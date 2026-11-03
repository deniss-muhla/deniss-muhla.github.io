# Third-party assets

The pinned third-party runtime inventory lives in `scripts/model-assets.mjs`: one entry per file with its
same-origin route, byte count, sha256, source URL and license. Runtime assets are copied from the
external cache `~/.cache/cv-assistant/model-assets/` into `dist/`. Kitten generation uses explicit
external runtime/model inputs and adds no model files to the site. None of those runtime/model files is
committed to git. The byte counts below are pinned inventory values, not a total for the production build.

## Embedding model

`mixedbread-ai/mxbai-embed-xsmall-v1` at revision
`e6ac24e5d6efb8782b59de1647b3ececb4ece94e`, 6 files, 25,393,982 bytes, served from
`/models/mixedbread-ai/mxbai-embed-xsmall-v1/`.

- Source: `https://huggingface.co/mixedbread-ai/mxbai-embed-xsmall-v1/resolve/e6ac24e5d6efb8782b59de1647b3ececb4ece94e/`
- License: Apache-2.0.

## ONNX Runtime Web

Version `1.31.0-dev.20260914-8d85527a0`, the `jsep` pair at `/ort/`
(`ort-wasm-simd-threaded.jsep.mjs`, `ort-wasm-simd-threaded.jsep.wasm`), 28,399,736 bytes.
The files are served byte for byte from the installed `onnxruntime-web` package under the MIT
license.

Project: `https://github.com/microsoft/onnxruntime`.

## Kitten-generated assistant audio provenance

The v2 assistant corpus was prepared with the pinned local `kittenml` SDK 0.9.4 source
(commit `8ed679c08e0976b236bd5d0dc4ec9ddd98b0da98`, archive SHA-256 recorded in
`scripts/cv-audio/kitten-pins.json`; SDK license: Apache-2.0) and the pinned
`KittenML/kitten-tts-2` model revision `f2eee74f4467855ad58fe16f1fb7b7df473263fd`.
The pin metadata identifies the model license as the Stellon Labs Community License. A pinned
Chatterbox-Turbo decoder asset is also used by the local adapter. The SDK and model terms are
distinct; this provenance record does not assess the model/decoder terms or establish permission
to publicly distribute generated audio. No legal clearance or publication acceptance is claimed.
The SDK, weights, decoder and runtime roots remain external and are not included in the site.

## Fonts

SIL Open Font License 1.1 per family. 16 woff2 files (latin and latin-ext), 426,740 bytes,
served from `/fonts/`, fetched from `https://fonts.googleapis.com/css2` with a Chrome user
agent and `https://fonts.gstatic.com`.

Families: Archivo, Bricolage Grotesque, JetBrains Mono, Libre Baskerville, Outfit,
Playfair Display.

## Whistle speech-to-text

Two pinned pairs from Cactus-Compute, served byte for byte from the external asset cache.

- Engine runtime: `Cactus-Compute/needle3` at revision
  `2ae11323dc000f5e70c49f7403efa6af12ba9e67`, 2 files, 986,420 bytes (`needle.js` 63,072,
  `needle.wasm` 923,348), served from `/models/cactus-needle/wasm/`.
  Source: `https://huggingface.co/Cactus-Compute/needle3/resolve/2ae11323dc000f5e70c49f7403efa6af12ba9e67/wasm`.
- Speech model: `Cactus-Compute/whistle` at revision
  `b358ddadd89b7a713b5aa131f23032d3cca1b251`, `whistle.cact`, 16,919,407 bytes, served from
  `/models/cactus-needle/whistle/`.
  Source: `https://huggingface.co/Cactus-Compute/whistle/resolve/b358ddadd89b7a713b5aa131f23032d3cca1b251/whistle.cact`.

Both are licensed under Apache-2.0, `http://www.apache.org/licenses/LICENSE-2.0`. Their license
text is the same 11,358-byte file (sha256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`),
kept with the downloaded bytes in `~/.cache/cv-assistant/model-assets/` rather than in git.
Attribution: the runtime and the model are by Cactus-Compute and are used unmodified under that
license; the site serves its own copies at the routes above and reaches no Cactus-Compute host.
