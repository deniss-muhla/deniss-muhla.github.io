# Assistant audio pipeline

## Offline installed-pair check

From the repository root, run `pnpm cv:audio:check` (or `node scripts/cv-audio.mjs --check`).
This read-only, model-free check validates the installed v2 manifest, exact facts/greeting/
catalog identities, per-item text digests, MP3 bytes and complete directory coverage. It does
not check an external candidate/stage or prove pronunciation, truth, licensing or publication
acceptance. It has no generation side effect.

## External Kitten stage

Run this explicit recipe from the validated repository root. All example `/external/...`
paths are placeholders for canonical absolute external paths. `--kitten-stage` is the only
generation mode and prepares a non-servable v2 corpus in a **new** external stage directory.
It requires exact final embedded facts bytes/SHA and an explicit pinned runtime-input record;
it never defaults to served facts, public audio or local model paths.

```bash
facts=/external/facts.candidate.json
runtime_inputs=/external/kitten-runtime-inputs.json
stage=/external/new-kitten-v2-stage
workspace_root=/external/kitten-workspaces  # existing external temporary-workspace parent
facts_sha256="<64-character-sha256-for-the-exact-facts-bytes>"

# All inputs, stage output and temporary workspaces stay external; stage must not exist.
test -f "$facts" && test -f "$runtime_inputs" && test -d "$workspace_root"
# TERM at 179m55s leaves five seconds for KILL within the 180-minute outer bound.
TMPDIR="$workspace_root" timeout --signal=TERM --kill-after=5s 10795s \
  node scripts/cv-audio.mjs --kitten-stage \
    --facts "$facts" \
    --facts-sha256 "$facts_sha256" \
    --runtime-inputs "$runtime_inputs" \
    --stage "$stage" \
    --deadline-minutes 168
```

The owned deadline must be a positive integer no greater than 168 minutes. It stops admission
and active work early, not by extending each item. A real run also needs the external
180-minute hard ceiling. The 12-minute difference is for termination/settlement, not synthesis.
Admission reserves the 10-minute adapter call, 2-minute encoder call, their TERM/KILL settlement
allowances and a 60-second finalization margin. Cancellation stops new work and waits for owned
children to close. Interrupted/deadline-expired stages keep partial evidence, not a completed
manifest. Sample a bounded technical workload before authorizing the complete corpus.

The runtime record is version 1 with exactly these path fields plus `version`:
`pythonExecutable`, `sandboxExecutable`, `sdkRoot`, `sdkArchive`, `modelSnapshot`, `hubCache`
and `modulePathsFile`. The latter is an external JSON object with a required `modulePaths`
array of 88 absolute roots and optional `packageSources` object of 88 entries. Other fields
or malformed shapes are refused. `packageSources` is compatibility metadata, not a required
generation input. Paths, pins and the full source inventory are checked before the first
adapter call. Existing stage or sibling pending-manifest paths are refused.

The inventory determines the complete count; each item gets exactly one fresh serial pinned
adapter call. No waveform reuse, reuse receipts or `--reuse-inputs` option exists. WAVs,
metadata sidecars and encoding work stay in the reported workspace under explicit `TMPDIR`.
After complete validation, the stage holds only content-addressed MP3s and one final v2
playback manifest. `<stage>.manifest.pending` remains in the same-filesystem parent outside
the validated directory as provenance. The stage is not installed, published or a fallback.
Do not reformat/change the embedded facts bytes after staging; vectors affect their SHA too.

## Installation is separate

The CLI has no implicit generation mode, no public-writing path and no audio installer.
`pnpm cv:audio:generate` names the same entry point but still requires explicit staging options;
it is not a turnkey command. `--help` is not an audio CLI option. No model runs during `--check`
or model-free stage regressions. The stage command never loads Vite or the CV artifact pipeline.
This recipe documents an interface, not permission to run generation.

Follow the [CV-update workflow](../.github/skills/cv-update/references/workflow.md) for explicit
reviewed pair installation, backup/rollback, PDF refresh and verification. Keep runtime/model
files external; see [third-party assets](third-party.md) for pinned sources and separate SDK/
model/decoder license limits. Provenance does not grant audio-distribution permission.
