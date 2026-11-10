export const PARADEE_CACHE = "paradee-models-v1-330617ad1f097b4f6b02c103e54b39006c090b45";
export const PARADEE_ASSETS = [
  { url: "/models/sahilmahendrakar/Paradee-8M-v1.1/config.json", bytes: 1774, sha256: "c3f420e8a5aea41b97f698404a1b1e28e403c662f65927345335fc5493f2e075" },
  { url: "/models/sahilmahendrakar/Paradee-8M-v1.1/onnx/paradee_int8.onnx", bytes: 8461438, sha256: "665c3cce6d9872e24bd43db4aa19d3b9c224cdeb6d79b0814190e1c2e43defbc" },
  { url: "/models/sahilmahendrakar/Paradee-8M-v1.1/tokenizer.json", bytes: 3497, sha256: "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34" },
] as const;

/** Verify even cached responses: stale or damaged bytes must never reach inference. */
export async function readParadeeAsset(asset: { url: string; bytes: number; sha256: string }): Promise<ArrayBuffer> {
  const cache = await caches.open(PARADEE_CACHE);
  const verify = async (response: Response | undefined): Promise<ArrayBuffer | null> => {
    if (!response?.ok) return null;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== asset.bytes) return null;
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return hex === asset.sha256 ? bytes : null;
  };
  const cached = await verify(await cache.match(asset.url));
  if (cached) return cached;
  await cache.delete(asset.url);
  const response = await fetch(asset.url);
  const bytes = await verify(response.clone());
  if (!bytes) throw new Error("Invalid speech model asset");
  await cache.put(asset.url, response);
  return bytes;
}

export async function pruneParadeeCaches(): Promise<void> {
  for (const name of await caches.keys()) {
    if (name.startsWith("paradee-models-") && name !== PARADEE_CACHE) await caches.delete(name);
  }
}
