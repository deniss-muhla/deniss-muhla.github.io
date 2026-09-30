# deniss-muhla.github.io

Personal GitHub Pages site for Deniss Muhla.

## Stack

- React 19
- TypeScript 6.0.2
- CSS Modules
- Vite 8
- GitHub Pages via GitHub Actions

## Development

- `pnpm install`
- `pnpm dev`
- `pnpm typecheck`
- `pnpm cv:build`
- `pnpm lint`
- `pnpm test` (browser-free unit tests)
- `pnpm build` (typecheck and production build)

The checked-in `.npmrc` disables pnpm's peer auto-installation; in particular, this prevents Oxlint's optional Vite+ integration from being installed. The site is a single-page experience with the CV embedded in the main page. The downloadable PDF is generated from the markdown source during the build pipeline.

## On-device voice assistant

The page ships a floating assistant button that runs entirely in the browser — no server, no API keys, nothing leaves the device:

- **Speech to text:** Moonshine Small Streaming (123M) via WASM. Add `?stt=tiny` to the URL to fall back to Tiny Streaming (34M) for slow devices or quick checks.
- **Answer model:** SmolLM2-360M-Instruct via WebLLM/WebGPU (`q4f16` when the adapter exposes `shader-f16`, otherwise `q4f32`).
- **Speech output:** Pocket TTS INT8 (voice `alba`) in a WASM worker.

The public CV markdown is passed to the model as plain prompt context; there are no embeddings and no retrieval. Models start downloading in the background shortly after load (skipped on metered connections), show progress in a ring around the button, and blink once when ready. Opening the panel greets the visitor, speaks the greeting and starts listening; pauses in the transcript commit a turn answer that is shown in the chat and spoken aloud. Typing is always available as a fallback.

### Offline support

`public/sw.js` is a service worker with two jobs:

1. **Cross-origin isolation** — it adds `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` to same-origin responses, which GitHub Pages cannot serve as headers. Moonshine's threaded WASM build needs `SharedArrayBuffer` and therefore `crossOriginIsolated`.
2. **Caching** — the app shell, same-origin assets, Google Fonts and the ONNX Runtime used by Pocket TTS are cached for offline use. Model weights are cached by the libraries themselves (Moonshine, Pocket TTS and WebLLM all use Cache Storage), so the worker does not duplicate those downloads.

After the app shell, same-origin assets and model files have been cached successfully, the service worker is intended to serve them offline and the header shows an offline badge while disconnected. Offline behavior has not been verified against the current shipped build, so full assistant availability is not guaranteed. `public/sw-register.js` reloads once (cache-busting `?coi=` parameter, max three attempts per tab) so the document is served by the worker, and cleans that parameter afterwards. The worker is skipped on localhost unless the URL contains `?sw=1`.

### Local testing

```bash
pnpm dev
pnpm build && pnpm preview:site
pnpm test                 # focused unit tests; no browser or model
pnpm test:browser         # optional headless Chrome test with a fake engine
```

Run one bounded real model smoke separately from the site QA. It uses headed Chrome/WebGPU, the shipping SmolLM2 selection and the complete production prompt. Output contains model/cache identities and timings, not the question or answer:

```bash
timeout --signal=TERM --kill-after=5s 400s pnpm cv:smoke
```

For an end-to-end check of the service worker, offline behaviour and the voice loop, use the Playwright harness. It launches and closes its own browser and serves the production build **without** COOP/COEP headers, the same way GitHub Pages does:

```bash
pnpm build
node scripts/serve-dist.mjs dist 4174      # no COI headers; open with ?sw=1
node scripts/voice-qa.mjs --redacted       # isolation, readiness, typed answer, offline
VOICE_WAV=/tmp/question.wav node scripts/voice-qa.mjs --redacted   # + fake microphone
```

The separate browser integration test uses a fake engine and does not download a model. Redacted QA removes `voiceDebug`, needs no evaluation IDs or interactive terminal, suppresses answer/transcript/error content, and saves no screenshots. It checks readiness and greeting, then an optional fake-microphone turn, typed answer, offline reload and offline model readiness. The microphone baseline is captured before opening the panel starts listening; only a new user message followed by its completed non-greeting reply passes, before the typed question is submitted. Omitting `VOICE_WAV` skips only the microphone check. Failed requested microphone, offline reload or offline readiness checks fail QA. Point `BASE_URL` at the dev server (`pnpm dev`, then `BASE_URL=http://localhost:5173/ node scripts/voice-qa.mjs --redacted`) to check dev serving; offline reload applies to a production build because dev has no service worker. Non-redacted QA is a developer-only mode that can print answers and save `/tmp/voice-qa-*.png`; use `--redacted` when content must not appear in output or captures.

Speech recognition requires a secure context (HTTPS or localhost) and microphone permission; the answer model requires WebGPU. When either is unavailable the widget degrades to typed questions.

The Moonshine runtime is served through the project-owned `/moonshine/` route defined by the `moonshine-runtime-serve` and `moonshine-runtime-build` plugins in `vite.config.ts` instead of being bundled: minifying the Emscripten and streaming code makes transcription fail silently, and the 13 MB WASM does not belong in the JS graph. The dev middleware streams the package's own files and the build plugin emits them into `dist/moonshine/`, so the URL is identical in dev, preview and production. Dev and preview set COOP/COEP; the dev Moonshine route also sets CORP `same-origin`. The service worker adds COOP/COEP to same-origin responses. Without cross-origin isolation, Chrome blocks the pthread worker scripts with `coep-frame-resource-needs-coep-header`.

## CV Source

- Canonical CV markdown: `resources/cv/source/cv.md`
- Public career facts, skills and source policy: [resources/README.md](resources/README.md)
- Detailed supporting documents are stored outside this public repository.
- Generated download artifact: `public/downloads/deniss-muhla-cv.pdf`

## Deployment

GitHub Pages deployment is handled by `.github/workflows/deploy-pages.yml`.
