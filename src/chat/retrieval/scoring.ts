/**
 * Cosine scoring over the complete card array.
 *
 * Design decision 9 requires every card to be scored, because a keyword or alias pre-filter
 * would defeat free-form matching: the visitor's wording is unknown, so the only honest
 * candidate set is all of them. Scores are returned to the caller rather than reduced to a
 * winner, because the thresholds, the refusal and the clarification are the caller's
 * decision and must be applied in the documented order.
 */
import { RetrievalError } from "./errors.ts";
import type { AnswerCard, ReviewedIndex } from "./index.ts";

export interface ScoredCard {
  id: string;
  topic: string;
  /** Cosine similarity in [-1, 1]. A threshold comparison, never a probability. */
  score: number;
}

/** A ranked candidate list plus the dimension both sides were compared in. */
export interface Ranking {
  scored: ScoredCard[];
  dimensions: number;
}

/**
 * Rejects a query vector that could not be compared honestly: wrong length, non-finite
 * entries or a zero vector, whose cosine is undefined rather than zero.
 */
function checkQueryVector(vector: readonly number[], dimensions: number): number {
  if (typeof vector?.length !== "number") throw new RetrievalError("query/vector-shape");

  const length = vector.length;

  if (length !== dimensions) throw new RetrievalError("query/vector-dimensions");

  let squared = 0;

  for (let index = 0; index < length; index += 1) {
    const value = vector[index];

    if (!Number.isFinite(value)) throw new RetrievalError("query/vector-not-finite");
    squared += value * value;
  }

  if (squared === 0) throw new RetrievalError("query/vector-zero");

  return Math.sqrt(squared);
}

function cosine(query: readonly number[], queryNorm: number, card: AnswerCard): number {
  let dot = 0;
  let cardSquared = 0;

  for (let index = 0; index < query.length; index += 1) {
    dot += query[index] * card.vector[index];
    cardSquared += card.vector[index] * card.vector[index];
  }

  const cardNorm = Math.sqrt(cardSquared);

  if (cardNorm === 0) throw new RetrievalError("card/vector-zero", card.id);

  return dot / (queryNorm * cardNorm);
}

/**
 * Descending score, then ascending card id. The id tie-break exists only so an exact tie
 * ranks the same way twice: two equally scored cards are a clarification, never an
 * arbitrary winner chosen by array order.
 */
function compare(left: ScoredCard, right: ScoredCard): number {
  if (left.score !== right.score) return right.score - left.score;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Scores one query vector against every card in the index.
 *
 * @param index the reviewed index
 * @param queryVector the embedded trimmed question
 * @returns all cards, ranked, so the caller can apply the floors and the margin
 */
export function rankCards(index: ReviewedIndex, queryVector: readonly number[]): Ranking {
  const dimensions = index.embedding.dimensions;
  const queryNorm = checkQueryVector(queryVector, dimensions);

  const scored = index.cards.map((card) => ({
    id: card.id,
    topic: card.topic,
    score: cosine(queryVector, queryNorm, card),
  }));

  scored.sort(compare);

  return { scored, dimensions };
}