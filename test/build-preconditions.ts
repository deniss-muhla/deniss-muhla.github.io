import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Documented build preconditions for the checks that read the real build output.
 *
 * Two worktree states have to stay green, and neither is the built branch's own state: the
 * plain production build intentionally omits `dist/qa/retrieval.html`, and a fresh checkout
 * (the deploy workflow runs lint and tests before its build) has no `dist/` at all. A check
 * whose precondition does not hold therefore skips visibly, under the reason the report
 * shows, instead of failing on an artifact nobody was asked to build. The marker every
 * caller registers at the end of its file asserts that exactly the checks with an unmet
 * precondition recorded a skip, so a precondition can never turn a check into a silent pass.
 * Where the precondition holds, the check runs its full assertions unchanged.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** What a check needs from the build, and why it is skipped when that is not there. */
export type BuildPrecondition = {
  readonly built: boolean;
  readonly reason: string;
};

/**
 * The QA-gated page beside the canonical page, which is what the built branch's script-graph
 * preflight refuses without. Both files, because the preflight names either as missing.
 */
export function qaArtifacts(distDir = join(REPO_ROOT, "dist")): BuildPrecondition {
  return {
    built: existsSync(join(distDir, "index.html")) && existsSync(join(distDir, "qa", "retrieval.html")),
    reason: "qa-artifacts-not-built: dist/qa/retrieval.html is absent; the built branch needs `RETRIEVAL_QA=1 pnpm build`",
  };
}

/** The emitted build output itself, which is what the shipped-manifest check reads. */
export function buildOutput(outputDir: string): BuildPrecondition {
  return {
    built: existsSync(outputDir),
    reason: `build-output-absent: ${outputDir} holds no build output; the manifest check needs \`pnpm build\``,
  };
}

/** The checks registered with a precondition, in registration order, and the skips recorded as they ran. */
const registered: Array<{ name: string; built: boolean }> = [];
const recorded: string[] = [];

/** A check that runs where its precondition holds and skips visibly, by name, where it does not. */
export function guardedTest(
  precondition: BuildPrecondition,
  name: string,
  run: (t: TestContext) => void | Promise<void>,
): void {
  registered.push({ name, built: precondition.built });

  test(name, async (t) => {
    if (precondition.built) {
      await run(t);
      return;
    }

    recorded.push(name);
    t.skip(precondition.reason);
  });
}

/**
 * The anti-vacuous marker: register it once per file, after every guarded check in it.
 *
 * Both directions are asserted, so it is a check in both worktree states: an unmet
 * precondition must have been recorded by every guarded check, and a met precondition must
 * have been recorded by none.
 */
export function skipLedgerMarker(): void {
  test("every guarded check recorded its precondition skip, or none did", () => {
    assert.deepEqual(
      recorded,
      registered.filter((entry) => !entry.built).map((entry) => entry.name),
      "the recorded precondition skips must be exactly the checks whose precondition did not hold",
    );
  });
}
