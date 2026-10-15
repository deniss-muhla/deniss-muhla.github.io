/**
 * Voice-assistant QA harness (Playwright).
 *
 * Voice workload blocked before launch pending live-on-open maintenance (see guard below).
 * The retained footer-consent workload previously launched headed Chrome and verified:
 *   1. cross-origin isolation after service-worker registration,
 *   2. the closed-panel consent choices and on-demand model loading,
 *   3. the greeting (silent in typed-only mode; played only after live-voice consent),
 *   4. optionally, a full voice turn from an explicitly requested fake microphone WAV,
 *   5. a typed answer through the retrieval path (silent in typed mode, with an explicit
 *      stored-plan Replay check; resolving clarification when offered and failing on a notice/error),
 *   6. an offline reload served from cache with the models still usable,
 *   7. the metered lifecycle: data saving reported before the explicit open, on-demand
 *      loading only after it, and a typed question while the models load,
 *   8. typed and spoken parity when a fake microphone supplies the spoken question:
 *      same answer, same cleanup, same spoken output,
 *   9. resize, scrolling and exit with the chat open (the headed checks 6.2 deferred).
 * Every added check logs booleans and fixed labels only, never message text.
 *
 * Usage (production build served without COOP/COEP headers, like GitHub Pages):
 *
 *   pnpm build
 *   node scripts/serve-dist.mjs dist 4174 &     # any static server without headers
 *   node scripts/voice-qa.mjs
 *   node scripts/voice-qa.mjs --redacted
 *
 * The embedding retrieval workload runs through the same entry point:
 *
 *   node scripts/voice-qa.mjs --qa=retrieval [--routing=dev|built]
 *
 * With a fake microphone (Chrome plays the WAV as a live capture device):
 *
 *   VOICE_WAV=/tmp/generated-neutral.wav node scripts/voice-qa.mjs
 *
 * Environment: BASE_URL, MODELS_TIMEOUT_MS, VOICE_WAV, HEADLESS, CHROME_CHANNEL.
 * A fake WAV selects the live UI choice; Playwright's microphone permission is fixture setup,
 * separate from the app's explicit consent button. A default run stays typed-only and grants no mic permission.
 * Ordinary QA screenshots are written to /tmp/voice-qa-*.png; the browser is always closed.
 *
 * Note: use a static server that sends no COOP/COEP headers; the service worker
 * is expected to add them. `http://localhost` is a secure context.
 */
import { chromium } from "playwright-core";
import {
  qaCompletedVoiceTurnSince,
  qaFiniteFakeAudioCaptureArg,
  qaMatchLabel,
  qaMeteredPhase,
  qaNoteKind,
  qaOfflineReloadSucceeded,
  qaTurnSpeech,
  qaEntryTerminalLine,
  qaTypedOutcome,
  qaVoiceConsentChoice,
  selectQaMode,
} from "./voice-qa-checks.ts";
import { logQaContent, logQaError, qaUrl, takeQaScreenshot } from "./voice-qa-privacy.ts";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4174/?sw=1";
const REDACTED = process.argv.includes("--redacted");
const MODELS_TIMEOUT_MS = Number(process.env.MODELS_TIMEOUT_MS ?? 900_000);
const VOICE_WAV = process.env.VOICE_WAV;
const HEADLESS = process.env.HEADLESS === "true";
const CHROME_CHANNEL = process.env.CHROME_CHANNEL ?? "chrome";
const CONSENT_CHOICE = qaVoiceConsentChoice(Boolean(VOICE_WAV));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(500);
  }
}

const qaMode = selectQaMode(process.argv.slice(2));

// The harness owns its browser at module scope so an interrupted run closes it through the
// same path as a normal exit instead of leaving Chrome behind. SIGTERM exits with 128+15.
let ownedBrowser;

async function closeOwnedBrowser(onError = () => {}) {
  if (!ownedBrowser) return;
  const closing = ownedBrowser;
  ownedBrowser = undefined;
  await closing.close().catch(onError);
}

process.on("SIGTERM", async () => {
  await closeOwnedBrowser();
  process.exit(143);
});

if (qaMode === "retrieval") {
  // The retrieval workload opens its own browser and server, so the voice path does not
  // load them: `--qa=retrieval` reaches it and every command without the argument stays
  // the voice run below.
  const { runRetrievalQa } = await import("./retrieval-qa.mjs");
  await runRetrievalQa();
} else {
  // Preserve the old workload for a separately approved live-on-open harness update.
  console.error("[qa] Voice QA is blocked: update the live-on-open consent, typed and Replay workload before running it. Use owner-started pnpm dev and docs/manual-testing.md for interaction testing.");
  process.exit(1);
  try {
    ownedBrowser = await chromium.launch({
      channel: CHROME_CHANNEL,
      headless: HEADLESS,
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--use-fake-device-for-media-stream",
        ...(VOICE_WAV ? [qaFiniteFakeAudioCaptureArg(VOICE_WAV)] : []),
      ],
    });

    const QA_URL = qaUrl(BASE_URL, REDACTED);
    const context = await ownedBrowser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const audioRequestCounts = { manifests: 0, hashedClips: 0 };
    page.on("request", (request) => {
      let pathname;
      try {
        pathname = new URL(request.url()).pathname;
      } catch {
        return;
      }
      if (pathname === "/audio/assistant/manifest.json") audioRequestCounts.manifests += 1;
      else if (/^\/audio\/assistant\/[a-z0-9-]+-[a-f0-9]{64}\.mp3$/.test(pathname)) {
        audioRequestCounts.hashedClips += 1;
      }
    });
    page.on("console", (message) => {
      if (REDACTED) {
        if (message.type() === "error") console.log("[console:error] (content redacted)");
        return;
      }
      if (message.type() === "error") console.log(`[console:error] ${message.text()}`);
    });
    page.on("pageerror", (error) => {
      if (REDACTED) {
        console.log("[pageerror] (content redacted)");
        return;
      }
      console.log("[pageerror]", error.message);
    });

    const messagesOf = (targetPage) =>
      targetPage.evaluate(() =>
        [...document.querySelectorAll('[data-testid="voice-messages"] > p')].map((node) => ({
          text: node.textContent?.trim() ?? "",
          pending: node.hasAttribute("data-pending"),
          assistant: node.className.includes("assistant"),
          user: node.className.includes("user"),
        })),
      );
    const messages = () => messagesOf(page);

    /** The newest assistant reply after one question, with the status line's error state. */
    const replyState = (targetPage, question) =>
      targetPage.evaluate((q) => {
        const nodes = [...document.querySelectorAll('[data-testid="voice-messages"] > p')];
        const userIndex = nodes.findIndex(
          (node) => node.className.includes("user") && node.textContent?.trim() === q,
        );
        const after = userIndex === -1 ? [] : nodes.slice(userIndex + 1);
        const reply = [...after].reverse().find((node) => node.className.includes("assistant"));
        return {
          text: reply?.textContent?.trim() ?? "",
          pending: reply?.hasAttribute("data-pending") ?? true,
          error:
            document.querySelector('[data-testid="voice-status"]')?.getAttribute("data-state") === "error",
        };
      }, question);

    /** Waits until the shipped reply for a typed question is anything but pending. */
    const waitForOutcome = async (targetPage, question, timeoutMs, label) => {
      const start = Date.now();
      for (;;) {
        const state = await replyState(targetPage, question).catch(() => ({
          text: "",
          pending: true,
          error: false,
        }));
        const outcome = qaTypedOutcome(state);
        if (outcome !== "pending") return { outcome, state };
        if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
        await sleep(500);
      }
    };

    /** Selects one offered choice and waits for the prepared answer, with no new question. */
    const resolveChoice = async (targetPage, assistantBaseline, timeoutMs) => {
      const start = Date.now();
      for (;;) {
        const snapshot = await targetPage.evaluate(() => {
          const nodes = [...document.querySelectorAll('[data-testid="voice-messages"] > p')];
          const assistants = nodes.filter((node) => node.className.includes("assistant"));
          const reply = assistants[assistants.length - 1];
          return {
            count: assistants.length,
            text: reply?.textContent?.trim() ?? "",
            pending: reply?.hasAttribute("data-pending") ?? true,
            error:
              document.querySelector('[data-testid="voice-status"]')?.getAttribute("data-state") === "error",
          };
        });
        if (snapshot.count > assistantBaseline && !snapshot.pending) {
          const outcome = qaTypedOutcome(snapshot);
          if (outcome === "answer") return snapshot.text;
          if (outcome !== "pending") throw new Error(`choice-outcome:${outcome}`);
        }
        if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for choice answer");
        await sleep(300);
      }
    };

    /** The recorded turn timeline; empty when no fake microphone runs. */
    const timeline = () => page.evaluate(() => window.__qaTimeline ?? []);

    const statusState = () =>
      page.evaluate(
        () => document.querySelector('[data-testid="voice-status"]')?.getAttribute("data-state") ?? null,
      );

    /** The kind of the first rendered note beside an answer, or `undefined` for none. */
    const noteKindNow = async () => {
      const notes = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="voice-note"]')].map(
          (node) => node.textContent?.trim() ?? "",
        ),
      );
      if (notes.length === 0) return undefined;
      const kind = qaNoteKind(notes[0]);
      if (kind === undefined) throw new Error("unknown-note-kind");
      return kind;
    };

    /** Content-free cleanup snapshot after one turn: flags and counts only. */
    const cleanupState = () =>
      page.evaluate(() => {
        const nodes = [...document.querySelectorAll('[data-testid="voice-messages"] > p')];
        return {
          pending: nodes.filter((node) => node.hasAttribute("data-pending")).length,
          choices: document.querySelectorAll('[data-testid="voice-choice"]').length,
          retry: document.querySelector('[data-testid="voice-retry"]') === null ? 0 : 1,
          inputEmpty: document.querySelector('[data-testid="voice-input"]')?.value === "",
          state:
            document.querySelector('[data-testid="voice-status"]')?.getAttribute("data-state") ?? null,
          speechFailed: nodes.some((node) =>
            (node.textContent ?? "").startsWith("Speech output failed"),
          ),
        };
      });

    /** Live turns settle to listening; silent typed turns settle to idle. */
    const waitForTurnSettled = (label) =>
      waitFor(async () => ["listening", "idle"].includes(await statusState()), 60_000, label);

    /** The reply to the newest user message with this text, only once a new assistant message exists. */
    const parityReplyState = (targetPage, question, assistantBaseline) =>
      targetPage.evaluate(
        ({ q, baseline }) => {
          const nodes = [...document.querySelectorAll('[data-testid="voice-messages"] > p')];
          let userIndex = -1;
          nodes.forEach((node, index) => {
            if (node.className.includes("user") && node.textContent?.trim() === q) userIndex = index;
          });
          const after = userIndex === -1 ? [] : nodes.slice(userIndex + 1);
          const assistants = after.filter((node) => node.className.includes("assistant"));
          const total = nodes.filter((node) => node.className.includes("assistant")).length;
          const reply = assistants[assistants.length - 1];
          return {
            text: reply?.textContent?.trim() ?? "",
            pending: total <= baseline || (reply?.hasAttribute("data-pending") ?? true),
            error:
              document.querySelector('[data-testid="voice-status"]')?.getAttribute("data-state") ===
              "error",
          };
        },
        { q: question, baseline: assistantBaseline },
      );

    /** Waits for a typed question that repeats an earlier one: only its own reply counts. */
    const waitForNewOutcome = async (targetPage, question, assistantBaseline, timeoutMs, label) => {
      const start = Date.now();
      for (;;) {
        const state = await parityReplyState(targetPage, question, assistantBaseline).catch(() => ({
          text: "",
          pending: true,
          error: false,
        }));
        const outcome = qaTypedOutcome(state);
        if (outcome !== "pending") return { outcome, state };
        if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
        await sleep(500);
      }
    };

    /** Panel and input geometry after a viewport change; booleans only. */
    const layoutState = () =>
      page.evaluate(() => {
        const panel = document.querySelector('[role="dialog"]');
        const input = document.querySelector('[data-testid="voice-input"]');
        const rect = panel.getBoundingClientRect();
        const inputRect = input.getBoundingClientRect();
        return {
          panelInViewport:
            rect.left >= 0 &&
            rect.top >= 0 &&
            rect.right <= window.innerWidth &&
            rect.bottom <= window.innerHeight,
          inputInViewport:
            inputRect.width > 0 &&
            inputRect.left >= 0 &&
            inputRect.right <= window.innerWidth &&
            inputRect.bottom <= window.innerHeight,
          panelShown: Number.parseFloat(getComputedStyle(panel).opacity) >= 0.99,
          documentFits: document.documentElement.scrollWidth <= window.innerWidth,
        };
      });

    const closedState = () =>
      page.evaluate(() => ({
        panelHidden: document.querySelector('[role="dialog"]')?.getAttribute("aria-hidden") === "true",
        fabClosed:
          document.querySelector('[data-testid="voice-fab"]')?.getAttribute("aria-expanded") ===
          "false",
      }));

    if (REDACTED) console.log("[qa] opening URL (redacted)");
    else console.log(`[qa] opening ${QA_URL}`);
    await page.goto(QA_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitFor(() => page.evaluate(() => window.crossOriginIsolated === true), 30_000, "isolation");
    console.log(
      "[qa] capabilities:",
      JSON.stringify(
        await page.evaluate(async () => {
          return {
            isolated: self.crossOriginIsolated,
            serviceWorker: !!navigator.serviceWorker.controller,
          };
        }),
      ),
    );

    if (VOICE_WAV) {
      // Content-free turn timeline for the voice and parity checks: status states,
      // the user-message count and the speech-failure flag, never message text.
      await page.evaluate(() => {
        const events = [];
        window.__qaTimeline = events;
        const record = () => {
          const status = document.querySelector('[data-testid="voice-status"]');
          const nodes = [...document.querySelectorAll('[data-testid="voice-messages"] > p')];
          events.push({
            t: Date.now(),
            state: status?.getAttribute("data-state") ?? null,
            users: nodes.filter((node) => node.className.includes("user")).length,
            speechFailed: nodes.some((node) =>
              (node.textContent ?? "").startsWith("Speech output failed"),
            ),
          });
        };
        record();
        new MutationObserver(record).observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["data-state", "data-pending"],
        });
      });
    }

    const closedStateBeforeChoice = await page.evaluate(() => ({
      open: document.querySelector('[data-testid="voice-fab"]')?.getAttribute("aria-expanded") === "true",
    }));
    if (closedStateBeforeChoice.open) throw new Error("panel-open-before-choice");
    if (audioRequestCounts.manifests !== 0 || audioRequestCounts.hashedClips !== 0) {
      throw new Error("audio-request-before-choice");
    }
    await takeQaScreenshot(page, "/tmp/voice-qa-01-closed.png", REDACTED);

    // Opening enables silent typing. The browser permission grant below is fixture
    // setup for the WAV; the app starts audio/STT only after the footer voice action.
    const microphoneBaseline = CONSENT_CHOICE === "live" ? (await messages()).length : 0;
    await page.getByTestId("voice-fab").click();
    await page.getByTestId("voice-toggle").waitFor({ state: "visible", timeout: 15_000 });
    await page.getByTestId("voice-input").waitFor({ state: "visible", timeout: 15_000 });
    if (CONSENT_CHOICE === "live") {
      await context.grantPermissions(["microphone"], { origin: new URL(QA_URL).origin });
      await page.getByTestId("voice-toggle").click();
    }
    await waitFor(async () => (await messages()).some((m) => m.assistant), 30_000, "greeting");
    await sleep(250);
    if (CONSENT_CHOICE === "live") {
      await waitFor(
        () => audioRequestCounts.manifests > 0 && audioRequestCounts.hashedClips > 0,
        45_000,
        "consented-greeting-audio",
      );
    } else if (audioRequestCounts.manifests !== 0 || audioRequestCounts.hashedClips !== 0) {
      throw new Error("typed-greeting-not-silent");
    }
    logQaContent(REDACTED, console.log, "[qa] greeting:", JSON.stringify((await messages()).find((m) => m.assistant)?.text));
    await takeQaScreenshot(page, "/tmp/voice-qa-02-greeting.png", REDACTED);

    if (VOICE_WAV) {
      console.log("[qa] waiting for a voice turn from the fake microphone…");
      const voiceTurn = await waitFor(
        async () => qaCompletedVoiceTurnSince(await messages(), microphoneBaseline),
        180_000,
        "voice turn",
      );
      if (REDACTED) {
        console.log("[qa] voice turn completed");
      } else {
        console.log("[qa] voice turn:", JSON.stringify(voiceTurn));
      }
      await takeQaScreenshot(page, "/tmp/voice-qa-03-voice.png", REDACTED);

      // Evidence for recognition -> selection -> speech, all content-free: the outcome
      // class the shipped chat rendered, the note that pins the matching label, the
      // recorded speaking states, and the cleanup snapshot parity repeats later.
      const voiceSpeechStart = (await timeline()).find((event) => event.users >= 1)?.t ?? Date.now();
      let spokenOutcome = qaTypedOutcome({
        text: voiceTurn.answered,
        pending: false,
        error: (await statusState()) === "error",
      });
      let spokenFinal = voiceTurn.answered;
      if (spokenOutcome === "clarify") {
        const before = await messages();
        const assistantBaseline = before.filter((message) => message.assistant).length;
        await page.getByTestId("voice-choice").first().click();
        spokenFinal = await resolveChoice(page, assistantBaseline, 60_000);
        spokenOutcome = "answer";
      }
      if (spokenOutcome !== "answer") throw new Error(`voice-turn-outcome:${spokenOutcome}`);
      await waitForTurnSettled("voice-turn-settled");
      const spokenNote = await noteKindNow();
      const spokenSpeech = qaTurnSpeech(await timeline(), voiceSpeechStart, Date.now());
      const spokenCleanup = await cleanupState();
      if (spokenSpeech.speechFailed) throw new Error("voice-turn-speech-failed");
      if (!spokenSpeech.spoke || !spokenSpeech.settledListening) {
        throw new Error("voice-turn-speech-missing");
      }
      console.log(
        "[qa] voice turn evidence:",
        JSON.stringify({
          outcome: spokenOutcome,
          note: spokenNote ?? "none",
          match: qaMatchLabel(spokenNote),
          spoke: spokenSpeech.spoke,
          cleanup: spokenCleanup,
        }),
      );

      // Typed and spoken parity through the shared path: type exactly what the
      // microphone produced and require the same outcome, answer, cleanup and speech.
      const parityBaseline = (await messages()).filter((message) => message.assistant).length;
      const parityStart = Date.now();
      await page.getByTestId("voice-input").fill(voiceTurn.heard);
      await page.getByRole("button", { name: "Send" }).click();
      const parityTyped = await waitForNewOutcome(
        page,
        voiceTurn.heard,
        parityBaseline,
        240_000,
        "parity outcome",
      );
      let parityOutcome = parityTyped.outcome;
      let parityFinal = parityTyped.state.text;
      if (parityOutcome === "clarify") {
        const before = await messages();
        const assistantBaseline = before.filter((message) => message.assistant).length;
        await page.getByTestId("voice-choice").first().click();
        parityFinal = await resolveChoice(page, assistantBaseline, 60_000);
        parityOutcome = "answer";
      }
      await waitForTurnSettled("parity-settled");
      const paritySpeech = qaTurnSpeech(await timeline(), parityStart, Date.now());
      const parityCleanup = await cleanupState();
      const parity = {
        sameOutcome: parityOutcome === spokenOutcome,
        sameAnswer: parityFinal === spokenFinal,
        sameCleanup: JSON.stringify(parityCleanup) === JSON.stringify(spokenCleanup),
        spoke: paritySpeech.spoke && !paritySpeech.speechFailed && paritySpeech.settledListening,
      };
      console.log("[qa] parity:", JSON.stringify(parity));
      if (!parity.sameOutcome) throw new Error("parity-outcome-mismatch");
      if (!parity.sameAnswer) throw new Error("parity-answer-mismatch");
      if (!parity.sameCleanup) throw new Error("parity-cleanup-mismatch");
      if (!parity.spoke) throw new Error("parity-speech-missing");
    }

    // A known covered question exercises the typed path; no fixture file is read.
    if (CONSENT_CHOICE === "live") {
      await page.getByRole("button", { name: "Close chat", exact: true }).click();
      await page.getByTestId("voice-fab").click();
    }
    const question = "what was the first employer";
    const typedAudioBaseline = { ...audioRequestCounts };
    await page.getByTestId("voice-input").fill(question);
    await page.getByRole("button", { name: "Send" }).click();
    const typed = await waitForOutcome(page, question, 240_000, "typed outcome");
    console.log("[qa] typed outcome:", typed.outcome);
    if (typed.outcome === "clarify") {
      const before = await messages();
      const assistantBaseline = before.filter((message) => message.assistant).length;
      await page.getByTestId("voice-choice").first().click();
      const answer = await resolveChoice(page, assistantBaseline, 60_000);
      const usersAfter = (await messages()).filter((message) => message.user).length;
      if (usersAfter !== before.filter((message) => message.user).length) {
        throw new Error("choice-added-a-question");
      }
      logQaContent(REDACTED, console.log, "[qa] answer:", JSON.stringify(answer));
    } else if (typed.outcome === "answer") {
      logQaContent(REDACTED, console.log, "[qa] answer:", JSON.stringify(typed.state.text));
    } else {
      // A notice or an error means the required typed answer never arrived.
      throw new Error(`typed-outcome:${typed.outcome}`);
    }
    await waitForTurnSettled("typed-answer-silent-settled");
    if (audioRequestCounts.manifests !== typedAudioBaseline.manifests || audioRequestCounts.hashedClips !== typedAudioBaseline.hashedClips) {
      throw new Error("typed-answer-played-before-replay");
    }
    await page.getByTestId("voice-replay").last().click();
    await waitForTurnSettled("typed-stored-plan-replay-settled");
    if (audioRequestCounts.hashedClips <= typedAudioBaseline.hashedClips) {
      throw new Error("typed-stored-plan-replay-missing");
    }
    if (REDACTED) console.log("[qa] typed answer stayed silent until explicit stored-plan Replay");
    await takeQaScreenshot(page, "/tmp/voice-qa-04-answer.png", REDACTED);

    const noteTexts = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="voice-note"]')].map((node) => node.textContent?.trim() ?? ""),
    );
    const noteKinds = noteTexts.map((text) => qaNoteKind(text));
    if (noteKinds.some((kind) => kind === undefined)) throw new Error("unknown-note-kind");
    console.log("[qa] note kinds:", JSON.stringify(noteKinds));

    // The headed checks 6.2 deferred: resize, scrolling and exit with the chat open.
    console.log("[qa] ui: resize with the chat open");
    await page.setViewportSize({ width: 414, height: 800 });
    const resizeSmall = await layoutState();
    await page.setViewportSize({ width: 1280, height: 900 });
    const resizeRestored = await layoutState();
    const resize = {
      small: resizeSmall.panelInViewport && resizeSmall.inputInViewport && resizeSmall.panelShown,
      restored:
        resizeRestored.panelInViewport && resizeRestored.inputInViewport && resizeRestored.panelShown,
      documentFits: resizeSmall.documentFits && resizeRestored.documentFits,
    };
    console.log("[qa] ui resize:", JSON.stringify(resize));
    if (!resize.small || !resize.restored) throw new Error("resize-check-failed");

    console.log("[qa] ui: scrolling with the chat open");
    const scroll = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="voice-messages"]');
      const max = list.scrollHeight - list.clientHeight;
      const auto = list.scrollTop;
      list.scrollTo({ top: list.scrollHeight, behavior: "instant" });
      return {
        scrollable: max > 0,
        autoNearBottom: max <= 0 || auto >= max - 40,
        reachedEnd: max <= 0 || list.scrollTop >= max - 1,
      };
    });
    console.log("[qa] ui scroll:", JSON.stringify(scroll));
    if (!scroll.scrollable) throw new Error("messages-not-scrollable");
    if (!scroll.reachedEnd) throw new Error("scroll-check-failed");

    console.log("[qa] ui: exit with the chat open");
    const beforeExit = (await messages()).length;
    await page.getByRole("button", { name: "Close chat" }).click();
    const exitStart = Date.now();
    for (;;) {
      const closed = await closedState();
      if (closed.panelHidden && closed.fabClosed) break;
      if (Date.now() - exitStart > 15_000) throw new Error("exit-check-timeout");
      await sleep(300);
    }
    // The fake microphone may still be playing; a closed panel must stop listening.
    await sleep(2500);
    const exit = await page.evaluate(
      (baseline) => ({
        panelHidden: document.querySelector('[role="dialog"]')?.getAttribute("aria-hidden") === "true",
        fabClosed:
          document.querySelector('[data-testid="voice-fab"]')?.getAttribute("aria-expanded") ===
          "false",
        consentReset:
          document.querySelector('[data-testid="voice-toggle"]')?.getAttribute("aria-label") === "Enable live voice" &&
          !!document.querySelector('[data-testid="voice-input"]'),
        idle:
          document.querySelector('[data-testid="voice-status"]')?.getAttribute("data-state") === "idle",
        noNewMessages:
          document.querySelectorAll('[data-testid="voice-messages"] > p').length === baseline,
      }),
      beforeExit,
    );
    console.log("[qa] ui exit:", JSON.stringify(exit));
    if (!exit.panelHidden || !exit.fabClosed || !exit.consentReset || !exit.idle || !exit.noNewMessages) {
      throw new Error("exit-check-failed");
    }

    console.log("[qa] going offline and reloading");
    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(6000);
    const offlineState = await page.evaluate(() => ({
      online: navigator.onLine,
      isolated: self.crossOriginIsolated,
      badge: document.querySelector('[role="status"]')?.textContent?.trim() ?? null,
      status: document.querySelector('[data-testid="voice-status"]')?.textContent?.trim() ?? null,
    }));
    if (REDACTED) {
      console.log("[qa] offline:", JSON.stringify({
        online: offlineState.online,
        isolated: offlineState.isolated,
        hasBadge: offlineState.badge !== null,
      }));
    } else {
      console.log("[qa] offline:", JSON.stringify(offlineState));
    }
    if (!qaOfflineReloadSucceeded({
      online: offlineState.online,
      isolated: offlineState.isolated,
      hasBadge: offlineState.badge !== null,
    })) {
      throw new Error("offline-reload-failed");
    }
    await takeQaScreenshot(page, "/tmp/voice-qa-05-offline.png", REDACTED);

    const offlineAssistantBaseline = (await messages()).filter((message) => message.assistant).length;
    const offlineClipBaseline = audioRequestCounts.hashedClips;
    await page.getByTestId("voice-fab").click();
    await page.getByTestId("voice-input").waitFor({ state: "visible", timeout: 15_000 });
    await page.getByTestId("voice-input").fill(question);
    await page.getByRole("button", { name: "Send" }).click();
    const offlineOutcome = await waitForNewOutcome(
      page,
      question,
      offlineAssistantBaseline,
      240_000,
      "offline typed outcome",
    );
    if (offlineOutcome.outcome === "clarify") {
      const choiceBaseline = (await messages()).filter((message) => message.assistant).length;
      await page.getByTestId("voice-choice").first().click();
      await resolveChoice(page, choiceBaseline, 60_000);
    } else if (offlineOutcome.outcome !== "answer") {
      throw new Error(`offline-typed-${offlineOutcome.outcome}`);
    }
    await waitForTurnSettled("offline-typed-silent-settled");
    if (audioRequestCounts.hashedClips !== offlineClipBaseline) {
      throw new Error("offline-typed-answer-played-before-replay");
    }
    await page.getByTestId("voice-replay").last().click();
    await waitForTurnSettled("offline-stored-plan-replay-settled");
    const offlineCleanup = await cleanupState();
    if (offlineCleanup.speechFailed || audioRequestCounts.hashedClips <= offlineClipBaseline) {
      throw new Error("offline-stored-plan-replay-missing");
    }
    if (REDACTED) console.log("[qa] cached typed answer audio played only after explicit Replay");

    await context.setOffline(false);

    // Metered lifecycle, in a second page of this context: the init script reports data
    // saving, so no model request may happen before the explicit open, the typed question
    // must work while the models load, and readiness is read with the panel closed. The
    // models from the run above sit in this context's cache, so the walk reuses them.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "connection", {
        configurable: true,
        value: { saveData: true, effectiveType: "4g", downlink: 10, rtt: 50 },
      });
    });
    const meteredPage = await context.newPage();
    const meteredObservation = async (overrides) => {
      const observed = await meteredPage.evaluate(() => ({
        saveData: navigator.connection?.saveData === true,
        statusText:
          document.querySelector('[role="status"]')?.textContent?.trim() ??
          document.querySelector('[data-testid="voice-status"]')?.textContent?.trim() ?? "",
        loading: document.querySelector('[data-testid="voice-fab"]')?.hasAttribute("data-loading") ?? false,
        loadingSeen: window.__meteredLoadingSeen === true,
      }));
      return { ...observed, opened: false, sent: false, answered: false, ...overrides };
    };

    console.log("[qa] metered phase: starting");
    await meteredPage.goto(QA_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitFor(
      () => meteredPage.evaluate(() => window.crossOriginIsolated === true),
      30_000,
      "metered isolation",
    );

    let meteredPhase = qaMeteredPhase(undefined, await meteredObservation({}));
    console.log(`[qa] metered phase: ${meteredPhase}`);

    const preOpen = await waitFor(async () => {
      const observation = await meteredObservation({});
      return observation.statusText.startsWith("Data saving") && !observation.loading
        ? observation
        : undefined;
    }, 120_000, "metered pre-open notice");
    meteredPhase = qaMeteredPhase(meteredPhase, preOpen);
    console.log(`[qa] metered phase: ${meteredPhase}`);

    // Watch the button itself: loading is a real state change, never guessed from time.
    await meteredPage.evaluate(() => {
      const fab = document.querySelector('[data-testid="voice-fab"]');
      window.__meteredLoadingSeen = fab?.hasAttribute("data-loading") ?? false;
      if (fab && !window.__meteredLoadingSeen) {
        new MutationObserver((_mutations, observer) => {
          if (fab.hasAttribute("data-loading")) {
            window.__meteredLoadingSeen = true;
            observer.disconnect();
          }
        }).observe(fab, { attributes: true, attributeFilter: ["data-loading"] });
      }
    });

    await meteredPage.getByTestId("voice-fab").click();
    meteredPhase = qaMeteredPhase(meteredPhase, await meteredObservation({ opened: true }));
    console.log(`[qa] metered phase: ${meteredPhase}`);

    await waitFor(
      () => meteredPage.evaluate(() => window.__meteredLoadingSeen === true),
      MODELS_TIMEOUT_MS,
      "metered on-demand loading",
    );
    meteredPhase = qaMeteredPhase(meteredPhase, await meteredObservation({ opened: true }));
    console.log(`[qa] metered phase: ${meteredPhase}`);

    await meteredPage.getByTestId("voice-input").fill(question);
    await meteredPage.getByRole("button", { name: "Send" }).click();
    meteredPhase = qaMeteredPhase(meteredPhase, await meteredObservation({ opened: true, sent: true }));
    console.log(`[qa] metered phase: ${meteredPhase}`);

    const meteredTyped = await waitForOutcome(
      meteredPage,
      question,
      MODELS_TIMEOUT_MS,
      "metered typed outcome",
    );
    if (meteredTyped.outcome === "clarify") {
      const baseline = (await messagesOf(meteredPage)).filter((message) => message.assistant).length;
      await meteredPage.getByTestId("voice-choice").first().click();
      await resolveChoice(meteredPage, baseline, 60_000);
    } else if (meteredTyped.outcome !== "answer") {
      throw new Error(`metered-outcome:${meteredTyped.outcome}`);
    }
    await waitForTurnSettled("metered-silent-answer-settled");
    console.log("[qa] metered outcome: answer");
    meteredPhase = qaMeteredPhase(
      meteredPhase,
      await meteredObservation({ opened: true, sent: true, answered: true }),
    );
    console.log(`[qa] metered phase: ${meteredPhase}`);

    const typedReady = await meteredPage.evaluate(() =>
      !document.querySelector('[data-testid="voice-fab"]')?.hasAttribute("data-loading") &&
      document.querySelector('[data-testid="voice-status"]')?.getAttribute("data-state") === "idle",
    );
    if (!typedReady) throw new Error("metered-typed-route-not-settled");
    await meteredPage.getByRole("button", { name: "Close chat" }).click();
    console.log("[qa] metered typed route settled without waiting for STT readiness");
  } catch (error) {
    logQaError(error, REDACTED, console.error);
    process.exitCode = 1;
  } finally {
    await closeOwnedBrowser((error) => {
      logQaError(error, REDACTED, console.error);
      process.exitCode = 1;
    });
  }
}

// One run, one terminal line: the retrieval workload already reported its own outcome.
const terminalLine = qaEntryTerminalLine(qaMode, process.exitCode);
if (terminalLine) console.log(terminalLine);
