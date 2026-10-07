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
- `pnpm cv:facts`, `pnpm cv:facts:embed`, `pnpm cv:facts:check`, `pnpm cv:facts:promote` (the reviewed answer index; see below)

The checked-in `.npmrc` disables pnpm's peer auto-installation; in particular, this prevents Oxlint's optional Vite+ integration from being installed. The site is a single-page experience with the CV embedded in the main page. The downloadable PDF is generated from the markdown source during the build pipeline.

## On-device voice assistant

The page ships a floating assistant button that runs entirely in the browser — no server, no API keys, nothing leaves the device:

- **Speech to text:** Moonshine Small Streaming (123M) via WASM. Add `?stt=tiny` to the URL to fall back to Tiny Streaming (34M) for slow devices or quick checks.
- **Answers:** on-device retrieval over a reviewed answer index. A small embedding model matches the question to a prepared answer in CPU WebAssembly; nothing is generated at runtime.
- **Speech output:** Pocket TTS INT8 (voice `alba`) in a WASM worker.

Questions are matched against the reviewed answer index on the device; no prompt and no model output is involved. Models start downloading in the background shortly after load (skipped on metered connections), show progress in a ring around the button, and blink once when ready. Opening the panel greets the visitor, speaks the greeting and starts listening; pauses in the transcript commit a turn answer that is shown in the chat and spoken aloud. Typing is always available as a fallback.

### Offline support

`public/sw.js` is a service worker with two jobs:

1. **Cross-origin isolation** — it adds `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` to same-origin responses, which GitHub Pages cannot serve as headers. Moonshine's threaded WASM build needs `SharedArrayBuffer` and therefore `crossOriginIsolated`.
2. **Caching** — the app shell, same-origin assets, Google Fonts and the ONNX Runtime used by Pocket TTS are cached for offline use. Model weights are cached by the libraries themselves (Moonshine, Pocket TTS and the embedding model all use Cache Storage), so the worker does not duplicate those downloads.

After the app shell, same-origin assets and model files have been cached successfully, the service worker is intended to serve them offline and the header shows an offline badge while disconnected. Offline behavior has not been verified against the current shipped build, so full assistant availability is not guaranteed. `public/sw-register.js` reloads once (cache-busting `?coi=` parameter, max three attempts per tab) so the document is served by the worker, and cleans that parameter afterwards. The worker is skipped on localhost unless the URL contains `?sw=1`.

### Local testing

```bash
pnpm dev
pnpm build && pnpm preview:site
pnpm test                 # focused unit tests; no browser or model
pnpm test:browser         # optional headless Chrome test with a fake engine
```

Run one bounded technical smoke separately from the site QA. It is the CPU retrieval check, not an answer-quality check: it walks five stages (source, index, startup, model-load, query), verifies the reviewed index and the pinned encoder assets, and prints one report of redacted technical metadata. Every field is a digest, a pinned identity, a byte count, a duration, a URL or a fixed enum, and a failure reports only one of the five stage names:

```bash
timeout --signal=TERM --kill-after=5s 400s pnpm cv:smoke
```

For an end-to-end check of the service worker, the voice loop and the answer path, use the QA harness. It launches and closes its own browser and serves the production build **without** COOP/COEP headers, the same way GitHub Pages does:

```bash
pnpm build
node scripts/serve-dist.mjs dist 4174      # no COI headers; open with ?sw=1
node scripts/voice-qa.mjs --redacted       # readiness, typed answer, clarification, offline, metered
VOICE_WAV=/tmp/question.wav node scripts/voice-qa.mjs --redacted   # + fake microphone
```

The separate browser integration test uses a fake engine and does not download a model. Redacted QA removes `voiceDebug`, needs no evaluation IDs or interactive terminal, suppresses answer/transcript/error content, and saves no screenshots. It checks readiness and greeting, then an optional fake-microphone turn followed by the same question typed by hand (both paths must give the same outcome, answer, cleanup and spoken output), a typed answer through the retrieval path (resolving a clarification choice when one is offered, and failing on a notice or error instead of an answer), resize to 414x800 and back with the chat open, message-list scrolling, exit with the chat open without adding a message, the offline reload with the models still usable, and the metered lifecycle: the data-saving notice before any model request, loading only after the explicit open, a typed question while the models load, and readiness with the panel closed. The fake-microphone timeline behind the voice and parity checks records status states, the user-message count and the speech-failure flag, never message text. The microphone baseline is captured before opening the panel starts listening; only a new user message followed by its completed non-greeting reply passes, before the typed question is submitted. Omitting `VOICE_WAV` skips only the microphone and parity checks. A failed requested microphone turn or its speech evidence, parity, resize, scroll or exit check, offline reload, offline readiness, typed answer or metered step fails QA. Point `BASE_URL` at the dev server (`pnpm dev`, then `BASE_URL=http://localhost:5173/ node scripts/voice-qa.mjs --redacted`) to check dev serving; offline reload applies to a production build because dev has no service worker. Non-redacted QA is a developer-only mode that can print answers and save `/tmp/voice-qa-*.png`; use `--redacted` when content must not appear in output or captures.

Speech recognition requires a secure context (HTTPS or localhost), microphone permission and cross-origin isolation. When live voice is unavailable the widget degrades to typed questions.

The Moonshine runtime is served through the project-owned `/moonshine/` route defined by the `moonshine-runtime-serve` and `moonshine-runtime-build` plugins in `vite.config.ts` instead of being bundled: minifying the Emscripten and streaming code makes transcription fail silently, and the 13 MB WASM does not belong in the JS graph. The dev middleware streams the package's own files and the build plugin emits them into `dist/moonshine/`, so the URL is identical in dev, preview and production. Dev and preview set COOP/COEP; the dev Moonshine route also sets CORP `same-origin`. The service worker adds COOP/COEP to same-origin responses. Without cross-origin isolation, Chrome blocks the pthread worker scripts with `coep-frame-resource-needs-coep-header`.

## CV Source

- Canonical CV markdown: `resources/cv/source/cv.md`, the single authoritative fact source
- Reviewed answer index: `resources/cv/facts.json`, one derived file regenerated from that CV
- Public career facts, skills and source policy: [resources/README.md](resources/README.md)
- Detailed supporting documents are stored outside this public repository.
- Generated download artifact: `public/downloads/deniss-muhla-cv.pdf`

## Answer index

`resources/cv/facts.json` is the reviewed answer index, prepared so the assistant can select one
prepared answer instead of generating text. It is derived from the canonical CV and is the only
derived file kept here: the analysis, the candidate, the per-section snapshots and the model caches
all stay in a workspace outside this repository. It currently holds 36 reviewed cards with
384-dimension vectors. The shipped assistant reads it: the engine selects one prepared answer from
this index, so no answer is generated from the CV text. The module that selects from the index
lives in `src/chat/retrieval` and is documented there. It does contain the query side:
`src/chat/retrieval/encoder` embeds one
trimmed question in a module worker with the pinned model, and is the only place that imports the
embedding library. `node scripts/voice-qa.mjs --qa=retrieval --routing=dev` and `--routing=built` drive it in
headed Chrome in both routings, through the same harness entry point as the voice workload;
running `node scripts/retrieval-qa.mjs --routing=dev` calls the same run. The built run needs
`RETRIEVAL_QA=1 pnpm build` first, because a
production build only includes that private page when it is asked for.

Every change follows the same order: prepare, author, source review, embed, check, promote.

- `pnpm cv:facts --out <dir>` reads the canonical CV and writes `analysis.json` and a
  `facts.candidate.json` scaffold into a workspace directory outside this repository. It reaches no
  hosted provider and no model. It refuses to overwrite a candidate you already authored unless you
  pass `--force`.
- Author the candidate by hand in that external workspace: a `topic`, descriptive `tags`, the
  `sourceRefs` lines each answer came from, and one concise `answer` per card. Leave `vector` empty.
- Source-review every answer against the referenced source lines, as an independent reviewer with a
  recorded outcome. A review record states the run, the date, the card ids and any findings.
- `pnpm cv:facts:embed --candidate <path>` computes the embedding vectors for one named candidate
  and records what produced them. This is the only script that reaches the network, and only for
  the pinned model at its pinned revision. Model caches stay outside the repository; pass
  `--cache <dir>` to choose one.
- `pnpm cv:facts:check --candidate <path>` validates offline. It writes nothing and runs no model.
  It checks the raw source digest, the artifact version and shape, unique card ids, nonempty fields,
  source line ranges inside the document, the pinned embedding identity, the content digest and the
  stored vectors. The format is closed, so a field it does not declare is refused rather than
  carried along. Run it with no argument to check the reviewed index instead; `build` and `build:site`
  both do that, so a stale index fails the build. It reports that it proves neither answer truth nor
  retrieval quality; that comes from reviewing every answer against the source.
- `pnpm cv:facts:promote --candidate <path> --confirm-reviewed` validates first, then replaces the
  reviewed index atomically. A failure leaves the previous index untouched. The flag acknowledges a
  recorded independent source review; it is not that review's evidence and not owner acceptance.
  Nothing is staged or committed.

Coverage is recorded as mapped source units plus deliberate omissions. Every extracted unit has at
least one card drawing on it, and the omissions that remain are recorded individually with their
reasons in the external workspace. A mapped unit means only that some card draws on it, not that
every fact inside it is answered, so this is neither a claim that every visitor question is covered
nor a claim that every fact in the CV is answered. There is no card count target.

Any edit to the canonical CV or to a card's text invalidates the index, because the artifact records
the raw source digest and a content digest over each card's id, topic, tags and answer. A CV change
means regenerating the whole candidate and having an independent reviewer source-review the whole
regenerated index, not only the answers that look affected, then re-embed, re-check and promote;
there is no partial card migration. The `.agents/skills/cv-facts` skill documents that workflow in
full, including the pnpm argument form the commands need.

## Deployment

GitHub Pages deployment is handled by `.github/workflows/deploy-pages.yml`.
