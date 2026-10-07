import react from "@vitejs/plugin-react";
import { createReadStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineConfig, type Plugin } from "vite";

import {
  ORT_PACKAGE,
  ORT_ROUTE,
  ORT_RUNTIME_ASSETS,
  ORT_RUNTIME_VERSION,
} from "./src/chat/retrieval/encoder/runtime-assets.ts";
import { MODEL_ASSETS_CACHE, MODEL_ASSET_SETS } from "./scripts/model-assets.mjs";

type CvPipelineModule = {
  ensureCvArtifacts: () => Promise<void>;
};

export const crossOriginIsolationHeaders = {
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

/**
 * The pinned ONNX Runtime Web files, served as static files instead of from a CDN.
 *
 * The embedding runtime's own default is a third-party CDN URL carrying the locked runtime
 * version. That is version-pinned but it is not this project's bytes, so the retrieval
 * module names same-origin URLs instead and this route serves them from the installed
 * locked package.
 *
 * This is not the Moonshine rule copied onto an unrelated package. Moonshine ships
 * unminified because bundling it breaks speech recognition; here the two files are plain
 * static assets kept out of the JavaScript graph and out of the module worker's bundle.
 * Their digests are recorded in `runtime-assets.ts` and proven by the headed retrieval QA
 * run, not hashed on every start-up.
 *
 * The route serves only the two recorded names, so the second WebAssembly pair the
 * library's default path template would name is never emitted or served. The
 * cross-origin isolation headers are the site's own, because the page is isolated for
 * speech recognition; the retrieval path itself runs single-threaded and does not need
 * them.
 */
function resolveOnnxRuntimeDist(): string {
  // pnpm keeps the locked runtime in the store, so the version is part of the path.
  const stored = resolve(
    process.cwd(),
    "node_modules",
    ".pnpm",
    `${ORT_PACKAGE}@${ORT_RUNTIME_VERSION}`,
    "node_modules",
    ORT_PACKAGE,
    "dist",
  );
  const candidates = [stored, resolve(process.cwd(), "node_modules", ORT_PACKAGE, "dist")];

  const found = candidates.find((candidate) => ORT_RUNTIME_ASSETS.every((asset) => existsSync(join(candidate, asset.name))));

  if (found === undefined) {
    throw new Error(
      `[onnxruntime-assets] could not locate the pinned ${ORT_PACKAGE} ${ORT_RUNTIME_VERSION} runtime. Checked: ${candidates.join(", ")}`,
    );
  }

  const installedVersion = JSON.parse(
    readFileSync(join(found, "..", "package.json"), "utf8"),
  )?.version;

  if (installedVersion !== ORT_RUNTIME_VERSION) {
    throw new Error(
      `[onnxruntime-assets] installed ${ORT_PACKAGE} is ${String(installedVersion)}, not the pinned ${ORT_RUNTIME_VERSION}`,
    );
  }

  return found;
}

export function onnxRuntimeServePlugin(): Plugin {
  const distDir = resolveOnnxRuntimeDist();

  return {
    name: "onnxruntime-assets-serve",
    apply: "serve",

    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = (request.url ?? "").split("?")[0];
        if (!pathname.startsWith(ORT_ROUTE)) return next();

        const name = pathname.slice(ORT_ROUTE.length);
        const asset = ORT_RUNTIME_ASSETS.find((candidate) => candidate.name === name);

        if (asset === undefined) return next();

        const file = join(distDir, name);
        if (!existsSync(file)) return next();

        response.setHeader("Content-Type", asset.contentType);
        response.setHeader("Cache-Control", "no-cache");
        for (const [header, value] of Object.entries(crossOriginIsolationHeaders)) {
          response.setHeader(header, value);
        }
        response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        createReadStream(file).pipe(response);
      });
    },
  };
}

function onnxRuntimeBuildPlugin(): Plugin {
  const distDir = resolveOnnxRuntimeDist();

  return {
    name: "onnxruntime-assets-build",
    apply: "build",

    async buildStart() {
      for (const asset of ORT_RUNTIME_ASSETS) {
        this.emitFile({
          type: "asset",
          fileName: `${ORT_ROUTE.slice(1)}${asset.name}`,
          source: await readFile(join(distDir, asset.name)),
        });
      }
    },
  };
}

/**
 * The self-hosted model and font assets: served from the external cache in development,
 * emitted into the build output.
 *
 * `scripts/model-assets.mjs` pins every file (route, bytes, sha256, source, license) and
 * `scripts/fetch-model-assets.mjs` keeps the verified bytes in
 * `~/.cache/cv-assistant/model-assets/`. These plugins only map a pinned route to that
 * cache file, so the embedding model, the Moonshine and Pocket TTS model weights, the
 * Pocket TTS ONNX Runtime files and the web fonts all load from this site's own origin in
 * development and in production, with the same header policy as the Moonshine and ONNX
 * runtime routes (isolation headers for worker scripts, `Cross-Origin-Resource-Policy:
 * same-origin`, no cache in development).
 *
 * A request is matched against the pinned route table, never joined from request text,
 * so a path outside the manifest cannot reach the filesystem. A missing cache file fails
 * the build with the command that creates it instead of shipping a hole in `dist/`.
 */
const MODELS_ROUTE = "/models/";
const FONTS_ROUTE = "/fonts/";

const modelAssetRoutes = new Map<string, string>();
for (const set of MODEL_ASSET_SETS) {
  for (const file of set.files) {
    modelAssetRoutes.set(
      `${set.route}${file.name}`,
      join(MODEL_ASSETS_CACHE, set.id, set.rev, file.name),
    );
  }
}

const modelAssetContentTypes: Record<string, string> = {
  ".bin": "application/octet-stream",
  ".json": "application/json",
  ".model": "application/octet-stream",
  ".mjs": "text/javascript; charset=utf-8",
  ".onnx": "application/octet-stream",
  ".ort": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
};

function isModelAssetPath(pathname: string): boolean {
  return pathname.startsWith(MODELS_ROUTE) || pathname.startsWith(FONTS_ROUTE);
}

export function modelAssetsServePlugin(): Plugin {
  return {
    name: "model-assets-serve",
    apply: "serve",

    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = (request.url ?? "").split("?")[0];
        if (!isModelAssetPath(pathname)) return next();

        const file = modelAssetRoutes.get(pathname);
        if (file === undefined || !existsSync(file)) return next();

        response.setHeader(
          "Content-Type",
          modelAssetContentTypes[extname(pathname)] ?? "application/octet-stream",
        );
        response.setHeader("Cache-Control", "no-cache");
        for (const [header, value] of Object.entries(crossOriginIsolationHeaders)) {
          response.setHeader(header, value);
        }
        response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        createReadStream(file).pipe(response);
      });
    },
  };
}

function modelAssetsBuildPlugin(): Plugin {
  return {
    name: "model-assets-build",
    apply: "build",

    async buildStart() {
      for (const [route, file] of modelAssetRoutes) {
        if (!existsSync(file)) {
          throw new Error(
            `[model-assets] missing cached file for ${route}; run node scripts/fetch-model-assets.mjs`,
          );
        }
        this.emitFile({ type: "asset", fileName: route.slice(1), source: await readFile(file) });
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
  plugins: [
    react(),
    cvArtifactsPlugin(),
    moonshineRuntimeServePlugin(),
    moonshineRuntimeBuildPlugin(),
    onnxRuntimeServePlugin(),
    onnxRuntimeBuildPlugin(),
    modelAssetsServePlugin(),
    modelAssetsBuildPlugin(),
  ],
  // Pocket TTS resolves its worker and WASM assets at runtime; Vite's
  // dependency optimizer would otherwise rewrite them to missing URLs.
  optimizeDeps: {
    exclude: ["pocket-tts-js"],
  },
  // onnxruntime-web only exposes its non-bundled entry under this condition. The bundled
  // entry embeds its WASM URLs, so the build emits a 26 MB asyncify asset the page never
  // loads: the worker names the pinned jsep pair through ORT_WASM_PATHS instead, served
  // from /ort/. Vite replaces the default condition list rather than extending it, so the
  // client defaults are restated here next to the added condition.
  resolve: {
    conditions: ["module", "browser", "development|production", "onnxruntime-web-use-extern-wasm"],
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
        // The private retrieval QA page is only built when the headed check asks for it,
        // so a production build never ships a second entry. In development it is served
        // from its own path without this flag.
        ...(process.env.RETRIEVAL_QA === "1"
          ? { "qa-retrieval": resolve(import.meta.dirname, "qa/retrieval.html") }
          : {}),
      },
      output: {
        // The site entry mounts the app into #root at module top level, and the retrieval
        // QA document shares chunks with it but has no #root, so shared code must never
        // drag the mount into the QA page: the entry module stays in its own chunk, which
        // only index.html loads.
        manualChunks(id) {
          if (id === resolve(import.meta.dirname, "src/entries/home.tsx")) return "site-entry";
          return undefined;
        },
      },
    },
  },
});
