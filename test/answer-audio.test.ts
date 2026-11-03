import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createAnswerAudioPlayer,
  type AudioSourceIdentity,
} from "../src/chat/answer-audio.ts";
import {
  AUDIO_CATALOG_TEXT,
  assistantClipId,
  type AssistantClipReference,
} from "../src/chat/audio-catalog.ts";
import { GREETING } from "../src/chat/cv-context.ts";
import { createAudioSourceInventory } from "../scripts/cv-audio/catalog.mjs";

const bytes = Buffer.from([1, 2, 3, 4, 5, 6]);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const identity: AudioSourceIdentity = {
  factsSha256: "a".repeat(64),
  greetingSha256: "b".repeat(64),
  catalogSha256: "c".repeat(64),
};
const LINE_TERMINATORS = ["\n", "\r", "\r\n", "\u2028", "\u2029"];

function manifestResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

function decodedAudio(length = 4, sampleRate = 24_000, channels = 2): AudioBuffer {
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return {
    length,
    sampleRate,
    numberOfChannels: channels,
    getChannelData: (channel: number) => data[channel],
  } as AudioBuffer;
}

function catalogReference(id: keyof typeof AUDIO_CATALOG_TEXT): AssistantClipReference {
  return { kind: "catalog", id, text: AUDIO_CATALOG_TEXT[id] };
}

const sequenceReferences: readonly AssistantClipReference[] = [
  { kind: "fact", cardId: "synthetic-alpha", text: "Synthetic answer alpha." },
  { kind: "fact", cardId: "synthetic-beta", text: "Synthetic answer beta." },
  { kind: "fact", cardId: "synthetic-gamma", text: "Synthetic answer gamma." },
];
const sequenceIds = sequenceReferences.map((reference) => assistantClipId(reference));
const referenceFixture: AssistantClipReference[] = [
  catalogReference("greeting"),
  sequenceReferences[0],
  { kind: "topic", cardId: "synthetic-alpha", text: "Synthetic topic alpha." },
  catalogReference("weakMatchNote"),
  sequenceReferences[1],
];

function textSha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function v2Manifest(references: readonly AssistantClipReference[], source = identity) {
  return {
    version: 2,
    factsSha256: source.factsSha256,
    greetingSha256: source.greetingSha256,
    catalogSha256: source.catalogSha256,
    clips: references.map((reference) => {
      const id = assistantClipId(reference);
      return {
        id,
        file: `${id}-${sha256}.mp3`,
        bytes: bytes.length,
        durationSeconds: 1,
        sha256,
        textSha256: textSha256(reference.text),
      };
    }),
  };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

interface SequenceHarnessOptions {
  manifest?: unknown;
  manifestPromise?: Promise<unknown>;
  identity?: AudioSourceIdentity;
  initialState?: AudioContextState;
  audioResponse?: (id: string, signal: AbortSignal | undefined) => Promise<Buffer | null>;
  decode?: (call: number, input: ArrayBuffer) => Promise<AudioBuffer>;
}

interface SequenceSource {
  buffer: AudioBuffer | null;
  onended: (() => void) | null;
  stopCalls: number;
  disconnectCalls: number;
}

function sequenceHarness(options: SequenceHarnessOptions = {}) {
  const requests: string[] = [];
  const cacheOptions: Array<RequestCache | undefined> = [];
  const audioIds: string[] = [];
  const signals: AbortSignal[] = [];
  const identity = options.identity ?? defaultIdentity;
  const manifest = options.manifest ?? v2Manifest(sequenceReferences, identity);
  const fileEntries = typeof manifest === "object" && manifest !== null && "clips" in manifest && Array.isArray(manifest.clips)
    ? manifest.clips
    : [];
  const files = new Map<string, string>();
  for (const entry of fileEntries) {
    if (typeof entry === "object" && entry !== null && "id" in entry && "file" in entry &&
        typeof entry.id === "string" && typeof entry.file === "string") {
      files.set(`/audio/assistant/${entry.file}`, entry.id);
    }
  }
  const fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    cacheOptions.push(init?.cache);
    if (init?.signal) signals.push(init.signal);
    if (url === "/audio/assistant/manifest.json") {
      return manifestResponse(options.manifestPromise ? await options.manifestPromise : manifest);
    }
    const id = files.get(url);
    if (!id) return new Response(null, { status: 404 });
    audioIds.push(id);
    const audio = options.audioResponse ? await options.audioResponse(id, init?.signal ?? undefined) : bytes;
    if (!audio) return new Response(null, { status: 404 });
    return new Response(Uint8Array.from(audio).buffer as ArrayBuffer, { status: 200 });
  };

  const sources: SequenceSource[] = [];
  let decodeCalls = 0;
  let contextState = options.initialState ?? "running";
  const context = {
    get state() { return contextState; },
    destination: {},
    baseLatency: 0.01,
    outputLatency: 0.02,
    decodeAudioData: (input: ArrayBuffer) => {
      const call = decodeCalls++;
      return options.decode ? options.decode(call, input) : Promise.resolve(decodedAudio());
    },
    createBuffer: (channels: number, length: number, sampleRate: number) => decodedAudio(length, sampleRate, channels),
    createBufferSource: () => {
      const source: SequenceSource = { buffer: null, onended: null, stopCalls: 0, disconnectCalls: 0 };
      sources.push(source);
      return {
        get buffer() { return source.buffer; },
        set buffer(value: AudioBuffer | null) { source.buffer = value; },
        get onended() { return source.onended; },
        set onended(value: (() => void) | null) { source.onended = value; },
        connect() {},
        disconnect() { source.disconnectCalls += 1; },
        start() {},
        stop() {
          source.stopCalls += 1;
          source.onended?.();
        },
      };
    },
  } as unknown as AudioContext;
  return {
    audioIds,
    cacheOptions,
    context,
    player: createAnswerAudioPlayer(fetcher, identity),
    requests,
    signals,
    sources,
    decodeCalls: () => decodeCalls,
    setState: (state: AudioContextState) => { contextState = state; },
  };
}

const defaultIdentity = identity;

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("reference playback did not reach the expected state");
    await new Promise<void>((resolve) => { setTimeout(resolve, 1); });
  }
}

test("the shipped manifest matches the exact current facts and catalog inventory", async () => {
  const facts = await readFile(new URL("../resources/cv/facts.json", import.meta.url));
  const manifest = JSON.parse(await readFile(new URL("../public/audio/assistant/manifest.json", import.meta.url), "utf8"));
  const inventory = createAudioSourceInventory(facts, GREETING);

  assert.equal(manifest.version, 2);
  assert.equal(manifest.factsSha256, inventory.factsSha256);
  assert.equal(manifest.greetingSha256, inventory.greetingSha256);
  assert.equal(manifest.catalogSha256, inventory.catalogSha256);
  assert.equal(manifest.clips.length, inventory.items.length);
  for (const [index, item] of inventory.items.entries()) {
    assert.equal(manifest.clips[index].id, item.id);
    assert.equal(manifest.clips[index].textSha256, item.textSha256);
  }
});

test("reference playback fetches one network-first v2 manifest and only selected hashed clips", async () => {
  const reference = sequenceReferences[0];
  const h = sequenceHarness({ manifest: v2Manifest([reference]) });
  const pending = h.player.playReferences([reference], h.context);
  await waitFor(() => h.sources.length === 1);
  assert.deepEqual(h.audioIds, [assistantClipId(reference)]);
  assert.equal(h.requests[0], "/audio/assistant/manifest.json");
  assert.equal(h.cacheOptions[0], "no-store");
  assert.equal(h.requests.length, 2, "only the selected content-addressed clip is requested");
  h.sources[0].onended?.();
  await pending;
});

test("a stale source or text identity rejects before requesting any clip", async () => {
  const reference = sequenceReferences[0];
  const valid = v2Manifest([reference]);
  for (const playerIdentity of [
    { ...identity, factsSha256: "d".repeat(64) },
    { ...identity, greetingSha256: "d".repeat(64) },
    { ...identity, catalogSha256: "d".repeat(64) },
  ]) {
    const h = sequenceHarness({ manifest: valid, identity: playerIdentity });
    await assert.rejects(h.player.playReferences([reference], h.context), {
      message: "Speech audio could not be played.",
    });
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.audioIds, []);
  }

  const staleText = { ...valid, clips: valid.clips.map((clip) => ({ ...clip, textSha256: "e".repeat(64) })) };
  const textHarness = sequenceHarness({ manifest: staleText });
  await assert.rejects(textHarness.player.playReferences([reference], textHarness.context), {
    message: "Speech audio could not be played.",
  });
  assert.equal(textHarness.requests.length, 1);
  assert.deepEqual(textHarness.audioIds, []);
});

test("legacy v1 manifests and raw-id player methods are rejected or absent", async () => {
  const reference = sequenceReferences[0];
  const legacyManifest = {
    version: 1,
    factsSha256: identity.factsSha256,
    greetingSha256: identity.greetingSha256,
    clips: v2Manifest([reference]).clips.map(({ textSha256: _textSha256, ...clip }) => clip),
  };
  const h = sequenceHarness({ manifest: legacyManifest });
  await assert.rejects(h.player.playReferences([reference], h.context), {
    message: "Speech audio could not be played.",
  });
  assert.deepEqual(h.requests, ["/audio/assistant/manifest.json"]);
  assert.deepEqual(h.audioIds, []);
  assert.deepEqual(Object.keys(h.player).sort(), [
    "pausePlaying", "playReferences", "settleOutput", "stop",
  ]);
});

test("bad clip bytes and missing IDs fail closed before playback", async () => {
  const reference = sequenceReferences[0];
  const wrongBytes = Buffer.from(bytes);
  wrongBytes[0] ^= 0xff;
  const bad = sequenceHarness({
    manifest: v2Manifest([reference]),
    audioResponse: async () => wrongBytes,
  });
  await assert.rejects(bad.player.playReferences([reference], bad.context), {
    message: "Speech audio could not be played.",
  });
  assert.deepEqual(bad.audioIds, [assistantClipId(reference)]);
  assert.equal(bad.sources.length, 0);

  const missing = sequenceHarness({ manifest: v2Manifest([]) });
  await assert.rejects(missing.player.playReferences([reference], missing.context), {
    message: "Speech audio could not be played.",
  });
  assert.deepEqual(missing.audioIds, []);
  assert.equal(missing.sources.length, 0);
});

test("stop aborts a pending manifest request and prevents clip playback", async () => {
  const gate = deferred<unknown>();
  const h = sequenceHarness({ manifest: v2Manifest([sequenceReferences[0]]), manifestPromise: gate.promise });
  const pending = h.player.playReferences([sequenceReferences[0]], h.context);
  await waitFor(() => h.requests.includes("/audio/assistant/manifest.json"));
  h.player.stop();
  gate.resolve(v2Manifest([sequenceReferences[0]]));
  await pending;
  assert.deepEqual(h.audioIds, []);
  assert.equal(h.sources.length, 0);
  assert.ok(h.signals.length > 0 && h.signals.every((signal) => signal.aborted));
});

test("a non-running context rejects before fetching or starting playback", async () => {
  const h = sequenceHarness({ initialState: "suspended" });
  await assert.rejects(h.player.playReferences([sequenceReferences[0]], h.context), {
    message: "Speech audio could not be played.",
  });
  assert.deepEqual(h.requests, []);
  assert.equal(h.sources.length, 0);
});

function playbackHarness(latency: { baseLatency?: number; outputLatency?: number } = {}) {
  const decoded = decodedAudio();
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    decoded.getChannelData(channel).fill((channel + 1) / 4);
  }
  const h = sequenceHarness({ decode: () => Promise.resolve(decoded) });
  Object.assign(h.context, latency);
  const playback = h.player.playReferences([sequenceReferences[0]], h.context);
  return {
    decoded,
    context: h.context,
    player: h.player,
    playback,
    started: waitFor(() => h.sources.length === 1),
    source: () => h.sources[0],
    stopped: () => h.sources[0]?.stopCalls ?? 0,
    disconnected: () => h.sources[0]?.disconnectCalls ?? 0,
  };
}

test("playback pads every channel while preserving decoded samples", async () => {
  const h = playbackHarness();
  await h.started;
  try {
    const padded = h.source().buffer!;
    assert.notEqual(padded, h.decoded);
    assert.equal(padded.numberOfChannels, h.decoded.numberOfChannels);
    assert.equal(padded.sampleRate, h.decoded.sampleRate);
    for (let channel = 0; channel < padded.numberOfChannels; channel += 1) {
      const data = padded.getChannelData(channel);
      const first = data.findIndex(sample => sample !== 0);
      assert.equal(first, 3600, "120 ms minimum plus the reported 30 ms delivery latency");
      assert.ok(data.subarray(0, first).every(sample => sample === 0));
      assert.deepEqual(data.slice(first, first + h.decoded.length), h.decoded.getChannelData(channel));
      const tail = data.subarray(first + h.decoded.length);
      assert.ok(tail.length >= 5520 && tail.length <= 5521, "200 ms minimum plus delivery latency");
      assert.ok(tail.every(sample => sample === 0));
    }
  } finally {
    h.player.stop();
    await h.playback;
  }
});

for (const [kind, latency] of [
  ["unavailable", { baseLatency: undefined, outputLatency: undefined }],
  ["invalid", { baseLatency: -1, outputLatency: Number.NaN }],
] as const) {
  test(`${kind} latency readings retain the minimum padding`, async () => {
    const h = playbackHarness(latency);
    await h.started;
    try {
      const data = h.source().buffer!.getChannelData(0);
      assert.equal(data.findIndex(sample => sample !== 0), 2880);
      assert.equal(data.length, 2880 + h.decoded.length + 4800);
    } finally {
      h.player.stop();
      await h.playback;
    }
  });
}

for (const position of ["leading", "trailing"] as const) {
  test(`interruption during ${position} padding stops without waiting for the buffer end`, async () => {
    const h = playbackHarness();
    await h.started;
    if (position === "trailing") {
      (h.context as unknown as { currentTime: number }).currentTime =
        (h.source().buffer!.length - 1) / h.source().buffer!.sampleRate;
    }
    h.player.stop();
    await h.playback;
    assert.equal(h.stopped(), 1);
    assert.equal(h.disconnected(), 1);
    assert.equal(h.source().onended, null);
  });
}

test("natural playback completion disconnects its own source exactly once", async () => {
  const h = playbackHarness();
  await h.started;
  h.source().onended?.();
  await h.playback;
  assert.equal(h.disconnected(), 1);
  h.player.stop();
  assert.equal(h.disconnected(), 1);
  assert.equal(h.stopped(), 0);
});

test("reference plans fetch, decode and naturally complete clips in order", async () => {
  const h = sequenceHarness();
  const pending = h.player.playReferences(sequenceReferences, h.context);
  for (let index = 0; index < sequenceReferences.length; index += 1) {
    await waitFor(() => h.sources.length === index + 1);
    assert.deepEqual(h.audioIds, sequenceIds.slice(0, index + 1));
    h.sources[index].onended?.();
  }
  await pending;
  assert.deepEqual(h.audioIds, sequenceIds);
  assert.deepEqual(h.sources.map((source) => source.disconnectCalls), [1, 1, 1]);
  assert.deepEqual(h.sources.map((source) => source.stopCalls), [0, 0, 0]);
});

test("playReferences snapshots exact text and order before delayed manifest resolution", async () => {
  const first = { kind: "fact" as const, cardId: "synthetic-alpha", text: "Original answer." };
  const second = { kind: "topic" as const, cardId: "synthetic-beta", text: "Original topic." };
  const references = [first, second];
  const manifest = v2Manifest(references);
  const manifestGate = deferred<unknown>();
  const h = sequenceHarness({ manifest, manifestPromise: manifestGate.promise });
  const expectedIds = references.map((reference) => assistantClipId(reference));
  const pending = h.player.playReferences(references, h.context);
  await waitFor(() => h.requests.includes("/audio/assistant/manifest.json"));
  first.text = "Mutated after call.";
  references[1] = { kind: "fact", cardId: "synthetic-gamma", text: "Replacement reference." };
  manifestGate.resolve(manifest);

  for (let index = 0; index < expectedIds.length; index += 1) {
    await waitFor(() => h.sources.length === index + 1);
    assert.deepEqual(h.audioIds, expectedIds.slice(0, index + 1));
    h.sources[index].onended?.();
  }
  await pending;
  assert.deepEqual(h.audioIds, expectedIds);
});

test("stopping during reference preflight prevents any clip from starting", async () => {
  const references = [referenceFixture[1]];
  const manifest = v2Manifest(references);
  const gate = deferred<unknown>();
  const h = sequenceHarness({ manifest, manifestPromise: gate.promise });
  const pending = h.player.playReferences(references, h.context);
  await waitFor(() => h.requests.includes("/audio/assistant/manifest.json"));
  h.player.stop();
  gate.resolve(manifest);
  await pending;
  assert.equal(h.audioIds.length, 0);
  assert.equal(h.sources.length, 0);
  assert.ok(h.signals.length > 0 && h.signals.every((signal) => signal.aborted));
});

test("a missing later reference fails before any clip audio or source starts", async () => {
  const references: AssistantClipReference[] = [
    catalogReference("clarifyPrompt"),
    { kind: "topic", cardId: "missing-topic", text: "Missing topic text." },
  ];
  const h = sequenceHarness({ manifest: v2Manifest(references.slice(0, 1)) });
  await assert.rejects(h.player.playReferences(references, h.context), {
    message: "Speech audio could not be played.",
  });
  assert.deepEqual(h.audioIds, []);
  assert.equal(h.sources.length, 0);
});

test("stop aborts a sequence while its first clip is fetching", async () => {
  const h = sequenceHarness({
    audioResponse: (_id, signal) => new Promise<Buffer | null>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  });
  const pending = h.player.playReferences(sequenceReferences, h.context);
  await waitFor(() => h.audioIds.length === 1);
  h.player.stop();
  await pending;
  assert.deepEqual(h.audioIds, [sequenceIds[0]]);
  assert.equal(h.decodeCalls(), 0);
  assert.equal(h.sources.length, 0);
});

test("a replacement plan invalidates decoding and stops active playback", async () => {
  const decode = deferred<AudioBuffer>();
  const h = sequenceHarness({ decode: (call) => call === 0 ? decode.promise : Promise.resolve(decodedAudio()) });
  const pending = h.player.playReferences(sequenceReferences, h.context);
  await waitFor(() => h.decodeCalls() === 1);
  const replacement = h.player.playReferences([sequenceReferences[2]], h.context);
  decode.resolve(decodedAudio());
  await waitFor(() => h.sources.length === 1);
  h.sources[0].onended?.();
  await Promise.all([pending, replacement]);
  assert.deepEqual(h.audioIds, [sequenceIds[0], sequenceIds[2]]);
  assert.equal(h.sources.length, 1);
});

test("replacing a plan stops active output and prevents the old plan continuing", async () => {
  const h = sequenceHarness();
  const pending = h.player.playReferences(sequenceReferences, h.context);
  await waitFor(() => h.sources.length === 1);
  const replacement = h.player.playReferences([sequenceReferences[2]], h.context);
  await waitFor(() => h.sources.length === 2);
  assert.equal(h.sources[0].stopCalls, 1);
  assert.equal(h.sources[0].disconnectCalls, 1);
  assert.deepEqual(h.audioIds, [sequenceIds[0], sequenceIds[2]]);
  h.sources[1].onended?.();
  await Promise.all([pending, replacement]);
});

test("stop between naturally completed clips prevents the next clip from starting", async () => {
  const h = sequenceHarness();
  const pending = h.player.playReferences(sequenceReferences, h.context);
  await waitFor(() => h.sources.length === 1);
  h.sources[0].onended?.();
  h.player.stop();
  await pending;
  assert.deepEqual(h.audioIds, [sequenceIds[0]]);
  assert.equal(h.sources.length, 1);
});

test("a current guard that turns false during fetch prevents decode and remaining clips", async () => {
  const response = deferred<Buffer | null>();
  const h = sequenceHarness({ audioResponse: () => response.promise });
  let current = true;
  const pending = h.player.playReferences(sequenceReferences, h.context, () => current);
  await waitFor(() => h.audioIds.length === 1);
  current = false;
  response.resolve(bytes);
  await pending;
  assert.equal(h.decodeCalls(), 0);
  assert.equal(h.sources.length, 0);
  assert.deepEqual(h.audioIds, [sequenceIds[0]]);
});

test("a current guard that turns false during playback prevents the next clip", async () => {
  const h = sequenceHarness();
  let current = true;
  const pending = h.player.playReferences(sequenceReferences, h.context, () => current);
  await waitFor(() => h.sources.length === 1);
  current = false;
  h.sources[0].onended?.();
  await pending;
  assert.deepEqual(h.audioIds, [sequenceIds[0]]);
  assert.equal(h.sources.length, 1);
});

for (const failure of ["missing", "digest", "decoder"] as const) {
  test(`a ${failure} middle reference rejects without starting later clips`, async () => {
    const wrongBytes = Buffer.from(bytes);
    wrongBytes[0] ^= 0xff;
    const references = failure === "missing"
      ? [sequenceReferences[0], sequenceReferences[2]]
      : sequenceReferences;
    const h = sequenceHarness({
      manifest: v2Manifest(references),
      audioResponse: failure === "digest"
        ? (id) => Promise.resolve(id === sequenceIds[1] ? wrongBytes : bytes)
        : undefined,
      decode: failure === "decoder"
        ? (call) => call === 1 ? Promise.reject(new Error("decode failed")) : Promise.resolve(decodedAudio())
        : undefined,
    });
    const pending = h.player.playReferences(sequenceReferences, h.context);
    if (failure === "missing") {
      await assert.rejects(pending, { message: "Speech audio could not be played." });
      assert.deepEqual(h.audioIds, []);
      assert.equal(h.sources.length, 0);
      return;
    }
    await waitFor(() => h.sources.length === 1);
    h.sources[0].onended?.();
    await assert.rejects(pending, { message: "Speech audio could not be played." });
    assert.ok(!h.audioIds.includes(sequenceIds[2]), "the final clip is never requested");
    assert.equal(h.sources.length, 1);
    assert.deepEqual(h.audioIds, sequenceIds.slice(0, 2));
  });
}

test("a context suspended between clips rejects before requesting the next clip", async () => {
  const h = sequenceHarness();
  const pending = h.player.playReferences(sequenceReferences, h.context);
  await waitFor(() => h.sources.length === 1);
  h.sources[0].onended?.();
  h.setState("suspended");
  await assert.rejects(pending, { message: "Speech audio could not be played." });
  assert.deepEqual(h.audioIds, [sequenceIds[0]]);
});

test("an empty reference plan does no work and leaves active playback untouched", async () => {
  const h = sequenceHarness();
  await h.player.playReferences([], h.context);
  assert.deepEqual(h.requests, []);
  assert.equal(h.decodeCalls(), 0);
  assert.equal(h.sources.length, 0);

  const pending = h.player.playReferences(sequenceReferences.slice(0, 2), h.context);
  await waitFor(() => h.sources.length === 1);
  const active = h.sources[0];
  await h.player.playReferences([], h.context);
  assert.equal(active.stopCalls, 0);
  assert.equal(active.disconnectCalls, 0);
  assert.notEqual(active.onended, null);
  active.onended?.();
  await waitFor(() => h.sources.length === 2);
  h.sources[1].onended?.();
  await pending;
});

for (const invalidity of [
  "catalog identity missing", "catalog identity stale", "source mismatch", "text mismatch",
  "unknown field", "clip unknown field", "duplicate id", "path traversal", "oversized declaration",
] as const) {
  test(`v2 ${invalidity} fails closed before output`, async () => {
    const reference = referenceFixture[1];
    const valid = v2Manifest([reference]);
    let manifest: unknown = valid;
    let playerIdentity: AudioSourceIdentity = identity;
    if (invalidity === "catalog identity missing") {
      const { catalogSha256: _catalogSha256, ...withoutCatalog } = identity;
      playerIdentity = withoutCatalog as AudioSourceIdentity;
    } else if (invalidity === "catalog identity stale") {
      playerIdentity = { ...identity, catalogSha256: "d".repeat(64) };
    } else if (invalidity === "source mismatch") {
      manifest = { ...valid, factsSha256: "d".repeat(64) };
    } else if (invalidity === "text mismatch") {
      manifest = { ...valid, clips: valid.clips.map((clip) => ({ ...clip, textSha256: "d".repeat(64) })) };
    } else if (invalidity === "unknown field") {
      manifest = { ...valid, unexpected: true };
    } else if (invalidity === "clip unknown field") {
      manifest = { ...valid, clips: valid.clips.map((clip) => ({ ...clip, unexpected: true })) };
    } else if (invalidity === "duplicate id") {
      manifest = { ...valid, clips: [...valid.clips, ...valid.clips] };
    } else if (invalidity === "path traversal") {
      manifest = {
        ...valid,
        clips: valid.clips.map((clip) => ({ ...clip, id: "../outside", file: `../outside-${sha256}.mp3` })),
      };
    } else if (invalidity === "oversized declaration") {
      manifest = { ...valid, clips: valid.clips.map((clip) => ({ ...clip, bytes: 20 * 1024 * 1024 + 1 })) };
    }
    const h = sequenceHarness({ manifest, identity: playerIdentity });
    await assert.rejects(h.player.playReferences([reference], h.context), {
      message: "Speech audio could not be played.",
    });
    assert.equal(h.sources.length, 0);
    assert.deepEqual(h.audioIds, []);
  });
}

test("v2 catalog SHA rejects terminal line breaks before clip fetch", async () => {
  for (const terminator of LINE_TERMINATORS) {
    const malformedCatalogSha = `${identity.catalogSha256}${terminator}`;
    const references = [referenceFixture[1]];
    const value = v2Manifest(references);
    const malformedManifest = { ...value, catalogSha256: malformedCatalogSha };
    const malformedIdentity = { ...identity, catalogSha256: malformedCatalogSha };
    const h = sequenceHarness({ manifest: malformedManifest, identity: malformedIdentity });
    await assert.rejects(h.player.playReferences(references, h.context), {
      message: "Speech audio could not be played.",
    });
    assert.deepEqual(h.audioIds, []);
    assert.equal(h.requests.length, 1);
  }
});

test("invalid reference shapes and noncanonical catalog text fail without leaking details", async () => {
  const h = sequenceHarness({ manifest: v2Manifest(referenceFixture) });
  const invalid = { kind: "topic", cardId: 42, text: "Not valid." } as unknown as AssistantClipReference;
  await assert.rejects(h.player.playReferences([invalid], h.context), {
    message: "Speech audio could not be played.",
  });
  const staleCatalog = { kind: "catalog", id: "greeting", text: "Different greeting." } as unknown as AssistantClipReference;
  await assert.rejects(h.player.playReferences([staleCatalog], h.context), {
    message: "Speech audio could not be played.",
  });
  assert.deepEqual(h.requests, []);
});

test("native playback pause keeps the same source and holds clip order until resume", async () => {
  const h = sequenceHarness();
  let suspends = 0;
  let resumes = 0;
  Object.assign(h.context, {
    suspend: async () => { suspends++; h.setState("suspended"); },
    resume: async () => { resumes++; h.setState("running"); },
  });
  const pending = h.player.playReferences(sequenceReferences.slice(0, 2), h.context);
  assert.equal(h.player.pausePlaying?.(), null, "preparation is not native playing proof");
  await waitFor(() => h.sources.length === 1);
  const sameSource = h.sources[0];
  const pause = h.player.pausePlaying?.();
  assert.ok(pause, "active native source can pause");
  await pause.ready;
  assert.equal(h.context.state, "suspended");
  assert.equal(sameSource.stopCalls, 0, "pause never restarts the clip");
  // A natural end racing suspend must not start the next clip while held.
  sameSource.onended?.();
  await new Promise<void>(r => setImmediate(r));
  assert.equal(h.sources.length, 1);
  await pause.resume();
  await waitFor(() => h.sources.length === 2);
  assert.equal(h.sources[0], sameSource);
  assert.deepEqual(h.audioIds, sequenceIds.slice(0, 2));
  assert.equal(suspends, 1); assert.equal(resumes, 1);
  h.sources[1].onended?.(); await pending;
});

test("late native pause/resume cannot revive cancelled or naturally finished output", async () => {
  for (const exit of ["stop", "natural", "pending-resume"] as const) {
    const h = sequenceHarness();
    const suspension = deferred<void>();
    const resumption = deferred<void>();
    let resumes = 0;
    Object.assign(h.context, {
      suspend: () => suspension.promise.then(() => { h.setState("suspended"); }),
      resume: () => { resumes++; return resumption.promise.then(() => { h.setState("running"); }); },
    });
    const pending = h.player.playReferences(sequenceReferences.slice(0, 1), h.context);
    await waitFor(() => h.sources.length === 1);
    const pause = h.player.pausePlaying?.(); assert.ok(pause);
    if (exit === "natural") h.sources[0].onended?.();
    else if (exit === "stop") h.player.stop();
    if (exit === "natural") {
      assert.equal(pause.outcome(), "ended", "natural completion is not cancellation");
    }
    suspension.resolve(); await pause.ready;
    const resuming = pause.resume();
    if (exit === "pending-resume") {
      await Promise.resolve();
      assert.equal(resumes, 1, "the native resume must be pending before cancellation");
      h.player.stop();
    }
    resumption.resolve(); await resuming;
    await h.player.settleOutput?.(); await pending;
    assert.equal(resumes, exit === "pending-resume" ? 1 : 0);
    assert.equal(pause.isCurrent(), false);
    assert.equal(h.sources.length, 1, "no replacement source starts from a stale resume");
  }
});

test("native resume failure preserves failure ownership until an explicit stop", async () => {
  const h = sequenceHarness();
  Object.assign(h.context, { suspend: async () => h.setState("suspended"),
    resume: async () => { throw new Error("private-native-resume-detail"); } });
  const pending = h.player.playReferences(sequenceReferences.slice(0, 1), h.context);
  await waitFor(() => h.sources.length === 1);
  const pause = h.player.pausePlaying?.(); assert.ok(pause); await pause.ready;
  await assert.rejects(pause.resume(), { message: "Speech audio could not be played." });
  await pending;
  assert.equal(h.sources[0].stopCalls, 1, "failed native resume cleans output");
  assert.equal(pause.outcome(), "failed", "cleanup must not masquerade as intentional cancellation");
  h.player.stop();
  assert.equal(pause.outcome(), "cancelled", "subsequent intentional stop invalidates stale notice ownership");
});
