/**
 * The engine's answer path behind its existing interface: retrieval selection, one whole
 * answer emission in place of token streaming, and a turn token that stops an interrupted
 * or closed turn from emitting late. Speech is tested through the shared message-plan flow.
 * Model progress covers only STT and the retrieval encoder.
 *
 * Everything is synthetic: the index is the shared fixture, the encoder worker is a double
 * and speech is recorded on the instance, so no model, worker or CV text is involved.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";

import type { Answer, VoiceEngine as VoiceEngineInstance } from "../src/chat/engine.ts";
import type { AnswerAudioPlayer } from "../src/chat/answer-audio.ts";
import type { AssistantClipSequence } from "../src/chat/audio-catalog.ts";
import {
  createRetrievalController,
  WEAK_MATCH_CUE,
} from "../src/chat/retrieval/controller.ts";
import {
  createRetrievalEncoder,
  type EncoderWorker,
} from "../src/chat/retrieval/encoder/index.ts";
import { EXPECTED_EMBEDDING } from "../src/chat/retrieval/index.ts";
import type { EncoderRequest } from "../src/chat/retrieval/encoder/protocol.ts";
import { axisVector, syntheticIndex } from "./retrieval-fixtures.ts";

const engineSource = process.env.VOICE_ENGINE_SOURCE_OVERRIDE
  ? pathToFileURL(process.env.VOICE_ENGINE_SOURCE_OVERRIDE).href
  : new URL("../src/chat/engine.ts", import.meta.url).href;
const { VoiceEngine } = await import(engineSource) as typeof import("../src/chat/engine.ts");

const QUESTION = "calendar scheduling";
const DIMENSIONS = EXPECTED_EMBEDDING.dimensions;

/** A worker double: it records what was sent and lets the test decide what comes back. */
class FakeWorker implements EncoderWorker {
  readonly sent: EncoderRequest[] = [];
  private messageListener: (value: unknown) => void = () => undefined;
  private failureListener: () => void = () => undefined;

  postMessage(message: EncoderRequest): void {
    this.sent.push(message);
  }

  terminate(): void {}

  onMessage(listener: (value: unknown) => void): void {
    this.messageListener = listener;
  }

  onFailure(listener: () => void): void {
    this.failureListener = listener;
  }

  emit(value: unknown): void {
    this.messageListener(value);
  }

  fail(): void {
    this.failureListener();
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

interface Harness {
  engine: VoiceEngineInstance;
  workers: FakeWorker[];
  playedPlans: AssistantClipSequence[];
}

function setup(): Harness {
  stubAudioContext();
  const workers: FakeWorker[] = [];
  const encoder = createRetrievalEncoder({
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  const playedPlans: AssistantClipSequence[] = [];
  const audioPlayer: AnswerAudioPlayer = {
    playReferences: async (sequence) => { playedPlans.push(sequence); },
    stop: () => undefined,
  };
  const engine = new VoiceEngine({
    loadController: async () => createRetrievalController(syntheticIndex()),
    encoder,
    audioPlayer: () => audioPlayer,
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

  assert.equal(harness.workers[0].sent.filter((message) => message.type === "load").length, 1);
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

test("the shipping engine holds no prompt route and no generative answer call", async () => {
  const source = await readFile(new URL("../src/chat/engine.ts", import.meta.url), "utf8");

  assert.ok(!source.includes("cv-context"), "the engine must not import the prompt helpers");
  assert.ok(!source.includes("buildPromptMessages"), "no full-CV prompt route");
  assert.ok(!source.includes("chat.completions"), "no generative answer call");
  assert.ok(!source.includes("WEAK_MATCH_CUE"), "the weak-match cue belongs to the chat UI");
});

test("storage persistence diagnostics do not forward raw exception payloads", async () => {
  const sourcePath = process.env.VOICE_ENGINE_SOURCE_OVERRIDE
    ? pathToFileURL(process.env.VOICE_ENGINE_SOURCE_OVERRIDE)
    : new URL("../src/chat/engine.ts", import.meta.url);
  const source = await readFile(sourcePath, "utf8");
  const rawPayloadTrace = /trace\(\s*[\"']storage persist failed[\"']\s*,/.test(source);
  assert.equal(rawPayloadTrace, false, "storage failure traces contain only the fixed lifecycle event");
});

/**
 * Content-free replacement for the deleted prompt-equality assertions: instead of pinning
 * the prompt's instructions and full-CV body, no shipping source may hold a prompt template,
 * a raw CV import, the old runtime import or an llm state at all. Strings compared are
 * markers only; no CV text is read or copied here.
 */
test("no shipping source composes a prompt or reaches the retired answer runtime", async () => {
  const { readdir, readFile: read } = await import("node:fs/promises");
  const srcRoot = new URL("../src/", import.meta.url);
  const forbidden = [
    "--- CV ---",
    "SYSTEM_PROMPT",
    "buildPromptMessages",
    "cleanForDisplay",
    "chat.completions",
    "CreateMLCEngine",
    "@mlc-ai/web-llm",
    "SmolLM2",
    "pocket-tts-js",
    "PocketTTS",
  ];
  // The assistant code must not carry the CV body at all. The site page still renders
  // the public CV for display, which is the page's purpose, not a prompt.
  const chatForbidden = [...forbidden, "cv.md?raw"];

  const files: string[] = [];
  const walk = async (url: URL): Promise<void> => {
    for (const entry of await readdir(url, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), url);
      if (entry.isDirectory()) await walk(child);
      else if (/\.(ts|tsx|css)$/.test(entry.name)) files.push(child.href);
    }
  };
  await walk(srcRoot);
  assert.ok(files.length >= 10, "the scan must actually cover the source tree");

  for (const href of files) {
    const text = await read(new URL(href), "utf8");
    const markers = href.includes("/src/chat/") ? chatForbidden : forbidden;
    for (const marker of markers) {
      assert.ok(!text.includes(marker), `${href} must not contain ${marker}`);
    }
    if (href.endsWith("engine.ts")) {
      assert.ok(!/\bllm\b/.test(text), `${href} must hold no llm slot`);
    }
  }
});

test("without a ready encoder the question answers from the lexical path as limited", async () => {
  const { engine, workers } = setup();
  const results: Answer[] = [];
  const emissions: string[] = [];

  const answer = await engine.ask(QUESTION, {
    onResult: (result) => results.push(result),
    onDelta: (text) => emissions.push(text),
  });

  assert.equal(workers.length, 0, "a question alone makes no model request");
  assert.equal(results.length, 1);
  assert.equal(results[0].kind, "answer");
  assert.equal(results[0].kind === "answer" && results[0].matching, "limited");
  assert.equal(results[0].kind === "answer" && results[0].limitedCause, "model-unavailable");
  assert.notEqual(answer, "");
  assert.deepEqual(emissions, [answer], "one whole answer emission, not token streaming");
});

test("a ready encoder answers the same question semantically", async () => {
  const harness = setup();
  await readyEncoder(harness);

  const results: Answer[] = [];
  const pending = harness.engine.ask(QUESTION, { onResult: (result) => results.push(result) });
  const embeds = await waitForEmbeds(harness.workers[0], 1);
  const embed = embeds[0];
  assert.equal(embed.type, "embed");
  if (embed.type !== "embed") return;
  harness.workers[0].emit(vectorMessage(embed.id));

  const answer = await pending;
  assert.notEqual(answer, "");
  assert.equal(results.length, 1);
  assert.equal(results[0].kind, "answer");
  assert.equal(results[0].kind === "answer" && results[0].matching, "semantic");
});

test("typed and recognized asks select the same prepared answer without bypassing the message plan", async () => {
  const harness = setup();
  await readyEncoder(harness);

  const typedResults: Answer[] = [];
  const typedPending = harness.engine.ask(QUESTION, { onResult: (result) => typedResults.push(result) });
  const firstEmbeds = await waitForEmbeds(harness.workers[0], 1);
  const firstEmbed = firstEmbeds[0];
  assert.equal(firstEmbed.type, "embed");
  if (firstEmbed.type !== "embed") return;
  harness.workers[0].emit(vectorMessage(firstEmbed.id));
  const typed = await typedPending;

  const recognizedResults: Answer[] = [];
  const recognizedEmissions: string[] = [];
  const recognizedPending = harness.engine.ask(QUESTION, {
    onResult: (result) => recognizedResults.push(result),
    onDelta: (text) => recognizedEmissions.push(text),
  });
  const embeds = await waitForEmbeds(harness.workers[0], 2);
  const embed = embeds[1];
  assert.equal(embed.type, "embed");
  if (embed.type !== "embed") return;
  harness.workers[0].emit(vectorMessage(embed.id));
  const recognizedAnswer = await recognizedPending;

  assert.equal(recognizedAnswer, typed, "the same question selects the same prepared answer");
  assert.deepEqual(recognizedEmissions, [typed]);
  assert.equal(harness.playedPlans.length, 0, "retrieval never owns message-plan playback");
  assert.ok(!typed.includes(WEAK_MATCH_CUE), "the cue stays outside prepared text");
  assert.equal(
    recognizedResults[0].kind === "answer" && recognizedResults[0].answer,
    typedResults[0].kind === "answer" && typedResults[0].answer,
  );
  assert.equal(recognizedResults[0].kind === "answer" && recognizedResults[0].matching, "semantic");
});

test("retrieval emits selected text without starting message-plan playback", async () => {
  const { engine, playedPlans } = setup();
  const emissions: string[] = [];
  const answer = await engine.ask(QUESTION, { onDelta: (text) => emissions.push(text) });

  assert.notEqual(answer, "");
  assert.deepEqual(emissions, [answer]);
  assert.deepEqual(playedPlans, [], "the shared turn flow owns all assistant playback");
});

test("an interrupt during an in-flight question emits no late answer", async () => {
  const harness = setup();
  await readyEncoder(harness);

  const results: Answer[] = [];
  const emissions: string[] = [];
  const pending = harness.engine.ask(QUESTION, {
    onResult: (result) => results.push(result),
    onDelta: (text) => emissions.push(text),
  });

  const embeds = await waitForEmbeds(harness.workers[0], 1);
  const embed = embeds[0];
  assert.equal(embed.type, "embed");
  if (embed.type !== "embed") return;

  // What the chat's close path does first: invalidate the turn.
  harness.engine.interrupt();
  harness.workers[0].emit(vectorMessage(embed.id));

  assert.equal(await pending, "");
  assert.equal(results.length, 0, "a superseded turn surfaces no structured result");
  assert.deepEqual(emissions, []);
  assert.deepEqual(harness.playedPlans, [], "no playback starts inside an invalidated retrieval turn");
});

test("a newer question supersedes the older in-flight one", async () => {
  const harness = setup();
  await readyEncoder(harness);

  const olderResults: Answer[] = [];
  const older = harness.engine.ask(QUESTION, { onResult: (result) => olderResults.push(result) });
  await waitForEmbeds(harness.workers[0], 1);

  const newerResults: Answer[] = [];
  const newer = harness.engine.ask(QUESTION, { onResult: (result) => newerResults.push(result) });
  const embeds = await waitForEmbeds(harness.workers[0], 2);
  const embed = embeds[1];
  assert.equal(embed.type, "embed");
  if (embed.type !== "embed") return;
  harness.workers[0].emit(vectorMessage(embed.id));

  assert.equal(await older, "");
  assert.equal(olderResults.length, 0, "the superseded question emits nothing");
  assert.notEqual(await newer, "");
  assert.equal(newerResults.length, 1);
});

test("the loaded encoder is reused across a close and reopen", async () => {
  const harness = setup();
  await readyEncoder(harness);

  const first = harness.engine.ask(QUESTION);
  const firstEmbeds = await waitForEmbeds(harness.workers[0], 1);
  const firstEmbed = firstEmbeds[0];
  assert.equal(firstEmbed.type, "embed");
  if (firstEmbed.type !== "embed") return;
  harness.workers[0].emit(vectorMessage(firstEmbed.id));
  assert.notEqual(await first, "");

  // What the chat's close does to the engine, followed by a reopen and a new question.
  harness.engine.interrupt();

  const second = harness.engine.ask(QUESTION);
  const secondEmbeds = await waitForEmbeds(harness.workers[0], 2);
  const secondEmbed = secondEmbeds[1];
  assert.equal(secondEmbed.type, "embed");
  if (secondEmbed.type !== "embed") return;
  harness.workers[0].emit(vectorMessage(secondEmbed.id));
  assert.notEqual(await second, "");

  assert.equal(harness.workers.length, 1, "one worker serves both turns");
  assert.equal(
    harness.workers[0].sent.filter((message) => message.type === "load").length,
    1,
    "the cached model is not reloaded on reopen",
  );
});

test("a controller that resolves after an interrupt emits no late answer", async () => {
  const workers: FakeWorker[] = [];
  const encoder = createRetrievalEncoder({
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  // The index load is the deferred work: it resolves only after the turn was invalidated.
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
    encoder,
    audioPlayer: () => ({
      playReferences: async (sequence) => { playedPlans.push(sequence); },
      stop: () => undefined,
    }),
  });

  const results: Answer[] = [];
  const emissions: string[] = [];
  const pending = engine.ask(QUESTION, {
    onResult: (result) => results.push(result),
    onDelta: (text) => emissions.push(text),
  });

  // What the chat's close path does first: invalidate the turn and stop playback.
  engine.interrupt();
  engine.stopAudio();

  assert.equal(controllerLoads, 1, "the question started the deferred controller load");
  releaseController();

  assert.equal(await pending, "");
  assert.equal(results.length, 0, "a result resolving after the interrupt surfaces nothing");
  assert.deepEqual(emissions, [], "no late answer reaches the chat");
  assert.deepEqual(playedPlans, [], "no playback starts after the interrupt");
  assert.deepEqual(workers, [], "the invalidated turn starts no encoder request");
});

test("a failed encoder still answers limited instead of losing the turn", async () => {
  const harness = setup();
  await readyEncoder(harness);

  const results: Answer[] = [];
  const pending = harness.engine.ask(QUESTION, { onResult: (result) => results.push(result) });
  await waitForEmbeds(harness.workers[0], 1);
  harness.workers[0].fail();

  const answer = await pending;

  assert.equal(results.length, 1);
  assert.equal(results[0].kind, "answer");
  assert.equal(results[0].kind === "answer" && results[0].matching, "limited");
  assert.equal(results[0].kind === "answer" && results[0].limitedCause, "embedding-failed");
  assert.notEqual(answer, "");
});

function stubAudioContext(): void {
  const scope = globalThis as { AudioContext?: unknown };
  scope.AudioContext ??= class {
    state = "running";
    destination = {};
    resume(): Promise<void> {
      return Promise.resolve();
    }
  };
}

async function withTestAudioContext(
  state: AudioContextState,
  resume: () => Promise<void>,
  run: () => Promise<void>,
): Promise<void> {
  const scope = globalThis as unknown as { AudioContext?: typeof AudioContext };
  const previous = scope.AudioContext;
  scope.AudioContext = class {
    readonly state = state;
    readonly destination = {};
    resume(): Promise<void> {
      return resume();
    }
  } as unknown as typeof AudioContext;
  try {
    await run();
  } finally {
    if (previous === undefined) delete scope.AudioContext;
    else scope.AudioContext = previous;
  }
}

test("resumeAudio normalizes an AudioContext constructor failure", async () => {
  const scope = globalThis as unknown as { AudioContext?: typeof AudioContext };
  const previous = scope.AudioContext;
  scope.AudioContext = class {
    constructor() {
      throw new Error("constructor-failed");
    }
  } as unknown as typeof AudioContext;
  try {
    await assert.rejects(new VoiceEngine().resumeAudio(), {
      message: "Speech audio could not be played.",
    });
  } finally {
    if (previous === undefined) delete scope.AudioContext;
    else scope.AudioContext = previous;
  }
});

test("resumeAudio rejects a browser resume failure", async () => {
  await withTestAudioContext("suspended", async () => { throw new Error("resume-failed"); }, async () => {
    const engine = new VoiceEngine();
    await assert.rejects(engine.resumeAudio(), { message: "Speech audio could not be played." });
  });
});

test("resumeAudio rejects a context that remains non-running", async () => {
  await withTestAudioContext("suspended", async () => undefined, async () => {
    const engine = new VoiceEngine();
    await assert.rejects(engine.resumeAudio(), { message: "Speech audio could not be played." });
  });
});

test("speech recognition starts before optional output resume settles", async () => {
  let settleResume: () => void = () => undefined;
  let resumeSettled = false;
  const resumePending = new Promise<void>((resolve) => { settleResume = resolve; }).then(() => {
    resumeSettled = true;
  });

  await withTestAudioContext("suspended", () => resumePending, async () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { crossOriginIsolated: false },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { mediaDevices: { getUserMedia: () => undefined } },
    });
    let listening: Promise<void> | null = null;
    try {
      let signalStart: () => void = () => undefined;
      const started = new Promise<void>((resolve) => { signalStart = resolve; });
      const engine = new VoiceEngine({
        stt: async () => ({
          load: async () => undefined,
          start: async () => { signalStart(); },
          stop: async () => undefined,
        }),
      });
      listening = engine.startListening();
      let timeoutId!: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error("STT start was blocked by audio resume")), 1000);
      });
      try {
        await Promise.race([started, timeout]);
      } finally {
        clearTimeout(timeoutId);
      }
      assert.equal(resumeSettled, false, "STT start reached the injected adapter while resume is pending");
      settleResume();
      await listening;
      await resumePending;
      await settle();
    } finally {
      settleResume();
      await listening?.catch(() => undefined);
      if (windowDescriptor === undefined) Reflect.deleteProperty(globalThis, "window");
      else Object.defineProperty(globalThis, "window", windowDescriptor);
      if (navigatorDescriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    }
  });
});

test("a stale live-voice request does not construct audio or load STT", async () => {
  await withDeferredAudioContext(async ({ constructions, resumes }) => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { crossOriginIsolated: false },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { mediaDevices: { getUserMedia: () => undefined } },
    });
    let speechLoads = 0;
    try {
      const engine = new VoiceEngine({ stt: async () => {
        speechLoads += 1;
        throw new Error("stale request must not load STT");
      } });

      await engine.startListening({ isCurrent: () => false }).catch(() => undefined);
      assert.equal(constructions(), 0);
      assert.equal(resumes(), 0);
      assert.equal(speechLoads, 0);
    } finally {
      if (windowDescriptor === undefined) Reflect.deleteProperty(globalThis, "window");
      else Object.defineProperty(globalThis, "window", windowDescriptor);
      if (navigatorDescriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    }
  });
});

test("closing while STT loads prevents the microphone from starting", async () => {
  await withTestAudioContext("running", async () => undefined, async () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { crossOriginIsolated: false },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { mediaDevices: { getUserMedia: () => undefined } },
    });

    type TestStt = { load: () => Promise<void>; start: () => Promise<void>; stop: () => Promise<void> };
    let finishLoad: (stt: TestStt) => void = () => undefined;
    let signalLoad: () => void = () => undefined;
    const loading = new Promise<void>((resolve) => { signalLoad = resolve; });
    const pendingStt = new Promise<TestStt>((resolve) => { finishLoad = resolve; });
    let starts = 0;
    let current = true;
    try {
      const engine = new VoiceEngine({
        stt: async () => {
          signalLoad();
          return pendingStt;
        },
      });
      const listening = engine.startListening({ isCurrent: () => current });
      await loading;
      current = false;
      finishLoad({
        load: async () => undefined,
        start: async () => { starts += 1; },
        stop: async () => undefined,
      });
      await listening;
      assert.equal(starts, 0, "a canceled choice never opens microphone capture");
    } finally {
      if (windowDescriptor === undefined) Reflect.deleteProperty(globalThis, "window");
      else Object.defineProperty(globalThis, "window", windowDescriptor);
      if (navigatorDescriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    }
  });
});

test("closing during microphone start stops the late-started capture", async () => {
  await withTestAudioContext("running", async () => undefined, async () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { crossOriginIsolated: false },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { mediaDevices: { getUserMedia: () => undefined } },
    });

    let signalStart: () => void = () => undefined;
    let finishStart: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { signalStart = resolve; });
    const pendingStart = new Promise<void>((resolve) => { finishStart = resolve; });
    let stopCalls = 0;
    let current = true;
    try {
      const engine = new VoiceEngine({
        stt: async () => ({
          load: async () => undefined,
          start: async () => {
            signalStart();
            await pendingStart;
          },
          stop: async () => { stopCalls += 1; },
        }),
      });
      const listening = engine.startListening({ isCurrent: () => current });
      await started;
      current = false;
      finishStart();
      await listening;
      assert.equal(stopCalls, 1, "a close during start stops capture after the adapter settles");
    } finally {
      finishStart();
      if (windowDescriptor === undefined) Reflect.deleteProperty(globalThis, "window");
      else Object.defineProperty(globalThis, "window", windowDescriptor);
      if (navigatorDescriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    }
  });
});

test("opening does not load speech recognition before live-voice consent", async () => {
  let finishEncoder: () => void = () => {};
  const pendingEncoder = new Promise<void>((resolve) => { finishEncoder = resolve; });
  let speechLoads = 0;
  class PendingMatchingEngine extends VoiceEngine {
    override ensureEncoder(): Promise<void> { return pendingEncoder; }
    override async ensureStt(): Promise<void> { speechLoads += 1; }
  }
  const engine = new PendingMatchingEngine({ storage: () => undefined });
  const loading = engine.startOnDemand();
  try {
    await settle();
    assert.equal(speechLoads, 0, "opening loads retrieval only; STT awaits live-voice consent");
  } finally {
    finishEncoder();
    await loading;
  }
});

test("the engine tracks only STT and retrieval model readiness", () => {
  const { engine } = setup();
  assert.deepEqual(Object.keys(engine.states).sort(), ["encoder", "stt"]);
  assert.deepEqual(Object.keys(engine.progress).sort(), ["encoder", "stt"]);
});

test("the engine exposes no raw-id greeting or answer playback methods", () => {
  const { engine } = setup();
  assert.equal("speakGreeting" in engine, false);
  assert.equal("speakAnswer" in engine, false);
});

test("interrupt stops answer-audio playback", () => {
  let stops = 0;
  const engine = new VoiceEngine({
    audioPlayer: () => ({
      playReferences: async () => undefined,
      stop: () => { stops += 1; },
    }),
  });
  engine.interrupt();
  assert.equal(stops, 1);
});

async function withDeferredAudioContext(
  run: (context: { constructions: () => number; resumes: () => number; release: () => void }) => Promise<void>,
): Promise<void> {
  const scope = globalThis as unknown as { AudioContext?: typeof AudioContext };
  const previous = scope.AudioContext;
  let state: AudioContextState = "suspended";
  let constructions = 0;
  let resumes = 0;
  let releaseResume: () => void = () => undefined;
  const pendingResume = new Promise<void>((resolve) => {
    releaseResume = () => {
      state = "running";
      resolve();
    };
  });
  scope.AudioContext = class {
    readonly destination = {};
    constructor() { constructions += 1; }
    get state(): AudioContextState { return state; }
    resume(): Promise<void> {
      resumes += 1;
      return pendingResume;
    }
  } as unknown as typeof AudioContext;
  try {
    await run({
      constructions: () => constructions,
      resumes: () => resumes,
      release: () => releaseResume(),
    });
  } finally {
    releaseResume();
    if (previous === undefined) delete scope.AudioContext;
    else scope.AudioContext = previous;
  }
}

const referencePlan: AssistantClipSequence = Object.freeze([
  Object.freeze({ kind: "catalog", id: "clarifyPrompt", text: "Which of these did you mean?" }),
  Object.freeze({ kind: "topic", cardId: "calendar", text: "Synthetic calendar topic" }),
]);

test("stored reference playback snapshots exact order before delayed resume", async () => {
  const source = [
    { kind: "catalog" as const, id: "clarifyPrompt" as const, text: "Which of these did you mean?" },
    { kind: "topic" as const, cardId: "calendar", text: "Synthetic calendar topic" },
  ];
  const mutablePlan = source as unknown as AssistantClipSequence;
  const calls: string[] = [];
  let received: AssistantClipSequence | null = null;
  let retrievalCalls = 0;
  const player: AnswerAudioPlayer = {
    playReferences: async (sequence, _context, isCurrent) => {
      calls.push("references");
      received = sequence;
      assert.equal(isCurrent?.(), true);
    },
    stop: () => { calls.push("stop"); },
  };

  await withDeferredAudioContext(async ({ constructions, resumes, release }) => {
    const speaking: boolean[] = [];
    const engine = new VoiceEngine({
      audioPlayer: () => player,
      loadController: async () => {
        retrievalCalls += 1;
        throw new Error("reference playback must not retrieve");
      },
    });
    const pending = engine.speakSequence(mutablePlan, {
      onSpeakingChange: (value) => speaking.push(value),
    });
    await settle();

    assert.equal(constructions(), 1);
    assert.equal(resumes(), 1);
    assert.equal(received, null, "references wait for the suspended context");
    assert.deepEqual(calls, ["stop"]);
    Reflect.set(source[0], "text", "mutated prompt");
    source.push({ kind: "topic", cardId: "injected", text: "Late topic" });

    release();
    await pending;
    assert.deepEqual(received, referencePlan, "the stored plan keeps its original values and order");
    assert.notEqual(received, mutablePlan, "the delayed operation owns a value snapshot");
    assert.deepEqual(speaking, [true, false]);

    assert.equal(retrievalCalls, 0, "message playback never repeats retrieval");
    assert.equal(constructions(), 1, "stored-plan playback owns the AudioContext");
    assert.equal(resumes(), 1, "a running context is not resumed a second time");
    assert.deepEqual(calls, ["stop", "references"]);
  });
});

test("empty and initially stale reference plans do not create, resume or stop output", async () => {
  await withDeferredAudioContext(async ({ constructions, resumes }) => {
    let stops = 0;
    let plays = 0;
    const speaking: boolean[] = [];
    const engine = new VoiceEngine({
      audioPlayer: () => ({
        playReferences: async () => { plays += 1; },
        stop: () => { stops += 1; },
      }),
    });

    await engine.speakSequence([], { onSpeakingChange: (value) => speaking.push(value) });
    await engine.speakSequence(referencePlan, {
      isCurrent: () => false,
      onSpeakingChange: (value) => speaking.push(value),
    });

    assert.equal(constructions(), 0);
    assert.equal(resumes(), 0);
    assert.equal(stops, 0);
    assert.equal(plays, 0);
    assert.deepEqual(speaking, []);
  });
});

test("replacement and direct stop complete each stored sequence once without late state changes", async () => {
  await withTestAudioContext("running", async () => undefined, async () => {
    let stops = 0;
    const guards: Array<() => boolean> = [];
    const activeFinish: { current: (() => void) | null } = { current: null };
    const events: string[] = [];
    const player: AnswerAudioPlayer = {
      playReferences: (_sequence, _context, isCurrent) => {
        guards.push(isCurrent ?? (() => true));
        return new Promise<void>((resolve) => { activeFinish.current = resolve; });
      },
      stop: () => {
        stops += 1;
        const finish = activeFinish.current;
        activeFinish.current = null;
        finish?.();
      },
    };
    const engine = new VoiceEngine({ audioPlayer: () => player });

    const first = engine.speakSequence(referencePlan, {
      onSpeakingChange: (speaking) => events.push(`first:${speaking}`),
    });
    await settle();
    assert.deepEqual(events, ["first:true"]);
    assert.equal(guards[0](), true);
    await engine.speakSequence([]);
    assert.equal(stops, 1, "an empty plan does not replace active output");
    assert.equal(guards[0](), true);
    assert.deepEqual(events, ["first:true"]);

    const second = engine.speakSequence(referencePlan, {
      onSpeakingChange: (speaking) => events.push(`second:${speaking}`),
    });
    await settle();
    assert.deepEqual(events, ["first:true", "first:false", "second:true"]);
    assert.equal(guards[0](), false, "replacement invalidates the prior player consumer");
    assert.equal(guards[1](), true);

    engine.stopAudio();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["first:true", "first:false", "second:true", "second:false"]);
    assert.equal(guards[1](), false, "direct stop invalidates the active player consumer");

    const third = engine.speakSequence(referencePlan, {
      onSpeakingChange: (speaking) => events.push(`third:${speaking}`),
    });
    await settle();
    assert.deepEqual(events, ["first:true", "first:false", "second:true", "second:false", "third:true"]);
    const finish = activeFinish.current;
    activeFinish.current = null;
    finish?.();
    await third;
    assert.deepEqual(events, [
      "first:true",
      "first:false",
      "second:true",
      "second:false",
      "third:true",
      "third:false",
    ]);
  });
});

test("an interrupted stored sequence stopped during resume never reaches playback", async () => {
  await withDeferredAudioContext(async ({ resumes, release }) => {
    let stops = 0;
    let plays = 0;
    const speaking: boolean[] = [];
    const engine = new VoiceEngine({
      audioPlayer: () => ({
        playReferences: async () => { plays += 1; },
        stop: () => { stops += 1; },
      }),
    });
    const pending = engine.speakSequence(referencePlan, {
      onSpeakingChange: (value) => speaking.push(value),
    });
    await settle();
    assert.equal(resumes(), 1);

    engine.interrupt();
    release();
    await pending;
    assert.equal(plays, 0);
    assert.equal(stops, 2);
    assert.deepEqual(speaking, [], "a pending operation never opens or clears speaking state");
  });
});

test("caller currentness is rechecked after delayed context resume", async () => {
  await withDeferredAudioContext(async ({ release }) => {
    let current = true;
    let plays = 0;
    let stops = 0;
    const speaking: boolean[] = [];
    const engine = new VoiceEngine({
      audioPlayer: () => ({
        playReferences: async () => { plays += 1; },
        stop: () => { stops += 1; },
      }),
    });
    const pending = engine.speakSequence(referencePlan, {
      isCurrent: () => current,
      onSpeakingChange: (value) => speaking.push(value),
    });
    await settle();
    current = false;
    release();
    await pending;

    assert.equal(plays, 0);
    assert.equal(stops, 1);
    assert.deepEqual(speaking, []);
  });
});

test("stored sequence playback normalizes player failures and closes speaking state once", async () => {
  await withTestAudioContext("running", async () => undefined, async () => {
    const speaking: boolean[] = [];
    const engine = new VoiceEngine({
      audioPlayer: () => ({
        playReferences: async () => { throw new Error("vendor-detail"); },
        stop: () => undefined,
      }),
    });

    await assert.rejects(
      engine.speakSequence(referencePlan, { onSpeakingChange: (value) => speaking.push(value) }),
      { message: "Speech audio could not be played." },
    );
    assert.deepEqual(speaking, [true, false]);

    const stopFailure = new VoiceEngine({
      audioPlayer: () => ({
        playReferences: async () => undefined,
        stop: () => { throw new Error("vendor-stop-detail"); },
      }),
    });
    await assert.rejects(stopFailure.speakSequence(referencePlan), {
      message: "Speech audio could not be played.",
    });
  });
});

test("engine starter offer and exact selection need no model, microphone, playback or second retrieval", async () => {
  const h = setup();
  const offered = await h.engine.offerStarters();
  assert.equal(offered.length, 3);
  assert.equal(new Set(offered.map((choice) => choice.topic)).size, 3);
  assert.strictEqual(await h.engine.offerStarters(), offered);
  assert.deepEqual(h.workers, []);
  assert.deepEqual(h.playedPlans, []);
  const picked = h.engine.chooseClarification("synthetic-codecs");
  assert.deepEqual(picked, {
    kind: "answer", cardId: "synthetic-codecs", topic: "Synthetic audio codecs",
    answer: "A synthetic fixture records audio codecs.", matching: "semantic", weak: false,
    sourceRefs: [{ startLine: 1, endLine: 2 }],
  });
  assert.deepEqual(await h.engine.offerStarters(), []);
  assert.deepEqual(h.workers, []);
});

for (const newer of ["question", "dismiss", "close", "reset"] as const) {
  test(`delayed engine starter loading cannot revive an offer after ${newer}`, async () => {
    let release!: (controller: ReturnType<typeof createRetrievalController>) => void;
    const controller = createRetrievalController(syntheticIndex());
    let loads = 0;
    const h = new VoiceEngine({
      loadController: () => { loads += 1; return new Promise((resolve) => { release = resolve; }); },
      audioPlayer: () => ({ playReferences: async () => assert.fail("no playback for topics"), stop() {} }),
    });
    let open = true;
    const offer = h.offerStarters({ isCurrent: () => open });
    let question: Promise<string> | undefined;
    if (newer === "question") question = h.ask("calendar scheduling");
    if (newer === "dismiss") h.dismissStarters();
    if (newer === "close") open = false;
    if (newer === "reset") h.resetConversation();
    release(controller);
    assert.deepEqual(await offer, []);
    await question;
    assert.equal(loads, 1);
    assert.equal(h.chooseClarification("synthetic-ledgers"), null, "stale offer grants no selection authority");
    if (newer === "reset" || newer === "close") {
      assert.equal((await h.offerStarters()).length, 3, "an unchanged reopen or fresh conversation can offer topics");
    } else {
      assert.deepEqual(await h.offerStarters(), []);
    }
  });
}

test("failed starter index loading is safe and leaves the engine model state untouched", async () => {
  const engine = new VoiceEngine({ loadController: async () => { throw new Error("synthetic index unavailable"); } });
  assert.deepEqual(await engine.offerStarters(), []);
  assert.deepEqual(engine.states, { stt: "idle", encoder: "idle" });
});
