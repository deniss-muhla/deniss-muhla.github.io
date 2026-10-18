import {
  AUDIO_CATALOG_TEXT,
  assistantClipId,
  type AssistantClipReference,
  type AssistantClipSequence,
} from "./audio-catalog.ts";

const MANIFEST_URL = "/audio/assistant/manifest.json";
const AUDIO_DIRECTORY = "/audio/assistant/";
const SHA256_PATTERN = /^[a-f0-9]{64}(?![\s\S])/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*(?![\s\S])/;

export interface AudioSourceIdentity {
  factsSha256: string;
  greetingSha256: string;
  catalogSha256: string;
}

declare const __CV_AUDIO_SOURCE_IDENTITY__: AudioSourceIdentity;

interface AudioManifestClipV2 {
  id: string;
  file: string;
  bytes: number;
  durationSeconds: number;
  sha256: string;
  textSha256: string;
}

interface AudioManifestV2 {
  version: 2;
  factsSha256: string;
  greetingSha256: string;
  catalogSha256: string;
  clips: AudioManifestClipV2[];
}

export type PlaybackPauseOutcome = "active" | "ended" | "cancelled" | "failed";

export interface PlaybackPause {
  ready: Promise<void>;
  isCurrent(): boolean;
  /** Natural end preserves captured admission; explicit cancellation does not. */
  outcome(): PlaybackPauseOutcome;
  resume(): Promise<void>;
}

export interface AnswerAudioPlayer {
  playReferences(sequence: AssistantClipSequence, context: AudioContext, isCurrent?: () => boolean): Promise<void>;
  stop(): void;
  pausePlaying?(): PlaybackPause | null;
  settleOutput?(): Promise<void>;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(value: unknown): AudioManifestV2 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "factsSha256", "greetingSha256", "catalogSha256", "clips"]) ||
    value.version !== 2 ||
    typeof value.factsSha256 !== "string" || !SHA256_PATTERN.test(value.factsSha256) ||
    typeof value.greetingSha256 !== "string" || !SHA256_PATTERN.test(value.greetingSha256) ||
    typeof value.catalogSha256 !== "string" || !SHA256_PATTERN.test(value.catalogSha256) ||
    !Array.isArray(value.clips)
  ) throw new Error("Speech audio could not be played.");

  const ids = new Set<string>();
  let declaredBytes = 0;
  const clips = value.clips.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["id", "file", "bytes", "durationSeconds", "sha256", "textSha256"]) ||
      typeof entry.id !== "string" || !ID_PATTERN.test(entry.id) || ids.has(entry.id) ||
      typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256) ||
      entry.file !== `${entry.id}-${entry.sha256}.mp3` ||
      !Number.isSafeInteger(entry.bytes) || (entry.bytes as number) <= 0 ||
      typeof entry.durationSeconds !== "number" || !Number.isFinite(entry.durationSeconds) || entry.durationSeconds <= 0 ||
      typeof entry.textSha256 !== "string" || !SHA256_PATTERN.test(entry.textSha256)
    ) throw new Error("Speech audio could not be played.");

    const bytes = entry.bytes as number;
    if (bytes > 20 * 1024 * 1024 - declaredBytes) throw new Error("Speech audio could not be played.");
    declaredBytes += bytes;
    ids.add(entry.id);
    return entry as unknown as AudioManifestClipV2;
  });

  return {
    version: 2,
    factsSha256: value.factsSha256,
    greetingSha256: value.greetingSha256,
    catalogSha256: value.catalogSha256,
    clips,
  };
}

function configuredSourceIdentity(): AudioSourceIdentity {
  if (typeof __CV_AUDIO_SOURCE_IDENTITY__ === "undefined") {
    throw new Error("Speech audio could not be played.");
  }
  return __CV_AUDIO_SOURCE_IDENTITY__;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Text(text: string): Promise<string> {
  const encoded = new TextEncoder().encode(text);
  const copy = new Uint8Array(encoded.byteLength);
  copy.set(encoded);
  return sha256(copy.buffer);
}

interface AudioFetchOptions {
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  identity?: AudioSourceIdentity;
}

async function fetchValidatedManifest(options: AudioFetchOptions = {}): Promise<AudioManifestV2> {
  const fetcher = options.fetcher ?? fetch;
  try {
    const identity = options.identity ?? configuredSourceIdentity();
    const response = await fetcher(MANIFEST_URL, { cache: "no-store", signal: options.signal });
    if (!response.ok) throw new Error("manifest");
    const manifest = parseManifest(await response.json());
    if (
      manifest.factsSha256 !== identity.factsSha256 ||
      manifest.greetingSha256 !== identity.greetingSha256 ||
      manifest.catalogSha256 !== identity.catalogSha256
    ) throw new Error("source");
    return manifest;
  } catch {
    throw new Error("Speech audio could not be played.");
  }
}

async function fetchClipBytes(
  manifest: AudioManifestV2,
  request: RequestedAudioClip,
  options: AudioFetchOptions,
): Promise<ArrayBuffer> {
  const fetcher = options.fetcher ?? fetch;
  try {
    const clip = manifest.clips.find((candidate) => candidate.id === request.id);
    if (!clip || clip.textSha256 !== request.textSha256) throw new Error("text");
    const response = await fetcher(`${AUDIO_DIRECTORY}${clip.file}`, { signal: options.signal });
    if (!response.ok) throw new Error("audio");
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== clip.bytes || (await sha256(bytes)) !== clip.sha256) throw new Error("digest");
    return bytes;
  } catch {
    throw new Error("Speech audio could not be played.");
  }
}

function padPlayback(context: AudioContext, audio: AudioBuffer): AudioBuffer {
  const deliveryLatency = [context.baseLatency, context.outputLatency]
    .filter(value => Number.isFinite(value) && value > 0)
    .reduce((total, value) => total + value, 0);
  // Give the output route time to start and drain without rewriting verified clip bytes.
  // Padding lives in the source buffer, so interruption never waits for a delay timer.
  const leading = Math.ceil((0.12 + deliveryLatency) * audio.sampleRate);
  const trailing = Math.ceil((0.2 + deliveryLatency) * audio.sampleRate);
  const padded = context.createBuffer(audio.numberOfChannels, leading + audio.length + trailing, audio.sampleRate);
  for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
    padded.getChannelData(channel).set(audio.getChannelData(channel), leading);
  }
  return padded;
}

interface RequestedAudioClip {
  id: string;
  textSha256: string;
}

interface BoundAudioReference {
  id: string;
  text: string;
}

function snapshotAudioReferences(sequence: unknown): readonly BoundAudioReference[] {
  if (!Array.isArray(sequence)) throw new Error("Speech audio could not be played.");
  return Object.freeze(sequence.map((entry: unknown) => {
    if (!isRecord(entry)) throw new Error("Speech audio could not be played.");
    const kind = entry.kind;
    const text = entry.text;
    if (typeof text !== "string" || text.trim() === "") throw new Error("Speech audio could not be played.");
    let reference: AssistantClipReference;
    if (kind === "catalog") {
      const rawId = entry.id;
      if (typeof rawId !== "string" || !Object.hasOwn(AUDIO_CATALOG_TEXT, rawId)) {
        throw new Error("Speech audio could not be played.");
      }
      const id = rawId as keyof typeof AUDIO_CATALOG_TEXT;
      if (text !== AUDIO_CATALOG_TEXT[id]) throw new Error("Speech audio could not be played.");
      reference = Object.freeze({ kind, id, text });
    } else if (kind === "fact" || kind === "topic") {
      const cardId = entry.cardId;
      if (typeof cardId !== "string") throw new Error("Speech audio could not be played.");
      reference = Object.freeze({ kind, cardId, text });
    } else {
      throw new Error("Speech audio could not be played.");
    }
    return Object.freeze({ id: assistantClipId(reference), text });
  }));
}

/** Web Audio playback with device-latency padding and stop-on-interruption semantics. */
export function createAnswerAudioPlayer(fetcher?: typeof fetch, identity?: AudioSourceIdentity): AnswerAudioPlayer {
  let generation = 0;
  let controller: AbortController | null = null;
  let source: AudioBufferSourceNode | null = null;
  let finishPlayback: (() => void) | null = null;
  let activeContext: AudioContext | null = null;
  let nativeTail: Promise<void> = Promise.resolve();
  let hold: { release(): void; end(): void; released: Promise<void> } | null = null;

  const releaseHold = (): void => { hold?.release(); hold = null; };
  const settleOutput = (): Promise<void> => nativeTail.catch(() => undefined);
  const pausePlaying = (): PlaybackPause | null => {
    const context = activeContext;
    if (!source || !context || context.state !== "running" || hold) return null;
    const token = generation;
    let release!: () => void;
    let ended = false;
    let failureGeneration: number | null = null;
    const candidate = { released: new Promise<void>(resolve => { release = resolve; }), release: () => release(), end: () => { ended = true; } };
    hold = candidate;
    const outcome = (): PlaybackPauseOutcome => {
      if (failureGeneration === generation) return "failed";
      if (generation !== token) return "cancelled";
      if (ended) return "ended";
      return hold === candidate && controller !== null ? "active" : "cancelled";
    };
    const isCurrent = () => outcome() === "active";
    const failPlayback = (): void => {
      if (outcome() === "cancelled") return;
      stop();
      failureGeneration = generation;
    };
    let ready: Promise<void>;
    try { ready = context.suspend(); } catch { ready = Promise.reject(new Error("Speech audio could not be played.")); }
    nativeTail = ready;
    void ready.catch(failPlayback);
    return {
      ready,
      isCurrent,
      outcome,
      async resume() {
        await ready;
        if (!isCurrent()) return;
        const resuming = context.resume();
        nativeTail = resuming;
        try {
          await resuming;
          if (isCurrent()) releaseHold();
        } catch {
          failPlayback();
          throw new Error("Speech audio could not be played.");
        }
      },
    };
  };

  const stop = (): void => {
    generation += 1;
    releaseHold();
    controller?.abort();
    controller = null;
    const activeSource = source;
    source = null;
    activeSource?.stop();
    finishPlayback?.();
    finishPlayback = null;
  };

  const playReferences = async (
    sequence: AssistantClipSequence,
    context: AudioContext,
    isCurrent = () => true,
  ): Promise<void> => {
    let references: readonly BoundAudioReference[];
    try {
      references = snapshotAudioReferences(sequence);
    } catch {
      throw new Error("Speech audio could not be played.");
    }
    if (references.length === 0) return;

    stop();
    const currentGeneration = generation;
    const request = new AbortController();
    controller = request;
    const stillCurrent = (): boolean => currentGeneration === generation && isCurrent();

    try {
      await settleOutput();
      if (!stillCurrent()) return;
      activeContext = context;
      if (context.state !== "running") throw new Error("context");
      const requests = await Promise.all(references.map(async ({ id, text }) => ({
        id,
        textSha256: await sha256Text(text),
      })));
      if (!stillCurrent()) return;
      const manifest = await fetchValidatedManifest({ signal: request.signal, fetcher, identity });
      if (!stillCurrent()) return;

      for (let index = 0; index < requests.length; index += 1) {
        const clip = manifest.clips.find((candidate) => candidate.id === requests[index].id);
        if (!clip || clip.textSha256 !== requests[index].textSha256) throw new Error("text");
      }

      for (const [index, item] of requests.entries()) {
        await hold?.released;
        await settleOutput();
        if (!stillCurrent()) return;
        if (context.state !== "running") throw new Error("context");
        const clipBytes = await fetchClipBytes(manifest, item, { signal: request.signal, fetcher, identity });
        if (!stillCurrent()) return;
        const audio = await context.decodeAudioData(clipBytes.slice(0));
        if (!stillCurrent()) return;
        if (context.state !== "running") throw new Error("context");

        const playback = context.createBufferSource();
        playback.buffer = padPlayback(context, audio);
        playback.connect(context.destination);
        source = playback;

        await new Promise<void>((resolve) => {
          let finished = false;
          const finish = (): void => {
            if (finished) return;
            finished = true;
            playback.onended = null;
            playback.disconnect();
            if (source === playback) {
              source = null;
              // A naturally finished final clip cannot be resumed by a late decision.
              if (index === requests.length - 1) { hold?.end(); releaseHold(); }
            }
            if (finishPlayback === finish) finishPlayback = null;
            resolve();
          };
          finishPlayback = finish;
          playback.onended = finish;
          playback.start();
        });
      }
    } catch {
      if (stillCurrent()) throw new Error("Speech audio could not be played.");
    } finally {
      if (controller === request) { controller = null; activeContext = null; releaseHold(); }
      if (currentGeneration === generation) finishPlayback?.();
    }
  };

  return { playReferences, stop, pausePlaying, settleOutput };
}
