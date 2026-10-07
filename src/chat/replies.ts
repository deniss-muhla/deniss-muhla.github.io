/**
 * How the chat presents one structured retrieval result. Pure mapping so the browser-free
 * suite can pin every label; `VoiceChat` owns the DOM around it.
 *
 * The uncertainty cue and the limited-matching label are separate fields here, never part
 * of the answer text: the prepared answer is spoken and read verbatim, and these notes are
 * rendered beside it.
 */
import { WEAK_MATCH_CUE, type Answer, type LimitedCause } from "./retrieval/controller.ts";

export type ReplyView =
  /** The prepared answer, with an optional note rendered outside the answer text. */
  | { kind: "answer"; note: string | null }
  /** Two offered entries: render the prompt and the choices from `pendingChoices()`. */
  | { kind: "choices"; prompt: string }
  /** A labeled state with no answer: its own text instead of a generic fallback. */
  | { kind: "notice"; text: string; retryable: boolean }
  /** Cancelled or superseded work that should leave no trace in the conversation. */
  | { kind: "none" };

export const CLARIFY_PROMPT = "Which of these did you mean?";

/** Shown when the browser dropped the cached speech model between visits. */
export const MODEL_STORAGE_CLEARED_NOTICE =
  "Model storage was cleared by the browser; loading the voice model again.";

function limitedLabel(cause: LimitedCause): string {
  return cause === "model-unavailable"
    ? "Limited matching: the embedding model is not loaded, so this was found by word overlap."
    : "Limited matching: the embedding model failed to load, so this was found by word overlap.";
}

function rephraseText(result: Answer & { kind: "rephrase" }): string {
  if (result.matching === "limited" && result.limitedCause) {
    const cause =
      result.limitedCause === "model-unavailable" ? "is not loaded" : "failed to load";
    return `Limited matching: the embedding model ${cause}, and no entry matched by words. Try rephrasing it.`;
  }
  return "No entry matched that question. Try rephrasing it.";
}

/** Maps one controller result to what the chat shows next. */
export function describeReply(result: Answer): ReplyView {
  switch (result.kind) {
    case "answer": {
      if (result.weak) return { kind: "answer", note: WEAK_MATCH_CUE };
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
        text: "That question is too long. Please ask a shorter one.",
        retryable: true,
      };
    case "ask-question":
      return { kind: "notice", text: "Please ask a question first.", retryable: false };
    case "cancelled":
    case "superseded":
      return { kind: "none" };
  }
}
