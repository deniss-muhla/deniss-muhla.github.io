/**
 * `cv:facts promote`: validate first, then replace the reviewed file atomically.
 *
 * The candidate is validated with exactly the rules `check` uses, and the reviewed file is
 * replaced through one rename. Any rejection leaves the existing artifact untouched, so a
 * failed promotion cannot reduce the reviewed knowledge the assistant serves.
 *
 * `--confirm-reviewed` is an acknowledgment of a recorded independent source review. It is
 * never evidence that such a review happened, and it is never owner acceptance.
 */
import fs from "node:fs";

import { CvFactsError } from "./errors.mjs";
import { validateArtifact } from "./artifact.mjs";
import { serializeJson, writeFileAtomic } from "./paths.mjs";

export const PROMOTION_ACKNOWLEDGMENT =
  "acknowledged: --confirm-reviewed records an independent source review; it is not that review's evidence and not owner acceptance";

/**
 * @param {{ artifact: unknown, reviewedPath: string, context: object }} options
 * @returns {{ findings: object[], replaced: boolean, bytes: number }}
 */
export function promoteArtifact({ artifact, reviewedPath, context }) {
  const { findings } = validateArtifact(artifact, context);

  if (findings.length > 0) return { findings, replaced: false, bytes: 0 };

  const contents = serializeJson(artifact);

  writeFileAtomic(reviewedPath, contents);

  return { findings, replaced: true, bytes: Buffer.byteLength(contents, "utf8") };
}

/**
 * Reads a candidate or reviewed artifact. A missing or unparsable file is classified and the
 * raw text is never reported, because a candidate is authored material.
 *
 * @param {string} file
 * @param {{ stage: string }} options `stage` names the command, for example `check`
 */
export function readArtifactFile(file, { stage }) {
  if (!fs.existsSync(file)) throw new CvFactsError(`${stage}/artifact-missing`);

  let parsed;

  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new CvFactsError(`${stage}/artifact-unreadable`);
  }

  return parsed;
}