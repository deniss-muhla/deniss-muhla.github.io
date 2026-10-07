import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_QUESTION_CHARS,
  TOKEN_CAP,
  readRequest,
  readResponse,
  verifyQueryVector,
} from "../src/chat/retrieval/encoder/protocol.ts";
import { EXPECTED_EMBEDDING } from "../src/chat/retrieval/index.ts";
import { RetrievalError } from "../src/chat/retrieval/errors.ts";

const DIMENSIONS = EXPECTED_EMBEDDING.dimensions;

function unitVector(): number[] {
  const vector = Array.from({ length: DIMENSIONS }, () => 0);
  vector[0] = 1;
  return vector;
}

function ready(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "ready",
    dimensions: DIMENSIONS,
    loadMs: 12,
    runtimeVersion: EXPECTED_EMBEDDING.runtimeVersion,
    remoteHost: "https://huggingface.co/",
    remotePathTemplate: `{model}/resolve/${EXPECTED_EMBEDDING.revision}/`,
    files: ["config.json", "tokenizer.json"],
    ...overrides,
  };
}

test("the token cap is the recorded one and the transport guard is above it", () => {
  assert.equal(TOKEN_CAP, 256);
  assert.ok(MAX_QUESTION_CHARS > TOKEN_CAP, "the char guard must not refuse a question inside the token cap");
});

test("a valid request survives and an invalid one is refused", () => {
  assert.deepEqual(readRequest({ type: "load" }), { type: "load" });
  assert.deepEqual(readRequest({ type: "embed", id: 1, question: "a question" }), {
    type: "embed",
    id: 1,
    question: "a question",
  });
  assert.deepEqual(readRequest({ type: "cancel", id: 2 }), { type: "cancel", id: 2 });
});

test("a request can never ask for card vectors", () => {
  // The index vectors are precomputed and stored. Any request that carries card text or a
  // cards array is not a request this module will send, so it cannot reach the worker.
  assert.equal(readRequest({ type: "embed", id: 1, question: "q", cards: [{ id: "a" }] }), null);
  assert.equal(readRequest({ type: "embed-cards", id: 1, cards: [] }), null);
  assert.equal(readRequest({ type: "embed-cards", cards: [] }), null);
});

test("malformed requests are refused field by field", () => {
  assert.equal(readRequest(null), null);
  assert.equal(readRequest("load"), null);
  assert.equal(readRequest({ type: "load", extra: 1 }), null);
  assert.equal(readRequest({ type: "embed", id: 0, question: "q" }), null);
  assert.equal(readRequest({ type: "embed", id: 1.5, question: "q" }), null);
  assert.equal(readRequest({ type: "embed", id: 1, question: "   " }), null);
  assert.equal(readRequest({ type: "embed", id: 1, question: "q".repeat(MAX_QUESTION_CHARS + 1) }), null);
  assert.equal(readRequest({ type: "cancel" }), null);
  assert.equal(readRequest({ type: "unknown" }), null);
});

test("progress, ready, vector and failure messages are narrowed", () => {
  const progress = readResponse({ type: "progress", file: "onnx/model_quantized.onnx", loaded: 5, total: 10, percent: 50 });
  assert.deepEqual(progress, { type: "progress", file: "onnx/model_quantized.onnx", loaded: 5, total: 10, percent: 50 });

  const readyMessage = readResponse(ready());
  assert.equal(readyMessage?.type, "ready");
  assert.deepEqual(readyMessage?.type === "ready" ? readyMessage.files : null, ["config.json", "tokenizer.json"]);

  const vector = readResponse({ type: "vector", id: 1, vector: unitVector(), tokenCount: 4, durationMs: 3 });
  assert.equal(vector?.type, "vector");

  assert.deepEqual(readResponse({ type: "cancelled", id: 3 }), { type: "cancelled", id: 3 });
  assert.deepEqual(readResponse({ type: "load-failed", reason: "model/dimension-mismatch" }), {
    type: "load-failed",
    reason: "model/dimension-mismatch",
  });
  assert.deepEqual(readResponse({ type: "embed-failed", id: 4, reason: "query/too-long" }), {
    type: "embed-failed",
    id: 4,
    reason: "query/too-long",
  });
});

test("a message with a wrong dimension, an extra field or a vendor-shaped value is dropped", () => {
  assert.equal(readResponse(ready({ dimensions: 512 })), null);
  assert.equal(readResponse(ready({ runtimeVersion: "3.0.0 " })), null);
  assert.equal(readResponse({ ...ready(), extra: "x" }), null);
  assert.equal(readResponse({ type: "ready", ...ready(), files: ["../secret"] }), null);
  assert.equal(readResponse({ type: "progress", file: "a", loaded: 1, total: 0, percent: 140 }), null);
  assert.equal(
    readResponse({ type: "vector", id: 1, vector: Array.from({ length: DIMENSIONS - 1 }, () => 0.1), tokenCount: 1, durationMs: 1 }),
    null,
  );
  assert.equal(
    readResponse({ type: "vector", id: 1, vector: Array.from({ length: DIMENSIONS }, () => 0), tokenCount: 1, durationMs: 1 }),
    null,
  );
  assert.equal(
    readResponse({
      type: "vector",
      id: 1,
      vector: Array.from({ length: DIMENSIONS }, () => 0).map((_value, index) => (index === 3 ? Number.NaN : 0.1)),
      tokenCount: 1,
      durationMs: 1,
    }),
    null,
  );
  assert.equal(readResponse({ type: "vector", id: 1, vector: unitVector(), tokenCount: -1, durationMs: 1 }), null);
});

test("a vendor exception message cannot be a reason", () => {
  const vendor = { type: "load-failed", reason: "Error: onnxruntime aborted (wasm trap) at /tmp/x.wasm" };

  assert.equal(readResponse(vendor), null);
  assert.equal(readResponse({ type: "embed-failed", id: 1, reason: "npx: command not found" }), null);
});

test("verifyQueryVector copies, checks and refuses", () => {
  const source = unitVector();
  const verified = verifyQueryVector(source);

  assert.notEqual(verified, source, "the returned array must be the caller's, not the message's");
  assert.deepEqual(verified, source);

  assert.throws(() => verifyQueryVector(Array.from({ length: DIMENSIONS - 1 }, () => 0.1)), (error: unknown) => {
    assert.ok(error instanceof RetrievalError);
    assert.equal(error.reason, "query/vector-dimensions");
    return true;
  });

  assert.throws(() => verifyQueryVector(Array.from({ length: DIMENSIONS }, () => 0)), /query\/vector-zero/);
  assert.throws(
    () => verifyQueryVector(Array.from({ length: DIMENSIONS }, () => 0).map((_value, index) => (index === 1 ? Number.POSITIVE_INFINITY : 0.1))),
    /query\/vector-not-finite/,
  );
  assert.throws(() => verifyQueryVector("vector"), /query\/vector-dimensions/);
});
