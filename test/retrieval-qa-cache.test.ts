import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { evaluateRuntimeCacheProof } from "../scripts/retrieval-qa.mjs";
import type { RuntimeCacheInput, RuntimeCacheProof, StoredRuntimeAsset } from "../scripts/retrieval-qa.mjs";
import { ORT_WASM_PATHS } from "../src/chat/retrieval/encoder/runtime-assets.ts";

/**
 * The runtime cache and offline-replay gate, on synthetic records.
 *
 * Every case declares its own tiny bytes, digests and headers, so a missing cache entry, a
 * wrong size, a wrong digest, an unanswered replay or an unisolated replay is a change in the
 * input rather than a large fixture. No browser, server or model is involved: the gate is a
 * pure function of what a page reported.
 *
 * The gate replaced a check that asked the page's headers object for a `transferSize`. The
 * first case keeps that exact input and asserts the new gate holds on the byte evidence, which
 * is the correction: a resource-timing field was never the proof of a stored response.
 */

const PATHS = [ORT_WASM_PATHS.mjs, ORT_WASM_PATHS.wasm] as const;

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

/** The stored and served shape of one cached runtime file, from synthetic bytes. */
function proofText(path: string): { text: string; bytes: number; sha256: string; name: string } {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const text = `synthetic ${name}`;
  const bytes = Buffer.byteLength(text, "utf8");

  return { text, bytes, sha256: createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"), name };
}

function declaredAssets() {
  return PATHS.map((path) => {
    const asset = proofText(path);

    return { name: asset.name, bytes: asset.bytes, sha256: asset.sha256 };
  });
}

/**
 * A stored response with no cache policy and no isolation headers, which is what a worker
 * stores before it serves the response with those headers added.
 */
function storedEntry(path: string, overrides: Partial<StoredRuntimeAsset> = {}): StoredRuntimeAsset {
  const asset = proofText(path);

  return {
    path,
    url: `https://qa.example${path}`,
    cacheName: "cv-assets-1",
    found: true,
    headers: { status: 200, contentType: "application/wasm", contentLength: null, cacheControl: null, crossOriginOpenerPolicy: null, crossOriginEmbedderPolicy: null, crossOriginResourcePolicy: null },
    bytes: asset.bytes,
    sha256: asset.sha256,
    ...overrides,
  };
}

function replayRecord(paths: readonly string[], overrides: Partial<RuntimeCacheInput["replay"]> = {}) {
  const replayed = paths.map((path) => {
    const asset = proofText(path);

    return {
      path,
      url: `https://qa.example${path}`,
      status: 200,
      headers: {
        status: 200,
        contentType: "application/wasm",
        contentLength: null,
        cacheControl: null,
        crossOriginOpenerPolicy: "same-origin" as const,
        crossOriginEmbedderPolicy: "require-corp" as const,
        crossOriginResourcePolicy: "same-origin" as const,
      },
      bytes: asset.bytes,
      sha256: asset.sha256,
      error: null as string | null,
    };
  });

  return {
    phase: "offline-replay",
    offline: true,
    crossOriginIsolated: true,
    serviceWorkerControlled: true,
    replayed,
    ...overrides,
  } as NonNullable<RuntimeCacheInput["replay"]>;
}

/** A complete, valid proof. Each failing case changes one value in it. */
function proof(overrides: Partial<RuntimeCacheInput> = {}) {
  const declared = overrides.declared ?? declaredAssets();
  const stored = overrides.stored ?? PATHS.map((path) => storedEntry(path));
  const consumed =
    overrides.consumed ?? PATHS.map((path) => ({ path, status: 200, bytes: proofText(path).bytes, sha256: proofText(path).sha256 }));
  const replay = "replay" in overrides ? (overrides.replay ?? null) : replayRecord(PATHS);

  return evaluateRuntimeCacheProof({ routing: "built", stored, replay, consumed, declared, ...overrides });
}

function failuresOf(result: RuntimeCacheProof): string[] {
  return result.failures;
}

test("a stored response with no cache policy and no isolation headers is accepted on its bytes", () => {
  const result = proof({ stored: PATHS.map((path) => storedEntry(path, { headers: { status: 200, cacheControl: "no-store" } })) });

  assert.deepEqual(result, { applicable: true, checks: Object.fromEntries(Object.keys(result.checks).map((key) => [key, true])), failures: [] });
  assert.equal(result.checks.storageComplete, true);
  assert.equal(result.checks.storedDigestMatchArtifact, true);
  assert.equal(result.checks.replayDigestMatchStored, true);
});

test("the pre-fix gate could not pass this input, and the new gate does", () => {
  const headers = { status: 200, contentType: "application/wasm", cacheControl: null, crossOriginOpenerPolicy: "same-origin", crossOriginEmbedderPolicy: "require-corp" };
  const preFix = [{ cached: headers }].every((entry) => typeof (entry.cached as { transferSize?: unknown }).transferSize === "number");

  assert.equal(preFix, false, "the removed timing-field gate is false on a valid headers object");
  assert.deepEqual(proof({ stored: PATHS.map((path) => storedEntry(path, { headers })) }).failures, []);
});

test("a runtime file the worker never stored fails storage completeness", () => {
  const result = proof({ stored: [storedEntry(PATHS[0]), storedEntry(PATHS[1], { found: false, cacheName: null, bytes: null, sha256: null, headers: null })] });

  assert.equal(result.checks.storageComplete, false);
  assert.ok(failuresOf(result).includes("cache-storage-complete"));
  assert.ok(failuresOf(result).includes("cache-stored-digest-match-artifact"));
  assert.ok(failuresOf(result).includes("cache-replay-digest-match-stored"));
});

test("a stored response without a cache name fails, because the holding cache is evidence", () => {
  const result = proof({ stored: PATHS.map((path) => storedEntry(path, { cacheName: "" })) });

  assert.equal(result.checks.storageComplete, false);
  assert.ok(failuresOf(result).includes("cache-storage-complete"));
});

test("a stored response that is not a successful status fails", () => {
  const result = proof({ stored: PATHS.map((path) => storedEntry(path, { headers: { status: 404 } })) });

  assert.equal(result.checks.storageComplete, false);
});

test("a wrong stored digest against the artifact fails", () => {
  const result = proof({ stored: PATHS.map((path) => storedEntry(path, { sha256: DIGEST_A })) });

  assert.equal(result.checks.storedDigestMatchArtifact, false);
  assert.ok(failuresOf(result).includes("cache-stored-digest-match-artifact"));
});

test("a wrong stored size against the artifact fails", () => {
  const result = proof({ stored: PATHS.map((path) => storedEntry(path, { bytes: proofText(path).bytes + 1 })) });

  assert.equal(result.checks.storedBytesMatchArtifact, false);
  assert.ok(failuresOf(result).includes("cache-stored-bytes-match-artifact"));
});

test("browser-consumed bytes that differ from the stored bytes fail byte identity", () => {
  const result = proof({ consumed: PATHS.map((path) => ({ path, status: 200, bytes: proofText(path).bytes, sha256: DIGEST_B })) });

  assert.equal(result.checks.consumedMatchesStored, false);
  assert.ok(failuresOf(result).includes("cache-consumed-matches-stored"));
});

test("a missing replay record fails, because an unrun replay proves nothing", () => {
  const result = proof({ replay: null });

  assert.equal(result.checks.replayCompleted, false);
  assert.ok(failuresOf(result).includes("cache-replay-completed"));
});

test("a replay that never went offline, or that had no controller, fails", () => {
  const online = proof({ replay: replayRecord(PATHS, { offline: false }) });
  const uncontrolled = proof({ replay: replayRecord(PATHS, { serviceWorkerControlled: false }) });

  assert.ok(failuresOf(online).includes("cache-replay-completed"));
  assert.ok(failuresOf(uncontrolled).includes("cache-replay-completed"));
});

test("a replay the page could not answer fails with its own error", () => {
  const record = replayRecord(PATHS);

  record.replayed[0] = { ...record.replayed[0], status: 0, headers: null, bytes: null, sha256: null, error: "TypeError" };

  const result = proof({ replay: record });

  assert.equal(result.checks.replayComplete, false);
  assert.ok(failuresOf(result).includes("cache-replay-complete"));
});

test("a replay the harness itself failed fails", () => {
  const result = proof({ replayError: "deadline offline-replay after 120000ms" });

  assert.equal(result.checks.replayCompleted, false);
  assert.ok(failuresOf(result).includes("cache-replay-completed"));
});

test("a wrong replayed size or digest against the stored bytes fails", () => {
  const wrongBytes = replayRecord(PATHS);

  wrongBytes.replayed[1] = { ...wrongBytes.replayed[1], bytes: proofText(PATHS[1]).bytes + 2 };

  const wrongDigest = replayRecord(PATHS);

  wrongDigest.replayed[0] = { ...wrongDigest.replayed[0], sha256: DIGEST_A };

  assert.ok(failuresOf(proof({ replay: wrongBytes })).includes("cache-replay-bytes-match-stored"));
  assert.ok(failuresOf(proof({ replay: wrongDigest })).includes("cache-replay-digest-match-stored"));
});

test("a replay that is not cross-origin isolated fails", () => {
  const record = replayRecord(PATHS);

  record.replayed[0] = {
    ...record.replayed[0],
    headers: { ...record.replayed[0].headers, crossOriginEmbedderPolicy: null },
  };

  const result = proof({ replay: record });

  assert.equal(result.checks.replayIsolated, false);
  assert.ok(failuresOf(result).includes("cache-replay-isolated"));
});

test("a routing without the service worker is out of scope rather than failing", () => {
  const result = evaluateRuntimeCacheProof({ routing: "dev", stored: null, replay: null, consumed: [], declared: [] });

  assert.deepEqual(result, { applicable: false, checks: {}, failures: [] });
});

test("every failing check is named in the failure list", () => {
  const result = proof({ stored: [], replay: null, consumed: [] });
  const failing = Object.entries(result.checks).filter(([, held]) => !held).map(([check]) => check);

  assert.ok(failing.length > 0);
  assert.deepEqual(
    result.failures,
    failing.map((check) => `cache-${check.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`),
  );
});
