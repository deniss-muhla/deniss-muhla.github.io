import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs, { renameSync, writeFileSync } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { AUDIO_CATALOG_TEXT } from "../src/chat/audio-catalog.ts";
// @ts-expect-error Node-only implementation modules expose the stage and encoder process ports.
import { runKittenStage } from "../scripts/cv-audio/kitten-stage.mjs";
// @ts-expect-error Node-only implementation modules are exercised through their safe exported ports.
import { audioProcessTest, MAX_V2_AUDIO_BYTES, parseMp3, validateCatalogCorpusV2 } from "../scripts/cv-audio.mjs";
import { createAudioSourceInventory } from "../scripts/cv-audio/catalog.mjs";
import { contentSha256, PINNED_EMBEDDING } from "../scripts/cv-facts/artifact.mjs";
// @ts-expect-error The Node-only final-output helper has no browser-facing declarations.
import { writeFinalManifest } from "../scripts/cv-audio/final-output.mjs";

const execFileAsync = promisify(execFile);
const digest = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
type StageError = Error & { code?: string; stageDirectory?: string | null; workspaceRoot?: string | null; activityPath?: string | null };
type StageFixture = Awaited<ReturnType<typeof fixture>>;
type StagePorts = {
  preflight?: (options: Record<string, any>) => Promise<any>;
  checkFinalFacts?: () => Promise<any>;
  generateAudio: (options: Record<string, any>) => Promise<any>;
  encodeWav: (wavPath: string, mp3Path: string) => Promise<void>;
  parseMp3: (bytes: Buffer) => any;
  validateCorpus: (options: Record<string, any>) => Promise<any>;
  maxAudioBytes: number;
};

type SyntheticCard = { id: string; answer: string; topic: string };

function factsBytes(cards: SyntheticCard[] = [
  { id: "synthetic-alpha", answer: "Synthetic answer alpha.", topic: "Synthetic topic alpha" },
  { id: "synthetic-beta", answer: "Synthetic answer beta.", topic: "Synthetic topic beta" },
]): Buffer {
  return Buffer.from(JSON.stringify({ cards }), "utf8");
}

async function fixture(input?: Buffer | SyntheticCard[], options: { packageSources?: boolean } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "cv-audio-kitten-stage-test-"));
  const factsPath = join(root, "facts.synthetic.json");
  const bytes = Buffer.isBuffer(input) ? input : factsBytes(input);
  await writeFile(factsPath, bytes, { flag: "wx" });

  const runtimeRoot = join(root, "runtime");
  const sdkRoot = join(runtimeRoot, "sdk");
  const hubCache = join(runtimeRoot, "hub");
  const modelSnapshot = join(hubCache, "models", "snapshot");
  const archive = join(runtimeRoot, "sdk.tar.gz");
  const pythonPrefix = join(runtimeRoot, "venv");
  const pythonExecutable = join(pythonPrefix, "bin", "python");
  const sandboxExecutable = join(runtimeRoot, "sandbox");
  const modulePaths = Array.from({ length: 88 }, (_, index) => join(runtimeRoot, "module-roots", String(index).padStart(2, "0")));
  await Promise.all([
    mkdir(sdkRoot, { recursive: true }),
    mkdir(modelSnapshot, { recursive: true }),
    mkdir(join(runtimeRoot, "venv", "bin"), { recursive: true }),
    ...modulePaths.map((path) => mkdir(path, { recursive: true })),
  ]);
  await writeFile(archive, "synthetic SDK archive", { flag: "wx" });
  await writeFile(pythonExecutable, "synthetic executable", { flag: "wx" });
  await writeFile(sandboxExecutable, "synthetic executable", { flag: "wx" });
  await chmod(pythonExecutable, 0o700);
  await chmod(sandboxExecutable, 0o700);
  const modulePathsFile = join(runtimeRoot, "module-paths.json");
  const moduleRecord: Record<string, unknown> = { modulePaths };
  if (options.packageSources) {
    moduleRecord.packageSources = Object.fromEntries(modulePaths.map((_, index) => [
      `synthetic-package-${String(index).padStart(2, "0")}`,
      `synthetic-source-${String(index).padStart(2, "0")}`,
    ]));
  }
  await writeFile(modulePathsFile, JSON.stringify(moduleRecord), { flag: "wx" });
  const runtimeInputsPath = join(runtimeRoot, "runtime-inputs.json");
  await writeFile(runtimeInputsPath, JSON.stringify({
    version: 1,
    pythonExecutable,
    sandboxExecutable,
    sdkRoot,
    sdkArchive: archive,
    modelSnapshot,
    hubCache,
    modulePathsFile,
  }), { flag: "wx" });
  return {
    root,
    factsPath,
    factsBytes: bytes,
    factsSha256: digest(bytes),
    runtimeInputsPath,
    stagePath: join(root, "stage-out"),
    runtimeRoot,
    sdkRoot,
    hubCache,
    modelSnapshot,
    pythonPrefix,
    pythonExecutable,
    modulePaths,
  };
}

function syntheticWav(): Buffer {
  const payload = Buffer.alloc(480 * 2);
  for (let index = 0; index < 480; index += 1) payload.writeInt16LE(index % 2 ? 4500 : -4500, index * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + payload.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(payload.length, 40);
  return Buffer.concat([header, payload]);
}

function syntheticMp3(frameCount = 2): Buffer {
  const frameBytes = 96;
  const bytes = Buffer.alloc(frameBytes * frameCount);
  const header = (0xffe00000 | (2 << 19) | (1 << 17) | (1 << 16) | (4 << 12) | (1 << 10) | (3 << 6)) >>> 0;
  for (let offset = 0; offset < bytes.length; offset += frameBytes) bytes.writeUInt32BE(header, offset);
  return bytes;
}

function fakePorts(
  mp3 = syntheticMp3(),
  options: { failAt?: number; foreignStageOutput?: (stagePath: string, itemId: string) => Promise<void>; mutateFacts?: (path: string, call: number) => Promise<void>; beforeReturn?: (stagePath: string, itemId: string) => Promise<void> } = {},
) {
  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;
  const ports: StagePorts = {
    async preflight() {},
    async generateAudio(request) {
      calls.push(request.text);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const call = calls.length;
      try {
        if (options.failAt === call) throw new Error("synthetic adapter failure");
        const wav = syntheticWav();
        await writeFile(request.outputWav, wav, { flag: "wx" });
        await writeFile(request.metadataPath, JSON.stringify({ status: "synthetic-provenance" }), { flag: "wx" });
        if (options.foreignStageOutput) await options.foreignStageOutput(request.stagePath ?? "", request.id ?? "");
        if (options.beforeReturn) await options.beforeReturn(request.stagePath ?? "", request.id ?? "");
        if (options.mutateFacts) await options.mutateFacts(request.factsPath ?? "", call);
        return { status: "ok", audio: { path: request.outputWav, bytes: wav.length, sha256: digest(wav) } };
      } finally {
        active -= 1;
      }
    },
    async encodeWav(wavPath, mp3Path) {
      await readFile(wavPath);
      await writeFile(mp3Path, mp3, { flag: "wx" });
    },
    parseMp3,
    validateCorpus: validateCatalogCorpusV2,
    maxAudioBytes: MAX_V2_AUDIO_BYTES,
  };
  return { ports, calls, maxActive: () => maxActive };
}

function stageArgs(value: StageFixture, ports: StagePorts, overrides: Record<string, unknown> = {}) {
  return {
    factsPath: value.factsPath,
    factsSha256: value.factsSha256,
    runtimeInputsPath: value.runtimeInputsPath,
    stagePath: value.stagePath,
    deadlineMinutes: 168,
    greeting: AUDIO_CATALOG_TEXT.greeting,
    ports,
    ...overrides,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") return false;
    throw error;
  }
}

async function cleanup(value: StageFixture, workspaceRoot?: string | null, extra: string[] = []) {
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  await rm(value.root, { recursive: true, force: true });
  for (const path of extra) await rm(path, { recursive: true, force: true });
}

test("Kitten stage CLI rejects missing and conflicting flags before reading inputs", async () => {
  const script = new URL("../scripts/cv-audio.mjs", import.meta.url).pathname;
  await assert.rejects(execFileAsync(process.execPath, [script, "--kitten-stage"], { timeout: 5000 }), (error: any) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /cli\/kitten-stage-arguments-required/);
    return true;
  });
  await assert.rejects(execFileAsync(process.execPath, [script, "--kitten-stage", "--check"], { timeout: 5000 }), (error: any) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /cli\/mode-conflict/);
    return true;
  });
  await assert.rejects(execFileAsync(process.execPath, [script], { timeout: 5000 }), (error: any) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /cli\/mode-required/);
    return true;
  });
  await assert.rejects(execFileAsync(process.execPath, [script, "--facts", "/tmp/synthetic-facts.json"], { timeout: 5000 }), (error: any) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /cli\/kitten-stage-required/);
    return true;
  });
  const required = [
    "--kitten-stage", "--facts", "/tmp/synthetic-facts.json", "--facts-sha256", "a".repeat(64),
    "--runtime-inputs", "/tmp/runtime-inputs.json", "--stage", "/tmp/new-stage",
  ];
  for (const deadline of ["0", "169", "180"]) {
    await assert.rejects(execFileAsync(process.execPath, [script, ...required, "--deadline-minutes", deadline], { timeout: 5000 }), (error: any) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /cli\/deadline-invalid/);
      return true;
    });
  }
  await assert.rejects(execFileAsync(process.execPath, [script, ...required, "--deadline-minutes", "168", "--reuse-inputs", "/tmp/obsolete-reuse-inputs.json"], { timeout: 5000 }), (error: any) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /cli\/unknown-option/);
    return true;
  });
});

test("whole-inventory text and facts-digest preflight block every adapter call and stage creation", async () => {
  const stale = await fixture();
  const staleFake = fakePorts();
  try {
    await assert.rejects(runKittenStage(stageArgs(stale, staleFake.ports, { factsSha256: "0".repeat(64) })), (error: StageError) => {
      assert.equal(error.code, "input/facts-digest-mismatch");
      return true;
    });
    assert.equal(staleFake.calls.length, 0);
    await assert.rejects(readFile(stale.stagePath));
  } finally {
    await cleanup(stale);
  }

  const invalid = await fixture([
    { id: "synthetic-alpha", answer: "Synthetic answer alpha.", topic: "Synthetic topic alpha" },
    { id: "synthetic-beta", answer: "Synthetic answer beta.", topic: `line\nbreak ${"x".repeat(2001)}` },
  ]);
  const invalidFake = fakePorts();
  try {
    await assert.rejects(runKittenStage(stageArgs(invalid, invalidFake.ports)), (error: StageError) => {
      assert.equal(error.code, "source/item-text-invalid");
      return true;
    });
    assert.equal(invalidFake.calls.length, 0);
    await assert.rejects(readFile(invalid.stagePath));
  } finally {
    await cleanup(invalid);
  }
});

test("runtime path cardinality and aliased facts or stage targets are rejected before generation", async () => {
  const shortMap = await fixture();
  const shortMapPath = join(shortMap.root, "runtime", "module-paths.json");
  await writeFile(shortMapPath, JSON.stringify({ modulePaths: shortMap.modulePaths.slice(0, 87) }));
  const shortMapFake = fakePorts();
  try {
    await assert.rejects(runKittenStage(stageArgs(shortMap, shortMapFake.ports)), (error: StageError) => {
      assert.equal(error.code, "input/module-paths-invalid");
      return true;
    });
    assert.equal(shortMapFake.calls.length, 0);
    await assert.rejects(readFile(shortMap.stagePath));
  } finally {
    await cleanup(shortMap);
  }

  const aliasedFacts = await fixture();
  const realFacts = `${aliasedFacts.factsPath}.real`;
  await rename(aliasedFacts.factsPath, realFacts);
  await symlink(realFacts, aliasedFacts.factsPath);
  const aliasedFactsFake = fakePorts();
  try {
    await assert.rejects(runKittenStage(stageArgs(aliasedFacts, aliasedFactsFake.ports)), (error: StageError) => {
      assert.equal(error.code, "input/facts-path-aliased");
      return true;
    });
    assert.equal(aliasedFactsFake.calls.length, 0);
  } finally {
    await cleanup(aliasedFacts);
  }

  const aliasedStage = await fixture();
  const realStage = `${aliasedStage.stagePath}.real`;
  await mkdir(realStage);
  await symlink(realStage, aliasedStage.stagePath);
  const aliasedStageFake = fakePorts();
  try {
    await assert.rejects(runKittenStage(stageArgs(aliasedStage, aliasedStageFake.ports)), (error: StageError) => {
      assert.equal(error.code, "stage/already-exists");
      return true;
    });
    assert.equal(aliasedStageFake.calls.length, 0);
    assert.equal((await readdir(realStage)).length, 0);
  } finally {
    await cleanup(aliasedStage);
  }
});

test("protected runtime roots reject nested stage paths before creation or adapter calls", async (t) => {
  const value = await fixture();
  const protectedStagePaths: Array<[string, string]> = [
    ["SDK root", join(value.sdkRoot, "nested-stage")],
    ["Python environment prefix", join(value.pythonPrefix, "nested-stage")],
    ["model snapshot", join(value.modelSnapshot, "nested-stage")],
    ["hub cache", join(value.hubCache, "nested-stage")],
    ["module root", join(value.modulePaths[0], "nested-stage")],
  ];
  try {
    for (const [label, stagePath] of protectedStagePaths) {
      await t.test(label, async () => {
        const fake = fakePorts();
        let summary: any;
        let caught: StageError | undefined;
        try { summary = await runKittenStage(stageArgs(value, fake.ports, { stagePath })); }
        catch (error) { caught = error as StageError; }
        const observed = {
          code: caught?.code ?? null,
          adapterCalls: fake.calls.length,
          stageCreated: await pathExists(stagePath),
          workspaceRoot: summary?.workspaceRoot ?? caught?.workspaceRoot ?? null,
        };
        try {
          assert.deepEqual(observed, {
            code: "stage/runtime-path-protected",
            adapterCalls: 0,
            stageCreated: false,
            workspaceRoot: null,
          }, `${label} protection must happen before either output root or adapter call`);
        } finally {
          const workspaceRoot = summary?.workspaceRoot ?? caught?.workspaceRoot;
          if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
          await rm(stagePath, { recursive: true, force: true });
        }
      });
    }
  } finally {
    await cleanup(value);
  }
});

test("canonical runtime directory aliases are included in protected stage roots", async () => {
  const value = await fixture();
  const alias = join(value.runtimeRoot, "hub-cache-alias");
  await symlink(value.hubCache, alias);
  const runtime = JSON.parse(await readFile(value.runtimeInputsPath, "utf8"));
  runtime.hubCache = alias;
  await writeFile(value.runtimeInputsPath, JSON.stringify(runtime));
  const stagePath = join(value.hubCache, "canonical-alias-stage");
  const fake = fakePorts();
  let summary: any;
  let caught: StageError | undefined;
  try {
    try { summary = await runKittenStage(stageArgs(value, fake.ports, { stagePath })); }
    catch (error) { caught = error as StageError; }
    assert.deepEqual({
      code: caught?.code ?? null,
      adapterCalls: fake.calls.length,
      stageCreated: await pathExists(stagePath),
      workspaceRoot: summary?.workspaceRoot ?? caught?.workspaceRoot ?? null,
    }, {
      code: "stage/runtime-path-protected",
      adapterCalls: 0,
      stageCreated: false,
      workspaceRoot: null,
    }, "the symlink spelling of hubCache must protect its canonical target");
  } finally {
    await cleanup(value, summary?.workspaceRoot ?? caught?.workspaceRoot);
  }
});

test("workspace temporary roots inside runtime caches are refused before stage creation", async () => {
  const value = await fixture();
  const protectedTempRoot = join(value.sdkRoot, "temporary-workspaces");
  const protectedTempAlias = join(value.runtimeRoot, "sdk-workspace-alias");
  await mkdir(protectedTempRoot);
  await symlink(protectedTempRoot, protectedTempAlias);
  const originalTmpdir = process.env.TMPDIR;
  const fake = fakePorts();
  let summary: any;
  let caught: StageError | undefined;
  try {
    process.env.TMPDIR = protectedTempAlias;
    assert.equal(tmpdir(), protectedTempAlias, "the test must exercise the scoped synthetic TMPDIR alias");
    try { summary = await runKittenStage(stageArgs(value, fake.ports)); }
    catch (error) { caught = error as StageError; }
    assert.deepEqual({
      code: caught?.code ?? null,
      adapterCalls: fake.calls.length,
      stageCreated: await pathExists(value.stagePath),
      tempChildren: await readdir(protectedTempRoot),
      workspaceRoot: summary?.workspaceRoot ?? caught?.workspaceRoot ?? null,
    }, {
      code: "stage/runtime-path-protected",
      adapterCalls: 0,
      stageCreated: false,
      tempChildren: [],
      workspaceRoot: null,
    }, "TMPDIR must be checked against protected runtime/cache roots before stage or workspace creation");
  } finally {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    await cleanup(value, summary?.workspaceRoot ?? caught?.workspaceRoot);
  }
});

test("the approved 88-root module map accepts optional synthetic packageSources metadata", async () => {
  const value = await fixture(undefined, { packageSources: true });
  const fake = fakePorts();
  let summary: any;
  let caught: StageError | undefined;
  try {
    try { summary = await runKittenStage(stageArgs(value, fake.ports)); }
    catch (error) { caught = error as StageError; }
    assert.equal(summary?.clipCount, 14,
      `approved module map should be accepted, got code=${caught?.code ?? "none"}, adapterCalls=${fake.calls.length}`);
    assert.equal(fake.calls.length, 14);
  } finally {
    await cleanup(value, summary?.workspaceRoot ?? caught?.workspaceRoot);
  }
});

test("module-map metadata remains shape-checked and unsupported fields are rejected", async (t) => {
  const value = await fixture();
  const modulePathsFile = join(value.runtimeRoot, "module-paths.json");
  const validSources = Object.fromEntries(value.modulePaths.map((_, index) => [
    `synthetic-package-${String(index).padStart(2, "0")}`,
    `synthetic-source-${String(index).padStart(2, "0")}`,
  ]));
  const malformedRecords: Array<[string, Record<string, unknown>]> = [
    ["packageSources is not an object", { modulePaths: value.modulePaths, packageSources: [] }],
    ["packageSources has the wrong cardinality", { modulePaths: value.modulePaths, packageSources: { synthetic: "source" } }],
    ["unsupported fields remain rejected", { modulePaths: value.modulePaths, packageSources: validSources, extra: true }],
  ];
  try {
    for (const [label, record] of malformedRecords) {
      await t.test(label, async () => {
        await writeFile(modulePathsFile, JSON.stringify(record));
        const fake = fakePorts();
        await assert.rejects(runKittenStage(stageArgs(value, fake.ports)), (error: StageError) => {
          assert.equal(error.code, "input/module-paths-invalid");
          return true;
        });
        assert.equal(fake.calls.length, 0);
        assert.equal(await pathExists(value.stagePath), false);
      });
    }
  } finally {
    await cleanup(value);
  }
});

test("serial explicit adapter calls create one validated non-servable v2 stage with retained WAV provenance", async () => {
  const value = await fixture();
  const fake = fakePorts();
  const generateAudio = fake.ports.generateAudio;
  fake.ports.generateAudio = async (options) => {
    assert.equal(options.pythonExecutable, value.pythonExecutable, "protection canonicalization must not replace the venv executable path passed to the adapter");
    return generateAudio(options);
  };
  let summary: Awaited<ReturnType<typeof runKittenStage>> | undefined;
  try {
    summary = await runKittenStage(stageArgs(value, fake.ports));
    const inventory = createAudioSourceInventory(value.factsBytes, AUDIO_CATALOG_TEXT.greeting);
    assert.equal(summary.status, "staged-not-servable");
    assert.equal(summary.version, 2);
    assert.equal(summary.clipCount, 14);
    assert.equal(fake.calls.length, inventory.items.length);
    assert.equal(fake.maxActive(), 1);
    assert.deepEqual(fake.calls, inventory.items.map((item) => item.text));
    const manifestBytes = await readFile(join(value.stagePath, "manifest.json"));
    const pendingManifestBytes = await readFile(`${value.stagePath}.manifest.pending`);
    assert.deepEqual(pendingManifestBytes, manifestBytes, "the same-filesystem pending manifest is retained outside the validated corpus");
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    assert.equal(manifest.clips.length, 14);
    assert.equal((await validateCatalogCorpusV2({ directory: value.stagePath, manifest, inventory })).clipCount, 14);
    const corpusEntries = await readdir(value.stagePath);
    assert.equal(corpusEntries.length, 15, "only 14 final MP3 files and the single playback manifest are in the corpus");
    assert.ok(corpusEntries.includes("manifest.json"));
    const workspaceEntries = await readdir(summary.workspaceRoot);
    assert.equal(workspaceEntries.filter((name) => name !== "activity.jsonl").length, 14);
    const activity = (await readFile(summary.activityPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(activity.filter((event) => event.event === "item-start").length, 14);
    assert.equal(activity.filter((event) => event.event === "item-complete").length, 14);
    assert.equal(activity.at(-1).status, "staged-not-servable");
    assert.ok(activity.every((event) => !Object.hasOwn(event, "text")));
  } finally {
    await cleanup(value, summary?.workspaceRoot);
  }
});

test("foreign pending-manifest sibling is refused before generation and preserved", async () => {
  const value = await fixture();
  const pendingPath = `${value.stagePath}.manifest.pending`;
  const foreignBytes = Buffer.from("foreign pending artifact must remain intact");
  await writeFile(pendingPath, foreignBytes, { flag: "wx" });
  const fake = fakePorts();
  let error: StageError | undefined;
  try {
    await assert.rejects(runKittenStage(stageArgs(value, fake.ports)), (caught: StageError) => {
      error = caught;
      assert.equal(caught.code, "stage/manifest-pending-already-exists");
      return true;
    });
    assert.equal(fake.calls.length, 0, "a stale pending path blocks work before the stage is created");
    assert.deepEqual(await readFile(pendingPath), foreignBytes);
    assert.equal(await pathExists(value.stagePath), false);
  } finally {
    await cleanup(value, error?.workspaceRoot);
  }
});

test("first adapter failure stops without retry or manifest and preserves partial artifacts", async () => {
  const value = await fixture();
  const fake = fakePorts(syntheticMp3(), { failAt: 2 });
  let error: StageError | undefined;
  try {
    await assert.rejects(runKittenStage(stageArgs(value, fake.ports)), (caught: StageError) => {
      error = caught;
      assert.equal(caught.code, "stage/failed");
      return true;
    });
    assert.equal(fake.calls.length, 2);
    assert.ok(error?.stageDirectory);
    assert.ok(error?.workspaceRoot);
    assert.equal((await readdir(value.stagePath)).length, 1, "the completed first clip is kept without a final manifest");
    assert.equal((await readdir(error!.workspaceRoot!)).filter((name) => name !== "activity.jsonl").length, 2);
  } finally {
    await cleanup(value, error?.workspaceRoot);
  }
});

test("foreign outputs and a replaced stage path are refused without overwriting or cleanup", async () => {
  const foreign = await fixture();
  const mp3 = syntheticMp3();
  const foreignDigest = digest(mp3);
  const foreignPath = join(foreign.stagePath, `greeting-${foreignDigest}.mp3`);
  const foreignBytes = Buffer.from("foreign output must remain intact");
  const foreignFake = fakePorts(mp3, {
    foreignStageOutput: async () => {
      await writeFile(foreignPath, foreignBytes, { flag: "wx" });
    },
  });
  let foreignError: StageError | undefined;
  try {
    await assert.rejects(runKittenStage(stageArgs(foreign, foreignFake.ports)), (caught: StageError) => {
      foreignError = caught;
      assert.equal(caught.code, "stage/output-already-exists");
      return true;
    });
    assert.deepEqual(await readFile(foreignPath), foreignBytes);
    assert.equal((await readdir(foreign.stagePath)).includes("manifest.json"), false);
  } finally {
    await cleanup(foreign, foreignError?.workspaceRoot);
  }

  const replaced = await fixture();
  const movedPath = `${replaced.stagePath}.moved`;
  const replacementMarker = join(replaced.stagePath, "foreign-marker");
  const replacementFake = fakePorts(mp3, {
    beforeReturn: async () => {
      await rename(replaced.stagePath, movedPath);
      await mkdir(replaced.stagePath);
      await writeFile(replacementMarker, "preserve replacement", { flag: "wx" });
    },
  });
  let replacedError: StageError | undefined;
  try {
    await assert.rejects(runKittenStage(stageArgs(replaced, replacementFake.ports)), (caught: StageError) => {
      replacedError = caught;
      assert.equal(caught.code, "stage/path-replaced");
      return true;
    });
    assert.equal(await readFile(replacementMarker, "utf8"), "preserve replacement");
    assert.equal((await readdir(movedPath)).length, 0);
  } finally {
    await cleanup(replaced, replacedError?.workspaceRoot, [movedPath]);
  }
});

test("real MP3 parsing, cumulative size cap, and final source-drift check stop before manifest", async () => {
  const invalidMp3 = await fixture();
  const invalidFake = fakePorts(Buffer.from("not an MP3"));
  let invalidError: StageError | undefined;
  try {
    await assert.rejects(runKittenStage(stageArgs(invalidMp3, invalidFake.ports)), (caught: StageError) => {
      invalidError = caught;
      assert.equal(caught.code, "audio/mp3-truncated");
      return true;
    });
    assert.equal((await readdir(invalidMp3.stagePath)).length, 0);
    assert.equal(invalidFake.calls.length, 1);
  } finally {
    await cleanup(invalidMp3, invalidError?.workspaceRoot);
  }

  const overLimit = await fixture();
  const overLimitFrames = Math.ceil((MAX_V2_AUDIO_BYTES + 1) / 96);
  const overLimitFake = fakePorts(syntheticMp3(overLimitFrames));
  let limitError: StageError | undefined;
  try {
    await assert.rejects(runKittenStage(stageArgs(overLimit, overLimitFake.ports)), (caught: StageError) => {
      limitError = caught;
      assert.equal(caught.code, "audio/size-cap-exceeded");
      return true;
    });
    assert.equal((await readdir(overLimit.stagePath)).length, 0);
    assert.equal(overLimitFake.calls.length, 1);
  } finally {
    await cleanup(overLimit, limitError?.workspaceRoot);
  }

  const drifted = await fixture();
  const driftFake = fakePorts(syntheticMp3(), {
    mutateFacts: async (_path, call) => {
      if (call === 14) await writeFile(drifted.factsPath, "synthetic facts changed during run");
    },
  });
  let driftError: StageError | undefined;
  try {
    await assert.rejects(runKittenStage(stageArgs(drifted, driftFake.ports)), (caught: StageError) => {
      driftError = caught;
      assert.equal(caught.code, "input/facts-changed");
      return true;
    });
    assert.equal(driftFake.calls.length, 14);
    assert.equal((await readdir(drifted.stagePath)).length, 14);
    assert.equal((await readdir(drifted.stagePath)).includes("manifest.json"), false);
  } finally {
    await cleanup(drifted, driftError?.workspaceRoot);
  }
});

test("deadline-consuming setup blocks adapter and encoder admission before output creation", async () => {
  const value = await fixture();
  const fake = fakePorts();
  let clockRead = 0;
  const monotonicNow = () => {
    clockRead += 1;
    return clockRead === 3 ? 168 * 60 * 1000 - 1 : 0;
  };
  try {
    await assert.rejects(runKittenStage(stageArgs(value, fake.ports, { monotonicNow })), (error: StageError) => {
      assert.equal(error.code, "deadline/window-insufficient");
      return true;
    });
    assert.equal(fake.calls.length, 0);
    assert.equal(await pathExists(value.stagePath), false);
  } finally {
    await cleanup(value);
  }
});

test("deadline-expired validation retains partial clips but never writes a manifest", async () => {
  const value = await fixture();
  const fake = fakePorts();
  let clock = 0;
  const monotonicNow = () => clock;
  fake.ports.validateCorpus = async (options) => {
    const result = await validateCatalogCorpusV2(options);
    clock = 168 * 60 * 1000 - 1;
    return result;
  };
  let failure: StageError | undefined;
  try {
    await assert.rejects(runKittenStage(stageArgs(value, fake.ports, { monotonicNow })), (error: StageError) => {
      failure = error;
      assert.equal(error.code, "deadline/window-insufficient");
      return true;
    });
    assert.equal(fake.calls.length, 14);
    assert.equal((await readdir(value.stagePath)).length, 14);
    assert.equal(await pathExists(join(value.stagePath, "manifest.json")), false);
    assert.ok(failure?.workspaceRoot);
  } finally {
    await cleanup(value, failure?.workspaceRoot);
  }
});

test("encoder pre-launch remaining-window check prevents spawning without its deadline and settlement reserve", async () => {
  let spawnCount = 0;
  await assert.rejects(audioProcessTest.runProcess("synthetic-encoder", [], 120_000, "audio/encode-failed", {
    deadlineAt: 100_000,
    requiredAfterProcessMs: 60_000,
    monotonicNow: () => 0,
    spawnProcess: () => { spawnCount += 1; throw new Error("must not spawn"); },
  }), (error: StageError) => error.code === "deadline/window-insufficient");
  assert.equal(spawnCount, 0);
});

test("encoder cancellation waits for close, escalates only the owned process and clears timers", async () => {
  const child = new EventEmitter() as EventEmitter & { kill: (signal: string) => boolean };
  const signals: string[] = [];
  const scheduled = new Set<unknown>();
  const cleared = new Set<unknown>();
  child.kill = (signal: string) => { signals.push(signal); return true; };
  const controller = new AbortController();
  let settled = false;
  const pending = audioProcessTest.runProcess("synthetic-encoder", [], 5000, "audio/encode-failed", {
    spawnProcess: () => child,
    termGraceMs: 15,
    signal: controller.signal,
    setTimer(callback: () => void, delay: number) { const handle = setTimeout(callback, delay); scheduled.add(handle); return handle; },
    clearTimer(handle: unknown) { cleared.add(handle); clearTimeout(handle as ReturnType<typeof setTimeout>); },
  }).then(() => { settled = true; }, (error: StageError) => { settled = true; throw error; });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(settled, false, "cancellation must await the owned child close event");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(settled, false, "SIGKILL is not settlement");
  child.emit("close", null, "SIGKILL");
  await assert.rejects(pending, (error: StageError) => error.code === "audio/cancelled");
  assert.equal(settled, true);
  assert.equal(scheduled.size, 2);
  assert.equal(cleared.size, 2);
});

test("encoder timeout waits for child close and escalates only the owned process", async () => {
  const child = new EventEmitter() as EventEmitter & { pid?: number; kill: (signal: string) => boolean };
  const signals: string[] = [];
  child.kill = (signal: string) => { signals.push(signal); return true; };
  let settled = false;
  const pending = audioProcessTest.runProcess("synthetic-encoder", [], 15, "audio/encode-failed", {
    spawnProcess: () => child,
    termGraceMs: 35,
  }).then(
    () => { settled = true; },
    (error: StageError) => { settled = true; throw error; },
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(settled, false, "timeout rejection must wait for terminal process settlement");
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(settled, false, "SIGKILL is bounded cleanup, not permission to release ownership early");
  child.emit("close", null, "SIGKILL");
  await assert.rejects(pending, (error: StageError) => error.code === "audio/encode-failed");
  assert.equal(settled, true);
});


// Direct-output fixtures relocate the actual adapter, never the owner's artifacts.
async function finalFixture() {
  const value = await fixture();
  const project = join(await realpath(value.root), "project");
  for (const dir of ["scripts/cv-audio", "scripts/cv-facts", "src/chat", "resources/cv/source", "public/audio/assistant"]) {
    await mkdir(join(project, dir), { recursive: true });
  }
  for (const file of await readdir(new URL("../scripts/cv-audio/", import.meta.url))) {
    if (file.endsWith(".mjs")) await copyFile(new URL(`../scripts/cv-audio/${file}`, import.meta.url), join(project, "scripts/cv-audio", file));
  }
  await copyFile(new URL("../scripts/cv-audio.mjs", import.meta.url), join(project, "scripts/cv-audio.mjs"));
  for (const file of ["artifact.mjs", "paths.mjs", "errors.mjs"]) {
    await copyFile(new URL(`../scripts/cv-facts/${file}`, import.meta.url), join(project, "scripts/cv-facts", file));
  }
  await writeFile(join(project, "src/chat/audio-catalog.ts"), `export * from ${JSON.stringify(new URL("../src/chat/audio-catalog.ts", import.meta.url).href)};`);
  const sourcePath = join(project, "resources/cv/source/cv.md");
  await writeFile(sourcePath, "# Synthetic CV\nSynthetic source.\n");
  const cards = JSON.parse(value.factsBytes.toString()).cards.map((card: SyntheticCard) => ({
    ...card, tags: ["synthetic"], sourceRefs: [{ startLine: 1, endLine: 2 }], vector: Array(384).fill(0.01),
  }));
  value.factsBytes = Buffer.from(JSON.stringify({
    version: 1,
    source: { path: "resources/cv/source/cv.md", sha256: digest(await readFile(sourcePath)) },
    embedding: { ...PINNED_EMBEDDING, contentSha256: contentSha256(cards) },
    cards,
  }));
  value.factsSha256 = digest(value.factsBytes);
  value.factsPath = join(project, "resources/cv/facts.json");
  value.stagePath = join(project, "public/audio/assistant");
  await writeFile(value.factsPath, value.factsBytes);
  const adapter = await import(join(project, "scripts/cv-audio/kitten-stage.mjs"));
  const { checkFinalFacts } = await import(join(project, "scripts/cv-audio.mjs"));
  await checkFinalFacts();
  const inventory = createAudioSourceInventory(value.factsBytes, AUDIO_CATALOG_TEXT.greeting);
  // Seed a complete older corpus with a different card count and valid owned byte identities.
  const oldInventory = createAudioSourceInventory(factsBytes([{ id: "old-card", answer: "Old answer.", topic: "Old topic" }]));
  const { createV2Manifest } = await import("../scripts/cv-audio/catalog.mjs");
  const oldBytes = syntheticMp3(3);
  const oldClips = oldInventory.items.map((item) => ({
    id: item.id, file: `${item.id}-${digest(oldBytes)}.mp3`, sha256: digest(oldBytes), bytes: oldBytes.length, durationSeconds: 0.072,
  }));
  for (const clip of oldClips) await writeFile(join(value.stagePath, clip.file), oldBytes);
  await writeFile(join(value.stagePath, "manifest.json"), JSON.stringify(createV2Manifest(oldInventory, oldClips)));
  const before = async () => Promise.all((await readdir(value.stagePath)).sort().map(async (name) => [name, digest(await readFile(join(value.stagePath, name)))]));
  return { ...value, adapter, inventory, before, oldClips, sourcePath, checkFinalFacts };
}

function finalArgs(value: Awaited<ReturnType<typeof finalFixture>>, ports: StagePorts, overrides = {}) {
  return stageArgs(value, { checkFinalFacts: value.checkFinalFacts, ...ports }, { final: true, ...overrides });
}

test("direct final output regenerates all items serially at canonical defaults and removes only verified old clips", async () => {
  const value = await finalFixture();
  const fake = fakePorts();
  let result: any;
  try {
    result = await value.adapter.runKittenStage(finalArgs(value, fake.ports, { factsPath: undefined, stagePath: undefined }));
    assert.equal(result.status, "complete-final");
    assert.equal(result.stageDirectory, value.stagePath);
    assert.deepEqual(fake.calls, value.inventory.items.map((item) => item.text));
    assert.equal(fake.maxActive(), 1);
    const manifest = JSON.parse(await readFile(join(value.stagePath, "manifest.json"), "utf8"));
    assert.equal(manifest.factsSha256, value.factsSha256);
    assert.equal((await validateCatalogCorpusV2({ directory: value.stagePath, manifest, inventory: value.inventory })).clipCount, 14);
    assert.deepEqual((await readdir(value.stagePath)).sort(), ["manifest.json", ...manifest.clips.map((clip: any) => clip.file)].sort());
    assert.equal(await pathExists(`${value.stagePath}.manifest.pending`), false);
    for (const itemDirectory of (await readdir(result.workspaceRoot)).filter((name: string) => name !== "activity.jsonl")) {
      assert.deepEqual(await readdir(join(result.workspaceRoot, itemDirectory)), ["runtime.json"], "direct mode keeps provenance, not another corpus in runtime scratch");
    }
    for (const clip of value.oldClips) assert.equal(await pathExists(join(value.stagePath, clip.file)), false);
    // Replacing an already matching corpus must still synthesize every item anew.
    const second = fakePorts();
    const again = await value.adapter.runKittenStage(finalArgs(value, second.ports));
    assert.equal(second.calls.length, 14);
    await rm(again.workspaceRoot, { recursive: true, force: true });
  } finally { await cleanup(value, result?.workspaceRoot); }
});

test("direct preflight refuses unrelated targets, source aliases, hardlinks, ancestors and foreign entries without mutation", async (t) => {
  for (const kind of ["target", "facts", "symlink", "facts-hardlink", "hardlink", "ancestor", "parent-alias", "clip-symlink", "foreign", "duplicate", "bad-digest", "runtime"]) {
    await t.test(kind, async () => {
      const value = await finalFixture();
      const fake = fakePorts();
      let overrides: Record<string, unknown> = {};
      try {
        if (kind === "target") overrides.stagePath = join(value.root, "unrelated");
        if (kind === "facts") overrides.factsPath = join(value.root, "facts.synthetic.json");
        if (kind === "symlink") {
          await rename(value.factsPath, `${value.factsPath}.real`);
          await symlink(`${value.factsPath}.real`, value.factsPath);
        }
        if (kind === "facts-hardlink") await link(value.factsPath, join(value.root, "linked-facts.json"));
        if (kind === "parent-alias") {
          const parent = join(value.stagePath, "..");
          await rename(parent, `${parent}.real`);
          await symlink(`${parent}.real`, parent);
        }
        if (kind === "clip-symlink") {
          const clip = join(value.stagePath, value.oldClips[0].file);
          const outside = join(value.root, "outside.mp3");
          await rename(clip, outside);
          await symlink(outside, clip);
        }
        if (kind === "hardlink") await link(join(value.stagePath, value.oldClips[0].file), join(value.root, "linked.mp3"));
        if (kind === "ancestor") {
          await rename(value.stagePath, `${value.stagePath}.real`);
          await symlink(`${value.stagePath}.real`, value.stagePath);
        }
        if (kind === "foreign") await writeFile(join(value.stagePath, "notes.txt"), "unrelated");
        if (kind === "duplicate") {
          const manifestPath = join(value.stagePath, "manifest.json");
          const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
          manifest.clips[1] = manifest.clips[0];
          await writeFile(manifestPath, JSON.stringify(manifest));
        }
        if (kind === "bad-digest") overrides.factsSha256 = "f".repeat(64);
        if (kind === "runtime") await writeFile(value.runtimeInputsPath, "{}");
        const before = await value.before();
        const expectedCode = kind === "target" ? "final/audio-path-required" : kind === "facts" ? "final/facts-path-required"
          : kind === "bad-digest" ? "input/facts-digest-mismatch" : kind === "runtime" ? "input/runtime-inputs-invalid"
          : kind === "foreign" || kind === "duplicate" ? "final/unexpected-entry" : "final/path-aliased-or-invalid";
        await assert.rejects(value.adapter.runKittenStage(finalArgs(value, fake.ports, overrides)), (error: StageError) => {
          assert.equal(error.code, expectedCode); return true;
        });
        assert.equal(fake.calls.length, 0);
        assert.deepEqual(await value.before(), before);
        assert.equal(await pathExists(join(value.root, "unrelated")), false);
      } finally { await cleanup(value); }
    });
  }
});

test("direct runtime preflight failure preserves the complete old output", async () => {
  const value = await finalFixture();
  const fake = fakePorts();
  let checked = false;
  Object.assign(fake.ports, { async preflight() { checked = true; throw Object.assign(new Error("invalid pins"), { code: "pin/sdk-archive-mismatch" }); } });
  try {
    const before = await value.before();
    await assert.rejects(value.adapter.runKittenStage(finalArgs(value, fake.ports)), /pin\/sdk-archive-mismatch/);
    assert.equal(checked, true);
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(await value.before(), before);
  } finally { await cleanup(value); }
});

test("direct failures invalidate completion before synthesis and never restore a completed manifest", async (t) => {
  for (const kind of ["adapter", "encoder", "cancel", "deadline", "facts-drift", "foreign-output", "validation"]) {
    await t.test(kind, async () => {
      const value = await finalFixture();
      const fake = fakePorts();
      const controller = new AbortController();
      let clock = 0;
      let caught: StageError | undefined;
      const generate = fake.ports.generateAudio;
      fake.ports.generateAudio = async (options) => {
        assert.equal(await pathExists(join(value.stagePath, "manifest.json")), false, "completion must be invalidated before the first adapter call");
        const result = await generate(options);
        if (fake.calls.length === 2) {
          if (kind === "adapter") throw new Error("synthetic failure");
          if (kind === "cancel") controller.abort();
          if (kind === "deadline") clock = 168 * 60 * 1000 - 1;
          if (kind === "facts-drift") await writeFile(value.factsPath, "changed");
          if (kind === "foreign-output") await writeFile(join(value.stagePath, "unrelated.txt"), "preserve");
        }
        return result;
      };
      if (kind === "encoder") fake.ports.encodeWav = async () => { throw new Error("encoder failure"); };
      if (kind === "validation") fake.ports.validateCorpus = async (options) => {
        if (options.inventory.factsSha256 === value.factsSha256) throw new Error("validation failure");
        return validateCatalogCorpusV2(options);
      };
      try {
        await assert.rejects(value.adapter.runKittenStage(finalArgs(value, fake.ports, { signal: controller.signal, monotonicNow: () => clock })), (error: StageError) => { caught = error; return true; });
        assert.ok(fake.calls.length >= 1);
        assert.equal(await pathExists(join(value.stagePath, "manifest.json")), false);
        assert.equal(await pathExists(`${value.stagePath}.manifest.pending`), false);
        assert.equal(await pathExists(`${value.stagePath}.generation.lock`), false);
        if (kind === "foreign-output") assert.equal(await readFile(join(value.stagePath, "unrelated.txt"), "utf8"), "preserve");
        if (kind === "cancel" || kind === "deadline" || kind === "adapter") assert.equal(fake.calls.length, 2);
      } finally { await cleanup(value, caught?.workspaceRoot); }
    });
  }
});


test("direct output rejects source-only drift under the lock before invalidation and through finalization", async (t) => {
  for (const phase of ["preflight-gap", "generation", "validation", "completion-notification"]) {
    for (const mutation of ["edit", "replace"]) await t.test(`${phase}/${mutation}`, async () => {
      const value = await finalFixture();
      const fake = fakePorts();
      const changed = "# Synthetic intervening edit\nPreserve this newer source.\n";
      let failure: StageError | undefined;
      let completed: any;
      let mutated = false;
      const mutate = () => {
        if (mutated) return;
        mutated = true;
        if (mutation === "replace") {
          writeFileSync(`${value.sourcePath}.new`, changed, { flag: "wx" });
          renameSync(`${value.sourcePath}.new`, value.sourcePath);
        } else writeFileSync(value.sourcePath, changed);
      };
      fake.ports.checkFinalFacts = async () => {
        assert.equal(await pathExists(`${value.stagePath}.generation.lock`), true, "source/facts revalidation must retain lock ownership");
        return value.checkFinalFacts();
      };
      if (phase === "preflight-gap") fake.ports.preflight = async () => { mutate(); };
      if (phase === "generation") {
        const generate = fake.ports.generateAudio;
        fake.ports.generateAudio = async (options) => { const result = await generate(options); if (fake.calls.length === 2) mutate(); return result; };
      }
      if (phase === "validation") fake.ports.validateCorpus = async (options) => {
        const result = await validateCatalogCorpusV2(options);
        if (options.inventory.factsSha256 === value.factsSha256) mutate();
        return result;
      };
      try {
        const before = await value.before();
        await assert.rejects(value.adapter.runKittenStage(finalArgs(value, fake.ports, {
          onProgress(event: { event: string }) { if (phase === "completion-notification" && event.event === "complete") mutate(); },
        })).then((result: any) => { completed = result; return result; }), (error: StageError) => {
          failure = error;
          assert.equal(error.code, "source/facts-check-failed");
          return true;
        });
        assert.equal(mutated, true);
        assert.equal(completed, undefined, "source-only drift must never return complete-final");
        assert.equal(await readFile(value.sourcePath, "utf8"), changed, "preserve the intervening owner edit");
        assert.deepEqual(await readFile(value.factsPath), value.factsBytes, "facts bytes did not drift");
        if (phase === "preflight-gap") {
          assert.equal(fake.calls.length, 0);
          assert.deepEqual(await value.before(), before, "reject before invalidating prior output");
        } else assert.equal(await pathExists(join(value.stagePath, "manifest.json")), false);
        assert.equal(await pathExists(`${value.stagePath}.generation.lock`), false);
      } finally { await cleanup(value, failure?.workspaceRoot ?? completed?.workspaceRoot); }
    });
  }
});

test("direct completion notification failure removes only its owned final manifest", async () => {
  const value = await finalFixture();
  const fake = fakePorts();
  let caught: StageError | undefined;
  try {
    await assert.rejects(value.adapter.runKittenStage(finalArgs(value, fake.ports, {
      onProgress(event: { event: string }) { if (event.event === "complete") throw new Error("observer failed"); },
    })), (error: StageError) => { caught = error; return true; });
    assert.equal(fake.calls.length, 14);
    assert.equal(await pathExists(join(value.stagePath, "manifest.json")), false);
    assert.equal((await readdir(value.stagePath)).length, 14);
    assert.equal(await pathExists(`${value.stagePath}.generation.lock`), false);
  } finally { await cleanup(value, caught?.workspaceRoot); }
});

test("two direct runs that both pass preflight cannot acquire the same final output", async () => {
  const value = await finalFixture();
  const first = fakePorts();
  const second = fakePorts();
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
  const firstReady = deferred(); const secondReady = deferred();
  const admitFirst = deferred(); const admitSecond = deferred();
  const generating = deferred(); const finishGeneration = deferred();
  first.ports.preflight = async () => { firstReady.resolve(); await admitFirst.promise; };
  second.ports.preflight = async () => { secondReady.resolve(); await admitSecond.promise; };
  const generate = first.ports.generateAudio;
  first.ports.generateAudio = async (options) => { generating.resolve(); await finishGeneration.promise; return generate(options); };
  let firstResult: any;
  let firstFailure: StageError | undefined;
  let secondFailure: StageError | undefined;
  const firstRun = value.adapter.runKittenStage(finalArgs(value, first.ports));
  const ownedFirst = firstRun.then((result: any) => { firstResult = result; }, (error: StageError) => { firstFailure = error; });
  await firstReady.promise;
  const secondRun = value.adapter.runKittenStage(finalArgs(value, second.ports));
  const refusedSecond = assert.rejects(secondRun, (error: StageError) => { secondFailure = error; return error.code === "final/generation-in-progress"; });
  try {
    await secondReady.promise;
    admitFirst.resolve();
    await generating.promise;
    const before = await value.before();
    admitSecond.resolve();
    await refusedSecond;
    assert.deepEqual(await value.before(), before);
    assert.equal(second.calls.length, 0);
    finishGeneration.resolve();
    await ownedFirst;
    assert.equal(firstFailure, undefined);
    assert.equal(firstResult.status, "complete-final");
    assert.equal(await pathExists(`${value.stagePath}.generation.lock`), false);
  } finally {
    admitFirst.resolve(); admitSecond.resolve(); finishGeneration.resolve();
    await ownedFirst; await refusedSecond;
    if (secondFailure?.workspaceRoot) await rm(secondFailure.workspaceRoot, { recursive: true, force: true });
    await cleanup(value, firstResult?.workspaceRoot ?? firstFailure?.workspaceRoot);
  }
});

test("a launch during private finalization is refused without modifying the first run", async () => {
  const value = await finalFixture();
  const first = fakePorts(); const second = fakePorts();
  let attempted = false;
  let result: any;
  first.ports.validateCorpus = async (options) => {
    const validated = await validateCatalogCorpusV2(options);
    if (options.inventory.factsSha256 === value.factsSha256) {
      attempted = true;
      const before = await value.before();
      await assert.rejects(value.adapter.runKittenStage(finalArgs(value, second.ports)), /final\/generation-in-progress/);
      assert.deepEqual(await value.before(), before);
    }
    return validated;
  };
  try {
    result = await value.adapter.runKittenStage(finalArgs(value, first.ports));
    assert.equal(attempted, true);
    assert.equal(second.calls.length, 0);
    assert.equal(result.status, "complete-final");
    assert.equal(await pathExists(`${value.stagePath}.generation.lock`), false);
  } finally { await cleanup(value, result?.workspaceRoot); }
});

test("foreign and replaced direct locks are never deleted or treated as completion", async (t) => {
  for (const phase of ["preflight", "generation", "finalization"]) await t.test(phase, async () => {
    const value = await finalFixture();
    const fake = fakePorts();
    const lock = `${value.stagePath}.generation.lock`;
    const replace = async () => { await rename(lock, `${lock}.moved`); await writeFile(lock, "foreign lock"); };
    let failure: StageError | undefined;
    if (phase === "preflight") await writeFile(lock, "foreign lock");
    if (phase === "generation") {
      const generate = fake.ports.generateAudio;
      fake.ports.generateAudio = async (options) => { const result = await generate(options); await replace(); return result; };
    }
    try {
      const before = await value.before();
      await assert.rejects(value.adapter.runKittenStage(finalArgs(value, fake.ports, phase === "finalization" ? {
        onProgress(event: { event: string }) {
          if (event.event === "complete") {
            // Synchronous callback mutation covers loss of ownership after the manifest exists.
            renameSync(lock, `${lock}.moved`);
            writeFileSync(lock, "foreign lock");
          }
        },
      } : {})), (error: StageError) => { failure = error; return /final\/(lock-replaced|generation-in-progress)/.test(error.code ?? ""); });
      assert.equal(await readFile(lock, "utf8"), "foreign lock");
      if (phase === "preflight") { assert.equal(fake.calls.length, 0); assert.deepEqual(await value.before(), before); }
      else assert.equal(await pathExists(join(value.stagePath, "manifest.json")), false);
    } finally { await cleanup(value, failure?.workspaceRoot); }
  });
});

test("direct manifest creation rejects replacement after open and preserves the foreign pathname", async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "cv-audio-manifest-race-test-"));
  const manifestPath = join(root, "manifest.json");
  const foreignPath = join(root, "foreign.json");
  const foreign = "foreign replacement, not owned output\n";
  const originalOpen = fs.openSync;
  let replaced = false;
  try {
    await writeFile(foreignPath, foreign, { flag: "wx" });
    const identity = await lstat(root);
    const foreignIdentity = await lstat(foreignPath);
    const openMock = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      const fd = originalOpen(...args);
      if (String(args[0]) === manifestPath && !replaced) {
        replaced = true;
        fs.renameSync(manifestPath, join(root, "opened-manifest.json"));
        fs.renameSync(foreignPath, manifestPath);
      }
      return fd;
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => writeFinalManifest({ path: root }, identity, Buffer.from("owned manifest\n")), /final\/output-replaced/);
    } finally {
      openMock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(replaced, true, "replace precisely after exclusive open, before descriptor/path inspection");
    assert.equal(await readFile(manifestPath, "utf8"), foreign);
    const after = await lstat(manifestPath);
    assert.equal(after.dev, foreignIdentity.dev);
    assert.equal(after.ino, foreignIdentity.ino, "failure cleanup must not delete or adopt the foreign inode");
  } finally { await rm(root, { recursive: true, force: true }); }
});
