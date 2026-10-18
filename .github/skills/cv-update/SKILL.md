---
name: cv-update
description: >
  Update the canonical public CV and coordinate the whole independently reviewed answer
  index, matching prerecorded speech corpus, explicit pair installation, PDF refresh and
  verification. Use for CV changes or stale CV/facts/audio identities. Preparation and
  staging are not installation or publication; this skill grants no promotion authority.
---

# CV update

## Read before acting

- [Canonical source and publication rules](../../../docs/cv-publication.md): public-only
  evidence, private exclusions, career-note staleness and artifact boundaries.
- [Complete update workflow](references/workflow.md): exact order, prerequisites, commands,
  matching-pair backup/rollback and owner approval gates.
- [Facts skill](../cv-facts/SKILL.md): extract/scaffold, author every answer, independently
  source-review the **whole regenerated candidate**, embed and check exact bytes.
- [Audio pipeline](../../../docs/audio-pipeline.md): explicit pinned external runtime,
  facts SHA, new stage, temporary-workspace parent and bounded full-corpus preparation.
- [Manual testing](../../../docs/manual-testing.md): rendered CV/PDF, typed answers, stored
  Replay and separately consented live voice. No source/build-only runtime acceptance.

## Sequence and stop conditions

1. Confirm scope, public sources, external workspace and owner authority. Edit only the
   canonical CV for CV claims; inspect career notes and `cv-gaps.md` for staleness.
2. Regenerate the whole facts scaffold, author all cards and record mapped units/omissions.
   Obtain a recorded independent source review of every regenerated answer.
3. Embed the exact external candidate (the named network step), then check it offline.
   Check does not prove truth or retrieval quality; do not promote a failed candidate.
4. Stage every speech clip afresh from the final embedded bytes and SHA with pinned external
   runtime inputs. Do not reformat/change those bytes afterwards or use partial output.
5. With explicit authorization, back up the previous facts/audio pair externally, promote
   the reviewed candidate and manually replace the complete audio directory. No audio
   installer exists. Do not serve the mismatched interval; restore both halves on failure.
6. Refresh the PDF, check both installed artifacts, build and manually verify. Publication,
   commit, push and archive remain separate explicit owner decisions.

Stop for unsupported claims, private material, uncertain source provenance, absent review,
failed checks, mismatched identities, missing runtime pins or an unapproved install/publication.
Do not migrate only selected old cards or merge clips. This is coordinated work, not a turnkey
CV generator. `cv:build` refreshes the PDF only; stage is not installation or playback fallback.

## Optional read-only candidate preflight

The bundled helper invokes the existing offline facts check only. It validates explicit
absolute repo/workspace/candidate inputs, canonicalizes containment, limits the child to
30 seconds and prints rule labels without source/answer text. It does not author, download,
embed, run a model, generate audio/PDF, promote, install, create caches or publish. It does
not validate an external speech stage or replace independent source review.

From this skill directory, with an existing external workspace and embedded candidate:

```bash
node scripts/check-candidate.mjs --help
repo="$(realpath ../../..)"
workspace=/external/existing-cv-update
candidate="$workspace/facts.candidate.json"
node scripts/check-candidate.mjs --repo "$repo" --workspace "$workspace" --candidate "$candidate"
```

The repo must be the checkout containing this helper; the workspace must be an existing
external directory, not an ancestor containing that checkout. The candidate must resolve
to a regular file inside that workspace. Help and invalid arguments are safe read-only
samples. Any nonzero exit stops the update; the helper's pass means only offline identity
and shape validation passed, not approval to install.
