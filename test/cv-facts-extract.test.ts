import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CvFactsError } from "../scripts/cv-facts/errors.mjs";
import type { SourceUnit } from "../scripts/cv-facts/extract.mjs";
import { extractSourceUnits } from "../scripts/cv-facts/extract.mjs";
import { prepareWorkspace, scaffoldArtifact } from "../scripts/cv-facts/prepare.mjs";
import { readSource, serializeJson } from "../scripts/cv-facts/paths.mjs";

const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cv-facts-extract-"));

test.after(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

/**
 * A synthetic document with the same shapes as the canonical CV: a title block with hard
 * breaks, an intro quote, one section per coverage area, two employers with a context
 * paragraph, bullets and a stack line, and a GFM technology table. It carries no CV text.
 */
const SYNTHETIC_CV = `# Sample Person

Staff Engineer  
Riga, EU  
Email: [sample@example.invalid](mailto:sample@example.invalid)

> A summary sentence written as a blockquote before the first section.

## Profile

A paragraph standing in for the profile statement.

## Current Focus

- First focus bullet.
- Second focus bullet.

## Experience

### Example Company | Software Developer | Riga | Jan 2020 - Present

A context paragraph describing what the employer delivers.

- Implemented a documented feature.
- Reviewed another documented change.

**Stack:** TypeScript, Web Components

### Second Company | Team Lead | Daugavpils | Mar 2016 - Dec 2019

- Led a documented workstream.

**Stack:** C#, MS SQL

## Strengths

- Architecture design
- Technical leadership

## Technology Stack

| Area            | Level        |
| --------------- | ------------ |
| HTML / CSS      | Advanced     |
| Web Components  | Advanced     |
| Docker          | Intermediate |

## Language

- A documented language certificate with a date.
- A documented subscore.

## Certificates

- A documented certificate with an issue date.

## Interests

- A documented interest.
- A second documented interest.
`;

function syntheticSource(name = "cv.md") {
  const absolutePath = path.join(workspace, name);
  fs.writeFileSync(absolutePath, SYNTHETIC_CV);
  return readSource({ absolutePath, relativePath: `fixture/${name}` });
}

function unitFor(units: SourceUnit[], cardId: string): SourceUnit {
  const unit = units.find((entry) => entry.cardId === cardId);
  assert.ok(unit, `expected a unit with card id ${cardId}`);
  return unit;
}

function textOf(units: SourceUnit[], cardId: string): string {
  return unitFor(units, cardId).text ?? "";
}

function itemsOf(units: SourceUnit[], cardId: string): string[] {
  return unitFor(units, cardId).items ?? [];
}

function headerOf(units: SourceUnit[], cardId: string) {
  const header = unitFor(units, cardId).header;
  assert.ok(header, `expected an employer header for ${cardId}`);
  return header;
}

test("extraction names every coverage area and keeps its own coordinates", () => {
  const { units, coverage } = extractSourceUnits(SYNTHETIC_CV);

  assert.deepEqual(coverage, {
    identity: 1,
    role: 1,
    location: 1,
    contact: 1,
    profile: 2,
    focus: 1,
    employment: 2,
    strengths: 1,
    technology: 3,
    languages: 1,
    certificates: 1,
    interests: 1,
  });
  assert.equal(units.every((unit) => unit.lines.start >= 1 && unit.lines.end >= unit.lines.start), true);
});

test("the title block becomes identity, role, location and contact units", () => {
  const { units } = extractSourceUnits(SYNTHETIC_CV);

  assert.equal(textOf(units, "identity-name"), "Sample Person");
  assert.equal(textOf(units, "identity-role"), "Staff Engineer");
  assert.equal(textOf(units, "identity-location"), "Riga, EU");
  assert.equal(textOf(units, "identity-contact-2").startsWith("Email:"), true);
  assert.equal(unitFor(units, "identity-role").lines.start, 3);
  assert.equal(unitFor(units, "identity-role").lines.end, 3);
  assert.equal(unitFor(units, "identity-location").lines.start, 4);
});

test("the intro blockquote and the profile paragraph are separate profile units", () => {
  const { units } = extractSourceUnits(SYNTHETIC_CV);

  assert.equal(unitFor(units, "profile").kind, "quote");
  assert.equal(unitFor(units, "profile-statement").kind, "note");
  assert.equal(unitFor(units, "profile").lines.start, 7);
  assert.equal(unitFor(units, "profile-statement").lines.start, 11);
});

test("short lists are grouped into one unit that reads as a single card", () => {
  const { units } = extractSourceUnits(SYNTHETIC_CV);

  assert.deepEqual(itemsOf(units, "focus"), ["First focus bullet.", "Second focus bullet."]);
  assert.deepEqual(itemsOf(units, "strengths"), ["Architecture design", "Technical leadership"]);
  assert.deepEqual(itemsOf(units, "languages"), [
    "A documented language certificate with a date.",
    "A documented subscore.",
  ]);
});

test("an employer heading carries its header, context, bullets and stack", () => {
  const { units } = extractSourceUnits(SYNTHETIC_CV);
  const employer = unitFor(units, "employment-example-company");

  assert.deepEqual(headerOf(units, "employment-example-company"), {
    employer: "Example Company",
    role: "Software Developer",
    location: "Riga",
    period: "Jan 2020 - Present",
  });
  assert.deepEqual(employer.context, ["A context paragraph describing what the employer delivers."]);
  assert.deepEqual(employer.items, [
    "Implemented a documented feature.",
    "Reviewed another documented change.",
  ]);
  assert.deepEqual(employer.stack, ["TypeScript", "Web Components"]);
  assert.equal(employer.lines.start, 20);
  assert.equal(employer.lines.end, 27);

  const second = unitFor(units, "employment-second-company");

  assert.equal(headerOf(units, "employment-second-company").period, "Mar 2016 - Dec 2019");
  assert.deepEqual(second.context, []);
  assert.deepEqual(second.stack, ["C#", "MS SQL"]);
});

test("GFM technology rows stay separate units and the header row is an explicit omission", () => {
  const { units, omissions } = extractSourceUnits(SYNTHETIC_CV);
  const rows = units.filter((unit) => unit.area === "technology");

  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.label),
    ["HTML / CSS", "Web Components", "Docker"],
  );
  assert.deepEqual(rows[0].items, ["HTML / CSS", "Advanced"]);
  assert.equal(rows[1].level, "Advanced");
  assert.equal(rows[0].cardId, "technology-html-css");
  assert.equal(rows[1].lines.start, rows[0].lines.start + 1);

  const headerOmission = omissions.find((entry) => entry.kind === "table-header");
  assert.ok(headerOmission);
  assert.equal(headerOmission.reason, "format-only");
  assert.equal(headerOmission.lines?.start, 42);
  assert.equal(rows[0].lines.start, 44);
});

test("blank lines are recorded as an explicit omission", () => {
  const { omissions } = extractSourceUnits(SYNTHETIC_CV);
  const blank = omissions.find((entry) => entry.kind === "blank-lines");

  assert.ok(blank);
  assert.equal(blank.reason, "blank");
  assert.equal(blank.count, SYNTHETIC_CV.split("\n").filter((line) => line.trim() === "").length);
});

test("extraction is byte-stable across runs", () => {
  assert.equal(JSON.stringify(extractSourceUnits(SYNTHETIC_CV)), JSON.stringify(extractSourceUnits(SYNTHETIC_CV)));
});

test("a malformed grouping stops preparation with a coordinate and no source text", () => {
  const malformed = SYNTHETIC_CV.replace(
    "### Second Company | Team Lead | Daugavpils | Mar 2016 - Dec 2019",
    "### Second Company | Team Lead | Daugavpils",
  );

  assert.throws(
    () => extractSourceUnits(malformed),
    (error: unknown) =>
      error instanceof CvFactsError &&
      error.reason === "extract/employer-header-malformed" &&
      error.lines?.start === 29 &&
      error.lines?.end === 29 &&
      !error.message.includes("Second Company"),
  );
});

test("an unreadable employer period is a failure, never an inferred date", () => {
  const malformed = SYNTHETIC_CV.replace("Jan 2020 - Present", "since 2020");

  assert.throws(
    () => extractSourceUnits(malformed),
    (error: unknown) =>
      error instanceof CvFactsError && error.reason === "extract/employer-period-unreadable" && error.lines?.start === 20,
  );
});

const ORPHAN_EMPLOYMENT_CV = "# Sample\n\n## Experience\n\n- Documented work.\n";

test("an employment list without an employer heading stops preparation and writes nothing", () => {
  assert.throws(
    () => extractSourceUnits(ORPHAN_EMPLOYMENT_CV),
    (error: unknown) =>
      error instanceof CvFactsError &&
      error.reason === "extract/employer-grouping-missing" &&
      error.lines?.start === 5,
  );

  const orphanPath = path.join(workspace, "orphan-cv.md");

  fs.writeFileSync(orphanPath, ORPHAN_EMPLOYMENT_CV);

  const source = readSource({ absolutePath: orphanPath, relativePath: "fixture/orphan-cv.md" });
  const outDir = path.join(workspace, "prepare-orphan");

  assert.throws(
    () => prepareWorkspace({ source, outDir }),
    (error: unknown) =>
      error instanceof CvFactsError && error.reason === "extract/employer-grouping-missing",
  );
  assert.equal(fs.existsSync(outDir), false, "a stopped preparation must leave no workspace behind");
});

test("an unknown section stops preparation instead of guessing its area", () => {
  const malformed = SYNTHETIC_CV.replace("## Certificates", "## Awards");

  assert.throws(
    () => extractSourceUnits(malformed),
    (error: unknown) =>
      error instanceof CvFactsError && error.reason === "extract/unknown-section" && error.lines?.start === 53,
  );
});

test("a subheading outside the experience section stops preparation with a coordinate", () => {
  const malformed = SYNTHETIC_CV.replace(
    "## Strengths\n\n- Architecture design",
    "## Strengths\n\n### Nested heading\n\n- Architecture design",
  );

  assert.throws(
    () => extractSourceUnits(malformed),
    (error: unknown) =>
      error instanceof CvFactsError && error.reason === "extract/unexpected-subheading" && error.lines?.start === 37,
  );
});

test("a table outside the technology section stops preparation", () => {
  const malformed = SYNTHETIC_CV.replace(
    "## Strengths\n\n- Architecture design",
    "## Strengths\n\n| Area | Level |\n| - | - |\n| One | High |",
  );

  assert.throws(
    () => extractSourceUnits(malformed),
    (error: unknown) => error instanceof CvFactsError && error.reason === "extract/unexpected-table",
  );
});

test("the scaffold carries the extracted ids and source references with empty fields", () => {
  const source = syntheticSource();
  const { units } = extractSourceUnits(SYNTHETIC_CV);
  const artifact = scaffoldArtifact({ source, units });

  assert.equal(artifact.version, 1);
  assert.equal(artifact.source.path, source.relativePath);
  assert.equal(artifact.source.sha256, source.sha256);
  assert.equal(artifact.embedding.contentSha256, "");
  assert.equal(artifact.cards.length, units.length);
  assert.equal(artifact.cards.every((card) => card.topic === "" && card.answer === ""), true);
  assert.equal(artifact.cards.every((card) => card.tags.length === 0 && card.vector.length === 0), true);
  assert.deepEqual(artifact.cards[0].sourceRefs, [{ startLine: 1, endLine: 1 }]);
  assert.equal(new Set(artifact.cards.map((card) => card.id)).size, artifact.cards.length);
});

test("prepare writes both files outside the repository and reruns byte-identically", () => {
  const source = syntheticSource("prepare.md");
  const first = path.join(workspace, "prepare-a");
  const second = path.join(workspace, "prepare-b");

  const one = prepareWorkspace({ source, outDir: first });
  const two = prepareWorkspace({ source, outDir: second });

  const analysisOne = fs.readFileSync(one.analysisPath, "utf8");
  const analysisTwo = fs.readFileSync(two.analysisPath, "utf8");
  const candidateOne = fs.readFileSync(one.candidatePath, "utf8");
  const candidateTwo = fs.readFileSync(two.candidatePath, "utf8");

  assert.equal(analysisOne, analysisTwo);
  assert.equal(candidateOne, candidateTwo);
  assert.equal(analysisOne, serializeJson(JSON.parse(analysisOne)));
  assert.ok(one.analysisPath.startsWith(workspace));
  assert.ok(one.candidatePath.startsWith(workspace));
  assert.deepEqual(fs.readdirSync(first).sort(), ["analysis.json", "facts.candidate.json"]);

  const analysis = JSON.parse(analysisOne);

  assert.equal(analysis.source.lines, source.lineCount);
  assert.equal(analysis.units.length, one.units);
  assert.equal(analysis.omissions.length, one.omissions);
});

test("prepare refuses to overwrite an authored candidate without an explicit force", () => {
  const source = syntheticSource("authored.md");
  const outDir = path.join(workspace, "prepare-authored");
  const first = prepareWorkspace({ source, outDir });
  const artifact = JSON.parse(fs.readFileSync(first.candidatePath, "utf8"));

  artifact.cards[0].topic = "An authored topic";
  artifact.cards[0].answer = "An authored answer";
  fs.writeFileSync(first.candidatePath, serializeJson(artifact));

  assert.throws(
    () => prepareWorkspace({ source, outDir }),
    (error: unknown) => error instanceof CvFactsError && error.reason === "prepare/authored-candidate-present",
  );

  const forced = prepareWorkspace({ source, outDir, force: true });

  assert.equal(JSON.parse(fs.readFileSync(forced.candidatePath, "utf8")).cards[0].topic, "");
});

test("the scaffold is byte-identical when the workspace already holds an empty candidate", () => {
  const source = syntheticSource("empty.md");
  const outDir = path.join(workspace, "prepare-empty");

  const first = prepareWorkspace({ source, outDir });

  assert.equal(
    fs.readFileSync(first.candidatePath, "utf8"),
    serializeJson(scaffoldArtifact({ source, units: extractSourceUnits(SYNTHETIC_CV).units })),
  );
  assert.doesNotThrow(() => prepareWorkspace({ source, outDir }));
});