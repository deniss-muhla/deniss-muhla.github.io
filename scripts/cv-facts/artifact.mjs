/**
 * Artifact format v1 and the offline validator behind `cv:facts check` and `cv:facts promote`.
 *
 * The validator is deliberately narrow. It proves shape, provenance and identity: the raw
 * source digest, the artifact version, unique nonempty fields, source ranges inside the
 * document, the pinned embedding identity, the ordered content digest and finite nonzero
 * vectors of the recorded length. It proves neither that an answer is true nor that a
 * visitor's question will be covered. A rejection names a rule id, a card id when the id is
 * safe to print, and source coordinates. It never prints source text or a field value.
 */
import { createHash } from "node:crypto";

export const ARTIFACT_VERSION = 1;
export const INPUT_VERSION = "retrieval-text-v1";
export const VECTOR_DECIMALS = 6;

/** The pinned embedding identity from design decisions 6 and 8. Any change fails the check. */
export const PINNED_EMBEDDING = Object.freeze({
  model: "mixedbread-ai/mxbai-embed-xsmall-v1",
  revision: "e6ac24e5d6efb8782b59de1647b3ececb4ece94e",
  dtype: "q8",
  runtimeVersion: "4.3.0",
  pooling: "mean",
  normalize: true,
  dimensions: 384,
  inputVersion: INPUT_VERSION,
});

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Format v1 is closed. A key that is not named here is unchecked payload that would reach the
 * published artifact, so it is refused rather than ignored.
 */
const ARTIFACT_KEYS = ["version", "source", "embedding", "cards"];
const SOURCE_KEYS = ["path", "sha256"];
const EMBEDDING_KEYS = [...Object.keys(PINNED_EMBEDDING), "contentSha256"];
const CARD_KEYS = ["id", "topic", "tags", "sourceRefs", "answer", "vector"];
const VARIANT_GROUP = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SOURCE_REF_KEYS = ["startLine", "endLine"];

/** Retrieval text v1. The query path embeds bare trimmed text against exactly this string. */
export function retrievalText(card) {
  return `${card.topic}\n${card.tags.join(", ")}\n${card.answer}`;
}

/**
 * Digest over ordered card text and, when present, reviewed equivalence metadata. Ungrouped
 * v1 artifacts retain their original tuple shape so the current reviewed index remains valid;
 * any grouped artifact uses a fifth nullable field on every tuple, binding both group names
 * and ungrouped membership. Retrieval text remains topic, tags and answer only.
 *
 * The cards are hashed as ordered JSON tuples, so a field value cannot forge a field, an array
 * or a record boundary: two tags `["a","b"]` and the single tag `"a<separator>b"` are
 * different arrays, even though retrieval text v1 joins both to the same query string. Source
 * drift and card drift stay distinguishable because the source digest is a separate field.
 */
export function contentSha256(cards) {
  const hasVariantGroups = cards.some((card) => card.variantGroup !== undefined);
  const records = cards.map((card) => {
    const text = [card.id, card.topic, card.tags, card.answer];
    return hasVariantGroups ? [...text, card.variantGroup ?? null] : text;
  });

  return createHash("sha256").update(JSON.stringify([INPUT_VERSION, records]), "utf8").digest("hex");
}

/** An empty identity block for a scaffold: pinned fields plus the digest `embed` computes. */
export function emptyEmbeddingIdentity() {
  return { ...PINNED_EMBEDDING, contentSha256: "" };
}

function safeCardId(value) {
  return typeof value === "string" && SAFE_ID.test(value) ? value : null;
}

function safeCoordinate(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;
}

/** Renders only numbers from `sourceRefs`. A value that is not a line number is dropped. */
function safeCoordinates(sourceRefs) {
  if (!Array.isArray(sourceRefs)) return null;
  const parts = [];

  for (const ref of sourceRefs) {
    const start = safeCoordinate(ref?.startLine);
    const end = safeCoordinate(ref?.endLine);

    if (start === null || end === null) continue;
    parts.push(`${start}-${end}`);
  }

  return parts.length > 0 ? parts.join(",") : null;
}

function finding(rule, { card = null, cardId = null, coordinates = null } = {}) {
  return { rule, card, cardId: safeCardId(cardId), coordinates };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value);

  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function hasAtMostSixDecimals(value) {
  const scaled = value * 10 ** VECTOR_DECIMALS;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/**
 * @param {unknown} artifact the parsed candidate or reviewed file
 * @param {{ sourceRelativePath: string, sourceSha256: string, sourceLineCount: number,
 *           expectedIdentity?: typeof PINNED_EMBEDDING }} context
 * @returns {{ findings: object[], cardCount: number }} findings in a stable order
 */
export function validateArtifact(artifact, context) {
  const { sourceRelativePath, sourceSha256, sourceLineCount } = context;
  const expectedIdentity = context.expectedIdentity ?? PINNED_EMBEDDING;
  const findings = [];

  if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) {
    return { findings: [finding("artifact/shape")], cardCount: 0 };
  }

  if (artifact.version !== ARTIFACT_VERSION) findings.push(finding("artifact/version"));
  if (!hasExactKeys(artifact, ARTIFACT_KEYS)) findings.push(finding("artifact/keys"));
  if (!Array.isArray(artifact.cards)) {
    findings.push(finding("artifact/shape"));
    return { findings, cardCount: 0 };
  }

  const source = artifact.source;

  if (
    source === null ||
    typeof source !== "object" ||
    !isNonEmptyString(source.path) ||
    source.path !== sourceRelativePath
  ) {
    findings.push(finding("source/path"));
  }

  if (!isNonEmptyString(source?.sha256) || !SHA256.test(source.sha256)) {
    findings.push(finding("source/digest-format"));
  } else if (source.sha256 !== sourceSha256) {
    findings.push(finding("source/digest"));
  }

  if (isRecord(source) && !hasExactKeys(source, SOURCE_KEYS)) findings.push(finding("source/keys"));

  const embedding = artifact.embedding;
  let contentDigestReadable = false;

  if (embedding === null || typeof embedding !== "object" || Array.isArray(embedding)) {
    findings.push(finding("embedding/identity"), finding("embedding/content-digest-format"));
  } else {
    if (!hasExactKeys(embedding, EMBEDDING_KEYS)) findings.push(finding("embedding/keys"));

    for (const [key, expected] of Object.entries(expectedIdentity)) {
      if (embedding[key] !== expected) findings.push(finding("embedding/identity"));
    }

    if (!isNonEmptyString(embedding.contentSha256) || !SHA256.test(embedding.contentSha256)) {
      findings.push(finding("embedding/content-digest-format"));
    } else {
      contentDigestReadable = true;
    }
  }

  const dimensions = expectedIdentity.dimensions;
  const seenIds = new Set();
  const variantGroupCounts = new Map();
  let cardsReadable = true;

  for (const [index, card] of artifact.cards.entries()) {
    const at = `cards[${index}]`;

    if (card === null || typeof card !== "object" || Array.isArray(card)) {
      findings.push(finding("card/shape", { card: at }));
      cardsReadable = false;
      continue;
    }

    if (!Array.isArray(card.tags)) cardsReadable = false;

    const cardId = safeCardId(card.id);
    const coordinates = safeCoordinates(card.sourceRefs);
    const where = { card: at, cardId, coordinates };

    const hasVariantGroup = Object.hasOwn(card, "variantGroup");
    const cardKeys = hasVariantGroup ? [...CARD_KEYS, "variantGroup"] : CARD_KEYS;

    if (!hasExactKeys(card, cardKeys)) findings.push(finding("card/keys", where));

    if (cardId === null) findings.push(finding("card/id", where));
    else if (seenIds.has(card.id)) findings.push(finding("card/id-duplicate", where));
    else seenIds.add(card.id);

    if (!isNonEmptyString(card.topic)) findings.push(finding("card/topic", where));
    if (!isNonEmptyString(card.answer)) findings.push(finding("card/answer", where));

    if (hasVariantGroup) {
      if (typeof card.variantGroup !== "string" || !VARIANT_GROUP.test(card.variantGroup)) {
        findings.push(finding("card/variant-group", where));
        cardsReadable = false;
      } else {
        variantGroupCounts.set(card.variantGroup, (variantGroupCounts.get(card.variantGroup) ?? 0) + 1);
      }
    }

    if (!Array.isArray(card.tags) || card.tags.length === 0) {
      findings.push(finding("card/tags", where));
    } else if (!card.tags.every(isNonEmptyString)) {
      findings.push(finding("card/tags", where));
    }

    if (!Array.isArray(card.sourceRefs) || card.sourceRefs.length === 0) {
      findings.push(finding("card/source-refs", where));
    } else {
      for (const ref of card.sourceRefs) {
        if (isRecord(ref) && !hasExactKeys(ref, SOURCE_REF_KEYS)) {
          findings.push(finding("card/source-ref-keys", where));
          break;
        }

        const start = safeCoordinate(ref?.startLine);
        const end = safeCoordinate(ref?.endLine);

        if (start === null || end === null || start < 1 || end < start || end > sourceLineCount) {
          findings.push(finding("card/source-range", where));
          break;
        }
      }
    }

    if (!Array.isArray(card.vector) || card.vector.length !== dimensions) {
      findings.push(finding("card/vector-length", where));
      continue;
    }

    if (!card.vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
      findings.push(finding("card/vector-not-finite", where));
      continue;
    }

    let squared = 0;

    for (const value of card.vector) squared += value * value;

    if (squared === 0) {
      findings.push(finding("card/vector-zero", where));
      continue;
    }

    if (!card.vector.every(hasAtMostSixDecimals)) {
      findings.push(finding("card/vector-precision", where));
    }
  }

  for (const count of variantGroupCounts.values()) {
    if (count < 2) findings.push(finding("card/variant-group-singleton", { card: "cards" }));
  }

  // The content digest is checked last so a malformed card cannot make the digest unreadable
  // and a malformed digest cannot hide a malformed card.
  if (contentDigestReadable && cardsReadable && embedding.contentSha256 !== contentSha256(artifact.cards)) {
    findings.push(finding("embedding/content-digest"));
  }

  return { findings, cardCount: artifact.cards.length };
}

/** A rejection line: rule id, safe card id, safe coordinates. Never a field value. */
export function describeFinding(findingRecord) {
  const parts = [findingRecord.rule];

  if (findingRecord.card) parts.push(findingRecord.card);
  if (findingRecord.cardId) parts.push(`card=${findingRecord.cardId}`);
  if (findingRecord.coordinates) parts.push(`at=${findingRecord.coordinates}`);

  return parts.join(" ");
}

/** Printed by every successful check so no reader mistakes it for an accuracy measurement. */
export const CHECK_SCOPE_NOTE =
  "scope: this check proves shape, provenance and embedding identity only; it proves neither answer truth nor retrieval quality.";