import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "vite";

test("the real model asset serve plugin returns the cached needle.js with JavaScript MIME", { timeout: 30_000 }, async () => {
  process.env.OFFLINE_CHAT_QA_ONLY = "1";
  const { modelAssetsServePlugin } = await import("../vite.config.ts");
  const { MODEL_ASSET_SETS } = await import("../scripts/model-assets.mjs");
  const pin = MODEL_ASSET_SETS.flatMap((set) => set.files.map((file) => ({ route: `${set.route}${file.name}`, file })))
    .find((entry) => entry.file.name === "needle.js");
  assert.ok(pin, "the installed pinned model set must contain needle.js");

  const root = await mkdtemp(join(tmpdir(), "model-asset-serve-route-"));
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    server = await createServer({
      configFile: false,
      root,
      envDir: false,
      publicDir: false,
      cacheDir: join(root, ".vite-cache"),
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true, include: [] },
      server: {
        host: "127.0.0.1",
        port: 5192,
        strictPort: true,
        hmr: false,
        watch: null,
        fs: { strict: true, allow: [root] },
      },
      plugins: [modelAssetsServePlugin()],
    });
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}${pin.route}`, { signal: AbortSignal.timeout(10_000) });
    const bytes = Buffer.from(await response.arrayBuffer());

    assert.equal(response.status, 200);
    assert.equal(bytes.byteLength, pin.file.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.file.sha256);
    assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(response.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  } finally {
    if (server) await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
