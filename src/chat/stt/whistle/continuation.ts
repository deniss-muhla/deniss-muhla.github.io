import type { PlaybackPause } from "../../answer-audio.ts";
import { createUtteranceGate, createMinimumVoicedGate, FRAME_MILLISECONDS, latestFrameHasSound, type UtteranceEvent } from "./utterance.ts";

/** Duration trial, not noise classification. Freshness is receipt time, not capture time. */
export function createPlaybackAdmission(options: {
  isCurrent(): boolean;
  pausePlaying(): PlaybackPause | null;
  onOnset(): void;
  onAdmittedStart(): void;
  deliver(events: UtteranceEvent[]): void;
  onError(): void;
}) {
  let gate = createUtteranceGate();
  let minimum = createMinimumVoicedGate();
  let latestAt = -Infinity;
  let latestSound = false;
  let revision = 0;
  let reportedRevision = -1;
  let held: { revision: number; pause: PlaybackPause; events: UtteranceEvent[]; confirmed: boolean; timer: ReturnType<typeof setTimeout> } | null = null;

  const discard = (): void => {
    if (held) clearTimeout(held.timer);
    held = null;
    gate = createUtteranceGate();
    minimum = createMinimumVoicedGate();
  };

  const reportFailure = (candidate: NonNullable<typeof held>): void => {
    if (revision !== candidate.revision || reportedRevision === candidate.revision
      || !options.isCurrent() || candidate.pause.outcome() === "cancelled") return;
    reportedRevision = candidate.revision;
    discard();
    options.onError();
  };

  const release = (candidate: NonNullable<typeof held>, events: UtteranceEvent[]): void => {
    const admitted = minimum.push(events);
    if (admitted.some(event => event.type === "start")) {
      clearTimeout(candidate.timer);
      held = null;
      options.onAdmittedStart();
      options.deliver(admitted);
    } else if (events.some(event => event.type === "end")) {
      discard();
      void candidate.pause.resume().catch(() => reportFailure(candidate));
    }
  };

  const refresh = (candidate: NonNullable<typeof held>): void => {
    clearTimeout(candidate.timer);
    candidate.timer = setTimeout(() => {
      if (held !== candidate) return;
      const resume = options.isCurrent() && candidate.pause.outcome() !== "cancelled";
      discard();
      if (resume) void candidate.pause.resume().catch(() => reportFailure(candidate));
    }, 1000);
  };

  const decide = async (candidate: NonNullable<typeof held>): Promise<void> => {
    if (held !== candidate) return;
    if (!options.isCurrent() || candidate.pause.outcome() === "cancelled") { discard(); return; }
    const age = Date.now() - latestAt;
    const continued = latestSound && age >= 0 && age <= FRAME_MILLISECONDS;
    try {
      await candidate.pause.ready;
      if (held !== candidate || !options.isCurrent() || candidate.pause.outcome() === "cancelled") return;
      if (continued) {
        candidate.confirmed = true;
        refresh(candidate);
        const events = candidate.events;
        candidate.events = [];
        release(candidate, events);
      } else {
        discard();
        await candidate.pause.resume();
      }
    } catch {
      reportFailure(candidate);
    }
  };

  return {
    push(samples: Float32Array): void {
      if (!samples.length || !options.isCurrent()) return;
      if (held && held.pause.outcome() === "cancelled") { discard(); return; }
      latestAt = Date.now();
      latestSound = latestFrameHasSound(samples);
      const events = gate.push(samples);
      if (events.some(event => event.type === "start")) {
        if (held) clearTimeout(held.timer);
        held = null;
        revision += 1;
        options.onOnset();
        const pause = options.pausePlaying();
        if (pause) {
          const candidate = { revision, pause, events: [...events], confirmed: false, timer: setTimeout(() => void decide(candidate), 200) };
          held = candidate;
          void pause.ready.catch(() => {
            reportFailure(candidate);
          });
          return;
        }
      }
      if (held) {
        if (held.confirmed) { refresh(held); release(held, events); }
        else held.events.push(...events);
      } else {
        const admitted = minimum.push(events);
        if (admitted.some(event => event.type === "start")) options.onAdmittedStart();
        options.deliver(admitted);
      }
    },
    stop: () => { revision += 1; discard(); },
  };
}
