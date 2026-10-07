import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  logQaContent,
  logQaError,
  qaUrl,
  takeQaScreenshot,
} from "../scripts/voice-qa-privacy.ts";

const voiceQaScript = readFileSync(new URL("../scripts/voice-qa.mjs", import.meta.url), "utf8");

test("the redacted voice route takes no terminal input, scores nothing and writes no per-case report", () => {
  // The retrieval workload behind `--qa=retrieval` keeps its accepted report in its own
  // module; this is the voice route that `--redacted` governs.
  const forbidden: ReadonlyArray<readonly [string, RegExp]> = [
    ["terminal input", /process\.stdin|\breadline\b|prompt\(/],
    ["human scoring", /\bscore|\bgrade|rubric|\bhuman\b/i],
    ["evaluation identifiers", /\beval\b|evaluation|caseId|case-\d|\brun-\d/],
    ["report or artifact writing", /writeFile|createWriteStream|appendFile|mkdir|report\.json/],
    ["voiceDebug construction", /voiceDebug/],
  ];

  for (const [label, pattern] of forbidden) {
    assert.equal(pattern.test(voiceQaScript), false, label);
  }
});

test("every screenshot in the route goes through the redaction-aware helper", () => {
  assert.equal(/\.screenshot\(/.test(voiceQaScript), false);
  const guarded = voiceQaScript.match(/takeQaScreenshot\(page, "[^"]+", REDACTED\)/g) ?? [];
  const allCalls = voiceQaScript.match(/takeQaScreenshot\(page,/g) ?? [];
  assert.equal(guarded.length, allCalls.length);
  assert.equal(guarded.length, 6);
});

const CONTENT_LOG =
  /(message\.text\(\)|error\.message|QA_URL|state\.status|voiceTurn|messages\(\)|typed\.state|JSON\.stringify\(answer|offlineState|offlineReadyStatus)/;

test("no content-bearing log line sits outside the redaction guard", () => {
  const lines = voiceQaScript.split("\n");
  const offenders: number[] = [];
  let guardedSites = 0;

  lines.forEach((line, index) => {
    if (!/console\.(log|error)/.test(line) || !CONTENT_LOG.test(line)) return;
    guardedSites += 1;
    const guarded =
      line.includes("REDACTED") ||
      lines.slice(Math.max(0, index - 10), index).some((before) => before.includes("REDACTED"));
    if (!guarded) offenders.push(index + 1);
  });

  assert.deepEqual(offenders, []);
  // Keep the token list aligned with the script: the scan has to find the known sites.
  assert.ok(guardedSites >= 8, `found ${guardedSites} content log sites`);
});

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
