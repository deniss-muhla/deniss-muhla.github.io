/**
 * The answer path from one question to one prepared answer.
 *
 * The controller owns the branch between the semantic and the lexical path and nothing
 * else. It does not know the embedding library exists: it receives an encoder per call,
 * which keeps the vendor boundary in the module task 5.3 adds and lets the engine decide
 * when a model request is allowed at all. A metered session that has not opened the
 * assistant yet passes no encoder, and the controller answers from the lexical path
 * without asking for anything.
 *
 * Both paths read the same reviewed entries, so a limited answer is the same prepared
 * answer the semantic path would have served, marked as limited because it was found by
 * word overlap rather than by meaning. Only the latest request may update clarification
 * state; superseded and cancelled embedding work never falls back to a prepared answer.
 * Nothing here reports readiness, formats text or renders anything; that is the chat's work.
 *
 * A conversation remembers the card it answered last and its pending offered choices.
 * Greeting starters are sampled once and carry no retrieval score. An ordinal that
 * names a reviewed topic word ("second workplace") picks that position of the topic group
 * straight from the index without an embedding, and a question of at most three tokens is
 * embedded with the last answered topic appended, so a short follow-up carries the context
 * of the turn before it. Both need a previous answered turn; without one the question takes
 * the ordinary path unchanged. An ordinal past the end of its group asks for a rephrase:
 * design decision 9 refuses before it offers choices the visitor did not earn, and a
 * position pick has no score to offer.
 */
import { findCard, type AnswerCard, type ReviewedIndex, type SourceRange } from "./index.ts";
import { RetrievalError } from "./errors.ts";
import { STOPWORDS, findLexicalMatch } from "./lexical.ts";
import { rankCards } from "./scoring.ts";
import {
  type ClarificationChoice,
  type Selection,
  resolveClarification,
  selectAnswer,
} from "./selection.ts";

/** Embeds one trimmed question. Task 5.3 supplies the worker-backed implementation. */
export type QuestionEncoder = (question: string) => Promise<readonly number[]>;

/** Whether an answer was chosen by meaning or by word overlap. Never present the first as the second. */
export type Matching = "semantic" | "limited";

/** Why the lexical path answered. Both values mean no semantic answer was possible. */
export type LimitedCause = "model-unavailable" | "embedding-failed";

/** Added outside the prepared answer text; the answer itself is never modified. */
export const WEAK_MATCH_CUE = "I am not certain this is the detail you meant.";

export type Answer =
  | {
      kind: "answer";
      cardId: string;
      topic: string;
      /** The prepared answer, verbatim. The chat composes any cue around it. */
      answer: string;
      matching: Matching;
      /** True only for a semantic match between the floors, where the cue is added. */
      weak: boolean;
      /** Present exactly when `matching` is `limited`. */
      limitedCause?: LimitedCause;
      /** Existing reviewed line references for page-side section navigation. */
      sourceRefs?: SourceRange[];
    }
  | { kind: "clarify"; choices: ClarificationChoice[] }
  | { kind: "rephrase"; matching: Matching; limitedCause?: LimitedCause }
  | { kind: "shorten"; reason: "query/too-long" }
  | { kind: "cancelled" }
  | { kind: "superseded" }
  | { kind: "ask-question" };

/** A reviewed topic offered without a question or a similarity score. */
export type FactTopicChoice = Pick<ClarificationChoice, "cardId" | "topic">;

export interface RetrievalController {
  /**
   * Answers one trimmed or untrimmed question. A new question clears any pending choice;
   * an ordinal follow-up with a discussed topic word resolves without an embedding.
   */
  ask(question: string, encoder: QuestionEncoder | null): Promise<Answer>;
  /** Samples up to three distinct prepared topics once per conversation, without inference. */
  offerStarters(): readonly FactTopicChoice[];
  /** A real question or selection permanently dismisses this conversation's starters. */
  dismissStarters(): void;
  /** Resolves only a currently offered clarification or starter, without another retrieval. */
  chooseClarification(cardId: string): Answer | null;
  /** The choices currently on offer, or `null` when none are pending. */
  pendingChoices(): readonly ClarificationChoice[] | null;
  /** Clears conversation context and invalidates pending inference, retaining the index. */
  resetConversation(): void;
}

/** A question of at most this many tokens counts as a short follow-up. */
const SHORT_QUERY_TOKENS = 3;

/** A composed follow-up must stay short; a longer last topic leaves the question untouched. */
const MAX_COMPOSED_TOKENS = 6;

/** Ordinal words in question order, so "third" is the third card of the group. */
const ORDINAL_WORDS: Readonly<Record<string, number>> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

/** Word forms that follow "number", so "workplace number two" is "second workplace". */
const COUNTING_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const ORDINAL_SUFFIX = /^(\d+)(?:st|nd|rd|th)$/;

interface OrdinalRequest {
  /** The 1-based position the visitor asked for. */
  position: number;
  /** The question's tokens once the ordinal words are removed. */
  remaining: string[];
}

/** Question tokens, lowercased; single characters survive so "number 2" is still seen. */
function tokensOf(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Indexed words keep lexical matching's rule: punctuation is not a word character. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1);
}

function countOf(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  if (COUNTING_WORDS[token] !== undefined) return COUNTING_WORDS[token];
  return /^\d+$/.test(token) ? Number(token) : undefined;
}

function positionOf(token: string): number | undefined {
  if (ORDINAL_WORDS[token] !== undefined) return ORDINAL_WORDS[token];
  const match = ORDINAL_SUFFIX.exec(token);
  return match === null ? undefined : Number(match[1]);
}

/** The first ordinal of the question and the tokens around it, or `null` when it has none. */
function detectOrdinal(question: string): OrdinalRequest | null {
  const tokens = tokensOf(question);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const afterNumber = token === "number";
    const position = afterNumber ? countOf(tokens[index + 1]) : positionOf(token);

    if (position === undefined) continue;

    const remaining = [...tokens];
    remaining.splice(index, afterNumber ? 2 : 1);
    return { position, remaining };
  }

  return null;
}

/** The first word of the question that names a reviewed topic or tag, or `null`. */
function topicWordOf(remaining: readonly string[], vocabulary: ReadonlySet<string>): string | null {
  for (const token of remaining) {
    if (STOPWORDS.has(token)) continue;
    if (vocabulary.has(token)) return token;
  }

  return null;
}

export function createRetrievalController(index: ReviewedIndex, random: () => number = Math.random): RetrievalController {
  let offered: ClarificationChoice[] | null = null;
  let starters: readonly FactTopicChoice[] | null = null;
  let startersDismissed = false;
  let latestRequest = 0;
  /** The card this conversation answered last: the anchor every follow-up resolves against. */
  let answered: AnswerCard | null = null;

  const cardWords = new Map(
    index.cards.map((card) => [card.id, new Set([...wordsOf(card.topic), ...card.tags.flatMap(wordsOf)])]),
  );
  const vocabulary = new Set<string>();
  for (const words of cardWords.values()) for (const word of words) vocabulary.add(word);

  /** Every card whose topic or tag carries this exact word, in the index's source order. */
  function groupOf(word: string): AnswerCard[] {
    return index.cards.filter((card) => cardWords.get(card.id)?.has(word) === true);
  }

  /** Whether the last answered turn shares a word with this card: the topic was discussed. */
  function discussed(card: AnswerCard): boolean {
    const previous = answered === null ? undefined : cardWords.get(answered.id);
    const words = cardWords.get(card.id);

    if (previous === undefined || words === undefined) return false;
    for (const word of words) if (previous.has(word)) return true;
    return false;
  }

  /** An ordinal over a discussed topic: its position's card, with no embedding at all. */
  function resolveOrdinal(question: string): Answer | null {
    if (answered === null) return null;

    const ordinal = detectOrdinal(question);
    if (ordinal === null) return null;

    const word = topicWordOf(ordinal.remaining, vocabulary);
    if (word === null) return null;

    const group = groupOf(word);
    if (group.length === 0 || !group.some(discussed)) return null;

    const card = group[ordinal.position - 1];
    if (card === undefined) return { kind: "rephrase", matching: "semantic" };

    answered = card;
    return {
      kind: "answer",
      cardId: card.id,
      topic: card.topic,
      answer: card.answer,
      matching: "semantic",
      weak: false,
      sourceRefs: card.sourceRefs,
    };
  }

  /** A short follow-up embeds with the last answered topic appended, so it carries context. */
  function composedQuery(trimmed: string): string {
    if (answered === null) return trimmed;

    const tokens = tokensOf(trimmed);
    if (tokens.length === 0 || tokens.length > SHORT_QUERY_TOKENS) return trimmed;

    const composed = `${trimmed} ${answered.topic}`;
    return tokensOf(composed).length <= MAX_COMPOSED_TOKENS ? composed : trimmed;
  }

  function fromSelection(selection: Selection): Answer {
    if (selection.kind === "clarify") {
      offered = selection.choices;
      return { kind: "clarify", choices: selection.choices };
    }

    offered = null;

    if (selection.kind === "rephrase") return { kind: "rephrase", matching: "semantic" };

    const card = findCard(index, selection.cardId);

    if (card !== undefined) answered = card;

    return {
      kind: "answer",
      cardId: selection.cardId,
      topic: card?.topic ?? selection.cardId,
      answer: card?.answer ?? "",
      matching: "semantic",
      weak: selection.weak,
      sourceRefs: card?.sourceRefs ?? [],
    };
  }

  function lexical(cause: LimitedCause, question: string): Answer {
    const match = findLexicalMatch(index, question);

    offered = null;

    if (match === null) return { kind: "rephrase", matching: "limited", limitedCause: cause };

    const card = findCard(index, match.cardId);

    if (card !== undefined) answered = card;

    return {
      kind: "answer",
      cardId: match.cardId,
      topic: card?.topic ?? match.topic,
      answer: card?.answer ?? "",
      matching: "limited",
      weak: false,
      limitedCause: cause,
      sourceRefs: card?.sourceRefs ?? [],
    };
  }

  return {
    async ask(question, encoder) {
      // Starting a question immediately replaces any pending choice and supersedes older work.
      const request = ++latestRequest;
      offered = null;
      startersDismissed = true;

      const trimmed = question.trim();

      if (trimmed === "") return { kind: "ask-question" };

      // An ordinal over a discussed topic is a position in the index, not a model question.
      const followUp = resolveOrdinal(trimmed);
      if (followUp !== null) return followUp;

      const query = composedQuery(trimmed);

      if (encoder === null) return lexical("model-unavailable", query);

      let vector: readonly number[];

      try {
        vector = await encoder(query);
      } catch (error) {
        if (request !== latestRequest) return { kind: "superseded" };
        if (error instanceof RetrievalError && error.reason === "query/too-long") {
          return { kind: "shorten", reason: error.reason };
        }
        if (
          error instanceof RetrievalError &&
          (error.reason === "embed/cancelled" || error.reason === "embed/closed" || error.reason === "embed/superseded")
        ) {
          return { kind: "cancelled" };
        }
        return lexical("embedding-failed", query);
      }

      if (request !== latestRequest) return { kind: "superseded" };

      return fromSelection(selectAnswer(rankCards(index, vector), random));
    },

    offerStarters() {
      if (startersDismissed || offered !== null) return [];
      if (starters !== null) return starters;

      let available = [...index.cards];
      const sampled: FactTopicChoice[] = [];
      while (sampled.length < 3 && available.length > 0) {
        const position = Math.min(available.length - 1, Math.max(0, Math.floor(random() * available.length)));
        const card = available[position];
        sampled.push(Object.freeze({ cardId: card.id, topic: card.topic }));
        available = available.filter((candidate) => candidate.topic !== card.topic);
      }
      starters = Object.freeze(sampled);
      return starters;
    },

    dismissStarters() {
      startersDismissed = true;
    },

    chooseClarification(cardId) {
      const chosen = offered !== null
        ? resolveClarification(offered, cardId)
        : startersDismissed ? null : starters?.find((choice) => choice.cardId === cardId);
      if (chosen == null) return null;
      const card = findCard(index, chosen.cardId);
      if (card === undefined) return null;

      offered = null;
      startersDismissed = true;
      answered = card;
      return {
        kind: "answer",
        cardId: card.id,
        topic: card.topic,
        answer: card.answer,
        matching: "semantic",
        weak: false,
        sourceRefs: card.sourceRefs,
      };
    },

    resetConversation() {
      latestRequest += 1;
      offered = null;
      starters = null;
      startersDismissed = false;
      answered = null;
    },

    pendingChoices() {
      return offered;
    },
  };
}