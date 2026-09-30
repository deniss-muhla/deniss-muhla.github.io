/**
 * Public CV context for the answer model.
 *
 * Only the published CV markdown is used. No private documents or retrieval:
 * the complete source is passed as plain prompt context.
 */
import cvMarkdown from "../../resources/cv/source/cv.md?raw";

export function buildCvContext(): string {
  return cvMarkdown.trim();
}

export const SYSTEM_PROMPT = [
  "You are the voice assistant on Deniss Muhla's public CV website.",
  "Use only the CV facts below; never invent details and never mention anything that is not in the CV.",
  "Speak about Deniss in the third person and start the answer directly with 'He'.",
  "Answer in ONE short sentence of at most 25 words, as plain spoken text.",
  "Never use lists, numbers, headings, markdown, quotation marks or emoji.",
  "Do not repeat the question and do not add a preamble such as 'At If, Deniss does the following'.",
  "If the CV does not contain the answer, say in one sentence that it is not in the CV.",
  "The user message may come from speech recognition with missing punctuation; interpret it charitably.",
].join(" ");

export const GREETING =
  "Hi! I'm Deniss's on-device assistant. I run entirely in your browser, I keep working offline once loaded, and my answers come from small local models, so they can be approximate.";

/** Shown in the chat before the conversation starts. */
export const INTRO =
  "This assistant runs entirely in your browser with small local models: speech recognition, a 360M-parameter language model, and speech synthesis. Nothing is sent to a server. It keeps working offline after the first visit, but local models of this size can mishear or oversimplify. Ask about experience, projects or skills, by voice or by typing.";

export function buildPromptMessages(question: string, cvContext: string = buildCvContext()) {
  return [
    {
      role: "system" as const,
      content: `${SYSTEM_PROMPT}\n\n--- CV ---\n${cvContext}`,
    },
    { role: "user" as const, content: question },
  ];
}

/**
 * Strips markdown, list markers and line breaks so streamed model output is
 * readable in the chat while it is still arriving. Interrupted answers keep the
 * text produced so far, so this also runs on the partial stream.
 */
export function cleanForDisplay(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*(?:#{1,6}|[-*•]|\d+[.)])\s*/gm, " ")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trimStart();
}

/**
 * Turns raw model output into one or two spoken sentences: single paragraph,
 * no markdown, no filler preamble, no trailing list fragments.
 */
export function cleanAnswer(raw: string): string {
  let text = cleanForDisplay(raw).trim();

  // Drop filler openings such as "Based on the document, ..." or
  // "At If, Deniss does the following:" that small models like to produce.
  text = text
    .replace(/^(?:certainly|sure|of course)[,!.\s]+/i, "")
    .replace(/^based on (?:the )?(?:cv|document|information|provided context)[^.:!?]*[,:.!?]?\s*/i, "")
    .replace(/^[^.!?]{0,70}:\s*/, "")
    .trim();

  const sentences = text.match(/[^.!?]+[.!?]*/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];

  // Small models often repeat themselves; keep the first occurrence of an
  // identical or near-identical sentence.
  const seen = new Set<string>();
  const unique = sentences.filter((sentence) => {
    const key = sentence.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const kept = unique.length > 0 ? unique : sentences;
  if (kept.length > 2) {
    text = kept.slice(0, 2).join(" ").trim();
  } else if (kept.length > 0) {
    text = kept.join(" ").trim();
  }

  return text || raw.replace(/\s+/g, " ").trim();
}
