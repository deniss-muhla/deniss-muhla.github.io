import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { parseAudioCacheProgress, requestAudioCacheWarm } from "../src/offline/audio-cache.ts";

const origin = "https://example.test";
const TEST_IDENTITY = { factsSha256: "a".repeat(64), greetingSha256: "b".repeat(64), catalogSha256: "c".repeat(64) };
const OTHER_IDENTITY = { factsSha256: "d".repeat(64), greetingSha256: "e".repeat(64), catalogSha256: "f".repeat(64) };
const swSource = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const voiceChatSource = await readFile(new URL("../src/chat/VoiceChat.tsx", import.meta.url), "utf8");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

class TestResponse {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly type: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
  constructor(bytes: Uint8Array, status = 200, headers = new Headers()) {
    this.body = bytes.slice();
    this.status = status;
    this.statusText = status === 200 ? "OK" : "Error";
    this.ok = status >= 200 && status < 300;
    this.type = "basic";
    this.headers = headers;
  }
  clone() { return new TestResponse(this.body, this.status, new Headers(this.headers)); }
  async arrayBuffer() { return this.body.slice().buffer; }
  async json() { return JSON.parse(new TextDecoder().decode(this.body)); }
}

class TestCache {
  entries = new Map<string, TestResponse>();
  private readonly storage: TestStorage;
  constructor(storage: TestStorage) { this.storage = storage; }
  async match(request: Request | string) {
    const key = this.storage.key(request);
    return this.entries.get(key)?.clone();
  }
  async put(request: Request | string, response: TestResponse | Response) {
    const key = this.storage.key(request);
    if (this.storage.quotaFailures.has(key)) {
      this.storage.quotaFailures.delete(key);
      throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
    }
    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    this.entries.set(key, new TestResponse(bytes, response.status, new Headers(response.headers)));
  }
  async delete(request: Request | string) { return this.entries.delete(this.storage.key(request)); }
  async keys() { return [...this.entries.keys()].map((url) => new Request(url)); }
  async add(request: Request | string) {
    const response = await this.storage.fetch(request);
    await this.put(request, response);
  }
}

class TestStorage {
  caches = new Map<string, TestCache>();
  quotaFailures = new Set<string>();
  readonly fetch: (request: Request | string) => Promise<TestResponse>;
  constructor(fetch: (request: Request | string) => Promise<TestResponse>) { this.fetch = fetch; }
  key(request: Request | string) { return new URL(typeof request === "string" ? request : request.url, origin).href; }
  async open(name: string) {
    let cache = this.caches.get(name);
    if (!cache) { cache = new TestCache(this); this.caches.set(name, cache); }
    return cache;
  }
  async keys() { return [...this.caches.keys()]; }
  async delete(name: string) { return this.caches.delete(name); }
  async match(request: Request | string, options: { cacheName?: string } = {}) {
    if (options.cacheName) return (await this.open(options.cacheName)).match(request);
    for (const cache of this.caches.values()) {
      const response = await cache.match(request);
      if (response) return response;
    }
    return undefined;
  }
}

function syntheticCorpus(count = 122, identity = TEST_IDENTITY) {
  const clips = Array.from({ length: count }, (_, index) => {
    const bytes = new TextEncoder().encode(`unit-clip-${index}`);
    const hash = sha256(bytes);
    return { id: `unit-${String(index).padStart(3, "0")}`, file: `unit-${String(index).padStart(3, "0")}-${hash}.mp3`, bytes: bytes.length, durationSeconds: 0.1, sha256: hash, textSha256: sha256(new TextEncoder().encode(`text-${index}`)), body: bytes };
  });
  const manifest = { version: 2, ...identity, clips: clips.map(({ body: _body, ...entry }) => entry) };
  return { manifest, clips };
}

async function bootWorker(options: { corpus?: ReturnType<typeof syntheticCorpus>; failedRoutes?: Set<string>; offline?: boolean; beforeFetch?: (pathname: string) => Promise<void> | void } = {}) {
  const corpus = options.corpus ?? syntheticCorpus();
  const failedRoutes = options.failedRoutes ?? new Set<string>();
  const listeners = new Map<string, (event: any) => void>();
  const fetched: string[] = [];
  let offline = options.offline ?? false;
  const fetch = async (input: Request | string) => {
    const url = new URL(typeof input === "string" ? input : input.url, origin);
    fetched.push(url.pathname);
    await options.beforeFetch?.(url.pathname);
    if (offline) throw new TypeError("network offline");
    if (failedRoutes.has(url.pathname)) throw new TypeError("network failed");
    if (url.pathname === "/audio/assistant/manifest.json") {
      return new TestResponse(new TextEncoder().encode(JSON.stringify(corpus.manifest)), 200, new Headers({ "Content-Type": "application/json" }));
    }
    const clip = corpus.clips.find((item) => `/audio/assistant/${item.file}` === url.pathname);
    return clip ? new TestResponse(clip.body) : new TestResponse(new TextEncoder().encode("asset"));
  };
  const storage = new TestStorage(fetch);
  let clientClaimCount = 0;
  const self = {
    location: { origin, hostname: "example.test" },
    addEventListener: (name: string, callback: (event: any) => void) => listeners.set(name, callback),
    skipWaiting: async () => undefined,
    clients: { claim: async () => { clientClaimCount += 1; }, matchAll: async () => [] },
  };
  runInNewContext(swSource, {
    self, caches: storage, fetch, Request, Response, Headers, URL, crypto: webcrypto,
    TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Promise, Set, Map, Object, Number, RegExp, Error,
  });
  const post = (data: unknown) => {
    const messages: any[] = [];
    const pending: Promise<unknown>[] = [];
    const source = { postMessage: (message: unknown) => messages.push(message) };
    listeners.get("message")?.({ data, source, waitUntil: (value: Promise<unknown>) => pending.push(value) });
    return { messages, pending, source };
  };
  const send = async (data: unknown) => {
    const result = post(data);
    await Promise.all(result.pending);
    return result.messages;
  };
  const dispatchFetch = async (pathname: string): Promise<Response | null> => {
    const slot: { response?: Promise<Response> } = {};
    listeners.get("fetch")?.({
      request: new Request(new URL(pathname, origin)),
      respondWith: (response: Promise<Response> | Response) => { slot.response = Promise.resolve(response); },
    });
    return slot.response ? await slot.response : null;
  };
  return { corpus, listeners, storage, fetched, post, send, dispatchFetch, clientClaimCount: () => clientClaimCount, setOffline: (value: boolean) => { offline = value; }, setFailedRoute: (path: string, value: boolean) => { if (value) failedRoutes.add(path); else failedRoutes.delete(path); } };
}

const warmRequest = { type: "CV_AUDIO_CACHE_WARM", online: true, saveData: false, identity: TEST_IDENTITY };

test("published v2 audio manifest has the reviewed complete corpus within the audio budget", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/audio/assistant/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.version, 2);
  assert.equal(manifest.clips.length, 122);
  const ids = new Set<string>();
  const files = new Set<string>();
  for (const clip of manifest.clips) {
    assert.match(clip.id, /^[a-z0-9][a-z0-9-]*$/);
    assert.match(clip.sha256, /^[a-f0-9]{64}$/);
    assert.match(clip.textSha256, /^[a-f0-9]{64}$/);
    assert.equal(clip.file, `${clip.id}-${clip.sha256}.mp3`);
    assert.ok(Number.isSafeInteger(clip.bytes) && clip.bytes > 0);
    assert.ok(Number.isFinite(clip.durationSeconds) && clip.durationSeconds > 0);
    assert.equal(ids.has(clip.id), false);
    assert.equal(files.has(clip.file), false);
    ids.add(clip.id);
    files.add(clip.file);
  }
  let actualTotalBytes = 0;
  for (const clip of manifest.clips) {
    assert.equal(typeof clip.id, "string");
    assert.equal(typeof clip.file, "string");
    assert.equal(typeof clip.bytes, "number");
    assert.equal(typeof clip.sha256, "string");
    assert.match(clip.file, /^[a-z0-9][a-z0-9-]{0,79}-[a-f0-9]{64}\.mp3$/);
    assert.equal(clip.file, `${clip.id}-${clip.sha256}.mp3`);
    const audioBytes = await readFile(new URL(`../public/audio/assistant/${clip.file}`, import.meta.url));
    assert.equal(audioBytes.byteLength, clip.bytes);
    assert.equal(sha256(audioBytes), clip.sha256);
    actualTotalBytes += audioBytes.byteLength;
  }
  assert.equal(manifest.clips.length, 122);
  assert.ok(actualTotalBytes > 0 && actualTotalBytes <= 20 * 1024 * 1024);
});

test("status filters stale compiled identity", () => {
  const currentReady = {
    type: "CV_AUDIO_CACHE_STATUS", identity: TEST_IDENTITY, state: "ready", verifiedClips: 2, totalClips: 2,
    verifiedBytes: 12, totalBytes: 12, manifestValid: true, manifestRetained: true,
    failureCategory: "none", canRetry: false,
  };
  assert.equal(parseAudioCacheProgress(currentReady, TEST_IDENTITY)?.state, "ready");
  assert.equal(parseAudioCacheProgress(currentReady, OTHER_IDENTITY), null);
  assert.equal(parseAudioCacheProgress({ ...currentReady, identity: { ...TEST_IDENTITY, factsSha256: [TEST_IDENTITY.factsSha256] } }, TEST_IDENTITY), null);
});

test("root manifest hashes reject coerced arrays", async () => {
  const fields = ["factsSha256", "greetingSha256", "catalogSha256"] as const;
  for (const field of fields) {
    const corpus = syntheticCorpus();
    (corpus.manifest as unknown as Record<string, unknown>)[field] = [TEST_IDENTITY[field]];
    const worker = await bootWorker({ corpus });
    const statuses = await worker.send(warmRequest);
    assert.equal((statuses.at(-1) as { state: string }).state, "error", `${field} array must be rejected`);
  }
});

test("VoiceChat listens for offline and removes that listener", () => {
  assert.match(voiceChatSource, /window\.addEventListener\("offline", requestWarm\)/);
  assert.match(voiceChatSource, /window\.removeEventListener\("offline", requestWarm\)/);
});

test("background warm retains all 122 clips separately while generic assets stay capped", async () => {
  const worker = await bootWorker();
  assert.equal(typeof worker.listeners.get("message"), "function", "service worker must expose the closed audio warm message");
  for (let index = 0; index < 121; index += 1) await worker.dispatchFetch(`/assets/test-${index}.js`);
  const statuses = await worker.send(warmRequest);
  const ready = statuses.at(-1) as { type: string; state: string; verifiedClips: number; totalClips: number; verifiedBytes: number; totalBytes: number; manifestRetained: boolean };
  assert.equal(ready.type, "CV_AUDIO_CACHE_STATUS");
  assert.equal(ready.state, "ready");
  assert.equal(ready.verifiedClips, 122);
  assert.equal(ready.totalClips, 122);
  assert.equal(ready.verifiedBytes, ready.totalBytes);
  assert.equal(ready.manifestRetained, true);
  const names = await worker.storage.keys();
  const audioName = names.find((name) => name.startsWith("cv-audio-"));
  const assetsName = names.find((name) => name.startsWith("cv-assets-"));
  assert.ok(audioName && assetsName);
  assert.equal((await (await worker.storage.open(audioName)).keys()).length, 123);
  assert.ok((await (await worker.storage.open(assetsName)).keys()).length <= 120);
});

test("save-data skips network and reports incomplete instead of ready", async () => {
  const worker = await bootWorker();
  assert.equal(typeof worker.listeners.get("message"), "function", "service worker must expose the closed audio warm message");
  const statuses = await worker.send({ ...warmRequest, saveData: true });
  assert.equal((statuses.at(-1) as { state: string }).state, "skipped-save-data");
  assert.equal(worker.fetched.length, 0);
});

test("a cached complete corpus never satisfies a different compiled identity offline", async () => {
  const worker = await bootWorker({ corpus: syntheticCorpus(122, OTHER_IDENTITY) });
  const oldReady = await worker.send({ ...warmRequest, identity: OTHER_IDENTITY });
  assert.equal((oldReady.at(-1) as { state: string }).state, "ready");
  worker.setOffline(true);
  const current = await worker.send({ ...warmRequest, online: false, identity: TEST_IDENTITY });
  const status = current.at(-1) as { state: string; identity: typeof TEST_IDENTITY; manifestValid: boolean };
  assert.equal(status.state, "offline");
  assert.equal(status.identity.factsSha256, TEST_IDENTITY.factsSha256);
  assert.equal(status.identity.greetingSha256, TEST_IDENTITY.greetingSha256);
  assert.equal(status.identity.catalogSha256, TEST_IDENTITY.catalogSha256);
  assert.equal(status.manifestValid, false);
});

test("different-identity warm requests serialize without borrowing Ready", async () => {
  const worker = await bootWorker();
  const current = worker.post(warmRequest);
  const other = worker.post({ ...warmRequest, identity: OTHER_IDENTITY });
  await Promise.all([...current.pending, ...other.pending]);
  assert.equal(current.messages.at(-1)?.state, "ready");
  assert.equal(other.messages.at(-1)?.state, "error");
  assert.equal(other.messages.some((status) => status.state === "ready"), false);
  assert.equal(other.messages.at(-1)?.identity.factsSha256, OTHER_IDENTITY.factsSha256);
  assert.equal(other.messages.at(-1)?.identity.greetingSha256, OTHER_IDENTITY.greetingSha256);
  assert.equal(other.messages.at(-1)?.identity.catalogSha256, OTHER_IDENTITY.catalogSha256);
});

test("offline hint stops further warm requests and reports offline", async () => {
  let releaseFetch!: () => void;
  let signalStarted!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFetch = resolve; });
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const worker = await bootWorker({ beforeFetch: async (pathname) => {
    if (!pathname.endsWith(".mp3")) return;
    signalStarted();
    await gate;
  } });
  const initial = worker.post(warmRequest);
  await started;
  worker.setOffline(true);
  const offlineHint = worker.post({ ...warmRequest, online: false });
  releaseFetch();
  await Promise.all([...initial.pending, ...offlineHint.pending]);
  assert.equal(initial.messages.at(-1)?.state, "offline");
  assert.equal(offlineHint.messages.at(-1)?.state, "offline");
  assert.ok(worker.fetched.filter((path) => path.endsWith(".mp3")).length < worker.corpus.clips.length);
});

test("offline update reaches a different-identity job while queued", async () => {
  let releaseFetch!: () => void;
  let signalStarted!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFetch = resolve; });
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const worker = await bootWorker({ beforeFetch: async (pathname) => {
    if (!pathname.endsWith(".mp3")) return;
    signalStarted();
    await gate;
  } });
  const initial = worker.post(warmRequest);
  await started;
  const activeOffline = worker.post({ ...warmRequest, online: false });
  const queuedOnline = worker.post({ ...warmRequest, identity: OTHER_IDENTITY });
  const queuedOffline = worker.post({ ...warmRequest, online: false, identity: OTHER_IDENTITY });
  worker.setOffline(true);
  releaseFetch();
  await Promise.all([...initial.pending, ...activeOffline.pending, ...queuedOnline.pending, ...queuedOffline.pending]);
  assert.equal(initial.messages.at(-1)?.state, "offline");
  assert.equal(activeOffline.messages.at(-1)?.state, "offline");
  assert.equal(queuedOnline.messages.at(-1)?.state, "offline");
  assert.equal(queuedOffline.messages.at(-1)?.state, "offline");
  assert.equal(worker.fetched.filter((path) => path === "/audio/assistant/manifest.json").length, 1);
});

test("partial network retains verified entries and retry fills only missing clips", async () => {
  const corpus = syntheticCorpus();
  const missingPath = `/audio/assistant/${corpus.clips[31].file}`;
  const worker = await bootWorker({ corpus, failedRoutes: new Set([missingPath]) });
  assert.equal(typeof worker.listeners.get("message"), "function", "service worker must expose the closed audio warm message");
  const partial = await worker.send(warmRequest);
  assert.equal((partial.at(-1) as { state: string }).state, "partial");
  const audioName = (await worker.storage.keys()).find((name) => name.startsWith("cv-audio-"));
  assert.ok(audioName);
  const cache = await worker.storage.open(audioName);
  assert.equal((await cache.keys()).length, 122);
  worker.fetched.splice(0);
  worker.setFailedRoute(missingPath, false);
  worker.setOffline(false);
  const ready = await worker.send(warmRequest);
  assert.equal((ready.at(-1) as { state: string; verifiedClips: number }).state, "ready");
  assert.equal((ready.at(-1) as { verifiedClips: number }).verifiedClips, 122);
  assert.equal(worker.fetched.filter((path) => path.endsWith(corpus.clips[31].file)).length, 1);
});

test("PDF and model routes pass through before respondWith", async () => {
  const worker = await bootWorker();
  const pdf = await worker.dispatchFetch("/downloads/generic-placeholder.pdf");
  const model = await worker.dispatchFetch("/models/generic-model.bin");
  assert.equal(pdf, null);
  assert.equal(model, null);
  assert.equal(worker.fetched.length, 0);
});

test("client warm request waits for control and forwards current network hints", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const unavailable: string[] = [];
  const messages: unknown[] = [];
  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { onLine: false, serviceWorker: { controller: null } },
    });
    requestAudioCacheWarm((state) => unavailable.push(state), TEST_IDENTITY);
    assert.deepEqual(unavailable, ["waiting-control"]);
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        onLine: false,
        connection: { saveData: true },
        serviceWorker: { controller: { postMessage: (message: unknown) => messages.push(message) } },
      },
    });
    const missingBuildIdentity: string[] = [];
    requestAudioCacheWarm((state) => missingBuildIdentity.push(state));
    assert.deepEqual(missingBuildIdentity, ["unsupported"]);
    assert.equal(messages.length, 0);
    requestAudioCacheWarm(undefined, TEST_IDENTITY);
    assert.deepEqual(messages, [{ type: "CV_AUDIO_CACHE_WARM", online: false, saveData: true, identity: TEST_IDENTITY }]);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("audio warm progress accepts only the closed truthful-ready contract", () => {
  const ready = {
    type: "CV_AUDIO_CACHE_STATUS", identity: TEST_IDENTITY, state: "ready", verifiedClips: 2, totalClips: 2,
    verifiedBytes: 12, totalBytes: 12, manifestValid: true, manifestRetained: true,
    failureCategory: "none", canRetry: false,
  };
  assert.equal(parseAudioCacheProgress(ready, TEST_IDENTITY)?.state, "ready");
  assert.equal(parseAudioCacheProgress({ ...ready, verifiedClips: 1 }, TEST_IDENTITY), null);
  assert.equal(parseAudioCacheProgress({ ...ready, manifestRetained: false }, TEST_IDENTITY), null);
  assert.equal(parseAudioCacheProgress({ ...ready, rawError: "not allowed" }, TEST_IDENTITY), null);
});

test("invalid manifest and quota failures never claim complete readiness", async () => {
  const invalidCorpus = syntheticCorpus();
  invalidCorpus.manifest.clips[0].file = "../escape.mp3";
  const invalidWorker = await bootWorker({ corpus: invalidCorpus });
  const invalidStatus = await invalidWorker.send(warmRequest);
  assert.equal((invalidStatus.at(-1) as { state: string }).state, "error");
  assert.equal((invalidStatus.at(-1) as { manifestValid: boolean }).manifestValid, false);
  assert.equal(invalidWorker.fetched.some((path) => path.endsWith(".mp3")), false);

  const quotaWorker = await bootWorker();
  const quotaPath = `/audio/assistant/${quotaWorker.corpus.clips[17].file}`;
  quotaWorker.storage.quotaFailures.add(quotaWorker.storage.key(quotaPath));
  const partial = await quotaWorker.send(warmRequest);
  assert.notEqual((partial.at(-1) as { state: string }).state, "ready");
  assert.equal((partial.at(-1) as { failureCategory: string }).failureCategory, "quota");
  const retry = await quotaWorker.send(warmRequest);
  assert.equal((retry.at(-1) as { state: string }).state, "ready");
});

test("parallel warm requests share one network job", async () => {
  const worker = await bootWorker();
  const first = worker.post(warmRequest);
  const second = worker.post(warmRequest);
  await Promise.all([...first.pending, ...second.pending]);
  assert.equal(first.messages.at(-1)?.state, "ready");
  assert.equal(second.messages.at(-1)?.state, "ready");
  assert.equal(worker.fetched.filter((path) => path === "/audio/assistant/manifest.json").length, 1);
  for (const clip of worker.corpus.clips) {
    assert.equal(worker.fetched.filter((path) => path === `/audio/assistant/${clip.file}`).length, 1);
  }
});

test("activation prunes only owned worker cache versions and preserves model cache names", async () => {
  const worker = await bootWorker();
  await worker.storage.open("cv-shell-4");
  await worker.storage.open("cv-assets-4");
  await worker.storage.open("cv-audio-4");
  await worker.storage.open("whistle-model-cache-v1");
  let activation: Promise<unknown> | null = null;
  worker.listeners.get("activate")?.({ waitUntil: (value: Promise<unknown>) => { activation = value; } });
  await activation;
  const names = await worker.storage.keys();
  assert.equal(names.includes("cv-shell-4"), false);
  assert.equal(names.includes("cv-assets-4"), false);
  assert.equal(names.includes("cv-audio-4"), false);
  assert.equal(names.includes("whistle-model-cache-v1"), true);
  assert.equal(worker.clientClaimCount(), 1);
});

test("shell fallback retains isolation headers after offline navigation", async () => {
  const worker = await bootWorker();
  const shell = await worker.storage.open("cv-shell-5");
  await shell.put("/index.html", new TestResponse(new TextEncoder().encode("shell")));
  worker.setOffline(true);
  const response = await worker.dispatchFetch("/assistant.html");
  assert.ok(response);
  assert.equal(response.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  assert.equal(response.headers.get("Cross-Origin-Embedder-Policy"), "require-corp");
});
