// Types for the sibling `.mjs` module, so the typechecked browser-free suite sees them.
import type { Artifact } from "./artifact.mjs";
import type { ExtractionOmission, SourceUnit } from "./extract.mjs";
import type { SourceLocation } from "./paths.mjs";

export const ANALYSIS_FILE: string;
export const CANDIDATE_FILE: string;

export function scaffoldArtifact(options: {
  source: { relativePath: string; sha256: string };
  units: SourceUnit[];
}): Artifact;

export function prepareFinalArtifact(options: {
  source: SourceLocation;
  force?: boolean;
}): {
  artifactPath: string;
  mappings: { cardId: string; lines: { start: number; end: number } }[];
  omissions: ExtractionOmission[];
  coverage: Record<string, number>;
};

export function prepareWorkspace(options: {
  source: SourceLocation;
  outDir: string;
  force?: boolean;
}): { analysisPath: string; candidatePath: string; units: number; omissions: number };
