import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
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

const execFileAsync = promisify(execFile);
const digest = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
type StageError = Error & { code?: string; stageDirectory?: string | null; workspaceRoot?: string | null; activityPath?: string | null };
type StageFixture = Awaited<ReturnType<typeof fixture>>;
type StagePorts = {
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
  const root = await mkdtemp(join(tmpdir(), "cv-audio-kitten-stage-test-"));
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

