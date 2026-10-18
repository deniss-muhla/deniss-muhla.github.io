import { describeReply, type ReplyView } from "../src/chat/replies.ts";
import type { Answer } from "../src/chat/retrieval/controller.ts";

export type VoiceQaMode = "voice" | "retrieval";

/** The workloads this entry point owns. `voice` stays the default. */
const QA_MODES: readonly VoiceQaMode[] = ["voice", "retrieval"];

/**
 * Which workload `scripts/voice-qa.mjs` runs.
 *
 * The repository requires model and browser checks through this entry point, and the
 * embedding query path is a second workload behind the same headed browser. The mode is
 * read from one `--qa=` argument, so every existing voice command keeps its meaning.
 *
 * @param argv the process arguments
 * @returns the requested mode, or `voice` when none is asked for
 * @throws Error on an unknown mode, instead of silently running the wrong check
 */
export function selectQaMode(argv: readonly string[]): VoiceQaMode {
  const requested = argv.find((argument) => argument.startsWith("--qa="))?.slice("--qa=".length);

  if (requested === undefined) return "voice";

  const mode = QA_MODES.find((candidate) => candidate === requested);

  if (mode === undefined) {
    throw new Error(`unknown-qa-mode:${requested}. Use one of ${QA_MODES.join(", ")}, or no --qa argument.`);
  }

  return mode;
}

export type QaVoiceConsentChoice = "typed" | "live";

/**
 * Chooses the application's explicit mode from the requested QA workload.
 * A default/typed-only run must never grant microphone permission or enter live voice.
 *
 * @param fakeMicrophoneRequested whether this run explicitly supplied a fake input WAV
 * @returns the UI choice the runner must select after opening the panel
 */
export function qaVoiceConsentChoice(fakeMicrophoneRequested: boolean): QaVoiceConsentChoice {
  return fakeMicrophoneRequested ? "live" : "typed";
}

/** The validated finite-playback Chromium switch used by real fake-mic QA workloads. */
export function qaFiniteFakeAudioCaptureArg(wavPath: string): string {
  if (wavPath.length === 0 || wavPath.includes("\0")) {
    throw new Error("invalid-fake-audio-capture-path");
  }
  return `--use-file-for-fake-audio-capture=${wavPath}%noloop`;
}

/**
 * The terminal line `scripts/voice-qa.mjs` prints after its own workload.
 *
 * The voice run reports its outcome only here. The retrieval workload already prints its
 * cleanup and its own `[qa] done`/`[qa] FAILED` line, so the entry stays silent after it:
 * one run, one terminal line.
 *
 * @param mode the workload the entry dispatched
 * @param exitCode the process exit code the run settled with
 * @returns the line to print, or `null` when the workload already reported
 */
export function qaEntryTerminalLine(mode: VoiceQaMode, exitCode: number | undefined): string | null {
  if (mode === "retrieval") return null;
  return exitCode ? "[qa] FAILED" : "[qa] done";
}

export type VoiceQaMessage = {
  text: string;
  pending: boolean;
  assistant: boolean;
  user: boolean;
};

/** One recorded turn-timeline event: the status state and counters, never message text. */
export type VoiceQaTimelineEvent = {
  t: number;
  state: string | null;
  users: number;
  speechFailed: boolean;
};

/**
 * The speech evidence for one turn from the recorded timeline: the answer path
 * reached `speaking` after its `thinking` state, settled back to `listening` and
 * never recorded a speech failure inside the window. A clarification choice speaks
 * without a preceding `thinking` of its own, which still sits after the turn's
 * `thinking` inside the window.
 *
 * @param events the timeline recorded in the page
 * @param fromMs inclusive window start (the turn's first observable event)
 * @param toMs inclusive window end (after the turn completed)
 * @returns whether speech ran and where the turn settled, without reading audio
 */
export function qaTurnSpeech(
  events: readonly VoiceQaTimelineEvent[],
  fromMs: number,
  toMs: number,
): { spoke: boolean; settledListening: boolean; speechFailed: boolean } {
  const window = events.filter((event) => event.t >= fromMs && event.t <= toMs);
  const states = window.map((event) => event.state);
  const thinkingAt = states.indexOf("thinking");
  return {
    spoke: thinkingAt !== -1 && states.slice(thinkingAt + 1).includes("speaking"),
    settledListening: states.length > 0 && states[states.length - 1] === "listening",
    speechFailed: window.some((event) => event.speechFailed),
  };
}

export type QaMatchLabel = "semantic" | "semantic-weak" | "limited";

/**
 * The matching label behind a rendered answer, derived from the only note the chat
 * renders beside it (`describeReply`): no note is a confident semantic selection,
 * the uncertainty cue is a semantic selection below the confidence floor, and the
 * limited label is word-overlap matching.
 *
 * @param note the kind of the rendered note, or `undefined` when no note renders
 * @returns the matching label the DOM can prove
 */
export function qaMatchLabel(note: QaNoteKind | undefined): QaMatchLabel {
  if (note === undefined) return "semantic";
  if (note === "limited") return "limited";
  return "semantic-weak";
}

export function qaOfflineReloadSucceeded(state: {
  online: boolean;
  isolated: boolean;
  hasBadge: boolean;
}): boolean {
  return !state.online && state.isolated && state.hasBadge;
}

export function qaModelsReady(status: string): boolean {
  return status.startsWith("Ready");
}

export function qaCompletedVoiceTurnSince(
  messages: readonly VoiceQaMessage[],
  baselineCount: number,
): { heard: string; answered: string } | undefined {
  for (let userIndex = baselineCount; userIndex < messages.length; userIndex += 1) {
    const userMessage = messages[userIndex];
    if (!userMessage?.user || userMessage.text.length <= 8) continue;

    const answer = messages.slice(userIndex + 1).find(
      (message) => message.assistant && !message.pending && message.text.length > 20,
    );
    if (answer) return { heard: userMessage.text, answered: answer.text };
  }
}

/** What a typed question produced, classified from what the shipped chat rendered. */
export type QaTypedOutcome =
  | "clarify"
  | "rephrase"
  | "shorten"
  | "ask-question"
  | "answer"
  | "pending"
  | "error";

/** The note beside an answer: the uncertainty cue or a limited-matching label. */
export type QaNoteKind = "uncertain" | "limited";

/** One step of the metered lifecycle walk `scripts/voice-qa.mjs` records. */
export type QaMeteredPhase =
  | "init-script"
  | "pre-open"
  | "open"
  | "on-demand"
  | "typed-fill"
  | "finished";

type AnswerResult = Extract<Answer, { kind: "answer" }>;

function answerResult(overrides: Partial<AnswerResult> = {}): AnswerResult {
  return {
    kind: "answer",
    cardId: "card",
    topic: "topic",
    answer: "prepared answer",
    matching: "semantic",
    weak: false,
    ...overrides,
  };
}

function noteOf(result: Answer): string {
  const view: ReplyView = describeReply(result);
  if (view.kind !== "answer" || view.note === null) throw new Error("qa-note-mapping");
  return view.note;
}

/** The only notes the shipped chat renders, derived from `describeReply` itself. */
const SHIPPED_NOTES: ReadonlyArray<readonly [QaNoteKind, string]> = [
  ["uncertain", noteOf(answerResult({ weak: true }))],
  ["limited", noteOf(answerResult({ matching: "limited", limitedCause: "model-unavailable" }))],
  ["limited", noteOf(answerResult({ matching: "limited", limitedCause: "embedding-failed" }))],
];

/** The canned reply texts, derived from `describeReply`, so a relabel fails here visibly. */
const REPLY_SAMPLES: ReadonlyArray<readonly [QaTypedOutcome, Answer]> = [
  ["clarify", { kind: "clarify", choices: [] }],
  ["rephrase", { kind: "rephrase", matching: "semantic" }],
  ["rephrase", { kind: "rephrase", matching: "limited", limitedCause: "model-unavailable" }],
  ["rephrase", { kind: "rephrase", matching: "limited", limitedCause: "embedding-failed" }],
  ["shorten", { kind: "shorten", reason: "query/too-long" }],
  ["ask-question", { kind: "ask-question" }],
];

const OUTCOMES_BY_TEXT: ReadonlyMap<string, QaTypedOutcome> = new Map(
  REPLY_SAMPLES.flatMap(
    ([outcome, result]): ReadonlyArray<readonly [string, QaTypedOutcome]> => {
      const view: ReplyView = describeReply(result);
      if (view.kind === "notice") return [[view.text, outcome]];
      if (view.kind === "choices") return [[view.prompt, outcome]];
      return [];
    },
  ),
);

/**
 * Classifies one typed question from the rendered reply, never from page internals.
 *
 * @param state the newest assistant message after the question and the status line state
 * @returns the shipped outcome, or `pending` while no completed reply exists yet
 */
export function qaTypedOutcome(state: { text: string; pending: boolean; error: boolean }): QaTypedOutcome {
  if (state.error) return "error";
  if (state.pending || state.text === "") return "pending";
  return OUTCOMES_BY_TEXT.get(state.text) ?? "answer";
}

/**
 * @param note the rendered note text beside an answer
 * @returns how the shipped chat classifies it, or `undefined` for an unknown note
 */
export function qaNoteKind(note: string): QaNoteKind | undefined {
  return SHIPPED_NOTES.find(([, text]) => text === note)?.[0];
}

/** What one metered page shows; each phase reads the fields it requires. */
export type QaMeteredObservation = {
  /** The page still reports the data-saving connection hint. */
  saveData: boolean;
  /** The status line text as read from the page. */
  statusText: string;
  /** The assistant button reports model loading right now. */
  loading: boolean;
  /** Model loading has been observed since the explicit open. */
  loadingSeen: boolean;
  /** The panel has been opened through its explicit control. */
  opened: boolean;
  /** A typed question has been sent. */
  sent: boolean;
  /** Its reply has completed. */
  answered: boolean;
};

const METERED_PHASES: readonly QaMeteredPhase[] = [
  "init-script",
  "pre-open",
  "open",
  "on-demand",
  "typed-fill",
  "finished",
];

/**
 * Advances the metered walk by exactly one phase when the observation proves it.
 *
 * The harness calls this once per phase. The returned name is the phase whose
 * requirements the current observation just proved, so a skipped, reordered or
 * unproven step throws instead of quietly passing, and each failure message names
 * the requirement without carrying page content.
 *
 * @param phase the phase reached so far, or `undefined` before the first one
 * @param observation what the metered page currently shows
 * @returns the next phase
 * @throws Error naming the requirement that failed, or `metered-phase-overflow` past the end
 */
export function qaMeteredPhase(
  phase: QaMeteredPhase | undefined,
  observation: QaMeteredObservation,
): QaMeteredPhase {
  const index = phase === undefined ? -1 : METERED_PHASES.indexOf(phase);
  if (phase !== undefined && index === -1) throw new Error("metered-phase-unknown");

  const next = METERED_PHASES[index + 1];
  if (next === undefined) throw new Error("metered-phase-overflow");

  switch (next) {
    case "init-script":
      if (!observation.saveData) throw new Error("metered-save-data-missing");
      break;
    case "pre-open":
      // The same copy pin `qaModelsReady` applies to the readiness line.
      if (!observation.statusText.startsWith("Data saving")) {
        throw new Error("metered-notice-missing");
      }
      if (observation.loading) throw new Error("metered-loading-before-open");
      if (observation.opened) throw new Error("metered-opened-early");
      break;
    case "open":
      if (!observation.opened) throw new Error("metered-open-missing");
      break;
    case "on-demand":
      if (!observation.loadingSeen) throw new Error("metered-on-demand-missing");
      break;
    case "typed-fill":
      if (!observation.sent) throw new Error("metered-question-not-sent");
      break;
    case "finished":
      if (!observation.answered) throw new Error("metered-answer-missing");
      break;
  }
  return next;
}
