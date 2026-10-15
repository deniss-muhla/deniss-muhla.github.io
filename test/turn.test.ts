/**
 * The turn flow's supersede rule of contract 6.2(d): a second send or a retry takes the
 * turn back from an answer that is still in flight, and the interrupted assistant bubble
 * reaches its terminal state instead of surviving as a stale pending marker. The terminal
 * state follows the `finalizeBubble` contract: shown text keeps standing without pending,
 * an empty bubble leaves the conversation, and neither can ever take late content. The
 * second rule this file pins is the greeting's: its speaking/listening transitions must
 * never erase a failure the panel surfaced while the greeting was speaking.
 *
 * Everything is synthetic: the engine double hands the test a deferred resolution per
 * asked question, the message list is a plain array behind the flow's own ports, and no
 * model, browser, network or CV text is involved.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Answer, AskOptions, ClarificationChoice } from "../src/chat/engine.ts";
import { AUDIO_CATALOG_TEXT, type AssistantClipSequence } from "../src/chat/audio-catalog.ts";
import type { SpeechOutputOptions } from "../src/chat/speech-output.ts";
import { GREETING } from "../src/chat/cv-context.ts";
import {
  createTurnFlow,
  type Message,
  type TurnEngine,
  type TurnPorts,
  type TurnState,
} from "../src/chat/turn.ts";

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface DeferredAsk {
  question: string;
  options: AskOptions;
  resolve: (answer: string) => void;
  reject: (reason: unknown) => void;
}

/** Assistant-plan playback, deferred so a test can interleave failure or interruption. */
interface DeferredSpeak {
  sequence: AssistantClipSequence;
  options: NonNullable<SpeechOutputOptions>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

type TestSourceRefs = readonly { startLine: number; endLine: number }[];

function syntheticAnswer(
  sourceRefs: TestSourceRefs,
  overrides: Partial<Extract<Answer, { kind: "answer" }>> = {},
): Extract<Answer, { kind: "answer" }> {
  return {
    kind: "answer",
    cardId: "synthetic-answer",
    topic: "Synthetic topic",
    answer: "Synthetic answer.",
    matching: "semantic",
    weak: true,
    sourceRefs: sourceRefs.length > 0 ? [...sourceRefs] : undefined,
    ...overrides,
  };
}

interface Harness {
  flow: ReturnType<typeof createTurnFlow>;
  messages: () => Message[];
  asks: DeferredAsk[];
  speaks: DeferredSpeak[];
  answerSelections: () => TestSourceRefs[];
  displayedChoices: () => readonly ClarificationChoice[] | null;
  turn: () => TurnState;
  notice: () => string | null;
  /** The mic failure double: how `VoiceChat.startListening` reports a refused microphone. */
  surfaceError: (message: string) => void;
  approveAudio: () => void;
  setPendingChoices: (choices: readonly ClarificationChoice[] | null) => void;
}

/** One flow over a plain message array: exactly the ports `VoiceChat` wires, minus React. */
function makeHarness(audioApproved = true): Harness {
  let list: Message[] = [];
  let nextId = 1;
  const asks: DeferredAsk[] = [];
  const speaks: DeferredSpeak[] = [];
  let activeSpeak: DeferredSpeak | null = null;
  const selectedRefs: TestSourceRefs[] = [];
  let offeredChoices: readonly ClarificationChoice[] | null = null;
  let displayedChoices: readonly ClarificationChoice[] | null = null;
  let turn: TurnState = "idle";
  let notice: string | null = null;

  const engine: TurnEngine = {
    ask: (question, options = {}) =>
      new Promise<string>((resolve, reject) => {
        asks.push({ question, options, resolve, reject });
      }),
    interrupt: () => undefined,
    stopAudio: () => {
      const speaking = activeSpeak;
      activeSpeak = null;
      speaking?.resolve();
    },
    pendingChoices: () => offeredChoices,
    speakSequence: (sequence, options = {}) =>
      new Promise<void>((resolve, reject) => {
        const speaking = { sequence, options, resolve, reject };
        speaks.push(speaking);
        activeSpeak = speaking;
      }),
  };

  const ports: TurnPorts = {
    engine,
    refs: {
      revision: { current: 0 },
      activeUser: { current: null },
      activeAssistant: { current: null },
    },
    append: (role, text, pending = false, audioBinding = {}) => {
      const id = nextId++;
      list = [...list, { id, role, text, pending, ...audioBinding }];
      return id;
    },
    update: (id, patch) => {
      list = list.map((message) => (message.id === id ? { ...message, ...patch } : message));
    },
    remove: (id) => {
      list = list.filter((message) => message.id !== id);
    },
    setMessages: (updater) => {
      list = updater(list);
    },
    setTurn: (next) => {
      turn = typeof next === "function" ? next(turn) : next;
    },
    setChoices: (choices) => { displayedChoices = choices; },
    setRetryOf: () => undefined,
    setNotice: (message) => {
      notice = message;
    },
    canSpeak: () => audioApproved,
    resetTurnText: () => undefined,
    onAnswer: (sourceRefs) => selectedRefs.push(sourceRefs),
  };

  return {
    flow: createTurnFlow(ports),
    messages: () => list,
    asks,
    speaks,
    answerSelections: () => selectedRefs,
    displayedChoices: () => displayedChoices,
    turn: () => turn,
    notice: () => notice,
    approveAudio: () => { audioApproved = true; },
    setPendingChoices: (choices) => { offeredChoices = choices; },
    surfaceError: (message) => {
      ports.setNotice(message);
      ports.setTurn("error");
    },
  };
}

const assistantBubbles = (harness: Harness): Message[] =>
  harness.messages().filter((message) => message.role === "assistant");

const pendingMessages = (harness: Harness): Message[] =>
  harness.messages().filter((message) => message.pending === true);

async function deliverResult(harness: Harness, result: Answer): Promise<Message> {
  harness.flow.respond("synthetic request");
  await settle();
  const assistantId = assistantBubbles(harness)[0].id;
  const ask = harness.asks[0];
  ask.options.onResult?.(result);
  ask.resolve(result.kind === "answer" ? result.answer : "");
  await settle();
  const message = harness.messages().find((item) => item.id === assistantId);
  assert.ok(message, "the result remains on its assistant message");
  return message;
}

test("selected answers emit navigation refs while clarification offers and refusals do not", async () => {
  const refs = [{ startLine: 4, endLine: 8 }];
  const result = syntheticAnswer(refs);
  const selected = makeHarness();

  selected.flow.respond("synthetic request");
  await settle();
  selected.asks[0].options.onResult?.(result);
  selected.asks[0].resolve("Synthetic answer.");
  await settle();

  assert.deepEqual(selected.answerSelections(), [refs], "a weak selected answer still navigates");

  const chosen = makeHarness();
  chosen.flow.answerSelected(result);
  assert.deepEqual(chosen.answerSelections(), [refs], "a valid clarification selection navigates");

  const offered = makeHarness();
  offered.flow.respond("synthetic request");
  await settle();
  offered.asks[0].options.onResult?.({
    kind: "clarify",
    choices: [{ cardId: "synthetic-choice", topic: "Synthetic choice", score: 0.8 }],
  });
  offered.asks[0].resolve("Synthetic clarification offer.");
  await settle();

  assert.deepEqual(offered.answerSelections(), [], "offering a choice does not navigate");

  const refused = makeHarness();
  refused.flow.respond("synthetic request");
  await settle();
  refused.asks[0].options.onResult?.({ kind: "rephrase", matching: "semantic" });
  refused.asks[0].resolve("Synthetic refusal.");
  await settle();

  assert.deepEqual(refused.answerSelections(), [], "a refusal does not navigate");
});

test("assistant messages store an immutable selected-card sequence before playback", async () => {
  const h = makeHarness();
  const selected = syntheticAnswer([], {
    cardId: "variant-card-2",
    answer: "Selected synthetic answer.",
    weak: true,
  });

  h.flow.respond("synthetic request");
  await settle();
  h.asks[0].options.onResult?.(selected);

  const message = assistantBubbles(h)[0];
  assert.equal(message.selectedCardId, "variant-card-2");
  assert.deepEqual(message.audioSequence, [
    { kind: "catalog", id: "weakMatchNote", text: AUDIO_CATALOG_TEXT.weakMatchNote },
    { kind: "fact", cardId: "variant-card-2", text: "Selected synthetic answer." },
  ]);
  assert.equal(Object.isFrozen(message.audioSequence), true);
  assert.ok(message.audioSequence?.every((clip) => Object.isFrozen(clip)));

  h.asks[0].resolve(selected.answer);
  await settle();
  assert.strictEqual(h.speaks[0].sequence, message.audioSequence, "live output uses the stored plan");
  assert.equal(h.asks.length, 1, "planning does not rerun retrieval or choose another variant");
});

test("limited answer plans keep the exact note before the selected fact", async () => {
  const h = makeHarness();
  const result = syntheticAnswer([], {
    cardId: "limited-card",
    weak: false,
    matching: "limited",
    limitedCause: "embedding-failed",
  });
  const message = await deliverResult(h, result);

  assert.deepEqual(message.audioSequence, [
    {
      kind: "catalog",
      id: "limitedAnswerEmbeddingFailed",
      text: AUDIO_CATALOG_TEXT.limitedAnswerEmbeddingFailed,
    },
    { kind: "fact", cardId: "limited-card", text: result.answer },
  ]);
  assert.equal(message.selectedCardId, "limited-card");
});

test("clarification plans snapshot the exact result choices, not pending engine choices", async () => {
  const h = makeHarness();
  const choices: ClarificationChoice[] = [
    { cardId: "result-choice-a", topic: "Result topic A", score: 0.51 },
    { cardId: "result-choice-b", topic: "Result topic B", score: 0.5 },
  ];
  h.setPendingChoices([
    { cardId: "different-pending-choice", topic: "Different pending topic", score: 0.9 },
  ]);
  const message = await deliverResult(h, { kind: "clarify", choices });

  assert.deepEqual(h.displayedChoices(), choices);
  assert.equal(Object.isFrozen(h.displayedChoices()), true);
  assert.ok(h.displayedChoices()?.every((choice) => Object.isFrozen(choice)));

  choices[0].cardId = "mutated-card";
  choices[0].topic = "Mutated topic";
  h.setPendingChoices([{ cardId: "later-pending-choice", topic: "Later topic", score: 0.8 }]);

  assert.deepEqual(h.displayedChoices(), [
    { cardId: "result-choice-a", topic: "Result topic A", score: 0.51 },
    { cardId: "result-choice-b", topic: "Result topic B", score: 0.5 },
  ]);
  assert.equal(message.selectedCardId, undefined);
  assert.deepEqual(message.audioSequence, [
    { kind: "catalog", id: "clarifyPrompt", text: AUDIO_CATALOG_TEXT.clarifyPrompt },
    { kind: "topic", cardId: "result-choice-a", text: "Result topic A" },
    { kind: "topic", cardId: "result-choice-b", text: "Result topic B" },
  ]);
  assert.equal(Object.isFrozen(message.audioSequence), true);
});

test("clarification selections bind immutable answer messages to the selected result", async () => {
  const h = makeHarness(false);
  const choices: ClarificationChoice[] = [
    { cardId: "offered-card-a", topic: "Offered topic A", score: 0.51 },
    { cardId: "offered-card-b", topic: "Offered topic B", score: 0.5 },
  ];

  h.flow.respond("synthetic request");
  await settle();
  h.asks[0].options.onResult?.({ kind: "clarify", choices });
  h.asks[0].resolve(AUDIO_CATALOG_TEXT.clarifyPrompt);
  await settle();

  const offer = assistantBubbles(h)[0];
  const expectedOfferSequence = [
    { kind: "catalog", id: "clarifyPrompt", text: "Which of these did you mean?" },
    { kind: "topic", cardId: "offered-card-a", text: "Offered topic A" },
    { kind: "topic", cardId: "offered-card-b", text: "Offered topic B" },
  ];
  assert.equal(offer.selectedCardId, undefined, "the clarification offer has no selected answer id");
  assert.deepEqual(offer.audioSequence, expectedOfferSequence);

  const firstRefs = [{ startLine: 14, endLine: 18 }];
  const firstPick = syntheticAnswer(firstRefs, {
    cardId: "selected-card-b",
    topic: "Selected topic B",
    answer: "Prepared answer from selected card B.",
    matching: "semantic",
    weak: false,
  });
  const firstMessageId = h.flow.appendSelectedAnswer(firstPick);
  const firstMessage = h.messages().find((message) => message.id === firstMessageId);
  assert.ok(firstMessage, "the selected result creates an assistant message");
  assert.equal(firstMessage.role, "assistant");
  assert.equal(firstMessage.text, "Prepared answer from selected card B.");
  assert.equal(firstMessage.selectedCardId, "selected-card-b");
  assert.deepEqual(firstMessage.audioSequence, [
    { kind: "fact", cardId: "selected-card-b", text: "Prepared answer from selected card B." },
  ]);
  assert.equal(Object.isFrozen(firstMessage.audioSequence), true);
  assert.ok(firstMessage.audioSequence?.every((clip) => Object.isFrozen(clip)));
  assert.deepEqual(h.answerSelections(), [[{ startLine: 14, endLine: 18 }]], "one valid pick navigates once");
  assert.equal(h.asks.length, 1, "selecting a card does not ask or reselect");
  assert.equal(h.speaks.length, 0, "silent typed selection stores a plan without autoplay");

  const retainedSequence = firstMessage.audioSequence;
  firstPick.cardId = "mutated-card-after-binding";
  firstPick.answer = "Mutated answer after binding.";
  choices[0].cardId = "mutated-offer-card";
  choices[0].topic = "Mutated offer topic";

  const secondRefs = [{ startLine: 24, endLine: 27 }];
  const secondPick = syntheticAnswer(secondRefs, {
    cardId: "selected-card-a",
    answer: "Prepared answer from selected card A.",
    matching: "semantic",
    weak: false,
  });
  const secondMessageId = h.flow.appendSelectedAnswer(secondPick);
  const secondMessage = h.messages().find((message) => message.id === secondMessageId);
  assert.equal(secondMessage?.text, "Prepared answer from selected card A.");
  assert.equal(secondMessage?.selectedCardId, "selected-card-a");
  assert.deepEqual(secondMessage?.audioSequence, [
    { kind: "fact", cardId: "selected-card-a", text: "Prepared answer from selected card A." },
  ]);

  const firstAfterSecondPick = h.messages().find((message) => message.id === firstMessageId);
  assert.equal(firstAfterSecondPick?.text, "Prepared answer from selected card B.");
  assert.equal(firstAfterSecondPick?.selectedCardId, "selected-card-b");
  assert.strictEqual(firstAfterSecondPick?.audioSequence, retainedSequence);
  assert.deepEqual(offer.audioSequence, expectedOfferSequence, "later choice mutation cannot change the offer plan");
  assert.deepEqual(h.answerSelections(), [
    [{ startLine: 14, endLine: 18 }],
    [{ startLine: 24, endLine: 27 }],
  ], "each selected result navigates once");

  h.flow.supersedeAnswer();
  const firstAfterInterruption = h.messages().find((message) => message.id === firstMessageId);
  assert.equal(firstAfterInterruption?.text, "Prepared answer from selected card B.");
  assert.strictEqual(firstAfterInterruption?.audioSequence, retainedSequence);
});

test("an empty malformed clarification stays visible without an audio plan", async () => {
  const h = makeHarness();
  const message = await deliverResult(h, { kind: "clarify", choices: [] });

  assert.equal(message.text, AUDIO_CATALOG_TEXT.clarifyPrompt);
  assert.equal(message.audioSequence, undefined);
  assert.deepEqual(h.displayedChoices(), []);
});

test("fixed rephrase and question notices store their finite catalog plan", async () => {
  const cases: { result: Answer; id: string; text: string }[] = [
    { result: { kind: "rephrase", matching: "semantic" }, id: "rephrase", text: AUDIO_CATALOG_TEXT.rephrase },
    {
      result: { kind: "rephrase", matching: "limited", limitedCause: "model-unavailable" },
      id: "limitedRephraseModelUnavailable",
      text: AUDIO_CATALOG_TEXT.limitedRephraseModelUnavailable,
    },
    {
      result: { kind: "rephrase", matching: "limited", limitedCause: "embedding-failed" },
      id: "limitedRephraseEmbeddingFailed",
      text: AUDIO_CATALOG_TEXT.limitedRephraseEmbeddingFailed,
    },
    { result: { kind: "shorten", reason: "query/too-long" }, id: "shorten", text: AUDIO_CATALOG_TEXT.shorten },
    { result: { kind: "ask-question" }, id: "askQuestion", text: AUDIO_CATALOG_TEXT.askQuestion },
  ];

  for (const item of cases) {
    const message = await deliverResult(makeHarness(), item.result);
    assert.deepEqual(message.audioSequence, [{ kind: "catalog", id: item.id, text: item.text }]);
    assert.equal(message.selectedCardId, undefined);
  }
});

test("only canonical greeting text stores a greeting plan and repeated calls keep one bubble", () => {
  const canonical = makeHarness();
  canonical.flow.showGreeting(GREETING);
  canonical.flow.showGreeting("different text");
  assert.equal(assistantBubbles(canonical).length, 1);
  assert.deepEqual(assistantBubbles(canonical)[0].audioSequence, [
    { kind: "catalog", id: "greeting", text: GREETING },
  ]);

  const custom = makeHarness();
  custom.flow.showGreeting("custom welcome");
  custom.flow.showGreeting(GREETING);
  assert.equal(assistantBubbles(custom).length, 1);
  assert.equal(assistantBubbles(custom)[0].text, "custom welcome");
  assert.equal(assistantBubbles(custom)[0].audioSequence, undefined);
});

test("user and error-status messages never receive assistant audio plans", async () => {
  const h = makeHarness();
  h.flow.send("typed synthetic question");
  await settle();
  assert.equal(h.messages().find((message) => message.role === "user")?.audioSequence, undefined);

  h.asks[0].reject(new Error("synthetic request failure"));
  await settle();
  const status = h.messages().find((message) => message.role === "status");
  assert.equal(status?.text, "synthetic request failure");
  assert.equal(status?.audioSequence, undefined);
});

test("a second send finalizes the superseded bubble, which never takes late content", async () => {
  const harness = makeHarness();

  harness.flow.send("first question");
  await settle();
  assert.equal(harness.asks.length, 1, "the first question reached the engine");

  // Interim content and the exact answer plan arrive before the owner sends again.
  const firstAsk = harness.asks[0];
  firstAsk.options.onDelta?.("interim answer");
  firstAsk.options.onResult?.(syntheticAnswer([], { cardId: "retained-card", weak: false }));
  const superseded = assistantBubbles(harness)[0];
  const retainedSequence = superseded.audioSequence;
  assert.equal(superseded.text, "interim answer");
  assert.equal(superseded.pending, true, "the first bubble waits for the deferred result");
  assert.equal(superseded.selectedCardId, "retained-card");
  assert.ok(retainedSequence, "the selected answer plan is stored before interruption");

  harness.flow.send("second question");
  await settle();

  // The fail-before assertion: without the settle step the superseded bubble keeps
  // `pending` forever, because send() nulls the active-assistant ref before any finalize.
  const kept = harness.messages().find((message) => message.id === superseded.id);
  assert.ok(kept, "already-shown text keeps standing");
  assert.equal(kept.pending, false, "no stale pending marker may survive the second send");

  // The new turn proceeds normally: its own bubble is the only pending message.
  assert.equal(harness.asks.length, 2, "the second question reached the engine");
  const stillPending = pendingMessages(harness);
  assert.equal(stillPending.length, 1, "exactly the new turn's bubble is pending");
  assert.equal(stillPending[0].role, "assistant");

  // The deferred resolution of the first turn lands after the supersede: no late content.
  firstAsk.options.onDelta?.("late content");
  firstAsk.options.onResult?.(syntheticAnswer([{ startLine: 4, endLine: 8 }]));
  firstAsk.resolve("stale answer");
  await settle();

  assert.deepEqual(harness.answerSelections(), [], "a superseded result never navigates");
  const after = harness.messages().find((message) => message.id === superseded.id);
  assert.equal(after?.text, "interim answer", "a superseded turn writes no late content");
  assert.equal(after?.pending, false, "a late resolution cannot re-pend the finalized bubble");
  assert.equal(after?.audioSequence, retainedSequence, "the visible finalized message keeps its exact plan");
  assert.equal(after?.selectedCardId, "retained-card");

  // The new turn completes on its own.
  const secondAsk = harness.asks[1];
  secondAsk.options.onDelta?.("second answer");
  secondAsk.resolve("second answer");
  await settle();

  const bubbles = assistantBubbles(harness);
  assert.equal(bubbles.length, 2, "superseded kept-text plus the new answer");
  const finished = bubbles[bubbles.length - 1];
  assert.equal(finished.text, "second answer");
  assert.equal(finished.pending, false, "the new turn settles normally");
  assert.equal(harness.turn(), "listening", "the flow returns to listening after the answer");
});

test("a second send drops the empty superseded bubble instead of leaving it pending", async () => {
  const harness = makeHarness();

  harness.flow.send("first question");
  await settle();
  const superseded = assistantBubbles(harness)[0];
  assert.equal(superseded.text, "", "no content reached the first bubble yet");

  harness.flow.send("second question");
  await settle();

  // The finalizeBubble contract for empty text: the bubble leaves the conversation.
  const survived = harness.messages().some((message) => message.id === superseded.id);
  assert.equal(survived, false, "an empty superseded bubble is dropped, not left pending");

  const stillPending = pendingMessages(harness);
  assert.equal(stillPending.length, 1, "only the new turn's bubble carries pending");

  harness.asks[1].resolve("second answer");
  await settle();

  const bubbles = assistantBubbles(harness);
  assert.equal(bubbles.length, 1, "the new turn's answer is the only assistant bubble left");
  assert.equal(bubbles[0].pending, false);
});

test("retry supersedes the in-flight answer through the same settle path", async () => {
  const harness = makeHarness();

  harness.flow.respond("first question");
  await settle();
  assert.equal(harness.asks.length, 1);
  const firstAsk = harness.asks[0];
  const superseded = assistantBubbles(harness)[0];

  harness.flow.retry("first question");
  await settle();

  const survived = harness.messages().some((message) => message.id === superseded.id);
  assert.equal(survived, false, "an empty superseded bubble is dropped, not left pending");

  const stillPending = pendingMessages(harness);
  assert.equal(stillPending.length, 1, "only the retried turn's bubble carries pending");

  // The deferred result of the superseded attempt lands late and writes nothing.
  firstAsk.resolve("stale answer");
  await settle();
  const late = harness.messages().some((message) => message.text === "stale answer");
  assert.equal(late, false, "a superseded retry never receives late content");

  assert.equal(harness.asks.length, 2, "the retry re-asked the question");
  harness.asks[1].resolve("retried answer");
  await settle();

  const bubbles = assistantBubbles(harness);
  assert.equal(bubbles.length, 1, "the retried turn's answer stands alone");
  assert.equal(bubbles[0].text, "retried answer");
  assert.equal(bubbles[0].pending, false, "the retried turn settles normally");
});

test("typed consent stays silent while approved live playback uses the greeting plan", async () => {
  const h = makeHarness(false);
  h.flow.showGreeting(GREETING);
  assert.equal(assistantBubbles(h).length, 1);
  assert.equal(await h.flow.greet(GREETING), false);
  assert.equal(h.speaks.length, 0);

  const answer = syntheticAnswer([], { cardId: "typed-card", weak: false });
  const response = h.flow.respond("synthetic typed question");
  assert.equal(Object.hasOwn(h.asks[0].options, "speak"), false, "retrieval never owns speech consent");
  h.asks[0].options.onResult?.(answer);
  h.asks[0].options.onDelta?.(answer.answer);
  h.asks[0].resolve(answer.answer);
  await response;
  assert.equal(h.speaks.length, 0, "typed answers store their plan without autoplay");
  assert.deepEqual(assistantBubbles(h).at(-1)?.audioSequence, [
    { kind: "fact", cardId: "typed-card", text: answer.answer },
  ]);

  h.approveAudio();
  const greeting = h.flow.greet(GREETING);
  assert.equal(h.speaks.length, 1);
  assert.deepEqual(h.speaks[0].sequence, [
    { kind: "catalog", id: "greeting", text: GREETING },
  ]);
  h.speaks[0].resolve();
  assert.equal(await greeting, true);
  assert.equal(assistantBubbles(h).length, 2, "approval does not add another greeting bubble");
});

test("live autoplay and explicit replay use the exact stored message plan without re-asking", async () => {
  const h = makeHarness();
  const answer = syntheticAnswer([], {
    cardId: "replay-card",
    answer: "Prepared replay answer.",
    weak: false,
  });
  const response = h.flow.respond("synthetic live question");
  h.asks[0].options.onResult?.(answer);
  h.asks[0].options.onDelta?.(answer.answer);
  h.asks[0].resolve(answer.answer);
  await settle();

  const message = assistantBubbles(h)[0];
  assert.ok(message.audioSequence);
  assert.strictEqual(h.speaks[0].sequence, message.audioSequence, "autoplay consumes the bound plan");
  h.speaks[0].options.onSpeakingChange?.(true);
  assert.equal(h.turn(), "speaking");

  const replay = h.flow.replay(message.audioSequence);
  assert.equal(h.speaks.length, 2);
  assert.strictEqual(h.speaks[1].sequence, message.audioSequence, "replay reuses that exact plan");
  assert.equal(h.asks.length, 1, "replay does not query or select again");
  h.speaks[1].resolve();
  assert.equal(await replay, true);
  h.speaks[0].resolve();
  await response;
  assert.equal(message.text, answer.answer, "the visible message remains unchanged");
});

test("speech failure preserves the answer and creates a silent status message", async () => {
  const h = makeHarness();
  const answer = syntheticAnswer([], { cardId: "speech-failure-card", weak: false });
  const response = h.flow.respond("synthetic question");
  h.asks[0].options.onResult?.(answer);
  h.asks[0].options.onDelta?.(answer.answer);
  h.asks[0].resolve(answer.answer);
  await settle();

  const assistant = assistantBubbles(h)[0];
  const retainedSequence = assistant.audioSequence;
  assert.ok(retainedSequence);
  h.speaks[0].reject(new Error("vendor detail must not be exposed"));
  await response;

  assert.equal(assistantBubbles(h)[0].text, answer.answer);
  assert.strictEqual(assistantBubbles(h)[0].audioSequence, retainedSequence);
  const status = h.messages().find((message) => message.role === "status");
  assert.equal(status?.text, "Speech output failed: Speech audio could not be played.");
  assert.equal(status?.audioSequence, undefined, "playback errors never receive an audio plan");
  assert.equal(h.turn(), "listening", "speech failure leaves text and typed input ready");
});

test("a failed greeting can be retried without repeating its bubble", async () => {
  const h = makeHarness();
  const first = h.flow.greet(GREETING);
  h.speaks[0].reject(new Error("synthetic audio failure"));
  assert.equal(await first, false);
  const retry = h.flow.greet(GREETING);
  assert.equal(h.speaks.length, 2);
  h.speaks[1].resolve();
  assert.equal(await retry, true);
  assert.equal(assistantBubbles(h).length, 1);
});

test("the greeting speaks its stored plan once and settles into listening", async () => {
  const harness = makeHarness();

  const greeting = harness.flow.greet(GREETING);
  await settle();

  assert.equal(harness.speaks.length, 1, "the greeting started its speech");
  assert.deepEqual(harness.speaks[0].sequence, [
    { kind: "catalog", id: "greeting", text: GREETING },
  ]);
  assert.equal(assistantBubbles(harness)[0].text, GREETING, "the visible greeting stays in chat");

  harness.speaks[0].options.onSpeakingChange?.(true);
  assert.equal(harness.turn(), "speaking", "the greeting shows its speaking state");
  harness.speaks[0].options.onSpeakingChange?.(false);
  harness.speaks[0].resolve();
  await greeting;
  await settle();

  assert.equal(harness.turn(), "listening", "a greeting with no failure settles into listening");

  await harness.flow.greet(GREETING);
  await settle();
  assert.equal(harness.speaks.length, 1, "the greeting runs once per panel");
  assert.equal(assistantBubbles(harness).length, 1, "one greeting bubble, never a second");
});

test("a surfaced microphone failure survives the greeting turn", async () => {
  const harness = makeHarness();

  const greeting = harness.flow.greet(GREETING);
  await settle();
  assert.equal(harness.speaks.length, 1, "the greeting started its speech");
  harness.speaks[0].options.onSpeakingChange?.(true);
  assert.equal(harness.turn(), "speaking", "the greeting shows its speaking state");

  harness.surfaceError("microphone-unavailable");
  assert.equal(harness.turn(), "error", "the mic failure reaches the panel");

  harness.speaks[0].options.onSpeakingChange?.(false);
  assert.equal(harness.turn(), "error", "speech transitions do not erase the mic failure");

  harness.speaks[0].resolve();
  await greeting;
  await settle();

  assert.equal(harness.turn(), "error", "the error state survives the greeting turn");
  assert.equal(harness.notice(), "microphone-unavailable", "the missing input remains explained");
});

test("greeting message identity stays bound through repeat display and changes only on reset", () => {
  const h = makeHarness();
  const first = h.flow.showGreeting(GREETING);
  assert.equal(h.flow.showGreeting(GREETING), first);
  assert.equal(assistantBubbles(h).find((message) => message.id === first)?.text, GREETING);
  h.flow.resetConversation();
  const next = h.flow.showGreeting(GREETING);
  assert.notEqual(next, first);
  assert.equal(assistantBubbles(h).find((message) => message.id === next)?.text, GREETING);
});
