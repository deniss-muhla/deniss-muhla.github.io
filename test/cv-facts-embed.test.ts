import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CvFactsError, describeFailure } from "../scripts/cv-facts/errors.mjs";
import { PINNED_EMBEDDING, contentSha256, validateArtifact } from "../scripts/cv-facts/artifact.mjs";
import { REPO_ROOT, REVIEWED_ARTIFACT_PATH } from "../scripts/cv-facts/paths.mjs";
import {
  ADAPTER_CONTRACT,
  MODEL_ID,
  REVISION,
  TOKEN_CAP,
  AdapterContractError,
  configurePinnedEnvironment,
  embedCandidate,
  embedCardVectors,
  installedDistributionDirs,
  loadPinnedModel,
  loadPinnedWebDelivery,
  meanPoolAndNormalize,
} from "../scripts/cv-facts/embedding.mjs";

/**
 * Warm state this test needs, outside the repository. It is the already-reviewed pinned model
 * tree from the accepted external probe, and the accepted Node WebAssembly report that the
 * vectors are compared against. Create it once with the reviewed probe's own fetch, or let
 * `cv:facts embed` populate its own external cache. The test skips, loudly, without it.
 */
const WARM_ASSETS = "/home/den/.cache/cv-assistant/retrieval-first-probe-mxbai/cache/hf-assets";
const ACCEPTED_REPORT = "/home/den/.cache/cv-assistant/retrieval-first-probe-mxbai/runs/run-01/node-report.json";
const GRAPH_FILE = path.join(WARM_ASSETS, MODEL_ID, "resolve", REVISION, "onnx", "model_quantized.onnx");

/** Two cards from the external probe's own synthetic fixture. No CV text is used here. */
const SYNTHETIC_CARDS = [
  {
    id: "tech-postgres",
    topic: "Relational database technology",
    tags: ["PostgreSQL", "relational database", "data storage"],
    answer: "PostgreSQL is the relational database used for data storage in this synthetic fixture.",
    sourceRefs: [{ startLine: 40, endLine: 40 }],
  },
  {
    id: "language-german",
    topic: "Spoken languages",
    tags: ["languages", "German", "English"],
    answer: "This synthetic fixture records German and English as the sample person's spoken languages.",
    sourceRefs: [{ startLine: 41, endLine: 41 }],
  },
];

const warmStateMissing = !fs.existsSync(GRAPH_FILE) || !fs.existsSync(ACCEPTED_REPORT);

/** A bounded origin that answers only `<model>/resolve/<revision>/<file>` and 404s the rest. */
function startPinnedOrigin(cacheRoot: string) {
  const prefix = `/${MODEL_ID}/resolve/${REVISION}/`;
  const root = path.resolve(cacheRoot, MODEL_ID, "resolve", REVISION);
  const requests: { path: string; range: string | undefined }[] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    requests.push({ path: url.pathname, range: request.headers.range });

    const refuse = () => {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not-a-pinned-revision-path");
    };

    if (!url.pathname.startsWith(prefix)) return refuse();

    const target = path.resolve(root, url.pathname.slice(prefix.length));

    if (target !== root && !target.startsWith(root + path.sep)) return refuse();
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return refuse();

    const bytes = fs.readFileSync(target);
    const match = request.headers.range && /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);

    if (match) {
      const start = Number(match[1]);
      const end = match[2] === "" ? bytes.length - 1 : Number(match[2]);

      response.writeHead(206, {
        "content-length": String(end - start + 1),
        "content-range": `bytes ${start}-${end}/${bytes.length}`,
      });
      return response.end(bytes.subarray(start, end + 1));
    }

    response.writeHead(200, { "content-length": String(bytes.length) });
    response.end(bytes);
  });

  return {
    requests,
    prefix,
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}/` };
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function maxAbsDiff(a: readonly number[], b: readonly number[]) {
  let worst = 0;

  for (let index = 0; index < a.length; index++) worst = Math.max(worst, Math.abs(a[index] - b[index]));

  return worst;
}

test("the pinned delivery contract and pooling refuse before they produce a vector", async (t) => {
  const { packageDir, ortDir } = installedDistributionDirs();

  await t.test("a mutated locked digest refuses before any import or request", async () => {
    await assert.rejects(
      loadPinnedWebDelivery({
        packageDir,
        ortDir,
        contract: { ...ADAPTER_CONTRACT, buildSha256: "0".repeat(64) },
      }),
      (error: unknown) => error instanceof AdapterContractError && error.reason === "web-build-digest-mismatch",
    );

    await assert.rejects(
      loadPinnedWebDelivery({ packageDir, ortDir, contract: { ...ADAPTER_CONTRACT, version: "4.4.0" } }),
      (error: unknown) => error instanceof AdapterContractError && error.reason === "package-version-mismatch",
    );

    await assert.rejects(
      loadPinnedWebDelivery({
        packageDir,
        ortDir,
        contract: { ...ADAPTER_CONTRACT, ortWasmSha256: "0".repeat(64) },
      }),
      (error: unknown) => error instanceof AdapterContractError && error.reason === "ort-wasm-digest-mismatch",
    );
  });

  await t.test("pooling refuses a wrong dimension and an empty attention mask", () => {
    assert.throws(
      () => meanPoolAndNormalize({ dims: [1, 2, 8], data: new Float32Array(16), attentionMask: [1, 1], expectedDimensions: 384 }),
      (error: unknown) => error instanceof CvFactsError && error.reason === "embed/dimension-mismatch",
    );
    assert.throws(
      () => meanPoolAndNormalize({ dims: [1, 2, 384], data: new Float32Array(768), attentionMask: [0, 0], expectedDimensions: 384 }),
      (error: unknown) => error instanceof CvFactsError && error.reason === "embed/empty-attention-mask",
    );
    assert.throws(
      () => meanPoolAndNormalize({ dims: [1, 384], data: new Float32Array(384), attentionMask: [1], expectedDimensions: 384 }),
      (error: unknown) => error instanceof CvFactsError && error.reason === "embed/hidden-shape-unreadable",
    );
  });

  await t.test("an unsupported candidate shape is refused before the model is loaded", async () => {
    await assert.rejects(
      embedCandidate({ version: 2, cards: [] }, { transformers: {} }),
      (error: unknown) => error instanceof CvFactsError && error.reason === "embed/candidate-shape-unsupported",
    );
  });

  await t.test("an adapter contract refusal keeps its own reason in the reported rule", () => {
    assert.deepEqual(describeFailure(new AdapterContractError("web-build-digest-mismatch")), [
      "[cv] cv-facts/embed/web-build-digest-mismatch",
    ]);
  });
});

test("a real WebAssembly embed records the pinned identity, a stable vector and an external cache", async (t) => {
  if (warmStateMissing) {
    t.skip(
      `warm pinned model bytes and the accepted report are required at ${WARM_ASSETS} and ${ACCEPTED_REPORT}; populate them with the reviewed external probe or one cv:facts embed run`,
    );
    return;
  }

  const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cv-facts-embed-"));
  const cacheDir = path.join(workspace, "cache");
  const reviewedBefore = fs.existsSync(REVIEWED_ARTIFACT_PATH)
    ? fs.readFileSync(REVIEWED_ARTIFACT_PATH)
    : null;
  const pinned = startPinnedOrigin(WARM_ASSETS);

  t.after(async () => {
    await pinned.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const { origin } = await pinned.listen();
  const { packageDir, ortDir } = installedDistributionDirs();
  const { transformers, wasm, restored } = await loadPinnedWebDelivery({ packageDir, ortDir });

  assert.deepEqual(restored, { identityPreserved: true, descriptorRestored: true });

  const environment = configurePinnedEnvironment({ transformers, wasm, cacheDir, remoteHost: origin });

  assert.equal(environment.remotePathTemplate, `{model}/resolve/${REVISION}/`);
  assert.equal(environment.cacheDir, cacheDir);
  assert.equal(environment.cacheDir.startsWith(REPO_ROOT), false);

  const { tokenizer, model } = await loadPinnedModel({ transformers });
  const first = await embedCardVectors({ tokenizer, model, cards: SYNTHETIC_CARDS });
  const second = await embedCardVectors({ tokenizer, model, cards: SYNTHETIC_CARDS });

  assert.equal(first.dimensions, PINNED_EMBEDDING.dimensions);
  assert.equal(first.dimensions, 384);
  assert.equal(model.config?.hidden_size, first.dimensions);

  for (const card of SYNTHETIC_CARDS) {
    const vector = first.vectors.get(card.id);

    assert.ok(vector, `${card.id} must produce a vector`);
    assert.equal(vector.length, 384);
    assert.equal(vector.every((value) => Number.isFinite(value)), true);
    assert.equal(vector.some((value) => value !== 0), true);
    assert.equal(
      vector.every((value) => Math.abs(value * 1e6 - Math.round(value * 1e6)) < 1e-6),
      true,
    );
    assert.deepEqual(second.vectors.get(card.id), vector);
  }

  // Independent source of truth: the accepted Node WebAssembly run for the same pinned graph.
  const accepted = JSON.parse(fs.readFileSync(ACCEPTED_REPORT, "utf8"));

  for (const card of SYNTHETIC_CARDS) {
    const vector = first.vectors.get(card.id);
    const reference: number[] | undefined = accepted.cardVectors[card.id];

    assert.ok(vector);
    assert.ok(Array.isArray(reference), `the accepted report must carry ${card.id}`);
    assert.ok(
      maxAbsDiff(vector, reference) <= 1e-6,
      `${card.id} must match the accepted Node WebAssembly vector within the six-decimal store precision`,
    );
  }

  const offRevision = pinned.requests.filter((entry) => !entry.path.startsWith(pinned.prefix));

  assert.deepEqual(offRevision, []);
  assert.ok(pinned.requests.length >= 1);
  assert.equal(pinned.requests.some((entry) => entry.range === "bytes=0-0"), true);
  assert.equal(pinned.requests.some((entry) => entry.path.includes("/resolve/main/")), false);

  // The candidate records the pinned identity, the recorded digest and passable vectors.
  const candidate = await embedCandidate(
    {
      version: 1,
      source: { path: "resources/cv/source/cv.md", sha256: "0".repeat(64) },
      embedding: {},
      cards: SYNTHETIC_CARDS.map((card) => ({ ...card, vector: [] })),
    },
    { transformers },
  );

  assert.deepEqual(candidate.embedding, { ...PINNED_EMBEDDING, contentSha256: contentSha256(candidate.cards) });
  assert.equal(candidate.embedding.contentSha256, contentSha256(candidate.cards));
  assert.equal(
    candidate.cards.every((card) => card.vector.length === 384),
    true,
  );

  // A card whose retrieval text exceeds the cap is rejected rather than truncated.
  const overCap = [
    {
      id: "over-cap-card",
      topic: "Oversized topic",
      tags: ["oversized"],
      answer: "documented token ".repeat(300),
      sourceRefs: [{ startLine: 7, endLine: 9 }],
    },
  ];

  await assert.rejects(
    embedCardVectors({ tokenizer, model, cards: overCap }),
    (error: unknown) =>
      error instanceof CvFactsError &&
      error.reason === "embed/card-token-cap" &&
      error.lines?.start === 7 &&
      !error.message.includes("documented token"),
  );

  // A candidate is authored material, so its coordinates are only reported when they are
  // plain line numbers.
  const poisonedCoordinates = [
    {
      id: "over-cap-poisoned",
      topic: "Oversized topic",
      tags: ["oversized"],
      answer: "documented token ".repeat(300),
      sourceRefs: [{ startLine: "SOURCE_SENTINEL", endLine: "SOURCE_SENTINEL" }],
    },
  ];

  await assert.rejects(
    embedCardVectors({ tokenizer, model, cards: poisonedCoordinates }),
    (error: unknown) =>
      error instanceof CvFactsError &&
      error.reason === "embed/card-token-cap" &&
      error.lines === undefined &&
      !JSON.stringify(describeFailure(error)).includes("SOURCE_SENTINEL"),
  );

  // Caches stay outside the repository, and embed writes the candidate it was handed rather
  // than the reviewed index, which `promote` is the only command allowed to replace.
  assert.deepEqual(
    fs.existsSync(REVIEWED_ARTIFACT_PATH) ? fs.readFileSync(REVIEWED_ARTIFACT_PATH) : null,
    reviewedBefore,
  );
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "node_modules", ".cache")), false);
  assert.ok(fs.existsSync(cacheDir));
});

test("a real WebAssembly embed candidate passes the offline validator shape", async (t) => {
  if (warmStateMissing) {
    t.skip("warm pinned model bytes are required for a real embedding");
    return;
  }

  const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cv-facts-embed-check-"));
  const pinned = startPinnedOrigin(WARM_ASSETS);

  t.after(async () => {
    await pinned.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const { origin } = await pinned.listen();
  const { packageDir, ortDir } = installedDistributionDirs();
  const { transformers, wasm } = await loadPinnedWebDelivery({ packageDir, ortDir });

  configurePinnedEnvironment({ transformers, wasm, cacheDir: path.join(workspace, "cache"), remoteHost: origin });

  const sourceBytes = Buffer.from(["# Fixture", "", "One documented line.", ""].join("\n"));
  const { createHash } = await import("node:crypto");
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const candidate = await embedCandidate(
    {
      version: 1,
      source: { path: "resources/cv/source/cv.md", sha256: sourceSha256 },
      embedding: {},
      cards: [
        {
          id: "fixture-card",
          topic: "A synthetic topic",
          tags: ["synthetic"],
          sourceRefs: [{ startLine: 3, endLine: 3 }],
          answer: "A synthetic answer that states a documented fixture fact.",
          vector: [],
        },
      ],
    },
    { transformers },
  );

  const { findings } = validateArtifact(candidate, {
    sourceRelativePath: "resources/cv/source/cv.md",
    sourceSha256,
    sourceLineCount: 3,
  });

  assert.deepEqual(findings, []);
});

test("the recorded token cap and pooling identity match design decisions 7 and 8", () => {
  assert.equal(TOKEN_CAP, 256);
  assert.equal(PINNED_EMBEDDING.dtype, "q8");
  assert.equal(PINNED_EMBEDDING.pooling, "mean");
  assert.equal(PINNED_EMBEDDING.normalize, true);
  assert.equal(PINNED_EMBEDDING.inputVersion, "retrieval-text-v1");
  assert.equal(PINNED_EMBEDDING.runtimeVersion, ADAPTER_CONTRACT.version);
  assert.equal(PINNED_EMBEDDING.revision, REVISION);
  assert.equal(ADAPTER_CONTRACT.ortVersion, "1.31.0-dev.20260914-8d85527a0");
});