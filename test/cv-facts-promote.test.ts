import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { contentSha256 } from "../scripts/cv-facts/artifact.mjs";
import { CvFactsError, describeFailure } from "../scripts/cv-facts/errors.mjs";
import { readSource } from "../scripts/cv-facts/paths.mjs";
import { PROMOTION_ACKNOWLEDGMENT, promoteArtifact, readArtifactFile } from "../scripts/cv-facts/promote.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cv-facts-promote-"));

test.after(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

const SOURCE_TEXT = ["# Fixture", "", "One documented line.", "Another documented line.", ""].join("\n");
const sourcePath = path.join(workspace, "fixture-cv.md");

fs.writeFileSync(sourcePath, SOURCE_TEXT);

const source = readSource({ absolutePath: sourcePath, relativePath: "fixture/cv.md" });

const context = () => ({
  sourceRelativePath: source.relativePath,
  sourceSha256: source.sha256,
  sourceLineCount: source.lineCount,
});

function vector(seed: number) {
  const raw = Array.from({ length: 384 }, (_, index) => ((index + seed) % 13) / 13 - 0.5);
  const norm = Math.sqrt(raw.reduce((total, value) => total + value * value, 0));

  return raw.map((value) => Number((value / norm).toFixed(6)));
}

/** A valid artifact. The reviewed target is synthetic; no real CV material is involved. */
function validArtifact() {
  const cards = [
    {
      id: "first-card",
      topic: "First topic",
      tags: ["first tag"],
      sourceRefs: [{ startLine: 3, endLine: 3 }],
      answer: "First answer.",
      vector: vector(1),
    },
    {
      id: "second-card",
      topic: "Second topic",
      tags: ["second tag"],
      sourceRefs: [{ startLine: 4, endLine: 4 }],
      answer: "Second answer.",
      vector: vector(2),
    },
  ];

  return {
    version: 1,
    source: { path: source.relativePath, sha256: source.sha256 },
    embedding: {
      model: "mixedbread-ai/mxbai-embed-xsmall-v1",
      revision: "e6ac24e5d6efb8782b59de1647b3ececb4ece94e",
      dtype: "q8",
      runtimeVersion: "4.3.0",
      pooling: "mean",
      normalize: true,
      dimensions: 384,
      inputVersion: "retrieval-text-v1",
      contentSha256: contentSha256(cards),
    },
    cards,
  };
}

function writeReviewed(name: string, artifact: unknown) {
  const reviewedPath = path.join(workspace, name);

  fs.writeFileSync(reviewedPath, `${JSON.stringify(artifact, null, 2)}\n`);

  return reviewedPath;
}

test("a valid candidate replaces the reviewed file", () => {
  const reviewedPath = writeReviewed("reviewed-valid.json", validArtifact());
  const candidate = validArtifact();

  candidate.cards[1].answer = "Second answer, reviewed against the source.";
  candidate.embedding.contentSha256 = contentSha256(candidate.cards);

  const result = promoteArtifact({ artifact: candidate, reviewedPath, context: context() });

  assert.equal(result.replaced, true);
  assert.deepEqual(result.findings, []);
  assert.ok(result.bytes > 0);

  const written = JSON.parse(fs.readFileSync(reviewedPath, "utf8"));

  assert.equal(written.cards[1].answer, "Second answer, reviewed against the source.");
  assert.equal(written.embedding.contentSha256, candidate.embedding.contentSha256);
  assert.deepEqual(fs.readdirSync(workspace).filter((entry) => entry.endsWith(".tmp")), []);
});

test("an invalid candidate never replaces a good reviewed file", () => {
  const good = validArtifact();
  const reviewedPath = writeReviewed("reviewed-untouched.json", good);
  const before = fs.readFileSync(reviewedPath);

  const invalid = validArtifact();

  invalid.cards[0].topic = "";
  invalid.source.sha256 = "0".repeat(64);

  const result = promoteArtifact({ artifact: invalid, reviewedPath, context: context() });

  assert.equal(result.replaced, false);
  assert.ok(result.findings.some((finding) => finding.rule === "card/topic"));
  assert.ok(result.findings.some((finding) => finding.rule === "source/digest"));
  assert.deepEqual(fs.readFileSync(reviewedPath), before);
  assert.deepEqual(fs.readdirSync(workspace).filter((entry) => entry.endsWith(".tmp")), []);
});

test("a tampered candidate is refused while an unreadable one leaves the reviewed file alone", () => {
  const reviewedPath = writeReviewed("reviewed-tampered.json", validArtifact());
  const before = fs.readFileSync(reviewedPath);
  const tampered = validArtifact();

  tampered.cards[0].vector = tampered.cards[0].vector.map((value, index) => (index === 5 ? 0.9999999 : value));

  const tamperedResult = promoteArtifact({ artifact: tampered, reviewedPath, context: context() });

  assert.equal(tamperedResult.replaced, false);
  assert.ok(tamperedResult.findings.some((finding) => finding.rule === "card/vector-precision"));
  assert.deepEqual(fs.readFileSync(reviewedPath), before);

  const unreadable = promoteArtifact({ artifact: "not json", reviewedPath, context: context() });

  assert.equal(unreadable.replaced, false);
  assert.ok(unreadable.findings.some((finding) => finding.rule === "artifact/shape"));
  assert.deepEqual(fs.readFileSync(reviewedPath), before);
});

/** Replaces one filesystem call for the duration of `action`, then puts the real one back. */
function withInjectedFilesystemFailure(
  method: "writeFileSync" | "fsyncSync",
  action: () => void,
) {
  const fsRecord = fs as unknown as Record<string, unknown>;
  const original = fsRecord[method];

  fsRecord[method] = () => {
    throw new Error(`injected-${method}-failure`);
  };

  try {
    action();
  } finally {
    fsRecord[method] = original;
  }
}

test("a filesystem failure while writing leaves the previous bytes and no temporary", () => {
  for (const method of ["writeFileSync", "fsyncSync"] as const) {
    const reviewedPath = writeReviewed(`reviewed-${method}.json`, validArtifact());
    const before = fs.readFileSync(reviewedPath);

    assert.throws(
      () =>
        withInjectedFilesystemFailure(method, () => {
          promoteArtifact({ artifact: validArtifact(), reviewedPath, context: context() });
        }),
      new RegExp(`injected-${method}-failure`),
    );

    assert.deepEqual(fs.readFileSync(reviewedPath), before);
    assert.deepEqual(
      fs.readdirSync(workspace).filter((entry) => entry.endsWith(".tmp")),
      [],
      `a failed ${method} must not leave a temporary behind`,
    );
  }
});

test("a temporary this call did not create survives the refused write untouched", () => {
  const reviewedPath = writeReviewed("reviewed-occupied.json", validArtifact());
  const temporary = `${reviewedPath}.${process.pid}.tmp`;
  const unrelated = "authored by another writer\n";

  fs.writeFileSync(temporary, unrelated);

  const before = fs.readFileSync(reviewedPath);

  try {
    // The exclusive open fails before this call owns anything, so the promotion reports the
    // refusal and removes nothing: the previous index and the foreign temporary both survive.
    assert.throws(
      () => promoteArtifact({ artifact: validArtifact(), reviewedPath, context: context() }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST",
    );

    assert.deepEqual(fs.readFileSync(reviewedPath), before);
    assert.equal(fs.readFileSync(temporary, "utf8"), unrelated);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
});

test("the confirmation flag is an acknowledgment and never review proof", () => {
  assert.match(PROMOTION_ACKNOWLEDGMENT, /not that review's evidence and not owner acceptance/);

  const result = promoteArtifact({
    artifact: validArtifact(),
    reviewedPath: writeReviewed("reviewed-ack.json", validArtifact()),
    context: context(),
  });

  // The writer itself records nothing about review. Only the command line output states the
  // acknowledgment, and it states that the flag proves nothing.
  assert.deepEqual(Object.keys(result).sort(), ["bytes", "findings", "replaced"]);
});

test("promotion stages and commits nothing", () => {
  const before = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repositoryRoot, encoding: "utf8" });

  promoteArtifact({
    artifact: validArtifact(),
    reviewedPath: writeReviewed("reviewed-git.json", validArtifact()),
    context: context(),
  });

  const after = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repositoryRoot, encoding: "utf8" });

  assert.equal(before, "");
  assert.equal(after, "");
});

test("a missing or unparsable artifact is classified without its raw text", () => {
  assert.throws(
    () => readArtifactFile(path.join(workspace, "absent.json"), { stage: "check" }),
    (error: unknown) => error instanceof CvFactsError && error.reason === "check/artifact-missing",
  );

  const unparsable = path.join(workspace, "unparsable.json");

  fs.writeFileSync(unparsable, "SYNTHETIC_UNPARSABLE_MARKER");

  assert.throws(
    () => readArtifactFile(unparsable, { stage: "check" }),
    (error: unknown) =>
      error instanceof CvFactsError &&
      error.reason === "check/artifact-unreadable" &&
      !describeFailure(error).join("\n").includes("SYNTHETIC_UNPARSABLE_MARKER"),
  );
});