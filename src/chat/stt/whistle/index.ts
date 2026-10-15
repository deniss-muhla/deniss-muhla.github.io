/**
 * The Whistle speech-to-text adapter.
 *
 * This is the module the engine loads for live transcription: it opens the microphone,
 * hands the engine ordered 16 kHz mono pieces bounded to one project frame, and turns the engine's
 * committed deltas, pending tail and failures into the three callbacks the chat already
 * speaks through (`onLine`, `onText`, `onError`) plus the byte-accurate download progress.
 *
 * The vendor runtime and its `ccall` marshalling stay one directory below, inside the
 * worker; nothing above this file knows the engine exists.
 *
 * The decoder tail is confirmed only when a real audio pause closes the utterance. That
 * flush ends one question; closing the panel instead discards it. Recognizer update timing
 * is not a speech boundary, and quiet input must not keep re-decoding the previous phrase.
 */
import type { CaptureFactory, MicrophoneCapture } from "./capture.ts";
import { createSttSession, type SttSession, type SttWorkerFactory } from "./loader.ts";
import { STT_ERROR_MESSAGES, readStreamJson } from "./protocol.ts";
import { trace } from "../../engine.ts";
import { createBoundedChunkSender } from "./chunk.ts";
import type { UtteranceEvent } from "./utterance.ts";
import { createPlaybackAdmission } from "./continuation.ts";
import type { PlaybackPause } from "../../answer-audio.ts";

/** One committed piece of transcript, as the chat renders it. */
export type TranscriptLine = { text: string };

export interface WhistleSttHandlers {
  /** The engine's unconfirmed tail after the last commit; interim text for the bubble. */
  onText?: (text: string) => void;
  /** Words the engine has committed. */
  onLine?: (line: TranscriptLine) => void;
  /** Acoustic speech onset at the existing gate, before decoder stop or transcript delivery. */
  onUtteranceStart?: () => void;
  /** A real audio pause, after the decoder's remaining words have been delivered. */
  onUtteranceEnd?: () => void;
  /** Safe output failure category, separate from recognizer/vendor errors. */
  onPlaybackError?: () => void;
  /** A capture limitation the visitor can act on. */
  onWarning?: (message: string) => void;
  /** A failure carrying a safe message; vendor detail is discarded. */
  onError?: (error: Error) => void;
  /** Download progress over everything `load` fetches, 0 to 1. */
  onProgress?: (fraction: number) => void;
}

export interface WhistleSttOptions extends WhistleSttHandlers {
  /** Overridden by the browser-free suite; the defaults build the real worker and microphone. */
  readonly workerFactory?: SttWorkerFactory;
  readonly captureFactory?: CaptureFactory;
  /** Actual native playback ownership; preparation/UI speaking state is insufficient. */
  readonly onPlaybackOnset?: () => PlaybackPause | null;
}

/** What the engine needs from this adapter: the same three calls the old path had. */
export interface SttTranscriber {
  /** Downloads and loads the runtime and model. Later calls share the one load. */
  load(): Promise<void>;
  /** Opens the microphone and starts a new engine stream. */
  start(): Promise<void>;
  /** Closes the microphone, hands the engine its last partial piece and ends the stream. */
  stop(): Promise<void>;
}

/** The microphone path, imported only when the microphone opens: the worklet URL it needs is a
 * build-time asset reference, and a browser-free test injects a double instead. */
async function defaultCaptureFactory(options: {
  onChunk(samples: Float32Array): void;
  onWarning?(message: string): void;
}): Promise<MicrophoneCapture> {
  const { createMicrophoneCapture } = await import("./capture.ts");
  return createMicrophoneCapture(options);
}

/** Maps a capture failure to a message the visitor can act on. */
function captureError(error: unknown): Error {
  const name = (error as { name?: unknown } | null)?.name;
  trace("stt capture failed");
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new Error("Microphone permission was denied.");
  }
  if (name === "NotFoundError") return new Error("No microphone was found.");
  return new Error(STT_ERROR_MESSAGES["capture-failed"]);
}

export function createWhistleStt(options: WhistleSttOptions = {}): SttTranscriber {
  const captureFactory = options.captureFactory ?? defaultCaptureFactory;

  let session: SttSession | null = null;
  let capture: { microphone: MicrophoneCapture; beginClose(): void; flushChunks(): void; disableChunks(): void } | null = null;
  let generation = 0;
  let acceptingResults = false;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let endingUtterance = false;
  // Acoustic ownership advances before the queued decoder drain. A delayed prior
  // stop still drains its samples, but may no longer commit text or restart output.
  let acousticUtterance = 0;
  let decoderUtterance = 0;

  const emitTranscript = (json: string): void => {
    const result = readStreamJson(json);
    if (result === null) {
      trace("stt result unparseable", json.length);
      return;
    }
    if ((result.text ?? "").trim()) options.onLine?.({ text: result.text ?? "" });
    options.onText?.(result.pending ?? "");
  };

  const ensureSession = (): SttSession => {
    session ??= createSttSession({
      workerFactory: options.workerFactory,
      onProgress: (fraction) => options.onProgress?.(fraction),
      onResult: (json) => {
        if (!acceptingResults || decoderUtterance !== acousticUtterance) return;
        emitTranscript(json);
      },
      onStopped: (json) => {
        if (!acceptingResults || !endingUtterance || decoderUtterance !== acousticUtterance) return;
        if (json) emitTranscript(json);
        options.onText?.("");
        options.onUtteranceEnd?.();
      },
      onError: (error) => {
        if (startPromise !== null && capture === null) {
          generation += 1;
          acceptingResults = false;
        }
        acceptingResults = false;
        trace("stt worker error");
        options.onError?.(error);
      },
    });
    return session;
  };

  return {
    async load() {
      await ensureSession().load();
    },

    start() {
      if (stopPromise !== null) return stopPromise.then(() => this.start());
      if (capture) return Promise.resolve();
      if (startPromise !== null) return startPromise;

      const startedGeneration = generation;
      const starting = (async () => {
        await this.load();
        if (startedGeneration !== generation) return;

        const current = ensureSession();
        acousticUtterance = 0;
        decoderUtterance = 0;
        current.start();
        const processChunks = createBoundedChunkSender((samples) => current.sendChunk(samples));
        let sendChunks = true;
        let closing = false;
        const queued: { event: UtteranceEvent; utterance: number }[] = [];
        let draining = false;
        const drain = (): void => {
          if (draining) return;
          if (!sendChunks || startedGeneration !== generation) {
            queued.length = 0;
            return;
          }
          while (queued.length > 0) {
            const { event, utterance } = queued.shift()!;
            if (event.type === "start") {
              decoderUtterance = utterance;
              current.start();
            }
            else if (event.type === "chunk") processChunks.push(event.samples);
            else {
              // Stop replies and their tail belong to this utterance. Flush the bounded
              // remainder before stop; then do not start the next stream until its reply.
              processChunks.flush();
              endingUtterance = true;
              draining = true;
              void current.stop().finally(() => {
                endingUtterance = false;
                draining = false;
                drain();
              });
              return;
            }
          }
        };
        const admission = createPlaybackAdmission({
          isCurrent: () => sendChunks && startedGeneration === generation,
          pausePlaying: () => options.onPlaybackOnset?.() ?? null,
          onOnset: () => { acousticUtterance += 1; },
          onAdmittedStart: () => options.onUtteranceStart?.(),
          deliver: events => {
            queued.push(...events.map(event => ({ event, utterance: acousticUtterance })));
            drain();
          },
          onError: () => options.onPlaybackError?.(),
        });
        let microphone: MicrophoneCapture;
        try {
          microphone = await captureFactory({
            onWarning: options.onWarning,
            onChunk: (samples) => {
              if (!sendChunks) return;
              if (startedGeneration !== generation) {
                if (closing) processChunks.push(samples);
                return;
              }
              admission.push(samples);
            },
          });
        } catch (error) {
          if (startedGeneration !== generation) return;
          throw captureError(error);
        }

        if (startedGeneration !== generation) {
          await microphone.stop().catch(() => undefined);
          sendChunks = false;
          return;
        }

        capture = {
          microphone,
          beginClose: () => { closing = true; admission.stop(); },
          flushChunks: () => processChunks.flush(),
          disableChunks: () => { sendChunks = false; },
        };
        acceptingResults = true;
        trace("stt listening");
      })();
      let activeStart: Promise<void>;
      activeStart = starting.finally(() => {
        if (startPromise === activeStart) startPromise = null;
      });
      startPromise = activeStart;
      return activeStart;
    },

    stop() {
      if (stopPromise !== null) return stopPromise;

      acceptingResults = false;
      generation += 1;
      const current = capture;
      capture = null;
      const pendingStart = startPromise;
      const stopping = (async () => {
        await pendingStart?.catch(() => undefined);
        if (current) {
          // The tail the worklet still holds reaches the engine before the stream ends.
          current.beginClose();
          await current.microphone.stop().catch(() => undefined);
          current.flushChunks();
          current.disableChunks();
        }
        await session?.stop();
        trace("stt stopped");
      })();
      let activeStop: Promise<void>;
      activeStop = stopping.finally(() => {
        if (stopPromise === activeStop) stopPromise = null;
      });
      stopPromise = activeStop;
      return activeStop;
    },
  };
}
