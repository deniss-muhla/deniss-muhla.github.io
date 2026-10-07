/**
 * The conversation flow of one asked turn, independent of React: the turn token, the
 * assistant bubble from creation to its terminal state, and what a supersede does to an
 * answer that is still in flight. `VoiceChat` renders the message list and wires the panel;
 * the browser-free suite drives this module directly, which is why the state decisions
 * live here rather than inside a component closure.
 */
import type { ClarificationChoice, VoiceEngine } from "./engine.ts";
import { describeReply, type ReplyView } from "./replies.ts";

export type MessageRole = "user" | "assistant" | "status";
export type Message = { id: number; role: MessageRole; text: string; pending?: boolean; note?: string };
export type TurnState = "idle" | "listening" | "thinking" | "speaking" | "error";

/** The engine surface the flow uses: the chat passes the singleton, a test an instance. */
export type TurnEngine = Pick<
  VoiceEngine,
  "ask" | "interrupt" | "stopAudio" | "pendingChoices" | "speak"
>;

/** The chat's turn refs, plain objects so React refs and a test's own holders both fit. */
export interface TurnRefs {
  revision: { current: number };
  activeUser: { current: number | null };
  activeAssistant: { current: number | null };
}

export interface TurnPorts {
  engine: TurnEngine;
  refs: TurnRefs;
  append: (role: MessageRole, text: string, pending?: boolean) => number;
  update: (id: number, patch: Partial<Message>) => void;
  remove: (id: number) => void;
  setMessages: (updater: (list: Message[]) => Message[]) => void;
  /** Plain value or updater: a transition that must read the current state takes the updater. */
  setTurn: (turn: TurnState | ((current: TurnState) => TurnState)) => void;
  setChoices: (choices: readonly ClarificationChoice[] | null) => void;
  setRetryOf: (question: string | null) => void;
  setNotice: (notice: string) => void;
  cancelPause: () => void;
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
  let greeted = false;

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

  /**
   * The one greeting the panel speaks on its first open: one assistant bubble, then the
   * spoken line, all bounded by the turn token. Each status transition reads the current
   * state instead of overwriting it, so a failure surfaced while the greeting speaks (a
   * microphone that will not open) keeps the panel on its error notice: the interface
   * keeps explaining what is missing instead of falling back to `speaking` and
   * `listening`.
   */
  async function greet(text: string): Promise<void> {
    if (greeted) return;
    greeted = true;
    const revision = refs.revision.current;
    const isCurrent = () => revision === refs.revision.current;
    const show = (next: TurnState): void => {
      if (!isCurrent()) return;
      ports.setTurn((current) => (current === "error" ? current : next));
    };
    ports.append("assistant", text);
    try {
      await engine.speak(text, {
        isCurrent,
        onSpeakingChange: (speaking) => show(speaking ? "speaking" : "listening"),
      });
      show("listening");
    } catch {
      // Speech output is optional; the text greeting is still shown.
      show("listening");
    }
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
    try {
      const answer = await engine.ask(question, {
        speak: true,
        isCurrent: current,
        onResult: (result) => {
          if (!current()) return;
          const view = describeReply(result);
          outcome = view;
          switch (view.kind) {
            // The note (uncertainty cue or limited-matching label) attaches beside the
            // answer; the text itself arrives through onDelta and is spoken verbatim.
            case "answer":
              if (view.note !== null) ports.update(assistantId, { note: view.note });
              return;
            case "choices":
              ports.update(assistantId, { text: view.prompt, pending: false });
              ports.setChoices(engine.pendingChoices() ?? []);
              ports.setTurn("listening");
              return;
            case "notice":
              ports.update(assistantId, { text: view.text, pending: false });
              if (view.retryable) ports.setRetryOf(question);
              ports.setTurn("listening");
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
        onSpeakingChange: (speaking) => {
          if (!current()) return;
          ports.setTurn(speaking ? "speaking" : "listening");
        },
        onSpeechError: (error) => {
          if (!current()) return;
          // The answer text stays in the chat; this status line labels what failed.
          ports.append("status", `Speech output failed: ${error.message}`);
        },
      });

      if (!current()) return;
      refs.activeAssistant.current = null;
      if (answer) {
        // Choices, notices and notes were already rendered in onResult.
        ports.update(assistantId, { text: answer, pending: false });
        ports.setTurn("listening");
      } else if (outcome === null) {
        // The engine returned no result and surfaced nothing: drop the empty bubble.
        ports.remove(assistantId);
        ports.setTurn("listening");
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
    ports.cancelPause();
    ports.resetTurnText();
    refs.activeUser.current = null;
    ports.append("user", question);
    void respond(question);
  }

  /** The retry control re-asks the last question through the same supersede preamble. */
  function retry(question: string): void {
    supersedeAnswer();
    ports.cancelPause();
    ports.resetTurnText();
    refs.activeUser.current = null;
    void respond(question);
  }

  return { greet, respond, send, retry, supersedeAnswer };
}

export type TurnFlow = ReturnType<typeof createTurnFlow>;
