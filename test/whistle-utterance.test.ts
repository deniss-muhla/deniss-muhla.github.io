import assert from "node:assert/strict";
import test from "node:test";
import { createWhistleStt } from "../src/chat/stt/whistle/index.ts";
import type { SttWorker } from "../src/chat/stt/whistle/loader.ts";
import type { SttRequest } from "../src/chat/stt/whistle/protocol.ts";

class Worker implements SttWorker {
  sent: SttRequest[] = [];
  listener: (message: unknown) => void = () => {};
  postMessage(message: SttRequest) {
    this.sent.push(message);
    if (message.type === "stop") {
      this.listener({ type: "stopped", json: JSON.stringify({ text: "synthetic tail" }) });
    }
  }
  terminate() {}
  onMessage(listener: (message: unknown) => void) { this.listener = listener; }
  onFailure() {}
}

async function setup() {
  const worker = new Worker();
  let chunk: (samples: Float32Array) => void = () => {};
  const lines: string[] = [];
  let ends = 0;
  const stt = createWhistleStt({
    workerFactory: () => worker,
    captureFactory: async ({ onChunk }) => {
      chunk = onChunk;
      return { async stop() {} };
    },
    onLine: ({ text }) => lines.push(text),
    onUtteranceEnd: () => { ends += 1; },
  });
  const loading = stt.load();
  worker.listener({ type: "ready", loadMs: 1 });
  await loading;
  await stt.start();
  return { worker, stt, chunk, lines, ends: () => ends };
}

const silence = () => new Float32Array(16_000);
const speech = () => new Float32Array(16_000).fill(0.1);
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("silence does not start decoding or create a question", async () => {
  const h = await setup();
  for (let i = 0; i < 10; i += 1) h.chunk(silence());
  assert.equal(h.worker.sent.filter(m => m.type === "chunk").length, 0);
  assert.equal(h.ends(), 0);
  assert.deepEqual(h.lines, []);
  await h.stt.stop();
});

test("the first decode includes speech rather than an isolated quiet pre-roll", async () => {
  const h = await setup();
  h.chunk(silence());
  h.chunk(speech());
  const first = h.worker.sent.find(m => m.type === "chunk");
  assert.equal(first?.type, "chunk");
  assert.equal(first.samples.length, 16_000, "no decoder process call exceeds one project frame");
  assert.ok(first.samples.subarray(0, 3_200).every((sample) => sample === 0), "quiet pre-roll remains first");
  assert.ok(first.samples.subarray(3_200).every((sample) => sample > 0.09), "speech follows the pre-roll in order");
  await h.stt.stop();
  const chunks = h.worker.sent.filter((message) => message.type === "chunk");
  assert.deepEqual(chunks.map((message) => message.type === "chunk" ? message.samples.length : 0), [16_000, 3_200]);
  assert.ok(chunks.every((message) => message.type === "chunk" && message.samples.length <= 16_000));
  if (chunks[1]?.type === "chunk") assert.ok(chunks[1].samples.every((sample) => sample > 0.09), "closing flush preserves the speech remainder");
  assert.equal(h.worker.sent.at(-1)?.type, "stop", "the remainder is delivered before stream close");
});

test("a pause flushes one utterance once and later silence cannot replay it", async () => {
  const h = await setup();
  h.chunk(speech());
  h.worker.listener({ type: "result", json: JSON.stringify({ text: "synthetic", pending: "tail" }) });
  h.chunk(silence());
  await settle();
  for (let i = 0; i < 10; i += 1) h.chunk(silence());
  assert.equal(h.ends(), 1);
  assert.deepEqual(h.lines, ["synthetic", "synthetic tail"]);
  assert.equal(h.worker.sent.filter(m => m.type === "stop").length, 1);
  await h.stt.stop();
  assert.equal(h.ends(), 1, "closing must not publish a second question");
});

test("the same phrase in a later spoken utterance is still accepted", async () => {
  const h = await setup();
  for (let i = 0; i < 2; i += 1) {
    h.chunk(speech());
    h.worker.listener({ type: "result", json: JSON.stringify({ text: "same phrase", pending: "" }) });
    h.chunk(silence());
    await settle();
  }
  assert.equal(h.ends(), 2);
  assert.equal(h.lines.filter(line => line === "same phrase").length, 2);
  await h.stt.stop();
});
