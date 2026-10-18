/**
 * Minimal static file server for local production checks.
 *
 * Unlike `vite preview`, it deliberately sends **no** COOP/COEP headers so the
 * service worker's cross-origin-isolation path can be exercised the same way
 * GitHub Pages serves the site.
 *
 *   pnpm build
 *   node scripts/serve-dist.mjs dist 4174
 *   # then open http://localhost:4174/?sw=1
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = process.argv[2] ?? "dist";
const port = Number(process.argv[3] ?? 4174);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://localhost:${port}`);
    let pathname = normalize(decodeURIComponent(url.pathname));

    if (pathname.endsWith("/")) pathname += "index.html";

    let filePath = join(root, pathname);
    try {
      const info = await stat(filePath);
      if (info.isDirectory()) filePath = join(filePath, "index.html");
    } catch {
      // Single-page fallback.
      filePath = join(root, "index.html");
    }

    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
    });
    response.end(body);
  } catch (error) {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end(String(error));
  }
}).listen(port, () => {
  console.log(`[serve-dist] http://localhost:${port} (no COOP/COEP headers)`);
});
