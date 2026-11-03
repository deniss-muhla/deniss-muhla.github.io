import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const pythonTest = fileURLToPath(new URL("./cv-audio-kitten-completion.py", import.meta.url));

test("scoped completion observer accepts only complete, paired synthetic chunks and restores hooks", async () => {
  const { stdout, stderr } = await execFileAsync("python3", ["-I", "-B", pythonTest], {
    timeout: 10_000,
    maxBuffer: 8_192
  });
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), {
    status: "ok",
    testCases: 12,
    modelImports: 0,
    inferenceCalls: 0
  });
});
