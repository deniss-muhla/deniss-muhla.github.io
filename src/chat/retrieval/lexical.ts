/**
 * The labeled lexical fallback for the states where no semantic answer is possible.
 *
 * It exists so a typed question still gets an answer while the embedding model loads, and
 * after loading failed, from exactly the same reviewed entries the semantic path uses. It
 * matches literal words in a card's topic, tags and answer, so it can only find a question
 * that shares wording with a prepared answer. That limit is why every result is marked
 * `limited`: this path never reports semantic readiness and never satisfies free-form
 * acceptance.
 *
 * The rule is deliberately strict and has no tunable constant. Stopwords are removed, and a
 * card is returned only when it contains every remaining term of the question. A partial
 * overlap is not a limited match, it is an inadequate one, and an inadequate match asks for
 * a rephrase rather than answering with the closest wording it happened to find.
 */
import type { ReviewedIndex } from "./index.ts";

export interface LexicalMatch {
  cardId: string;
  topic: string;
  /** Terms of the question found in the card's topic, tags or answer. */
  matchedTerms: string[];
}

export const STOPWORDS = new Set([
  "a", "about", "an", "and", "any", "are", "as", "at", "be", "did", "do", "does", "for", "from",
  "had", "has", "have", "he", "her", "his", "how", "i", "in", "is", "it", "me", "much", "of", "on",
  "or", "she", "tell", "that", "the", "their", "them", "there", "they", "to", "was", "were", "what",
  "when", "where", "which", "who", "whose", "why", "with", "you",
]);

/** Lowercase word characters only, so a punctuation difference is not a different term. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 1 && !STOPWORDS.has(term));
}

/** The same words a visitor would search for, across the three reviewed text fields. */
function searchableText(card: { topic: string; tags: string[]; answer: string }): string {
  return `${card.topic}\n${card.tags.join(" ")}\n${card.answer}`;
}

/**
 * Finds the card whose reviewed text covers the whole question.
 *
 * @param index the reviewed index
 * @param question the trimmed question
 * @returns the single covering card, or `null` when no card covers every term
 */
export function findLexicalMatch(index: ReviewedIndex, question: string): LexicalMatch | null {
  const terms = [...new Set(tokenize(question))];

  if (terms.length === 0) return null;

  const matches: LexicalMatch[] = [];

  for (const card of index.cards) {
    const haystack = tokenize(searchableText(card));
    const matchedTerms = terms.filter((term) => haystack.includes(term));

    if (matchedTerms.length === terms.length) {
      matches.push({ cardId: card.id, topic: card.topic, matchedTerms });
    }
  }

  // Several cards can cover the same question. Ordering by id keeps the choice stable;
  // lexical matching carries no score to rank by.
  matches.sort((left, right) => (left.cardId < right.cardId ? -1 : left.cardId > right.cardId ? 1 : 0));

  return matches[0] ?? null;
}