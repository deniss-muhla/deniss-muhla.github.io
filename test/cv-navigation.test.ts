import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { remark } from "remark";

import { buildCvSectionRanges, cvHeadingId, resolveCvAnchor } from "../src/page/cv-navigation.ts";

const headings = [
  { level: 1, line: 2 },
  { level: 2, line: 7 },
  { level: 3, line: 12 },
  { level: 4, line: 18 },
];

test("h1 through h4 positions produce stable inclusive section ranges", () => {
  const sections = buildCvSectionRanges([...headings, { level: 5, line: 22 }], 24);

  assert.deepEqual(sections, [
    { level: 1, startLine: 2, endLine: 6, anchorId: "cv-line-2" },
    { level: 2, startLine: 7, endLine: 11, anchorId: "cv-line-7" },
    { level: 3, startLine: 12, endLine: 17, anchorId: "cv-line-12" },
    { level: 4, startLine: 18, endLine: 24, anchorId: "cv-line-18" },
  ]);
  assert.equal(cvHeadingId(18), "cv-line-18");
});

test("a source range spanning headings resolves to the first covered section in document order", () => {
  const sections = buildCvSectionRanges(headings, 24);
  const target = resolveCvAnchor(
    [{ startLine: 8, endLine: 14 }],
    sections,
    () => true,
  );

  assert.equal(target, "cv-line-7");
});

test("an uncovered earlier reference is skipped before a covered reference", () => {
  const sections = buildCvSectionRanges(headings, 24);
  const target = resolveCvAnchor(
    [{ startLine: 1, endLine: 1 }, { startLine: 13, endLine: 14 }],
    sections,
    () => true,
  );

  assert.equal(target, "cv-line-12");
});

test("source references keep their array order", () => {
  const sections = buildCvSectionRanges(headings, 24);
  const target = resolveCvAnchor(
    [{ startLine: 13, endLine: 14 }, { startLine: 2, endLine: 3 }],
    sections,
    () => true,
  );

  assert.equal(target, "cv-line-12");
});

test("a shared identity citation does not hide the cited content section", () => {
  const sections = buildCvSectionRanges(headings, 24);

  assert.equal(
    resolveCvAnchor(
      [{ startLine: 2, endLine: 2 }, { startLine: 13, endLine: 14 }],
      sections,
      () => true,
    ),
    "cv-line-12",
  );
});

test("content citations keep source-reference order ahead of title context", () => {
  const sections = buildCvSectionRanges(headings, 24);

  assert.equal(
    resolveCvAnchor(
      [{ startLine: 2, endLine: 2 }, { startLine: 8, endLine: 9 }, { startLine: 19, endLine: 20 }],
      sections,
      () => true,
    ),
    "cv-line-7",
  );
});

test("a citation spanning the title and content lands on the first content section", () => {
  const sections = buildCvSectionRanges(headings, 24);

  assert.equal(resolveCvAnchor([{ startLine: 2, endLine: 14 }], sections, () => true), "cv-line-7");
});

test("identity and contact-only citations still land on the CV title", () => {
  const sections = buildCvSectionRanges(headings, 24);

  assert.equal(
    resolveCvAnchor(
      [{ startLine: 2, endLine: 2 }, { startLine: 4, endLine: 5 }],
      sections,
      () => true,
    ),
    "cv-line-2",
  );
});

test("a missing cited content anchor does not fall back to the title or another section", () => {
  const sections = buildCvSectionRanges(headings, 24);

  assert.equal(
    resolveCvAnchor(
      [{ startLine: 2, endLine: 2 }, { startLine: 13, endLine: 14 }, { startLine: 19, endLine: 20 }],
      sections,
      (id) => id !== "cv-line-12",
    ),
    null,
  );
});

test("a source range before the first heading has no target", () => {
  const sections = buildCvSectionRanges(headings, 24);

  assert.equal(resolveCvAnchor([{ startLine: 1, endLine: 1 }], sections, () => true), null);
});

test("a first covered section without an actual anchor has no fallback", () => {
  const sections = buildCvSectionRanges(headings, 24);

  assert.equal(
    resolveCvAnchor(
      [{ startLine: 7, endLine: 9 }, { startLine: 18, endLine: 20 }],
      sections,
      (id) => id !== "cv-line-7",
    ),
    null,
  );
});

test("source lines outside the map and an empty section map have no target", () => {
  const sections = buildCvSectionRanges(headings, 24);

  assert.equal(resolveCvAnchor([{ startLine: 25, endLine: 27 }], sections, () => true), null);
  assert.deepEqual(buildCvSectionRanges([], 24), []);
  assert.equal(resolveCvAnchor([{ startLine: 2, endLine: 3 }], [], () => true), null);
});

test("installed fact citations resolve to their canonical CV sections despite shared identity context", () => {
  const markdown = readFileSync(new URL("../resources/cv/source/cv.md", import.meta.url), "utf8");
  const facts = JSON.parse(readFileSync(new URL("../resources/cv/facts.json", import.meta.url), "utf8")) as {
    cards: { id: string; sourceRefs: { startLine: number; endLine: number }[] }[];
  };
  const renderedHeadings = remark().parse(markdown).children.filter((node) => node.type === "heading");
  const sections = buildCvSectionRanges(
    renderedHeadings.map((node) => ({ level: node.depth, line: node.position!.start.line })),
    markdown.split(/\r\n|\n|\r/).length,
  );
  const cases = [
    ["identity-name", null],
    ["contact-email", null],
    ["profile-agent-workflows", "Profile"],
    ["employment-if-p-c-insurance", "IF P&C Insurance |"],
    ["employment-stream-labs", "Stream Labs |"],
    ["technology-front-end", "Technology Stack"],
    ["certificate-mcpd", "Certificates"],
    ["interest-linux", "Interests"],
  ] as const;

  for (const [cardId, headingText] of cases) {
    const card = facts.cards.find(({ id }) => id === cardId);
    const expectedHeading = renderedHeadings.find((node) => headingText === null
      ? node.depth === 1
      : node.children.some((child) => child.type === "text" && child.value.startsWith(headingText)));
    assert.ok(card, `${cardId} exists in the installed reviewed corpus`);
    assert.ok(expectedHeading?.position, `${cardId} has its expected canonical heading`);
    const expectedAnchor = `cv-line-${expectedHeading.position.start.line}`;

    assert.equal(
      resolveCvAnchor(card.sourceRefs, sections, (id) => sections.some((section) => section.anchorId === id)),
      expectedAnchor,
      `${cardId} navigates to ${headingText ?? "the CV title"}`,
    );
  }
});
