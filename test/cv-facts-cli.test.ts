import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { contentSha256, PINNED_EMBEDDING, validateArtifact } from "../scripts/cv-facts/artifact.mjs";
import { readCanonicalSource, REVIEWED_ARTIFACT_PATH } from "../scripts/cv-facts/paths.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const cliPath = path.join(repositoryRoot, "scripts", "cv-facts.mjs");
const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
const source = readCanonicalSource();
const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cv-facts-cli-"));

test.after(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

const DOCUMENTED_COMMANDS = ["prepare", "embed", "check", "promote"] as const;
const PACKAGE_SCRIPTS = ["cv:facts", "cv:facts:embed", "cv:facts:check", "cv:facts:promote"] as const;

function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function syntheticVector(seed: number) {
  const raw = Array.from({ length: 384 }, (_, index) => ((index + seed) % 11) / 11 - 0.5);
  const norm = Math.sqrt(raw.reduce((total, value) => total + value * value, 0));

  return raw.map((value) => Number((value / norm).toFixed(6)));
}

function syntheticCandidate(sourceSha256: string, lineCount: number) {
  const cards = [
    {
      id: "fixture-card",
      topic: "A synthetic topic",
      tags: ["synthetic"],
      sourceRefs: [{ startLine: 1, endLine: Math.min(3, lineCount) }],
      answer: "A synthetic answer for a command-level fixture.",
      vector: syntheticVector(1),
    },
  ];

  return {
    version: 1,
    source: { path: source.relativePath, sha256: sourceSha256 },
    embedding: {
      model: "mixedbread-ai/mxbai-embed-xsmall-v1",
      revision: "e6ac24e5d6efb8782b59de1647b3ececb4ece94e",
      dtype: "q8",
      runtimeVersion: "4.3.0",
      pooling: "mean",
      normalize: true,
      dimensions: 384,
      inputVersion: "retrieval-text-v1",
      contentSha256: contentSha256(cards),
    },
    cards,
  };
}

function writeCandidate(name: string, artifact: unknown) {
  const file = path.join(workspace, name);

  fs.writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`);

  return file;
}

test("the documented commands are listed in --help and match the CLI", () => {
  const result = run(["--help"]);

  assert.equal(result.status, 0);

  for (const command of DOCUMENTED_COMMANDS) {
    assert.match(result.stdout, new RegExp(`^  ${command}\\s`, "m"), `--help must document ${command}`);
  }

  assert.match(result.stdout, /--out <dir>/);
  assert.match(result.stdout, /--candidate <path>/);
  assert.match(result.stdout, /--confirm-reviewed/);
  assert.match(result.stdout, /only command that reaches the network/);
  assert.match(result.stdout, /Writes nothing and runs no inference/);
  assert.match(result.stdout, /neither answer truth nor retrieval quality/);

  assert.equal(run(["help"]).stdout, result.stdout);
  assert.equal(run(["prepare", "--help"]).status, 0);
  assert.equal(run(["check", "--help"]).stdout, result.stdout);
});

test("an unknown command or option is refused", () => {
  for (const args of [["explain"], ["check", "--nope"], ["check", "--candidate"], ["prepare", "extra"]]) {
    const result = run(args);

    assert.equal(result.status, 1, `${args.join(" ")} must fail`);
    assert.match(result.stderr, /\[cv\] cv-facts\/cli\//);
  }
});

/**
 * The reviewed index exists from the first successful promotion onward, so a command that
 * must not write it is proven by its bytes instead of by its absence. `null` covers the
 * window before the first promotion, where any write would create the file.
 */
function reviewedBytes() {
  return fs.existsSync(REVIEWED_ARTIFACT_PATH) ? fs.readFileSync(REVIEWED_ARTIFACT_PATH) : null;
}

test("prepare refuses a workspace inside the repository", () => {
  const before = reviewedBytes();
  const result = run(["prepare", "--out", "resources/cv"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /cv-facts\/path\/inside-repository/);
  assert.deepEqual(reviewedBytes(), before, "prepare must not write into the repository");
});

test("embed and promote refuse a candidate inside the repository", () => {
  for (const args of [
    ["embed", "--candidate", "resources/cv/facts.json"],
    ["promote", "--candidate", "resources/cv/facts.json", "--confirm-reviewed"],
    ["check", "--candidate", "resources/cv/source/cv.md"],
  ]) {
    const result = run(args);

    assert.equal(result.status, 1, `${args.join(" ")} must fail`);
    assert.match(result.stderr, /cv-facts\/path\/inside-repository/);
  }
});

test("check passes an external candidate, is offline and reports its scope", () => {
  const candidatePath = writeCandidate("valid.json", syntheticCandidate(source.sha256, source.lineCount));
  const before = fs.readFileSync(candidatePath);
  const reviewed = reviewedBytes();
  const result = run(["check", "--candidate", candidatePath]);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\[cv\] check passed for 1 cards from candidate/);
  assert.match(result.stdout, /neither answer truth nor retrieval quality/);
  assert.deepEqual(fs.readFileSync(candidatePath), before);
  assert.deepEqual(reviewedBytes(), reviewed, "checking a candidate must not write the reviewed index");
});

test("check fails a candidate with a stale source digest and prints no source text", () => {
  const artifact = syntheticCandidate(source.sha256, source.lineCount);

  artifact.source.sha256 = "0".repeat(64);
  artifact.cards[0].answer = "An answer quoting a confidential source detail verbatim.";

  const result = run(["check", "--candidate", writeCandidate("stale.json", artifact)]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /\[cv\] check: source\/digest/);
  assert.match(result.stdout, /check failed with 2 findings/);
  assert.equal(result.stdout.includes("confidential source detail"), false);
  assert.equal(result.stdout.includes(source.sha256), false);
  assert.equal(result.stderr, "");
});

test("check without a candidate validates the reviewed index", () => {
  const result = run(["check"]);

  assert.ok(reviewedBytes(), "the reviewed index is the default target of check");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\[cv\] check passed for \d+ cards from the reviewed index/);
  assert.match(result.stdout, /neither answer truth nor retrieval quality/);
});

test("a failure reports its rule id only, whatever the environment asks for", () => {
  const result = run(["check", "--candidate", path.join(workspace, "absent-candidate.json")], {
    CV_FACTS_DEBUG: "1",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "[cv] cv-facts/path/not-a-file\n");

  const cliSource = fs.readFileSync(cliPath, "utf8");

  assert.equal(cliSource.includes("CV_FACTS_DEBUG"), false, "no debug branch may print a raw failure");
  assert.equal(cliSource.includes("console.error(error)"), false);
});

test("promote requires the acknowledgment flag and never writes without it", () => {
  const candidatePath = writeCandidate("promote-valid.json", syntheticCandidate(source.sha256, source.lineCount));
  const reviewed = reviewedBytes();
  const withoutFlag = run(["promote", "--candidate", candidatePath]);

  assert.equal(withoutFlag.status, 1);
  assert.match(withoutFlag.stderr, /cv-facts\/promote\/confirmation-missing/);
  assert.deepEqual(reviewedBytes(), reviewed);

  const withoutCandidate = run(["promote", "--confirm-reviewed"]);

  assert.equal(withoutCandidate.status, 1);
  assert.match(withoutCandidate.stderr, /cv-facts\/cli\/required-option-missing/);
  assert.deepEqual(reviewedBytes(), reviewed);
});

test("a failing promotion leaves the reviewed index untouched and prints no review claim", () => {
  const artifact = syntheticCandidate(source.sha256, source.lineCount);
  const reviewed = reviewedBytes();

  artifact.cards[0].answer = "";

  const result = run([
    "promote",
    "--candidate",
    writeCandidate("promote-invalid.json", artifact),
    "--confirm-reviewed",
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /\[cv\] promote: card\/answer cards\[0\] card=fixture-card/);
  assert.match(result.stdout, /promote failed; the reviewed index is untouched/);
  assert.equal(/review (passed|recorded|complete|proof)/.test(result.stdout), false);
  assert.deepEqual(reviewedBytes(), reviewed, "a rejected candidate must not replace the reviewed index");
});

test("the package scripts map to the four commands and the skill documents the same ones", () => {
  const expected = DOCUMENTED_COMMANDS.map((command) => `node ./scripts/cv-facts.mjs ${command}`);

  PACKAGE_SCRIPTS.forEach((script, index) => {
    assert.equal(manifest.scripts[script], expected[index], `${script} must map to ${expected[index]}`);
  });

  const skill = fs.readFileSync(path.join(repositoryRoot, ".github", "skills", "cv-facts", "SKILL.md"), "utf8");

  for (const script of PACKAGE_SCRIPTS) assert.match(skill, new RegExp(`\`pnpm ${script}\\b`));

  for (const command of DOCUMENTED_COMMANDS) {
    assert.match(skill, new RegExp(`pnpm ${PACKAGE_SCRIPTS[DOCUMENTED_COMMANDS.indexOf(command)]}`));
  }

  const documentedInSkill = [...skill.matchAll(/node \.\/scripts\/cv-facts\.mjs ([a-z]+)/g)].map(
    (match) => match[1],
  );

  assert.deepEqual([...new Set(documentedInSkill)].sort(), [...DOCUMENTED_COMMANDS].sort());
  assert.equal(skill.includes("@mlc-ai/web-llm"), false);
});

/**
 * Every pnpm example the skill shows must be the working form. The name boundary in the
 * assertion above is what lets a complete example carry its options; this test is what stops the
 * document from drifting back to a bare name or to the delimiter this pnpm rejects. The single
 * example the skill shows as failing is exempt, and that exemption is stated in the document
 * next to the example rather than assumed here.
 */
test("every pnpm example in the skill is the working form this pnpm routes", () => {
  const skill = fs.readFileSync(path.join(repositoryRoot, ".github", "skills", "cv-facts", "SKILL.md"), "utf8");
  const documentedFailure = "cv-facts/cli/unknown-option";
  const working: string[] = [];
  let failingExamples = 0;

  // The rule id can sit on the next line of a wrapped sentence, so the exemption looks at the
  // short window of text that follows the example rather than at its own line.
  for (const match of skill.matchAll(/`(pnpm [a-z:]+[^`]*)`/g)) {
    const example = match[1];
    const follows = skill.slice(match.index, match.index + example.length + 200);

    if (follows.includes(documentedFailure)) failingExamples++;
    else working.push(example);
  }

  assert.ok(working.length >= PACKAGE_SCRIPTS.length, "the skill must show at least one example per script");
  assert.ok(failingExamples <= 1, "at most one pnpm example may show the failing delimiter, beside its rule id");
  assert.ok(failingExamples >= 1, "the skill must keep showing the delimiter failure it warns about");

  for (const example of working) {
    const [runner, script, ...tokens] = example.split(" ");

    assert.equal(runner, "pnpm", `${example} is not a pnpm invocation`);
    assert.notEqual(tokens[0], "--", `${example} passes a literal -- that this pnpm forwards to the CLI`);
    assert.ok(
      PACKAGE_SCRIPTS.includes(script as (typeof PACKAGE_SCRIPTS)[number]),
      `${example} names no package script`,
    );

    // Split on whitespace outside placeholders, so `<external dir>` stays one token. Every
    // remaining token is either a placeholder or an option flag; a bare word would mean the
    // example documents an argument the CLI has no option for.
    for (const token of tokens.join(" ").match(/<[^>]+>|\[[^\]]+\]|\S+/g) ?? []) {
      if (token === "" || token.startsWith("<") || token.startsWith("[")) continue;
      assert.match(token, /^--[a-z][a-z-]*$/, `${example} carries a token that is not an option: ${token}`);
    }
  }

  // The delimiter claim is verified by execution, not by reading the sentence about it.
  const routed = run(["check", "--help"]);
  const misrouted = run(["check", "--", "--help"]);

  assert.equal(routed.status, 0, routed.stdout + routed.stderr);
  assert.match(routed.stdout, /Usage:/);
  assert.equal(misrouted.status, 1);
  assert.equal(misrouted.stderr.trim(), "[cv] cv-facts/cli/unknown-option");
});

test("no new parser dependency is added and prepare reaches neither the model nor the network", () => {
  const helperDirectory = path.join(repositoryRoot, "scripts", "cv-facts");

  /** Static import specifiers only, so a dynamic import inside a command is not counted. */
  function staticImports(file: string): string[] {
    const source = fs.readFileSync(file, "utf8");

    return [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gm)].map((match) => match[1]);
  }

  const extractImports = staticImports(path.join(helperDirectory, "extract.mjs"));

  assert.deepEqual(
    extractImports.filter((specifier) => !specifier.startsWith(".")),
    ["remark", "remark-gfm"],
  );

  const cliSource = fs.readFileSync(cliPath, "utf8");

  assert.equal(
    staticImports(cliPath).some((specifier) => specifier.includes("embedding")),
    false,
    "the CLI must reach the embedding runtime only through its own dynamic import",
  );
  assert.match(cliSource, /await import\("\.\/cv-facts\/embedding\.mjs"\)/);

  // Walk everything the CLI imports statically and prove no branch of it reaches the model.
  const visited = new Set<string>();
  const queue = [cliPath];

  while (queue.length > 0) {
    const file = queue.pop() as string;

    if (visited.has(file)) continue;
    visited.add(file);

    for (const specifier of staticImports(file)) {
      assert.doesNotMatch(
        specifier,
        /@huggingface\/transformers|onnxruntime|node:https|node:net|node:http/,
        `${file} must not statically reach the model or a network client`,
      );
      if (specifier.startsWith(".")) queue.push(path.resolve(path.dirname(file), specifier));
    }
  }

  assert.ok(visited.has(path.join(helperDirectory, "extract.mjs")));
  assert.equal(visited.has(path.join(helperDirectory, "embedding.mjs")), false);
});

test("the checked-in CV digest is the one the commands and the review gate depend on", () => {
  assert.equal(source.sha256, createHash("sha256").update(source.bytes).digest("hex"));
  assert.equal(source.lineCount > 1, true);
  assert.deepEqual(validateArtifact(syntheticCandidate(source.sha256, source.lineCount), {
    sourceRelativePath: source.relativePath,
    sourceSha256: source.sha256,
    sourceLineCount: source.lineCount,
  }).findings, []);
});

/**
 * The build gate is `build` and `build:site` running the offline check before the bundler. It
 * is proved on an isolated synthetic project rather than on the shipping artifact: the earlier
 * pass zeroed the shared reviewed index in place to prove this rule, which mutated the very file
 * the rule protects. The standing rule is that fault injection uses isolated synthetic targets,
 * so this test builds one.
 *
 * What is real here and what is not:
 *   - real: the manifest's own `build`, `build:site` and `cv:facts:check` strings, byte for byte;
 *     the generator files, copied byte for byte and asserted to be identical to the repository's;
 *     this project's real pnpm routing; the real checker reading a real synthetic CV file.
 *   - stubbed: `tsc` and `vite`, replaced by shell stubs that only append their name to a log,
 *     so that the position of the gate in the chain is observable without a compiler or a
 *     bundler, and without a full site build.
 *   - synthetic: a three-line CV and a one-card index. No CV text, no model weights and no
 *     fixture are copied, and the repository's own index and CV are only read, at the end, to
 *     prove they were untouched.
 *
 * The ancestor `node_modules` symlink exists because the copied extractor imports `remark`, which
 * the CLI reaches statically through `prepare` even on the check path. It hangs off the temporary
 * root rather than the project so that pnpm sees no project-level `node_modules` and does not try
 * to install anything.
 */
test("both build scripts run the offline gate and stop before the bundler on a stale index", { timeout: 180_000 }, () => {
  const reviewedBefore = fs.readFileSync(REVIEWED_ARTIFACT_PATH);
  const sourceBytesBefore = fs.readFileSync(path.join(repositoryRoot, "resources", "cv", "source", "cv.md"));
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cv-facts-build-gate-"));
  const project = path.join(root, "project");
  const logFile = path.join(root, "chain.log");

  /**
   * @param {string} name the package script to run in the synthetic project
   * @returns {{ status: number | null, output: string, chain: string[] }} the combined output and
   *   the order the compiler and bundler stubs ran in
   */
  function runBuildScript(name: string) {
    fs.writeFileSync(logFile, "");
    const result = spawnSync("pnpm", ["run", name], {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, PATH: `${path.join(project, "bin")}:${process.env.PATH ?? ""}`, GATE_LOG: logFile },
      timeout: 120_000,
    });

    return {
      status: result.status,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
      chain: fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean),
    };
  }

  try {
    fs.mkdirSync(path.join(project, "scripts", "cv-facts"), { recursive: true });
    fs.mkdirSync(path.join(project, "resources", "cv", "source"), { recursive: true });
    fs.mkdirSync(path.join(project, "bin"), { recursive: true });
    fs.symlinkSync(path.join(repositoryRoot, "node_modules"), path.join(root, "node_modules"), "dir");

    fs.copyFileSync(cliPath, path.join(project, "scripts", "cv-facts.mjs"));
    for (const file of fs.readdirSync(path.join(repositoryRoot, "scripts", "cv-facts"))) {
      if (!file.endsWith(".mjs")) continue;
      fs.copyFileSync(path.join(repositoryRoot, "scripts", "cv-facts", file), path.join(project, "scripts", "cv-facts", file));
    }

    // The copied checker must be this repository's checker, not a lookalike.
    for (const [from, to] of [
      [cliPath, path.join(project, "scripts", "cv-facts.mjs")],
      ...fs
        .readdirSync(path.join(repositoryRoot, "scripts", "cv-facts"))
        .filter((file) => file.endsWith(".mjs"))
        .map((file) => [
          path.join(repositoryRoot, "scripts", "cv-facts", file),
          path.join(project, "scripts", "cv-facts", file),
        ]),
    ]) {
      assert.deepEqual(fs.readFileSync(to), fs.readFileSync(from), `${path.basename(from)} was not copied unchanged`);
    }

    for (const stub of ["tsc", "cv-audio-check", "vite"]) {
      const stubPath = path.join(project, "bin", stub);

      fs.writeFileSync(stubPath, `#!/bin/sh\necho "${stub} ran" >> "$GATE_LOG"\nexit 0\n`, { mode: 0o755 });
    }

    // A synthetic CV of three lines. Nothing from the canonical CV is copied.
    const syntheticSource = ["# Synthetic build-gate source", "", "A synthetic sentence that exists only for this test."].join("\n");

    fs.writeFileSync(path.join(project, "resources", "cv", "source", "cv.md"), `${syntheticSource}\n`);

    const cards = [
      {
        id: "synthetic-gate-card",
        topic: "A synthetic topic",
        tags: ["synthetic", "build gate"],
        sourceRefs: [{ startLine: 1, endLine: 3 }],
        answer: "A synthetic answer that exists only inside this test.",
        vector: syntheticVector(3),
      },
    ];
    const indexPath = path.join(project, "resources", "cv", "facts.json");
    const validIndex = `${JSON.stringify(
      {
        version: 1,
        source: { path: "resources/cv/source/cv.md", sha256: createHash("sha256").update(`${syntheticSource}\n`).digest("hex") },
        embedding: { ...PINNED_EMBEDDING, contentSha256: contentSha256(cards) },
        cards,
      },
      null,
      2,
    )}\n`;

    fs.writeFileSync(indexPath, validIndex);

    fs.writeFileSync(
      path.join(project, "package.json"),
      `${JSON.stringify(
        {
          name: "synthetic-build-gate",
          private: true,
          type: "module",
          packageManager: manifest.packageManager,
          scripts: {
            build: manifest.scripts.build,
            "build:site": manifest.scripts["build:site"],
            "cv:facts:check": manifest.scripts["cv:facts:check"],
            "cv:audio:check": "cv-audio-check",
          },
        },
        null,
        2,
      )}\n`,
    );

    // The gate is only worth asserting if the wiring is the shipping wiring.
    assert.equal(manifest.scripts.build, "tsc -b && pnpm cv:facts:check && pnpm cv:audio:check && vite build");
    assert.equal(manifest.scripts["build:site"], "tsc -b && pnpm cv:facts:check && pnpm cv:audio:check && vite build");
    assert.equal(manifest.scripts["cv:facts:check"], "node ./scripts/cv-facts.mjs check");

    for (const name of ["build", "build:site"]) {
      const passing = runBuildScript(name);

      assert.equal(passing.status, 0, passing.output);
      assert.match(passing.output, /check passed for 1 cards from the reviewed index/);
      assert.deepEqual(
        passing.chain,
        ["tsc ran", "cv-audio-check ran", "vite ran"],
        `${name} must run both offline gates between compile and bundle`,
      );

      // The fault is index level: the index no longer claims the digest of the file beside it.
      fs.writeFileSync(
        indexPath,
        validIndex.replace(/"sha256": "[0-9a-f]{64}"/, `"sha256": "${"0".repeat(64)}"`),
      );
      const failing = runBuildScript(name);

      assert.notEqual(failing.status, 0, `${name} must fail on a stale index`);
      assert.match(failing.output, /\[cv\] check: source\/digest/);
      assert.equal(failing.output.includes("A synthetic sentence"), false, "the gate must print no source text");
      assert.deepEqual(failing.chain, ["tsc ran"], `${name} must stop before the bundler`);

      // The exact bytes restore the build, so the failure above was the digest and nothing else.
      fs.writeFileSync(indexPath, validIndex);
      const restored = runBuildScript(name);

      assert.equal(restored.status, 0, restored.output);
      assert.deepEqual(restored.chain, ["tsc ran", "cv-audio-check ran", "vite ran"]);
    }

    // The regression value of the loop above, shown rather than asserted about. With the gate
    // removed from the same synthetic build string and the same stale index in place, the build
    // succeeds and the bundler runs. That is the state the check above refuses, so the test can
    // tell a working gate from a working `&&`.
    fs.writeFileSync(
      indexPath,
      validIndex.replace(/"sha256": "[0-9a-f]{64}"/, `"sha256": "${"0".repeat(64)}"`),
    );
    fs.writeFileSync(
      path.join(project, "package.json"),
      `${JSON.stringify({ name: "synthetic-build-gate", private: true, type: "module", packageManager: manifest.packageManager, scripts: { build: "tsc -b && vite build", "cv:facts:check": manifest.scripts["cv:facts:check"] } }, null, 2)}\n`,
    );
    const ungated = runBuildScript("build");

    assert.equal(ungated.status, 0, ungated.output);
    assert.deepEqual(ungated.chain, ["tsc ran", "vite ran"], "without the gate a stale index reaches the bundler");

    fs.writeFileSync(indexPath, validIndex);
    fs.writeFileSync(
      path.join(project, "package.json"),
      `${JSON.stringify({ name: "synthetic-build-gate", private: true, type: "module", packageManager: manifest.packageManager, scripts: { build: manifest.scripts.build, "build:site": manifest.scripts["build:site"], "cv:facts:check": manifest.scripts["cv:facts:check"] } }, null, 2)}\n`,
    );

    // The fault target was the synthetic index throughout.
    assert.deepEqual(fs.readFileSync(indexPath), Buffer.from(validIndex, "utf8"));
    assert.deepEqual(fs.readFileSync(REVIEWED_ARTIFACT_PATH), reviewedBefore, "the reviewed index must be untouched");
    assert.deepEqual(
      fs.readFileSync(path.join(repositoryRoot, "resources", "cv", "source", "cv.md")),
      sourceBytesBefore,
      "the canonical CV must be untouched",
    );
  } finally {
    // The symlink is removed explicitly so the recursive removal cannot walk into the
    // repository's own dependency tree.
    fs.rmSync(path.join(root, "node_modules"), { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Real production CLI/helpers, relocated into disposable project-owned synthetic repositories. */
function finalProject(t: { after: (fn: () => void) => void }) {
  const project = fs.mkdtempSync(path.join(repositoryRoot, "test", ".cv-facts-final-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.cpSync(path.join(repositoryRoot, "scripts", "cv-facts"), path.join(project, "scripts", "cv-facts"), { recursive: true });
  fs.copyFileSync(cliPath, path.join(project, "scripts", "cv-facts.mjs"));
  const sourcePath = path.join(project, "resources", "cv", "source", "cv.md");
  const factsPath = path.join(project, "resources", "cv", "facts.json");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "# Synthetic Person\n\n## Profile\n\nA documented synthetic statement.\n");
  const invoke = (args: string[]) => spawnSync(process.execPath, [path.join(project, "scripts", "cv-facts.mjs"), ...args], {
    cwd: project, encoding: "utf8", timeout: 10_000,
  });
  return { project, sourcePath, factsPath, invoke };
}

test("direct final preparation writes only a whole scaffold, protects authored facts and checks offline", (t) => {
  const { project, sourcePath, factsPath, invoke } = finalProject(t);
  const before = fs.readFileSync(sourcePath);
  assert.match(invoke(["check"]).stderr, /check\/artifact-missing/);
  assert.equal(fs.existsSync(factsPath), false, "a missing-index check cannot create one");
  const prepared = invoke(["prepare", "--final"]);
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  const artifact = JSON.parse(fs.readFileSync(factsPath, "utf8"));
  assert.deepEqual(artifact.cards.map((card: { id: string }) => card.id), ["identity-name", "profile-statement"]);
  assert.ok(artifact.cards.every((card: { answer: string; vector: number[] }) => card.answer === "" && card.vector.length === 0));
  assert.match(prepared.stdout, /incomplete/);
  assert.match(prepared.stdout, /profile-statement.*5-5/);
  assert.equal(prepared.stdout.includes("A documented synthetic statement"), false);
  assert.deepEqual(fs.readdirSync(path.join(project, "resources", "cv")).sort(), ["facts.json", "source"]);
  assert.equal(invoke(["check"]).status, 1, "an unauthored scaffold cannot pass the offline gate");
  artifact.cards[0].answer = "An authored synthetic answer.";
  fs.writeFileSync(factsPath, JSON.stringify(artifact));
  const authored = fs.readFileSync(factsPath);
  assert.equal(invoke(["prepare", "--final"]).status, 1);
  assert.deepEqual(fs.readFileSync(factsPath), authored);
  assert.equal(invoke(["prepare", "--final", "--force"]).status, 0);
  assert.deepEqual(fs.readFileSync(sourcePath), before);
  const scaffold = fs.readFileSync(factsPath);
  fs.writeFileSync(sourcePath, "# Synthetic Person\n\n## Unknown section\n\nUnsupported grouping.\n");
  const malformed = invoke(["prepare", "--final", "--force"]);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /extract\/unknown-section/);
  assert.deepEqual(fs.readFileSync(factsPath), scaffold, "failed extraction leaves prior facts intact");
});

test("direct final CLI rejects conflicting options, aliases and malformed embedding input without writes", (t) => {
  const { project, sourcePath, factsPath, invoke } = finalProject(t);
  fs.writeFileSync(factsPath, "{invalid-json");
  const before = fs.readFileSync(factsPath);
  for (const args of [
    ["prepare", "--final", "--out", project],
    ["embed", "--final", "--candidate", factsPath, "--confirm-reviewed"],
    ["check", "--final", "--candidate", factsPath],
    ["promote", "--final", "--confirm-reviewed"],
    ["check", "--out", project],
  ]) {
    const result = invoke(args);
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, /cv-facts\/cli\//);
    assert.deepEqual(fs.readFileSync(factsPath), before);
  }
  assert.match(invoke(["embed", "--final"]).stderr, /embed\/confirmation-missing/);
  assert.match(invoke(["embed", "--final", "--confirm-reviewed"]).stderr, /embed\/artifact-unreadable/);
  fs.unlinkSync(factsPath);
  const sourceBefore = fs.readFileSync(sourcePath);
  fs.symlinkSync(sourcePath, factsPath);
  assert.match(invoke(["prepare", "--final", "--force"]).stderr, /path\/canonical-alias/);
  assert.match(invoke(["check"]).stderr, /path\/canonical-alias/);
  assert.deepEqual(fs.readFileSync(sourcePath), sourceBefore);
  fs.unlinkSync(factsPath);
  fs.linkSync(sourcePath, factsPath);
  assert.match(invoke(["prepare", "--final", "--force"]).stderr, /path\/canonical-alias/);
  assert.deepEqual(fs.readFileSync(sourcePath), sourceBefore);
  fs.unlinkSync(factsPath);
  fs.symlinkSync(path.join(project, "absent.json"), factsPath);
  assert.match(invoke(["prepare", "--final", "--force"]).stderr, /path\/canonical-alias/);
  assert.equal(fs.existsSync(path.join(project, "absent.json")), false);
  fs.unlinkSync(factsPath);
  fs.mkdirSync(factsPath);
  assert.match(invoke(["prepare", "--final", "--force"]).stderr, /path\/not-a-file/);
  fs.rmdirSync(factsPath);
  const cvDir = path.dirname(factsPath);
  const relocated = path.join(project, "relocated");
  fs.renameSync(cvDir, relocated);
  fs.symlinkSync(relocated, cvDir, "dir");
  assert.match(invoke(["prepare", "--final", "--force"]).stderr, /path\/canonical-alias/);
});

function authorFinalScaffold(factsPath: string) {
  const artifact = JSON.parse(fs.readFileSync(factsPath, "utf8"));
  for (const card of artifact.cards) {
    card.topic = "Synthetic topic";
    card.tags = ["synthetic"];
    card.answer = "A documented synthetic statement.";
  }
  fs.writeFileSync(factsPath, JSON.stringify(artifact));
  return artifact;
}

/** Mock only the pinned runtime delivery/model, keeping CLI orchestration and pooling real. */
async function modelFreeRuntime(project: string, onModelCall = () => {}) {
  const real = await import(pathToFileURL(path.join(project, "scripts", "cv-facts", "embedding.mjs")).href);
  let calls = 0;
  const tokenizer = () => ({ input_ids: { data: [1, 2, 3] }, attention_mask: { data: [1, 1, 1] } });
  const model = Object.assign(async () => {
    calls++;
    onModelCall();
    return { last_hidden_state: { dims: [1, 3, 384], data: new Float32Array(3 * 384).fill(0.5) } };
  }, { config: { hidden_size: 384 } });
  const transformers = {
    env: { remoteHost: "fixture:", backends: { onnx: { wasm: {} } } },
    AutoTokenizer: { from_pretrained: async () => tokenizer },
    AutoModel: { from_pretrained: async () => model },
  };
  return {
    calls: () => calls,
    loadRuntime: async () => ({
      ...real,
      installedDistributionDirs: () => ({ packageDir: "unused", ortDir: "unused" }),
      loadPinnedWebDelivery: async () => ({ transformers, wasm: {}, restored: { identityPreserved: true, descriptorRestored: true } }),
      configurePinnedEnvironment: (options: { transformers: object; wasm: object; cacheDir?: string }) => real.configurePinnedEnvironment(options),
    }),
  };
}

test("default final embedding neither selects nor creates an external cache directory", async (t) => {
  const { project, factsPath, invoke } = finalProject(t);
  assert.equal(invoke(["prepare", "--final"]).status, 0);
  authorFinalScaffold(factsPath);
  const { run } = await import(pathToFileURL(path.join(project, "scripts", "cv-facts.mjs")).href);
  const { DEFAULT_CACHE_DIR } = await import(pathToFileURL(path.join(project, "scripts", "cv-facts", "paths.mjs")).href);
  const runtime = await modelFreeRuntime(project);
  const realRuntime = await runtime.loadRuntime();
  const mkdirSync = fs.mkdirSync;
  t.mock.method(fs, "mkdirSync", (...args: Parameters<typeof fs.mkdirSync>) => {
    assert.notEqual(path.resolve(String(args[0])), DEFAULT_CACHE_DIR, "final embedding must not create the legacy cache");
    return mkdirSync(...args);
  });
  let configured = false;
  assert.equal(await run(["embed", "--final", "--confirm-reviewed"], {
    loadRuntime: async () => ({
      ...realRuntime,
      configurePinnedEnvironment: (options: { transformers: object; wasm: object; cacheDir?: string }) => {
        assert.equal(options.cacheDir, undefined, "final embedding must not select an implicit external cache");
        configured = true;
        return realRuntime.configurePinnedEnvironment(options);
      },
    }),
  }), 0);
  assert.equal(configured, true, "the real environment configuration must run");
});

test("direct final embedding uses every authored card, checks read-only, and preserves bytes on model/input failure", async (t) => {
  const { project, sourcePath, factsPath, invoke } = finalProject(t);
  assert.equal(invoke(["prepare", "--final"]).status, 0);
  const authored = authorFinalScaffold(factsPath);
  const { run } = await import(pathToFileURL(path.join(project, "scripts", "cv-facts.mjs")).href);
  const runtime = await modelFreeRuntime(project);
  const options = ["embed", "--final", "--confirm-reviewed"];
  assert.equal(await run(options, runtime), 0);
  assert.equal(runtime.calls(), authored.cards.length, "one fresh embedding per card");
  const embedded = fs.readFileSync(factsPath);
  const finalArtifact = JSON.parse(embedded.toString());
  assert.ok(finalArtifact.cards.every((card: { vector: number[] }) => card.vector.length === 384));
  assert.equal(finalArtifact.embedding.contentSha256, contentSha256(finalArtifact.cards));
  assert.equal(invoke(["check"]).status, 0);
  assert.equal(invoke(["check", "--final"]).status, 0);
  assert.deepEqual(fs.readFileSync(factsPath), embedded, "offline checks do not rewrite the final bytes");
  assert.equal(await run(["check"], { loadRuntime: () => assert.fail("check must not load a model") }), 0);

  await assert.rejects(run(options, { loadRuntime: () => { throw new Error("Synthetic model failure"); } }));
  assert.deepEqual(fs.readFileSync(factsPath), embedded);
  const mutatedFacts = `${embedded.toString()}\n`;
  const interrupted = await modelFreeRuntime(project, () => fs.writeFileSync(factsPath, mutatedFacts));
  await assert.rejects(run(options, interrupted), (error: { reason?: string }) => error.reason === "embed/inputs-changed");
  assert.equal(fs.readFileSync(factsPath, "utf8"), mutatedFacts, "an intervening author edit survives");
  fs.writeFileSync(factsPath, embedded);
  const sourceBefore = fs.readFileSync(sourcePath);
  const sourceChanged = await modelFreeRuntime(project, () => fs.writeFileSync(sourcePath, `${sourceBefore.toString()}\n`));
  await assert.rejects(run(options, sourceChanged), (error: { reason?: string }) => error.reason === "embed/inputs-changed");
  assert.deepEqual(fs.readFileSync(factsPath), embedded, "source drift cannot update embedding identity");
  fs.writeFileSync(sourcePath, sourceBefore);
  const targetAliased = await modelFreeRuntime(project, () => {
    if (!fs.lstatSync(factsPath).isSymbolicLink()) {
      fs.unlinkSync(factsPath);
      fs.symlinkSync(sourcePath, factsPath);
    }
  });
  await assert.rejects(run(options, targetAliased), (error: { reason?: string }) => error.reason === "path/canonical-alias");
  assert.deepEqual(fs.readFileSync(sourcePath), sourceBefore, "a target swapped to the source cannot be written");
  assert.equal(fs.lstatSync(factsPath).isSymbolicLink(), true);
  assert.deepEqual(fs.readdirSync(path.dirname(factsPath)).sort(), ["facts.json", "source"]);
});

test("direct embed validates authored shape, source, pins and output before writing or loading the runtime", async (t) => {
  const { project, factsPath, invoke } = finalProject(t);
  assert.equal(invoke(["prepare", "--final"]).status, 0);
  const { run } = await import(pathToFileURL(path.join(project, "scripts", "cv-facts.mjs")).href);
  const options = ["embed", "--final", "--confirm-reviewed"];
  const noRuntime = { loadRuntime: () => assert.fail("invalid input must not load the runtime") };
  const scaffold = fs.readFileSync(factsPath);
  assert.equal(await run(options, noRuntime), 1, "empty authored fields fail before model import");
  assert.deepEqual(fs.readFileSync(factsPath), scaffold);
  const authored = authorFinalScaffold(factsPath);
  for (const mutate of [
    (artifact: any) => { artifact.source.sha256 = "0".repeat(64); },
    (artifact: any) => { artifact.cards[0].tags = "malformed"; },
    (artifact: any) => { artifact.cards[0].sourceRefs[0].endLine = 500; },
    (artifact: any) => { artifact.cards[1].id = artifact.cards[0].id; },
    (artifact: any) => { artifact.embedding.revision = "0".repeat(40); },
  ]) {
    const artifact = structuredClone(authored);
    mutate(artifact);
    fs.writeFileSync(factsPath, JSON.stringify(artifact));
    const before = fs.readFileSync(factsPath);
    assert.equal(await run(options, noRuntime), 1);
    assert.deepEqual(fs.readFileSync(factsPath), before);
  }
  fs.writeFileSync(factsPath, JSON.stringify({ ...authored, cards: [] }));
  await assert.rejects(run(options, noRuntime), (error: { reason?: string }) => error.reason === "embed/empty-index");
  fs.writeFileSync(factsPath, JSON.stringify(authored));
  const before = fs.readFileSync(factsPath);
  const runtime = await modelFreeRuntime(project);
  const realRuntime = await runtime.loadRuntime();
  assert.equal(await run(options, { loadRuntime: async () => ({ ...realRuntime, embedCandidate: async () => authored }) }), 1,
    "invalid embedded output cannot replace authored facts");
  assert.deepEqual(fs.readFileSync(factsPath), before);
  const invalidCache = writeCandidate("not-a-cache-directory.json", {});
  for (const [cache, reason] of [
    [project, "path/inside-repository"],
    [invalidCache, "path/not-a-directory"],
    [" ", "path/missing"],
  ]) {
    await assert.rejects(run([...options, "--cache", cache], noRuntime), (error: { reason?: string }) => error.reason === reason);
    assert.deepEqual(fs.readFileSync(factsPath), before);
  }
});

test("legacy external guard also refuses hard-linked canonical input aliases", async (t) => {
  const { project, sourcePath } = finalProject(t);
  const outside = finalProject(t);
  const { resolveExternalPath } = await import(pathToFileURL(path.join(project, "scripts", "cv-facts", "paths.mjs")).href);
  fs.linkSync(sourcePath, outside.factsPath);
  assert.throws(() => resolveExternalPath(outside.factsPath, { option: "--candidate", expect: "file" }),
    (error: { reason?: string }) => error.reason === "path/file-alias");
});
