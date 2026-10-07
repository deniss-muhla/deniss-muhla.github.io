import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { GREETING, INTRO } from "./cv-context";
import {
  PROGRESS_WEIGHTS,
  trace,
  voiceEngine,
  type ClarificationChoice,
  type ModelProgress,
  type ModelStates,
} from "./engine";
import { mergeTranscript } from "./transcript";
import {
  createTurnFlow,
  type Message,
  type MessageRole,
  type TurnFlow,
  type TurnState,
} from "./turn";
import styles from "./VoiceChat.module.css";

const PAUSE_COMMIT_MS = 1100;

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function VoiceChat() {
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<ModelProgress>({ stt: 0, tts: 0, encoder: 0 });
  const [states, setStates] = useState<ModelStates>({
    stt: "idle",
    tts: "idle",
    encoder: "idle",
  });
  const [turn, setTurn] = useState<TurnState>("idle");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [blink, setBlink] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  /** The clarification choices currently offered, rendered from the engine's pendingChoices(). */
  const [choices, setChoices] = useState<readonly ClarificationChoice[] | null>(null);
  /** The last question that produced no answer, offered back through the retry control. */
  const [retryOf, setRetryOf] = useState<string | null>(null);

  const openRef = useRef(open);
  const revisionRef = useRef(0);
  const finalizedTurnRef = useRef("");
  const interimTurnRef = useRef("");
  const pauseTimerRef = useRef<number | null>(null);
  const activeUserMessageRef = useRef<number | null>(null);
  const activeAssistantMessageRef = useRef<number | null>(null);
  const nextIdRef = useRef(1);
  const listRef = useRef<HTMLDivElement>(null);
  const blinkTimerRef = useRef<number | null>(null);

  openRef.current = open;

  const overall = useMemo(
    () => (Object.keys(PROGRESS_WEIGHTS) as Array<keyof ModelProgress>).reduce(
      (sum, key) => sum + progress[key] * PROGRESS_WEIGHTS[key],
      0,
    ),
    [progress],
  );
  const loading =
    states.stt === "loading" ||
    states.tts === "loading" ||
    states.encoder === "loading";
  const ready = states.stt === "ready" && states.tts === "ready";

  const appendMessage = useCallback((role: MessageRole, text: string, pending = false) => {
    const id = nextIdRef.current++;
    setMessages((current) => [...current, { id, role, text, pending }]);
    return id;
  }, []);

  const updateMessage = useCallback((id: number, patch: Partial<Message>) => {
    setMessages((current) => current.map((message) => (message.id === id ? { ...message, ...patch } : message)));
  }, []);

  const removeMessage = useCallback((id: number) => {
    setMessages((current) => current.filter((message) => message.id !== id));
  }, []);

  const currentTurnText = useCallback(
    () => mergeTranscript(finalizedTurnRef.current, interimTurnRef.current),
    [],
  );

  const resetTurnText = useCallback(() => {
    finalizedTurnRef.current = "";
    interimTurnRef.current = "";
  }, []);

  const renderTurnBubble = useCallback(
    (text: string) => {
      if (activeUserMessageRef.current === null) {
        activeUserMessageRef.current = appendMessage("user", text, true);
      } else {
        updateMessage(activeUserMessageRef.current, { text, pending: true });
      }
    },
    [appendMessage, updateMessage],
  );

  const cancelPauseTimer = useCallback(() => {
    if (pauseTimerRef.current !== null) {
      window.clearTimeout(pauseTimerRef.current);
      pauseTimerRef.current = null;
    }
  }, []);

  const flowRef = useRef<TurnFlow | null>(null);
  flowRef.current ??= createTurnFlow({
    engine: voiceEngine,
    refs: {
      revision: revisionRef,
      activeUser: activeUserMessageRef,
      activeAssistant: activeAssistantMessageRef,
    },
    append: appendMessage,
    update: updateMessage,
    remove: removeMessage,
    setMessages,
    setTurn,
    setChoices,
    setRetryOf,
    setNotice,
    cancelPause: cancelPauseTimer,
    resetTurnText,
  });
  const flow = flowRef.current;
  const stopAssistantWork = flow.supersedeAnswer;

  /** Selects an offered clarification entry directly: no second inference, then the same
   * spoken output any other answer would get. */
  const handleChoice = useCallback(
    (cardId: string) => {
      setChoices(null);
      setRetryOf(null);
      const picked = voiceEngine.chooseClarification(cardId);
      if (!picked || picked.kind !== "answer") {
        appendMessage("status", "That choice is no longer available. Please ask again.");
        setTurn("listening");
        return;
      }

      const revision = ++revisionRef.current;
      const isCurrent = () => revision === revisionRef.current;
      appendMessage("assistant", picked.answer, false);

      setTurn("speaking");
      void voiceEngine
        .speak(picked.answer, {
          isCurrent,
          onSpeakingChange: (speaking) => {
            if (isCurrent()) setTurn(speaking ? "speaking" : "listening");
          },
        })
        .then(() => {
          if (isCurrent()) setTurn("listening");
        })
        .catch((error: unknown) => {
          if (!isCurrent()) return;
          const message = error instanceof Error ? error.message : String(error);
          appendMessage("status", `Speech output failed: ${message}`);
          setTurn("listening");
        });
    },
    [appendMessage],
  );

  const handleRetry = useCallback(() => {
    if (retryOf === null) return;
    // The same supersede as a typed send, then re-ask through the flow.
    flow.retry(retryOf);
  }, [flow, retryOf]);

  const commitPendingTurn = useCallback(() => {
    pauseTimerRef.current = null;
    const question = currentTurnText().trim();
    if (!question) {
      resetTurnText();
      return;
    }

    const userMessageId = activeUserMessageRef.current;
    resetTurnText();
    activeUserMessageRef.current = null;
    setAsked(true);

    if (userMessageId !== null) {
      updateMessage(userMessageId, { text: question, pending: false });
    }

    void flow.respond(question);
  }, [currentTurnText, flow, resetTurnText, updateMessage]);

  const scheduleCommit = useCallback(() => {
    cancelPauseTimer();
    pauseTimerRef.current = window.setTimeout(commitPendingTurn, PAUSE_COMMIT_MS);
  }, [cancelPauseTimer, commitPendingTurn]);

  const handleSend = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const question = input.trim();
      if (!question) return;

      setInput("");
      setAsked(true);
      flow.send(question);
    },
    [flow, input],
  );

  // Wire speech recognition callbacks once; they read refs so they stay stable.
  useEffect(() => {
    voiceEngine.setSttHandlers({
      onText: (text) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        trace("interim", trimmed.slice(0, 80));
        // Interim transcripts update the pending bubble but do not interrupt an
        // answer; only a finalized line counts as the user taking the turn back.
        interimTurnRef.current = trimmed;
        renderTurnBubble(currentTurnText());
        scheduleCommit();
      },
      onLine: (line) => {
        const trimmed = line.text.trim();
        if (!trimmed) return;
        trace("final line", trimmed.slice(0, 80));
        stopAssistantWork();
        setTurn("listening");
        // The finalized line usually repeats the interim text that is already on
        // screen, so merge rather than append.
        finalizedTurnRef.current = mergeTranscript(finalizedTurnRef.current, trimmed);
        interimTurnRef.current = "";
        renderTurnBubble(currentTurnText());
        scheduleCommit();
      },
      onError: (error) => {
        trace("stt error", error.message);
        setNotice(error.message);
        setTurn("error");
      },
    });
  }, [appendMessage, currentTurnText, renderTurnBubble, scheduleCommit, stopAssistantWork, updateMessage]);

  // Subscribe to model progress and prefetch models once the page is idle.
  useEffect(() => {
    const unsubscribe = voiceEngine.subscribe((nextProgress, nextStates) => {
      setProgress(nextProgress);
      setStates(nextStates);
    });
    // A storage eviction surfaces during the TTS load; the chat reports it as a
    // status line, so the reason the model is loading again is visible when the
    // panel opens.
    voiceEngine.setStorageNoticeHandler((text) => appendMessage("status", text));

    const startPrefetch = async () => {
      const capabilities = await voiceEngine.detectOnce();
      // Data saving: no model request before the explicit open. The engine enforces the
      // same gate; the chat only adds the explanation.
      if (capabilities.saveData) {
        setNotice("Data saving is on: models are not preloaded. They will load when you open the chat.");
        return;
      }
      void voiceEngine.prefetch();
    };

    let idleId: number | null = null;
    const timeoutId = window.setTimeout(() => {
      if (typeof window.requestIdleCallback === "function") {
        idleId = window.requestIdleCallback(() => void startPrefetch(), { timeout: 4000 });
      } else {
        void startPrefetch();
      }
    }, 1200);

    return () => {
      voiceEngine.setStorageNoticeHandler(null);
      window.clearTimeout(timeoutId);
      if (idleId !== null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleId);
      }
      unsubscribe();
    };
  }, [appendMessage]);

  // When everything is ready while the panel is closed, blink the ring once.
  useEffect(() => {
    if (!ready) return;
    if (open) return;
    setBlink(true);
    if (blinkTimerRef.current !== null) window.clearTimeout(blinkTimerRef.current);
    blinkTimerRef.current = window.setTimeout(() => setBlink(false), 1800);
  }, [ready, open]);

  const startListening = useCallback(async () => {
    setTurn("listening");

    if (!voiceEngine.sttSupported) {
      setNotice("Live voice needs cross-origin isolation, which is unavailable in this browser session.");
      setTurn("error");
      return;
    }

    try {
      await voiceEngine.resumeAudio();
      await voiceEngine.startListening();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trace("startListening failed", message);
      setNotice(message);
      setTurn("error");
    }
  }, []);

  // Greet and start listening when the panel opens (or when models finish loading).
  useEffect(() => {
    if (!open) return;

    void voiceEngine.resumeAudio();

    if (!ready) {
      setTurn(loading ? "idle" : "error");
      return;
    }

    void flow.greet(GREETING);
    if (turn === "idle") void startListening();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready]);

  const handleToggle = useCallback(() => {
    setOpen((current) => {
      const next = !current;
      if (next) {
        setNotice(null);
        void voiceEngine.resumeAudio();
        // The explicit open starts the on-demand loads; under data saving this is where
        // every model request begins, otherwise it joins the background prefetch.
        void voiceEngine.startOnDemand();
      } else {
        cancelPauseTimer();
        resetTurnText();
        activeUserMessageRef.current = null;
        stopAssistantWork();
        void voiceEngine.stopListening();
        voiceEngine.stopAudio();
        setTurn("idle");
      }
      return next;
    });
  }, [cancelPauseTimer, resetTurnText, stopAssistantWork]);

  useEffect(() => {
    return () => {
      cancelPauseTimer();
      if (blinkTimerRef.current !== null) window.clearTimeout(blinkTimerRef.current);
      void voiceEngine.stopListening();
      voiceEngine.stopAudio();
    };
  }, [cancelPauseTimer]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const ringOffset = circumference * (1 - Math.max(overall, 0.02));
  const showRing = loading || (overall > 0 && overall < 1);

  const statusText = (() => {
    if (states.stt === "error" && states.tts === "error") {
      return "Local models are unavailable in this browser.";
    }
    if (loading) {
      if (states.stt === "loading") return `Loading speech recognition · ${formatPercent(progress.stt)}`;
      if (states.tts === "loading") return `Loading speech output · ${formatPercent(progress.tts)}`;
      if (states.encoder === "loading") return `Loading matching model · ${formatPercent(progress.encoder)}`;
      return `Loading local models · ${formatPercent(overall)}`;
    }
    if (!ready) return notice ?? "Voice assistant unavailable.";
    if (turn === "listening") return "Listening — speak or type.";
    if (turn === "thinking") return "Thinking…";
    if (turn === "speaking") return "Speaking…";
    if (turn === "error") return notice ?? "Something went wrong.";
    return "Ready.";
  })();

  return (
    <div className={styles.widget} data-open={open ? "" : undefined}>
      <section
        className={styles.panel}
        aria-hidden={!open}
        aria-label="Voice assistant for the CV"
        role="dialog"
      >
        <header className={styles.header}>
          <div className={styles.headerText}>
            <p className={styles.eyebrow}>On-device voice assistant</p>
            <h2 className={styles.title}>Ask my CV</h2>
          </div>
          <button
            type="button"
            className={styles.closeButton}
            onClick={handleToggle}
            aria-label="Close chat"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        <p className={styles.status} data-testid="voice-status" data-state={turn}>
          <span className={styles.statusDot} aria-hidden="true" />
          {statusText}
        </p>

        <div className={styles.messages} data-testid="voice-messages" ref={listRef} aria-live="polite">
          {!asked ? (
            <p className={styles.about}>
              {loading
                ? `Downloading local models once — ${formatPercent(overall)}. The chat will start by itself.`
                : INTRO}
            </p>
          ) : null}
          {messages.map((message) => (
            <Fragment key={message.id}>
              <p
                className={`${styles.message} ${message.role === "status" ? styles.statusMessage : styles[message.role]}`}
                data-pending={message.pending ? "" : undefined}
              >
                {message.text || "…"}
              </p>
              {/* The cue or limited-matching label sits outside the prepared answer. */}
              {message.note ? (
                <p className={styles.note} data-testid="voice-note">
                  {message.note}
                </p>
              ) : null}
            </Fragment>
          ))}
        </div>

        {choices && choices.length > 0 ? (
          <div
            className={styles.choices}
            role="group"
            aria-label="Clarification choices"
            data-testid="voice-choices"
          >
            {choices.map((choice) => (
              <button
                key={choice.cardId}
                type="button"
                className={styles.choice}
                data-testid="voice-choice"
                onClick={() => handleChoice(choice.cardId)}
              >
                {choice.topic}
              </button>
            ))}
          </div>
        ) : null}

        {retryOf !== null ? (
          <button
            type="button"
            className={styles.retry}
            data-testid="voice-retry"
            onClick={handleRetry}
          >
            Try again
          </button>
        ) : null}

        <form className={styles.composer} onSubmit={handleSend}>
          <input
            className={styles.input}
            data-testid="voice-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Type a question…"
            aria-label="Type a question"
          />
          <button type="submit" className={styles.send} disabled={!input.trim()}>
            Send
          </button>
        </form>
      </section>

      <button
        type="button"
        className={styles.fab}
        data-testid="voice-fab"
        data-loading={loading ? "" : undefined}
        data-blink={blink ? "" : undefined}
        onClick={handleToggle}
        aria-expanded={open}
        aria-label={open ? "Close voice assistant" : "Open voice assistant"}
        title={
          loading
            ? `Downloading local models · ${formatPercent(overall)}`
            : "Ask my CV with your voice"
        }
      >
        <svg className={styles.ring} viewBox="0 0 64 64" aria-hidden="true">
          <circle className={styles.ringTrack} cx="32" cy="32" r={radius} />
          <circle
            className={styles.ringValue}
            cx="32"
            cy="32"
            r={radius}
            strokeDasharray={circumference}
            strokeDashoffset={showRing ? ringOffset : 0}
            data-hidden={showRing ? undefined : ""}
          />
        </svg>

        {open ? (
          <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        ) : (
          <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" />
            <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
            <path d="M12 18v3" />
            <path d="M4 5.5h1.6M4 9h1.6M18.4 5.5H20M18.4 9H20" className={styles.spark} />
          </svg>
        )}

        {loading && !open ? (
          <span className={styles.progressBadge}>{formatPercent(overall)}</span>
        ) : null}
      </button>
    </div>
  );
}
