/**
 * The reviewed answer index, read through one normal Vite import.
 *
 * The page must serve only entries that came from the reviewed artifact, so the module
 * re-checks the identity the artifact recorded instead of trusting the import: a stale
 * generation, a different model, a wrong dimension or a malformed vector is refused here
 * rather than answered from. The offline `cv:facts check` is the authoritative gate; this
 * is the narrow runtime guard that keeps a served index from being the wrong one.
 *
 * The expected identity is a copy of the generator's `PINNED_EMBEDDING`. The generator runs
 * in Node and imports `node:crypto`, so the two runtimes cannot share one module. The copy
 * is what keeps them from drifting: `test/retrieval-index.test.ts` asserts that both values
 * are identical, and a changed pin fails the suite instead of the page.
 */
import { RetrievalError } from "./errors.ts";

export interface EmbeddingIdentity {
  model: string;
  revision: string;
  dtype: string;
  runtimeVersion: string;
  pooling: string;
  normalize: boolean;
  dimensions: number;
  inputVersion: string;
}

/** Design decisions 6 and 8. Any difference from the generator's pin fails the tests. */
export const EXPECTED_EMBEDDING: Readonly<EmbeddingIdentity> = Object.freeze({
  model: "mixedbread-ai/mxbai-embed-xsmall-v1",
  revision: "e6ac24e5d6efb8782b59de1647b3ececb4ece94e",
  dtype: "q8",
  runtimeVersion: "4.3.0",
  pooling: "mean",
  normalize: true,
  dimensions: 384,
  inputVersion: "retrieval-text-v1",
});

export interface SourceRange {
  startLine: number;
  endLine: number;
}

export interface AnswerCard {
  id: string;
  topic: string;
  tags: string[];
  sourceRefs: SourceRange[];
  answer: string;
  vector: number[];
}

export interface ReviewedIndex {
  embedding: EmbeddingIdentity & { contentSha256: string };
  /** Ordered as the artifact stores them. Selection never reorders the array itself. */
  cards: AnswerCard[];
}

const IDENTITY_KEYS = Object.keys(EXPECTED_EMBEDDING) as (keyof EmbeddingIdentity)[];
const SHA256 = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isLineNumber(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 1_000_000;
}

function readSourceRefs(value: unknown, cardLabel: string): SourceRange[] {
  if (!Array.isArray(value) || value.length === 0) throw new RetrievalError("card/source-refs", cardLabel);

  return value.map((ref, position) => {
    if (!isRecord(ref)) throw new RetrievalError("card/source-ref", `${cardLabel}[${position}]`);

    const { startLine, endLine } = ref;

    if (!isLineNumber(startLine) || !isLineNumber(endLine) || endLine < startLine) {
      throw new RetrievalError("card/source-range", `${cardLabel}[${position}]`);
    }

    return { startLine, endLine };
  });
}

/**
 * Finite, nonzero and exactly as long as the recorded dimension. A vector that fails any
 * of those would produce a score that looks valid and means nothing.
 */
function readVector(value: unknown, dimensions: number, cardLabel: string): number[] {
  if (!Array.isArray(value) || value.length !== dimensions) {
    throw new RetrievalError("card/vector-dimensions", cardLabel);
  }

  let squared = 0;

  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new RetrievalError("card/vector-not-finite", cardLabel);
    }
    squared += entry * entry;
  }

  if (squared === 0) throw new RetrievalError("card/vector-zero", cardLabel);

  return value as number[];
}

function readCard(value: unknown, dimensions: number, seen: Set<string>, position: number): AnswerCard {
  if (!isRecord(value)) throw new RetrievalError("card/shape", `cards[${position}]`);

  const label = isNonEmptyString(value.id) ? value.id : `cards[${position}]`;

  if (!isNonEmptyString(value.id)) throw new RetrievalError("card/id", label);
  if (seen.has(value.id)) throw new RetrievalError("card/duplicate-id", label);
  if (!isNonEmptyString(value.topic)) throw new RetrievalError("card/topic", label);
  if (!isNonEmptyString(value.answer)) throw new RetrievalError("card/answer", label);
  if (!Array.isArray(value.tags) || value.tags.length === 0 || !value.tags.every(isNonEmptyString)) {
    throw new RetrievalError("card/tags", label);
  }

  seen.add(value.id);

  return {
    id: value.id,
    topic: value.topic,
    tags: value.tags as string[],
    sourceRefs: readSourceRefs(value.sourceRefs, label),
    answer: value.answer,
    vector: readVector(value.vector, dimensions, label),
  };
}

/**
 * The recorded identity must equal the pinned one field by field, so an index built by
 * another model, revision, dtype, tokenizer version, pooling or dimension is refused
 * instead of scored against vectors it was never compared with.
 */
function readEmbedding(value: unknown): ReviewedIndex["embedding"] {
  if (!isRecord(value)) throw new RetrievalError("index/embedding-shape");

  for (const key of IDENTITY_KEYS) {
    if (value[key] !== EXPECTED_EMBEDDING[key]) throw new RetrievalError("index/embedding-identity", key);
  }

  if (!isNonEmptyString(value.contentSha256) || !SHA256.test(value.contentSha256)) {
    throw new RetrievalError("index/content-digest");
  }

  return { ...EXPECTED_EMBEDDING, contentSha256: value.contentSha256 };
}

/** The one reviewed entry with this id, or `undefined`. Selection never invents an entry. */
export function findCard(index: ReviewedIndex, cardId: string): AnswerCard | undefined {
  return index.cards.find((card) => card.id === cardId);
}

/**
 * Validates one parsed artifact into the shape the matcher scores.
 *
 * This accepts no field the artifact does not define and computes no vector. Cards keep
 * their stored order and their stored vectors, so the served index is exactly what source
 * review promoted.
 *
 * @param value the parsed `resources/cv/facts.json`
 * @returns the validated index
 */
export function readReviewedIndex(value: unknown): ReviewedIndex {
  if (!isRecord(value)) throw new RetrievalError("index/shape");
  if (value.version !== 1) throw new RetrievalError("index/version");

  const source = value.source;

  if (!isRecord(source) || !isNonEmptyString(source.path) || !isNonEmptyString(source.sha256) || !SHA256.test(source.sha256)) {
    throw new RetrievalError("index/source-digest");
  }

  const embedding = readEmbedding(value.embedding);

  if (!Array.isArray(value.cards)) throw new RetrievalError("index/cards-shape");

  const seen = new Set<string>();
  const cards = value.cards.map((card, position) => readCard(card, embedding.dimensions, seen, position));

  return { embedding, cards };
}