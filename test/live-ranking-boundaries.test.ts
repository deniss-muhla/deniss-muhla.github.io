import assert from "node:assert/strict";
import test from "node:test";
import { rankLiveCards } from "../src/chat/retrieval/live-ranking.ts";
import { VoiceEngine } from "../src/chat/engine.ts";
import { syntheticIndex } from "./retrieval-fixtures.ts";

const index = syntheticIndex([
  { id: "tag", topic: "Other", tags: ["work"], answer: "Unrelated", axis: 0 },
  { id: "experience-second-by-start-date-position", topic: "Second position", tags: ["experience"], answer: "Second position", axis: 1 },
  { id: "fuzzy", topic: "Other", tags: ["cat"], answer: "Other", axis: 2 },
  { id: "different-first", topic: "Other", tags: ["bat"], answer: "Other", axis: 3 },
  { id: "too-long", topic: "Other", tags: ["cater"], answer: "Other", axis: 4 },
]);

test("public suggestions preserve tag priority over the ordinal perspective", async () => {
  const engine = new VoiceEngine({ loadReviewedIndex: async () => index });
  const result = await engine.suggest("where did Denis work second");
  assert.equal(result[0].cardId, "tag");
  assert.ok(result.some((item) => item.cardId === "experience-second-by-start-date-position"));
});

test("three-letter fuzzy matching requires the same initial and a three or four letter token", () => {
  const ids = rankLiveCards(index, "cta").map((item) => item.id);
  assert.ok(ids.includes("fuzzy"), "adjacent transposition matches");
  assert.ok(!ids.includes("different-first"));
  assert.ok(!ids.includes("too-long"));
  assert.deepEqual(rankLiveCards(index, "ct"), []);
});
