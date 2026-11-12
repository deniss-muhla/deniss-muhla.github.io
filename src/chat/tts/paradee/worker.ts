import * as ort from "onnxruntime-web";
import { phonemize } from "phonemizer";
import { ORT_WASM_PATHS } from "../../retrieval/encoder/runtime-assets.ts";
import { tokenizeChunks, toMisaki } from "./tokenizer.ts";
import { createLatestQueue } from "./latest-queue.ts";
import { PARADEE_ASSETS, pruneParadeeCaches, readParadeeAsset } from "./assets.ts";

ort.env.wasm.wasmPaths = ORT_WASM_PATHS;
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.logLevel = "fatal";
let model: Promise<{ session: ort.InferenceSession; vocab: Record<string, number> }> | undefined;
function load() {
  model ??= (async () => {
    await pruneParadeeCaches();
    const [configBytes, modelBytes] = await Promise.all(PARADEE_ASSETS.map(readParadeeAsset));
    const config = JSON.parse(new TextDecoder().decode(configBytes)) as { vocab: Record<string, number> };
    const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ["wasm"] });
    return { session, vocab: config.vocab };
  })().catch((error: unknown) => { model = undefined; throw error; });
  return model;
}
const enqueue = createLatestQueue(async ({ id, text }: { id: number; text: string }, isCurrent) => {
  try {
    const { session, vocab } = await load();
    const sentences = text.trim().split(/(?<=[.!?…])\s+|\n+/u).filter(Boolean);
    const audio: Float32Array[] = [];
    for (const sentence of sentences) {
      const raw = (await phonemize(sentence, "en-us")).join(" ");
      for (const ids of tokenizeChunks(toMisaki(raw), vocab)) {
        const output = await session.run({
          input_ids: new ort.Tensor("int64", ids, [1, ids.length]),
          speed: new ort.Tensor("float32", new Float32Array([1]), [1]),
        });
        const samples = output.waveform?.data;
        if (!(samples instanceof Float32Array) || !samples.length || !samples.every(Number.isFinite)) throw new Error("waveform");
        audio.push(samples.slice());
      }
    }
    if (!audio.length) throw new Error("empty");
    const length = audio.reduce((sum, part) => sum + part.length, 0);
    const waveform = new Float32Array(length);
    let offset = 0;
    for (const part of audio) { waveform.set(part, offset); offset += part.length; }
    if (isCurrent()) self.postMessage({ id, waveform }, { transfer: [waveform.buffer] });
  } catch {
    if (isCurrent()) self.postMessage({ id, error: true });
  }
});
self.onmessage = (event: MessageEvent<{ id: number; text?: string; prepare?: boolean }>) => {
  if (event.data.prepare) {
    void load().then(() => self.postMessage({ id: event.data.id, ready: true }), () => self.postMessage({ id: event.data.id, error: true }));
  } else if (typeof event.data.text === "string") enqueue({ id: event.data.id, text: event.data.text });
};
