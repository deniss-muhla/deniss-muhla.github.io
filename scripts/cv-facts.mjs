/**
 * Deliberate whole-index preparation/embedding, offline checks and legacy external support.
 * Only embed dynamically imports the model adapter. Nothing runs from startup or build.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CvFactsError, describeFailure } from "./cv-facts/errors.mjs";
import {
  CHECK_SCOPE_NOTE,
  describeFinding,
  validateArtifact,
} from "./cv-facts/artifact.mjs";
import {
  DEFAULT_CACHE_DIR,
  REVIEWED_ARTIFACT_PATH,
  readCanonicalSource,
  resolveExternalPath,
  resolveFinalArtifactPath,
  serializeJson,
  writeFileAtomic,
} from "./cv-facts/paths.mjs";
import { ANALYSIS_FILE, CANDIDATE_FILE, prepareFinalArtifact, prepareWorkspace } from "./cv-facts/prepare.mjs";
import { PROMOTION_ACKNOWLEDGMENT, promoteArtifact, readArtifactFile } from "./cv-facts/promote.mjs";

const COMMANDS = ["prepare", "embed", "check", "promote"];

const HELP = `cv:facts: develop the reviewed answer index from the canonical CV.

Usage:
  node ./scripts/cv-facts.mjs <command> [options]

Commands:
  prepare   --final writes a whole scaffold directly to resources/cv/facts.json and prints
            metadata-only source mappings/omissions. It does not author answers or vectors.
            Requires --force to replace any existing final file. Runs no model or network.
            Legacy --out <dir> writes ${ANALYSIS_FILE} and ${CANDIDATE_FILE} externally.
  embed     --final --confirm-reviewed embeds the authored final index in place, after independent
            whole-index source review. No promotion is needed. A failure leaves prior bytes intact.
            Legacy --candidate <path> embeds an external candidate instead.
            The only command that reaches the network. No cache directory is selected by default
            with --final; legacy embedding retains its external default. Optional --cache must be external.
  check     Validate source digest, closed shape, source ranges, embedding pins, content digest
            and finite nonzero vectors offline. Writes nothing and runs no inference. Defaults to the
            final reviewed index; legacy --candidate <path> checks an external candidate instead.
  promote   Legacy only: validate an external candidate, then replace the reviewed index atomically.
            Requires --candidate <path> and --confirm-reviewed. Not needed for the final workflow.

Options:
  --final                  prepare, embed, check: use only the fixed canonical facts path
  --force                  prepare: explicitly replace existing authored work with a scaffold
  --confirm-reviewed       embed --final, promote: acknowledge recorded independent source review
  --out <dir>              prepare: legacy external workspace (incompatible with --final)
  --candidate <path>       embed, check, promote: legacy external file (incompatible with --final)
  --cache <dir>            embed: external model cache directory
  -h, --help               show this help

Preparation leaves an incomplete facts index. Author and independently review every card,
embed explicitly, then pass the facts check before serving. A check does not record
source review. If the existing reviewed identity already matches, do not regenerate it needlessly.

The reviewed index is ${path.relative(process.cwd(), REVIEWED_ARTIFACT_PATH) || REVIEWED_ARTIFACT_PATH}.
${CHECK_SCOPE_NOTE}`;

/** Options are `name -> takes a value`; anything else is a rejection rather than a guess. */
const VALUE_OPTIONS = new Set(["out", "candidate", "cache"]);
const FLAG_OPTIONS = new Set(["force", "confirm-reviewed", "final"]);

function parseArguments(argv) {
  const options = {};
  let index = 0;

  while (index < argv.length) {
    const token = argv[index];

    if (token === "-h" || token === "--help") return { help: true, options };
    if (!token.startsWith("--")) throw new CvFactsError("cli/unknown-argument");

    const name = token.slice(2);

    if (FLAG_OPTIONS.has(name)) {
      options[name] = true;
      index += 1;
      continue;
    }

    if (!VALUE_OPTIONS.has(name)) throw new CvFactsError("cli/unknown-option", { option: name });

    const value = argv[index + 1];

    if (value === undefined || value.startsWith("--")) {
      throw new CvFactsError("cli/missing-option-value", { option: name });
    }

    options[name] = value;
    index += 2;
  }

  return { help: false, options };
}

function requireOption(options, name) {
  const value = options[name];

  if (value === undefined) throw new CvFactsError("cli/required-option-missing", { option: name });

  return value;
}

function log(message) {
  console.log(`[cv] ${message}`);
}

function reportFindings(stage, findings) {
  for (const record of findings) log(`${stage}: ${describeFinding(record)}`);
}

function printHelp() {
  console.log(HELP);
}

function runPrepare(options) {
  const source = readCanonicalSource();
  if (options.final === true) {
    const result = prepareFinalArtifact({ source, force: options.force === true });
    log(`prepared final scaffold: ${result.mappings.length} source units; facts index incomplete`);
    for (const { cardId, lines } of result.mappings) log(`mapped ${cardId} at ${lines.start}-${lines.end}`);
    for (const omission of result.omissions) {
      const location = omission.lines ? `at ${omission.lines.start}-${omission.lines.end}` : `count=${omission.count}`;
      log(`omitted ${omission.kind}: ${omission.reason} ${location}`);
    }
    log(`coverage: ${JSON.stringify(result.coverage)}`);
    log(`final scaffold: ${result.artifactPath}`);
    log("author every topic, tag and answer here, record whole-index source review, then embed --final --confirm-reviewed");
    return 0;
  }

  const outDir = resolveExternalPath(requireOption(options, "out"), {
    option: "--out",
    expect: "directory-target",
  });
  const result = prepareWorkspace({ source, outDir, force: options.force === true });

  log(`prepared ${result.units} source units and ${result.omissions} recorded omissions`);
  log(`analysis: ${result.analysisPath}`);
  log(`candidate: ${result.candidatePath}`);
  log("author topic, tags and answer in the candidate, source-review every answer, then run embed");

  return 0;
}

function validationContext(source) {
  return {
    sourceRelativePath: source.relativePath,
    sourceSha256: source.sha256,
    sourceLineCount: source.lineCount,
  };
}

async function loadEmbeddingRuntime() {
  return await import("./cv-facts/embedding.mjs");
}

async function runEmbed(options, loadRuntime) {
  if (options.final === true && options["confirm-reviewed"] !== true) {
    throw new CvFactsError("embed/confirmation-missing", { option: "--confirm-reviewed" });
  }
  const resolveTarget = () => options.final === true
    ? resolveFinalArtifactPath()
    : resolveExternalPath(requireOption(options, "candidate"), { option: "--candidate", expect: "file" });
  const candidatePath = resolveTarget();
  const cacheDir = options.final === true && options.cache === undefined
    ? undefined
    : resolveExternalPath(options.cache ?? DEFAULT_CACHE_DIR, {
      option: "--cache",
      expect: "directory-target",
    });
  const source = readCanonicalSource();
  const originalBytes = fs.readFileSync(candidatePath);
  const artifact = readArtifactFile(candidatePath, { stage: "embed" });
  const context = validationContext(source);
  const { findings } = validateArtifact(artifact, { ...context, embeddingPending: true });
  reportFindings("embed", findings);
  if (findings.length > 0) {
    log("embed failed; facts index incomplete; prior facts bytes untouched");
    return 1;
  }
  if (artifact.cards.length === 0) throw new CvFactsError("embed/empty-index");

  // Imported here, and only here, so `check` and `promote` cannot reach the model.
  const { configurePinnedEnvironment, embedCandidate, installedDistributionDirs, loadPinnedWebDelivery } =
    await loadRuntime();
  const { packageDir, ortDir } = installedDistributionDirs();
  const { transformers, wasm, restored } = await loadPinnedWebDelivery({ packageDir, ortDir });

  if (!restored.identityPreserved || !restored.descriptorRestored) {
    throw new CvFactsError("embed/process-binding-not-restored");
  }

  const environment = configurePinnedEnvironment({ transformers, wasm, cacheDir });
  const embedded = await embedCandidate(artifact, { transformers });

  const finalValidation = validateArtifact(embedded, context);
  reportFindings("embed", finalValidation.findings);
  if (finalValidation.findings.length > 0) {
    log("embed failed; facts index incomplete; prior facts bytes untouched");
    return 1;
  }

  // A long embed must not silently overwrite an intervening author edit or source change.
  if (resolveTarget() !== candidatePath || readCanonicalSource().sha256 !== source.sha256 ||
      !fs.readFileSync(candidatePath).equals(originalBytes)) {
    throw new CvFactsError("embed/inputs-changed");
  }
  writeFileAtomic(candidatePath, serializeJson(embedded));

  log(`embedded ${embedded.cards.length} cards at ${environment.remoteHost}${environment.remotePathTemplate}`);
  log(`${options.final === true ? "final index" : "candidate"}: ${candidatePath}`);
  if (options.final === true) {
    log("--confirm-reviewed is an acknowledgment, not source-review evidence or owner acceptance");
    log("facts index incomplete until the facts check passes; do not serve an incomplete index");
  }

  return 0;
}

function runCheck(options) {
  const source = readCanonicalSource();
  const usingCandidate = options.candidate !== undefined;
  const artifactPath = usingCandidate
    ? resolveExternalPath(options.candidate, { option: "--candidate", expect: "file" })
    : resolveFinalArtifactPath({ allowMissing: true });

  const artifact = readArtifactFile(artifactPath, { stage: "check" });
  const { findings, cardCount } = validateArtifact(artifact, {
    sourceRelativePath: source.relativePath,
    sourceSha256: source.sha256,
    sourceLineCount: source.lineCount,
  });

  reportFindings("check", findings);

  if (findings.length > 0) {
    log(`check failed with ${findings.length} findings`);
    return 1;
  }

  log(`check passed for ${cardCount} cards from ${usingCandidate ? "candidate" : "the reviewed index"}`);
  log(CHECK_SCOPE_NOTE);

  return 0;
}

function runPromote(options) {
  if (options["confirm-reviewed"] !== true) {
    throw new CvFactsError("promote/confirmation-missing", { option: "--confirm-reviewed" });
  }

  resolveFinalArtifactPath({ allowMissing: true });
  const source = readCanonicalSource();
  const candidatePath = resolveExternalPath(requireOption(options, "candidate"), {
    option: "--candidate",
    expect: "file",
  });
  const artifact = readArtifactFile(candidatePath, { stage: "promote" });
  const { findings, replaced, bytes } = promoteArtifact({
    artifact,
    reviewedPath: REVIEWED_ARTIFACT_PATH,
    context: {
      sourceRelativePath: source.relativePath,
      sourceSha256: source.sha256,
      sourceLineCount: source.lineCount,
    },
  });

  reportFindings("promote", findings);

  if (!replaced) {
    log("promote failed; the reviewed index is untouched");
    return 1;
  }

  log(`promoted ${bytes} bytes to ${REVIEWED_ARTIFACT_PATH}`);
  log(PROMOTION_ACKNOWLEDGMENT);
  log("nothing was staged or committed");

  return 0;
}

export async function run(argv, { loadRuntime = loadEmbeddingRuntime } = {}) {
  const [command, ...rest] = argv;

  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    printHelp();
    return 0;
  }

  if (!COMMANDS.includes(command)) throw new CvFactsError("cli/unknown-command");

  const { help, options } = parseArguments(rest);

  if (help) {
    printHelp();
    return 0;
  }

  const allowed = {
    prepare: ["final", "out", "force"],
    embed: ["final", "candidate", "cache", "confirm-reviewed"],
    check: ["final", "candidate"],
    promote: ["candidate", "confirm-reviewed"],
  };
  for (const option of Object.keys(options)) {
    if (!allowed[command].includes(option)) throw new CvFactsError("cli/option-not-supported", { option });
  }
  if (options.final === true && (options.out !== undefined || options.candidate !== undefined)) {
    throw new CvFactsError("cli/conflicting-options");
  }

  if (command === "prepare") return runPrepare(options);
  if (command === "check") return runCheck(options);
  if (command === "promote") return runPromote(options);
  if (command === "embed") return runEmbed(options, loadRuntime);

  throw new CvFactsError("cli/unknown-command");
}

async function main() {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    // One classified rule id and, when the range is a pair of line numbers, its coordinates.
    // The raw exception is never printed, not even under a debug variable, so a vendor
    // message or authored candidate text cannot reach the output on any path.
    for (const line of describeFailure(error)) console.error(line);

    if (process.argv[2] === "prepare" || process.argv[2] === "embed") {
      console.error("[cv] generation did not complete; do not serve an incomplete facts index");
    }
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) await main();