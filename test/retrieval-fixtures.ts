/**
 * Synthetic retrieval fixtures for the browser-free suite.
 *
 * Nothing here comes from the CV. Topics, tags and answers say "synthetic fixture" and
 * describe invented subjects, so a test can never pass by matching real card wording or
 * leak card text into a failure message. Vectors are axis-aligned on purpose: with a query
 * on one axis the cosines are exactly 1 or 0, so a ranking assertion is about ordering and
 * never about float equality.
 */
import { EXPECTED_EMBEDDING, readReviewedIndex, type ReviewedIndex } from "../src/chat/retrieval/index.ts";

const FAKE_SOURCE_SHA = "a".repeat(64);
const FAKE_CONTENT_SHA = "b".repeat(64);

export interface SyntheticCardSpec {
  id: string;
  topic: string;
  tags: string[];
  answer: string;
  /** Axis index the stored vector points at, so a query on that axis scores exactly 1. */
  axis: number;
}

export const SYNTHETIC_CARDS: SyntheticCardSpec[] = [
  {
    id: "synthetic-calendar",
    topic: "Synthetic calendar systems",
    tags: ["calendar", "scheduling"],
    answer: "A synthetic fixture records calendar and scheduling systems.",
    axis: 0,
  },
  {
    id: "synthetic-ledgers",
    topic: "Synthetic payment ledgers",
    tags: ["payments", "ledger"],
    answer: "A synthetic fixture records payment ledgers.",
    axis: 1,
  },
  {
    id: "synthetic-codecs",
    topic: "Synthetic audio codecs",
    tags: ["audio", "codec"],
    answer: "A synthetic fixture records audio codecs.",
    axis: 2,
  },
];

/**
 * Three cards that share the topic word "workplace", for the ordinal follow-up tests.
 * The axes are distinct from each other and from the cards above, so ranking still picks
 * exactly one card while the ordinal group stays the source order of these three.
 */
export const WORKPLACE_CARDS: SyntheticCardSpec[] = [
  {
    id: "synthetic-workplace-alpha",
    topic: "Workplace alpha record",
    tags: ["workplace"],
    answer: "A synthetic fixture records the alpha workplace.",
    axis: 3,
  },
  {
    id: "synthetic-workplace-beta",
    topic: "Workplace beta record",
    tags: ["workplace"],
    answer: "A synthetic fixture records the beta workplace.",
    axis: 4,
  },
  {
    id: "synthetic-workplace-gamma",
    topic: "Workplace gamma record",
    tags: ["workplace"],
    answer: "A synthetic fixture records the gamma workplace.",
    axis: 5,
  },
];

/** A unit vector on one axis of the pinned dimension. */
export function axisVector(axis: number, dimensions = EXPECTED_EMBEDDING.dimensions): number[] {
  const vector = Array.from({ length: dimensions }, (): number => 0);
  vector[axis] = 1;
  return vector;
}

/** A complete artifact object, so a test can corrupt exactly one field. */
export function syntheticArtifact(cards: SyntheticCardSpec[] = SYNTHETIC_CARDS): unknown {
  return {
    version: 1,
    source: { path: "resources/cv/source/synthetic.md", sha256: FAKE_SOURCE_SHA },
    embedding: { ...EXPECTED_EMBEDDING, contentSha256: FAKE_CONTENT_SHA },
    cards: cards.map((card) => ({
      id: card.id,
      topic: card.topic,
      tags: card.tags,
      sourceRefs: [{ startLine: 1, endLine: 2 }],
      answer: card.answer,
      vector: axisVector(card.axis),
    })),
  };
}

export function syntheticIndex(cards: SyntheticCardSpec[] = SYNTHETIC_CARDS): ReviewedIndex {
  return readReviewedIndex(syntheticArtifact(cards));
}

/**
 * An index whose first two cards share the query axis, so a query scores them equally.
 * That is the near-tie case selection turns into a clarification.
 */
export function tiedIndex(): ReviewedIndex {
  return syntheticIndex([
    { ...SYNTHETIC_CARDS[0], id: "synthetic-alpha", axis: 0 },
    { ...SYNTHETIC_CARDS[0], id: "synthetic-beta", axis: 0 },
    { ...SYNTHETIC_CARDS[1], id: "synthetic-gamma", axis: 2 },
  ]);
}

/** A valid artifact with one field replaced, for a rejection test. */
export function syntheticArtifactWith(
  replace: (artifact: Record<string, unknown>) => void,
  cards: SyntheticCardSpec[] = SYNTHETIC_CARDS,
): unknown {
  const artifact = syntheticArtifact(cards) as Record<string, unknown>;
  replace(artifact);
  return artifact;
}