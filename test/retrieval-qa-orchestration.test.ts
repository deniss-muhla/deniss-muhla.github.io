import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ORT_ROUTE, ORT_RUNTIME_ASSETS, ORT_WASM_PATHS } from "../src/chat/retrieval/encoder/runtime-assets.ts";
import { EXPECTED_EMBEDDING } from "../src/chat/retrieval/index.ts";
import { CONFIDENCE, CONFIDENCE_MARGIN, RELEVANCE_FLOOR } from "../src/chat/retrieval/selection.ts";
import { createCleanupLedger } from "../scripts/qa-deadlines.ts";
import type { ObservedFailure, WorkloadGateInput } from "../scripts/retrieval-qa.mjs";
import { guardedTest, qaArtifacts, skipLedgerMarker } from "./build-preconditions.ts";

/**
 * The retrieval run's own orchestration, and the failure accounting it judges itself by.
 *
 * The first group drives the shipped control flow: `runRetrievalQaWork` is the run itself,
 * with the server, the browser, the fixture and the routing replaced through the seams the
 * module exposes, and it runs through the encoder load, the whole sampled workload, the
 * report and the run's own final acceptance gate. Nothing here reimplements the branch, so a
 * proof that is built after its own first read fails these cases the same way it fails a built
 * run. The static server is a real one, because the run's own server probe and header
 * measurement are part of what is being exercised, and it is closed by the check that started
 * it.
 *
 * The second group judges the classification and the acceptance predicates on their own, with
 * synthetic records. Nothing carries question text, card text or an answer: a refusal is named
 * by its reason and a failure by its class, which is exactly what a report is allowed to keep.
 */

/** The harness reads its directories once, when the module loads, so the check owns them first. */
const outDir = mkdtempSync(join(tmpdir(), "retrieval-qa-orchestration-"));
process.env.RETRIEVAL_QA_OUT = outDir;
process.env.RETRIEVAL_QA_PROFILE = join(outDir, "browser-profile");

// A promise, not an await, so the environment above is in place before the module is loaded.
const qa = import("../scripts/retrieval-qa.mjs");

/**
 * The built branch's documented precondition: the QA-gated artifact the plain production build
 * intentionally omits. Where it is absent the twelve checks below skip under their own names,
 * and the marker at the end of this file asserts every one of them recorded that skip.
 */
const QA_ARTIFACTS = qaArtifacts();

/** The offline replay context the classifier is given only where the run itself set it offline. */
const OFFLINE = { offline: true };

/** One observed failure in the only form the classifier and the gate read. */
function failure(source: ObservedFailure["source"], over: Partial<ObservedFailure> = {}): ObservedFailure {
  return { stage: "offline-replay", source, reason: "unclassified", disposition: "blocking", ...over };
}

/** The two runtime files, in the one place every page-shaped record of them is built from. */
const RUNTIME_FILES = ORT_RUNTIME_ASSETS.map((asset) => ({ path: `${ORT_ROUTE}${asset.name}`, name: asset.name, bytes: asset.bytes, sha256: asset.sha256 }));

/** What a browser reports for a console error: its class is parsed from the text, its path from the location. */
function consoleErrorMessage(url: string, text = "Failed to load resource: net::ERR_INTERNET_DISCONNECTED") {
  return { type: () => "error", text: () => text, location: () => ({ url, lineNumber: 0, columnNumber: 0 }) };
}

/**
 * A unit vector with the given axis weights. The synthetic cases below need two axes at most.
 *
 * Card A is the first axis and card B the second, so a vector along the first axis scores 1.0
 * on card A and 0.0 on card B, and one at 0.5 along the first axis and the square root of the
 * remainder along a third scores 0.5 on card A and nothing on either other. The run's own
 * ranking, parity and calibration arithmetic therefore runs on vectors it computed itself.
 */
function weighted(weights: Readonly<Record<number, number>>): number[] {
  const vector = Array.from({ length: EXPECTED_EMBEDDING.dimensions }, () => 0);

  for (const [axis, weight] of Object.entries(weights)) vector[Number(axis)] = weight;

  return vector;
}

const CARD_A = weighted({ 0: 1 });
const CARD_B = weighted({ 1: 1 });
const CONFIDENT = weighted({ 0: 1 });
const WEAK = weighted({ 0: 0.5, 2: Math.sqrt(0.75) });
/** The ranking the frozen reference records per case, in the shape the run reads it back in. */
const RANKING = [{ id: "card-a" }, { id: "card-b" }];

/**
 * The frozen case set the run reads, with four cases because the run probes its answer paths
 * on the fourth one. Every expectation is one the synthetic vectors below actually produce.
 */
const CASES = [
  { id: "q-1", probe: "probe-one", expect: { branchIs: "confident-answer", topCardId: "card-a" } },
  { id: "q-2", probe: "probe-two", expect: { branchIs: "weak-answer", topCardId: "card-a" } },
  { id: "q-3", probe: "probe-three", expect: { branchIs: "confident-answer" } },
  { id: "q-4", probe: "probe-four", expect: { branchIs: "confident-answer" } },
];

const QUERY_VECTORS = new Map([
  ["q-1", CONFIDENT],
  ["q-2", WEAK],
  ["q-3", CONFIDENT],
  ["q-4", CONFIDENT],
]);

/**
 * The frozen fixture the run reads: synthetic ids and vectors, with no question text kept.
 *
 * The admitted assets and the observed configuration and tokenizer values are the harness's
 * own pinned identity, so the three-way identity check compares the stub's consumed bytes
 * against the same values a real run compares them against.
 */
function stubFrozen(pin: typeof import("../scripts/retrieval-qa.mjs").pinnedModelIdentity) {
  const thresholds = { relevanceFloor: RELEVANCE_FLOOR, confidence: CONFIDENCE, margin: CONFIDENCE_MARGIN };

  return {
    cases: { cases: CASES, gate: { thresholds } },
    gate: { thresholds },
    cardVectors: new Map([
      ["card-a", CARD_A],
      ["card-b", CARD_B],
    ]),
    byCase: new Map(
      CASES.map((entry) => {
        const vector = QUERY_VECTORS.get(entry.id);

        // The frozen case set and the vectors that answer it are one fixture; a case without
        // its own vector blocks here instead of comparing an absent vector against the sample.
        assert.ok(vector !== undefined, `orchestration-fixture-missing: query vector for ${entry.id}`);

        return [entry.id, { id: entry.id, vector, branch: "confident-answer", ranking: RANKING }] as const;
      }),
    ),
    admitted: {
      assets: pin.modelAssets.map((asset) => ({ file: asset.name, bytes: asset.bytes, sha256: asset.sha256 })),
      config: pin.observedConfig,
      tokenizer: pin.observedTokenizer,
    },
  };
}

/** The model files the browser is recorded as having consumed, in the admitted record's order. */
function modelAssets(pin: typeof import("../scripts/retrieval-qa.mjs").pinnedModelIdentity, origin: string) {
  return {
    entries: pin.modelAssets.map((asset) => ({ name: asset.name, status: 200, bytes: asset.bytes, sha256: asset.sha256, source: "cache-storage" })),
    observedConfig: {
      hidden_size: pin.observedConfig.hiddenSize,
      model_type: pin.observedConfig.modelType,
      max_position_embeddings: pin.observedConfig.maxPositionEmbeddings,
      vocab_size: pin.observedConfig.vocabularySize,
    },
    observedTokenizer: {
      model_max_length: pin.observedTokenizer.modelMaxLength,
      truncation_side: pin.observedTokenizer.truncationSide,
      padding_side: pin.observedTokenizer.paddingSide,
    },
    origin,
  };
}

/** How the controller probe's own payload deviates from the nested shape its producer returns. */
type ControllerShape = "nested" | "flat" | "no-answer" | "no-kind";

/**
 * The answer paths and guards the run reads at the end of its workload.
 *
 * The controller metadata is nested under `answer`, the way `qa/retrieval-main.ts` returns it,
 * and the lexical metadata is flat, the way the same producer returns it. The other two shapes
 * are the ones that must block: the flat controller metadata of the old gate read, a probe
 * without an `answer` at all, and an answer object with no kind.
 */
function answerPaths(shape: ControllerShape) {
  const answer = { kind: "answer", cardId: "card-a", matching: "semantic", weak: false, limitedCause: null };
  const controller =
    shape === "nested"
      ? { cards: 2, topCardId: "card-a", answer }
      : shape === "flat"
        ? { cards: 2, ...answer }
        : shape === "no-answer"
          ? { cards: 2, topCardId: "card-a" }
          : { cards: 2, topCardId: "card-a", answer: { cardId: "card-a", matching: "semantic", limitedCause: null } };

  return {
    controllerProbe: controller,
    // A null encoder never produces a semantic match: the controller's `ask(question, null)`
    // takes the lexical branch, so this probe reports the limited match and the cause it fell
    // back for. The fixture's earlier `matching: "semantic"` was an outcome the real producer
    // cannot return, which is part of why the old gate judged nothing here.
    lexicalProbe: { kind: "rephrase", matching: "limited", limitedCause: "model-unavailable", cardId: null },
    guards: [
      { name: "wrong-dimension", reason: "encoder/wrong-dimensions" },
      { name: "malformed-index", reason: "index/version-mismatch" },
    ],
  };
}

/** What the run under test is made to answer differently from a clean run. */
interface StubAnswers {
  /** The controller payload's own answer, where `nested` is the shape the real producer returns. */
  controller?: Record<string, unknown>;
  /** The lexical probe's own metadata, as the page reports it. */
  lexical?: { kind: string; matching: string | null; limitedCause: string | null; cardId?: string | null };
  /** The superseding outcomes the page reports, where a missing field is a missing outcome. */
  supersede?: { older?: string; newer?: string };
}

/** Everything the page answers, per call. No content, only measurements and branch metadata. */
function pageAnswers(
  pin: typeof import("../scripts/retrieval-qa.mjs").pinnedModelIdentity,
  origin: string,
  shape: ControllerShape,
  over: StubAnswers = {},
) {
  const answers = answerPaths(shape);

  return {
    environment: { isolated: true, serviceWorker: true, gpuObjectPresent: false, secureContext: true, locationOrigin: origin },
    delivery: {
      crossOriginIsolated: true,
      serviceWorkerControlled: true,
      cacheNames: ["cv-runtime-v1"],
      runtime: RUNTIME_FILES.map((file) => ({ path: file.path, bypassed: { crossOriginOpenerPolicy: "same-origin", crossOriginEmbedderPolicy: "require-corp" } })),
    },
    assets: {
      entries: RUNTIME_FILES.map((file) => ({ path: file.path, status: 200, contentType: "text/plain", bytes: file.bytes, sha256: file.sha256 })),
      declared: RUNTIME_FILES.map((file) => ({ name: file.name, bytes: file.bytes, sha256: file.sha256 })),
    },
    runtimeCache: {
      names: ["cv-runtime-v1"],
      stored: RUNTIME_FILES.map((file) => ({ path: file.path, url: `${origin}${file.path}`, cacheName: "cv-runtime-v1", found: true, headers: { status: 200 }, bytes: file.bytes, sha256: file.sha256 })),
      declared: RUNTIME_FILES.map((file) => ({ name: file.name, bytes: file.bytes, sha256: file.sha256 })),
    },
    replayRuntime: {
      phase: "offline-replay",
      offline: true,
      crossOriginIsolated: true,
      serviceWorkerControlled: true,
      replayed: RUNTIME_FILES.map((file) => ({
        path: file.path,
        url: `${origin}${file.path}`,
        status: 200,
        headers: { crossOriginOpenerPolicy: "same-origin", crossOriginEmbedderPolicy: "require-corp" },
        bytes: file.bytes,
        sha256: file.sha256,
        error: null,
      })),
    },
    open: {
      state: "ready",
      dimensions: EXPECTED_EMBEDDING.dimensions,
      loadMs: 12,
      runtimeVersion: "3.0.0",
      remoteHost: "https://huggingface.co",
      remotePathTemplate: `https://huggingface.co/{model}/resolve/${EXPECTED_EMBEDDING.revision}/`,
      files: [],
    },
    progressReport: { events: 1, files: ["model_quantized.onnx"], lastPercent: 100 },
    modelAssets: modelAssets(pin, origin),
    oversize: { refused: true, reason: "query/too-long", length: 100_000, durationMs: 1 },
    supersede: over.supersede ?? { older: "embed/superseded", newer: "resolved" },
    ...answers,
    controllerProbe: over.controller ?? answers.controllerProbe,
    lexicalProbe: over.lexical ?? answers.lexicalProbe,
    close: null,
  };
}

interface StubRun {
  calls: string[];
  offlineSwitches: boolean[];
  browser: { pages: () => unknown[]; newPage: () => Promise<unknown>; setOffline: (value: boolean) => Promise<void>; close: () => Promise<void> };
  child: { exitCode: number | null; once: (event: string, handler: () => void) => void; kill: () => void };
}

/** What the run under test is made to do differently from a clean run. */
interface StubMode {
  replay: "revalidation" | "unrelated" | "http" | "none";
  /** The controller payload's shape, where `nested` is what the real producer returns. */
  controller?: ControllerShape;
  /** Whether the context refuses the restore that ends the offline phase. */
  restoration?: "clean" | "fails";
  /** What the page answers instead of what its own producers return. */
  answers?: StubAnswers;
}

const CLEAN: StubMode = { replay: "none" };

/**
 * A page, a browser context and a child process, each recording what the run asked of it.
 *
 * `replay` decides what the page produces while the context is offline: a revalidation failure
 * with its network evidence, an unrelated page error with none, an HTTP status failure, or
 * nothing at all.
 *
 * The workload is answered all the way through, so the run reaches its own final report and
 * acceptance gate. Every answer is derived from the synthetic fixture rather than recorded, and
 * nothing carries question text, card text or an answer.
 */
function stubRun(mode: StubMode, origin: string, pin: typeof import("../scripts/retrieval-qa.mjs").pinnedModelIdentity): StubRun {
  const listeners = new Map<string, Array<(argument: unknown) => void>>();
  const calls: string[] = [];
  const offlineSwitches: boolean[] = [];
  const fire = (event: string, argument: unknown) => {
    for (const handler of listeners.get(event) ?? []) handler(argument);
  };
  const frame = { url: () => "http://127.0.0.1/qa/retrieval.html?sw=1" };

  const page = {
    mainFrame: () => frame,
    on(event: string, handler: (argument: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return page;
    },
    setDefaultTimeout: () => undefined,
    setDefaultNavigationTimeout: () => undefined,
    async goto() {
      return null;
    },
    async waitForFunction() {
      return undefined;
    },
    async evaluate(fn: () => unknown, argument?: unknown) {
      const source = String(fn);

      // The barrier's own probe reads the delivery state of the current document; it names the
      // page's API only to ask whether that API is there, so it is matched first.
      if (source.includes("navigator.serviceWorker")) {
        return { controlled: true, isolated: true, coiSeen: true, ready: true };
      }

      const method = /retrievalQa\.(\w+)/.exec(source)?.[1] ?? "";
      const answers: Record<string, unknown> = pageAnswers(pin, origin, mode.controller ?? "nested", mode.answers);

      // A page call this stub does not answer is named here rather than answered as `undefined`.
      // `embed` is the one method answered below rather than from the table above, because it
      // answers from the frozen vectors instead of from a recorded payload.
      if (method !== "embed" && !(method in answers)) throw new Error(`orchestration-stub: unrecognised page call ${source}`);

      calls.push(method);

      if (method === "replayRuntime" && mode.replay === "revalidation") {
        // The origin is the one the run served, because the browser reports a failed same-origin
        // runtime load by that origin and the classifier refuses any other one.
        const runtimeUrl = `${origin}${ORT_WASM_PATHS.wasm}`;

        fire("requestfailed", { url: () => runtimeUrl, failure: () => ({ errorText: "net::ERR_INTERNET_DISCONNECTED" }) });
        fire("console", consoleErrorMessage(runtimeUrl));
      }

      if (method === "replayRuntime" && mode.replay === "unrelated") {
        fire("pageerror", new Error("unrelated failure during the replay"));
      }

      if (method === "replayRuntime" && mode.replay === "http") {
        fire("response", { status: () => 500, url: () => `${origin}/qa/retrieval.html` });
      }

      // One embedded question, reported the way the page reports it: the id it was asked with
      // and the vector of the matching synthetic case.
      if (method === "embed") {
        const query = Array.isArray(argument) ? argument[0] : undefined;
        const vector = QUERY_VECTORS.get(query?.id);

        // The run names each embedded question by the id it was asked with, and the frozen
        // vectors are the only ones this stub answers with. A question the fixture does not
        // hold is named here, instead of being embedded as some other case's vector.
        assert.ok(vector !== undefined, `orchestration-fixture-missing: query vector for ${String(query?.id)}`);

        return [
          {
            id: query?.id,
            vector,
            norm: 1,
            tokenCount: 12,
            durationMs: 1,
            finite: true,
            dimensions: EXPECTED_EMBEDDING.dimensions,
          },
        ];
      }

      return answers[method];
    },
  };

  const browser = {
    pages: () => [page],
    newPage: async () => page,
    setOffline: async (value: boolean) => {
      offlineSwitches.push(value);
      // The restore is its own step and can fail on its own; the run reports it beside the
      // replay's own outcome instead of letting it replace that outcome.
      if (!value && mode.restoration === "fails") throw new Error("context-offline-restore-failed");
    },
    close: async () => undefined,
  };

  const child = {
    exitCode: null,
    once(event: string, handler: () => void) {
      if (event === "exit") queueMicrotask(handler);
    },
    kill: () => undefined,
  };

  return { calls, offlineSwitches, browser, child };
}

/** The run, driven with the stub above, returning what it asked for, what it logged and how it ended. */
async function runBuiltOrchestration(mode: StubMode = CLEAN) {
  const { pinnedModelIdentity, qaSeams, runRetrievalQaWork } = await qa;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>qa</title>");
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  const stub = stubRun(mode, origin, pinnedModelIdentity);

  qaSeams.routing = "built";
  qaSeams.readFrozen = () => stubFrozen(pinnedModelIdentity);
  qaSeams.startServer = async () => ({ child: stub.child, origin });
  qaSeams.launch = async () => stub.browser;

  const logged: string[] = [];
  const log = console.log;
  const exitCode = process.exitCode;

  console.log = (...parts: unknown[]) => {
    logged.push(parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" "));
  };

  try {
    await runRetrievalQaWork(createCleanupLedger());

    return { stub, logged, exitCode: process.exitCode, reportFile: join(outDir, "retrieval-qa-built.json") };
  } finally {
    console.log = log;
    process.exitCode = exitCode;
    await new Promise<void>((done) => server.close(() => done()));
  }
}

/** The failures the run's own final gate ended with, read from the line it logs. */
function gateFailures(logged: string[]): string[] {
  const line = logged.find((entry) => entry.startsWith("[qa] FAILED:"));

  assert.equal(logged.filter((entry) => entry.startsWith("[qa] FAILED:")).length, 1, "one failure line names the whole run");

  // The line reads `[qa] FAILED: <names>`, so the names start after the space that follows the colon.
  return line!.slice("[qa] FAILED:".length).trim().split(", ");
}

guardedTest(QA_ARTIFACTS, "the built branch judges the cache proof before its own first read and reaches the encoder", async () => {
  const { stub, logged } = await runBuiltOrchestration();

  // The production routing is what runs the offline replay at all, so reaching it and the
  // encoder load after it is what a built run does that a gate test on its own cannot show.
  assert.deepEqual(stub.calls.slice(0, 3), ["environment", "delivery", "assets"]);
  assert.ok(stub.calls.includes("runtimeCache"), "the built routing must read what the worker stored");
  assert.ok(stub.calls.includes("replayRuntime"), "the built routing must replay the cached runtime file");
  assert.ok(stub.calls.includes("open"), "the run must reach the encoder load after the cache proof");
  assert.ok(
    stub.calls.indexOf("open") > stub.calls.indexOf("replayRuntime"),
    "the encoder load comes after the cache proof and the offline replay",
  );

  // Past the encoder load the run answers every frozen case, reads what the browser consumed
  // and the answer paths report, and closes the encoder before it judges itself.
  assert.deepEqual(stub.calls.slice(stub.calls.indexOf("open")), [
    "open",
    "progressReport",
    "embed",
    "embed",
    "embed",
    "embed",
    "modelAssets",
    "oversize",
    "supersede",
    "controllerProbe",
    "lexicalProbe",
    "guards",
    "close",
  ]);

  const proof = logged.find((line) => line.startsWith("[qa] cache proof:"));

  assert.ok(proof !== undefined, "the cache proof must be reported instead of throwing at its own log");
  assert.match(proof, /"applicable":true/);
});

guardedTest(QA_ARTIFACTS, "the built branch restores the networked context around the replay, in order", async () => {
  const { stub } = await runBuiltOrchestration();

  assert.deepEqual(stub.offlineSwitches, [true, false]);
});

/** The classified accounting the offline phase reports, read from the run's own log line. */
function replayWindow(logged: string[]): { expected: ObservedFailure[]; unresolved: ObservedFailure[] } {
  const line = logged.find((entry) => entry.startsWith("[qa] offline replay window:"));

  assert.ok(line !== undefined, "the offline phase must report what it classified");

  return JSON.parse(line.slice("[qa] offline replay window:".length).replace(/ replay: .*$/, ""));
}

guardedTest(QA_ARTIFACTS, "an offline-phase console error with its network evidence is the one expected failure", async () => {
  const { logged } = await runBuiltOrchestration({ replay: "revalidation" });
  const window = replayWindow(logged);
  const console = window.expected.find((entry) => entry.source === "console");
  const request = window.expected.find((entry) => entry.source === "request");

  assert.deepEqual(window.unresolved, [], "both failures of the replay are explained");
  assert.ok(console !== undefined, "the console error the request failure explains is expected");
  assert.equal(console.disposition, "expected");
  assert.equal(console.classification, "sw-revalidation-without-network");
  // The cause the console error's own text parsed into is kept, and the request that explains
  // it is named beside it rather than written over it.
  assert.equal(console.reason, "internet-disconnected");
  assert.equal(console.path, ORT_WASM_PATHS.wasm);
  assert.deepEqual(console.evidence, { source: "request", path: ORT_WASM_PATHS.wasm, reason: "internet-disconnected" });
  assert.ok(request !== undefined, "the locked runtime request failure is explained by the offline replay itself");
  assert.deepEqual(request.evidence, { source: "offline-replay", path: ORT_WASM_PATHS.wasm, reason: "internet-disconnected" });
});

guardedTest(QA_ARTIFACTS, "an offline-phase failure with no evidence stays unresolved and is not excused", async () => {
  const { logged } = await runBuiltOrchestration({ replay: "unrelated" });
  const window = replayWindow(logged);

  assert.deepEqual(window.expected, []);
  assert.equal(window.unresolved.length, 1);
  assert.deepEqual(window.unresolved[0], {
    stage: "offline-replay",
    disposition: "blocking",
    source: "page",
    reason: "unclassified",
    classification: "unexplained",
  });
});

guardedTest(QA_ARTIFACTS, "an HTTP status failure during the replay is classified and kept, not dropped", async () => {
  const { logged } = await runBuiltOrchestration({ replay: "http" });
  const window = replayWindow(logged);

  assert.deepEqual(window.expected, [], "an HTTP status failure is never an offline revalidation");
  assert.equal(window.unresolved.length, 1, "the HTTP failure survives the classification");
  assert.equal(window.unresolved[0].source, "http");
  assert.equal(window.unresolved[0].status, 500);
  assert.equal(window.unresolved[0].classification, "unexplained");
});

guardedTest(QA_ARTIFACTS, "the run's own final gate accepts a nested answer with a null window restoration", async () => {
  const { logged, exitCode, reportFile } = await runBuiltOrchestration();

  assert.equal(exitCode, undefined, "a run whose own gate holds ends without a failure code");
  assert.ok(logged.includes("[qa] done"), "the run reaches the branch that reports success");
  assert.ok(
    logged.some((line) => line.startsWith("[qa] report written to")),
    "the report is written before the gate judges the run",
  );

  const report = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, any>;

  // The metadata the producer nests under `answer` is what the gate judged, and the report
  // keeps it where the producer put it.
  assert.equal(report.limits.controller.answer.kind, "answer");
  assert.equal(report.limits.controller.answer.matching, "semantic");
  assert.equal(report.limits.lexical.kind, "rephrase");
  // The restoration the offline phase reports is the one inside its own window record.
  assert.equal(report.cache.replay.window.restoration, null);
  assert.equal(report.cache.replay.restoration, null);
  assert.equal(report.failures.blocking, 0);
  assert.equal(report.parity.allWithinTolerance, true, "the parity the run computed from the synthetic vectors holds");
  assert.equal(report.calibration.allExpectationsHeld, true, "the named synthetic expectations held");
});

guardedTest(QA_ARTIFACTS, "the final gate blocks a controller probe whose answer metadata is missing or malformed", async () => {
  for (const [shape, expected] of [
    // The old flat read: the probe reported its metadata at the top level, where the gate did
    // not look for it, so the gate has to name that rather than pass a probe it never read.
    ["flat", "controller-answer-missing"],
    ["no-answer", "controller-answer-missing"],
    ["no-kind", "controller-kind-missing"],
  ] as const) {
    const { logged, exitCode } = await runBuiltOrchestration({ replay: "none", controller: shape });

    assert.equal(exitCode, 1, `${shape} must end the run with a failure`);
    assert.deepEqual(gateFailures(logged), [expected], `${shape} is named by what it did not report`);
  }
});

guardedTest(QA_ARTIFACTS, "the final gate accepts the outcomes the two superseding questions actually produce", async () => {
  const { logged, exitCode } = await runBuiltOrchestration({
    replay: "none",
    answers: { supersede: { older: "embed/superseded", newer: "resolved" } },
  });

  assert.equal(exitCode, undefined, "the producer's own outcomes leave the run passing");
  assert.ok(logged.includes("[qa] done"));
});

guardedTest(QA_ARTIFACTS, "the final gate blocks a newer question that failed, was superseded, or was never reported", async () => {
  for (const [supersede, expected] of [
    // A classified failure is a newer question that did not land, even though nothing about it
    // is malformed and the older question still lost as it should.
    [{ older: "embed/superseded", newer: "embed/failed" }, ["supersede-newer"]],
    [{ older: "embed/superseded", newer: "embed/superseded" }, ["supersede-newer"]],
    // A page that reported no outcome at all is not evidence the question was answered.
    [{ older: "embed/superseded" }, ["supersede-newer-missing"]],
    [{}, ["supersede-older-missing", "supersede-newer-missing"]],
    [{ older: "resolved", newer: "resolved" }, ["supersede-older"]],
  ] as const) {
    const { logged, exitCode } = await runBuiltOrchestration({ replay: "none", answers: { supersede } });

    assert.equal(exitCode, 1, `${JSON.stringify(supersede)} must end the run with a failure`);
    assert.deepEqual(gateFailures(logged), [...expected], `${JSON.stringify(supersede)} is named by the outcome it reported`);
  }
});

guardedTest(QA_ARTIFACTS, "the final gate blocks answer metadata that is well formed but belongs to the other path", async () => {
  for (const [answers, expected] of [
    // The loaded controller cannot report a limited match, whatever the cause it names.
    [
      { controller: { cards: 2, topCardId: "card-a", answer: { kind: "answer", cardId: "card-a", matching: "limited", limitedCause: "model-unavailable", weak: false } } },
      ["controller-matching-not-semantic"],
    ],
    // The semantic match is the other probe's outcome, and it carries no cause to name.
    [
      { lexical: { kind: "rephrase", matching: "semantic", limitedCause: null, cardId: null } },
      ["lexical-matching-not-limited", "lexical-limited-cause-not-model-unavailable"],
    ],
    // A limited fallback for another cause is not the null-encoder path this probe runs.
    [
      { lexical: { kind: "answer", cardId: "card-a", matching: "limited", limitedCause: "embedding-failed" } },
      ["lexical-limited-cause-not-model-unavailable"],
    ],
  ] as const) {
    const { logged, exitCode } = await runBuiltOrchestration({ replay: "none", answers });

    assert.equal(exitCode, 1, `${JSON.stringify(answers)} must end the run with a failure`);
    assert.deepEqual(gateFailures(logged), [...expected], `${JSON.stringify(answers)} is named by what it reported instead`);
  }
});

guardedTest(QA_ARTIFACTS, "the final gate blocks a restoration the offline phase could not complete", async () => {
  const { logged, exitCode, reportFile } = await runBuiltOrchestration({ replay: "none", restoration: "fails" });

  assert.equal(exitCode, 1);
  assert.deepEqual(gateFailures(logged), ["offline-restore-failed"]);

  const report = JSON.parse(readFileSync(reportFile, "utf8")) as Record<string, any>;

  // The failed restore is reported beside the replay's own outcome, which stayed successful.
  assert.notEqual(report.cache.replay.window.restoration, null);
  assert.equal(report.cache.replay.window.failure, null);
});

guardedTest(QA_ARTIFACTS, "a failure observed during the replay blocks through the run's own final gate", async () => {
  for (const replay of ["unrelated", "http"] as const) {
    const { logged, exitCode } = await runBuiltOrchestration({ replay });

    assert.equal(exitCode, 1, `${replay} must end the run with a failure`);
    assert.deepEqual(gateFailures(logged), ["observed-failures:1"], `${replay} is counted at the gate, not excused`);
  }
});

test("an environment override only shortens a declared bound, and only as a positive integer", async () => {
  const { readLimits } = await qa;
  const declared = { loadMs: 120_000, queryMs: 10_000, runMs: 600_000 };

  assert.deepEqual(readLimits({}), declared);

  for (const refused of ["0", "-1", "1.5", "abc", "", "Infinity", "NaN"]) {
    assert.deepEqual(readLimits({ RETRIEVAL_QA_LOAD_MS: refused }), declared, `${refused} must not change a bound`);
  }

  assert.deepEqual(readLimits({ RETRIEVAL_QA_LOAD_MS: "2000", RETRIEVAL_QA_QUERY_MS: "500", RETRIEVAL_QA_RUN_MS: "30000" }), {
    loadMs: 2000,
    queryMs: 500,
    runMs: 30_000,
  });
});

test("a page error is never expected, whatever evidence the phase observed", async () => {
  const { classifyOfflinePhase } = await qa;
  const request: ObservedFailure = failure("request", { reason: "internet-disconnected", path: ORT_WASM_PATHS.wasm });
  const out = classifyOfflinePhase([failure("page"), request], OFFLINE);

  assert.equal(out.expected.filter((entry) => entry.source === "page").length, 0, "a page error is never explained");
  assert.deepEqual(out.unresolved, [
    { stage: "offline-replay", source: "page", reason: "unclassified", disposition: "blocking", classification: "unexplained" },
  ]);
  assert.equal(out.entries.length, 2, "the request that would have excused it is classified as well");
});

test("an unknown console error with qualified evidence stays blocking", async () => {
  const { classifyOfflinePhase } = await qa;
  const request: ObservedFailure = failure("request", { reason: "internet-disconnected", path: ORT_WASM_PATHS.wasm });

  for (const unknown of [
    failure("console"),
    failure("console", { reason: "internet-disconnected" }),
    failure("console", { path: ORT_WASM_PATHS.wasm }),
  ]) {
    const out = classifyOfflinePhase([unknown, request], OFFLINE);

    assert.equal(out.entries.filter((entry) => entry.disposition === "expected" && entry.source === "console").length, 0);
    assert.equal(out.unresolved.filter((entry) => entry.source === "console").length, 1);
  }
});

test("a console error the request failure does not share a path or a cause with stays blocking", async () => {
  const { classifyOfflinePhase } = await qa;
  const request: ObservedFailure = failure("request", { reason: "internet-disconnected", path: ORT_WASM_PATHS.wasm });
  const known = (over: Partial<ObservedFailure>) => failure("console", { reason: "internet-disconnected", path: ORT_WASM_PATHS.wasm, ...over });

  for (const unmatched of [
    known({ path: "/ort/other.wasm" }),
    known({ path: "/assets/app.js" }),
    known({ path: `http://example.test${ORT_WASM_PATHS.wasm}` }),
    known({ reason: "network-failed" }),
  ]) {
    const out = classifyOfflinePhase([unmatched, request], OFFLINE);

    assert.equal(out.entries.filter((entry) => entry.disposition === "expected" && entry.source === "console").length, 0, `${unmatched.reason} ${unmatched.path}`);
  }

  // The same console error beside a request failure of the other locked path is expected, so
  // the exemption follows the pinned runtime files and not one of them by habit.
  const mjs = classifyOfflinePhase([known({ path: ORT_WASM_PATHS.mjs }), { ...request, path: ORT_WASM_PATHS.mjs }], OFFLINE);

  assert.equal(mjs.entries.filter((entry) => entry.disposition === "expected" && entry.source === "console").length, 1);
});

test("a known console error beside a matching request failure is expected and keeps its own reason", async () => {
  const { classifyOfflinePhase } = await qa;
  const out = classifyOfflinePhase(
    [
      failure("console", { reason: "network-failed", path: ORT_WASM_PATHS.wasm }),
      failure("request", { reason: "network-failed", path: ORT_WASM_PATHS.wasm }),
    ],
    OFFLINE,
  );
  const console = out.expected.find((entry) => entry.source === "console");

  assert.ok(console !== undefined, "the console error the request failure explains is expected");
  assert.equal(console.disposition, "expected");
  assert.equal(console.classification, "sw-revalidation-without-network");
  assert.equal(console.reason, "network-failed", "the cause its own text parsed into is kept, not replaced");
  assert.equal(console.path, ORT_WASM_PATHS.wasm);
  assert.deepEqual(console.evidence, { source: "request", path: ORT_WASM_PATHS.wasm, reason: "network-failed" });

  // One request failure explains one console error, never a whole phase.
  const pair = classifyOfflinePhase(
    [
      failure("console", { reason: "network-failed", path: ORT_WASM_PATHS.wasm }),
      failure("console", { reason: "network-failed", path: ORT_WASM_PATHS.wasm }),
      failure("request", { reason: "network-failed", path: ORT_WASM_PATHS.wasm }),
    ],
    OFFLINE,
  );

  assert.equal(pair.entries.filter((entry) => entry.source === "console" && entry.disposition === "expected").length, 1);
  assert.equal(pair.unresolved.length, 1);
});

test("a request failure is expected on its own only in a confirmed offline replay", async () => {
  const { classifyOfflinePhase } = await qa;
  const qualified: ObservedFailure = failure("request", { reason: "internet-disconnected", path: ORT_WASM_PATHS.wasm });

  const explained = classifyOfflinePhase([qualified], OFFLINE);

  assert.equal(explained.expected.length, 1);
  assert.deepEqual(explained.expected[0].evidence, { source: "offline-replay", path: ORT_WASM_PATHS.wasm, reason: "internet-disconnected" });

  for (const refused of [
    { ...qualified, path: "/ort/other.wasm" },
    { ...qualified, reason: "unclassified" },
    { ...qualified, source: "http" as const, status: 500 },
  ]) {
    const out = classifyOfflinePhase([refused], OFFLINE);

    assert.equal(out.expected.length, 0, `${refused.reason} ${refused.path ?? ""}`);
  }

  // Outside a replay this run set offline itself, nothing is explained at all.
  for (const context of [undefined, { offline: false }]) {
    const out = classifyOfflinePhase(
      [failure("console", { reason: "internet-disconnected", path: ORT_WASM_PATHS.wasm }), qualified],
      context,
    );

    assert.equal(out.expected.length, 0);
    assert.equal(out.unresolved.length, 2);
  }
});

test("every observed entry survives the classification, including the HTTP status failure", async () => {
  const { classifyOfflinePhase } = await qa;
  const out = classifyOfflinePhase(
    [
      failure("page"),
      failure("request", { reason: "internet-disconnected", path: ORT_WASM_PATHS.wasm }),
      failure("http", { reason: "http-status", status: 500, path: "/qa/retrieval.html" }),
      failure("request", { reason: "network-failed", path: "/assets/app.js" }),
    ],
    OFFLINE,
  );

  assert.deepEqual(
    out.entries.map((entry) => entry.source),
    ["page", "request", "http", "request"],
    "no entry is dropped by the classification",
  );
  assert.deepEqual(out.unresolved.map((entry) => entry.classification), ["unexplained", "unexplained", "unexplained"]);
  assert.equal(out.unresolved.find((entry) => entry.source === "http")?.status, 500);
});

test("the acceptance gate blocks on exactly what the classifier left unexplained", async () => {
  const { classifyOfflinePhase, workloadGate } = await qa;
  const probe = {
    guards: [],
    supersede: { older: "embed/superseded", newer: "resolved" },
    controller: { answer: { kind: "answer", matching: "semantic", limitedCause: null } },
    lexical: { kind: "answer", matching: "limited", limitedCause: "model-unavailable" },
  };
  const request: ObservedFailure = failure("request", { reason: "internet-disconnected", path: ORT_WASM_PATHS.wasm });

  const clean = classifyOfflinePhase(
    [failure("console", { reason: "internet-disconnected", path: ORT_WASM_PATHS.wasm }), request],
    OFFLINE,
  );

  assert.deepEqual(workloadGate({ ...probe, observed: clean.entries }), []);

  // The page error the old rule excused, beside the same evidence, blocks the run.
  const excused = classifyOfflinePhase([failure("page"), request], OFFLINE);

  assert.deepEqual(workloadGate({ ...probe, observed: excused.entries }), ["observed-failures:1"]);
});

test("the acceptance gate judges the guards, the superseding result and the answer metadata", async () => {
  const { workloadGate } = await qa;
  const clean: WorkloadGateInput = {
    guards: [{ name: "wrong-dimension", reason: "encoder/wrong-dimensions" }],
    supersede: { older: "embed/superseded", newer: "resolved" },
    controller: { answer: { kind: "answer", matching: "semantic", limitedCause: null } },
    lexical: { kind: "answer", matching: "limited", limitedCause: "model-unavailable" },
    observed: [{ stage: "offline-replay", source: "console", reason: "sw-revalidation-without-network", disposition: "expected" }],
  };

  assert.deepEqual(workloadGate(clean), []);

  assert.deepEqual(workloadGate({ ...clean, guards: [{ name: "zero-vector", reason: "accepted:object" }] }), ["guard-accepted:zero-vector"]);
  assert.deepEqual(workloadGate({ ...clean, supersede: { older: "embed/superseded", newer: "embed/superseded" } }), ["supersede-newer"]);
  assert.deepEqual(workloadGate({ ...clean, supersede: { older: "resolved", newer: "resolved" } }), ["supersede-older"]);
  assert.deepEqual(
    workloadGate({ ...clean, controller: { answer: { kind: "answer", matching: "limited", limitedCause: null } } }),
    ["controller-limited-cause-missing"],
  );
  assert.deepEqual(
    workloadGate({ ...clean, controller: { answer: { kind: "answer", matching: "limited", limitedCause: "model-unavailable" } } }),
    // Well formed and shape-valid, and still not what the loaded controller produces, so the
    // gate judges the path's purpose and not only the shape both paths share.
    ["controller-matching-not-semantic"],
  );
  assert.deepEqual(workloadGate({ ...clean, lexical: { kind: "clarify", matching: null, limitedCause: null } }), ["lexical-unexpected-kind:clarify"]);
  // A probe that reported no metadata at all is named, not read past as an absent field.
  assert.deepEqual(workloadGate({ ...clean, controller: null }), ["controller-answer-missing"]);
  assert.deepEqual(workloadGate({ ...clean, lexical: null }), ["lexical-answer-missing"]);
  assert.deepEqual(
    workloadGate({ ...clean, observed: [{ stage: "run", source: "console", reason: "unclassified", disposition: "blocking" }] }),
    ["observed-failures:1"],
  );
});

/**
 * The icon links a document actually declares, read from the file on disk. The expectation is
 * the canonical page's own declaration, not a list written out here, so a later change to
 * `index.html` is what the QA document has to follow.
 */
function declaredIcons(htmlPath: string): string[] {
  const head = readFileSync(htmlPath, "utf8").split("</head>")[0];
  return [...head.matchAll(/<link\b[^>]*\brel="icon"[^>]*>/g)].map((tag) => {
    const href = /\bhref="([^"]+)"/.exec(tag[0])?.[1];
    assert.ok(href, `an icon link in ${htmlPath} carries no href: ${tag[0]}`);
    return href;
  });
}

test("the QA document declares the canonical page's icon and the asset exists in public/", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const canonical = declaredIcons(join(root, "index.html"));
  const qaPage = declaredIcons(join(root, "qa/retrieval.html"));

  assert.deepEqual(canonical, ["/favicon.svg"]);
  // A document without an icon declaration leaves the browser requesting /favicon.ico, which
  // this repository does not ship, so the run sees a 404 the page itself never asked for.
  assert.deepEqual(qaPage, canonical);

  for (const href of qaPage) {
    const [path] = href.split(/[?#]/);
    assert.ok(path?.startsWith("/"), `icon ${href} is not a site-absolute path`);
    assert.ok(existsSync(join(root, "public", path)), `icon ${href} has no file in public/`);
  }
});

test("the check leaves nothing behind in the repository", () => {
  rmSync(outDir, { recursive: true, force: true });
});

skipLedgerMarker();
