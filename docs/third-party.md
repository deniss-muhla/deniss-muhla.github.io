# Third-party assets

The pinned third-party runtime inventory lives in `scripts/model-assets.mjs`: one entry per file with its
same-origin route, byte count, sha256, source URL and license. Runtime assets are copied from the
external cache `~/.cache/cv-assistant/model-assets/` into `dist/`. None of those runtime/model files is
committed to git. The byte counts below are pinned inventory values, not a total for the production build.

## Embedding model

`mixedbread-ai/mxbai-embed-xsmall-v1` at revision
`e6ac24e5d6efb8782b59de1647b3ececb4ece94e`, 6 files, 25,393,982 bytes, served from
`/models/mixedbread-ai/mxbai-embed-xsmall-v1/`.

- Source: `https://huggingface.co/mixedbread-ai/mxbai-embed-xsmall-v1/resolve/e6ac24e5d6efb8782b59de1647b3ececb4ece94e/`
- License: Apache-2.0.

## Paradee speech model

`sahilmahendrakar/Paradee-8M-v1.1` at revision
`330617ad1f097b4f6b02c103e54b39006c090b45`, 3 files, 8,466,709 bytes, served from
`/models/sahilmahendrakar/Paradee-8M-v1.1/`. The int8 ONNX model is 8,461,438 bytes.

- Source: `https://huggingface.co/sahilmahendrakar/Paradee-8M-v1.1/tree/330617ad1f097b4f6b02c103e54b39006c090b45`
- License: Apache-2.0.

## ONNX Runtime Web

Version `1.31.0-dev.20260914-8d85527a0`, the `jsep` pair at `/ort/`
(`ort-wasm-simd-threaded.jsep.mjs`, `ort-wasm-simd-threaded.jsep.wasm`), 28,399,736 bytes.
The files are served byte for byte from the installed `onnxruntime-web` package under the MIT
license.

Project: `https://github.com/microsoft/onnxruntime`.

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

## Paradee phonemization

The runtime uses `phonemizer` 1.2.1 by Xenova, declared Apache-2.0 by its npm package.
It embeds eSpeak NG-derived code and data; its upstream component terms need independent
license review before public distribution. The conversion in
`src/chat/tts/paradee/tokenizer.ts` follows Paradee v1.1 `web/misaki.js` by
sahilmahendrakar, Apache-2.0. No legal clearance is claimed.
