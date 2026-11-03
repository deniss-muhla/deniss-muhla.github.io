/**
 * The page's handle on the embedding worker.
 *
 * The client owns the parts of the lifecycle that are not inference: when the worker is
 * created, which question is still wanted, and which state a typed answer may be served
 * from. It knows nothing about the embedding library, so the engine that owns model
 * lifecycle can hold one of these without importing a vendor package.
 *
 * Construction is free. No worker exists, and no request is made, until `load` or `embed`
 * is called, which is what lets a metered session decide not to load at all: it simply
 * passes no encoder to the retrieval controller and never touches this module.
 *
 * A new question replaces the previous one, even while the model is still loading. The
 * older caller is rejected with `embed/superseded` and told the question was cancelled, and
 * a result that arrives for it afterwards is discarded rather than rendered, so an
 * interrupted turn cannot show up late.
 */
import { RetrievalError } from "../errors.ts";
import {
  MAX_QUESTION_CHARS,
  readResponse,
  type EncoderRequest,
  type EncoderResponse,
} from "./protocol.ts";

/** `idle` before anything was asked for, then loading, ready or failed. */
export type EncoderState = "idle" | "loading" | "ready" | "failed";

/** Real download progress, reduced to a file name and byte counts. */
export interface EncoderProgress {
  readonly file: string;
  readonly loaded: number;
  readonly total: number;
  readonly percent: number;
}

/** What the loaded runtime reported, so a caller can record identity without importing the library. */
export interface EncoderIdentity {
  readonly dimensions: number;
  readonly loadMs: number;
  readonly runtimeVersion: string;
  readonly remoteHost: string;
  readonly remotePathTemplate: string;
  readonly files: readonly string[];
}

/** What one completed question cost, from the library's own count and the worker's own clock. */
export interface EncoderQuery {
  readonly dimensions: number;
  readonly tokenCount: number;
  readonly durationMs: number;
}

/** The worker surface this module needs. A real worker and a test double both satisfy it. */
export interface EncoderWorker {
  postMessage(message: EncoderRequest): void;
  terminate(): void;
  onMessage(listener: (value: unknown) => void): void;
  onFailure(listener: () => void): void;
}

export type EncoderWorkerFactory = () => EncoderWorker;

export interface RetrievalEncoderOptions {
  /** Overridden by the browser-free suite with a double; the default creates the real worker. */
  readonly workerFactory?: EncoderWorkerFactory;
  /** Called with each library progress event, in arrival order. */
  readonly onProgress?: (progress: EncoderProgress) => void;
}

export interface RetrievalEncoder {
  readonly state: EncoderState;
  /** Identity of the loaded runtime, or `null` before it is ready. */
  readonly identity: EncoderIdentity | null;
  /** What the last completed question cost, or `null` before one has. */
  readonly lastQuery: EncoderQuery | null;
  /** Loads the pinned model. Concurrent and later calls share the one load. */
  load(): Promise<void>;
  /** Embeds one trimmed question. Loads the model first if it is not loaded. */
  embed(question: string): Promise<readonly number[]>;
  /** Ends the worker. A later `load` or `embed` starts a fresh one. */
  close(): void;
}

/** The default worker: one module worker, so inference never blocks the page. */
export function createEncoderWorker(): EncoderWorker {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "retrieval-encoder",
  });

  return {
    postMessage(message) {
      worker.postMessage(message);
    },
    terminate() {
      worker.terminate();
    },
    onMessage(listener) {
      worker.addEventListener("message", (event: MessageEvent) => {
        listener(event.data);
      });
    },
    onFailure(listener) {
      worker.addEventListener("error", () => {
        listener();
      });
    },
  };
}

interface ActiveEmbed {
  readonly id: number;
  readonly question: string;
  resolve(vector: readonly number[]): void;
  reject(error: RetrievalError): void;
}

function asRetrievalError(error: unknown): RetrievalError {
  return error instanceof RetrievalError ? error : new RetrievalError("model/load-failed");
}

/**
 * @param options the progress callback and, for tests, the worker factory
 * @returns a lazy encoder for the pinned model
 */
export function createRetrievalEncoder(options: RetrievalEncoderOptions = {}): RetrievalEncoder {
  const factory = options.workerFactory ?? createEncoderWorker;

  let worker: EncoderWorker | null = null;
  let status: EncoderState = "idle";
  let identity: EncoderIdentity | null = null;
  let lastQuery: EncoderQuery | null = null;
  let loadPromise: Promise<void> | null = null;
  let nextId = 0;
  let settleLoad: { resolve(): void; reject(error: RetrievalError): void } | null = null;
  let active: ActiveEmbed | null = null;

  function dropActive(reason: RetrievalError, cancel: boolean): void {
    const previous = active;

    active = null;

    if (previous === null) return;

    previous.reject(reason);

    if (cancel) worker?.postMessage({ type: "cancel", id: previous.id });
  }

  function handle(message: EncoderResponse): void {
    switch (message.type) {
      case "progress": {
        options.onProgress?.({
          file: message.file,
          loaded: message.loaded,
          total: message.total,
          percent: message.percent,
        });
        return;
      }

      case "ready": {
        status = "ready";
        identity = {
          dimensions: message.dimensions,
          loadMs: message.loadMs,
          runtimeVersion: message.runtimeVersion,
          remoteHost: message.remoteHost,
          remotePathTemplate: message.remotePathTemplate,
          files: message.files,
        };
        settleLoad?.resolve();
        settleLoad = null;
        return;
      }

      case "vector": {
        // A result for a question the visitor already replaced is discarded, not rendered.
        if (active === null || active.id !== message.id) return;

        const answered = active;

        active = null;
        lastQuery = {
          dimensions: message.vector.length,
          tokenCount: message.tokenCount,
          durationMs: message.durationMs,
        };
        answered.resolve(message.vector);
        return;
      }

      case "cancelled": {
        if (active === null || active.id !== message.id) return;
        dropActive(new RetrievalError("embed/cancelled"), false);
        return;
      }

      case "load-failed": {
        status = "failed";
        loadPromise = null;
        dropActive(new RetrievalError(message.reason), false);
        settleLoad?.reject(new RetrievalError(message.reason));
        settleLoad = null;
        return;
      }

      case "embed-failed": {
        if (active === null || active.id !== message.id) return;
        dropActive(new RetrievalError(message.reason), false);
      }
    }
  }

  function ensureWorker(): EncoderWorker {
    if (worker !== null) return worker;

    const created = factory();

    // Both listeners are bound to the worker they were registered on. A worker this client has
    // since replaced is stale, so its late replies, progress and failures cannot reach state that
    // now belongs to the replacement.
    created.onMessage((value: unknown) => {
      if (worker !== created) return;

      const message = readResponse(value);

      if (message === null) return;
      handle(message);
    });
    created.onFailure(() => {
      if (worker !== created) return;

      created.terminate();
      worker = null;
      status = "failed";
      loadPromise = null;
      dropActive(new RetrievalError("worker/failed"), false);
      settleLoad?.reject(new RetrievalError("worker/failed"));
      settleLoad = null;
    });

    worker = created;

    return created;
  }

  /** Ends the current worker and forgets it, so the next call builds a fresh one. */
  function replaceWorker(): void {
    const previous = worker;

    worker = null;
    previous?.terminate();
  }

  function load(): Promise<void> {
    if (loadPromise !== null) return loadPromise;

    // A failed load leaves library state behind that the worker cannot undo: the runtime's own
    // session-initialisation chain stays rejected for the life of that module instance, so a
    // second load request to the same worker fails the same way. An explicit retry therefore ends
    // that worker and starts a fresh one with clean state. This is never automatic, and a healthy
    // or still-loading worker is reused exactly as before.
    if (status === "failed") replaceWorker();

    status = "loading";

    loadPromise = new Promise<void>((resolve, reject) => {
      settleLoad = { resolve, reject };
      ensureWorker().postMessage({ type: "load" });
    });

    return loadPromise;
  }

  return {
    get state() {
      return status;
    },

    get identity() {
      return identity;
    },

    get lastQuery() {
      return lastQuery;
    },

    load,

    async embed(question) {
      const trimmed = question.trim();

      if (trimmed === "") throw new RetrievalError("query/empty");
      if (trimmed.length > MAX_QUESTION_CHARS) throw new RetrievalError("query/too-long");

      // A newer question replaces the pending one, even if that one is still waiting for
      // the model, so no earlier turn can land after a later one.
      dropActive(new RetrievalError("embed/superseded"), true);

      const id = (nextId += 1);

      const current: ActiveEmbed = {
        id,
        question: trimmed,
        resolve: () => undefined,
        reject: () => undefined,
      };
      const result = new Promise<readonly number[]>((resolve, reject) => {
        current.resolve = resolve;
        current.reject = reject;
      });
      // The caller attaches its own handler after the load; this keeps a supersede during
      // loading from surfacing as an unhandled rejection before that happens.
      void result.catch(() => undefined);
      active = current;

      try {
        await load();
      } catch (error) {
        if (active === current) active = null;
        throw asRetrievalError(error);
      }

      if (active !== current) throw new RetrievalError("embed/superseded");

      // Read through `ensureWorker` rather than keeping a reference from before the load: a retry
      // after a failed load ends the worker that was current when this question started, so the
      // question belongs to whichever worker loaded the model.
      ensureWorker().postMessage({ type: "embed", id, question: trimmed });

      return result;
    },

    close() {
      dropActive(new RetrievalError("embed/closed"), false);
      settleLoad?.reject(new RetrievalError("embed/closed"));
      settleLoad = null;
      worker?.terminate();
      worker = null;
      identity = null;
      lastQuery = null;
      loadPromise = null;
      nextId = 0;
      status = "idle";
    },
  };
}
