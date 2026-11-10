import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
function setup(initial: string[] = []) {
  const names = new Set(initial);
  const handlers = new Map<string, (event: any) => void>();
  const shell = new Response("offline shell", { headers: { "content-type": "text/html" } });
  let claimed = false;
  const caches = {
    keys: async () => [...names],
    delete: async (name: string) => names.delete(name),
    match: async (key: string, options: { cacheName: string }) => key === "/index.html" && options.cacheName === "cv-shell-6" ? shell.clone() : undefined,
  };
  const self = { location: { origin: "https://example.test" }, clients: { claim: async () => { claimed = true; } }, addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler) };
  runInNewContext(source, { self, caches, URL, Request, Response, Headers, fetch: async () => { throw new Error("offline"); } });
  return { names, handlers, claimed: () => claimed };
}

test("activation prunes only old owned caches while preserving model caches", async () => {
  const h = setup(["cv-shell-5", "cv-assets-4", "cv-audio-2", "cv-vendor-1", "cv-shell-6", "cv-assets-6", "cv-vendor-6", "paradee-model", "whistle-model", "embedding-model", "other-cache"]);
  let done!: Promise<void>;
  h.handlers.get("activate")!({ waitUntil: (promise: Promise<void>) => { done = promise; } });
  await done;
  assert.deepEqual([...h.names].sort(), ["cv-shell-6", "cv-assets-6", "cv-vendor-6", "paradee-model", "whistle-model", "embedding-model", "other-cache"].sort());
  assert.equal(h.claimed(), true);
});

test("PDF, downloads and model requests pass through without interception", () => {
  const h = setup();
  for (const path of ["/downloads/cv.pdf", "/public/downloads/cv.pdf", "/elsewhere/CV.PDF", "/models/model/weights.onnx"]) {
    let intercepted = false;
    h.handlers.get("fetch")!({ request: new Request(`https://example.test${path}`), respondWith: () => { intercepted = true; } });
    assert.equal(intercepted, false, path);
  }
});

test("offline navigation fallback restores isolation headers", async () => {
  const h = setup();
  let result!: Promise<Response>;
  h.handlers.get("fetch")!({ request: { method: "GET", url: "https://example.test/profile", mode: "navigate" }, respondWith: (promise: Promise<Response>) => { result = promise; } });
  const response = await result;
  assert.equal(await response.text(), "offline shell");
  assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(response.headers.get("cross-origin-embedder-policy"), "require-corp");
});
