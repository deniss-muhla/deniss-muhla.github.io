/*!
 * Service worker for deniss-muhla.github.io
 *
 * Two responsibilities:
 *
 * 1. Cross-origin isolation. Same-origin responses are returned with
 *    COOP/COEP headers so the page is `crossOriginIsolated` and can use
 *    SharedArrayBuffer, which the threaded Moonshine WASM build requires.
 *    Technique based on coi-serviceworker by Guido Zuidhof and contributors (MIT).
 *
 * 2. Offline support. The app shell and same-origin assets are cached on first
 *    use, plus the third-party assets the local voice stack needs at runtime
 *    (ONNX Runtime from jsDelivr, Google Fonts). Model weights are cached by the
 *    libraries themselves (Moonshine / Pocket TTS / WebLLM use Cache Storage),
 *    so this worker deliberately does not duplicate those downloads, including
 *    the same-origin answer model served from /models/.
 *
 * Update VERSION when the caching strategy changes; stale caches are pruned on
 * activation. Hashed Vite assets are immutable and served cache-first, while
 * unhashed files use stale-while-revalidate so deploys propagate.
 */
const VERSION = "1";
const SHELL_CACHE = `cv-shell-${VERSION}`;
const ASSET_CACHE = `cv-assets-${VERSION}`;
const VENDOR_CACHE = `cv-vendor-${VERSION}`;
const KNOWN_CACHES = new Set([SHELL_CACHE, ASSET_CACHE, VENDOR_CACHE]);

const SHELL_URLS = ["/", "/index.html", "/favicon.svg", "/downloads/deniss-muhla-cv.pdf"];

const VENDOR_HOSTS = new Set([
  "cdn.jsdelivr.net",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
]);

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
            // A missing optional shell file (e.g. the generated CV PDF in dev)
            // must not fail the whole install.
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
          .filter((name) => name.startsWith("cv-") && !KNOWN_CACHES.has(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    // The answer model is served same-origin from /models/ and cached by the
    // runtime's own Cache Storage, so the worker passes it straight through
    // instead of keeping a second copy of it here.
    if (url.pathname.startsWith("/models/")) return;
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

  // Vite output under /assets/ is content-hashed and safe to serve cache-first.
  if (url.pathname.startsWith("/assets/")) {
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
