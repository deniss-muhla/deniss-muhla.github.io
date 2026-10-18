import assert from "node:assert/strict";
import test from "node:test";

import {
  NORM_TOLERANCE,
  TOKEN_OUTPUT_NAMES,
  assertModelIdentity,
  l2Norm,
  poolQueryVector,
  tokenOutputName,
} from "../src/chat/retrieval/encoder/pooling.ts";
import { EXPECTED_EMBEDDING } from "../src/chat/retrieval/index.ts";
import { meanPoolAndNormalize } from "../scripts/cv-facts/embedding.mjs";

const DIMENSIONS = EXPECTED_EMBEDDING.dimensions;

/** A deterministic three-token hidden output with no dependency on any real model. */
function tokenOutput(hiddenSize = DIMENSIONS): { dims: number[]; data: Float32Array } {
  const data = new Float32Array(3 * hiddenSize);

  for (let index = 0; index < data.length; index += 1) {
    data[index] = Math.sin(index * 0.37) * 0.5 + 0.25;
  }

  return { dims: [1, 3, hiddenSize], data };
}

test("the runtime pooling is the generator's pooling, on the same input", () => {
  // The two runtimes cannot share one module: the generator runs in Node and imports
  // node:crypto. This is what keeps the copies from drifting.
  const output = tokenOutput();
  const mask = [1, 1, 0];

  const runtime = poolQueryVector({ dims: output.dims, data: output.data }, mask);
  const generated = meanPoolAndNormalize({
    dims: output.dims,
    data: output.data,
    attentionMask: mask,
    expectedDimensions: DIMENSIONS,
  });

  assert.equal(runtime.hiddenSize, generated.hiddenSize);
  assert.equal(runtime.tokenCount, generated.tokenCount);
  assert.equal(runtime.pooledNorm, generated.pooledNorm);
  assert.deepEqual(Array.from(runtime.vector), Array.from(generated.vector));
});

test("masked mean pooling then normalization gives a unit vector", () => {
  const output = tokenOutput();
  const result = poolQueryVector({ dims: output.dims, data: output.data }, [1, 1, 1]);

  assert.equal(result.vector.length, DIMENSIONS);
  assert.equal(result.tokenCount, 3);
  assert.ok(Math.abs(l2Norm(result.vector) - 1) <= NORM_TOLERANCE, "the pooled vector must be a unit vector");

  // Masking is what makes it a mean over real tokens: the padded position must not count.
  const masked = poolQueryVector({ dims: output.dims, data: output.data }, [1, 1, 0]);

  assert.equal(masked.tokenCount, 2);
  assert.notDeepEqual(Array.from(masked.vector), Array.from(result.vector));
  assert.ok(Math.abs(l2Norm(masked.vector) - 1) <= NORM_TOLERANCE);
});

test("a graph that does not match the recorded identity is refused", () => {
  const output = tokenOutput();

  assert.throws(() => poolQueryVector({ dims: [1, 3, 512], data: new Float32Array(3 * 512) }, [1, 1, 1]), /model\/dimension-mismatch/);
  assert.throws(() => poolQueryVector({ dims: [1, 384], data: new Float32Array(384) }, [1]), /model\/hidden-shape-unreadable/);
  assert.throws(() => poolQueryVector({ dims: [1, 0, DIMENSIONS], data: new Float32Array(0) }, [1]), /model\/hidden-shape-unreadable/);
  assert.throws(() => poolQueryVector({ dims: [1, 8, DIMENSIONS], data: new Float32Array(8) }, Array.from({ length: 8 }, () => 1)), /model\/tensor-truncated/);
  assert.throws(() => poolQueryVector(output, [0, 0, 0]), /query\/empty-attention-mask/);

  const notFinite = tokenOutput();
  notFinite.data[5] = Number.NaN;
  assert.throws(() => poolQueryVector(notFinite, [1, 1, 1]), /query\/vector-not-finite/);
});

test("a zero pooled vector is refused rather than divided by", () => {
  const zero = { dims: [1, 2, DIMENSIONS], data: new Float32Array(2 * DIMENSIONS) };

  assert.throws(() => poolQueryVector(zero, [1, 1]), /query\/vector-zero/);
});

test("only the two recorded token-level output names are accepted", () => {
  assert.deepEqual([...TOKEN_OUTPUT_NAMES], ["token_embeddings", "last_hidden_state"]);

  assert.equal(tokenOutputName({ token_embeddings: { dims: [1, 2, 384] } }), "token_embeddings");
  assert.equal(tokenOutputName({ last_hidden_state: { dims: [1, 2, 384] } }), "last_hidden_state");
  // The pinned graph publishes its own pooled output as well; it is not used for pooling.
  assert.equal(tokenOutputName({ sentence_embedding: { dims: [1, 384] } }), null);
  assert.equal(tokenOutputName({}), null);
  assert.equal(tokenOutputName(undefined), null);
});

test("a model, revision, version or hidden size that moved is refused", () => {
  const correct = {
    model: EXPECTED_EMBEDDING.model,
    revision: EXPECTED_EMBEDDING.revision,
    hiddenSize: DIMENSIONS,
    runtimeVersion: EXPECTED_EMBEDDING.runtimeVersion,
  };

  assert.deepEqual(assertModelIdentity(correct), EXPECTED_EMBEDDING);

  assert.throws(() => assertModelIdentity({ ...correct, model: "other/model" }), /model\/id-mismatch/);
  assert.throws(() => assertModelIdentity({ ...correct, revision: "main" }), /model\/revision-mismatch/);
  assert.throws(() => assertModelIdentity({ ...correct, runtimeVersion: "3.0.0" }), /model\/runtime-version-mismatch/);
  assert.throws(() => assertModelIdentity({ ...correct, hiddenSize: 512 }), /model\/dimension-mismatch/);
  assert.throws(() => assertModelIdentity({ ...correct, hiddenSize: undefined }), /model\/dimension-mismatch/);
});

test("l2Norm refuses a non-finite vector instead of reporting a number", () => {
  assert.equal(l2Norm([3, 4]), 5);
  assert.ok(Number.isNaN(l2Norm([Number.POSITIVE_INFINITY, 1])));
});
