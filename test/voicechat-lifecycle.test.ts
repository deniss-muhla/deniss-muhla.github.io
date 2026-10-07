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
import test from "node:test";

import { VoiceEngine, type Answer } from "../src/chat/engine.ts";
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
  spoken: string[];
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
  const engine = new VoiceEngine({
    loadController: async () => makeController(),
    connection: () => ({ saveData }),
    ...(withWorkerFactory
      ? { workerFactory }
      : { encoder: createRetrievalEncoder({ workerFactory }) }),
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
    speak: true,
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
  assert.deepEqual(harness.spoken, [], "no speech starts after the close");
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
  const engine = new VoiceEngine({
    loadController: () => {
      controllerLoads += 1;
      return new Promise((resolve) => {
        releaseController = () => resolve(createRetrievalController(syntheticIndex()));
      });
    },
    connection: () => ({ saveData: true }),
    encoder: createRetrievalEncoder({ workerFactory }),
  });
  const spoken: string[] = [];
  engine.speak = async (text) => {
    spoken.push(text);
  };

  // The chat's respond path: a revision token the panel close bumps.
  let revision = 0;
  const isCurrent = () => revision === 0;
  const results: Answer[] = [];
  const emissions: string[] = [];

  const pending = engine.ask(QUESTION, {
    speak: true,
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
  assert.deepEqual(spoken, [], "no speech starts after the close");
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
