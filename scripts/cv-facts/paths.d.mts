// Types for the sibling `.mjs` module, so the typechecked browser-free suite sees them.
export const REPO_ROOT: string;
export const SOURCE_RELATIVE_PATH: string;
export const SOURCE_PATH: string;
export const REVIEWED_ARTIFACT_PATH: string;
export const DEFAULT_CACHE_DIR: string;

export interface SourceLocation {
  relativePath: string;
  absolutePath: string;
  bytes: Buffer;
  sha256: string;
  lineCount: number;
}

export function sha256(bytes: Uint8Array | string): string;
export function resolveExternalPath(
  input: string,
  options: { option: string; expect?: "file" | "directory-target"; cwd?: string },
): string;
export function readSource(location: { absolutePath: string; relativePath: string }): SourceLocation;
export function readCanonicalSource(): SourceLocation;
export function writeFileAtomic(file: string, contents: string | Uint8Array): void;
export function serializeJson(value: unknown): string;
