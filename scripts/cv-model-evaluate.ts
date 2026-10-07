#!/usr/bin/env node
// One bounded, unscored smoke through the shipping CPU retrieval answer path.
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import type { InlineConfig, ViteDevServer } from "vite";

import { EXPECTED_EMBEDDING, MODEL_PATH_PREFIX, readReviewedIndex } from "../src/chat/retrieval/index.ts";
import type { EmbeddingIdentity } from "../src/chat/retrieval/index.ts";
import { ORT_RUNTIME_ASSETS, ORT_RUNTIME_VERSION, ORT_ROUTE } from "../src/chat/retrieval/encoder/runtime-assets.ts";
import { crossOriginIsolationHeaders, onnxRuntimeServePlugin } from "../vite.config.ts";

export const MODEL_TIMEOUT_MS = 240_000;
export const QUERY_TIMEOUT_MS = 60_000;
export const SMOKE_OUTER_TIMEOUT_SECONDS = 400;
export const FROZEN_CV_SHA256 = "93bc0ecaeafad56e0d199b8b634ea3d45b5636d3e3a603fdfe7f2bac2bd3fb92";

/**
 * The only names a failure may carry. `source` gates the canonical CV bytes, `index` the
 * reviewed artifact and what the page loaded from it, `startup` the server, browser and
 * navigation, `model-load` the encoder and its assets, `query` the selection exercise.
 * Raw vendor exception details never leave `run`.
 */
export type SmokeStage = "source" | "index" | "startup" | "model-load" | "query";

export class SmokeFailure extends Error {
  readonly stage: SmokeStage;

  constructor(stage: SmokeStage) {
    super(`smoke-${stage}-failed`);
    this.stage = stage;
  }
}

/** One hashed asset: a cached model file or a served runtime file. Technical metadata only. */
export type SmokeAsset = {
  url: string;
  sha256: string;
  bytes: number;
};

/**
 * The redacted result. Every field is a digest, a pinned identity value, a byte count, a
 * duration, a URL of a pinned asset or a fixed enum: no field can hold question, answer,
 * prompt or CV text, and `test/cv-model-evaluate.integration.test.ts` enforces that shape.
 */
export type SmokeReport = {
  cliVersion: number;
  smoke: "retrieval-select-unscored";
  sourceFingerprint: string;
  indexFingerprint: string;
  index: EmbeddingIdentity & { contentDigest: string; cards: number };
  runtime: { ortRuntimeVersion: string };
  assets: SmokeAsset[];
  chromeVersion: string;
  host: string;
  cacheEntriesBeforeLoad: number;
  loadMs: number;
  queryMs: number;
  selection: { outcome: "answer" | "clarify"; cards: number };
};

const route = "/__cv-model-smoke__.html";
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

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Requires a cached graph, tokenizer and config, each named by the pinned model's own files. */
function requireCachedKinds(assets: readonly SmokeAsset[]): void {
  const names = assets
    .filter((asset) => asset.url.includes(MODEL_PATH_PREFIX))
    .map((asset) => asset.url.split("/").pop() ?? "");

  if (!names.some((name) => name.endsWith(".onnx"))) throw new Error("cached-graph-missing");
  if (!names.some((name) => name.startsWith("tokenizer"))) throw new Error("cached-tokenizer-missing");
  if (!names.some((name) => name.startsWith("config"))) throw new Error("cached-config-missing");
}

/** The two runtime files must be exactly the bytes recorded in the project's own table. */
function requireRuntimeAssets(assets: readonly SmokeAsset[]): void {
  for (const expected of ORT_RUNTIME_ASSETS) {
    const url = `${ORT_ROUTE}${expected.name}`;
    const found = assets.find((asset) => asset.url === url);
    if (found === undefined || found.sha256 !== expected.sha256 || found.bytes !== expected.bytes) {
      throw new Error("runtime-asset-mismatch");
    }
  }
}

/**
 * The dev-server options behind the smoke's own server. The worker format and dependency
 * handling mirror the shipped dev server, the ONNX runtime comes from the same route plugin
 * the shipped server uses, and `server.headers` is the shipped isolation-header policy
 * (`vite.config.ts`) so every route the smoke serves, including the encoder worker script,
 * carries the same COOP/COEP headers as the shipped routes.
 */
export function smokeServerOptions(): InlineConfig {
  return {
    configFile: false,
    logLevel: "silent",
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      headers: crossOriginIsolationHeaders,
    },
    // Same worker format and dependency handling as the shipped dev server, so the
    // encoder worker and its library are served the way the app serves them.
    worker: { format: "es" },
    optimizeDeps: { include: ["@huggingface/transformers"], exclude: ["pocket-tts-js"] },
    plugins: [
      // The page's encoder loads the pinned ONNX Runtime from the same route, plugin and
      // bytes the shipped server serves; nothing else may serve that runtime.
      onnxRuntimeServePlugin(),
      {
        name: "isolated-model-smoke-page",
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url !== route) return next();
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            // This middleware answers directly, bypassing Vite's send paths where
            // `server.headers` applies, so the page route sets the pair itself.
            for (const [header, value] of Object.entries(crossOriginIsolationHeaders)) {
              response.setHeader(header, value);
            }
            response.end(html);
          });
        },
      },
    ],
  };
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
    const sourceFingerprint = sha256(source);
    if (sourceFingerprint !== FROZEN_CV_SHA256) throw new Error("source-snapshot-stale");

    stage = "index";
    const artifactBytes = await readFile(new URL("../resources/cv/facts.json", import.meta.url));
    const indexFingerprint = sha256(artifactBytes);
    let artifact: unknown;
    try {
      artifact = JSON.parse(artifactBytes.toString("utf8"));
    } catch {
      throw new Error("index-unparsable");
    }
    // The same validation the shipped import runs, here before any browser is owned, plus
    // the digest the artifact records: an index built from another source never launches.
    readReviewedIndex(artifact);
    const parsed = artifact as { source?: { sha256?: unknown }; embedding?: { contentSha256?: unknown }; cards?: unknown[] };
    if (parsed.source?.sha256 !== sourceFingerprint) throw new Error("index-source-drift");
    if (!Array.isArray(parsed.cards) || parsed.cards.length === 0) throw new Error("index-empty");
    if (typeof parsed.embedding?.contentSha256 !== "string") throw new Error("index-content-digest");
    const cards = parsed.cards.length;
    const contentDigest = parsed.embedding.contentSha256;

    stage = "startup";
    const startServer = dependencies.createServer ?? createServer;
    server = await startServer(smokeServerOptions());
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("server-unavailable");

    const launch = dependencies.launchBrowser ?? chromium.launch.bind(chromium);
    // No WebGPU: retrieval runs on the CPU encoder in WebAssembly.
    browser = await launch({ channel: "chrome", headless: false });
    const context = await browser.newContext({ serviceWorkers: "block" });
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}${route}`);

    stage = "index";
    const closeOnTimeout = () => { void browser?.close().catch(() => {}); };
    const pageIndex = await within(page.evaluate(() => window.__cvSmoke.loadIndex()), MODEL_TIMEOUT_MS, closeOnTimeout);
    if (
      pageIndex.cards !== cards ||
      pageIndex.contentDigest !== contentDigest ||
      (Object.keys(EXPECTED_EMBEDDING) as (keyof EmbeddingIdentity)[]).some(
        (key) => pageIndex.identity[key] !== EXPECTED_EMBEDDING[key],
      )
    ) {
      throw new Error("index-page-mismatch");
    }

    stage = "model-load";
    const cacheEntriesBeforeLoad = await page.evaluate(async () => {
      let count = 0;
      for (const name of await caches.keys()) count += (await (await caches.open(name)).keys()).length;
      return count;
    });
    const loaded = await within(page.evaluate(() => window.__cvSmoke.loadEncoder()), MODEL_TIMEOUT_MS, closeOnTimeout);
    requireCachedKinds(loaded.assets);
    requireRuntimeAssets(loaded.assets);

    stage = "query";
    const selection = await within(page.evaluate(() => window.__cvSmoke.ask()), QUERY_TIMEOUT_MS, closeOnTimeout);
    if (selection.cards < 1) throw new Error("empty-selection");

    return {
      cliVersion: 3,
      smoke: "retrieval-select-unscored",
      sourceFingerprint,
      indexFingerprint,
      index: { ...EXPECTED_EMBEDDING, contentDigest, cards },
      runtime: { ortRuntimeVersion: ORT_RUNTIME_VERSION },
      assets: loaded.assets,
      chromeVersion: browser.version(),
      host: hostname(),
      cacheEntriesBeforeLoad,
      loadMs: loaded.loadMs,
      queryMs: selection.queryMs,
      selection: { outcome: selection.outcome, cards: selection.cards },
    };
  } catch {
    throw new SmokeFailure(stage);
  } finally {
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
      loadIndex: () => Promise<{ cards: number; contentDigest: string; identity: EmbeddingIdentity }>;
      loadEncoder: () => Promise<{ assets: SmokeAsset[]; loadMs: number }>;
      ask: () => Promise<{ queryMs: number; outcome: "answer" | "clarify"; cards: number }>;
    };
  }
}
