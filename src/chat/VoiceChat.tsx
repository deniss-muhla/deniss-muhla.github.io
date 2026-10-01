import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { GREETING, INTRO } from "./cv-context";
import { PREVIEW_FLAG, trace, voiceEngine, type ModelProgress, type ModelStates } from "./engine";
import { mergeTranscript } from "./transcript";
import styles from "./VoiceChat.module.css";

type MessageRole = "user" | "assistant" | "status";
type Message = { id: number; role: MessageRole; text: string; pending?: boolean };

type TurnState = "idle" | "listening" | "thinking" | "speaking" | "error";

const PAUSE_COMMIT_MS = 1100;

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function VoiceChat() {
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<ModelProgress>({ stt: 0, tts: 0, llm: 0 });
  const [states, setStates] = useState<ModelStates>({ stt: "idle", tts: "idle", llm: "idle" });
  const [turn, setTurn] = useState<TurnState>("idle");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [blink, setBlink] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);

  const openRef = useRef(open);
  const preview = voiceEngine.preview;
  const greetingSentRef = useRef(false);
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
    () => (Object.keys(progress) as Array<keyof ModelProgress>).reduce(
      (sum, key, index) => sum + progress[key] * [0.18, 0.27, 0.55][index],
      0,
    ),
    [progress],
  );
  const loading = states.stt === "loading" || states.tts === "loading" || states.llm === "loading";
  const ready = states.stt === "ready" && states.tts === "ready" && states.llm === "ready";

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

  const stopAssistantWork = useCallback(() => {
    revisionRef.current += 1;
    voiceEngine.interrupt();
    voiceEngine.stopAudio();
    if (activeAssistantMessageRef.current !== null) {
      const id = activeAssistantMessageRef.current;
      activeAssistantMessageRef.current = null;
      setMessages((current) =>
        current.flatMap((message) => {
          if (message.id !== id) return [message];
          const text = message.text.trim();
          return text ? [{ ...message, pending: false }] : [];
        }),
      );
    }
  }, []);

  const respond = useCallback(
    async (question: string) => {
      const revision = ++revisionRef.current;
      const isCurrent = () => revision === revisionRef.current;
      setTurn("thinking");

      const assistantId = appendMessage("assistant", "", true);
      activeAssistantMessageRef.current = assistantId;

      try {
        await voiceEngine.ensureLlm();
        if (!isCurrent()) return;

        const answer = await voiceEngine.ask(question, {
          speak: true,
          isCurrent,
          onDelta: (text) => {
            if (!isCurrent()) return;
            updateMessage(assistantId, { text, pending: true });
          },
          onSpeakingChange: (speaking) => {
            if (!isCurrent()) return;
            setTurn(speaking ? "speaking" : "thinking");
          },
        });

        if (!isCurrent()) return;
        activeAssistantMessageRef.current = null;
        updateMessage(assistantId, {
          text: answer || "I could not find an answer in the CV.",
          pending: false,
        });
        setTurn("listening");
      } catch (error) {
        if (!isCurrent()) return;
        activeAssistantMessageRef.current = null;
        removeMessage(assistantId);
        const message = error instanceof Error ? error.message : String(error);
        setNotice(message);
        setTurn("error");
        appendMessage("status", message);
      }
    },
    [appendMessage, removeMessage, updateMessage],
  );

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

    void respond(question);
  }, [currentTurnText, resetTurnText, respond, updateMessage]);

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
      revisionRef.current += 1;
      voiceEngine.interrupt();
      voiceEngine.stopAudio();
      cancelPauseTimer();
      resetTurnText();
      activeUserMessageRef.current = null;
      activeAssistantMessageRef.current = null;

      appendMessage("user", question);
      void respond(question);
    },
    [appendMessage, cancelPauseTimer, input, resetTurnText, respond],
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

  // Subscribe to model progress and start loading once the page is idle.
  useEffect(() => {
    const unsubscribe = voiceEngine.subscribe((nextProgress, nextStates) => {
      setProgress(nextProgress);
      setStates(nextStates);
    });

    const startPrefetch = async () => {
      const capabilities = await voiceEngine.detectOnce();
      // Respect metered connections: nothing downloads without a click. Opening
      // the assistant below starts the same load from the visitor's own action.
      if (capabilities.saveData) {
        setNotice("Models are not preloaded on metered connections. They load when you open the chat.");
        return;
      }
      void voiceEngine.loadRequiredModels();
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
      window.clearTimeout(timeoutId);
      if (idleId !== null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleId);
      }
      unsubscribe();
    };
  }, []);

  // When everything is ready while the panel is closed, blink the ring once.
  useEffect(() => {
    if (!ready) return;
    if (open) return;
    setBlink(true);
    if (blinkTimerRef.current !== null) window.clearTimeout(blinkTimerRef.current);
    blinkTimerRef.current = window.setTimeout(() => setBlink(false), 1800);
  }, [ready, open]);

  const greet = useCallback(async () => {
    if (greetingSentRef.current) return;
    greetingSentRef.current = true;
    appendMessage("assistant", GREETING);
    try {
      await voiceEngine.speak(GREETING, {
        isCurrent: () => true,
        onSpeakingChange: (speaking) => setTurn(speaking ? "speaking" : "listening"),
      });
      setTurn("listening");
    } catch {
      // Speech output is optional; the text greeting is still shown.
      setTurn("listening");
    }
  }, [appendMessage]);

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

    void greet();
    if (turn === "idle") void startListening();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready]);

  const handleToggle = useCallback(() => {
    setOpen((current) => {
      const next = !current;
      if (next) {
        setNotice(null);
        void voiceEngine.resumeAudio();
        // A metered session skipped the background load, so opening the panel is
        // the visitor's explicit request for these models. Starting here is what
        // keeps the panel from waiting on a download nobody asked for.
        void voiceEngine.loadRequiredModels();
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
    if (states.llm === "error" && states.stt === "error" && states.tts === "error") {
      return "Local models are unavailable in this browser.";
    }
    if (loading) {
      if (states.stt === "loading") return `Loading speech recognition · ${formatPercent(progress.stt)}`;
      if (states.tts === "loading") return `Loading speech output · ${formatPercent(progress.tts)}`;
      return `Loading answer model · ${formatPercent(progress.llm)}`;
    }
    if (!ready) {
      if (states.llm === "error") {
        return "The answer model is unavailable here. It needs WebGPU; reloading may help.";
      }
      if (states.stt === "error") {
        return "Speech recognition is unavailable here. Type your question instead.";
      }
      if (states.tts === "error") {
        return "Speech output is unavailable here. Answers will appear as text.";
      }
      return "Voice assistant unavailable.";
    }
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
            <p
              key={message.id}
              className={`${styles.message} ${styles[message.role]}`}
              data-pending={message.pending ? "" : undefined}
            >
              {message.text || "…"}
            </p>
          ))}
        </div>

        {preview.state !== "off" ? (
          <p className={styles.about} data-testid="preview-notice">
            {preview.state === "incomplete"
              ? `Preview model ${preview.modelId} needs ${preview.missing} in the page URL, as absolute same-origin URLs without a query or a fragment.`
              : `The page URL points this session at the ${preview.modelId} pair it names instead of the assets this site ships. Remove ${PREVIEW_FLAG} from the page URL and reload to go back.`}
          </p>
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
