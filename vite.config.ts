import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig, type Plugin } from "vite-plus";

type CvPipelineModule = {
  ensureCvArtifacts: () => Promise<void>;
};

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
  plugins: [react(), cvArtifactsPlugin()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        cv: resolve(__dirname, "cv/index.html"),
      },
    },
  },
});
