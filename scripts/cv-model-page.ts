import { voiceEngine, type Answer } from "../src/chat/engine";
import type { EmbeddingIdentity } from "../src/chat/retrieval/index.ts";
import { EXPECTED_EMBEDDING } from "../src/chat/retrieval/index.ts";
import { reviewedIndex } from "../src/chat/retrieval/reviewed-index.ts";
import { ORT_ROUTE, ORT_RUNTIME_ASSETS } from "../src/chat/retrieval/encoder/runtime-assets.ts";

type SmokePage = Window["__cvSmoke"];

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, "0")).join("");
}

/** The reviewed index as the shipped answer path imports it, with no content in the reply. */
async function loadIndex(): Promise<{
  cards: number;
  contentDigest: string;
  identity: EmbeddingIdentity;
}> {
  const index = reviewedIndex();
  return {
    cards: index.cards.length,
    contentDigest: index.embedding.contentSha256,
    identity: {
      model: index.embedding.model,
      revision: index.embedding.revision,
      dtype: index.embedding.dtype,
      runtimeVersion: index.embedding.runtimeVersion,
      pooling: index.embedding.pooling,
      normalize: index.embedding.normalize,
      dimensions: index.embedding.dimensions,
      inputVersion: index.embedding.inputVersion,
    },
  };
}

/**
 * Loads the pinned encoder through the engine's own entry point, then hashes what the load
 * produced: every cache entry at the pinned model revision (graph, tokenizer, config) and
 * the two runtime files the project route serves, byte for byte against the recorded table.
 */
async function loadEncoder(): Promise<{ assets: Array<{ url: string; sha256: string; bytes: number }>; loadMs: number }> {
  const startedAt = performance.now();
  await voiceEngine.ensureEncoder();
  if (voiceEngine.states.encoder !== "ready") throw new Error("encoder-not-ready");
  const loadMs = performance.now() - startedAt;

  const assets: Array<{ url: string; sha256: string; bytes: number }> = [];
  const pinnedPrefix = `/${EXPECTED_EMBEDDING.model}/resolve/${EXPECTED_EMBEDDING.revision}/`;

  for (const cacheName of await caches.keys()) {
    const cache = await caches.open(cacheName);
    for (const request of await cache.keys()) {
      if (!request.url.includes(pinnedPrefix)) continue;
      const response = await cache.match(request);
      if (!response) continue;
      const bytes = await response.arrayBuffer();
      assets.push({ url: request.url, sha256: await sha256Hex(bytes), bytes: bytes.byteLength });
    }
  }

  for (const asset of ORT_RUNTIME_ASSETS) {
    const url = `${ORT_ROUTE}${asset.name}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error("runtime-asset-unavailable");
    const bytes = await response.arrayBuffer();
    const sha256 = await sha256Hex(bytes);
    if (bytes.byteLength !== asset.bytes || sha256 !== asset.sha256) {
      throw new Error("runtime-asset-digest-mismatch");
    }
    assets.push({ url, sha256, bytes: bytes.byteLength });
  }

  return { assets, loadMs };
}

/**
 * One question through the shipping answer path: `voiceEngine.ask` over the reviewed index
 * with the ready encoder. The probe is retrieval text v1 rebuilt from the first card
 * (`topic`, tags joined with ", ", `answer`), the same join the card vectors were embedded
 * from, so the query scores at the top of its own card and the matcher reaches a selection.
 * The probe never leaves this page: only the outcome shape is reported, never which card
 * was selected, what was asked or what came back.
 */
async function ask(): Promise<{ queryMs: number; outcome: "answer" | "clarify"; cards: number }> {
  const index = reviewedIndex();
  const card = index.cards[0];
  if (card === undefined) throw new Error("index-empty");

  const probe = `${card.topic}\n${card.tags.join(", ")}\n${card.answer}`;

  let result: Answer | undefined;
  const startedAt = performance.now();
  const answer = await voiceEngine.ask(probe, { onResult: (value) => { result = value; } });
  const queryMs = performance.now() - startedAt;

  if (result === undefined) throw new Error("selection-missing");

  if (result.kind === "answer") {
    // Empty or whitespace-only output is incomplete, whatever the selection says.
    if (result.cardId === "" || answer.trim() === "") throw new Error("selection-empty");
    return { queryMs, outcome: "answer", cards: 1 };
  }

  if (result.kind === "clarify") {
    const pending = voiceEngine.pendingChoices();
    if (pending === null || pending.length === 0 || pending.length !== result.choices.length) {
      throw new Error("selection-empty");
    }
    return { queryMs, outcome: "clarify", cards: pending.length };
  }

  // Rephrase, shorten, ask-question, cancelled and superseded selected no card.
  throw new Error("selection-empty");
}

window.__cvSmoke = { loadIndex, loadEncoder, ask } satisfies SmokePage;
