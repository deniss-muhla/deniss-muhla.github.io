/**
 * Voice-assistant QA harness (Playwright).
 *
 * Launches its own headed Chrome instance, then verifies:
 *   1. cross-origin isolation after service-worker registration,
 *   2. background model prefetch progress and the one-shot "ready" blink,
 *   3. the greeting,
 *   4. optionally, a full voice turn from a fake microphone WAV,
 *   5. a streamed text answer,
 *   6. an offline reload served from cache with the models still usable.
 *
 * Usage (production build served without COOP/COEP headers, like GitHub Pages):
 *
 *   pnpm build
 *   node scripts/serve-dist.mjs dist 4174 &     # any static server without headers
 *   node scripts/voice-qa.mjs
 *   node scripts/voice-qa.mjs --redacted
 *
 * With a fake microphone (Chrome plays the WAV as a live capture device):
 *
 *   VOICE_WAV=/tmp/question.wav node scripts/voice-qa.mjs
 *
 * Environment: BASE_URL, MODELS_TIMEOUT_MS, VOICE_WAV, HEADLESS, CHROME_CHANNEL.
 * Ordinary QA screenshots are written to /tmp/voice-qa-*.png; the browser is always closed.
 *
 * Note: use a static server that sends no COOP/COEP headers; the service worker
 * is expected to add them. `http://localhost` is a secure context.
 */
import { chromium } from "playwright-core";
import {
  qaCompletedVoiceTurnSince,
  qaModelsReady,
  qaOfflineReloadSucceeded,
} from "./voice-qa-checks.ts";
import { logQaContent, logQaError, qaUrl, takeQaScreenshot } from "./voice-qa-privacy.ts";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4174/?sw=1";
const REDACTED = process.argv.includes("--redacted");
const MODELS_TIMEOUT_MS = Number(process.env.MODELS_TIMEOUT_MS ?? 900_000);
const VOICE_WAV = process.env.VOICE_WAV;
const HEADLESS = process.env.HEADLESS === "true";
const CHROME_CHANNEL = process.env.CHROME_CHANNEL ?? "chrome";

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

let browser;
try {
  browser = await chromium.launch({
    channel: CHROME_CHANNEL,
    headless: HEADLESS,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-device-for-media-stream",
      ...(VOICE_WAV ? [`--use-file-for-fake-audio-capture=${VOICE_WAV}`] : []),
    ],
  });

  const QA_URL = qaUrl(BASE_URL, REDACTED);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ...(REDACTED && !VOICE_WAV ? {} : { permissions: ["microphone"] }),
  });
  const page = await context.newPage();
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

  const status = () =>
    page.evaluate(() => document.querySelector('[data-testid="voice-status"]')?.textContent?.trim() ?? "");
  const messages = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="voice-messages"] > p')].map((node) => ({
        text: node.textContent?.trim() ?? "",
        pending: node.hasAttribute("data-pending"),
        assistant: node.className.includes("assistant"),
        user: node.className.includes("user"),
      })),
    );

  if (REDACTED) console.log("[qa] opening URL (redacted)");
  else console.log(`[qa] opening ${QA_URL}`);
  await page.goto(QA_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitFor(() => page.evaluate(() => window.crossOriginIsolated === true), 30_000, "isolation");
  console.log(
    "[qa] capabilities:",
    JSON.stringify(
      await page.evaluate(async () => {
        const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
        return {
          isolated: self.crossOriginIsolated,
          serviceWorker: !!navigator.serviceWorker.controller,
          webGpu: !!adapter,
          shaderF16: adapter ? adapter.features.has("shader-f16") : false,
        };
      }),
    ),
  );

  const prefetchStart = Date.now();
  let lastStatus = "";
  let sawBlink = false;
  while (Date.now() - prefetchStart < MODELS_TIMEOUT_MS) {
    const state = await page.evaluate(() => {
      const fab = document.querySelector('[data-testid="voice-fab"]');
      return {
        loading: fab?.hasAttribute("data-loading") ?? false,
        blink: fab?.hasAttribute("data-blink") ?? false,
        status: document.querySelector('[data-testid="voice-status"]')?.textContent?.trim() ?? "",
      };
    });
    if (state.status !== lastStatus) {
      const elapsed = ((Date.now() - prefetchStart) / 1000).toFixed(0);
      if (REDACTED) console.log(`[qa] ${elapsed}s readiness status changed`);
      else console.log(`[qa] ${elapsed}s ${state.status}`);
      lastStatus = state.status;
    }
    sawBlink ||= state.blink;
    if (!state.loading && state.status.startsWith("Ready")) break;
    await sleep(1500);
  }
  console.log(`[qa] prefetch finished in ${((Date.now() - prefetchStart) / 1000).toFixed(0)}s; blink=${sawBlink}`);
  await takeQaScreenshot(page, "/tmp/voice-qa-01-ready.png", REDACTED);

  // Opening the panel starts capture; snapshot before it, and run typed QA afterward.
  const microphoneBaseline = VOICE_WAV ? (await messages()).length : 0;
  await page.getByTestId("voice-fab").click();
  await waitFor(async () => (await messages()).some((m) => m.text.includes("voice assistant")), 30_000, "greeting");
  await sleep(2500);
  logQaContent(REDACTED, console.log, "[qa] greeting:", JSON.stringify((await messages())[0]?.text));
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
  }

  const question = "What does Deniss do at If?";
  await page.getByTestId("voice-input").fill(question);
  await page.getByRole("button", { name: "Send" }).click();
  const answer = await waitFor(
    async () => {
      const all = await messages();
      const index = all.findIndex((m) => m.text === question);
      return index >= 0
        ? all.slice(index + 1).find((m) => m.assistant && !m.pending && m.text.length > 20)
        : undefined;
    },
    240_000,
    "text answer",
  );
  logQaContent(REDACTED, console.log, "[qa] answer:", JSON.stringify(answer?.text));
  await takeQaScreenshot(page, "/tmp/voice-qa-04-answer.png", REDACTED);

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
      ready: offlineState.status?.startsWith("Ready") ?? false,
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

  await waitFor(async () => qaModelsReady(await status()), 120_000, "offline models");
  const offlineReadyStatus = await status();
  if (REDACTED) console.log("[qa] offline models ready");
  else console.log("[qa] offline model status:", offlineReadyStatus);

  await takeQaScreenshot(page, "/tmp/voice-qa-06-offline-ready.png", REDACTED);

  await context.setOffline(false);
} catch (error) {
  logQaError(error, REDACTED, console.error);
  process.exitCode = 1;
} finally {
  if (browser) {
    await browser.close().catch((error) => {
      logQaError(error, REDACTED, console.error);
      process.exitCode = 1;
    });
  }
}

console.log(process.exitCode ? "[qa] FAILED" : "[qa] done");
