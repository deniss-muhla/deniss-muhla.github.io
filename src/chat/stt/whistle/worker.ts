/**
 * The Whistle speech engine's worker: the one module that reaches the vendor `ccall`
 * surface, so the marshalling lives here and nowhere else.
 *
 * This classic worker must avoid runtime module syntax because it loads the pinned Emscripten
 * runtime with `importScripts`, which module workers do not have. The runtime bytes, the wasm and
 * the model are all read through this project's own Cache Storage cache first, so a load
 * works offline; a network read streams and reports the real byte counts. `needle_load`
 * reads the model while its buffer is allocated, every `malloc` is freed in the same call,
 * and the JSON out buffer is read before it is freed.
 *
 * Replies carry the engine's own result text; the vendor error string only ever travels as
 * `detail`, for the page's `?voiceDebug=1` trace.
 */
type SttRequest = import("./protocol.ts").SttRequest;
type SttResponse = import("./protocol.ts").SttResponse;

/** The worker global, described by this module instead of by a WebWorker lib the app does not load. */
interface WorkerScope {
  postMessage(message: SttResponse): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

/** Where the three pinned files are cached for offline reloads. Outside the service worker's cache family. */
const NEEDLE_CACHE = "needle-models-v1";

/** Capacity of the JSON out buffers; the engine's per-chunk result is far below it. */
const OUT_CAP = 1 << 16;

const port = self as unknown as WorkerScope;

let needle: NeedleModule | null = null;
let streamOpen = false;
let language = "";
let keywords = "";

function send(message: SttResponse): void {
  port.postMessage(message);
}

function reasonOf(error: unknown): string {
  return String((error as { message?: unknown } | null)?.message ?? error);
}

function lastError(): string {
  if (needle === null) return "engine not loaded";
  try {
    return needle.ccall("needle_last_error", "string", [], []) as string;
  } catch (error) {
    return `needle_last_error failed: ${reasonOf(error)}`;
  }
}

function malloc(bytes: number): number {
  const pointer = needle?._malloc(bytes) ?? 0;
  if (!pointer) throw new Error(`malloc failed for ${bytes} bytes`);
  return pointer;
}

/** `needle_load` takes `unsigned long long`, so the wasm export wants a BigInt. */
function loadModel(model: Uint8Array): number {
  if (needle === null) throw new Error("engine not loaded");
  const pointer = malloc(model.length);
  try {
    needle.HEAPU8.set(model, pointer);
    try {
      return needle.ccall("needle_load", "number", ["number", "number"], [
        pointer,
        BigInt(model.length),
      ]) as number;
    } catch (error) {
      if (error instanceof TypeError) {
        return needle.ccall("needle_load", "number", ["number", "number"], [
          pointer,
          model.length,
        ]) as number;
      }
      throw error;
    }
  } finally {
    needle._free(pointer);
  }
}

/** Reads one pinned file from this project's cache, or streams it in and caches the bytes. */
async function readAsset(
  url: string,
  file: "runtime" | "wasm" | "model",
): Promise<Uint8Array<ArrayBuffer>> {
  const cache = await caches.open(NEEDLE_CACHE);
  const cached = await cache.match(url);
  if (cached) {
    const bytes = new Uint8Array(await cached.arrayBuffer());
    send({ type: "progress", file, loaded: bytes.length, total: bytes.length });
    return bytes;
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`http ${response.status}`);

  const announced = Number(response.headers.get("content-length") ?? 0);
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    send({ type: "progress", file, loaded: bytes.length, total: bytes.length });
    return bytes;
  }

  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    parts.push(value);
    loaded += value.length;
    send({ type: "progress", file, loaded, total: announced || loaded });
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }

  await cache.put(
    url,
    new Response(bytes, {
      headers: { "content-type": response.headers.get("content-type") ?? "application/octet-stream" },
    }),
  );
  return bytes;
}

async function load(message: Extract<SttRequest, { type: "load" }>): Promise<void> {
  const startedAt = performance.now();
  language = message.language;
  keywords = message.keywords;

  let runtime: Uint8Array<ArrayBuffer>;
  let wasm: Uint8Array<ArrayBuffer>;
  let model: Uint8Array<ArrayBuffer>;
  try {
    [runtime, wasm, model] = await Promise.all([
      readAsset(message.runtimeUrl, "runtime"),
      readAsset(message.wasmUrl, "wasm"),
      readAsset(message.modelUrl, "model"),
    ]);
  } catch (error) {
    send({ type: "error", code: "runtime-load-failed", detail: reasonOf(error) });
    return;
  }

  try {
    const runtimeUrl = URL.createObjectURL(new Blob([runtime], { type: "text/javascript" }));
    try {
      importScripts(runtimeUrl);
    } finally {
      URL.revokeObjectURL(runtimeUrl);
    }
    needle = await createNeedle({ wasmBinary: wasm });
  } catch (error) {
    send({ type: "error", code: "runtime-load-failed", detail: reasonOf(error) });
    return;
  }

  try {
    const result = loadModel(model);
    // Only negative values signal failure in the pinned C API.
    if (result < 0) {
      send({ type: "error", code: "model-load-failed", detail: lastError() });
      return;
    }
  } catch (error) {
    send({ type: "error", code: "model-load-failed", detail: reasonOf(error) });
    return;
  }

  send({ type: "ready", loadMs: Math.round(performance.now() - startedAt) });
}

/** Ends a stream the engine still holds, without reporting its output: `start` needs a clean stream. */
function resetStream(): void {
  if (needle === null || !streamOpen) return;
  const pointer = malloc(OUT_CAP);
  try {
    needle.ccall("needle_stream_transcribe_stop", "number", ["number", "number"], [
      pointer,
      OUT_CAP,
    ]);
  } finally {
    needle._free(pointer);
    streamOpen = false;
  }
}

function processChunk(samples: Float32Array): void {
  if (needle === null) {
    send({ type: "error", code: "transcribe-failed", detail: "engine not loaded" });
    return;
  }

  const pcm = malloc(samples.byteLength);
  const out = malloc(OUT_CAP);
  try {
    needle.HEAPU8.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), pcm);
    const words = needle.ccall(
      "needle_stream_transcribe_process",
      "number",
      ["number", "number", "string", "string", "number", "number"],
      [pcm, samples.length, language || null, keywords || null, out, OUT_CAP],
    ) as number;
    // The out buffer is only meaningful on success, so the code is read first.
    const json = needle.UTF8ToString(out);
    if (words < 0) {
      send({ type: "error", code: "transcribe-failed", detail: lastError() });
      return;
    }
    streamOpen = true;
    send({ type: "result", json });
  } catch (error) {
    send({ type: "error", code: "transcribe-failed", detail: reasonOf(error) });
  } finally {
    needle._free(pcm);
    needle._free(out);
  }
}

function stopStream(): void {
  if (needle === null || !streamOpen) {
    send({ type: "stopped", json: "" });
    return;
  }

  const out = malloc(OUT_CAP);
  try {
    needle.ccall("needle_stream_transcribe_stop", "number", ["number", "number"], [out, OUT_CAP]);
    const json = needle.UTF8ToString(out);
    streamOpen = false;
    send({ type: "stopped", json });
  } catch (error) {
    streamOpen = false;
    send({ type: "error", code: "stream-stop-failed", detail: reasonOf(error) });
  } finally {
    needle._free(out);
  }
}

async function handle(message: SttRequest): Promise<void> {
  switch (message?.type) {
    case "load":
      await load(message);
      return;
    case "start":
      resetStream();
      return;
    case "chunk":
      processChunk(message.samples);
      return;
    case "stop":
      stopStream();
      return;
    default:
      send({ type: "error", code: "transcribe-failed", detail: "unknown request" });
  }
}

port.addEventListener("message", (event) => {
  const message = event.data as SttRequest;
  if (typeof message?.type !== "string") return;
  void handle(message);
});
