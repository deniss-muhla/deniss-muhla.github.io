import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import test from "node:test";
import { createServer } from "vite";
import { FROZEN_CV_SHA256, SmokeFailure, SMOKE_OUTER_TIMEOUT_SECONDS } from "../scripts/cv-model-evaluate.ts";

const engineUrl = new URL("../src/chat/engine.ts", import.meta.url);
const chatUrl = new URL("../src/chat/VoiceChat.tsx", import.meta.url);
const workerUrl = new URL("../public/sw.js", import.meta.url);
const pairUrl = new URL("../public/models/trlm-135m/", import.meta.url);
// WebLLM fetches every asset from `<model url>/resolve/main/`, so that is where
// the weights live; the licenses and the provenance sit beside the directory.
const pairWeightsUrl = new URL("./resolve/main/", pairUrl);
const snapshotUrl = new URL("./cv-context.public-cv.snapshot.md", import.meta.url);

test("the smoke fingerprint matches the frozen public-CV prompt snapshot", async () => {
  const snapshot = await readFile(snapshotUrl);
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha256").update(snapshot).digest("hex"), FROZEN_CV_SHA256);
});

test("the smoke deadline allows model load, generation and resource cleanup", () => {
  assert.ok(SMOKE_OUTER_TIMEOUT_SECONDS * 1_000 > 240_000 + 90_000 + 60_000);
});

test("the smoke reports only fixed failure stages", () => {
  for (const stage of ["source", "startup", "model-load", "generation"] as const) {
    const failure = new SmokeFailure(stage);
    assert.equal(failure.stage, stage);
    assert.equal(failure.message, `smoke-${stage}-failed`);
  }
});

test("the production answer model is the pair this repository ships", async () => {
  const engine = await readFile(engineUrl, "utf8");
  assert.match(engine, /const LLM_MODEL_ID = "trlm-135m-q4f32_1";/);
  // Served from the site root, which assumes this site is served from the
  // domain root; the project sets no Vite `base`, so BASE_URL is "/". WebLLM
  // needs absolute URLs, so the page origin is added when the pair is asked for.
  assert.match(engine, /const LLM_MODEL_PATH = `\$\{import\.meta\.env\.BASE_URL\}models\/trlm-135m\/resolve\/main\/`;/);
  assert.match(engine, /modelUrl: `\$\{window\.location\.origin\}\$\{LLM_MODEL_PATH\}`,/);
  assert.match(engine, /libraryUrl: `\$\{window\.location\.origin\}\$\{LLM_MODEL_PATH\}\$\{LLM_LIBRARY_NAME\}`,/);
  // One branch selects the pair, and no prebuilt registry can answer instead, so
  // a broken or absent candidate cannot be hidden behind another model.
  assert.match(engine, /const pair = llmPreview\(\) \?\? productionPair\(\);/);
  assert.match(engine, /appConfig: localAppConfig\(pair\)/);
  assert.doesNotMatch(engine, /prebuiltAppConfig/);
  assert.doesNotMatch(engine, /SmolLM2/);
});

const previewModel = "trlm-135m-q4f32_1";
// The page origin the previewed pair has to be served from. The site is cross
// origin isolated and served over https, so a pair on any other origin is mixed
// content or a blocked fetch, and a third party must not be able to choose the
// bytes this site downloads, executes and caches.
const pageOrigin = "http://127.0.0.1:4173";
const previewPair = `?llmPreview=1&llmModelUrl=${pageOrigin}/trlm-135m/resolve/main/&llmWasmUrl=${pageOrigin}/webgpu/trlm-135m-q4f32_1-webgpu.wasm`;

// The shipping engine module, loaded the way the app loads it. Only the model
// selection is called here; the prompt module it imports is never inspected.
async function loadEngineModule() {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
    logLevel: "error",
  });
  try {
    return await server.ssrLoadModule("/src/chat/engine.ts");
  } finally {
    await server.close();
  }
}

test("the answer model stays the production one unless the preview is asked for", async () => {
  const { PREVIEW_FLAG, previewRequest } = await loadEngineModule();
  assert.equal(PREVIEW_FLAG, "llmPreview");
  for (const search of [
    "",
    "?stt=tiny",
    "?voiceDebug=1",
    "?llmPreview=0",
    "?llmPreview=false",
    "?llmPreview=1x",
  ]) {
    assert.deepEqual(previewRequest(search, pageOrigin), { state: "off" }, search);
  }
});

test("the requested preview selects the candidate pair from the given URLs", async () => {
  const { previewRequest } = await loadEngineModule();
  assert.deepEqual(previewRequest(previewPair, pageOrigin), {
    state: "on",
    modelId: previewModel,
    modelUrl: `${pageOrigin}/trlm-135m/resolve/main/`,
    libraryUrl: `${pageOrigin}/webgpu/trlm-135m-q4f32_1-webgpu.wasm`,
  });
});

test("an incomplete or unusable preview request names what it needs", async () => {
  const { previewRequest } = await loadEngineModule();
  assert.deepEqual(previewRequest("?llmPreview=1", pageOrigin), {
    state: "incomplete",
    modelId: previewModel,
    missing: "llmModelUrl and llmWasmUrl",
  });
  assert.deepEqual(
    previewRequest(`?llmPreview=1&llmModelUrl=${pageOrigin}/trlm-135m/resolve/main/`, pageOrigin),
    { state: "incomplete", modelId: previewModel, missing: "llmWasmUrl" },
  );
  const good = `${pageOrigin}/trlm-135m/resolve/main/`;
  const wasm = `${pageOrigin}/pair.wasm`;
  for (const broken of [
    // Not absolute, not http(s), wrong path suffix, on another origin, and the
    // query and fragment cases: WebLLM 0.2.85 concatenates the weights URL with
    // every asset name and resolves the config against it, so a query or a
    // fragment ends up inside an asset path.
    `?llmPreview=1&llmModelUrl=trlm-135m/resolve/main/&llmWasmUrl=${wasm}`,
    `?llmPreview=1&llmModelUrl=javascript:alert(1)/&llmWasmUrl=${wasm}`,
    `?llmPreview=1&llmModelUrl=${pageOrigin}/trlm-135m/resolve/main/mlc-chat-config.json&llmWasmUrl=${wasm}`,
    `?llmPreview=1&llmModelUrl=https://preview.invalid/trlm-135m/resolve/main/&llmWasmUrl=${wasm}`,
    `?llmPreview=1&llmModelUrl=${good}&llmWasmUrl=https://preview.invalid/pair.wasm`,
    `?llmPreview=1&llmModelUrl=http://127.0.0.1:4174/trlm-135m/resolve/main/&llmWasmUrl=${wasm}`,
    `?llmPreview=1&llmModelUrl=${good}?token=abc&llmWasmUrl=${wasm}`,
    `?llmPreview=1&llmModelUrl=${good}%23frag&llmWasmUrl=${wasm}`,
    `?llmPreview=1&llmModelUrl=${good}&llmWasmUrl=${pageOrigin}/pair.wasm?v=1`,
    `?llmPreview=1&llmModelUrl=${good}&llmWasmUrl=${pageOrigin}/pair.wasm%23frag`,
  ]) {
    assert.equal(previewRequest(broken, pageOrigin).state, "incomplete", broken);
  }
});

test("the preview is read from the page URL, stored nowhere and reversed by the URL", async () => {
  const engine = await readFile(engineUrl, "utf8");
  assert.match(engine, /previewRequest\(window\.location\.search, window\.location\.origin\)/);
  assert.doesNotMatch(engine, /localStorage|sessionStorage|indexedDB/);
  // The preview is the only other branch and it never edits the production pair.
  assert.match(engine, /llmPreview\(\) \?\? productionPair\(\)/);
});

test("the interface says when the preview answers and how to leave it", async () => {
  const chat = await readFile(chatUrl, "utf8");
  assert.match(chat, /data-testid="preview-notice"/);
  assert.match(chat, /instead of the assets this site ships/);
  assert.match(chat, /Remove \$\{PREVIEW_FLAG\} from the page URL and reload to go back\./);
  assert.match(chat, /preview\.state !== "off"/);
});

/**
 * The seven files WebLLM 0.2.85 fetched from a cold cache with the production
 * build, with the recorded byte sizes and SHA-256 digests. The measurement is in
 * the private task 3.3 record `trlm-preview-33.json` (`requests.previewPairPaths`,
 * 7 cache entries) and `trlm-verify-314.json`.
 */
const deployedPair = [
  ["mlc-chat-config.json", 2212, "6cf1e49b0baf59ed74c7cdc2e7927bd2e5b6efd7849d81ff5f6dbb81202eb94a"],
  ["params_shard_0.bin", 33364872, "afb353dc6f247babeef77fcd56256ed3b00d313bae632c07b481656791f95728"],
  ["params_shard_1.bin", 32883840, "88180df97bf0f2d5f92673dc8a4fa40ef50e18d2ace39ed326b35a15efb59403"],
  ["params_shard_2.bin", 9467136, "25943fdff6acb653bd5bc25fa77f59929765ec73ec4f882fefe0c79f61723090"],
  ["tensor-cache.json", 115483, "f7c3ba6b54d316500cf22dba7df6a3f00637c55f7ac221224250775db56b5689"],
  ["tokenizer.json", 3523023, "67afd7bf266e40695a8d209874c82a88ff5ade32c7a96967ffa712e519757986"],
  [
    "trlm-135m-q4f32_1-webgpu.wasm",
    5677823,
    "2d21eb8f7c8bd231755e041e89793abb8536e63c8350bd33cdaab40e63c0e709",
  ],
] as const;

/**
 * Converted files the runtime never requested. WebLLM 0.2.85 loads the tokenizer
 * from `tokenizer.json` and the `q4f32_1` tensor cache from `tensor-cache.json`,
 * so shipping the rest of the conversion output would only add download weight.
 * They stay in the external working directory next to the checkpoint.
 */
const neverFetched = [
  "added_tokens.json",
  "merges.txt",
  "tensor-cache-b16.json",
  "tokenizer_config.json",
  "vocab.json",
];

// The panel toggle, split into the open branch and the close branch, so a
// regression can name which one does what.
function toggleBranches(source: string): { open: string; close: string } {
  const start = source.indexOf("setOpen((current) => {");
  const end = source.indexOf("return next;", start);
  assert.ok(start !== -1 && end !== -1, "the panel toggle must compute its next open state");
  const open = source.slice(start, end);
  const closeStart = source.indexOf("} else {", start);
  assert.ok(closeStart !== -1, "the panel toggle must have a close branch");
  return { open, close: source.slice(closeStart, end) };
}

function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `${signature} must exist`);
  const next = source.indexOf("\n  async ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test("opening the assistant starts the loading a metered session skipped", async () => {
  const { open, close } = toggleBranches(await readFile(chatUrl, "utf8"));

  // Without this the panel waits for a download that nothing ever starts.
  assert.match(open, /void voiceEngine\.loadRequiredModels\(\);/);
  // Closing stays a cleanup-only path: no load, and the existing stop path.
  assert.doesNotMatch(close, /loadRequiredModels/);
  assert.match(close, /stopAssistantWork\(\);/);
  assert.match(close, /void voiceEngine\.stopListening\(\);/);
  assert.match(close, /voiceEngine\.stopAudio\(\);/);
});

test("a metered connection still returns before any load starts", async () => {
  const chat = await readFile(chatUrl, "utf8");
  const gate = chat.indexOf("if (capabilities.saveData) {");
  const load = chat.indexOf("void voiceEngine.loadRequiredModels();", gate);
  assert.ok(gate !== -1 && load !== -1, "the prefetch path must exist");
  assert.ok(load > gate, "the load must sit behind the metered gate");
  assert.match(chat.slice(gate, load), /return;/);
});

test("required models report loading before the first await, from library events", async () => {
  const engine = await readFile(engineUrl, "utf8");
  const body = methodBody(engine, "async loadRequiredModels()");
  const mark = body.indexOf('setState(key, "loading")');
  const firstAwait = body.indexOf("await ");
  assert.ok(mark !== -1, "the required models must be marked loading when a load starts");
  assert.ok(firstAwait !== -1 && mark < firstAwait, "the loading states must precede any await");

  // Percentages stay the libraries' own reports, never a timer or a guess.
  assert.match(engine, /initProgressCallback: \(report\) => this\.setProgress\("llm", report\.progress \?\? 0\)/);
  assert.match(engine, /\.onProgress\(\(fraction\) => this\.setProgress\("stt", fraction\)\)/);
  assert.match(engine, /await tts\.load\(\(info\) => \{/);
});

test("the interface explains an unavailable model instead of claiming readiness", async () => {
  const chat = await readFile(chatUrl, "utf8");
  // Typed input stays usable in every message state.
  assert.match(chat, /data-testid="voice-input"/);
  assert.doesNotMatch(chat, /disabled=\{loading\}/);
  assert.match(chat, /if \(states\.llm === "error"\) \{/);
  assert.match(chat, /if \(states\.stt === "error"\) \{/);
  assert.match(chat, /if \(states\.tts === "error"\) \{/);
});

test("the repository ships the verified pair and nothing the runtime ignores", async () => {
  for (const [name, bytes, sha256] of deployedPair) {
    const data = await readFile(new URL(name, pairWeightsUrl));
    assert.equal(data.byteLength, bytes, name);
    assert.equal(createHash("sha256").update(data).digest("hex"), sha256, name);
  }
  for (const name of neverFetched) {
    await assert.rejects(readFile(new URL(name, pairWeightsUrl)), `${name} is never fetched`);
  }
  // GitHub blocks repository files at 100 MiB, and no LFS is configured.
  for (const entry of await readdir(pairUrl, { recursive: true })) {
    if (typeof entry !== "string") continue;
    assert.ok((await stat(new URL(entry, pairUrl))).size < 100 * 1024 * 1024, entry);
  }
});

test("the service worker passes the shipped model assets through", async () => {
  const worker = await readFile(workerUrl, "utf8");
  const passThrough = worker.indexOf('url.pathname.startsWith("/models/")');
  const handled = worker.indexOf("event.respondWith(handleSameOrigin(request, url))");
  assert.ok(passThrough !== -1, "the worker must skip the runtime's own model cache");
  assert.ok(passThrough < handled, "the skip has to happen before the worker responds");
});
