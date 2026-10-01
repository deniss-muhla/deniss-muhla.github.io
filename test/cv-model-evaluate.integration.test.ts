import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import type { Browser, LaunchOptions } from "playwright-core";
import { chromium } from "playwright-core";
import type { InlineConfig, Plugin, ViteDevServer } from "vite";
import { FROZEN_CV_SHA256, run, SmokeFailure } from "../scripts/cv-model-evaluate.ts";

const failureMarker = "private failure detail";
type Scenario = "success" | "load-failure" | "generation-failure" | "empty-output";

function mockRuntime(scenario: Scenario): Plugin {
  const throwAtLoad = scenario === "load-failure";
  const throwAtGeneration = scenario === "generation-failure";
  const emptyOutput = scenario === "empty-output";
  const engine = `export const voiceEngine = {
    modelLabel: "smoke-model",
    llmAssets: {
      modelId: "smoke-model",
      modelUrl: "https://model.test/smoke/",
      libraryUrl: "https://wasm.test/smoke.wasm"
    },
    ensureLlm: async () => { if (${throwAtLoad}) throw new Error(${JSON.stringify(failureMarker)}); },
    ask: async () => { if (${throwAtGeneration}) throw new Error(${JSON.stringify(failureMarker)}); return ${emptyOutput ? '"  "' : '"private answer"'}; }
  };`;

  return {
    name: "smoke-test-runtime",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "../src/chat/engine" && importer?.endsWith("scripts/cv-model-page.ts")) return "\0smoke-engine";
    },
    load(id) {
      if (id === "\0smoke-engine") return engine;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith("/__cv-model-smoke__.html")) return next();
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        response.end(`<!doctype html><html><body><script>
          Object.defineProperty(navigator, "gpu", { configurable: true, value: {
            requestAdapter: async () => ({ features: new Set() })
          } });
          const requests = [
            { url: "https://model.test/smoke/weights.bin" },
            { url: "https://wasm.test/smoke.wasm" }
          ];
          Object.defineProperty(globalThis, "caches", { configurable: true, value: {
            keys: async () => ["smoke"],
            open: async () => ({ keys: async () => requests, match: async (request) =>
              new Response(request.url.endsWith(".wasm") ? "wasm-bytes" : "weight-bytes") })
          } });
        </script><script type="module" src="/scripts/cv-model-page.ts"></script></body></html>`);
      });
    },
  };
}

async function verifyRun(scenario: Scenario) {
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  let serverCloseCalls = 0;
  let browserCloseCalls = 0;
  let serverClosed = false;
  let browserClosed = false;

  const createOwnedServer = async (config: InlineConfig) => {
    server = await createServer({ ...config, plugins: [mockRuntime(scenario), ...(config.plugins ?? [])] });
    return new Proxy(server, {
      get(target, property) {
        if (property === "close") return async () => {
          serverCloseCalls++;
          await target.close();
          serverClosed = !target.httpServer?.listening;
        };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const launchOwnedBrowser = async (options?: LaunchOptions) => {
    browser = await chromium.launch({ ...options, headless: true });
    return new Proxy(browser, {
      get(target, property) {
        if (property === "close") return async () => {
          browserCloseCalls++;
          await target.close();
          browserClosed = !target.isConnected();
        };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };

  try {
    if (scenario === "success") {
      const report = await run({ createServer: createOwnedServer, launchBrowser: launchOwnedBrowser });
      const output = JSON.stringify(report);
      assert.equal(report.smoke, "generation-complete-unscored");
      assert.equal(report.modelId, "smoke-model");
      assert.equal(report.cachedAssets.length, 2);
      assert.equal(report.sourceFingerprint, FROZEN_CV_SHA256);
      assert.ok(!output.includes(failureMarker) && !output.includes("private answer"));
    } else {
      let failure: unknown;
      try {
        await run({ createServer: createOwnedServer, launchBrowser: launchOwnedBrowser });
      } catch (error) {
        failure = error;
      }
      assert.ok(failure instanceof SmokeFailure);
      assert.equal(failure.stage, scenario === "load-failure" ? "model-load" : "generation");
      assert.ok(!failure.message.includes(failureMarker));
    }

    assert.equal(serverCloseCalls, 1, `${scenario}: run() must close its own Vite server`);
    assert.equal(browserCloseCalls, 1, `${scenario}: run() must close its own browser`);
    assert.equal(serverClosed, true, `${scenario}: Vite server must be closed before run() returns`);
    assert.equal(browserClosed, true, `${scenario}: browser must be closed before run() returns`);
  } finally {
    // Fallback cleanup happens after the assertions and cannot satisfy them.
    if (browser && !browserClosed) await browser.close();
    if (server && !serverClosed) await server.close();
  }
}

test("run() closes its owned browser and server on success and model/generation failures", async () => {
  for (const scenario of ["success", "load-failure", "generation-failure", "empty-output"] as const) {
    await verifyRun(scenario);
  }
});
