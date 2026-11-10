import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createLatestQueue } from "../src/chat/tts/paradee/latest-queue.ts";

test("superseded speech waits for active synthesis and skips obsolete queued requests", async () => {
  const started: number[] = [];
  const emitted: number[] = [];
  let release!: () => void;
  let done!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const finished = new Promise<void>((resolve) => { done = resolve; });
  const enqueue = createLatestQueue(async (id: number, current) => {
    started.push(id);
    if (id === 1) await pending;
    if (current()) emitted.push(id);
    if (id === 3) done();
  });
  enqueue(1);
  await Promise.resolve();
  enqueue(2);
  enqueue(3);
  assert.deepEqual(started, [1]);
  release();
  await finished;
  assert.deepEqual(started, [1, 3]);
  assert.deepEqual(emitted, [3]);
});

test("a failed operation does not block later requests", async () => {
  let done!: () => void;
  const finished = new Promise<void>((resolve) => { done = resolve; });
  const enqueue = createLatestQueue(async (id: number) => {
    if (id === 1) throw new Error("synthetic failure");
    done();
  });
  enqueue(1);
  await Promise.resolve();
  enqueue(2);
  await finished;
});
