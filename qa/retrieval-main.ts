/**
 * The private page the headed retrieval check drives.
 *
 * It is deliberately not the site's entry: it does not mount the chat and never starts
 * the speech models, so a check of the embedding path cannot accidentally pull a second
 * model onto the connection. Nothing links to it and a production build only
 * includes it when `RETRIEVAL_QA=1` asks for it.
 *
 * It does load the site's own `/sw-register.js` when the routing asks for it, because the
 * production boundary that adds cross-origin isolation is the service worker, and a check
 * that measured isolation without the worker would measure nothing. The registration
 * script stays the only owner of registration and of the recovery reload.
 *
 * Everything it returns is metadata: case ids, scores, dimensions, norms, timings, digests
 * and outcomes. No question text, no answer text, no card text and no model internals are
 * returned, logged or written, so the check can be recorded as evidence.
 */
import { createRetrievalController, WEAK_MATCH_CUE } from "../src/chat/retrieval/controller.ts";
import { createRetrievalEncoder, type RetrievalEncoder } from "../src/chat/retrieval/encoder/index.ts";
import { ORT_RUNTIME_ASSETS, ORT_WASM_PATHS } from "../src/chat/retrieval/encoder/runtime-assets.ts";
import { readRequest, readResponse, verifyQueryVector } from "../src/chat/retrieval/encoder/protocol.ts";
import { assertModelIdentity, poolQueryVector, tokenOutputName } from "../src/chat/retrieval/encoder/pooling.ts";
import { EXPECTED_EMBEDDING, readReviewedIndex } from "../src/chat/retrieval/index.ts";
import { rankCards } from "../src/chat/retrieval/scoring.ts";
import { reviewedIndex } from "../src/chat/retrieval/reviewed-index.ts";

interface EmbedReport {
  readonly id: string;
  readonly dimensions: number;
  readonly norm: number;
  readonly finite: boolean;
  readonly tokenCount: number;
  readonly durationMs: number;
  readonly vector: readonly number[];
}

interface GuardReport {
  readonly name: string;
  readonly reason: string;
}

/** The response headers the production delivery boundary is measured on. */
interface MeasuredHeaders {
  readonly status: number;
  readonly contentType: string | null;
  readonly contentLength: string | null;
  readonly cacheControl: string | null;
  readonly crossOriginOpenerPolicy: string | null;
  readonly crossOriginEmbedderPolicy: string | null;
  readonly crossOriginResourcePolicy: string | null;
}

interface MeasuredAsset {
  readonly name: string;
  readonly url: string;
  /** Where the bytes came from: the loader's own cache, or a request this page made. */
  readonly source: string;
  readonly status: number;
  readonly bytes: number;
  readonly sha256: string;
}

/** What Cache Storage holds for one runtime file, and which cache holds it. */
interface StoredRuntimeAsset {
  readonly path: string;
  readonly url: string;
  readonly cacheName: string | null;
  readonly found: boolean;
  readonly headers: MeasuredHeaders | null;
  readonly bytes: number | null;
  readonly sha256: string | null;
}

/** One replayed runtime file. A failed fetch is reported, never thrown away. */
interface ReplayedRuntimeAsset {
  readonly path: string;
  readonly url: string;
  readonly status: number;
  readonly headers: MeasuredHeaders | null;
  readonly bytes: number | null;
  readonly sha256: string | null;
  readonly error: string | null;
}

/** The model files whose own fields are read as observed configuration, not just bytes. */
const CONFIG_FILES: readonly string[] = ["config.json", "tokenizer_config.json"];

/** The runtime files whose delivery is measured, in load order. */
const RUNTIME_PATHS: readonly string[] = [ORT_WASM_PATHS.mjs, ORT_WASM_PATHS.wasm];

interface ReadModelAsset {
  readonly entry: MeasuredAsset;
  readonly body?: ArrayBuffer;
}

/** `deliveryType` is a Chromium field; where it is absent the report says so. */
interface MeasuredTiming extends PerformanceResourceTiming {
  readonly deliveryType?: string;
}

let encoder: RetrievalEncoder | null = null;
const progress: { file: string; loaded: number; total: number; percent: number }[] = [];

function activeEncoder(): RetrievalEncoder {
  if (encoder === null) {
    encoder = createRetrievalEncoder({
      onProgress(event) {
        progress.push({ file: event.file, loaded: event.loaded, total: event.total, percent: event.percent });
      },
    });
  }

  return encoder;
}

function l2Norm(vector: readonly number[]): number {
  let squared = 0;

  for (const value of vector) squared += value * value;

  return Math.sqrt(squared);
}

async function digestOf(body: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", body);

  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function headersOf(response: Response): MeasuredHeaders {
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    contentLength: response.headers.get("content-length"),
    cacheControl: response.headers.get("cache-control"),
    crossOriginOpenerPolicy: response.headers.get("cross-origin-opener-policy"),
    crossOriginEmbedderPolicy: response.headers.get("cross-origin-embedder-policy"),
    crossOriginResourcePolicy: response.headers.get("cross-origin-resource-policy"),
  };
}

/**
 * The bytes this browser holds for one model file, hashed where they are consumed.
 *
 * The loader keeps the model in Cache Storage, so that copy is read first and is the
 * strongest record of what the run used. A file it did not store is fetched through the
 * browser's own cache. Either way the source is reported, so a digest is never presented
 * as proof of an origin it did not come from.
 */
async function readModelAsset(name: string, url: string): Promise<ReadModelAsset> {
  let cached: Response | undefined;

  try {
    cached = await caches.match(url);
  } catch {
    // A cross-origin URL can be refused as a cache key; the request below still measures it.
  }

  const response = cached ?? (await fetch(url, { cache: "force-cache" }));
  const body = await response.arrayBuffer();
  const entry: MeasuredAsset = {
    name,
    url,
    source: cached ? "cache-storage" : "browser-cache-or-network",
    status: response.status,
    bytes: body.byteLength,
    sha256: await digestOf(body),
  };

  return { entry, ...(CONFIG_FILES.includes(name) ? { body } : {}) };
}

/** The configuration fields the generator recorded, read out of the consumed config file. */
function observedFields(body: ArrayBuffer | undefined, keys: readonly string[]): Record<string, number | string | null> {
  if (body === undefined) return {};

  const config = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;

  return Object.fromEntries(
    keys.map((key) => {
      const value = config[key];

      return [key, typeof value === "number" || typeof value === "string" ? value : null];
    }),
  );
}

function reasonOf(error: unknown): string {
  return error instanceof Error && "reason" in error && typeof error.reason === "string"
    ? error.reason
    : "unknown";
}

const api = {
  environment() {
    return {
      isolated: self.crossOriginIsolated === true,
      serviceWorker: Boolean(navigator.serviceWorker?.controller),
      gpuObjectPresent: "gpu" in navigator,
      secureContext: self.isSecureContext,
      locationOrigin: self.location.origin,
    };
  },

  /** Fetches the two served runtime files and records what actually came back. */
  async assets() {
    const entries = await Promise.all(
      [ORT_WASM_PATHS.mjs, ORT_WASM_PATHS.wasm].map(async (path) => {
        const response = await fetch(path, { cache: "no-store" });
        const body = await response.arrayBuffer();

        return {
          path,
          status: response.status,
          contentType: response.headers.get("content-type"),
          bytes: body.byteLength,
          sha256: await digestOf(body),
        };
      }),
    );

    return { entries, declared: ORT_RUNTIME_ASSETS.map((asset) => ({ name: asset.name, bytes: asset.bytes, sha256: asset.sha256 })) };
  },

  /**
   * The production delivery boundary, measured in the page.
   *
   * The static server this routing is checked on sends no isolation headers, so a
   * COOP/COEP pair on a same-origin response came from the service worker this page
   * registered. Each runtime file is requested twice, once bypassing every cache and once
   * through the browser's own, so cache behavior is a measurement rather than an
   * assumption. Resource timing is reported as the browser recorded it.
   */
  async delivery() {
    const controller = navigator.serviceWorker?.controller ?? null;
    const runtime = [];

    for (const path of RUNTIME_PATHS) {
      const bypassed = await fetch(path, { cache: "no-store" });
      const cached = await fetch(path, { cache: "force-cache" });
      const last = performance
        .getEntriesByType("resource")
        .filter((entry): entry is MeasuredTiming => entry.name.endsWith(path))
        .at(-1);

      runtime.push({
        path,
        bypassed: headersOf(bypassed),
        cached: headersOf(cached),
        cachedTransferSize: last?.transferSize ?? null,
        cachedDeliveryType: last?.deliveryType ?? null,
        cachedEncodedBodySize: last?.encodedBodySize ?? null,
      });
    }

    return {
      crossOriginIsolated: self.crossOriginIsolated === true,
      serviceWorkerControlled: Boolean(controller),
      controllerScript: controller?.scriptURL ?? null,
      secureContext: self.isSecureContext,
      locationOrigin: self.location.origin,
      cacheNames: (await caches.keys()).sort(),
      runtime,
    };
  },

  /**
   * What Cache Storage actually holds for the two runtime files.
   *
   * Each cache is opened in turn, because the name a response is stored under is part of the
   * evidence and `caches.match` alone would not report it. The stored response is read and
   * hashed here, in the browser, so the record is the stored bytes rather than a header or a
   * timing field. Nothing is written and no cache is cleared. The stored headers are reported
   * as they are: the worker re-adds the isolation headers when it serves a response, so what
   * is stored carries no policy this check is allowed to judge.
   */
  async runtimeCache() {
    const names = (await caches.keys()).sort();
    const stored: StoredRuntimeAsset[] = [];

    for (const path of RUNTIME_PATHS) {
      const url = new URL(path, self.location.origin).href;
      let found: { cacheName: string; response: Response } | null = null;

      for (const cacheName of names) {
        const response = await (await caches.open(cacheName)).match(url);

        if (response !== undefined) {
          found = { cacheName, response };
          break;
        }
      }

      if (found === null) {
        stored.push({ path, url, cacheName: null, found: false, headers: null, bytes: null, sha256: null });
        continue;
      }

      const body = await found.response.arrayBuffer();

      stored.push({
        path,
        url,
        cacheName: found.cacheName,
        found: true,
        headers: headersOf(found.response),
        bytes: body.byteLength,
        sha256: await digestOf(body),
      });
    }

    return { names, stored, declared: ORT_RUNTIME_ASSETS.map((asset) => ({ name: asset.name, bytes: asset.bytes, sha256: asset.sha256 })) };
  },

  /**
   * Replays the two runtime files while the browser context is offline.
   *
   * The requests are plain same-origin fetches, so they travel through the same service
   * worker as every other request; nothing here names a cache mode or a store. A fetch that
   * cannot be answered is reported per file with its error name, because a replay that only
   * reports successes would be indistinguishable from one that never ran.
   *
   * This proves two cached runtime files are served offline. It proves nothing about the model
   * files, the chat path or speech, and it writes nothing.
   */
  async replayRuntime(paths: readonly string[]) {
    const replayed: ReplayedRuntimeAsset[] = [];

    for (const path of paths) {
      const url = new URL(path, self.location.origin).href;

      try {
        const response = await fetch(url);
        const body = await response.arrayBuffer();

        replayed.push({ path, url, status: response.status, headers: headersOf(response), bytes: body.byteLength, sha256: await digestOf(body), error: null });
      } catch (error) {
        replayed.push({ path, url, status: 0, headers: null, bytes: null, sha256: null, error: error instanceof Error ? error.name : "fetch-failed" });
      }
    }

    return {
      phase: "offline-replay",
      offline: navigator.onLine === false,
      crossOriginIsolated: self.crossOriginIsolated === true,
      serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
      replayed,
    };
  },

  /**
   * The model bytes this browser consumed, hashed where they were consumed.
   *
   * @param admitted `[{ name, url }]` built by the harness from the accepted generator
   *   artifact and the runtime's own reported host and path template. Digests are compared
   *   in the harness, so this reports only what was read.
   */
  async modelAssets(admitted: { name: string; url: string }[]) {
    const reads = await Promise.all(admitted.map((asset) => readModelAsset(asset.name, asset.url)));
    const byName = new Map(reads.map((read) => [read.entry.name, read]));
    const config = byName.get("config.json");

    return {
      entries: reads.map((read) => read.entry),
      observedConfig: observedFields(config?.body, ["hidden_size", "model_type", "max_position_embeddings", "vocab_size"]),
      observedTokenizer: observedFields(byName.get("tokenizer_config.json")?.body, ["model_max_length", "truncation_side", "padding_side"]),
    };
  },

  /** Loads the pinned model. Progress is recorded here and read once with `progressReport`. */
  async open() {
    await activeEncoder().load();
    const identity = activeEncoder().identity;

    return {
      state: activeEncoder().state,
      dimensions: identity?.dimensions ?? 0,
      loadMs: identity?.loadMs ?? 0,
      runtimeVersion: identity?.runtimeVersion ?? "",
      remoteHost: identity?.remoteHost ?? "",
      remotePathTemplate: identity?.remotePathTemplate ?? "",
      files: identity?.files ?? [],
    };
  },

  progressReport() {
    return { events: progress.length, files: [...new Set(progress.map((event) => event.file))].sort(), lastPercent: progress.at(-1)?.percent ?? 0 };
  },

  /**
   * Embeds questions one at a time and reports metadata per question.
   *
   * @param inputs `{ id, text }` pairs; the text is never returned
   */
  async embed(inputs: { id: string; text: string }[]): Promise<EmbedReport[]> {
    const reports: EmbedReport[] = [];

    for (const input of inputs) {
      const vector = verifyQueryVector(await activeEncoder().embed(input.text));
      const last = activeEncoder().lastQuery;

      reports.push({
        id: input.id,
        dimensions: vector.length,
        norm: l2Norm(vector),
        finite: vector.every((value) => Number.isFinite(value)),
        tokenCount: last?.tokenCount ?? -1,
        durationMs: last?.durationMs ?? -1,
        vector,
      });
    }

    return reports;
  },

  /** An over-cap question is refused, not truncated into a vector. */
  async oversize() {
    const long = `${"word ".repeat(400)}end`;
    const startedAt = performance.now();

    try {
      await activeEncoder().embed(long);
      return { refused: false, reason: "accepted", length: long.length, durationMs: performance.now() - startedAt };
    } catch (error) {
      return { refused: true, reason: reasonOf(error), length: long.length, durationMs: performance.now() - startedAt };
    }
  },

  /** A newer question supersedes the pending one, and the older result never lands. */
  async supersede(first: string, second: string) {
    const running = activeEncoder();
    const older = running.embed(first).then(
      () => "resolved" as const,
      (error: unknown) => reasonOf(error),
    );
    const newer = running.embed(second).then(
      () => "resolved" as const,
      (error: unknown) => reasonOf(error),
    );

    return { older: await older, newer: await newer };
  },

  /** The shipped answer path: the reviewed index, the controller and a real query vector. */
  async controllerProbe(question: string) {
    const index = reviewedIndex();
    const controller = createRetrievalController(index);
    const vector = await activeEncoder().embed(question);
    const ranking = rankCards(index, vector);
    const answer = await controller.ask(question, async () => vector);

    return {
      cards: index.cards.length,
      identity: index.embedding,
      topScore: ranking.scored[0]?.score ?? 0,
      topCardId: ranking.scored[0]?.id ?? "",
      answer: {
        kind: answer.kind,
        cardId: "cardId" in answer ? answer.cardId : null,
        matching: "matching" in answer ? answer.matching : null,
        weak: "weak" in answer ? answer.weak : null,
        limitedCause: "limitedCause" in answer ? (answer.limitedCause ?? null) : null,
      },
      weakCue: WEAK_MATCH_CUE,
    };
  },

  /** The lexical fallback against the real index, with no encoder. */
  async lexicalProbe(question: string) {
    const controller = createRetrievalController(reviewedIndex());
    const answer = await controller.ask(question, null);

    return {
      kind: answer.kind,
      matching: "matching" in answer ? answer.matching : null,
      limitedCause: "limitedCause" in answer ? (answer.limitedCause ?? null) : null,
      cardId: "cardId" in answer ? answer.cardId : null,
    };
  },

  /** The guards of the shipped bundle, each expected to refuse. */
  guards(): GuardReport[] {
    const expected: { name: string; run: () => unknown }[] = [
      {
        name: "wrong-dimension",
        run: () => poolQueryVector({ dims: [1, 4, 383], data: new Float32Array(4 * 383) }, [1, 1, 1, 1]),
      },
      {
        name: "rank-two-output",
        run: () => poolQueryVector({ dims: [1, 384], data: new Float32Array(384) }, [1]),
      },
      {
        name: "truncated-tensor",
        run: () => poolQueryVector({ dims: [1, 8, EXPECTED_EMBEDDING.dimensions], data: new Float32Array(8) }, Array.from({ length: 8 }, () => 1)),
      },
      {
        name: "empty-mask",
        run: () => poolQueryVector({ dims: [1, 4, EXPECTED_EMBEDDING.dimensions], data: new Float32Array(4 * EXPECTED_EMBEDDING.dimensions) }, [0, 0, 0, 0]),
      },
      {
        name: "non-finite",
        run: () =>
          poolQueryVector(
            { dims: [1, 2, EXPECTED_EMBEDDING.dimensions], data: (() => { const data = new Float32Array(2 * EXPECTED_EMBEDDING.dimensions); data[0] = Number.NaN; return data; })() },
            [1, 1],
          ),
      },
      { name: "pooled-only-graph", run: () => tokenOutputName({ sentence_embedding: {} }) },
      { name: "wrong-model", run: () => assertModelIdentity({ model: "some/other", revision: EXPECTED_EMBEDDING.revision, hiddenSize: 384, runtimeVersion: EXPECTED_EMBEDDING.runtimeVersion }) },
      { name: "wrong-revision", run: () => assertModelIdentity({ model: EXPECTED_EMBEDDING.model, revision: "main", hiddenSize: 384, runtimeVersion: EXPECTED_EMBEDDING.runtimeVersion }) },
      { name: "wrong-runtime-version", run: () => assertModelIdentity({ model: EXPECTED_EMBEDDING.model, revision: EXPECTED_EMBEDDING.revision, hiddenSize: 384, runtimeVersion: "3.0.0" }) },
      { name: "hidden-size-mismatch", run: () => assertModelIdentity({ model: EXPECTED_EMBEDDING.model, revision: EXPECTED_EMBEDDING.revision, hiddenSize: 512, runtimeVersion: EXPECTED_EMBEDDING.runtimeVersion }) },
      { name: "short-vector", run: () => verifyQueryVector(Array.from({ length: EXPECTED_EMBEDDING.dimensions - 1 }, () => 0.1)) },
      { name: "zero-vector", run: () => verifyQueryVector(Array.from({ length: EXPECTED_EMBEDDING.dimensions }, () => 0)) },
      { name: "cards-in-request", run: () => readRequest({ type: "embed", id: 1, question: "anything", cards: [{ id: "x" }] }) },
      { name: "foreign-response", run: () => readResponse({ type: "vector", id: 1, vector: Array.from({ length: EXPECTED_EMBEDDING.dimensions }, () => 0), tokenCount: 1, durationMs: 1, tensor: {} }) },
      { name: "malformed-index", run: () => readReviewedIndex({ version: 2 }) },
    ];

    return expected.map(({ name, run }) => {
      try {
        const value = run();

        return { name, reason: value === null ? "refused:null" : `accepted:${typeof value}` };
      } catch (error) {
        return { name, reason: reasonOf(error) };
      }
    });
  },

  async close() {
    encoder?.close();
    encoder = null;

    return { state: "idle" as const };
  },
};

declare global {
  interface Window {
    retrievalQa: typeof api;
  }
}

window.retrievalQa = api;
document.getElementById("status")?.replaceChildren(document.createTextNode("ready"));
