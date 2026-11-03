/**
 * The three thresholds and the branch order of design decision 9.
 *
 * These values are thresholds for comparing cosine similarities, not calibrated
 * probabilities, and nothing here may present them as confidence. They were checked once
 * against the named synthetic cases of the accepted external probe and are recorded with
 * those cases below. That pass did not change them: the initial values already separated
 * every named case, so a constant that moves is a change the cases do not justify.
 *
 * The order below is the design's order and is not interchangeable. Refusal is checked
 * before the near-set branch, so an exact tie below the relevance floor asks for a rephrase
 * instead of offering choices the visitor did not earn. Only candidates that reach the
 * relevance floor are eligible. All close eligible ranks are inspected; only reviewed group
 * members share one contender identity, and randomness is limited to such close members.
 */
import type { Ranking, ScoredCard } from "./scoring.ts";

/** Below this cosine nothing in the index is treated as relevant. */
export const RELEVANCE_FLOOR = 0.45;

/** At or above this cosine a single clear candidate is answered without an uncertainty cue. */
export const CONFIDENCE = 0.6;

/** The gap the runner-up must leave before the best candidate is answered on its own. */
export const CONFIDENCE_MARGIN = 0.05;

/**
 * The calibration record. The named cases are the frozen v2 case set of the accepted
 * external probe, and the observed values are the browser's own query vectors scored against
 * the recorded card vectors of the same case set, in the dev and the built routing. They are
 * stored with the probe, not copied here, and a changed case set fails the check instead of
 * quietly becoming a new measurement.
 *
 * | Case | Branch | Top score | Margin over the runner-up |
 * | --- | --- | --- | --- |
 * | first-workplace-standalone | confident answer | 0.7185 | 0.1208 |
 * | second-workplace-standalone | clarify | 0.5420 | 0.0486 |
 * | continuation-no-memory | below-floor rephrase | 0.3651 | 0.0461 |
 * | named-employer-role | confident answer | 0.7086 | 0.1899 |
 * | named-employer-start-date | weak answer | 0.4952 | 0.0799 |
 * | distinct-technology-container | confident answer | 0.6396 | 0.4698 |
 * | distinct-technology-database | confident answer | 0.6706 | 0.4460 |
 * | absent-skill | below-floor rephrase | 0.3709 | 0.0788 |
 * | negation | weak answer | 0.5118 | 0.0909 |
 * | underspecified-topic | weak answer | 0.5644 | 0.1687 |
 *
 * Every expectation held with these values, and the same values are the ones the frozen gate
 * declared before the model was selected. The widest evidence for each boundary: a refusal
 * at 0.3709 and a refusal at 0.3651 sit below the floor, while the lowest answered case is
 * 0.4952 above it; the closest pair is 0.0486 inside the margin, and the narrowest margin
 * above it is 0.0799; the lowest confident answer is 0.6396 and the highest weak answer is
 * 0.5644, both clear of 0.60. Scores are not probabilities and no further tuning is planned.
 *
 * @see scripts/retrieval-qa.mjs, which recomputes this record in a real browser.
 */
export const CALIBRATION_CASES = Object.freeze([
  "first-workplace-standalone",
  "second-workplace-standalone",
  "continuation-no-memory",
  "named-employer-role",
  "named-employer-start-date",
  "distinct-technology-container",
  "distinct-technology-database",
  "absent-skill",
  "negation",
  "underspecified-topic",
] as const);

/** Shortest prepared answer plus cue the chat will render, kept out of the answer text itself. */
export const MAX_CLARIFICATION_CHOICES = 2;

export type Selection =
  /** Nothing relevant. The visitor is asked to rephrase. */
  | { kind: "rephrase" }
  /** Two highest-ranked distinct eligible contenders within the margin. */
  | { kind: "clarify"; choices: ClarificationChoice[] }
  /** One selected card. `weak` adds the uncertainty cue outside the prepared answer. */
  | { kind: "answer"; cardId: string; score: number; weak: boolean };

export interface ClarificationChoice {
  cardId: string;
  topic: string;
  score: number;
}

/**
 * @param ranking the full ranked list from `rankCards`
 * @param random injectable source in [0, 1], used only for close members of one reviewed group
 * @returns the branch decision; an empty list is a refusal, never an empty answer
 */
export function selectAnswer(ranking: Ranking, random: () => number = Math.random): Selection {
  const best = ranking.scored[0];

  if (best === undefined) return { kind: "rephrase" };
  if (best.score < RELEVANCE_FLOOR) return { kind: "rephrase" };

  const close = ranking.scored.filter(
    (candidate) => candidate.score >= RELEVANCE_FLOOR && best.score - candidate.score < CONFIDENCE_MARGIN,
  );
  const contenders = distinctContenders(close);

  if (contenders.length > 1) {
    return {
      kind: "clarify",
      choices: contenders.slice(0, MAX_CLARIFICATION_CHOICES).map(toChoice),
    };
  }

  const onlyGroup = close[0]?.variantGroup;
  if (onlyGroup !== undefined && close.length > 1) {
    const selected = close[Math.min(Math.floor(readRandom(random) * close.length), close.length - 1)];
    return answerSelection(selected);
  }

  // A non-close variant, a singleton group member, or an ungrouped card stays deterministic.
  return answerSelection(best);
}

function contenderKey(candidate: ScoredCard): string {
  return JSON.stringify(candidate.variantGroup === undefined
    ? ["card", candidate.id]
    : ["group", candidate.variantGroup]);
}

/** One highest-ranked representative per distinct card or reviewed group, in score order. */
function distinctContenders(close: readonly ScoredCard[]): ScoredCard[] {
  const seen = new Set<string>();
  const contenders: ScoredCard[] = [];

  for (const candidate of close) {
    const key = contenderKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    contenders.push(candidate);
  }

  return contenders;
}

function readRandom(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError("selection random source must return a finite value from 0 through 1");
  }
  return value;
}

function answerSelection(candidate: ScoredCard): Selection {
  return {
    kind: "answer",
    cardId: candidate.id,
    score: candidate.score,
    weak: candidate.score < CONFIDENCE,
  };
}

function toChoice(candidate: ScoredCard): ClarificationChoice {
  return { cardId: candidate.id, topic: candidate.topic, score: candidate.score };
}

/**
 * Resolves a visitor's pick from an earlier clarification.
 *
 * The card id is taken from the offered list only, so choosing an option cannot reach a card
 * the visitor was never shown, and it needs no second embedding or scoring pass. An id that
 * was not offered, including one guessed rather than chosen, resolves to nothing.
 *
 * @param offered the choices the visitor was actually shown
 * @param cardId the id the visitor selected
 * @returns the offered choice, or `null` when it was not offered
 */
export function resolveClarification(offered: readonly ClarificationChoice[], cardId: string): ClarificationChoice | null {
  return offered.find((choice) => choice.cardId === cardId) ?? null;
}