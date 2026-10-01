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
- **Answer model:** TRLM-135M (`q4f32_1`) via WebLLM/WebGPU, converted from `Shekswess/trlm-135m` and served from this repository at `/models/trlm-135m/resolve/main/`, described in [Answer model](#answer-model) below.
- **Speech output:** Pocket TTS INT8 (voice `alba`) in a WASM worker.

The public CV markdown is passed to the model as plain prompt context; there are no embeddings and no retrieval. Models start downloading in the background shortly after load, show progress in a ring around the button, and blink once when ready. On a metered connection the background download is skipped and nothing loads without a click: opening the panel starts the same load and shows real progress while typed input stays available. Opening the panel greets the visitor, speaks the greeting and starts listening once the models report ready; pauses in the transcript commit a turn answer that is shown in the chat and spoken aloud. Typing is always available as a fallback, and the status line names a model that could not load instead of claiming readiness.

### Offline support

`public/sw.js` is a service worker with two jobs:

1. **Cross-origin isolation** — it adds `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` to same-origin responses, which GitHub Pages cannot serve as headers. Moonshine's threaded WASM build needs `SharedArrayBuffer` and therefore `crossOriginIsolated`.
2. **Caching** — the app shell, same-origin assets, Google Fonts and the ONNX Runtime used by Pocket TTS are cached for offline use. Model weights are cached by the libraries themselves (Moonshine, Pocket TTS and WebLLM all use Cache Storage), so the worker does not duplicate those downloads, including the same-origin answer model under `/models/`.

After the app shell, same-origin assets and model files have been cached successfully, the service worker is intended to serve them offline and the header shows an offline badge while disconnected. Offline behavior has not been verified against the current shipped build, so full assistant availability is not guaranteed. `public/sw-register.js` reloads once (cache-busting `?coi=` parameter, max three attempts per tab) so the document is served by the worker, and cleans that parameter afterwards. The worker is skipped on localhost unless the URL contains `?sw=1`.

### Local testing

```bash
pnpm dev
pnpm build && pnpm preview:site
pnpm test                 # focused unit tests; no browser or model
pnpm test:browser         # optional headless Chrome test with a fake engine
```

Run one bounded real model smoke separately from the site QA. It uses headed Chrome/WebGPU, the shipped answer-model pair and the complete production prompt. Output contains model/cache identities and timings, not the question or answer:

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

## Answer model

The site answers with TRLM-135M, converted from [`Shekswess/trlm-135m`](https://huggingface.co/Shekswess/trlm-135m) at revision `eb6adefde3066b2555a4f88aae9843fcb528d87a` and served from this repository in `public/models/trlm-135m/`. `PROVENANCE.md` in that directory records the byte sizes and SHA-256 digests, which notices were copied from where, what the runtime was measured not to need, and which upstream notices are still unresolved. The model card for that checkpoint warns of frequent hallucinations and reasoning errors; nothing below is evidence about answer quality.

The weights are requested from `/models/trlm-135m/resolve/main/`, the path WebLLM fetches every asset from, which assumes this site is served from the domain root; the project sets no Vite `base`. WebLLM's own Cache Storage keeps the files, and the service worker deliberately passes them through instead of keeping a second copy.

All conversion and compilation work lives in one external working directory, `$HOME/.cache/cv-assistant/trlm-eb6adefde3066b2555a4f88aae9843fcb528d87a`, where `$HOME` stands in for the account that runs the commands below. The 269,062,856-byte BF16 checkpoint, the Python, MLC, TVM and Emscripten toolchains, the caches and the build trees stay in that directory. None of them belongs in this public repository.

Pinned inputs:

- Source `Shekswess/trlm-135m` at revision `eb6adefde3066b2555a4f88aae9843fcb528d87a`, Apache 2.0 declared in the model card, no standalone license file in that revision.
- Python 3.11.16 in an isolated venv, MLC `2008fe8343e1f40ef89ee57b9287aebcf1b86c98`, TVM `bc1a904ec1ad89454ee6577d66cde1268b8f6bc8`, host LLVM 22.1.8.
- Emscripten 3.1.74 with Binaryen 120_b and its own Node 24.19.0. This is a deliberate deviation from the install note in the pinned MLC tree: host LLVM 22 writes `bulk-memory-opt` and `call-indirect-overlong` target features that the Binaryen shipped with Emscripten 3.1.56 rejects.
- WebLLM 0.2.85 from `node_modules`, used only to load and check the pair.

Selected quantization and context: `q4f32_1`, context window 4096, batch size 1, prefill chunk 4096, vocabulary 49,154 including the added tokens 49,152 and 49,153.

Regenerate, with `$W` set to the working directory above. The conversion runs through `checks/run_bounded_q4f32_conversion.py`, the wrapper that produced the candidate. It re-hashes the pinned checkpoint and `config.json`, creates `$W/model/conversion-input-q4f32_1` with a symlink to the pinned checkpoint and nothing else, sets `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `TVM_NUM_THREADS=2` and `TOKENIZERS_PARALLELISM=false`, unsets `MLC_LIBRARY_PATH`, `TVM_LIBRARY_PATH` and `MLC_INTERNAL_PRESHARD_NUM`, and refuses to start while `$W/model/conversion-input-q4f32_1` or `$W/model/converted-q4f32_1-weights` exists, so remove both first. The wrapper's own `mlc_llm convert_weight` call then adds `model.safetensors.index.json` to that same input directory. The compile below unsets `MLC_LIBRARY_PATH` and `TVM_LIBRARY_PATH`. The two `gen_config` scripts take the workspace path as their only argument and refuse to overwrite an existing output directory, so remove it first:

```bash
python3 $W/checks/run_bounded_q4f32_conversion.py

# plain gen_config output, kept only as the preserved base config
$W/env/mlc/bin/python $W/checks/generate_trlm_config.py $W
# boundary config, written to its own directory
# $W/model/config-q4f32_1-context4096-batch1-token-boundary
$W/env/mlc/bin/python $W/checks/generate_trlm_boundary_config.py $W
# install that config in the candidate directory and re-hash the 11 files
python3 $W/checks/verify_candidate_config_update.py --apply

cd $W/build/webgpu-313/mlc && env -u MLC_LIBRARY_PATH -u TVM_LIBRARY_PATH \
  HOME=$W/home TVM_HOME=$W/build/webgpu-313/tvm \
  PYTHONPATH=$W/source/tvm/python \
  LD_LIBRARY_PATH=$W/build/tvm-compiler-llvm22/lib:$W/build/mlc-native-staged-overlay/lib \
  OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 EMSDK_QUIET=1 \
  PATH=$W/source/emsdk-313r-e566f7bdcc7735f44037911c24b87a58a3c93145:$W/source/emsdk-313r-e566f7bdcc7735f44037911c24b87a58a3c93145/upstream/emscripten:$W/source/emsdk-313r-e566f7bdcc7735f44037911c24b87a58a3c93145/node/24.19.0_64bit/bin:$PATH \
  EM_CONFIG=$W/source/emsdk-313r-e566f7bdcc7735f44037911c24b87a58a3c93145/.emscripten \
  EM_CACHE=$W/source/emsdk-313r-e566f7bdcc7735f44037911c24b87a58a3c93145/upstream/emscripten/cache \
  timeout --signal=TERM --kill-after=20 2400 \
  $W/env/mlc/bin/mlc_llm compile $W/model/converted-q4f32_1-weights \
  --device webgpu --output $W/model/compiled-webgpu/trlm-135m-q4f32_1-webgpu.wasm
```

The two generation scripts only write into their own output directories. `verify_candidate_config_update.py` is the step that puts the boundary `mlc-chat-config.json` into `$W/model/converted-q4f32_1-weights`, and the compile in the block above has to run after it, or the library is built against the other config. That script hardcodes the working directory, as the conversion wrapper does, and compares the 11 candidate files against `$W/logs/312-artifact-validation.json`, so a clean-room workspace needs that manifest in `$W/logs/` first, and it needs the plain `gen_config` output as the preserved base config.

The conversion directory holds 11 files and 80,741,610 bytes, and the compiled library is 5,677,823 bytes:

```bash
sha256sum $W/model/converted-q4f32_1-weights/* $W/model/compiled-webgpu/trlm-135m-q4f32_1-webgpu.wasm
```

The pair that was actually loaded, by size and SHA-256:

- Source checkpoint `model/source/model.safetensors`: 269,062,856 bytes, `f72be34d84f9d95d2f1ba9e6aa5d352ec841ce1e7aed81998135ce5bf96e9a09`.
- Candidate config `converted-q4f32_1-weights/mlc-chat-config.json`: 2,212 bytes, `6cf1e49b0baf59ed74c7cdc2e7927bd2e5b6efd7849d81ff5f6dbb81202eb94a`.
- Compiled library `compiled-webgpu/trlm-135m-q4f32_1-webgpu.wasm`: 5,677,823 bytes, `2d21eb8f7c8bd231755e041e89793abb8536e63c8350bd33cdaab40e63c0e709`.

The recorded expectations for the other nine candidate files are in `$W/logs/314-provenance-and-rights.txt`.

The conversion produces 11 files, but `public/models/trlm-135m/resolve/main/` holds seven: `mlc-chat-config.json`, `tokenizer.json`, `tensor-cache.json`, the three `params_shard_*.bin` shards and the compiled library. A cold-cache browser load of the production build requested exactly those seven and nothing else, and loading the shipped copy through the assistant's own path in headed Chrome requested the same seven with the same digests. So `added_tokens.json`, `merges.txt`, `tensor-cache-b16.json`, `tokenizer_config.json` and `vocab.json` stay outside the repository, where the conversion still produces them, and `pnpm test` hashes the seven that are shipped. `PROVENANCE.md` records the digests and that measurement.

The browser check serves those exact bytes from the working directory to a headed Chrome that loads them through WebLLM 0.2.85, hashes what the runtime actually fetched, and then runs a single-token forward pass on the default prompt. It launches Chrome with `--enable-unsafe-webgpu`, blocks the service worker in the browser context, serves a plain page with no COOP or COEP headers, and gives the forward pass a one-character user turn instead of a real question, so it measures the load and not an answer. Its harness also stays in the working directory:

```bash
timeout --signal=TERM --kill-after=10s 600s node $W/checks/verify_browser_load_314.mjs
```

Set `TRLM_SMOKE_32=1` for the same harness's second mode, which streams a bounded generation instead of a forward pass and reports load and generation durations, token counts and the cache identities. It stays unscored and retains no prompt, question or answer.

Other bytes can be tried against the same assistant without changing this repository. The engine loads a pair named in the page URL instead of the shipped one: `?llmPreview=1` opts in, `?llmModelUrl=` and `?llmWasmUrl=` say where the operator serves the weights directory and the compiled library, and the chat panel names the model that is answering. Nothing is stored, so removing `llmPreview` and reloading returns to the shipped pair; an opt-in without usable URLs is reported instead of silently falling back. The two URLs must be absolute `http` or `https` URLs on the same origin as the page, the weights URL ending in `/` and the library URL in `.wasm`, with no query and no fragment: WebLLM appends every asset name to the weights URL, so anything else resolves to the wrong path. The page is cross-origin isolated and served over HTTPS, so the pair has to come from the page's own origin, because another origin is mixed content or a blocked fetch there and a link from elsewhere must not be able to choose the bytes this site downloads, executes and caches. A local comparison therefore serves the site and the other pair from one local origin rather than two. The shipped pair already comes from the site itself at `/models/trlm-135m/resolve/main/`, so the preview URLs only matter for comparing against another conversion. `checks/verify_preview_33.mjs` in the working directory checks entry, the exact pair, the unchanged default, the way back and the refusal of a pair on another origin, in headed Chrome with the repository's own COOP/COEP headers, against both the dev server and the production build:

```bash
TRLM_PREVIEW_SCENARIO=source_on timeout --signal=TERM --kill-after=10s 600s node $W/checks/verify_preview_33.mjs
```

Before these files are replaced by a rebuild, and before any new copy reaches `public/models/trlm-135m/resolve/main/`, the same checks have to pass again: the exact SHA-256 and byte size of all 11 files and the library, the vocabulary check below, and a successful load in headed Chrome with the installed WebLLM 0.2.85. The delivered copies are also pinned by `pnpm test`, which hashes the seven shipped files and fails if one of the five measured-unused files appears beside them. `verify_candidate_config_update.py` compares file hashes, the 11-file inventory, the total bytes and the 100 MiB limit, so the vocabulary has to be read from the candidate files directly:

```bash
python3 -c "import json; c=json.load(open('$W/model/converted-q4f32_1-weights/mlc-chat-config.json')); a=json.load(open('$W/model/converted-q4f32_1-weights/added_tokens.json')); print(c['vocab_size'], c['active_vocab_size'], sorted(a.values()))"
```

Expected `49154 49154 [49152, 49153]`.

The `LICENSE` and `NOTICE` files of MLC and TVM and the `LICENSE` files of Emscripten and Node exist in the pinned toolchains at the sizes and hashes in `$W/logs/314-provenance-and-rights.txt`. No notice text is embedded in the 5,677,823-byte library, so the applicable ones travel with the pair in `public/models/trlm-135m/`: the canonical Apache 2.0 text, the MLC LLM and TVM notices, the bundled-third-party section of the TVM license, and the Emscripten and Node licenses. `PROVENANCE.md` records where each copy came from and its digest.

One rights item stays open and is stated in `PROVENANCE.md` rather than resolved: the pinned `Shekswess/trlm-135m` tree declares Apache 2.0 in its metadata and README but ships no standalone license file, and it carries no attribution, license or notice for the base model it was fine-tuned from or for its tokenizer. Those upstream notices cannot be manufactured here, so this repository does not claim that redistribution of the derived weights is legally sufficient.

The recorded library was linked from bitcode that Emscripten 3.1.56 produced and that the 3.1.74 link consumed without rebuilding, so a clean rebuild can produce different bytes. Compare a rebuilt library against the hash above: it identifies the pair that was actually loaded and is not a build target.

## CV Source

- Canonical CV markdown: `resources/cv/source/cv.md`
- Public career facts, skills and source policy: [resources/README.md](resources/README.md)
- Detailed supporting documents are stored outside this public repository.
- Generated download artifact: `public/downloads/deniss-muhla-cv.pdf`

## Deployment

GitHub Pages deployment is handled by `.github/workflows/deploy-pages.yml`.
