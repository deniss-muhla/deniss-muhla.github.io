/**
 * Browser-local voice engine for the CV assistant.
 *
 * Models (downloaded once, then cached by the browser; all inference runs locally):
 *  - STT: Moonshine Tiny Streaming (34M) via @moonshine-ai/moonshine-wasm
 *  - LLM: TRLM-135M q4f32_1 via WebLLM (WebGPU), converted from
 *    `Shekswess/trlm-135m` and served from this repository
 *  - LLM preview: a pair named in the page URL instead of the shipped one
 *  - TTS: Pocket TTS INT8 via pocket-tts-js (WASM worker)
 *
 * No embeddings and no retrieval: the public CV markdown is passed to the model
 * as plain prompt context.
 */
import type { MicTranscriber, TranscriptLine } from "@moonshine-ai/moonshine-wasm";
import type { AppConfig, MLCEngine } from "@mlc-ai/web-llm";
import type { PocketTTS, StreamingPlayer } from "pocket-tts-js";

import { buildPromptMessages, cleanAnswer, cleanForDisplay } from "./cv-context";

export type ModelKey = "stt" | "tts" | "llm";
export type ModelState = "idle" | "loading" | "ready" | "error";
export type ModelProgress = Record<ModelKey, number>;
export type ModelStates = Record<ModelKey, ModelState>;

export type SttHandlers = {
  onText?: (text: string) => void;
  onLine?: (line: TranscriptLine) => void;
  onError?: (error: Error) => void;
};

export type AskOptions = {
  onDelta?: (text: string) => void;
  onSpeakingChange?: (speaking: boolean) => void;
  isCurrent?: () => boolean;
  speak?: boolean;
};

const TTS_VOICE = "alba";

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
const PROGRESS_WEIGHTS: Record<ModelKey, number> = { stt: 0.18, tts: 0.27, llm: 0.55 };

/** The models a session needs, smallest first. */
const REQUIRED_MODELS: ModelKey[] = ["stt", "tts", "llm"];

/**
 * Production answer model.
 *
 * TRLM-135M `q4f32_1`, converted from `Shekswess/trlm-135m` at revision
 * `eb6adefde3066b2555a4f88aae9843fcb528d87a` and served from this repository, so
 * a visitor downloads it from the site instead of a model host. The quantized
 * pair needs no `shader-f16`, so one set of bytes serves every WebGPU adapter.
 * `PROVENANCE.md` beside the assets records the digests, the notices and the
 * unresolved upstream notice chain.
 *
 * The path assumes this site is served from the domain root: the project sets
 * no Vite `base`, so `BASE_URL` is `/`. WebLLM rewrites a weights URL that has no
 * `resolve/<revision>/` segment to end in `resolve/main/`, so the path names
 * that segment explicitly and the assets stay in one flat directory.
 */
const LLM_MODEL_ID = "trlm-135m-q4f32_1";
const LLM_MODEL_PATH = `${import.meta.env.BASE_URL}models/trlm-135m/resolve/main/`;
const LLM_LIBRARY_NAME = `${LLM_MODEL_ID}-webgpu.wasm`;

/** A model served over http(s): its weights directory and compiled library. */
export type ModelPair = { modelId: string; modelUrl: string; libraryUrl: string };

/**
 * The shipped pair as the current page can reach it.
 *
 * WebLLM builds URLs from these fields with `new URL()`, which needs an
 * absolute base, so the page origin is added when the pair is asked for rather
 * than while this module is being loaded.
 */
function productionPair(): ModelPair {
  return {
    modelId: LLM_MODEL_ID,
    modelUrl: `${window.location.origin}${LLM_MODEL_PATH}`,
    libraryUrl: `${window.location.origin}${LLM_MODEL_PATH}${LLM_LIBRARY_NAME}`,
  };
}

/**
 * Non-production answer-model preview.
 *
 * `?llmPreview=1` opts in, `?llmModelUrl=` and `?llmWasmUrl=` say where the pair
 * is served from, which lets someone try other bytes against the shipped
 * assistant without changing this repository. Both URLs have to sit on the
 * page's own origin: the site is cross-origin isolated and served over https,
 * so another origin would be mixed content or a blocked fetch, and a link from a
 * third party must not be able to choose the bytes this site downloads, executes
 * and caches. Nothing is stored, so leaving the preview is removing `llmPreview`
 * from the URL and reloading: every load without it keeps the production pair.
 */
export const PREVIEW_FLAG = "llmPreview";
const PREVIEW_MODEL_ID = "trlm-135m-q4f32_1";
const PREVIEW_MODEL_URL = "llmModelUrl";
const PREVIEW_LIBRARY_URL = "llmWasmUrl";

export type PreviewRequest =
  | { state: "off" }
  | { state: "incomplete"; modelId: string; missing: string }
  | { state: "on"; modelId: string; modelUrl: string; libraryUrl: string };

/**
 * A previewed asset URL has to be absolute, on the page's own origin, and
 * without a query or a fragment. WebLLM 0.2.85 concatenates the weights URL
 * with the relative name of every file it fetches and resolves the config
 * against it, so a query or a fragment would end up inside an asset path.
 */
function isAssetUrl(value: string, suffix: string, origin: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === origin && url.search === "" && url.hash === "" &&
      url.pathname.endsWith(suffix);
  } catch {
    return false;
  }
}

/** Reads the preview request from a page query string. Never stores anything. */
export function previewRequest(search: string, origin: string): PreviewRequest {
  const params = new URLSearchParams(search);
  const flag = params.get(PREVIEW_FLAG);
  if (flag !== "1" && flag !== "true") return { state: "off" };

  const modelUrl = params.get(PREVIEW_MODEL_URL) ?? "";
  const libraryUrl = params.get(PREVIEW_LIBRARY_URL) ?? "";
  const missing = [
    ...(isAssetUrl(modelUrl, "/", origin) ? [] : [PREVIEW_MODEL_URL]),
    ...(isAssetUrl(libraryUrl, ".wasm", origin) ? [] : [PREVIEW_LIBRARY_URL]),
  ];
  if (missing.length > 0) {
    return { state: "incomplete", modelId: PREVIEW_MODEL_ID, missing: missing.join(" and ") };
  }
  return { state: "on", modelId: PREVIEW_MODEL_ID, modelUrl, libraryUrl };
}

/** The previewed pair, or null for the production model. Reports missing inputs. */
function llmPreview(): Extract<PreviewRequest, { state: "on" }> | null {
  if (typeof window === "undefined") return null;
  const request = previewRequest(window.location.search, window.location.origin);
  if (request.state === "incomplete") {
    throw new Error(
      `The ${request.modelId} preview needs ${request.missing} in the page URL, ` +
        "as absolute same-origin URLs without a query or a fragment.",
    );
  }
  return request.state === "on" ? request : null;
}

/**
 * Registers a pair with WebLLM. The vendor model-list shape and the URLs stay
 * here, inside the engine boundary.
 */
function localAppConfig(pair: ModelPair): AppConfig {
  return {
    model_list: [
      {
        model: pair.modelUrl,
        model_lib: pair.libraryUrl,
        model_id: pair.modelId,
        // No vram_required_MB: WebLLM 0.2.85 only carries the field as registry
        // metadata and never reads it, so a number here would be a guess.
        required_features: [],
      },
    ],
    cacheBackend: "cache",
  };
}

export type Capabilities = {
  webGpu: boolean;
  shaderF16: boolean;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  microphone: boolean;
  saveData: boolean;
};

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

export async function detectCapabilities(): Promise<Capabilities> {
  let webGpu = false;
  let shaderF16 = false;

  if (typeof navigator !== "undefined" && "gpu" in navigator && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      webGpu = adapter !== null;
      shaderF16 = adapter?.features.has("shader-f16") ?? false;
    } catch {
      webGpu = false;
    }
  }

  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;

  return {
    webGpu,
    shaderF16,
    crossOriginIsolated: window.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer === "function",
    microphone: "getUserMedia" in navigator.mediaDevices,
    saveData: connection?.saveData === true,
  };
}

/** Splits streamed tokens at sentence boundaries so speech can start early. */
class SentenceStream implements AsyncIterable<string> {
  private buffer = "";
  private queue: string[] = [];
  private waiters: Array<(value: string | null) => void> = [];
  private closed = false;

  push(text: string): void {
    if (this.closed) return;
    this.buffer += text;

    for (;;) {
      const boundary = this.buffer.match(/[.!?。！？]+(?:\s+|$)/);
      if (!boundary || boundary.index === undefined) break;
      const end = boundary.index + boundary[0].length;
      this.emit(this.buffer.slice(0, end).trim());
      this.buffer = this.buffer.slice(end);
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.buffer.trim()) this.emit(this.buffer.trim());
    this.buffer = "";
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  private emit(text: string): void {
    if (!text) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(text);
    else this.queue.push(text);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    for (;;) {
      const queued = this.queue.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<string | null>((resolve) => this.waiters.push(resolve));
      if (next === null) return;
      yield next;
    }
  }
}

class VoiceEngine {
  readonly progress: ModelProgress = { stt: 0, tts: 0, llm: 0 };
  readonly states: ModelStates = { stt: "idle", tts: "idle", llm: "idle" };
  capabilities: Capabilities | null = null;

  private listeners = new Set<(progress: ModelProgress, states: ModelStates) => void>();
  private stt: MicTranscriber | null = null;
  private sttHandlers: SttHandlers = {};
  private sttPromise: Promise<void> | null = null;
  private tts: PocketTTS | null = null;
  private ttsVoice: string | null = null;
  private ttsPlayer: StreamingPlayer | null = null;
  private ttsPromise: Promise<void> | null = null;
  private audioContext: AudioContext | null = null;
  private llm: MLCEngine | null = null;
  private llmPair: ModelPair | null = null;
  private llmPromise: Promise<void> | null = null;
  private loadPromise: Promise<void> | null = null;

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

  get overallProgress(): number {
    return (Object.keys(PROGRESS_WEIGHTS) as ModelKey[]).reduce(
      (sum, key) => sum + PROGRESS_WEIGHTS[key] * this.progress[key],
      0,
    );
  }

  get isReady(): boolean {
    return this.states.stt === "ready" && this.states.tts === "ready" && this.states.llm === "ready";
  }

  get isBusy(): boolean {
    return (Object.keys(this.states) as ModelKey[]).some((key) => this.states[key] === "loading");
  }

  get sttSupported(): boolean {
    return this.capabilities?.crossOriginIsolated === true;
  }

  get modelLabel(): string {
    return this.llmPair?.modelId ?? LLM_MODEL_ID;
  }

  /**
   * Where the answer model is served from, so a check can compare the loaded
   * bytes against the recorded digests. Null until a model is ready.
   */
  get llmAssets(): ModelPair | null {
    return this.llmPair;
  }

  /** What the current URL asks for, for the interface to show or explain. */
  get preview(): PreviewRequest {
    if (typeof window === "undefined") return { state: "off" };
    return previewRequest(window.location.search, window.location.origin);
  }

  setSttHandlers(handlers: SttHandlers): void {
    this.sttHandlers = handlers;
  }

  /** Cached capability probe (WebGPU, isolation, metered connection). */
  async detectOnce(): Promise<Capabilities> {
    this.capabilities ??= await detectCapabilities();
    return this.capabilities;
  }

  /**
   * Loads the models a session needs, smallest first.
   *
   * The models are marked loading before the first await, so an interface that
   * starts this on an explicit action shows lifecycle progress instead of an
   * unexplained wait, and the percentages stay the libraries' own events. A
   * model that cannot load does not stop the others; the interface names what
   * is missing and typed input keeps working. Safe to call repeatedly: a model
   * that is already ready or already loading is reused.
   */
  async loadRequiredModels(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;

    for (const key of REQUIRED_MODELS) {
      if (this.states[key] !== "ready") this.setState(key, "loading");
    }

    this.loadPromise = (async () => {
      this.capabilities ??= await detectCapabilities();
      await this.ensureStt().catch(() => undefined);
      await this.ensureTts().catch(() => undefined);
      await this.ensureLlm().catch(() => undefined);
    })().finally(() => {
      this.loadPromise = null;
    });

    return this.loadPromise;
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
      const { PocketTTS, StreamingPlayer } = await import("pocket-tts-js");

      const tts = new PocketTTS({
        language: "english_2026-04",
        quantized: true,
        voiceCloning: false,
        cache: true,
        maxThreads: Math.min(navigator.hardwareConcurrency || 4, 4),
      });

      await tts.load((info) => {
        if (info.total && info.loaded !== undefined) {
          this.setProgress("tts", info.loaded / info.total);
        }
      });

      const voice = await tts.loadVoice(TTS_VOICE);
      this.audioContext ??= new AudioContext();
      const player = new StreamingPlayer({
        sampleRate: tts.sampleRate,
        audioContext: this.audioContext,
        primeSeconds: 0.25,
        leadSeconds: 0.04,
      });

      this.tts = tts;
      this.ttsVoice = voice;
      this.ttsPlayer = player;
      this.setProgress("tts", 1);
      this.setState("tts", "ready");
    })()
      .catch((error: unknown) => {
        this.tts?.destroy();
        this.tts = null;
        this.ttsVoice = null;
        this.ttsPlayer = null;
        this.setState("tts", "error");
        throw error;
      })
      .finally(() => {
        this.ttsPromise = null;
      });

    return this.ttsPromise;
  }

  async ensureLlm(): Promise<void> {
    if (this.states.llm === "ready" && this.llm) return;
    if (this.llmPromise) return this.llmPromise;

    this.llmPromise = (async () => {
      this.capabilities ??= await detectCapabilities();

      if (!this.capabilities.webGpu) {
        throw new Error("The answer model needs WebGPU, which this browser does not provide.");
      }

      const pair = llmPreview() ?? productionPair();
      this.setState("llm", "loading");

      const { CreateMLCEngine } = await import("@mlc-ai/web-llm");
      const engine = await CreateMLCEngine(pair.modelId, {
        appConfig: localAppConfig(pair),
        // The Cache API backend avoids the concurrent IndexedDB write race.
        initProgressCallback: (report) => this.setProgress("llm", report.progress ?? 0),
      });

      this.llm = engine;
      this.llmPair = pair;
      this.setProgress("llm", 1);
      this.setState("llm", "ready");
    })()
      .catch((error: unknown) => {
        this.llm = null;
        this.llmPair = null;
        this.setState("llm", "error");
        throw error;
      })
      .finally(() => {
        this.llmPromise = null;
      });

    return this.llmPromise;
  }

  /**
   * Streams an answer for the question. The streamed text is shown as it
   * arrives; the spoken variant is cleaned and synthesized afterwards so the
   * assistant never reads out markdown, lists or filler preambles.
   */
  async ask(question: string, options: AskOptions = {}): Promise<string> {
    const trimmed = question.trim();
    if (!trimmed) return "";

    await this.ensureLlm();
    if (!this.llm) throw new Error("The answer model is unavailable.");

    const isCurrent = options.isCurrent ?? (() => true);
    let answer = "";

    const stream = (await this.llm.chat.completions.create({
      messages: buildPromptMessages(trimmed),
      temperature: 0.15,
      max_tokens: 120,
      stream: true,
    })) as unknown as AsyncIterable<{
      choices: Array<{ delta?: { content?: string | null } }>;
    }>;

    for await (const chunk of stream) {
      if (!isCurrent()) break;
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (!delta) continue;
      answer += delta;
      // Show readable text while streaming; the final bubble uses cleanAnswer.
      options.onDelta?.(cleanForDisplay(answer));
    }

    trace("raw answer", answer.slice(0, 160));

    if (!isCurrent()) return "";

    const cleaned = cleanAnswer(answer);
    trace("cleaned answer", cleaned);
    if (options.speak && cleaned) {
      options.onSpeakingChange?.(true);
      try {
        await this.speak(cleaned, { isCurrent });
      } catch (error) {
        // Speech output is an addition, not the answer: a visitor who cannot
        // hear it still gets the text, which is the accessible path.
        trace("speak failed", error instanceof Error ? error.message : String(error));
      } finally {
        options.onSpeakingChange?.(false);
      }
    }

    return cleaned;
  }

  async speak(text: string, options: { isCurrent?: () => boolean; onSpeakingChange?: (speaking: boolean) => void } = {}): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    await this.ensureTts();
    const isCurrent = options.isCurrent ?? (() => true);
    this.stopAudio();
    await this.resumeAudio();

    const splitter = new SentenceStream();
    const consumer = this.consumeSentences(splitter, isCurrent);

    for (const token of trimmed.match(/\s*\S+/g) ?? [trimmed]) {
      splitter.push(token);
      await delay(0);
    }
    splitter.close();

    options.onSpeakingChange?.(true);
    await consumer;
    options.onSpeakingChange?.(false);
  }

  private async consumeSentences(
    splitter: SentenceStream,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!this.tts || !this.ttsVoice || !this.ttsPlayer) throw new Error("Speech output is unavailable.");
    const player = this.ttsPlayer;
    const tts = this.tts;
    const voice = this.ttsVoice;

    await player.resume();
    for await (const sentence of splitter) {
      if (!isCurrent()) return;
      await tts.generate(sentence, {
        voice,
        onChunk: (audio, meta) => {
          if (!isCurrent()) return;
          player.play(audio, meta);
        },
      });
    }
    if (isCurrent()) player.flush();
  }

  /** Cancels the current generation, if one is running. */
  interrupt(): void {
    void this.llm?.interruptGenerate().catch(() => undefined);
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

  dispose(): void {
    void this.stt?.close();
    this.ttsPlayer?.reset();
    this.tts?.destroy();
  }
}

export const voiceEngine = new VoiceEngine();

// Debug hook used by the browser QA scripts (?voiceDebug=1).
if (debugEnabled && typeof window !== "undefined") {
  (window as unknown as { __cvVoiceEngine?: VoiceEngine }).__cvVoiceEngine = voiceEngine;
}
