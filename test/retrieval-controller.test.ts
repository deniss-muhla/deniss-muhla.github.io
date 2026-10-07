/**
 * The answer path: lexical fallback while no model is available, the transition to semantic
 * matching once an encoder is supplied, and the pending clarification choice.
 *
 * Every assertion checks the branch and its label, not a score. A limited answer must never
 * be able to look like a semantic one, which is the property that keeps the fallback from
 * claiming readiness it does not have.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createRetrievalController,
  WEAK_MATCH_CUE,
  type Answer,
  type QuestionEncoder,
} from "../src/chat/retrieval/controller.ts";
import { RetrievalError } from "../src/chat/retrieval/errors.ts";
import { createRetrievalEncoder } from "../src/chat/retrieval/encoder/index.ts";
import { SYNTHETIC_CARDS, WORKPLACE_CARDS, axisVector, syntheticIndex, tiedIndex } from "./retrieval-fixtures.ts";

const COVERED_QUESTION = "calendar scheduling";
const INADEQUATE_QUESTION = "calendar payments audio";

/** The short first turn that answers a workplace card and opens the follow-up context. */
const CONTEXT_QUESTION = "workplace history";

/** An encoder that records its calls and input lengths, never content. */
function countingEncoder(
  vector: number[] = axisVector(0),
): QuestionEncoder & { calls: number; lengths: number[] } {
  const encoder = Object.assign(
    (_question: string) => {
      encoder.calls += 1;
      encoder.lengths.push(_question.length);
      return Promise.resolve(vector);
    },
    { calls: 0, lengths: [] as number[] },
  );

  return encoder;
}

test("with no encoder the answer is limited matching and still comes from the index", async () => {
  const controller = createRetrievalController(syntheticIndex());
  const answer = await controller.ask(COVERED_QUESTION, null);

  assert.equal(answer.kind, "answer");
  assert.equal(answer.kind === "answer" && answer.matching, "limited");
  assert.equal(answer.kind === "answer" && answer.limitedCause, "model-unavailable");
  assert.equal(answer.kind === "answer" && answer.cardId, "synthetic-calendar");
  assert.equal(answer.kind === "answer" && answer.answer, SYNTHETIC_CARDS[0].answer);
});

test("an inadequate lexical match asks for a rephrase instead of guessing", async () => {
  const controller = createRetrievalController(syntheticIndex());
  const answer = await controller.ask(INADEQUATE_QUESTION, null);

  assert.deepEqual(answer, { kind: "rephrase", matching: "limited", limitedCause: "model-unavailable" });
});

test("a question with no meaningful words cannot produce a limited answer", async () => {
  const controller = createRetrievalController(syntheticIndex());

  assert.deepEqual(await controller.ask("what is it", null), {
    kind: "rephrase",
    matching: "limited",
    limitedCause: "model-unavailable",
  });
});

test("once an encoder is supplied the same question is answered semantically", async () => {
  const controller = createRetrievalController(syntheticIndex());
  const encoder = countingEncoder();

  const limited = await controller.ask(COVERED_QUESTION, null);
  const semantic = await controller.ask(COVERED_QUESTION, encoder);

  assert.equal(limited.kind === "answer" && limited.matching, "limited");
  assert.equal(semantic.kind, "answer");
  assert.equal(semantic.kind === "answer" && semantic.matching, "semantic");
  assert.equal(semantic.kind === "answer" && semantic.cardId, "synthetic-calendar");
  assert.equal(semantic.kind === "answer" && semantic.limitedCause, undefined);
  assert.equal(encoder.calls, 1);
});

test("an embedding failure falls back to limited matching, never to a semantic answer", async () => {
  const controller = createRetrievalController(syntheticIndex());
  const failing: QuestionEncoder = () => Promise.reject(new Error("vendor detail must not escape"));
  const answer = await controller.ask(COVERED_QUESTION, failing);

  assert.equal(answer.kind, "answer");
  assert.equal(answer.kind === "answer" && answer.matching, "limited");
  assert.equal(answer.kind === "answer" && answer.limitedCause, "embedding-failed");
  assert.equal(JSON.stringify(answer).includes("vendor detail"), false);
});

test("a lexical answer never carries the semantic weak-match cue", async () => {
  const controller = createRetrievalController(syntheticIndex());
  const answer = await controller.ask(COVERED_QUESTION, null);

  assert.equal(answer.kind === "answer" && answer.weak, false);
  assert.equal(JSON.stringify(answer).includes(WEAK_MATCH_CUE), false);
});

test("the weak cue is separate from the prepared answer text", async () => {
  // One card sits 58 degrees off the query axis, so its cosine lands between the two
  // floors: the single branch that adds the uncertainty cue.
  const index = syntheticIndex();
  const weakIndex = {
    ...index,
    cards: index.cards.map((card) =>
      card.id === "synthetic-calendar" ? { ...card, vector: tiltedVector(58) } : { ...card, vector: axisVector(5) },
    ),
  };
  const controller = createRetrievalController(weakIndex);
  const answer = await controller.ask(COVERED_QUESTION, countingEncoder(axisVector(0)));

  assert.equal(answer.kind, "answer");
  assert.equal(answer.kind === "answer" && answer.cardId, "synthetic-calendar");
  assert.equal(answer.kind === "answer" && answer.weak, true);
  assert.equal(answer.kind === "answer" && answer.answer, SYNTHETIC_CARDS[0].answer);
  assert.equal(WEAK_MATCH_CUE.includes(SYNTHETIC_CARDS[0].answer), false);
});

test("an empty question asks for a question instead of answering", async () => {
  const controller = createRetrievalController(syntheticIndex());
  const encoder = countingEncoder();

  assert.deepEqual(await controller.ask("   ", encoder), { kind: "ask-question" });
  assert.equal(encoder.calls, 0);
});

test("choosing an offered clarification needs no second inference", async () => {
  const controller = createRetrievalController(tiedIndex());
  const encoder = countingEncoder(axisVector(0));
  const clarification = await controller.ask(COVERED_QUESTION, encoder);

  assert.equal(clarification.kind, "clarify");
  assert.deepEqual(
    clarification.kind === "clarify" ? clarification.choices.map((choice) => choice.cardId) : [],
    ["synthetic-alpha", "synthetic-beta"],
  );

  const callsAfterClarification = encoder.calls;
  const chosen = controller.chooseClarification("synthetic-beta");

  assert.equal(chosen?.kind, "answer");
  assert.equal(chosen?.kind === "answer" && chosen.cardId, "synthetic-beta");
  assert.equal(chosen?.kind === "answer" && chosen.matching, "semantic");
  assert.equal(chosen?.kind === "answer" && chosen.answer, SYNTHETIC_CARDS[0].answer);
  assert.equal(encoder.calls, callsAfterClarification);
  assert.equal(controller.pendingChoices(), null);
});

test("choosing an id that was not offered returns nothing", async () => {
  const controller = createRetrievalController(tiedIndex());
  await controller.ask(COVERED_QUESTION, countingEncoder(axisVector(0)));

  // `synthetic-gamma` was never offered, so it cannot be selected.
  assert.equal(controller.chooseClarification("synthetic-gamma"), null);
  assert.equal(controller.chooseClarification("synthetic-alpha")?.kind, "answer");
});

test("a new question replaces any pending clarification choice", async () => {
  const controller = createRetrievalController(tiedIndex());

  await controller.ask(COVERED_QUESTION, countingEncoder(axisVector(0)));
  assert.notEqual(controller.pendingChoices(), null);

  const answered = await controller.ask(COVERED_QUESTION, countingEncoder(axisVector(2)));

  assert.equal(answered.kind === "answer" && answered.cardId, "synthetic-gamma");
  assert.equal(controller.pendingChoices(), null);
  assert.equal(controller.chooseClarification("synthetic-alpha"), null);
});

test("a limited answer also replaces a pending clarification choice", async () => {
  const controller = createRetrievalController(tiedIndex());

  await controller.ask(COVERED_QUESTION, countingEncoder(axisVector(0)));
  assert.notEqual(controller.pendingChoices(), null);

  const limited = await controller.ask(COVERED_QUESTION, null);

  assert.equal(limited.kind === "answer" && limited.matching, "limited");
  assert.equal(controller.pendingChoices(), null);
  assert.equal(controller.chooseClarification("synthetic-alpha"), null);
});

/** A unit vector at `degrees` from the first axis, so its cosine with a card on axis 0 is exact. */
function tiltedVector(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180;
  const vector = axisVector(0);
  vector[1] = Math.sin(radians);
  vector[0] = Math.cos(radians);
  return vector;
}

test("no semantic answer is possible while the encoder is absent", async () => {
  const controller = createRetrievalController(syntheticIndex());

  for (const question of [COVERED_QUESTION, INADEQUATE_QUESTION, "audio codec", "zzzz"]) {
    const answer = await controller.ask(question, null);

    assert.notEqual(answer.kind === "answer" && answer.matching, "semantic");
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

test("an obsolete resolution cannot restore clarification choices after a newer question", async () => {
  const controller = createRetrievalController(tiedIndex());
  const oldVector = deferred<readonly number[]>();
  const obsolete = controller.ask(COVERED_QUESTION, () => oldVector.promise);

  const current = await controller.ask(COVERED_QUESTION, null);
  assert.equal(current.kind, "answer");
  assert.equal(controller.pendingChoices(), null);

  oldVector.resolve(axisVector(0));

  assert.deepEqual(await obsolete, { kind: "superseded" });
  assert.equal(controller.pendingChoices(), null);
  assert.equal(controller.chooseClarification("synthetic-alpha"), null);
});

test("an obsolete rejection cannot erase a newer clarification or fall back", async () => {
  const controller = createRetrievalController(tiedIndex());
  const oldVector = deferred<readonly number[]>();
  const obsolete = controller.ask(COVERED_QUESTION, () => oldVector.promise);
  const current = await controller.ask(COVERED_QUESTION, countingEncoder(axisVector(0)));

  assert.equal(current.kind, "clarify");
  const offered = controller.pendingChoices();
  assert.deepEqual(offered?.map((choice) => choice.cardId), ["synthetic-alpha", "synthetic-beta"]);

  oldVector.reject(new Error("obsolete embedding failure"));

  assert.deepEqual(await obsolete, { kind: "superseded" });
  assert.deepEqual(controller.pendingChoices(), offered);
});

test("an active encoder cancellation does not become a limited lexical answer", async () => {
  const controller = createRetrievalController(syntheticIndex());

  for (const reason of ["embed/cancelled", "embed/closed", "embed/superseded"]) {
    const result = await controller.ask(COVERED_QUESTION, () => Promise.reject(new RetrievalError(reason)));

    assert.deepEqual(result, { kind: "cancelled" });
  }
});

test("a classified query-cap refusal remains a shorten result through the controller", async () => {
  const controller = createRetrievalController(syntheticIndex());
  const result = await controller.ask(COVERED_QUESTION, () => Promise.reject(new RetrievalError("query/too-long")));

  assert.deepEqual(result, { kind: "shorten", reason: "query/too-long" });
});

test("the real lazy encoder refuses an oversized question without creating its worker", async () => {
  const controller = createRetrievalController(syntheticIndex());
  let workerFactoryCalls = 0;
  const encoder = createRetrievalEncoder({
    workerFactory() {
      workerFactoryCalls += 1;
      throw new Error("worker construction should not be reached");
    },
  });

  try {
    const result = await controller.ask("calendar ".repeat(600), (question) => encoder.embed(question));

    assert.deepEqual(result, { kind: "shorten", reason: "query/too-long" });
    assert.equal(workerFactoryCalls, 0);
  } finally {
    encoder.close();
  }
});

test("an empty question clears an offer without starting another inference", async () => {
  const controller = createRetrievalController(tiedIndex());
  const encoder = countingEncoder(axisVector(0));

  assert.equal((await controller.ask(COVERED_QUESTION, encoder)).kind, "clarify");
  assert.notEqual(controller.pendingChoices(), null);

  assert.deepEqual(await controller.ask("   ", encoder), { kind: "ask-question" });
  assert.equal(controller.pendingChoices(), null);
  assert.equal(encoder.calls, 1);
});

test("a semantic question stays pending through encoder loading then answers once ready", async () => {
  let receive: (value: unknown) => void = () => undefined;
  let sendEmbed: ((message: { type: "embed"; id: number; question: string }) => void) | null = null;
  const embedPosted = new Promise<{ type: "embed"; id: number; question: string }>((resolve) => {
    sendEmbed = resolve;
  });
  const encoder = createRetrievalEncoder({
    workerFactory: () => ({
      postMessage(message) {
        if (message.type === "embed") sendEmbed?.(message);
      },
      terminate() {},
      onMessage(listener) {
        receive = listener;
      },
      onFailure() {},
    }),
  });
  const controller = createRetrievalController(syntheticIndex());

  try {
    const answer = controller.ask(`  ${COVERED_QUESTION}  `, (question) => encoder.embed(question));

    assert.equal(encoder.state, "loading");
    receive({
      type: "ready",
      dimensions: 384,
      loadMs: 1,
      runtimeVersion: "4.3.0",
      remoteHost: "https://example.test",
      remotePathTemplate: "{model}/resolve/e6ac24e5d6efb8782b59de1647b3ececb4ece94e/",
      files: ["model.onnx"],
    });

    const request = await embedPosted;
    assert.equal(request.question, COVERED_QUESTION);
    receive({ type: "vector", id: request.id, vector: axisVector(0), tokenCount: 2, durationMs: 1 });

    const result = await answer;
    assert.equal(result.kind, "answer");
    assert.equal(result.kind === "answer" && result.cardId, "synthetic-calendar");
    assert.equal(encoder.state, "ready");
  } finally {
    encoder.close();
  }
});

// Ordinal and short-query follow-ups: one answered turn gives a short question its context.

test("an ordinal follow-up picks the position of the discussed topic without embedding", async () => {
  const controller = createRetrievalController(syntheticIndex(WORKPLACE_CARDS));
  const encoder = countingEncoder(axisVector(4));

  const context = await controller.ask(CONTEXT_QUESTION, encoder);
  assert.equal(context.kind, "answer");
  assert.equal(encoder.calls, 1);

  const first = await controller.ask("first workplace", encoder);
  assert.equal(first.kind === "answer" && first.cardId, "synthetic-workplace-alpha");
  assert.equal(first.kind === "answer" && first.topic, WORKPLACE_CARDS[0].topic);

  const second = await controller.ask("second workplace", encoder);
  assert.equal(second.kind === "answer" && second.cardId, "synthetic-workplace-beta");
  assert.equal(second.kind === "answer" && second.matching, "semantic");
  assert.equal(second.kind === "answer" && second.weak, false);
  assert.equal(second.kind === "answer" && second.limitedCause, undefined);
  assert.equal(second.kind === "answer" && second.answer, WORKPLACE_CARDS[1].answer);

  const third = await controller.ask("third workplace", encoder);
  assert.equal(third.kind === "answer" && third.cardId, "synthetic-workplace-gamma");

  assert.equal(encoder.calls, 1, "the ordinal picks never embed");
});

test('"workplace number two" resolves like "second workplace"', async () => {
  const answers: Answer[] = [];

  for (const question of ["second workplace", "workplace number two"]) {
    const controller = createRetrievalController(syntheticIndex(WORKPLACE_CARDS));
    const encoder = countingEncoder(axisVector(4));

    await controller.ask(CONTEXT_QUESTION, encoder);
    const answer = await controller.ask(question, encoder);

    answers.push(answer);
    assert.equal(encoder.calls, 1, `${question} resolved without an embedding`);
  }

  assert.equal(answers[0].kind === "answer" && answers[0].cardId, "synthetic-workplace-beta");
  assert.deepEqual(answers[0], answers[1]);
});

test("an ordinal past the end of its group asks for a rephrase instead of guessing", async () => {
  const controller = createRetrievalController(syntheticIndex(WORKPLACE_CARDS));
  const encoder = countingEncoder(axisVector(4));

  await controller.ask(CONTEXT_QUESTION, encoder);
  const answer = await controller.ask("fourth workplace", encoder);

  assert.deepEqual(answer, { kind: "rephrase", matching: "semantic" });
  assert.equal(encoder.calls, 1, "an out-of-range ordinal never embeds");
});

test("an ordinal follow-up resolves after a clarification choice", async () => {
  const tied = syntheticIndex([
    WORKPLACE_CARDS[0],
    { ...WORKPLACE_CARDS[1], axis: 3 },
    WORKPLACE_CARDS[2],
  ]);
  const controller = createRetrievalController(tied);
  const encoder = countingEncoder(axisVector(3));

  const clarification = await controller.ask(CONTEXT_QUESTION, encoder);
  assert.equal(clarification.kind, "clarify");
  assert.equal(controller.chooseClarification("synthetic-workplace-beta")?.kind, "answer");

  const answer = await controller.ask("third workplace", encoder);

  assert.equal(answer.kind === "answer" && answer.cardId, "synthetic-workplace-gamma");
  assert.equal(encoder.calls, 1, "the choice and the ordinal need no second inference");
});

test("a short follow-up embeds the query with the last answered topic appended", async () => {
  const controller = createRetrievalController(syntheticIndex(WORKPLACE_CARDS));
  const encoder = countingEncoder(axisVector(4));

  await controller.ask(CONTEXT_QUESTION, encoder);
  const answer = await controller.ask("why", encoder);

  assert.equal(encoder.calls, 2);
  assert.ok((encoder.lengths[1] ?? 0) > "why".length, "the embedded query carries the appended topic");
  assert.equal(answer.kind, "answer");
});

test("an ordinal over an undiscussed topic falls back to the normal path", async () => {
  const controller = createRetrievalController(syntheticIndex([...SYNTHETIC_CARDS, ...WORKPLACE_CARDS]));
  const encoder = countingEncoder(axisVector(2));

  const context = await controller.ask(CONTEXT_QUESTION, encoder);
  assert.equal(context.kind === "answer" && context.cardId, "synthetic-codecs");

  const answer = await controller.ask("second workplace", encoder);

  assert.equal(encoder.calls, 2, "the topic was never discussed, so the question embeds");
  assert.ok(
    (encoder.lengths[1] ?? 0) > "second workplace".length,
    "the short query still carries the appended topic",
  );
  assert.equal(answer.kind === "answer" && answer.cardId, "synthetic-codecs");
});

test("a short question with no answered turn is embedded exactly as asked", async () => {
  const bare = createRetrievalController(syntheticIndex(WORKPLACE_CARDS));
  const bareEncoder = countingEncoder(axisVector(3));

  const bareAnswer = await bare.ask("why", bareEncoder);
  assert.equal(bareEncoder.calls, 1);
  assert.equal(bareEncoder.lengths[0], "why".length);
  assert.equal(bareAnswer.kind, "answer");

  const fresh = createRetrievalController(syntheticIndex(WORKPLACE_CARDS));
  const freshEncoder = countingEncoder(axisVector(3));

  const ordinal = await fresh.ask("second workplace", freshEncoder);
  assert.equal(freshEncoder.calls, 1);
  assert.equal(freshEncoder.lengths[0], "second workplace".length);
  assert.equal(ordinal.kind === "answer" && ordinal.cardId, "synthetic-workplace-alpha");
});
