import { strict as assert } from "node:assert";
import { test } from "node:test";
import { selectLiveSuggestions } from "../src/chat/retrieval/live-suggestions.ts";
import type { ScoredCard } from "../src/chat/retrieval/scoring.ts";

const ranked: ScoredCard[] = [
  { id: "unrelated", topic: "Background", score: 0.7 },
  { id: "experience-listed-positions-count", topic: "Workplaces", score: 0.2 },
  { id: "experience-second-by-start-date-position", topic: "Second position", score: 0.2 },
  { id: "experience-fourth-by-start-date-position", topic: "Fourth position", score: 0.2 },
  { id: "technology-position-count-react", topic: "React position count", score: 0.2 },
  { id: "technology-position-count-react-native", topic: "React Native position count", score: 0.2 },
  { id: "other", topic: "Other", score: 0.5 },
];

test("explicit workplace perspectives appear even when their cosine is below the suggestion floor", () => {
  for (const [query, expected] of [
    ["where did Denis work second", "experience-second-by-start-date-position"],
    ["how many workplaces", "experience-listed-positions-count"],
    ["what was the last workplace", "experience-fourth-by-start-date-position"],
    ["which employers used React", "technology-position-count-react"],
  ]) {
    const suggestions = selectLiveSuggestions(query, ranked);
    assert.equal(suggestions[0].id, expected);
    assert.deepEqual(suggestions.slice(1).map((item) => item.id), ["unrelated", "other"]);
  }
});

test("unrelated, negated, ambiguous or unsupported perspectives retain cosine order", () => {
  for (const query of ["second certificate", "not the second workplace", "first or second job", "which employers used React Native and React", "fifth workplace"]) {
    assert.deepEqual(selectLiveSuggestions(query, ranked).map((item) => item.id), ["unrelated", "other"]);
  }
});
