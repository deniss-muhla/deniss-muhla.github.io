/**
 * Browser-local voice engine for the CV assistant.
 *
 * Models (downloaded once, then cached by the browser; all inference runs locally):
 *  - STT: Moonshine Tiny Streaming (34M) via @moonshine-ai/moonshine-wasm
 *  - Query embeddings: the pinned retrieval encoder in its own module worker
 *  - TTS: Pocket TTS INT8 via pocket-tts-js (WASM worker)
 *
 * Questions go to the retrieval controller, which selects one prepared answer from the
 * reviewed index; nothing here generates an answer or builds a CV prompt.
 *
 * Model loading follows design decision 10: a data-saving connection makes no model
 * request before the explicit chat open (`prefetch` refuses, `startOnDemand` loads there);
 * other connections keep the owner-requested background prefetch.
 */
import type { MicTranscriber, TranscriptLine } from "@moonshine-ai/moonshine-wasm";

import { MODEL_STORAGE_CLEARED_NOTICE } from "./replies.ts";
import {
  createRetrievalController,
  type Answer,
  type QuestionEncoder,
  type RetrievalController,
} from "./retrieval/controller.ts";
import {
  createRetrievalEncoder,
  type EncoderWorkerFactory,
  type RetrievalEncoder,
} from "./retrieval/encoder/index.ts";
import type { ClarificationChoice } from "./retrieval/selection.ts";

export type { Answer, ClarificationChoice };

export type ModelKey = "stt" | "tts" | "encoder";
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
  onError?: (error: Error) => void;
};

export type AskOptions = {
  /** Receives the whole prepared answer in one emission. */
  onDelta?: (text: string) => void;
  /** The structured result behind the text: matching label, weak flag, clarification choices. */
  onResult?: (result: Answer) => void;
  onSpeakingChange?: (speaking: boolean) => void;
  /** Speech failed after the answer was chosen; the answer text itself still stands. */
  onSpeechError?: (error: Error) => void;
  isCurrent?: () => boolean;
  speak?: boolean;
};

const TTS_VOICE = "alba";
/**
 * Same-origin bases for the shipped TTS pair. The vendor joins `language/file` onto
 * `modelBaseUrl` after stripping one trailing slash and defaults `voicesUrl` to the same
 * directory, and it loads the runtime from `ortBaseUrl` as given, so that one keeps its
 * slash. `scripts/model-assets.mjs` pins the bytes these routes serve.
 */
const TTS_MODEL_BASE = "/models/pocket-tts/onnx/";
const TTS_ORT_BASE = "/models/onnxruntime-web/1.20.0/";

/**
 * Playback cushion before speech starts, in seconds of synthesized audio. The
 * vendor default (0.4) leaves too little runway when a phone synthesizes near
 * real time: the schedule must absorb worker chunk gaps and Android output
 * latency, or the player restarts mid-word and the speech sounds jumpy.
 */
export const TTS_PRIME_SECONDS = 1.0;
/** Scheduling lead for the first buffer, so it does not start "late" on a
 * device with a large baseLatency. */
const TTS_LEAD_SECONDS = 0.1;

/** localStorage marker: the speech model was last served from Cache Storage. */
const TTS_CACHE_WARM_KEY = "cv-tts-cache-warm";

function readStorage(key: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: eviction detection stays off rather than false-positive */
  }
}

export type TtsStorageVerdict = "first-visit" | "warm" | "cleared";

/**
 * Classifies one TTS load: `cleared` means a load that previously ran from
 * Cache Storage (the persisted marker) needed a network fetch this time, which
 * is how a browser storage eviction presents itself. Without a marker the same
 * fetch is just the first visit.
 */
export function ttsStorageVerdict(
  marker: string | null,
  observed: { cacheHit: boolean; networkFetch: boolean },
): TtsStorageVerdict {
  if (marker === "1" && observed.networkFetch) return "cleared";
  return observed.cacheHit ? "warm" : "first-visit";
}

/**
 * Classifies one observed TTS load against the warm marker, routes a cleared storage
 * to the chat's labeled notice, and arms the marker on an observed cache hit.
 * Exported so the browser-free suite pins the routing; the TTS load calls it with the
 * panel's notice handler.
 */
export function reportTtsStorageLoad(
  marker: string | null,
  observed: { cacheHit: boolean; networkFetch: boolean },
  notify: (text: string) => void,
): TtsStorageVerdict {
  const verdict = ttsStorageVerdict(marker, observed);
  if (verdict === "cleared") notify(MODEL_STORAGE_CLEARED_NOTICE);
  // Armed only by an observed cache hit: that is the evidence a next load
  // should be able to reuse the storage this load just read.
  if (observed.cacheHit) writeStorage(TTS_CACHE_WARM_KEY, "1");
  return verdict;
}

/**
 * Moonshine architecture used for live transcription.
 *
 * Small Streaming (123M) is the default because Tiny Streaming (34M) mishears
 * too much conversational speech. Tiny stays available as a diagnostic through
 * `?stt=tiny` for slow devices or quick checks.
 */
function sttArchPreference(): "tiny" | "small" {
  if (typeof window === "undefined") return "small";
  return new URLSearchParams(window.location.search).get("stt") === "tiny" ? "tiny" : "small";
}

const debugEnabled =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("voiceDebug");

export function trace(...args: unknown[]): void {
  if (!debugEnabled) return;
  console.info("[voice]", ...args);
}
/**
 * How the download ring weighs each model; keyed so a new model cannot shift the order.
 * Presentation weights only (they sum to 1); retrieval scoring thresholds are unrelated.
 */
export const PROGRESS_WEIGHTS: Record<ModelKey, number> = {
  stt: 0.15,
  tts: 0.25,
  encoder: 0.6,
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

/** One audio piece as the TTS boundary passes it to playback. */
export interface SpeechMeta {
  chunkDuration: number;
  isFirst?: boolean;
  isLast?: boolean;
  isSilence?: boolean;
}

/**
 * Synthesis behind the engine boundary: one call speaks a whole text and streams
 * audio pieces as they are produced. The vendor worker owns internal text
 * chunking and the silence it pads at those boundaries; nothing outside the
 * engine sees it.
 */
export interface SpeechSynth {
  generate(
    text: string,
    options: { voice: string; onChunk: (audio: Float32Array, meta: SpeechMeta) => void },
  ): Promise<unknown>;
  stop(): Promise<void>;
}

/** Playback of streamed audio: schedule, flush, reset, resume. */
export interface SpeechPlayer {
  play(audio: Float32Array, meta: SpeechMeta): void;
  flush(): void;
  reset(): void;
  resume(): Promise<void>;
  /** Scheduling restarts after playback ran dry; a nonzero count is jumpy speech. */
  readonly underruns?: number;
}

/** What one TTS load hands the engine: synthesis, voice, playback. */
export type TtsBinding = { synth: SpeechSynth; voice: string; player: SpeechPlayer };

/**
 * The seams a browser-free test needs. The defaults are the shipped wiring: the reviewed
 * index behind one controller, and the pinned lazy encoder.
 */
export interface VoiceEngineDeps {
  /** Loads the one controller over the one index, on the first question. */
  loadController?: () => Promise<RetrievalController>;
  /** The query encoder handed to the controller once it is ready. */
  encoder?: RetrievalEncoder;
  /** Overrides the encoder worker so a browser-free test can drive load progress. */
  workerFactory?: EncoderWorkerFactory;
  /** Overrides the TTS binding so a browser-free test can drive synthesis and playback. */
  tts?: () => Promise<TtsBinding>;
  /** Reads the connection hint (data saving); a test injects a fixed value here. */
  connection?: () => ConnectionInfo;
  /** Reads the navigator storage surface; a test injects a double for the persist ask. */
  storage?: () => StorageSurface;
}

/** The shipped wiring: the reviewed index through its single Vite import, validated once. */
async function defaultLoadController(): Promise<RetrievalController> {
  const { reviewedIndex } = await import("./retrieval/reviewed-index.ts");
  return createRetrievalController(reviewedIndex());
}

export class VoiceEngine {
  readonly progress: ModelProgress = { stt: 0, tts: 0, encoder: 0 };
  readonly states: ModelStates = { stt: "idle", tts: "idle", encoder: "idle" };
  capabilities: Capabilities | null = null;
  /** The last persist grant: technical metadata for `?voiceDebug=1`, never rendered. */
  storagePersisted: boolean | null = null;

  private readonly deps: VoiceEngineDeps;
  private readonly encoder: RetrievalEncoder;
  private controller: RetrievalController | null = null;
  private controllerPromise: Promise<RetrievalController> | null = null;
  /** The turn token. `interrupt` bumps it, which invalidates every in-flight answer. */
  private turn = 0;

  private listeners = new Set<(progress: ModelProgress, states: ModelStates) => void>();
  private stt: MicTranscriber | null = null;
  private sttHandlers: SttHandlers = {};
  private sttPromise: Promise<void> | null = null;
  private tts: SpeechSynth | null = null;
  private ttsVoice: string | null = null;
  private ttsPlayer: SpeechPlayer | null = null;
  private ttsPromise: Promise<void> | null = null;
  private storageNoticeHandler: ((text: string) => void) | null = null;
  private audioContext: AudioContext | null = null;
  private prefetchPromise: Promise<void> | null = null;

  constructor(deps: VoiceEngineDeps = {}) {
    this.deps = deps;
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
    return this.capabilities?.crossOriginIsolated === true;
  }

  setSttHandlers(handlers: SttHandlers): void {
    this.sttHandlers = handlers;
  }

  /**
   * Hands one chat-facing notice line to the panel (the storage-cleared wording
   * from replies.ts); `null` removes the handler. The panel sets it, the engine
   * only reports the detected event.
   */
  setStorageNoticeHandler(handler: ((text: string) => void) | null): void {
    this.storageNoticeHandler = handler;
  }

  /** Cached capability probe (isolation, data-saving connection). */
  async detectOnce(): Promise<Capabilities> {
    this.capabilities ??= await this.detect();
    return this.capabilities;
  }

  private detect(): Promise<Capabilities> {
    return detectCapabilities(this.deps.connection);
  }

  /** Loads the models in the background: the retrieval encoder first, then speech. */
  async prefetch(): Promise<void> {
    if (this.prefetchPromise) return this.prefetchPromise;

    this.prefetchPromise = (async () => {
      this.capabilities ??= await this.detect();
      // Data saving: no model request before the explicit chat open (design decision 10).
      if (this.capabilities.saveData) return;
      await this.loadModels();
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
      (error: unknown) =>
        trace("storage persist failed", error instanceof Error ? error.message : String(error)),
    );
  }

  /**
   * Loads the models on the explicit chat open. Under data saving this is where every model
   * request begins; on other connections it joins the background prefetch already in flight.
   * Both entry points share one promise, so a reopen never reloads a cached model. The first
   * state change is synchronous, so the opening panel renders loading instead of an error.
   * The open also asks for persistent storage, synchronously inside the click's gesture.
   */
  async startOnDemand(): Promise<void> {
    this.requestPersistentStorage();
    if (this.prefetchPromise) return this.prefetchPromise;

    this.prefetchPromise = this.loadModels().finally(() => {
      this.prefetchPromise = null;
    });

    return this.prefetchPromise;
  }

  private async loadModels(): Promise<void> {
    await this.ensureEncoder().catch(() => undefined);
    await this.ensureStt().catch(() => undefined);
    await this.ensureTts().catch(() => undefined);
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

  /** The one controller over the one index, created once on the first question. */
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
        throw new Error(
          "Speech recognition needs a cross-origin isolated page (SharedArrayBuffer).",
        );
      }

      const sttArch = sttArchPreference();
      trace("stt model", sttArch === "tiny" ? "Moonshine Tiny Streaming" : "Moonshine Small Streaming");
      this.setState("stt", "loading");
      // Served from the project-owned /moonshine/ route, which streams the
      // unmodified upstream runtime in dev and emits it in the build; see the
      // moonshine-runtime plugins in vite.config.ts for why it is not bundled.
      const runtimeUrl = `${import.meta.env.BASE_URL}moonshine/index.js`;
      const { MicTranscriber, ModelArch } = (await import(
        /* @vite-ignore */ runtimeUrl
      )) as typeof import("@moonshine-ai/moonshine-wasm");
      const transcriber = new MicTranscriber()
        .language("en")
        .audioConstraints({ echoCancellation: true, noiseSuppression: true, autoGainControl: true })
        .modelArch(sttArch === "tiny" ? ModelArch.TinyStreaming : ModelArch.SmallStreaming)
        .onProgress((fraction) => this.setProgress("stt", fraction))
        .onText((text) => this.sttHandlers.onText?.(text))
        .onLine((line) => this.sttHandlers.onLine?.(line))
        .onError((error) => this.sttHandlers.onError?.(error));

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

  async startListening(): Promise<void> {
    await this.ensureStt();
    if (!this.stt) throw new Error("Speech recognition is unavailable.");
    await this.stt.start();
    trace("stt started");
  }

  async stopListening(): Promise<void> {
    await this.stt?.stop().catch(() => undefined);
    trace("stt stopped");
  }

  async ensureTts(): Promise<void> {
    if (this.states.tts === "ready" && this.tts && this.ttsVoice && this.ttsPlayer) return;
    if (this.ttsPromise) return this.ttsPromise;

    this.ttsPromise = (async () => {
      this.setState("tts", "loading");
      try {
        const binding = this.deps.tts ? await this.deps.tts() : await this.loadPocketTts();
        this.tts = binding.synth;
        this.ttsVoice = binding.voice;
        this.ttsPlayer = binding.player;
        this.setProgress("tts", 1);
        this.setState("tts", "ready");
      } catch (error) {
        this.tts = null;
        this.ttsVoice = null;
        this.ttsPlayer = null;
        this.setState("tts", "error");
        throw error;
      }
    })()
      .finally(() => {
        this.ttsPromise = null;
      });

    return this.ttsPromise;
  }

  /**
   * The shipped TTS pair behind its public surface: models, worker and playback
   * options stay inside this method. The load progress both drives the ring and
   * classifies the cache: a warm marker that now needs a network fetch is how a
   * browser storage eviction presents itself, so the panel can say why the model
   * is loading again.
   */
  private async loadPocketTts(): Promise<TtsBinding> {
    const { PocketTTS, StreamingPlayer } = await import("pocket-tts-js");

    const tts = new PocketTTS({
      language: "english_2026-04",
      quantized: true,
      voiceCloning: false,
      cache: true,
      maxThreads: Math.min(navigator.hardwareConcurrency || 4, 4),
      modelBaseUrl: TTS_MODEL_BASE,
      ortBaseUrl: TTS_ORT_BASE,
    });

    try {
      let cacheHit = false;
      let networkFetch = false;
      await tts.load((info) => {
        if (info.total && info.loaded !== undefined) {
          this.setProgress("tts", info.loaded / info.total);
        }
        if (info.fromCache === true) cacheHit = true;
        if (info.fromCache === false) networkFetch = true;
      });
      const voice = await tts.loadVoice(TTS_VOICE);

      const verdict = reportTtsStorageLoad(
        readStorage(TTS_CACHE_WARM_KEY),
        { cacheHit, networkFetch },
        (text) => this.storageNoticeHandler?.(text),
      );
      trace("tts storage", verdict);

      this.audioContext ??= new AudioContext();
      const player = new StreamingPlayer({
        sampleRate: tts.sampleRate,
        audioContext: this.audioContext,
        primeSeconds: TTS_PRIME_SECONDS,
        leadSeconds: TTS_LEAD_SECONDS,
        onUnderrun: (info) => trace("underrun", Math.round(info.gapSeconds * 1000), info.count),
      });

      return { synth: tts, voice, player };
    } catch (error) {
      tts.destroy();
      throw error;
    }
  }

  /**
   * Selects one prepared answer for the question and, when asked, speaks it.
   *
   * The retrieval controller answers, never a language model: while the encoder is not
   * ready the controller serves the lexical path and labels the result `limited`. The
   * whole answer is emitted once through `onDelta`, and a speech failure is reported
   * through `onSpeechError` instead of losing the text.
   */
  async ask(question: string, options: AskOptions = {}): Promise<string> {
    const trimmed = question.trim();
    if (!trimmed) return "";

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

    if (options.speak && answer) {
      options.onSpeakingChange?.(true);
      try {
        await this.speak(answer, { isCurrent });
      } catch (error) {
        // The chat already has the text; only speech failed, so report it and keep the answer.
        options.onSpeechError?.(error instanceof Error ? error : new Error(String(error)));
        trace("speech failed");
      } finally {
        options.onSpeakingChange?.(false);
      }
    }

    return isCurrent() ? answer : "";
  }

  /** The clarification choices the controller currently offers, or `null` when none are. */
  pendingChoices(): readonly ClarificationChoice[] | null {
    return this.controller?.pendingChoices() ?? null;
  }

  /**
   * Resolves a pick from the last clarification without a second embedding.
   *
   * `null` when nothing was offered or the id was not one of the offered choices.
   */
  chooseClarification(cardId: string): Answer | null {
    return this.controller?.chooseClarification(cardId) ?? null;
  }

  async speak(text: string, options: { isCurrent?: () => boolean; onSpeakingChange?: (speaking: boolean) => void } = {}): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    await this.ensureTts();
    const isCurrent = options.isCurrent ?? (() => true);
    this.stopAudio();
    await this.resumeAudio();

    options.onSpeakingChange?.(true);
    try {
      await this.generateSpeech(trimmed, isCurrent);
    } finally {
      options.onSpeakingChange?.(false);
    }
  }

  /**
   * Synthesizes the whole text in one call and plays the streamed pieces as they
   * arrive. One call keeps the vendor worker's own text grouping and the silence
   * it pads at those boundaries. Sentence-at-a-time calls instead stall between
   * every sentence (worker setup plus a main-thread round trip, no pad), and on a
   * phone synthesizing near real time that starves the playback schedule into
   * mid-word pauses.
   */
  private async generateSpeech(text: string, isCurrent: () => boolean): Promise<void> {
    if (!this.tts || !this.ttsVoice || !this.ttsPlayer) throw new Error("Speech output is unavailable.");
    const synth = this.tts;
    const player = this.ttsPlayer;
    const voice = this.ttsVoice;

    await player.resume();
    const startedAt = performance.now();
    let audioSeconds = 0;
    let chunks = 0;
    let stoppedForTurn = false;
    await synth.generate(text, {
      voice,
      onChunk: (audio, meta) => {
        audioSeconds += meta.chunkDuration;
        chunks += 1;
        if (!isCurrent()) {
          // The turn that wanted this speech is gone: cut synthesis and playback
          // once, then drop the remaining pieces.
          if (!stoppedForTurn) {
            stoppedForTurn = true;
            this.stopAudio();
          }
          return;
        }
        player.play(audio, meta);
      },
    });
    if (isCurrent()) player.flush();
    trace("speech", {
      ms: Math.round(performance.now() - startedAt),
      audioSec: Math.round(audioSeconds * 10) / 10,
      chunks,
      underruns: player.underruns ?? 0,
    });
  }

  /** Invalidates the current turn: an in-flight answer or speech can no longer emit. */
  interrupt(): void {
    this.turn += 1;
  }

  async resumeAudio(): Promise<AudioContext> {
    this.audioContext ??= new AudioContext();
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume().catch(() => undefined);
    }
    return this.audioContext;
  }

  stopAudio(): void {
    this.ttsPlayer?.reset();
    void this.tts?.stop().catch(() => undefined);
  }
}

export const voiceEngine = new VoiceEngine();

// Debug hook used by the browser QA scripts (?voiceDebug=1).
if (debugEnabled && typeof window !== "undefined") {
  (window as unknown as { __cvVoiceEngine?: VoiceEngine }).__cvVoiceEngine = voiceEngine;
}
