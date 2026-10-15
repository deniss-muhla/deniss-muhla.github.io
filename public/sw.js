/*!
 * Service worker for deniss-muhla.github.io
 *
 * Two responsibilities:
 *
 * 1. Cross-origin isolation. Same-origin responses are returned with
 *    COOP/COEP headers so the page is `crossOriginIsolated` and can use
 *    SharedArrayBuffer. No shipped model needs it: the speech engine and the
 *    retrieval encoder both run single-threaded, so it stays the page's header
 *    policy. Technique based on coi-serviceworker by Guido Zuidhof and
 *    contributors (MIT).
 *
 * 2. Offline support. The app shell, the hashed Vite assets, the site's own
 *    `/fonts/` files and every other same-origin path are cached on first use,
 *    so this worker is the one cache for them. `/models/` is passed through:
 *    the model bytes are served from this origin and kept by their own Cache
 *    Storage (the embedding model and the Whistle speech worker each own their
 *    copy), so a second copy here would double the storage. Reviewed answer clips
 *    are cached here; their manifest is network-first with an offline cache
 *    fallback, and every clip path is content-hashed. No third-party host is
 *    cached here anymore.
 *
 * Update VERSION when the caching strategy changes; stale caches are pruned on
 * activation. Hashed Vite and audio files are immutable and served cache-first,
 * while other unhashed files use stale-while-revalidate so deploys propagate.
 */
const VERSION = "5";
const SHELL_CACHE = `cv-shell-${VERSION}`;
const ASSET_CACHE = `cv-assets-${VERSION}`;
const AUDIO_CACHE = `cv-audio-${VERSION}`;
const VENDOR_CACHE = `cv-vendor-${VERSION}`;
const KNOWN_CACHES = new Set([SHELL_CACHE, ASSET_CACHE, AUDIO_CACHE, VENDOR_CACHE]);
const OWNED_CACHE_PREFIXES = ["cv-shell-", "cv-assets-", "cv-audio-", "cv-vendor-"];

const SHELL_URLS = ["/", "/index.html", "/favicon.svg"];
const AUDIO_MANIFEST_PATH = "/audio/assistant/manifest.json";
const AUDIO_MANIFEST_LIMIT_BYTES = 256 * 1024;
const AUDIO_CLIP_PATTERN = /^\/audio\/assistant\/([a-z0-9-]+)-([a-f0-9]{64})\.mp3$/;
const AUDIO_CACHE_LIMIT_BYTES = 20 * 1024 * 1024;
const AUDIO_CACHE_LIMIT_CLIPS = 200;
const AUDIO_PREFETCH_CONCURRENCY = 3;
let audioWarmJob = null;
let audioWarmControl = null;
let audioWarmIdentityKey = null;
let audioWarmQueue = Promise.resolve();
const audioWarmQueued = new Map();
const audioWarmClients = new Map();
const audioClipJobs = new Map();

// Every third-party runtime asset is served from this origin now, so no host is
// left for the worker to cache. The set and the branch below stay: the next
// asset that has to come from a host is added here once, by name.
const VENDOR_HOSTS = new Set();

const ASSET_CACHE_LIMIT = 120;

const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(
        SHELL_URLS.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: "reload" }));
          } catch {
            // A missing optional shell file must not fail the whole install.
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => OWNED_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix)) && !KNOWN_CACHES.has(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (!isAudioWarmRequest(event.data)) return;
  if (event.source && typeof event.source.postMessage === "function") {
    audioWarmClients.set(event.source, audioSourceIdentityKey(event.data.identity));
  }
  event.waitUntil(requestAudioWarm(event.data));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    // Protected documents/downloads and model loaders own their own delivery/storage.
    // These early returns must precede respondWith so the worker never fetches or caches them.
    if (isDownloadOrPdfPath(url.pathname)) return;
    if (url.pathname.startsWith("/models/")) return;
    if (url.pathname === AUDIO_MANIFEST_PATH) {
      event.respondWith(networkFirstAudioManifest(request));
      return;
    }
    if (AUDIO_CLIP_PATTERN.test(url.pathname)) {
      event.respondWith(handleAudioClipRequest(request, url));
      return;
    }
    if (url.pathname.startsWith("/audio/assistant/")) return;
    event.respondWith(handleSameOrigin(request, url));
    return;
  }

  if (VENDOR_HOSTS.has(url.hostname)) {
    event.respondWith(cacheFirst(request, VENDOR_CACHE));
  }
});

async function handleSameOrigin(request, url) {
  const isDocument =
    request.mode === "navigate" ||
    request.destination === "document" ||
    url.pathname === "/" ||
    url.pathname.endsWith(".html");

  if (isDocument) {
    return networkFirstDocument(request);
  }

  // Vite output and reviewed audio clips are content-hashed and safe to serve cache-first.
  if (
    url.pathname.startsWith("/assets/") ||
    /^\/audio\/assistant\/[a-z0-9-]+-[a-f0-9]{64}\.mp3$/.test(url.pathname)
  ) {
    return cacheFirst(request, ASSET_CACHE, { isolate: true });
  }

  return staleWhileRevalidate(request, ASSET_CACHE);
}

async function networkFirstDocument(request) {
  try {
    // `no-store` keeps a 304 out of the way: a revalidated response has no body
    // and would let the browser merge original headers, dropping COOP/COEP.
    const response = await fetch(new Request(request, { cache: "no-store" }));
    if (response && response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put("/index.html", response.clone()).catch(() => undefined);
    }
    return withIsolationHeaders(response);
  } catch (error) {
    const cached = await caches.match("/index.html", { cacheName: SHELL_CACHE });
    if (cached) return withIsolationHeaders(cached);
    throw error;
  }
}

function isDownloadOrPdfPath(pathname) {
  const path = pathname.toLowerCase();
  return path === "/downloads" || path.startsWith("/downloads/") ||
    path === "/public/downloads" || path.startsWith("/public/downloads/") || path.endsWith(".pdf");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isAudioSourceIdentity(value) {
  const isSha256 = (hash) => typeof hash === "string" && hash.length === 64 && /^[a-f0-9]{64}$/.test(hash);
  return isRecord(value) && hasExactKeys(value, ["factsSha256", "greetingSha256", "catalogSha256"]) &&
    isSha256(value.factsSha256) && isSha256(value.greetingSha256) && isSha256(value.catalogSha256);
}

function audioSourceIdentityKey(identity) {
  return `${identity.factsSha256}:${identity.greetingSha256}:${identity.catalogSha256}`;
}

function sameAudioSourceIdentity(left, right) {
  return left.factsSha256 === right.factsSha256 &&
    left.greetingSha256 === right.greetingSha256 &&
    left.catalogSha256 === right.catalogSha256;
}

function parseAudioManifest(value) {
  const isSha256 = (hash) => typeof hash === "string" && hash.length === 64 && /^[a-f0-9]{64}$/.test(hash);
  const idPattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "factsSha256", "greetingSha256", "catalogSha256", "clips"]) ||
    value.version !== 2 ||
    !isSha256(value.factsSha256) || !isSha256(value.greetingSha256) ||
    !isSha256(value.catalogSha256) || !Array.isArray(value.clips) ||
    value.clips.length === 0 || value.clips.length > AUDIO_CACHE_LIMIT_CLIPS
  ) throw new Error("invalid-manifest");

  const ids = new Set();
  const files = new Set();
  let totalBytes = 0;
  const clips = value.clips.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["id", "file", "bytes", "durationSeconds", "sha256", "textSha256"]) ||
      typeof entry.id !== "string" || !idPattern.test(entry.id) || ids.has(entry.id) ||
      !isSha256(entry.sha256) ||
      entry.file !== `${entry.id}-${entry.sha256}.mp3` || files.has(entry.file) ||
      !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 ||
      typeof entry.durationSeconds !== "number" || !Number.isFinite(entry.durationSeconds) || entry.durationSeconds <= 0 ||
      !isSha256(entry.textSha256)
    ) throw new Error("invalid-manifest");
    const route = `/audio/assistant/${entry.file}`;
    const clipUrl = new URL(route, self.location.origin);
    if (clipUrl.origin !== self.location.origin || clipUrl.pathname !== route || !AUDIO_CLIP_PATTERN.test(route)) {
      throw new Error("invalid-manifest");
    }
    if (entry.bytes > AUDIO_CACHE_LIMIT_BYTES - totalBytes) throw new Error("invalid-manifest");
    totalBytes += entry.bytes;
    ids.add(entry.id);
    files.add(entry.file);
    return { id: entry.id, file: entry.file, bytes: entry.bytes, sha256: entry.sha256 };
  });
  return { version: 2, factsSha256: value.factsSha256, greetingSha256: value.greetingSha256, catalogSha256: value.catalogSha256, clips, totalBytes };
}

function safeAudioFailureCategory(error) {
  const name = error instanceof Error ? error.name : "";
  if (name === "QuotaExceededError") return "quota";
  if (name === "TypeError" || name === "NetworkError" || name === "AbortError") return "network";
  return "unknown";
}

async function readAudioManifestJson(response) {
  const bytes = await response.clone().arrayBuffer();
  if (bytes.byteLength > AUDIO_MANIFEST_LIMIT_BYTES) throw new Error("invalid-manifest");
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function responseMatchesAudioClip(response, clip) {
  if (!response || response.status !== 200 || !response.ok || response.type === "opaque") return false;
  try {
    const bytes = await response.clone().arrayBuffer();
    if (bytes.byteLength !== clip.bytes) return false;
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return actual === clip.sha256;
  } catch {
    return false;
  }
}

async function readCachedAudioManifest(cache, expectedIdentity) {
  const response = await cache.match(AUDIO_MANIFEST_PATH);
  if (!response) return null;
  let manifest;
  try { manifest = parseAudioManifest(await readAudioManifestJson(response)); }
  catch {
    await cache.delete(AUDIO_MANIFEST_PATH).catch(() => undefined);
    return null;
  }
  if (expectedIdentity && !sameAudioSourceIdentity(manifest, expectedIdentity)) return null;
  return { response, manifest };
}

async function fetchAudioManifest(cache, request, expectedIdentity) {
  let failureCategory = "network";
  try {
    const response = await fetch(new Request(request, { cache: "no-store" }));
    if (response?.ok && response.type !== "opaque") {
      let manifest;
      try { manifest = parseAudioManifest(await readAudioManifestJson(response)); }
      catch { failureCategory = "invalid-manifest"; manifest = null; }
      if (manifest && expectedIdentity && !sameAudioSourceIdentity(manifest, expectedIdentity)) {
        failureCategory = "identity-mismatch";
        manifest = null;
      }
      if (manifest) {
        let retained = false;
        try {
          await cache.put(AUDIO_MANIFEST_PATH, response.clone());
          const stored = await readCachedAudioManifest(cache, expectedIdentity);
          retained = !!stored;
        } catch (error) {
          failureCategory = safeAudioFailureCategory(error);
        }
        return { response, manifest, retained, failureCategory: retained ? "none" : failureCategory };
      }
    }
  } catch (error) {
    failureCategory = safeAudioFailureCategory(error);
  }
  const cached = await readCachedAudioManifest(cache, expectedIdentity);
  if (cached) return { ...cached, retained: true, failureCategory };
  return { response: null, manifest: null, retained: false, failureCategory };
}

async function networkFirstAudioManifest(request) {
  const cache = await caches.open(AUDIO_CACHE);
  const result = await fetchAudioManifest(cache, request);
  if (result.response && result.manifest) return withIsolationHeaders(result.response);
  return withIsolationHeaders(new Response("", { status: 503, headers: ISOLATION_HEADERS }));
}

function createAudioStatus(state, stats, identity, failureCategory = "none", canRetry = false) {
  return {
    type: "CV_AUDIO_CACHE_STATUS",
    identity: { factsSha256: identity.factsSha256, greetingSha256: identity.greetingSha256, catalogSha256: identity.catalogSha256 },
    state,
    verifiedClips: stats.verified.size,
    totalClips: stats.manifest?.clips.length ?? 0,
    verifiedBytes: stats.verifiedBytes,
    totalBytes: stats.manifest?.totalBytes ?? 0,
    manifestValid: !!stats.manifest,
    manifestRetained: stats.manifestRetained,
    failureCategory,
    canRetry,
  };
}

function postAudioStatusToClient(client, status) {
  try { client.postMessage(status); } catch { /* A closed page is not a cache failure. */ }
}

function publishAudioStatus(status) {
  const identityKey = audioSourceIdentityKey(status.identity);
  for (const [client, clientKey] of audioWarmClients) {
    if (clientKey === identityKey) postAudioStatusToClient(client, status);
  }
}

function isAudioWarmRequest(data) {
  return isRecord(data) && hasExactKeys(data, ["type", "online", "saveData", "identity"]) &&
    data.type === "CV_AUDIO_CACHE_WARM" && typeof data.online === "boolean" &&
    typeof data.saveData === "boolean" && isAudioSourceIdentity(data.identity);
}

function startAudioWarm(hints, identityKey) {
  audioWarmIdentityKey = identityKey;
  audioWarmControl = {
    online: hints.online,
    saveData: hints.saveData,
    identity: { factsSha256: hints.identity.factsSha256, greetingSha256: hints.identity.greetingSha256, catalogSha256: hints.identity.catalogSha256 },
  };
  audioWarmJob = runAudioWarm(audioWarmControl).catch(() => {
    const emptyStats = { manifest: null, manifestRetained: false, verified: new Set(), verifiedBytes: 0 };
    publishAudioStatus(createAudioStatus("error", emptyStats, audioWarmControl.identity, "unknown", !audioWarmControl.saveData));
  }).finally(() => {
    if (audioWarmIdentityKey === identityKey) {
      audioWarmJob = null;
      audioWarmControl = null;
      audioWarmIdentityKey = null;
    }
    for (const [client, clientKey] of audioWarmClients) {
      if (clientKey === identityKey) audioWarmClients.delete(client);
    }
  });
  return audioWarmJob;
}

function requestAudioWarm(hints) {
  const identityKey = audioSourceIdentityKey(hints.identity);
  if (audioWarmJob && audioWarmIdentityKey === identityKey) {
    if (audioWarmControl) {
      audioWarmControl.online = hints.online;
      audioWarmControl.saveData = hints.saveData;
    }
    return audioWarmJob;
  }
  const queued = audioWarmQueued.get(identityKey);
  if (queued) {
    queued.online = hints.online;
    queued.saveData = hints.saveData;
    return queued.promise;
  }
  const queuedHints = {
    online: hints.online,
    saveData: hints.saveData,
    identity: { factsSha256: hints.identity.factsSha256, greetingSha256: hints.identity.greetingSha256, catalogSha256: hints.identity.catalogSha256 },
    promise: null,
  };
  const job = audioWarmQueue.then(() => {
    if (audioWarmQueued.get(identityKey) !== queuedHints) return;
    audioWarmQueued.delete(identityKey);
    return startAudioWarm(queuedHints, identityKey);
  });
  queuedHints.promise = job;
  audioWarmQueued.set(identityKey, queuedHints);
  audioWarmQueue = job.catch(() => undefined);
  return job;
}

async function pruneAudioCacheToManifest(cache, manifest) {
  const keep = new Set([AUDIO_MANIFEST_PATH, ...manifest.clips.map((clip) => `/audio/assistant/${clip.file}`)]);
  const keys = await cache.keys();
  await Promise.all(keys.map(async (request) => {
    try {
      const url = new URL(request.url);
      if (url.origin === self.location.origin && url.pathname.startsWith("/audio/assistant/") && !keep.has(url.pathname)) {
        await cache.delete(request);
      }
    } catch { /* Ignore unrecognized keys in this worker-owned cache. */ }
  }));
}

function ensureAudioClipStored(cache, clip, requestForHeaders) {
  const route = `/audio/assistant/${clip.file}`;
  const existing = audioClipJobs.get(route);
  if (existing) return existing;
  const job = (async () => {
    let cached = await cache.match(route);
    if (cached && await responseMatchesAudioClip(cached, clip)) return { response: cached, verified: true, failureCategory: "none" };
    if (cached) await cache.delete(route).catch(() => undefined);

    let response;
    try {
      const request = requestForHeaders
        ? new Request(requestForHeaders, { cache: "no-store" })
        : new Request(new URL(route, self.location.origin), { cache: "no-store" });
      response = await fetch(request);
    } catch (error) {
      return { response: null, verified: false, failureCategory: safeAudioFailureCategory(error) };
    }
    if (!await responseMatchesAudioClip(response, clip)) {
      return { response: null, verified: false, failureCategory: "invalid-clip" };
    }
    try { await cache.put(route, response.clone()); }
    catch (error) { return { response, verified: false, failureCategory: safeAudioFailureCategory(error) }; }
    cached = await cache.match(route);
    if (cached && await responseMatchesAudioClip(cached, clip)) return { response: cached, verified: true, failureCategory: "none" };
    if (cached) await cache.delete(route).catch(() => undefined);
    return { response, verified: false, failureCategory: "cache-write" };
  })();
  audioClipJobs.set(route, job);
  return job.finally(() => { if (audioClipJobs.get(route) === job) audioClipJobs.delete(route); });
}

async function getAudioManifestForClip(cache) {
  const cached = await readCachedAudioManifest(cache);
  if (cached) return { ...cached, retained: true, failureCategory: "none" };
  return fetchAudioManifest(cache, new Request(new URL(AUDIO_MANIFEST_PATH, self.location.origin), { cache: "no-store" }));
}

async function handleAudioClipRequest(request, url) {
  const cache = await caches.open(AUDIO_CACHE);
  const manifestResult = await getAudioManifestForClip(cache);
  if (!manifestResult.manifest) return withIsolationHeaders(new Response("", { status: 503, headers: ISOLATION_HEADERS }));
  const clip = manifestResult.manifest.clips.find((entry) => `/audio/assistant/${entry.file}` === url.pathname);
  if (!clip) return withIsolationHeaders(new Response("", { status: 404, headers: ISOLATION_HEADERS }));
  const result = await ensureAudioClipStored(cache, clip, request);
  if (!result.response) return withIsolationHeaders(new Response("", { status: 502, headers: ISOLATION_HEADERS }));
  return withIsolationHeaders(result.response.clone());
}

async function runAudioWarm(hints) {
  const cache = await caches.open(AUDIO_CACHE);
  const stats = { manifest: null, manifestRetained: false, verified: new Set(), verifiedBytes: 0 };
  const publish = (state, category = "none") => publishAudioStatus(createAudioStatus(state, stats, hints.identity, category, !hints.saveData));
  publish("checking");

  let manifestResult;
  if (hints.saveData || !hints.online) {
    const cached = await readCachedAudioManifest(cache, hints.identity);
    manifestResult = cached ? { ...cached, retained: true, failureCategory: "none" } : { manifest: null, retained: false, failureCategory: hints.saveData ? "save-data" : "offline" };
  } else {
    manifestResult = await fetchAudioManifest(cache, new Request(new URL(AUDIO_MANIFEST_PATH, self.location.origin), { cache: "no-store" }), hints.identity);
  }
  if (!manifestResult.manifest) {
    publish(hints.saveData ? "skipped-save-data" : hints.online ? "error" : "offline", manifestResult.failureCategory);
    return;
  }
  stats.manifest = manifestResult.manifest;
  stats.manifestRetained = manifestResult.retained;
  if (stats.manifestRetained) await pruneAudioCacheToManifest(cache, stats.manifest);

  const inspectOne = async (clip) => {
    const route = `/audio/assistant/${clip.file}`;
    const response = await cache.match(route);
    if (response && await responseMatchesAudioClip(response, clip)) {
      stats.verified.add(clip.file);
      stats.verifiedBytes += clip.bytes;
    } else if (response) {
      await cache.delete(route).catch(() => undefined);
    }
    publish("checking");
  };
  let inspectIndex = 0;
  await Promise.all(Array.from({ length: Math.min(AUDIO_PREFETCH_CONCURRENCY, stats.manifest.clips.length) }, async () => {
    while (inspectIndex < stats.manifest.clips.length) {
      const clip = stats.manifest.clips[inspectIndex++];
      await inspectOne(clip);
    }
  }));

  const corpusComplete = () => stats.manifestRetained && stats.verified.size === stats.manifest.clips.length && stats.verifiedBytes === stats.manifest.totalBytes;
  if (corpusComplete()) { publish("ready"); return; }
  if (hints.saveData) { publish("skipped-save-data", "save-data"); return; }
  if (!hints.online) { publish("offline", "offline"); return; }
  if (!stats.manifestRetained) { publish("partial", manifestResult.failureCategory === "none" ? "quota" : manifestResult.failureCategory); return; }

  publish("downloading");
  const missing = stats.manifest.clips.filter((clip) => !stats.verified.has(clip.file));
  let nextIndex = 0;
  let quotaReached = false;
  let failureCategory = "none";
  const downloadOne = async (clip) => {
    const result = await ensureAudioClipStored(cache, clip);
    if (result.verified && !stats.verified.has(clip.file)) {
      stats.verified.add(clip.file);
      stats.verifiedBytes += clip.bytes;
    } else if (!result.verified && failureCategory === "none") {
      failureCategory = result.failureCategory;
    }
    if (result.failureCategory === "quota") quotaReached = true;
    publish("downloading", result.failureCategory);
  };
  await Promise.all(Array.from({ length: Math.min(AUDIO_PREFETCH_CONCURRENCY, missing.length) }, async () => {
    while (nextIndex < missing.length && !quotaReached && hints.online && !hints.saveData) {
      const clip = missing[nextIndex++];
      await downloadOne(clip);
    }
  }));
  if (corpusComplete()) publish("ready");
  else if (hints.saveData) publish("skipped-save-data", "save-data");
  else if (!hints.online) publish("offline", "offline");
  else publish("partial", failureCategory === "none" ? "network" : failureCategory);
}

async function cacheFirst(request, cacheName, options = {}) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  if (cached) {
    return options.isolate ? withIsolationHeaders(cached) : cached;
  }

  const response = await fetch(request);
  if (isCacheable(response)) {
    await cache.put(request, response.clone()).catch(() => undefined);
    await trimCache(cache, ASSET_CACHE_LIMIT);
  }
  return options.isolate ? withIsolationHeaders(response) : response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then(async (response) => {
      if (isCacheable(response)) {
        await cache.put(request, response.clone()).catch(() => undefined);
        await trimCache(cache, ASSET_CACHE_LIMIT);
      }
      return response;
    })
    .catch(() => undefined);

  if (cached) {
    void network;
    return withIsolationHeaders(cached);
  }

  const response = await network;
  if (response) return withIsolationHeaders(response);
  throw new Error(`Offline and no cached response for ${request.url}`);
}

function isCacheable(response) {
  if (!response) return false;
  if (response.type === "opaque") return true;
  return response.ok && (response.type === "basic" || response.type === "cors");
}

/** Adds isolation headers to a response body without consuming the original. */
function withIsolationHeaders(response) {
  if (!response || !response.body) return response;

  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) {
    headers.set(name, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function trimCache(cache, limit) {
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  await Promise.all(keys.slice(0, keys.length - limit).map((key) => cache.delete(key)));
}
