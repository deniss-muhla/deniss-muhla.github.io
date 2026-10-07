import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  ORT_NUM_THREADS,
  ORT_PACKAGE,
  ORT_PROXY,
  ORT_ROUTE,
  ORT_RUNTIME_ASSETS,
  ORT_RUNTIME_VERSION,
  ORT_WASM_PATHS,
} from "../src/chat/retrieval/encoder/runtime-assets.ts";
import { ADAPTER_CONTRACT, installedDistributionDirs } from "../scripts/cv-facts/embedding.mjs";
import { buildOutput, guardedTest, skipLedgerMarker } from "./build-preconditions.ts";

function digestOf(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const { packageDir, ortDir } = installedDistributionDirs();
const distDir = path.join(ortDir, "dist");

const repositoryRoot = path.resolve(import.meta.dirname, "..");

/**
 * The build output the manifest check below reads.
 *
 * `ORT_BUILD_DIR` points it at another build so the A/B run can check the
 * old-configuration output without touching the shipped `dist/`. Unset, it is `dist/`.
 */
const buildOutputDir = process.env.ORT_BUILD_DIR
  ? path.resolve(repositoryRoot, process.env.ORT_BUILD_DIR)
  : path.join(repositoryRoot, "dist");

function listBuildFiles(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listBuildFiles(dir, rel));
    else files.push(rel);
  }
  return files;
}

test("the route serves the installed locked runtime, not a CDN", () => {
  assert.equal(ORT_ROUTE, "/ort/");
  assert.equal(ORT_PACKAGE, "onnxruntime-web");
  assert.deepEqual(ORT_WASM_PATHS, {
    mjs: "/ort/ort-wasm-simd-threaded.jsep.mjs",
    wasm: "/ort/ort-wasm-simd-threaded.jsep.wasm",
  });

  for (const asset of ORT_RUNTIME_ASSETS) {
    assert.equal(ORT_WASM_PATHS.mjs.endsWith(asset.name) || ORT_WASM_PATHS.wasm.endsWith(asset.name), true);
  }

  // Single-threaded and no proxy worker, so the path needs no `SharedArrayBuffer` and no
  // cross-origin isolation of its own.
  assert.equal(ORT_NUM_THREADS, 1);
  assert.equal(ORT_PROXY, false);
});

test("the served file list is the two recorded runtime files and nothing else", () => {
  assert.deepEqual(
    ORT_RUNTIME_ASSETS.map((asset) => asset.name),
    ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"],
  );

  // The library's default path template would also name the `asyncify` pair. The page never
  // requests it, so it is not served and not emitted.
  const installed = fs.readdirSync(distDir).filter((name) => name.includes("asyncify"));
  assert.ok(installed.length > 0, "the installed package still contains the second pair");
  assert.ok(
    ORT_RUNTIME_ASSETS.every((asset) => !asset.name.includes("asyncify")),
    "the served list must not include the second pair",
  );
});

test("this record and the generator's settled contract name the same runtime and files", () => {
  assert.equal(ORT_RUNTIME_VERSION, ADAPTER_CONTRACT.ortVersion);
  assert.equal(ADAPTER_CONTRACT.ortWasmFile, `dist/${ORT_RUNTIME_ASSETS[1].name}`);
  assert.equal(ADAPTER_CONTRACT.ortFactoryFile, `dist/${ORT_RUNTIME_ASSETS[0].name}`);
  assert.equal(ADAPTER_CONTRACT.ortWasmSha256, ORT_RUNTIME_ASSETS[1].sha256);
  assert.equal(ADAPTER_CONTRACT.ortFactorySha256, ORT_RUNTIME_ASSETS[0].sha256);
});

test("the installed files are the bytes the route will serve", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ortDir, "package.json"), "utf8")) as { name: string; version: string };

  assert.equal(manifest.name, ORT_PACKAGE);
  assert.equal(manifest.version, ORT_RUNTIME_VERSION);

  for (const asset of ORT_RUNTIME_ASSETS) {
    const file = path.join(distDir, asset.name);

    assert.ok(fs.existsSync(file), `${asset.name} is missing from the installed runtime`);
    assert.equal(fs.statSync(file).size, asset.bytes, `${asset.name} has a different size than recorded`);
    assert.equal(digestOf(file), asset.sha256, `${asset.name} is not the recorded file`);
  }
});

/** The console surface the library prints on. Every call is counted and then discarded. */
type ConsoleSurface = {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
};

/**
 * Runs `report` with the console captured in memory and returns how many calls it made.
 *
 * The captured calls are counted and their arguments dropped, so a failing run cannot leak the
 * payload this check exists to keep out of a log.
 */
async function countPrints(report: () => void | Promise<void>): Promise<number> {
  const real: ConsoleSurface = { error: console.error, warn: console.warn, log: console.log };
  let printed = 0;
  const count = (): void => {
    printed += 1;
  };

  console.error = count;
  console.warn = count;
  console.log = count;

  try {
    await report();
  } finally {
    console.error = real.error;
    console.warn = real.warn;
    console.log = real.log;
  }

  return printed;
}

/**
 * The one check that reads the real build output's manifest: it skips under its own name where
 * no build output exists at all (a fresh checkout runs tests before its build) and runs
 * unchanged wherever one does.
 */
guardedTest(buildOutput(buildOutputDir), "the built site emits no asyncify asset and ships the pinned jsep pair byte for byte", () => {
  // The whole 3a chain rests on this manifest: the extern-wasm condition selects the
  // non-bundled entry, so the library no longer forces its own asyncify pair into the
  // build, while the route still emits the two recorded jsep files.
  const emitted = listBuildFiles(buildOutputDir);
  assert.ok(emitted.length > 0, `${buildOutputDir} must hold a build output to check`);

  assert.deepEqual(
    emitted.filter((name) => name.includes("asyncify")),
    [],
    "the build output must not emit the asyncify asset the bundled entry would force",
  );

  for (const asset of ORT_RUNTIME_ASSETS) {
    const file = path.join(buildOutputDir, "ort", asset.name);
    assert.ok(fs.existsSync(file), `${asset.name} is missing from the build output`);
    assert.equal(fs.statSync(file).size, asset.bytes, `${asset.name} has a different size than recorded`);
    assert.equal(digestOf(file), asset.sha256, `${asset.name} is not the recorded file`);
  }
});

test("the shipped worker leaves the library it imports at the only level that prints nothing", async () => {
  // The worker configures its runtime while the module is being evaluated, so it is loaded as
  // it ships, against a worker port it can talk to. The level is then read back from the
  // library instance that module configured, which is the one the page downloads. No request
  // is made, so nothing is fetched and no file is cached.
  const scope = globalThis as { self?: unknown };
  const hadSelf = "self" in scope;
  const original = scope.self;

  scope.self = { postMessage: (): void => undefined, addEventListener: (): void => undefined };

  try {
    const library = await import("@huggingface/transformers");

    await import("../src/chat/retrieval/encoder/worker.ts");

    assert.equal(
      library.env.logLevel,
      library.LogLevel.NONE,
      "the worker must leave the library at the level that prints nothing",
    );
    assert.ok(
      library.LogLevel.ERROR < library.LogLevel.NONE,
      "an error level would still print, so NONE is the only silencing level the library offers",
    );
  } finally {
    if (hadSelf) scope.self = original;
    else delete scope.self;
  }
});

test("a real failed inference prints its inputs at the default and at ERROR, and prints nothing at NONE", async () => {
  // The library's own failure path, from the installed package: `sessionRun` catches the error,
  // unpacks the data of every input tensor and hands both to `logger.error`. Four fixed token
  // ids and a session that rejects are enough to reach it, so nothing is downloaded and no real
  // question is used. `src/models/session.js`, `src/env.js` and `src/utils/logger.js` are one
  // source graph, so the logger decides on the `env` configured here.
  const vendorEnv = await import(pathToFileURL(path.join(packageDir, "src/env.js")).href);
  const vendorSession = await import(pathToFileURL(path.join(packageDir, "src/models/session.js")).href);
  const vendorTensors = await import(pathToFileURL(path.join(packageDir, "src/utils/tensor.js")).href);

  assert.equal(vendorEnv.LogLevel.WARNING, 30, "the library's documented default level");
  assert.equal(vendorEnv.LogLevel.ERROR, 40);
  assert.equal(vendorEnv.LogLevel.NONE, 50);

  // `Tensor(type, data, dims)` is the library's own signature. Four fixed ids stand in for a
  // tokenized question; nothing visitor-shaped enters this file.
  const tensor = new vendorTensors.Tensor("int64", BigInt64Array.from([101n, 42n, 7n, 9n]), [1, 4]);
  const rejectingSession = {
    inputNames: ["input_ids"],
    run: async (): Promise<never> => {
      throw new Error("synthetic inference failure");
    },
  };
  const failedRun = async (): Promise<void> => {
    await assert.rejects(vendorSession.sessionRun(rejectingSession, { input_ids: tensor }));
  };

  // The default is where the library starts, and an error level is what a worker that silenced
  // only warnings would leave in place. Both print the inputs of the failed run.
  vendorEnv.env.logLevel = vendorEnv.LogLevel.WARNING;
  assert.ok(
    (await countPrints(failedRun)) > 0,
    "the library does print the inputs of a failed run at its own default level",
  );

  vendorEnv.env.logLevel = vendorEnv.LogLevel.ERROR;
  assert.ok(
    (await countPrints(failedRun)) > 0,
    "an error level still prints them, so silencing warnings is not enough",
  );

  // The level the worker configures above is the only one that prints nothing.
  vendorEnv.env.logLevel = vendorEnv.LogLevel.NONE;
  assert.equal(await countPrints(failedRun), 0, "the configured level must print nothing at all");
});

test("the runtime bundle the page ships gates that same error line with that same public level", () => {
  // Independent installed-source evidence, with its limit stated. The shipped bundles export
  // neither their internal logger nor `sessionRun`, so the runtime proof above runs on the
  // installed source graph instead. This check ties the two together: the browser bundle the
  // page downloads carries the same failure log lines and the same `logLevel` gate, so it reads
  // the one public field the worker configures. It is a source qualification of that link, not
  // a second runtime proof, and it prints no vendor output.
  const bundle = fs.readFileSync(path.join(packageDir, "dist", "transformers.web.js"), "utf8");

  assert.ok(
    bundle.includes("An error occurred during model execution"),
    "the shipped bundle logs the failed inference",
  );
  assert.ok(bundle.includes("Inputs given to model:"), "the shipped bundle logs the failed inputs");
  assert.ok(
    bundle.includes("logLevel <= LogLevel.ERROR"),
    "the shipped bundle gates its error log with the public level the worker configures",
  );
});

skipLedgerMarker();