// Types for the sibling `.mjs` module, so the typechecked browser-free suite sees them.

export interface AdmittedAsset {
  file: string;
  bytes: number;
  sha256: string;
}

/** The admitted model identity: the generator's asset record, its configured values and its tokenizer record. */
export interface AdmittedIdentity {
  assets: AdmittedAsset[];
  config: Record<string, any>;
  tokenizer: Record<string, any>;
}

export interface FrozenRun {
  /** The frozen case set, with its gate. */
  cases: Record<string, any>;
  gate: Record<string, any>;
  cardVectors: Map<string, number[]>;
  byCase: Map<string, { id: string; vector: number[] }>;
  admitted: AdmittedIdentity;
}

/**
 * Admits the accepted generator record against the pinned copy and the authenticated
 * `config.json` bytes. Throws before any value is read when a byte count, a digest, a
 * configured value or a recorded value disagrees.
 */
export function admitModelIdentity(node: unknown, configBytes: Uint8Array, frozen?: unknown): AdmittedIdentity;

/**
 * The model files, the observed configuration and tokenizer values and the pinned runtime byte
 * count the identity checks compare the consumed bytes against.
 */
export const pinnedModelIdentity: {
  modelAssets: readonly { name: string; bytes: number; sha256: string }[];
  observedConfig: Readonly<Record<string, number | string>>;
  observedTokenizer: Readonly<Record<string, number | string>>;
  ortWasmBytes: number;
};

/** Reads the frozen fixture and the admitted identity from the probe workspace, and nothing else. */
export function readFrozen(): FrozenRun;

/** The delivery facts read from the document that is current at one moment. */
export interface DeliveryState {
  controlled: boolean;
  isolated: boolean;
  coiSeen: boolean;
  ready: boolean;
}

/** The sanitized public state of the startup: phase, current path, navigations and last flags. */
export interface DeliveryPhase {
  phase: "startup" | "measured";
  path: string | null;
  navigations: number;
  coiSeen: boolean | null;
  controlled: boolean | null;
  isolated: boolean | null;
}

/** The part of a page the barrier and its observation read. */
export interface DeliveryPage {
  mainFrame(): unknown;
  on(event: string, handler: (frame: unknown) => void): unknown;
  evaluate(fn: unknown): Promise<DeliveryState>;
}

/** Watches the main frame from before the first navigation, keeping public metadata only. */
export function observeDeliveryPhase(page: DeliveryPage): DeliveryPhase;

/** Waits for the delivery boundary of one routing, on the load bound it is given. */
export function waitForDeliveryControl(
  page: DeliveryPage,
  limits: { loadMs: number },
  options?: { routing?: "dev" | "built"; observation?: DeliveryPhase; startedAt?: number },
): Promise<DeliveryState>;

export function runRetrievalQa(): Promise<void>;

/** The run's own orchestration, without the whole-run deadline around it. */
export function runRetrievalQaWork(cleanup: unknown): Promise<void>;

/**
 * The seams a registered regression replaces, with the real ones as their values: the routing,
 * the bounds, the frozen fixture, the server and the browser.
 */
export const qaSeams: {
  routing: string;
  readLimits: (env?: Record<string, string | undefined>) => { loadMs: number; queryMs: number; runMs: number };
  readFrozen: () => FrozenRun;
  startServer: () => Promise<{ child: unknown; origin: string }>;
  launch: (profileDir: string, options: Record<string, unknown>) => Promise<unknown>;
};

/** The declared bounds, overridable so a check can see a deadline fail without waiting it out. */
export function readLimits(env?: Record<string, string | undefined>): { loadMs: number; queryMs: number; runMs: number };

/** One failure the run observed, in the only form a report may carry. */
export interface ObservedFailure {
  stage: string;
  source: "console" | "page" | "http" | "request";
  reason: string;
  disposition: "expected" | "blocking";
  path?: string;
  status?: number;
  /** Why the run judged the entry the way it did, kept beside the entry's own source and reason. */
  classification?: string;
  /** What explains an expected entry: the request failure that does, or the confirmed replay itself. */
  evidence?: { source: "request" | "offline-replay"; path?: string; reason?: string };
}

/**
 * One classification for every failure the offline replay produced.
 *
 * `entries` keeps every entry in the order it was observed, `expected` the ones a confirmed
 * offline replay explains and `unresolved` the rest. Nothing is explained unless `context`
 * reports that the run set the context offline itself.
 */
export function classifyOfflinePhase(
  entries: readonly ObservedFailure[],
  context?: { offline?: boolean },
): { entries: ObservedFailure[]; expected: ObservedFailure[]; unresolved: ObservedFailure[] };

/** The metadata one answer path reported, the fields the gate judges. */
export interface AnswerMetadata {
  kind: string;
  matching: string | null;
  limitedCause: string | null;
  weak?: boolean | null;
  cardId?: string | null;
}

/** What the acceptance predicates judge: the guards, the superseding result and both answers. */
export interface WorkloadGateInput {
  guards: readonly { name: string; reason: string }[];
  supersede: { older: string; newer: string };
  /** The controller probe, which nests its answer metadata under `answer`. */
  controller: { answer?: AnswerMetadata } | null;
  /** The lexical probe, which reports the same metadata flat. */
  lexical: AnswerMetadata | null;
  observed: readonly ObservedFailure[];
}

/** The failures the run's collected predictions would leave the acceptance gate with. */
export function workloadGate(input: WorkloadGateInput): string[];

/** What Cache Storage holds for one runtime file, as the page read it. */
export interface StoredRuntimeAsset {
  path: string;
  url: string;
  cacheName: string | null;
  found: boolean;
  headers: Record<string, string | number | null> | null;
  bytes: number | null;
  sha256: string | null;
}

/** One replayed runtime file from the offline phase. */
export interface ReplayedRuntimeAsset {
  path: string;
  url: string;
  status: number;
  headers: Record<string, string | number | null> | null;
  bytes: number | null;
  sha256: string | null;
  error: string | null;
}

/** The page's own record of the offline replay. */
export interface RuntimeReplayRecord {
  phase: string;
  offline: boolean;
  crossOriginIsolated: boolean;
  serviceWorkerControlled: boolean;
  replayed: ReplayedRuntimeAsset[];
}

export interface RuntimeCacheInput {
  routing: string;
  stored: StoredRuntimeAsset[] | null;
  replay: RuntimeReplayRecord | null;
  replayError?: string | null;
  consumed: { path: string; status: number; bytes: number; sha256: string }[];
  declared: { name: string; bytes: number; sha256: string }[];
  /** The replay's own thrown value, when it failed. `null` means the replay itself succeeded. */
  replayError?: unknown;
}

export interface RuntimeCacheProof {
  applicable: boolean;
  checks: Record<string, boolean>;
  failures: string[];
}

/** Judges the stored runtime bytes and the offline replay. Browser-free. */
export function evaluateRuntimeCacheProof(input: RuntimeCacheInput): RuntimeCacheProof;
export type QaScriptGraphResult =
  | { ok: true; scripts: number }
  | { ok: false; reason: string; detail: string };

/**
 * Refuses a built QA document whose script graph can reach the site entry or its top-level
 * mount into `#root`. Browser-free: it reads the built files only.
 */
export function checkQaScriptGraph(distDir: string): QaScriptGraphResult;
