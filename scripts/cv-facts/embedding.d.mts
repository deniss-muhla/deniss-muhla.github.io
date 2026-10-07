// Types for the sibling `.mjs` module, so the typechecked browser-free suite sees them.
import type { Artifact } from "./artifact.mjs";

export const MODEL_ID: string;
export const REVISION: string;
export const TOKEN_CAP: number;
export const ADAPTER_CONTRACT: Readonly<Record<string, string>>;

export class AdapterContractError extends Error {
  constructor(reason: string);
  readonly reason: string;
}

export interface PinnedWasm {
  wasmFile: string;
  factoryFile: string;
  wasmBytes: Uint8Array;
}

export interface PinnedDelivery {
  transformers: Record<string, any>;
  wasm: PinnedWasm;
  restored: { identityPreserved: boolean; descriptorRestored: boolean };
}

export function installedDistributionDirs(): { packageDir: string; ortDir: string };
export function loadPinnedWebDelivery(options: {
  packageDir: string;
  ortDir: string;
  contract?: Readonly<Record<string, string>>;
}): Promise<PinnedDelivery>;
export function configurePinnedEnvironment(options: {
  transformers: Record<string, any>;
  wasm: PinnedWasm;
  cacheDir?: string;
  remoteHost?: string;
}): { remoteHost: string; remotePathTemplate: string; cacheDir: string };
export function meanPoolAndNormalize(options: {
  dims: readonly number[];
  data: ArrayLike<number>;
  attentionMask: ArrayLike<number>;
  expectedDimensions: number;
}): { vector: Float32Array; pooledNorm: number; hiddenSize: number; tokenCount: number };
export function loadPinnedModel(options: { transformers: Record<string, any> }): Promise<{
  tokenizer: any;
  model: any;
}>;
export function embedCardVectors(options: {
  tokenizer: any;
  model: any;
  cards: { id: string; topic: string; tags: string[]; answer: string }[];
  expectedDimensions?: number;
}): Promise<{ vectors: Map<string, number[]>; dimensions: number; tokenCounts: Map<string, number> }>;
export function embedCandidate(
  artifact: unknown,
  options: { transformers: Record<string, any>; expectedDimensions?: number },
): Promise<Artifact>;
