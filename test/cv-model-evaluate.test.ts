import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createServer } from "vite";
import {
  FROZEN_CV_SHA256,
  MODEL_TIMEOUT_MS,
  QUERY_TIMEOUT_MS,
  SmokeFailure,
  SMOKE_OUTER_TIMEOUT_SECONDS,
  smokeServerOptions,
} from "../scripts/cv-model-evaluate.ts";
import { ORT_ROUTE, ORT_RUNTIME_ASSETS } from "../src/chat/retrieval/encoder/runtime-assets.ts";
import { retrievalText } from "../scripts/cv-facts/artifact.mjs";

const engineUrl = new URL("../src/chat/engine.ts", import.meta.url);
const pageUrl = new URL("../scripts/cv-model-page.ts", import.meta.url);
// The canonical source only: the check compares digests and never copies CV text.
const canonicalCvUrl = new URL("../resources/cv/source/cv.md", import.meta.url);

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("the canonical CV source matches the frozen independent digest", async () => {
  assert.equal(sha256(await readFile(canonicalCvUrl)), FROZEN_CV_SHA256);
});

test("the source digest check fails a simulated source change and passes the unchanged source", async () => {
  const source = await readFile(canonicalCvUrl);
  // Unchanged source passes.
  assert.equal(sha256(source), FROZEN_CV_SHA256);

  // A simulated content edit fails, so a CV change forces a deliberate digest review.
  const factEdit = Buffer.from(source.toString("utf8").replace(/(?<=^# )\S+/m, "Changed"));
  assert.ok(!factEdit.equals(source), "simulated edit must change source bytes");
  assert.notEqual(sha256(factEdit), FROZEN_CV_SHA256);

  // Trailing whitespace fails too: the digest watches raw bytes, not normalized text.
  const trailingWhitespace = Buffer.concat([source, Buffer.from(" ")]);
  assert.notEqual(sha256(trailingWhitespace), FROZEN_CV_SHA256);
});

test("the smoke deadline allows encoder load, query and resource cleanup", () => {
  assert.ok(SMOKE_OUTER_TIMEOUT_SECONDS * 1_000 > MODEL_TIMEOUT_MS + QUERY_TIMEOUT_MS + 60_000);
});

test("every route the smoke server serves carries the cross-origin isolation headers", { timeout: 60_000 }, async (t) => {
  const server = await createServer(smokeServerOptions());
  t.after(() => server.close());
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== "string");

  // The page, the encoder worker script (the route Chrome blocked with
  // `coep-frame-resource-needs-coep-header`) and a pinned runtime asset.
  const routes = [
    "/__cv-model-smoke__.html",
    "/src/chat/retrieval/encoder/worker.ts?worker_file&type=module",
    `${ORT_ROUTE}${ORT_RUNTIME_ASSETS[0].name}`,
  ];

  for (const path of routes) {
    const response: Response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin", path);
    assert.equal(response.headers.get("cross-origin-embedder-policy"), "require-corp", path);
    await response.arrayBuffer();
  }
});

test("the smoke reports only fixed failure stages", () => {
  for (const stage of ["source", "index", "startup", "model-load", "query"] as const) {
    const failure = new SmokeFailure(stage);
    assert.equal(failure.stage, stage);
    assert.equal(failure.message, `smoke-${stage}-failed`);
  }
});

test("the page probe rebuilds the artifact's retrieval text from the same fields", async () => {
  const card = { id: "card", topic: "Topic", tags: ["alpha", "beta"], answer: "Answer." };
  // The page derives its technical probe from the loaded card; this pins the join to
  // retrieval text v1, the text the card vectors were embedded from.
  assert.equal(retrievalText(card), `${card.topic}\n${card.tags.join(", ")}\n${card.answer}`);
  const page = await readFile(pageUrl, "utf8");
  assert.ok(page.includes("card.tags.join(\", \")"));
  assert.ok(page.includes("voiceEngine.ask(probe"));
});

test("the smoke question never enters the page contract or the report", async () => {
  const evaluate = await readFile(new URL("../scripts/cv-model-evaluate.ts", import.meta.url), "utf8");
  const page = await readFile(pageUrl, "utf8");
  // The host passes no question into the page, and the page returns no answer text: the
  // only cross-boundary calls are index, encoder and selection metadata. A non-empty
  // argument inside `ask(` is what would carry a question across.
  assert.equal(/page\.evaluate\(\([^)]*\)\s*=>[^)]*ask\([^)]+\)/.test(evaluate), false);
  assert.ok(evaluate.includes("window.__cvSmoke.ask()"));
  assert.ok(!page.includes("return answer"));
  assert.ok(!/smoke: "[^"]*generation/.test(evaluate));
});

test("the engine holds no path to the retired WebLLM runtime", async () => {
  const engine = await readFile(engineUrl, "utf8");
  assert.ok(!engine.includes("@mlc-ai/web-llm"), "no WebLLM import may remain in the engine");
  assert.ok(!engine.includes("ensureLlm"), "the retired answer-model loader must be gone");
  assert.ok(!/\bllm\b/.test(engine), "no llm state or slot may remain in the engine");
});
