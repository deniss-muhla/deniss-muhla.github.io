/**
 * Speech transcript composition for the question bubble.
 *
 * Moonshine reports interim text for the line being spoken and then reports the
 * same text again as a finalized line, and it can split one utterance into
 * several lines at natural pauses. Concatenating those events directly
 * duplicates phrases in the chat, so merging checks for exact, prefix and
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

    const remainder = right.split(/\s+/).slice(size).join(" ").trim();
    return remainder ? `${left} ${remainder}` : left;
  }

  return `${left} ${right}`;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
