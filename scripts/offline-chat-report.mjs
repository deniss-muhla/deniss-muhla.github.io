import { open, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";

export class ReportPathError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReportPathError";
    this.code = code;
  }
}

function isWithin(root, path) {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}

export async function validateReportDestination(reportPath, repoRoot) {
  if (typeof reportPath !== "string" || reportPath.trim() === "") {
    throw new ReportPathError("report-path-invalid");
  }

  let absolutePath;
  let canonicalRepoRoot;
  try {
    absolutePath = resolve(reportPath);
    canonicalRepoRoot = await realpath(repoRoot);
  } catch {
    throw new ReportPathError("report-path-invalid");
  }
  if (extname(absolutePath).toLowerCase() !== ".json") {
    throw new ReportPathError("report-path-must-be-json");
  }

  let canonicalParent;
  try {
    canonicalParent = await realpath(dirname(absolutePath));
  } catch {
    throw new ReportPathError("report-parent-missing");
  }
  let parentInfo;
  try {
    parentInfo = await stat(canonicalParent);
  } catch {
    throw new ReportPathError("report-parent-missing");
  }
  if (!parentInfo.isDirectory()) throw new ReportPathError("report-parent-not-directory");
  if (isWithin(canonicalRepoRoot, canonicalParent)) {
    throw new ReportPathError("report-parent-inside-repository");
  }

  return {
    path: join(canonicalParent, basename(absolutePath)),
    directory: canonicalParent,
    canonicalRepoRoot,
  };
}

export async function reserveNewReport(reportPath, repoRoot) {
  const destination = await validateReportDestination(reportPath, repoRoot);
  let handle;
  try {
    handle = await open(destination.path, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") throw new ReportPathError("report-target-not-fresh");
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      throw new ReportPathError("report-parent-missing");
    }
    throw new ReportPathError("report-target-reserve-failed");
  }

  try {
    await handle.chmod(0o600);
  } catch {
    await handle.close().catch(() => undefined);
    throw new ReportPathError("report-target-mode-failed");
  }
  return { ...destination, handle };
}
