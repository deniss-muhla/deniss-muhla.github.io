import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// @ts-expect-error The CLI is Node-only MJS; tests exercise its exported validators directly.
import { MAX_V2_AUDIO_BYTES, parseMp3, validateCatalogCorpusV2 } from "../scripts/cv-audio.mjs";
import { createAudioSourceInventory, createV2Manifest } from "../scripts/cv-audio/catalog.mjs";

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const LINE_TERMINATORS = ["\n", "\r", "\r\n", "\u2028", "\u2029"];

function validMp3(): Buffer {
  // MPEG-2 Layer III, 32 kbps, 24 kHz, mono: two complete 96-byte frames.
  const header =
    (0xffe00000 | (2 << 19) | (1 << 17) | (1 << 16) | (4 << 12) | (1 << 10) | (3 << 6)) >>> 0;
  const bytes = Buffer.alloc(192);
  bytes.writeUInt32BE(header, 0);
  bytes.writeUInt32BE(header, 96);
  return bytes;
}

async function v2Fixture() {
  const factsBytes = Buffer.from(JSON.stringify({
    cards: [
      { id: "synthetic-alpha", answer: "Synthetic answer alpha.", topic: "Synthetic topic alpha" },
      { id: "synthetic-beta", answer: "Synthetic answer beta.", topic: "Synthetic topic beta" },
    ],
  }), "utf8");
  const inventory = createAudioSourceInventory(factsBytes);
  const directory = await mkdtemp(join(tmpdir(), "cv-audio-v2-test-"));
  const encoded = [];
  for (const item of inventory.items) {
    const bytes = validMp3();
    const sha256 = digest(bytes);
    const file = `${item.id}-${sha256}.mp3`;
    await writeFile(join(directory, file), bytes);
    encoded.push({ id: item.id, file, bytes: bytes.length, durationSeconds: 0.048, sha256 });
  }
  return { directory, inventory, manifest: createV2Manifest(inventory, encoded) };
}

function overLimitMp3(): Buffer {
  const frameBytes = 96;
  const length = Math.ceil((MAX_V2_AUDIO_BYTES + 1) / frameBytes) * frameBytes;
  const header =
    (0xffe00000 | (2 << 19) | (1 << 17) | (1 << 16) | (4 << 12) | (1 << 10) | (3 << 6)) >>> 0;
  const bytes = Buffer.alloc(length);
  for (let offset = 0; offset < length; offset += frameBytes) bytes.writeUInt32BE(header, offset);
  return bytes;
}

test("the audio CLI has no implicit generator or reachable Pocket browser path", async () => {
  const source = await readFile(new URL("../scripts/cv-audio.mjs", import.meta.url), "utf8");
  assert.match(source, /cli\/mode-required/);
  assert.match(source, /validateCatalogCorpusV2/);
  assert.match(source, /runKittenStage\(/);
  assert.doesNotMatch(source, /pocket-tts-js|PocketTTS|playwright-core|--sample|function publish/);
  assert.doesNotMatch(source, /version: 1/);
});

test("v2 manifest binds the exact source inventory and per-clip text digests", async () => {
  const data = await v2Fixture();
  try {
    assert.deepEqual(Object.keys(data.manifest), [
      "version", "factsSha256", "greetingSha256", "catalogSha256", "clips",
    ]);
    assert.equal(data.manifest.version, 2);
    assert.equal(data.manifest.clips.length, 14, "greeting, nine messages, and fact/topic clips for two cards");
    assert.deepEqual(Object.keys(data.manifest.clips[0]).sort(), [
      "bytes", "durationSeconds", "file", "id", "sha256", "textSha256",
    ]);
    assert.equal("text" in data.manifest.clips[0], false, "the manifest carries digests, not source text");
    const encoded = data.manifest.clips.map(({ textSha256: _textSha256, ...clip }) => clip);
    assert.throws(
      () => createV2Manifest(data.inventory, [...encoded, encoded[0]]),
      /manifest\/clip-id-duplicate/,
    );
    const unknown = encoded.map((clip, index) =>
      index === 0 ? { ...clip, id: "unlisted-item", file: `unlisted-item-${clip.sha256}.mp3` } : clip,
    );
    assert.throws(() => createV2Manifest(data.inventory, unknown), /manifest\/clip-id-unknown/);
    assert.deepEqual(await validateCatalogCorpusV2(data), {
      clipCount: data.inventory.items.length,
      totalBytes: data.inventory.items.length * 192,
    });
  } finally {
    await rm(data.directory, { recursive: true, force: true });
  }
});

test("v2 validation rejects missing coverage, stale source identities, stale text and v1", async () => {
  const data = await v2Fixture();
  try {
    await assert.rejects(
      validateCatalogCorpusV2({ ...data, manifest: { ...data.manifest, clips: data.manifest.clips.slice(1) } }),
      /manifest\/coverage-mismatch/,
    );
    await assert.rejects(
      validateCatalogCorpusV2({ ...data, inventory: { ...data.inventory, factsSha256: "b".repeat(64) } }),
      /manifest\/facts-digest-mismatch/,
    );
    await assert.rejects(
      validateCatalogCorpusV2({ ...data, inventory: { ...data.inventory, greetingSha256: "b".repeat(64) } }),
      /manifest\/greeting-digest-mismatch/,
    );
    await assert.rejects(
      validateCatalogCorpusV2({ ...data, inventory: { ...data.inventory, catalogSha256: "c".repeat(64) } }),
      /manifest\/catalog-digest-mismatch/,
    );
    const clips = data.manifest.clips.map((clip, index) =>
      index === 0 ? { ...clip, textSha256: "d".repeat(64) } : clip,
    );
    await assert.rejects(
      validateCatalogCorpusV2({ ...data, manifest: { ...data.manifest, clips } }),
      /manifest\/text-digest-mismatch/,
    );
    await assert.rejects(validateCatalogCorpusV2({
      ...data,
      manifest: {
        version: 1,
        factsSha256: data.manifest.factsSha256,
        greetingSha256: data.manifest.greetingSha256,
        clips: [],
      },
    }), /manifest\/v2-shape-invalid/);
  } finally {
    await rm(data.directory, { recursive: true, force: true });
  }
});

test("v2 constructor and validator reject terminal line breaks in identities, IDs and hashes", async () => {
  const data = await v2Fixture();
  try {
    const encoded = data.manifest.clips.map(({ textSha256: _textSha256, ...clip }) => clip);
    for (const terminator of LINE_TERMINATORS) {
      for (const field of ["factsSha256", "greetingSha256", "catalogSha256"] as const) {
        const malformedInventory = { ...data.inventory, [field]: `${data.inventory[field]}${terminator}` };
        assert.throws(() => createV2Manifest(malformedInventory, encoded), /manifest\/clip-invalid/);
        const manifest = { ...data.manifest, [field]: `${data.manifest[field]}${terminator}` };
        await assert.rejects(validateCatalogCorpusV2({ ...data, manifest }), /manifest\/v2-shape-invalid/);
      }

      const malformedItem = {
        ...data.inventory.items[0],
        textSha256: `${data.inventory.items[0].textSha256}${terminator}`,
      };
      assert.throws(() => createV2Manifest({
        ...data.inventory,
        items: [malformedItem, ...data.inventory.items.slice(1)],
      }, encoded), /manifest\/clip-invalid/);

      const malformedClip = data.manifest.clips.map((clip, index) => index === 0
        ? { ...clip, sha256: `${clip.sha256}${terminator}`, file: `${clip.id}-${clip.sha256}${terminator}.mp3` }
        : clip);
      await assert.rejects(
        validateCatalogCorpusV2({ ...data, manifest: { ...data.manifest, clips: malformedClip } }),
        /manifest\/clip-invalid/,
      );
    }
  } finally {
    await rm(data.directory, { recursive: true, force: true });
  }
});

test("v2 validation checks MP3 bytes, hashes, duration and orphan files", async () => {
  const data = await v2Fixture();
  try {
    const first = data.manifest.clips[0];
    const wrongBytes = data.manifest.clips.map((clip, index) => index === 0 ? { ...clip, bytes: clip.bytes + 1 } : clip);
    await assert.rejects(
      validateCatalogCorpusV2({ ...data, manifest: { ...data.manifest, clips: wrongBytes } }),
      /manifest\/clip-digest-mismatch/,
    );
    const wrongDuration = data.manifest.clips.map((clip, index) => index === 0 ? { ...clip, durationSeconds: 2 } : clip);
    await assert.rejects(
      validateCatalogCorpusV2({ ...data, manifest: { ...data.manifest, clips: wrongDuration } }),
      /manifest\/duration-mismatch/,
    );
    const path = join(data.directory, first.file);
    const changed = validMp3();
    changed[100] ^= 1;
    await writeFile(path, changed);
    await assert.rejects(validateCatalogCorpusV2(data), /manifest\/clip-digest-mismatch/);
    await writeFile(path, validMp3());
    await writeFile(join(data.directory, `orphan-${"e".repeat(64)}.mp3`), validMp3());
    await assert.rejects(validateCatalogCorpusV2(data), /manifest\/orphan-audio/);
  } finally {
    await rm(data.directory, { recursive: true, force: true });
  }
});

test("v2 validation enforces the complete 20 MiB cap", async () => {
  const data = await v2Fixture();
  try {
    const first = data.manifest.clips[0];
    await rm(join(data.directory, first.file));
    const bytes = overLimitMp3();
    const sha256 = digest(bytes);
    const file = `${first.id}-${sha256}.mp3`;
    const durationSeconds = parseMp3(bytes).durationSeconds;
    await writeFile(join(data.directory, file), bytes);
    const encoded = data.manifest.clips.map(({ textSha256: _textSha256, ...clip }) =>
      clip.id === first.id ? { ...clip, file, bytes: bytes.length, durationSeconds, sha256 } : clip,
    );
    const manifest = createV2Manifest(data.inventory, encoded);
    await assert.rejects(validateCatalogCorpusV2({ ...data, manifest }), /audio\/size-cap-exceeded/);
  } finally {
    await rm(data.directory, { recursive: true, force: true });
  }
});

test("Vite source identity uses the shared inventory behind the offline QA guard", async () => {
  const source = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  const identityStart = source.indexOf("function cvAudioSourceIdentity()");
  const guard = source.indexOf('if (process.env.OFFLINE_CHAT_QA_ONLY === "1")', identityStart);
  const sourceInventory = source.indexOf("createAudioSourceInventory(facts)", identityStart);
  const qaDefine = source.indexOf("define: offlineChatQaOnly");
  const identityCall = source.indexOf("JSON.stringify(cvAudioSourceIdentity())");
  assert.ok(identityStart >= 0 && identityStart < guard && guard < sourceInventory);
  assert.ok(qaDefine >= 0 && identityCall > qaDefine, "the identity call stays behind the offline QA define branch");
  assert.match(source, /catalogSha256: inventory\.catalogSha256/);
  assert.doesNotMatch(source, /audioGenerator|pocket-tts-js/);
});

test("MP3 validation checks Layer III, 24 kHz mono and 32 kbps frames", () => {
  assert.deepEqual(parseMp3(validMp3()), {
    codec: "mp3", sampleRate: 24000, channels: 1, bitRate: 32000, frames: 2, durationSeconds: 0.048,
  });
});
