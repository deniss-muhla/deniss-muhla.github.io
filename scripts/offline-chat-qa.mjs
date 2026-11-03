#!/usr/bin/env node
/**
 * Headed-Chrome regression for the first typed turn after an offline refresh.
 *
 * The test runs the Vite dev route and a temporary static build on ephemeral localhost
 * ports. It waits for service-worker control and for the reviewed-index bundle to enter
 * the worker cache, then stops only the server it started, goes offline, refreshes, and
 * sends one synthetic typed question. Reports contain fixed labels and booleans only.
 * A dedicated QA-only environment flag makes vite.config.ts omit its CV artifact plugin
 * and source-identity read before config loading. Dev and build outputs stay under a
 * canonical temp root outside the canonical repository. A temporary public directory
 * contains only the worker, registration script, and favicon; assistant audio and the
 * repository public directory are never copied or served.
 *
 * Run from the repository root with `node scripts/offline-chat-qa.mjs`.
 * `--routing=dev` or `--routing=built` selects one route. `--preflight` validates
 * configs and the report parent without starting a server, build, or browser. An
 * `OFFLINE_CHAT_QA_REPORT` override needs an existing external parent and a fresh JSON name.
 */
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { copyFile, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";
import { build, createServer as createViteServer, loadConfigFromFile } from "vite";
import { ReportPathError, reserveNewReport, validateReportDestination } from "./offline-chat-report.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPORT_PATH_OVERRIDE = process.env.OFFLINE_CHAT_QA_REPORT;
const QUESTION = "What is his profile summary?";
const STARTUP_TIMEOUT_MS = 60_000;
const CACHE_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 60_000;
const BLOCKED_PORTS = new Set([4173, 4174]);
const QA_CONFIG_ENV = "OFFLINE_CHAT_QA_ONLY";
const qaRuntimeCalls = { createViteServer: false, build: false, browser: false };
const qaReportCalls = { reserve: false, write: false };
const ROUTING_ARG = process.argv.find((argument) => argument.startsWith("--routing="));
const ROUTINGS = ROUTING_ARG ? [ROUTING_ARG.slice("--routing=".length)] : ["dev", "built"];

function reportPathFor(scratchContext) {
  return REPORT_PATH_OVERRIDE ?? join(scratchContext.canonicalTempRoot, `offline-chat-qa-${randomUUID()}.json`);
}

class QaFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function requireQa(condition, code) {
  if (!condition) throw new QaFailure(code);
}

function timeoutPromise(promise, milliseconds, code) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new QaFailure(code)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function nextAvailablePort() {
  for (;;) {
    const probe = createNetServer();
    const port = await new Promise((resolvePort, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => resolvePort(probe.address().port));
    });
    await new Promise((resolveClose, reject) =>
      probe.close((error) => (error ? reject(error) : resolveClose())),
    );
    if (!BLOCKED_PORTS.has(port)) return port;
  }
}

async function waitForHttp(url, timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // The owned server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  throw new QaFailure("server-startup-timeout");
}

function flattenPlugins(plugins, result = []) {
  for (const plugin of plugins ?? []) {
    if (Array.isArray(plugin)) flattenPlugins(plugin, result);
    else if (plugin) result.push(plugin);
  }
  return result;
}

const SAFE_SHELL_FILES = ["favicon.svg", "sw.js", "sw-register.js"];
const BLOCKED_PUBLIC_ROUTES = ["/public", "/downloads", "/audio"];

function isWithin(root, path) {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}

async function resolveScratchContext() {
  const [canonicalRepoRoot, canonicalTempRoot] = await Promise.all([
    realpath(REPO_ROOT),
    realpath(tmpdir()),
  ]);
  requireQa(!isWithin(canonicalRepoRoot, canonicalTempRoot), "canonical-tmpdir-inside-repository");
  return { canonicalRepoRoot, canonicalTempRoot };
}

async function assertSafeScratchDirectory(path, scratchContext, failureCode) {
  let canonicalPath;
  try {
    canonicalPath = await realpath(path);
  } catch {
    throw new QaFailure(failureCode);
  }
  requireQa(canonicalPath === resolve(path), `${failureCode}-not-canonical`);
  requireQa(isWithin(scratchContext.canonicalTempRoot, canonicalPath), `${failureCode}-outside-tmpdir`);
  requireQa(!isWithin(scratchContext.canonicalRepoRoot, canonicalPath), `${failureCode}-inside-repository`);
  return canonicalPath;
}

async function createScratchDirectory(scratchContext, prefix) {
  let createdPath;
  try {
    createdPath = await mkdtemp(join(scratchContext.canonicalTempRoot, prefix));
    const canonicalPath = await realpath(createdPath);
    requireQa(isWithin(scratchContext.canonicalTempRoot, canonicalPath), "scratch-directory-outside-tmpdir");
    requireQa(!isWithin(scratchContext.canonicalRepoRoot, canonicalPath), "scratch-directory-inside-repository");
    return canonicalPath;
  } catch (error) {
    if (createdPath) await rm(createdPath, { recursive: true, force: true });
    throw error;
  }
}

async function copySafeShellFiles(destinationDir, scratchContext) {
  const safeDestination = await assertSafeScratchDirectory(
    destinationDir,
    scratchContext,
    "safe-shell-destination-invalid",
  );
  for (const name of SAFE_SHELL_FILES) {
    await copyFile(join(scratchContext.canonicalRepoRoot, "public", name), join(safeDestination, name));
  }
}

async function createSafePublicDir(scratchContext) {
  const safePublicDir = await createScratchDirectory(scratchContext, "offline-chat-safe-public-");
  await copySafeShellFiles(safePublicDir, scratchContext);
  const names = (await readdir(safePublicDir)).sort();
  requireQa(
    JSON.stringify(names) === JSON.stringify([...SAFE_SHELL_FILES].sort()),
    "safe-public-directory-contents-changed",
  );
  return safePublicDir;
}

async function loadQaConfig(command, mode, scratchContext) {
  process.env[QA_CONFIG_ENV] = "1";
  requireQa(process.env[QA_CONFIG_ENV] === "1", "qa-config-flag-not-set");
  let loaded;
  try {
    loaded = await loadConfigFromFile(
      { command, mode, isSsrBuild: false, isPreview: false },
      join(scratchContext.canonicalRepoRoot, "vite.config.ts"),
      scratchContext.canonicalRepoRoot,
      "silent",
    );
  } catch {
    throw new QaFailure("repo-vite-config-load-failed");
  }
  requireQa(loaded !== null, "repo-vite-config-missing");
  const cvArtifactPluginCount = flattenPlugins(loaded.config.plugins)
    .filter((plugin) => plugin.name === "cv-artifacts").length;
  requireQa(cvArtifactPluginCount === 0, "qa-cv-artifact-plugin-present");
  return {
    config: {
      ...loaded.config,
      configFile: false,
      root: scratchContext.canonicalRepoRoot,
      logLevel: "silent",
    },
    cvArtifactPluginCount,
    qaFlagSetBeforeLoad: true,
  };
}

function safePublicGuardPlugin() {
  return {
    name: "offline-chat-safe-public-guard",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        let pathname;
        try {
          pathname = new URL(request.url ?? "/", "http://vite.local").pathname;
        } catch {
          response.writeHead(404);
          response.end();
          return;
        }
        if (BLOCKED_PUBLIC_ROUTES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
          response.writeHead(404);
          response.end();
          return;
        }
        next();
      });
    },
  };
}

async function createSafeConfigPlan(safePublicDir, buildDir, scratchContext) {
  await assertSafeScratchDirectory(safePublicDir, scratchContext, "safe-public-directory-invalid");
  await assertSafeScratchDirectory(buildDir, scratchContext, "safe-build-directory-invalid");
  const [devLoaded, buildLoaded] = await Promise.all([
    loadQaConfig("serve", "development", scratchContext),
    loadQaConfig("build", "production", scratchContext),
  ]);

  const devFs = devLoaded.config.server?.fs ?? {};
  const devConfig = {
    ...devLoaded.config,
    configFile: false,
    publicDir: safePublicDir,
    server: {
      ...devLoaded.config.server,
      fs: {
        ...devFs,
        deny: [...new Set([...(devFs.deny ?? []), "**/public/**"])],
      },
    },
    plugins: [...(Array.isArray(devLoaded.config.plugins) ? devLoaded.config.plugins : [devLoaded.config.plugins]), safePublicGuardPlugin()],
  };
  const buildConfig = {
    ...buildLoaded.config,
    configFile: false,
    publicDir: false,
    build: {
      ...buildLoaded.config.build,
      outDir: buildDir,
      emptyOutDir: true,
      copyPublicDir: false,
      manifest: true,
    },
  };

  assertSafeConfig(devConfig, { route: "dev", safePublicDir });
  assertSafeConfig(buildConfig, { route: "built" });
  return {
    devConfig,
    buildConfig,
    cvArtifactPluginCounts: { dev: devLoaded.cvArtifactPluginCount, built: buildLoaded.cvArtifactPluginCount },
    qaFlagSetBeforeConfigLoad: devLoaded.qaFlagSetBeforeLoad && buildLoaded.qaFlagSetBeforeLoad,
    cvAudioSourceIdentitySkipped:
      !Object.hasOwn(devLoaded.config.define ?? {}, "__CV_AUDIO_SOURCE_IDENTITY__") &&
      !Object.hasOwn(buildLoaded.config.define ?? {}, "__CV_AUDIO_SOURCE_IDENTITY__"),
  };
}

function assertSafeConfig(config, { route, safePublicDir } = {}) {
  requireQa(config.configFile === false, `${route}-config-file-not-disabled`);
  requireQa(!flattenPlugins(config.plugins).some((plugin) => plugin.name === "cv-artifacts"), `${route}-cv-artifact-plugin-present`);
  if (route === "dev") {
    requireQa(config.publicDir === safePublicDir, "dev-public-directory-not-safe");
    requireQa(flattenPlugins(config.plugins).some((plugin) => plugin.name === "offline-chat-safe-public-guard"), "dev-public-route-guard-missing");
    requireQa(config.server?.fs?.deny?.includes("**/public/**"), "dev-repository-public-deny-missing");
  } else {
    requireQa(config.publicDir === false, "built-public-directory-not-disabled");
    requireQa(config.build?.copyPublicDir === false, "built-public-copy-not-disabled");
  }
}

async function buildSafeStaticArtifact(buildConfig, outputDir, scratchContext) {
  assertSafeConfig(buildConfig, { route: "built" });
  await assertSafeScratchDirectory(outputDir, scratchContext, "safe-build-output-directory-invalid");
  requireQa(buildConfig.build?.outDir === outputDir, "safe-build-output-directory-mismatch");
  try {
    qaRuntimeCalls.build = true;
    await build({ ...buildConfig, configFile: false, publicDir: false });
  } catch {
    throw new QaFailure("safe-site-build-failed");
  }

  await copySafeShellFiles(outputDir, scratchContext);
  const builtWorker = await readFile(join(outputDir, "sw.js"), "utf8");
  requireQa(!workerPrecacheContainsPdf(builtWorker), "built-worker-precache-contract-failed");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(outputDir, ".vite", "manifest.json"), "utf8"));
  } catch {
    throw new QaFailure("safe-build-manifest-missing");
  }
  const indexEntry = Object.entries(manifest).find(([key, value]) =>
    key.includes("src/chat/retrieval/reviewed-index.ts") ||
    value.src?.includes("src/chat/retrieval/reviewed-index.ts"),
  );
  requireQa(indexEntry && typeof indexEntry[1].file === "string", "reviewed-index-build-entry-missing");
  return { reviewedIndexBundlePath: `/${indexEntry[1].file}` };
}

function workerPrecacheContainsPdf(source) {
  const match = source.match(/const SHELL_URLS\s*=\s*\[([^\]]*)\]/);
  return match === null || /\.pdf\b|\/downloads\//i.test(match[1]);
}

async function warmDevOptimizer(origin) {
  const targets = ["/src/entries/home.tsx", "/src/chat/retrieval/encoder/worker.ts"];
  let previous = "";
  for (let round = 0; round < 6; round += 1) {
    const signatures = [];
    for (const target of targets) {
      const response = await fetch(`${origin}${target}`, { signal: AbortSignal.timeout(15_000) });
      signatures.push(`${response.status}:${(await response.arrayBuffer()).byteLength}`);
    }
    const current = signatures.join("|");
    if (current === previous) return;
    previous = current;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new QaFailure("dev-optimizer-did-not-stabilize");
}

async function startDevServer(port, devConfig, safePublicDir, scratchContext) {
  assertSafeConfig(devConfig, { route: "dev", safePublicDir });
  await assertSafeScratchDirectory(safePublicDir, scratchContext, "dev-public-directory-invalid");
  let server;
  try {
    qaRuntimeCalls.createViteServer = true;
    server = await createViteServer({
      ...devConfig,
      configFile: false,
      publicDir: safePublicDir,
      server: { ...devConfig.server, host: "127.0.0.1", port, strictPort: true, open: false },
    });
    await server.listen();
    return { close: () => server.close() };
  } catch {
    await server?.close().catch(() => undefined);
    throw new QaFailure("dev-server-start-failed");
  }
}

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".woff2", "font/woff2"],
]);

async function startStaticServer(root, port, scratchContext) {
  const resolvedRoot = await assertSafeScratchDirectory(root, scratchContext, "static-root-invalid");
  const server = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      let pathname = decodeURIComponent(url.pathname);
      if (BLOCKED_PUBLIC_ROUTES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (pathname.endsWith("/")) pathname += "index.html";
      let filePath = resolve(resolvedRoot, `.${pathname}`);
      if (filePath !== resolvedRoot && !filePath.startsWith(`${resolvedRoot}${sep}`)) {
        response.writeHead(404);
        response.end();
        return;
      }
      try {
        const info = await stat(filePath);
        if (info.isDirectory()) filePath = join(filePath, "index.html");
      } catch {
        filePath = join(resolvedRoot, "index.html");
      }
      const body = await readFile(filePath);
      response.writeHead(200, {
        "Content-Type": MIME_TYPES.get(extname(filePath)) ?? "application/octet-stream",
        "Content-Length": body.length,
        "Cache-Control": "no-cache",
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  try {
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolveListen);
    });
  } catch {
    server.close();
    throw new QaFailure("static-server-start-failed");
  }
  return {
    close: () => new Promise((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    ),
  };
}

async function workerCacheHasPath(page, path) {
  return page.evaluate(async (expectedPath) => {
    for (const name of await caches.keys()) {
      if (!name.startsWith("cv-assets-")) continue;
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        if (new URL(request.url).pathname !== expectedPath) continue;
        const response = await cache.match(request);
        return response?.ok === true;
      }
    }
    return false;
  }, path);
}

async function waitForWorkerCache(page, path) {
  const deadline = Date.now() + CACHE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await workerCacheHasPath(page, path).catch(() => false)) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  return false;
}

async function waitForControlledApp(page) {
  await page.waitForFunction(
    () =>
      Boolean(document.querySelector('[data-testid="voice-fab"]')) &&
      Boolean(navigator.serviceWorker?.controller) &&
      self.crossOriginIsolated === true,
    null,
    { timeout: STARTUP_TIMEOUT_MS },
  ).catch(() => {
    throw new QaFailure("controlled-app-timeout");
  });
}

async function countUserMessages(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="voice-messages"] > p')].filter((node) =>
      node.className.includes("user"),
    ).length,
  );
}

async function readFirstTurnOutcome(page) {
  const result = await page.waitForFunction(
    (question) => {
      const nodes = [...document.querySelectorAll('[data-testid="voice-messages"] > p')];
      const userIndex = nodes.findIndex(
        (node) => node.className.includes("user") && node.textContent?.trim() === question,
      );
      if (userIndex < 0) return null;
      const reply = nodes.slice(userIndex + 1).find((node) => node.className.includes("assistant"));
      if (reply && !reply.hasAttribute("data-pending") && (reply.textContent ?? "").trim()) {
        return {
          kind: document.querySelector('[data-testid="voice-choices"]') ? "clarification" : "answer",
          limitedMatching: Boolean(document.querySelector('[data-testid="voice-note"]')),
        };
      }
      if (document.querySelector('[data-testid="voice-status"]')?.getAttribute("data-state") === "error") {
        return { kind: "error", limitedMatching: false };
      }
      if (document.querySelector('[data-testid="voice-retry"]')) {
        return { kind: "refusal", limitedMatching: false };
      }
      return null;
    },
    QUESTION,
    { timeout: TURN_TIMEOUT_MS },
  ).catch(() => {
    throw new QaFailure("first-offline-turn-timeout");
  });
  return result.jsonValue();
}

async function runRoute(routing, {
  buildDir,
  reviewedIndexBundlePath,
  devConfig,
  safePublicDir,
  scratchContext,
}) {
  const result = {
    routing,
    browser: "Chrome",
    headed: true,
    serviceWorkerControlledOnline: false,
    reviewedIndexBundleCachedOnline: false,
    onlineTypedQuestions: 0,
    serverStoppedBeforeRefresh: false,
    offlineRefreshSucceeded: false,
    serviceWorkerControlledOffline: false,
    offlineTypedQuestions: 0,
    firstTurnKind: "not-run",
    limitedMatching: false,
    protectedPdfRequested: false,
    assistantAudioRequested: false,
    microphoneCaptureUsed: false,
    browserTtsUsed: false,
    serverCleanup: "pending",
    browserCleanup: "pending",
    passed: false,
    failure: null,
  };

  const port = await nextAvailablePort();
  requireQa(!BLOCKED_PORTS.has(port), "protected-port-selected");
  const origin = `http://127.0.0.1:${port}`;
  let server;
  let browser;
  let context;
  let page;

  try {
    server = routing === "dev"
      ? await startDevServer(port, devConfig, safePublicDir, scratchContext)
      : await startStaticServer(buildDir, port, scratchContext);
    await waitForHttp(`${origin}/`);

    if (routing === "dev") await warmDevOptimizer(origin);

    qaRuntimeCalls.browser = true;
    browser = await chromium.launch({
      channel: "chrome",
      headless: false,
      args: ["--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--mute-audio"],
    });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      const devices = navigator.mediaDevices;
      if (devices) {
        Object.defineProperty(devices, "getUserMedia", {
          configurable: true,
          value: () => Promise.reject(new DOMException("QA capture disabled", "NotAllowedError")),
        });
      }
      Object.defineProperty(window, "AudioContext", {
        configurable: true,
        value: class {
          constructor() {
            throw new DOMException("QA audio disabled", "NotAllowedError");
          }
        },
      });
    });
    page = await context.newPage();
    page.setDefaultTimeout(STARTUP_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(STARTUP_TIMEOUT_MS);
    page.on("request", (request) => {
      try {
        const pathname = new URL(request.url()).pathname;
        if (/^\/downloads\/.*\.pdf$/i.test(pathname)) result.protectedPdfRequested = true;
        if (pathname === "/audio" || pathname.startsWith("/audio/")) result.assistantAudioRequested = true;
      } catch {
        // Malformed URLs do not enter the content-free report.
      }
    });

    const indexPath = routing === "dev"
      ? "/src/chat/retrieval/reviewed-index.ts"
      : reviewedIndexBundlePath;
    await page.goto(`${origin}/?sw=1`, { waitUntil: "domcontentloaded" });
    await waitForControlledApp(page);
    result.serviceWorkerControlledOnline = true;

    // Reload once under control so every module in the lazy chat chunk is fetched through
    // the worker before the owned server is stopped. No typed turn is sent online.
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForControlledApp(page);
    result.reviewedIndexBundleCachedOnline = await waitForWorkerCache(page, indexPath);
    result.onlineTypedQuestions = await countUserMessages(page).catch(() => 0);

    await server.close();
    server = null;
    result.serverStoppedBeforeRefresh = true;
    result.serverCleanup = "stopped";

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForControlledApp(page);
    result.offlineRefreshSucceeded = true;
    result.serviceWorkerControlledOffline = await page.evaluate(() => Boolean(navigator.serviceWorker?.controller));

    await page.getByTestId("voice-fab").click();
    await page.waitForFunction(
      () => {
        const input = document.querySelector('[data-testid="voice-input"]');
        return input instanceof HTMLInputElement && input.offsetParent !== null;
      },
      null,
      { timeout: STARTUP_TIMEOUT_MS },
    ).catch(() => {
      throw new QaFailure("offline-composer-unavailable");
    });
    result.offlineTypedQuestions = await countUserMessages(page).catch(() => 0);
    requireQa(result.offlineTypedQuestions === 0, "question-was-not-first-turn");

    await page.getByTestId("voice-input").fill(QUESTION);
    await page.getByRole("button", { name: "Send" }).click();
    const outcome = await readFirstTurnOutcome(page);
    result.firstTurnKind = outcome.kind;
    result.limitedMatching = outcome.limitedMatching;
    result.offlineTypedQuestions = await countUserMessages(page).catch(() => 0);
    requireQa(
      outcome.kind === "answer" || outcome.kind === "clarification",
      "first-offline-turn-not-retrieved",
    );
    requireQa(result.offlineTypedQuestions === 1, "offline-turn-count-mismatch");
    requireQa(result.onlineTypedQuestions === 0, "online-question-was-submitted");
    requireQa(!result.protectedPdfRequested, "protected-pdf-request-observed");
    requireQa(!result.assistantAudioRequested, "assistant-audio-request-observed");
    result.passed = true;
  } catch (error) {
    result.failure = error instanceof QaFailure ? error.code : "unexpected-failure";
  } finally {
    if (page) {
      await page.close().catch(() => undefined);
    }
    if (context) {
      await context.close().catch(() => undefined);
    }
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    result.browserCleanup = browser ? "closed" : "not-started";

    if (server) {
      try {
        await timeoutPromise(server.close(), 10_000, "owned-server-close-timeout");
        result.serverCleanup = "stopped";
      } catch {
        result.serverCleanup = "close-failed";
        if (result.failure === null) result.failure = "owned-server-close-failed";
        result.passed = false;
      }
    } else if (result.serverCleanup === "pending") {
      result.serverCleanup = "not-started";
    }
  }

  return result;
}

async function runSafeConfigPreflight() {
  const scratchContext = await resolveScratchContext();
  const reportDestination = await validateReportDestination(
    reportPathFor(scratchContext),
    scratchContext.canonicalRepoRoot,
  );
  let safePublicDir;
  let buildDir;
  try {
    safePublicDir = await createSafePublicDir(scratchContext);
    buildDir = await createScratchDirectory(scratchContext, "offline-chat-config-preflight-build-");
    const plan = await createSafeConfigPlan(safePublicDir, buildDir, scratchContext);
    const publicEntries = (await readdir(safePublicDir)).sort();
    const canonicalSafePublicDir = await assertSafeScratchDirectory(
      safePublicDir,
      scratchContext,
      "preflight-public-directory-invalid",
    );
    const canonicalBuildDir = await assertSafeScratchDirectory(
      buildDir,
      scratchContext,
      "preflight-build-directory-invalid",
    );
    const evidence = {
      status: "passed",
      runtimeCalls: { ...qaRuntimeCalls },
      noPostLoadPluginFilter: true,
      reportOperations: { ...qaReportCalls },
      reportDestination: {
        parentCanonical: await realpath(reportDestination.directory) === reportDestination.directory,
        parentOutsideRepository: !isWithin(
          scratchContext.canonicalRepoRoot,
          reportDestination.directory,
        ),
      },
      canonicalPaths: {
        repoRootCanonical: await realpath(REPO_ROOT) === scratchContext.canonicalRepoRoot,
        tempRootCanonical: await realpath(tmpdir()) === scratchContext.canonicalTempRoot,
        tempOutsideRepository: !isWithin(scratchContext.canonicalRepoRoot, scratchContext.canonicalTempRoot),
        safePublicCanonical: canonicalSafePublicDir === safePublicDir,
        safePublicWithinTemp: isWithin(scratchContext.canonicalTempRoot, canonicalSafePublicDir),
        safePublicOutsideRepository: !isWithin(scratchContext.canonicalRepoRoot, canonicalSafePublicDir),
        buildOutputCanonical: canonicalBuildDir === buildDir,
        buildOutputWithinTemp: isWithin(scratchContext.canonicalTempRoot, canonicalBuildDir),
        buildOutputOutsideRepository: !isWithin(scratchContext.canonicalRepoRoot, canonicalBuildDir),
      },
      dev: {
        cvArtifactsFound: plan.cvArtifactPluginCounts.dev,
        cvArtifactsAbsent: plan.cvArtifactPluginCounts.dev === 0 &&
          !flattenPlugins(plan.devConfig.plugins).some((plugin) => plugin.name === "cv-artifacts"),
        qaFlagSetBeforeConfigLoad: plan.qaFlagSetBeforeConfigLoad,
        cvAudioSourceIdentitySkipped: plan.cvAudioSourceIdentitySkipped,
        configFileFalse: plan.devConfig.configFile === false,
        safePublicDirOnly: plan.devConfig.publicDir === safePublicDir &&
          JSON.stringify(publicEntries) === JSON.stringify([...SAFE_SHELL_FILES].sort()),
        repositoryPublicDenied: plan.devConfig.server.fs.deny.includes("**/public/**"),
        publicRouteGuardInstalled: flattenPlugins(plan.devConfig.plugins).some((plugin) =>
          plugin.name === "offline-chat-safe-public-guard",
        ),
      },
      built: {
        cvArtifactsFound: plan.cvArtifactPluginCounts.built,
        cvArtifactsAbsent: plan.cvArtifactPluginCounts.built === 0 &&
          !flattenPlugins(plan.buildConfig.plugins).some((plugin) => plugin.name === "cv-artifacts"),
        qaFlagSetBeforeConfigLoad: plan.qaFlagSetBeforeConfigLoad,
        cvAudioSourceIdentitySkipped: plan.cvAudioSourceIdentitySkipped,
        configFileFalse: plan.buildConfig.configFile === false,
        publicDirFalse: plan.buildConfig.publicDir === false,
        publicCopyFalse: plan.buildConfig.build.copyPublicDir === false,
      },
      safePublicFiles: publicEntries,
    };
    requireQa(
      evidence.noPostLoadPluginFilter && Object.values(evidence.runtimeCalls).every((called) => !called) &&
        Object.values(evidence.reportOperations).every((called) => !called) &&
        evidence.reportDestination.parentCanonical && evidence.reportDestination.parentOutsideRepository &&
        evidence.canonicalPaths.repoRootCanonical &&
        evidence.canonicalPaths.tempRootCanonical && evidence.canonicalPaths.tempOutsideRepository &&
        evidence.canonicalPaths.safePublicCanonical && evidence.canonicalPaths.safePublicWithinTemp &&
        evidence.canonicalPaths.safePublicOutsideRepository && evidence.canonicalPaths.buildOutputCanonical &&
        evidence.canonicalPaths.buildOutputWithinTemp && evidence.canonicalPaths.buildOutputOutsideRepository,
      "canonical-scratch-preflight-failed",
    );
    requireQa(
      evidence.dev.cvArtifactsFound === 0 && evidence.dev.cvArtifactsAbsent &&
        evidence.dev.qaFlagSetBeforeConfigLoad && evidence.dev.cvAudioSourceIdentitySkipped &&
        evidence.dev.configFileFalse && evidence.dev.safePublicDirOnly &&
        evidence.dev.repositoryPublicDenied && evidence.dev.publicRouteGuardInstalled,
      "dev-safe-config-preflight-failed",
    );
    requireQa(
      evidence.built.cvArtifactsFound === 0 && evidence.built.cvArtifactsAbsent &&
        evidence.built.qaFlagSetBeforeConfigLoad && evidence.built.cvAudioSourceIdentitySkipped &&
        evidence.built.configFileFalse && evidence.built.publicDirFalse && evidence.built.publicCopyFalse,
      "built-safe-config-preflight-failed",
    );
    console.log(JSON.stringify(evidence));
  } finally {
    if (safePublicDir) await rm(safePublicDir, { recursive: true, force: true });
    if (buildDir) await rm(buildDir, { recursive: true, force: true });
  }
}

async function main() {
  requireQa(ROUTINGS.length > 0 && ROUTINGS.every((route) => route === "dev" || route === "built"), "invalid-routing");
  const report = {
    schema: "offline-first-chat-turn-v1",
    browser: "Chrome",
    headed: true,
    microphoneCaptureUsed: false,
    browserTtsUsed: false,
    assistantAudioRequested: false,
    coldEmbeddingModelLoadsOfflineClaimed: false,
    routes: [],
  };
  let scratchContext;
  let safePublicDir;
  let buildDir;
  let reportReservation;

  try {
    scratchContext = await resolveScratchContext();
    qaReportCalls.reserve = true;
    reportReservation = await reserveNewReport(
      reportPathFor(scratchContext),
      scratchContext.canonicalRepoRoot,
    );
    const sourceWorker = await readFile(join(scratchContext.canonicalRepoRoot, "public", "sw.js"), "utf8");
    requireQa(!workerPrecacheContainsPdf(sourceWorker), "source-worker-precache-contract-failed");

    safePublicDir = await createSafePublicDir(scratchContext);
    buildDir = await createScratchDirectory(scratchContext, "offline-chat-static-");
    const safeConfigs = await createSafeConfigPlan(safePublicDir, buildDir, scratchContext);
    let buildDetails = { reviewedIndexBundlePath: null };
    if (ROUTINGS.includes("built")) {
      buildDetails = await buildSafeStaticArtifact(safeConfigs.buildConfig, buildDir, scratchContext);
    }

    for (const routing of ROUTINGS) {
      const result = await runRoute(routing, {
        buildDir,
        ...buildDetails,
        devConfig: safeConfigs.devConfig,
        safePublicDir,
        scratchContext,
      });
      report.routes.push(result);
      if (!result.passed) break;
    }
    report.assistantAudioRequested = report.routes.some((route) => route.assistantAudioRequested);
  } catch (error) {
    report.failure = error instanceof QaFailure || error instanceof ReportPathError
      ? error.code
      : "unexpected-failure";
  } finally {
    if (safePublicDir) await rm(safePublicDir, { recursive: true, force: true });
    if (buildDir) await rm(buildDir, { recursive: true, force: true });
  }

  if (!reportReservation) {
    console.log("[offline-chat-qa] report destination rejected");
    process.exitCode = 1;
    return;
  }

  report.passed = report.failure === undefined && report.routes.length === ROUTINGS.length && report.routes.every((route) => route.passed);
  let reportWritten = false;
  try {
    qaReportCalls.write = true;
    await reportReservation.handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    reportWritten = true;
  } catch {
    report.passed = false;
  } finally {
    await reportReservation.handle.close().catch(() => {
      reportWritten = false;
    });
  }

  if (report.passed && reportWritten) console.log("[offline-chat-qa] passed");
  else console.log("[offline-chat-qa] failed (details are in the content-free report)");
  if (!report.passed || !reportWritten) process.exitCode = 1;
}

if (process.argv.includes("--preflight")) {
  await runSafeConfigPreflight().catch(() => {
    console.log("[offline-chat-qa] safe config preflight failed");
    process.exitCode = 1;
  });
} else {
  await main();
}
