import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { PARADEE_ASSETS, PARADEE_CACHE, readParadeeAsset } from "../src/chat/tts/paradee/assets.ts";
import { VoiceEngine } from "../src/chat/engine.ts";
import { MODEL_ASSET_SETS } from "../scripts/model-assets.mjs";

test("runtime inventory matches the pinned manifest", () => {
  const set = MODEL_ASSET_SETS.find((entry: { id: string }) => entry.id === "sahilmahendrakar-paradee-8m-v1.1")!;
  for (const asset of PARADEE_ASSETS) {
    const file = set.files.find((entry: { name: string }) => set.route + entry.name === asset.url);
    assert.ok(file);
    assert.equal(asset.bytes, file.bytes);
    assert.equal(asset.sha256, file.sha256);
  }
  assert.match(PARADEE_CACHE, new RegExp(set.rev));
});

test("service worker leaves Paradee model requests to the verified model owner", () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const self = { location: { origin: "https://example.test" }, addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener) };
  runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), { self, URL, Set });
  let intercepted = false;
  listeners.get("fetch")!({ request: { method: "GET", url: `https://example.test${PARADEE_ASSETS[0].url}` }, respondWith: () => { intercepted = true; } });
  assert.equal(intercepted, false);
});

test("cached model bytes are verified and cold offline or corrupted bytes cannot report success", async () => {
  const oldCaches = globalThis.caches;
  const oldFetch = globalThis.fetch;
  const entries = new Map<string, Response>();
  const good = new TextEncoder().encode("verified fixture");
  const asset = { url: "/model", bytes: good.length, sha256: createHash("sha256").update(good).digest("hex") };
  let online = true;
  let requests = 0;
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { open: async () => ({
    match: async (key: string) => entries.get(key)?.clone(),
    delete: async (key: string) => entries.delete(key),
    put: async (key: string, response: Response) => { entries.set(key, response.clone()); },
  }) } });
  globalThis.fetch = (async () => { requests++; if (!online) throw new Error("offline"); return new Response(good); }) as typeof fetch;
  try {
    online = false;
    await assert.rejects(readParadeeAsset(asset));
    online = true;
    assert.deepEqual(new Uint8Array(await readParadeeAsset(asset)), good);
    online = false;
    assert.deepEqual(new Uint8Array(await readParadeeAsset(asset)), good);
    assert.equal(requests, 2, "warm cache does not request network");
    entries.set(asset.url, new Response(new TextEncoder().encode("corrupted bytes!")));
    await assert.rejects(readParadeeAsset(asset));
    assert.equal(entries.has(asset.url), false, "damaged entry is removed");
  } finally {
    Object.defineProperty(globalThis, "caches", { configurable: true, value: oldCaches });
    globalThis.fetch = oldFetch;
  }
});

test("speech readiness follows preparation and failure allows retry", async () => {
  let fail = true;
  const engine = new VoiceEngine({ audioPlayer: () => ({
    prepare: async () => { if (fail) throw new Error("offline"); },
    playReferences: async () => undefined, stop: () => undefined,
  }) });
  await assert.rejects(engine.ensureParadee());
  assert.equal(engine.states.paradee, "error");
  fail = false;
  await engine.ensureParadee();
  assert.equal(engine.states.paradee, "ready");
  assert.equal(engine.progress.paradee, 1);
});

test("readiness stays loading until verified preparation resolves and concurrent callers share it", async () => {
  let finish!: () => void;
  let calls = 0;
  const engine = new VoiceEngine({ audioPlayer: () => ({
    prepare: () => { calls++; return new Promise<void>((resolve) => { finish = resolve; }); },
    playReferences: async () => undefined, stop: () => undefined,
  }) });
  const first = engine.ensureParadee();
  const second = engine.ensureParadee();
  assert.equal(engine.states.paradee, "loading");
  await Promise.resolve();
  assert.equal(calls, 1);
  finish();
  await Promise.all([first, second]);
  assert.equal(engine.states.paradee, "ready");
});
