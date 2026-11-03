#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `Read-only offline candidate check. No generation, model, install or publication.
Usage from the cv-update skill directory:
  node scripts/check-candidate.mjs --repo <absolute-checkout> --workspace <absolute-external-dir> --candidate <absolute-file>
  node scripts/check-candidate.mjs --help
The workspace must exist outside the checkout and not contain it.
The candidate must resolve inside that workspace. Child limit: 30 seconds.
A pass proves shape/provenance/identity only, not answer truth or source review.`;

class PreflightError extends Error {}
const fail = (label) => { throw new PreflightError(label); };
const contains = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

function parse(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return null;
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!["--repo", "--workspace", "--candidate"].includes(key)) fail("cli/unknown-option");
    if (Object.hasOwn(values, key)) fail("cli/duplicate-option");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) fail("cli/missing-value");
    if (!path.isAbsolute(value)) fail("path/absolute-required");
    values[key] = value;
  }
  if (Object.keys(values).length !== 3) fail("cli/required-inputs");
  return values;
}

function existing(input, kind, label) {
  try {
    const real = realpathSync(input);
    const stat = statSync(real);
    if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) fail(label);
    return real;
  } catch {
    fail(label);
  }
}

function run(args) {
  const options = parse(args);
  if (options === null) { console.log(HELP); return 0; }
  const repo = existing(options["--repo"], "directory", "path/repo-invalid");
  const bundledRepo = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.."));
  if (repo !== bundledRepo) fail("path/repo-mismatch");
  const workspace = existing(options["--workspace"], "directory", "path/workspace-invalid");
  if (contains(repo, workspace) || contains(workspace, repo)) fail("path/workspace-not-external");
  const candidate = existing(options["--candidate"], "file", "path/candidate-invalid");
  if (!contains(workspace, candidate)) fail("path/candidate-outside-workspace");
  const entry = existing(path.join(repo, "scripts/cv-facts.mjs"), "file", "path/check-entry-invalid");
  if (!contains(repo, entry)) fail("path/check-entry-invalid");

  // Only this existing offline mode may run; never forward arbitrary commands or raw output.
  const result = spawnSync(process.execPath, [entry, "check", "--candidate", candidate], {
    cwd: repo, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024,
  });
  if (result.error?.code === "ETIMEDOUT") fail("check/timeout");
  if (result.error || result.signal) fail("check/process-failed");
  if (result.status !== 0) {
    const labels = new Set();
    for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
      const match = line.match(/^\[cv\] (?:check: |cv-facts\/)([a-z][a-z0-9-]*\/[a-z][a-z0-9-]*)(?:\s|$)/);
      if (match) labels.add(`cv-facts/${match[1]}`);
    }
    for (const label of labels) console.error(`[cv-update] ${label}`);
    fail("check/rejected");
  }
  console.log("[cv-update] check/passed: shape, provenance and identity only; not truth or review");
  return 0;
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (error) {
  console.error(`[cv-update] ${error instanceof PreflightError ? error.message : "internal-failure"}`);
  process.exitCode = 1;
}
