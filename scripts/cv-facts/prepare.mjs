/**
 * `cv:facts prepare`: deterministic extraction and a candidate scaffold in an external
 * workspace.
 *
 * The command reaches no hosted provider and no model. It extracts source units, records the
 * lines it deliberately omitted, and writes a scaffold whose topic, tags, answer and vector
 * fields are empty on purpose: the skill directs agent-assisted authorship in that file, and
 * the offline check rejects an empty field. An authored candidate is never overwritten
 * without an explicit `--force`.
 */
import fs from "node:fs";
import path from "node:path";

import { CvFactsError } from "./errors.mjs";
import { extractSourceUnits } from "./extract.mjs";
import { ARTIFACT_VERSION, emptyEmbeddingIdentity } from "./artifact.mjs";
import { serializeJson, writeFileAtomic } from "./paths.mjs";

export const ANALYSIS_FILE = "analysis.json";
export const CANDIDATE_FILE = "facts.candidate.json";

/** Raw source-unit extraction with context, plus a metadata-only coverage report. */
function buildAnalysis({ source, units, omissions, coverage }) {
  return {
    version: ARTIFACT_VERSION,
    source: { path: source.relativePath, sha256: source.sha256, lines: source.lineCount },
    units,
    omissions,
    coverage,
  };
}

/**
 * An artifact skeleton whose ids and source references already match the extracted units, so
 * a source review maps a card to the lines it came from without guessing coordinates.
 */
export function scaffoldArtifact({ source, units }) {
  return {
    version: ARTIFACT_VERSION,
    source: { path: source.relativePath, sha256: source.sha256 },
    embedding: emptyEmbeddingIdentity(),
    cards: units.map((unit) => ({
      id: unit.cardId,
      topic: "",
      tags: [],
      sourceRefs: [{ startLine: unit.lines.start, endLine: unit.lines.end }],
      answer: "",
      vector: [],
    })),
  };
}

function isAuthored(candidate) {
  return (
    Array.isArray(candidate?.cards) &&
    candidate.cards.some(
      (card) =>
        (typeof card?.topic === "string" && card.topic.trim() !== "") ||
        (typeof card?.answer === "string" && card.answer.trim() !== "") ||
        (Array.isArray(card?.tags) && card.tags.length > 0),
    )
  );
}

/**
 * @param {{ source: object, outDir: string, force?: boolean }} options
 *   `outDir` must already have passed the external-workspace guard.
 * @returns {{ analysisPath: string, candidatePath: string, units: number, omissions: number }}
 */
export function prepareWorkspace({ source, outDir, force = false }) {
  const candidatePath = path.join(outDir, CANDIDATE_FILE);

  if (fs.existsSync(candidatePath) && !force) {
    let existing = null;

    try {
      existing = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
    } catch {
      throw new CvFactsError("prepare/candidate-unreadable");
    }

    if (isAuthored(existing)) {
      throw new CvFactsError("prepare/authored-candidate-present");
    }
  }

  const { units, omissions, coverage } = extractSourceUnits(source.bytes.toString("utf8"));
  const analysis = buildAnalysis({ source, units, omissions, coverage });
  const artifact = scaffoldArtifact({ source, units });

  fs.mkdirSync(outDir, { recursive: true });

  const analysisPath = path.join(outDir, ANALYSIS_FILE);

  writeFileAtomic(analysisPath, serializeJson(analysis));
  writeFileAtomic(candidatePath, serializeJson(artifact));

  return { analysisPath, candidatePath, units: units.length, omissions: omissions.length };
}