import type { AudioSourceIdentity } from "../chat/answer-audio.ts";

declare const __CV_AUDIO_SOURCE_IDENTITY__: AudioSourceIdentity;

export type AudioCacheState =
  | "checking"
  | "waiting-control"
  | "downloading"
  | "ready"
  | "partial"
  | "skipped-save-data"
  | "offline"
  | "error"
  | "unsupported";

export type AudioCacheFailure =
  | "none"
  | "network"
  | "quota"
  | "invalid-manifest"
  | "identity-mismatch"
  | "invalid-clip"
  | "offline"
  | "save-data"
  | "cache-write"
  | "unknown";

export type AudioCacheProgress = Readonly<{
  state: AudioCacheState;
  verifiedClips: number;
  totalClips: number;
  verifiedBytes: number;
  totalBytes: number;
  manifestValid: boolean;
  manifestRetained: boolean;
  failureCategory: AudioCacheFailure;
  canRetry: boolean;
}>;

const STATES = new Set<AudioCacheState>([
  "checking", "waiting-control", "downloading", "ready", "partial", "skipped-save-data", "offline", "error", "unsupported",
]);
const FAILURES = new Set<AudioCacheFailure>([
  "none", "network", "quota", "invalid-manifest", "identity-mismatch", "invalid-clip", "offline", "save-data", "cache-write", "unknown",
]);
const MAX_CORPUS_BYTES = 20 * 1024 * 1024;
const MAX_CORPUS_CLIPS = 200;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDENTITY_KEYS = ["factsSha256", "greetingSha256", "catalogSha256"] as const;

export const INITIAL_AUDIO_CACHE_PROGRESS: AudioCacheProgress = Object.freeze({
  state: "checking",
  verifiedClips: 0,
  totalClips: 0,
  verifiedBytes: 0,
  totalBytes: 0,
  manifestValid: false,
  manifestRetained: false,
  failureCategory: "none",
  canRetry: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateAudioSourceIdentity(value: unknown): AudioSourceIdentity | null {
  if (!isRecord(value) || !hasExactKeys(value, IDENTITY_KEYS)) return null;
  if (IDENTITY_KEYS.some((key) => typeof value[key] !== "string" || (value[key] as string).length !== 64 || !SHA256_PATTERN.test(value[key] as string))) return null;
  return Object.freeze({
    factsSha256: value.factsSha256 as string,
    greetingSha256: value.greetingSha256 as string,
    catalogSha256: value.catalogSha256 as string,
  });
}

function configuredAudioSourceIdentity(): AudioSourceIdentity | null {
  if (typeof __CV_AUDIO_SOURCE_IDENTITY__ === "undefined") return null;
  return validateAudioSourceIdentity(__CV_AUDIO_SOURCE_IDENTITY__);
}

function sameAudioSourceIdentity(left: AudioSourceIdentity, right: AudioSourceIdentity): boolean {
  return IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

/** Accepts only the service worker's closed, content-free progress contract for this compiled corpus. */
export function parseAudioCacheProgress(value: unknown, expectedSource?: AudioSourceIdentity): AudioCacheProgress | null {
  const expectedIdentity = expectedSource === undefined
    ? configuredAudioSourceIdentity()
    : validateAudioSourceIdentity(expectedSource);
  if (!expectedIdentity || !isRecord(value) || value.type !== "CV_AUDIO_CACHE_STATUS") return null;
  const messageIdentity = validateAudioSourceIdentity(value.identity);
  if (!messageIdentity || !sameAudioSourceIdentity(messageIdentity, expectedIdentity)) return null;
  const expectedKeys = ["type", "identity", "state", "verifiedClips", "totalClips", "verifiedBytes", "totalBytes", "manifestValid", "manifestRetained", "failureCategory", "canRetry"];
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (actualKeys.length !== sortedExpectedKeys.length || !actualKeys.every((key, index) => key === sortedExpectedKeys[index])) return null;
  if (
    typeof value.state !== "string" || !STATES.has(value.state as AudioCacheState) ||
    !isCount(value.verifiedClips) || !isCount(value.totalClips) || value.totalClips > MAX_CORPUS_CLIPS || value.verifiedClips > value.totalClips ||
    !isCount(value.verifiedBytes) || !isCount(value.totalBytes) || value.verifiedBytes > value.totalBytes ||
    value.totalBytes > MAX_CORPUS_BYTES ||
    typeof value.manifestValid !== "boolean" || typeof value.manifestRetained !== "boolean" ||
    typeof value.failureCategory !== "string" || !FAILURES.has(value.failureCategory as AudioCacheFailure) ||
    typeof value.canRetry !== "boolean"
  ) return null;
  if (value.state === "ready" && (value.manifestValid !== true || value.manifestRetained !== true || value.totalClips === 0 || value.totalBytes === 0 || value.verifiedClips !== value.totalClips || value.verifiedBytes !== value.totalBytes)) return null;
  return Object.freeze({
    state: value.state as AudioCacheState,
    verifiedClips: value.verifiedClips,
    totalClips: value.totalClips,
    verifiedBytes: value.verifiedBytes,
    totalBytes: value.totalBytes,
    manifestValid: value.manifestValid,
    manifestRetained: value.manifestRetained,
    failureCategory: value.failureCategory as AudioCacheFailure,
    canRetry: value.canRetry,
  });
}

export function subscribeAudioCacheProgress(
  listener: (progress: AudioCacheProgress) => void,
  expectedSource?: AudioSourceIdentity,
): () => void {
  const expectedIdentity = expectedSource === undefined
    ? configuredAudioSourceIdentity()
    : validateAudioSourceIdentity(expectedSource);
  if (!("serviceWorker" in navigator) || !expectedIdentity) {
    listener(Object.freeze({ ...INITIAL_AUDIO_CACHE_PROGRESS, state: "unsupported" }));
    return () => undefined;
  }
  const onMessage = (event: MessageEvent<unknown>) => {
    const progress = parseAudioCacheProgress(event.data, expectedIdentity);
    if (progress) listener(progress);
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}

export function requestAudioCacheWarm(
  onUnavailable?: (state: "waiting-control" | "unsupported") => void,
  expectedSource?: AudioSourceIdentity,
): void {
  if (!("serviceWorker" in navigator)) {
    onUnavailable?.("unsupported");
    return;
  }
  const identity = expectedSource === undefined
    ? configuredAudioSourceIdentity()
    : validateAudioSourceIdentity(expectedSource);
  if (!identity) {
    onUnavailable?.("unsupported");
    return;
  }
  const worker = navigator.serviceWorker.controller;
  if (!worker) {
    onUnavailable?.("waiting-control");
    return;
  }
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  try {
    worker.postMessage({
      type: "CV_AUDIO_CACHE_WARM",
      online: navigator.onLine !== false,
      saveData: connection?.saveData === true,
      identity,
    });
  } catch {
    onUnavailable?.("unsupported");
  }
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function describeAudioCacheProgress(progress: AudioCacheProgress): string {
  const count = progress.totalClips > 0 ? `${progress.verifiedClips}/${progress.totalClips} clips` : "audio files";
  const bytes = progress.totalBytes > 0 ? ` · ${formatBytes(progress.verifiedBytes)} of ${formatBytes(progress.totalBytes)}` : "";
  switch (progress.state) {
    case "checking": return "Checking offline answer audio…";
    case "waiting-control": return "Waiting for service-worker control before saving answer audio. Text chat remains available.";
    case "downloading": return `Saving answer audio offline: ${count}${bytes}. Text chat remains available.`;
    case "ready": return `Answer audio ready offline: ${count}${bytes}.`;
    case "skipped-save-data": return `Data saver paused audio downloads (${count}${bytes}). Text chat remains available; turn off data saver and retry.`;
    case "offline": return `Offline audio is incomplete (${count}${bytes}). Text chat remains available; reconnect to continue.`;
    case "partial":
    case "error": return `Some answer audio could not be verified (${count}${bytes}). Text chat remains available; retry when online.`;
    case "unsupported": return "Offline audio caching is unavailable. Text chat remains available.";
  }
}
