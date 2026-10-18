import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, createContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { transformWithOxc } from "vite";

const workerUrl = new URL("../src/chat/stt/whistle/worker.ts", import.meta.url);
const workerFilename = fileURLToPath(workerUrl);

async function loadWorker(modelResult: number): Promise<{ type: string; code?: string }> {
  const source = await readFile(workerUrl, "utf8");
  const { code } = await transformWithOxc(source, workerFilename, {
    lang: "ts",
  });
  let receive: ((event: { data: unknown }) => void) | undefined;
  let finish: (value: { type: string; code?: string }) => void = () => {};
  const done = new Promise<{ type: string; code?: string }>((resolve) => { finish = resolve; });
  const heap = new Uint8Array(1024);
  let freed = false;
  const context = createContext({
    self: {
      addEventListener(_type: string, listener: typeof receive) { receive = listener; },
      postMessage(message: { type: string; code?: string }) {
        if (message.type === "ready" || message.type === "error") finish(message);
      },
    },
    caches: { async open() { return { async match() { return new Response(new Uint8Array([1, 2, 3])); } }; } },
    performance,
    Blob,
    URL,
    Response,
    importScripts() {},
    async createNeedle() {
      return {
        HEAPU8: heap,
        _malloc() { return 8; },
        _free() { freed = true; },
        ccall(name: string) {
          if (name === "needle_load") return modelResult;
          if (name === "needle_last_error") return "synthetic load failure";
          throw new Error("unexpected-call");
        },
      };
    },
  });
  new Script(code, { filename: workerFilename }).runInContext(context);
  assert.ok(receive);
  receive({ data: {
    type: "load", runtimeUrl: "/runtime", wasmUrl: "/wasm", modelUrl: "/model",
    language: "en", keywords: "",
  } });
  const result = await done;
  assert.equal(freed, true);
  return result;
}

// The pinned header states that only negative returns fail:
// https://huggingface.co/Cactus-Compute/needle3/raw/2ae11323dc000f5e70c49f7403efa6af12ba9e67/wasm/needle.h
test("Whistle worker accepts a successful speech-model load", { timeout: 2000 }, async () => {
  assert.equal((await loadWorker(0)).type, "ready");
  assert.equal((await loadWorker(2)).type, "ready");
});

test("Whistle worker reports a negative model-load result", { timeout: 2000 }, async () => {
  const result = await loadWorker(-1);
  assert.equal(result.type, "error");
  assert.equal(result.code, "model-load-failed");
});
