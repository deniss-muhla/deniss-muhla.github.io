/**
 * The chat's view of one structured retrieval result: the uncertainty cue and the
 * limited-matching label arrive as a separate note field, every labeled state has its own
 * text instead of a generic fallback, a clarification offers a prompt for the choices, and
 * cancelled work leaves no trace.
 *
 * Everything is synthetic: the results are literals over the shared types, so no model,
 * index, network or CV text is involved.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CLARIFY_PROMPT,
  describeReply,
  MODEL_STORAGE_CLEARED_NOTICE,
} from "../src/chat/replies.ts";
import { WEAK_MATCH_CUE, type Answer } from "../src/chat/retrieval/controller.ts";

type AnswerResult = Extract<Answer, { kind: "answer" }>;

function answerResult(overrides: Partial<AnswerResult> = {}): AnswerResult {
  return {
    kind: "answer",
    cardId: "card-1",
    topic: "sample topic",
    answer: "prepared answer text",
    matching: "semantic",
    weak: false,
    ...overrides,
  };
}

test("a plain answer carries no note", () => {
  assert.deepEqual(describeReply(answerResult()), { kind: "answer", note: null });
});

test("a weak match keeps the uncertainty cue outside the answer text", () => {
  const view = describeReply(answerResult({ weak: true }));

  assert.deepEqual(view, { kind: "answer", note: WEAK_MATCH_CUE });
});

test("a limited answer labels which matching was available and why", () => {
  const unloaded = describeReply(
    answerResult({ matching: "limited", limitedCause: "model-unavailable" }),
  );
  const failed = describeReply(
    answerResult({ matching: "limited", limitedCause: "embedding-failed" }),
  );

  assert.equal(unloaded.kind, "answer");
  assert.equal(unloaded.kind === "answer" && unloaded.note?.includes("not loaded"), true);
  assert.equal(failed.kind, "answer");
  assert.equal(failed.kind === "answer" && failed.note?.includes("failed to load"), true);
});

test("a clarification offers a prompt for the engine's choices", () => {
  const view = describeReply({ kind: "clarify", choices: [] });

  assert.deepEqual(view, { kind: "choices", prompt: CLARIFY_PROMPT });
});

test("a rephrase notice differs between a missing model and no word match", () => {
  const limited = describeReply({ kind: "rephrase", matching: "limited", limitedCause: "model-unavailable" });
  const full = describeReply({ kind: "rephrase", matching: "semantic" });

  assert.equal(limited.kind, "notice");
  assert.equal(limited.kind === "notice" && limited.retryable, true);
  assert.equal(limited.kind === "notice" && limited.text.includes("not loaded"), true);
  assert.equal(full.kind, "notice");
  assert.equal(full.kind === "notice" && full.text, "No entry matched that question. Try rephrasing it.");
});

test("an oversized question asks for a shorter one", () => {
  const view = describeReply({ kind: "shorten", reason: "query/too-long" });

  assert.deepEqual(view, {
    kind: "notice",
    text: "That question is too long. Please ask a shorter one.",
    retryable: true,
  });
});

test("an empty question asks for a question and offers no retry", () => {
  const view = describeReply({ kind: "ask-question" });

  assert.deepEqual(view, {
    kind: "notice",
    text: "Please ask a question first.",
    retryable: false,
  });
});

test("cancelled and superseded results leave no trace", () => {
  assert.deepEqual(describeReply({ kind: "cancelled" }), { kind: "none" });
  assert.deepEqual(describeReply({ kind: "superseded" }), { kind: "none" });
});

test("the storage-cleared notice names the cause and the reload", () => {
  assert.equal(
    MODEL_STORAGE_CLEARED_NOTICE,
    "Model storage was cleared by the browser; loading the voice model again.",
  );
});
