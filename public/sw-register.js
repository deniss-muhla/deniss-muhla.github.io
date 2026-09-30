/*
 * Service worker registration + recovery reload for cross-origin isolation.
 *
 * The worker injects COOP/COEP headers, so only documents it serves become
 * `crossOriginIsolated` (needed by the threaded Moonshine WASM build).
 * Two cases need a reload:
 *
 *  - the first controlled load (a worker has just been installed), and
 *  - Chrome's offline reload, which can serve a stale HTTP-cache copy of the
 *    document without those headers.
 *
 * Reloads use a cache-busting parameter so the stale cache entry is bypassed,
 * and are limited to three per tab session so this can never loop. The extra
 * parameter is removed from the URL once isolation is confirmed.
 */
(function () {
  if (!("serviceWorker" in navigator)) return;

  var params = new URLSearchParams(window.location.search);
  var isLocalhost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  var forced = params.has("sw");

  // Production always registers; localhost only when explicitly requested
  // (?sw=1) because Vite's dev server already sends the isolation headers.
  if (window.location.protocol !== "https:" && !forced) return;
  if (isLocalhost && !forced) return;

  var cleanUrl = function () {
    if (!window.location.search.includes("coi=")) return;
    var url = new URL(window.location.href);
    url.searchParams.delete("coi");
    window.history.replaceState(window.history.state, "", url.toString());
  };

  navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then(function () {
      if (window.crossOriginIsolated) {
        cleanUrl();
        return;
      }

      var reloadKey = "cv-sw-reloads";
      var attempts = Number(window.sessionStorage.getItem(reloadKey) || "0");

      var reloadIfNeeded = function () {
        if (window.crossOriginIsolated) {
          cleanUrl();
          return;
        }
        if (attempts >= 3) return;
        window.sessionStorage.setItem(reloadKey, String(attempts + 1));
        var url = new URL(window.location.href);
        url.searchParams.set("coi", String(Date.now()));
        window.location.replace(url.toString());
      };

      if (navigator.serviceWorker.controller) {
        reloadIfNeeded();
        return;
      }

      navigator.serviceWorker.addEventListener("controllerchange", reloadIfNeeded, { once: true });
      navigator.serviceWorker.ready.then(function () {
        if (navigator.serviceWorker.controller) reloadIfNeeded();
      });
      window.setTimeout(reloadIfNeeded, 1500);
    })
    .catch(function () {
      // Offline or unsupported: the site still loads, without caching or isolation.
    });
})();
