/**
 * Development embedding for `cv:facts embed`, on the settled delivery contract from design
 * decision 8.
 *
 * Two things in this file are unsupported internals rather than public API, and both are
 * deliberate. Transformers 4.3.0 has no stock Node entry for device `wasm`, so the generator
 * loads the package's own browser-targeted build under a narrow, version-coupled environment
 * adapter that removes the `process` binding for the duration of one dynamic import and
 * restores it in a `finally`. And the runtime's revision-less tokenizer metadata probe is
 * closed by the library's own documented `env.remotePathTemplate`, set here to a
 * revision-literal template so every request it builds, including that probe, resolves to the
 * exact selected commit. No vendor file is edited, global `fetch` is not patched, and there
 * is no native or GPU fallback.
 *
 * Vectors are computed once, here, after source review. The build and the browser never
 * generate vectors for the artifact's cards.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { CvFactsError } from "./errors.mjs";
import { REPO_ROOT } from "./paths.mjs";
import { INPUT_VERSION, PINNED_EMBEDDING, VECTOR_DECIMALS, contentSha256, retrievalText } from "./artifact.mjs";

export const MODEL_ID = PINNED_EMBEDDING.model;
export const REVISION = PINNED_EMBEDDING.revision;
export const TOKEN_CAP = 256;

/**
 * The locked distribution this adapter is coupled to. Any change must fail closed rather than
 * silently produce different vectors under the same recorded identity.
 */
export const ADAPTER_CONTRACT = Object.freeze({
  packageName: "@huggingface/transformers",
  version: PINNED_EMBEDDING.runtimeVersion,
  buildFile: "dist/transformers.web.js",
  buildSha256: "2eb83e73bc8326f14b55b27b59f72b4966d7601a1f48a19e5ca0ea6800eaddd1",
  ortVersion: "1.31.0-dev.20260914-8d85527a0",
  ortWasmFile: "dist/ort-wasm-simd-threaded.jsep.wasm",
  ortWasmSha256: "62ff86b2f2fa3a79eb87a7e4720e8ea9051942bf975f314181bf7dcef2feac06",
  ortFactoryFile: "dist/ort-wasm-simd-threaded.jsep.mjs",
  ortFactorySha256: "c2f80e915e9df63289788a99d434d8c4e00e64e9c1f030f4b80b022458dd2c99",
});

/** A classified refusal. The reason is this file's own vocabulary, never a vendor message. */
export class AdapterContractError extends Error {
  constructor(reason) {
    super(`adapter-contract:${reason}`);
    this.name = "AdapterContractError";
    this.reason = reason;
  }
}

function digestOf(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function requireFile(file, reason) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new AdapterContractError(reason);
  return file;
}

/** The installed locked packages, resolved through pnpm's symlinks so digests see real bytes. */
export function installedDistributionDirs() {
  const modules = path.join(REPO_ROOT, "node_modules");
  const packageDir = path.join(modules, "@huggingface", "transformers");
  const ortDir = path.join(modules, ".pnpm", `onnxruntime-web@${ADAPTER_CONTRACT.ortVersion}`, "node_modules", "onnxruntime-web");

  for (const [directory, reason] of [
    [packageDir, "transformers-package-missing"],
    [ortDir, "onnxruntime-web-package-missing"],
  ]) {
    if (!fs.existsSync(directory)) throw new CvFactsError(`embed/${reason}`);
  }

  return { packageDir: fs.realpathSync(packageDir), ortDir: fs.realpathSync(ortDir) };
}

/**
 * Verifies the locked distribution and then loads the browser-targeted build with the
 * `process` binding removed for one import.
 *
 * @param {{ packageDir: string, ortDir: string, contract?: typeof ADAPTER_CONTRACT }} options
 * @returns {Promise<{ transformers: object, wasm: { wasmFile: string, factoryFile: string, wasmBytes: Uint8Array },
 *   restored: { identityPreserved: boolean, descriptorRestored: boolean } }>}
 */
export async function loadPinnedWebDelivery({ packageDir, ortDir, contract = ADAPTER_CONTRACT }) {
  const manifestFile = requireFile(path.join(packageDir, "package.json"), "package-manifest-missing");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));

  if (manifest.name !== contract.packageName) throw new AdapterContractError("package-name-mismatch");
  if (manifest.version !== contract.version) throw new AdapterContractError("package-version-mismatch");

  const buildFile = requireFile(path.join(packageDir, contract.buildFile), "web-build-missing");

  if (digestOf(buildFile) !== contract.buildSha256) {
    throw new AdapterContractError("web-build-digest-mismatch");
  }

  const wasmFile = requireFile(path.join(ortDir, contract.ortWasmFile), "ort-wasm-missing");

  if (digestOf(wasmFile) !== contract.ortWasmSha256) {
    throw new AdapterContractError("ort-wasm-digest-mismatch");
  }

  const factoryFile = requireFile(path.join(ortDir, contract.ortFactoryFile), "ort-factory-missing");

  if (digestOf(factoryFile) !== contract.ortFactorySha256) {
    throw new AdapterContractError("ort-factory-digest-mismatch");
  }

  const originalProcess = globalThis.process;
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "process");
  let transformers;

  try {
    delete globalThis.process;
    transformers = await import(pathToFileURL(buildFile).href);
  } finally {
    if (originalDescriptor) Object.defineProperty(globalThis, "process", originalDescriptor);
    else if (originalProcess !== undefined) globalThis.process = originalProcess;
  }

  const currentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "process");
  const restored = {
    identityPreserved: globalThis.process === originalProcess,
    descriptorRestored:
      currentDescriptor?.value === originalDescriptor?.value &&
      currentDescriptor?.configurable === originalDescriptor?.configurable &&
      currentDescriptor?.writable === originalDescriptor?.writable,
  };

  if (transformers.env.version !== contract.version) {
    throw new AdapterContractError("loaded-version-mismatch");
  }

  return {
    transformers,
    wasm: { wasmFile, factoryFile, wasmBytes: fs.readFileSync(wasmFile) },
    restored,
  };
}

/**
 * Configures the library's own documented `env` fields. `remoteHost` is left at the
 * library's default unless a caller supplies an origin, which is how the external proof and
 * the synthetic embedding test answer requests from reviewed pinned bytes without reaching
 * the Internet.
 */
export function configurePinnedEnvironment({ transformers, wasm, cacheDir, remoteHost }) {
  const { env } = transformers;

  env.allowRemoteModels = true;
  env.allowLocalModels = false;
  env.useBrowserCache = false;
  env.useFSCache = false;

  if (cacheDir) {
    fs.mkdirSync(cacheDir, { recursive: true });
    env.cacheDir = cacheDir;
  }

  if (remoteHost) env.remoteHost = remoteHost;

  // Revision-literal: the template holds no `{revision}` placeholder, so the library's own
  // revision substitution is a no-op and its revision-less metadata probe resolves here too.
  env.remotePathTemplate = `{model}/resolve/${REVISION}/`;
  env.backends.onnx.wasm.wasmPaths = { mjs: wasm.factoryFile, wasm: wasm.wasmFile };
  env.backends.onnx.wasm.wasmBinary = wasm.wasmBytes;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;

  return { remoteHost: env.remoteHost, remotePathTemplate: env.remotePathTemplate, cacheDir: env.cacheDir };
}

/** The two accepted token-level output names. A pooled-only graph is a recorded failure. */
const TOKEN_OUTPUT_NAMES = ["token_embeddings", "last_hidden_state"];

/** Masked mean pooling followed by L2 normalization, as design decisions 7 and 8 specify. */
export function meanPoolAndNormalize({ dims, data, attentionMask, expectedDimensions }) {
  if (!Array.isArray(dims) || dims.length !== 3) throw new CvFactsError("embed/hidden-shape-unreadable");

  const [, sequenceLength, hiddenSize] = dims;

  if (hiddenSize !== expectedDimensions) throw new CvFactsError("embed/dimension-mismatch");

  const pooled = new Float32Array(hiddenSize);
  let counted = 0;

  for (let position = 0; position < sequenceLength; position++) {
    if (!attentionMask[position]) continue;
    counted++;
    const base = position * hiddenSize;

    for (let index = 0; index < hiddenSize; index++) pooled[index] += data[base + index];
  }

  if (counted === 0) throw new CvFactsError("embed/empty-attention-mask");

  for (let index = 0; index < hiddenSize; index++) pooled[index] /= counted;

  let squared = 0;

  for (let index = 0; index < hiddenSize; index++) squared += pooled[index] * pooled[index];

  const pooledNorm = Math.sqrt(squared);

  for (let index = 0; index < hiddenSize; index++) pooled[index] /= pooledNorm;

  return { vector: pooled, pooledNorm, hiddenSize, tokenCount: counted };
}

function roundVector(vector) {
  const rounded = Array.from(vector, (value) => {
    if (!Number.isFinite(value)) throw new CvFactsError("embed/vector-not-finite");
    return Number(value.toFixed(VECTOR_DECIMALS));
  });

  let squared = 0;

  for (const value of rounded) squared += value * value;

  if (squared === 0) throw new CvFactsError("embed/vector-zero");

  return rounded;
}

/**
 * Loads the pinned tokenizer and graph once, on device `wasm` with the pinned dtype.
 *
 * The observed hidden size is checked against `config.json` here, so a graph that does not
 * match the recorded dimensions is refused before any card is embedded.
 */
export async function loadPinnedModel({ transformers }) {
  const tokenizer = await transformers.AutoTokenizer.from_pretrained(MODEL_ID);
  const model = await transformers.AutoModel.from_pretrained(MODEL_ID, {
    device: "wasm",
    dtype: PINNED_EMBEDDING.dtype,
  });

  if (model.config?.hidden_size !== PINNED_EMBEDDING.dimensions) {
    throw new CvFactsError("embed/config-dimension-mismatch");
  }

  return { tokenizer, model };
}

/**
 * Computes one vector per card for retrieval text v1.
 *
 * A card whose retrieval text needs more than `TOKEN_CAP` tokens is rejected, not truncated,
 * so the artifact can never hold a vector for text the model did not see whole.
 *
 * @param {{ tokenizer: object, model: object, cards: object[],
 *           expectedDimensions?: number }} options
 * @returns {Promise<{ vectors: Map<string, number[]>, dimensions: number, tokenCounts: Map<string, number> }>}
 */
export async function embedCardVectors({ tokenizer, model, cards, expectedDimensions = PINNED_EMBEDDING.dimensions }) {
  const vectors = new Map();
  const tokenCounts = new Map();

  for (const card of cards) {
    const text = retrievalText(card);
    // Count before padding or truncation, so the cap is measured on the text itself.
    const tokenCount = tokenizer(text).input_ids.data.length;

    if (tokenCount > TOKEN_CAP) {
      const ref = Array.isArray(card.sourceRefs) ? card.sourceRefs[0] : null;

      throw new CvFactsError("embed/card-token-cap", {
        lines: ref ? { start: ref.startLine, end: ref.endLine } : undefined,
      });
    }

    const inputs = tokenizer(text, { padding: true, truncation: true, max_length: TOKEN_CAP });
    const output = await model(inputs);
    const outputName = TOKEN_OUTPUT_NAMES.find((name) => output[name]);

    if (!outputName) throw new CvFactsError("embed/token-output-missing");

    const pooled = meanPoolAndNormalize({
      dims: output[outputName].dims,
      data: output[outputName].data,
      attentionMask: inputs.attention_mask.data,
      expectedDimensions,
    });

    vectors.set(card.id, roundVector(pooled.vector));
    tokenCounts.set(card.id, tokenCount);
  }

  return { vectors, dimensions: expectedDimensions, tokenCounts };
}

/**
 * Produces a candidate artifact with vectors, the pinned identity block and the ordered
 * content digest. Nothing is written here; the caller decides where the file goes.
 */
export async function embedCandidate(artifact, { transformers, expectedDimensions = PINNED_EMBEDDING.dimensions }) {
  if (artifact?.version !== 1 || !Array.isArray(artifact.cards)) {
    throw new CvFactsError("embed/candidate-shape-unsupported");
  }

  const { tokenizer, model } = await loadPinnedModel({ transformers });
  const { vectors, dimensions } = await embedCardVectors({
    tokenizer,
    model,
    cards: artifact.cards,
    expectedDimensions,
  });

  const cards = artifact.cards.map((card) => ({ ...card, vector: vectors.get(card.id) }));

  return {
    ...artifact,
    embedding: { ...PINNED_EMBEDDING, dimensions, inputVersion: INPUT_VERSION, contentSha256: contentSha256(cards) },
    cards,
  };
}