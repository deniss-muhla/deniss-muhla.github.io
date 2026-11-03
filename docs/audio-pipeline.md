# Assistant audio pipeline

## Owner-approved CV update target

Use the canonical source at `resources/cv/source/cv.md`. Regenerate the whole answer index
at `resources/cv/facts.json`, then generate the complete matching v2 audio corpus directly in
`public/audio/assistant/`. Use the exact final facts bytes, the pinned Kitten SDK/model/decoder
and the approved speech settings. Generate every catalog item afresh and validate the complete
manifest, clip bytes, text digests, identities and directory coverage.

Do not create a separate candidate, stage or backup output. Do not add a promotion or move-after-
generation step. Keep the whole-index independent source review, exact pins and complete-pair
checks. If generation is interrupted or validation fails, leave a truthful incomplete state and
stop serving the mismatched pair. Do not claim a partial corpus is complete. Complete the
[listening acceptance step](../.github/skills/cv-update/references/workflow.md#owner-approved-sequence)
in the CV-update workflow separately from technical checks.

The read-only installed checks are available now:

```bash
pnpm cv:facts:check
pnpm cv:audio:check
```

The facts check validates source identity, shape and embedding identity; it does not prove that
answers are true or useful. The audio check validates the installed v2 manifest, exact facts,
greeting and catalog identities, per-item text digests, MP3 bytes and complete directory
coverage. It runs no model and writes nothing. Neither check proves pronunciation, licensing or
publication acceptance.

<a id="current-implementation-gap"></a>

## Current command interface

Facts preparation and embedding support `--final` without separate promotion; follow the
[facts command interface](../.github/skills/cv-facts/SKILL.md#current-command-interface).
Audio supports an explicit `--final` mode with fixed canonical facts and output paths. The adapter
has model-free regression coverage. The current corpus was generated successfully on macOS
CPU/bf16 through an approved temporary bridge outside the maintained code. The maintained CLI
remains Linux/CUDA only, refuses non-Linux hosts before changing any prior output, and makes no
portable or permanent macOS support claim. Human listening and accessibility review is still open.

After independent whole-index source review, a passing facts check, verified runtime prerequisites
and separately authorized real sample evidence, the direct command is:

```bash
FACTS_SHA256="$(shasum -a 256 resources/cv/facts.json | cut -d ' ' -f 1)"
pnpm cv:audio:generate --final --confirm-reviewed \
  --facts-sha256 "$FACTS_SHA256" \
  --runtime-inputs /absolute/external/runtime-inputs.json \
  --deadline-minutes 168
```

`--confirm-reviewed` acknowledges an existing recorded independent whole-index source review; it
does not create that evidence or grant synthesis, licensing or publication authority. `--facts`
and `--stage` overrides are forbidden with `--final`. The only source is `resources/cv/facts.json`
and the only output is `public/audio/assistant/`. The command runs the existing offline facts
validator before synthesis, under the generation lock before invalidating prior output, and again
through finalization before completion and lock release. It also verifies exact facts bytes before
each item and at finalization.

Runtime inputs must be available locally outside the repository. The version-1 JSON record has
`version`, `pythonExecutable`, `sandboxExecutable`, `sdkRoot`, `sdkArchive`, `modelSnapshot`,
`hubCache` and `modulePathsFile`. All paths must be absolute. The module-path file contains exactly
88 distinct existing external module roots in `modulePaths`, with optional 88-entry `packageSources`
metadata. The existing pinned Linux CUDA runtime, bubblewrap isolation and import-origin checks
remain unchanged. The command checks available paths, artifact pins, platform and an executable
`ffmpeg` before invalidating prior completion. Dependency imports, device availability and actual
OS isolation still require the bounded real runtime/sample evidence; filesystem preflight alone
does not prove those properties. Nothing is installed or downloaded by this interface.

An existing complete generated corpus may be replaced even when it belongs to older facts. Its
manifest, bytes and complete directory inventory must validate first, and all entries must be
regular, unaliased files. Unknown entries, hardlinks, symlinks, aliased ancestors and incomplete
prior output block generation without deletion. Preflight failure leaves valid prior files intact.
No waveform is reused, including when replacing an already matching corpus.

After read-only preflight, the command exclusively creates the fixed transient sibling file
`public/audio/assistant.generation.lock`. This is a lock file, not an output workspace. It rechecks
output identity and inventory under that lock before mutating prior files. The lock remains held
through manifest creation and final verification, and its verified owned inode is removed only at
the last successful finalization step. The installed audio check and dev guard treat lock-present
as incomplete, even if a manifest exists. Contending runs, foreign locks and replaced locks fail
closed. Cancellation/failure releases only the owned lock after awaited process settlement; a
stale or foreign lock is never deleted automatically. Confirm owned-child settlement before any
scoped manual recovery.

The command removes the old completion manifest first, then unlinks only
individually verified prior generated clips. Every new MP3 is written directly at the final path.
During work, or after a failure, the missing manifest is the fail-closed incomplete marker. There
is no pending-manifest sibling or external output workspace in direct mode. Temporary per-item
WAV/encoding files are removed by identity after each successful item. Metadata-only activity and
runtime provenance remain in the owned system temporary workspace reported by the command; a
failure may retain the current item's temporary files, never a second completed output corpus. A successful directory contains
only the final v2 manifest and its referenced MP3s. A failed partial corpus requires deliberate
scoped recovery before retrying; it is not silently merged or broadly removed.

The legacy external `--kitten-stage` remains compatible for existing callers. It still requires
external facts/runtime inputs, a nonexistent external `--stage`, a facts digest and a deadline.
It is not the recommended CV-update workflow and does not permit arbitrary repository writes.

## Serving and failure coverage

Both build scripts already run the installed facts and audio checks before Vite. Ordinary Vite dev
startup now validates the complete pair and refuses a mismatch. Its pre-static middleware also
checks facts validity and current completion on requests, including on an already-running server.
An active generation lock, missing manifest, changed facts identity or invalid MP3 corpus returns
HTTP 503 rather than serving an incomplete pair. Every request validates the live MP3 corpus and
directory coverage, even when facts and manifest bytes are unchanged. The isolated offline QA
config omits this source-pair plugin.

Built preview serves its built artifact, not the current source/public root, so it is not gated by
unrelated source edits. This dev guard does not intercept static hosts, an existing built artifact,
or previously cached browser content. Do not copy or serve an incomplete source pair on another
route; run both installed checks before building or serving it. Browser identity checks and stored
Replay remain unchanged.

Synthesis requires OS-enforced network denial, verified runtime pins and import origins, and
writes confined to the canonical final outputs and owned runtime scratch. Fail closed if any of
these isolation guarantees cannot be met.

The shared generation contract sets a 168-minute owned deadline and a separate 180-minute outer
ceiling. A fresh item needs a 13-minute 11.25-second admission reserve for synthesis, encoding,
termination/settlement and finalization. Direct generation preserves those limits, serial fresh-item calls, cancellation and
owned-child settlement guarantees. Do not add an automatic device, runtime, model or hosted-service
fallback. Runtime/model weights and caches stay out of Git; see [third-party assets](third-party.md)
for pinned sources and separate SDK/model/decoder license limits. Provenance does not grant
permission to distribute generated audio.

Local generation, source review and checks do not authorize Git staging, committing, pushing,
publication or archive. Follow the [CV-update workflow](../.github/skills/cv-update/references/workflow.md)
for the complete sequence and [CV publication rules](cv-publication.md) for privacy and acceptance.
