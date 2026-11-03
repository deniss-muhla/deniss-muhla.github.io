/**
 * Acoustic boundaries for the 16 kHz microphone stream, not word filtering.
 * Silent input never starts inference. One second of quiet ends an active utterance;
 * the adapter flushes its decoder tail before telling the chat to submit it.
 */
const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 320;
export const FRAME_MILLISECONDS = FRAME_SAMPLES / SAMPLE_RATE * 1000;
const START_SAMPLES = SAMPLE_RATE * 0.08;
const END_SAMPLES = SAMPLE_RATE;
const PRE_ROLL_SAMPLES = SAMPLE_RATE * 0.2;
// -42 dBFS: below ordinary speech, above near-zero microphone input. This is an
// energy gate, not a guarantee that background noise or loudspeaker audio is speech-free.
const MIN_RMS = 0.008;

export type UtteranceEvent =
  | { type: "start" }
  | { type: "chunk"; samples: Float32Array }
  | { type: "end" };

export function createUtteranceGate(): { push(samples: Float32Array): UtteranceEvent[] } {
  let active = false;
  let voicedSamples = 0;
  let quietSamples = 0;
  let preRoll = new Float32Array(0);

  return {
    push(samples) {
      if (samples.length === 0) return [];
      let onset = false;
      for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
        const end = Math.min(offset + FRAME_SAMPLES, samples.length);
        let energy = 0;
        for (let index = offset; index < end; index += 1) energy += samples[index] ** 2;
        if (Math.sqrt(energy / (end - offset)) >= MIN_RMS) {
          voicedSamples += end - offset;
          quietSamples = 0;
          if (voicedSamples >= START_SAMPLES) onset = true;
        } else {
          voicedSamples = 0;
          quietSamples += end - offset;
        }
      }

      const events: UtteranceEvent[] = [];
      let activeSamples = samples;
      if (!active && onset) {
        active = true;
        events.push({ type: "start" });
        if (preRoll.length > 0) {
          // Do not decode quiet pre-roll as a separate pass. Preserve the onset
          // context, but send it together with the input that opened the gate.
          activeSamples = new Float32Array(preRoll.length + samples.length);
          activeSamples.set(preRoll);
          activeSamples.set(samples, preRoll.length);
        }
        preRoll = new Float32Array(0);
      }
      if (active) {
        events.push({ type: "chunk", samples: activeSamples });
        if (quietSamples >= END_SAMPLES) {
          events.push({ type: "end" });
          active = false;
          voicedSamples = 0;
          quietSamples = 0;
        }
      } else {
        const recent = new Float32Array(preRoll.length + samples.length);
        recent.set(preRoll);
        recent.set(samples, preRoll.length);
        preRoll = recent.slice(-PRE_ROLL_SAMPLES);
      }
      return events;
    },
  };
}

/** The latest completed delivery frame, using the same energy criterion as onset. */
export function latestFrameHasSound(samples: Float32Array): boolean {
  const offset = Math.max(0, samples.length - FRAME_SAMPLES);
  let energy = 0;
  for (let index = offset; index < samples.length; index++) energy += samples[index] ** 2;
  return samples.length > offset && Math.sqrt(energy / (samples.length - offset)) >= MIN_RMS;
}
