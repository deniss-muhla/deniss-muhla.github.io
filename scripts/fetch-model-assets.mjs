#!/usr/bin/env node
/**
 * Download the pinned model and font assets into the external cache, verifying every
 * file against `model-assets.mjs`.
 *
 * Usage:
 *   node scripts/fetch-model-assets.mjs              # all sets
 *   node scripts/fetch-model-assets.mjs --set <id>   # one vendor set (sample first)
 *   node scripts/fetch-model-assets.mjs --record     # bootstrap: accept files whose
 *                                                    # digest is not pinned yet and write
 *                                                    # the digest table next to them
 *
 * The cache is `~/.cache/cv-assistant/model-assets/<id>/<rev>/` (see MODEL_ASSETS_CACHE),
 * outside the repository. Runs are idempotent: a cached file whose sha256 matches the pin
 * is never re-downloaded. A cached file whose digest does not match is reported and left
 * in place, never silently replaced, and a failed download is never retried in the same
 * run. Each file gets one bounded request (FILE_TIMEOUT_MS, default 10 minutes).
 *
 * The accepted probe workspace's Hugging Face mirror seeds the embedding set when its
 * bytes match the pinned digests, so a warm probe cache needs no network at all.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

import { MODEL_ASSETS_CACHE, MODEL_ASSETS_SEED_DIR, MODEL_ASSET_SETS } from "./model-assets.mjs";

const FILE_TIMEOUT_MS = Number(process.env.FILE_TIMEOUT_MS ?? 600_000);

function parseArgs(argv) {
  const options = { record: false, setId: null };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--record") options.record = true;
    else if (arg === "--set") {
      options.setId = argv[i + 1] ?? null;
      i += 1;
    }
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  return options;
}

/** The probe workspace mirror path for the one set it holds, or null for the others. */
function seedCandidate(setId, rev, name) {
  if (setId !== "mxbai-embed-xsmall-v1") return null;
  return join(
    MODEL_ASSETS_SEED_DIR,
    "cache",
    "hf-assets",
    "mixedbread-ai",
    "mxbai-embed-xsmall-v1",
    "resolve",
    rev,
    name,
  );
}

async function digestOf(path) {
  const bytes = await readFile(path);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

class AssetError extends Error {}

async function download(source, dest) {
  const response = await fetch(source, { redirect: "follow", signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });

  if (!response.ok) {
    throw new AssetError(`http ${response.status}`);
  }
  if (response.body === null) {
    throw new AssetError("empty body");
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const part = `${dest}.part`;
  await writeFile(part, bytes);
  await rename(part, dest);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function ensureFile(set, file, record) {
  const dest = join(MODEL_ASSETS_CACHE, set.id, set.rev, file.name);

  if (file.sha256 === null && !record) {
    throw new AssetError("digest not pinned (run --record once, then pin the manifest)");
  }

  await mkdir(dirname(dest), { recursive: true });

  if (existsSync(dest)) {
    const actual = await digestOf(dest);
    if (file.sha256 !== null && (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes)) {
      throw new AssetError(`cache digest mismatch (have ${actual.sha256}, pinned ${file.sha256})`);
    }
    return { actual, from: "cache" };
  }

  const seed = seedCandidate(set.id, set.rev, file.name);
  if (seed !== null && existsSync(seed)) {
    const actual = await digestOf(seed);
    if (file.sha256 !== null && actual.sha256 === file.sha256 && actual.bytes === file.bytes) {
      await copyFile(seed, dest);
      return { actual, from: "seed" };
    }
  }

  // A file may carry its own absolute source (the gstatic font paths); otherwise the
  // set's base plus the pinned name is the URL.
  const source = file.source ?? `${set.source}/${file.name}`;

  let actual;
  try {
    actual = await download(source, dest);
  } catch (error) {
    await unlink(`${dest}.part`).catch(() => undefined);
    throw new AssetError(`download failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (file.sha256 !== null && (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes)) {
    await unlink(dest).catch(() => undefined);
    throw new AssetError(`downloaded digest mismatch (have ${actual.sha256}, pinned ${file.sha256})`);
  }

  return { actual, from: "network" };
}

async function runSet(set, options, failures) {
  const recordPath = join(MODEL_ASSETS_CACHE, set.id, set.rev, "record.json");
  const recorded = {};
  let cached = 0;
  let seeded = 0;
  let fetched = 0;
  let totalBytes = 0;

  for (const file of set.files) {
    try {
      const { actual, from } = await ensureFile(set, file, options.record);
      if (from === "cache") cached += 1;
      if (from === "seed") seeded += 1;
      if (from === "network") fetched += 1;
      totalBytes += actual.bytes;
      if (file.sha256 === null) recorded[file.name] = actual;
      console.log(`ok ${set.id}/${file.name} ${actual.bytes} ${from}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${set.id}/${file.name}: ${message}`);
      console.error(`FAIL ${set.id}/${file.name} ${message}`);
    }
  }

  if (options.record && Object.keys(recorded).length > 0) {
    await writeFile(recordPath, `${JSON.stringify(recorded, null, 2)}\n`);
    console.log(`recorded ${Object.keys(recorded).length} digests -> ${recordPath}`);
  }

  console.log(
    `set ${set.id}: ${set.files.length} files, ${totalBytes} bytes (cache ${cached}, seed ${seeded}, network ${fetched})`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sets =
    options.setId === null
      ? MODEL_ASSET_SETS
      : MODEL_ASSET_SETS.filter((set) => set.id === options.setId);

  if (sets.length === 0) {
    console.error(`unknown set: ${options.setId}`);
    process.exit(2);
  }

  const failures = [];

  for (const set of sets) {
    await runSet(set, options, failures);
  }

  if (failures.length > 0) {
    console.error(`${failures.length} file(s) failed:`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }

  console.log("all assets verified");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
