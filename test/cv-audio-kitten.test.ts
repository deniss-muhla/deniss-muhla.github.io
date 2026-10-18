import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const adapterModulePath = process.env.KITTEN_TEST_ADAPTER_PATH
  ? pathToFileURL(resolve(process.env.KITTEN_TEST_ADAPTER_PATH)).href
  : new URL("../scripts/cv-audio/kitten.mjs", import.meta.url).href;
const { generateKittenAudio, KittenTaskError, kittenProcessTest, verifyPinnedArtifacts } = await import(adapterModulePath);
import completionContract from "../scripts/cv-audio/kitten-completion.json" with { type: "json" };

const digest = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
const execFileAsync = promisify(execFile);
type Fixture = Awaited<ReturnType<typeof fixture>>;
type RuntimeContext = { pythonRealpath: string; pythonPrefix: string; sdkPackageRoot: string; moduleRoots: string[]; hubCache: string; decoderPath: string };
type JsonRecord = Record<string, any>;
type FakeChild = EventEmitter & { stdin: PassThrough; stdout: PassThrough; kill: (signal: string) => boolean };
type FakeOptions = { foreignOutput?: string; foreignMetadata?: string; mutateMetadata?: (metadata: JsonRecord) => void; wavBytes?: Buffer };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cv-audio-kitten-test-"));
  const sdkRoot = join(root, "sdk");
  const sdkPackage = join(sdkRoot, "kittenml");
  const hubCache = join(root, "hub");
  const revision = "f".repeat(40);
  const modelSnapshot = join(hubCache, "models--KittenML--kitten-tts-2", "snapshots", revision);
  const decoderRoot = join(hubCache, "models--example--decoder");
  const decoderSnapshot = join(decoderRoot, "snapshots", "d".repeat(40));
  const archive = join(root, "sdk.tar.gz");
  await mkdir(sdkPackage, { recursive: true });
  await mkdir(modelSnapshot, { recursive: true });
  await mkdir(join(decoderRoot, "refs"), { recursive: true });
  await mkdir(decoderSnapshot, { recursive: true });
  const sdkBytes = Buffer.from("source archive fixture");
  const sdkSource = Buffer.from("# fixed source fixture\n");
  const modelBytes = Buffer.from("model fixture");
  const decoderBytes = Buffer.from("decoder fixture");
  await writeFile(archive, sdkBytes);
  await writeFile(join(sdkPackage, "__init__.py"), sdkSource);
  await writeFile(join(modelSnapshot, "config.json"), modelBytes);
  await writeFile(join(decoderSnapshot, "weights.bin"), decoderBytes);
  await writeFile(join(decoderRoot, "refs", "main"), "d".repeat(40));
  const treeHash = createHash("sha256");
  const name = Buffer.from("kittenml/__init__.py");
  const nameLength = Buffer.alloc(4);
  nameLength.writeUInt32BE(name.length);
  const contentLength = Buffer.alloc(8);
  contentLength.writeBigUInt64BE(BigInt(sdkSource.length));
  treeHash.update(nameLength).update(name).update(contentLength).update(sdkSource);
  const sourcePins = JSON.parse(await readFile(new URL("../scripts/cv-audio/kitten-pins.json", import.meta.url), "utf8"));
  const pins = structuredClone(sourcePins);
  pins.sdk.archiveSha256 = digest(sdkBytes);
  pins.sdk.sourceTreeSha256 = treeHash.digest("hex");
  pins.sdk.sourceFileCount = 1;
  pins.kittenModel.revision = revision;
  pins.kittenModel.files = [{ path: "config.json", sha256: digest(modelBytes) }];
  pins.decoder.repo = "example/decoder";
  pins.decoder.revision = "d".repeat(40);
  pins.decoder.path = "weights.bin";
  pins.decoder.sha256 = digest(decoderBytes);
  return { root, sdkRoot, hubCache, modelSnapshot, decoderRoot, archive, sdkArchive: archive, pins, sourcePins };
}

function wavFixture(frames = 480): Buffer {
  const payload = Buffer.alloc(frames * 2);
  for (let index = 0; index < frames; index += 1) payload.writeInt16LE(index % 2 ? 5000 : -5000, index * 2);
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

function successMetadata(audioPath: string, context: RuntimeContext, pins: JsonRecord, bytes = wavFixture(), identityPins: JsonRecord = pins): JsonRecord {
  const distributions = {
    numpy: "numpy", soundfile: "soundfile", torch: "torch", transformers: "transformers",
    safetensors: "safetensors", librosa: "librosa", diffusers: "diffusers", s3tokenizer: "s3tokenizer",
    onnx: "onnx", huggingface_hub: "huggingface-hub", mpmath: "mpmath", narwhals: "narwhals"
  };
  const imports = [{ name: "kittenml", path: join(context.sdkPackageRoot, "__init__.py"), version: "0.0.0.dev0" }];
  for (const [name, distribution] of Object.entries(distributions)) {
    const modulePath = name === "mpmath"
      ? join(context.moduleRoots[0], "mpmath-1.3.0-root", "mpmath", "__init__.py")
      : name === "narwhals"
        ? join(context.moduleRoots[0], `narwhals-${pins.dependencies.narwhals}-root`, "narwhals", "__init__.py")
        : join(context.moduleRoots[0], name, "__init__.py");
    imports.push({ name, path: modulePath, version: pins.dependencies[distribution] });
  }
  const frames = (bytes.length - 44) / 2;
  return {
    status: "ok",
    audio: {
      path: audioPath, bytes: bytes.length, sha256: digest(bytes), format: "WAV", subtype: "PCM_16",
      sampleRate: 24000, channels: 1, frames, durationSeconds: frames / 24000,
      peakFloat: 5000 / 32768, floatingClippedSamples: 0, pcmFullscaleSamples: 0
    },
    runtime: {
      executable: context.pythonRealpath, prefix: context.pythonPrefix,
      sdk: { version: identityPins.sdk.version, sourceCommit: identityPins.sdk.sourceCommit, archiveSha256: identityPins.sdk.archiveSha256, sourceTreeSha256: identityPins.sdk.sourceTreeSha256 },
      imports, dependencies: { ...pins.dependencies },
      model: {
        revision: pins.kittenModel.revision, voice: pins.kittenModel.voice, weights: pins.kittenModel.weights,
        preset: pins.kittenModel.preset, device: "cuda", gpu: "test GPU identifier",
        freeGpuBytesBeforeLoad: 6 * 1024 ** 3, totalGpuBytes: 8 * 1024 ** 3,
        loadSeconds: 1.25, inferenceSeconds: 0.75
      },
      decoder: {
        revision: identityPins.decoder.revision, sha256: identityPins.decoder.sha256,
        resolvedPath: context.decoderPath
      },
      offline: { hfHub: "1", transformers: "1", implicitAuth: "1", telemetryDisabled: "1" },
      osNetworkSandbox: "bubblewrap --unshare-net",
      networkGuard: "additional process-local Python socket hooks; not OS isolation",
      networkGuardBlockedAttempts: 0, synthesisTextLogged: false,
      completion: {
        generationUtilsSha256: completionContract.generationUtilsSha256,
        expectedChunks: 1, requestedMaxNewTokensPerChunk: 1000, sdkDerivedBudgets: [240],
        observedGenerationCalls: 1, observedDecodeCalls: 1,
        decodedAudioChunks: 1, terminalMarkers: ["eos-tail"]
      }
    }
  };
}

async function runtimeContext(value: Fixture, pythonExecutable = process.execPath): Promise<RuntimeContext> {
  return {
    pythonRealpath: await realpath(pythonExecutable),
    pythonPrefix: await realpath(dirname(dirname(pythonExecutable))),
    sdkPackageRoot: await realpath(join(value.sdkRoot, "kittenml")),
    moduleRoots: [await realpath(value.root)],
    hubCache: await realpath(value.hubCache),
    decoderPath: await realpath(join(value.decoderRoot, "snapshots", value.pins.decoder.revision, value.pins.decoder.path))
  };
}

function fakeSuccessSpawner(context: RuntimeContext, pins: JsonRecord, { foreignOutput, foreignMetadata, mutateMetadata, wavBytes }: FakeOptions = {}, identityPins: JsonRecord = pins) {
  return (_command: string, _args: string[]) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    let input = "";
    child.stdin.on("data", (chunk: Buffer) => { input += chunk.toString(); });
    child.stdin.on("end", () => {
      void (async () => {
        const request = JSON.parse(input);
        const bytes = wavBytes ?? wavFixture();
        await writeFile(request.outputWav, bytes);
        if (foreignOutput) await writeFile(foreignOutput, "foreign output");
        if (foreignMetadata) await writeFile(foreignMetadata, "foreign metadata");
        const metadata = successMetadata(request.outputWav, context, pins, bytes, identityPins);
        mutateMetadata?.(metadata);
        child.stdout.write(JSON.stringify(metadata));
        setImmediate(() => { child.stdout.end(); child.emit("close", 0); });
      })().catch((error) => {
        child.emit("error", error);
        setImmediate(() => child.emit("close", 1));
      });
    });
    return child;
  };
}

function trackedAbortSignal() {
  let aborted = false;
  const listeners = new Set<(...args: any[]) => void>();
  const signal = {
    get aborted() { return aborted; },
    addEventListener(_type: string, listener: (...args: any[]) => void) { listeners.add(listener); },
    removeEventListener(_type: string, listener: (...args: any[]) => void) { listeners.delete(listener); },
  };
  return {
    signal,
    abort() { aborted = true; for (const listener of listeners) listener(); },
    listenerCount() { return listeners.size; },
  };
}

function generationOptions(value: Fixture, outputWav: string, metadataPath: string) {
  return {
    text: "A short synthetic sample.", pythonExecutable: process.execPath, sandboxExecutable: process.execPath,
    sdkRoot: value.sdkRoot, sdkArchive: value.archive, modelSnapshot: value.modelSnapshot,
    hubCache: value.hubCache, workspace: value.root, outputWav, metadataPath, modulePaths: [value.root], timeoutMs: 3000
  };
}

test("repository-local and otherwise invalid explicit runtime paths are rejected", async () => {
  await assert.rejects(generateKittenAudio({
    text: "synthetic sample",
    pythonExecutable: new URL("../scripts/cv-audio/kitten.mjs", import.meta.url).pathname,
    sdkRoot: "/tmp/sdk", sdkArchive: "/tmp/sdk.tar.gz", modelSnapshot: "/tmp/model",
    hubCache: "/tmp/hub", workspace: "/tmp", outputWav: "/tmp/out.wav", modulePaths: ["/tmp"]
  }), (error: { code?: string }) => error.code === "input/repository-path-forbidden");
});

test("pinned SDK, model and decoder artifacts pass local digest verification", async () => {
  const value = await fixture();
  try {
    const result = await verifyPinnedArtifacts(value, value.pins);
    assert.equal(result.decoderFile, join(value.decoderRoot, "snapshots", value.pins.decoder.revision, "weights.bin"));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("required mpmath imports from its dedicated pinned root before model construction", async () => {
  const value = await fixture();
  try {
    const moduleRoot = join(value.root, "runtime-module-root");
    const packageRoot = join(moduleRoot, "mpmath");
    const distributionRoot = join(moduleRoot, "mpmath-1.3.0.dist-info");
    await mkdir(packageRoot, { recursive: true });
    await mkdir(distributionRoot, { recursive: true });
    await writeFile(join(packageRoot, "__init__.py"), "__version__ = '1.3.0'\n");
    await writeFile(join(distributionRoot, "METADATA"), "Metadata-Version: 2.1\nName: mpmath\nVersion: 1.3.0\n\n");
    const runnerPath = fileURLToPath(new URL("../scripts/cv-audio/kitten-runner.py", import.meta.url));
    const sdkRoot = value.sdkRoot;
    const script = [
      "import importlib,importlib.metadata,importlib.util,json,pathlib,sys",
      "spec=importlib.util.spec_from_file_location('kitten_runner',sys.argv[1])",
      "runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)",
      "root=pathlib.Path(sys.argv[2]).resolve();sdk=pathlib.Path(sys.argv[3]).resolve()",
      "runner.configure_imports([root],sdk)",
      "module=runner.verify_mpmath([root])",
      "records=runner.check_origins({'mpmath':module},[root],sdk)",
      "assert importlib.metadata.version('mpmath') == runner.PINS['dependencies']['mpmath']",
      "assert records[0]['version'] == runner.PINS['dependencies']['mpmath']",
      "assert pathlib.Path(module.__file__).resolve().is_relative_to(root)",
      "print(json.dumps({'status':'ok','version':records[0]['version'],'originVerified':True,'modelConstructed':False}))"
    ].join("\n");
    const { stdout, stderr } = await execFileAsync("python3", ["-I", "-B", "-c", script, runnerPath, moduleRoot, sdkRoot], { timeout: 5000, maxBuffer: 4096 });
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), { status: "ok", version: "1.3.0", originVerified: true, modelConstructed: false });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("required narwhals stable v2 API imports from its dedicated pinned root", async () => {
  const value = await fixture();
  try {
    const moduleRoot = join(value.root, "narwhals-module-root");
    const packageRoot = join(moduleRoot, "narwhals");
    const stableRoot = join(packageRoot, "stable");
    const stableV2Root = join(stableRoot, "v2");
    const distributionRoot = join(moduleRoot, "narwhals-2.0.1.dist-info");
    await mkdir(stableV2Root, { recursive: true });
    await mkdir(distributionRoot, { recursive: true });
    await writeFile(join(packageRoot, "__init__.py"), "__version__ = '2.0.1'\n");
    await writeFile(join(stableRoot, "__init__.py"), "");
    await writeFile(join(stableV2Root, "__init__.py"), "API_AVAILABLE = True\n");
    await writeFile(join(distributionRoot, "METADATA"), "Metadata-Version: 2.1\nName: narwhals\nVersion: 2.0.1\n\n");
    const runnerPath = fileURLToPath(new URL("../scripts/cv-audio/kitten-runner.py", import.meta.url));
    const script = [
      "import importlib,importlib.util,json,pathlib,sys",
      "assert sys.dont_write_bytecode is True",
      "spec=importlib.util.spec_from_file_location('kitten_runner',sys.argv[1])",
      "runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)",
      "root=pathlib.Path(sys.argv[2]).resolve();sdk=pathlib.Path(sys.argv[3]).resolve()",
      "runner.configure_imports([root],sdk)",
      "module=runner.verify_narwhals([root])",
      "api=importlib.import_module('narwhals.stable.v2')",
      "record=runner.check_origins({'narwhals':module},[root],sdk)[0]",
      "assert record['version'] == runner.PINS['dependencies']['narwhals']",
      "assert pathlib.Path(module.__file__).resolve().is_relative_to(root)",
      "assert pathlib.Path(api.__file__).resolve().is_relative_to(root)",
      "print(json.dumps({'status':'ok','version':record['version'],'originVerified':True,'stableV2Verified':True,'modelConstructed':False}))"
    ].join("\n");
    const { stdout, stderr } = await execFileAsync("python3", ["-I", "-B", "-c", script, runnerPath, moduleRoot, value.sdkRoot], { timeout: 5000, maxBuffer: 4096 });
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), { status: "ok", version: "2.0.1", originVerified: true, stableV2Verified: true, modelConstructed: false });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("model pin failure occurs before the runner process can be invoked", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.modelSnapshot, "config.json"), "tampered");
    let invoked = false;
    const options = {
      text: "short synthetic text",
      pythonExecutable: process.execPath,
      sandboxExecutable: process.execPath,
      sdkRoot: value.sdkRoot,
      sdkArchive: value.archive,
      modelSnapshot: value.modelSnapshot,
      hubCache: value.hubCache,
      workspace: value.root,
      outputWav: join(value.root, "clip.wav"),
      modulePaths: [value.root]
    };
    await assert.rejects(
      kittenProcessTest.runWithPins(options, value.pins, () => { invoked = true; throw new Error("must not run"); }),
      (error: { code?: string }) => error.code === "pin/model-file-mismatch"
    );
    assert.equal(invoked, false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("decoder default cache reference must match the immutable decoder pin", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.decoderRoot, "refs", "main"), `${value.pins.decoder.revision}\n`);
    await assert.rejects(verifyPinnedArtifacts(value, value.pins), (error: { code?: string }) => error.code === "pin/decoder-default-ref-mismatch");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("production Python spawn uses -B despite isolated mode", async () => {
  const value = await fixture();
  try {
    const outputWav = join(value.root, "publish", "sample.wav");
    const metadataPath = join(value.root, "publish", "sample.json");
    await mkdir(dirname(outputWav), { recursive: true });
    const context = await runtimeContext(value);
    const runnerPath = fileURLToPath(new URL("../scripts/cv-audio/kitten-runner.py", import.meta.url));
    let capturedArgs: string[] = [];
    let capturedOptions: JsonRecord = {};
    const fakeSpawner = fakeSuccessSpawner(context, value.pins);
    const captureSpawner = (command: string, args: string[], options: JsonRecord) => {
      capturedArgs = [...args];
      capturedOptions = options;
      return fakeSpawner(command, args);
    };
    await kittenProcessTest.runWithPins(generationOptions(value, outputWav, metadataPath), value.pins, captureSpawner);

    const separator = capturedArgs.indexOf("--");
    assert.ok(separator >= 0);
    assert.equal(capturedArgs[separator + 1], process.execPath);
    assert.deepEqual(capturedArgs.slice(separator + 2, separator + 5), ["-I", "-B", runnerPath]);
    assert.equal(capturedOptions.env.PYTHONDONTWRITEBYTECODE, "1");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("strict metadata rejects foreign import origins, runtime identities, and unknown fields", async () => {
  const value = await fixture();
  try {
    const context = await runtimeContext(value);
    const paths = { ...context, outputWav: join(value.root, "clip.wav") };
    const valid = successMetadata(paths.outputWav, context, value.pins);
    const foreign = structuredClone(valid);
    const torchImport = foreign.runtime.imports.find((item: JsonRecord) => item.name === "torch");
    assert.ok(torchImport);
    torchImport.path = "/tmp/unapproved/torch/__init__.py";
    assert.throws(() => kittenProcessTest.assertSafeMetadata(foreign, paths, value.pins), (error: { code?: string }) => error.code === "runner/import-origin-mismatch");
    const mpmathImport = valid.runtime.imports.find((item: JsonRecord) => item.name === "mpmath");
    assert.ok(mpmathImport);
    assert.equal(mpmathImport.version, "1.3.0");

    const mutations: Array<(metadata: JsonRecord) => void> = [
      (metadata) => { metadata.text = "SECRET SYNTHESIS TEXT"; },
      (metadata) => { metadata.runtime.executable = "/tmp/other-python"; },
      (metadata) => { metadata.runtime.dependencies.torch = "wrong-version"; },
      (metadata) => { metadata.runtime.dependencies.mpmath = "wrong-version"; },
      (metadata) => { metadata.runtime.imports.find((item: JsonRecord) => item.name === "mpmath").version = "wrong-version"; },
      (metadata) => { metadata.runtime.imports.push({ name: "hf_xet", version: "1.1.3" }); },
      (metadata) => { metadata.runtime.model.revision = "wrong-model"; },
      (metadata) => { metadata.runtime.decoder.resolvedPath = join(context.hubCache, "other-model.safetensors"); },
      (metadata) => { metadata.runtime.sdk.extra = "unknown"; },
      (metadata) => { delete metadata.runtime.completion; },
      (metadata) => { metadata.runtime.completion.generationUtilsSha256 = "0".repeat(64); },
      (metadata) => { metadata.runtime.completion.detail = "unapproved"; }
    ];
    const mutationResults = mutations.map((mutate) => {
      const altered = structuredClone(valid);
      mutate(altered);
      try {
        assert.throws(() => kittenProcessTest.assertSafeMetadata(altered, paths, value.pins), (error: { code?: string; message?: string }) => {
          assert.equal(error.code, "runner/result-invalid");
          assert.doesNotMatch(error.message ?? "", /SECRET SYNTHESIS TEXT/);
          return true;
        });
        return true;
      } catch {
        return false;
      }
    });
    assert.deepEqual(mutationResults, mutations.map(() => true));

    const safe = kittenProcessTest.assertSafeMetadata(valid, paths, value.pins);
    assert.equal(safe.runtime.model.gpu, undefined);
    assert.equal(safe.runtime.decoder.resolvedPath, undefined);
    assert.equal(safe.runtime.imports[0].path, undefined);
    assert.ok(safe.runtime.imports.some((item: JsonRecord) => item.name === "mpmath" && item.version === "1.3.0"));
    assert.ok(safe.runtime.imports.some((item: JsonRecord) => item.name === "narwhals" && item.version === "2.0.1"));
    for (const name of ["hf_xet", "pre_commit", "cfgv", "identify", "nodeenv", "virtualenv", "distlib"]) {
      assert.equal(safe.runtime.imports.some((item: JsonRecord) => item.name === name), false);
    }
    assert.equal(safe.runtime.sdk.version, value.pins.sdk.version);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("the strict WAV inspector accepts a 16-second waveform within the whole-output cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "cv-audio-kitten-duration-test-"));
  try {
    const wavPath = join(root, "over-15-seconds.wav");
    await writeFile(wavPath, wavFixture(16 * 24000));
    const inspected = await kittenProcessTest.inspectWav(wavPath);
    assert.equal(inspected.frames, 16 * 24000);
    assert.equal(inspected.sampleRate, 24000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("1000-token request metadata accepts SDK-derived budgets and a 16-second whole waveform", async () => {
  const value = await fixture();
  try {
    const outputWav = join(value.root, "publish", "long-but-bounded.wav");
    const metadataPath = join(value.root, "publish", "long-but-bounded.json");
    await mkdir(dirname(outputWav), { recursive: true });
    const context = await runtimeContext(value);
    const bytes = wavFixture(16 * 24000);
    const result = await kittenProcessTest.runWithPins(
      generationOptions(value, outputWav, metadataPath), value.pins,
      fakeSuccessSpawner(context, value.pins, { wavBytes: bytes })
    );
    assert.equal(result.audio.durationSeconds, 16);
    assert.equal(result.runtime.completion.requestedMaxNewTokensPerChunk, 1000);
    assert.deepEqual(result.runtime.completion.sdkDerivedBudgets, [240]);
    assert.ok(result.runtime.completion.sdkDerivedBudgets.every((budget: number) => budget > 0 && budget <= 1000));
    assert.deepEqual(await readFile(outputWav), bytes);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("strict request budgets and the 180-second cap reject invalid metadata and WAVs", async () => {
  const value = await fixture();
  try {
    const outputWav = join(value.root, "publish", "bounded.wav");
    const metadataPath = join(value.root, "publish", "bounded.json");
    await mkdir(dirname(outputWav), { recursive: true });
    const context = await runtimeContext(value);
    const shortWav = wavFixture();
    const tooLongWav = wavFixture(181 * 24000);
    const mutations: Array<(metadata: JsonRecord) => void> = [
      (metadata) => { metadata.runtime.completion.requestedMaxNewTokensPerChunk = 999; },
      (metadata) => { metadata.runtime.completion.requestedMaxNewTokensPerChunk = 1001; },
      (metadata) => { metadata.runtime.completion.sdkDerivedBudgets[0] = 0; },
      (metadata) => { metadata.runtime.completion.sdkDerivedBudgets[0] = 1001; },
      (metadata) => { metadata.runtime.completion.sdkDerivedBudgets = []; },
      (metadata) => { metadata.audio.durationSeconds = 181; },
      (metadata) => { metadata.audio.frames = 181 * 24000; }
    ];
    for (const mutateMetadata of mutations) {
      await assert.rejects(
        kittenProcessTest.runWithPins(
          generationOptions(value, outputWav, metadataPath), value.pins,
          fakeSuccessSpawner(context, value.pins, { wavBytes: shortWav, mutateMetadata })
        ),
        (error: { code?: string }) => error.code === "runner/result-invalid"
      );
      await assert.rejects(readFile(outputWav), { code: "ENOENT" });
      await assert.rejects(readFile(metadataPath), { code: "ENOENT" });
    }
    const inspectPath = join(value.root, "above-cap.wav");
    await writeFile(inspectPath, tooLongWav);
    await assert.rejects(
      kittenProcessTest.inspectWav(inspectPath),
      (error: { code?: string }) => error.code === "output/wav-invalid"
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("invalid completion evidence is rejected before WAV or metadata staging", async () => {
  const value = await fixture();
  try {
    const outputWav = join(value.root, "publish", "sample.wav");
    const metadataPath = join(value.root, "publish", "sample.json");
    await mkdir(dirname(outputWav), { recursive: true });
    const context = await runtimeContext(value);
    const mutations: Array<(metadata: JsonRecord) => void> = [
      (metadata) => { delete metadata.runtime.completion; },
      (metadata) => { metadata.runtime.completion.generationUtilsSha256 = "0".repeat(64); },
      (metadata) => { metadata.runtime.completion.detail = "unapproved"; }
    ];
    for (const mutateMetadata of mutations) {
      await assert.rejects(
        kittenProcessTest.runWithPins(
          generationOptions(value, outputWav, metadataPath), value.pins,
          fakeSuccessSpawner(context, value.pins, { mutateMetadata })
        ),
        (error: { code?: string }) => error.code === "runner/result-invalid"
      );
      await assert.rejects(readFile(outputWav), { code: "ENOENT" });
      await assert.rejects(readFile(metadataPath), { code: "ENOENT" });
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("canonical output and metadata aliases are rejected before the runner starts", async () => {
  const value = await fixture();
  try {
    const outputWav = join(value.root, "same.wav");
    const aliasDirectory = join(value.root, "alias");
    await mkdir(aliasDirectory);
    let invoked = false;
    const options = generationOptions(value, outputWav, join(aliasDirectory, "..", "same.wav"));
    await assert.rejects(
      kittenProcessTest.runWithPins(options, value.pins, () => { invoked = true; throw new Error("must not run"); }),
      (error: { code?: string }) => error.code === "output/path-alias"
    );
    assert.equal(invoked, false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("no-clobber publication preserves a foreign output created before publication", async () => {
  const value = await fixture();
  try {
    const outputWav = join(value.root, "publish", "sample.wav");
    const metadataPath = join(value.root, "publish", "sample.json");
    await mkdir(dirname(outputWav), { recursive: true });
    const context = await runtimeContext(value);
    await assert.rejects(
      kittenProcessTest.runWithPins(generationOptions(value, outputWav, metadataPath), value.pins,
        fakeSuccessSpawner(context, value.pins, { foreignOutput: outputWav })),
      (error: { code?: string }) => error.code === "output/already-exists"
    );
    assert.equal(await readFile(outputWav, "utf8"), "foreign output");
    await assert.rejects(readFile(metadataPath), { code: "ENOENT" });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("metadata publication never clobbers a foreign sidecar and reports the owned partial WAV", async () => {
  const value = await fixture();
  try {
    const outputWav = join(value.root, "publish", "sample.wav");
    const metadataPath = join(value.root, "publish", "sample.json");
    await mkdir(dirname(outputWav), { recursive: true });
    const context = await runtimeContext(value);
    await assert.rejects(
      kittenProcessTest.runWithPins(generationOptions(value, outputWav, metadataPath), value.pins,
        fakeSuccessSpawner(context, value.pins, { foreignMetadata: metadataPath })),
      (error: { code?: string; partialOutput?: boolean }) => error.code === "output/metadata-already-exists" && error.partialOutput === true
    );
    assert.deepEqual(await readFile(metadataPath), Buffer.from("foreign metadata"));
    assert.deepEqual(await readFile(outputWav), wavFixture());
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("exclusive staging preserves a foreign path replaced after its descriptor opens", async () => {
  const root = await mkdtemp(join(tmpdir(), "cv-audio-kitten-staging-race-test-"));
  try {
    const source = join(root, "source.wav");
    const output = join(root, "output.wav");
    const openedFile = join(root, "opened-inode.wav");
    await writeFile(source, "owned source");
    await assert.rejects(
      kittenProcessTest.stageNoClobber(source, output, undefined, undefined, false, async (_handle: unknown, destination: string) => {
        await rename(destination, openedFile);
        await writeFile(destination, "foreign replacement");
      }),
      (error: { code?: string; partialOutput?: boolean }) => error.code === "output/staging-path-replaced" && error.partialOutput === true
    );
    assert.equal(await readFile(output, "utf8"), "foreign replacement");
    assert.equal(await readFile(openedFile, "utf8"), "owned source");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exclusive staging reports and leaves an owned partial file after write failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "cv-audio-kitten-staging-failure-test-"));
  try {
    const source = join(root, "source.wav");
    const output = join(root, "output.wav");
    await writeFile(source, "complete source");
    await assert.rejects(
      kittenProcessTest.stageNoClobber(source, output, undefined, undefined, false, async (handle: { writeFile(data: string): Promise<void> }) => {
        await handle.writeFile("partial output");
        throw new Error("injected write failure");
      }),
      (error: { code?: string; partialOutput?: boolean }) => error.code === "output/staging-write-failed" && error.partialOutput === true
    );
    assert.equal(await readFile(output, "utf8"), "partial output");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validated success metadata is safely published without local origins or device names", async () => {
  const value = await fixture();
  try {
    const outputWav = join(value.root, "publish", "sample.wav");
    const metadataPath = join(value.root, "publish", "sample.json");
    await mkdir(dirname(outputWav), { recursive: true });
    const context = await runtimeContext(value);
    const result = await kittenProcessTest.runWithPins(generationOptions(value, outputWav, metadataPath), value.pins,
      fakeSuccessSpawner(context, value.pins));
    const persisted = JSON.parse(await readFile(metadataPath, "utf8"));
    assert.equal(result.audio.path, outputWav);
    assert.equal(persisted.audio.sha256, digest(wavFixture()));
    assert.equal(persisted.runtime.model.gpu, undefined);
    assert.equal(persisted.runtime.imports[0].path, undefined);
    assert.equal(persisted.runtime.decoder.resolvedPath, undefined);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("runner error records are closed and never return unapproved payload fields", () => {
  assert.throws(() => kittenProcessTest.parseRunnerOutput("not-json"), (error: { code?: string }) => error.code === "runner/protocol-invalid");
  assert.throws(
    () => kittenProcessTest.parseRunnerOutput(JSON.stringify({ status: "error", code: "runtime/device-unavailable", stage: "single local inference", text: "SECRET SYNTHESIS INPUT" })),
    (error: { code?: string; message?: string; stage?: string }) => {
      assert.equal(error.code, "runner/failed");
      assert.equal(error.message, "runner/failed");
      assert.equal(error.stage, null);
      assert.doesNotMatch(error.message ?? "", /SECRET/);
      return true;
    }
  );
});

test("completion reasons cross the Python-to-Node boundary only as closed, content-free fields", async () => {
  const runnerPath = fileURLToPath(new URL("../scripts/cv-audio/kitten-runner.py", import.meta.url));
  const serializer = [
    "import contextlib,importlib.util,io,json,sys",
    "spec=importlib.util.spec_from_file_location('kitten_runner',sys.argv[1])",
    "runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)",
    "def emit(code,stage,reason):",
    " runner.STAGE=stage",
    " runner.main=lambda: runner.fail(code,reason)",
    " output=io.StringIO()",
    " try:",
    "  with contextlib.redirect_stdout(output): runner.entrypoint()",
    " except SystemExit as error: assert error.code == 2",
    " return json.loads(output.getvalue())",
    "records=[emit('output/completion-invalid','single local inference','terminal-marker-missing'),",
    " emit('output/completion-invalid','model load','terminal-marker-missing'),",
    " emit('runtime/device-unavailable','single local inference','terminal-marker-missing')]",
    "print(json.dumps(records,separators=(',',':')))"
  ].join("\n");
  const execution = await execFileAsync("python3", ["-I", "-B", "-c", serializer, runnerPath], {
    timeout: 5000, maxBuffer: 4096
  });
  assert.equal(execution.stderr, "");
  const [record, wrongStage, wrongCode] = JSON.parse(execution.stdout);
  assert.deepEqual(wrongStage, {
    status: "error", code: "output/completion-invalid", stage: "model load"
  });
  assert.deepEqual(wrongCode, {
    status: "error", code: "runtime/device-unavailable", stage: "single local inference"
  });
  assert.deepEqual(record, {
    status: "error", code: "output/completion-invalid", stage: "single local inference",
    reason: "terminal-marker-missing"
  });
  assert.throws(() => kittenProcessTest.parseRunnerOutput(JSON.stringify(record)), (error: JsonRecord) => {
    assert.equal(error.code, "runner/output/completion-invalid");
    assert.equal(error.message, "runner/output/completion-invalid");
    assert.equal(error.stage, "single local inference");
    assert.equal(error.reason, "terminal-marker-missing");
    return true;
  });

  const generic = { status: "error", code: "output/completion-invalid", stage: "single local inference" };
  assert.throws(() => kittenProcessTest.parseRunnerOutput(JSON.stringify(generic)), (error: JsonRecord) => {
    assert.equal(error.code, "runner/output/completion-invalid");
    assert.equal(error.message, "runner/output/completion-invalid");
    assert.equal(error.reason, undefined);
    return true;
  });

  for (const malformed of [
    { ...record, reason: "unknown completion reason" },
    { ...record, reason: "SECRET INPUT / traceback" },
    { ...record, reason: { value: "terminal-marker-missing" } },
    { ...record, code: "runtime/device-unavailable" },
    { ...record, stage: "model load" },
    { ...record, extra: "SECRET PRIVATE PATH" }
  ]) {
    assert.throws(() => kittenProcessTest.parseRunnerOutput(JSON.stringify(malformed)), (error: JsonRecord) => {
      assert.equal(error.code, "runner/failed");
      assert.equal(error.message, "runner/failed");
      assert.equal(error.reason, undefined);
      assert.doesNotMatch(error.message, /SECRET|PRIVATE/);
      return true;
    });
  }
  const unrelated = new KittenTaskError(
    "runner/runtime/device-unavailable", "single local inference", { reason: "terminal-marker-missing" }
  );
  assert.equal(unrelated.reason, undefined);
});

test("model-load reports preserve only the fixed classification schema", () => {
  const record = {
    status: "error", code: "runtime/model-load-cuda-oom", stage: "model load",
    kind: "cuda-oom", callSite: "kittenml.get_model.KittenTTS.__new__", errno: 12
  };
  assert.throws(() => kittenProcessTest.parseRunnerOutput(JSON.stringify(record)), (error: JsonRecord) => {
    assert.equal(error.code, "runner/runtime/model-load-cuda-oom");
    assert.equal(error.stage, "model load");
    assert.equal(error.kind, "cuda-oom");
    assert.equal(error.callSite, "kittenml.get_model.KittenTTS.__new__");
    assert.equal(error.errno, 12);
    return true;
  });
  for (const unsafe of [
    { ...record, detail: "SECRET EXCEPTION TEXT" },
    { ...record, kind: "cuda-oom: SECRET" },
    { ...record, callSite: "/private/path/model.py" },
    { ...record, errno: 999999 }
  ]) {
    assert.throws(() => kittenProcessTest.parseRunnerOutput(JSON.stringify(unsafe)), (error: { code?: string; message?: string }) => {
      assert.equal(error.code, "runner/failed");
      assert.equal(error.message, "runner/failed");
      assert.doesNotMatch(error.message ?? "", /SECRET|private/);
      return true;
    });
  }
});

test("Python model-load exception classification is closed and does not expose exception text or paths", async () => {
  const runnerPath = fileURLToPath(new URL("../scripts/cv-audio/kitten-runner.py", import.meta.url));
  const bytecodeFiles = async () => (await readdir(join(dirname(runnerPath), "__pycache__")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })).filter((name) => name.startsWith("kitten-runner."));
  const bytecodeBefore = await bytecodeFiles();
  const classifier = [
    "import importlib.util,json,sys,types",
    "assert sys.dont_write_bytecode is True",
    "spec=importlib.util.spec_from_file_location('kitten_runner',sys.argv[1])",
    "runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)",
    "class FakeCudaOOM(Exception): pass",
    "torch=types.SimpleNamespace(cuda=types.SimpleNamespace(OutOfMemoryError=FakeCudaOOM))",
    "errors=[FakeCudaOOM('SECRET'),MemoryError('SECRET'),FileNotFoundError(2,'SECRET','/private/weight'),PermissionError(13,'SECRET','/private/weight'),ModuleNotFoundError('SECRET'),RuntimeError('CUDA out of memory SECRET'),ValueError('SECRET')]",
    "print(json.dumps([runner.classify_model_load_exception(e,torch) for e in errors],sort_keys=True))"
  ].join("\n");
  const { stdout, stderr } = await execFileAsync("python3", ["-I", "-B", "-c", classifier, runnerPath], { timeout: 5000, maxBuffer: 4096 });
  assert.equal(stderr, "");
  const reports = JSON.parse(stdout);
  assert.deepEqual(reports.map((item: JsonRecord) => [item.code, item.kind, item.errno ?? null]), [
    ["runtime/model-load-cuda-oom", "cuda-oom", null],
    ["runtime/model-load-memory-exhausted", "memory", null],
    ["runtime/model-load-file-not-found", "file-not-found", 2],
    ["runtime/model-load-permission-denied", "permission", 13],
    ["runtime/model-load-dependency-unavailable", "dependency", null],
    ["runtime/model-load-runtime-error", "runtime-error", null],
    ["runtime/model-load-unexpected", "other", null]
  ]);
  assert.ok(reports.every((item: JsonRecord) => item.stage === "model load" && item.callSite === "kittenml.get_model.KittenTTS.__new__"));
  assert.doesNotMatch(stdout, /SECRET|private|weight/);
  assert.deepEqual(await bytecodeFiles(), bytecodeBefore);
});

test("nonzero fake runner preserves only its allowlisted error code and stage", async () => {
  const root = await mkdtemp(join(tmpdir(), "cv-audio-kitten-status-test-"));
  try {
    const sandbox = join(root, "fake-sandbox.sh");
    await writeFile(sandbox, `#!/bin/sh\nprintf '%s\\n' '{"status":"error","code":"runtime/device-unavailable","stage":"model load"}'\nexit 2\n`);
    await chmod(sandbox, 0o755);
    const output = await kittenProcessTest.runChild({
      pythonExecutable: "/bin/false", sandboxExecutable: sandbox, runRoot: root, timeoutMs: 3000,
      inputs: { text: "synthetic", sdkRoot: root, sdkArchive: root, modelSnapshot: root, hubCache: root },
      moduleRoots: [], spawnProcess: spawn
    });
    assert.throws(
      () => kittenProcessTest.parseRunnerOutput(output),
      (error: { code?: string; stage?: string; message?: string }) => {
        assert.equal(error.code, "runner/runtime/device-unavailable");
        assert.equal(error.stage, "model load");
        assert.equal(error.message, "runner/runtime/device-unavailable");
        assert.doesNotMatch(error.message ?? "", /SECRET/);
        return true;
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nonzero fake child accepts a closed model-load classification", async () => {
  const root = await mkdtemp(join(tmpdir(), "cv-audio-kitten-model-load-status-test-"));
  try {
    const sandbox = join(root, "fake-sandbox.sh");
    const record = JSON.stringify({
      status: "error", code: "runtime/model-load-cuda-oom", stage: "model load", kind: "cuda-oom",
      callSite: "kittenml.get_model.KittenTTS.__new__", errno: 12
    });
    await writeFile(sandbox, `#!/bin/sh\nprintf '%s\\n' '${record}'\nexit 2\n`);
    await chmod(sandbox, 0o755);
    const output = await kittenProcessTest.runChild({
      pythonExecutable: "/bin/false", sandboxExecutable: sandbox, runRoot: root, timeoutMs: 3000,
      inputs: { text: "synthetic", sdkRoot: root, sdkArchive: root, modelSnapshot: root, hubCache: root },
      moduleRoots: [], spawnProcess: spawn
    });
    assert.throws(() => kittenProcessTest.parseRunnerOutput(output), (error: JsonRecord) => {
      assert.equal(error.code, "runner/runtime/model-load-cuda-oom");
      assert.equal(error.stage, "model load");
      assert.equal(error.kind, "cuda-oom");
      assert.equal(error.errno, 12);
      assert.equal(error.callSite, "kittenml.get_model.KittenTTS.__new__");
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter pre-launch window check blocks spawning when setup consumed the reserved call and settlement window", async () => {
  let spawnCount = 0;
  await assert.rejects(kittenProcessTest.runChild({
    pythonExecutable: "/synthetic/python", sandboxExecutable: "/synthetic/sandbox", runRoot: "/synthetic/work",
    timeoutMs: 6000, deadlineAt: 10000, requiredAfterProcessMs: 5000, monotonicNow: () => 0,
    termGraceMs: 250, killSettlementReserveMs: 5000,
    inputs: { text: "synthetic", sdkRoot: "/synthetic/sdk", sdkArchive: "/synthetic/archive", modelSnapshot: "/synthetic/model", hubCache: "/synthetic/hub" },
    moduleRoots: [], spawnProcess: () => { spawnCount += 1; throw new Error("must not spawn"); },
  }), (error: { code?: string }) => error.code === "deadline/window-insufficient");
  assert.equal(spawnCount, 0);
});

test("adapter cancellation before spawn launches no child", async () => {
  const owned = trackedAbortSignal();
  owned.abort();
  let spawnCount = 0;
  await assert.rejects(kittenProcessTest.runChild({
    pythonExecutable: "/synthetic/python", sandboxExecutable: "/synthetic/sandbox", runRoot: "/synthetic/work",
    timeoutMs: 5000, signal: owned.signal,
    inputs: { text: "synthetic", sdkRoot: "/synthetic/sdk", sdkArchive: "/synthetic/archive", modelSnapshot: "/synthetic/model", hubCache: "/synthetic/hub" },
    moduleRoots: [], spawnProcess: () => { spawnCount += 1; throw new Error("must not spawn"); },
  }), (error: { code?: string }) => error.code === "runner/cancelled");
  assert.equal(spawnCount, 0);
});

test("adapter cancellation sends bounded TERM/KILL to its owned child and waits for close", async () => {
  const owned = trackedAbortSignal();
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  const signals: string[] = [];
  const scheduled = new Set<unknown>();
  const cleared = new Set<unknown>();
  child.kill = (signal: string) => {
    signals.push(signal);
    if (signal === "SIGKILL") setTimeout(() => child.emit("close", null, "SIGKILL"), 80);
    return true;
  };
  let settled = false;
  const pending = kittenProcessTest.runChild({
    pythonExecutable: "/synthetic/python", sandboxExecutable: "/synthetic/sandbox", runRoot: "/synthetic/work",
    timeoutMs: 5000, signal: owned.signal, termGraceMs: 10, killSettlementReserveMs: 5000,
    inputs: { text: "synthetic", sdkRoot: "/synthetic/sdk", sdkArchive: "/synthetic/archive", modelSnapshot: "/synthetic/model", hubCache: "/synthetic/hub" },
    moduleRoots: [], spawnProcess: () => child,
    setTimer(callback: () => void, delay: number) { const handle = setTimeout(callback, delay); scheduled.add(handle); return handle; },
    clearTimer(handle: unknown) { cleared.add(handle); clearTimeout(handle as ReturnType<typeof setTimeout>); },
  }).then((value: string) => { settled = true; return value; }, (error: { code?: string }) => { settled = true; throw error; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(owned.listenerCount(), 1);
  owned.abort();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(settled, false, "SIGKILL is not process settlement");
  assert.equal(owned.listenerCount(), 1, "cancellation ownership lasts through close");
  await assert.rejects(pending, (error: { code?: string }) => error.code === "runner/cancelled");
  assert.equal(settled, true);
  assert.equal(owned.listenerCount(), 0);
  assert.equal(scheduled.size, 2);
  assert.equal(cleared.size, 2);
});

test("timeout kills and waits for the owned process group", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cv-audio-kitten-timeout-test-"));
  try {
    const pidFile = join(root, "pid");
    const executable = join(root, "slow-runner.sh");
    const sandbox = join(root, "test-sandbox.sh");
    await writeFile(executable, `#!/bin/sh\nprintf '%s' "$$" > '${pidFile}'\nsleep 20\n`);
    await writeFile(sandbox, `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    --unshare-net) shift ;;\n    --ro-bind|--bind|--dev-bind) shift 3 ;;\n    --proc|--chdir) shift 2 ;;\n    --) shift; break ;;\n    *) break ;;\n  esac\ndone\nexec "$@"\n`);
    await chmod(executable, 0o755);
    await chmod(sandbox, 0o755);
    await assert.rejects(
      kittenProcessTest.runChild({
        pythonExecutable: executable, sandboxExecutable: sandbox, runRoot: root, timeoutMs: 300,
        inputs: { text: "synthetic", sdkRoot: root, sdkArchive: root, modelSnapshot: root, hubCache: root },
        moduleRoots: [], spawnProcess: spawn
      }),
      (error: { code?: string }) => error.code === "runner/timeout"
    );
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("neutral PCM16 WAV protocol accepts finite, nonzero 24 kHz mono audio and rejects fullscale", async () => {
  const root = await mkdtemp(join(tmpdir(), "cv-audio-kitten-wav-test-"));
  try {
    const path = join(root, "neutral.wav");
    const bytes = wavFixture();
    await writeFile(path, bytes);
    const result = await kittenProcessTest.inspectWav(path);
    assert.equal(result.bytes, bytes.length);
    assert.equal(result.sha256, digest(bytes));
    assert.equal(result.sampleRate, 24000);
    assert.equal(result.channels, 1);
    assert.equal(result.frames, 480);
    const clipped = Buffer.from(bytes);
    clipped.writeInt16LE(32767, 44);
    await writeFile(path, clipped);
    await assert.rejects(kittenProcessTest.inspectWav(path), (error: { code?: string }) => error.code === "output/wav-invalid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
