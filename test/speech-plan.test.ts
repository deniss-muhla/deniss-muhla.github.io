/** Synthetic checks for finite assistant speech planning. */
import assert from "node:assert/strict";
import test from "node:test";
import { GREETING } from "../src/chat/cv-context.ts";
import { AUDIO_CATALOG_TEXT, createAudioSequence, createGreetingSequence, type AssistantClipSequence } from "../src/chat/speech-plan.ts";
import { WEAK_MATCH_CUE, type Answer } from "../src/chat/retrieval/controller.ts";
import type { ClarificationChoice } from "../src/chat/retrieval/selection.ts";
type AnswerResult = Extract<Answer, { kind: "answer" }>;
function answer(overrides: Partial<AnswerResult> = {}): AnswerResult {
  return { kind: "answer", cardId: "variant-card-2", topic: "synthetic topic", answer: "Synthetic prepared answer.", matching: "semantic", weak: false, ...overrides };
}
function catalogIds(sequence: AssistantClipSequence): string[] {
  return sequence.map((clip) => clip.kind === "catalog" ? clip.id : clip.kind);
}
test("greeting has its own catalog identity and retains cv-context text", () => {
  const greeting = createGreetingSequence();

  assert.deepEqual(greeting, [{ kind: "catalog", id: "greeting", text: GREETING }]);
  assert.equal(AUDIO_CATALOG_TEXT.greeting, GREETING);
  assert.equal(Object.isFrozen(greeting), true);
  assert.equal(Object.isFrozen(greeting[0]), true);
});

test("a selected answer keeps the controller's card id without reselecting a variant", () => {
  const planned = createAudioSequence(answer());

  assert.deepEqual(planned, [
    { kind: "fact", cardId: "variant-card-2", text: "Synthetic prepared answer." },
  ]);
});

test("weak and limited notes precede the selected fact and use finite catalog text", () => {
  const weak = createAudioSequence(answer({ weak: true }));
  const unavailable = createAudioSequence(answer({ matching: "limited", limitedCause: "model-unavailable" }));
  const failed = createAudioSequence(answer({ matching: "limited", limitedCause: "embedding-failed" }));

  assert.deepEqual(weak?.map((clip) => clip.text), [WEAK_MATCH_CUE, "Synthetic prepared answer."]);
  assert.deepEqual(unavailable?.map((clip) => clip.text), [
    AUDIO_CATALOG_TEXT.limitedAnswerModelUnavailable,
    "Synthetic prepared answer.",
  ]);
  assert.deepEqual(failed?.map((clip) => clip.text), [
    AUDIO_CATALOG_TEXT.limitedAnswerEmbeddingFailed,
    "Synthetic prepared answer.",
  ]);
  assert.deepEqual(catalogIds(weak ?? []), ["weakMatchNote", "fact"]);
});

test("clarification composes a prompt and separate topic clips bound to actual choices", () => {
  const offered: ClarificationChoice[] = [
    { cardId: "topic-card-a", topic: "Synthetic topic A", score: 0.51 },
    { cardId: "topic-card-b", topic: "Synthetic topic B", score: 0.5 },
  ];
  const result: Extract<Answer, { kind: "clarify" }> = { kind: "clarify", choices: [] };
  const planned = createAudioSequence(result, offered);

  assert.deepEqual(planned, [
    { kind: "catalog", id: "clarifyPrompt", text: AUDIO_CATALOG_TEXT.clarifyPrompt },
    { kind: "topic", cardId: "topic-card-a", text: "Synthetic topic A" },
    { kind: "topic", cardId: "topic-card-b", text: "Synthetic topic B" },
  ]);
  assert.deepEqual(catalogIds(planned ?? []), ["clarifyPrompt", "topic", "topic"]);
});

test("clarification plans copy the choices and freeze the complete sequence", () => {
  const offered: ClarificationChoice[] = [
    { cardId: "original-card", topic: "Original topic", score: 0.5 },
  ];
  const planned = createAudioSequence({ kind: "clarify", choices: offered });

  offered[0].cardId = "mutated-card";
  offered[0].topic = "Mutated topic";
  offered.push({ cardId: "later-card", topic: "Later topic", score: 0.4 });

  assert.deepEqual(planned?.slice(1), [
    { kind: "topic", cardId: "original-card", text: "Original topic" },
  ]);
  assert.equal(Object.isFrozen(planned), true);
  assert.ok(planned?.every((clip) => Object.isFrozen(clip)));
});

test("clarifications without actual choices have no prompt-only plan", () => {
  const choice: ClarificationChoice = {
    cardId: "controller-card",
    topic: "Controller topic",
    score: 0.5,
  };
  const emptyResult = createAudioSequence({ kind: "clarify", choices: [] });
  const nullChoices = createAudioSequence({ kind: "clarify", choices: [choice] }, null);
  const emptyChoices = createAudioSequence({ kind: "clarify", choices: [choice] }, []);

  assert.equal(emptyResult, null);
  assert.equal(nullChoices, null);
  assert.equal(emptyChoices, null);
});

test("rephrase, limited rephrase, shorten and ask-question use finite clips", () => {
  const results: Answer[] = [
    { kind: "rephrase", matching: "semantic" },
    { kind: "rephrase", matching: "limited", limitedCause: "model-unavailable" },
    { kind: "rephrase", matching: "limited", limitedCause: "embedding-failed" },
    { kind: "shorten", reason: "query/too-long" },
    { kind: "ask-question" },
  ];
  const sequences = results.map((result) => createAudioSequence(result));

  assert.deepEqual(sequences.map((plan) => plan?.[0]?.text), [
    AUDIO_CATALOG_TEXT.rephrase,
    AUDIO_CATALOG_TEXT.limitedRephraseModelUnavailable,
    AUDIO_CATALOG_TEXT.limitedRephraseEmbeddingFailed,
    AUDIO_CATALOG_TEXT.shorten,
    AUDIO_CATALOG_TEXT.askQuestion,
  ]);
  assert.deepEqual(sequences.map((plan) => plan?.length), [1, 1, 1, 1, 1]);
});

test("cancelled and superseded work has no sequence", () => {
  assert.equal(createAudioSequence({ kind: "cancelled" }), null);
  assert.equal(createAudioSequence({ kind: "superseded" }), null);
});

test("message clip text contains no model-storage notice", () => {
  assert.equal(
    (Object.values(AUDIO_CATALOG_TEXT) as readonly string[]).includes(
      "Model storage was cleared by the browser; loading the voice model again.",
    ),
    false,
  );
});
