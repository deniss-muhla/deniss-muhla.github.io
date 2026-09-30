import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  qaCompletedVoiceTurnSince,
  qaModelsReady,
  qaOfflineReloadSucceeded,
  type VoiceQaMessage,
} from "../scripts/voice-qa-checks.ts";

const greeting: VoiceQaMessage = {
  text: "Hello, I am your voice assistant.",
  pending: false,
  assistant: true,
  user: false,
};
const typedQuestion: VoiceQaMessage = {
  text: "What does Deniss do at If?",
  pending: false,
  assistant: false,
  user: true,
};
const completedAnswer: VoiceQaMessage = {
  text: "A completed answer about the work at If is already present.",
  pending: false,
  assistant: true,
  user: false,
};
const transcript: VoiceQaMessage = {
  text: "Tell me more about the work there.",
  pending: false,
  assistant: false,
  user: true,
};

test("requested offline reload fails unless offline, isolated and showing the offline badge", () => {
  assert.equal(qaOfflineReloadSucceeded({ online: false, isolated: true, hasBadge: true }), true);
  assert.equal(qaOfflineReloadSucceeded({ online: true, isolated: true, hasBadge: true }), false);
  assert.equal(qaOfflineReloadSucceeded({ online: false, isolated: false, hasBadge: true }), false);
  assert.equal(qaOfflineReloadSucceeded({ online: false, isolated: true, hasBadge: false }), false);
});

test("offline model readiness uses the closed-panel status before opening changes it", () => {
  assert.equal(qaModelsReady("Ready."), true);
  assert.equal(qaModelsReady("Listening — speak or type."), false);
  assert.equal(qaModelsReady("Speaking…"), false);
  assert.equal(qaModelsReady("Voice assistant unavailable."), false);
});

function qaOfflineReadinessPrecedesPanelOpen(script: string): boolean {
  const offlineStart = script.indexOf("await context.setOffline(true);");
  const offlineEnd = script.indexOf("await context.setOffline(false);", offlineStart);
  if (offlineStart === -1 || offlineEnd === -1) return false;

  const offlineWorkflow = script.slice(offlineStart, offlineEnd);
  const reload = offlineWorkflow.indexOf("await page.reload(");
  const readiness = offlineWorkflow.search(
    /await waitFor\(async \(\) => (?:qaModelsReady\(await status\(\)\)|\(await status\(\)\)\.startsWith\("Ready"\)),/,
  );
  const panelReopen = offlineWorkflow.indexOf('await page.getByTestId("voice-fab").click();');
  return reload !== -1 && readiness > reload && (panelReopen === -1 || readiness < panelReopen);
}

test("offline reload checks readiness before any panel reopen", () => {
  const legacyReadyBeforePanelOpen = [
    "await context.setOffline(true);",
    "await page.reload();",
    'await waitFor(async () => (await status()).startsWith("Ready"), 120_000, "offline models");',
    'await page.getByTestId("voice-fab").click();',
    "await context.setOffline(false);",
  ].join("\n");
  assert.equal(qaOfflineReadinessPrecedesPanelOpen(legacyReadyBeforePanelOpen), true);

  const oldClickBeforeReadyOrder = [
    "await context.setOffline(true);",
    "await page.reload();",
    'await page.getByTestId("voice-fab").click();',
    'await waitFor(async () => (await status()).startsWith("Ready"), 120_000, "offline models");',
    "await context.setOffline(false);",
  ].join("\n");
  assert.equal(qaOfflineReadinessPrecedesPanelOpen(oldClickBeforeReadyOrder), false);

  const script = readFileSync(new URL("../scripts/voice-qa.mjs", import.meta.url), "utf8");
  assert.equal(qaOfflineReadinessPrecedesPanelOpen(script), true);
});

test("typed-only history before microphone activation cannot satisfy a voice check", () => {
  const typedHistory = [greeting, typedQuestion, completedAnswer];
  assert.equal(qaCompletedVoiceTurnSince(typedHistory, typedHistory.length), undefined);
});

test("only a new user message followed by its completed non-greeting reply passes", () => {
  const baseline = [greeting, typedQuestion, completedAnswer];
  const pendingReply: VoiceQaMessage = { ...completedAnswer, pending: true };
  const messages = [...baseline, transcript, pendingReply];

  assert.equal(qaCompletedVoiceTurnSince(messages, baseline.length), undefined);
  assert.deepEqual(
    qaCompletedVoiceTurnSince([...baseline, transcript, completedAnswer], baseline.length),
    { heard: transcript.text, answered: completedAnswer.text },
  );
});

test("a prior reply or greeting after a new user message cannot be reused as the answer", () => {
  const baseline = [greeting, completedAnswer];
  assert.equal(qaCompletedVoiceTurnSince([...baseline, transcript], baseline.length), undefined);
  assert.equal(
    qaCompletedVoiceTurnSince([...baseline, transcript, greeting], baseline.length),
    undefined,
  );
});
