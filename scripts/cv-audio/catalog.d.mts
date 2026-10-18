import type { AudioCatalogErrorCode } from "../../src/chat/audio-catalog.ts";

export declare class AudioCatalogError extends Error {
  readonly code: AudioCatalogErrorCode;
  constructor(code: AudioCatalogErrorCode);
}

export type AudioSourceItemKind = "greeting" | "fact" | "topic" | "message";

export interface AudioSourceItem {
  readonly id: string;
  readonly kind: AudioSourceItemKind;
  readonly text: string;
  readonly textSha256: string;
}

export interface AudioSourceInventory {
  readonly factsSha256: string;
  readonly greetingSha256: string;
  readonly catalogSha256: string;
  readonly items: readonly AudioSourceItem[];
}

export interface EncodedAudioClip {
  id: string;
  file: string;
  bytes: number;
  durationSeconds: number;
  sha256: string;
}

export interface AudioManifestV2 {
  version: 2;
  factsSha256: string;
  greetingSha256: string;
  catalogSha256: string;
  clips: readonly (EncodedAudioClip & { textSha256: string })[];
}

export declare function createAudioSourceInventory(
  factsBytes: Uint8Array,
  greeting?: string,
): AudioSourceInventory;

export declare function createV2Manifest(
  inventory: AudioSourceInventory,
  clips: readonly EncodedAudioClip[],
): AudioManifestV2;

