import { test } from "node:test";
import assert from "node:assert/strict";
import { toMisaki, tokenizeChunks } from "../src/chat/tts/paradee/tokenizer.ts";

test("converts eSpeak spelling before Paradee token mapping", () => {
  assert.equal(toMisaki("aɪ aʊ eɪ oʊ ɚ ɾ"), "I W A O əɹ T");
  assert.deepEqual([...tokenizeChunks("I🙂 W", { I: 25, " ": 16, W: 39 })[0]], [0n, 25n, 16n, 39n, 0n]);
});

test("splits mapped code points without truncation and reserves both boundary tokens", () => {
  const chunks = tokenizeChunks("a".repeat(510) + " " + "a".repeat(30), { a: 2, " ": 16 });
  assert.ok(chunks.every((chunk) => chunk.length <= 512));
  assert.equal(chunks.reduce((sum, chunk) => sum + [...chunk].filter((id) => id === 2n).length, 0), 540);
  assert.ok(chunks.every((chunk) => chunk[0] === 0n && chunk[chunk.length - 1] === 0n));
});
