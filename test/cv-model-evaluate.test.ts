import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { prebuiltAppConfig } from "@mlc-ai/web-llm";
import { FROZEN_CV_SHA256, SmokeFailure, SMOKE_OUTER_TIMEOUT_SECONDS } from "../scripts/cv-model-evaluate.ts";

const engineUrl = new URL("../src/chat/engine.ts", import.meta.url);
const snapshotUrl = new URL("./cv-context.public-cv.snapshot.md", import.meta.url);

test("the smoke fingerprint matches the frozen public-CV prompt snapshot", async () => {
  const snapshot = await readFile(snapshotUrl);
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha256").update(snapshot).digest("hex"), FROZEN_CV_SHA256);
});

test("the smoke deadline allows model load, generation and resource cleanup", () => {
  assert.ok(SMOKE_OUTER_TIMEOUT_SECONDS * 1_000 > 240_000 + 90_000 + 60_000);
});

test("the smoke reports only fixed failure stages", () => {
  for (const stage of ["source", "startup", "model-load", "generation"] as const) {
    const failure = new SmokeFailure(stage);
    assert.equal(failure.stage, stage);
    assert.equal(failure.message, `smoke-${stage}-failed`);
  }
});

test("production model registrations map actual shader-f16 capability to matching artifacts", async () => {
  const engine = await readFile(engineUrl, "utf8");
  for (const [symbol, id] of [
    ["LLM_MODEL_F16", "SmolLM2-360M-Instruct-q4f16_1-MLC"],
    ["LLM_MODEL_F32", "SmolLM2-360M-Instruct-q4f32_1-MLC"],
  ]) {
    assert.ok(engine.includes(`const ${symbol} = "${id}";`));
    const artifact = prebuiltAppConfig.model_list.find((entry) => entry.model_id === id);
    assert.ok(artifact?.model.startsWith("https://huggingface.co/"));
    assert.ok(artifact?.model_lib.endsWith("-webgpu.wasm"));
    assert.equal(artifact?.required_features?.includes("shader-f16") ?? false, symbol === "LLM_MODEL_F16");
  }
  assert.match(engine, /this\.capabilities\.shaderF16 \? LLM_MODEL_F16 : LLM_MODEL_F32/);
});
