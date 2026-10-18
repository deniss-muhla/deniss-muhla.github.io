// Types for the sibling `.mjs` module, so the typechecked browser-free suite sees them.
import type { Finding, ValidationContext } from "./artifact.mjs";

export const PROMOTION_ACKNOWLEDGMENT: string;

export function readArtifactFile(file: string, options: { stage: string }): unknown;

export function promoteArtifact(options: {
  artifact: unknown;
  reviewedPath: string;
  context: ValidationContext;
}): { findings: Finding[]; replaced: boolean; bytes: number };
