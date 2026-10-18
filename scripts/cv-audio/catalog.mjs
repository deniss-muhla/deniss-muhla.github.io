import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import {
  AUDIO_CATALOG_TEXT,
  AudioCatalogError,
  assistantClipId,
} from "../../src/chat/audio-catalog.ts";

export { AudioCatalogError };

const SHA256_PATTERN = /^[a-f0-9]{64}(?![\s\S])/;
const CLIP_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(?![\s\S])/;
const MANIFEST_CLIP_KEYS = ["id", "file", "bytes", "durationSeconds", "sha256"];

function fail(code) {
  throw new AudioCatalogError(code);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function textSha256(text) {
  return sha256(Buffer.from(text, "utf8"));
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function exactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function makeItem(kind, reference) {
  if (!nonemptyString(reference.text)) {
    fail(kind === "topic" ? "source/card-topic-empty" : "source/card-answer-empty");
  }
  try {
    const id = assistantClipId(reference);
    return Object.freeze({ id, kind, text: reference.text, textSha256: textSha256(reference.text) });
  } catch (error) {
    if (error instanceof AudioCatalogError) {
      if (kind === "fact" || kind === "topic") fail("source/card-id-invalid");
      throw error;
    }
    fail("source/facts-shape-invalid");
  }
}

/** Build the exact source inventory; card text remains in memory only for generation and hashing. */
export function createAudioSourceInventory(factsBytes, greeting = AUDIO_CATALOG_TEXT.greeting) {
  if (!(factsBytes instanceof Uint8Array) || factsBytes.byteLength === 0) {
    fail("source/facts-bytes-invalid");
  }
  if (greeting !== AUDIO_CATALOG_TEXT.greeting) fail("source/greeting-mismatch");

  const factsRaw = Buffer.from(factsBytes);
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(factsRaw));
  } catch {
    fail("source/facts-json-invalid");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.cards) || parsed.cards.length === 0) {
    fail("source/facts-shape-invalid");
  }

  const cards = [];
  const seenCardIds = new Set();
  for (const card of parsed.cards) {
    if (!isRecord(card)) fail("source/card-shape-invalid");
    if (!nonemptyString(card.id)) fail("source/card-id-invalid");
    try {
      assistantClipId({ kind: "fact", cardId: card.id, text: "" });
    } catch {
      fail("source/card-id-invalid");
    }
    if (seenCardIds.has(card.id)) fail("source/card-id-duplicate");
    seenCardIds.add(card.id);
    if (!nonemptyString(card.answer)) fail("source/card-answer-empty");
    if (!nonemptyString(card.topic)) fail("source/card-topic-empty");
    cards.push({ id: card.id, answer: card.answer, topic: card.topic });
  }

  const greetingItem = makeItem("greeting", {
    kind: "catalog",
    id: "greeting",
    text: AUDIO_CATALOG_TEXT.greeting,
  });
  const factItems = cards.map(({ id, answer }) =>
    makeItem("fact", { kind: "fact", cardId: id, text: answer }),
  );
  const topicItems = cards.map(({ id, topic }) =>
    makeItem("topic", { kind: "topic", cardId: id, text: topic }),
  );
  const messageItems = Object.entries(AUDIO_CATALOG_TEXT)
    .filter(([key]) => key !== "greeting")
    .map(([id, text]) => makeItem("message", { kind: "catalog", id, text }));

  const items = [greetingItem, ...factItems, ...topicItems, ...messageItems];
  const seenClipIds = new Set();
  for (const item of items) {
    if (seenClipIds.has(item.id)) fail("source/clip-id-duplicate");
    seenClipIds.add(item.id);
  }

  const catalogEntries = [...messageItems, ...topicItems].map(({ id, text }) => [id, text]);
  return Object.freeze({
    factsSha256: sha256(factsRaw),
    greetingSha256: textSha256(AUDIO_CATALOG_TEXT.greeting),
    catalogSha256: sha256(Buffer.from(JSON.stringify(catalogEntries), "utf8")),
    items: Object.freeze(items),
  });
}

/** Attach exact current source-text digests to already encoded clip metadata for the later v2 generator. */
export function createV2Manifest(inventory, clips) {
  if (
    !isRecord(inventory) ||
    typeof inventory.factsSha256 !== "string" || !SHA256_PATTERN.test(inventory.factsSha256) ||
    typeof inventory.greetingSha256 !== "string" || !SHA256_PATTERN.test(inventory.greetingSha256) ||
    typeof inventory.catalogSha256 !== "string" || !SHA256_PATTERN.test(inventory.catalogSha256) ||
    !Array.isArray(inventory.items) || inventory.items.length === 0 ||
    !Array.isArray(clips)
  ) fail("manifest/clip-invalid");

  const expected = new Map();
  for (const item of inventory.items) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !CLIP_ID_PATTERN.test(item.id) ||
      typeof item.textSha256 !== "string" ||
      !SHA256_PATTERN.test(item.textSha256) ||
      expected.has(item.id)
    ) fail("manifest/clip-invalid");
    expected.set(item.id, item);
  }
  const listed = new Map();
  for (const clip of clips) {
    if (
      !exactKeys(clip, MANIFEST_CLIP_KEYS) ||
      typeof clip.id !== "string" ||
      typeof clip.file !== "string" ||
      !Number.isSafeInteger(clip.bytes) || clip.bytes <= 0 ||
      typeof clip.durationSeconds !== "number" || !Number.isFinite(clip.durationSeconds) || clip.durationSeconds <= 0 ||
      typeof clip.sha256 !== "string" || !SHA256_PATTERN.test(clip.sha256) ||
      clip.file !== `${clip.id}-${clip.sha256}.mp3`
    ) fail("manifest/clip-invalid");
    if (listed.has(clip.id)) fail("manifest/clip-id-duplicate");
    if (!expected.has(clip.id)) fail("manifest/clip-id-unknown");
    listed.set(clip.id, clip);
  }
  if (listed.size !== expected.size || [...expected.keys()].some((id) => !listed.has(id))) {
    fail("manifest/coverage-mismatch");
  }

  return {
    version: 2,
    factsSha256: inventory.factsSha256,
    greetingSha256: inventory.greetingSha256,
    catalogSha256: inventory.catalogSha256,
    clips: inventory.items.map((item) => ({
      ...listed.get(item.id),
      textSha256: item.textSha256,
    })),
  };
}
