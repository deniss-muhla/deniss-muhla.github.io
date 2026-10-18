import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { admitModelIdentity } from "../scripts/retrieval-qa.mjs";

/**
 * The admission gate with synthetic records, so it runs with a cold model cache and no
 * browser. Every case declares its own pinned copy, digests and byte counts from the text
 * it uses, which is what makes a substituted config detectable: a value that disagrees with
 * the pinned copy while the digest and the report's asset metadata agree is exactly the
 * shape a moved artifact takes.
 */

const TOKENIZER = Object.freeze({ modelMaxLength: 512, truncationSide: "right", paddingSide: "right" });

/** The accepted report's `identity.model`: no vocabulary key, which is the real gap. */
function recordedModel(overrides: Record<string, unknown> = {}) {
  return {
    hiddenSize: 384,
    maxPositionEmbeddings: 4096,
    modelType: "bert",
    tokenizerModelMaxLength: 512,
    tokenizerTruncationSide: "right",
    tokenizerPaddingSide: "right",
    ...overrides,
  };
}

function asset(file: string, bytes: number, digest: string) {
  return { file, bytes, sha256: digest };
}

/** The pinned copy keys its own list by name; the report records the same file by name. */
function pinnedAsset(file: string, bytes: number, digest: string) {
  return { name: file, bytes, sha256: digest };
}

function digestOf(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** A pinned copy and a matching report for `configText`, so only the named field can fail. */
function admission(configText: string, { model = recordedModel(), assets }: { model?: Record<string, unknown>; assets?: unknown[] } = {}) {
  const configAsset = asset("config.json", Buffer.byteLength(configText), digestOf(configText));
  const tokenizerAsset = asset("tokenizer.json", 711_661, "b".repeat(64));
  const pinned = {
    modelAssets: [pinnedAsset("config.json", configAsset.bytes, configAsset.sha256), pinnedAsset("tokenizer.json", tokenizerAsset.bytes, tokenizerAsset.sha256)],
    observedConfig: { hiddenSize: 384, modelType: "bert", maxPositionEmbeddings: 4_096, vocabularySize: 30_522 },
    observedTokenizer: TOKENIZER,
  };
  const node = { identity: { model, assets: assets ?? [configAsset, tokenizerAsset] } };

  return { pinned, node, bytes: Buffer.from(configText, "utf8") };
}

const RAW_CONFIG = JSON.stringify(
  {
    architectures: ["BertModel"],
    hidden_act: "gelu",
    hidden_size: 384,
    max_position_embeddings: 4096,
    model_type: "bert",
    vocab_size: 30_522,
  },
  null,
  2,
);

test("the vocabulary the accepted report never recorded is authenticated from the config bytes", () => {
  const { pinned, node, bytes } = admission(RAW_CONFIG);
  const report = node.identity.model as Record<string, unknown>;

  assert.equal("vocabularySize" in report, false, "the real report carries no vocabulary key, so this case must not invent one");

  const admitted = admitModelIdentity(node, bytes, pinned);

  assert.deepEqual(
    {
      hiddenSize: admitted.config.hiddenSize,
      modelType: admitted.config.modelType,
      maxPositionEmbeddings: admitted.config.maxPositionEmbeddings,
      vocabularySize: admitted.config.vocabularySize,
    },
    pinned.observedConfig,
  );
  assert.deepEqual(admitted.tokenizer, TOKENIZER);
  assert.equal(admitted.config.tokenizerModelMaxLength, 512, "the recorded tokenizer values stay on the returned record");
});

test("a config whose digest is wrong is refused before it is parsed", () => {
  const { pinned, node, bytes } = admission(RAW_CONFIG);
  // Same byte count, and not JSON at all, so a refusal can only have come from the digest
  // gate: a parse attempt would have reported a syntax error instead.
  const notEvenJson = Buffer.from("x".repeat(bytes.byteLength), "utf8");

  assert.throws(() => admitModelIdentity(node, notEvenJson, pinned), /^Error: admitted-config-digest-mismatch$/);
});

test("a config whose byte count is wrong is refused before it is parsed", () => {
  const { pinned, node } = admission(RAW_CONFIG);
  // The declared values are all correct, so only the byte count can catch this.
  const padded = Buffer.from(`${RAW_CONFIG}\n`, "utf8");

  assert.throws(() => admitModelIdentity(node, padded, pinned), /^Error: admitted-config-byte-count-changed:\d+$/);
});

test("correct bytes that declare the wrong dimension are refused", () => {
  const wrongDimension = RAW_CONFIG.replace('"hidden_size": 384', '"hidden_size": 768');
  const { pinned, node, bytes } = admission(wrongDimension);

  assert.throws(() => admitModelIdentity(node, bytes, pinned), /^Error: admitted-config-changed:hiddenSize$/);
});

test("correct bytes that declare the wrong vocabulary are refused", () => {
  const wrongVocabulary = RAW_CONFIG.replace('"vocab_size": 30522', '"vocab_size": 30523');
  const { pinned, node, bytes } = admission(wrongVocabulary);

  assert.throws(() => admitModelIdentity(node, bytes, pinned), /^Error: admitted-config-changed:vocabularySize$/);
});

test("a report value that disagrees with the authenticated bytes is refused", () => {
  const { pinned, node, bytes } = admission(RAW_CONFIG, { model: recordedModel({ hiddenSize: 512 }) });

  assert.throws(() => admitModelIdentity(node, bytes, pinned), /^Error: admitted-record-disagrees:hiddenSize$/);
});

test("each raw key is read by its own snake_case name, and camelCase aliases are not accepted", () => {
  const { pinned, node, bytes } = admission(RAW_CONFIG);

  assert.deepEqual(Object.keys(pinned.observedConfig).sort(), ["hiddenSize", "maxPositionEmbeddings", "modelType", "vocabularySize"]);

  const camelOnly = Buffer.from(
    JSON.stringify({ hiddenSize: 384, maxPositionEmbeddings: 4096, modelType: "bert", vocabularySize: 30_522 }),
    "utf8",
  );
  const camelAdmission = admission(camelOnly.toString("utf8"));

  assert.throws(() => admitModelIdentity(camelAdmission.node, camelOnly, camelAdmission.pinned), /^Error: admitted-config-unreadable:hidden_size$/);
  assert.equal(admitModelIdentity(node, bytes, pinned).config.hiddenSize, 384);
});