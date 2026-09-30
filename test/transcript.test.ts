import assert from "node:assert/strict";
import test from "node:test";

import { mergeTranscript } from "../src/chat/transcript.ts";

test("keeps a single phrase when the finalized line repeats the interim text", () => {
  // Regression: Moonshine reports interim text and then the same finalized
  // line, which used to appear twice in the question bubble.
  const interim = "What does Deniss do at If";
  const finalized = "What does Deniss do at If?";

  assert.equal(mergeTranscript(interim, finalized), finalized);
  assert.equal(mergeTranscript("", interim), interim);
  assert.equal(mergeTranscript(finalized, finalized), finalized);
});

test("prefers the longer text when the finalized line extends the interim text", () => {
  assert.equal(
    mergeTranscript("Where did he work", "Where did he work before Stream Labs"),
    "Where did he work before Stream Labs",
  );
});

test("joins a continuation that overlaps by whole words", () => {
  assert.equal(
    mergeTranscript("He worked at If and Stream Labs", "Stream Labs for seven years"),
    "He worked at If and Stream Labs for seven years",
  );
});

test("joins unrelated continuations once", () => {
  assert.equal(
    mergeTranscript("What are his skills", "and where did he work"),
    "What are his skills and where did he work",
  );
});

test("ignores empty input on either side", () => {
  assert.equal(mergeTranscript("", ""), "");
  assert.equal(mergeTranscript("  ", "text"), "text");
  assert.equal(mergeTranscript("text", "   "), "text");
});
