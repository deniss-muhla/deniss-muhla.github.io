import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { GREETING, INTRO } from "./cv-context";
import {
  PROGRESS_WEIGHTS,
  trace,
  voiceEngine,
  type Answer,
  type ClarificationChoice,
  type FactTopicChoice,
  type ModelProgress,
  type ModelStates,
} from "./engine";
import { mergeTranscript } from "./transcript";
import {
  describeAudioCacheProgress,
  INITIAL_AUDIO_CACHE_PROGRESS,
  requestAudioCacheWarm,
  subscribeAudioCacheProgress,
  type AudioCacheProgress,
} from "../offline/audio-cache";
import {
  createTurnFlow,
  type Message,
  type MessageRole,
  type TurnFlow,
  type TurnState,
} from "./turn";
import styles from "./VoiceChat.module.css";

type SelectedAnswer = Extract<Answer, { kind: "answer" }>;
type AnswerSourceRefs = NonNullable<SelectedAnswer["sourceRefs"]>;
type VoiceMode = "typed" | "live";

interface VoiceChatProps {
  onAnswer?: (sourceRefs: AnswerSourceRefs) => void;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function VoiceChat({ onAnswer }: VoiceChatProps) {
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<ModelProgress>({ stt: 0, encoder: 0 });
  const [states, setStates] = useState<ModelStates>({
    stt: "idle",
    encoder: "idle",
  });
  const [turn, setTurn] = useState<TurnState>("idle");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [blink, setBlink] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [audioCacheProgress, setAudioCacheProgress] = useState<AudioCacheProgress>(INITIAL_AUDIO_CACHE_PROGRESS);
  const [asked, setAsked] = useState(false);
  const [audioApproved, setAudioApproved] = useState(false);
  const [voiceMode, setVoiceMode] = useState<VoiceMode>("typed");
  const [startingVoice, setStartingVoice] = useState(false);
  const [muted, setMuted] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const audioApprovedRef = useRef(false);
  const voiceModeRef = useRef<VoiceMode>("typed");
  const voiceStartRef = useRef(0);
  const startingVoiceRef = useRef(false);
  /** The clarification choices currently offered, rendered from the engine's pendingChoices(). */
  const [choices, setChoices] = useState<readonly ClarificationChoice[] | null>(null);
  /** The last question that produced no answer, offered back through the retry control. */
  const [retryOf, setRetryOf] = useState<string | null>(null);

  const openRef = useRef(open);
  const revisionRef = useRef(0);
  const finalizedTurnRef = useRef("");
  const interimTurnRef = useRef("");
  const activeUserMessageRef = useRef<number | null>(null);
  const activeAssistantMessageRef = useRef<number | null>(null);
  const greetingStartRef = useRef(0);
  const nextIdRef = useRef(1);
  const listRef = useRef<HTMLDivElement>(null);
  const blinkTimerRef = useRef<number | null>(null);
  const mutedRef = useRef(false);
  const [starters, setStarters] = useState<readonly FactTopicChoice[] | null>(null);
  const [greetingMessageId, setGreetingMessageId] = useState<number | null>(null);
  const starterRequestRef = useRef(0);

  const dismissStarters = useCallback(() => {
    starterRequestRef.current += 1;
    setStarters(null);
    voiceEngine.dismissStarters();
  }, []);

  openRef.current = open;
  voiceModeRef.current = voiceMode;

  const overall = useMemo(
    () => (Object.keys(PROGRESS_WEIGHTS) as Array<keyof ModelProgress>).reduce(
      (sum, key) => sum + progress[key] * PROGRESS_WEIGHTS[key],
      0,
    ),
    [progress],
  );
  const loading = states.encoder === "loading" || (voiceMode === "live" && states.stt === "loading");
  const ready = states.encoder === "ready";
  const ringProgress = voiceMode === "live" ? overall : progress.encoder;

  const appendMessage = useCallback((
    role: MessageRole,
    text: string,
    pending = false,
    audioBinding: Pick<Message, "audioSequence" | "selectedCardId"> = {},
  ) => {
    const id = nextIdRef.current++;
    setMessages((current) => [...current, { id, role, text, pending, ...audioBinding }]);
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

  const settlePendingVoiceDraft = useCallback(() => {
    resetTurnText();
    const activeUser = activeUserMessageRef.current;
    if (activeUser === null) return;
    setMessages((list) => list.flatMap((message) => {
      if (message.id !== activeUser) return [message];
      return message.text.trim() ? [{ ...message, pending: false }] : [];
    }));
    activeUserMessageRef.current = null;
  }, [resetTurnText]);

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

  const flowRef = useRef<TurnFlow | null>(null);
  flowRef.current ??= createTurnFlow({
    engine: voiceEngine,
    onAnswer,
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
    canSpeak: () => openRef.current && audioApprovedRef.current && !mutedRef.current,
    canReplay: () => openRef.current && !mutedRef.current,
    resetTurnText,
  });
  const flow = flowRef.current;
  const showGreetingWithStarters = useCallback(() => {
    setGreetingMessageId(flow.showGreeting(GREETING));
    const request = ++starterRequestRef.current;
    const isCurrent = () => openRef.current && request === starterRequestRef.current;
    void voiceEngine.offerStarters({ isCurrent }).then((offered) => {
      if (isCurrent()) setStarters(offered);
    });
  }, [flow]);
  const stopAssistantWork = useCallback(() => {
    setReplaying(false);
    flow.supersedeAnswer();
  }, [flow]);

  const handleReplay = useCallback(async (sequence: NonNullable<Message["audioSequence"]>) => {
    if (mutedRef.current || !openRef.current) return;
    setReplaying(true);
    const playback = flow.replay(sequence);
    const revision = revisionRef.current;
    try {
      await playback;
    } finally {
      if (revisionRef.current === revision) setReplaying(false);
    }
  }, [flow]);

  /** Selects an offered clarification or starter directly: no second inference, then the same
   * spoken output any other answer would get. */
  const handleChoice = useCallback(
    (cardId: string) => {
      setReplaying(false);
      setChoices(null);
      setRetryOf(null);
      const picked = voiceEngine.chooseClarification(cardId);
      dismissStarters();
      if (!picked || picked.kind !== "answer") {
        appendMessage("status", "That choice is no longer available. Please ask again.");
        setTurn("listening");
        return;
      }

      flow.appendSelectedAnswer(picked);
      if (!audioApprovedRef.current) {
        setTurn((current) => (current === "error" ? current : "listening"));
      }
    },
    [appendMessage, dismissStarters, flow],
  );

  const handleRetry = useCallback(() => {
    if (retryOf === null) return;
    // The same supersede as a typed send, then re-ask through the flow.
    setReplaying(false);
    flow.retry(retryOf);
  }, [flow, retryOf]);

  const commitPendingTurn = useCallback(() => {
    if (!openRef.current || voiceModeRef.current !== "live" || mutedRef.current) return;
    const question = currentTurnText().trim();
    if (!question) {
      resetTurnText();
      return;
    }

    const userMessageId = activeUserMessageRef.current;
    resetTurnText();
    activeUserMessageRef.current = null;
    setAsked(true);
    dismissStarters();

    if (userMessageId !== null) {
      updateMessage(userMessageId, { text: question, pending: false });
    }

    void flow.respond(question);
  }, [currentTurnText, dismissStarters, flow, resetTurnText, updateMessage]);

  const handleSend = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const question = input.trim();
      if (!question) return;

      setReplaying(false);
      setInput("");
      setAsked(true);
      dismissStarters();
      flow.send(question);
    },
    [dismissStarters, flow, input],
  );

  // Wire speech recognition callbacks once; they read refs so they stay stable.
  useEffect(() => {
    voiceEngine.setSttHandlers({
      onUtteranceStart: () => {
        if (!openRef.current || voiceModeRef.current !== "live" || !audioApprovedRef.current || mutedRef.current) return;
        // Cancel an awaited greeting separately from the microphone generation: capture
        // stays live so the utterance that caused this event can become the next question.
        greetingStartRef.current += 1;
        settlePendingVoiceDraft();
        stopAssistantWork();
        setTurn((current) => (current === "error" ? current : "listening"));
      },
      onText: (text) => {
        if (!openRef.current || voiceModeRef.current !== "live" || mutedRef.current) return;
        const trimmed = text.trim();
        if (trimmed) dismissStarters();
        interimTurnRef.current = trimmed;
        const combined = currentTurnText();
        if (combined) renderTurnBubble(combined);
        else if (activeUserMessageRef.current !== null) {
          removeMessage(activeUserMessageRef.current);
          activeUserMessageRef.current = null;
        }
      },
      onLine: (line) => {
        if (!openRef.current || voiceModeRef.current !== "live" || mutedRef.current) return;
        const trimmed = line.text.trim();
        if (!trimmed) return;
        dismissStarters();
        trace("stt final line");
        stopAssistantWork();
        setTurn("listening");
        // The finalized line usually repeats the interim text that is already on
        // screen, so merge rather than append.
        finalizedTurnRef.current = mergeTranscript(finalizedTurnRef.current, trimmed);
        interimTurnRef.current = "";
        renderTurnBubble(currentTurnText());
      },
      onUtteranceEnd: commitPendingTurn,
      onWarning: (message) => {
        if (openRef.current && voiceModeRef.current === "live" && !mutedRef.current) setNotice(message);
      },
      onPlaybackError: () => {
        if (!openRef.current || voiceModeRef.current !== "live" || mutedRef.current) return;
        setNotice("Speech audio could not be paused or resumed. You can still type a question.");
        setTurn("error");
      },
      onError: () => {
        if (!openRef.current || voiceModeRef.current !== "live" || mutedRef.current) return;
        trace("stt error");
        setNotice("Speech recognition failed. You can still type a question.");
        setTurn("error");
      },
    });
  }, [commitPendingTurn, currentTurnText, dismissStarters, removeMessage, renderTurnBubble, settlePendingVoiceDraft, stopAssistantWork]);

  // Subscribe to model progress and prefetch models once the page is idle.
  useEffect(() => {
    const unsubscribe = voiceEngine.subscribe((nextProgress, nextStates) => {
      setProgress(nextProgress);
      setStates(nextStates);
    });
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

  const startListening = useCallback(async (isCurrent: () => boolean, outputRevision: number) => {
    if (!isCurrent()) return;
    try {
      await voiceEngine.startListening({ isCurrent });
      if (isCurrent() && revisionRef.current === outputRevision) {
        setTurn((current) => (current === "error" ? current : "listening"));
      }
    } catch {
      if (!isCurrent()) return;
      trace("startListening failed");
      setNotice("Voice input could not start. You can still type a question.");
      setTurn("error");
    }
  }, []);

  const handleStartVoice = useCallback(async () => {
    if (startingVoiceRef.current || !openRef.current) return;
    mutedRef.current = false;
    setMuted(false);
    const request = ++voiceStartRef.current;
    const greetingRequest = ++greetingStartRef.current;
    const outputRevision = revisionRef.current;
    voiceModeRef.current = "live";
    setVoiceMode("live");
    startingVoiceRef.current = true;
    setStartingVoice(true);
    const isCurrent = () =>
      openRef.current && !mutedRef.current && voiceModeRef.current === "live" && voiceStartRef.current === request;

    try {
      // The opener or explicit voice enable is the consent boundary for audio and STT loading.
      await voiceEngine.resumeAudio();
      if (!isCurrent()) return;
      audioApprovedRef.current = true;
      setAudioApproved(true);
      // Keep capture active during playback so confirmed speech can interrupt it.
      // Output supersession cancels startup presentation/greeting, not consented capture.
      await startListening(isCurrent, outputRevision);
      if (!isCurrent() || greetingStartRef.current !== greetingRequest || revisionRef.current !== outputRevision) return;
      await flow.greet(GREETING);
    } catch {
      if (isCurrent()) {
        voiceModeRef.current = "typed";
        setVoiceMode("typed");
        audioApprovedRef.current = false;
        setAudioApproved(false);
        setNotice("Audio could not start. Try the voice button again, or type a question.");
      }
    } finally {
      if (voiceStartRef.current === request) {
        startingVoiceRef.current = false;
        if (openRef.current) setStartingVoice(false);
      }
    }
  }, [flow, startListening]);

  const handleVoiceToggle = useCallback(() => {
    // Inactive typed chat enables live voice; active Replay still offers master mute.
    if (mutedRef.current || (voiceModeRef.current !== "live" && !startingVoiceRef.current && !replaying && turn !== "speaking")) {
      void handleStartVoice();
      return;
    }
    mutedRef.current = true;
    setMuted(true);
    voiceStartRef.current += 1;
    greetingStartRef.current += 1;
    startingVoiceRef.current = false;
    setStartingVoice(false);
    settlePendingVoiceDraft();
    stopAssistantWork();
    void voiceEngine.stopListening();
    setTurn("listening");
  }, [handleStartVoice, settlePendingVoiceDraft, stopAssistantWork, replaying, turn]);

  const handleNewChat = useCallback(() => {
    const request = ++voiceStartRef.current;
    const greetingRequest = ++greetingStartRef.current;
    startingVoiceRef.current = false;
    setStartingVoice(false);
    setReplaying(false);
    flow.resetConversation();
    const outputRevision = revisionRef.current;
    voiceEngine.resetConversation();
    resetTurnText();
    activeUserMessageRef.current = null;
    activeAssistantMessageRef.current = null;
    setMessages([]);
    setInput("");
    setChoices(null);
    setRetryOf(null);
    setNotice(null);
    setAsked(false);
    setTurn("listening");
    setStarters(null);
    showGreetingWithStarters();
    // Stop/discard the old recognizer tail before starting a fresh consented stream.
    const isCurrent = () => openRef.current && !mutedRef.current
      && voiceModeRef.current === "live" && audioApprovedRef.current
      && voiceStartRef.current === request;
    const stopped = voiceEngine.stopListening();
    if (!isCurrent()) return;
    startingVoiceRef.current = true;
    setStartingVoice(true);
    void (async () => {
      await stopped;
      await startListening(isCurrent, outputRevision);
      if (isCurrent() && greetingStartRef.current === greetingRequest && revisionRef.current === outputRevision) {
        await flow.greet(GREETING);
      }
    })().finally(() => {
      if (voiceStartRef.current === request) {
        startingVoiceRef.current = false;
        setStartingVoice(false);
      }
    });
  }, [flow, resetTurnText, showGreetingWithStarters, startListening]);

  useEffect(() => {
    if (!open) return;
    showGreetingWithStarters();
  }, [open, showGreetingWithStarters]);

  const handleToggle = useCallback(() => {
    if (!openRef.current) {
      openRef.current = true;
      setOpen(true);
      voiceModeRef.current = "typed";
      setVoiceMode("typed");
      audioApprovedRef.current = false;
      setAudioApproved(false);
      setNotice(null);
      void voiceEngine.startOnDemand();
      void handleStartVoice();
      return;
    }

    openRef.current = false;
    starterRequestRef.current += 1;
    setOpen(false);
    voiceStartRef.current += 1;
    greetingStartRef.current += 1;
    voiceModeRef.current = "typed";
    setVoiceMode("typed");
    audioApprovedRef.current = false;
    setAudioApproved(false);
    startingVoiceRef.current = false;
    setStartingVoice(false);
    settlePendingVoiceDraft();
    stopAssistantWork();
    void voiceEngine.stopListening();
    setChoices(null);
    setRetryOf(null);
    setNotice(null);
    setTurn("idle");
  }, [handleStartVoice, settlePendingVoiceDraft, stopAssistantWork]);

  useEffect(() => {
    return () => {
      if (blinkTimerRef.current !== null) window.clearTimeout(blinkTimerRef.current);
      openRef.current = false;
      starterRequestRef.current += 1;
      voiceStartRef.current += 1;
      greetingStartRef.current += 1;
      voiceModeRef.current = "typed";
      stopAssistantWork();
      void voiceEngine.stopListening();
    };
  }, [stopAssistantWork]);

  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeAudioCacheProgress((progress) => {
      if (active) setAudioCacheProgress(progress);
    });
    const requestWarm = () => requestAudioCacheWarm((state) => {
      if (active) setAudioCacheProgress((current) => ({ ...current, state, canRetry: false }));
    });
    const serviceWorker = "serviceWorker" in navigator ? navigator.serviceWorker : null;
    const connection = (navigator as Navigator & { connection?: EventTarget }).connection;
    requestWarm();
    window.addEventListener("online", requestWarm);
    window.addEventListener("offline", requestWarm);
    serviceWorker?.addEventListener("controllerchange", requestWarm);
    connection?.addEventListener("change", requestWarm);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("online", requestWarm);
      window.removeEventListener("offline", requestWarm);
      serviceWorker?.removeEventListener("controllerchange", requestWarm);
      connection?.removeEventListener("change", requestWarm);
    };
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const ringOffset = circumference * (1 - Math.max(ringProgress, 0.02));
  const showRing = loading || (ringProgress > 0 && ringProgress < 1);

  const statusText = (() => {
    if (muted) return "Voice muted. You can still type a question.";
    if (voiceMode === "typed") {
      if (states.encoder === "loading") return `Loading matching model · ${formatPercent(progress.encoder)}. You can type meanwhile.`;
      if (turn === "thinking") return "Matching your question…";
      if (turn === "speaking") return "Playing the requested replay…";
      if (turn === "error") return notice ?? "Silent typed chat is ready.";
      if (states.encoder === "error") return "Silent typed chat ready; semantic matching is unavailable.";
      return "Silent typed chat ready.";
    }
    if (states.stt === "error") return "Live speech recognition unavailable; typed chat remains ready.";
    if (loading) {
      if (states.stt === "loading") return `Loading speech recognition · ${formatPercent(progress.stt)}. You can type meanwhile.`;
      if (states.encoder === "loading") return `Loading matching model · ${formatPercent(progress.encoder)}. You can type meanwhile.`;
      return `Loading voice models · ${formatPercent(overall)}`;
    }
    if (turn === "listening") return "Listening — speak or type.";
    if (turn === "thinking") return "Matching your question…";
    if (turn === "speaking") return "Speaking…";
    if (startingVoice) return "Starting live voice…";
    if (turn === "error") return notice ?? "Something went wrong; typed chat is ready.";
    if (states.encoder === "error") return "Live voice ready; semantic matching is unavailable.";
    if (!audioApproved) return "Use the voice button to start live voice, or type a question.";
    return "Live voice ready. You can type, too.";
  })();

  const canMuteVoice = !muted && (voiceMode === "live" || startingVoice || replaying || turn === "speaking");
  const audioCacheText = audioCacheProgress.state === "ready"
    ? "Answer audio available offline."
    : describeAudioCacheProgress(audioCacheProgress);

  return (
    <div className={styles.widget} data-open={open ? "" : undefined}>
      <section
        className={styles.panel}
        aria-hidden={!open}
        inert={!open}
        aria-label="Voice assistant for the CV"
        role="dialog"
      >
        <header className={styles.header}>
          <div className={styles.headerText}>
            <p className={styles.eyebrow}>On-device voice assistant</p>
            <h2 className={styles.title}>Ask my CV</h2>
          </div>
          <button type="button" className={styles.newChat} data-testid="voice-new-chat"
            onClick={handleNewChat} aria-label="New chat" title="New chat">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10a8 8 0 1 1 1 8M4 4v6h6" /></svg>
          </button>
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

        <p
          className={styles.status}
          data-testid="voice-status"
          data-state={voiceMode === "typed" && turn === "listening" ? "idle" : turn}
        >
          <span className={styles.statusDot} aria-hidden="true" />
          {statusText}
        </p>
        <div className={audioCacheProgress.state === "ready" ? styles.audioCacheReady : styles.audioCacheStatus} role="status" aria-live="polite" data-testid="voice-audio-cache-status">
          <span>{audioCacheText}</span>
          {["partial", "skipped-save-data", "offline", "error"].includes(audioCacheProgress.state) ? (
            <button type="button" className={styles.audioCacheRetry} onClick={() => requestAudioCacheWarm()}>
              Retry audio download
            </button>
          ) : null}
        </div>

        {notice ? <p className={styles.about} role="status">{notice}</p> : null}

        <div className={styles.messages} data-testid="voice-messages" ref={listRef} aria-live="polite">
          {!asked ? (
            <p className={styles.about}>
              {loading
                ? states.stt === "loading"
                  ? `Loading speech recognition · ${formatPercent(progress.stt)}. You can type meanwhile.`
                  : `Loading matching model · ${formatPercent(progress.encoder)}. You can type meanwhile.`
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
              {message.id === greetingMessageId && starters && starters.length > 0 ? (
                <div className={styles.choices} role="group" aria-label="Suggested fact topics" data-testid="voice-starters">
                  {starters.map((choice) => (
                    <button key={choice.cardId} type="button" className={styles.choice}
                      data-testid="voice-starter" onClick={() => handleChoice(choice.cardId)}>
                      {choice.topic}
                    </button>
                  ))}
                </div>
              ) : null}
              {/* The cue or limited-matching label sits outside the prepared answer. */}
              {message.note ? (
                <p className={styles.note} data-testid="voice-note">
                  {message.note}
                </p>
              ) : null}
              {message.role === "assistant" && message.audioSequence?.length && !message.pending ? (
                <button
                  type="button"
                  className={styles.replay}
                  data-testid="voice-replay"
                  disabled={muted}
                  aria-label={`Replay assistant message ${message.id}`}
                  title="Replay answer"
                  onClick={() => void handleReplay(message.audioSequence!)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z" /></svg>
                </button>
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
          <button type="button" className={styles.voiceToggle} data-testid="voice-toggle"
            aria-pressed={canMuteVoice} aria-label={canMuteVoice ? "Mute voice" : "Enable live voice"}
            title={canMuteVoice ? "Mute voice (microphone and audio)" : "Enable live voice (microphone and audio)"}
            onClick={handleVoiceToggle}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M11 5 6 9H3v6h3l5 4z" />
              {!canMuteVoice ? <path d="m16 9 5 6m0-6-5 6" /> : <path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />}
            </svg>
          </button>
          <input
            className={styles.input}
            data-testid="voice-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Type a question…"
            aria-label="Type a question"
          />
          <button type="submit" className={styles.send} disabled={!input.trim()} aria-label="Send" title="Send question">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 17 8-17 8 3-8zm3 8h14" /></svg>
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
        aria-label={open ? "Close voice assistant" : `Open voice assistant (microphone and audio). ${audioCacheText}`}
        title={
          !open
            ? `Open voice assistant (microphone and audio). ${audioCacheText}`
            : loading
              ? `Loading ${voiceMode === "live" && states.stt === "loading" ? "speech recognition" : "matching model"} · ${formatPercent(ringProgress)}`
              : audioCacheText
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
          <span className={styles.progressBadge}>{formatPercent(ringProgress)}</span>
        ) : !open && audioCacheProgress.state === "downloading" ? (
          <span className={styles.progressBadge} aria-label={`${audioCacheProgress.verifiedClips} of ${audioCacheProgress.totalClips} audio clips cached`}>
            {audioCacheProgress.verifiedClips}/{audioCacheProgress.totalClips}
          </span>
        ) : null}
      </button>
    </div>
  );
}
