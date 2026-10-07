// Types for the sibling `.mjs` module, so the typechecked browser-free suite sees them.
export const ARTIFACT_VERSION: number;
export const INPUT_VERSION: string;
export const VECTOR_DECIMALS: number;
export const CHECK_SCOPE_NOTE: string;

export const PINNED_EMBEDDING: Readonly<{
  model: string;
  revision: string;
  dtype: string;
  runtimeVersion: string;
  pooling: string;
  normalize: boolean;
  dimensions: number;
  inputVersion: string;
}>;

export interface ArtifactCard {
  id: string;
  topic: string;
  tags: string[];
  sourceRefs: { startLine: number; endLine: number }[];
  answer: string;
  vector: number[];
}

export interface Artifact {
  version: number;
  source: { path: string; sha256: string };
  embedding: Record<string, unknown>;
  cards: ArtifactCard[];
}

export interface Finding {
  rule: string;
  card: string | null;
  cardId: string | null;
  coordinates: string | null;
}

export interface ValidationContext {
  sourceRelativePath: string;
  sourceSha256: string;
  sourceLineCount: number;
  expectedIdentity?: Record<string, unknown>;
}

export function retrievalText(card: { topic: string; tags: string[]; answer: string }): string;
export function contentSha256(cards: ArtifactCard[]): string;
export function emptyEmbeddingIdentity(): Record<string, unknown>;
export function validateArtifact(
  artifact: unknown,
  context: ValidationContext,
): { findings: Finding[]; cardCount: number };
export function describeFinding(finding: Finding): string;
