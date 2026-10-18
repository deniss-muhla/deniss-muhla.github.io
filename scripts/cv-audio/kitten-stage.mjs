import { constants, linkSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, lstat, realpath, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { createAudioSourceInventory, createV2Manifest } from "./catalog.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const SHA256 = /^[a-f0-9]{64}$/;
const RUNTIME_KEYS = [
  "version", "pythonExecutable", "sandboxExecutable", "sdkRoot", "sdkArchive",
  "modelSnapshot", "hubCache", "modulePathsFile",
];
const RUNTIME_PATH_KINDS = {
  pythonExecutable: "executable",
  sandboxExecutable: "executable",
  sdkRoot: "directory",
  sdkArchive: "file",
  modelSnapshot: "directory",
  hubCache: "directory",
};
const MODULE_PATH_COUNT = 88;
const MAX_ITEM_TEXT_LENGTH = 2000;
const EVENT_FILE = "activity.jsonl";
const ADAPTER_TIMEOUT_MS = 10 * 60 * 1000;
const ADAPTER_TERM_GRACE_MS = 250;
const ADAPTER_KILL_SETTLEMENT_MS = 5000;
const ENCODER_TIMEOUT_MS = 2 * 60 * 1000;
const ENCODER_TERM_GRACE_MS = 1000;
const ENCODER_KILL_SETTLEMENT_MS = 5000;
const FINALIZATION_MARGIN_MS = 60 * 1000;
const ENCODER_WINDOW_MS = ENCODER_TIMEOUT_MS + ENCODER_TERM_GRACE_MS + ENCODER_KILL_SETTLEMENT_MS;
const AFTER_ADAPTER_WINDOW_MS = ENCODER_WINDOW_MS + FINALIZATION_MARGIN_MS;
const FRESH_ITEM_WINDOW_MS = ADAPTER_TIMEOUT_MS + ADAPTER_TERM_GRACE_MS + ADAPTER_KILL_SETTLEMENT_MS + AFTER_ADAPTER_WINDOW_MS;
export const MAX_KITTEN_STAGE_DEADLINE_MINUTES = 168;

function requireJobWindow(deadlineAt, requiredMs, monotonicNow) {
  const remaining = deadlineAt - monotonicNow();
  if (!Number.isFinite(remaining) || remaining < requiredMs) fail("deadline/window-insufficient");
}

function requireNotAborted(signal) {
  if (signal?.aborted) fail("stage/cancelled");
}

export class KittenStageError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "KittenStageError";
    this.code = code;
    this.stageDirectory = details.stageDirectory ?? null;
    this.workspaceRoot = details.workspaceRoot ?? null;
    this.activityPath = details.activityPath ?? null;
  }
}

const fail = (code) => { throw new KittenStageError(code); };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function isWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function safeFailureCode(error, fallback) {
  return typeof error?.code === "string" && /^[a-z0-9/-]{1,100}$/.test(error.code)
    ? error.code
    : fallback;
}

async function lstatOrNull(path) {
  try { return await lstat(path); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function existingExternalPath(path, field, kind, { noSymlink = false } = {}) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) fail(`input/${field}-path-invalid`);
  const canonical = await realpath(path).catch(() => "");
  if (!canonical || isWithin(ROOT, canonical)) fail(canonical ? "input/repository-path-forbidden" : `input/${field}-path-unavailable`);
  if (noSymlink && canonical !== path) fail(`input/${field}-path-aliased`);
  const info = noSymlink ? await lstat(path).catch(() => null) : await stat(canonical).catch(() => null);
  if (!info) fail(`input/${field}-path-unavailable`);
  if (kind === "file" && !info.isFile()) fail(`input/${field}-path-invalid`);
  if (kind === "directory" && !info.isDirectory()) fail(`input/${field}-path-invalid`);
  if (kind === "executable" && (!info.isFile() || (info.mode & 0o111) === 0)) fail(`input/${field}-path-invalid`);
  if (noSymlink && info.isSymbolicLink()) fail(`input/${field}-path-aliased`);
  return { path, canonical, info };
}

async function readStableSource(source, field) {
  const before = await lstatOrNull(source.path);
  if (!before?.isFile() || before.isSymbolicLink() || !sameIdentity(before, source.info)) fail(`input/${field}-path-replaced`);
  let handle;
  try {
    handle = await open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(opened, source.info)) fail(`input/${field}-path-replaced`);
    const bytes = await handle.readFile();
    const current = await lstatOrNull(source.path);
    if (!current?.isFile() || current.isSymbolicLink() || !sameIdentity(current, source.info)) fail(`input/${field}-path-replaced`);
    return bytes;
  } catch (error) {
    if (error instanceof KittenStageError) throw error;
    fail(`input/${field}-read-failed`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readJsonSource(source, field) {
  const bytes = await readStableSource(source, field);
  try { return JSON.parse(bytes.toString("utf8")); } catch { fail(`input/${field}-json-invalid`); }
}

async function validateRuntimeInputs(runtimeInputsPath) {
  const runtimeSource = await existingExternalPath(runtimeInputsPath, "runtime-inputs", "file", { noSymlink: true });
  const runtime = await readJsonSource(runtimeSource, "runtime-inputs");
  if (!exactKeys(runtime, RUNTIME_KEYS) || runtime.version !== 1) fail("input/runtime-inputs-invalid");

  const resolved = {};
  const protectedRoots = [];
  for (const [field, kind] of Object.entries(RUNTIME_PATH_KINDS)) {
    if (typeof runtime[field] !== "string" || !isAbsolute(runtime[field]) || resolve(runtime[field]) !== runtime[field]) {
      fail(`input/${field}-path-invalid`);
    }
    const checked = await existingExternalPath(runtime[field], field, kind);
    resolved[field] = checked.path;
    if (["sdkRoot", "modelSnapshot", "hubCache"].includes(field)) protectedRoots.push(checked.canonical);
  }
  const moduleFile = await existingExternalPath(runtime.modulePathsFile, "module-paths-file", "file", { noSymlink: true });
  const moduleRecord = await readJsonSource(moduleFile, "module-paths-file");
  const hasPackageSources = isRecord(moduleRecord) && Object.hasOwn(moduleRecord, "packageSources");
  const allowedModuleKeys = hasPackageSources ? ["modulePaths", "packageSources"] : ["modulePaths"];
  if (!exactKeys(moduleRecord, allowedModuleKeys) || !Array.isArray(moduleRecord.modulePaths) || moduleRecord.modulePaths.length !== MODULE_PATH_COUNT) {
    fail("input/module-paths-invalid");
  }
  if (hasPackageSources) {
    const packageSources = moduleRecord.packageSources;
    const sourceNames = isRecord(packageSources) ? Object.keys(packageSources) : [];
    if (!isRecord(packageSources) || sourceNames.length !== MODULE_PATH_COUNT || sourceNames.some((name) => name.trim() === "")) {
      fail("input/module-paths-invalid");
    }
  }
  const modulePaths = [];
  const canonicalRoots = new Set();
  for (const root of moduleRecord.modulePaths) {
    if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root) fail("input/module-paths-invalid");
    const checked = await existingExternalPath(root, "module", "directory");
    if (canonicalRoots.has(checked.canonical)) fail("input/module-paths-aliased");
    canonicalRoots.add(checked.canonical);
    protectedRoots.push(checked.canonical);
    modulePaths.push(root);
  }
  const pythonPrefix = await realpath(dirname(dirname(resolved.pythonExecutable))).catch(() => "");
  if (!pythonPrefix) fail("input/python-prefix-unavailable");
  protectedRoots.push(pythonPrefix);
  return {
    runtime: { ...resolved, modulePaths, modulePathsFile: moduleFile.path, runtimeInputsPath: runtimeSource.path },
    protectedRoots: [...new Set(protectedRoots)],
  };
}

async function validateStageTarget(stagePath, sourcePaths, protectedRoots) {
  if (typeof stagePath !== "string" || !isAbsolute(stagePath) || resolve(stagePath) !== stagePath) fail("stage/path-invalid");
  const parent = dirname(stagePath);
  const canonicalParent = await realpath(parent).catch(() => "");
  if (!canonicalParent || canonicalParent !== parent) fail("stage/parent-path-invalid");
  if (isWithin(ROOT, canonicalParent)) fail("stage/repository-path-forbidden");
  if (protectedRoots.some((root) => isWithin(root, stagePath))) fail("stage/runtime-path-protected");
  const parentInfo = await lstat(canonicalParent).catch(() => null);
  if (!parentInfo?.isDirectory() || parentInfo.isSymbolicLink()) fail("stage/parent-path-invalid");
  const existing = await lstatOrNull(stagePath);
  if (existing) fail("stage/already-exists");
  if (sourcePaths.has(stagePath)) fail("stage/path-alias");
  const pendingPath = `${stagePath}.manifest.pending`;
  if (sourcePaths.has(pendingPath)) fail("stage/path-alias");
  if (await lstatOrNull(pendingPath)) fail("stage/manifest-pending-already-exists");
  return { path: stagePath, parent: canonicalParent, parentInfo };
}

async function validateStageIdentity(stage, identity) {
  const currentParent = await lstatOrNull(stage.parent);
  if (!currentParent?.isDirectory() || currentParent.isSymbolicLink() || !sameIdentity(currentParent, stage.parentInfo)) fail("stage/parent-path-replaced");
  if (await realpath(stage.parent).catch(() => "") !== stage.parent) fail("stage/parent-path-replaced");
  const current = await lstatOrNull(stage.path);
  if (!current?.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, identity)) fail("stage/path-replaced");
  if (await realpath(stage.path).catch(() => "") !== stage.path) fail("stage/path-replaced");
}

async function validateWorkspaceIdentity(path, identity) {
  const current = await lstatOrNull(path);
  if (!current?.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, identity)) fail("stage/workspace-replaced");
  if (await realpath(path).catch(() => "") !== path) fail("stage/workspace-replaced");
}

async function readOwnedFile(path, field, expectedParent, parentIdentity) {
  await validateWorkspaceIdentity(expectedParent, parentIdentity);
  const before = await lstatOrNull(path);
  if (!before?.isFile() || before.isSymbolicLink()) fail(`stage/${field}-invalid`);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(opened, before)) fail(`stage/${field}-replaced`);
    const bytes = await handle.readFile();
    const after = await lstatOrNull(path);
    if (!after?.isFile() || after.isSymbolicLink() || !sameIdentity(after, before)) fail(`stage/${field}-replaced`);
    await validateWorkspaceIdentity(expectedParent, parentIdentity);
    return { bytes, info: before };
  } catch (error) {
    if (error instanceof KittenStageError) throw error;
    fail(`stage/${field}-read-failed`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeExclusive(path, bytes, { stage, stageIdentity, code }) {
  await validateStageIdentity(stage, stageIdentity);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") fail(code);
    fail("stage/output-open-failed");
  }
  try {
    const opened = await handle.stat();
    const current = await lstatOrNull(path);
    await validateStageIdentity(stage, stageIdentity);
    if (!current?.isFile() || current.isSymbolicLink() || !sameIdentity(opened, current)) fail("stage/output-path-replaced");
    await handle.writeFile(bytes);
    await handle.sync();
    const written = await handle.stat();
    const after = await lstatOrNull(path);
    await validateStageIdentity(stage, stageIdentity);
    if (!after?.isFile() || after.isSymbolicLink() || !sameIdentity(opened, after) || written.size !== bytes.length) fail("stage/output-path-replaced");
    return { dev: after.dev, ino: after.ino };
  } catch (error) {
    if (error instanceof KittenStageError) throw error;
    fail("stage/output-write-failed");
  } finally {
    await handle.close().catch(() => {});
  }
}

async function commitManifest(stage, stageIdentity, bytes, { signal, deadlineAt, monotonicNow }) {
  const pendingPath = `${stage.path}.manifest.pending`;
  const pendingIdentity = await writeExclusive(pendingPath, bytes, {
    stage, stageIdentity, code: "stage/manifest-pending-already-exists",
  });
  requireNotAborted(signal);
  requireJobWindow(deadlineAt, FINALIZATION_MARGIN_MS, monotonicNow);
  await validateStageIdentity(stage, stageIdentity);
  requireNotAborted(signal);
  requireJobWindow(deadlineAt, FINALIZATION_MARGIN_MS, monotonicNow);
  const pendingInfo = lstatSync(pendingPath);
  if (!pendingInfo.isFile() || pendingInfo.isSymbolicLink() || !sameIdentity(pendingInfo, pendingIdentity)) fail("stage/manifest-pending-replaced");
  try {
    linkSync(pendingPath, join(stage.path, "manifest.json"));
  } catch (error) {
    if (error?.code === "EEXIST") fail("stage/manifest-already-exists");
    fail("stage/manifest-commit-failed");
  }
  const committedInfo = lstatSync(join(stage.path, "manifest.json"));
  if (!committedInfo.isFile() || committedInfo.isSymbolicLink() || !sameIdentity(committedInfo, pendingIdentity)) fail("stage/manifest-commit-invalid");
}

async function assertOnlyOwnedClips(stage, stageIdentity, clips, ownedFiles) {
  await validateStageIdentity(stage, stageIdentity);
  const expected = new Map(ownedFiles);
  const entries = await readdir(stage.path, { withFileTypes: true });
  if (entries.length !== clips.length) fail("stage/unexpected-entry");
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !expected.has(entry.name)) fail("stage/unexpected-entry");
    const current = await lstat(join(stage.path, entry.name));
    if (!sameIdentity(current, expected.get(entry.name))) fail("stage/output-path-replaced");
  }
}

function validateInventoryTexts(inventory) {
  if (!Array.isArray(inventory?.items) || inventory.items.length === 0) fail("source/inventory-invalid");
  const ids = new Set();
  for (const item of inventory.items) {
    if (!item || typeof item.id !== "string" || ids.has(item.id)) fail("source/inventory-invalid");
    ids.add(item.id);
    if (typeof item.text !== "string" || item.text.trim() === "" || item.text.length > MAX_ITEM_TEXT_LENGTH || /[\r\n]/.test(item.text)) {
      fail("source/item-text-invalid");
    }
  }
}

async function createActivity(workspaceRoot, stagePath, itemCount) {
  const activityPath = join(workspaceRoot, EVENT_FILE);
  const handle = await open(activityPath, "wx", 0o600);
  const write = async (event) => {
    await handle.write(`${JSON.stringify(event)}\n`);
    await handle.sync();
  };
  await write({ event: "run-start", itemCount, stageDirectory: stagePath, workspaceRoot });
  return { handle, path: activityPath, write };
}

function makeStageError(error, context) {
  if (error instanceof KittenStageError) {
    error.stageDirectory ??= context.stageDirectory ?? null;
    error.workspaceRoot ??= context.workspaceRoot ?? null;
    error.activityPath ??= context.activityPath ?? null;
    return error;
  }
  return new KittenStageError(safeFailureCode(error, "stage/failed"), context);
}

/** Prepare a non-servable v2 corpus. All synthesis/encoding implementations are explicit ports. */
export async function runKittenStage({
  factsPath,
  factsSha256,
  runtimeInputsPath,
  stagePath,
  greeting,
  ports,
  deadlineMinutes,
  deadlineAt = null,
  signal,
  monotonicNow = () => performance.now(),
  onProgress = () => {},
}) {
  let stage;
  let stageIdentity;
  let workspaceRoot = null;
  let activity;
  let currentItem = null;
  const context = {};
  try {
    if (!Number.isSafeInteger(deadlineMinutes) || deadlineMinutes <= 0 || deadlineMinutes > MAX_KITTEN_STAGE_DEADLINE_MINUTES) {
      fail("deadline/invalid");
    }
    if (typeof monotonicNow !== "function") fail("deadline/clock-invalid");
    if (signal !== undefined && (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
      fail("stage/cancellation-invalid");
    }
    const jobStartedAt = monotonicNow();
    if (!Number.isFinite(jobStartedAt)) fail("deadline/clock-invalid");
    const jobDeadlineAt = deadlineAt === null ? jobStartedAt + deadlineMinutes * 60 * 1000 : deadlineAt;
    if (!Number.isFinite(jobDeadlineAt) || jobDeadlineAt <= jobStartedAt) fail("deadline/invalid");
    requireNotAborted(signal);
    if (typeof factsSha256 !== "string" || !SHA256.test(factsSha256)) fail("input/facts-digest-invalid");
    if (typeof greeting !== "string" || greeting.trim() === "") fail("source/greeting-invalid");
    if (!ports || typeof ports.generateAudio !== "function" || typeof ports.encodeWav !== "function" ||
        typeof ports.parseMp3 !== "function" || typeof ports.validateCorpus !== "function" ||
        typeof ports.maxAudioBytes !== "number" || !Number.isSafeInteger(ports.maxAudioBytes) || ports.maxAudioBytes <= 0) {
      fail("stage/ports-invalid");
    }

    const factsSource = await existingExternalPath(factsPath, "facts", "file", { noSymlink: true });
    const initialFacts = await readStableSource(factsSource, "facts");
    if (sha256(initialFacts) !== factsSha256) fail("input/facts-digest-mismatch");
    const inventory = createAudioSourceInventory(initialFacts, greeting);
    validateInventoryTexts(inventory);

    requireNotAborted(signal);
    requireJobWindow(jobDeadlineAt, FRESH_ITEM_WINDOW_MS, monotonicNow);

    requireNotAborted(signal);
    const { runtime, protectedRoots } = await validateRuntimeInputs(runtimeInputsPath);
    requireNotAborted(signal);
    const stageSources = new Set([
      factsSource.path,
      runtime.runtimeInputsPath,
      runtime.modulePathsFile,
      ...Object.values(runtime).filter((value) => typeof value === "string" && isAbsolute(value)),
      ...runtime.modulePaths,
    ]);
    requireNotAborted(signal);
    const tempRoot = await realpath(tmpdir()).catch(() => "");
    if (!tempRoot) fail("stage/workspace-root-unavailable");
    const tempRootInfo = await stat(tempRoot).catch(() => null);
    if (!tempRootInfo?.isDirectory()) fail("stage/workspace-root-unavailable");
    if (isWithin(ROOT, tempRoot)) fail("stage/workspace-root-forbidden");
    if (protectedRoots.some((root) => isWithin(root, tempRoot))) fail("stage/runtime-path-protected");

    stage = await validateStageTarget(stagePath, stageSources, protectedRoots);
    context.stageDirectory = stage.path;

    if (isWithin(stage.path, tempRoot) || isWithin(tempRoot, stage.path)) {
      // Sibling stage paths under the system temp root are allowed; only exact nesting is rejected below.
      if (stage.path === tempRoot || isWithin(stage.path, tempRoot)) fail("stage/workspace-root-alias");
    }

    // All source, inventory, runtime and output paths are checked before either output root is created.
    requireNotAborted(signal);
    requireJobWindow(jobDeadlineAt, FRESH_ITEM_WINDOW_MS, monotonicNow);
    await mkdir(stage.path);
    const madeStage = await lstat(stage.path);
    if (!madeStage.isDirectory() || madeStage.isSymbolicLink()) fail("stage/path-created-invalid");
    stageIdentity = { dev: madeStage.dev, ino: madeStage.ino };
    workspaceRoot = await mkdtemp(join(tempRoot, "cv-audio-kitten-stage-"));
    context.workspaceRoot = workspaceRoot;
    const activityContext = await createActivity(workspaceRoot, stage.path, inventory.items.length);
    activity = activityContext;
    context.activityPath = activity.path;

    const ownedFiles = new Map();
    const clips = [];
    let totalBytes = 0;
    for (let index = 0; index < inventory.items.length; index += 1) {
      const item = inventory.items[index];
      currentItem = { id: item.id, index: index + 1, count: inventory.items.length };
      requireNotAborted(signal);
      requireJobWindow(jobDeadlineAt, FRESH_ITEM_WINDOW_MS, monotonicNow);
      const started = monotonicNow();
      const itemWorkspace = await mkdtemp(join(workspaceRoot, `${String(index + 1).padStart(3, "0")}-${item.id}-`));
      const itemDirectory = await lstat(itemWorkspace);
      const itemIdentity = { dev: itemDirectory.dev, ino: itemDirectory.ino };
      const wavPath = join(itemWorkspace, "source.wav");
      const metadataPath = join(itemWorkspace, "runtime.json");
      const encodedPath = join(itemWorkspace, "encoded.mp3");
      await activity.write({ event: "item-start", id: item.id, index: index + 1, count: inventory.items.length });
      onProgress({ event: "item-start", id: item.id, index: index + 1, count: inventory.items.length });

      requireNotAborted(signal);
      requireJobWindow(jobDeadlineAt, FRESH_ITEM_WINDOW_MS, monotonicNow);
      const adapterResult = await ports.generateAudio({
        ...runtime,
        text: item.text,
        workspace: itemWorkspace,
        outputWav: wavPath,
        metadataPath,
        signal,
        deadlineAt: jobDeadlineAt,
        requiredAfterProcessMs: AFTER_ADAPTER_WINDOW_MS,
        monotonicNow,
      });
      await validateStageIdentity(stage, stageIdentity);
      const wav = await readOwnedFile(wavPath, "wav", itemWorkspace, itemIdentity);
      await readOwnedFile(metadataPath, "metadata", itemWorkspace, itemIdentity);
      const wavDigest = sha256(wav.bytes);
      if (!adapterResult || adapterResult.status !== "ok" || adapterResult.audio?.path !== wavPath ||
          adapterResult.audio.bytes !== wav.bytes.length || adapterResult.audio.sha256 !== wavDigest) {
        fail("stage/adapter-result-invalid");
      }
      const generated = await lstatOrNull(encodedPath);
      if (generated) fail("stage/encoded-output-exists");
      requireNotAborted(signal);
      requireJobWindow(jobDeadlineAt, ENCODER_WINDOW_MS + FINALIZATION_MARGIN_MS, monotonicNow);
      await ports.encodeWav(wavPath, encodedPath, {
        signal,
        deadlineAt: jobDeadlineAt,
        requiredAfterProcessMs: FINALIZATION_MARGIN_MS,
        monotonicNow,
      });
      requireNotAborted(signal);
      requireJobWindow(jobDeadlineAt, FINALIZATION_MARGIN_MS, monotonicNow);
      await validateWorkspaceIdentity(itemWorkspace, itemIdentity);
      const encodedFile = await readOwnedFile(encodedPath, "encoded-mp3", itemWorkspace, itemIdentity);
      const parsed = ports.parseMp3(encodedFile.bytes);
      if (!Number.isSafeInteger(encodedFile.bytes.length) || encodedFile.bytes.length <= 0 ||
          !parsed || typeof parsed.durationSeconds !== "number" || !Number.isFinite(parsed.durationSeconds) || parsed.durationSeconds <= 0) {
        fail("stage/mp3-invalid");
      }
      if (totalBytes + encodedFile.bytes.length > ports.maxAudioBytes) fail("audio/size-cap-exceeded");
      const digest = sha256(encodedFile.bytes);
      const file = `${item.id}-${digest}.mp3`;
      const identity = await writeExclusive(join(stage.path, file), encodedFile.bytes, {
        stage,
        stageIdentity,
        code: "stage/output-already-exists",
      });
      ownedFiles.set(file, identity);
      const clip = {
        id: item.id,
        file,
        bytes: encodedFile.bytes.length,
        durationSeconds: parsed.durationSeconds,
        sha256: digest,
      };
      clips.push(clip);
      totalBytes += encodedFile.bytes.length;
      const result = {
        event: "item-complete",
        id: item.id,
        index: index + 1,
        count: inventory.items.length,
        wavBytes: wav.bytes.length,
        wavSha256: wavDigest,
        mp3Bytes: encodedFile.bytes.length,
        mp3Sha256: digest,
        elapsedMs: monotonicNow() - started,
      };
      await activity.write(result);
      onProgress(result);
    }

    currentItem = null;
    requireNotAborted(signal);
    requireJobWindow(jobDeadlineAt, FINALIZATION_MARGIN_MS, monotonicNow);
    const currentFacts = await readStableSource(factsSource, "facts");
    if (sha256(currentFacts) !== factsSha256) fail("input/facts-changed");
    const manifest = createV2Manifest(inventory, clips);
    requireNotAborted(signal);
    requireJobWindow(jobDeadlineAt, FINALIZATION_MARGIN_MS, monotonicNow);
    const validated = await ports.validateCorpus({ directory: stage.path, manifest, inventory, signal, deadlineAt: jobDeadlineAt });
    requireNotAborted(signal);
    requireJobWindow(jobDeadlineAt, FINALIZATION_MARGIN_MS, monotonicNow);
    await validateStageIdentity(stage, stageIdentity);
    await assertOnlyOwnedClips(stage, stageIdentity, clips, ownedFiles);
    const finalFacts = await readStableSource(factsSource, "facts");
    if (sha256(finalFacts) !== factsSha256) fail("input/facts-changed");
    requireNotAborted(signal);
    requireJobWindow(jobDeadlineAt, FINALIZATION_MARGIN_MS, monotonicNow);
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await commitManifest(stage, stageIdentity, manifestBytes, {
      signal,
      deadlineAt: jobDeadlineAt,
      monotonicNow,
    });
    await activity.write({
      event: "complete",
      status: "staged-not-servable",
      clipCount: validated.clipCount,
      totalBytes: validated.totalBytes,
      factsSha256: inventory.factsSha256,
      greetingSha256: inventory.greetingSha256,
      catalogSha256: inventory.catalogSha256,
    });
    const summary = {
      status: "staged-not-servable",
      version: 2,
      clipCount: validated.clipCount,
      totalBytes: validated.totalBytes,
      factsSha256: inventory.factsSha256,
      greetingSha256: inventory.greetingSha256,
      catalogSha256: inventory.catalogSha256,
      stageDirectory: stage.path,
      workspaceRoot,
      activityPath: activity.path,
    };
    onProgress({ event: "complete", ...summary });
    return summary;
  } catch (error) {
    const stageContext = {
      stageDirectory: stage?.path ?? context.stageDirectory,
      workspaceRoot,
      activityPath: activity?.path,
    };
    const safeError = makeStageError(error, stageContext);
    if (activity) {
      await activity.write({
        event: "failed",
        code: safeError.code,
        ...currentItem,
      }).catch(() => {});
    }
    throw safeError;
  } finally {
    await activity?.handle.close().catch(() => {});
  }
}
