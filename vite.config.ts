import react from "@vitejs/plugin-react";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineConfig, type Plugin } from "vite";

type CvPipelineModule = {
  ensureCvArtifacts: () => Promise<void>;
};

const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

/**
 * Moonshine browser runtime, served as static files instead of being bundled.
 *
 * Minifying the upstream Emscripten and streaming code makes speech recognition
 * fail silently (audio is captured, no transcript is produced), so the runtime
 * must ship unmodified. Serving it from a URL also keeps the 13 MB WASM out of
 * the JS graph and gives the service worker plain same-origin files to cache.
 *
 * The runtime cannot live in `public/`: Vite refuses to load `public/` URLs from
 * source code. This plugin serves the package's `dist/` directory at
 * `/moonshine/` during development and emits the same files into the build
 * output, so the runtime URL is identical in dev, preview and production.
 */
const MOONSHINE_ROUTE = "/moonshine/";

const moonshineContentTypes: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

function resolveMoonshineDist(): string {
  const candidates: string[] = [];

  try {
    candidates.push(dirname(fileURLToPath(import.meta.resolve("@moonshine-ai/moonshine-wasm"))));
  } catch {
    // The package only declares an "import" condition; fall back to the layout.
  }

  candidates.push(resolve(process.cwd(), "node_modules", "@moonshine-ai", "moonshine-wasm", "dist"));

  const found = candidates.find((candidate) => existsSync(join(candidate, "index.js")));
  if (!found) {
    throw new Error(
      `[moonshine-runtime] could not locate the Moonshine runtime. Checked: ${candidates.join(", ")}`,
    );
  }
  return found;
}

function listMoonshineFiles(distDir: string): string[] {
  return readdirSync(distDir).filter(
    (name) => !name.endsWith(".map") && !name.endsWith(".d.ts") && !name.endsWith(".d.cts"),
  );
}

function moonshineRuntimeServePlugin(): Plugin {
  const distDir = resolveMoonshineDist();

  return {
    name: "moonshine-runtime-serve",
    apply: "serve",

    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = (request.url ?? "").split("?")[0];
        if (!pathname.startsWith(MOONSHINE_ROUTE)) return next();

        const name = pathname.slice(MOONSHINE_ROUTE.length);
        if (!name || name.includes("/") || name.includes("..")) return next();

        const file = join(distDir, name);
        if (!existsSync(file)) return next();

        response.setHeader(
          "Content-Type",
          moonshineContentTypes[extname(name)] ?? "application/octet-stream",
        );
        response.setHeader("Cache-Control", "no-cache");
        // Same headers the service worker adds in production. Without them
        // Chrome blocks the pthread worker scripts in a cross-origin isolated
        // page with `coep-frame-resource-needs-coep-header`.
        for (const [header, value] of Object.entries(crossOriginIsolationHeaders)) {
          response.setHeader(header, value);
        }
        response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        createReadStream(file).pipe(response);
      });
    },
  };
}

function moonshineRuntimeBuildPlugin(): Plugin {
  const distDir = resolveMoonshineDist();

  return {
    name: "moonshine-runtime-build",
    apply: "build",

    async buildStart() {
      for (const name of listMoonshineFiles(distDir)) {
        this.emitFile({
          type: "asset",
          fileName: `moonshine/${name}`,
          source: await readFile(join(distDir, name)),
        });
      }
    },
  };
}

async function loadCvPipeline(): Promise<CvPipelineModule> {
  const moduleUrl = pathToFileURL(
    resolve(process.cwd(), "scripts/cv-pipeline.mjs"),
  ).href;

  return (await import(moduleUrl)) as CvPipelineModule;
}

function cvArtifactsPlugin(): Plugin {
  return {
    name: "cv-artifacts",
    async buildStart() {
      const { ensureCvArtifacts } = await loadCvPipeline();
      await ensureCvArtifacts();
    },
    async handleHotUpdate(context) {
      const normalizedPath = context.file.replaceAll("\\", "/");

      if (!normalizedPath.endsWith("/resources/cv/source/cv.md")) {
        return;
      }

      const { ensureCvArtifacts } = await loadCvPipeline();
      await ensureCvArtifacts();
    },
  };
}

export default defineConfig({
  plugins: [react(), cvArtifactsPlugin(), moonshineRuntimeServePlugin(), moonshineRuntimeBuildPlugin()],
  // Pocket TTS resolves its worker and WASM assets at runtime; Vite's
  // dependency optimizer would otherwise rewrite them to missing URLs.
  optimizeDeps: {
    exclude: ["pocket-tts-js"],
  },
  worker: {
    format: "es",
  },
  // Cross-origin isolation is required by Moonshine's threaded WASM build.
  // In production the service worker adds these headers to same-origin
  // responses (public/sw.js); the dev and preview servers set them directly.
  server: {
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  build: {
    target: "esnext",
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
      },
    },
  },
});
