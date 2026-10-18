// Types for the sibling `.mjs` module, so the typechecked browser-free suite sees them.
import type { Artifact } from "./artifact.mjs";
import type { SourceUnit } from "./extract.mjs";
import type { SourceLocation } from "./paths.mjs";

export const ANALYSIS_FILE: string;
export const CANDIDATE_FILE: string;

export function scaffoldArtifact(options: {
  source: { relativePath: string; sha256: string };
  units: SourceUnit[];
}): Artifact;

export function prepareWorkspace(options: {
  source: SourceLocation;
  outDir: string;
  force?: boolean;
}): { analysisPath: string; candidatePath: string; units: number; omissions: number };
