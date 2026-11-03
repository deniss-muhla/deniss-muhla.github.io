#!/usr/bin/env node
/** Offline v2 validation and explicit direct-final or legacy external generation. */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { AudioCatalogError, createAudioSourceInventory } from "./cv-audio/catalog.mjs";
import { KittenStageError, MAX_KITTEN_STAGE_DEADLINE_MINUTES, runKittenStage } from "./cv-audio/kitten-stage.mjs";
import { assertNoAudioGenerationLock } from "./cv-audio/final-output.mjs";
import { validateArtifact } from "./cv-facts/artifact.mjs";
import { readCanonicalSource, resolveFinalArtifactPath } from "./cv-facts/paths.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const FACTS_PATH = join(ROOT, "resources/cv/facts.json");
const CONTEXT_PATH = join(ROOT, "src/chat/cv-context.ts");
const AUDIO_DIR = join(ROOT, "public/audio/assistant");
export const MAX_V2_AUDIO_BYTES = 20 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}(?![\s\S])/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*(?![\s\S])/;

class AudioTaskError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const fail = (code) => {
  throw new AudioTaskError(code);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exactKeys = (value, keys) =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

export function parseAudioArguments(args) {
  const options = {
    check: false, kittenStage: false, final: false, confirmReviewed: false,
    facts: null, factsSha256: null, runtimeInputs: null, stage: null, deadlineMinutes: null,
  };
  const seen = new Set();
  const valueOptions = new Map([
    ["--facts", "facts"], ["--facts-sha256", "factsSha256"],
    ["--runtime-inputs", "runtimeInputs"], ["--stage", "stage"],
    ["--deadline-minutes", "deadlineMinutes"],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (seen.has(argument) && (["--check", "--kitten-stage", "--final", "--confirm-reviewed"].includes(argument) || valueOptions.has(argument))) {
      fail("cli/duplicate-option");
    }
    seen.add(argument);
    if (argument === "--check") options.check = true;
    else if (argument === "--kitten-stage") options.kittenStage = true;
    else if (argument === "--final") options.final = true;
    else if (argument === "--confirm-reviewed") options.confirmReviewed = true;
    else if (valueOptions.has(argument)) {
      const value = args[index + 1] ?? null;
      if (!value || value.startsWith("--")) fail("cli/missing-option-value");
      options[valueOptions.get(argument)] = value;
      index += 1;
    } else fail("cli/unknown-option");
  }

  const stageInputs = [options.facts, options.factsSha256, options.runtimeInputs, options.stage];
  if ([options.check, options.kittenStage, options.final].filter(Boolean).length > 1) fail("cli/mode-conflict");
  if (options.final && (options.facts !== null || options.stage !== null)) fail("cli/final-path-overrides-forbidden");
  if (options.confirmReviewed && !options.final) fail("cli/final-required");
  if ((stageInputs.some((value) => value !== null) || options.deadlineMinutes !== null) && !options.kittenStage && !options.final) {
    fail("cli/kitten-stage-required");
  }
  if (options.final) {
    if (!options.confirmReviewed) fail("cli/review-confirmation-required");
    options.facts = FACTS_PATH;
    options.stage = AUDIO_DIR;
  }
  if (options.kittenStage || options.final) {
    if ([options.facts, options.factsSha256, options.runtimeInputs, options.stage, options.deadlineMinutes].some((value) => value === null)) {
      fail(options.final ? "cli/final-arguments-required" : "cli/kitten-stage-arguments-required");
    }
    if (!SHA256_PATTERN.test(options.factsSha256)) fail("cli/facts-digest-invalid");
    if (!/^[1-9][0-9]*$/.test(options.deadlineMinutes)) fail("cli/deadline-invalid");
    options.deadlineMinutes = Number(options.deadlineMinutes);
    if (!Number.isSafeInteger(options.deadlineMinutes) || options.deadlineMinutes > MAX_KITTEN_STAGE_DEADLINE_MINUTES) fail("cli/deadline-invalid");
    for (const path of [options.facts, options.runtimeInputs, options.stage]) {
      if (!isAbsolute(path) || resolve(path) !== path) fail("cli/stage-path-invalid");
    }
  } else if (!options.check) fail("cli/mode-required");
  return options;
}

async function readGreeting() {
  let source;
  try {
    source = await readFile(CONTEXT_PATH, "utf8");
  } catch {
    fail("source/greeting-unreadable");
  }
  const match = source.match(/export const GREETING\s*=\s*("(?:[^"\\]|\\.)*");/);
  if (!match) fail("source/greeting-unreadable");
  try {
    const greeting = JSON.parse(match[1]);
    if (typeof greeting !== "string" || greeting.trim() === "") fail("source/greeting-invalid");
    return greeting;
  } catch {
    fail("source/greeting-invalid");
  }
}

export function parseMp3(bytes) {
  let offset = 0;
  if (bytes.length >= 10 && bytes.toString("ascii", 0, 3) === "ID3") {
    const tagSize =
      (bytes[6] & 0x7f) * 2 ** 21 +
      (bytes[7] & 0x7f) * 2 ** 14 +
      (bytes[8] & 0x7f) * 2 ** 7 +
      (bytes[9] & 0x7f);
    offset = 10 + tagSize + ((bytes[5] & 0x10) !== 0 ? 10 : 0);
  }

  let frames = 0;
  while (offset + 4 <= bytes.length) {
    const header = bytes.readUInt32BE(offset);
    if (((header & 0xffe00000) >>> 0) !== 0xffe00000) break;
    const version = (header >>> 19) & 0x3;
    const layer = (header >>> 17) & 0x3;
    const bitrateIndex = (header >>> 12) & 0xf;
    const sampleRateIndex = (header >>> 10) & 0x3;
    const channelMode = (header >>> 6) & 0x3;
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
      fail("audio/mp3-header-invalid");
    }

    const mpeg1Layer3Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
    const mpeg2Layer3Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
    const bitrate = (version === 3 ? mpeg1Layer3Bitrates : mpeg2Layer3Bitrates)[bitrateIndex];
    const baseRates = [44100, 48000, 32000];
    const sampleRate = baseRates[sampleRateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const padding = (header >>> 9) & 1;
    const frameBytes = Math.floor((version === 3 ? 144 : 72) * bitrate * 1000 / sampleRate) + padding;
    if (bitrate !== 32 || sampleRate !== 24000 || channelMode !== 3 || frameBytes < 4 || offset + frameBytes > bytes.length) {
      fail("audio/mp3-format-invalid");
    }
    offset += frameBytes;
    frames += 1;
  }

  if (frames === 0 || (offset < bytes.length && bytes.length - offset >= 4)) fail("audio/mp3-truncated");
  return {
    codec: "mp3",
    sampleRate: 24000,
    channels: 1,
    bitRate: 32000,
    frames,
    durationSeconds: Math.round((frames * 576 / 24000) * 1_000_000) / 1_000_000,
  };
}

/** Offline validation shared by the shipped v2 check and external Kitten stage. */
export async function validateCatalogCorpusV2({ directory, manifest, inventory }) {
  if (
    !exactKeys(manifest, ["version", "factsSha256", "greetingSha256", "catalogSha256", "clips"]) ||
    manifest.version !== 2 ||
    typeof manifest.factsSha256 !== "string" || !SHA256_PATTERN.test(manifest.factsSha256) ||
    typeof manifest.greetingSha256 !== "string" || !SHA256_PATTERN.test(manifest.greetingSha256) ||
    typeof manifest.catalogSha256 !== "string" || !SHA256_PATTERN.test(manifest.catalogSha256) ||
    !Array.isArray(manifest.clips)
  ) fail("manifest/v2-shape-invalid");

  if (
    !inventory ||
    typeof inventory.factsSha256 !== "string" || !SHA256_PATTERN.test(inventory.factsSha256) ||
    typeof inventory.greetingSha256 !== "string" || !SHA256_PATTERN.test(inventory.greetingSha256) ||
    typeof inventory.catalogSha256 !== "string" || !SHA256_PATTERN.test(inventory.catalogSha256) ||
    !Array.isArray(inventory.items)
  ) fail("manifest/v2-source-invalid");
  if (manifest.factsSha256 !== inventory.factsSha256) fail("manifest/facts-digest-mismatch");
  if (manifest.greetingSha256 !== inventory.greetingSha256) fail("manifest/greeting-digest-mismatch");
  if (manifest.catalogSha256 !== inventory.catalogSha256) fail("manifest/catalog-digest-mismatch");

  const expected = new Map();
  for (const item of inventory.items) {
    if (
      !item || typeof item.id !== "string" || !ID_PATTERN.test(item.id) ||
      typeof item.textSha256 !== "string" || !SHA256_PATTERN.test(item.textSha256) ||
      expected.has(item.id)
    ) fail("manifest/v2-source-invalid");
    expected.set(item.id, item);
  }
  if (expected.size === 0 || manifest.clips.length !== expected.size) fail("manifest/coverage-mismatch");

  const listed = new Map();
  let totalBytes = 0;
  for (const clip of manifest.clips) {
    if (
      !exactKeys(clip, ["id", "file", "bytes", "durationSeconds", "sha256", "textSha256"]) ||
      typeof clip.id !== "string" ||
      !ID_PATTERN.test(clip.id) ||
      typeof clip.sha256 !== "string" ||
      !SHA256_PATTERN.test(clip.sha256) ||
      typeof clip.textSha256 !== "string" ||
      !SHA256_PATTERN.test(clip.textSha256) ||
      clip.file !== `${clip.id}-${clip.sha256}.mp3` ||
      !Number.isSafeInteger(clip.bytes) ||
      clip.bytes <= 0 ||
      typeof clip.durationSeconds !== "number" ||
      !Number.isFinite(clip.durationSeconds) ||
      clip.durationSeconds <= 0
    ) fail("manifest/clip-invalid");
    if (listed.has(clip.id)) fail("manifest/clip-id-duplicate");
    if (!expected.has(clip.id)) fail("manifest/clip-id-unknown");
    if (clip.textSha256 !== expected.get(clip.id).textSha256) fail("manifest/text-digest-mismatch");

    let bytes;
    try {
      bytes = await readFile(join(directory, clip.file));
    } catch {
      fail("manifest/clip-missing");
    }
    if (bytes.length !== clip.bytes || sha256(bytes) !== clip.sha256) fail("manifest/clip-digest-mismatch");
    const audio = parseMp3(bytes);
    if (Math.abs(audio.durationSeconds - clip.durationSeconds) > 0.04) fail("manifest/duration-mismatch");
    listed.set(clip.id, clip);
    totalBytes += bytes.length;
  }
  if ([...expected.keys()].some((id) => !listed.has(id))) fail("manifest/coverage-mismatch");
  if (totalBytes > MAX_V2_AUDIO_BYTES) fail("audio/size-cap-exceeded");

  const entries = await readdir(directory, { withFileTypes: true });
  const actualMp3s = new Set(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".mp3")).map((entry) => entry.name));
  const listedMp3s = new Set(manifest.clips.map((clip) => clip.file));
  if (actualMp3s.size !== listedMp3s.size || [...actualMp3s].some((name) => !listedMp3s.has(name))) {
    fail("manifest/orphan-audio");
  }
  return { clipCount: listed.size, totalBytes };
}

async function readManifest(directory) {
  try {
    return JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  } catch {
    fail("manifest/unreadable");
  }
}

async function runCheck() {
  await assertNoAudioGenerationLock(AUDIO_DIR);
  let facts;
  try {
    facts = await readFile(FACTS_PATH);
  } catch {
    fail("source/facts-unreadable");
  }
  const greeting = await readGreeting();
  const inventory = createAudioSourceInventory(facts, greeting);
  const manifest = await readManifest(AUDIO_DIR);
  const result = await validateCatalogCorpusV2({ directory: AUDIO_DIR, manifest, inventory });

  const expectedNames = new Set(["manifest.json", ...manifest.clips.map((clip) => clip.file)]);
  const entries = await readdir(AUDIO_DIR, { withFileTypes: true });
  if (
    entries.length !== expectedNames.size ||
    entries.some((entry) => !entry.isFile() || !expectedNames.has(entry.name))
  ) fail("manifest/directory-entry-mismatch");
  await assertNoAudioGenerationLock(AUDIO_DIR);
  console.log(`[cv-audio] check passed: clips=${result.clipCount} bytes=${result.totalBytes}`);
}

async function runProcess(command, args, timeoutMs, failureCode, {
  spawnProcess = spawn, termGraceMs = 1000, killSettlementReserveMs = 5000,
  signal, deadlineAt, requiredAfterProcessMs = 0, monotonicNow = () => performance.now(),
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  if (signal?.aborted) throw new AudioTaskError("audio/cancelled");
  if (deadlineAt !== undefined && (!Number.isFinite(deadlineAt) || !Number.isSafeInteger(requiredAfterProcessMs) ||
      requiredAfterProcessMs < 0 || typeof monotonicNow !== "function")) throw new AudioTaskError("deadline/invalid");
  if (deadlineAt !== undefined) {
    const remaining = deadlineAt - monotonicNow();
    if (!Number.isFinite(remaining) || remaining < timeoutMs + termGraceMs + killSettlementReserveMs + requiredAfterProcessMs) {
      throw new AudioTaskError("deadline/window-insufficient");
    }
  }
  await new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      if (signal?.aborted) throw new AudioTaskError("audio/cancelled");
      child = spawnProcess(command, args, {
        stdio: "ignore",
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      rejectPromise(error instanceof AudioTaskError ? error : new AudioTaskError(failureCode));
      return;
    }
    let timedOut = false;
    let cancelled = false;
    let spawnError = false;
    let stopping = false;
    let killTimer;
    const killOwned = (signalName) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signalName);
        else child.kill(signalName);
      } catch {}
    };
    const requestStop = (reason) => {
      if (stopping) return;
      stopping = true;
      if (reason === "timeout") timedOut = true;
      if (reason === "cancelled") cancelled = true;
      killOwned("SIGTERM");
      killTimer = setTimer(() => killOwned("SIGKILL"), termGraceMs);
    };
    const onAbort = () => requestStop("cancelled");
    const timer = setTimer(() => requestStop("timeout"), timeoutMs);
    child.once("error", () => { spawnError = true; });
    child.once("close", (code) => {
      clearTimer(timer);
      if (killTimer !== undefined) clearTimer(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (timedOut) rejectPromise(new AudioTaskError(failureCode));
      else if (cancelled) rejectPromise(new AudioTaskError("audio/cancelled"));
      else if (spawnError || code !== 0) rejectPromise(new AudioTaskError(failureCode));
      else resolvePromise();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export const audioProcessTest = Object.freeze({ runProcess });

async function encodeWav(wavPath, mp3Path, { signal, deadlineAt, requiredAfterProcessMs, monotonicNow, encoderExecutable = "ffmpeg" } = {}) {
  await runProcess(
    encoderExecutable,
    [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-i", wavPath,
      "-map_metadata", "-1", "-vn", "-ac", "1", "-ar", "24000",
      "-codec:a", "libmp3lame", "-b:a", "32k", "-minrate", "32k", "-maxrate", "32k",
      "-write_xing", "0", "-id3v2_version", "0", "-f", "mp3", mp3Path,
    ],
    120_000,
    "audio/encode-failed",
    { signal, deadlineAt, requiredAfterProcessMs, monotonicNow },
  );
}

export function createKittenStageCancellation({
  deadlineAt,
  processRef = process,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  monotonicNow = () => performance.now(),
} = {}) {
  if (!Number.isFinite(deadlineAt) || typeof monotonicNow !== "function" ||
      typeof processRef?.on !== "function" || typeof processRef?.removeListener !== "function") {
    throw new AudioTaskError("deadline/invalid");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  processRef.on("SIGTERM", abort);
  processRef.on("SIGINT", abort);
  const timer = setTimer(abort, Math.max(0, deadlineAt - monotonicNow()));
  let disposed = false;
  return {
    signal: controller.signal,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer(timer);
      processRef.removeListener("SIGTERM", abort);
      processRef.removeListener("SIGINT", abort);
    },
  };
}

/** Same offline facts contract as cv:facts:check; this does not establish source review. */
export async function checkFinalFacts() {
  const source = readCanonicalSource();
  const path = resolveFinalArtifactPath();
  const artifact = JSON.parse(await readFile(path, "utf8"));
  const result = validateArtifact(artifact, {
    sourceRelativePath: source.relativePath, sourceSha256: source.sha256, sourceLineCount: source.lineCount,
  });
  if (result.findings.length > 0) fail("source/facts-check-failed");
  return result;
}

async function requireEncoder() {
  const { realpath, stat } = await import("node:fs/promises");
  const { delimiter } = await import("node:path");
  for (const root of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(root)) continue;
    const info = await stat(join(root, "ffmpeg")).catch(() => null);
    if (info?.isFile() && (info.mode & 0o111) !== 0) return realpath(join(root, "ffmpeg"));
  }
  fail("audio/ffmpeg-required");
}

async function runKittenStageCommand(options) {
  const deadlineAt = performance.now() + options.deadlineMinutes * 60 * 1000;
  const cancellation = createKittenStageCancellation({ deadlineAt });
  let encoderExecutable = "ffmpeg";
  try {
    const greeting = await readGreeting();
    if (cancellation.signal.aborted) throw new KittenStageError("stage/cancelled");
    const { generateKittenAudio, preflightKittenRuntime } = await import("./cv-audio/kitten.mjs");
    if (options.final) await checkFinalFacts();
    if (cancellation.signal.aborted) throw new KittenStageError("stage/cancelled");
    return await runKittenStage({
      final: options.final,
      factsPath: options.facts,
      factsSha256: options.factsSha256,
      runtimeInputsPath: options.runtimeInputs,
      stagePath: options.stage,
      deadlineMinutes: options.deadlineMinutes,
      deadlineAt,
      signal: cancellation.signal,
      greeting,
      ports: {
        generateAudio: generateKittenAudio,
        checkFinalFacts,
        preflight: async (runtime) => {
          await preflightKittenRuntime(runtime);
          encoderExecutable = await requireEncoder();
        },
        encodeWav: (wavPath, mp3Path, processOptions) => encodeWav(wavPath, mp3Path, { ...processOptions, encoderExecutable }),
        parseMp3,
        validateCorpus: validateCatalogCorpusV2,
        maxAudioBytes: MAX_V2_AUDIO_BYTES,
      },
      onProgress(event) {
        if (event.event === "item-start") {
          console.log(`[cv-audio] ${options.final ? "final" : "kitten-stage"} item-start id=${event.id} index=${event.index}/${event.count}`);
        } else if (event.event === "item-complete") {
          console.log(`[cv-audio] ${options.final ? "final" : "kitten-stage"} item-complete id=${event.id} index=${event.index}/${event.count} mp3Bytes=${event.mp3Bytes} mp3Sha256=${event.mp3Sha256} elapsedMs=${event.elapsedMs}`);
        } else if (event.event === "complete") {
          console.log(`[cv-audio] ${options.final ? "final" : "kitten-stage"} complete status=${event.status} clips=${event.clipCount} bytes=${event.totalBytes} factsSha256=${event.factsSha256} catalogSha256=${event.catalogSha256} stage=${event.stageDirectory} workspaces=${event.workspaceRoot} activity=${event.activityPath}`);
        }
      },
    });
  } finally {
    cancellation.dispose();
  }
}

async function main() {
  const options = parseAudioArguments(process.argv.slice(2));
  if (options.kittenStage || options.final) return runKittenStageCommand(options);
  return runCheck();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const code = error instanceof AudioTaskError || error instanceof AudioCatalogError || error instanceof KittenStageError
      ? error.code
      : "internal-error";
    console.error(`[cv-audio] failed: ${code}`);
    if (error instanceof KittenStageError && error.stageDirectory && error.workspaceRoot) {
      console.error(`[cv-audio] output may be incomplete; do not serve without both pair checks; retained output=${error.stageDirectory} workspaces=${error.workspaceRoot}${error.activityPath ? ` activity=${error.activityPath}` : ""}`);
    }
    process.exitCode = 1;
  });
}
