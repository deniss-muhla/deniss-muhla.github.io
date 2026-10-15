import assert from "node:assert/strict";
import test from "node:test";

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
    { startLine: 2, endLine: 6, anchorId: "cv-line-2" },
    { startLine: 7, endLine: 11, anchorId: "cv-line-7" },
    { startLine: 12, endLine: 17, anchorId: "cv-line-12" },
    { startLine: 18, endLine: 24, anchorId: "cv-line-18" },
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
