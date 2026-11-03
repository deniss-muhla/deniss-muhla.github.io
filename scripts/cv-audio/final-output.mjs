/** Fixed final-path ownership checks. No external path guard is relaxed by this mode. */
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
export const FINAL_FACTS_PATH = join(ROOT, "resources/cv/facts.json");
export const FINAL_AUDIO_PATH = join(ROOT, "public/audio/assistant");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (left, right) => left && right && left.dev === right.dev && left.ino === right.ino;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

const lockPath = (directory) => `${directory}.generation.lock`;

export async function assertNoAudioGenerationLock(directory) {
  const info = await lstat(lockPath(directory)).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (info) fail("final/generation-in-progress");
}

function assertLockParent(stage, identity) {
  if (realpathSync(stage.parent) !== stage.parent || !same(lstatSync(stage.parent), stage.parentInfo) ||
      realpathSync(stage.path) !== stage.path || !same(lstatSync(stage.path), identity)) fail("final/output-replaced");
}

export function validateFinalLock(stage, identity, lockIdentity) {
  assertLockParent(stage, identity);
  let current;
  try { current = lstatSync(lockPath(stage.path)); } catch { fail("final/lock-replaced"); }
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || !same(current, lockIdentity)) fail("final/lock-replaced");
}

export function acquireFinalLock(stage, identity) {
  assertLockParent(stage, identity);
  let fd;
  let owned;
  try {
    fd = openSync(lockPath(stage.path), "wx", 0o600);
    owned = fstatSync(fd);
    closeSync(fd);
    fd = undefined;
    validateFinalLock(stage, identity, owned);
    return owned;
  } catch (error) {
    if (owned) releaseFinalLock(stage, identity, owned);
    if (error.code === "EEXIST") fail("final/generation-in-progress");
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function releaseFinalLock(stage, identity, lockIdentity) {
  validateFinalLock(stage, identity, lockIdentity);
  unlinkSync(lockPath(stage.path));
}

async function canonical(path, kind) {
  const info = await lstat(path).catch(() => null);
  if (!info || info.isSymbolicLink() || await realpath(path).catch(() => "") !== path ||
      (kind === "file" ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())) fail("final/path-aliased-or-invalid");
  return info;
}

export async function finalFactsSource(path = FINAL_FACTS_PATH) {
  if (path !== FINAL_FACTS_PATH) fail("final/facts-path-required");
  return { path, canonical: path, info: await canonical(path, "file"), requireCanonical: true };
}

async function snapshotFile(path) {
  const info = await canonical(path, "file");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !same(info, opened)) fail("final/output-replaced");
    const bytes = await handle.readFile();
    const after = await canonical(path, "file");
    if (!same(info, after) || info.size !== bytes.length) fail("final/output-replaced");
    return { info, sha256: digest(bytes), bytes };
  } finally { await handle.close(); }
}

/** A complete prior generated corpus may be replaced even when its facts identity is old. */
export async function finalOutputTarget(path = FINAL_AUDIO_PATH, validateCorpus) {
  if (path !== FINAL_AUDIO_PATH) fail("final/audio-path-required");
  const parent = dirname(path);
  const parentInfo = await canonical(parent, "directory");
  await assertNoAudioGenerationLock(path);
  const info = await lstat(path).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
  const stage = { path, parent, parentInfo, prior: new Map(), existing: info !== null };
  if (!info) return stage;
  stage.info = await canonical(path, "directory");
  const names = await readdir(path);
  if (names.length === 0) return stage;
  if (!names.includes("manifest.json")) fail("final/prior-corpus-incomplete");
  // Keep ownership/digest evidence, not a copy of the prior corpus.
  let manifestBytes;
  for (const name of names) {
    const { bytes, ...snapshot } = await snapshotFile(join(path, name));
    stage.prior.set(name, snapshot);
    if (name === "manifest.json") manifestBytes = bytes;
  }
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); }
  catch { fail("final/prior-manifest-invalid"); }
  if (!Array.isArray(manifest?.clips)) fail("final/prior-manifest-invalid");
  const expected = new Set(["manifest.json", ...manifest.clips.map((clip) => clip?.file)]);
  if (expected.size !== names.length || names.some((name) => !expected.has(name))) fail("final/unexpected-entry");
  const inventory = {
    factsSha256: manifest.factsSha256, greetingSha256: manifest.greetingSha256, catalogSha256: manifest.catalogSha256,
    items: manifest.clips.map((clip) => ({ id: clip.id, textSha256: clip.textSha256 })),
  };
  await validateCorpus({ directory: path, manifest, inventory });
  return stage;
}

async function assertSnapshot(stage, name, snapshot) {
  await canonical(stage.path, "directory");
  const current = await snapshotFile(join(stage.path, name));
  if (!same(current.info, snapshot.info) || current.sha256 !== snapshot.sha256) fail("final/output-replaced");
}

/** Invalidate completion first, then unlink only individually verified generated files. */
export async function clearPriorCorpus(stage, validateIdentity) {
  await validateIdentity();
  const names = await readdir(stage.path);
  if (names.length !== stage.prior.size || names.some((name) => !stage.prior.has(name))) fail("final/unexpected-entry");
  for (const [name, snapshot] of stage.prior) await assertSnapshot(stage, name, snapshot);
  const ordered = ["manifest.json", ...[...stage.prior.keys()].filter((name) => name !== "manifest.json")];
  for (const name of ordered) {
    if (!stage.prior.has(name)) continue;
    await validateIdentity();
    await assertSnapshot(stage, name, stage.prior.get(name));
    await unlink(join(stage.path, name));
  }
}

/** Final-only manifest write, with no pending sibling or artifact relocation. */
export function writeFinalManifest(stage, identity, bytes) {
  const path = join(stage.path, "manifest.json");
  let fd;
  let owned;
  try {
    if (!same(lstatSync(stage.path), identity) || realpathSync(stage.path) !== stage.path) fail("final/output-replaced");
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    owned = fstatSync(fd);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    const current = lstatSync(path);
    if (!current.isFile() || current.nlink !== 1 || !same(current, owned) ||
        !same(lstatSync(stage.path), identity) || realpathSync(stage.path) !== stage.path) fail("final/output-replaced");
    closeSync(fd);
    fd = undefined;
    return owned;
  } catch (error) {
    if (owned && realpathSync(stage.path) === stage.path && same(lstatSync(stage.path), identity) &&
        same(lstatSync(path), owned)) unlinkSync(path);
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export async function removeFinalManifest(stage, identity, manifestIdentity) {
  if (!manifestIdentity) return;
  if (!same(await lstat(stage.path).catch(() => null), identity) ||
      await realpath(stage.path).catch(() => "") !== stage.path) return;
  const path = join(stage.path, "manifest.json");
  const current = await lstat(path).catch(() => null);
  if (current?.isFile() && !current.isSymbolicLink() && same(current, manifestIdentity)) await unlink(path);
}
