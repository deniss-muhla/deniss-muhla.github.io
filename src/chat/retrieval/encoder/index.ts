/**
 * The query encoder: the module task 5.3 added behind the existing `QuestionEncoder` seam.
 *
 * `createRetrievalEncoder` is the whole public surface. It returns a lazy handle whose
 * `embed` satisfies the controller's seam, so nothing above this directory imports the
 * embedding library, spawns a worker or knows a model revision.
 *
 * - `client.ts` is the page's handle: when to create the worker, which question is still
 *   wanted, and the loading, ready and failed transitions.
 * - `worker.ts` is the only module that imports `@huggingface/transformers`. It runs the
 *   inference off the page thread.
 * - `protocol.ts` is the boundary: plain data both ways, classified reasons for failures,
 *   and no way to ask for a card vector.
 * - `pooling.ts` is the pinned pooling and the model-identity guards, as pure functions so
 *   the browser-free suite can run them.
 * - `runtime-assets.ts` is the project's record of the pinned ONNX Runtime Web files and the
 *   one same-origin route that serves them.
 */
export {
  createEncoderWorker,
  createRetrievalEncoder,
  type EncoderIdentity,
  type EncoderProgress,
  type EncoderState,
  type EncoderWorker,
  type EncoderWorkerFactory,
  type RetrievalEncoder,
  type RetrievalEncoderOptions,
} from "./client.ts";
export { MAX_QUESTION_CHARS, TOKEN_CAP } from "./protocol.ts";
export { ORT_RUNTIME_VERSION, ORT_WASM_PATHS } from "./runtime-assets.ts";
