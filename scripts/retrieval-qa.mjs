/**
 * Headed-Chrome check for the embedding query path (task 5.3).
 *
 * It drives one private page that exists only for this check, in both routings the site
 * actually ships: the Vite dev server, and the built static artifact served the way GitHub
 * Pages serves it, with no COOP/COEP headers. Both are the real delivered bytes, not
 * assertions about source.
 *
 * The workload is small and frozen. It is the separate case set from the accepted external
 * probe, read from that workspace and checked against its recorded digest, so nothing here
 * duplicates a fixture into the repository and a changed fixture fails instead of passing
 * quietly. The cards are synthetic and say so; no CV text, visitor question, transcript or
 * answer is returned, logged or written. What a report keeps is case ids, card ids, scores,
 * dimensions, norms, timings, digests and outcomes.
 *
 * The same workspace records the admitted model identity: the digests of the six files the
 * generator read, and the configuration values it observed. This harness pins them, checks
 * that the admitted artifact still agrees, and compares the bytes the browser consumed
 * against them. That is three independent sides, so a constant compared with itself cannot
 * stand in as identity proof.
 *
 * The one value that accepted report does not carry is the vocabulary: `identity.model` has
 * no vocabulary key, and a historical report is not regenerated to add one. That value is
 * authenticated from the cached `config.json` the generator actually read, on byte count and
 * SHA-256 against the same pinned digest the report's own asset record names, before the
 * file is parsed. The harness and the browser still compare the same vocabulary, so the
 * three-way identity keeps four values instead of three.
 *
 * Every wait is bounded from this process. `page.evaluate` waits for the page's reply and
 * only gives up when the page goes away, so a stalled load or question would hang the run
 * before it could report anything; the 120-second load, 10-second per-question and
 * whole-run bounds live in `./qa-deadlines.ts` and can be shortened through the environment
 * for a check that needs to see a deadline fail. An override is a positive whole number of
 * milliseconds; anything else is refused and the declared bound stands. The startup shares one
 * load bound across the navigation, the page's own API and the delivery barrier, and refuses an
 * expired budget before it accepts a ready document. The browser and the server this run
 * started are closed on success and on failure through one cleanup ledger, and the
 * whole-run deadline drains that same ledger before it settles, so a wait that never
 * answers cannot leave the run's browser and server open. Each of them is owned from the
 * moment it is acquired rather than once it exists, so one that arrives after the deadline
 * is closed on arrival and reported beside the deadline that gave up on it.
 *
 * The production routing uses the real service worker: the private page loads the site's own
 * `/sw-register.js`, so isolation is the worker's doing on a static server that sends no
 * COOP/COEP headers, and the harness records those same headers from outside the browser as
 * the control.
 *
 * One input is embedded first and inspected before the bounded workload starts, and the
 * model is loaded once, cold, so the warm figures are the same as the cold ones unless the
 * second routing reuses the same browser profile.
 *
 *   node scripts/retrieval-qa.mjs --routing=dev
 *   RETRIEVAL_QA=1 pnpm build && node scripts/retrieval-qa.mjs --routing=built
 *   node scripts/voice-qa.mjs --qa=retrieval --routing=built
 *
 * Environment: PROBE_DIR, RETRIEVAL_QA_OUT, RETRIEVAL_QA_PROFILE, QA_HEADLESS, CHROME_CHANNEL,
 * RETRIEVAL_QA_PORT, RETRIEVAL_QA_LOAD_MS, RETRIEVAL_QA_QUERY_MS, RETRIEVAL_QA_RUN_MS. A second
 * profile directory gives a cold run against the same origin. The browser profile, both
 * servers and the report live outside the repository.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { ADAPTER_CONTRACT } from "../scripts/cv-facts/embedding.mjs";
import { selectAnswer, RELEVANCE_FLOOR, CONFIDENCE, CONFIDENCE_MARGIN } from "../src/chat/retrieval/selection.ts";
import { EXPECTED_EMBEDDING } from "../src/chat/retrieval/index.ts";
import { ORT_WASM_PATHS } from "../src/chat/retrieval/encoder/runtime-assets.ts";
import { MODEL_ASSET_SETS } from "./model-assets.mjs";
import { QaDeadlineError, qaLimits, withDeadline, withOwnedDeadline } from "./qa-deadlines.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROBE_DIR = process.env.PROBE_DIR ?? "/home/den/.cache/cv-assistant/retrieval-first-probe-mxbai";
const OUT_DIR = process.env.RETRIEVAL_QA_OUT ?? "/home/den/.cache/cv-assistant/retrieval-first-group5";
const PROFILE_DIR = process.env.RETRIEVAL_QA_PROFILE ?? join(OUT_DIR, "browser-profile");
const HEADLESS = process.env.QA_HEADLESS === "true";
const CHROME_CHANNEL = process.env.CHROME_CHANNEL ?? "chrome";

/** The self-host proof asks the browser to resolve no host but the site's own and the one exception. */
const BLOCK_OFF_ORIGIN = process.env.QA_BLOCK_OFF_ORIGIN === "1";
const OFF_ORIGIN_BLOCK_FLAG =
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE download.moonshine.ai";

/**
 * The frozen fixture and identity digests. A changed fixture or a moved admitted artifact
 * is a failure, not a new measurement.
 *
 * The model files are the generator's recorded digests for the pinned commit, pinned here
 * as well so the admitted workspace file, these values and the bytes the browser consumed
 * are three separate things that must agree.
 */
const FROZEN = Object.freeze({
  cases: "827c43a7a76bc5c0cdeb4c36a60e8250a5653ed1f97733c23a1e49c8eb03c091",
  modelAssets: Object.freeze([
    { name: "config.json", bytes: 675, sha256: "55f755d351fd04b0fef37760e07e195eb47e15f7aed6fc42d9be3dde3d38bca4" },
    { name: "tokenizer.json", bytes: 711_661, sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0" },
    { name: "tokenizer_config.json", bytes: 1_433, sha256: "bd2e06a5b20fd1b13ca988bedc8763d332d242381b4fbc98f8fead4524158f79" },
    { name: "special_tokens_map.json", bytes: 695, sha256: "5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a" },
    { name: "vocab.txt", bytes: 231_508, sha256: "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3" },
    { name: "onnx/model_quantized.onnx", bytes: 24_448_010, sha256: "952f996d8cf46c311ee8654a750fa942b71c8b94aabe69d043dbb2bcaff5528e" },
  ]),
  /**
   * The pinned configuration, keyed the way the accepted report keys what it recorded and
   * read from the authenticated `config.json` for the one value it never recorded. These are
   * the values the browser's own observed config is compared against later.
   */
  observedConfig: Object.freeze({
    hiddenSize: 384,
    modelType: "bert",
    maxPositionEmbeddings: 4_096,
    /** `vocab_size` in the admitted `config.json`. The accepted report has no vocabulary key. */
    vocabularySize: 30_522,
  }),
  observedTokenizer: Object.freeze({ modelMaxLength: 512, truncationSide: "right", paddingSide: "right" }),
  /** The generator's recorded byte count for the pinned runtime file. */
  ortWasmBytes: 28_352_885,
});

/**
 * The pinned model identity, as the gate reads it.
 *
 * A browser-free check that drives the run to its final gate has to build a fixture the
 * identity checks pass, and those checks compare the consumed bytes against this pin. It is
 * exported rather than copied into a check, so a check's fixture cannot drift from the values
 * it is judged against.
 */
export const pinnedModelIdentity = Object.freeze({
  modelAssets: FROZEN.modelAssets,
  observedConfig: FROZEN.observedConfig,
  observedTokenizer: FROZEN.observedTokenizer,
  ortWasmBytes: FROZEN.ortWasmBytes,
});

/** The recorded cross-runtime tolerance from the frozen gate. Not a tuning target. */
const VECTOR_TOLERANCE = 1e-4;
const NORM_TOLERANCE = 1e-4;
const ARTIFACT_DECIMALS = 6;

/**
 * The declared bounds, overridable so a check can see a deadline fail without waiting it out.
 *
 * The environment names only shorten the bounds. A check that has to prove the real
 * 120-second and 10-second limits still waits for them.
 */
export function readLimits(env = process.env) {
  // A bound is a count of milliseconds, so only a positive finite integer is one. A zero, a
  // fraction, a negative value and a name that does not resolve to a positive finite integer
  // are all refused, which is what keeps an override able to shorten a declared bound and
  // never to lengthen it or make it fractional.
  const number = (name) => {
    const value = Number(env[name]);

    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  };
  const loadMs = number("RETRIEVAL_QA_LOAD_MS");
  const queryMs = number("RETRIEVAL_QA_QUERY_MS");
  const runMs = number("RETRIEVAL_QA_RUN_MS");

  return qaLimits({
    ...(loadMs === undefined ? {} : { loadMs }),
    ...(queryMs === undefined ? {} : { queryMs }),
    ...(runMs === undefined ? {} : { runMs }),
  });
}

const routing = process.argv.find((argument) => argument.startsWith("--routing="))?.split("=")[1] ?? "dev";
const port = Number(process.env.RETRIEVAL_QA_PORT ?? (routing === "built" ? 4322 : 4321));

/**
 * The seams a registered regression replaces, with the real ones as their values.
 *
 * `test/retrieval-qa-orchestration.test.ts` drives the run's own orchestration through these
 * with its own server, browser and frozen fixture, so the branch that reaches the encoder is
 * the shipped control flow and not a re-implementation of it. Nothing here is used to decide
 * a run: a value is only replaced from outside a check, and a replaced one fails its own
 * acceptance predicates rather than passing quietly.
 */
export const qaSeams = {
  routing,
  readLimits,
  readFrozen,
  startServer,
  launch: (profileDir, options) => chromium.launchPersistentContext(profileDir, options),
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function digestOf(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A failure this harness raises itself.
 *
 * The reason is a class the acceptance gate and a report can judge, and the message keeps the
 * detail of this one run. Both are project-owned text, so a failure boundary can name the
 * reason without copying a browser or vendor message into a report.
 */
function qaFailure(reason, detail = reason) {
  const error = new Error(detail);

  error.reason = reason;

  return error;
}

/**
 * The one name a failure boundary gives a thrown value.
 *
 * A deadline is named by its own label and bound, and a refusal this project raises is named
 * by its `reason`. Anything else is `unexpected`: the value stays with the run that threw it
 * and still ends that run, but none of a browser, a page or a library message is copied into
 * a report.
 */
function reasonOf(error) {
  if (error instanceof QaDeadlineError) return `deadline:${error.label}`;
  if (error instanceof Error && typeof error.reason === "string") return error.reason;

  return "unexpected";
}

/** What one failure boundary reports: the stage that was running, and the classified reason. */
function boundaryFailure(stage, error) {
  if (error instanceof QaDeadlineError) return { stage, reason: reasonOf(error), limitMs: error.limitMs };
  if (error instanceof Error && typeof error.reason === "string") {
    return { stage, reason: error.reason, detail: error.message };
  }

  return { stage, reason: "unexpected" };
}

/** The origin and path of one request URL, with the query and fragment left out. */
function requestPath(url) {
  try {
    const parsed = new URL(url);

    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "unparsable-url";
  }
}

export function readFrozen() {
  const casesFile = join(PROBE_DIR, "probe/fixture/synthetic-cases-v2.json");
  const reportFile = join(PROBE_DIR, "runs/run-01/node-report.json");
  // The same cache layout the generator's own run left behind, addressed by the shipped pin
  // rather than by a second copy of it, so the admitted bytes are the ones that pin names.
  const configFile = join(PROBE_DIR, "cache/hf-assets", EXPECTED_EMBEDDING.model, "resolve", EXPECTED_EMBEDDING.revision, "config.json");

  for (const file of [casesFile, reportFile]) {
    if (!existsSync(file)) {
      throw new Error(`frozen-fixture-missing: ${file}. Set PROBE_DIR to the accepted probe workspace.`);
    }
  }

  if (!existsSync(configFile)) {
    throw new Error(
      `admitted-config-missing: ${configFile}. The admitted identity is authenticated from the cached config.json the generator read.`,
    );
  }

  const casesBytes = readFileSync(casesFile);
  const cases = JSON.parse(casesBytes.toString("utf8"));
  const node = JSON.parse(readFileSync(reportFile, "utf8"));

  if (digestOf(casesBytes) !== FROZEN.cases) throw new Error("frozen-fixture-digest-mismatch");

  if (node.revision !== EXPECTED_EMBEDDING.revision) throw new Error("frozen-fixture-revision-mismatch");
  if (node.dtype !== EXPECTED_EMBEDDING.dtype) throw new Error("frozen-fixture-dtype-mismatch");
  if (node.transformersVersion !== EXPECTED_EMBEDDING.runtimeVersion) throw new Error("frozen-fixture-runtime-mismatch");

  const cardVectors = new Map(Object.entries(node.cardVectors));
  const byCase = new Map(node.cases.map((entry) => [entry.id, entry]));

  return { cases, gate: cases.gate, cardVectors, byCase, admitted: admitModelIdentity(node, readFileSync(configFile)) };
}

/**
 * The admitted configuration, mapped field by field from the raw config keys.
 *
 * `recorded` names the three values the accepted report also carries, so the historical
 * record and the authenticated bytes are both sides of the comparison for them. The
 * vocabulary is the exception: the report has no key for it, and an accepted report is
 * history this task does not regenerate.
 */
const CONFIG_FIELDS = Object.freeze([
  { pinned: "hiddenSize", raw: "hidden_size", kind: "number", recorded: true },
  { pinned: "modelType", raw: "model_type", kind: "string", recorded: true },
  { pinned: "maxPositionEmbeddings", raw: "max_position_embeddings", kind: "number", recorded: true },
  { pinned: "vocabularySize", raw: "vocab_size", kind: "number", recorded: false },
]);

/**
 * The admitted config.json on its own bytes, checked before any of its values is read.
 *
 * The size and the digest are the pinned copy and the accepted report's own asset record for
 * the same file, so a substituted or truncated config fails on its bytes rather than on a
 * value it was able to declare itself.
 */
function authenticatedConfig(configBytes, frozen) {
  const pinned = frozen.modelAssets[0];

  if (configBytes.byteLength !== pinned.bytes) throw new Error(`admitted-config-byte-count-changed:${configBytes.byteLength}`);
  if (digestOf(configBytes) !== pinned.sha256) throw new Error("admitted-config-digest-mismatch");

  const raw = JSON.parse(configBytes.toString("utf8"));
  const config = {};

  for (const field of CONFIG_FIELDS) {
    const value = raw?.[field.raw];
    const usable = field.kind === "number" ? Number.isInteger(value) && value > 0 : typeof value === "string" && value !== "";

    if (!usable) throw new Error(`admitted-config-unreadable:${field.raw}`);
    config[field.pinned] = value;
  }

  return config;
}

/**
 * The generator's own record of what it read, checked against the pinned copy.
 *
 * The workspace file is the generator; `FROZEN` is this harness; the browser supplies the
 * third side later. If the admitted record and the pinned copy disagree, the run stops
 * before any measurement, because a moved artifact would otherwise compare cleanly with
 * itself. Every configured value is read from the authenticated bytes, so the value the
 * harness pins and the value the generator read cannot drift apart through the report.
 */
export function admitModelIdentity(node, configBytes, frozen = FROZEN) {
  const recorded = node.identity;
  const assets = recorded?.assets ?? [];
  const names = assets.map((asset) => asset.file);

  for (const [index, pinned] of frozen.modelAssets.entries()) {
    const observed = assets[index];

    if (observed === undefined || observed.file !== pinned.name) throw new Error(`admitted-asset-missing:${pinned.name}`);
    if (observed.bytes !== pinned.bytes || observed.sha256 !== pinned.sha256) {
      throw new Error(`admitted-asset-moved:${pinned.name}`);
    }
  }

  if (names.length !== frozen.modelAssets.length) throw new Error("admitted-asset-count-changed");

  const config = authenticatedConfig(configBytes, frozen);
  const recordedModel = recorded.model ?? {};

  for (const field of CONFIG_FIELDS) {
    if (config[field.pinned] !== frozen.observedConfig[field.pinned]) throw new Error(`admitted-config-changed:${field.pinned}`);
    if (field.recorded && recordedModel[field.pinned] !== config[field.pinned]) {
      throw new Error(`admitted-record-disagrees:${field.pinned}`);
    }
  }

  // The tokenizer settings are the report's own record; `config.json` carries none of them.
  const tokenizer = {
    modelMaxLength: recordedModel.tokenizerModelMaxLength,
    truncationSide: recordedModel.tokenizerTruncationSide,
    paddingSide: recordedModel.tokenizerPaddingSide,
  };

  for (const [key, value] of Object.entries(frozen.observedTokenizer)) {
    if (tokenizer[key] !== value) throw new Error(`admitted-tokenizer-changed:${key}`);
  }

  return { assets, config: { ...recordedModel, ...config }, tokenizer };
}

function freePort(preferred) {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", () => fail(new Error(`port-unavailable: ${preferred}`)));
    probe.listen(preferred, "127.0.0.1", () => {
      const { port: chosen } = probe.address();
      probe.close(() => done(chosen));
    });
  });
}

/**
 * Warms the dev server's dependency optimizer before a browser connects.
 *
 * Vite discovers the embedding library while the first module is requested and then
 * forces a full page reload, which would destroy a page mid-load. Fetching the worker's
 * module graph with no client attached does the same work without the reload, so the run
 * measures the path and not the optimizer.
 */
async function warmDevOptimizer(origin) {
  const targets = [
    "/qa/retrieval.html",
    "/qa/retrieval-main.ts",
    "/src/chat/retrieval/encoder/worker.ts",
  ];
  let previous = "";

  for (let round = 0; round < 6; round += 1) {
    const digests = [];

    for (const target of targets) {
      const response = await fetch(`${origin}${target}`);
      digests.push(`${target}:${response.status}:${digestOf(await response.arrayBuffer()).slice(0, 12)}`);
    }

    const current = digests.join("|");

    if (current === previous) return true;
    previous = current;
    await sleep(1500);
  }

  return false;
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (response.ok) return true;
    } catch {
      // The server is not listening yet.
    }
    await sleep(200);
  }

  return false;
}

/** Starts the routing this run checks. The caller stops what this returns. */
async function startServer() {
  const chosen = await freePort(port);

  if (routing === "built") {
    if (!existsSync(join(REPO_ROOT, "dist/qa/retrieval.html"))) {
      throw new Error("built-routing-missing: build with RETRIEVAL_QA=1 first");
    }

    const child = spawn(process.execPath, [join(REPO_ROOT, "scripts/serve-dist.mjs"), join(REPO_ROOT, "dist"), String(chosen)], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    drainServerOutput(child, "static");

    return { child, origin: `http://127.0.0.1:${chosen}` };
  }

  const child = spawn(
    join(REPO_ROOT, "node_modules/.bin/vite"),
    ["--host", "127.0.0.1", "--port", String(chosen), "--strictPort"],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
  );
  drainServerOutput(child, "dev");

  return { child, origin: `http://127.0.0.1:${chosen}` };
}

/** Sends a started server's output to a log file. A full pipe buffer would stall it. */
function drainServerOutput(child, label) {
  const log = createWriteStream(join(OUT_DIR, `server-${label}-${routing}.log`), { flags: "a" });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
}

function stopServer(server) {
  return new Promise((done) => {
    if (server === null || server === undefined || server.exitCode !== null) {
      done();
      return;
    }

    const timer = setTimeout(() => {
      server.kill("SIGTERM");
      done();
    }, 4000);

    server.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    server.kill("SIGTERM");
  });
}

/**
 * The isolation and cache headers the server itself sends, measured outside the browser.
 *
 * This is the control for the in-page measurement: the production routing is a static
 * server that deliberately sends no COOP/COEP, so any header the browser sees on a
 * same-origin response there came from the service worker. Reading it here from the same
 * origin is what makes that attribution a measurement.
 */
async function measureServerHeaders(origin) {
  const paths = ["/qa/retrieval.html", ...Object.values(ORT_WASM_PATHS)];

  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => {
        try {
          const response = await fetch(`${origin}${path}`);
          const body = await response.arrayBuffer();

          return [
            path,
            {
              status: response.status,
              bytes: body.byteLength,
              cacheControl: response.headers.get("cache-control"),
              crossOriginOpenerPolicy: response.headers.get("cross-origin-opener-policy"),
              crossOriginEmbedderPolicy: response.headers.get("cross-origin-embedder-policy"),
              crossOriginResourcePolicy: response.headers.get("cross-origin-resource-policy"),
            },
          ];
        } catch (error) {
          return [path, { error: error instanceof Error ? error.message : "request-failed" }];
        }
      }),
    ),
  );
}

/** The isolation headers a response carries, for comparing the two sides of one URL. */
function isolationHeaders(measured) {
  return {
    coop: measured.crossOriginOpenerPolicy,
    coep: measured.crossOriginEmbedderPolicy,
    corp: measured.crossOriginResourcePolicy,
    cacheControl: measured.cacheControl,
  };
}

/**
 * The storage and offline proof for the two runtime files.
 *
 * The pre-fix gate asked the page's headers object for a `transferSize`. That is a resource
 * timing field, this headers object never carried one, so the gate reported every runtime file
 * as uncacheable on every run, whatever the cache actually did.
 *
 * This judges bytes instead: which cache holds each file, the stored status, byte count and
 * SHA-256 against the artifact the route records, the byte identity with what this browser
 * consumed for the same two URLs, and what an offline replay of those URLs returns. A
 * `cache-control` value is deliberately not judged: the worker stores a response and re-adds
 * the isolation headers when it serves one, so the stored policy is not what the page
 * receives, and a `no-store` policy is not evidence that a stored response was not served.
 *
 * The routing decides applicability, because only the production routing is delivered by the
 * worker that holds these files. The caller supplies the values; nothing here reads a file,
 * a cache or a clock, so the check is exercisable without a browser.
 */
export function evaluateRuntimeCacheProof({ routing, stored, replay, replayError = null, consumed, declared }) {
  if (routing !== "built") return { applicable: false, checks: {}, failures: [] };

  const expected = Object.values(ORT_WASM_PATHS);
  const storedByPath = new Map((stored ?? []).map((entry) => [entry.path, entry]));
  const consumedByPath = new Map((consumed ?? []).map((entry) => [entry.path, entry]));
  const declaredByName = new Map((declared ?? []).map((asset) => [asset.name, asset]));

  const rows = expected.map((path) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const entry = storedByPath.get(path) ?? null;
    const artifact = declaredByName.get(name) ?? null;
    const seen = consumedByPath.get(path) ?? null;
    const offline = (replay?.replayed ?? []).find((item) => item.path === path) ?? null;
    const storedOk =
      entry !== null &&
      entry.found === true &&
      typeof entry.cacheName === "string" &&
      entry.cacheName !== "" &&
      entry.headers?.status === 200 &&
      typeof entry.bytes === "number" &&
      typeof entry.sha256 === "string";
    const storedBytesOk = storedOk && artifact !== null && entry.bytes === artifact.bytes;
    const storedDigestOk = storedOk && artifact !== null && entry.sha256 === artifact.sha256;
    const consumedOk = storedOk && seen !== null && seen.status === 200 && seen.bytes === entry.bytes && seen.sha256 === entry.sha256;
    const replayOk =
      replay !== null &&
      replayError === null &&
      offline !== null &&
      offline.error === null &&
      offline.status === 200 &&
      typeof offline.bytes === "number" &&
      typeof offline.sha256 === "string";
    const replayBytesOk = replayOk && entry !== null && offline.bytes === entry.bytes;
    const replayDigestOk = replayOk && entry !== null && offline.sha256 === entry.sha256;
    const replayIsolatedOk = replayOk && offline.headers?.crossOriginOpenerPolicy === "same-origin" && offline.headers?.crossOriginEmbedderPolicy === "require-corp";

    return { storedOk, storedBytesOk, storedDigestOk, consumedOk, replayOk, replayBytesOk, replayDigestOk, replayIsolatedOk };
  });

  const checks = {
    storageComplete: rows.every((row) => row.storedOk),
    storedBytesMatchArtifact: rows.every((row) => row.storedBytesOk),
    storedDigestMatchArtifact: rows.every((row) => row.storedDigestOk),
    consumedMatchesStored: rows.every((row) => row.consumedOk),
    replayCompleted:
      replay !== null &&
      replayError === null &&
      replay.phase === "offline-replay" &&
      replay.offline === true &&
      replay.serviceWorkerControlled === true &&
      replay.crossOriginIsolated === true,
    replayComplete: rows.every((row) => row.replayOk),
    replayBytesMatchStored: rows.every((row) => row.replayBytesOk),
    replayDigestMatchStored: rows.every((row) => row.replayDigestOk),
    replayIsolated: rows.every((row) => row.replayIsolatedOk),
  };

  const failures = Object.entries(checks)
    .filter(([, held]) => !held)
    .map(([check]) => `cache-${check.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);

  return { applicable: true, checks, failures };
}

/** How often the delivery barrier re-reads the state of the document that is current. */
const DELIVERY_POLL_MS = 250;

/** Reads the delivery facts from the page, in whichever document answers right now. */
const deliveryState = () => ({
  controlled: Boolean(navigator.serviceWorker?.controller),
  isolated: self.crossOriginIsolated === true,
  coiSeen: "crossOriginIsolated" in self,
  ready: typeof window.retrievalQa === "object",
});

/**
 * The sanitized public state of the startup: the phase, the current document's path and the
 * last delivery flags a probe read. Nothing from the page's own content is kept, and the
 * query and fragment of a frame URL are dropped.
 */
function deliveryRecord() {
  return { phase: "startup", path: null, navigations: 0, coiSeen: null, controlled: null, isolated: null };
}

/** The five public fields a timeout reports, so a failure names the state it actually saw. */
function snapshotOf(record) {
  return {
    phase: record.phase,
    path: record.path,
    coiSeen: record.coiSeen,
    controlled: record.controlled,
    isolated: record.isolated,
  };
}

/** The path of a frame URL, with the query and fragment left out. */
function documentPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/**
 * Watches the main frame from before the first navigation.
 *
 * The production routing reaches a controlled document through the site's own registration
 * script, so a main-frame navigation during startup is expected. It is recorded here, so the
 * barrier can tell it apart from a navigation that happens during the measurement and can
 * report where the current document is.
 */
export function observeDeliveryPhase(page) {
  const record = deliveryRecord();

  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    record.navigations += 1;
    record.path = documentPath(frame.url());
  });

  return record;
}

/**
 * Whether the current document has what this routing needs.
 *
 * The production routing is delivered by the site's own service worker, so only a document
 * that has the page's API, a controller and isolation counts. The dev routing keeps its
 * existing rule, where the API alone is enough and the controlled pair is the state the dev
 * optimizer may still not have reached.
 */
function deliverySatisfied(state, routing) {
  if (routing !== "dev") return state.ready === true && state.controlled === true && state.isolated === true;
  return state.ready === true || (state.controlled === true && state.isolated === true);
}

/**
 * Waits for the production boundary to be real, reading every probe from the document that is
 * current at that moment.
 *
 * Registering the worker takes a controlled load, and the site's registration script owns the
 * reload that achieves it, so a navigation here is expected rather than a fault. It is observed
 * before the first navigation, the loop keeps the one load bound it was given across it, and each
 * probe is bounded by what is left of that same bound, because a probe waits on the page's reply
 * and a page that stops answering would otherwise hold the run past it. A destroyed context is
 * tolerated only when a main-frame navigation was observed since the last probe that answered and
 * the failure is the context-destroyed one that navigation explains; any other evaluation failure
 * is the run's own and propagates with its own error. Only a navigation after this returns is the
 * dev optimizer problem the run reports.
 */
/**
 * Whether an evaluation failed because its context went away, which is what a main-frame
 * navigation does to a probe that was already in flight. The wording is the browsers' own, so
 * the check is limited to that family instead of retrying whatever a lost context produced.
 */
function isContextDestroyed(error) {
  const message = error instanceof Error ? error.message : String(error);

  return /execution context (was destroyed|is not available|cannot be accessed)|cannot find context with specified id/i.test(message);
}

export async function waitForDeliveryControl(page, limits, { routing = "dev", observation, startedAt = Date.now() } = {}) {
  const record = observation ?? deliveryRecord();
  const deadline = startedAt + limits.loadMs;
  const timeoutFailure = () => qaFailure("delivery-control-timeout", `delivery-control-timeout:${JSON.stringify(snapshotOf(record))}`);
  const left = () => deadline - Date.now();
  // The poll never sleeps past the bound: a sleep that overshot it would keep a run alive
  // after the startup it belongs to is already over.
  const poll = () => sleep(Math.min(DELIVERY_POLL_MS, Math.max(0, left())));
  let settled = record.navigations;

  for (;;) {
    if (left() <= 0) throw timeoutFailure();

    let state;

    try {
      state = await withDeadline("delivery-probe", left(), page.evaluate(deliveryState));
    } catch (error) {
      // A probe the page never answers ends the barrier here, on the same load bound the loop
      // keeps, so the run reports a delivery timeout instead of waiting for the whole-run bound.
      if (error instanceof QaDeadlineError) throw timeoutFailure();

      // Only a navigation this record saw, together with the destroyed context it explains,
      // makes a retry right. Anything else is the run's own failure, so its error is kept
      // instead of being retried or reported as a timeout.
      if (record.navigations <= settled || !isContextDestroyed(error)) throw error;
      if (left() <= 0) throw timeoutFailure();

      await poll();
      continue;
    }

    settled = record.navigations;
    record.coiSeen = state.coiSeen;
    record.controlled = state.controlled;
    record.isolated = state.isolated;

    // Expiry is refused before a ready state is accepted, so a document that answers only
    // after the bound has passed cannot resolve a startup that is already over.
    if (left() <= 0) throw timeoutFailure();
    if (deliverySatisfied(state, routing)) return state;

    await poll();
  }
}

/**
 * The load budget still left for the startup, refused when it is spent.
 *
 * Playwright reads `timeout: 0` as "no timeout at all", so an empty budget is refused here
 * instead of being handed over as a wait that would never end. The failure is the barrier's
 * own, with the same public state snapshot, so a startup that runs out of budget reads the
 * same way whichever wait ran out.
 */
function remainingLoadMs(startedAt, limits, record) {
  const left = limits.loadMs - (Date.now() - startedAt);

  if (left <= 0) {
    throw qaFailure("delivery-control-timeout", `delivery-control-timeout:${JSON.stringify(snapshotOf(record))}`);
  }

  return left;
}

/**
 * The reasons a failed request may carry, named by class instead of by its text.
 *
 * The browser's own error text is not copied anywhere: it is matched here and what is kept is
 * the class, so a report can say why a request failed without carrying the message.
 */
function networkReason(failureText) {
  if (typeof failureText !== "string") return "unclassified";
  if (/ERR_INTERNET_DISCONNECTED/i.test(failureText)) return "internet-disconnected";
  if (/ERR_(?:FAILED|NAME_NOT_RESOLVED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_REFUSED)/i.test(failureText)) {
    return "network-failed";
  }

  return "unclassified";
}

/**
 * The model's own route and its six locked paths, taken from the manifest that pins its files.
 */
const MXBAI_SET = MODEL_ASSET_SETS.find((set) => set.id === "mxbai-embed-xsmall-v1");

if (MXBAI_SET === undefined) throw new Error("mxbai-set-missing-from-manifest");

const MXBAI_ROUTE = MXBAI_SET.route;
const MODEL_PATHS = MXBAI_SET.files.map((file) => `${MXBAI_ROUTE}${file.name}`);

/**
 * The locked same-origin runtime paths: the two ONNX Runtime files and the six model files.
 *
 * Only these paths can carry an explanation in the offline phase, so what is exempt comes from
 * the routes the project already pins rather than from an inventory written beside it.
 */
const LOCKED_RUNTIME_PATHS = new Set([...Object.values(ORT_WASM_PATHS), ...MODEL_PATHS]);

/** The replay's own scope: exactly the locked paths, nothing the project does not pin. */
const REPLAY_PATHS = [...LOCKED_RUNTIME_PATHS];

/** The failure classes that name an offline network cause, as opposed to an unknown message. */
const KNOWN_NETWORK_CAUSES = new Set(["internet-disconnected", "network-failed"]);

/**
 * The locked runtime path a browser URL is, or null when it is not one.
 *
 * The match is on the parsed path against the origin the run served, so a query, a fragment,
 * another origin or any other site path cannot become a locked path, and nothing of a refused
 * URL is kept.
 */
function lockedRuntimePath(rawUrl, origin) {
  if (typeof rawUrl !== "string" || typeof origin !== "string") return null;

  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  return url.origin === origin && LOCKED_RUNTIME_PATHS.has(url.pathname) ? url.pathname : null;
}

/**
 * What a console error is, without any of its text.
 *
 * The message is matched here and only its class is kept, and the path is the one the browser
 * reports as that message's own location, refused unless it is a locked same-origin runtime
 * path. A message this cannot classify keeps neither a cause nor a path, so nothing downstream
 * can explain it, and the text itself is never recorded.
 */
function consoleFailure(message, origin) {
  const text = typeof message.text === "function" ? message.text() : null;
  const located = typeof message.location === "function" ? message.location() : null;
  const path = lockedRuntimePath(located?.url, origin);

  return { source: "console", reason: text === null ? "unclassified" : networkReason(text), ...(path === null ? {} : { path }) };
}

/** The classification a confirmed offline replay gives a path the worker itself caches and serves. */
const OFFLINE_EXPECTED_REASON = "sw-revalidation-without-network";

/**
 * The classification for a `/models/` path, and why it is not the one above.
 *
 * The worker passes those paths through, so it holds no copy of them and never revalidates
 * one: an offline failure there is the passthrough being offline, not a revalidation without a
 * network. One distinct reason per path class keeps the replay truthful.
 */
const PASSTHROUGH_EXPECTED_REASON = "model-passthrough-not-sw-cached";

/** The classification a locked path's own handling earns, read from the path alone. */
function offlineReason(path) {
  return path.startsWith(MXBAI_ROUTE) ? PASSTHROUGH_EXPECTED_REASON : OFFLINE_EXPECTED_REASON;
}

/** The classification a failure nothing in its phase explains carries. */
const UNEXPLAINED = "unexplained";

/**
 * One classification for every failure the offline replay produced, and not one excuse.
 *
 * A page error is never explained: a thrown error keeps its own message inside the page, so
 * nothing this project can read names a cause for it. A request failure of a locked runtime
 * path with a known network cause is the one failure a confirmed offline replay explains by
 * itself, because the run set that context offline and then asked the page to replay exactly
 * those paths. A console error is explained only by such a request failure of the same path
 * and the same cause, and one request failure explains one console error. What an explained
 * entry is told follows its own path: a worker-served runtime file keeps
 * {@link OFFLINE_EXPECTED_REASON}, a `/models/` passthrough keeps
 * {@link PASSTHROUGH_EXPECTED_REASON}.
 *
 * Everything else stays blocking: an unknown message, a path that is not a locked one, a cause
 * a request failure does not share, and every HTTP status failure. An explained entry keeps its
 * own source, reason and path and gains a classification and the reference that explains it, so
 * an explanation never replaces what was observed. `entries` carries every entry in the order
 * it was observed, because the run's own accounting keeps request and HTTP failures too.
 *
 * @param context `{ offline: true }`, and only where the run set that context offline itself.
 *   Nothing is explained without it, so a failure outside a confirmed replay keeps its ordinary
 *   accounting.
 */
export function classifyOfflinePhase(entries, context) {
  const confirmed = context?.offline === true;
  const qualifies = (entry) =>
    confirmed && entry.source === "request" && KNOWN_NETWORK_CAUSES.has(entry.reason) && LOCKED_RUNTIME_PATHS.has(entry.path);

  const explains = entries.filter(qualifies);
  const claimed = new Set();
  const classified = entries.map((entry) => {
    if (entry.source !== "page" && KNOWN_NETWORK_CAUSES.has(entry.reason) && LOCKED_RUNTIME_PATHS.has(entry.path)) {
      if (qualifies(entry)) {
        return {
          ...entry,
          disposition: "expected",
          classification: offlineReason(entry.path),
          evidence: { source: "offline-replay", path: entry.path, reason: entry.reason },
        };
      }

      // A console error needs the request failure itself and not only its own class and path:
      // the same path and the same cause, unused so far, so one failure explains one error.
      if (entry.source === "console") {
        const claim = explains.findIndex((candidate, index) => !claimed.has(index) && candidate.path === entry.path && candidate.reason === entry.reason);

        if (claim !== -1) {
          claimed.add(claim);

          return {
            ...entry,
            disposition: "expected",
            classification: offlineReason(entry.path),
            evidence: { source: "request", path: entry.path, reason: entry.reason },
          };
        }
      }
    }

    return { ...entry, disposition: "blocking", classification: UNEXPLAINED };
  });

  return {
    entries: classified,
    expected: classified.filter((entry) => entry.disposition === "expected"),
    unresolved: classified.filter((entry) => entry.disposition === "blocking"),
  };
}

/** The matchings the controller reports, and the causes a limited match has to name. */
const MATCHINGS = new Set(["semantic", "limited"]);
const LIMITED_CAUSES = new Set(["model-unavailable", "embedding-failed"]);

/** The two superseding outcomes the producer writes: the pending one loses, the newer one lands. */
const SUPERSEDED_OUTCOME = "embed/superseded";
const RESOLVED_OUTCOME = "resolved";

/**
 * What each answer path's own purpose has to report, next to the shape both of them share.
 *
 * `controllerProbe` embeds the question first, so a card it reports is a semantic match, while
 * `lexicalProbe` asks with a null encoder, so a card it reports is a limited match that has to
 * name the cause it fell back for. These are the producers' own outputs
 * (`src/chat/retrieval/controller.ts` returns `matching: "semantic"` from the selection path and
 * `matching: "limited"`, `limitedCause: "model-unavailable"` from the null-encoder path).
 */
const ANSWER_PURPOSES = {
  controller: { matching: "semantic" },
  lexical: { matching: "limited", limitedCause: "model-unavailable" },
};

/**
 * What one answer path's own metadata does not allow, or null.
 *
 * The metadata has to travel with the kind: a semantic match carries no limited cause and a
 * limited one names which cause it was, because a limited fallback that cannot say why is not
 * a fallback the run can judge. A probe that carries no metadata object at all, or a metadata
 * object with no kind, is reported by name rather than read past as a field that happens to
 * be absent.
 */
function answerMetadataProblem(metadata) {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return "answer-missing";
  if (typeof metadata.kind !== "string") return "kind-missing";
  if (metadata.kind !== "answer" && metadata.kind !== "rephrase") return `unexpected-kind:${metadata.kind}`;
  if (!MATCHINGS.has(metadata.matching)) return "matching-missing";
  if (metadata.matching === "limited" && !LIMITED_CAUSES.has(metadata.limitedCause)) return "limited-cause-missing";
  if (metadata.matching === "semantic" && (metadata.limitedCause ?? null) !== null) return "semantic-carries-limited-cause";

  return null;
}

/**
 * What the printed summary reports about the controller probe's own answer metadata.
 *
 * The summary is written before {@link workloadGate} judges that same metadata, so it must not
 * read past a probe that carries none: the fields are read only once the gate's own predicate
 * accepts them, and a probe that predicate refuses is reported by the name it refuses it with,
 * which is the name the run then ends on. Reading the fields unconditionally here would end the
 * run on a thrown read instead, and the gate below would never name the probe at all.
 *
 * The gate itself is unchanged: this builds the diagnostic, it does not soften the verdict.
 */
function controllerSummary(controller) {
  const problem = answerMetadataProblem(controller?.answer);

  if (problem !== null) return { metadata: problem, cards: controller?.cards ?? null };

  return {
    kind: controller.answer.kind,
    matching: controller.answer.matching,
    weak: controller.answer.weak,
    cards: controller.cards,
  };
}

/**
 * The acceptance predicates the run collects but would otherwise only record: what the
 * guards, the superseding result, the two answer paths and the observed failures must say.
 *
 * Every guard has to refuse, the newer of two superseding questions has to have produced the
 * producer's own success token, each answer path has to report the metadata its own purpose
 * produces, and a failure this run observed blocks unless the offline phase explained it with
 * evidence. A refusal is judged by its reason, never by the text a card or a question would
 * have carried.
 */
export function workloadGate({ guards, supersede, controller, lexical, observed }) {
  const failures = [];

  for (const guard of guards) {
    if (guard.reason.startsWith("accepted:")) failures.push(`guard-accepted:${guard.name}`);
  }

  if (supersede?.older !== SUPERSEDED_OUTCOME) {
    failures.push(typeof supersede?.older === "string" ? "supersede-older" : "supersede-older-missing");
  }

  // The producer answers the newer question with the literal `"resolved"` when it embedded, and
  // with a classified reason when it did not, so only that one token is a superseded question
  // that landed. A superseded, failed, malformed or absent outcome all fail here: a missing
  // field is not evidence that the question was answered.
  if (supersede?.newer !== RESOLVED_OUTCOME) {
    failures.push(typeof supersede?.newer === "string" ? "supersede-newer" : "supersede-newer-missing");
  }

  // Each probe is read from where its own producer writes the metadata: the controller probe
  // nests it under `answer`, the lexical probe reports it flat. A probe that carries no
  // metadata at all is named, not read past.
  for (const [name, metadata] of [
    ["controller", controller?.answer],
    ["lexical", lexical],
  ]) {
    const problem = answerMetadataProblem(metadata);

    if (problem !== null) {
      failures.push(`${name}-${problem}`);
      continue;
    }

    // Shape is shared, purpose is not. The controller probe answers with a loaded encoder, so
    // it has to report the semantic match the semantic path produces; the lexical probe asks
    // with no encoder at all, so it has to report the limited match and name the cause it fell
    // back for. Metadata that is well formed but belongs to the other path is not what this
    // probe was asked to produce, so the path's own metadata is checked as well as its shape.
    // The names are built from the expected constants, so an unexpected value is never echoed.
    const expected = ANSWER_PURPOSES[name];

    if (metadata.matching !== expected.matching) failures.push(`${name}-matching-not-${expected.matching}`);
    if (expected.limitedCause !== undefined && metadata.limitedCause !== expected.limitedCause) {
      failures.push(`${name}-limited-cause-not-${expected.limitedCause}`);
    }
  }

  const blocking = observed.filter((entry) => entry.disposition !== "expected");

  if (blocking.length > 0) failures.push(`observed-failures:${blocking.length}`);

  return failures;
}

/**
 * What the offline phase's own restoration reporting does not allow, or null.
 *
 * The phase reports a failed restoration beside the replay's own outcome, inside its `window`
 * record, and reports a clean one as an explicit `null` there. A phase that reports no window,
 * or a window without that field, has reported nothing about the restoration, so it blocks
 * rather than reading as a clean restore.
 */
function restorationProblem(replay) {
  const phaseWindow = replay?.window;

  if (phaseWindow === null || typeof phaseWindow !== "object") return "offline-window-missing";
  if (!("restoration" in phaseWindow)) return "offline-restoration-unreported";

  return phaseWindow.restoration === null ? null : "offline-restore-failed";
}

/**
 * The scoped offline replay of every locked runtime path.
 *
 * `setOffline(true)` is the browser's own switch and it is undone in `finally`, so a replay
 * that fails leaves the rest of the run on a networked context. The page fetches each locked
 * URL as a plain same-origin request, and nothing here names a cache mode or asks a cache to
 * be bypassed. The two classes of path answer differently on purpose: the worker serves the
 * ONNX Runtime files from its own cache, and it passes `/models/` straight through, so those
 * fail with the network and are classified by their own reason instead of by the worker's.
 * The failures this phase produced are classified, not excused: {@link classifyOfflinePhase}
 * explains a request failure of a locked runtime path with a known network cause, and a
 * console error that a request failure of the same path and cause explains, while every other
 * failure keeps its ordinary accounting.
 *
 * @returns `result` is the page's own record, `failure` the thrown value of the replay itself
 *   as it was thrown, `window` the phase's own classified accounting, and a restoration that
 *   failed reported beside the replay's own outcome instead of replacing it.
 */
async function replayRuntimeOffline(context, page, limits, phase) {
  const from = phase.observed.length;
  // Whether this phase may explain a locked runtime failure at all. The switch that went
  // offline is recorded rather than assumed from the stage, so a replay that never went
  // offline classifies everything it observed as unexplained.
  let offlineConfirmed = false;
  let result = null;
  let failure = null;
  let restoration = null;

  phase.stage = "offline-replay";

  try {
    await context.setOffline(true);
    offlineConfirmed = true;
    result = await withDeadline(
      "offline-replay",
      limits.loadMs,
      page.evaluate((paths) => window.retrievalQa.replayRuntime(paths), REPLAY_PATHS),
    );
  } catch (error) {
    // The thrown value is kept as it was thrown. What a report says about it is decided at
    // the boundary that reports it, not here and not as a rendering of its message.
    failure = error;
  } finally {
    // Restoring the context is its own step and can fail on its own. That failure is reported
    // beside the replay's outcome, because a restoration error thrown from here would
    // otherwise replace the one diagnostic the phase actually produced.
    try {
      await context.setOffline(false);
    } catch (restored) {
      restoration = restored;
    } finally {
      phase.stage = "run";
    }
  }

  const classified = classifyOfflinePhase(phase.observed.slice(from), { offline: offlineConfirmed });

  // Every classified entry goes back in, the request and HTTP failures included, so the run's
  // own accounting keeps them instead of losing them to the classification.
  phase.observed.splice(from, phase.observed.length - from, ...classified.entries);

  return {
    result,
    failure,
    window: {
      phase: "offline-replay",
      expected: classified.expected,
      unresolved: classified.unresolved,
      failure: failure === null ? null : { stage: "offline-replay", reason: reasonOf(failure) },
      restoration: restoration === null ? null : { stage: "offline-restore", reason: reasonOf(restoration) },
    },
  };
}

function cosine(left, right) {
  let dot = 0;
  let leftSquared = 0;
  let rightSquared = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftSquared += left[index] * left[index];
    rightSquared += right[index] * right[index];
  }

  return dot / (Math.sqrt(leftSquared) * Math.sqrt(rightSquared));
}

function roundVector(vector) {
  return vector.map((value) => Number(value.toFixed(ARTIFACT_DECIMALS)));
}

function maxAbsoluteDifference(left, right) {
  let worst = 0;

  for (let index = 0; index < left.length; index += 1) {
    worst = Math.max(worst, Math.abs(left[index] - right[index]));
  }

  return worst;
}

/** The decision 9 branch names the frozen expectations use, mapped from the module's own union. */
function branchName(selection) {
  if (selection.kind === "rephrase") return "below-floor-rephrase";
  if (selection.kind === "clarify") return "clarify";
  return selection.weak ? "weak-answer" : "confident-answer";
}

function meetsExpectation(expect, observed) {
  if (expect.branchIs !== undefined && observed.branch !== expect.branchIs) return false;
  if (expect.branchIsNot !== undefined && observed.branch === expect.branchIsNot) return false;
  if (expect.topCardId !== undefined && observed.topCardId !== expect.topCardId) return false;
  if (Array.isArray(expect.topCardIdIn) && !expect.topCardIdIn.includes(observed.topCardId)) return false;
  if (Array.isArray(expect.anyOf) && !expect.anyOf.some((option) => meetsExpectation(option, observed))) return false;
  return true;
}

/** How long one owned resource's close may take before it is recorded as unconfirmed. */
const CLEANUP_CLOSE_MS = 10_000;

/**
 * Reports what the run could confirm, separately from the failure it exits with.
 *
 * An unconfirmed close is its own failure, so it is reported here and never folded into
 * the message of the error that ended the run.
 */
function reportCleanup(records) {
  if (records.some((record) => !record.closed)) {
    console.log(`[qa] FAILED: unconfirmed-cleanup ${JSON.stringify(records.filter((record) => !record.closed))}`);
    process.exitCode = 1;
  }

  console.log(`[qa] cleanup: ${JSON.stringify(records)}`);
}

/**
 * Reports a handle that arrived after the run's own drain gave up on its acquisition.
 *
 * The run already reported that acquisition as unresolved at the deadline, so this is a
 * separate fact about what happened afterwards: only a close that failed or was not
 * confirmed in time fails the run further.
 */
function reportLateCleanup(record) {
  console.log(`[qa] cleanup-late: ${JSON.stringify([record])}`);

  if (!record.closed) {
    console.log(`[qa] FAILED: unconfirmed-late-cleanup ${JSON.stringify([record])}`);
    process.exitCode = 1;
  }
}

/** The one string that identifies the site's top-level mount in a built chunk. */
const SITE_MOUNT_MARKER = "getElementById(`root`)";

/** Every script address an HTML document loads. */
function scriptSources(html) {
  return [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"[^>]*>/g)].map((match) => match[1]);
}

/** Every ES import specifier a built chunk can carry, static or dynamic. */
function importSpecifiers(text) {
  return [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

/**
 * The refusal that keeps the built QA document out of the site entry's module graph.
 *
 * The site entry mounts the app into `#root` at module top level. A chunk layout that gives
 * the QA document an import edge to that entry throws during module evaluation in a document
 * with no `#root`, the graph aborts, and the page API never appears; that was the built
 * startup failure of runs 44, 45 and 58. Two shapes are refused: reaching a script that
 * carries the mount, and reaching the script `index.html` loads as the site entry. Shared
 * bootstraps both documents load (the module preload polyfill, the rollup runtime) are not
 * refusals on their own.
 *
 * Browser-free and content-free: a refusal names a repository-relative file path and a
 * project-owned reason, never file contents.
 */
export function checkQaScriptGraph(distDir) {
  const siteHtml = join(distDir, "index.html");
  const qaHtml = join(distDir, "qa/retrieval.html");

  if (!existsSync(siteHtml) || !existsSync(qaHtml)) {
    return { ok: false, reason: "qa-graph-artifacts-missing", detail: "index.html or qa/retrieval.html is not built" };
  }

  const siteScripts = scriptSources(readFileSync(siteHtml, "utf8"))
    .map((src) => (src.startsWith("/") ? join(distDir, src) : resolve(dirname(siteHtml), src)));
  // The site entry is the loaded script that carries the mount. A build without any marker
  // is anomalous, so the last loaded script stands in for it instead of accepting everything.
  const carriesMount = siteScripts.filter((file) => existsSync(file) && readFileSync(file, "utf8").includes(SITE_MOUNT_MARKER));
  const siteEntryTargets = new Set(carriesMount.length > 0 ? carriesMount : siteScripts.slice(-1));

  const queue = scriptSources(readFileSync(qaHtml, "utf8")).map((src) =>
    src.startsWith("/") ? join(distDir, src) : resolve(dirname(qaHtml), src),
  );
  const seen = new Set();

  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);

    if (!existsSync(file)) {
      return { ok: false, reason: "qa-graph-missing-script", detail: relative(distDir, file) };
    }

    const text = readFileSync(file, "utf8");
    if (siteEntryTargets.has(file)) {
      return { ok: false, reason: "qa-graph-reaches-site-entry", detail: relative(distDir, file) };
    }
    if (text.includes(SITE_MOUNT_MARKER)) {
      return { ok: false, reason: "qa-graph-contains-site-mount", detail: relative(distDir, file) };
    }

    for (const spec of importSpecifiers(text)) {
      if (spec.startsWith("/")) queue.push(join(distDir, spec));
      else if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec));
    }
  }

  return { ok: true, scripts: seen.size };
}

async function main(cleanup) {
  // The seams are read here, so a registered regression drives this same control flow with its
  // own server, browser and frozen fixture, and the branch it exercises is the shipped one.
  const { routing, readLimits: limitsFrom, readFrozen: readFixture, startServer: start, launch } = qaSeams;
  const limits = limitsFrom();

  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(PROFILE_DIR, { recursive: true });
  const frozen = readFixture();
  // The frozen field is `probe`; the page takes a question as `text`. The text is passed in and
  // never returned, logged or written.
  const queries = frozen.cases.cases.map((entry) => ({ id: entry.id, probe: entry.probe, text: entry.probe }));
  const cardOrder = [...frozen.cardVectors.keys()];

  const server = await cleanup.registerAcquisition("server", start, (handle) => stopServer(handle.child), reportLateCleanup);
  let navigated = false;
  const requested = [];
  // The cold byte footprint (task 8.1): the first response observed for each request path,
  // sized once. Byte counts and fixed window names only, so the report stays content-free.
  // A path fetched again later is a repeat, not new cold bytes, which is what separates the
  // footprint from this harness's own duplicate measurement fetches. `byteWindow` names the
  // part of the run that was active when the first response arrived.
  const firstTransfers = new Map();
  let repeatedResponses = 0;
  let unmeasuredPaths = 0;
  let byteWindow = "startup";
  // Every failure this run observes is kept as one record: the stage that was running, where it
  // came from, and nothing of the message itself. A console error and a page error arrive as
  // opaque text, so what they are stays unresolved unless one specific piece of evidence
  // explains them. That is what keeps an unexpected failure from being recorded as expected
  // because it happened to arrive during a phase, and what lets every one of them block.
  const observed = [];
  const phase = { stage: "run", observed };
  const record = (entry) => observed.push({ stage: phase.stage, disposition: "blocking", ...entry });
  const timed = (label, work, limitMs = limits.queryMs) => withDeadline(label, limitMs, work);
  let browser;

  // Ownership starts before the handle exists, so the deadline can reach a server that is
  // still starting. This guard is what stops such a handle from starting the rest of the run:
  // the run's outcome is already known, so nothing the server would serve is needed.
  if (cleanup.ended()) {
    console.log("[qa] the whole-run deadline ended before the server was ready; its handle is closed through cleanup");
    return;
  }

  try {
    // The graph refusal runs before the browser exists, so a poisoned chunk layout never
    // reaches a navigation; the stage names the refusal for the failure report.
    if (routing === "built") {
      phase.stage = "preflight";
      const graph = checkQaScriptGraph(join(REPO_ROOT, "dist"));
      if (!graph.ok) throw qaFailure(graph.reason, graph.detail);
      console.log(`[qa] preflight: QA script graph clean, ${graph.scripts} scripts`);
      phase.stage = "run";
    }

    if (!(await waitForServer(`${server.origin}/qa/retrieval.html`, 90_000))) {
      throw qaFailure("server-did-not-start", `server-did-not-start: ${server.origin}`);
    }

    // The control for the in-page delivery measurement, taken before the browser exists.
    const serverHeaders = await measureServerHeaders(server.origin);

    if (routing === "dev") {
      const warm = await warmDevOptimizer(server.origin);
      console.log(`[qa] dev dependency optimizer warm and stable: ${warm}`);
    }

    browser = await cleanup.registerAcquisition(
      "browser",
      () =>
        launch(PROFILE_DIR, {
          channel: CHROME_CHANNEL,
          headless: HEADLESS,
          viewport: { width: 1280, height: 900 },
          ...(BLOCK_OFF_ORIGIN ? { args: [OFF_ORIGIN_BLOCK_FLAG] } : {}),
        }),
      (context) => context.close(),
      reportLateCleanup,
    );

    // The same guard for the browser: a context that arrives after the run ended is closed
    // through cleanup, not used.
    if (cleanup.ended()) {
      console.log("[qa] the whole-run deadline ended before the browser was ready; its handle is closed through cleanup");
      return;
    }

    const page = browser.pages()[0] ?? (await browser.newPage());
    // Playwright's own bounds are a backstop; the harness deadlines below are what the
    // report attributes a failure to.
    page.setDefaultTimeout(limits.loadMs);
    page.setDefaultNavigationTimeout(limits.loadMs);

    page.on("console", (message) => {
      if (message.type() === "error") record(consoleFailure(message, server.origin));
    });
    page.on("pageerror", () => {
      record({ source: "page", reason: "unclassified" });
    });
    page.on("request", (request) => {
      requested.push(requestPath(request.url()));
    });
    page.on("requestfailed", (request) => {
      const url = request.url();

      // A locked runtime URL is recorded as its path, so the classifier compares it with the
      // same locked paths. Any other URL keeps the origin it was requested from, as before.
      record({
        source: "request",
        path: lockedRuntimePath(url, server.origin) ?? requestPath(url),
        reason: networkReason(request.failure()?.errorText),
      });
    });
    page.on("response", (response) => {
      if (response.status() < 400) return;
      record({ source: "http", status: response.status(), path: requestPath(response.url()), reason: "http-status" });
    });

    // Sizes every response, and keeps the largest body observed per request path: a path that
    // is fetched again (the harness's own probe, a repeat of a runtime file) must not add the
    // same asset twice, while a path whose first response is only a range probe or a redirect
    // must not hide the transfer that follows it. The content-length header is tried first
    // (what the wire carried), then Chrome's own size accounting, then a body read. A path none
    // of them can size keeps its status and the reason the last basis failed, so an incomplete
    // total names what it is missing instead of hiding it behind a count, and a later response
    // may still size it. The basis used is counted, because a compressed path and an
    // uncompressed one are not the same measure. The window name is captured when the response
    // arrives, so a slow body does not get attributed to a later phase.
    page.on("response", (response) => {
      let path;

      try {
        path = requestPath(response.url());
      } catch {
        unmeasuredPaths += 1;
        return;
      }

      const sized = firstTransfers.get(path);

      if (sized !== undefined) repeatedResponses += 1;

      let status = null;

      try {
        status = response.status();
      } catch {
        // The status stays unknown; the sizing below still runs.
      }

      const window = byteWindow;
      const entry = sized ?? { path, window, status, bytes: 0, basis: null, reason: null, attempts: 0 };
      entry.attempts += 1;
      firstTransfers.set(path, entry);

      // A later response only replaces the recorded size when it carries more bytes: that is
      // the real transfer behind a probe, and never a repeat of an asset already counted.
      const settle = (bytes, basis) => {
        if (!(Number.isFinite(bytes) && bytes > 0) || bytes <= entry.bytes) return;

        entry.bytes = bytes;
        entry.basis = basis;
        entry.reason = null;
        entry.window = window;
        entry.status = status;
      };
      const miss = (reason) => {
        if (entry.basis === null) entry.reason = reason;
      };
      const fromBody = () => {
        try {
          const pending = typeof response.body === "function" ? response.body() : null;

          if (pending !== null) {
            pending
              .then((buffer) => {
                if (buffer.byteLength > 0) settle(buffer.byteLength, "body");
                else miss("empty-body");
              })
              .catch(() => miss("body-unavailable"));
            return;
          }
        } catch {
          // Reason recorded below.
        }

        miss("body-unavailable");
      };
      const fromSizes = () => {
        try {
          const sizes = typeof response.sizes === "function" ? response.sizes() : null;
          const bodySize = sizes?.responseBodySize;

          if (Number.isFinite(bodySize) && bodySize > 0) {
            settle(bodySize, "sizes");
            return;
          }

          miss("sizes-empty");
        } catch {
          miss("sizes-unavailable");
        }

        fromBody();
      };

      try {
        const headers = typeof response.headers === "function" ? response.headers() : null;
        const length = Number(headers?.["content-length"]);

        if (Number.isFinite(length) && length > 0) {
          settle(length, "content-length");
          return;
        }

        miss("no-content-length");
      } catch {
        miss("headers-unavailable");
      }

      fromSizes();
    });

    // The production routing asks for the service worker through the site's own
    // registration script, which is why the isolated document needs a controlled load.
    const pageUrl =
      routing === "built"
        ? `${server.origin}/qa/retrieval.html?sw=1`
        : `${server.origin}/qa/retrieval.html`;

    // Armed before the first navigation, because the reload that gives the production routing
    // a controller belongs to the load the barrier below is waiting for.
    const startup = observeDeliveryPhase(page);

    const openPage = async () => {
      // One load bound for the whole startup: the navigation, the page's own API and the
      // delivery barrier share it, so the expected registration reload is waited for here
      // rather than by a second deadline or a retry. Every wait inside is bounded by what is
      // left of that one bound, and none of them can outlive it, so a page that stalls in any
      // of them ends on the declared load bound rather than on the sum of several waits.
      const startedAt = Date.now();
      const loadLeft = () => remainingLoadMs(startedAt, limits, startup);

      await withDeadline("page-goto", loadLeft(), page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: loadLeft() }));
      await withDeadline(
        "page-api-ready",
        loadLeft(),
        page.waitForFunction(() => typeof window.retrievalQa === "object", null, { timeout: loadLeft() }),
      );
      await waitForDeliveryControl(page, limits, { routing, observation: startup, startedAt });

      return Date.now() - startedAt;
    };

    console.log(`[qa] opening ${pageUrl} (${routing}, headless=${HEADLESS})`);
    const startupMs = await openPage();

    if (startup.navigations > 0) {
      console.log(`[qa] startup: ${startup.navigations} expected navigation(s) before the delivery barrier, at ${startup.path}`);
    }

    // The measurement boundary starts here. Everything above may reload, because the site's
    // registration script owns that navigation. From here a main-frame navigation is the dev
    // optimizer problem the run reports, so this listener is armed only after the barrier
    // passed, and the initial environment measurement cannot race the known startup reload.
    startup.phase = "measured";
    byteWindow = "probes";
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigated = true;
    });

    const environment = await timed("environment", page.evaluate(() => window.retrievalQa.environment()), limits.queryMs);
    const delivery = await timed("delivery", page.evaluate(() => window.retrievalQa.delivery()), limits.queryMs);
    const assets = await timed("runtime-assets", page.evaluate(() => window.retrievalQa.assets()), limits.loadMs);

    // What the worker actually stored, and a scoped offline replay of the same two URLs. Both
    // happen before the model is loaded and in their own phase, so neither is counted as an
    // encoder download or as part of a query, and neither invents an initial-download or cache
    // budget. Only the production routing has the worker that stores these files.
    byteWindow = "offline";
    const runtimeCache =
      routing === "built" ? await timed("runtime-cache", page.evaluate(() => window.retrievalQa.runtimeCache()), limits.loadMs) : null;
    const offline = routing === "built" ? await replayRuntimeOffline(browser, page, limits, phase) : null;

    // The cache gate, on the stored bytes and the offline replay rather than on a timing field.
    // It is judged before the first read of it, because the log below reads it: a proof built
    // after its own logging would throw there instead of being reported.
    const cacheProof = evaluateRuntimeCacheProof({
      routing,
      stored: runtimeCache?.stored ?? null,
      replay: offline?.result ?? null,
      replayError: offline?.failure ?? null,
      consumed: assets.entries,
      declared: assets.declared,
    });

    if (navigated) {
      throw qaFailure("page-reloaded-during-run", "page-reloaded-during-run: the main frame navigated after the delivery barrier");
    }
    console.log("[qa] environment:", JSON.stringify(environment));
    console.log("[qa] delivery:", JSON.stringify({ ...delivery, runtime: delivery.runtime.length }));
    console.log("[qa] assets:", JSON.stringify(assets.entries));

    if (runtimeCache !== null) {
      console.log(
        "[qa] stored runtime files:",
        JSON.stringify(runtimeCache.stored.map((entry) => ({ path: entry.path, cacheName: entry.cacheName, status: entry.headers?.status ?? null, bytes: entry.bytes, sha256: entry.sha256 }))),
      );
      console.log("[qa] offline replay window:", JSON.stringify(offline.window), "replay:", JSON.stringify(offline.result?.replayed ?? null));
      console.log("[qa] cache proof:", JSON.stringify({ applicable: cacheProof.applicable, checks: cacheProof.checks, failures: cacheProof.failures }));
    }

    // Sampled run: one input, inspected before the bounded workload.
    console.log(`[qa] loading the pinned model and embedding one sampled input`);
    byteWindow = "model";
    const opened = await timed("model-load", page.evaluate(() => window.retrievalQa.open()), limits.loadMs);
    const progress = await page.evaluate(() => window.retrievalQa.progressReport());
    byteWindow = "queries";
    console.log("[qa] model:", JSON.stringify({ ...opened, files: opened.files.length }));

    const sample = (
      await timed("query:sample", page.evaluate((inputs) => window.retrievalQa.embed(inputs), [queries[0]]))
    )[0];
    console.log(
      "[qa] sample:",
      JSON.stringify({ id: sample.id, dimensions: sample.dimensions, norm: sample.norm, tokenCount: sample.tokenCount, durationMs: Math.round(sample.durationMs * 10) / 10 }),
    );

    if (sample.dimensions !== EXPECTED_EMBEDDING.dimensions || !sample.finite || Math.abs(sample.norm - 1) > NORM_TOLERANCE) {
      throw qaFailure("sampled-vector-invalid");
    }

    // Bounded workload: the rest of the frozen cases, each under its own per-query deadline,
    // because one stalled question must fail on its own bound instead of stalling the batch.
    const reports = [];

    for (const query of queries.slice(1)) {
      const [report] = await timed(
        `query:${query.id}`,
        page.evaluate((inputs) => window.retrievalQa.embed(inputs), [query]),
      );

      reports.push(report);
    }

    const byId = new Map([sample, ...reports].map((report) => [report.id, report]));

    // The model bytes this browser consumed, against the generator's admitted digests. The
    // URLs are the ones the page really asked for: the origin the worker reports serving them
    // from, joined to the route the manifest pins, and no vendor address the browser never
    // reaches.
    const remoteBase = `${opened.remoteHost ?? ""}${MXBAI_ROUTE}`;
    const admittedUrls = frozen.admitted.assets.map((asset) => ({
      name: asset.file,
      url: `${remoteBase}${asset.file}`,
    }));
    const consumed = await timed("model-assets", page.evaluate((inputs) => window.retrievalQa.modelAssets(inputs), admittedUrls), limits.loadMs);

    const oversize = await timed("oversize", page.evaluate(() => window.retrievalQa.oversize()));
    const supersede = await timed(
      "supersede",
      page.evaluate((inputs) => window.retrievalQa.supersede(inputs[0], inputs[1]), [queries[0].probe, queries[1].probe]),
    );
    const controller = await timed("controller", page.evaluate((text) => window.retrievalQa.controllerProbe(text), queries[3].probe));
    const lexical = await timed("lexical", page.evaluate((text) => window.retrievalQa.lexicalProbe(text), queries[3].probe));
    const guards = await timed("guards", page.evaluate(() => window.retrievalQa.guards()));

    await timed("close", page.evaluate(() => window.retrievalQa.close()));

    // Cross-runtime parity over the recorded Node vectors, then decision 9 over the
    // recorded card vectors. The frozen Node run is the generator-side reference.
    const parity = [];
    const branches = [];
    const roundedBranches = [];

    for (const entry of frozen.cases.cases) {
      const report = byId.get(entry.id);
      const frozenCase = frozen.byCase.get(entry.id);

      if (report === undefined || frozenCase === undefined) throw qaFailure("frozen-case-missing", `frozen-case-missing:${entry.id}`);

      const difference = maxAbsoluteDifference(report.vector, frozenCase.vector);
      const cardScores = cardOrder.map((id) => ({ id, score: cosine(report.vector, frozen.cardVectors.get(id)) }));
      const ranking = {
        scored: cardScores.sort((left, right) => (right.score - left.score) || (left.id < right.id ? -1 : 1)),
        dimensions: EXPECTED_EMBEDDING.dimensions,
      };
      const selection = selectAnswer(ranking);
      const observed = {
        branch: branchName(selection),
        topCardId: ranking.scored[0].id,
        topScore: ranking.scored[0].score,
        secondScore: ranking.scored[1]?.score ?? 0,
        margin: ranking.scored[0].score - (ranking.scored[1]?.score ?? 0),
        ranking: ranking.scored.map((card) => card.id),
      };
      const roundedRanking = {
        scored: cardScores
          .map((card) => ({ id: card.id, score: cosine(report.vector, roundVector(frozen.cardVectors.get(card.id))) }))
          .sort((left, right) => (right.score - left.score) || (left.id < right.id ? -1 : 1)),
        dimensions: EXPECTED_EMBEDDING.dimensions,
      };

      if (report.durationMs > limits.queryMs) throw qaFailure("warm-query-bound", `warm-query-bound:${entry.id}`);

      parity.push({
        id: entry.id,
        maxAbsDifference: difference,
        withinTolerance: difference <= VECTOR_TOLERANCE,
        orderMatches: observed.ranking.join("|") === frozenCase.ranking.map((card) => card.id).join("|"),
        nodeBranch: frozenCase.branch,
        browserBranch: observed.branch,
        norm: report.norm,
        tokenCount: report.tokenCount,
        durationMs: Math.round(report.durationMs * 10) / 10,
      });
      branches.push({ ...observed, id: entry.id, held: meetsExpectation(entry.expect, observed) });
      roundedBranches.push({ id: entry.id, branch: branchName(selectAnswer(roundedRanking)) });
    }

    // The three-way identity: this harness's pinned copy, the admitted generator record, and
    // the bytes the browser actually consumed. A constant compared with itself is not here.
    const consumedEntries = consumed.entries;
    const ortEntry = assets.entries.find((entry) => entry.path === ORT_WASM_PATHS.wasm);
    const factoryEntry = assets.entries.find((entry) => entry.path === ORT_WASM_PATHS.mjs);
    const identityChecks = {
      assetCount: consumedEntries.length === frozen.admitted.assets.length,
      allOk: consumedEntries.every((entry) => entry.status === 200),
      bytesMatchAdmitted: consumedEntries.every((entry, index) => entry.bytes === frozen.admitted.assets[index]?.bytes),
      digestMatchAdmitted: consumedEntries.every((entry, index) => entry.sha256 === frozen.admitted.assets[index]?.sha256),
      pinnedMatchesAdmitted: FROZEN.modelAssets.every(
        (pinned, index) =>
          frozen.admitted.assets[index]?.sha256 === pinned.sha256 &&
          frozen.admitted.assets[index]?.bytes === pinned.bytes,
      ),
      observedConfigMatchesAdmitted:
        consumed.observedConfig.hidden_size === FROZEN.observedConfig.hiddenSize &&
        consumed.observedConfig.model_type === FROZEN.observedConfig.modelType &&
        consumed.observedConfig.max_position_embeddings === FROZEN.observedConfig.maxPositionEmbeddings &&
        consumed.observedConfig.vocab_size === FROZEN.observedConfig.vocabularySize,
      observedTokenizerMatchesAdmitted:
        consumed.observedTokenizer.model_max_length === FROZEN.observedTokenizer.modelMaxLength &&
        consumed.observedTokenizer.truncation_side === FROZEN.observedTokenizer.truncationSide &&
        consumed.observedTokenizer.padding_side === FROZEN.observedTokenizer.paddingSide,
      // The dimension the real tensor produced, the config the browser read, the generator's
      // record and the artifact must be one number, not one constant compared with itself.
      dimensionsAgree:
        sample.dimensions === consumed.observedConfig.hidden_size &&
        sample.dimensions === frozen.admitted.config.hiddenSize &&
        sample.dimensions === EXPECTED_EMBEDDING.dimensions,
      revisionLiteralsOnly:
        opened.remotePathTemplate?.includes(EXPECTED_EMBEDDING.revision) === true &&
        !opened.remotePathTemplate?.includes("{revision}") &&
        !requested.some((url) => url.includes("/resolve/main/")),
      ortWasmMatchesGenerator: ortEntry?.bytes === FROZEN.ortWasmBytes && ortEntry?.sha256 === ADAPTER_CONTRACT.ortWasmSha256,
      ortFactoryMatchesGenerator: factoryEntry?.sha256 === ADAPTER_CONTRACT.ortFactorySha256,
    };

    // Isolation is the worker's doing in production: the same URLs carry no COOP/COEP from
    // the static server that serves them, and carry them in the browser.
    const runtimePaths = Object.values(ORT_WASM_PATHS);
    const deliveryChecks = {
      serverSendsNoIsolation: runtimePaths.every(
        (path) =>
          serverHeaders[path]?.crossOriginOpenerPolicy === null && serverHeaders[path]?.crossOriginEmbedderPolicy === null,
      ),
      pageIsolated: delivery.crossOriginIsolated === true,
      serviceWorkerControlled: delivery.serviceWorkerControlled === true,
      runtimeIsolated: delivery.runtime.every(
        (entry) =>
          entry.bypassed.crossOriginOpenerPolicy === "same-origin" &&
          entry.bypassed.crossOriginEmbedderPolicy === "require-corp",
      ),
      servedByServiceWorker: delivery.cacheNames.some((name) => name.startsWith("cv-")),
    };

    // A path no browser basis could size is measured from the served file instead, and only on
    // this run's own origin: the bytes the server would send are what the transfer carried
    // (neither routing compresses), while a third-party path is left unmeasured and named in
    // the report rather than fetched again by the harness.
    for (const entry of firstTransfers.values()) {
      if (entry.basis !== null || !entry.path.startsWith(`${server.origin}/`)) continue;

      try {
        const served = await fetch(entry.path);
        const body = await served.arrayBuffer();

        if (served.ok && body.byteLength > 0) {
          entry.bytes = body.byteLength;
          entry.basis = "served-file";
          entry.reason = null;
        }
      } catch {
        // The path stays unmeasured and is named in the report instead of being guessed.
      }
    }

    // The cold byte footprint: one size per request path, the largest body observed for it, so
    // the harness's own repeat fetches do not inflate what a cold visit costs while a range
    // probe followed by the real transfer on one path is still counted once and in full.
    const network = {
      bytes: 0,
      paths: 0,
      byWindow: { startup: 0, probes: 0, offline: 0, model: 0, queries: 0 },
      byBasis: { "content-length": 0, sizes: 0, body: 0, "served-file": 0 },
      unmeasured: unmeasuredPaths,
      repeatedResponses,
      complete: unmeasuredPaths === 0,
      entries: [],
    };

    for (const entry of firstTransfers.values()) {
      network.entries.push({
        path: entry.path,
        window: entry.window,
        status: entry.status,
        bytes: entry.bytes,
        basis: entry.basis,
        reason: entry.reason,
        responses: entry.attempts,
      });

      if (entry.basis === null) {
        network.unmeasured += 1;
        network.complete = false;
        continue;
      }

      network.bytes += entry.bytes;
      network.paths += 1;
      network.byWindow[entry.window] += entry.bytes;
      network.byBasis[entry.basis] += 1;
    }

    const report = {
      routing,
      headless: HEADLESS,
      origin: server.origin,
      pageUrl,
      bounds: limits,
      identity: {
        model: EXPECTED_EMBEDDING.model,
        revision: EXPECTED_EMBEDDING.revision,
        runtimeVersion: opened.runtimeVersion,
        remoteHost: opened.remoteHost,
        remotePathTemplate: opened.remotePathTemplate,
        filesRead: opened.files,
        dimensions: opened.dimensions,
        loadMs: Math.round(opened.loadMs),
        loadWithinBound: opened.loadMs <= limits.loadMs,
        observedTensorDimensions: sample.dimensions,
        observedConfig: consumed.observedConfig,
        observedTokenizer: consumed.observedTokenizer,
        consumed: consumedEntries,
        consumedSources: Object.fromEntries(consumedEntries.map((entry) => [entry.name, entry.source])),
        admitted: frozen.admitted,
        checks: identityChecks,
      },
      environment,
      delivery: {
        page: delivery,
        server: serverHeaders,
        checks: deliveryChecks,
      },
      assets: {
        entries: assets.entries,
        declared: assets.declared,
        bytesMatch: assets.entries.every((entry, index) => entry.bytes === assets.declared[index].bytes),
        digestMatch: assets.entries.every((entry, index) => entry.sha256 === assets.declared[index].sha256),
        servedPaths: runtimePaths,
      },
      progress,
      cache: {
        proof: cacheProof.applicable ? "stored-bytes-and-offline-replay" : "not-applicable-outside-the-service-worker-routing",
        checks: cacheProof.checks,
        failures: cacheProof.failures,
        storage: runtimeCache,
        replay: offline === null ? null : { result: offline.result, failure: offline.window.failure, restoration: offline.window.restoration, window: offline.window },
      },
      sample: { id: sample.id, dimensions: sample.dimensions, norm: sample.norm, tokenCount: sample.tokenCount, durationMs: Math.round(sample.durationMs * 10) / 10 },
      parity: {
        tolerance: VECTOR_TOLERANCE,
        worst: Math.max(...parity.map((entry) => entry.maxAbsDifference)),
        allWithinTolerance: parity.every((entry) => entry.withinTolerance),
        allOrdersMatch: parity.every((entry) => entry.orderMatches),
        cases: parity,
      },
      calibration: {
        fixture: "synthetic-cases-v2",
        fixtureSha256: FROZEN.cases,
        constants: { relevanceFloor: RELEVANCE_FLOOR, confidence: CONFIDENCE, margin: CONFIDENCE_MARGIN },
        gateConstants: frozen.gate.thresholds,
        constantsMatchGate:
          RELEVANCE_FLOOR === frozen.gate.thresholds.relevanceFloor &&
          CONFIDENCE === frozen.gate.thresholds.confidence &&
          CONFIDENCE_MARGIN === frozen.gate.thresholds.margin,
        changed: false,
        allExpectationsHeld: branches.every((entry) => entry.held),
        roundedCardVectorsSameBranch: roundedBranches.every((entry, index) => entry.branch === branches[index].branch),
        cases: branches,
      },
      limits: {
        oversize,
        supersede,
        controller,
        lexical,
        guards,
      },
      startup: {
        durationMs: startupMs,
        navigations: startup.navigations,
      },
      network: {
        basis: "largest-body-per-request-path",
        sizing: "content-length-else-sizes-else-body-else-same-origin-served-file",
        bytes: network.bytes,
        paths: network.paths,
        byWindow: network.byWindow,
        byBasis: network.byBasis,
        unmeasuredPaths: network.unmeasured,
        repeatedResponses: network.repeatedResponses,
        complete: network.complete,
        entries: network.entries,
      },
      requests: {
        total: requested.length,
        runtimeAssets: requested.filter((url) => url.includes("/ort/")),
        modelRequests: [...new Set(requested.filter((url) => url.includes(MXBAI_ROUTE)))].sort(),
        // Everything the page asked for outside its own origin, kept as origins and paths so
        // a self-host proof can show what still leaves the site, and by which exception.
        offOrigin: [...new Set(requested.filter((url) => !url.startsWith(server.origin)))].sort(),
        offOriginBlocked: BLOCK_OFF_ORIGIN,
        asyncifyRequested: requested.some((url) => url.includes("asyncify")),
      },
      failures: {
        observed,
        expectedOffline: offline === null ? [] : offline.window.expected,
        blocking: observed.filter((entry) => entry.disposition !== "expected").length,
      },
      notOk: observed.filter((entry) => entry.source === "http").map((entry) => ({ status: entry.status, path: entry.path })),
      fixtureCards: cardOrder.length,
      dimensions: EXPECTED_EMBEDDING.dimensions,
    };

    mkdirSync(OUT_DIR, { recursive: true });
    const reportFile = join(OUT_DIR, `retrieval-qa-${routing}.json`);
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);

    console.log(`[qa] report written to ${reportFile}`);
    console.log(
      "[qa] summary:",
      JSON.stringify({
        routing,
        isolated: environment.isolated,
        serviceWorkerControlled: delivery.serviceWorkerControlled,
        serverIsolationHeaders: isolationHeaders(serverHeaders[runtimePaths[0]] ?? {}),
        pageIsolationHeaders: isolationHeaders(delivery.runtime[0]?.bypassed ?? {}),
        gpuObjectPresent: environment.gpuObjectPresent,
        runtimeVersion: opened.runtimeVersion,
        remotePathTemplate: opened.remotePathTemplate,
        loadMs: Math.round(opened.loadMs),
        startupMs,
        coldBytes: report.network.bytes,
        coldComplete: report.network.complete,
        coldUnmeasured: report.network.unmeasuredPaths,
        progressEvents: progress.events,
        identityChecks,
        deliveryChecks,
        cacheProof: cacheProof.applicable ? { checks: cacheProof.checks, failures: cacheProof.failures } : "not-applicable-outside-the-service-worker-routing",
        parityWorst: report.parity.worst,
        ordersMatch: report.parity.allOrdersMatch,
        branchesHeld: report.calibration.allExpectationsHeld,
        assetBytesMatch: report.assets.bytesMatch,
        assetDigestMatch: report.assets.digestMatch,
        asyncifyRequested: report.requests.asyncifyRequested,
        oversize,
        supersede,
        controller: controllerSummary(controller),
        lexical,
        modelRequestPaths: report.requests.modelRequests.length,
        offOriginRequestPaths: report.requests.offOrigin,
        offOriginBlocked: report.requests.offOriginBlocked,
        notOk: report.notOk,
      }),
    );

    const failures = [];
    if (!report.identity.loadWithinBound) failures.push("model-load-bound");
    if (!report.assets.bytesMatch || !report.assets.digestMatch) failures.push("runtime-asset-bytes");
    for (const [check, held] of Object.entries(identityChecks)) {
      if (!held) failures.push(`identity-${check.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
    }
    if (routing === "built") {
      for (const [check, held] of Object.entries(deliveryChecks)) {
        if (!held) failures.push(`delivery-${check.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
      }

      // The stored bytes and the offline replay, which the pre-fix `runtime-cacheable` timing
      // check could not decide.
      failures.push(...cacheProof.failures);
    }
    if (!report.parity.allWithinTolerance) failures.push("cross-runtime-parity");
    if (!report.parity.allOrdersMatch) failures.push("ranking-order");
    if (!report.calibration.constantsMatchGate) failures.push("threshold-drift");
    if (!report.calibration.allExpectationsHeld) failures.push("named-case-expectation");
    if (!oversize.refused || oversize.reason !== "query/too-long") failures.push("token-cap-refusal");
    // The predictions the run collects but must judge: every guard has to refuse, the newer
    // question has to land, both answer paths have to carry their matching metadata, and every
    // failure the run observed blocks unless the offline phase explained it with evidence.
    failures.push(...workloadGate({ guards, supersede, controller, lexical, observed }));
    if (offline !== null && offline.failure !== null) failures.push("offline-replay-failed");
    if (offline !== null) {
      const restoration = restorationProblem(offline);

      if (restoration !== null) failures.push(restoration);
    }
    if (report.requests.asyncifyRequested) failures.push("asyncify-requested");

    if (failures.length > 0) {
      process.exitCode = 1;
      console.log(`[qa] FAILED: ${failures.join(", ")}`);
    } else {
      console.log("[qa] done");
    }
  } catch (error) {
    // A deadline that fired is the run's result, not a crash: it is named with its own bound
    // so the evidence says which wait stopped answering.
    if (cleanup.ended()) {
      console.log("[qa] work unwound after the whole-run deadline, once its resources were closed");
      return;
    }

    // The boundary reports the stage and the classified reason, never a vendor message. The
    // thrown value stays with the run that produced it and still ends the run; an unexplained
    // one is named `unexpected` rather than copied into the log.
    console.log(`[qa] FAILED: ${JSON.stringify(boundaryFailure(phase.stage, error))}`);
    process.exitCode = 1;
  } finally {
    // Success and failure close through one ledger, so a run that ends in a deadline still
    // closes the browser and the server it started, and records what it could confirm. The
    // whole-run deadline drains the same ledger when the work is still running, and a drain
    // joins the one already running, so this waits for the same closes instead of settling
    // next to them or reporting a resource as closed that is still open.
    reportCleanup(await cleanup.drain());
  }
}

/**
 * The run's own orchestration, without the whole-run deadline around it.
 *
 * Exported so `test/retrieval-qa-orchestration.test.ts` can drive this control flow with its
 * own seams. Production reaches it through {@link boundRetrievalQaRun}, which is what gives
 * the run its whole-run deadline and the cleanup that reaches it.
 */
export const runRetrievalQaWork = main;

/**
 * Binds the whole-run deadline to the cleanup this run owns.
 *
 * The bare deadline is only a race: the runner would settle while the work kept waiting, so
 * a stalled page call would never reach its own `finally` and the browser and the server
 * this process started would stay open. `test/qa-deadlines.test.ts` pins this binding and
 * exercises the runner's control flow with stub handles, because the guarantee belongs to
 * the entry and not to the deadline helper alone.
 */
function boundRetrievalQaRun(
  run,
  { limits = readLimits(), closeMs = CLEANUP_CLOSE_MS, onCleanup = reportCleanup } = {},
) {
  return withOwnedDeadline("whole-run", limits.runMs, run, { closeMs, onCleanup });
}

/**
 * Runs the retrieval workload. `scripts/voice-qa.mjs --qa=retrieval` calls this, so the
 * model and browser check has one entry point, and running this file directly does the same.
 */
export async function runRetrievalQa() {
  try {
    await boundRetrievalQaRun((cleanup) => main(cleanup));
  } catch (error) {
    // Only the whole-run deadline reaches here, because the work reports its own failures.
    // The deadline that ended the run is named with its own stage and bound, so nothing
    // escapes as an unhandled rejection and no library message reaches the log.
    console.log(`[qa] FAILED: ${JSON.stringify(boundaryFailure("whole-run", error))}`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1];

if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  await runRetrievalQa();
}
