/**
 * The audio worklet that reads the microphone.
 *
 * A classic script loaded with `audioWorklet.addModule`: it posts 20 ms frames rather
 * than buffering a full second, allowing the existing acoustic onset gate to react at its
 * unchanged threshold. A `flush` request posts whatever short tail remains and answers
 * with `flushed` so a stop can collect it without dropping samples.
 */
class WhistleCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(Math.max(1, Math.round(sampleRate * 0.02)));
    this.length = 0;
    this.port.onmessage = (event) => {
      if (event.data === "flush") this.flush();
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;

    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(channel.length - offset, this.buffer.length - this.length);
      this.buffer.set(channel.subarray(offset, offset + take), this.length);
      this.length += take;
      offset += take;
      if (this.length === this.buffer.length) this.post();
    }
    return true;
  }

  post() {
    const samples = this.buffer.slice(0, this.length);
    this.length = 0;
    this.port.postMessage(samples, [samples.buffer]);
  }

  flush() {
    if (this.length > 0) this.post();
    this.port.postMessage({ type: "flushed" });
  }
}

registerProcessor("whistle-capture", WhistleCaptureProcessor);
