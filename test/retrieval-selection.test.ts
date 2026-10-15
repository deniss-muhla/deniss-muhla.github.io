/**
 * The thresholds and the branch order of design decision 9.
 *
 * These tests pin the current unmeasured defaults, the branch precedence and the
 * clarification rules. They do not claim the constants are calibrated: the named synthetic
 * cases of group 2 own that one-time check, and the constants carry that note.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { rankCards, type ScoredCard } from "../src/chat/retrieval/scoring.ts";
import {
  CALIBRATION_CASES,
  CONFIDENCE,
  CONFIDENCE_MARGIN,
  MAX_CLARIFICATION_CHOICES,
  RELEVANCE_FLOOR,
  resolveClarification,
  selectAnswer,
} from "../src/chat/retrieval/selection.ts";
import { SYNTHETIC_CARDS, axisVector, syntheticIndex, type SyntheticCardSpec } from "./retrieval-fixtures.ts";

test("the relevance floor, the confidence threshold and the margin are the recorded ones", () => {
  assert.equal(RELEVANCE_FLOOR, 0.45);
  assert.equal(CONFIDENCE, 0.6);
  assert.equal(CONFIDENCE_MARGIN, 0.05);
  assert.ok(RELEVANCE_FLOOR < CONFIDENCE);
});

test("the constants are the frozen gate's values, recorded with the cases they separate", () => {
  // The frozen gate declared these thresholds before the model was selected, and the headed
  // retrieval QA re-checked every named case with the browser's own query vectors. The case
  // list is the one that record was made against; a fixture or a gate that moves fails here.
  assert.equal(RELEVANCE_FLOOR, 0.45);
  assert.equal(CONFIDENCE, 0.6);
  assert.equal(CONFIDENCE_MARGIN, 0.05);
  assert.equal(CALIBRATION_CASES.length, 10);
  assert.equal(new Set(CALIBRATION_CASES).size, CALIBRATION_CASES.length);
  assert.ok(CALIBRATION_CASES.includes("second-workplace-standalone"));
  assert.ok(CALIBRATION_CASES.includes("absent-skill"));
  assert.ok(CALIBRATION_CASES.includes("continuation-no-memory"));
});

test("a clear confident card is answered without an uncertainty cue", () => {
  const index = syntheticIndex();
  const selection = selectAnswer(rankCards(index, axisVector(0)));

  assert.deepEqual(selection, { kind: "answer", cardId: "synthetic-calendar", score: 1, weak: false });
});

test("a card between the floors is answered with the weak-match cue", () => {
  const selection = selectAnswer(rankingOf([{ id: "synthetic-calendar", topic: "T", score: 0.5 }]));

  assert.equal(selection.kind, "answer");
  assert.equal(selection.kind === "answer" && selection.weak, true);
});

test("below the relevance floor the assistant asks for a rephrase", () => {
  const selection = selectAnswer(rankingOf([{ id: "synthetic-calendar", topic: "T", score: 0.44 }]));

  assert.deepEqual(selection, { kind: "rephrase" });
});

test("an empty index is a refusal, not an answer", () => {
  assert.deepEqual(selectAnswer(rankingOf([])), { kind: "rephrase" });
});

test("an exact tie above the floor clarifies instead of picking a winner", () => {
  const selection = selectAnswer(
    rankingOf([
      { id: "synthetic-alpha", topic: "Alpha topic", score: 0.7 },
      { id: "synthetic-beta", topic: "Beta topic", score: 0.7 },
    ]),
  );

  assert.equal(selection.kind, "clarify");
  assert.deepEqual(
    selection.kind === "clarify" ? selection.choices.map((choice) => choice.cardId) : [],
    ["synthetic-alpha", "synthetic-beta"],
  );
});

test("an exact tie below the floor refuses rather than clarifying", () => {
  // Refusal precedes the tie branch: two equally irrelevant cards are not worth choosing between.
  const selection = selectAnswer(
    rankingOf([
      { id: "synthetic-alpha", topic: "Alpha topic", score: 0.3 },
      { id: "synthetic-beta", topic: "Beta topic", score: 0.3 },
    ]),
  );

  assert.deepEqual(selection, { kind: "rephrase" });
});

test("two eligible competitors inside the margin clarify with their two topics", () => {
  const selection = selectAnswer(
    rankingOf([
      { id: "synthetic-alpha", topic: "Alpha topic", score: 0.62 },
      { id: "synthetic-beta", topic: "Beta topic", score: 0.6 },
    ]),
  );

  assert.equal(selection.kind, "clarify");
  assert.deepEqual(selection.kind === "clarify" && selection.choices, [
    { cardId: "synthetic-alpha", topic: "Alpha topic", score: 0.62 },
    { cardId: "synthetic-beta", topic: "Beta topic", score: 0.6 },
  ]);
});

test("the margin is exclusive, so exactly the margin apart still answers", () => {
  const selection = selectAnswer(
    rankingOf([
      { id: "synthetic-alpha", topic: "Alpha topic", score: 0.65 },
      { id: "synthetic-beta", topic: "Beta topic", score: 0.65 - CONFIDENCE_MARGIN },
    ]),
  );

  assert.equal(selection.kind, "answer");
});

test("at most two topics are offered, and a third competitor is not added", () => {
  const selection = selectAnswer(
    rankingOf([
      { id: "synthetic-alpha", topic: "Alpha topic", score: 0.7 },
      { id: "synthetic-beta", topic: "Beta topic", score: 0.68 },
      { id: "synthetic-gamma", topic: "Gamma topic", score: 0.67 },
    ]),
  );

  assert.equal(selection.kind, "clarify");
  assert.equal(selection.kind === "clarify" && selection.choices.length, MAX_CLARIFICATION_CHOICES);
});

test("an ineligible runner-up does not force a clarification", () => {
  // 0.58 clears the floor, 0.40 does not, so the second card is not an eligible competitor.
  const selection = selectAnswer(
    rankingOf([
      { id: "synthetic-alpha", topic: "Alpha topic", score: 0.58 },
      { id: "synthetic-beta", topic: "Beta topic", score: 0.4 },
    ]),
  );

  assert.equal(selection.kind, "answer");
  assert.equal(selection.kind === "answer" && selection.weak, true);
});

test("two close members of one reviewed group choose only a close member with injectable RNG", () => {
  const ranking = rankingOf([
    { id: "synthetic-near", topic: "Near", score: 0.62, variantGroup: "reviewed-variants" },
    { id: "synthetic-also-near", topic: "Also near", score: 0.58, variantGroup: "reviewed-variants" },
    { id: "synthetic-not-close", topic: "Not close", score: 0.4, variantGroup: "reviewed-variants" },
  ]);

  assert.deepEqual(selectAnswer(ranking, () => 0), {
    kind: "answer", cardId: "synthetic-near", score: 0.62, weak: false,
  });
  assert.deepEqual(selectAnswer(ranking, () => 1), {
    kind: "answer", cardId: "synthetic-also-near", score: 0.58, weak: true,
  });
});

test("a third distinct close contender clarifies after two reviewed variants", () => {
  const selection = selectAnswer(rankingOf([
    { id: "synthetic-variant-one", topic: "Variant one", score: 0.7, variantGroup: "reviewed-variants" },
    { id: "synthetic-variant-two", topic: "Variant two", score: 0.69, variantGroup: "reviewed-variants" },
    { id: "synthetic-distinct", topic: "Distinct topic", score: 0.68 },
  ]), () => assert.fail("randomness must not resolve a distinct contender"));

  assert.deepEqual(selection, {
    kind: "clarify",
    choices: [
      { cardId: "synthetic-variant-one", topic: "Variant one", score: 0.7 },
      { cardId: "synthetic-distinct", topic: "Distinct topic", score: 0.68 },
    ],
  });
});

test("group names cannot collide with card ids", () => {
  const selection = selectAnswer(rankingOf([
    { id: "synthetic-alpha", topic: "Variant", score: 0.7, variantGroup: "synthetic-beta" },
    { id: "synthetic-beta", topic: "Distinct", score: 0.69 },
    { id: "synthetic-gamma", topic: "Variant", score: 0.68, variantGroup: "synthetic-beta" },
  ]), () => assert.fail("the group and card id are separate contenders"));

  assert.equal(selection.kind, "clarify");
  assert.deepEqual(selection.kind === "clarify" ? selection.choices.map((choice) => choice.cardId) : [], [
    "synthetic-alpha", "synthetic-beta",
  ]);
});

test("below-floor and non-close group members never enter randomized selection", () => {
  const selection = selectAnswer(rankingOf([
    { id: "synthetic-near", topic: "Near", score: 0.58, variantGroup: "reviewed-variants" },
    { id: "synthetic-below-floor", topic: "Below floor", score: 0.44, variantGroup: "reviewed-variants" },
  ]), () => assert.fail("a singleton close group member is deterministic"));

  assert.deepEqual(selection, { kind: "answer", cardId: "synthetic-near", score: 0.58, weak: true });
});

test("a non-close member in the same group does not change the deterministic answer", () => {
  let randomCalls = 0;
  const selection = selectAnswer(rankingOf([
    { id: "synthetic-near", topic: "Near", score: 0.7, variantGroup: "reviewed-variants" },
    { id: "synthetic-far", topic: "Far", score: 0.6, variantGroup: "reviewed-variants" },
  ]), () => { randomCalls += 1; return 1; });

  assert.deepEqual(selection, { kind: "answer", cardId: "synthetic-near", score: 0.7, weak: false });
  assert.equal(randomCalls, 0);
});

test("the margin remains strict and an exact floor score is eligible", () => {
  const exactMargin = selectAnswer(rankingOf([
    { id: "synthetic-best", topic: "Best", score: 0.75, variantGroup: "reviewed-variants" },
    { id: "synthetic-at-margin", topic: "At margin", score: 0.7, variantGroup: "reviewed-variants" },
  ]), () => assert.fail("a member at the strict margin is not randomized"));
  const exactFloor = selectAnswer(rankingOf([
    { id: "synthetic-best", topic: "Best", score: 0.46 },
    { id: "synthetic-at-floor", topic: "At floor", score: 0.45 },
  ]));

  assert.equal(exactMargin.kind, "answer");
  assert.equal(exactFloor.kind, "clarify");
});

test("a chosen clarification resolves an offered id without a second inference", () => {
  const offered = [
    { cardId: "synthetic-alpha", topic: "Alpha topic", score: 0.7 },
    { cardId: "synthetic-beta", topic: "Beta topic", score: 0.68 },
  ];

  assert.equal(resolveClarification(offered, "synthetic-beta")?.cardId, "synthetic-beta");
  assert.equal(resolveClarification(offered, "synthetic-gamma"), null);
  assert.equal(resolveClarification([], "synthetic-alpha"), null);
});

test("the same thresholds apply to a ranking produced from real scoring", () => {
  // Guards against the fixtures and the scorer drifting apart: a genuinely tied pair of
  // cards comes out of `rankCards` as a clarification.
  const tied: SyntheticCardSpec[] = [
    { ...SYNTHETIC_CARDS[0], id: "synthetic-alpha", axis: 0 },
    { ...SYNTHETIC_CARDS[0], id: "synthetic-beta", axis: 0 },
    { ...SYNTHETIC_CARDS[0], id: "synthetic-gamma", axis: 1 },
  ];
  const selection = selectAnswer(rankCards(syntheticIndex(tied), axisVector(0)));

  assert.equal(selection.kind, "clarify");
  assert.deepEqual(
    selection.kind === "clarify" ? selection.choices.map((choice) => choice.cardId) : [],
    ["synthetic-alpha", "synthetic-beta"],
  );
});

function rankingOf(scored: ScoredCard[]): { scored: ScoredCard[]; dimensions: number } {
  return { scored, dimensions: 384 };
}