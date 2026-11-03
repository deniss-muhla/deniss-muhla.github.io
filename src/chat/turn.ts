/**
 * The conversation flow of one asked turn, independent of React: the turn token, the
 * assistant bubble from creation to its terminal state, and what a supersede does to an
 * answer that is still in flight. `VoiceChat` renders the message list and wires the panel;
 * the browser-free suite drives this module directly, which is why the state decisions
 * live here rather than inside a component closure.
 */
import type { Answer, ClarificationChoice, VoiceEngine } from "./engine.ts";
import { createAudioSequence, createGreetingSequence, type AssistantClipSequence } from "./audio-catalog.ts";
import { GREETING } from "./cv-context.ts";
import { describeReply, type ReplyView } from "./replies.ts";

export type MessageRole = "user" | "assistant" | "status";
export type Message = {
  id: number;
  role: MessageRole;
  text: string;
  pending?: boolean;
  note?: string;
  audioSequence?: AssistantClipSequence;
  selectedCardId?: string;
};
export type TurnState = "idle" | "listening" | "thinking" | "speaking" | "error";

/** The engine surface the flow uses: the chat passes the singleton, a test an instance. */
export type TurnEngine = Pick<
  VoiceEngine,
  "ask" | "interrupt" | "stopAudio" | "pendingChoices" | "speakSequence"
>;

/** The chat's turn refs, plain objects so React refs and a test's own holders both fit. */
export interface TurnRefs {
  revision: { current: number };
  activeUser: { current: number | null };
  activeAssistant: { current: number | null };
}

type SelectedAnswer = Extract<Answer, { kind: "answer" }>;
type AnswerSourceRefs = NonNullable<SelectedAnswer["sourceRefs"]>;
type MessageAudioBinding = Pick<Message, "audioSequence" | "selectedCardId">;

export interface TurnPorts {
  engine: TurnEngine;
  /** Page-owned scroll request for a selected prepared answer. */
  onAnswer?: (sourceRefs: AnswerSourceRefs) => void;
  refs: TurnRefs;
  append: (
    role: MessageRole,
    text: string,
    pending?: boolean,
    audioBinding?: MessageAudioBinding,
  ) => number;
  update: (id: number, patch: Partial<Message>) => void;
  remove: (id: number) => void;
  setMessages: (updater: (list: Message[]) => Message[]) => void;
  /** Plain value or updater: a transition that must read the current state takes the updater. */
  setTurn: (turn: TurnState | ((current: TurnState) => TurnState)) => void;
  setChoices: (choices: readonly ClarificationChoice[] | null) => void;
  setRetryOf: (question: string | null) => void;
  setNotice: (notice: string) => void;
  canSpeak: () => boolean;
  /** Explicit replay remains available to typed users, except while master-muted/closed. */
  canReplay?: () => boolean;
  resetTurnText: () => void;
}

/**
 * The terminal state of one interrupted assistant bubble: text already shown keeps
 * standing without the pending marker, an empty bubble leaves the conversation. Nothing
 * here ever writes answer text, so a superseded turn cannot echo content.
 */
function finalizeBubble(list: Message[], id: number): Message[] {
  return list.flatMap((message) => {
    if (message.id !== id) return [message];
    return message.text.trim() ? [{ ...message, pending: false }] : [];
  });
}

export function createTurnFlow(ports: TurnPorts) {
  const { engine, refs } = ports;
  const isCurrent = (revision: number) => revision === refs.revision.current;
  const answerSelected = (answer: SelectedAnswer): void => {
    if (answer.sourceRefs !== undefined) ports.onAnswer?.(answer.sourceRefs);
  };
  const settleActiveAssistant = (): void => {
    const id = refs.activeAssistant.current;
    if (id === null) return;
    ports.setMessages((list) => finalizeBubble(list, id));
  };

  /** Invalidates the in-flight answer and gives its bubble the terminal state: the one
   * supersede step, used by the close path and the voice-line interruption. */
  function supersedeAnswer(): void {
    refs.revision.current += 1;
    engine.interrupt();
    engine.stopAudio();
    settleActiveAssistant();
    refs.activeAssistant.current = null;
  }

  let greetingMessageId: number | null = null;
  let greetingPlayed = false;
  let greetingSequence: AssistantClipSequence | null = null;

  const appendSelectedAnswer = (answer: SelectedAnswer): number => {
    supersedeAnswer();
    const audioSequence = createAudioSequence(answer)!;
    const id = ports.append("assistant", answer.answer, false, {
      selectedCardId: answer.cardId,
      audioSequence,
    });
    answerSelected(answer);
    if (ports.canSpeak()) void playSequence(audioSequence, refs.revision.current);
    return id;
  };

  function showGreeting(text: string): number {
    if (greetingMessageId !== null) return greetingMessageId;
    greetingSequence = text === GREETING ? createGreetingSequence() : null;
    greetingMessageId = ports.append("assistant", text, false, greetingSequence ? { audioSequence: greetingSequence } : {});
    return greetingMessageId;
  }

  /** Speech for autoplay and replay always consumes the plan bound to the visible message. */
  async function playSequence(sequence: AssistantClipSequence, revision: number): Promise<boolean> {
    const current = () => isCurrent(revision) && (ports.canReplay?.() ?? true);
    if (!sequence.length || !current()) return false;

    const show = (next: TurnState): void => {
      if (current()) ports.setTurn((turn) => (turn === "error" ? turn : next));
    };
    try {
      await engine.speakSequence(sequence, {
        isCurrent: current,
        onSpeakingChange: (speaking) => show(speaking ? "speaking" : "listening"),
      });
      show("listening");
      return current();
    } catch {
      if (current()) {
        ports.append("status", "Speech output failed: Speech audio could not be played.");
        show("listening");
      }
      return false;
    }
  }

  /** The greeting is one visible message and one immutable plan, played only after consent. */
  async function greet(text: string): Promise<boolean> {
    showGreeting(text);
    if (greetingPlayed) return true;
    if (!ports.canSpeak() || !greetingSequence) return false;
    const played = await playSequence(greetingSequence, refs.revision.current);
    if (played) greetingPlayed = true;
    return played;
  }

  /** Explicit replay uses only the selected message's existing plan; it never asks again. */
  function replay(sequence: AssistantClipSequence): Promise<boolean> {
    if (!sequence.length || !(ports.canReplay?.() ?? true)) return Promise.resolve(false);
    supersedeAnswer();
    return playSequence(sequence, refs.revision.current);
  }

  async function respond(question: string): Promise<void> {
    const revision = ++refs.revision.current;
    const current = () => isCurrent(revision);
    ports.setTurn("thinking");
    // A new question replaces any pending clarification choice.
    ports.setChoices(null);
    ports.setRetryOf(null);

    const assistantId = ports.append("assistant", "", true);
    refs.activeAssistant.current = assistantId;

    let outcome: ReplyView | null = null;
    let audioSequence: AssistantClipSequence | null = null;
    try {
      const answer = await engine.ask(question, {
        isCurrent: current,
        onResult: (result) => {
          if (!current()) return;
          audioSequence = createAudioSequence(result);
          if (audioSequence !== null) {
            ports.update(assistantId, {
              audioSequence,
              ...(result.kind === "answer" ? { selectedCardId: result.cardId } : {}),
            });
          }
          const view = describeReply(result);
          outcome = view;
          switch (view.kind) {
            // The note (uncertainty cue or limited-matching label) attaches beside the
            // answer; the text itself arrives through onDelta and is spoken verbatim.
            case "answer":
              if (result.kind === "answer") answerSelected(result);
              if (view.note !== null) ports.update(assistantId, { note: view.note });
              return;
            case "choices": {
              ports.update(assistantId, { text: view.prompt, pending: false });
              const choices = result.kind === "clarify" ? result.choices : [];
              ports.setChoices(Object.freeze(choices.map((choice) => Object.freeze({ ...choice }))));
              ports.setTurn((turn) => (turn === "error" ? turn : "listening"));
              return;
            }
            case "notice":
              ports.update(assistantId, { text: view.text, pending: false });
              if (view.retryable) ports.setRetryOf(question);
              ports.setTurn((turn) => (turn === "error" ? turn : "listening"));
              return;
            case "none":
              // Superseded and cancelled results never reach onResult.
              return;
          }
        },
        onDelta: (text) => {
          if (!current()) return;
          ports.update(assistantId, { text, pending: true });
        },
      });

      if (!current()) return;
      refs.activeAssistant.current = null;
      if (answer) {
        // Choices, notices and notes were already rendered in onResult.
        ports.update(assistantId, { text: answer, pending: false });
        ports.setTurn((turn) => (turn === "error" ? turn : "listening"));
      } else if (outcome === null) {
        // The engine returned no result and surfaced nothing: drop the empty bubble.
        ports.remove(assistantId);
        ports.setTurn((turn) => (turn === "error" ? turn : "listening"));
      }
      if (audioSequence !== null && ports.canSpeak()) {
        await playSequence(audioSequence, revision);
      }
    } catch (error) {
      if (!current()) return;
      refs.activeAssistant.current = null;
      ports.remove(assistantId);
      const message = error instanceof Error ? error.message : String(error);
      ports.setNotice(message);
      ports.setTurn("error");
      ports.append("status", message);
      ports.setRetryOf(question);
    }
  }

  /** A typed or spoken send: take the turn back, then ask. */
  function send(question: string): void {
    supersedeAnswer();
    ports.resetTurnText();
    refs.activeUser.current = null;
    ports.append("user", question);
    void respond(question);
  }

  /** The retry control re-asks the last question through the same supersede preamble. */
  function retry(question: string): void {
    supersedeAnswer();
    ports.resetTurnText();
    refs.activeUser.current = null;
    void respond(question);
  }

  function resetConversation(): void {
    supersedeAnswer();
    greetingMessageId = null;
    greetingPlayed = false;
    greetingSequence = null;
  }

  return { resetConversation, showGreeting, greet, respond, send, retry, replay, supersedeAnswer, answerSelected, appendSelectedAnswer };
}

export type TurnFlow = ReturnType<typeof createTurnFlow>;
