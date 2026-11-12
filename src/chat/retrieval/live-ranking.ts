import type { AnswerCard, ReviewedIndex } from "./index.ts";
import { STOPWORDS } from "./lexical.ts";

const cache = new WeakMap<ReviewedIndex, Array<{ card: AnswerCard; fields: string[][] }>>();
const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1 && !STOPWORDS.has(word));

function distance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) rows[i][0] = i;
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
  }
  return rows[a.length][b.length];
}

// Query aliases are weaker than literal exact matches, but retain their field's tier.
const aliases: Record<string, readonly string[]> = {
  work: ["experience", "employment", "position", "positions", "workplace", "workplaces", "employer", "employers", "job", "jobs"],
  workplace: ["experience", "employment", "position", "positions", "workplaces", "employer", "employers", "job", "jobs"],
  workplaces: ["experience", "employment", "position", "positions", "workplace", "employer", "employers", "job", "jobs"],
  employer: ["experience", "employment", "position", "positions", "workplace", "workplaces", "job", "jobs"],
  employers: ["experience", "employment", "position", "positions", "workplace", "workplaces", "job", "jobs"],
  job: ["experience", "employment", "position", "positions", "workplace", "workplaces", "employer", "employers"],
  jobs: ["experience", "employment", "position", "positions", "workplace", "workplaces", "employer", "employers"],
  second: ["2nd"], first: ["1st"], earliest: ["first", "1st"], third: ["3rd"], fourth: ["4th"], last: ["fourth", "4th"], latest: ["fourth", "4th"],
  "2nd": ["second"], "1st": ["first"], "3rd": ["third"], "4th": ["fourth"],
  many: ["number", "count"], count: ["number"],
};

function quality(query: string, token: string): number {
  if (query === token) return 4;
  if (aliases[query]?.includes(token)) return 3;
  if (query.length >= 3 && token.startsWith(query)) return 2;
  if (query.length === 3) return token.length >= 3 && token.length <= 4 && token[0] === query[0] && distance(query, token) <= 1 ? 1 : 0;
  if (query.length < 4) return 0;
  const max = query.length < 7 ? 1 : 2;
  // Accept an inflectional plural without charging an additional edit.
  const singular = token.endsWith("s") ? token.slice(0, -1) : token;
  return (Math.abs(query.length - token.length) <= max && distance(query, token) <= max) ||
    (Math.abs(query.length - singular.length) <= max && distance(query, singular) <= max) ? 1 : 0;
}

/** Rank reviewed cards for live suggestions only. Field and match-quality precedence is
 * lexicographic, not a cosine bonus; the optional semantic scores break lexical ties. */
export function rankLiveCards(index: ReviewedIndex, query: string, semantic: ReadonlyMap<string, number> = new Map()): AnswerCard[] {
  const terms = [...new Set(words(query))];
  if (!terms.length || !terms.some((term) => term.length >= 3)) return [];
  let entries = cache.get(index);
  if (!entries) {
    entries = index.cards.map((card) => ({ card, fields: [words(card.tags.join(" ")), words(card.topic), words(card.answer)] }));
    cache.set(index, entries);
  }
  return entries.map(({ card, fields }) => {
    const counts = Array<number>(12).fill(0);
    let matched = 0;
    for (const term of terms) {
      let best = -1;
      for (let field = 0; field < fields.length; field++) {
        let q = 0;
        for (const token of fields[field]) q = Math.max(q, quality(term, token));
        if (q) { best = field * 4 + (4 - q); break; }
      }
      if (best >= 0) { counts[best]++; matched++; }
    }
    return { card, counts, matched };
  }).filter((item) => item.matched > 0).sort((a, b) => {
    for (let i = 0; i < 12; i++) if (a.counts[i] !== b.counts[i]) return b.counts[i] - a.counts[i];
    return (semantic.get(b.card.id) ?? 0) - (semantic.get(a.card.id) ?? 0) || a.card.id.localeCompare(b.card.id);
  }).map((item) => item.card);
}
