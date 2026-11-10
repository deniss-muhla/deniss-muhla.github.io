import assert from "node:assert/strict";
import test from "node:test";
import { ParadeePlayer } from "../src/chat/tts/paradee/player.ts";

class FakeWorker {
  static latest: FakeWorker;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: { id: number; text?: string; prepare?: boolean }[] = [];
  listeners = new Set<(event: MessageEvent) => void>();
  constructor() { FakeWorker.latest = this; }
  postMessage(message: { id: number; text?: string; prepare?: boolean }) { this.sent.push(message); }
  addEventListener(type: string, listener: (event: MessageEvent) => void) { if (type === "message") this.listeners.add(listener); }
  removeEventListener(type: string, listener: (event: MessageEvent) => void) { if (type === "message") this.listeners.delete(listener); }
  terminate() {}
  reply(data: unknown) {
    const event = { data } as MessageEvent;
    for (const listener of this.listeners) listener(event);
    this.onmessage?.(event);
  }
}
class FakeSource {
  buffer: unknown;
  onended: (() => void) | null = null;
  started = false;
  connected = false;
  connect() { this.connected = true; }
  start() { this.started = true; }
  stop() { this.onended?.(); }
  end() { this.onended?.(); }
}
class FakeContext {
  state = "running";
  baseLatency = 0;
  outputLatency = 0;
  destination = {};
  source: FakeSource | null = null;
  data = new Float32Array(0);
  offset = 0;
  suspendThrows = false;
  suspend() { if (this.suspendThrows) throw new Error("native"); this.state = "suspended"; return Promise.resolve(); }
  resume() { this.state = "running"; return Promise.resolve(); }
  createBuffer(_channels: number, length: number) {
    this.data = new Float32Array(length);
    return { copyToChannel: (samples: Float32Array, _channel: number, offset: number) => { this.offset = offset; this.data.set(samples, offset); } };
  }
  createBufferSource() { return this.source = new FakeSource(); }
  asAudio() { return this as unknown as AudioContext; }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function setup() {
  const previous = globalThis.Worker;
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  return { player: new ParadeePlayer(), context: new FakeContext(), restore: () => { globalThis.Worker = previous; } };
}

test("pause holds pending synthesis and resumes a short interruption", async () => {
  const { player, context, restore } = setup();
  try {
    const speaking = player.speak("hello", context.asAudio());
    const worker = FakeWorker.latest;
    const pause = player.pausePlaying();
    assert.ok(pause);
    assert.equal(player.pausePlaying(), null, "one hold at a time");
    await pause.ready;
    assert.equal(context.state, "suspended");
    worker.reply({ id: worker.sent[0].id, waveform: Float32Array.of(0.2) });
    await tick();
    assert.equal(context.source?.started, true);
    assert.equal(context.state, "suspended", "a ready waveform cannot play through the hold");
    await pause.resume();
    assert.equal(context.state, "running");
    context.source?.end();
    await speaking;
    assert.equal(player.pausePlaying(), null);
  } finally { restore(); }
});

test("running source pause, stop and natural completion have distinct outcomes", async () => {
  const { player, context, restore } = setup();
  try {
    const speaking = player.speak("hello", context.asAudio());
    const worker = FakeWorker.latest;
    worker.reply({ id: worker.sent[0].id, waveform: Float32Array.of(0.1) });
    await tick();
    assert.ok(context.source?.connected);
    const pause = player.pausePlaying(); assert.ok(pause);
    await pause.ready;
    assert.equal(pause.outcome(), "active");
    player.stop();
    assert.equal(pause.outcome(), "cancelled");
    await speaking;
    await player.settleOutput();
  } finally { restore(); }
});

test("synchronous suspend failure rejects ready rather than throwing", async () => {
  const { player, context, restore } = setup();
  try {
    const speaking = player.speak("hello", context.asAudio()).catch(() => undefined);
    context.suspendThrows = true;
    const pause = player.pausePlaying(); assert.ok(pause);
    await assert.rejects(pause.ready, /could not be paused/);
    assert.equal(pause.outcome(), "failed");
    await speaking;
  } finally { restore(); }
});

test("peak limiting only attenuates loud finite waveforms and rejects invalid samples", async () => {
  const { player, context, restore } = setup();
  try {
    for (const samples of [Float32Array.of(-2, 1), Float32Array.of(-0.4, 0.2)]) {
      const original = [...samples];
      const speaking = player.speak("hello", context.asAudio());
      const worker = FakeWorker.latest;
      worker.reply({ id: worker.sent.at(-1)!.id, waveform: samples });
      await tick();
      const actual = context.data.subarray(context.offset, context.offset + samples.length);
      const scale = Math.max(...original.map(Math.abs)) > 0.8 ? 0.4 : 1;
      actual.forEach((value, i) => assert.ok(Math.abs(value - original[i] * scale) < 1e-6));
      context.source?.end(); await speaking;
    }
    const speaking = player.speak("bad", context.asAudio());
    const worker = FakeWorker.latest;
    worker.reply({ id: worker.sent.at(-1)!.id, waveform: Float32Array.of(NaN) });
    await assert.rejects(speaking, /Invalid speech waveform/);
  } finally { restore(); }
});

test("cancelling synthesis invalidates its hold and ignores a late waveform", async () => {
  const { player, context, restore } = setup();
  try {
    const speaking = player.speak("hello", context.asAudio());
    const worker = FakeWorker.latest;
    const id = worker.sent[0].id;
    const pause = player.pausePlaying(); assert.ok(pause);
    await pause.ready;
    player.stop();
    await assert.rejects(speaking, /cancelled/);
    assert.equal(pause.outcome(), "cancelled");
    worker.reply({ id, waveform: Float32Array.of(0.1) });
    await tick();
    assert.equal(context.source, null);
    await pause.resume();
    assert.equal(context.state, "suspended", "obsolete hold cannot resume output");
  } finally { restore(); }
});

test("a non-running context cannot acquire a native hold", async () => {
  const { player, context, restore } = setup();
  try {
    const speaking = player.speak("hello", context.asAudio());
    context.state = "suspended";
    assert.equal(player.pausePlaying(), null);
    player.stop();
    await assert.rejects(speaking, /cancelled/);
  } finally { restore(); }
});
