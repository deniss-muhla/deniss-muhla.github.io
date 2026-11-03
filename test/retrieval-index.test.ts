/**
 * Index loading: the reviewed artifact must survive validation as itself, and a mismatch
 * must be refused with a named reason instead of being scored.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { RetrievalError } from "../src/chat/retrieval/errors.ts";
import {
  EXPECTED_EMBEDDING,
  findCard,
  readReviewedIndex,
} from "../src/chat/retrieval/index.ts";
import { PINNED_EMBEDDING } from "../scripts/cv-facts/artifact.mjs";
import {
  SYNTHETIC_CARDS,
  syntheticArtifact,
  syntheticArtifactWith,
  syntheticIndex,
} from "./retrieval-fixtures.ts";

function rejectionReason(value: unknown): string {
  try {
    readReviewedIndex(value);
  } catch (error) {
    assert.ok(error instanceof RetrievalError, `expected a RetrievalError, got ${String(error)}`);
    return error.reason;
  }
  return assert.fail("expected the artifact to be refused");
}

test("the runtime pin and the generator pin are the same identity", () => {
  // The runtime keeps its own copy because the generator imports node:crypto. This is what
  // stops the two from drifting: a changed pin fails here rather than in the page.
  assert.deepEqual({ ...EXPECTED_EMBEDDING }, { ...PINNED_EMBEDDING });
});

test("a valid artifact is accepted unchanged", () => {
  const index = syntheticIndex();

  assert.equal(index.embedding.dimensions, EXPECTED_EMBEDDING.dimensions);
  assert.deepEqual(
    index.cards.map((card) => card.id),
    SYNTHETIC_CARDS.map((card) => card.id),
  );

  const card = findCard(index, "synthetic-calendar");

  assert.equal(card?.topic, SYNTHETIC_CARDS[0].topic);
  assert.equal(card?.vector.length, EXPECTED_EMBEDDING.dimensions);
});

test("a reviewed optional group is parsed and an older ungrouped card stays unchanged", () => {
  const artifact = syntheticArtifactWith((value) => {
    const cards = value.cards as Record<string, unknown>[];
    cards[0].variantGroup = "reviewed-variants";
    cards[1].variantGroup = "reviewed-variants";
  }) as { cards: Record<string, unknown>[] };
  const parsed = readReviewedIndex(artifact);
  const older = readReviewedIndex(syntheticArtifact());

  assert.equal(parsed.cards[0].variantGroup, "reviewed-variants");
  assert.equal(Object.hasOwn(parsed.cards[2], "variantGroup"), false);
  assert.equal(Object.hasOwn(older.cards[0], "variantGroup"), false);
});

test("malformed optional group fields and singleton groups are refused", () => {
  const malformed = syntheticArtifactWith((value) => {
    (value.cards as Record<string, unknown>[])[0].variantGroup = null;
  });
  const unsafe = syntheticArtifactWith((value) => {
    (value.cards as Record<string, unknown>[])[0].variantGroup = "Not safe";
  });
  const unknown = syntheticArtifactWith((value) => {
    (value.cards as Record<string, unknown>[])[0].unreviewed = true;
  });
  const singleton = syntheticArtifactWith((value) => {
    (value.cards as Record<string, unknown>[])[0].variantGroup = "reviewed-variants";
  });

  assert.equal(rejectionReason(malformed), "card/variant-group");
  assert.equal(rejectionReason(unsafe), "card/variant-group");
  assert.equal(rejectionReason(unknown), "card/keys");
  assert.equal(rejectionReason(singleton), "index/variant-group-singleton");
});

test("cards keep the artifact order and their stored vectors", () => {
  const artifact = syntheticArtifact() as { cards: { id: string; vector: number[] }[] };
  const index = readReviewedIndex(artifact);

  assert.deepEqual(index.cards, artifact.cards);
});

test("the identity must match the pin field by field", () => {
  for (const field of Object.keys(EXPECTED_EMBEDDING)) {
    const artifact = syntheticArtifactWith((value) => {
      (value.embedding as Record<string, unknown>)[field] = "changed";
    });

    assert.equal(rejectionReason(artifact), "index/embedding-identity");
  }
});

test("a wrong vector dimension is refused instead of scored", () => {
  const artifact = syntheticArtifactWith((value) => {
    const card = (value.cards as Record<string, unknown>[])[0];
    card.vector = [1, 0, 0];
  });

  assert.equal(rejectionReason(artifact), "card/vector-dimensions");
});

test("a non-finite or zero vector is refused", () => {
  const notFinite = syntheticArtifactWith((value) => {
    const card = (value.cards as Record<string, unknown>[])[0];
    card.vector = axisWith(Number.NaN);
  });
  const zero = syntheticArtifactWith((value) => {
    const card = (value.cards as Record<string, unknown>[])[0];
    card.vector = axisWith(0);
  });

  assert.equal(rejectionReason(notFinite), "card/vector-not-finite");
  assert.equal(rejectionReason(zero), "card/vector-zero");
});

test("an empty field, a duplicate id and a bad source range are each named", () => {
  const emptyTopic = syntheticArtifactWith((value) => {
    (value.cards as Record<string, unknown>[])[1].topic = "  ";
  });
  const duplicate = syntheticArtifactWith((value) => {
    const cards = value.cards as Record<string, unknown>[];
    cards[1].id = cards[0].id;
  });
  const badRange = syntheticArtifactWith((value) => {
    (value.cards as Record<string, unknown>[])[0].sourceRefs = [{ startLine: 9, endLine: 4 }];
  });
  const missingRefs = syntheticArtifactWith((value) => {
    (value.cards as Record<string, unknown>[])[0].sourceRefs = [];
  });

  assert.equal(rejectionReason(emptyTopic), "card/topic");
  assert.equal(rejectionReason(duplicate), "card/duplicate-id");
  assert.equal(rejectionReason(badRange), "card/source-range");
  assert.equal(rejectionReason(missingRefs), "card/source-refs");
});

test("an artifact-level shape defect is refused", () => {
  const cardsShape = syntheticArtifactWith((value) => {
    value.cards = {};
  });
  const badSourceDigest = syntheticArtifactWith((value) => {
    (value.source as Record<string, unknown>).sha256 = "short";
  });
  const badContentDigest = syntheticArtifactWith((value) => {
    (value.embedding as Record<string, unknown>).contentSha256 = "short";
  });

  assert.equal(rejectionReason(null), "index/shape");
  assert.equal(rejectionReason(syntheticArtifactWith((value) => (value.version = 2))), "index/version");
  assert.equal(rejectionReason(cardsShape), "index/cards-shape");
  assert.equal(rejectionReason(badSourceDigest), "index/source-digest");
  assert.equal(rejectionReason(badContentDigest), "index/content-digest");
});

test("a rejection names a rule and a card id, never a field value", () => {
  const artifact = syntheticArtifactWith((value) => {
    (value.cards as Record<string, unknown>[])[2].answer = "";
  });

  try {
    readReviewedIndex(artifact);
    assert.fail("expected the artifact to be refused");
  } catch (error) {
    assert.ok(error instanceof RetrievalError);
    assert.equal(error.reason, "card/answer");
    assert.equal(error.field, "synthetic-codecs");
    assert.equal(error.message.includes("fixture"), false);
  }
});

function axisWith(first: number): number[] {
  const vector = Array.from({ length: EXPECTED_EMBEDDING.dimensions }, (): number => 0);
  vector[0] = first;
  return vector;
}