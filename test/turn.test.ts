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

import type { AskOptions } from "../src/chat/engine.ts";
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
}

/** The greeting's spoken line, deferred so a test can interleave a failure with it. */
interface DeferredSpeak {
  text: string;
  options: NonNullable<Parameters<TurnEngine["speak"]>[1]>;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

interface Harness {
  flow: ReturnType<typeof createTurnFlow>;
  messages: () => Message[];
  asks: DeferredAsk[];
  speaks: DeferredSpeak[];
  turn: () => TurnState;
  notice: () => string | null;
  /** The mic failure double: how `VoiceChat.startListening` reports a refused microphone. */
  surfaceError: (message: string) => void;
}

/** One flow over a plain message array: exactly the ports `VoiceChat` wires, minus React. */
function makeHarness(): Harness {
  let list: Message[] = [];
  let nextId = 1;
  const asks: DeferredAsk[] = [];
  const speaks: DeferredSpeak[] = [];
  let turn: TurnState = "idle";
  let notice: string | null = null;

  const engine: TurnEngine = {
    ask: (question, options = {}) =>
      new Promise<string>((resolve) => {
        asks.push({ question, options, resolve });
      }),
    interrupt: () => undefined,
    stopAudio: () => undefined,
    pendingChoices: () => null,
    speak: (text, options = {}) =>
      new Promise<void>((resolve, reject) => {
        speaks.push({ text, options, resolve, reject });
      }),
  };

  const ports: TurnPorts = {
    engine,
    refs: {
      revision: { current: 0 },
      activeUser: { current: null },
      activeAssistant: { current: null },
    },
    append: (role, text, pending = false) => {
      const id = nextId++;
      list = [...list, { id, role, text, pending }];
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
    setChoices: () => undefined,
    setRetryOf: () => undefined,
    setNotice: (message) => {
      notice = message;
    },
    cancelPause: () => undefined,
    resetTurnText: () => undefined,
  };

  return {
    flow: createTurnFlow(ports),
    messages: () => list,
    asks,
    speaks,
    turn: () => turn,
    notice: () => notice,
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

test("a second send finalizes the superseded bubble, which never takes late content", async () => {
  const harness = makeHarness();

  harness.flow.send("first question");
  await settle();
  assert.equal(harness.asks.length, 1, "the first question reached the engine");

  // Interim content arrives before the owner sends again: shown text keeps standing.
  const firstAsk = harness.asks[0];
  firstAsk.options.onDelta?.("interim answer");
  const superseded = assistantBubbles(harness)[0];
  assert.equal(superseded.text, "interim answer");
  assert.equal(superseded.pending, true, "the first bubble waits for the deferred result");

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
  firstAsk.resolve("stale answer");
  await settle();

  const after = harness.messages().find((message) => message.id === superseded.id);
  assert.equal(after?.text, "interim answer", "a superseded turn writes no late content");
  assert.equal(after?.pending, false, "a late resolution cannot re-pend the finalized bubble");

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

test("the greeting speaks once and settles the panel into listening", async () => {
  const harness = makeHarness();

  const greeting = harness.flow.greet("welcome line");
  await settle();

  assert.equal(harness.speaks.length, 1, "the greeting started its speech");
  assert.equal(harness.speaks[0].text, "welcome line");
  assert.equal(assistantBubbles(harness).length, 1, "the greeting appended its bubble");

  harness.speaks[0].options.onSpeakingChange?.(true);
  assert.equal(harness.turn(), "speaking", "the greeting shows its speaking state");
  harness.speaks[0].options.onSpeakingChange?.(false);
  harness.speaks[0].resolve();
  await greeting;
  await settle();

  assert.equal(harness.turn(), "listening", "a greeting with no failure settles into listening");

  await harness.flow.greet("welcome line");
  await settle();
  assert.equal(harness.speaks.length, 1, "the greeting runs once per panel");
  assert.equal(assistantBubbles(harness).length, 1, "one greeting bubble, never a second");
});

test("a surfaced microphone failure survives the greeting turn", async () => {
  const harness = makeHarness();

  const greeting = harness.flow.greet("welcome line");
  await settle();
  assert.equal(harness.speaks.length, 1, "the greeting started its speech");
  harness.speaks[0].options.onSpeakingChange?.(true);
  assert.equal(harness.turn(), "speaking", "the greeting shows its speaking state");

  // The open's listening attempt fails while the greeting still speaks, exactly how
  // row 11's first open failed: the notice is set and the state turns to error.
  harness.surfaceError("microphone-unavailable");
  assert.equal(harness.turn(), "error", "the mic failure reaches the panel");

  // The greeting's own transitions arrive after the failure and must not take it back:
  // this is the fail-before assertion, the overwrite row 11 observed on first open.
  harness.speaks[0].options.onSpeakingChange?.(false);
  assert.equal(harness.turn(), "error", "the greeting's listening transition keeps the failure");

  harness.speaks[0].resolve();
  await greeting;
  await settle();

  assert.equal(harness.turn(), "error", "the error state survives the greeting turn");
  assert.equal(
    harness.notice(),
    "microphone-unavailable",
    "the notice still explains what is missing",
  );
});
