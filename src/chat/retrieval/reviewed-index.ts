/**
 * The reviewed index as the page receives it.
 *
 * One normal Vite import is the only way the runtime reaches the artifact, so the page
 * cannot serve an entry that source review did not promote, and no code path here can
 * generate a card vector: the vectors are already in the imported bytes. This module
 * exists to hold that import, so the validation in `./index` stays a pure function that
 * browser-free tests can call with synthetic fixtures.
 */
import reviewedSource from "../../../resources/cv/facts.json";
import { RetrievalError } from "./errors.ts";
import { readReviewedIndex, type ReviewedIndex } from "./index.ts";

let loaded: ReviewedIndex | null = null;

/**
 * The validated reviewed index, read once and reused.
 *
 * A malformed import is a build or packaging defect, not a visitor question, so it throws
 * the module's own classified error instead of degrading to an empty index that would
 * answer everything with "not found".
 */
export function reviewedIndex(): ReviewedIndex {
  if (loaded === null) {
    try {
      loaded = readReviewedIndex(reviewedSource);
    } catch (error) {
      throw error instanceof RetrievalError ? error : new RetrievalError("index/unreadable");
    }
  }

  return loaded;
}