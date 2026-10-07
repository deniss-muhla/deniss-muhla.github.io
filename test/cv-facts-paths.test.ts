import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CvFactsError } from "../scripts/cv-facts/errors.mjs";
import { REPO_ROOT, resolveExternalPath } from "../scripts/cv-facts/paths.mjs";

const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cv-facts-guard-"));

// The aliases exist before any test runs, so no test depends on another test's side effect.
const aliasDirectory = path.join(workspace, "alias");
const alias = path.join(aliasDirectory, "resources");
const fileAlias = path.join(aliasDirectory, "manifest.json");
const deepAliasDirectory = path.join(workspace, "deep");
const repositoryAlias = path.join(deepAliasDirectory, "repo");
const preparedDirectory = path.join(workspace, "prepared");
const preparedFile = path.join(preparedDirectory, "facts.candidate.json");

fs.mkdirSync(aliasDirectory, { recursive: true });
fs.symlinkSync(path.join(REPO_ROOT, "resources"), alias, "dir");
fs.symlinkSync(path.join(REPO_ROOT, "package.json"), fileAlias);
fs.mkdirSync(deepAliasDirectory, { recursive: true });
fs.symlinkSync(REPO_ROOT, repositoryAlias, "dir");
fs.mkdirSync(preparedDirectory, { recursive: true });
fs.writeFileSync(preparedFile, "{}\n");

test.after(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function refuses(input: string, reason: string, options: Record<string, unknown> = {}) {
  assert.throws(
    () => resolveExternalPath(input, { option: "--out", expect: "directory-target", ...options }),
    (error: unknown) => error instanceof CvFactsError && error.reason === reason,
    `expected ${input} to be refused as ${reason}`,
  );
}

test("the guard refuses a path inside the repository", () => {
  refuses(path.join(REPO_ROOT, "resources", "cv"), "path/inside-repository");
  refuses(path.join(REPO_ROOT, "resources", "cv", "facts.json"), "path/inside-repository");
  refuses(REPO_ROOT, "path/inside-repository");
});

test("the guard refuses a relative path that resolves inside the repository", () => {
  refuses("resources/cv", "path/inside-repository", { cwd: REPO_ROOT });
  refuses("./resources/cv/../cv", "path/inside-repository", { cwd: REPO_ROOT });
});

test("the guard refuses a repository path reached through an external symlink alias", () => {
  // The alias itself sits outside the repository, so only resolving its real ancestors can
  // reveal that the target is inside.
  refuses(path.join(alias, "cv"), "path/inside-repository");
  refuses(path.join(aliasDirectory, "resources", "cv", "facts.json"), "path/inside-repository");
  refuses(path.join(alias, "..", "resources", "cv"), "path/inside-repository");
  refuses(path.join(deepAliasDirectory, "repo", "src", "chat"), "path/inside-repository");
});

test("the guard refuses an existing file symlinked from outside into the repository", () => {
  assert.throws(
    () => resolveExternalPath(fileAlias, { option: "--candidate", expect: "file" }),
    (error: unknown) => error instanceof CvFactsError && error.reason === "path/inside-repository",
  );
});

test("the guard accepts an external directory, an external file and a relative external path", () => {
  assert.equal(resolveExternalPath(preparedDirectory, { option: "--out" }), preparedDirectory);
  assert.equal(resolveExternalPath(preparedFile, { option: "--candidate", expect: "file" }), preparedFile);
  assert.equal(resolveExternalPath("prepared", { option: "--out", cwd: workspace }), preparedDirectory);
});

test("the guard accepts an external directory that does not exist yet", () => {
  const missing = path.join(workspace, "not-created-yet");

  assert.equal(resolveExternalPath(missing, { option: "--out" }), missing);
  assert.equal(fs.existsSync(missing), false);
});

test("the guard refuses a missing value and a file where a directory is required", () => {
  refuses("", "path/missing");
  refuses("   ", "path/missing");
  refuses(preparedFile, "path/not-a-directory");
  assert.throws(
    () => resolveExternalPath(path.join(workspace, "missing.json"), { option: "--candidate", expect: "file" }),
    (error: unknown) => error instanceof CvFactsError && error.reason === "path/not-a-file",
  );
});