#!/usr/bin/env node
// One bounded, unscored smoke through the shipping browser model path.
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import type { InlineConfig, ViteDevServer } from "vite";

export const MODEL_TIMEOUT_MS = 240_000;
export const GENERATION_TIMEOUT_MS = 90_000;
export const SMOKE_OUTER_TIMEOUT_SECONDS = 400;
export const FROZEN_CV_SHA256 = "93bc0ecaeafad56e0d199b8b634ea3d45b5636d3e3a603fdfe7f2bac2bd3fb92";

export type SmokeStage = "source" | "startup" | "model-load" | "generation";

export class SmokeFailure extends Error {
  readonly stage: SmokeStage;

  constructor(stage: SmokeStage) {
    super(`smoke-${stage}-failed`);
    this.stage = stage;
  }
}

export type SmokeReport = {
  cliVersion: number;
  smoke: "generation-complete-unscored";
  webllmVersion: string;
  modelId: string;
  modelUrl: string;
  wasmUrl: string;
  cachedAssets: Array<{ url: string; sha256: string; bytes: number }>;
  shaderF16: boolean;
  gpuFeatures: string[];
  chromeVersion: string;
  host: string;
  cacheEntriesBeforeLoad: number;
  sourceFingerprint: string;
  loadMs: number;
  generationMs: number;
};

const route = "/__cv-model-smoke__.html";
const question = "State one fact about Deniss's professional background.";
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Local model smoke</title></head><body>
<p>Technical smoke in progress</p><script type="module" src="/scripts/cv-model-page.ts"></script></body></html>`;

async function within<T>(operation: Promise<T>, milliseconds: number, onTimeout: () => void) {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => { onTimeout(); reject(new Error("smoke-timeout")); }, milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function run(dependencies: {
  createServer?: (config: InlineConfig) => Promise<ViteDevServer>;
  launchBrowser?: (options: Parameters<typeof chromium.launch>[0]) => Promise<Browser>;
} = {}): Promise<SmokeReport> {
  let stage: SmokeStage = "source";
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;

  try {
    const source = await readFile(new URL("../resources/cv/source/cv.md", import.meta.url));
    const sourceFingerprint = createHash("sha256").update(source).digest("hex");
    if (sourceFingerprint !== FROZEN_CV_SHA256) throw new Error("source-snapshot-stale");

    stage = "startup";
    const startServer = dependencies.createServer ?? createServer;
    server = await startServer({
      configFile: false,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      plugins: [{
        name: "isolated-model-smoke-page",
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url !== route) return next();
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
            response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
            response.end(html);
          });
        },
      }],
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("server-unavailable");

    const launch = dependencies.launchBrowser ?? chromium.launch.bind(chromium);
    browser = await launch({ channel: "chrome", headless: false, args: ["--enable-unsafe-webgpu"] });
    const context = await browser.newContext({ serviceWorkers: "block" });
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}${route}`);

    stage = "model-load";
    const cacheEntriesBeforeLoad = await page.evaluate(async () => {
      let count = 0;
      for (const name of await caches.keys()) count += (await (await caches.open(name)).keys()).length;
      return count;
    });
    const loadStarted = Date.now();
    const identity = await within(page.evaluate(() => window.__cvSmoke.load()), MODEL_TIMEOUT_MS,
      () => { void browser?.close().catch(() => {}); });
    const loadMs = Date.now() - loadStarted;
    const webllmVersion = JSON.parse(await readFile(
      new URL("../node_modules/@mlc-ai/web-llm/package.json", import.meta.url), "utf8",
    )).version as string;

    stage = "generation";
    const generationStarted = Date.now();
    const generated = await within(page.evaluate((prompt) => window.__cvSmoke.ask(prompt), question),
      GENERATION_TIMEOUT_MS, () => { void browser?.close().catch(() => {}); });
    if (!generated) throw new Error("empty-generation");

    return {
      cliVersion: 2,
      smoke: "generation-complete-unscored",
      webllmVersion,
      modelId: identity.modelId,
      modelUrl: identity.modelUrl,
      wasmUrl: identity.wasmUrl,
      cachedAssets: identity.cachedAssets,
      shaderF16: identity.shaderF16,
      gpuFeatures: identity.gpuFeatures,
      chromeVersion: browser.version(),
      host: hostname(),
      cacheEntriesBeforeLoad,
      sourceFingerprint,
      loadMs,
      generationMs: Date.now() - generationStarted,
    };
  } catch {
    throw new SmokeFailure(stage);
  } finally {
    await page?.evaluate(() => window.__cvSmoke?.clear()).catch(() => {});
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (process.argv.length !== 2) {
    process.stderr.write("Usage: node scripts/cv-model-evaluate.ts\n");
    process.exitCode = 2;
  } else {
    run().then((report) => {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    }).catch((error: unknown) => {
      const stage = error instanceof SmokeFailure ? error.stage : "startup";
      process.stderr.write(`Technical smoke incomplete at ${stage}.\n`);
      process.exitCode = 1;
    });
  }
}

declare global {
  interface Window {
    __cvSmoke: {
      load: () => Promise<{
        modelId: string;
        modelUrl: string;
        wasmUrl: string;
        cachedAssets: SmokeReport["cachedAssets"];
        shaderF16: boolean;
        gpuFeatures: string[];
      }>;
      ask: (question: string) => Promise<boolean>;
      clear: () => void;
    };
  }
}
