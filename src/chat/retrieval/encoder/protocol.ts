/**
 * The messages between the page and the embedding worker.
 *
 * The worker is the only place the embedding library exists, so this protocol is the
 * boundary: plain structured-cloneable data with no vendor object, no tokenizer output, no
 * tensor and no exception message crossing it. A failure crosses as this module's own
 * classified reason, so a vendor message cannot reach a log, a trace or the chat.
 *
 * Both directions are validated on arrival. The page never trusts a message it did not
 * shape, and a message that does not fit is dropped rather than partly used: a vector with
 * the wrong length or a non-finite entry would produce a score that looks valid and means
 * nothing.
 *
 * Nothing here can ask for a card vector. A request carries one trimmed question and
 * nothing else, because the vectors of the reviewed index are precomputed and stored.
 */
import { EXPECTED_EMBEDDING } from "../index.ts";
import { RetrievalError } from "../errors.ts";

/** Design decision 7: a query over the cap is refused, never truncated. */
export const TOKEN_CAP = 256;

/**
 * A transport guard, not a token limit. It stops an unbounded string from crossing into the
 * worker; the token cap is what actually refuses an oversized question.
 */
export const MAX_QUESTION_CHARS = 4096;

export type EncoderRequest =
  /** Ask for the pinned model. The worker does this lazily, so this is also the retry. */
  | { readonly type: "load" }
  | { readonly type: "embed"; readonly id: number; readonly question: string }
  /** Drop a queued question that a newer question has already replaced. */
  | { readonly type: "cancel"; readonly id: number };

export type EncoderResponse =
  /** Real download progress from the library, reduced to a file name and byte counts. */
  | {
      readonly type: "progress";
      readonly file: string;
      readonly loaded: number;
      readonly total: number;
      readonly percent: number;
    }
  | {
      readonly type: "ready";
      readonly dimensions: number;
      readonly loadMs: number;
      /** The library version that answered, the origin that served the bytes, the revision-literal path template, and the files it read. */
      readonly runtimeVersion: string;
      readonly remoteHost: string;
      readonly remotePathTemplate: string;
      readonly files: readonly string[];
    }
  | {
      readonly type: "vector";
      readonly id: number;
      readonly vector: readonly number[];
      readonly tokenCount: number;
      readonly durationMs: number;
    }
  | { readonly type: "cancelled"; readonly id: number }
  | { readonly type: "load-failed"; readonly reason: string }
  | { readonly type: "embed-failed"; readonly id: number; readonly reason: string };

const REASON = /^[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)*$/;
/** A package version, which carries dots and may start with a digit. */
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;
const MAX_FILE_NAME = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isReason(value: unknown): value is string {
  return typeof value === "string" && value.length <= 96 && REASON.test(value);
}

function isFileName(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_FILE_NAME && FILE_NAME.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * A returned query vector: finite, nonzero and exactly the recorded dimension.
 *
 * This is the same refusal the scorer makes, applied at the boundary, so a vector that
 * could not be compared honestly never reaches `rankCards`.
 *
 * @param value the raw vector from the worker
 * @param dimensions the pinned dimension
 * @returns a copy, so no worker-owned array is retained
 * @throws RetrievalError with a `query/...` reason
 */
export function verifyQueryVector(value: unknown, dimensions = EXPECTED_EMBEDDING.dimensions): number[] {
  if (!Array.isArray(value) || value.length !== dimensions) {
    throw new RetrievalError("query/vector-dimensions");
  }

  let squared = 0;
  const copy = Array.from({ length: dimensions }, () => 0);

  for (let index = 0; index < dimensions; index += 1) {
    const entry: unknown = value[index];

    if (!isFiniteNumber(entry)) throw new RetrievalError("query/vector-not-finite");

    copy[index] = entry;
    squared += entry * entry;
  }

  if (squared === 0) throw new RetrievalError("query/vector-zero");

  return copy;
}

/** @returns the request, or `null` when the value is not one this module is willing to send. */
export function readRequest(value: unknown): EncoderRequest | null {
  if (!isRecord(value)) return null;

  if (value.type === "load" && Object.keys(value).length === 1) return { type: "load" };

  if (
    value.type === "embed" &&
    Object.keys(value).length === 3 &&
    isRequestId(value.id) &&
    typeof value.question === "string" &&
    value.question.trim() !== "" &&
    value.question.length <= MAX_QUESTION_CHARS
  ) {
    return { type: "embed", id: value.id, question: value.question };
  }

  if (value.type === "cancel" && Object.keys(value).length === 2 && isRequestId(value.id)) {
    return { type: "cancel", id: value.id };
  }

  return null;
}

/** @returns the response, or `null` when the value is not one this module will act on. */
export function readResponse(value: unknown): EncoderResponse | null {
  if (!isRecord(value)) return null;

  switch (value.type) {
    case "progress": {
      if (
        Object.keys(value).length !== 5 ||
        !isFileName(value.file) ||
        !isNonNegativeInteger(value.loaded) ||
        !isNonNegativeInteger(value.total) ||
        !isFiniteNumber(value.percent) ||
        value.percent < 0 ||
        value.percent > 100
      ) {
        return null;
      }

      return {
        type: "progress",
        file: value.file,
        loaded: value.loaded,
        total: value.total,
        percent: value.percent,
      };
    }

    case "ready": {
      const files = value.files;

      if (
        Object.keys(value).length !== 7 ||
        value.dimensions !== EXPECTED_EMBEDDING.dimensions ||
        !isFiniteNumber(value.loadMs) ||
        typeof value.runtimeVersion !== "string" ||
        !VERSION.test(value.runtimeVersion) ||
        typeof value.remoteHost !== "string" ||
        value.remoteHost.length > 200 ||
        typeof value.remotePathTemplate !== "string" ||
        value.remotePathTemplate.length > 200 ||
        !Array.isArray(files) ||
        !files.every(isFileName)
      ) {
        return null;
      }

      return {
        type: "ready",
        dimensions: value.dimensions,
        loadMs: value.loadMs,
        runtimeVersion: value.runtimeVersion,
        remoteHost: value.remoteHost,
        remotePathTemplate: value.remotePathTemplate,
        files: [...files],
      };
    }

    case "vector": {
      if (Object.keys(value).length !== 5 || !isRequestId(value.id) || !isNonNegativeInteger(value.tokenCount) || !isFiniteNumber(value.durationMs)) {
        return null;
      }

      try {
        return {
          type: "vector",
          id: value.id,
          vector: verifyQueryVector(value.vector),
          tokenCount: value.tokenCount,
          durationMs: value.durationMs,
        };
      } catch {
        return null;
      }
    }

    case "cancelled": {
      if (Object.keys(value).length !== 2 || !isRequestId(value.id)) return null;
      return { type: "cancelled", id: value.id };
    }

    case "load-failed": {
      if (Object.keys(value).length !== 2 || !isReason(value.reason)) return null;
      return { type: "load-failed", reason: value.reason };
    }

    case "embed-failed": {
      if (Object.keys(value).length !== 3 || !isRequestId(value.id) || !isReason(value.reason)) return null;
      return { type: "embed-failed", id: value.id, reason: value.reason };
    }

    default:
      return null;
  }
}
