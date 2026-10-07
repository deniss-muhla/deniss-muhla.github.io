/**
 * `cv:facts` — the four development commands behind the reviewed answer index.
 *
 * The commands share one artifact contract (`scripts/cv-facts/artifact.mjs`) and one
 * external-workspace guard (`scripts/cv-facts/paths.mjs`). Candidates, analysis files and
 * model caches never enter this repository; `promote` is the only command that writes into
 * it, and only `resources/cv/facts.json`.
 *
 *   prepare  deterministic extraction and a candidate scaffold in an external workspace
 *   embed    the only network step; vectors for a named external candidate
 *   check    offline validation of the reviewed index or of a candidate; no writes, no inference
 *   promote  validate, then replace the reviewed index atomically
 *
 * The embedding runtime is imported dynamically and only by `embed`, so `check` cannot reach
 * the model even by accident. Every rejection is printed as this project's own rule id.
 */
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
  serializeJson,
  writeFileAtomic,
} from "./cv-facts/paths.mjs";
import { ANALYSIS_FILE, CANDIDATE_FILE, prepareWorkspace } from "./cv-facts/prepare.mjs";
import { PROMOTION_ACKNOWLEDGMENT, promoteArtifact, readArtifactFile } from "./cv-facts/promote.mjs";

const COMMANDS = ["prepare", "embed", "check", "promote"];

const HELP = `cv:facts: develop the reviewed answer index from the canonical CV.

Usage:
  node ./scripts/cv-facts.mjs <command> [options]

Commands:
  prepare   Extract source units and write ${ANALYSIS_FILE} and a ${CANDIDATE_FILE} scaffold.
            Requires --out <dir> outside this repository. Runs no model and no hosted provider.
            Refuses to overwrite an authored candidate unless --force is given.
  embed     Compute vectors for a named external candidate and record the embedding identity
            block and the ordered content digest. The only command that reaches the network.
            Requires --candidate <path> outside this repository. Optional --cache <dir>,
            which must also be outside this repository.
  check     Validate an artifact offline: raw source digest, version, closed shape with no undeclared
            key, unique ids, nonempty fields, source ranges, embedding identity, input digest,
            dimensions and finite nonzero vectors. Writes nothing and runs no inference. Defaults to the
            reviewed index; --candidate <path> validates an external candidate instead.
  promote   Validate a candidate, then replace the reviewed index atomically.
            Requires --candidate <path> and --confirm-reviewed. A failure leaves the reviewed
            index untouched. The acknowledgment is not review evidence and not owner acceptance.

Options:
  --out <dir>              prepare: external workspace directory, created if missing
  --candidate <path>       embed, check, promote: external candidate file
  --cache <dir>            embed: external model cache directory
  --force                  prepare: overwrite an authored candidate
  --confirm-reviewed       promote: acknowledge the recorded independent source review
  -h, --help               show this help

The reviewed index is ${path.relative(process.cwd(), REVIEWED_ARTIFACT_PATH) || REVIEWED_ARTIFACT_PATH}.
${CHECK_SCOPE_NOTE}`;

/** Options are `name -> takes a value`; anything else is a rejection rather than a guess. */
const VALUE_OPTIONS = new Set(["out", "candidate", "cache"]);
const FLAG_OPTIONS = new Set(["force", "confirm-reviewed"]);

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
  const outDir = resolveExternalPath(requireOption(options, "out"), {
    option: "--out",
    expect: "directory-target",
  });
  const source = readCanonicalSource();
  const result = prepareWorkspace({ source, outDir, force: options.force === true });

  log(`prepared ${result.units} source units and ${result.omissions} recorded omissions`);
  log(`analysis: ${result.analysisPath}`);
  log(`candidate: ${result.candidatePath}`);
  log("author topic, tags and answer in the candidate, source-review every answer, then run embed");

  return 0;
}

async function runEmbed(options) {
  const candidatePath = resolveExternalPath(requireOption(options, "candidate"), {
    option: "--candidate",
    expect: "file",
  });
  const cacheDir = resolveExternalPath(options.cache ?? DEFAULT_CACHE_DIR, {
    option: "--cache",
    expect: "directory-target",
  });
  const artifact = readArtifactFile(candidatePath, { stage: "embed" });

  // Imported here, and only here, so `check` and `promote` cannot reach the model.
  const { configurePinnedEnvironment, embedCandidate, installedDistributionDirs, loadPinnedWebDelivery } =
    await import("./cv-facts/embedding.mjs");
  const { packageDir, ortDir } = installedDistributionDirs();
  const { transformers, wasm, restored } = await loadPinnedWebDelivery({ packageDir, ortDir });

  if (!restored.identityPreserved || !restored.descriptorRestored) {
    throw new CvFactsError("embed/process-binding-not-restored");
  }

  const environment = configurePinnedEnvironment({ transformers, wasm, cacheDir });
  const embedded = await embedCandidate(artifact, { transformers });

  writeFileAtomic(candidatePath, serializeJson(embedded));

  log(`embedded ${embedded.cards.length} cards at ${environment.remoteHost}${environment.remotePathTemplate}`);
  log(`candidate: ${candidatePath}`);

  return 0;
}

function runCheck(options) {
  const source = readCanonicalSource();
  const usingCandidate = options.candidate !== undefined;
  const artifactPath = usingCandidate
    ? resolveExternalPath(options.candidate, { option: "--candidate", expect: "file" })
    : REVIEWED_ARTIFACT_PATH;

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

async function run(argv) {
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

  if (command === "prepare") return runPrepare(options);
  if (command === "check") return runCheck(options);
  if (command === "promote") return runPromote(options);
  if (command === "embed") return runEmbed(options);

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

    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) await main();