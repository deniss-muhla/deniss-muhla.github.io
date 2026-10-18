/**
 * The message contract between the Whistle adapter's host side and its worker.
 *
 * The worker is the only module that reaches the vendor `ccall` surface, and this file is
 * the only place the shape of that exchange is written down: host requests, worker
 * responses, the committed-delta JSON the engine returns per chunk, and the error codes
 * the chat is allowed to see. Vendor strings (`needle_last_error()`) travel as `detail`
 * for the `?voiceDebug=1` trace and never reach a rendered notice.
 */

/** One committed-delta result of `needle_stream_transcribe_process`, read as JSON. */
export interface WhistleStreamJson {
  /** The words this call committed (a delta, not the whole transcript). */
  text?: string;
  /** The unconfirmed tail after the committed delta. */
  pending?: string;
  /** Audio the engine has buffered, in seconds. */
  received?: number;
  /** Cost of this pass, in milliseconds. */
  pass_ms?: number;
}

/** What the chat may show when speech recognition fails. Codes, never vendor text. */
export type SttErrorCode =
  | "runtime-load-failed"
  | "model-load-failed"
  | "capture-failed"
  | "transcribe-failed"
  | "stream-stop-failed"
  | "worker-failed";

/** The one message each code produces, phrased for the visitor. */
export const STT_ERROR_MESSAGES: Record<SttErrorCode, string> = {
  "runtime-load-failed": "Speech recognition could not start: the local runtime failed to load.",
  "model-load-failed": "Speech recognition could not start: the local speech model failed to load.",
  "capture-failed": "The microphone could not be opened.",
  "transcribe-failed": "Speech recognition stopped: transcription failed.",
  "stream-stop-failed": "Speech recognition could not finish the current phrase.",
  "worker-failed": "Speech recognition stopped unexpectedly.",
};

/** What the host sends the worker. */
export type SttRequest =
  | {
      type: "load";
      /** Same-origin route of the vendor runtime script. */
      runtimeUrl: string;
      /** Same-origin route of the vendor wasm. */
      wasmUrl: string;
      /** Same-origin route of the speech model. */
      modelUrl: string;
      language: string;
      /** Newline-separated biasing terms; the empty string means none. */
      keywords: string;
    }
  | { type: "start" }
  | { type: "chunk"; samples: Float32Array }
  | { type: "stop" };

/** What the worker sends back. `json` is the engine's own result text, still a string. */
export type SttResponse =
  | { type: "progress"; file: "runtime" | "wasm" | "model"; loaded: number; total: number }
  | { type: "ready"; loadMs: number }
  | { type: "result"; json: string }
  | { type: "stopped"; json: string }
  | { type: "error"; code: SttErrorCode; detail: string };

/** Narrow check on a message that crossed the worker boundary before it is acted on. */
export function readSttResponse(value: unknown): SttResponse | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as Partial<SttResponse>;

  switch (message.type) {
    case "progress":
      return typeof message.file === "string" &&
        typeof message.loaded === "number" &&
        typeof message.total === "number"
        ? (message as SttResponse)
        : null;
    case "ready":
      return typeof message.loadMs === "number" ? (message as SttResponse) : null;
    case "result":
    case "stopped":
      return typeof message.json === "string" ? (message as SttResponse) : null;
    case "error":
      return typeof message.code === "string" && typeof message.detail === "string"
        ? (message as SttResponse)
        : null;
    default:
      return null;
  }
}

/** Parses one engine result; a malformed body yields `null` rather than a thrown error. */
export function readStreamJson(json: string): WhistleStreamJson | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? (parsed as WhistleStreamJson) : null;
  } catch {
    return null;
  }
}
