import { prebuiltAppConfig } from "@mlc-ai/web-llm";
import { voiceEngine } from "../src/chat/engine";

type SmokePage = Window["__cvSmoke"];

async function loadedModel() {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("webgpu-unavailable");

  const shaderF16 = adapter.features.has("shader-f16");
  await voiceEngine.ensureLlm();
  const modelId = voiceEngine.modelLabel;
  const entry = prebuiltAppConfig.model_list.find((model) => model.model_id === modelId);
  if (!entry || (shaderF16 && !entry.required_features?.includes("shader-f16")) ||
      (!shaderF16 && entry.required_features?.includes("shader-f16"))) {
    throw new Error("model-identity-mismatch");
  }

  const cachedAssets: Array<{ url: string; sha256: string; bytes: number }> = [];
  for (const cacheName of await caches.keys()) {
    const cache = await caches.open(cacheName);
    for (const request of await cache.keys()) {
      if (!request.url.startsWith(entry.model) && request.url !== entry.model_lib) continue;
      const response = await cache.match(request);
      if (!response) continue;
      const bytes = await response.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      cachedAssets.push({
        url: request.url,
        sha256: Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, "0")).join(""),
        bytes: bytes.byteLength,
      });
    }
  }
  if (!cachedAssets.some((asset) => asset.url === entry.model_lib) ||
      !cachedAssets.some((asset) => asset.url.startsWith(entry.model) && asset.url !== entry.model)) {
    throw new Error("cached-artifact-identity-unverified");
  }

  return {
    modelId,
    modelUrl: entry.model,
    wasmUrl: entry.model_lib,
    cachedAssets,
    shaderF16,
    gpuFeatures: [...adapter.features].sort(),
  };
}

window.__cvSmoke = {
  load: loadedModel,
  async ask(question) {
    const answer = await voiceEngine.ask(question);
    return typeof answer === "string" && answer.trim().length > 0;
  },
  clear() {},
} satisfies SmokePage;
