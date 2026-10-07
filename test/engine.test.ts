/**
 * The engine's answer path behind its existing interface: retrieval selection, one whole
 * answer emission in place of token streaming, identical typed and spoken answers, a speech
 * failure that keeps the text, the turn token that stops an interrupted or closed turn
 * from emitting late, and the storage boundary: whole-answer synthesis units, a probe-backed
 * playback cushion, the labeled eviction notice and the persist ask on the explicit open.
 *
 * Everything is synthetic: the index is the shared fixture, the encoder worker is a double
 * and speech is recorded on the instance, so no model, worker or CV text is involved.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  VoiceEngine,
  TTS_PRIME_SECONDS,
  reportTtsStorageLoad,
  ttsStorageVerdict,
  type Answer,
  type TtsBinding,
} from "../src/chat/engine.ts";
import { MODEL_STORAGE_CLEARED_NOTICE } from "../src/chat/replies.ts";
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
  engine: VoiceEngine;
  workers: FakeWorker[];
  spoken: string[];
}

function setup(): Harness {
  const workers: FakeWorker[] = [];
  const encoder = createRetrievalEncoder({
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  const engine = new VoiceEngine({
    loadController: async () => createRetrievalController(syntheticIndex()),
    encoder,
  });
  const spoken: string[] = [];
  engine.speak = async (text) => {
    spoken.push(text);
  };

  return { engine, workers, spoken };
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

test("typed and spoken asks select the same answer and speech gets the prepared text", async () => {
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

  const spokenResults: Answer[] = [];
  const spokenEmissions: string[] = [];
  const spokenPending = harness.engine.ask(QUESTION, {
    speak: true,
    onResult: (result) => spokenResults.push(result),
    onDelta: (text) => spokenEmissions.push(text),
  });
  const embeds = await waitForEmbeds(harness.workers[0], 2);
  const embed = embeds[1];
  assert.equal(embed.type, "embed");
  if (embed.type !== "embed") return;
  harness.workers[0].emit(vectorMessage(embed.id));
  const spokenAnswer = await spokenPending;

  assert.equal(spokenAnswer, typed, "the same question selects the same prepared answer");
  assert.deepEqual(spokenEmissions, [typed]);
  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0], typed, "speech receives the prepared answer text verbatim");
  assert.ok(!harness.spoken[0].includes(WEAK_MATCH_CUE), "the cue stays outside prepared text");
  assert.equal(
    spokenResults[0].kind === "answer" && spokenResults[0].answer,
    typedResults[0].kind === "answer" && typedResults[0].answer,
  );
  assert.equal(spokenResults[0].kind === "answer" && spokenResults[0].matching, "semantic");
});

test("a speech failure keeps the typed answer and reports the failure", async () => {
  const { engine } = setup();
  engine.speak = async () => {
    throw new Error("speech-unavailable");
  };

  const emissions: string[] = [];
  const failures: Error[] = [];
  const speaking: boolean[] = [];

  const answer = await engine.ask(QUESTION, {
    speak: true,
    onDelta: (text) => emissions.push(text),
    onSpeechError: (error) => failures.push(error),
    onSpeakingChange: (state) => speaking.push(state),
  });

  assert.notEqual(answer, "");
  assert.deepEqual(emissions, [answer], "the answer text reached the chat before speech");
  assert.equal(failures.length, 1);
  assert.deepEqual(speaking, [true, false], "speaking state is closed even when speech fails");
});

test("an interrupt during an in-flight question emits no late answer", async () => {
  const harness = setup();
  await readyEncoder(harness);

  const results: Answer[] = [];
  const emissions: string[] = [];
  let speakingChanges = 0;

  const pending = harness.engine.ask(QUESTION, {
    speak: true,
    onResult: (result) => results.push(result),
    onDelta: (text) => emissions.push(text),
    onSpeakingChange: () => {
      speakingChanges += 1;
    },
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
  assert.equal(speakingChanges, 0);
  assert.deepEqual(harness.spoken, [], "no playback starts after the turn was invalidated");
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
  const engine = new VoiceEngine({
    loadController: () => {
      controllerLoads += 1;
      return new Promise((resolve) => {
        releaseController = () => resolve(createRetrievalController(syntheticIndex()));
      });
    },
    encoder,
  });
  const spoken: string[] = [];
  engine.speak = async (text) => {
    spoken.push(text);
  };

  const results: Answer[] = [];
  const emissions: string[] = [];
  const pending = engine.ask(QUESTION, {
    speak: true,
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
  assert.deepEqual(spoken, [], "no playback starts after the interrupt");
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

/**
 * The speech seam: a fake synth streams fixed chunks through the same callback
 * the vendor worker uses, a fake player records playback, and an AudioContext
 * stub keeps the browser-only resume path inert in node.
 */
interface SpeechState {
  generates: string[];
  played: number[];
  stops: number;
  resets: number;
  flushes: number;
  /** A test replaces the default three-chunk stream to control timing. */
  chunkScript: ((emit: (dur: number) => void) => Promise<void>) | null;
}

function speechHarness(): { state: SpeechState; binding: TtsBinding } {
  const state: SpeechState = {
    generates: [],
    played: [],
    stops: 0,
    resets: 0,
    flushes: 0,
    chunkScript: null,
  };
  const binding: TtsBinding = {
    voice: "test-voice",
    synth: {
      generate: async (text, options) => {
        state.generates.push(text);
        const emit = (dur: number) =>
          options.onChunk(new Float32Array(0), { chunkDuration: dur });
        if (state.chunkScript) await state.chunkScript(emit);
        else {
          emit(0.125);
          emit(0.5);
          emit(0.5);
        }
      },
      stop: async () => {
        state.stops += 1;
      },
    },
    player: {
      play: (_audio, meta) => state.played.push(meta.chunkDuration),
      flush: () => {
        state.flushes += 1;
      },
      reset: () => {
        state.resets += 1;
      },
      resume: async () => undefined,
      underruns: 0,
    },
  };
  return { state, binding };
}

/** node has no AudioContext; the engine's resume path needs the constructor to exist. */
function stubAudioContext(): void {
  const scope = globalThis as { AudioContext?: unknown };
  scope.AudioContext ??= class {
    state = "running";
    resume(): Promise<void> {
      return Promise.resolve();
    }
  };
}

test("speech synthesizes the whole answer as one unit, not per sentence", async () => {
  stubAudioContext();
  const { state, binding } = speechHarness();
  const engine = new VoiceEngine({ tts: async () => binding });

  const answer =
    "First sentence ends here. Second sentence follows it now. Third sentence closes the answer.";
  await engine.speak(answer);

  assert.deepEqual(
    state.generates,
    [answer],
    "one synthesis call speaks the whole answer (sentence-at-a-time calls stalled playback between sentences)",
  );
  assert.equal(state.played.length, 3, "every streamed piece reaches the player");
  assert.equal(state.flushes, 1, "the schedule is flushed once when synthesis ends");
});

test("a word-heavy answer stays one synthesis unit, never per-word calls", async () => {
  stubAudioContext();
  const { state, binding } = speechHarness();
  const engine = new VoiceEngine({ tts: async () => binding });

  const words = Array.from({ length: 40 }, (_, index) => `word${index}`);
  await engine.speak(words.join(" "));

  assert.equal(
    state.generates.length,
    1,
    "a long text must not split into per-word or per-sentence synthesis calls",
  );
  assert.equal(state.generates[0], words.join(" "), "the unit carries the whole answer");
});

test("streamed pieces reach the player as they arrive, in order, before synthesis ends", async () => {
  stubAudioContext();
  const { state, binding } = speechHarness();
  const engine = new VoiceEngine({ tts: async () => binding });

  const playedWhileSynthesizing: number[] = [];
  state.chunkScript = async (emit) => {
    emit(0.3);
    await new Promise((resolve) => setTimeout(resolve, 1));
    playedWhileSynthesizing.push(state.played.length);
    emit(0.4);
    await new Promise((resolve) => setTimeout(resolve, 1));
    playedWhileSynthesizing.push(state.played.length);
    emit(0.5);
  };

  await engine.speak("The queue must advance while synthesis is still running.");

  assert.deepEqual(
    playedWhileSynthesizing,
    [1, 2],
    "each piece plays as it arrives; buffering until the end would starve the schedule again",
  );
  assert.deepEqual(state.played, [0.3, 0.4, 0.5], "arrival order is playback order");
  assert.equal(state.flushes, 1, "one flush closes the schedule after the last piece");
});

test("a turn that ends mid-speech cuts synthesis and playback immediately", async () => {
  stubAudioContext();
  const { state, binding } = speechHarness();
  const engine = new VoiceEngine({ tts: async () => binding });

  let current = true;
  state.chunkScript = async (emit) => {
    emit(0.5); // speech is playing while the turn is current
    current = false; // the user takes the turn back
    emit(0.5); // the worker keeps streaming after that
    emit(0.5);
  };

  await engine.speak("Anything spoken for this turn.", { isCurrent: () => current });

  assert.equal(state.played.length, 1, "pieces after the turn ended never reach playback");
  assert.ok(state.stops >= 2, "synthesis is stopped again when the turn dies mid-speech");
  assert.ok(state.resets >= 2, "already scheduled audio is cut when the turn dies mid-speech");
  assert.equal(state.flushes, 0, "a dead turn gets no flush");
});

test("the playback cushion holds the probe-supported runway", () => {
  // Vendor default is 0.4 s; the probe replay showed a thin cushion (0.25 s) let
  // gaps up to 651 ms through, which restarts speech mid-word. 1.0 s held the
  // same timeline's gaps to 240 ms, so that is the shipped floor.
  assert.ok(TTS_PRIME_SECONDS >= 1.0, `prime is ${TTS_PRIME_SECONDS}s`);
});

test("a warm cache that needs a network fetch is classified as cleared", () => {
  assert.equal(
    ttsStorageVerdict("1", { cacheHit: false, networkFetch: true }),
    "cleared",
    "marker plus network fetch: the browser dropped the cached model",
  );
  assert.equal(ttsStorageVerdict("1", { cacheHit: true, networkFetch: false }), "warm");
  assert.equal(
    ttsStorageVerdict(null, { cacheHit: false, networkFetch: true }),
    "first-visit",
    "without the marker a fetch is the first visit, not an eviction",
  );
  assert.equal(ttsStorageVerdict(null, { cacheHit: true, networkFetch: false }), "warm");
});

test("a restart that misses the warm cache reports the labeled recovery notice", () => {
  const notices: string[] = [];

  const verdict = reportTtsStorageLoad("1", { cacheHit: false, networkFetch: true }, (text) =>
    notices.push(text),
  );

  assert.equal(verdict, "cleared");
  assert.deepEqual(
    notices,
    [MODEL_STORAGE_CLEARED_NOTICE],
    "an evicted model reaches the panel as the labeled notice, not a silent reload",
  );
});

test("a first visit or a warm reload raises no eviction notice", () => {
  const notices: string[] = [];

  reportTtsStorageLoad(null, { cacheHit: false, networkFetch: true }, (text) => notices.push(text));
  reportTtsStorageLoad("1", { cacheHit: true, networkFetch: false }, (text) => notices.push(text));

  assert.deepEqual(notices, [], "only a warm marker plus a cache miss is an eviction");
});
