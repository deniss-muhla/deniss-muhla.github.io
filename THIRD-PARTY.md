# Third-party assets

This site serves its own copy of every third-party file it needs at runtime. The pinned
inventory lives in `scripts/model-assets.mjs`: one entry per file with its same-origin route,
byte count, sha256, source URL and license. The bytes are downloaded into the external cache
`~/.cache/cv-assistant/model-assets/` and emitted into `dist/`; none of them is committed to
git. The totals below were measured on the plain production build.

## Embedding model

`mixedbread-ai/mxbai-embed-xsmall-v1` at revision
`e6ac24e5d6efb8782b59de1647b3ececb4ece94e`, 6 files, 25,393,982 bytes, served from
`/models/mixedbread-ai/mxbai-embed-xsmall-v1/`.

- Source: `https://huggingface.co/mixedbread-ai/mxbai-embed-xsmall-v1/resolve/e6ac24e5d6efb8782b59de1647b3ececb4ece94e/`
- License: Apache-2.0.

## ONNX Runtime Web

MIT for both versions the site serves.

- Version `1.31.0-dev.20260914-8d85527a0`, the `jsep` pair at `/ort/`
  (`ort-wasm-simd-threaded.jsep.mjs`, `ort-wasm-simd-threaded.jsep.wasm`), 28,399,736 bytes.
  The files are served byte for byte from the installed `onnxruntime-web` package.
- Version `1.20.0`, the trio at `/models/onnxruntime-web/1.20.0/` (`ort.min.mjs`,
  `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm`), 11,712,424 bytes, fetched from
  `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/`. Pocket TTS loads this version.

Project: `https://github.com/microsoft/onnxruntime`, licensed MIT.

## Pocket TTS

- Library: `pocket-tts-js` 0.1.0, MIT, `https://github.com/vlapky/pocket-tts-js`.
- Model weights: 7 files, 177,861,718 bytes, served from
  `/models/pocket-tts/onnx/english_2026-04/`, pinned at
  `https://huggingface.co/vlapky/pocket-tts-onnx/resolve/c469236dbc5f68287fa2fbf175b66de3b80123af/onnx/english_2026-04/`.

Attribution: the Pocket TTS model weights and the built-in voice assets are © Kyutai and are
licensed under CC-BY-4.0, `https://creativecommons.org/licenses/by/4.0/`; see
`https://huggingface.co/kyutai/pocket-tts`. Using those assets keeps that attribution
requirement, independently of the library's MIT license.

## Fonts

SIL Open Font License 1.1 per family. 16 woff2 files (latin and latin-ext), 426,740 bytes,
served from `/fonts/`, fetched from `https://fonts.googleapis.com/css2` with a Chrome user
agent and `https://fonts.gstatic.com`.

Families: Archivo, Bricolage Grotesque, JetBrains Mono, Libre Baskerville, Outfit,
Playfair Display.

## Moonshine speech-to-text

- Runtime: `@moonshine-ai/moonshine-wasm` 0.1.5, MIT, `https://moonshine.ai`. 25 files,
  13,474,000 bytes, served unmodified from the project-owned `/moonshine/` route.
- Model: the page never tells the runtime where a model lives, so the runtime downloads the
  streaming model from its own default base `https://download.moonshine.ai/model` and keeps it
  in its own `moonshine-models-v1` cache. The self-hosted small set (7 files, 165,489,086
  bytes, MIT, source
  `https://download.moonshine.ai/model/small-streaming-en/quantized_26_07_30/`) also ships at
  `/models/moonshine/small-streaming-en/quantized_26_07_30/`, but no shipped code requests
  that route yet. It is swap-pending dead weight: the Whistle Phase 1 work removes it from the
  manifest and from `dist/`.
