import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { rankLiveCards } from "../src/chat/retrieval/live-ranking.ts";
import type { AnswerCard, ReviewedIndex } from "../src/chat/retrieval/index.ts";

const real = JSON.parse(readFileSync(new URL("../resources/cv/facts.json", import.meta.url), "utf8")) as ReviewedIndex;

test("prefixes and misspellings find reviewed cards for their intended topics", () => {
  const examples: Array<[string, string]> = [
    ["rea", "expertise-react-typescript"], ["reac", "expertise-react-typescript"],
    ["stre", "stream-period"], ["dia", "diatom-period"], ["cert", "certificate-mcpd"],
    ["seco", "experience-second-by-start-date-position"], ["java", "diatom-stack-item-javascript"],
    ["cyp", "background-item-cypress"], ["reakt", "expertise-react-typescript"],
    ["typscript", "expertise-react-typescript"], ["wokrplace", "experience-listed-positions-count"],
    ["strem labs", "stream-role-period"], ["where did Denis work second", "experience-second-by-start-date-position"],
  ];
  for (const [query, expected] of examples) {
    const ids = rankLiveCards(real, query).slice(0, 3).map((card) => card.id);
    assert.ok(ids.includes(expected), `${query}: ${ids.join(", ")}`);
  }
});

test("field precedence dominates match quality and quality is exact then prefix then fuzzy", () => {
  const card = (id: string, tags: string[], topic: string, answer: string): AnswerCard => ({ id, tags, topic, answer, vector: [], sourceRefs: [] });
  const index = { cards: [
    card("answer-exact", [], "other", "react"), card("topic-exact", [], "react", "other"),
    card("tag-fuzzy", ["reakt"], "other", "other"), card("tag-prefix", ["reactive"], "other", "other"),
    card("tag-exact", ["react"], "other", "other"),
  ] } as ReviewedIndex;
  assert.deepEqual(rankLiveCards(index, "react").map((c) => c.id), ["tag-exact", "tag-prefix", "tag-fuzzy", "topic-exact", "answer-exact"]);
  assert.deepEqual(rankLiveCards(index, "the a"), []);
  assert.deepEqual(rankLiveCards(index, "re"), []);
  const scores = new Map([["answer-exact", 1], ["tag-fuzzy", -1]]);
  assert.ok(rankLiveCards(index, "react", scores).findIndex((c) => c.id === "tag-fuzzy") < rankLiveCards(index, "react", scores).findIndex((c) => c.id === "answer-exact"), "semantic scores cannot overturn field priority");
});
