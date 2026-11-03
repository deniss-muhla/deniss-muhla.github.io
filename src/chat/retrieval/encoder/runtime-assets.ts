/**
 * The pinned ONNX Runtime Web files the embedding runtime needs, and the one route that
 * serves them.
 *
 * This module is the project-owned half of the distribution contract. The worker names the
 * files and versions from here, the Vite route plugin serves exactly these names from the
 * installed locked package, and a test refuses a version that moved. The library's own
 * default is a third-party CDN URL, which is version-pinned but not this project's bytes,
 * so the default is never used.
 *
 * Only the `jsep` pair is served. The `asyncify` pair is a second file the library's default
 * path template would name; the page never requests it, and serving it would add roughly the
 * same number of bytes again for nothing.
 *
 * The route is site-absolute, which assumes the site is served from the domain root.
 */

/** Same-origin route for the runtime files, one of the project-owned static runtime routes. */
export const ORT_ROUTE = "/ort/";

export const ORT_PACKAGE = "onnxruntime-web";

/** The locked `onnxruntime-web` version. Design decision 8, task 2.3. */
export const ORT_RUNTIME_VERSION = "1.31.0-dev.20260914-8d85527a0";

export interface OrtAsset {
  /** File name inside the installed package's `dist/`. */
  readonly name: string;
  readonly contentType: string;
  /** Size and digest of the installed bytes, so a moved or patched file is refused. */
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * The two files the pinned runtime loads, byte for byte as installed.
 *
 * The digests are the ones recorded when the runtime was selected. They are data, not a
 * check: nothing hashes 28 MB at start-up. The check that proves the served bytes are these
 * bytes is the headed retrieval QA run, and the test that keeps this table equal to the
 * generator's own contract is browser-free.
 */
export const ORT_RUNTIME_ASSETS: readonly OrtAsset[] = Object.freeze([
  {
    name: "ort-wasm-simd-threaded.jsep.mjs",
    contentType: "text/javascript; charset=utf-8",
    bytes: 46_851,
    sha256: "c2f80e915e9df63289788a99d434d8c4e00e64e9c1f030f4b80b022458dd2c99",
  },
  {
    name: "ort-wasm-simd-threaded.jsep.wasm",
    contentType: "application/wasm",
    bytes: 28_352_885,
    sha256: "62ff86b2f2fa3a79eb87a7e4720e8ea9051942bf975f314181bf7dcef2feac06",
  },
] satisfies OrtAsset[]);

/**
 * What the worker hands the runtime as `wasmPaths`.
 *
 * Single-threaded and no proxy worker, so the WebAssembly module needs no `SharedArrayBuffer`
 * and no cross-origin isolation of its own. The site is isolated anyway for speech
 * recognition, but this path does not depend on that and is not allowed to start depending
 * on it.
 */
export const ORT_WASM_PATHS = Object.freeze({
  mjs: `${ORT_ROUTE}${ORT_RUNTIME_ASSETS[0].name}`,
  wasm: `${ORT_ROUTE}${ORT_RUNTIME_ASSETS[1].name}`,
});

/** Single-threaded baseline. No threading, so no new browser requirement. */
export const ORT_NUM_THREADS = 1;

/** The runtime does not use a worker proxy, so the page never blocks on the inference thread. */
export const ORT_PROXY = false;
