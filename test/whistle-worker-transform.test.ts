import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transformWithOxc } from "vite";

const workerUrl = new URL("../src/chat/stt/whistle/worker.ts", import.meta.url);
const workerFilename = fileURLToPath(workerUrl);
const transformOptions = { lang: "ts" } as const;

async function transformTypeScript(source: string, filename: string): Promise<string> {
  return (await transformWithOxc(source, filename, transformOptions)).code;
}

function assertClassicScript(code: string, filename: string): void {
  new Script(code, { filename });
}

test("the installed Vite 8.3.1 transform keeps the Whistle worker a classic script", async () => {
  const vitePackage = JSON.parse(
    await readFile(new URL("../node_modules/vite/package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  assert.equal(vitePackage.version, "8.3.1");

  const source = await readFile(workerUrl, "utf8");
  const { code } = await transformWithOxc(source, workerFilename, transformOptions);

  assertClassicScript(code, workerFilename);
  assert.match(code, /\bimportScripts\s*\(\s*runtimeUrl\s*\)/);
  assert.doesNotMatch(code, /^\s*(?:import|export)\s/m);
});

test("the classic-script guard rejects the legacy module-form TypeScript import", async () => {
  const legacyFilename = workerFilename.replace(/worker\.ts$/, "legacy-worker.ts");
  const legacySource = [
    'import { type SttRequest } from "./protocol.ts";',
    "type LegacyRequest = SttRequest;",
    'const request: LegacyRequest = { type: "start" };',
    "void request;",
    'importScripts("needle.js");',
  ].join("\n");
  const code = await transformTypeScript(legacySource, legacyFilename);

  assert.match(code, /^\s*import\s+["']\.\/protocol\.ts["'];?$/m);
  assert.throws(
    () => assertClassicScript(code, legacyFilename),
    /Cannot use import statement outside a module/,
  );
});
