import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createUtteranceGate } from "../src/chat/stt/whistle/utterance.ts";

import { MODEL_ASSET_SETS, modelAssetFiles } from "../scripts/model-assets.mjs";
import {
  WHISTLE_ASSET_BYTES,
  WHISTLE_DOWNLOAD_TOTAL,
  WHISTLE_MODEL_ROUTE,
  WHISTLE_RUNTIME_ROUTE,
  WHISTLE_WASM_ROUTE,
} from "../src/chat/stt/whistle/assets.ts";
import { createChunkBuffer } from "../src/chat/stt/whistle/chunk.ts";
import { createWhistleStt } from "../src/chat/stt/whistle/index.ts";
import type { SttWorker } from "../src/chat/stt/whistle/loader.ts";
import type { SttRequest } from "../src/chat/stt/whistle/protocol.ts";

test("STT debug diagnostics do not forward raw capture or vendor details", async () => {
  const sourcePath = process.env.VOICECHAT_STT_SOURCE_OVERRIDE
    ? new URL(process.env.VOICECHAT_STT_SOURCE_OVERRIDE, import.meta.url)
    : new URL("../src/chat/stt/whistle/index.ts", import.meta.url);
  const source = await readFile(sourcePath, "utf8");
  const rawPayloadTrace = /trace\(\s*["']stt (?:capture detail|error detail)["']\s*,/.test(source);
  assert.equal(rawPayloadTrace, false, "STT lifecycle traces never include raw exception payloads");
});

class FakeWorker implements SttWorker {
  readonly sent: SttRequest[] = [];
  private messageListener: (value: unknown) => void = () => undefined;
  private failureListener: () => void = () => undefined;
  private readonly onSend: (message: SttRequest) => void;

  constructor(onSend: (message: SttRequest) => void = () => undefined) {
    this.onSend = onSend;
  }

  postMessage(message: SttRequest, transfer?: Transferable[]): void {
    const copy = transfer?.length ? structuredClone(message, { transfer }) : structuredClone(message);
    this.sent.push(copy);
    this.onSend(copy);
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

async function loadStt(worker: FakeWorker, options: Parameters<typeof createWhistleStt>[0] = {}) {
  const stt = createWhistleStt({ workerFactory: () => worker, ...options });
  const loading = stt.load();
  assert.equal(worker.sent[0]?.type, "load");
  worker.emit({ type: "ready", loadMs: 1 });
  await loading;
  return stt;
}

test("maps committed deltas and pending text, then consumes the stop tail", async () => {
  const worker = new FakeWorker();
  const lines: { text: string }[] = [];
  const textUpdates: string[] = [];
  const events: string[] = [];
  let captureChunk: ((samples: Float32Array) => void) | undefined;
  const stt = await loadStt(worker, {
    captureFactory: async ({ onChunk }) => {
      captureChunk = onChunk;
      return {
        async stop() {
          onChunk(Float32Array.of(0.25));
        },
      };
    },
    onLine: (line) => {
      lines.push(line);
      events.push(`line:${line.text}`);
    },
    onText: (text) => {
      textUpdates.push(text);
      events.push(`text:${text}`);
    },
  });

  await stt.start();
  assert.equal(worker.sent.at(-1)?.type, "start");

  const samples = new Float32Array(16_000).fill(0.1);
  captureChunk?.(samples);
  const sentChunk = worker.sent.at(-1);
  assert.equal(sentChunk?.type, "chunk");
  if (sentChunk?.type === "chunk") assert.deepEqual(sentChunk.samples, samples);

  worker.emit({
    type: "result",
    json: JSON.stringify({ text: "I worked at If P&C", pending: "before Stream Labs" }),
  });
  worker.emit({
    type: "result",
    json: JSON.stringify({ text: "Stream Labs", pending: "for seven years" }),
  });

  assert.deepEqual(lines, [{ text: "I worked at If P&C" }, { text: "Stream Labs" }]);
  assert.deepEqual(textUpdates, ["before Stream Labs", "for seven years"]);
  assert.deepEqual(events, [
    "line:I worked at If P&C",
    "text:before Stream Labs",
    "line:Stream Labs",
    "text:for seven years",
  ]);

  const stopping = stt.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    worker.sent.slice(-2).map((message) => message.type),
    ["chunk", "stop"],
    "capture flush reaches the worker before the stream stops",
  );

  worker.emit({
    type: "stopped",
    json: JSON.stringify({ text: "uncommitted stop tail", pending: "discard this turn" }),
  });
  await stopping;
  assert.equal(lines.length, 2, "the stop flush must not create a phantom committed line");
  assert.equal(textUpdates.length, 2, "the stop flush must not restore discarded interim text");
});

test("ignores results while closing and accepts results after a settled reopen", async () => {
  const worker = new FakeWorker();
  const events: string[] = [];
  let captureStarts = 0;
  const stt = await loadStt(worker, {
    captureFactory: async ({ onChunk }) => {
      const thisCapture = captureStarts++;
      return {
        async stop() {
          if (thisCapture !== 0) return;
          onChunk(Float32Array.of(0.25));
          worker.emit({
            type: "result",
            json: JSON.stringify({ text: "closing line", pending: "closing tail" }),
          });
        },
      };
    },
    onLine: ({ text }) => events.push(`line:${text}`),
    onText: (text) => events.push(`text:${text}`),
  });

  await stt.start();
  worker.emit({
    type: "result",
    json: JSON.stringify({ text: "active line", pending: "active tail" }),
  });
  assert.deepEqual(events, ["line:active line", "text:active tail"]);

  const stopping = stt.stop();
  const reopening = stt.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(captureStarts, 1, "reopen waits for the previous worker stop response");
  assert.equal(worker.sent.at(-1)?.type, "stop");

  worker.emit({
    type: "result",
    json: JSON.stringify({ text: "late closing line", pending: "late closing tail" }),
  });
  assert.deepEqual(events, ["line:active line", "text:active tail"]);

  worker.emit({ type: "stopped", json: "" });
  await stopping;
  await reopening;
  assert.equal(captureStarts, 2);
  assert.equal(worker.sent.at(-1)?.type, "start");

  worker.emit({
    type: "result",
    json: JSON.stringify({ text: "new line", pending: "new tail" }),
  });
  assert.deepEqual(events, [
    "line:active line",
    "text:active tail",
    "line:new line",
    "text:new tail",
  ]);
});

test("bounds onset pre-roll and preserves every sample before delayed utterance stops", async () => {
  const worker = new FakeWorker();
  let deliver: ((samples: Float32Array) => void) | undefined;

  let utteranceEnds = 0;
  const stt = await loadStt(worker, {
    captureFactory: async ({ onChunk }) => {
      deliver = onChunk;
      return { async stop() {} };
    },
    onUtteranceEnd: () => {
      utteranceEnds += 1;

    },
  });

  const makeVoice = (base: number) => Float32Array.from({ length: 16_000 }, (_, index) => base + (index % 257) / 10_000);
  const makePreRoll = (base: number) => Float32Array.from({ length: 3_200 }, (_, index) => base + (index % 47) / 100_000);
  const quiet = () => new Float32Array(16_000).fill(0.001);
  const join = (...parts: Float32Array[]) => {
    const result = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  };
  const assertConserved = (actual: Float32Array, expected: Float32Array, label: string) => {
    assert.equal(actual.length, expected.length, `${label} sample count`);
    for (let index = 0; index < expected.length; index += 1) {
      if (actual[index] !== expected[index]) assert.fail(`${label} sample order mismatch at ${index}`);
    }
  };
  const voiceOne = makeVoice(0.05);
  const preRollOne = makePreRoll(-0.003);
  const quietOne = quiet();
  const voiceTwo = makeVoice(0.15);
  const preRollTwo = makePreRoll(-0.006);
  const quietTwo = quiet();
  const expectedOne = join(preRollOne, voiceOne, quietOne);
  const expectedTwo = join(preRollTwo, voiceTwo, quietTwo);
  await stt.start();
  const send = deliver;
  assert.ok(send);

  send(preRollOne);
  send(voiceOne);
  send(quietOne);
  const commandsAfterFirst = worker.sent.filter((message) => message.type !== "load");
  const firstStopIndex = commandsAfterFirst.findIndex((message) => message.type === "stop");
  assert.ok(firstStopIndex >= 0, "quiet end requests stop");
  const firstSession = commandsAfterFirst.slice(0, firstStopIndex + 1);
  const startsBeforeSecondUtterance = firstSession.filter((message) => message.type === "start").length;
  assert.ok(startsBeforeSecondUtterance >= 1);
  const firstChunks = firstSession.filter((message) => message.type === "chunk");
  assert.ok(firstChunks.every((message) => message.type === "chunk" && message.samples.length <= 16_000));
  assert.deepEqual(firstChunks.map((message) => message.type === "chunk" ? message.samples.length : 0), [16_000, 16_000, 3_200]);
  assert.equal(firstSession.at(-1)?.type, "stop", "all remainder is flushed before the first stop");
  assertConserved(join(...firstChunks.map((message) => message.type === "chunk" ? message.samples : new Float32Array(0))), expectedOne, "first utterance");

  send(preRollTwo);
  send(voiceTwo);
  send(quietTwo);
  assert.equal(worker.sent.filter((message) => message.type === "start").length, startsBeforeSecondUtterance, "next start waits for prior stop reply");
  worker.emit({ type: "stopped", json: "" });
  assert.equal(utteranceEnds, 0, "superseded prior decoder end is discarded");
  await new Promise<void>((resolve) => setImmediate(resolve));

  const commands = worker.sent.filter((message) => message.type !== "load");
  const stopIndices = commands.flatMap((message, index) => message.type === "stop" ? [index] : []);
  const secondStartIndex = commands.findIndex((message, index) => index > stopIndices[0]! && message.type === "start");
  const secondStopIndex = commands.findIndex((message, index) => index > secondStartIndex && message.type === "stop");
  assert.ok(secondStartIndex > stopIndices[0]!);
  assert.ok(secondStopIndex > secondStartIndex);
  const secondSession = commands.slice(secondStartIndex, secondStopIndex + 1);
  const secondChunks = secondSession.filter((message) => message.type === "chunk");
  assert.ok(secondChunks.every((message) => message.type === "chunk" && message.samples.length <= 16_000));
  assert.deepEqual(secondChunks.map((message) => message.type === "chunk" ? message.samples.length : 0), [16_000, 16_000, 3_200]);
  assert.equal(secondSession.at(-1)?.type, "stop");
  assertConserved(join(...secondChunks.map((message) => message.type === "chunk" ? message.samples : new Float32Array(0))), expectedTwo, "second utterance has no prior remainder");

  worker.emit({ type: "stopped", json: "" });
  assert.equal(utteranceEnds, 1, "current decoder end still commits");
  const closing = stt.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(worker.sent.at(-1)?.type, "stop");
  worker.emit({ type: "stopped", json: JSON.stringify({ text: "discarded close generation", pending: "discarded tail" }) });
  await closing;
});

test("reloads a worker that fails during stop before reopening capture", async () => {
  const events: string[] = [];
  const workers: FakeWorker[] = [];
  const lines: string[] = [];
  let captures = 0;
  const stt = createWhistleStt({
    workerFactory: () => {
      const number = workers.length + 1;
      const worker = new FakeWorker((message) => events.push(`worker:${number}:${message.type}`));
      workers.push(worker);
      return worker;
    },
    captureFactory: async () => {
      captures += 1;
      events.push(`capture:${captures}`);
      return { async stop() {} };
    },
    onLine: ({ text }) => lines.push(text),
  });

  const loading = stt.load();
  const first = workers[0];
  assert.ok(first);
  assert.equal(first.sent[0]?.type, "load");
  events.push("worker:1:ready");
  first.emit({ type: "ready", loadMs: 1 });
  await loading;
  await stt.start();

  const stopping = stt.stop();
  const reopening = stt.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(first.sent.at(-1)?.type, "stop");
  assert.equal(captures, 1, "reopen waits for the current stop");

  first.fail();
  await stopping;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(workers.length, 2, "worker failure creates a fresh worker");
  const replacement = workers[1];
  assert.ok(replacement);
  assert.notEqual(replacement, first);
  assert.equal(replacement.sent[0]?.type, "load");
  assert.equal(captures, 1, "capture stays closed until the replacement is ready");
  assert.equal(replacement.sent.some((message) => message.type === "start"), false);

  events.push("worker:2:ready");
  replacement.emit({ type: "ready", loadMs: 1 });
  await reopening;
  assert.deepEqual(events.slice(-4), [
    "worker:2:load",
    "worker:2:ready",
    "worker:2:start",
    "capture:2",
  ]);
  assert.deepEqual(replacement.sent.map((message) => message.type), ["load", "start"]);

  replacement.emit({
    type: "result",
    json: JSON.stringify({ text: "fresh worker line", pending: "fresh tail" }),
  });
  assert.deepEqual(lines, ["fresh worker line"]);
});

test("stops capture that resolves after worker failure during startup", async () => {
  const worker = new FakeWorker();
  const events: string[] = [];
  let resolveCapture!: (capture: { stop(): Promise<void> }) => void;
  let signalCaptureRequested!: () => void;
  const captureRequested = new Promise<void>((resolve) => {
    signalCaptureRequested = resolve;
  });
  let captureStops = 0;
  const stt = await loadStt(worker, {
    captureFactory: () => new Promise((resolve) => {
      resolveCapture = resolve;
      signalCaptureRequested();
    }),
    onLine: ({ text }) => events.push(`line:${text}`),
    onText: (text) => events.push(`text:${text}`),
  });

  const starting = stt.start();
  await captureRequested;
  assert.equal(worker.sent.at(-1)?.type, "start");

  worker.fail();
  worker.emit({
    type: "result",
    json: JSON.stringify({ text: "failed startup line", pending: "failed startup tail" }),
  });
  resolveCapture({
    async stop() {
      captureStops += 1;
    },
  });
  await starting;

  assert.equal(captureStops, 1, "the late microphone must be stopped");
  worker.emit({
    type: "result",
    json: JSON.stringify({ text: "late line", pending: "late tail" }),
  });
  assert.deepEqual(events, [], "worker results remain suppressed after startup failure");
});

test("keeps microphone and worker errors safe for the visitor", async () => {
  const worker = new FakeWorker();
  const errors: Error[] = [];
  const stt = await loadStt(worker, {
    captureFactory: async () => {
      throw Object.assign(new Error("private device detail"), { name: "NotAllowedError" });
    },
    onError: (error) => errors.push(error),
  });

  await assert.rejects(stt.start(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Microphone permission was denied.");
    assert.doesNotMatch(error.message, /private device detail/);
    return true;
  });

  worker.emit({ type: "error", code: "transcribe-failed", detail: "private engine traceback" });
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.message, "Speech recognition stopped: transcription failed.");
  assert.doesNotMatch(errors[0]?.message ?? "", /private engine traceback/);
});

test("resamples fragmented 48 kHz input into bounded 20 ms 16 kHz capture frames", () => {
  const buffer = createChunkBuffer(48_000, 16_000);
  const input = new Float32Array(72_000).fill(0.25);
  const chunks = [
    ...buffer.push(input.subarray(0, 15_001)),
    ...buffer.push(input.subarray(15_001, 35_004)),
    ...buffer.push(input.subarray(35_004)),
  ];
  const tail = buffer.flush();

  assert.equal(chunks.length, 75);
  assert.ok(chunks.every((chunk) => chunk.length === 320));
  assert.equal(tail, null);
  assert.equal(chunks[0]?.[0], 0.25);
  assert.equal(chunks.at(-1)?.at(-1), 0.25);
  assert.equal(buffer.flush(), null);
});

test("acoustic onset is immediate before a pending stop reply while capture continues", async () => {
  const worker = new FakeWorker();
  const events: string[] = [];
  let deliver: ((samples: Float32Array) => void) | undefined;
  let captureStops = 0;
  const stt = await loadStt(worker, {
    captureFactory: async ({ onChunk }) => {
      deliver = onChunk;
      return { async stop() { captureStops += 1; } };
    },
    onUtteranceStart: () => events.push("onset"),
    onLine: ({ text }) => events.push(`line:${text}`),
    onText: (text) => events.push(`text:${text}`),
    onUtteranceEnd: () => events.push("end"),
  });
  await stt.start();
  assert.ok(deliver);
  const send = deliver;
  const voiceFrame = new Float32Array(320).fill(0.1);
  const quietFrame = new Float32Array(320).fill(0.001);

  for (let index = 0; index < 4; index += 1) send(voiceFrame);
  assert.deepEqual(events, ["onset"], "80 ms gate onset reaches the handler before transcript text");
  assert.equal(captureStops, 0, "onset does not stop the microphone");

  for (let index = 0; index < 50; index += 1) send(quietFrame);
  assert.equal(worker.sent.at(-1)?.type, "stop", "the first quiet end is waiting for its decoder reply");
  const startsBeforeNextOnset = worker.sent.filter((message) => message.type === "start").length;
  for (let index = 0; index < 4; index += 1) send(voiceFrame);
  assert.deepEqual(events, ["onset", "onset"], "the next onset is reported outside the queued stop drain");
  assert.equal(worker.sent.filter((message) => message.type === "start").length, startsBeforeNextOnset, "decoder restart still waits for stop acknowledgement");
  assert.equal(captureStops, 0, "capture continues while decoder work is serialized");

  worker.emit({ type: "stopped", json: JSON.stringify({ text: "previous utterance tail", pending: "" }) });
  assert.deepEqual(events, ["onset", "onset"], "obsolete prior tail/end cannot restart output after a newer onset");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(worker.sent.filter((message) => message.type === "start").length, startsBeforeNextOnset + 1, "queued capture starts after stop reply");

  const closing = stt.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));
  worker.emit({ type: "stopped", json: "" });
  await closing;
  assert.equal(captureStops, 1, "only explicit close stops capture");
  const onsetCountAfterClose = events.filter((event) => event === "onset").length;
  send(voiceFrame);
  assert.equal(events.filter((event) => event === "onset").length, onsetCountAfterClose, "a stale stopped stream cannot publish onset");
});

test("Whistle adapter routes and byte counts match the pinned Apache-2.0 manifest", () => {
  const whistleSets = MODEL_ASSET_SETS.filter(
    (set) => set.id === "cactus-needle-wasm" || set.id === "cactus-whistle-en",
  );
  assert.deepEqual(
    whistleSets.map((set) => set.license),
    ["Apache-2.0", "Apache-2.0"],
  );

  const actual = modelAssetFiles()
    .filter((file) => file.set === "cactus-needle-wasm" || file.set === "cactus-whistle-en")
    .map(({ route, name, bytes, sha256, source, license }) => {
      assert.ok(sha256);
      assert.match(sha256, /^[a-f0-9]{64}$/);
      assert.ok(source);
      assert.match(source, /Cactus-Compute/);
      return { route, name, bytes, license };
    })
    .sort((left, right) => left.route.localeCompare(right.route));
  const expected = [
    { route: WHISTLE_RUNTIME_ROUTE, name: "needle.js", bytes: WHISTLE_ASSET_BYTES.runtime, license: "Apache-2.0" },
    { route: WHISTLE_WASM_ROUTE, name: "needle.wasm", bytes: WHISTLE_ASSET_BYTES.wasm, license: "Apache-2.0" },
    { route: WHISTLE_MODEL_ROUTE, name: "whistle.cact", bytes: WHISTLE_ASSET_BYTES.model, license: "Apache-2.0" },
  ].sort((left, right) => left.route.localeCompare(right.route));

  assert.deepEqual(actual, expected);
  assert.equal(
    WHISTLE_DOWNLOAD_TOTAL,
    WHISTLE_ASSET_BYTES.runtime + WHISTLE_ASSET_BYTES.wasm + WHISTLE_ASSET_BYTES.model,
  );
});

test("a prior delayed decoder end cannot restart output after a newer acoustic onset", async () => {
  const worker = new FakeWorker();
  let send!: (samples: Float32Array) => void;
  let captureStops = 0;
  let ends = 0;
  const lines: string[] = [];
  const stt = await loadStt(worker, {
    captureFactory: async ({ onChunk }) => { send = onChunk; return { async stop() { captureStops++; } }; },
    onLine: ({ text }) => lines.push(text),
    onUtteranceEnd: () => { ends++; },
  });
  await stt.start();
  send(new Float32Array(1280).fill(0.1));
  send(new Float32Array(16000));
  send(new Float32Array(1280).fill(0.2));
  worker.emit({ type: "result", json: JSON.stringify({ text: "old delayed line" }) });
  worker.emit({ type: "stopped", json: JSON.stringify({ text: "old delayed tail" }) });
  await new Promise<void>((r) => setImmediate(r));
  assert.deepEqual(lines, [], "obsolete decoder text cannot commit a new answer over current speech");
  assert.equal(ends, 0, "obsolete decoder end cannot restart old output");
  assert.equal(captureStops, 0, "current question stays captured");
  worker.emit({ type: "result", json: JSON.stringify({ text: "current question" }) });
  send(new Float32Array(16000));
  worker.emit({ type: "stopped", json: "" });
  await new Promise<void>((r) => setImmediate(r));
  assert.deepEqual(lines, ["current question"]);
  assert.equal(ends, 1, "current question still commits normally");
  const closing = stt.stop();
  await new Promise<void>((r) => setImmediate(r));
  worker.emit({ type: "stopped", json: "" }); await closing;
});

test("the capture worklet emits 20 ms frames and conserves a flushed partial tail", async () => {
  const source = await readFile(new URL("../src/chat/stt/whistle/capture-processor.js", import.meta.url), "utf8");
  const messages: unknown[] = [];
  type CaptureProcessor = new () => {
    port: { onmessage: ((event: { data: unknown }) => void) | null };
    process(inputs: Float32Array[][]): boolean;
  };
  const registered: { current: CaptureProcessor | null } = { current: null };
  class WorkletBase {
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage(data: unknown) { messages.push(data); },
    };
  }
  runInNewContext(source, {
    AudioWorkletProcessor: WorkletBase,
    sampleRate: 16_000,
    registerProcessor: (_name: string, processor: unknown) => { registered.current = processor as CaptureProcessor; },
  });
  const RegisteredProcessor = registered.current;
  assert.ok(RegisteredProcessor);
  const processor = new RegisteredProcessor();
  const first = Float32Array.from({ length: 960 }, (_, index) => index / 1000);
  processor.process([[first]]);
  assert.deepEqual(messages.map((item) => (item as Float32Array).length), [320, 320, 320]);
  assert.deepEqual(
    Array.from(messages.flatMap((item) => Array.from(item as Float32Array))),
    Array.from(first),
    "worklet frames preserve sample order without loss",
  );

  messages.length = 0;
  const tail = Float32Array.from({ length: 97 }, (_, index) => -index / 1000);
  processor.process([[tail]]);
  processor.port.onmessage?.({ data: "flush" });
  assert.deepEqual(messages.map((item) => ArrayBuffer.isView(item) ? (item as Float32Array).length : (item as { type: string }).type), [97, "flushed"]);
  assert.deepEqual(Array.from(messages[0] as Float32Array), Array.from(tail));
});

test("fragmented resampling emits bounded 20 ms frames and conserves same-rate tail samples", () => {
  const sameRate = createChunkBuffer(16_000, 16_000);
  const exact = Float32Array.from({ length: 973 }, (_, index) => index / 1000);
  const exactFrames = [
    ...sameRate.push(exact.subarray(0, 117)),
    ...sameRate.push(exact.subarray(117, 691)),
    ...sameRate.push(exact.subarray(691)),
  ];
  const exactTail = sameRate.flush();
  assert.ok(exactFrames.every((frame) => frame.length === 320));
  assert.equal(exactTail?.length, 13);
  assert.deepEqual(Array.from([...exactFrames, exactTail!].flatMap((frame) => Array.from(frame))), Array.from(exact));

  const resampled = createChunkBuffer(48_000, 16_000);
  const input = new Float32Array(48_009).fill(0.25);
  const output = [
    ...resampled.push(input.subarray(0, 15_001)),
    ...resampled.push(input.subarray(15_001, 35_004)),
    ...resampled.push(input.subarray(35_004)),
  ];
  const tail = resampled.flush();
  assert.ok(output.length > 0);
  assert.ok(output.every((frame) => frame.length === 320));
  assert.equal(tail?.length, 3);
  assert.equal(output.reduce((sum, frame) => sum + frame.length, 0) + (tail?.length ?? 0), 16_003);
  assert.ok([...output, tail!].every((frame) => frame.every((sample) => sample === 0.25)));
});

test("the existing onset gate still admits only after 80 ms of voiced frames", () => {
  const gate = createUtteranceGate();
  const frame = new Float32Array(320).fill(0.1);
  for (let index = 0; index < 3; index += 1) {
    assert.equal(gate.push(frame).some((event) => event.type === "start"), false);
  }
  assert.equal(gate.push(frame).some((event) => event.type === "start"), true);
});

for (const variant of ["continued", "quiet", "stalled", "obsolete", "late-frame", "delayed-timer"] as const) {
  test(`200ms playback admission: ${variant}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const worker = new FakeWorker();
    let send!: (samples: Float32Array) => void;
    let starts = 0;
    let pauses = 0;
    let resumes = 0;
    let valid = true;
    const pause = { ready: Promise.resolve(), isCurrent: () => valid, outcome: () => valid ? "active" as const : "cancelled" as const, resume: async () => { resumes++; valid = false; } };
    const stt = await loadStt(worker, {
      captureFactory: async ({ onChunk }) => { send = onChunk; return { async stop() {} }; },
      onUtteranceStart: () => { starts++; },
      onPlaybackOnset: () => { pauses++; return pause; },
    });
    await stt.start();
    const frames: Float32Array[] = [];
    const deliver = (value: number) => { const f = new Float32Array(320).fill(value); frames.push(f); send(f); };
    for (let i = 0; i < 4; i++) deliver(0.1);
    assert.equal(pauses, 1, "native playing proof triggers immediate tentative pause");
    assert.equal(starts, 0, "tentative onset does not cancel original answer work");
    assert.equal(worker.sent.some(m => m.type === "chunk"), false, "no tentative data is decoded");
    t.mock.timers.tick(variant === "late-frame" ? 179 : 180);
    if (variant !== "stalled") deliver(variant === "quiet" ? 0 : 0.2);
    if (variant === "obsolete") valid = false;
    t.mock.timers.tick(variant === "delayed-timer" ? 100 : variant === "late-frame" ? 21 : 20);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.equal(starts, variant === "continued" ? 1 : 0);
    assert.equal(resumes, ["quiet", "stalled", "late-frame", "delayed-timer"].includes(variant) ? 1 : 0);
    if (variant === "continued") {
      // Complete the unchanged one-second quiet end to flush all admitted samples.
      for (let i = 0; i < 50; i++) deliver(0);
      const decoded = worker.sent.flatMap(m => m.type === "chunk" ? [...m.samples] : []);
      assert.deepEqual(decoded, frames.flatMap(f => [...f]), "confirmed prefix reaches STT exactly once in order");
      assert.ok(worker.sent.every(m => m.type !== "chunk" || m.samples.length <= 16000));
      worker.emit({ type: "stopped", json: "" }); await Promise.resolve();
    } else assert.equal(worker.sent.some(m => m.type === "chunk"), false);
    const closing = stt.stop();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    worker.emit({ type: "stopped", json: "" }); await closing;
  });
}

test("a new utterance during delayed rejected-burst resume is not lost", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const worker = new FakeWorker();
  let send!: (samples: Float32Array) => void;
  let release!: () => void;
  let starts = 0;
  let playing = true;
  let valid = true;
  const pause = { ready: Promise.resolve(), isCurrent: () => valid, outcome: () => valid ? "active" as const : "cancelled" as const,
    resume: () => new Promise<void>(resolve => { release = resolve; }) };
  const stt = await loadStt(worker, {
    captureFactory: async ({ onChunk }) => { send = onChunk; return { async stop() {} }; },
    onPlaybackOnset: () => { if (!playing) return null; playing = false; return pause; },
    onUtteranceStart: () => { starts++; valid = false; },
  });
  await stt.start();
  for (let i = 0; i < 4; i++) send(new Float32Array(320).fill(0.1));
  t.mock.timers.tick(180); send(new Float32Array(320)); t.mock.timers.tick(20);
  await Promise.resolve(); await Promise.resolve();
  assert.ok(release, "the native resume is pending");
  const prefix = new Float32Array(1280).fill(0.2);
  send(prefix);
  assert.equal(starts, 1, "outside playing output the new onset is immediate");
  release(); await Promise.resolve(); await Promise.resolve();
  const quiet = new Float32Array(16000); send(quiet);
  const decoded = worker.sent.flatMap(m => m.type === "chunk" ? [...m.samples] : []);
  assert.deepEqual(decoded, [...prefix, ...quiet], "only the new question reaches STT once");
  worker.emit({ type: "stopped", json: "" }); await Promise.resolve();
  const closing = stt.stop(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  worker.emit({ type: "stopped", json: "" }); await closing;
});

import { createPlaybackAdmission } from "../src/chat/stt/whistle/continuation.ts";

test("final natural end retains confirmed prefix while native pause readiness is pending", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let resolve!: () => void;
  let ended = false;
  let starts = 0;
  const delivered: number[] = [];
  const pause = { ready: new Promise<void>(r => { resolve = r; }), isCurrent: () => !ended,
    outcome: () => ended ? "ended" as const : "active" as const, resume: async () => assert.fail("finished output must not resume") };
  const admission = createPlaybackAdmission({ isCurrent: () => true, pausePlaying: () => pause,
    onOnset() {}, onAdmittedStart: () => { starts++; }, onError: () => assert.fail("natural end is not failure"),
    deliver: events => { for (const e of events) if (e.type === "chunk") delivered.push(...e.samples); },
  });
  const expected: number[] = [];
  const send = (value: number) => { const f = new Float32Array(320).fill(value); expected.push(...f); admission.push(f); };
  for (let i = 0; i < 4; i++) send(0.1);
  ended = true;
  t.mock.timers.tick(180); send(0.2); t.mock.timers.tick(20);
  await Promise.resolve();
  assert.equal(starts, 0, "decision retains samples while suspend remains pending");
  send(0.3); resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(starts, 1);
  assert.deepEqual(delivered, expected, "natural final end never drops confirmed captured prefix");
});

for (const cancelled of [false, true]) {
  test(`rejected native resume failure is ${cancelled ? "obsolete and silent" : "reported as playback"}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    let reject!: () => void;
    let obsolete = false;
    let failed = false;
    let notices = 0;
    const pause = { ready: Promise.resolve(), isCurrent: () => !obsolete,
      outcome: () => obsolete ? "cancelled" as const : failed ? "failed" as const : "active" as const,
      resume: () => new Promise<void>((_r, fail) => { reject = () => { failed = true; fail(new Error("private-native-detail")); }; }) };
    const admission = createPlaybackAdmission({ isCurrent: () => true, pausePlaying: () => pause,
      onOnset() {}, onAdmittedStart: () => assert.fail("quiet candidate not admitted"), deliver() {}, onError: () => { notices++; } });
    for (let i = 0; i < 4; i++) admission.push(new Float32Array(320).fill(0.1));
    t.mock.timers.tick(180); admission.push(new Float32Array(320)); t.mock.timers.tick(20);
    await Promise.resolve(); await Promise.resolve();
    assert.ok(reject); obsolete = cancelled; reject(); await Promise.resolve(); await Promise.resolve();
    assert.equal(notices, cancelled ? 0 : 1);
  });
}
