#!/usr/bin/env node
/** Pinned, local-only KittenTTS 2 adapter. Call only from an explicit generator command. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import pins from "./kitten-pins.json" with { type: "json" };
import completionContract from "./kitten-completion.json" with { type: "json" };

const ROOT = resolve(import.meta.dirname, "../..");
const RUNNER = fileURLToPath(new URL("./kitten-runner.py", import.meta.url));
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_RESULT_BYTES = 64 * 1024;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_GENERATION_TOKENS_PER_CHUNK = 1000;
const MAX_OUTPUT_DURATION_SECONDS = 180;
const RUNNER_STAGES = new Set(["startup", "paths", "offline setup", "pinned artifact verification", "isolated imports", "model load", "single local inference"]);
const COMPLETION_FAILURE_REASONS = new Set([
  "preparation-invalid", "generation-invalid", "terminal-marker-missing", "terminal-marker-misplaced",
  "event-pairing-invalid", "decode-invalid", "restoration-failed", "contract-invalid"
]);
const RUNNER_FAILURES = new Set([
  "input/repository-path-forbidden", "input/path-unavailable", "runtime/interpreter-mismatch",
  "runtime/virtual-environment-required", "input/module-paths-invalid", "runtime/stdlib-unavailable",
  "runtime/os-network-sandbox-required", "runtime/dependency-version-mismatch", "runtime/import-origin-mismatch",
  "runtime/decoder-cache-resolution-mismatch", "runtime/model-config-mismatch", "runtime/device-unavailable",
  "runtime/device-memory-unavailable", "runtime/model-contract-mismatch", "pins/sdk-source-invalid",
  "pins/sdk-source-mismatch", "pins/sdk-archive-mismatch", "pins/model-revision-mismatch",
  "pins/model-file-set-mismatch", "pins/model-file-mismatch", "pins/decoder-default-ref-mismatch",
  "pins/decoder-file-set-mismatch", "pins/decoder-file-mismatch", "input/text-invalid", "output/path-invalid",
  "output/waveform-invalid", "output/waveform-clipped", "output/wav-validation-failed", "output/duration-invalid",
  "pins/generation-source-mismatch", "runtime/completion-observer-unavailable", "output/completion-invalid",
  "runner/unexpected"
]);
const MODEL_LOAD_FAILURES = new Map([
  ["runtime/model-load-cuda-oom", "cuda-oom"],
  ["runtime/model-load-memory-exhausted", "memory"],
  ["runtime/model-load-file-not-found", "file-not-found"],
  ["runtime/model-load-permission-denied", "permission"],
  ["runtime/model-load-dependency-unavailable", "dependency"],
  ["runtime/model-load-import-failed", "import"],
  ["runtime/model-load-os-error", "os-error"],
  ["runtime/model-load-runtime-error", "runtime-error"],
  ["runtime/model-load-unexpected", "other"]
]);
const MODEL_LOAD_CALL_SITE = "kittenml.get_model.KittenTTS.__new__";
const SAFE_ERRNOS = new Set([1, 2, 5, 12, 13, 28]);

export class KittenTaskError extends Error {
  constructor(code, stage = null, details = {}) {
    super(code);
    this.name = "KittenTaskError";
    this.code = code;
    this.stage = stage;
    if (details.kind) this.kind = details.kind;
    if (details.callSite) this.callSite = details.callSite;
    if (details.errno !== undefined) this.errno = details.errno;
    if (code === "runner/output/completion-invalid" && stage === "single local inference" &&
        COMPLETION_FAILURE_REASONS.has(details.reason)) this.reason = details.reason;
    if (details.partialOutput === true) this.partialOutput = true;
  }
}

const fail = (code) => { throw new KittenTaskError(code); };

function isWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function canonicalPath(candidate) {
  const absolute = resolve(candidate);
  let ancestor = absolute;
  const suffix = [];
  for (;;) {
    try {
      return resolve(await realpath(ancestor), ...suffix.reverse());
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return absolute;
      suffix.push(ancestor.slice(parent.length + 1));
      ancestor = parent;
    }
  }
}

function assertExternalPath(path, field) {
  if (typeof path !== "string" || !isAbsolute(path)) fail(`input/${field}-path-invalid`);
  return canonicalPath(path).then((canonical) => {
    if (isWithin(ROOT, canonical)) fail("input/repository-path-forbidden");
    return canonical;
  });
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function treeDigest(root, expectedCount) {
  const entries = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const child of children) {
      const path = join(directory, child.name);
      if (child.isSymbolicLink()) fail("pin/sdk-source-invalid");
      if (child.isDirectory()) await visit(path);
      else if (child.isFile()) entries.push(path);
      else fail("pin/sdk-source-invalid");
    }
  }
  await visit(root);
  if (entries.length !== expectedCount) fail("pin/sdk-source-mismatch");
  const hash = createHash("sha256");
  for (const path of entries) {
    const name = relative(dirname(root), path).split(sep).join("/");
    const bytes = await readFile(path);
    const nameBytes = Buffer.from(name);
    const nameLength = Buffer.alloc(4);
    nameLength.writeUInt32BE(nameBytes.length);
    const contentLength = Buffer.alloc(8);
    contentLength.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(nameLength).update(nameBytes).update(contentLength).update(bytes);
  }
  return hash.digest("hex");
}

async function listFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, child.name);
      if (child.isDirectory()) await visit(path);
      else if (child.isFile() || child.isSymbolicLink()) files.push(relative(root, path).split(sep).join("/"));
      else fail("pin/model-file-invalid");
    }
  }
  await visit(root);
  return files.sort();
}

/** Verify the fixed pins before starting any child or importing model code. */
export async function verifyPinnedArtifacts({ sdkArchive, sdkRoot, modelSnapshot, hubCache }, fixedPins = pins) {
  if (await hashFile(sdkArchive).catch(() => "") !== fixedPins.sdk.archiveSha256) fail("pin/sdk-archive-mismatch");
  const sdkPackageRoot = join(sdkRoot, "kittenml");
  if (await treeDigest(sdkPackageRoot, fixedPins.sdk.sourceFileCount).catch(() => "") !== fixedPins.sdk.sourceTreeSha256) {
    fail("pin/sdk-source-mismatch");
  }

  const expectedSnapshot = join(hubCache, "models--KittenML--kitten-tts-2", "snapshots", fixedPins.kittenModel.revision);
  if (await realpath(modelSnapshot).catch(() => "") !== await realpath(expectedSnapshot).catch(() => "")) {
    fail("pin/model-revision-mismatch");
  }
  const expectedFiles = fixedPins.kittenModel.files.map(({ path }) => path).sort();
  const actualFiles = await listFiles(modelSnapshot).catch(() => []);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) fail("pin/model-file-set-mismatch");
  for (const item of fixedPins.kittenModel.files) {
    if (await hashFile(join(modelSnapshot, item.path)).catch(() => "") !== item.sha256) fail("pin/model-file-mismatch");
  }

  const decoderRoot = join(hubCache, `models--${fixedPins.decoder.repo.replace("/", "--")}`);
  const reference = await readFile(join(decoderRoot, "refs", "main"), "utf8").catch(() => "");
  if (reference !== fixedPins.decoder.revision) fail("pin/decoder-default-ref-mismatch");
  const decoderSnapshot = join(decoderRoot, "snapshots", fixedPins.decoder.revision);
  const decoderFiles = await listFiles(decoderSnapshot).catch(() => []);
  if (JSON.stringify(decoderFiles) !== JSON.stringify([fixedPins.decoder.path])) fail("pin/decoder-file-set-mismatch");
  if (await hashFile(join(decoderSnapshot, fixedPins.decoder.path)).catch(() => "") !== fixedPins.decoder.sha256) {
    fail("pin/decoder-file-mismatch");
  }
  return { sdkPackageRoot, decoderFile: join(decoderSnapshot, fixedPins.decoder.path) };
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function assertSafeMetadata(metadata, paths, fixedPins = pins) {
  const audioKeys = ["path", "bytes", "sha256", "format", "subtype", "sampleRate", "channels", "frames", "durationSeconds", "peakFloat", "floatingClippedSamples", "pcmFullscaleSamples"];
  const runtimeKeys = ["executable", "prefix", "sdk", "imports", "dependencies", "model", "decoder", "offline", "osNetworkSandbox", "networkGuard", "networkGuardBlockedAttempts", "synthesisTextLogged", "completion"];
  const importNames = {
    kittenml: null, numpy: "numpy", soundfile: "soundfile", torch: "torch", transformers: "transformers",
    safetensors: "safetensors", librosa: "librosa", diffusers: "diffusers", s3tokenizer: "s3tokenizer",
    onnx: "onnx", huggingface_hub: "huggingface-hub", mpmath: "mpmath", narwhals: "narwhals"
  };
  if (!hasExactKeys(metadata, ["status", "audio", "runtime"]) || metadata.status !== "ok" || !hasExactKeys(metadata.audio, audioKeys)) fail("runner/result-invalid");
  const audio = metadata.audio;
  if (
    audio.path !== paths.outputWav || audio.sampleRate !== fixedPins.kittenModel.sampleRate || audio.channels !== 1 ||
    audio.format !== "WAV" || audio.subtype !== "PCM_16" || !Number.isSafeInteger(audio.frames) || audio.frames <= 0 ||
    !Number.isFinite(audio.durationSeconds) || audio.durationSeconds <= 0 ||
    audio.durationSeconds > MAX_OUTPUT_DURATION_SECONDS || audio.frames / fixedPins.kittenModel.sampleRate > MAX_OUTPUT_DURATION_SECONDS ||
    !Number.isFinite(audio.peakFloat) || audio.peakFloat <= 0 || audio.peakFloat >= 1 ||
    audio.floatingClippedSamples !== 0 || audio.pcmFullscaleSamples !== 0 ||
    !Number.isSafeInteger(audio.bytes) || audio.bytes < 44 || !SHA256.test(audio.sha256)
  ) fail("runner/result-invalid");

  const runtime = metadata.runtime;
  if (!hasExactKeys(runtime, runtimeKeys) || runtime.executable !== paths.pythonRealpath || runtime.prefix !== paths.pythonPrefix) fail("runner/result-invalid");
  if (
    !hasExactKeys(runtime.sdk, ["version", "sourceCommit", "archiveSha256", "sourceTreeSha256"]) ||
    runtime.sdk.version !== fixedPins.sdk.version || runtime.sdk.sourceCommit !== fixedPins.sdk.sourceCommit ||
    runtime.sdk.archiveSha256 !== fixedPins.sdk.archiveSha256 || runtime.sdk.sourceTreeSha256 !== fixedPins.sdk.sourceTreeSha256
  ) fail("runner/result-invalid");
  if (!hasExactKeys(runtime.dependencies, Object.keys(fixedPins.dependencies))) fail("runner/result-invalid");
  for (const [name, version] of Object.entries(fixedPins.dependencies)) {
    if (runtime.dependencies[name] !== version) fail("runner/result-invalid");
  }
  if (!Array.isArray(runtime.imports) || runtime.imports.length !== Object.keys(importNames).length) fail("runner/result-invalid");
  const seenImports = new Set();
  for (const item of runtime.imports) {
    if (!hasExactKeys(item, ["name", "path", "version"]) || !Object.hasOwn(importNames, item.name) || seenImports.has(item.name) || !isAbsolute(item.path)) fail("runner/result-invalid");
    seenImports.add(item.name);
    const distribution = importNames[item.name];
    const expectedVersion = distribution === null ? "0.0.0.dev0" : fixedPins.dependencies[distribution];
    if (item.version !== expectedVersion) fail("runner/result-invalid");
    const expectedPath = item.name === "kittenml" ? paths.sdkPackageRoot : null;
    if (expectedPath ? !isWithin(expectedPath, item.path) : !paths.moduleRoots.some((root) => isWithin(root, item.path))) fail("runner/import-origin-mismatch");
  }

  const modelKeys = ["revision", "voice", "weights", "preset", "device", "gpu", "freeGpuBytesBeforeLoad", "totalGpuBytes", "loadSeconds", "inferenceSeconds"];
  if (!hasExactKeys(runtime.model, modelKeys) || runtime.model.revision !== fixedPins.kittenModel.revision ||
      runtime.model.voice !== fixedPins.kittenModel.voice || runtime.model.weights !== fixedPins.kittenModel.weights ||
      runtime.model.preset !== fixedPins.kittenModel.preset || runtime.model.device !== "cuda" ||
      typeof runtime.model.gpu !== "string" || runtime.model.gpu.length === 0 ||
      !Number.isSafeInteger(runtime.model.freeGpuBytesBeforeLoad) || runtime.model.freeGpuBytesBeforeLoad < 5 * 1024 ** 3 ||
      !Number.isSafeInteger(runtime.model.totalGpuBytes) || runtime.model.totalGpuBytes < runtime.model.freeGpuBytesBeforeLoad ||
      !Number.isFinite(runtime.model.loadSeconds) || runtime.model.loadSeconds < 0 ||
      !Number.isFinite(runtime.model.inferenceSeconds) || runtime.model.inferenceSeconds < 0) fail("runner/result-invalid");
  if (!hasExactKeys(runtime.decoder, ["revision", "sha256", "resolvedPath"]) || runtime.decoder.revision !== fixedPins.decoder.revision ||
      runtime.decoder.sha256 !== fixedPins.decoder.sha256 || runtime.decoder.resolvedPath !== paths.decoderPath) fail("runner/result-invalid");
  if (!hasExactKeys(runtime.offline, ["hfHub", "transformers", "implicitAuth", "telemetryDisabled"]) ||
      runtime.offline.hfHub !== "1" || runtime.offline.transformers !== "1" || runtime.offline.implicitAuth !== "1" || runtime.offline.telemetryDisabled !== "1") fail("runner/result-invalid");
  if (runtime.osNetworkSandbox !== "bubblewrap --unshare-net" ||
      runtime.networkGuard !== "additional process-local Python socket hooks; not OS isolation" ||
      runtime.networkGuardBlockedAttempts !== 0 || runtime.synthesisTextLogged !== false) fail("runner/result-invalid");
  const completion = runtime.completion;
  if (!hasExactKeys(completion, ["generationUtilsSha256", "expectedChunks", "requestedMaxNewTokensPerChunk", "sdkDerivedBudgets", "observedGenerationCalls", "observedDecodeCalls", "decodedAudioChunks", "terminalMarkers"]) ||
      completion.generationUtilsSha256 !== completionContract.generationUtilsSha256 ||
      !Number.isSafeInteger(completion.expectedChunks) || completion.expectedChunks <= 0 ||
      completion.requestedMaxNewTokensPerChunk !== MAX_GENERATION_TOKENS_PER_CHUNK ||
      !Array.isArray(completion.sdkDerivedBudgets) || completion.sdkDerivedBudgets.length !== completion.expectedChunks ||
      completion.sdkDerivedBudgets.some((budget) => !Number.isSafeInteger(budget) || budget <= 0 || budget > MAX_GENERATION_TOKENS_PER_CHUNK) ||
      completion.observedGenerationCalls !== completion.expectedChunks ||
      completion.observedDecodeCalls !== completion.expectedChunks ||
      completion.decodedAudioChunks !== completion.expectedChunks ||
      !Array.isArray(completion.terminalMarkers) || completion.terminalMarkers.length !== completion.expectedChunks ||
      completion.terminalMarkers.some((marker) => marker !== "eos-tail")) fail("runner/result-invalid");

  // Preserve provenance while dropping local import/cache paths and the host-specific GPU name.
  return {
    status: "ok",
    audio: { ...audio },
    runtime: {
      sdk: { ...runtime.sdk },
      imports: runtime.imports.map(({ name, version }) => ({ name, version })),
      dependencies: { ...runtime.dependencies },
      model: {
        revision: runtime.model.revision, voice: runtime.model.voice, weights: runtime.model.weights,
        preset: runtime.model.preset, device: runtime.model.device,
        freeGpuBytesBeforeLoad: runtime.model.freeGpuBytesBeforeLoad, totalGpuBytes: runtime.model.totalGpuBytes,
        loadSeconds: runtime.model.loadSeconds, inferenceSeconds: runtime.model.inferenceSeconds
      },
      decoder: { revision: runtime.decoder.revision, sha256: runtime.decoder.sha256 },
      offline: { ...runtime.offline }, osNetworkSandbox: runtime.osNetworkSandbox,
      networkGuard: runtime.networkGuard, networkGuardBlockedAttempts: runtime.networkGuardBlockedAttempts,
      synthesisTextLogged: runtime.synthesisTextLogged,
      completion: {
        generationUtilsSha256: completion.generationUtilsSha256,
        expectedChunks: completion.expectedChunks,
        requestedMaxNewTokensPerChunk: completion.requestedMaxNewTokensPerChunk,
        sdkDerivedBudgets: [...completion.sdkDerivedBudgets],
        observedGenerationCalls: completion.observedGenerationCalls,
        observedDecodeCalls: completion.observedDecodeCalls,
        decodedAudioChunks: completion.decodedAudioChunks,
        terminalMarkers: [...completion.terminalMarkers]
      }
    }
  };
}

async function stageNoClobber(source, destination, contents = undefined, existsCode = "output/already-exists", partialOutputOnFailure = false, afterOpen = null) {
  try {
    await mkdir(dirname(destination), { recursive: true });
  } catch {
    throw new KittenTaskError("output/staging-open-failed", "output staging", { partialOutput: partialOutputOnFailure });
  }

  let handle;
  try {
    try {
      handle = await open(destination, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") throw new KittenTaskError(existsCode, "output staging", { partialOutput: partialOutputOnFailure });
      throw new KittenTaskError("output/staging-open-failed", "output staging", { partialOutput: partialOutputOnFailure });
    }

    const opened = await handle.stat({ bigint: true });
    if (afterOpen) await afterOpen(handle, destination);
    const bytes = contents === undefined ? await readFile(source) : Buffer.from(contents);
    await handle.writeFile(bytes);
    await handle.sync();
    const written = await handle.stat({ bigint: true });
    await handle.close();
    handle = null;

    const current = await lstat(destination, { bigint: true }).catch(() => null);
    if (!current || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new KittenTaskError("output/staging-path-replaced", "output staging", { partialOutput: true });
    }
    if (written.size !== BigInt(bytes.length)) {
      throw new KittenTaskError("output/staging-write-failed", "output staging", { partialOutput: true });
    }
  } catch (error) {
    if (error instanceof KittenTaskError) throw error;
    throw new KittenTaskError("output/staging-write-failed", "output staging", { partialOutput: true });
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function isClassifiedRunnerFailure(result) {
  if (result?.status !== "error" || !RUNNER_STAGES.has(result.stage)) return false;
  if (hasExactKeys(result, ["status", "code", "stage"])) return RUNNER_FAILURES.has(result.code);
  if (
    result.code === "output/completion-invalid" && result.stage === "single local inference" &&
    hasExactKeys(result, ["status", "code", "stage", "reason"]) &&
    COMPLETION_FAILURE_REASONS.has(result.reason)
  ) return true;
  const kind = MODEL_LOAD_FAILURES.get(result.code);
  const keys = Object.hasOwn(result, "errno")
    ? ["status", "code", "stage", "kind", "callSite", "errno"]
    : ["status", "code", "stage", "kind", "callSite"];
  return kind !== undefined && result.stage === "model load" && hasExactKeys(result, keys) &&
    result.kind === kind && result.callSite === MODEL_LOAD_CALL_SITE &&
    (result.errno === undefined || (Number.isSafeInteger(result.errno) && SAFE_ERRNOS.has(result.errno)));
}

function parseRunnerOutput(stdout) {
  let result;
  try { result = JSON.parse(stdout); } catch { fail("runner/protocol-invalid"); }
  if (result?.status === "error") {
    if (!isClassifiedRunnerFailure(result)) fail("runner/failed");
    const kind = MODEL_LOAD_FAILURES.get(result.code);
    const details = kind
      ? { kind, callSite: result.callSite, ...(result.errno === undefined ? {} : { errno: result.errno }) }
      : result.reason === undefined ? {} : { reason: result.reason };
    throw new KittenTaskError(`runner/${result.code}`, result.stage, details);
  }
  if (result?.status !== "ok") fail("runner/result-invalid");
  return result;
}

function hasClassifiedRunnerFailure(stdout) {
  try { return isClassifiedRunnerFailure(JSON.parse(stdout)); } catch { return false; }
}

async function inspectWav(path) {
  const bytes = await readFile(path);
  if (
    bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE" || bytes.toString("ascii", 12, 16) !== "fmt "
  ) fail("output/wav-invalid");
  const format = bytes.readUInt16LE(20);
  const channels = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  const bits = bytes.readUInt16LE(34);
  const dataOffset = bytes.indexOf(Buffer.from("data"), 36);
  if (format !== 1 || channels !== 1 || sampleRate !== 24000 || bits !== 16 || dataOffset < 0) fail("output/wav-invalid");
  const frames = bytes.readUInt32LE(dataOffset + 4) / 2;
  if (!Number.isSafeInteger(frames) || frames <= 0 || frames / sampleRate > MAX_OUTPUT_DURATION_SECONDS ||
      dataOffset + 8 + frames * 2 !== bytes.length) fail("output/wav-invalid");
  let peak = 0;
  let nonzero = false;
  let fullscale = 0;
  for (let offset = dataOffset + 8; offset < bytes.length; offset += 2) {
    const sample = bytes.readInt16LE(offset);
    if (sample !== 0) nonzero = true;
    peak = Math.max(peak, Math.abs(sample) / 32768);
    if (Math.abs(sample) >= 32767) fullscale += 1;
  }
  if (!nonzero || fullscale !== 0) fail("output/wav-invalid");
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), sampleRate, channels, frames, peakFloat: peak };
}

async function runChild({
  pythonExecutable, sandboxExecutable, runRoot, inputs, moduleRoots, timeoutMs, spawnProcess,
  signal, deadlineAt, requiredAfterProcessMs = 0, monotonicNow = () => performance.now(),
  termGraceMs = 250, killSettlementReserveMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  if (signal?.aborted) fail("runner/cancelled");
  if (deadlineAt !== undefined && (!Number.isFinite(deadlineAt) || !Number.isSafeInteger(requiredAfterProcessMs) ||
      requiredAfterProcessMs < 0 || typeof monotonicNow !== "function")) fail("deadline/invalid");
  if (deadlineAt !== undefined) {
    const remaining = deadlineAt - monotonicNow();
    if (!Number.isFinite(remaining) || remaining < timeoutMs + termGraceMs + killSettlementReserveMs + requiredAfterProcessMs) {
      fail("deadline/window-insufficient");
    }
  }
  const pythonArgs = ["-I", "-B", RUNNER, "--sdk-root", inputs.sdkRoot, "--sdk-archive", inputs.sdkArchive,
    "--model-snapshot", inputs.modelSnapshot, "--hub-cache", inputs.hubCache, "--workspace", runRoot,
    "--python-executable", pythonExecutable];
  for (const path of moduleRoots) pythonArgs.push("--module-path", path);
  const args = ["--unshare-net", "--ro-bind", "/", "/", "--bind", runRoot, runRoot,
    "--dev-bind", "/dev", "/dev", "--proc", "/proc", "--chdir", runRoot,
    "--", pythonExecutable, ...pythonArgs];
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C.UTF-8",
    HOME: join(runRoot, "home"),
    XDG_CACHE_HOME: join(runRoot, "xdg-cache"),
    HF_HOME: join(runRoot, "hf-home"),
    HF_HUB_CACHE: inputs.hubCache,
    TMPDIR: join(runRoot, "tmp"),
    CV_AUDIO_OS_NETWORK_SANDBOX: "bubblewrap --unshare-net",
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    HF_HUB_DISABLE_PROGRESS_BARS: "1",
    TOKENIZERS_PARALLELISM: "false",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1"
  };
  return new Promise((resolveChild, rejectChild) => {
    let child;
    try {
      if (signal?.aborted) throw new KittenTaskError("runner/cancelled");
      child = spawnProcess(sandboxExecutable, args, {
        cwd: runRoot,
        env: environment,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "ignore"]
      });
    } catch (error) {
      rejectChild(error instanceof KittenTaskError ? error : new KittenTaskError("runner/failed"));
      return;
    }
    let output = "";
    let timeout = false;
    let cancelled = false;
    let overflow = false;
    let errorSeen = false;
    let stopping = false;
    let killTimer;
    const killGroup = (signalName) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signalName);
        else child.kill(signalName);
      } catch {}
    };
    const requestStop = (reason) => {
      if (stopping) return;
      stopping = true;
      if (reason === "timeout") timeout = true;
      if (reason === "cancelled") cancelled = true;
      killGroup("SIGTERM");
      killTimer = setTimer(() => killGroup("SIGKILL"), termGraceMs);
    };
    const onAbort = () => requestStop("cancelled");
    const timer = setTimer(() => requestStop("timeout"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (output.length + chunk.length > MAX_RESULT_BYTES) {
        overflow = true;
        killGroup("SIGKILL");
      } else output += chunk.toString("utf8");
    });
    child.on("error", () => { errorSeen = true; });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimer(timer);
      if (killTimer !== undefined) clearTimer(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (timeout) rejectChild(new KittenTaskError("runner/timeout"));
      else if (cancelled) rejectChild(new KittenTaskError("runner/cancelled"));
      else if (overflow) rejectChild(new KittenTaskError("runner/output-limit"));
      else if (errorSeen) rejectChild(new KittenTaskError("runner/failed"));
      else if (code === 0 || (code === 2 && hasClassifiedRunnerFailure(output))) resolveChild(output);
      else rejectChild(new KittenTaskError("runner/failed"));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdin.end(JSON.stringify({ text: inputs.text, outputWav: join(runRoot, "sample.wav") }));
  });
}

async function runGeneration(options, fixedPins, spawnProcess = spawn) {
  if (options.signal?.aborted) fail("runner/cancelled");
  if (options.deadlineAt !== undefined && (!Number.isFinite(options.deadlineAt) ||
      !Number.isSafeInteger(options.requiredAfterProcessMs) || options.requiredAfterProcessMs < 0 ||
      typeof options.monotonicNow !== "function")) fail("deadline/invalid");
  if (typeof options.text !== "string" || options.text.trim() === "" || options.text.length > 2000 || /[\r\n]/.test(options.text)) {
    fail("input/text-invalid");
  }
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) fail("input/timeout-invalid");
  if (!Array.isArray(options.modulePaths) || options.modulePaths.length === 0) fail("input/module-paths-invalid");

  const pathFields = ["pythonExecutable", "sandboxExecutable", "sdkRoot", "sdkArchive", "modelSnapshot", "hubCache", "workspace", "outputWav"];
  const resolved = {};
  for (const field of pathFields) {
    await assertExternalPath(options[field], field);
    resolved[field] = field === "pythonExecutable" ? resolve(options[field]) : await canonicalPath(options[field]);
  }
  resolved.pythonRealpath = await realpath(resolved.pythonExecutable);
  resolved.pythonPrefix = await canonicalPath(dirname(dirname(resolved.pythonExecutable)));
  resolved.metadataPath = options.metadataPath ? await assertExternalPath(options.metadataPath, "metadata") : null;
  if (resolved.metadataPath && resolved.metadataPath === resolved.outputWav) fail("output/path-alias");
  resolved.moduleRoots = await Promise.all(options.modulePaths.map((path) => assertExternalPath(path, "module")));
  const [pythonStat, sandboxStat, sdkStat, modelStat, hubStat, workStat] = await Promise.all([
    stat(resolved.pythonExecutable).catch(() => null), stat(resolved.sandboxExecutable).catch(() => null),
    stat(resolved.sdkRoot).catch(() => null), stat(resolved.modelSnapshot).catch(() => null),
    stat(resolved.hubCache).catch(() => null), stat(resolved.workspace).catch(() => null)
  ]);
  if (!pythonStat?.isFile() || (pythonStat.mode & 0o111) === 0 || !sandboxStat?.isFile() || (sandboxStat.mode & 0o111) === 0 || !sdkStat?.isDirectory() || !modelStat?.isDirectory() || !hubStat?.isDirectory() || !workStat?.isDirectory()) {
    fail("input/path-unavailable");
  }
  if (await lstat(resolved.outputWav).then(() => true).catch(() => false)) fail("output/already-exists");
  if (resolved.metadataPath && await lstat(resolved.metadataPath).then(() => true).catch(() => false)) fail("output/metadata-already-exists");
  const sdk = await verifyPinnedArtifacts({
    sdkArchive: resolved.sdkArchive,
    sdkRoot: resolved.sdkRoot,
    modelSnapshot: resolved.modelSnapshot,
    hubCache: resolved.hubCache
  }, fixedPins);
  resolved.sdkPackageRoot = await realpath(sdk.sdkPackageRoot);
  resolved.decoderPath = await realpath(sdk.decoderFile);
  const moduleRoots = await Promise.all(resolved.moduleRoots.map((path) => realpath(path)));

  if (options.signal?.aborted) fail("runner/cancelled");
  const runRoot = await mkdtemp(join(resolved.workspace, "kitten-run-"));
  const tempWav = join(runRoot, "sample.wav");
  try {
    await mkdir(join(runRoot, "tmp"), { recursive: true });
    const stdout = await runChild({
      pythonExecutable: resolved.pythonExecutable,
      sandboxExecutable: resolved.sandboxExecutable,
      runRoot,
      inputs: { ...resolved, sdkRoot: resolved.sdkRoot, text: options.text },
      moduleRoots,
      timeoutMs,
      spawnProcess,
      signal: options.signal,
      deadlineAt: options.deadlineAt,
      requiredAfterProcessMs: options.requiredAfterProcessMs ?? 0,
      monotonicNow: options.monotonicNow ?? (() => performance.now()),
    });
    if (options.signal?.aborted) fail("runner/cancelled");
    const runnerResult = parseRunnerOutput(stdout);
    const result = assertSafeMetadata(runnerResult, { ...resolved, outputWav: tempWav, moduleRoots }, fixedPins);
    const wav = await inspectWav(tempWav);
    if (
      result.audio.bytes !== wav.bytes || result.audio.sha256 !== wav.sha256 ||
      result.audio.frames !== wav.frames || result.audio.peakFloat !== wav.peakFloat ||
      Math.abs(result.audio.durationSeconds - wav.frames / 24000) > 0.0001
    ) fail("output/metadata-mismatch");
    result.audio.path = resolved.outputWav;
    if (options.signal?.aborted) fail("runner/cancelled");
    await stageNoClobber(tempWav, resolved.outputWav);
    if (options.signal?.aborted) fail("runner/cancelled");
    if (resolved.metadataPath) await stageNoClobber(null, resolved.metadataPath, `${JSON.stringify(result, null, 2)}\n`, "output/metadata-already-exists", true);
    return result;
  } catch (error) {
    if (error instanceof KittenTaskError) throw error;
    throw new KittenTaskError("runner/failed");
  } finally {
    await rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function generateKittenAudio(options) {
  return runGeneration(options, pins);
}

/** Test hook for the bounded process contract; production callers use generateKittenAudio. */
export const kittenProcessTest = Object.freeze({
  runChild,
  parseRunnerOutput,
  inspectWav,
  assertSafeMetadata,
  stageNoClobber: (source, destination, contents, existsCode, partialOutputOnFailure, afterOpen) =>
    stageNoClobber(source, destination, contents, existsCode, partialOutputOnFailure, afterOpen),
  runWithPins: (options, testPins, spawnProcess) => runGeneration(options, testPins, spawnProcess)
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stderr.write("Use generateKittenAudio() from an explicitly invoked local script.\n");
  process.exitCode = 2;
}
