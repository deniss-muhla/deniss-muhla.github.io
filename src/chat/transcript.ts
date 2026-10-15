/**
 * Speech transcript composition for the question bubble.
 *
 * Speech recognition reports the words the engine has committed and, separately, the tail
 * it has not confirmed yet, and it can repeat a phrase across both. Concatenating those
 * events directly duplicates phrases in the chat, so merging checks for exact, prefix and
 * word-level overlap before appending.
 */
export function mergeTranscript(committed: string, incoming: string): string {
  const left = committed.trim();
  const right = incoming.trim();

  if (!right) return left;
  if (!left) return right;

  const leftText = normalize(left);
  const rightText = normalize(right);

  if (leftText === rightText) return right;
  if (leftText.endsWith(rightText)) return left;
  if (rightText.startsWith(leftText)) return right;

  const leftWords = leftText.split(" ");
  const rightWords = rightText.split(" ");
  const maxOverlap = Math.min(leftWords.length, rightWords.length, 16);

  for (let size = maxOverlap; size > 0; size -= 1) {
    if (leftWords.slice(-size).join(" ") !== rightWords.slice(0, size).join(" ")) continue;

    const remainder = remainderAfterNormalizedWords(right, size);
    if (!remainder.trim()) return left;
    return /^\s/u.test(remainder)
      ? `${left} ${remainder.trimStart()}`
      : `${left}${remainder}`;
  }

  return `${left} ${right}`;
}

function remainderAfterNormalizedWords(text: string, count: number): string {
  let consumedTokens = 0;
  let sourceEnd = 0;

  // Track source runs rather than whitespace words: punctuation can split one word into
  // multiple normalized tokens, and the suffix may need to begin inside that word.
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const tokenCount = normalize(match[0]).split(" ").filter(Boolean).length;
    consumedTokens += tokenCount;
    sourceEnd = match.index + match[0].length;
    if (consumedTokens >= count) break;
  }

  return text.slice(sourceEnd);
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
