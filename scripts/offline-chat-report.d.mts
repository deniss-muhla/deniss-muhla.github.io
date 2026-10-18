import type { FileHandle } from "node:fs/promises";

export declare class ReportPathError extends Error {
  readonly code: string;
  constructor(code: string);
}

export interface ReportDestination {
  path: string;
  directory: string;
  canonicalRepoRoot: string;
}

export interface ReservedReport extends ReportDestination {
  handle: FileHandle;
}

export declare function validateReportDestination(
  reportPath: string,
  repoRoot: string,
): Promise<ReportDestination>;

export declare function reserveNewReport(
  reportPath: string,
  repoRoot: string,
): Promise<ReservedReport>;
