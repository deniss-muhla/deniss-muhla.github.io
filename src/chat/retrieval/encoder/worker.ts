/**
 * The one module that knows the embedding library exists.
 *
 * Application and interface code never imports `@huggingface/transformers`; they pass an
 * encoder to the retrieval controller and receive plain vectors back. This worker runs the
 * inference so a question does not block the page, and it keeps the pinned delivery
 * contract of design decision 8: the selected model at its literal revision, the `q8`
 * graph, masked mean pooling with normalization, a 256-token cap, single-threaded
 * WebAssembly, no proxy worker, and no GPU.
 *
 * Two things are deliberately not private. The runtime's own revision-less tokenizer
 * metadata probe resolves through the same revision-literal path template, so no request it
 * builds can reach a mutable remote. And the WebAssembly files are named as same-origin
 * URLs that the project's own route serves from the installed locked package, not from a
 * third-party CDN.
 *
 * Nothing here writes a card vector. A request carries one trimmed question; the vectors of
 * the reviewed index are precomputed and stored in the artifact.
 */
import { AutoModel, AutoTokenizer, LogLevel, env } from "@huggingface/transformers";

import { RetrievalError } from "../errors.ts";
import { EXPECTED_EMBEDDING, MODEL_ROUTE } from "../index.ts";
import { TOKEN_CAP, readRequest, type EncoderResponse } from "./protocol.ts";
import { assertModelIdentity, poolQueryVector, tokenOutputName } from "./pooling.ts";
import { ORT_NUM_THREADS, ORT_PROXY, ORT_WASM_PATHS } from "./runtime-assets.ts";

/** The worker global, described by this module instead of by a WebWorker lib the app does not load. */
interface WorkerScope {
  postMessage(message: EncoderResponse): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

/** Minimal shape of the library objects this module uses, so no vendor type escapes into the app. */
interface TokenizerOutput {
  input_ids: { data: ArrayLike<number> };
  attention_mask: { data: ArrayLike<number> };
}

interface Tokenizer {
  (text: string, options?: Record<string, unknown>): TokenizerOutput;
}

interface LoadedModel {
  (inputs: TokenizerOutput): Promise<Record<string, unknown>>;
  config?: { hidden_size?: unknown };
}

interface ProgressEvent {
  readonly status?: string;
  readonly file?: string;
  readonly loaded?: number;
  readonly total?: number;
}

const port = self as unknown as WorkerScope;

/** The pinned dtype, narrowed once here so the loader request is a literal. */
const PINNED_DTYPE = "q8";

const readFiles = new Set<string>();

let pipeline: { tokenizer: Tokenizer; model: LoadedModel } | null = null;
let loadPromise: Promise<void> | null = null;
/** Questions waiting for the model or the inference thread, in arrival order. */
const queued: { id: number; question: string }[] = [];
const cancelled = new Set<number>();
let draining = false;

function send(message: EncoderResponse): void {
  port.postMessage(message);
}

function reasonOf(error: unknown): string {
  return error instanceof RetrievalError ? error.reason : "embed/failed";
}

/** The library's own `env` fields, in the order the contract settles them. */
function configureEnvironment(): void {
  if (EXPECTED_EMBEDDING.dtype !== PINNED_DTYPE) throw new RetrievalError("model/dtype-mismatch");

  // The library prints a failed inference: on that path it unpacks every input tensor and hands
  // the data to `logger.error`, and those inputs are this visitor's own tokenized question.
  // `env.logLevel` is its documented control and NONE is the only level that suppresses that
  // line, so it is set before anything can load. Nothing is lost: download progress still
  // arrives through `reportProgress`, and a failure still leaves as a classified reason, so no
  // vendor message, tensor or question is printed from this worker.
  env.logLevel = LogLevel.NONE;

  const wasm = env.backends.onnx?.wasm;

  if (wasm === undefined) throw new RetrievalError("model/onnx-backend-missing");

  // Every model byte comes from this origin: the library resolves each file under the pinned
  // `/models/` route and refuses remote model URLs, so no request it builds leaves the site.
  // The route table and the digests those bytes are pinned by live in `scripts/model-assets.mjs`.
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = MODEL_ROUTE;
  env.useBrowserCache = true;

  // Revision-literal: the template holds no `{revision}` placeholder, so the library's own
  // revision substitution is a no-op. Remote models are refused, so nothing resolves through
  // it anymore; it stays the revision the reviewed index was scored against, and the identity
  // check still reads that literal from here.
  env.remotePathTemplate = `{model}/resolve/${EXPECTED_EMBEDDING.revision}/`;

  // The host field names the origin whose own route serves the bytes now, so a report says
  // where the model actually came from instead of a remote nothing reaches.
  env.remoteHost = self.location.origin;

  wasm.wasmPaths = { ...ORT_WASM_PATHS };
  wasm.numThreads = ORT_NUM_THREADS;
  wasm.proxy = ORT_PROXY;
}

function reportProgress(event: ProgressEvent): void {
  const file = event.file;

  if (typeof file !== "string" || file === "") return;

  readFiles.add(file);

  const loaded = Number.isFinite(event.loaded) ? Number(event.loaded) : 0;
  const total = Number.isFinite(event.total) ? Number(event.total) : 0;

  send({
    type: "progress",
    file,
    loaded,
    total,
    percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 1000) / 10) : 0,
  });
}

async function loadModel(): Promise<void> {
  const startedAt = performance.now();
  const progressCallback = reportProgress;

  const tokenizer = (await AutoTokenizer.from_pretrained(EXPECTED_EMBEDDING.model, {
    progress_callback: progressCallback,
  })) as unknown as Tokenizer;
  const model = (await AutoModel.from_pretrained(EXPECTED_EMBEDDING.model, {
    device: "wasm",
    dtype: PINNED_DTYPE,
    progress_callback: progressCallback,
  })) as unknown as LoadedModel;

  assertModelIdentity({
    model: EXPECTED_EMBEDDING.model,
    revision: EXPECTED_EMBEDDING.revision,
    hiddenSize: model.config?.hidden_size,
    runtimeVersion: env.version,
  });

  pipeline = { tokenizer, model };

  send({
    type: "ready",
    dimensions: EXPECTED_EMBEDDING.dimensions,
    loadMs: performance.now() - startedAt,
    runtimeVersion: env.version,
    remoteHost: env.remoteHost,
    remotePathTemplate: env.remotePathTemplate,
    files: [...readFiles].sort(),
  });
}

/** One load at a time, shared by every caller, so a second question never re-requests anything. */
function ensureLoaded(): Promise<void> {
  if (loadPromise !== null) return loadPromise;

  loadPromise = loadModel().catch((error: unknown) => {
    loadPromise = null;
    send({ type: "load-failed", reason: reasonOf(error) });
    throw error;
  });

  return loadPromise;
}

async function embedQuestion(question: string, id: number): Promise<void> {
  const loaded = pipeline;

  if (loaded === null) {
    send({ type: "embed-failed", id, reason: "embed/not-ready" });
    return;
  }

  const startedAt = performance.now();

  try {
    // Counted before padding or truncation, so the cap is measured on the question itself.
    const tokenCount = loaded.tokenizer(question).input_ids.data.length;

    if (tokenCount > TOKEN_CAP) {
      send({ type: "embed-failed", id, reason: "query/too-long" });
      return;
    }

    const inputs = loaded.tokenizer(question, { padding: true, truncation: true, max_length: TOKEN_CAP });
    const output = await loaded.model(inputs);
    const outputName = tokenOutputName(output);

    if (outputName === null) {
      send({ type: "embed-failed", id, reason: "model/token-output-missing" });
      return;
    }

    const tensor = output[outputName] as { dims: readonly number[]; data: ArrayLike<number> };
    const pooled = poolQueryVector({ dims: tensor.dims, data: tensor.data }, inputs.attention_mask.data);

    send({
      type: "vector",
      id,
      vector: Array.from(pooled.vector),
      tokenCount,
      durationMs: performance.now() - startedAt,
    });
  } catch (error) {
    send({ type: "embed-failed", id, reason: reasonOf(error) });
  }
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;

  try {
    while (queued.length > 0) {
      const next = queued.shift();

      if (next === undefined) break;

      if (cancelled.has(next.id)) {
        cancelled.delete(next.id);
        send({ type: "cancelled", id: next.id });
        continue;
      }

      try {
        await ensureLoaded();
      } catch {
        // The load already reported its own classified failure. Retry stays explicit.
        continue;
      }

      await embedQuestion(next.question, next.id);
    }
  } finally {
    draining = false;
  }
}

configureEnvironment();

port.addEventListener("message", (event) => {
  const request = readRequest(event.data);

  if (request === null) return;

  if (request.type === "load") {
    void ensureLoaded().catch(() => undefined);
    return;
  }

  if (request.type === "cancel") {
    cancelled.add(request.id);
    return;
  }

  queued.push({ id: request.id, question: request.question });
  void drain();
});
