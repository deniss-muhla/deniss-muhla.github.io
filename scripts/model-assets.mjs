/**
 * The pinned inventory of third-party runtime assets this site serves itself.
 *
 * Every file the page used to reach a vendor for at runtime is listed here with its
 * same-origin route, exact byte count, sha256, source URL and license. The Vite
 * `model-assets-*` and `fonts-*` plugins serve and emit exactly these files,
 * `fetch-model-assets.mjs` downloads them into the external cache and refuses a byte
 * that does not match, and the QA harness locks the offline scope to these routes.
 *
 * The cache lives outside the repository (`~/.cache/cv-assistant/model-assets/<id>/<rev>/`)
 * and the emitted copies live only in `dist/`; no asset in this manifest may enter git.
 *
 * A change to a vendor set means updating the file and re-running
 * `node scripts/fetch-model-assets.mjs`, which re-verifies every pinned digest.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Where `fetch-model-assets.mjs` keeps the verified bytes. Outside the repository. */
export const MODEL_ASSETS_CACHE = join(homedir(), ".cache", "cv-assistant", "model-assets");

/** The accepted probe workspace whose Hugging Face mirror seeds the embedding set. */
export const MODEL_ASSETS_SEED_DIR =
  process.env.PROBE_DIR ?? "/home/den/.cache/cv-assistant/retrieval-first-probe-mxbai";

/**
 * One vendor set: a pinned source location plus its files.
 *
 * `route` and `source` are the bases a file's own name is appended to, so every file's
 * full route and URL are pinned by two values and one name instead of repeated strings.
 * The `fonts` set carries absolute per-file sources because gstatic URLs are content
 * paths, not a name under a base.
 */
export const MODEL_ASSET_SETS = Object.freeze([
  {
    id: "mxbai-embed-xsmall-v1",
    rev: "e6ac24e5d6efb8782b59de1647b3ececb4ece94e",
    route: "/models/mixedbread-ai/mxbai-embed-xsmall-v1/",
    source:
      "https://huggingface.co/mixedbread-ai/mxbai-embed-xsmall-v1/resolve/e6ac24e5d6efb8782b59de1647b3ececb4ece94e",
    license: "Apache-2.0",
    files: [
      { name: "config.json", bytes: 675, sha256: "55f755d351fd04b0fef37760e07e195eb47e15f7aed6fc42d9be3dde3d38bca4" },
      { name: "tokenizer.json", bytes: 711_661, sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0" },
      { name: "tokenizer_config.json", bytes: 1_433, sha256: "bd2e06a5b20fd1b13ca988bedc8763d332d242381b4fbc98f8fead4524158f79" },
      { name: "special_tokens_map.json", bytes: 695, sha256: "5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a" },
      { name: "vocab.txt", bytes: 231_508, sha256: "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3" },
      { name: "onnx/model_quantized.onnx", bytes: 24_448_010, sha256: "952f996d8cf46c311ee8654a750fa942b71c8b94aabe69d043dbb2bcaff5528e" },
    ],
  },
  {
    id: "moonshine-small-streaming-en",
    rev: "quantized_26_07_30",
    route: "/models/moonshine/small-streaming-en/quantized_26_07_30/",
    source: "https://download.moonshine.ai/model/small-streaming-en/quantized_26_07_30",
    license: "MIT",
    files: [
      { name: "adapter.ort", bytes: 2870368, sha256: "c665f742364febad597cc9ac1e0b341ffbee0e24a1466e2f3bde95e6e4771762" },
      { name: "cross_kv.ort", bytes: 5356536, sha256: "e2d3417144e9514055ebfefe8dcc4c0a55a55adcb8530435844c75c53e352bf6" },
      { name: "decoder_kv.ort", bytes: 81878600, sha256: "1a05465b1dd955858dfcbee039c0020fb5dd982b0f5094c34e61735d518d771b" },
      { name: "encoder.ort", bytes: 44148576, sha256: "2d4d973e91e8aca08c51e7e7efa28a46ab265b63d809d5294d18b86bcd85b993" },
      { name: "frontend.ort", bytes: 30984520, sha256: "d1be8145bc9ef3e8625bb7bcb7a5b2930eeb828c91d6c1897bc215d7de6f2b93" },
      { name: "streaming_config.json", bytes: 512, sha256: "26f02b6afb22d60871a5efd85c3d38e569cc0ddb6c5eb6e93d3260152ae8a47a" },
      { name: "tokenizer.bin", bytes: 249974, sha256: "6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d" },
    ],
  },
  {
    id: "pocket-tts-onnx",
    rev: "c469236dbc5f68287fa2fbf175b66de3b80123af",
    route: "/models/pocket-tts/onnx/english_2026-04/",
    source:
      "https://huggingface.co/vlapky/pocket-tts-onnx/resolve/c469236dbc5f68287fa2fbf175b66de3b80123af/onnx/english_2026-04",
    license: "CC-BY-4.0",
    files: [
      { name: "bundle.json", bytes: 24381, sha256: "bab643150f437f37df080a710520ff39ed9ebd9a339f8ebdc739f7eddfc28b3f" },
      { name: "tokenizer.model", bytes: 59339, sha256: "d461765ae179566678c93091c5fa6f2984c31bbe990bf1aa62d92c64d91bc3f6" },
      { name: "text_conditioner_int8.onnx", bytes: 16388384, sha256: "24c0642bff11a4e1435c004d0c2aa6c68e093fadfa35f0f0dba849ac67f25ac3" },
      { name: "flow_lm_main_int8.onnx", bytes: 76341079, sha256: "f9bd8106b79a0192c1c43399ab938fb24900a95c1c599870d75a884e99000116" },
      { name: "flow_lm_flow_int8.onnx", bytes: 9962530, sha256: "3dd781ee5abee9e195320bf0106bebd6372a852b3b36352524ee78b40554635d" },
      { name: "mimi_decoder_int8.onnx", bytes: 22684077, sha256: "3630450a3297a101792a6ac66619ebc70ab916b265e6220c2afaef8b1673f925" },
      { name: "voices.bin", bytes: 52401928, sha256: "044364b05514d99f72c63830b0675951137c36f836e1e71bb2546e59b8c6d625" },
    ],
  },
  {
    id: "onnxruntime-web",
    rev: "1.20.0",
    route: "/models/onnxruntime-web/1.20.0/",
    source: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist",
    license: "MIT",
    files: [
      { name: "ort.min.mjs", bytes: 446164, sha256: "139580c307255a1db2a068de5a03b1f9a954174695ac07754916c5fbb5c3f4ed" },
      { name: "ort-wasm-simd-threaded.mjs", bytes: 24618, sha256: "b58de73c7b47b86290578489c6b5b16ade5d237cd5f340f0776a219bb833bd04" },
      { name: "ort-wasm-simd-threaded.wasm", bytes: 11241642, sha256: "704f51767fe3e11443aac6b5509c8654688e4cea3d988f96a069390b6eccbabc" },
    ],
  },
  {
    id: "google-fonts-css2",
    rev: "chrome-css2-2026-10-07",
    route: "/fonts/",
    source:
      "https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700&family=Bricolage+Grotesque:wght@400;600;700&family=JetBrains+Mono:wght@400;500&family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Outfit:wght@300;400;600;700&family=Playfair+Display:ital,wght@0,400;0,700;1,400&display=swap",
    license: "OFL-1.1",
    files: [
      { name: "archivo-normal-latin.woff2", bytes: 34928, sha256: "8f704806dbedeaaeca334b11ec348bc3ac3a439d6431544b3afb54f534ee4967", source: "https://fonts.gstatic.com/s/archivo/v25/k3kPo8UDI-1M0wlSV9XAw6lQkqWY8Q82sLydOxI.woff2" },
      { name: "archivo-normal-latinext.woff2", bytes: 32608, sha256: "ff4f17d21930e36d6d93baba663e624cb767afc3feebf7adaebd82242638de05", source: "https://fonts.gstatic.com/s/archivo/v25/k3kPo8UDI-1M0wlSV9XAw6lQkqWY8Q82sLyTOxK-vA.woff2" },
      { name: "bricolage-grotesque-normal-latin.woff2", bytes: 41344, sha256: "a97804dc9fbe5fc972a08018c5eda4dab7ef2346f64c57e61419d05e6de4ea1c", source: "https://fonts.gstatic.com/s/bricolagegrotesque/v9/3y9H6as8bTXq_nANBjzKo3IeZx8z6up5BeSl5jBNz_19PpbpMXuECpwUxJBOm_OJWiawA1Xp.woff2" },
      { name: "bricolage-grotesque-normal-latinext.woff2", bytes: 18668, sha256: "e808f16b56f84dc7933e498cc8a41d4a5cd853adc6eef154584baa5de1008b15", source: "https://fonts.gstatic.com/s/bricolagegrotesque/v9/3y9H6as8bTXq_nANBjzKo3IeZx8z6up5BeSl5jBNz_19PpbpMXuECpwUxJBOm_OJWiawDVXplDs.woff2" },
      { name: "jetbrains-mono-normal-latin.woff2", bytes: 31432, sha256: "83c005d49d8a6a50474c73a5a36ac0468076e9c4a29da7bdb14995d80560a5be", source: "https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxDcwg.woff2" },
      { name: "jetbrains-mono-normal-latinext.woff2", bytes: 11624, sha256: "db5ff4db83e580426280e9337a58dc57d3a83784a1b03ad80914651594441d52", source: "https://fonts.gstatic.com/s/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPx7cwhsk.woff2" },
      { name: "libre-baskerville-italic-latin.woff2", bytes: 21564, sha256: "efb7e5f4376a557314f5bb9f5197ef837d86c0ab38e1a50a0ff5c60c3400c629", source: "https://fonts.gstatic.com/s/librebaskerville/v24/kmKWZrc3Hgbbcjq75U4uslyuy4kn0qNccR04_RUJeby2OU36SjNNluc.woff2" },
      { name: "libre-baskerville-italic-latinext.woff2", bytes: 23036, sha256: "3874c62309273fb7aea1b2cd50345557940b621b93af608538a3e6a7c6dcc31b", source: "https://fonts.gstatic.com/s/librebaskerville/v24/kmKWZrc3Hgbbcjq75U4uslyuy4kn0qNccR04_RUJeby2OU36SjNDlufifQ.woff2" },
      { name: "libre-baskerville-normal-latin.woff2", bytes: 33872, sha256: "22219fb90e3b9bd28debd1825fe8d9a0154a0e31f8b3fa601ac1a0a5aa5e6d1b", source: "https://fonts.gstatic.com/s/librebaskerville/v24/kmKnZrc3Hgbbcjq75U4uslyuy4kn0qNZaxM.woff2" },
      { name: "libre-baskerville-normal-latinext.woff2", bytes: 35468, sha256: "8f7537ce3a6c1c0d0e93a9530432df13953312d378713a059e9a6cf0d0cde8b9", source: "https://fonts.gstatic.com/s/librebaskerville/v24/kmKnZrc3Hgbbcjq75U4uslyuy4kn0qNXaxMICA.woff2" },
      { name: "outfit-normal-latin.woff2", bytes: 32292, sha256: "6c18d579fd87c3776be068b762cbc83fde3acb543d49eabd3ade842eb987e887", source: "https://fonts.gstatic.com/s/outfit/v15/QGYvz_MVcBeNP4NJtEtq.woff2" },
      { name: "outfit-normal-latinext.woff2", bytes: 14808, sha256: "0f53d1c03b3918d744a843b5039001ee31695ca1e255e3914188df81beb461e9", source: "https://fonts.gstatic.com/s/outfit/v15/QGYvz_MVcBeNP4NJuktqQ4E.woff2" },
      { name: "playfair-display-italic-latin.woff2", bytes: 21884, sha256: "eabce94d4a69e439cd050755c31f9894ac8a78f93e58b063c6c01f370474e1de", source: "https://fonts.gstatic.com/s/playfairdisplay/v40/nuFRD-vYSZviVYUb_rj3ij__anPXDTnCjmHKM4nYO7KN_qiTXtHA-Q.woff2" },
      { name: "playfair-display-italic-latinext.woff2", bytes: 13668, sha256: "b02fdf18a2d7b09f409b01a1ab4afe7b5f7d08926b3c867187398765ea0fb3f1", source: "https://fonts.gstatic.com/s/playfairdisplay/v40/nuFRD-vYSZviVYUb_rj3ij__anPXDTnCjmHKM4nYO7KN_qiTXt_A-W2r.woff2" },
      { name: "playfair-display-normal-latin.woff2", bytes: 38404, sha256: "e0c764a8e9e1cce92163c55bac4b2ad6cd4cf8c696ce2289ab5c41565e65b7e2", source: "https://fonts.gstatic.com/s/playfairdisplay/v40/nuFiD-vYSZviVYUb_rj3ij__anPXDTzYgA.woff2" },
      { name: "playfair-display-normal-latinext.woff2", bytes: 21140, sha256: "42898ad49a6b23f32b109243e1df596edf831015ed685f429e4dafbb181d599d", source: "https://fonts.gstatic.com/s/playfairdisplay/v40/nuFiD-vYSZviVYUb_rj3ij__anPXDTLYgFE_.woff2" },
    ],
  },
]);

/**
 * Every file flattened to the per-file contract consumers read: full same-origin route,
 * full source URL, and the set's license, next to the file's own name and digests.
 */
export function modelAssetFiles() {
  return MODEL_ASSET_SETS.flatMap((set) =>
    set.files.map((file) => ({
      set: set.id,
      route: `${set.route}${file.name}`,
      name: file.name,
      bytes: file.bytes,
      sha256: file.sha256,
      source: set.id === "google-fonts-css2" ? file.source : `${set.source}/${file.name}`,
      license: set.license,
    })),
  );
}
