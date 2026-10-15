import { createAnswerAudioPlayer, type PlaybackPause, type AnswerAudioPlayer } from "./answer-audio.ts";
import type { AssistantClipSequence } from "./audio-catalog.ts";

const SPEECH_OUTPUT_ERROR = "Speech audio could not be played.";

export type SpeechOutputOptions = {
  isCurrent?: () => boolean;
  onSpeakingChange?: (speaking: boolean) => void;
};

export interface SpeechOutput {
  speakSequence(sequence: AssistantClipSequence, options?: SpeechOutputOptions): Promise<void>;
  resumeAudio(): Promise<AudioContext>;
  stop(): void;
  pausePlaying(): PlaybackPause | null;
}

function snapshotSequence(sequence: AssistantClipSequence): AssistantClipSequence {
  return Object.freeze(sequence.map((reference) => Object.freeze({ ...reference })));
}

type ReferencePlayback = {
  started: boolean;
  finished: boolean;
  onSpeakingChange?: (speaking: boolean) => void;
};

export function createSpeechOutput(player: AnswerAudioPlayer = createAnswerAudioPlayer()): SpeechOutput {
  let audioContext: AudioContext | null = null;
  let referenceGeneration = 0;
  let referencePlayback: ReferencePlayback | null = null;

  const resumeAudio = async (): Promise<AudioContext> => {
    try {
      await player.settleOutput?.();
      audioContext ??= new AudioContext();
      if (audioContext.state === "suspended") await audioContext.resume();
      if (audioContext.state !== "running") throw new Error("context-not-running");
      return audioContext;
    } catch {
      throw new Error(SPEECH_OUTPUT_ERROR);
    }
  };

  const finishReferencePlayback = (playback: ReferencePlayback): void => {
    if (playback.finished) return;
    playback.finished = true;
    if (playback.started) playback.onSpeakingChange?.(false);
  };

  const stop = (): void => {
    const playback = referencePlayback;
    referencePlayback = null;
    try {
      player.stop();
    } finally {
      if (playback) finishReferencePlayback(playback);
    }
  };

  const speakSequence = async (
    sequence: AssistantClipSequence,
    options: SpeechOutputOptions = {},
  ): Promise<void> => {
    const isCurrent = options.isCurrent ?? (() => true);
    if (!isCurrent() || sequence.length === 0) return;

    const snapshot = snapshotSequence(sequence);
    const operationGeneration = ++referenceGeneration;
    try {
      stop();
    } catch {
      throw new Error(SPEECH_OUTPUT_ERROR);
    }
    if (!isCurrent() || operationGeneration !== referenceGeneration) return;

    const playback = {
      started: false,
      finished: false,
      onSpeakingChange: options.onSpeakingChange,
    };
    referencePlayback = playback;
    const stillCurrent = (): boolean =>
      referencePlayback === playback && operationGeneration === referenceGeneration && isCurrent();

    try {
      const context = await resumeAudio();
      if (!stillCurrent()) return;
      playback.started = true;
      options.onSpeakingChange?.(true);
      if (!stillCurrent()) return;
      await player.playReferences(snapshot, context, stillCurrent);
    } catch {
      if (stillCurrent()) throw new Error(SPEECH_OUTPUT_ERROR);
    } finally {
      if (referencePlayback === playback) referencePlayback = null;
      finishReferencePlayback(playback);
    }
  };

  return { speakSequence, resumeAudio, stop, pausePlaying: () => player.pausePlaying?.() ?? null };
}
