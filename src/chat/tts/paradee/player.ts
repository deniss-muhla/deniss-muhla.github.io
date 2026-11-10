import type { PlaybackPause, PlaybackPauseOutcome } from "../../answer-audio.ts";

export class ParadeePlayer {
  private worker: Worker | null = null;
  private generation = 0;
  private source: AudioBufferSourceNode | null = null;
  private context: AudioContext | null = null;
  private nativeTail: Promise<void> = Promise.resolve();
  private pending: ((error: Error) => void) | null = null;
  private preparing: Promise<void> | null = null;

  private getWorker(): Worker {
    return this.worker ??= new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  }

  prepare(): Promise<void> {
    if (this.preparing) return this.preparing;
    const worker = this.getWorker();
    this.preparing = new Promise<void>((resolve, reject) => {
      const cleanup = () => { worker.removeEventListener("message", message); worker.removeEventListener("error", error); };
      const message = (event: MessageEvent<{ id: number; ready?: boolean; error?: boolean }>) => {
        if (event.data.id !== -1) return;
        cleanup();
        if (event.data.ready) resolve(); else reject(new Error("Speech model unavailable"));
      };
      const error = () => { cleanup(); reject(new Error("Speech model unavailable")); };
      worker.addEventListener("message", message);
      worker.addEventListener("error", error);
      worker.postMessage({ id: -1, prepare: true });
    }).catch((error: unknown) => { this.preparing = null; throw error; });
    return this.preparing;
  }

  stop(): void {
    this.generation++;
    this.source?.stop();
    this.source = null;
    this.pending?.(new Error("cancelled"));
    this.pending = null;
  }

  settleOutput(): Promise<void> { return this.nativeTail.catch(() => undefined); }

  pausePlaying(): PlaybackPause | null {
    const context = this.context;
    if (!context || !this.source) return null;
    const id = this.generation;
    const source = this.source;
    let failed = false;
    const outcome = (): PlaybackPauseOutcome => failed ? "failed" : this.generation !== id ? "cancelled"
      : this.source !== source ? "ended" : "active";
    const isCurrent = () => outcome() === "active";
    const ready = context.suspend().catch(() => { failed = true; this.stop(); throw new Error("Speech audio could not be paused."); });
    this.nativeTail = ready;
    void ready.catch(() => undefined);
    return { ready, isCurrent, outcome, resume: async () => {
      await ready;
      if (!isCurrent()) return;
      const resuming = context.resume();
      this.nativeTail = resuming;
      try { await resuming; } catch { failed = true; this.stop(); throw new Error("Speech audio could not be resumed."); }
    } };
  }

  async speak(text: string, context: AudioContext): Promise<void> {
    this.stop();
    const id = this.generation;
    const worker = this.getWorker();
    const samples = await new Promise<Float32Array>((resolve, reject) => {
      this.pending = reject;
      worker.onmessage = (event: MessageEvent<{ id: number; waveform?: Float32Array; error?: boolean }>) => {
        if (event.data.id !== id) return;
        this.pending = null;
        if (event.data.error || !event.data.waveform) reject(new Error("Paradee unavailable"));
        else resolve(event.data.waveform);
      };
      worker.onerror = () => { this.pending = null; this.worker?.terminate(); this.worker = null; this.preparing = null; reject(new Error("Paradee unavailable")); };
      worker.postMessage({ id, text });
    });
    if (id !== this.generation) return;
    const latency = [context.baseLatency, context.outputLatency].reduce((sum, value) =>
      sum + (Number.isFinite(value) && value > 0 ? value : 0), 0);
    const before = Math.ceil((0.12 + latency) * 24000);
    const after = Math.ceil((0.2 + latency) * 24000);
    const buffer = context.createBuffer(1, before + samples.length + after, 24000);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0, before);
    this.context = context;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    this.source = source;
    await new Promise<void>((resolve) => { source.onended = () => resolve(); source.start(); });
    if (this.source === source) this.source = null;
  }
}
