import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  qaCompletedVoiceTurnSince,
  qaMatchLabel,
  qaMeteredPhase,
  qaModelsReady,
  qaNoteKind,
  qaOfflineReloadSucceeded,
  qaTurnSpeech,
  qaTypedOutcome,
  qaEntryTerminalLine,
  selectQaMode,
  type QaMeteredObservation,
  type QaMeteredPhase,
  type QaTypedOutcome,
  type VoiceQaMessage,
  type VoiceQaTimelineEvent,
} from "../scripts/voice-qa-checks.ts";

const greeting: VoiceQaMessage = {
  text: "Hello, I am your voice assistant.",
  pending: false,
  assistant: true,
  user: false,
};
const typedQuestion: VoiceQaMessage = {
  text: "what was the first employer",
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

test("every command without a mode argument stays the voice workload", () => {
  for (const argv of [
    [],
    ["--redacted"],
    ["/tmp/question.wav"],
    ["--routing=dev"],
    ["node", "scripts/voice-qa.mjs", "--redacted"],
  ]) {
    assert.equal(selectQaMode(argv), "voice", `${JSON.stringify(argv)} must stay the voice workload`);
  }
});

test("the retrieval workload is reached through one additive mode argument", () => {
  assert.equal(selectQaMode(["--qa=retrieval"]), "retrieval");
  assert.equal(selectQaMode(["--redacted", "--qa=retrieval", "--routing=built"]), "retrieval");
  assert.equal(selectQaMode(["--qa=voice"]), "voice");
});

test("an unknown mode fails instead of quietly running the other workload", () => {
  assert.throws(() => selectQaMode(["--qa=offline"]), {
    message: /unknown-qa-mode:offline/,
  });
  assert.throws(() => selectQaMode(["--qa="]), { message: /unknown-qa-mode:/ });
});

test("the entry dispatches the requested workload and keeps the retrieval import out of the voice path", () => {
  const script = readFileSync(new URL("../scripts/voice-qa.mjs", import.meta.url), "utf8");
  assert.match(script, /selectQaMode\(process\.argv\.slice\(2\)\)/);

  // The dynamic import has to sit inside the retrieval branch: a static one would load the
  // retrieval browser, server and embedding work for every voice command.
  const branch = script.indexOf('if (qaMode === "retrieval") {');
  const dynamicImport = script.indexOf('await import("./retrieval-qa.mjs")');
  const dispatch = script.indexOf("await runRetrievalQa();", branch);
  const branchEnd = script.indexOf("} else {", branch);
  const voiceLaunch = script.indexOf("await chromium.launch(");

  assert.notEqual(branch, -1);
  assert.ok(dynamicImport > branch && dynamicImport < branchEnd, "retrieval import belongs to the branch");
  assert.ok(dispatch > dynamicImport && dispatch < branchEnd, "the branch must await the retrieval run");
  assert.ok(branchEnd !== -1 && voiceLaunch > branchEnd, "the voice run stays the default branch");
  assert.equal(script.match(/retrieval-qa\.mjs/g)?.length, 1, "one reference keeps the import reviewable");
});

test("one run prints exactly one terminal line, from the helper", () => {
  const script = readFileSync(new URL("../scripts/voice-qa.mjs", import.meta.url), "utf8");

  // The retrieval workload reports its own outcome, so a second hand-rolled line from the
  // entry would double every failed run's report.
  assert.equal(
    script.match(/qaEntryTerminalLine\(/g)?.length,
    1,
    "the entry must emit its terminal line through the helper exactly once",
  );
  assert.ok(
    !script.includes('process.exitCode ? "[qa] FAILED"'),
    "no hand-rolled terminal print may sit beside the helper",
  );

  assert.equal(qaEntryTerminalLine("voice", undefined), "[qa] done");
  assert.equal(qaEntryTerminalLine("voice", 1), "[qa] FAILED");
  assert.equal(qaEntryTerminalLine("retrieval", 1), null, "the retrieval run already reported");
  assert.equal(qaEntryTerminalLine("retrieval", undefined), null);
});

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

test("only a new user message followed by its completed reply passes", () => {
  const baseline = [greeting, typedQuestion, completedAnswer];
  const pendingReply: VoiceQaMessage = { ...completedAnswer, pending: true };
  const messages = [...baseline, transcript, pendingReply];

  assert.equal(qaCompletedVoiceTurnSince(messages, baseline.length), undefined);
  assert.deepEqual(
    qaCompletedVoiceTurnSince([...baseline, transcript, completedAnswer], baseline.length),
    { heard: transcript.text, answered: completedAnswer.text },
  );
});

test("a prior reply or the greeting before a new user message cannot be reused as the answer", () => {
  const baseline = [greeting, completedAnswer];
  // A completed reply that predates the new user message never counts as its answer.
  assert.equal(qaCompletedVoiceTurnSince([...baseline, transcript], baseline.length), undefined);
  // The greeting arrives once, after the microphone baseline and before the first user message.
  assert.equal(qaCompletedVoiceTurnSince([greeting, transcript], 0), undefined);
});

// The canned texts are literals of what the shipped chat renders. A relabel in
// `src/chat/replies.ts` fails here, which is the point: the harness vocabulary has to be
// re-reviewed against the shipped copy instead of drifting along with it.
test("every shipped canned reply classifies as its retrieval outcome", () => {
  const samples: ReadonlyArray<readonly [QaTypedOutcome, string]> = [
    ["clarify", "Which of these did you mean?"],
    ["rephrase", "No entry matched that question. Try rephrasing it."],
    [
      "rephrase",
      "Limited matching: the embedding model is not loaded, and no entry matched by words. Try rephrasing it.",
    ],
    [
      "rephrase",
      "Limited matching: the embedding model failed to load, and no entry matched by words. Try rephrasing it.",
    ],
    ["shorten", "That question is too long. Please ask a shorter one."],
    ["ask-question", "Please ask a question first."],
    ["answer", "A prepared answer about the work at If."],
  ];

  for (const [outcome, text] of samples) {
    assert.equal(qaTypedOutcome({ text, pending: false, error: false }), outcome, text);
  }
});

test("a pending or failed typed question never reads as an answer", () => {
  const clarifyText = "Which of these did you mean?";
  assert.equal(qaTypedOutcome({ text: "", pending: false, error: false }), "pending");
  assert.equal(qaTypedOutcome({ text: "A prepared answer.", pending: true, error: false }), "pending");
  assert.equal(qaTypedOutcome({ text: clarifyText, pending: true, error: false }), "pending");
  assert.equal(qaTypedOutcome({ text: "A prepared answer.", pending: false, error: true }), "error");
  assert.equal(qaTypedOutcome({ text: clarifyText, pending: true, error: true }), "error");
});

test("a note beside an answer classifies as the shipped cue or label only", () => {
  assert.equal(
    qaNoteKind("I am not certain this is the detail you meant."),
    "uncertain",
  );
  assert.equal(
    qaNoteKind("Limited matching: the embedding model is not loaded, so this was found by word overlap."),
    "limited",
  );
  assert.equal(
    qaNoteKind("Limited matching: the embedding model failed to load, so this was found by word overlap."),
    "limited",
  );
  assert.equal(qaNoteKind("Some note the shipped chat does not render"), undefined);
});

test("the matching label maps only the note kinds the shipped chat renders", () => {
  assert.equal(qaMatchLabel(undefined), "semantic");
  assert.equal(qaMatchLabel("uncertain"), "semantic-weak");
  assert.equal(qaMatchLabel("limited"), "limited");
});

function timelineEvent(
  t: number,
  state: string | null,
  overrides: Partial<VoiceQaTimelineEvent> = {},
): VoiceQaTimelineEvent {
  return { t, state, users: 1, speechFailed: false, ...overrides };
}

test("a voice turn counts as speech only in the recorded order and settles back", () => {
  const turn = [
    timelineEvent(1_000, "listening", { users: 0 }),
    timelineEvent(1_200, "listening"),
    timelineEvent(1_400, "thinking"),
    timelineEvent(1_800, "speaking"),
    timelineEvent(2_200, "listening"),
  ];

  assert.deepEqual(qaTurnSpeech(turn, 1_100, 2_500), {
    spoke: true,
    settledListening: true,
    speechFailed: false,
  });
  assert.deepEqual(qaTurnSpeech(turn, 0, 1_100), {
    spoke: false,
    settledListening: true,
    speechFailed: false,
  });
});

test("a recorded speech failure fails only the window it happened in", () => {
  const turn = [
    timelineEvent(1_000, "thinking"),
    timelineEvent(1_500, "listening", { speechFailed: true }),
    timelineEvent(2_000, "listening"),
  ];

  assert.equal(qaTurnSpeech(turn, 500, 2_500).speechFailed, true);
  assert.equal(qaTurnSpeech(turn, 1_600, 2_500).speechFailed, false);
});

test("speaking without its preceding thinking inside the window is not speech evidence", () => {
  const turn = [
    timelineEvent(1_000, "thinking"),
    timelineEvent(1_500, "speaking"),
    timelineEvent(2_000, "listening"),
  ];

  const cutBeforeThinking = qaTurnSpeech(turn, 1_600, 2_500);
  assert.equal(cutBeforeThinking.spoke, false);
  assert.equal(cutBeforeThinking.settledListening, true);

  const stillSpeaking = qaTurnSpeech(turn, 1_600, 1_900);
  assert.equal(stillSpeaking.spoke, false);
  assert.equal(stillSpeaking.settledListening, false);

  const emptyWindow = qaTurnSpeech(turn, 5_000, 6_000);
  assert.deepEqual(emptyWindow, { spoke: false, settledListening: false, speechFailed: false });
});

function meteredObservation(
  overrides: Partial<QaMeteredObservation> = {},
): QaMeteredObservation {
  return {
    saveData: true,
    statusText: "",
    loading: false,
    loadingSeen: false,
    opened: false,
    sent: false,
    answered: false,
    ...overrides,
  };
}

test("the metered walk advances one proven phase at a time and stops at the end", () => {
  let phase: QaMeteredPhase = qaMeteredPhase(undefined, meteredObservation());
  assert.equal(phase, "init-script");

  phase = qaMeteredPhase(
    phase,
    meteredObservation({ statusText: "Data saving is on for this connection." }),
  );
  assert.equal(phase, "pre-open");

  phase = qaMeteredPhase(phase, meteredObservation({ opened: true }));
  assert.equal(phase, "open");

  phase = qaMeteredPhase(phase, meteredObservation({ opened: true, loadingSeen: true }));
  assert.equal(phase, "on-demand");

  phase = qaMeteredPhase(phase, meteredObservation({ opened: true, loadingSeen: true, sent: true }));
  assert.equal(phase, "typed-fill");

  phase = qaMeteredPhase(
    phase,
    meteredObservation({ opened: true, loadingSeen: true, sent: true, answered: true }),
  );
  assert.equal(phase, "finished");

  assert.throws(
    () =>
      qaMeteredPhase(
        phase,
        meteredObservation({ opened: true, loadingSeen: true, sent: true, answered: true }),
      ),
    { message: "metered-phase-overflow" },
  );
});

test("an unproven metered step names its requirement instead of passing", () => {
  assert.throws(() => qaMeteredPhase(undefined, meteredObservation({ saveData: false })), {
    message: "metered-save-data-missing",
  });

  const afterInit: QaMeteredPhase = "init-script";
  assert.throws(() => qaMeteredPhase(afterInit, meteredObservation()), {
    message: "metered-notice-missing",
  });
  assert.throws(
    () =>
      qaMeteredPhase(
        afterInit,
        meteredObservation({ statusText: "Ready.", loading: true }),
      ),
    { message: "metered-notice-missing" },
  );
  assert.throws(
    () =>
      qaMeteredPhase(
        afterInit,
        meteredObservation({ statusText: "Data saving is on.", loading: true }),
      ),
    { message: "metered-loading-before-open" },
  );
  assert.throws(
    () =>
      qaMeteredPhase(
        afterInit,
        meteredObservation({ statusText: "Data saving is on.", opened: true }),
      ),
    { message: "metered-opened-early" },
  );

  const afterPreOpen: QaMeteredPhase = "pre-open";
  assert.throws(() => qaMeteredPhase(afterPreOpen, meteredObservation()), {
    message: "metered-open-missing",
  });

  const afterOpen: QaMeteredPhase = "open";
  assert.throws(() => qaMeteredPhase(afterOpen, meteredObservation({ opened: true })), {
    message: "metered-on-demand-missing",
  });

  const afterOnDemand: QaMeteredPhase = "on-demand";
  assert.throws(
    () => qaMeteredPhase(afterOnDemand, meteredObservation({ opened: true, loadingSeen: true })),
    { message: "metered-question-not-sent" },
  );

  const afterFill: QaMeteredPhase = "typed-fill";
  assert.throws(
    () =>
      qaMeteredPhase(afterFill, meteredObservation({ opened: true, loadingSeen: true, sent: true })),
    { message: "metered-answer-missing" },
  );

  assert.throws(
    () => qaMeteredPhase("opened" as unknown as QaMeteredPhase, meteredObservation()),
    { message: "metered-phase-unknown" },
  );
});

test("the harness classifies replies, notes and metered phases from the shipped chat", () => {
  const script = readFileSync(new URL("../scripts/voice-qa.mjs", import.meta.url), "utf8");

  // The typed wait classifies through qaTypedOutcome, a notice or error fails the run,
  // and a resolved choice must not add a second question (no second inference).
  assert.match(script, /qaTypedOutcome\(state\)/);
  assert.match(script, /`typed-outcome:\$\{typed\.outcome\}`/);
  assert.match(script, /choice-added-a-question/);
  assert.match(script, /usersAfter !== before\.filter/);

  // Notes are classified from the rendered element, and an unknown note fails the run.
  assert.match(script, /qaNoteKind\(text\)/);
  assert.match(script, /kind === undefined/);
  assert.match(script, /unknown-note-kind/);
  assert.match(script, /\[qa\] note kinds:/);

  // The metered walk advances through the shared phase helper and reports each phase.
  assert.match(script, /qaMeteredPhase\(undefined/);
  assert.match(script, /\[qa\] metered phase:/);
  assert.match(script, /\[qa\] metered outcome: answer/);
});
