/** Dev-only installed-pair guard. Static hosts and built preview are not source-root servers. */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { assertNoAudioGenerationLock } from "./final-output.mjs";
import { createAudioSourceInventory } from "./catalog.mjs";
import { validateCatalogCorpusV2 } from "../cv-audio.mjs";

export function createDevPairGuard({ factsPath, audioDirectory, checkFacts }) {
  return async function assertCompletePair() {
    await assertNoAudioGenerationLock(audioDirectory);
    // Always read completion first. Direct regeneration removes it before changing any MP3.
    const manifestBytes = await readFile(join(audioDirectory, "manifest.json"));
    const facts = await readFile(factsPath);
    await checkFacts();
    await assertNoAudioGenerationLock(audioDirectory);
    const inventory = createAudioSourceInventory(facts);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    await validateCatalogCorpusV2({ directory: audioDirectory, manifest, inventory });
    const expected = new Set(["manifest.json", ...manifest.clips.map((clip) => clip.file)]);
    const entries = await readdir(audioDirectory, { withFileTypes: true });
    if (entries.length !== expected.size || entries.some((entry) => !entry.isFile() || !expected.has(entry.name))) {
      throw new Error("manifest/directory-entry-mismatch");
    }
    // Reject completion invalidated during the full check, not only on the next request.
    if (!(await readFile(join(audioDirectory, "manifest.json"))).equals(manifestBytes) ||
        !(await readFile(factsPath)).equals(facts)) throw new Error("manifest/pair-changed");
    await assertNoAudioGenerationLock(audioDirectory);
  };
}

/** Runs in Vite's pre-static middleware chain, including on an already-running server. */
export function createDevPairMiddleware(assertCompletePair) {
  return (_request, response, next) => {
    void assertCompletePair().then(() => next(), () => {
      response.statusCode = 503;
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end("CV facts/audio pair incomplete. Run both installed-pair checks before serving.\n");
    });
  };
}
