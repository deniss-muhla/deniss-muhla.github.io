/**
 * Repository paths, the external-workspace guard and source reading for `cv:facts`.
 *
 * Authoring intermediates, candidates and model caches are development data, not site
 * content, so every path taken from the command line is resolved through its real path
 * ancestors and refused when it lands inside this repository, including through a symlink
 * or a relative alias. `promote` is the only command that writes into the repository, and
 * only `resources/cv/facts.json`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { CvFactsError } from "./errors.mjs";

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The real path of this repository. Every containment decision compares against it. */
export const REPO_ROOT = fs.realpathSync(scriptsDir);

/** The canonical CV, spelled exactly as an artifact's `source.path` must spell it. */
export const SOURCE_RELATIVE_PATH = "resources/cv/source/cv.md";
export const SOURCE_PATH = path.join(REPO_ROOT, ...SOURCE_RELATIVE_PATH.split("/"));

/** The single derived artifact. Nothing writes it before `promote` validates a candidate. */
export const REVIEWED_ARTIFACT_PATH = path.join(REPO_ROOT, "resources", "cv", "facts.json");

/** Default model cache for `embed`. External by construction; `--cache` overrides it. */
export const DEFAULT_CACHE_DIR = path.join(fs.realpathSync(os.tmpdir()), "cv-facts-cache");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Resolves the deepest existing ancestor of `absolute` through `realpath` and reattaches
 * the segments below it. A path that does not exist yet still gets its existing prefix
 * resolved, so a symlinked ancestor cannot smuggle a repository path past the guard.
 */
function resolveThroughRealAncestors(absolute) {
  let current = absolute;

  for (;;) {
    if (fs.existsSync(current)) {
      const real = fs.realpathSync(current);
      const tail = path.relative(current, absolute);
      return tail ? path.join(real, tail) : real;
    }

    const parent = path.dirname(current);

    if (parent === current) return absolute;
    current = parent;
  }
}

function isInsideRepository(resolved) {
  return resolved === REPO_ROOT || resolved.startsWith(REPO_ROOT + path.sep);
}

/**
 * @param {string} input a path from the command line, absolute or relative to `cwd`
 * @param {{ option: string, expect?: "file" | "directory-target", cwd?: string }} options
 *   `expect: "file"` requires an existing regular file, which is what `--candidate` needs.
 *   `expect: "directory-target"` allows a directory that does not exist yet, which is what
 *   `--out` and `--cache` need.
 * @returns {string} the absolute real path, guaranteed outside the repository
 */
export function resolveExternalPath(input, { option, expect = "directory-target", cwd = process.cwd() }) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new CvFactsError("path/missing", { option });
  }

  const resolved = resolveThroughRealAncestors(path.resolve(cwd, input));

  if (isInsideRepository(resolved)) {
    throw new CvFactsError("path/inside-repository", { option });
  }

  if (expect === "file") {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new CvFactsError("path/not-a-file", { option });
    }
  } else if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
    throw new CvFactsError("path/not-a-directory", { option });
  }

  return resolved;
}

/**
 * Reads a CV source as raw bytes plus the two facts every command needs about it: the
 * digest those bytes hash to, and how many 1-based inclusive lines they contain. Line
 * counting never normalizes the text, so a CRLF source keeps one coordinate per line.
 *
 * @param {{ absolutePath: string, relativePath: string }} location
 */
export function readSource({ absolutePath, relativePath }) {
  const bytes = fs.readFileSync(absolutePath);
  const rawLines = bytes.toString("utf8").split("\n");

  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();

  return {
    relativePath,
    absolutePath,
    bytes,
    sha256: sha256(bytes),
    lineCount: rawLines.length,
  };
}

/** Reads the canonical CV. The artifact's `source` block must describe exactly this file. */
export function readCanonicalSource() {
  return readSource({ absolutePath: SOURCE_PATH, relativePath: SOURCE_RELATIVE_PATH });
}

/**
 * Writes through one sibling temporary file and one rename, so a reader never sees a partial
 * file and a failure leaves the previous contents in place. The temporary is this call's own
 * only once the exclusive open has succeeded: from that point a failure while writing, syncing,
 * closing or renaming removes it, so no half-written file holding authored content is left
 * behind. A temporary that already exists belongs to someone else, is never opened or written,
 * is never removed, and leaves the EEXIST failure for the caller to report.
 */
export function writeFileAtomic(file, contents) {
  const temporary = `${file}.${process.pid}.tmp`;
  let acquired = false;
  let renamed = false;

  try {
    const handle = fs.openSync(temporary, "wx");

    acquired = true;

    try {
      fs.writeFileSync(handle, contents);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }

    fs.renameSync(temporary, file);
    renamed = true;
  } finally {
    if (acquired && !renamed) fs.rmSync(temporary, { force: true });
  }
}

/** Canonical artifact text: two-space indent and a trailing newline, so reruns are byte-stable. */
export function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}