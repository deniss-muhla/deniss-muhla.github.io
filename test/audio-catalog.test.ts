/** Synthetic checks for finite assistant clip planning; no CV content or audio assets are used. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { GREETING } from "../src/chat/cv-context.ts";
import {
  AUDIO_CATALOG_TEXT,
  AudioCatalogError,
  assistantClipId,
  createAudioSequence,
  createGreetingSequence,
  type AssistantClipSequence,
} from "../src/chat/audio-catalog.ts";
import { createAudioSourceInventory } from "../scripts/cv-audio/catalog.mjs";
import { WEAK_MATCH_CUE, type Answer } from "../src/chat/retrieval/controller.ts";
import type { ClarificationChoice } from "../src/chat/retrieval/selection.ts";

type AnswerResult = Extract<Answer, { kind: "answer" }>;

function answer(overrides: Partial<AnswerResult> = {}): AnswerResult {
  return {
    kind: "answer",
    cardId: "variant-card-2",
    topic: "synthetic topic",
    answer: "Synthetic prepared answer.",
    matching: "semantic",
    weak: false,
    ...overrides,
  };
}

function catalogIds(sequence: AssistantClipSequence): string[] {
  return sequence.map((clip) => clip.kind === "catalog" ? clip.id : clip.kind);
}

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function factsBytes(cards: readonly { id: string; answer: string; topic: string }[]): Buffer {
  return Buffer.from(JSON.stringify({ cards }), "utf8");
}

const LINE_TERMINATORS = ["\n", "\r", "\r\n", "\u2028", "\u2029"];

test("reference IDs use disjoint greeting, fact, topic and fixed-message namespaces", () => {
  assert.equal(assistantClipId({ kind: "catalog", id: "greeting", text: GREETING }), "greeting");
  assert.equal(assistantClipId({ kind: "fact", cardId: "synthetic-card", text: "Synthetic answer." }), "synthetic-card");
  assert.equal(assistantClipId({ kind: "topic", cardId: "synthetic-card", text: "Synthetic topic" }), "topic--synthetic-card");
  assert.equal(
    assistantClipId({ kind: "catalog", id: "weakMatchNote", text: AUDIO_CATALOG_TEXT.weakMatchNote }),
    "message--weak-match-note",
  );
  assert.equal(
    assistantClipId({ kind: "catalog", id: "askQuestion", text: AUDIO_CATALOG_TEXT.askQuestion }),
    "message--ask-question",
  );
});

test("catalog reference IDs reject boxed strings with the closed catalog-ID error", () => {
  const reference = {
    kind: "catalog",
    id: new String("greeting"),
    text: GREETING,
  } as unknown as Parameters<typeof assistantClipId>[0];

  assert.throws(
    () => assistantClipId(reference),
    (error: unknown) => error instanceof AudioCatalogError &&
      error.code === "reference/catalog-id-invalid" && error.message === "reference/catalog-id-invalid",
  );
});

test("catalog reference IDs reject coercing objects before property-key conversion", () => {
  let coerced = false;
  const reference = {
    kind: "catalog",
    id: {
      toString: () => {
        coerced = true;
        return "greeting";
      },
    },
    text: GREETING,
  } as unknown as Parameters<typeof assistantClipId>[0];

  assert.throws(
    () => assistantClipId(reference),
    (error: unknown) => error instanceof AudioCatalogError &&
      error.code === "reference/catalog-id-invalid" && error.message === "reference/catalog-id-invalid",
  );
  assert.equal(coerced, false);
});

test("source inventory binds exact fact bytes and text, fixed messages and source-ordered topics", () => {
  const raw = factsBytes([
    { id: "synthetic-alpha", answer: " Synthetic answer alpha. ", topic: "Synthetic topic alpha" },
    { id: "synthetic-beta", answer: "Synthetic answer beta.", topic: "Synthetic topic beta" },
  ]);
  const inventory = createAudioSourceInventory(raw);
  const messageEntries = Object.entries(AUDIO_CATALOG_TEXT)
    .filter(([key]) => key !== "greeting")
    .map(([key, text]) => [
      assistantClipId({ kind: "catalog", id: key as keyof typeof AUDIO_CATALOG_TEXT, text }),
      text,
    ]);
  const topicEntries = [
    ["topic--synthetic-alpha", "Synthetic topic alpha"],
    ["topic--synthetic-beta", "Synthetic topic beta"],
  ];

  assert.equal(inventory.factsSha256, digest(raw));
  assert.equal(inventory.greetingSha256, digest(Buffer.from(GREETING, "utf8")));
  assert.equal(inventory.items.filter((item) => item.kind === "greeting").length, 1);
  assert.equal(inventory.items.filter((item) => item.kind === "message").length, 9);
  assert.equal(inventory.items.filter((item) => item.kind === "fact").length, 2);
  assert.equal(inventory.items.filter((item) => item.kind === "topic").length, 2);
  assert.equal(inventory.items[1].text, " Synthetic answer alpha. ");
  assert.equal(inventory.items[1].textSha256, digest(Buffer.from(" Synthetic answer alpha. ", "utf8")));
  assert.equal(
    inventory.catalogSha256,
    digest(Buffer.from(JSON.stringify([...messageEntries, ...topicEntries]), "utf8")),
  );
  assert.equal(Object.isFrozen(inventory.items), true);
  assert.ok(inventory.items.every((item) => Object.isFrozen(item)));

  const changedAnswer = createAudioSourceInventory(factsBytes([
    { id: "synthetic-alpha", answer: "Changed answer alpha.", topic: "Synthetic topic alpha" },
    { id: "synthetic-beta", answer: "Changed answer beta.", topic: "Synthetic topic beta" },
  ]));
  assert.notEqual(changedAnswer.factsSha256, inventory.factsSha256);
  assert.equal(changedAnswer.catalogSha256, inventory.catalogSha256);
});

test("inventory validation rejects duplicate, unsafe and empty source fields by closed codes", () => {
  const assertCode = (bytes: Buffer, code: string): void => {
    assert.throws(
      () => createAudioSourceInventory(bytes),
      (error: unknown) => error instanceof AudioCatalogError && error.code === code && error.message === code,
    );
  };

  assertCode(factsBytes([
    { id: "same-id", answer: "Answer one.", topic: "Topic one" },
    { id: "same-id", answer: "Answer two.", topic: "Topic two" },
  ]), "source/card-id-duplicate");
  assertCode(factsBytes([{ id: "unsafe--namespace", answer: "Answer.", topic: "Topic" }]), "source/card-id-invalid");
  assertCode(factsBytes([{ id: "greeting", answer: "Answer.", topic: "Topic" }]), "source/card-id-invalid");
  assertCode(factsBytes([{ id: "empty-answer", answer: "  ", topic: "Topic" }]), "source/card-answer-empty");
  assertCode(factsBytes([{ id: "empty-topic", answer: "Answer.", topic: "  " }]), "source/card-topic-empty");
  assert.throws(
    () => createAudioSourceInventory(Buffer.from("not facts")),
    (error: unknown) => error instanceof AudioCatalogError && error.message === "source/facts-json-invalid",
  );
});

test("reference IDs reject non-strings, embedded invalid characters and terminal line breaks", () => {
  const assertInvalid = (cardId: unknown): void => {
    assert.throws(
      () => assistantClipId({ kind: "fact", cardId: cardId as string, text: "Synthetic answer." }),
      (error: unknown) => error instanceof AudioCatalogError && error.code === "reference/card-id-invalid",
    );
  };

  assertInvalid(7);
  assertInvalid({ toString: () => "valid-card" });
  assertInvalid("invalid_card");
  for (const terminator of LINE_TERMINATORS) {
    assertInvalid(`synthetic-card${terminator}`);
    assert.throws(
      () => createAudioSourceInventory(factsBytes([{
        id: `synthetic-card${terminator}`,
        answer: "Synthetic answer.",
        topic: "Synthetic topic",
      }])),
      (error: unknown) => error instanceof AudioCatalogError && error.code === "source/card-id-invalid",
    );
  }

  assert.equal(assistantClipId({ kind: "fact", cardId: "a".repeat(64), text: "Synthetic answer." }), "a".repeat(64));
  assertInvalid("a".repeat(65));
});

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
