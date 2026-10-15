/**
 * Microphone capture for the Whistle engine.
 *
 * One `AudioContext` at the engine's own 16 kHz rate (the browser resamples the device to
 * it), one worklet that reads the input, and one chunk buffer that hands the engine exact
 * 20 ms mono Float32 frames. The capture request asks for echo cancellation, noise
 * suppression and automatic gain control.
 *
 * The graph runs through a muted gain node to the destination: an unconnected worklet is
 * never pulled, and the muted path means the microphone is never monitored aloud.
 */
import captureProcessorUrl from "./capture-processor.js?url&no-inline";
import { createChunkBuffer } from "./chunk.ts";
import { hasBooleanEchoCancellation } from "./echo-cancellation.ts";

/** The rate the engine transcribes. Requested from the context so the browser resamples once. */
export const STT_SAMPLE_RATE = 16_000;

export interface MicrophoneCapture {
  /** Stops the microphone; whatever was buffered reaches `onChunk` before this resolves. */
  stop(): Promise<void>;
}

export type CaptureFactory = (options: {
  onChunk(samples: Float32Array): void;
  onWarning?(message: string): void;
}) => Promise<MicrophoneCapture>;

export async function createMicrophoneCapture(options: {
  onChunk(samples: Float32Array): void;
  onWarning?(message: string): void;
}): Promise<MicrophoneCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const context = new AudioContext({ sampleRate: STT_SAMPLE_RATE });
  let node: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let mute: GainNode | null = null;

  try {
    for (const track of stream.getAudioTracks()) {
      if (!(await hasBooleanEchoCancellation(track))) {
        options.onWarning?.("Browser echo cancellation was not confirmed. Headphones can reduce the chance that the microphone picks up assistant audio.");
      }
    }
    if (context.state === "suspended") await context.resume().catch(() => undefined);
    await context.audioWorklet.addModule(captureProcessorUrl);

    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, "whistle-capture");
    mute = context.createGain();
    mute.gain.value = 0;

    const buffer = createChunkBuffer(context.sampleRate, STT_SAMPLE_RATE);
    let settleFlush: (() => void) | null = null;

    node.port.onmessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (data instanceof Float32Array) {
        for (const piece of buffer.push(data)) options.onChunk(piece);
        return;
      }
      if (typeof data === "object" && data !== null && (data as { type?: unknown }).type === "flushed") {
        const tail = buffer.flush();
        if (tail) options.onChunk(tail);
        const settle = settleFlush;
        settleFlush = null;
        settle?.();
      }
    };

    source.connect(node);
    node.connect(mute);
    mute.connect(context.destination);

    let stopped = false;
    return {
      async stop() {
        if (stopped) return;
        stopped = true;

        node?.port.postMessage("flush");
        await new Promise<void>((resolve) => {
          settleFlush = resolve;
          // A worklet that never answers must not hold the close open.
          setTimeout(resolve, 250);
        });

        for (const track of stream.getTracks()) track.stop();
        node?.disconnect();
        mute?.disconnect();
        source?.disconnect();
        await context.close().catch(() => undefined);
      },
    };
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    node?.disconnect();
    mute?.disconnect();
    source?.disconnect();
    await context.close().catch(() => undefined);
    throw error;
  }
}
