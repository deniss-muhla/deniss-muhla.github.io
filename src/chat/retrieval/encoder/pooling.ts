/**
 * Turning a raw model output into one query vector.
 *
 * These are pure functions over the tensor data, kept out of the worker so the browser-free
 * suite can run them, and kept free of the embedding library so the module that embeds is
 * the only module that knows the library exists. They mirror the generator's pooling
 * exactly: masked mean over the token-level output, then L2 normalization. The generator
 * runs in Node and imports `node:crypto`, so the two runtimes cannot share one module; a
 * test runs both over the same synthetic input and fails if they disagree, which is what
 * keeps the copies from drifting.
 *
 * Every refusal here is deliberate. A graph whose hidden size is not the recorded one, a
 * pool with no unmasked token, a vector that is not finite or is zero, would each produce a
 * score that looks valid and means nothing. The runtime refuses instead.
 */
import { RetrievalError } from "../errors.ts";
import { EXPECTED_EMBEDDING } from "../index.ts";

/**
 * The two accepted token-level output names.
 *
 * The pinned graph publishes `token_embeddings` and not `last_hidden_state`, and publishes
 * its own pooled `sentence_embedding`, which the design records as the model's own pooling
 * rather than a substitute. A graph that publishes only a pooled output is a recorded
 * failure, not a silent change of method.
 */
export const TOKEN_OUTPUT_NAMES = Object.freeze(["token_embeddings", "last_hidden_state"]);

/** The L2 norm a pooled query vector must reach, within float tolerance. */
export const NORM_TOLERANCE = 1e-4;

export interface TokenOutput {
  /** `[batch, tokens, hidden]` as the runtime reports it. */
  readonly dims: readonly number[];
  readonly data: ArrayLike<number>;
}

export interface PoolResult {
  readonly vector: Float32Array;
  /** L2 norm of the pooled vector before normalization, kept so a scale change is visible. */
  readonly pooledNorm: number;
  readonly hiddenSize: number;
  readonly tokenCount: number;
}

/** Picks the token-level output, or refuses a graph that publishes none. */
export function tokenOutputName(output: Record<string, unknown> | undefined): string | null {
  if (output === undefined || output === null || typeof output !== "object") return null;
  return TOKEN_OUTPUT_NAMES.find((name) => Boolean(output[name])) ?? null;
}

/**
 * The recorded identity, checked against what the loaded model reports.
 *
 * A model, revision, dimension, pooling or normalization that differs from the index the
 * page scored against would produce cosines that mean nothing, so a mismatch is refused
 * rather than used. The browser is the same library the generator used, so its version is
 * checked too.
 *
 * @param observed what the loaded runtime reported
 * @param expected the identity the reviewed index was built with
 * @returns the observed identity when every field matches
 * @throws RetrievalError with the first mismatching field as its reason
 */
export function assertModelIdentity(
  observed: { readonly model?: unknown; readonly revision?: unknown; readonly hiddenSize?: unknown; readonly runtimeVersion?: unknown },
  expected: typeof EXPECTED_EMBEDDING = EXPECTED_EMBEDDING,
): typeof EXPECTED_EMBEDDING {
  if (observed.model !== expected.model) throw new RetrievalError("model/id-mismatch");
  if (observed.revision !== expected.revision) throw new RetrievalError("model/revision-mismatch");
  if (observed.runtimeVersion !== expected.runtimeVersion) throw new RetrievalError("model/runtime-version-mismatch");
  if (observed.hiddenSize !== expected.dimensions) throw new RetrievalError("model/dimension-mismatch");

  return expected;
}

/**
 * Masked mean pooling over the token-level output, then L2 normalization.
 *
 * @param output the token-level tensor the graph published
 * @param attentionMask one entry per token, nonzero for a real token
 * @param expectedDimensions the recorded dimension
 * @returns the unit vector and what was pooled
 * @throws RetrievalError with a `model/...` or `query/...` reason
 */
export function poolQueryVector(
  output: TokenOutput,
  attentionMask: ArrayLike<number>,
  expectedDimensions: number = EXPECTED_EMBEDDING.dimensions,
): PoolResult {
  const dims = output.dims;

  if (!Array.isArray(dims) || dims.length !== 3) throw new RetrievalError("model/hidden-shape-unreadable");

  const sequenceLength = dims[1];
  const hiddenSize = dims[2];

  if (hiddenSize !== expectedDimensions) throw new RetrievalError("model/dimension-mismatch");
  if (!Number.isInteger(sequenceLength) || sequenceLength < 1) throw new RetrievalError("model/hidden-shape-unreadable");
  if (output.data.length < sequenceLength * hiddenSize) throw new RetrievalError("model/tensor-truncated");

  const pooled = new Float32Array(hiddenSize);
  let counted = 0;

  for (let position = 0; position < sequenceLength; position += 1) {
    if (!attentionMask[position]) continue;

    counted += 1;
    const base = position * hiddenSize;

    for (let index = 0; index < hiddenSize; index += 1) {
      const value = output.data[base + index];

      if (!Number.isFinite(value)) throw new RetrievalError("query/vector-not-finite");

      pooled[index] += value;
    }
  }

  if (counted === 0) throw new RetrievalError("query/empty-attention-mask");

  for (let index = 0; index < hiddenSize; index += 1) pooled[index] /= counted;

  let squared = 0;

  for (let index = 0; index < hiddenSize; index += 1) squared += pooled[index] * pooled[index];

  const pooledNorm = Math.sqrt(squared);

  if (!Number.isFinite(pooledNorm) || pooledNorm === 0) throw new RetrievalError("query/vector-zero");

  for (let index = 0; index < hiddenSize; index += 1) pooled[index] /= pooledNorm;

  return { vector: pooled, pooledNorm, hiddenSize, tokenCount: counted };
}

/**
 * The norm of an already pooled vector, so a caller can record the real observed norm
 * instead of asserting one.
 */
export function l2Norm(vector: ArrayLike<number>): number {
  let squared = 0;

  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];

    if (!Number.isFinite(value)) return Number.NaN;
    squared += value * value;
  }

  return Math.sqrt(squared);
}
