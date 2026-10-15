/**
 * How the chat presents one structured retrieval result. Pure mapping so the browser-free
 * suite can pin every label; `VoiceChat` owns the DOM around it.
 *
 * The uncertainty cue and the limited-matching label are separate fields here, never part
 * of the answer text: the prepared answer is spoken and read verbatim, and these notes are
 * rendered beside it.
 */
import { AUDIO_CATALOG_TEXT } from "./audio-catalog.ts";
import type { Answer, LimitedCause } from "./retrieval/controller.ts";

export type ReplyView =
  /** The prepared answer, with an optional note rendered outside the answer text. */
  | { kind: "answer"; note: string | null }
  /** Two offered entries: render the prompt and the choices from `pendingChoices()`. */
  | { kind: "choices"; prompt: string }
  /** A labeled state with no answer: its own text instead of a generic fallback. */
  | { kind: "notice"; text: string; retryable: boolean }
  /** Cancelled or superseded work that should leave no trace in the conversation. */
  | { kind: "none" };

export const CLARIFY_PROMPT = AUDIO_CATALOG_TEXT.clarifyPrompt;

/** Shown when the browser dropped the cached speech model between visits. */
export const MODEL_STORAGE_CLEARED_NOTICE =
  "Model storage was cleared by the browser; loading the voice model again.";

function limitedLabel(cause: LimitedCause): string {
  return cause === "model-unavailable"
    ? AUDIO_CATALOG_TEXT.limitedAnswerModelUnavailable
    : AUDIO_CATALOG_TEXT.limitedAnswerEmbeddingFailed;
}

function rephraseText(result: Answer & { kind: "rephrase" }): string {
  if (result.matching === "limited" && result.limitedCause) {
    return result.limitedCause === "model-unavailable"
      ? AUDIO_CATALOG_TEXT.limitedRephraseModelUnavailable
      : AUDIO_CATALOG_TEXT.limitedRephraseEmbeddingFailed;
  }
  return AUDIO_CATALOG_TEXT.rephrase;
}

/** Maps one controller result to what the chat shows next. */
export function describeReply(result: Answer): ReplyView {
  switch (result.kind) {
    case "answer": {
      if (result.weak) return { kind: "answer", note: AUDIO_CATALOG_TEXT.weakMatchNote };
      if (result.matching === "limited") {
        return { kind: "answer", note: limitedLabel(result.limitedCause ?? "model-unavailable") };
      }
      return { kind: "answer", note: null };
    }
    case "clarify":
      return { kind: "choices", prompt: CLARIFY_PROMPT };
    case "rephrase":
      return { kind: "notice", text: rephraseText(result), retryable: true };
    case "shorten":
      return {
        kind: "notice",
        text: AUDIO_CATALOG_TEXT.shorten,
        retryable: true,
      };
    case "ask-question":
      return { kind: "notice", text: AUDIO_CATALOG_TEXT.askQuestion, retryable: false };
    case "cancelled":
    case "superseded":
      return { kind: "none" };
  }
}
