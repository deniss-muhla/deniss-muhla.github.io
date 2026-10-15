/**
 * The engine lifecycle rules of design decision 10 behind the chat's own seams: data saving
 * makes no model request before the explicit chat open, that open starts the encoder load
 * with real library progress, other connections keep the background prefetch, a closed panel
 * shows no late answer and no playback, and a reopen reuses the cached model. The explicit
 * open is also where the persist ask happens: once per open, inside the gesture, never
 * from the background prefetch.
 *
 * Everything is synthetic: the index is the shared fixture, the encoder worker is a double
 * and speech is recorded on the instance, so no model, worker, network or CV text is
 * involved. The capability probe runs against stubbed `window` and `navigator.mediaDevices`
 * values, and the connection hint arrives only through the engine's own seam.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

import { AUDIO_CATALOG_TEXT, type AssistantClipSequence } from "../src/chat/audio-catalog.ts";
import { GREETING, INTRO } from "../src/chat/cv-context.ts";
import { VoiceEngine, type Answer, type AskOptions, type ClarificationChoice } from "../src/chat/engine.ts";
import { createTurnFlow, type Message } from "../src/chat/turn.ts";
import { createRetrievalController } from "../src/chat/retrieval/controller.ts";
import {
  createRetrievalEncoder,
  type EncoderWorker,
} from "../src/chat/retrieval/encoder/index.ts";
import { EXPECTED_EMBEDDING } from "../src/chat/retrieval/index.ts";
import type { EncoderRequest } from "../src/chat/retrieval/encoder/protocol.ts";
import { axisVector, syntheticIndex } from "./retrieval-fixtures.ts";

// The capability probe reads these two values; nothing else of the browser is needed.
(globalThis as { window?: unknown }).window = { crossOriginIsolated: false };
if (typeof navigator !== "undefined" && !("mediaDevices" in navigator)) {
  Object.assign(navigator, { mediaDevices: {} });
}

const QUESTION = "calendar scheduling";
const DIMENSIONS = EXPECTED_EMBEDDING.dimensions;

/** A worker double: it records what was sent and lets the test decide what comes back. */
class FakeWorker implements EncoderWorker {
  readonly sent: EncoderRequest[] = [];
  private messageListener: (value: unknown) => void = () => undefined;

  postMessage(message: EncoderRequest): void {
    this.sent.push(message);
  }

  terminate(): void {}

  onMessage(listener: (value: unknown) => void): void {
    this.messageListener = listener;
  }

  onFailure(): void {
    // This double never fails a load; no lifecycle test drives the failure path.
  }

  emit(value: unknown): void {
    this.messageListener(value);
  }
}

function readyMessage(): Record<string, unknown> {
  return {
    type: "ready",
    dimensions: DIMENSIONS,
    loadMs: 20,
    runtimeVersion: EXPECTED_EMBEDDING.runtimeVersion,
    remoteHost: "https://example.test",
    remotePathTemplate: `{model}/resolve/${EXPECTED_EMBEDDING.revision}/`,
    files: ["config.json"],
  };
}

function vectorMessage(id: number): Record<string, unknown> {
  return { type: "vector", id, vector: axisVector(0), tokenCount: 4, durationMs: 3 };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function makeController(): ReturnType<typeof createRetrievalController> {
  return createRetrievalController(syntheticIndex());
}

interface Harness {
  engine: VoiceEngine;
  workers: FakeWorker[];
  playedPlans: AssistantClipSequence[];
}

/**
 * @param saveData the connection hint the engine's seam reports
 * @param withWorkerFactory wires the shipped default encoder (progress included) instead of
 *   an injected encoder handle, for the tests that read library progress
 */
function setup(saveData: boolean, withWorkerFactory = false): Harness {
  const workers: FakeWorker[] = [];
  const workerFactory = () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  };
  const playedPlans: AssistantClipSequence[] = [];
  const engine = new VoiceEngine({
    loadController: async () => makeController(),
    connection: () => ({ saveData }),
    audioPlayer: () => ({
      playReferences: async (sequence) => { playedPlans.push(sequence); },
      stop: () => undefined,
    }),
    ...(withWorkerFactory
      ? { workerFactory }
      : { encoder: createRetrievalEncoder({ workerFactory }) }),
  });

  return { engine, workers, playedPlans };
}

/** Loads the encoder through the engine and answers the load with the double's ready message. */
async function readyEncoder(harness: Harness): Promise<void> {
  const loading = harness.engine.ensureEncoder();
  await settle();

  assert.equal(harness.workers.length, 1, "the load creates exactly one worker");
  harness.workers[0].emit(readyMessage());
  await loading;
}

/** Waits until `count` embed requests reached the worker double, then returns them. */
async function waitForEmbeds(worker: FakeWorker, count: number): Promise<EncoderRequest[]> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const embeds = worker.sent.filter((message) => message.type === "embed");
    if (embeds.length >= count) return embeds;
    await settle();
  }

  throw new Error("no embed request reached the worker");
}

test("data saving schedules no model load before the chat is opened", async () => {
  const { engine, workers } = setup(true);

  // Bounded either way: before the fix the prefetch starts a load that never settles
  // without a ready message, so the assertion decides rather than a hang.
  await Promise.race([
    engine.prefetch(),
    new Promise((resolve) => setTimeout(resolve, 50)),
  ]);

  assert.equal(
    workers.length,
    0,
    "the background prefetch must not start a model load on a data-saving connection",
  );
  assert.equal(engine.capabilities?.saveData, true, "the connection seam reached the engine");
  assert.equal(engine.states.encoder, "idle", "no encoder state changed before the open");
});

test("the explicit open starts the encoder load with real library progress", async () => {
  const { engine, workers } = setup(true, true);

  const pending = engine.startOnDemand();
  await settle();

  assert.equal(workers.length, 1, "the open starts exactly one encoder worker");
  assert.equal(workers[0].sent.filter((message) => message.type === "load").length, 1);
  assert.equal(engine.states.encoder, "loading");

  // The library's own progress event, not a timer or an estimate.
  workers[0].emit({ type: "progress", file: "model_q8.onnx", loaded: 42, total: 100, percent: 42 });
  assert.equal(engine.progress.encoder, 0.42, "library progress reaches the model states");

  workers[0].emit(readyMessage());
  await pending;

  assert.equal(engine.states.encoder, "ready");
  assert.equal(engine.progress.encoder, 1);
});

test("other connections keep the background prefetch", async () => {
  const { engine, workers } = setup(false);

  const pending = engine.prefetch();
  await settle();

  assert.equal(workers.length, 1, "without data saving the prefetch starts the encoder");
  assert.equal(workers[0].sent.filter((message) => message.type === "load").length, 1);

  workers[0].emit(readyMessage());
  await pending;
});

test("the explicit open asks the browser to keep model storage", async () => {
  const workers: FakeWorker[] = [];
  const workerFactory = () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  };
  let persistCalls = 0;
  let grant: (granted: boolean) => void = () => undefined;
  const engine = new VoiceEngine({
    loadController: async () => makeController(),
    connection: () => ({ saveData: true }),
    workerFactory,
    storage: () => ({
      persist: () => {
        persistCalls += 1;
        return new Promise<boolean>((resolve) => {
          grant = resolve;
        });
      },
    }),
  });

  // No user gesture yet: the background prefetch must not ask for anything.
  await Promise.race([
    engine.prefetch(),
    new Promise((resolve) => setTimeout(resolve, 50)),
  ]);
  assert.equal(persistCalls, 0, "the background prefetch makes no eviction-permission request");

  const pending = engine.startOnDemand();
  await settle();

  assert.equal(persistCalls, 1, "the explicit open requests persistent storage once");
  assert.equal(engine.storagePersisted, null, "the grant has not landed yet");

  grant(true);
  await settle();
  assert.equal(
    engine.storagePersisted,
    true,
    "the grant result is recorded as technical metadata, not UI state",
  );

  workers[0].emit(readyMessage());
  await pending;
});

test("a closed panel shows no late answer and starts no playback", async () => {
  const harness = setup(true);
  await readyEncoder(harness);

  // The chat's respond path: a revision token the panel close bumps.
  let revision = 0;
  const isCurrent = () => revision === 0;
  const results: Answer[] = [];
  const emissions: string[] = [];

  const pending = harness.engine.ask(QUESTION, {
    isCurrent,
    onResult: (result) => results.push(result),
    onDelta: (text) => emissions.push(text),
  });

  const embeds = await waitForEmbeds(harness.workers[0], 1);
  const embed = embeds[0];
  assert.equal(embed.type, "embed");
  if (embed.type !== "embed") return;

  // What the panel close does: bump the turn token, interrupt the engine, stop playback.
  revision = 1;
  harness.engine.interrupt();
  harness.engine.stopAudio();

  // The deferred resolution lands after the close.
  harness.workers[0].emit(vectorMessage(embed.id));

  assert.equal(await pending, "");
  assert.equal(results.length, 0, "a closed panel surfaces no structured result");
  assert.deepEqual(emissions, [], "no late answer reaches the chat");
  assert.deepEqual(harness.playedPlans, [], "no stored plan starts after the close");
});

test("a controller load finishing after the close shows no late answer", async () => {
  const workers: FakeWorker[] = [];
  const workerFactory = () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  };
  // The index load is the deferred work: it resolves only after the panel was closed.
  let releaseController: () => void = () => undefined;
  let controllerLoads = 0;
  const playedPlans: AssistantClipSequence[] = [];
  const engine = new VoiceEngine({
    loadController: () => {
      controllerLoads += 1;
      return new Promise((resolve) => {
        releaseController = () => resolve(createRetrievalController(syntheticIndex()));
      });
    },
    connection: () => ({ saveData: true }),
    encoder: createRetrievalEncoder({ workerFactory }),
    audioPlayer: () => ({
      playReferences: async (sequence) => { playedPlans.push(sequence); },
      stop: () => undefined,
    }),
  });

  // The chat's respond path: a revision token the panel close bumps.
  let revision = 0;
  const isCurrent = () => revision === 0;
  const results: Answer[] = [];
  const emissions: string[] = [];

  const pending = engine.ask(QUESTION, {
    isCurrent,
    onResult: (result) => results.push(result),
    onDelta: (text) => emissions.push(text),
  });

  // What the panel close does while the index is still loading.
  revision = 1;
  engine.interrupt();
  engine.stopAudio();

  assert.equal(controllerLoads, 1, "the question started the deferred controller load");
  releaseController();

  assert.equal(await pending, "");
  assert.equal(results.length, 0, "a closed panel surfaces no structured result");
  assert.deepEqual(emissions, [], "no late answer reaches the chat");
  assert.deepEqual(playedPlans, [], "no stored plan starts after the close");
  assert.deepEqual(workers, [], "the closed turn starts no encoder request");
});

test("a reopen reuses the loaded model without another load", async () => {
  const harness = setup(true);
  await readyEncoder(harness);

  const first = harness.engine.ask(QUESTION);
  const firstEmbeds = await waitForEmbeds(harness.workers[0], 1);
  const firstEmbed = firstEmbeds[0];
  assert.equal(firstEmbed.type, "embed");
  if (firstEmbed.type !== "embed") return;
  harness.workers[0].emit(vectorMessage(firstEmbed.id));
  assert.notEqual(await first, "");

  // Close, then reopen through the same explicit-open entry point.
  harness.engine.interrupt();
  await harness.engine.startOnDemand();

  assert.equal(harness.workers.length, 1, "the reopen creates no second worker");
  assert.equal(
    harness.workers[0].sent.filter((message) => message.type === "load").length,
    1,
    "the cached model is not reloaded on reopen",
  );

  const second = harness.engine.ask(QUESTION);
  const secondEmbeds = await waitForEmbeds(harness.workers[0], 2);
  const secondEmbed = secondEmbeds[1];
  assert.equal(secondEmbed.type, "embed");
  if (secondEmbed.type !== "embed") return;
  harness.workers[0].emit(vectorMessage(secondEmbed.id));
  assert.notEqual(await second, "");
});

type MockElement = { type: unknown; props: Record<string, unknown> };
type SourceRefs = NonNullable<Extract<Answer, { kind: "answer" }>["sourceRefs"]>;
type VoiceChatMountOptions = {
  captureSttRegistration?: boolean;
  captureGreetingEffect?: boolean;
  traceCalls?: unknown[][];
  audioCacheState?: string;
};

function mockElements(tree: unknown): MockElement[] {
  const found: MockElement[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null || !("type" in value) || !("props" in value)) return;
    const element = value as MockElement;
    found.push(element);
    visit(element.props.children);
  };
  visit(tree);
  return found;
}

function mountVoiceChat(
  sourcePath: string,
  voiceEngine: Record<string, unknown>,
  onAnswer: (sourceRefs: SourceRefs) => void,
  options: VoiceChatMountOptions = {},
) {
  const stateSlots: { value: unknown; isMessageList: boolean }[] = [];
  const refSlots: { current: unknown }[] = [];
  let stateCursor = 0;
  let refCursor = 0;
  let effectCursor = 0;
  let sttRegistrationEffect: (() => unknown) | null = null;
  let greetingEffect: (() => unknown) | null = null;
  let messageSlot = -1;
  const Fragment = Symbol("Fragment");
  const react = {
    Fragment,
    useCallback: <T>(callback: T): T => callback,
    useEffect: (effect: unknown): void => {
      const index = effectCursor++;
      // Capture only the first (STT-handler registration) effect when explicitly requested.
      // Other effects remain inert; this helper does not simulate the component lifecycle.
      if (options.captureGreetingEffect && index === 3) greetingEffect = effect as () => unknown;
      if (options.captureSttRegistration && index === 0) {
        sttRegistrationEffect = effect as () => unknown;
      }
    },
    useMemo: <T>(factory: () => T): T => factory(),
    useRef: (initial: unknown) => {
      const index = refCursor++;
      refSlots[index] ??= { current: initial };
      return refSlots[index];
    },
    useState: (initial: unknown): [unknown, (next: unknown) => void] => {
      const index = stateCursor++;
      stateSlots[index] ??= { value: initial, isMessageList: Array.isArray(initial) };
      if (stateSlots[index].isMessageList) messageSlot = index;
      const slot = stateSlots[index];
      return [slot.value, (next) => {
        slot.value = typeof next === "function"
          ? (next as (current: unknown) => unknown)(slot.value)
          : next;
      }];
    },
  };
  const createElement = (type: unknown, props: Record<string, unknown>, _key?: unknown) => ({ type, props });
  const styles = new Proxy({} as Record<string, string>, {
    get: (_target, key) => typeof key === "string" ? key : "",
  });
  voiceEngine.offerStarters ??= async () => [];
  voiceEngine.dismissStarters ??= () => undefined;
  const modules: Record<string, unknown> = {
    react,
    "react/jsx-runtime": { Fragment, jsx: createElement, jsxs: createElement },
    "./cv-context": { GREETING, INTRO },
    "./engine": {
      PROGRESS_WEIGHTS: { stt: 0.2, encoder: 0.8 },
      trace: (...args: unknown[]) => options.traceCalls?.push(args),
      voiceEngine,
    },
    "./transcript": { mergeTranscript: (left: string, right: string) => [left, right].filter(Boolean).join(" ") },
    "../offline/audio-cache": {
      describeAudioCacheProgress: () => "Audio cache status with observed counts",
      INITIAL_AUDIO_CACHE_PROGRESS: { state: options.audioCacheState ?? "idle", verifiedClips: 0, totalClips: 122, canRetry: false },
      requestAudioCacheWarm: () => Promise.resolve(),
      subscribeAudioCacheProgress: () => () => undefined,
    },
    "./turn": { createTurnFlow },
    "./VoiceChat.module.css": { default: styles },
  };
  const compiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: false,
    },
  });
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(compiled.outputText, {
    exports: module.exports,
    module,
    require: (specifier: string) => {
      if (!Object.hasOwn(modules, specifier)) throw new Error(`Unexpected component import: ${specifier}`);
      return modules[specifier];
    },
  }, { filename: sourcePath });
  const Component = module.exports.VoiceChat as (props: { onAnswer: (sourceRefs: SourceRefs) => void }) => unknown;
  const render = () => {
    stateCursor = 0;
    refCursor = 0;
    effectCursor = 0;
    return Component({ onAnswer });
  };
  const messages = (): Message[] => {
    assert.notEqual(messageSlot, -1, "the component allocated its message list state");
    return stateSlots[messageSlot].value as Message[];
  };
  const runSttRegistrationEffect = (): void => {
    assert.ok(sttRegistrationEffect, "the targeted STT-handler effect was captured");
    sttRegistrationEffect();
  };
  const voiceDraftState = () => ({
    finalized: refSlots[6]?.current,
    interim: refSlots[7]?.current,
    activeUserMessage: refSlots[8]?.current,
  });
  const runGreetingEffect = (): void => {
    assert.ok(greetingEffect, "the targeted greeting effect was captured");
    greetingEffect();
  };
  return { render, messages, runSttRegistrationEffect, runGreetingEffect, voiceDraftState };
}

function componentSourceForTest(): string {
  return process.env.VOICECHAT_COMPONENT_SOURCE_OVERRIDE
    ?? fileURLToPath(new URL("../src/chat/VoiceChat.tsx", import.meta.url));
}

test("muting live voice settles the pending voice draft without clearing typed input", async () => {
  const transcriptSentinel = "voice-draft-sentinel";
  const typedDraft = "independent typed draft";
  const handlers: {
    current: {
      onText?: (text: string) => void;
      onLine?: (line: { text: string }) => void;
    } | null;
  } = { current: null };
  const voiceEngine = {
    startOnDemand: async () => undefined,
    resumeAudio: async () => undefined,
    startListening: async () => undefined,
    stopListening: async () => undefined,
    setSttHandlers: (next: typeof handlers.current) => { handlers.current = next; },
    ask: async () => "",
    chooseClarification: () => null,
    interrupt: () => undefined,
    pendingChoices: () => null,
    speakSequence: async () => undefined,
    stopAudio: () => undefined,
  };
  const chat = mountVoiceChat(componentSourceForTest(), voiceEngine, () => undefined, {
    captureSttRegistration: true,
  });
  const findElement = (tree: unknown, testId: string): MockElement | undefined =>
    mockElements(tree).find((element) => element.props["data-testid"] === testId);

  let tree = chat.render();
  let button = findElement(tree, "voice-fab");
  assert.ok(button);
  (button.props.onClick as () => void)();
  await settle();
  chat.runSttRegistrationEffect();
  handlers.current?.onText?.(transcriptSentinel);
  handlers.current?.onLine?.({ text: transcriptSentinel });

  const input = findElement(chat.render(), "voice-input");
  assert.ok(input, "the independent typed composer remains available in live mode");
  (input.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: typedDraft },
  });
  const switchButton = findElement(chat.render(), "voice-toggle");
  assert.ok(switchButton, "live mode offers master mute");
  (switchButton.props.onClick as () => void)();

  const voiceBubble = chat.messages().find((message) => message.role === "user");
  const voiceBubbleSettled = voiceBubble !== undefined
    && voiceBubble.text === transcriptSentinel
    && voiceBubble.pending === false;
  assert.equal(voiceBubbleSettled, true, "the pending voice bubble is finalized on switch");
  const composerAfterSwitch = findElement(chat.render(), "voice-input");
  const typedDraftPreserved = composerAfterSwitch?.props.value === typedDraft;
  assert.equal(typedDraftPreserved, true, "muting preserves the independent typed draft");
  const draftState = chat.voiceDraftState();
  const voiceOwnershipCleared = draftState.finalized === ""
    && draftState.interim === ""
    && draftState.activeUserMessage === null;
  assert.equal(voiceOwnershipCleared, true, "transcript buffers and voice-bubble ownership are cleared");
});

test("early acoustic onset supersedes output without stopping live capture or greeting late", async () => {
  let handlers: { current: { onUtteranceStart?: () => void } | null } = { current: null };
  let releaseStart!: () => void;
  let signalStart!: () => void;
  const startRequested = new Promise<void>((resolve) => { signalStart = resolve; });
  const pendingStart = new Promise<void>((resolve) => { releaseStart = resolve; });
  let startGuard: (() => boolean) | undefined;
  let audioStops = 0;
  let captureStops = 0;
  let greetingStarts = 0;
  const voiceEngine = {
    startOnDemand: async () => undefined,
    resumeAudio: async () => undefined,
    startListening: (options: { isCurrent?: () => boolean }) => {
      startGuard = options.isCurrent;
      signalStart();
      return pendingStart;
    },
    stopListening: async () => { captureStops += 1; },
    setSttHandlers: (next: typeof handlers.current) => { handlers.current = next; },
    ask: async () => "",
    chooseClarification: () => null,
    interrupt: () => { audioStops += 1; },
    pendingChoices: () => null,
    speakSequence: async () => { greetingStarts += 1; },
    stopAudio: () => { audioStops += 1; },
  };
  const chat = mountVoiceChat(componentSourceForTest(), voiceEngine, () => undefined, {
    captureSttRegistration: true,
  });
  const findElement = (tree: unknown, testId: string): MockElement | undefined =>
    mockElements(tree).find((element) => element.props["data-testid"] === testId);

  let button = findElement(chat.render(), "voice-fab");
  assert.ok(button);
  (button.props.onClick as () => void)();
  await startRequested;
  chat.runSttRegistrationEffect();
  const stopsBeforeOnset = audioStops;
  handlers.current?.onUtteranceStart?.();

  assert.ok(audioStops > stopsBeforeOnset, "the live onset synchronously supersedes pending output");
  assert.equal(captureStops, 0, "onset never stops or restarts the open microphone");
  assert.equal(startGuard?.(), true, "the live capture generation remains current");
  const status = mockElements(chat.render()).find((element) => element.props["data-testid"] === "voice-status");
  const statusChildren = status?.props.children;
  const statusText = Array.isArray(statusChildren)
    ? statusChildren.filter((child): child is string => typeof child === "string").join("")
    : statusChildren;
  assert.equal(statusText, "Listening — speak or type.");

  releaseStart();
  await settle();
  assert.equal(greetingStarts, 0, "a delayed greeting cannot start after acoustic onset");
  assert.equal(captureStops, 0, "the started capture remains active after output cancellation");

  button = findElement(chat.render(), "voice-fab");
  assert.ok(button);
  (button.props.onClick as () => void)();
  await settle();
  const stopsAfterClose = audioStops;
  handlers.current?.onUtteranceStart?.();
  assert.equal(audioStops, stopsAfterClose, "a stale onset after close is ignored");
  assert.equal(captureStops, 1, "only the explicit close stops the microphone");
});

test("early onset stops an active prepared answer while keeping capture live", async () => {
  const handlers: { current: { onUtteranceStart?: () => void } | null } = { current: null };
  const answer: Extract<Answer, { kind: "answer" }> = {
    kind: "answer",
    cardId: "synthetic-onset-answer",
    topic: "Synthetic topic",
    answer: "Synthetic prepared answer.",
    matching: "semantic",
    weak: false,
  };
  const releases: (() => void)[] = [];
  const spokenPlans: AssistantClipSequence[] = [];
  const events: string[] = [];
  const voiceEngine = {
    startOnDemand: async () => undefined,
    resumeAudio: async () => undefined,
    startListening: async () => { events.push("capture-start"); },
    stopListening: async () => { events.push("capture-stop"); },
    setSttHandlers: (next: typeof handlers.current) => { handlers.current = next; },
    ask: (_question: string, options: AskOptions = {}) => {
      events.push("ask");
      options.onResult?.(answer);
      options.onDelta?.(answer.answer);
      return Promise.resolve(answer.answer);
    },
    chooseClarification: () => null,
    interrupt: () => { events.push("interrupt"); },
    pendingChoices: () => null,
    speakSequence: (sequence: AssistantClipSequence) => {
      spokenPlans.push(sequence);
      return new Promise<void>((resolve) => { releases.push(resolve); });
    },
    stopAudio: () => {
      events.push("stop-audio");
      releases.at(-1)?.();
    },
  };
  const chat = mountVoiceChat(componentSourceForTest(), voiceEngine, () => undefined, {
    captureSttRegistration: true,
  });
  const findElement = (tree: unknown, predicate: (element: MockElement) => boolean): MockElement | undefined =>
    mockElements(tree).find(predicate);

  let tree = chat.render();
  let button = findElement(tree, (element) => element.props["data-testid"] === "voice-fab");
  assert.ok(button);
  (button.props.onClick as () => void)();
  await settle();
  chat.runSttRegistrationEffect();
  assert.equal(spokenPlans.length, 1, "consented live mode starts the greeting plan");
  releases[0]?.();
  await settle();

  const input = findElement(chat.render(), (element) => element.props["data-testid"] === "voice-input");
  assert.ok(input);
  (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "synthetic question" } });
  const form = findElement(chat.render(), (element) => element.type === "form");
  assert.ok(form);
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
  await settle();
  assert.equal(spokenPlans.length, 2, "the selected prepared answer is playing");
  const stopCount = events.filter((event) => event === "stop-audio").length;

  handlers.current?.onUtteranceStart?.();
  await settle();
  assert.ok(events.filter((event) => event === "stop-audio").length > stopCount, "acoustic onset stops active prepared playback");
  assert.equal(events.filter((event) => event === "capture-stop").length, 0, "capture remains live throughout interruption");
  assert.equal(spokenPlans.length, 2, "no delayed answer plan restarts after onset");
  assert.equal(chat.messages().some((message) => message.text === answer.answer), true, "already-visible prepared text remains intact");

  button = findElement(chat.render(), (element) => element.props["data-testid"] === "voice-fab");
  assert.ok(button);
  (button.props.onClick as () => void)();
  await settle();
  assert.equal(events.filter((event) => event === "capture-stop").length, 1, "explicit close eventually stops capture");
});

test("speech diagnostics omit transcript and raw exception payloads", async () => {
  const transcriptSentinel = "private-transcript-sentinel";
  const exceptionSentinel = "private-vendor-exception-sentinel";
  const traceCalls: unknown[][] = [];
  const handlers: {
    current: {
      onLine?: (line: { text: string }) => void;
      onError?: (error: Error) => void;
    } | null;
  } = { current: null };
  const voiceEngine = {
    startOnDemand: async () => undefined,
    resumeAudio: async () => undefined,
    startListening: async () => { throw new Error(exceptionSentinel); },
    stopListening: async () => undefined,
    setSttHandlers: (next: typeof handlers.current) => { handlers.current = next; },
    ask: async () => "",
    chooseClarification: () => null,
    interrupt: () => undefined,
    pendingChoices: () => null,
    speakSequence: async () => undefined,
    stopAudio: () => undefined,
  };
  const chat = mountVoiceChat(componentSourceForTest(), voiceEngine, () => undefined, {
    captureSttRegistration: true,
    traceCalls,
  });
  const findElement = (tree: unknown, testId: string): MockElement | undefined =>
    mockElements(tree).find((element) => element.props["data-testid"] === testId);
  let button = findElement(chat.render(), "voice-fab");
  assert.ok(button);
  (button.props.onClick as () => void)();
  await settle();
  chat.runSttRegistrationEffect();
  handlers.current?.onLine?.({ text: transcriptSentinel });
  handlers.current?.onError?.(new Error(exceptionSentinel));

  const payloadLeaked = traceCalls.some((args) => args.some((value) =>
    typeof value === "string"
      && (value.includes(transcriptSentinel) || value.includes(exceptionSentinel))));
  assert.equal(payloadLeaked, false, "speech trace arguments contain no transcript or raw exception text");
  const notice = mockElements(chat.render()).find((element) => element.props.role === "status");
  const rawErrorVisible = typeof notice?.props.children === "string"
    && notice.props.children.includes(exceptionSentinel);
  assert.equal(rawErrorVisible, false, "raw STT exception text is not shown as a notice");
});

test("the component clarification choice binds the actual selected result to its message", async () => {
  const offerChoices: ClarificationChoice[] = [
    { cardId: "offered-card-a", topic: "Offered topic A", score: 0.51 },
    { cardId: "offered-card-b", topic: "Offered topic B", score: 0.5 },
  ];
  const selected: Extract<Answer, { kind: "answer" }> = {
    kind: "answer",
    cardId: "selected-card-b",
    topic: "Selected topic B",
    answer: "Prepared answer from selected card B.",
    matching: "semantic",
    weak: false,
    sourceRefs: [{ startLine: 41, endLine: 44 }],
  };
  const askCalls: { question: string; options: AskOptions }[] = [];
  const chosenIds: string[] = [];
  const spokenPlans: AssistantClipSequence[] = [];
  const navigation: SourceRefs[] = [];
  const voiceEngine = {
    ask: (question: string, options: AskOptions = {}) => {
      askCalls.push({ question, options });
      options.onResult?.({ kind: "clarify", choices: offerChoices });
      return Promise.resolve(AUDIO_CATALOG_TEXT.clarifyPrompt);
    },
    chooseClarification: (cardId: string): Answer | null => {
      chosenIds.push(cardId);
      return cardId === "offered-card-b" ? selected : null;
    },
    interrupt: () => undefined,
    pendingChoices: () => offerChoices,
    speakSequence: async (sequence: AssistantClipSequence) => { spokenPlans.push(sequence); },
    stopAudio: () => undefined,
  };
  const sourceOverride = process.env.CLARIFICATION_BINDING_COMPONENT_SOURCE;
  const componentPath = sourceOverride ?? fileURLToPath(new URL("../src/chat/VoiceChat.tsx", import.meta.url));
  const chat = mountVoiceChat(componentPath, voiceEngine, (sourceRefs) => navigation.push(sourceRefs));
  const findElement = (tree: unknown, predicate: (element: MockElement) => boolean): MockElement | undefined =>
    mockElements(tree).find(predicate);
  const firstTree = chat.render();
  const input = findElement(firstTree, (element) => element.props["data-testid"] === "voice-input");
  assert.ok(input, "the component renders its typed input");
  (input.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: "synthetic clarification question" },
  });

  const form = findElement(chat.render(), (element) => element.type === "form");
  assert.ok(form, "the component renders its question form");
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => undefined });
  await settle();

  const choiceTree = chat.render();
  const choice = findElement(choiceTree, (element) =>
    element.props["data-testid"] === "voice-choice" && element.props.children === "Offered topic B",
  );
  assert.ok(choice, "the clarification offer renders the selected topic button");
  (choice.props.onClick as () => void)();

  const message = chat.messages().find((item) => item.role === "assistant" && item.text === selected.answer);
  assert.ok(message, "the actual choice handler appends the visible selected answer");
  assert.deepEqual({
    text: message.text,
    selectedCardId: message.selectedCardId,
    audioSequence: message.audioSequence,
  }, {
    text: "Prepared answer from selected card B.",
    selectedCardId: "selected-card-b",
    audioSequence: [
      { kind: "fact", cardId: "selected-card-b", text: "Prepared answer from selected card B." },
    ],
  }, "the assistant message binds text, identity and audio from the chosen result");
  assert.deepEqual(askCalls.map(({ question }) => question), ["synthetic clarification question"]);
  assert.deepEqual(chosenIds, ["offered-card-b"], "the route resolves the offered id once");
  assert.deepEqual(navigation, [[{ startLine: 41, endLine: 44 }]], "the actual valid route navigates once");
  assert.deepEqual(spokenPlans, [], "silent typed selection stores a plan without autoplay");
  assert.equal(Object.hasOwn(askCalls[0].options, "speak"), false);
  const visibleAnswer = findElement(chat.render(), (element) => element.type === "p" && element.props.children === selected.answer);
  assert.ok(visibleAnswer, "the same prepared answer remains visible in the component output");
});

test("opening immediately allows typing during live setup; icon controls and exact replay retain consent guards", async () => {
  const calls: string[] = [];
  let releaseAudio!: () => void;
  const pendingAudio = new Promise<void>((resolve) => { releaseAudio = resolve; });
  const spokenPlans: AssistantClipSequence[] = [];
  const askCalls: { question: string; options: AskOptions }[] = [];
  const selected: Extract<Answer, { kind: "answer" }> = {
    kind: "answer",
    cardId: "consent-card",
    topic: "Synthetic topic",
    answer: "Prepared synthetic answer.",
    matching: "semantic",
    weak: false,
  };
  const voiceEngine = {
    startOnDemand: async () => { calls.push("encoder-open"); },
    resumeAudio: () => { calls.push("resume-audio"); return pendingAudio; },
    startListening: async (options: { isCurrent?: () => boolean }) => {
      calls.push("start-listening");
      assert.equal(options.isCurrent?.(), true);
    },
    stopListening: async () => { calls.push("stop-listening"); },
    ask: (question: string, options: AskOptions = {}) => {
      askCalls.push({ question, options });
      options.onResult?.(selected);
      options.onDelta?.(selected.answer);
      return Promise.resolve(selected.answer);
    },
    chooseClarification: () => null,
    interrupt: () => { calls.push("interrupt"); },
    pendingChoices: () => null,
    speakSequence: async (sequence: AssistantClipSequence) => { spokenPlans.push(sequence); },
    stopAudio: () => { calls.push("stop-audio"); },
  };
  const componentPath = componentSourceForTest();
  const chat = mountVoiceChat(componentPath, voiceEngine, () => undefined);
  const findElement = (tree: unknown, predicate: (element: MockElement) => boolean): MockElement | undefined =>
    mockElements(tree).find(predicate);

  const fab = findElement(chat.render(), (element) => element.props["data-testid"] === "voice-fab");
  assert.ok(fab);
  assert.equal(calls.length, 0, "closed page does not resume audio or start capture");
  assert.match(String(fab.props["aria-label"]), /microphone and audio/);
  assert.match(String(fab.props.title), /microphone and audio/);
  (fab.props.onClick as () => void)();
  let tree = chat.render();
  const live = findElement(tree, (element) => element.props["data-testid"] === "voice-toggle");
  assert.ok(live, "opening presents cancellable live startup");
  assert.equal(live.props["aria-label"], "Mute voice");
  assert.equal(live.props["aria-pressed"], true);
  assert.equal(mockElements(tree).some((e) => e.props["data-testid"] === "voice-choose-typed"), false);
  const newChat = findElement(tree, (element) => element.props["data-testid"] === "voice-new-chat");
  assert.ok(newChat);
  assert.equal(mockElements(newChat.props.children).filter((e) => e.type === "svg").length, 1);
  assert.equal(mockElements(newChat).some((e) => e.type === "span"), false);
  const send = findElement(tree, (element) => element.type === "button" && element.props["aria-label"] === "Send");
  assert.ok(send);
  assert.equal(mockElements(send.props.children).filter((e) => e.type === "svg").length, 1);
  assert.equal(calls.includes("resume-audio"), true, "explicit open resumes audio in the gesture");
  assert.equal(calls.includes("start-listening"), false, "capture waits for audio setup");
  assert.deepEqual(spokenPlans, [], "the greeting waits for guarded startup");

  tree = chat.render();
  const input = findElement(tree, (element) => element.props["data-testid"] === "voice-input");
  assert.ok(input);
  (input.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: "synthetic typed question" },
  });
  assert.equal(findElement(chat.render(), (element) => element.props["data-testid"] === "voice-input")?.props.value, "synthetic typed question", "typing is usable before setup completes");
  releaseAudio();
  await settle();
  assert.equal(spokenPlans.length, 1, "the consented greeting plays once");
  const form = findElement(chat.render(), (element) => element.type === "form");
  assert.ok(form);
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => undefined });
  await settle();

  const answerMessage = chat.messages().find((message) => message.role === "assistant" && message.text === selected.answer);
  assert.ok(answerMessage?.audioSequence, "typed answers retain their immutable replay plan");
  assert.equal(spokenPlans.length, 2, "typed answers follow the consented live speech policy");
  assert.strictEqual(spokenPlans[1], answerMessage.audioSequence);
  assert.equal(calls.includes("start-listening"), true);
  assert.equal(Object.hasOwn(askCalls[0].options, "speak"), false);

  const replay = mockElements(chat.render()).filter((element) => element.props["data-testid"] === "voice-replay").at(-1);
  assert.ok(replay, "the assistant message exposes a replay control");
  assert.equal(mockElements(replay.props.children).filter((e) => e.type === "svg").length, 1);
  assert.equal(mockElements(replay).some((e) => e.type === "path" && e.props.d === "m8 5 11 7-11 7z"), true, "replay shows a play triangle");
  (replay.props.onClick as () => void)();
  await settle();
  assert.equal(spokenPlans.length, 3);
  assert.strictEqual(spokenPlans[2], answerMessage.audioSequence, "replay passes the exact stored plan");
  assert.equal(askCalls.length, 1, "replay does not retrieve or select again");
});

for (const startup of ["opening", "New chat"] as const) {
  for (const newerOwner of ["Send answer", "Send thinking", "Replay"] as const) {
    test(`pending ${startup} startup preserves newer ${newerOwner} output and consented capture`, async () => {
      const selected: Extract<Answer, { kind: "answer" }> = {
        kind: "answer",
        cardId: "pending-start-card",
        topic: "Synthetic topic",
        answer: "Synthetic selected answer.",
        matching: "semantic",
        weak: false,
      };
      const captureGuards: (() => boolean)[] = [];
      const finishCapture: (() => void)[] = [];
      const playedPlans: AssistantClipSequence[] = [];
      let captureStops = 0;
      let asks = 0;
      let finishAnswer!: () => void;
      let finishPlayback: (() => void) | undefined;
      const engine = {
        startOnDemand: async () => undefined,
        resumeAudio: async () => undefined,
        startListening: (options: { isCurrent: () => boolean }) => {
          captureGuards.push(options.isCurrent);
          return new Promise<void>((resolve) => { finishCapture.push(resolve); });
        },
        stopListening: async () => { captureStops++; },
        resetConversation: () => undefined,
        interrupt: () => undefined,
        stopAudio: () => { finishPlayback?.(); },
        pendingChoices: () => null,
        ask: (_question: string, options: AskOptions = {}) => {
          asks++;
          const answer = () => {
            options.onResult?.(selected);
            options.onDelta?.(selected.answer);
            return selected.answer;
          };
          return newerOwner === "Send thinking"
            ? new Promise<string>((resolve) => { finishAnswer = () => resolve(answer()); })
            : Promise.resolve(answer());
        },
        speakSequence: (sequence: AssistantClipSequence, options: { onSpeakingChange: (speaking: boolean) => void }) => {
          playedPlans.push(sequence);
          options.onSpeakingChange(true);
          return new Promise<void>((resolve) => { finishPlayback = resolve; });
        },
      };
      const chat = mountVoiceChat(componentSourceForTest(), engine, () => undefined);
      const find = (id: string) => mockElements(chat.render()).find((element) => element.props["data-testid"] === id);
      const click = (id: string) => {
        const element = find(id);
        assert.ok(element, id);
        (element.props.onClick as () => void)();
      };
      click("voice-fab");
      await settle();
      assert.equal(captureGuards.length, 1, "opening capture is pending before any Send");
      if (startup === "New chat") {
        click("voice-new-chat");
        await settle();
        assert.equal(captureGuards.length, 2, "retained live reset has its own awaited startup");
        assert.equal(captureGuards[0](), false, "reset invalidates the prior capture request");
        finishCapture[0]();
        await settle();
      }
      const stopsBeforeSend = captureStops;
      const input = find("voice-input");
      assert.ok(input);
      (input.props.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "independent pending-start question" },
      });
      const form = mockElements(chat.render()).find((element) => element.type === "form");
      assert.ok(form);
      (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
      await settle();
      const answerMessage = chat.messages().find((message) => message.selectedCardId === selected.cardId);
      if (newerOwner !== "Send thinking") {
        assert.ok(answerMessage?.audioSequence);
        assert.deepEqual(answerMessage.audioSequence, [
          { kind: "fact", cardId: "pending-start-card", text: "Synthetic selected answer." },
        ], "the visible selected answer owns its exact stored plan");
        assert.strictEqual(playedPlans[0], answerMessage.audioSequence);
      }
      if (newerOwner === "Replay") {
        const replay = mockElements(chat.render()).filter((element) => element.props["data-testid"] === "voice-replay").at(-1);
        assert.ok(replay);
        (replay.props.onClick as () => void)();
        await settle();
        assert.strictEqual(playedPlans[1], answerMessage?.audioSequence, "explicit Replay retains the visible message plan");
      }
      const expectedPlays = newerOwner === "Send thinking" ? 0 : newerOwner === "Replay" ? 2 : 1;
      const expectedState = newerOwner === "Send thinking" ? "thinking" : "speaking";
      assert.equal(find("voice-status")?.props["data-state"], expectedState, "newer output owns presentation before capture completes");
      finishCapture.at(-1)?.();
      await settle();
      assert.deepEqual({
        playbackStarts: playedPlans.length,
        presentation: find("voice-status")?.props["data-state"],
      }, {
        playbackStarts: expectedPlays,
        presentation: expectedState,
      }, "delayed startup neither greets over the newer output nor overwrites its state");
      assert.equal(captureGuards.at(-1)?.(), true, "Send/Replay do not revoke consented capture");
      assert.equal(captureStops, stopsBeforeSend, "output supersession never stops the microphone");
      assert.equal(asks, 1, "Replay/startup do not retrieve again");
      if (newerOwner === "Send thinking") {
        finishAnswer();
        await settle();
        assert.equal(playedPlans.length, 1, "the selected answer, not startup, eventually speaks");
      } else {
        assert.strictEqual(playedPlans.at(-1), answerMessage?.audioSequence);
      }
      finishPlayback?.();
      await settle();
      click("voice-fab");
    });
  }
}

test("closed page stays silent; explicit open and reopen start unmuted live voice with fresh consent", async () => {
  const events: string[] = [];
  const spokenPlans: AssistantClipSequence[] = [];
  const voiceEngine = {
    startOnDemand: async () => { events.push("encoder-open"); },
    resumeAudio: async () => { events.push("resume-audio"); },
    startListening: async (options: { isCurrent?: () => boolean }) => {
      events.push("start-listening");
      assert.equal(options.isCurrent?.(), true);
    },
    stopListening: async () => { events.push("stop-listening"); },
    ask: async () => "",
    chooseClarification: () => null,
    interrupt: () => { events.push("interrupt"); },
    pendingChoices: () => null,
    speakSequence: async (sequence: AssistantClipSequence) => {
      events.push("speak-sequence");
      spokenPlans.push(sequence);
    },
    stopAudio: () => { events.push("stop-audio"); },
  };
  const componentPath = componentSourceForTest();
  const chat = mountVoiceChat(componentPath, voiceEngine, () => undefined);
  const findElement = (tree: unknown, predicate: (element: MockElement) => boolean): MockElement | undefined =>
    mockElements(tree).find(predicate);

  let tree = chat.render();
  let fab = findElement(tree, (element) => element.props["data-testid"] === "voice-fab");
  assert.ok(fab);
  assert.deepEqual(events, [], "closed-page render starts no audio, capture or greeting");
  (fab.props.onClick as () => void)();
  tree = chat.render();
  await settle();

  assert.deepEqual(events.slice(0, 4), ["encoder-open", "resume-audio", "start-listening", "speak-sequence"]);
  const greeting = chat.messages().find((message) => message.role === "assistant");
  assert.ok(greeting?.audioSequence);
  assert.strictEqual(spokenPlans[0], greeting.audioSequence, "live greeting uses its message plan");

  const mute = findElement(chat.render(), (element) => element.props["data-testid"] === "voice-toggle");
  assert.ok(mute);
  (mute.props.onClick as () => void)();
  assert.equal(findElement(chat.render(), (element) => element.props["data-testid"] === "voice-toggle")?.props["aria-pressed"], false);

  tree = chat.render();
  fab = findElement(tree, (element) => element.props["data-testid"] === "voice-fab");
  assert.ok(fab);
  (fab.props.onClick as () => void)();
  assert.equal(events.filter((event) => event === "stop-listening").length, 2, "mute and close each stop capture");

  tree = chat.render();
  fab = findElement(tree, (element) => element.props["data-testid"] === "voice-fab");
  assert.ok(fab);
  (fab.props.onClick as () => void)();
  await settle();
  assert.equal(events.filter((event) => event === "resume-audio").length, 2, "reopen is a fresh consent action");
  assert.equal(events.filter((event) => event === "start-listening").length, 2, "explicit reopen starts capture again");
  assert.equal(findElement(chat.render(), (element) => element.props["data-testid"] === "voice-toggle")?.props["aria-label"], "Mute voice");
  assert.equal(spokenPlans.length, 1, "reopen does not duplicate the already-played greeting");
  assert.equal(chat.messages().filter((message) => message.text === GREETING).length, 1);
});

test("audio setup failure leaves typed input and an explicit retry voice icon", async () => {
  let startCalls = 0;
  const voiceEngine = {
    startOnDemand: async () => undefined,
    resumeAudio: async () => { throw new Error("synthetic audio failure"); },
    startListening: async () => { startCalls += 1; },
    stopListening: async () => undefined,
    ask: async () => "",
    chooseClarification: () => null,
    interrupt: () => undefined,
    pendingChoices: () => null,
    speakSequence: async () => undefined,
    stopAudio: () => undefined,
  };
  const componentPath = componentSourceForTest();
  const chat = mountVoiceChat(componentPath, voiceEngine, () => undefined);
  const findElement = (tree: unknown, predicate: (element: MockElement) => boolean): MockElement | undefined =>
    mockElements(tree).find(predicate);
  let tree = chat.render();
  let fab = findElement(tree, (element) => element.props["data-testid"] === "voice-fab");
  assert.ok(fab);
  (fab.props.onClick as () => void)();
  await settle();

  tree = chat.render();
  const retryVoice = findElement(tree, (element) => element.props["data-testid"] === "voice-toggle");
  const input = findElement(tree, (element) => element.props["data-testid"] === "voice-input");
  assert.equal(retryVoice?.props["aria-label"], "Enable live voice", "a failed audio start leaves explicit retry available");
  assert.ok(input, "the composer stays present after voice setup fails");
  assert.equal(startCalls, 0, "STT was not started after audio setup failed");
  assert.ok(findElement(chat.render(), (element) => element.props["data-testid"] === "voice-input"));
});

test("closing while live setup is pending invalidates its start and greeting", async () => {
  let finishStart: () => void = () => undefined;
  let signalStart: () => void = () => undefined;
  const startRequested = new Promise<void>((resolve) => { signalStart = resolve; });
  const pendingStart = new Promise<void>((resolve) => { finishStart = resolve; });
  let liveGuard: (() => boolean) | undefined;
  let greetings = 0;
  const voiceEngine = {
    startOnDemand: async () => undefined,
    resumeAudio: async () => undefined,
    startListening: (options: { isCurrent?: () => boolean }) => {
      liveGuard = options.isCurrent;
      signalStart();
      return pendingStart;
    },
    stopListening: async () => undefined,
    ask: async () => "",
    chooseClarification: () => null,
    interrupt: () => undefined,
    pendingChoices: () => null,
    speakSequence: async () => { greetings += 1; },
    stopAudio: () => undefined,
  };
  const componentPath = componentSourceForTest();
  const chat = mountVoiceChat(componentPath, voiceEngine, () => undefined);
  const findElement = (tree: unknown, predicate: (element: MockElement) => boolean): MockElement | undefined =>
    mockElements(tree).find(predicate);
  let tree = chat.render();
  let fab = findElement(tree, (element) => element.props["data-testid"] === "voice-fab");
  assert.ok(fab);
  (fab.props.onClick as () => void)();
  await startRequested;

  tree = chat.render();
  fab = findElement(tree, (element) => element.props["data-testid"] === "voice-fab");
  assert.ok(fab);
  (fab.props.onClick as () => void)();
  assert.equal(liveGuard?.(), false, "close invalidates the pending capture request");
  finishStart();
  await settle();
  assert.equal(greetings, 0, "a closed live setup cannot autoplay the greeting");
  finishStart();
});

test("New chat clears UI and late inference; master mute blocks replay but keeps typing", async () => {
  let resolveAnswer!: () => void;
  let resets = 0;
  let stops = 0;
  let playback = 0;
  let asks = 0;
  let finishReplay: (() => void) | undefined;
  const engine = {
    startOnDemand: async () => undefined,
    resumeAudio: async (): Promise<void> => { throw new Error("synthetic audio failure"); },
    startListening: async () => undefined,
    stopListening: async () => { stops++; },
    resetConversation: () => { resets++; },
    ask: (_question: string, options: AskOptions) => {
      asks++;
      return new Promise<string>((resolve) => { resolveAnswer = () => {
        options.onDelta?.("obsolete answer");
        resolve("obsolete answer");
      }; });
    },
    interrupt: () => undefined,
    pendingChoices: () => null,
    speakSequence: (_sequence: AssistantClipSequence, options: { onSpeakingChange: (speaking: boolean) => void }) => {
      playback++;
      options.onSpeakingChange(true);
      return playback === 1 ? new Promise<void>((resolve) => { finishReplay = resolve; }) : Promise.resolve();
    },
    stopAudio: () => { finishReplay?.(); },
  };
  const chat = mountVoiceChat(componentSourceForTest(), engine, () => undefined);
  const find = (id: string) => mockElements(chat.render()).find((e) => e.props["data-testid"] === id);
  const click = (id: string) => { const e = find(id); assert.ok(e, id); (e.props.onClick as () => void)(); };
  const send = () => {
    const input = find("voice-input")!;
    (input.props.onChange as (e: unknown) => void)({ target: { value: "synthetic question" } });
    const form = mockElements(chat.render()).find((e) => e.type === "form")!;
    (form.props.onSubmit as (e: unknown) => void)({ preventDefault() {} });
  };
  click("voice-fab");
  await settle();
  send();
  click("voice-new-chat");
  resolveAnswer();
  await settle();
  assert.equal(resets, 1);
  assert.equal(chat.messages().some((m) => m.text === "obsolete answer"), false);
  assert.equal(find("voice-input")?.props.value, "");
  assert.equal(chat.messages().filter((m) => m.text === GREETING).length, 1);
  assert.equal(playback, 0, "typed reset stays silent");
  click("voice-replay");
  await settle();
  assert.equal(find("voice-toggle")?.props["aria-label"], "Mute voice", "active typed replay exposes master mute");
  assert.equal(find("voice-toggle")?.props["aria-pressed"], true);
  click("voice-toggle");
  assert.equal(find("voice-toggle")?.props["aria-label"], "Enable live voice");
  assert.equal(find("voice-toggle")?.props["aria-pressed"], false);
  assert.ok(stops > 0);
  const replay = find("voice-replay");
  assert.ok(replay);
  assert.equal(replay.props.disabled, true);
  (replay.props.onClick as () => void)();
  await settle();
  assert.equal(playback, 1, "master mute rejects even programmatic replay");
  send();
  assert.equal(asks, 2, "typing remains usable while muted");
  click("voice-new-chat");
  resolveAnswer();
  await settle();
  assert.equal(find("voice-replay")?.props.disabled, true, "reset never unmutes");
  engine.resumeAudio = async () => undefined;
  click("voice-toggle");
  await settle();
  assert.equal(find("voice-toggle")?.props["aria-pressed"], true, "only explicit enable restores voice");
  assert.equal(playback, 2, "fresh greeting plays once after explicit consent");
});

test("master mute invalidates a delayed live start and greeting", async () => {
  let release!: () => void;
  let current!: () => boolean;
  let playback = 0;
  let stops = 0;
  const engine = {
    startOnDemand: async () => undefined,
    resumeAudio: async () => undefined,
    startListening: (options: { isCurrent: () => boolean }) => {
      current = options.isCurrent;
      return new Promise<void>((resolve) => { release = resolve; });
    },
    stopListening: async () => { stops++; },
    interrupt: () => undefined,
    stopAudio: () => undefined,
    speakSequence: async () => { playback++; },
  };
  const chat = mountVoiceChat(componentSourceForTest(), engine, () => undefined);
  const click = (id: string) => {
    const e = mockElements(chat.render()).find((e) => e.props["data-testid"] === id);
    assert.ok(e, id); (e.props.onClick as () => void)();
  };
  click("voice-fab");
  await settle();
  const pendingToggle = mockElements(chat.render()).find(e => e.props["data-testid"] === "voice-toggle");
  assert.equal(pendingToggle?.props["aria-label"], "Mute voice");
  assert.notEqual(pendingToggle?.props.disabled, true, "pending startup remains cancellable");
  click("voice-toggle");
  assert.equal(current(), false);
  release(); await settle();
  assert.equal(stops, 1);
  assert.equal(playback, 0);
});

test("live New chat retains consent, restarts capture and invalidates the old pending greeting", async () => {
  const guards: (() => boolean)[] = [];
  const releases: (() => void)[] = [];
  let resumes = 0;
  let stops = 0;
  let plays = 0;
  const engine = {
    startOnDemand: async () => undefined,
    resumeAudio: async () => { resumes++; },
    startListening: (options: { isCurrent: () => boolean }) => {
      guards.push(options.isCurrent);
      return new Promise<void>((resolve) => { releases.push(resolve); });
    },
    stopListening: async () => { stops++; },
    resetConversation: () => undefined,
    interrupt: () => undefined,
    stopAudio: () => undefined,
    speakSequence: async () => { plays++; },
  };
  const chat = mountVoiceChat(componentSourceForTest(), engine, () => undefined);
  const click = (id: string) => {
    const e = mockElements(chat.render()).find((e) => e.props["data-testid"] === id);
    assert.ok(e, id); (e.props.onClick as () => void)();
  };
  click("voice-fab"); await settle();
  assert.equal(guards.length, 1);
  click("voice-new-chat"); await settle();
  assert.equal(guards[0](), false);
  assert.equal(guards.length, 2);
  assert.equal(guards[1](), true);
  releases[0](); await settle();
  assert.equal(plays, 0, "old pending start cannot speak a stale intro");
  releases[1](); await settle();
  assert.equal(plays, 1);
  assert.equal(resumes, 1, "live reset preserves existing consent");
  assert.equal(stops, 1);
  assert.equal(chat.messages().filter((m) => m.text === GREETING).length, 1);
});

test("playback admission failure has a safe output notice, not a recognition notice", async () => {
  const handlers: { current: { onPlaybackError?: () => void } | null } = { current: null };
  const engine = { startOnDemand: async () => undefined, resumeAudio: async () => undefined,
    startListening: async () => undefined, stopListening: async () => undefined,
    setSttHandlers: (next: typeof handlers.current) => { handlers.current = next; },
    interrupt() {}, stopAudio() {}, speakSequence: async () => undefined };
  const chat = mountVoiceChat(componentSourceForTest(), engine, () => undefined, { captureSttRegistration: true });
  const click = (id: string) => { const e = mockElements(chat.render()).find(e => e.props["data-testid"] === id); assert.ok(e); (e.props.onClick as () => void)(); };
  click("voice-fab"); await settle(); chat.runSttRegistrationEffect();
  handlers.current?.onPlaybackError?.();
  const notice = mockElements(chat.render()).find(e => e.type === "p" && e.props.role === "status");
  assert.equal(notice?.props.children, "Speech audio could not be paused or resumed. You can still type a question.");
  assert.ok(mockElements(chat.render()).some(e => e.props["data-testid"] === "voice-input"));
  click("voice-fab");
  const before = chat.messages().length; handlers.current?.onPlaybackError?.();
  assert.equal(chat.messages().length, before, "late closed playback error is ignored");
});


test("completed audio uses a concise accessible hint; incomplete progress and retry stay visible", () => {
  const engine = {};
  const ready = mountVoiceChat(componentSourceForTest(), engine, () => undefined, { audioCacheState: "ready" });
  const readyTree = mockElements(ready.render());
  const status = readyTree.find(e => e.props["data-testid"] === "voice-audio-cache-status");
  assert.equal(status?.props.className, "audioCacheReady", "success does not consume a visible status row");
  assert.equal(status?.props.role, "status");
  assert.equal(mockElements(status).some(e => e.type === "span" && e.props.children === "Answer audio available offline."), true);
  assert.equal(readyTree.some(e => e.props.children === "Retry audio download"), false);
  for (const state of ["downloading", "partial", "skipped-save-data", "offline", "error"]) {
    const chat = mountVoiceChat(componentSourceForTest(), engine, () => undefined, { audioCacheState: state });
    const tree = mockElements(chat.render());
    const visible = tree.find(e => e.props["data-testid"] === "voice-audio-cache-status");
    assert.equal(visible?.props.className, "audioCacheStatus");
    assert.equal(tree.some(e => e.props.children === "Retry audio download"), state !== "downloading");
  }
});


test("master mute remains available while typed Replay is preparing, before actual speech", async () => {
  let finish!: () => void;
  let current!: () => boolean;
  let starts = 0;
  const engine = {
    startOnDemand: async () => undefined,
    resumeAudio: async () => { throw new Error("synthetic audio failure"); },
    resetConversation: () => undefined,
    startListening: async () => { starts++; },
    stopListening: async () => undefined,
    interrupt: () => undefined,
    stopAudio: () => undefined,
    speakSequence: (_sequence: AssistantClipSequence, options: { isCurrent: () => boolean }) => {
      current = options.isCurrent;
      return new Promise<void>(resolve => { finish = resolve; });
    },
  };
  const chat = mountVoiceChat(componentSourceForTest(), engine, () => undefined);
  const find = (id: string) => mockElements(chat.render()).find(e => e.props["data-testid"] === id);
  const click = (id: string) => { const element = find(id); assert.ok(element); (element.props.onClick as () => void)(); };
  click("voice-fab");
  await settle();
  click("voice-new-chat");
  click("voice-replay");
  assert.equal(find("voice-toggle")?.props["aria-label"], "Mute voice");
  assert.equal(find("voice-toggle")?.props["aria-pressed"], true);
  click("voice-toggle");
  assert.equal(current(), false, "mute cancels preparing replay through its stored-plan currentness guard");
  assert.equal(find("voice-replay")?.props.disabled, true);
  assert.equal(starts, 0, "mute must not enable a live microphone during typed replay setup");
  finish();
  await settle();
  assert.equal(find("voice-toggle")?.props["aria-label"], "Enable live voice");
});

test("greeting starters render prepared topics under the greeting before audio consent completes", async () => {
  let offers = 0;
  const topics = [
    { cardId: "starter-a", topic: "Synthetic topic A" },
    { cardId: "starter-b", topic: "Synthetic topic B" },
    { cardId: "starter-c", topic: "Synthetic topic C" },
  ];
  const chat = mountVoiceChat(componentSourceForTest(), {
    startOnDemand: async () => undefined,
    resumeAudio: () => new Promise<void>(() => undefined),
    offerStarters: async () => { offers += 1; return topics; },
    interrupt: () => undefined,
    stopAudio: () => undefined,
  }, () => undefined, { captureGreetingEffect: true });
  const opener = mockElements(chat.render()).find((element) => element.props["data-testid"] === "voice-fab");
  assert.ok(opener);
  (opener.props.onClick as () => void)();
  chat.render();
  chat.runGreetingEffect();
  await settle();
  const elements = mockElements(chat.render());
  const buttons = elements.filter((element) => element.props["data-testid"] === "voice-starter");
  assert.deepEqual(buttons.map((element) => element.props.children), topics.map((topic) => topic.topic),
    "three prepared topics are available while consent is pending");
  assert.equal(offers, 1);
  const greetingPosition = elements.findIndex((element) => element.type === "p" && element.props.children === GREETING);
  const groupPosition = elements.findIndex((element) => element.props["aria-label"] === "Suggested fact topics");
  assert.ok(greetingPosition >= 0 && groupPosition > greetingPosition, "the offer follows the greeting in the message area");
  assert.equal(buttons.every((button) => button.type === "button" && button.props.type === "button" && button.props.className === "choice"), true);
});

function starterComponentHarness(options: {
  loadController?: () => Promise<ReturnType<typeof createRetrievalController>>;
  startListening?: () => Promise<void>;
} = {}) {
  let draws = 0;
  let asks = 0;
  let resets = 0;
  const index = syntheticIndex();
  index.cards[1].sourceRefs = [{ startLine: 17, endLine: 19 }];
  const controller = createRetrievalController(index, () => { draws += 1; return 0; });
  const engine = new VoiceEngine({ loadController: options.loadController ?? (async () => controller) });
  const plans: AssistantClipSequence[] = [];
  const navigation: SourceRefs[] = [];
  const handlers: { current: SttHandlersForStarterTest } = { current: {} };
  const chat = mountVoiceChat(componentSourceForTest(), {
    startOnDemand: async () => undefined,
    resumeAudio: async () => undefined,
    startListening: options.startListening ?? (async () => undefined),
    stopListening: async () => undefined,
    setSttHandlers: (next: SttHandlersForStarterTest) => { handlers.current = next; },
    offerStarters: engine.offerStarters.bind(engine),
    dismissStarters: engine.dismissStarters.bind(engine),
    chooseClarification: engine.chooseClarification.bind(engine),
    resetConversation: () => { resets += 1; engine.resetConversation(); },
    ask: (question: string, askOptions: AskOptions) => { asks += 1; return engine.ask(question, askOptions); },
    interrupt: engine.interrupt.bind(engine),
    stopAudio: engine.stopAudio.bind(engine),
    pendingChoices: engine.pendingChoices.bind(engine),
    speakSequence: async (sequence: AssistantClipSequence) => { plans.push(sequence); },
  }, (refs) => navigation.push(refs), { captureGreetingEffect: true, captureSttRegistration: true });
  const find = (id: string) => mockElements(chat.render()).find((element) => element.props["data-testid"] === id);
  const click = (id: string) => {
    const button = find(id);
    assert.ok(button, id);
    (button.props.onClick as () => void)();
  };
  const starters = () => mockElements(chat.render()).filter((element) => element.props["data-testid"] === "voice-starter");
  const open = async () => {
    click("voice-fab");
    chat.render();
    chat.runGreetingEffect();
    chat.runSttRegistrationEffect();
    await settle();
  };
  const send = async () => {
    const input = find("voice-input");
    assert.ok(input);
    (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "calendar scheduling" } });
    const form = mockElements(chat.render()).find((element) => element.type === "form");
    assert.ok(form);
    (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
    await settle();
  };
  return { chat, engine, plans, navigation, handlers, find, click, starters, open, send,
    counts: () => ({ draws, asks, resets }) };
}

type SttHandlersForStarterTest = {
  onText?: (text: string) => void;
  onLine?: (line: { text: string }) => void;
  onUtteranceEnd?: () => void;
};

test("starter offer stays stable through render, greeting, mute and unchanged reopen; muted New chat resamples", async () => {
  const h = starterComponentHarness();
  await h.open();
  const topics = h.starters().map((button) => button.props.children);
  assert.equal(topics.length, 3);
  assert.equal(h.counts().draws, 3);
  assert.equal(h.chat.messages().filter((message) => message.text === GREETING).length, 1);
  assert.equal(h.plans.length, 1, "only the existing consented greeting plays");
  h.chat.render();
  h.click("voice-toggle");
  assert.deepEqual(h.starters().map((button) => button.props.children), topics);
  h.click("voice-fab");
  await h.open();
  assert.deepEqual(h.starters().map((button) => button.props.children), topics);
  assert.equal(h.counts().draws, 3, "close/reopen does not resample");
  assert.equal(h.chat.messages().filter((message) => message.text === GREETING).length, 1);
  assert.equal(h.plans.length, 1, "unchanged reopen does not greet again");
  h.click("voice-toggle");
  h.click("voice-new-chat");
  await settle();
  assert.equal(h.counts().draws, 6);
  assert.equal(h.counts().resets, 1);
  assert.equal(h.starters().length, 3);
  assert.equal(h.chat.messages().filter((message) => message.text === GREETING).length, 1);
  assert.equal(h.plans.length, 1, "muted reset does not autoplay");
  assert.equal(h.find("voice-toggle")?.props["aria-label"], "Enable live voice");
});

test("starter exact selection binds prepared text, source and immutable Replay without asking or late startup greeting", async () => {
  let finishCapture!: () => void;
  const h = starterComponentHarness({ startListening: () => new Promise<void>((resolve) => { finishCapture = resolve; }) });
  await h.open();
  const button = h.starters().find((element) => element.props.children === "Synthetic payment ledgers");
  assert.ok(button);
  (button.props.onClick as () => void)();
  await settle();
  assert.equal(h.starters().length, 0);
  assert.equal(h.counts().asks, 0);
  const message = h.chat.messages().find((item) => item.selectedCardId === "synthetic-ledgers");
  assert.ok(message?.audioSequence);
  assert.equal(message.text, "A synthetic fixture records payment ledgers.");
  assert.deepEqual(message.audioSequence, [{ kind: "fact", cardId: "synthetic-ledgers", text: "A synthetic fixture records payment ledgers." }]);
  assert.ok(Object.isFrozen(message.audioSequence));
  assert.deepEqual(h.navigation, [[{ startLine: 17, endLine: 19 }]], "navigation belongs to the exact offered card, not its neighbor");
  assert.strictEqual(h.plans[0], message.audioSequence, "autoplay consumes the stored plan");
  finishCapture();
  await settle();
  assert.equal(h.plans.length, 1, "late capture startup cannot greet over a starter selection");
  const replay = mockElements(h.chat.render()).filter((element) => element.props["data-testid"] === "voice-replay").at(-1);
  assert.ok(replay);
  (replay.props.onClick as () => void)();
  await settle();
  assert.strictEqual(h.plans[1], message.audioSequence);
  assert.equal(h.counts().asks, 0);
});

for (const newer of ["Send", "spoken question", "close", "New chat"] as const) {
  test(`lazy starter completion stays isolated after ${newer}`, async () => {
    let release!: (controller: ReturnType<typeof createRetrievalController>) => void;
    const h = starterComponentHarness({ loadController: () => new Promise((resolve) => { release = resolve; }) });
    await h.open();
    assert.equal(h.starters().length, 0);
    if (newer === "Send") await h.send();
    if (newer === "spoken question") h.handlers.current.onText?.("spoken synthetic question");
    if (newer === "close") h.click("voice-fab");
    if (newer === "New chat") h.click("voice-new-chat");
    release(createRetrievalController(syntheticIndex(), () => 0));
    await settle();
    assert.equal(h.starters().length, newer === "New chat" ? 3 : 0,
      "only a fresh conversation may own a fresh offer after reset");
    if (newer === "Send") {
      assert.equal(h.chat.messages().some((message) => message.selectedCardId === "synthetic-calendar"), true);
    }
    if (newer === "close") {
      await h.open();
      assert.equal(h.starters().length, 3, "an unchanged reopen can finish its own guarded offer");
    }
  });
}

test("a late starter offer cannot overwrite newer clarification controls", async () => {
  let release!: (topics: { cardId: string; topic: string }[]) => void;
  const clarification: ClarificationChoice[] = [
    { cardId: "clarify-a", topic: "Synthetic clarification A", score: 0.51 },
    { cardId: "clarify-b", topic: "Synthetic clarification B", score: 0.5 },
  ];
  const chat = mountVoiceChat(componentSourceForTest(), {
    startOnDemand: async () => undefined,
    resumeAudio: () => new Promise<void>(() => undefined),
    offerStarters: () => new Promise((resolve) => { release = resolve; }),
    interrupt: () => undefined,
    stopAudio: () => undefined,
    ask: async (_question: string, options: AskOptions) => {
      options.onResult?.({ kind: "clarify", choices: clarification });
      return "";
    },
  }, () => undefined, { captureGreetingEffect: true });
  const find = (id: string) => mockElements(chat.render()).find((element) => element.props["data-testid"] === id);
  (find("voice-fab")!.props.onClick as () => void)();
  chat.render();
  chat.runGreetingEffect();
  (find("voice-input")!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "actual question" } });
  const form = mockElements(chat.render()).find((element) => element.type === "form")!;
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
  await settle();
  release([{ cardId: "stale-starter", topic: "Synthetic stale topic" }]);
  await settle();
  const elements = mockElements(chat.render());
  assert.deepEqual(elements.filter((element) => element.props["data-testid"] === "voice-choice")
    .map((element) => element.props.children), ["Synthetic clarification A", "Synthetic clarification B"]);
  assert.equal(elements.some((element) => element.props["data-testid"] === "voice-starter"), false);
});

test("a muted starter selection stays silent and keeps its exact Replay plan disabled", async () => {
  const h = starterComponentHarness();
  await h.open();
  h.click("voice-toggle");
  const button = h.starters().find((element) => element.props.children === "Synthetic audio codecs");
  assert.ok(button);
  (button.props.onClick as () => void)();
  await settle();
  assert.equal(h.plans.length, 1, "selection cannot autoplay through master mute");
  assert.equal(h.starters().length, 0);
  const message = h.chat.messages().find((item) => item.selectedCardId === "synthetic-codecs");
  assert.deepEqual(message?.audioSequence, [{ kind: "fact", cardId: "synthetic-codecs", text: "A synthetic fixture records audio codecs." }]);
  const replay = mockElements(h.chat.render()).filter((element) => element.props["data-testid"] === "voice-replay").at(-1);
  assert.ok(replay);
  assert.equal(replay.props.disabled, true);
  (replay.props.onClick as () => void)();
  await settle();
  assert.equal(h.plans.length, 1);
  assert.equal(h.counts().asks, 0);
});

for (const available of ["empty", "failed"] as const) {
  test(`${available} starter index leaves the question composer usable`, async () => {
    const h = starterComponentHarness({ loadController: async () => {
      if (available === "failed") throw new Error("synthetic index unavailable");
      return createRetrievalController(syntheticIndex([]));
    } });
    await h.open();
    assert.equal(h.starters().length, 0);
    assert.equal(h.find("voice-input")?.props.disabled, undefined);
    await h.send();
    assert.equal(h.counts().asks, 1, "typing still reaches the ordinary question path");
    assert.equal(h.chat.messages().some((message) => message.role === "user" && message.text === "calendar scheduling"), true);
  });
}
