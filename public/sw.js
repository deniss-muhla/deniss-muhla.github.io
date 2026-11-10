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
 *    Storage (the embedding model, Whistle and Paradee workers each own their
 *    copy), so a second copy here would double the storage. No third-party host is
 *    cached here anymore.
 *
 * Update VERSION when the caching strategy changes; stale caches are pruned on
 * activation. Hashed Vite files are immutable and served cache-first,
 * while other unhashed files use stale-while-revalidate so deploys propagate.
 */
const VERSION = "6";
const SHELL_CACHE = `cv-shell-${VERSION}`;
const ASSET_CACHE = `cv-assets-${VERSION}`;
const VENDOR_CACHE = `cv-vendor-${VERSION}`;
const KNOWN_CACHES = new Set([SHELL_CACHE, ASSET_CACHE, VENDOR_CACHE]);
const OWNED_CACHE_PREFIXES = ["cv-shell-", "cv-assets-", "cv-audio-", "cv-vendor-"];

const SHELL_URLS = ["/", "/index.html", "/favicon.svg"];
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

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    // Protected documents/downloads and model loaders own their own delivery/storage.
    // These early returns must precede respondWith so the worker never fetches or caches them.
    if (isDownloadOrPdfPath(url.pathname)) return;
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

  // Hashed Vite output is safe to serve cache-first.
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

function isDownloadOrPdfPath(pathname) {
  const path = pathname.toLowerCase();
  return path === "/downloads" || path.startsWith("/downloads/") ||
    path === "/public/downloads" || path.startsWith("/public/downloads/") || path.endsWith(".pdf");
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
