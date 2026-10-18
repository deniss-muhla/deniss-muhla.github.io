/**
 * Streaming resample-and-chunk of captured microphone audio.
 *
 * The capture path delivers whatever rate the `AudioContext` runs at. This helper
 * interpolates the incoming rate down to the project's 16 kHz mono Float32 stream and
 * emits 20 ms target-rate capture frames. The adapter separately enforces its 16,000-sample
 * process-call boundary because utterance pre-roll may combine a short prior buffer with frames.
 * This is a project boundary, not a claim about an undocumented vendor limit. When the
 * rates match, this code passes samples through unchanged.
 *
 * `flush` returns the leftover shorter than one piece, which is what a stop hands the
 * engine before the stream ends. `push` always drains, so the leftover is always below one
 * piece when `flush` runs.
 */
export interface ChunkBuffer {
  /** Adds source-rate samples and returns every complete target-rate piece they finished. */
  push(samples: Float32Array): Float32Array[];
  /** Resamples what is left and returns it as one short tail, or `null` when nothing is left. */
  flush(): Float32Array | null;
}

export const WHISTLE_PROCESS_SAMPLE_LIMIT = 16_000;

export interface BoundedChunkSender {
  /** Adds samples and emits complete calls no larger than the project frame limit. */
  push(samples: Float32Array): void;
  /** Emits the remaining shorter tail once, then starts empty for the next stream. */
  flush(): void;
}

export function createBoundedChunkSender(sendChunk: (samples: Float32Array) => void): BoundedChunkSender {
  let remainder = new Float32Array(0);

  function emitComplete(samples: Float32Array): void {
    let offset = 0;
    while (samples.length - offset >= WHISTLE_PROCESS_SAMPLE_LIMIT) {
      // The worker transfers the process buffer; give each call an independent buffer so
      // later chunks never reference a detached input or remainder.
      sendChunk(samples.slice(offset, offset + WHISTLE_PROCESS_SAMPLE_LIMIT));
      offset += WHISTLE_PROCESS_SAMPLE_LIMIT;
    }
    if (offset < samples.length) remainder = samples.slice(offset);
  }

  return {
    push(samples) {
      if (samples.length === 0) return;
      if (remainder.length === 0) {
        emitComplete(samples);
        return;
      }
      const combined = new Float32Array(remainder.length + samples.length);
      combined.set(remainder);
      combined.set(samples, remainder.length);
      remainder = new Float32Array(0);
      emitComplete(combined);
    },
    flush() {
      if (remainder.length === 0) return;
      const tail = remainder;
      remainder = new Float32Array(0);
      sendChunk(tail);
    },
  };
}

export function createChunkBuffer(sourceRate: number, targetRate = 16_000): ChunkBuffer {
  if (!(sourceRate > 0) || !(targetRate > 0)) {
    throw new Error(`invalid sample rate: ${sourceRate} -> ${targetRate}`);
  }

  const step = sourceRate / targetRate;
  const frameSamples = Math.max(1, Math.round(targetRate * 0.02));
  let source = new Float32Array(0);
  let position = 0;
  let pending: number[] = [];

  function compact(): void {
    const consumed = Math.floor(position);
    if (consumed <= 0) return;
    source = source.slice(consumed);
    position -= consumed;
  }

  function read(final: boolean): number | null {
    const index = Math.floor(position);
    if (index >= source.length) return null;
    if (index + 1 >= source.length) {
      // The last sample needs no neighbour only once the stream ends; before that it is
      // held back, so an interpolation never reads past the buffer.
      if (!final) return null;
      position = index + 1;
      return source[index];
    }
    const fraction = position - index;
    position += step;
    return source[index] + (source[index + 1] - source[index]) * fraction;
  }

  function drain(final: boolean): Float32Array[] {
    const chunks: Float32Array[] = [];
    for (;;) {
      const value = read(final);
      if (value === null) break;
      pending.push(value);
      if (pending.length === frameSamples) {
        chunks.push(Float32Array.from(pending));
        pending = [];
      }
    }
    compact();
    if (final && pending.length > 0) {
      chunks.push(Float32Array.from(pending));
      pending = [];
    }
    return chunks;
  }

  return {
    push(samples) {
      if (samples.length === 0) return [];
      const merged = new Float32Array(source.length + samples.length);
      merged.set(source, 0);
      merged.set(samples, source.length);
      source = merged;
      return drain(false);
    },

    flush() {
      return drain(true)[0] ?? null;
    },
  };
}
