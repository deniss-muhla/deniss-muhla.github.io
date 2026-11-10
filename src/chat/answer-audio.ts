import type { AssistantClipSequence } from "./audio-catalog.ts";

export type PlaybackPauseOutcome = "active" | "ended" | "cancelled" | "failed";

export interface PlaybackPause {
  ready: Promise<void>;
  isCurrent(): boolean;
  /** Natural end preserves captured admission; explicit cancellation does not. */
  outcome(): PlaybackPauseOutcome;
  resume(): Promise<void>;
}

export interface AnswerAudioPlayer {
  prepare?(): Promise<void>;
  playReferences(sequence: AssistantClipSequence, context: AudioContext, isCurrent?: () => boolean): Promise<void>;
  stop(): void;
  pausePlaying?(): PlaybackPause | null;
  settleOutput?(): Promise<void>;
}
