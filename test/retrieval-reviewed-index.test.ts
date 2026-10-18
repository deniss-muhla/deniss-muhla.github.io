/**
 * The shipped reviewed index, loaded through the normal Vite import path.
 *
 * This is the one check that touches `resources/cv/facts.json` itself: it proves the
 * bundler resolves the JSON import, that the shipped artifact passes the runtime guard,
 * and that a served index is the reviewed one. It asserts identity, counts and shapes
 * only, so a failure cannot print card text.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

import { EXPECTED_EMBEDDING } from "../src/chat/retrieval/index.ts";

interface LoadedIndex {
  reviewedIndex: () => {
    embedding: typeof EXPECTED_EMBEDDING & { contentSha256: string };
    cards: { id: string; topic: string; answer: string; vector: number[] }[];
  };
}

async function loadReviewedIndexModule() {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
    logLevel: "error",
  });

  try {
    return {
      module: (await server.ssrLoadModule("/src/chat/retrieval/reviewed-index.ts")) as LoadedIndex,
      close: () => server.close(),
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}

test("the shipped index imports and passes the runtime guard", async () => {
  const { module, close } = await loadReviewedIndexModule();

  try {
    const index = module.reviewedIndex();

    assert.deepEqual(
      { ...index.embedding, contentSha256: index.embedding.contentSha256 },
      { ...EXPECTED_EMBEDDING, contentSha256: index.embedding.contentSha256 },
    );
    assert.ok(index.cards.length > 0);
    assert.equal(new Set(index.cards.map((card) => card.id)).size, index.cards.length);

    for (const card of index.cards) {
      assert.equal(card.vector.length, EXPECTED_EMBEDDING.dimensions);
      assert.ok(card.topic.trim() !== "" && card.answer.trim() !== "");
    }

    // A second call returns the same object, so the import is not revalidated per question.
    assert.equal(module.reviewedIndex(), index);
  } finally {
    await close();
  }
});

test("a stored vector is finite and normalized", async () => {
  const { module, close } = await loadReviewedIndexModule();

  try {
    for (const card of module.reviewedIndex().cards) {
      let squared = 0;

      for (const value of card.vector) {
        assert.ok(Number.isFinite(value));
        squared += value * value;
      }

      // Six-decimal rounding is why this is a tolerance and not equality.
      assert.ok(Math.abs(Math.sqrt(squared) - 1) < 1e-3, `vector length for ${card.id}`);
    }
  } finally {
    await close();
  }
});