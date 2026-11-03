import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { ReportPathError, reserveNewReport, validateReportDestination } from "../scripts/offline-chat-report.mjs";

function isWithin(root: string, path: string) {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}

async function withFixture(run: (paths: { root: string; repo: string; external: string }) => Promise<void>) {
  const [actualRepoRoot, canonicalTempRoot] = await Promise.all([
    realpath(fileURLToPath(new URL("..", import.meta.url))),
    realpath(tmpdir()),
  ]);
  assert.equal(isWithin(actualRepoRoot, canonicalTempRoot), false, "canonical temp directory must be outside the actual repository");
  const root = await mkdtemp(join(canonicalTempRoot, "offline-chat-report-test-"));
  const repo = join(root, "repository");
  const external = join(root, "external");
  await mkdir(repo);
  await mkdir(external);
  try {
    await run({ root, repo, external });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function expectReportError(operation: Promise<unknown>, code: string) {
  await assert.rejects(operation, (error: unknown) =>
    error instanceof ReportPathError && error.code === code,
  );
}

test("report destination rejects a parent inside the repository", async () => {
  await withFixture(async ({ repo }) => {
    await expectReportError(
      validateReportDestination(join(repo, "report.json"), repo),
      "report-parent-inside-repository",
    );
  });
});

test("report destination resolves a parent symlink before enforcing repository separation", async () => {
  await withFixture(async ({ root, repo }) => {
    const parentLink = join(root, "repository-link");
    await symlink(repo, parentLink, "dir");
    await expectReportError(
      validateReportDestination(join(parentLink, "report.json"), repo),
      "report-parent-inside-repository",
    );
  });
});

test("report destination rejects a missing parent without creating it", async () => {
  await withFixture(async ({ external, repo }) => {
    const missingParent = join(external, "not-created");
    await expectReportError(
      validateReportDestination(join(missingParent, "report.json"), repo),
      "report-parent-missing",
    );
    await assert.rejects(lstat(missingParent), { code: "ENOENT" });
  });
});

test("report preflight validates the parent without creating or opening the report", async () => {
  await withFixture(async ({ external, repo }) => {
    const reportPath = join(external, "fresh-report.json");
    const destination = await validateReportDestination(reportPath, repo);
    assert.equal(destination.directory, await realpath(external));
    assert.equal(destination.path, reportPath);
    await assert.rejects(lstat(reportPath), { code: "ENOENT" });
  });
});

test("new report reservation is exclusive, private, and writable through its retained handle", async () => {
  await withFixture(async ({ external, repo }) => {
    const reportPath = join(external, "fresh-report.json");
    const reservation = await reserveNewReport(reportPath, repo);
    try {
      assert.equal(reservation.path, reportPath);
      assert.equal((await lstat(reportPath)).mode & 0o777, 0o600);
      await reservation.handle.writeFile('{"result":"safe"}\n', "utf8");
    } finally {
      await reservation.handle.close();
    }
    assert.equal(await readFile(reportPath, "utf8"), '{"result":"safe"}\n');
  });
});

test("existing regular files, symlinks, and hardlinks are refused without modification", async () => {
  await withFixture(async ({ external, repo }) => {
    const content = "fixture marker\n";
    const regularFile = join(external, "existing.json");
    await writeFile(regularFile, content);
    await expectReportError(reserveNewReport(regularFile, repo), "report-target-not-fresh");
    assert.equal(await readFile(regularFile, "utf8"), content);

    const target = join(external, "link-target.json");
    await writeFile(target, content);
    const symbolicLink = join(external, "symbolic-link.json");
    await symlink(target, symbolicLink);
    await expectReportError(reserveNewReport(symbolicLink, repo), "report-target-not-fresh");
    assert.equal(await readFile(target, "utf8"), content);
    assert.equal((await lstat(symbolicLink)).isSymbolicLink(), true);

    const hardLink = join(external, "hard-link.json");
    await link(target, hardLink);
    await expectReportError(reserveNewReport(hardLink, repo), "report-target-not-fresh");
    assert.equal(await readFile(target, "utf8"), content);
    assert.equal(await readFile(hardLink, "utf8"), content);
  });
});
