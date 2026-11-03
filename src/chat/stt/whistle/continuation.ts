import type { PlaybackPause } from "../../answer-audio.ts";
import { createUtteranceGate, FRAME_MILLISECONDS, latestFrameHasSound, type UtteranceEvent } from "./utterance.ts";

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
  let latestAt = -Infinity;
  let latestSound = false;
  let revision = 0;
  let reportedRevision = -1;
  let held: { revision: number; pause: PlaybackPause; events: UtteranceEvent[]; timer: ReturnType<typeof setTimeout> } | null = null;

  const discard = (): void => {
    if (held) clearTimeout(held.timer);
    held = null;
    gate = createUtteranceGate();
  };

  const reportFailure = (candidate: NonNullable<typeof held>): void => {
    if (revision !== candidate.revision || reportedRevision === candidate.revision
      || !options.isCurrent() || candidate.pause.outcome() === "cancelled") return;
    reportedRevision = candidate.revision;
    discard();
    options.onError();
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
        held = null;
        options.onAdmittedStart();
        options.deliver(candidate.events);
      } else {
        // Re-arm admission now: a new question during a delayed native resume must
        // interrupt immediately, not disappear into the rejected burst buffer.
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
          const candidate = { revision, pause, events: [...events], timer: setTimeout(() => void decide(candidate), 200) };
          held = candidate;
          void pause.ready.catch(() => {
            reportFailure(candidate);
          });
          return;
        }
        options.onAdmittedStart();
      }
      if (held) held.events.push(...events);
      else options.deliver(events);
    },
    stop: () => { revision += 1; discard(); },
  };
}
