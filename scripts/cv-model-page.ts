import { voiceEngine } from "../src/chat/engine";

type SmokePage = Window["__cvSmoke"];

async function loadedModel() {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("webgpu-unavailable");

  const shaderF16 = adapter.features.has("shader-f16");
  await voiceEngine.ensureLlm();
  // The engine reports where the pair is served from; the prebuilt registry is
  // not involved, because the site ships the pair itself.
  const assets = voiceEngine.llmAssets;
  if (!assets) throw new Error("model-identity-unavailable");
  const modelId = voiceEngine.modelLabel;
  if (modelId !== assets.modelId) throw new Error("model-identity-mismatch");

  const cachedAssets: Array<{ url: string; sha256: string; bytes: number }> = [];
  for (const cacheName of await caches.keys()) {
    const cache = await caches.open(cacheName);
    for (const request of await cache.keys()) {
      if (!request.url.startsWith(assets.modelUrl) && request.url !== assets.libraryUrl) continue;
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
  if (!cachedAssets.some((asset) => asset.url === assets.libraryUrl) ||
      !cachedAssets.some((asset) => asset.url.startsWith(assets.modelUrl) && asset.url !== assets.modelUrl)) {
    throw new Error("cached-artifact-identity-unverified");
  }

  return {
    modelId,
    modelUrl: assets.modelUrl,
    wasmUrl: assets.libraryUrl,
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
