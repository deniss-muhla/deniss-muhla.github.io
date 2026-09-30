import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  logQaContent,
  logQaError,
  qaUrl,
  takeQaScreenshot,
} from "../scripts/voice-qa-privacy.ts";

test("redacted QA removes voiceDebug while ordinary URLs remain unchanged", () => {
  const url = "https://example.test/?sw=1&voiceDebug=1&mode=check#top";
  assert.equal(qaUrl(url, false), url);

  const redacted = new URL(qaUrl(url, true));
  assert.equal(redacted.searchParams.has("voiceDebug"), false);
  assert.equal(redacted.searchParams.get("sw"), "1");
  assert.equal(redacted.searchParams.get("mode"), "check");
  assert.equal(redacted.hash, "#top");
});

test("redacted QA omits content, answer-bearing errors and screenshots", async () => {
  const output: unknown[][] = [];
  const log = (...values: unknown[]) => output.push(values);
  let screenshots = 0;
  const page = { screenshot: async () => { screenshots += 1; } };
  const secret = "PRIVATE_QUESTION_AND_ANSWER";

  logQaContent(true, log, secret);
  logQaError(new Error(secret), true, log);
  await takeQaScreenshot(page, "/tmp/voice-qa-private.png", true);

  assert.equal(JSON.stringify(output).includes(secret), false);
  assert.deepEqual(output, [["[qa] failed (details redacted)"]]);
  assert.equal(screenshots, 0);
});

test("redacted QA catches browser-launch failures without printing their details", () => {
  const privateMarker = "private-redacted-launch-marker";
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/voice-qa.mjs", import.meta.url)), "--redacted"],
    {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, CHROME_CHANNEL: privateMarker, HEADLESS: "true" },
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 1, output);
  assert.match(output, /\[qa\] failed \(details redacted\)/);
  assert.match(output, /\[qa\] FAILED/);
  assert.equal(output.includes(privateMarker), false);
});

test("ordinary QA retains its existing content, error and screenshot behavior", async () => {
  const output: unknown[][] = [];
  const log = (...values: unknown[]) => output.push(values);
  let screenshotPath = "";
  const page = { screenshot: async ({ path }: { path: string }) => { screenshotPath = path; } };
  const secret = "ordinary content";
  const error = new Error(secret);

  logQaContent(false, log, secret);
  logQaError(error, false, log);
  await takeQaScreenshot(page, "/tmp/voice-qa-ordinary.png", false);

  assert.deepEqual(output, [[secret], ["[qa] failed:", secret]]);
  assert.equal(screenshotPath, "/tmp/voice-qa-ordinary.png");
});
