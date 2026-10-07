/**
 * The smoke harness itself, through the exported `run` with a faked page side.
 *
 * The page's engine surface is mocked so no model loads, the cache stub feeds the pinned
 * revision URLs the shipped encoder would leave behind, and the two ONNX runtime files come
 * from the real route plugin, so the runtime digests the report records are the shipped
 * ones. What this proves is the harness contract: allow-listed failure stages, a
 * nonempty-selection rule, a report whose every leaf is technical metadata, and owned
 * browser and server cleanup on success and on each failure.
 */
import assert from "node:assert/strict";
import { hostname } from "node:os";
import test from "node:test";
import { createServer } from "vite";
import type { Browser, LaunchOptions } from "playwright-core";
import { chromium } from "playwright-core";
import type { InlineConfig, Plugin, ViteDevServer } from "vite";
import {
  FROZEN_CV_SHA256,
  run,
  SmokeFailure,
  type SmokeReport,
} from "../scripts/cv-model-evaluate.ts";
import { EXPECTED_EMBEDDING, MODEL_PATH_PREFIX } from "../src/chat/retrieval/index.ts";
import { ORT_ROUTE, ORT_RUNTIME_VERSION } from "../src/chat/retrieval/encoder/runtime-assets.ts";

const failureMarker = "private failure detail";
const answerMarker = "private answer";

type Scenario =
  | "success"
  | "load-failure"
  | "query-failure"
  | "empty-output"
  | "empty-selection"
  | "clarify-selection";

const SCENARIOS: readonly Scenario[] = [
  "success",
  "load-failure",
  "query-failure",
  "empty-output",
  "empty-selection",
  "clarify-selection",
];

/** The engine entry points the page uses, faked per scenario. The answer text never leaves. */
function mockEngine(scenario: Scenario): string {
  const throwAtLoad = scenario === "load-failure";
  const throwAtQuery = scenario === "query-failure";
  const choices = `[{ cardId: "card-a", topic: "topic a", score: 0.5 }, { cardId: "card-b", topic: "topic b", score: 0.4 }]`;

  const result =
    scenario === "clarify-selection"
      ? `{ kind: "clarify", choices: ${choices} }`
      : scenario === "empty-selection"
        ? `{ kind: "rephrase", matching: "semantic" }`
        : `{ kind: "answer", cardId: "card-a", topic: "topic a", answer: ${JSON.stringify(answerMarker)}, matching: "semantic", weak: false }`;

  const returned =
    scenario === "empty-output" ? '"   "' : scenario === "empty-selection" ? '""' : scenario === "clarify-selection" ? '""' : JSON.stringify(answerMarker);

  return `export const voiceEngine = {
  states: { encoder: "ready" },
  ensureEncoder: async () => { if (${String(throwAtLoad)}) throw new Error(${JSON.stringify(failureMarker)}); },
  pendingChoices: () => ${scenario === "clarify-selection" ? `(${choices})` : "null"},
  ask: async (_question, options) => {
    if (${String(throwAtQuery)}) throw new Error(${JSON.stringify(failureMarker)});
    const result = ${result};
    options.onResult(result);
    return ${returned};
  },
};`;
}

function mockRuntime(scenario: Scenario): Plugin {
  const pinnedPrefix = MODEL_PATH_PREFIX;
  // The three cached kinds the report requires, at the site-absolute model route the loader
  // now reads them from, the same shape as the `/ort/` paths the page fetches below.
  const cachedRequests = [
    `${pinnedPrefix}onnx/model_quantized.onnx`,
    `${pinnedPrefix}tokenizer.json`,
    `${pinnedPrefix}config.json`,
  ];

  return {
    name: "smoke-test-runtime",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "../src/chat/engine" && importer?.endsWith("scripts/cv-model-page.ts")) {
        return "\0smoke-engine";
      }
      return null;
    },
    load(id) {
      if (id === "\0smoke-engine") return mockEngine(scenario);
      return null;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== "/__cv-model-smoke__.html") return next();
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        response.end(`<!doctype html><html><body><script>
          const requests = ${JSON.stringify(cachedRequests)}.map((url) => ({ url }));
          Object.defineProperty(globalThis, "caches", { configurable: true, value: {
            keys: async () => ["smoke"],
            open: async () => ({
              keys: async () => requests,
              match: async (request) => new Response(request.url.endsWith(".onnx") ? "graph-bytes" : "asset-bytes"),
            }),
          } });
        </script><script type="module" src="/scripts/cv-model-page.ts"></script></body></html>`);
      });
    },
  };
}

/** Every string leaf must be a digest, a pinned value, an enum, a URL path or a version. */
const PINNED_VALUES = new Set<string>([
  ...Object.values(EXPECTED_EMBEDDING).map((value) => String(value)),
  ORT_RUNTIME_VERSION,
]);
const ENUM_VALUES = new Set<string>(["retrieval-select-unscored", "answer", "clarify"]);
const DENIED_KEYS = new Set<string>([
  "question",
  "questions",
  "prompt",
  "answer",
  "answers",
  "reply",
  "replies",
  "transcript",
  "message",
  "messages",
  "choice",
  "choices",
  "topic",
  "note",
  "notes",
  "text",
  "probe",
  "input",
  "body",
  "snippet",
  "greeting",
  "cue",
]);
const HEX_DIGEST = /^[0-9a-f]{32,}$/;
const URL_PATH = /^(?:https?:\/\/[^\s?#]+|\/[^\s?#]+)$/;
const VERSION = /^(?:Chrome\/)?\d+(?:\.\d+)+$/;

function walkLeaves(value: unknown, path: string, key: string): void {
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walkLeaves(entry, `${path}[${index}]`, ""));
      return;
    }
    for (const [childKey, child] of Object.entries(value)) {
      walkLeaves(child, `${path}.${childKey}`, childKey);
    }
    return;
  }

  if (key !== "") {
    assert.equal(DENIED_KEYS.has(key.toLowerCase()), false, `${path} names conversational content`);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return;

  assert.equal(typeof value, "string", `${path} must be a string leaf`);
  const text = value as string;
  const technical =
    PINNED_VALUES.has(text) ||
    ENUM_VALUES.has(text) ||
    HEX_DIGEST.test(text) ||
    URL_PATH.test(text) ||
    VERSION.test(text) ||
    text === hostname();
  assert.equal(technical, true, `${path} carries a non-technical string`);
}

const reports: SmokeReport[] = [];

async function verifyRun(scenario: Scenario) {
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  let serverCloseCalls = 0;
  let browserCloseCalls = 0;
  let serverClosed = false;
  let browserClosed = false;

  const createOwnedServer = async (config: InlineConfig) => {
    server = await createServer({
      ...config,
      plugins: [mockRuntime(scenario), ...(config.plugins ?? [])],
    });
    return new Proxy(server, {
      get(target, property) {
        if (property === "close") {
          return async () => {
            serverCloseCalls++;
            await target.close();
            serverClosed = target.httpServer?.listening !== true;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const launchOwnedBrowser = async (options?: LaunchOptions) => {
    browser = await chromium.launch({ ...options, headless: true });
    return new Proxy(browser, {
      get(target, property) {
        if (property === "close") {
          return async () => {
            browserCloseCalls++;
            await target.close();
            browserClosed = !target.isConnected();
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };

  try {
    if (scenario === "success" || scenario === "clarify-selection") {
      const report = await run({ createServer: createOwnedServer, launchBrowser: launchOwnedBrowser });
      reports.push(report);
      const output = JSON.stringify(report);

      assert.equal(report.smoke, "retrieval-select-unscored");
      assert.equal(report.sourceFingerprint, FROZEN_CV_SHA256);
      assert.equal(report.runtime.ortRuntimeVersion, ORT_RUNTIME_VERSION);
      assert.equal(report.cacheEntriesBeforeLoad, 3);
      assert.equal(report.index.cards > 0, true);
      assert.equal(report.assets.filter((asset) => asset.url.startsWith(MODEL_PATH_PREFIX)).length, 3);
      assert.equal(report.assets.filter((asset) => asset.url.startsWith(ORT_ROUTE)).length, 2);
      assert.ok(!output.includes(failureMarker) && !output.includes(answerMarker));

      if (scenario === "success") {
        assert.deepEqual(report.selection, { outcome: "answer", cards: 1 });
      } else {
        assert.deepEqual(report.selection, { outcome: "clarify", cards: 2 });
      }
    } else {
      let failure: unknown;
      try {
        await run({ createServer: createOwnedServer, launchBrowser: launchOwnedBrowser });
      } catch (error) {
        failure = error;
      }
      assert.ok(failure instanceof SmokeFailure, `${scenario}: run() must reject with SmokeFailure`);
      const expectedStage = scenario === "load-failure" ? "model-load" : "query";
      assert.equal(failure.stage, expectedStage);
      assert.equal(failure.message, `smoke-${expectedStage}-failed`);
      assert.ok(!failure.message.includes(failureMarker) && !failure.message.includes(answerMarker));
    }

    assert.equal(serverCloseCalls, 1, `${scenario}: run() must close its own Vite server`);
    assert.equal(browserCloseCalls, 1, `${scenario}: run() must close its own browser`);
    assert.equal(serverClosed, true, `${scenario}: Vite server must be closed before run() returns`);
    assert.equal(browserClosed, true, `${scenario}: browser must be closed before run() returns`);
  } finally {
    // Fallback cleanup happens after the assertions and cannot satisfy them.
    if (browser && !browserClosed) await browser.close().catch(() => {});
    if (server && !serverClosed) await server.close().catch(() => {});
  }
}

test("run() closes its own server and browser on success and on every failure stage", async () => {
  for (const scenario of SCENARIOS) {
    await verifyRun(scenario);
  }
});

test("every report leaf is technical metadata with no conversational shape", async () => {
  assert.equal(reports.length, 2, "both successful scenarios must have produced a report");
  for (const report of reports) {
    walkLeaves(report, "report", "");
    assert.equal(report.host, hostname());
    assert.equal(report.loadMs >= 0 && report.queryMs >= 0, true);
  }
});
