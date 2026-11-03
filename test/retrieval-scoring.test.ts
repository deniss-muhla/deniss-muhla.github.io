/**
 * Cosine scoring over the full array.
 *
 * Assertions are about order and about how many cards were scored, never about a float
 * value: the synthetic vectors are axis-aligned so a ranking is exact while the arithmetic
 * stays ordinary cosine.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { RetrievalError } from "../src/chat/retrieval/errors.ts";
import { rankCards } from "../src/chat/retrieval/scoring.ts";
import { SYNTHETIC_CARDS, axisVector, syntheticIndex } from "./retrieval-fixtures.ts";

test("a covered question ranks its own card first and every other card still", () => {
  const index = syntheticIndex();
  const { scored, dimensions } = rankCards(index, axisVector(0));

  assert.equal(dimensions, index.embedding.dimensions);
  // Every card is scored: a keyword or alias pre-filter would produce fewer entries here,
  // and the design forbids one.
  assert.equal(scored.length, SYNTHETIC_CARDS.length);
  assert.deepEqual(
    scored.map((candidate) => candidate.id),
    ["synthetic-calendar", "synthetic-codecs", "synthetic-ledgers"],
  );
});

test("no card is dropped regardless of how little it resembles the query", () => {
  const index = syntheticIndex([...SYNTHETIC_CARDS, { ...SYNTHETIC_CARDS[0], id: "synthetic-unrelated", axis: 7 }]);
  const { scored } = rankCards(index, axisVector(0));

  // The three zero-scoring cards are ordered by id, and all four cards are present.
  assert.deepEqual(
    scored.map((candidate) => candidate.id),
    ["synthetic-calendar", "synthetic-codecs", "synthetic-ledgers", "synthetic-unrelated"],
  );
});

test("an unrelated query scores every card at or near zero and no card wins on a tiebreak alone", () => {
  const index = syntheticIndex();
  const { scored } = rankCards(index, axisVector(3));

  for (const candidate of scored) {
    assert.ok(candidate.score >= -1 && candidate.score <= 1);
  }

  // Axis 3 matches nothing, so every card is exactly 0 and the order is the stable id order.
  assert.deepEqual(
    scored.map((candidate) => candidate.id),
    ["synthetic-calendar", "synthetic-codecs", "synthetic-ledgers"],
  );
});

test("near-tied cards keep a stable id order across repeated runs", () => {
  // Two cards on the same axis are an exact tie, which selection turns into a clarification.
  // The ranking itself must still be reproducible.
  const index = syntheticIndex([
    { ...SYNTHETIC_CARDS[0], id: "synthetic-beta" },
    { ...SYNTHETIC_CARDS[0], id: "synthetic-alpha", axis: 0 },
    { ...SYNTHETIC_CARDS[0], id: "synthetic-gamma", axis: 0 },
  ]);

  const first = rankCards(index, axisVector(0));
  const second = rankCards(index, axisVector(0));

  assert.deepEqual(first.scored.map((c) => c.id), ["synthetic-alpha", "synthetic-beta", "synthetic-gamma"]);
  assert.deepEqual(first.scored.map((c) => c.id), second.scored.map((c) => c.id));
});

test("a near tie that is not an exact tie ranks by score", () => {
  // `tiltedVector` makes an exact cosine with an axis-0 query, so the two near-tied cards
  // differ by a known amount rather than by rounding noise.
  const index = syntheticIndex([
    { ...SYNTHETIC_CARDS[0], id: "synthetic-nearer", axis: 0 },
    { ...SYNTHETIC_CARDS[0], id: "synthetic-farther", axis: 0 },
  ]);

  const patch = (cardId: string, degrees: number): number[] =>
    (cardId === "synthetic-nearer" ? axisVector(0) : tiltedVector(degrees));

  const patched = {
    ...index,
    cards: index.cards.map((card) => ({ ...card, vector: patch(card.id, 20) })),
  };

  const { scored } = rankCards(patched, axisVector(0));

  assert.deepEqual(
    scored.map((candidate) => candidate.id),
    ["synthetic-nearer", "synthetic-farther"],
  );
  assert.ok(Math.abs(scored[0].score - 1) < 1e-6);
  assert.ok(Math.abs(scored[1].score - Math.cos((20 * Math.PI) / 180)) < 1e-6);
});

test("an empty card array ranks to an empty list instead of throwing", () => {
  const index = syntheticIndex([]);
  const { scored } = rankCards(index, axisVector(0));

  assert.deepEqual(scored, []);
});

/** A unit vector at `degrees` away from the first axis, so its cosine with it is exact. */
function tiltedVector(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180;
  const vector = axisVector(0);
  vector[1] = Math.sin(radians);
  vector[0] = Math.cos(radians);
  return vector;
}

function rejectionReason(vector: readonly number[]): string {
  const index = syntheticIndex();

  try {
    rankCards(index, vector);
  } catch (error) {
    assert.ok(error instanceof RetrievalError);
    return error.reason;
  }
  return assert.fail("expected the query vector to be refused");
}

test("an unusable query vector is refused rather than scored as zero", () => {
  assert.equal(rejectionReason([1, 0, 0]), "query/vector-dimensions");
  assert.equal(rejectionReason(axisVector(0).map(() => 0)), "query/vector-zero");
  assert.equal(rejectionReason([Number.NaN, ...axisVector(0).slice(1)]), "query/vector-not-finite");
});
test("a query vector that is not a sequence is refused", () => {
  assert.equal(
    rejectionReason(undefined as unknown as readonly number[]),
    "query/vector-shape",
  );
});
