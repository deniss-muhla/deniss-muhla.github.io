/**
 * Browser-local voice engine for the CV assistant.
 *
 * Models (downloaded once, then cached by the browser; all inference runs locally):
 *  - STT: Cactus-Compute Whistle (whistle.cact) through the project-owned adapter in
 *    `src/chat/stt/whistle`, which runs the vendor engine in a Web Worker
 *  - Query embeddings: the pinned retrieval encoder in its own module worker
 *  - Speech output: selected, content-hashed prerecorded answer clips
 *
 * Questions go to the retrieval controller, which selects one prepared answer from the
 * reviewed index; nothing here generates an answer or builds a CV prompt.
 *
 * The retrieval encoder may be prefetched on an ordinary connection; speech recognition
 * is loaded only after an explicit live-voice choice. Data-saving connections defer the
 * encoder too, until the visitor opens the chat.
 */
import type { SttTranscriber, TranscriptLine } from "./stt/whistle/index.ts";

import type { AnswerAudioPlayer } from "./answer-audio.ts";
import type { AssistantClipSequence } from "./audio-catalog.ts";
import { createSpeechOutput, type SpeechOutput, type SpeechOutputOptions } from "./speech-output.ts";
import {
  createRetrievalController,
  type Answer,
  type FactTopicChoice,
  type QuestionEncoder,
  type RetrievalController,
} from "./retrieval/controller.ts";
import {
  createRetrievalEncoder,
  type EncoderWorkerFactory,
  type RetrievalEncoder,
} from "./retrieval/encoder/index.ts";
import type { ClarificationChoice } from "./retrieval/selection.ts";

export type { Answer, ClarificationChoice, FactTopicChoice };

export type ModelKey = "stt" | "encoder";
export type ModelState = "idle" | "loading" | "ready" | "error";
export type ModelProgress = Record<ModelKey, number>;
export type ModelStates = Record<ModelKey, ModelState>;

/** The connection hint the lifecycle rules read, behind a project-owned seam. */
export type ConnectionInfo = { saveData?: boolean } | undefined;

/**
 * The one navigator storage call the engine makes: `persist()`, which opts the origin
 * out of Chromium's space-based eviction of best-effort data (the Cache Storage files
 * the models live in). Behind a seam so a test can inject a double.
 */
export type StorageSurface = Pick<StorageManager, "persist"> | undefined;

function navigatorStorage(): StorageSurface {
  if (typeof navigator === "undefined") return undefined;
  return navigator.storage;
}

export type SttHandlers = {
  onText?: (text: string) => void;
  onLine?: (line: TranscriptLine) => void;
  onUtteranceStart?: () => void;
  onUtteranceEnd?: () => void;
  onPlaybackError?: () => void;
  onWarning?: (message: string) => void;
  onError?: (error: Error) => void;
};

export type AskOptions = {
  /** Receives the whole prepared answer in one emission. */
  onDelta?: (text: string) => void;
  /** The structured result behind the text: matching label, weak flag, clarification choices. */
  onResult?: (result: Answer) => void;
  isCurrent?: () => boolean;
};

/**
 * Live transcription input.
 *
 * The microphone is the one prerequisite left: the engine itself runs single-threaded in a
 * worker and needs no cross-origin isolation, but a browser without `getUserMedia` (or a
 * visitor who declined the permission) cannot supply audio.
 */

const debugEnabled =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("voiceDebug");

export function trace(...args: unknown[]): void {
  if (!debugEnabled) return;
  console.info("[voice]", ...args);
}
/** Progress weights for the two local model downloads shown by the chat. */
export const PROGRESS_WEIGHTS: Record<ModelKey, number> = {
  stt: 0.2,
  encoder: 0.8,
};

export type Capabilities = {
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  microphone: boolean;
  saveData: boolean;
};

function navigatorConnection(): ConnectionInfo {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { connection?: ConnectionInfo }).connection;
}

export async function detectCapabilities(
  readConnection: () => ConnectionInfo = navigatorConnection,
): Promise<Capabilities> {
  return {
    crossOriginIsolated: window.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer === "function",
    microphone: "getUserMedia" in navigator.mediaDevices,
    saveData: readConnection()?.saveData === true,
  };
}

/**
 * The seams a browser-free test needs. The defaults are the shipped wiring: the reviewed
 * index behind one controller, and the pinned lazy encoder.
 */
export interface VoiceEngineDeps {
  /** Loads the one controller over the one index, on the first topic offer or question. */
  loadController?: () => Promise<RetrievalController>;
  /** The query encoder handed to the controller once it is ready. */
  encoder?: RetrievalEncoder;
  /** Overrides the encoder worker so a browser-free test can drive load progress. */
  workerFactory?: EncoderWorkerFactory;
  /** Overrides answer-audio loading and playback for browser-free lifecycle tests. */
  audioPlayer?: () => AnswerAudioPlayer;
  /** Overrides the speech-to-text adapter so a browser-free test can drive transcription. */
  stt?: () => Promise<SttTranscriber>;
  /** Reads the connection hint (data saving); a test injects a fixed value here. */
  connection?: () => ConnectionInfo;
  /** Reads the navigator storage surface; a test injects a double for the persist ask. */
  storage?: () => StorageSurface;
}

/** Start the browser import at app load so the controlled worker can cache the index code. */
const browserReviewedIndex =
  typeof window === "undefined" ? null : import("./retrieval/reviewed-index.ts");
void browserReviewedIndex?.catch(() => undefined);

async function defaultLoadController(): Promise<RetrievalController> {
  const { reviewedIndex } = await (browserReviewedIndex ?? import("./retrieval/reviewed-index.ts"));
  return createRetrievalController(reviewedIndex());
}

export class VoiceEngine {
  readonly progress: ModelProgress = { stt: 0, encoder: 0 };
  readonly states: ModelStates = { stt: "idle", encoder: "idle" };
  capabilities: Capabilities | null = null;
  /** The last persist grant: technical metadata for `?voiceDebug=1`, never rendered. */
  storagePersisted: boolean | null = null;

  private readonly deps: VoiceEngineDeps;
  private readonly encoder: RetrievalEncoder;
  private controller: RetrievalController | null = null;
  private controllerPromise: Promise<RetrievalController> | null = null;
  /** The turn token. `interrupt` bumps it, which invalidates every in-flight answer. */
  private turn = 0;
  /** Topic loading is independent of speech/output interruptions. */
  private starterRevision = 0;
  private startersDismissed = false;

  private listeners = new Set<(progress: ModelProgress, states: ModelStates) => void>();
  private stt: SttTranscriber | null = null;
  private sttHandlers: SttHandlers = {};
  private sttPromise: Promise<void> | null = null;
  private listeningRequest = 0;
  private readonly speechOutput: SpeechOutput;
  private prefetchPromise: Promise<void> | null = null;

  constructor(deps: VoiceEngineDeps = {}) {
    this.deps = deps;
    const audioPlayer = deps.audioPlayer?.();
    this.speechOutput = createSpeechOutput(audioPlayer);
    // Construction is free: no worker exists and no request is made until a load or embed.
    // The default encoder reports the library's own download progress into the model states.
    this.encoder =
      deps.encoder ??
      createRetrievalEncoder({
        workerFactory: deps.workerFactory,
        onProgress: (progress) => this.setProgress("encoder", progress.percent / 100),
      });
  }

  subscribe(listener: (progress: ModelProgress, states: ModelStates) => void): () => void {
    this.listeners.add(listener);
    listener({ ...this.progress }, { ...this.states });
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const progress = { ...this.progress };
    const states = { ...this.states };
    for (const listener of this.listeners) listener(progress, states);
  }

  private setProgress(key: ModelKey, value: number): void {
    const clamped = Math.max(0, Math.min(1, value));
    if (clamped <= this.progress[key]) return;
    this.progress[key] = clamped;
    this.notify();
  }

  private setState(key: ModelKey, state: ModelState): void {
    this.states[key] = state;
    this.notify();
  }

  get sttSupported(): boolean {
    return this.capabilities?.microphone === true;
  }

  setSttHandlers(handlers: SttHandlers): void {
    this.sttHandlers = handlers;
  }

  /** Cached capability probe (isolation, data-saving connection). */
  async detectOnce(): Promise<Capabilities> {
    this.capabilities ??= await this.detect();
    return this.capabilities;
  }

  private detect(): Promise<Capabilities> {
    return detectCapabilities(this.deps.connection);
  }

  /** May warm the retrieval encoder in the background; speech recognition is consent-gated. */
  async prefetch(): Promise<void> {
    if (this.prefetchPromise) return this.prefetchPromise;

    this.prefetchPromise = (async () => {
      this.capabilities ??= await this.detect();
      // Data saving: no model request before the explicit chat open (design decision 10).
      if (this.capabilities.saveData) return;
      await this.ensureEncoder().catch(() => undefined);
    })().finally(() => {
      this.prefetchPromise = null;
    });

    return this.prefetchPromise;
  }

  /**
   * Asks the browser to exempt this origin from storage-based eviction of best-effort
   * data (the cached model files), once per explicit chat open while the user gesture
   * is still on the stack. The grant result is technical metadata for `?voiceDebug=1`,
   * never a user-facing state: Chromium grants silently on engagement, and a refusal
   * changes nothing in the interface - a later eviction still surfaces through the
   * labeled storage-cleared notice.
   */
  requestPersistentStorage(): void {
    const surface = (this.deps.storage ?? navigatorStorage)();
    if (!surface?.persist) return;
    void surface.persist().then(
      (granted) => {
        this.storagePersisted = granted;
        trace("storage persist granted", granted);
      },
      () => trace("storage persist failed"),
    );
  }

  /**
   * Loads the retrieval encoder on the explicit chat open. Under data saving this is where
   * its request begins; on other connections it joins the background prefetch already in flight.
   * Both entry points share one promise, so a reopen never reloads a cached model. The first
   * state change is synchronous, so the opening panel renders loading instead of an error.
   * The open also asks for persistent storage, synchronously inside the click's gesture.
   */
  async startOnDemand(): Promise<void> {
    this.requestPersistentStorage();
    if (this.prefetchPromise) return this.prefetchPromise;

    this.prefetchPromise = this.ensureEncoder().catch(() => undefined).finally(() => {
      this.prefetchPromise = null;
    });

    return this.prefetchPromise;
  }

  /** Loads the embedding model for semantic matching; the encoder handle deduplicates the load. */
  async ensureEncoder(): Promise<void> {
    if (this.states.encoder === "ready") return;
    this.setState("encoder", "loading");
    try {
      await this.encoder.load();
      this.setProgress("encoder", 1);
      this.setState("encoder", "ready");
    } catch (error) {
      this.setState("encoder", "error");
      throw error;
    }
  }

  /** The one controller over the one index, shared by topic offers and questions. */
  private retrieval(): Promise<RetrievalController> {
    this.controllerPromise ??= (this.deps.loadController ?? defaultLoadController)().then(
      (controller) => {
        this.controller = controller;
        return controller;
      },
    );
    return this.controllerPromise;
  }

  async ensureStt(): Promise<void> {
    if (this.states.stt === "ready" && this.stt) return;
    if (this.sttPromise) return this.sttPromise;

    this.sttPromise = (async () => {
      this.capabilities ??= await detectCapabilities();

      if (!this.sttSupported) {
        throw new Error("Speech recognition needs a microphone, which is unavailable here.");
      }

      trace("stt model", "Cactus Whistle (whistle.cact)");
      this.setState("stt", "loading");
      const transcriber = this.deps.stt
        ? await this.deps.stt()
        : await this.loadWhistleStt();

      this.stt = transcriber;
      await transcriber.load();
      this.setProgress("stt", 1);
      this.setState("stt", "ready");
    })()
      .catch((error: unknown) => {
        this.stt = null;
        this.setState("stt", "error");
        throw error;
      })
      .finally(() => {
        this.sttPromise = null;
      });

    return this.sttPromise;
  }

  /**
   * The shipped adapter: capture, worker session and model download behind one project
   * boundary. Loaded lazily so the vendor runtime and its worker never enter the main
   * bundle, and wired to this engine's handlers so a `setSttHandlers` before or after the
   * load reaches the same callbacks.
   */
  private async loadWhistleStt(): Promise<SttTranscriber> {
    const { createWhistleStt } = await import("./stt/whistle/index.ts");
    return createWhistleStt({
      onProgress: (fraction) => this.setProgress("stt", fraction),
      onText: (text) => this.sttHandlers.onText?.(text),
      onLine: (line) => this.sttHandlers.onLine?.(line),
      onPlaybackOnset: () => this.speechOutput.pausePlaying(),
      onPlaybackError: () => this.sttHandlers.onPlaybackError?.(),
      onUtteranceStart: () => this.sttHandlers.onUtteranceStart?.(),
      onUtteranceEnd: () => this.sttHandlers.onUtteranceEnd?.(),
      onWarning: (message) => this.sttHandlers.onWarning?.(message),
      onError: (error) => this.sttHandlers.onError?.(error),
    });
  }

  async startListening(options: { isCurrent?: () => boolean } = {}): Promise<void> {
    const request = ++this.listeningRequest;
    const consumerCurrent = options.isCurrent ?? (() => true);
    const isCurrent = () => request === this.listeningRequest && consumerCurrent();
    if (!isCurrent()) return;

    void this.resumeAudio().catch(() => undefined);
    await this.ensureStt();
    if (!isCurrent()) return;
    if (!this.stt) throw new Error("Speech recognition is unavailable.");

    const transcriber = this.stt;
    await transcriber.start();
    // Closing or switching to typed chat while start() is pending must not leave capture open.
    if (!isCurrent()) {
      if (request === this.listeningRequest) await transcriber.stop().catch(() => undefined);
      return;
    }
    trace("stt started");
  }

  async stopListening(): Promise<void> {
    this.listeningRequest += 1;
    await this.stt?.stop().catch(() => undefined);
    trace("stt stopped");
  }

  /**
   * Selects one prepared answer for the question. Speech is handled by the shared turn flow
   * from the immutable plan it binds to the visible assistant message.
   *
   * The retrieval controller answers, never a language model: while the encoder is not
   * ready the controller serves the lexical path and labels the result `limited`. The
   * whole answer is emitted once through `onDelta`.
   */
  async ask(question: string, options: AskOptions = {}): Promise<string> {
    const trimmed = question.trim();
    if (!trimmed) return "";

    this.dismissStarters();
    const turn = this.turn;
    const consumerCurrent = options.isCurrent ?? (() => true);
    const isCurrent = () => turn === this.turn && consumerCurrent();

    const controller = await this.retrieval();
    if (!isCurrent()) return "";

    // Semantic matching only from a ready encoder; other states answer limited, while an
    // ordinal follow-up the controller resolves needs no encoder at all.
    const encoder: QuestionEncoder | null =
      this.encoder.state === "ready" ? (query) => this.encoder.embed(query) : null;

    const result = await controller.ask(question, encoder);
    if (result.kind === "superseded" || result.kind === "cancelled" || !isCurrent()) return "";

    options.onResult?.(result);

    if (result.kind !== "answer") {
      trace("answer", result.kind);
      return "";
    }

    trace("answer", result.cardId, result.matching);
    const answer = result.answer;

    options.onDelta?.(answer);

    return isCurrent() ? answer : "";
  }

  /** Loads reviewed topics only: no encoder, microphone or speech-output request. */
  async offerStarters(options: { isCurrent?: () => boolean } = {}): Promise<readonly FactTopicChoice[]> {
    if (this.startersDismissed) return [];
    const revision = this.starterRevision;
    const current = () => revision === this.starterRevision && !this.startersDismissed
      && (options.isCurrent?.() ?? true);
    try {
      const controller = await this.retrieval();
      return current() ? controller.offerStarters() : [];
    } catch {
      return [];
    }
  }

  dismissStarters(): void {
    this.starterRevision += 1;
    this.startersDismissed = true;
    this.controller?.dismissStarters();
  }

  /** The clarification choices the controller currently offers, or `null` when none are. */
  pendingChoices(): readonly ClarificationChoice[] | null {
    return this.controller?.pendingChoices() ?? null;
  }

  /**
   * Resolves a currently offered clarification or starter without a second retrieval.
   *
   * `null` when nothing was offered or the id was not one of the offered choices.
   */
  chooseClarification(cardId: string): Answer | null {
    const picked = this.controller?.chooseClarification(cardId) ?? null;
    if (picked !== null) this.dismissStarters();
    return picked;
  }

  /** Plays the selected message's stored plan without another retrieval or variant selection. */
  speakSequence(sequence: AssistantClipSequence, options: SpeechOutputOptions = {}): Promise<void> {
    return this.speechOutput.speakSequence(sequence, options);
  }

  /** Invalidates the current turn: an in-flight answer or speech can no longer emit. */
  interrupt(): void {
    this.turn += 1;
    this.stopAudio();
  }

  /** Reset only conversation state; loaded models, index and audio remain reusable. */
  resetConversation(): void {
    this.interrupt();
    this.starterRevision += 1;
    this.startersDismissed = false;
    this.controller?.resetConversation();
  }

  resumeAudio(): Promise<AudioContext> {
    return this.speechOutput.resumeAudio();
  }

  stopAudio(): void {
    this.speechOutput.stop();
  }
}

export const voiceEngine = new VoiceEngine();

// Debug hook used by the browser QA scripts (?voiceDebug=1).
if (debugEnabled && typeof window !== "undefined") {
  (window as unknown as { __cvVoiceEngine?: VoiceEngine }).__cvVoiceEngine = voiceEngine;
}
