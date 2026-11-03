import assert from "node:assert/strict";
import test from "node:test";

import {
  createRetrievalEncoder,
  type EncoderProgress,
  type EncoderWorker,
  type EncoderWorkerFactory,
} from "../src/chat/retrieval/encoder/index.ts";
import { MAX_QUESTION_CHARS } from "../src/chat/retrieval/encoder/protocol.ts";
import { EXPECTED_EMBEDDING } from "../src/chat/retrieval/index.ts";
import { RetrievalError } from "../src/chat/retrieval/errors.ts";
import type { EncoderRequest } from "../src/chat/retrieval/encoder/protocol.ts";

const DIMENSIONS = EXPECTED_EMBEDDING.dimensions;

/** A worker double: it records what was sent and lets the test decide what comes back. */
class FakeWorker implements EncoderWorker {
  readonly sent: EncoderRequest[] = [];
  terminations = 0;
  private messageListener: (value: unknown) => void = () => undefined;
  private failureListener: () => void = () => undefined;

  get terminated(): boolean {
    return this.terminations > 0;
  }

  postMessage(message: EncoderRequest): void {
    this.sent.push(message);
  }

  terminate(): void {
    this.terminations += 1;
  }

  onMessage(listener: (value: unknown) => void): void {
    this.messageListener = listener;
  }

  onFailure(listener: () => void): void {
    this.failureListener = listener;
  }

  emit(value: unknown): void {
    this.messageListener(value);
  }

  fail(): void {
    this.failureListener();
  }
}

function unitVector(seed = 1): number[] {
  const vector = Array.from({ length: DIMENSIONS }, () => 0);
  vector[seed % DIMENSIONS] = 1;
  return vector;
}

function readyMessage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "ready",
    dimensions: DIMENSIONS,
    loadMs: 20,
    runtimeVersion: EXPECTED_EMBEDDING.runtimeVersion,
    remoteHost: "https://example.test",
    remotePathTemplate: `{model}/resolve/${EXPECTED_EMBEDDING.revision}/`,
    files: ["config.json", "tokenizer.json"],
    ...over,
  };
}

function vectorMessage(id: number, seed = 1): Record<string, unknown> {
  return { type: "vector", id, vector: unitVector(seed), tokenCount: 4, durationMs: 3 };
}

function setup(): { workers: FakeWorker[]; factory: EncoderWorkerFactory; progress: EncoderProgress[] } {
  const workers: FakeWorker[] = [];
  const progress: EncoderProgress[] = [];

  return {
    workers,
    progress,
    factory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Turns a settled question into its value or its classified reason, for order-free assertions. */
const settledAs = (value: unknown): unknown =>
  value instanceof RetrievalError ? value.reason : value;

test("construction creates no worker and makes no request", () => {
  const { workers, factory } = setup();
  const encoder = createRetrievalEncoder({ workerFactory: factory });

  assert.equal(encoder.state, "idle");
  assert.equal(encoder.identity, null);
  assert.equal(encoder.lastQuery, null);
  assert.equal(workers.length, 0);
});

test("a question loads the model once and then embeds it", async () => {
  const { workers, factory } = setup();
  const encoder = createRetrievalEncoder({ workerFactory: factory });
  const first = encoder.embed("what did the sample person do first");

  assert.equal(workers.length, 1, "the worker is created on the first question, not before");
  assert.deepEqual(workers[0].sent, [{ type: "load" }]);
  assert.equal(encoder.state, "loading");

  workers[0].emit(readyMessage());
  await settle();

  assert.equal(encoder.state, "ready");
  assert.equal(encoder.identity?.runtimeVersion, EXPECTED_EMBEDDING.runtimeVersion);
  assert.equal(encoder.identity?.dimensions, DIMENSIONS);
  assert.ok(
    encoder.identity?.remotePathTemplate.includes(EXPECTED_EMBEDDING.revision) &&
      !encoder.identity.remotePathTemplate.includes("{revision}"),
    "the template must name the literal revision",
  );

  const embedded = first;
  await settle();

  assert.deepEqual(workers[0].sent.at(-1), {
    type: "embed",
    id: 1,
    question: "what did the sample person do first",
  });

  workers[0].emit(vectorMessage(1));
  assert.deepEqual(await embedded, unitVector(1));
  assert.deepEqual(encoder.lastQuery, { dimensions: DIMENSIONS, tokenCount: 4, durationMs: 3 });

  // A second question reuses the same worker and never loads again.
  const second = encoder.embed("and second");
  await settle();
  assert.equal(workers.length, 1);
  assert.equal(workers[0].sent.filter((message) => message.type === "load").length, 1);
  workers[0].emit(vectorMessage(2, 2));
  assert.deepEqual(await second, unitVector(2));
});

test("concurrent loads share one request", async () => {
  const { workers, factory } = setup();
  const encoder = createRetrievalEncoder({ workerFactory: factory });
  const both = Promise.all([encoder.load(), encoder.load()]);

  assert.equal(workers.length, 1);
  assert.deepEqual(workers[0].sent, [{ type: "load" }]);

  workers[0].emit(readyMessage());
  await both;
  assert.equal(encoder.state, "ready");
});

test("progress is forwarded as the library reported it", async () => {
  const { workers, factory, progress } = setup();
  const encoder = createRetrievalEncoder({ workerFactory: factory, onProgress: (event) => progress.push(event) });
  const loaded = encoder.load();

  workers[0].emit({ type: "progress", file: "onnx/model_quantized.onnx", loaded: 5, total: 10, percent: 50 });
  workers[0].emit({ type: "progress", file: "tokenizer.json", loaded: 7, total: 7, percent: 100 });
  workers[0].emit(readyMessage());
  await loaded;

  assert.deepEqual(progress, [
    { file: "onnx/model_quantized.onnx", loaded: 5, total: 10, percent: 50 },
    { file: "tokenizer.json", loaded: 7, total: 7, percent: 100 },
  ]);
});

test("a failed load moves to failed and can be retried explicitly", async () => {
  const { workers, factory } = setup();
  const encoder = createRetrievalEncoder({ workerFactory: factory });
  const first = encoder.load();
  const question = encoder.embed("a question");

  workers[0].emit({ type: "load-failed", reason: "model/dimension-mismatch" });

  await assert.rejects(first, (error: unknown) => {
    assert.ok(error instanceof RetrievalError);
    assert.equal(error.reason, "model/dimension-mismatch");
    return true;
  });
  await assert.rejects(question, /model\/dimension-mismatch/);
  assert.equal(encoder.state, "failed");

  // Retry stays explicit, and it needs clean library state: the runtime's own session
  // initialisation chain stays rejected for the life of the worker that hit the failure, so a
  // retry ends that worker and starts a fresh one. This is the corrected contract, not a
  // weakened check: the old one asserted a second load on the failed worker, which the
  // installed runtime cannot satisfy.
  const retry = encoder.load();

  assert.equal(workers.length, 2, "a retry after a failed load needs a fresh worker");
  assert.equal(workers[0].terminated, true, "the failed worker is ended exactly once");
  assert.equal(workers[0].terminations, 1, "and it is not ended a second time by the replacement");
  assert.deepEqual(workers[1].sent, [{ type: "load" }], "only the new worker is asked to load");
  workers[1].emit(readyMessage());
  await retry;
  assert.equal(encoder.state, "ready");
});

test("an embedding failure is reported as this module's reason, never a vendor message", async () => {
  const { workers, factory } = setup();
  const encoder = createRetrievalEncoder({ workerFactory: factory });
  const question = encoder.embed("a question");
  workers[0].emit(readyMessage());
  await settle();
  workers[0].emit({ type: "embed-failed", id: 1, reason: "query/too-long" });

  await assert.rejects(question, (error: unknown) => {
    assert.ok(error instanceof RetrievalError);
    assert.equal(error.reason, "query/too-long");
    assert.ok(!/onnx|wasm|Error:/i.test(error.message), "no vendor text may cross the boundary");
    return true;
  });
});

test("a new question supersedes the pending one and its late result is discarded", async () => {
  const { workers, factory } = setup();
  const encoder = createRetrievalEncoder({ workerFactory: factory });
  const older = encoder.embed("first question");
  workers[0].emit(readyMessage());
  await settle();

  const newer = encoder.embed("second question");
  await assert.rejects(older, /embed\/superseded/);

  const cancel = workers[0].sent.find((message) => message.type === "cancel");
  assert.deepEqual(cancel, { type: "cancel", id: 1 });
  assert.equal(
    Object.keys(cancel ?? {}).length,
    2,
    "a cancel carries an id only, so no question text is sent to cancel one",
  );

  // A result for the replaced question must not resolve anything.
  workers[0].emit(vectorMessage(1, 7));
  assert.equal(encoder.lastQuery, null);

  workers[0].emit(vectorMessage(2, 3));
  assert.deepEqual(await newer, unitVector(3));
});

test("superseding while the model is still loading also replaces the earlier turn", async () => {
  const { workers, factory } = setup();
  const encoder = createRetrievalEncoder({ workerFactory: factory });
  // Both are settled into values, so the earlier rejection is never left unhandled.
  const older = encoder.embed("first question").then(settledAs, settledAs);
  const newer = encoder.embed("second question").then(settledAs, settledAs);

  workers[0].emit(readyMessage());
  await settle();

  assert.equal(settledAs(await older), "embed/superseded");
  workers[0].emit(vectorMessage(2, 5));
  assert.deepEqual(await newer, unitVector(5));
});

test("a message that does not fit the protocol changes nothing", async () => {
  const { workers, factory } = setup();
  const encoder = createRetrievalEncoder({ workerFactory: factory });
  const question = encoder.embed("a question");
  workers[0].emit(readyMessage());
  await settle();

  workers[0].emit({ type: "ready", dimensions: 512 });
  workers[0].emit({ type: "vector", id: 1, vector: Array.from({ length: DIMENSIONS - 1 }, () => 0.1), tokenCount: 1, durationMs: 1 });
  workers[0].emit({ type: "tensor", id: 1, data: new Float32Array(DIMENSIONS) });

  let settled = false;
  void question.then(() => {
    settled = true;
  });
  await settle();
  assert.equal(settled, false);
  assert.equal(encoder.state, "ready");

  workers[0].emit(vectorMessage(1));
  assert.deepEqual(await question, unitVector(1));
});

test("an empty or oversized question never reaches the worker", async () => {
  const { workers, factory } = setup();
  const encoder = createRetrievalEncoder({ workerFactory: factory });

  await assert.rejects(encoder.embed("   "), /query\/empty/);
  await assert.rejects(encoder.embed("q".repeat(MAX_QUESTION_CHARS + 1)), /query\/too-long/);
  assert.equal(workers.length, 0);
});

test("closing ends the worker, rejects the pending question and allows a fresh one", async () => {
  const { workers, factory } = setup();
  const encoder = createRetrievalEncoder({ workerFactory: factory });
  const question = encoder.embed("a question");
  workers[0].emit(readyMessage());
  await settle();

  encoder.close();

  await assert.rejects(question, /embed\/closed/);
  assert.equal(workers[0].terminated, true);
  assert.equal(encoder.state, "idle");
  assert.equal(encoder.identity, null);

  const again = encoder.embed("another question");
  assert.equal(workers.length, 2, "a closed encoder starts a fresh worker");
  workers[1].emit(readyMessage());
  await settle();
  workers[1].emit(vectorMessage(1, 4));
  assert.deepEqual(await again, unitVector(4));
});

test("a worker that dies reports a classified failure instead of hanging", async () => {
  const { workers, factory } = setup();
  const encoder = createRetrievalEncoder({ workerFactory: factory });
  const question = encoder.embed("a question");

  workers[0].fail();

  await assert.rejects(question, /worker\/failed/);
  assert.equal(encoder.state, "failed");
  assert.equal(workers[0].terminated, true);
});

/**
 * A worker double that answers on its own: a poisoned one refuses every load it is ever asked
 * for, the way the installed library's own session chain does once one init failure has
 * poisoned it, and a healthy one reports ready and answers the question it was sent.
 */
class SelfAnsweringWorker implements EncoderWorker {
  readonly sent: EncoderRequest[] = [];
  terminations = 0;
  private readonly poisoned: boolean;
  private messageListener: (value: unknown) => void = () => undefined;
  private failureListener: () => void = () => undefined;

  constructor(poisoned: boolean) {
    this.poisoned = poisoned;
  }

  postMessage(message: EncoderRequest): void {
    this.sent.push(message);

    if (message.type === "load") {
      queueMicrotask(() => {
        this.messageListener(
          this.poisoned ? { type: "load-failed", reason: "model/load-failed" } : readyMessage(),
        );
      });
    }

    if (message.type === "embed") {
      queueMicrotask(() => {
        this.messageListener(vectorMessage(message.id));
      });
    }
  }

  terminate(): void {
    this.terminations += 1;
  }

  onMessage(listener: (value: unknown) => void): void {
    this.messageListener = listener;
  }

  onFailure(listener: () => void): void {
    this.failureListener = listener;
  }

  /** A reply from this worker, which may or may not still be the one the client holds. */
  emit(value: unknown): void {
    this.messageListener(value);
  }

  fail(): void {
    this.failureListener();
  }
}

test("an explicit retry after a failed load starts a fresh worker, and only the new one can answer", async () => {
  const progress: EncoderProgress[] = [];
  const workers: SelfAnsweringWorker[] = [];
  const encoder = createRetrievalEncoder({
    onProgress: (event) => progress.push(event),
    workerFactory: () => {
      const worker = new SelfAnsweringWorker(workers.length === 0);

      workers.push(worker);
      return worker;
    },
  });

  await assert.rejects(encoder.load(), (error: unknown) => {
    assert.ok(error instanceof RetrievalError);
    assert.equal(error.reason, "model/load-failed");
    return true;
  });
  assert.equal(encoder.state, "failed");
  assert.equal(workers.length, 1);

  // The poisoned worker refuses every further load, so only a fresh runtime can reach ready.
  await encoder.load();
  assert.equal(workers.length, 2, "a retry after a failed load needs a fresh worker");
  assert.equal(workers[0].terminations, 1, "the replaced worker is ended exactly once");
  assert.deepEqual(workers[1].sent, [{ type: "load" }], "only the new worker is asked to load");
  assert.deepEqual(
    workers[0].sent,
    [{ type: "load" }],
    "the ended worker is asked for nothing after it is replaced",
  );
  assert.equal(encoder.state, "ready");
  assert.equal(encoder.identity?.runtimeVersion, EXPECTED_EMBEDDING.runtimeVersion);

  const question = encoder.embed("a question after the replacement");

  assert.equal(workers.length, 2, "a healthy worker is reused, no third one is created");

  // Everything the ended worker still says is stale: it cannot fail the load in flight, cannot
  // report progress, cannot replace the identity, and cannot answer the pending question with
  // its own vector.
  workers[0].emit({ type: "load-failed", reason: "model/load-failed" });
  workers[0].emit({ type: "progress", file: "tokenizer.json", loaded: 1, total: 2, percent: 50 });
  workers[0].emit(readyMessage({ runtimeVersion: "9.9.9-stuck" }));
  workers[0].emit(vectorMessage(1, 9));
  await settle();

  assert.equal(encoder.state, "ready", "the ended worker cannot fail the replacement");
  assert.equal(progress.length, 0, "no progress from the ended worker is forwarded");
  assert.equal(encoder.identity?.runtimeVersion, EXPECTED_EMBEDDING.runtimeVersion);

  // The vector that answers is the new worker's, and the question went to it.
  assert.deepEqual(await question, unitVector(1));
  assert.equal(workers[0].sent.some((message) => message.type === "embed"), false);
  assert.ok(workers[1].sent.some((message) => message.type === "embed"));
  assert.equal(encoder.lastQuery?.tokenCount, 4, "the answered question is settled, not left pending");

  encoder.close();
  assert.equal(workers[1].terminations, 1);
  assert.equal(encoder.state, "idle");
});
