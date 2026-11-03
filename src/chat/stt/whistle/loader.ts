/**
 * The host side of the Whistle session: the worker handle, the load and its real download
 * progress, and the routing of worker replies to the adapter.
 *
 * The worker owns the vendor marshalling; this module owns only what the page needs: a
 * load promise that resolves when the model is in, byte-accurate progress from the fetch
 * streams, a way to hand over one-second pieces, the stop that resets the engine's stream,
 * and errors that carry a safe message while the vendor string stays in the detail for the
 * `?voiceDebug=1` trace.
 *
 * Construction is free: no worker exists until `load` is called, which is what lets a
 * metered session decide not to load at all.
 */
import {
  STT_ERROR_MESSAGES,
  readSttResponse,
  type SttErrorCode,
  type SttRequest,
} from "./protocol.ts";
import {
  WHISTLE_DOWNLOAD_TOTAL,
  WHISTLE_KEYWORDS,
  WHISTLE_LANGUAGE,
  WHISTLE_MODEL_ROUTE,
  WHISTLE_RUNTIME_ROUTE,
  WHISTLE_WASM_ROUTE,
} from "./assets.ts";

/** The worker surface this module needs. A real worker and a test double both satisfy it. */
export interface SttWorker {
  postMessage(message: SttRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onMessage(listener: (value: unknown) => void): void;
  onFailure(listener: () => void): void;
}

export type SttWorkerFactory = () => SttWorker;

export interface SttSessionOptions {
  /** Overridden by the browser-free suite with a double; the default creates the real worker. */
  readonly workerFactory?: SttWorkerFactory;
  /** Real download progress as a fraction of everything the load fetches. */
  readonly onProgress?: (fraction: number) => void;
  /** The engine's own JSON result text for one processed piece. */
  readonly onResult?: (json: string) => void;
  /** The flushed tail; the adapter publishes it for an audio pause, but discards it on close. */
  readonly onStopped?: (json: string) => void;
  /** A failure with its safe message; `detail` is the vendor string for the debug trace. */
  readonly onError?: (error: Error, detail: string) => void;
}

export interface SttSession {
  /** Downloads the runtime and model and loads them into the engine. Later calls share the load. */
  load(): Promise<void>;
  /** Resets any stream the engine still holds, so the first piece starts a new one. */
  start(): void;
  /** Hands one 16 kHz mono piece to the engine. */
  sendChunk(samples: Float32Array): void;
  /** Ends the stream and resolves after its stop response or a worker failure. */
  stop(): Promise<void>;
}

/** The default worker: one classic worker, so transcription never blocks the page. */
export function createSttWorker(): SttWorker {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "classic",
    name: "whistle-stt",
  });

  return {
    postMessage(message, transfer) {
      if (transfer === undefined) worker.postMessage(message);
      else worker.postMessage(message, transfer);
    },
    terminate() {
      worker.terminate();
    },
    onMessage(listener) {
      worker.addEventListener("message", (event: MessageEvent) => listener(event.data));
    },
    onFailure(listener) {
      worker.addEventListener("error", () => listener());
    },
  };
}

export function createSttSession(options: SttSessionOptions = {}): SttSession {
  const factory = options.workerFactory ?? createSttWorker;

  let worker: SttWorker | null = null;
  let status: "idle" | "loading" | "ready" | "failed" = "idle";
  let loadPromise: Promise<void> | null = null;
  let settleLoad: { resolve(): void; reject(error: Error): void } | null = null;
  let settleStop: (() => void) | null = null;
  let stopPromise: Promise<void> | null = null;
  /** The highest byte count seen per file: the worker reports cumulative loads. */
  const loadedByFile = { runtime: 0, wasm: 0, model: 0 };

  function asError(code: SttErrorCode): Error {
    return new Error(STT_ERROR_MESSAGES[code]);
  }

  function failLoad(error: Error): void {
    const settle = settleLoad;
    settleLoad = null;
    loadPromise = null;
    status = "failed";
    settle?.reject(error);
  }

  function finishStop(): void {
    const settle = settleStop;
    settleStop = null;
    settle?.();
  }

  function handleFailure(): void {
    finishStop();
    if (settleLoad) {
      failLoad(asError("worker-failed"));
      return;
    }
    loadPromise = null;
    status = "failed";
    options.onError?.(asError("worker-failed"), "worker error");
  }

  function handle(value: unknown): void {
    const message = readSttResponse(value);
    if (message === null) return;

    switch (message.type) {
      case "progress": {
        loadedByFile[message.file] = Math.max(loadedByFile[message.file], message.loaded);
        const loaded =
          loadedByFile.runtime + loadedByFile.wasm + loadedByFile.model;
        options.onProgress?.(Math.min(1, loaded / WHISTLE_DOWNLOAD_TOTAL));
        return;
      }
      case "ready": {
        status = "ready";
        options.onProgress?.(1);
        const settle = settleLoad;
        settleLoad = null;
        loadPromise = Promise.resolve();
        settle?.resolve();
        return;
      }
      case "result": {
        options.onResult?.(message.json);
        return;
      }
      case "stopped": {
        finishStop();
        options.onStopped?.(message.json);
        return;
      }
      case "error": {
        if (message.code === "stream-stop-failed") finishStop();
        const error = asError(message.code);
        if (settleLoad) {
          failLoad(error);
          return;
        }
        options.onError?.(error, message.detail);
        return;
      }
    }
  }

  function ensureWorker(): SttWorker {
    if (worker !== null) return worker;

    const created = factory();
    // A worker this session has since replaced is stale: its late replies cannot reach
    // state that belongs to the replacement.
    created.onMessage((value: unknown) => {
      if (worker !== created) return;
      handle(value);
    });
    created.onFailure(() => {
      if (worker !== created) return;
      handleFailure();
    });
    worker = created;
    return created;
  }

  function load(): Promise<void> {
    if (loadPromise !== null) return loadPromise;
    if (status === "ready") return Promise.resolve();

    // A failed load left engine state the worker cannot undo, so a retry ends that worker
    // and starts a fresh one with clean state. Never automatic: only this call does it.
    if (status === "failed") {
      worker?.terminate();
      worker = null;
    }

    status = "loading";
    loadedByFile.runtime = 0;
    loadedByFile.wasm = 0;
    loadedByFile.model = 0;
    loadPromise = new Promise<void>((resolve, reject) => {
      settleLoad = { resolve, reject };
      ensureWorker().postMessage({
        type: "load",
        runtimeUrl: WHISTLE_RUNTIME_ROUTE,
        wasmUrl: WHISTLE_WASM_ROUTE,
        modelUrl: WHISTLE_MODEL_ROUTE,
        language: WHISTLE_LANGUAGE,
        keywords: WHISTLE_KEYWORDS,
      });
    });

    return loadPromise;
  }

  return {
    load,

    start() {
      ensureWorker().postMessage({ type: "start" });
    },

    sendChunk(samples) {
      if (samples.length === 0) return;
      ensureWorker().postMessage({ type: "chunk", samples }, [samples.buffer]);
    },

    stop() {
      if (worker === null || status === "failed") return Promise.resolve();
      if (stopPromise !== null) return stopPromise;

      const stoppingWorker = worker;
      const stopping = new Promise<void>((resolve) => {
        settleStop = resolve;
        try {
          stoppingWorker.postMessage({ type: "stop" });
        } catch {
          finishStop();
        }
      });
      const settled = stopping.finally(() => {
        if (stopPromise === settled) stopPromise = null;
      });
      stopPromise = settled;
      return settled;
    },
  };
}
