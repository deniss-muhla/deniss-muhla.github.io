/**
 * Finite, project-owned reply text and immutable speech-plan references.
 * This prepares a message sequence only; it does not bind assets, play audio or synthesize.
 */
import { GREETING } from "./cv-context.ts";
import { WEAK_MATCH_CUE, type Answer } from "./retrieval/controller.ts";
import type { ClarificationChoice } from "./retrieval/selection.ts";

/** The exact fixed assistant messages used in speech plans. */
export const AUDIO_CATALOG_TEXT = Object.freeze({
  greeting: GREETING,
  weakMatchNote: WEAK_MATCH_CUE,
  limitedAnswerModelUnavailable:
    "Limited matching: the embedding model is not loaded, so this was found by word overlap.",
  limitedAnswerEmbeddingFailed:
    "Limited matching: the embedding model failed to load, so this was found by word overlap.",
  clarifyPrompt: "Which of these did you mean?",
  rephrase: "No entry matched that question. Try rephrasing it.",
  limitedRephraseModelUnavailable:
    "Limited matching: the embedding model is not loaded, and no entry matched by words. Try rephrasing it.",
  limitedRephraseEmbeddingFailed:
    "Limited matching: the embedding model failed to load, and no entry matched by words. Try rephrasing it.",
  shorten: "That question is too long. Please ask a shorter one.",
  askQuestion: "Please ask a question first.",
});

export type CatalogClipId = keyof typeof AUDIO_CATALOG_TEXT;

/** Fixed messages have catalog identities; facts and topics use separate namespaces. */
export type CatalogClipReference = Readonly<{
  kind: "catalog";
  id: CatalogClipId;
  text: string;
}>;

export type FactClipReference = Readonly<{
  kind: "fact";
  cardId: string;
  text: string;
}>;

export type TopicClipReference = Readonly<{
  kind: "topic";
  cardId: string;
  text: string;
}>;

export type AssistantClipReference =
  | CatalogClipReference
  | FactClipReference
  | TopicClipReference;
export type AssistantClipSequence = readonly AssistantClipReference[];

function catalogClip(id: CatalogClipId): CatalogClipReference {
  return Object.freeze({ kind: "catalog", id, text: AUDIO_CATALOG_TEXT[id] });
}

function sequence(...clips: AssistantClipReference[]): AssistantClipSequence {
  return Object.freeze(clips);
}

/** The greeting is a fixed catalog clip, with its original text still owned by cv-context. */
export function createGreetingSequence(): AssistantClipSequence {
  return sequence(catalogClip("greeting"));
}

function limitedAnswerNote(cause: "model-unavailable" | "embedding-failed"): CatalogClipReference {
  return catalogClip(
    cause === "model-unavailable"
      ? "limitedAnswerModelUnavailable"
      : "limitedAnswerEmbeddingFailed",
  );
}

function rephraseClip(result: Extract<Answer, { kind: "rephrase" }>): CatalogClipReference {
  if (result.matching !== "limited" || result.limitedCause === undefined) {
    return catalogClip("rephrase");
  }

  return catalogClip(
    result.limitedCause === "model-unavailable"
      ? "limitedRephraseModelUnavailable"
      : "limitedRephraseEmbeddingFailed",
  );
}

/**
 * Prepares the exact clip order for one controller result. Clarification choices are copied
 * into their own topic references, so later controller state or caller mutation cannot alter
 * a stored plan. No retrieval, variant choice, text generation or audio work happens here.
 */
export function createAudioSequence(
  result: Answer,
  actualChoices?: readonly ClarificationChoice[] | null,
): AssistantClipSequence | null {
  switch (result.kind) {
    case "answer": {
      const clips: AssistantClipReference[] = [];
      if (result.weak) {
        clips.push(catalogClip("weakMatchNote"));
      } else if (result.matching === "limited") {
        clips.push(limitedAnswerNote(result.limitedCause ?? "model-unavailable"));
      }
      clips.push(Object.freeze({ kind: "fact", cardId: result.cardId, text: result.answer }));
      return sequence(...clips);
    }
    case "clarify": {
      const choices = actualChoices === undefined ? result.choices : actualChoices;
      if (choices === null || choices.length === 0) return null;
      return sequence(
        catalogClip("clarifyPrompt"),
        ...choices.map((choice) =>
          Object.freeze({ kind: "topic" as const, cardId: choice.cardId, text: choice.topic }),
        ),
      );
    }
    case "rephrase":
      return sequence(rephraseClip(result));
    case "shorten":
      return sequence(catalogClip("shorten"));
    case "ask-question":
      return sequence(catalogClip("askQuestion"));
    case "cancelled":
    case "superseded":
      return null;
  }
}
