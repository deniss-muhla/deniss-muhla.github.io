---
name: cv-update
description: >
  Update the canonical public CV, regenerate the complete reviewed answer index and matching
  speech corpus directly at their final paths, refresh the PDF and verify the site. Use for CV
  changes or stale CV/facts/audio identities. The skill does not authorize publication.
---

# CV update

## Read before acting

- [Canonical source and publication rules](../../../docs/cv-publication.md): public-only
  evidence, private exclusions, career-note staleness and artifact boundaries.
- [Complete update workflow](references/workflow.md): direct final paths, whole-index review,
  pair checks, failure handling and the current adapter gap.
- [Facts skill](../cv-facts/SKILL.md): source-qualified answers, coverage, whole-index review and
  offline validation.
- [Audio pipeline](../../../docs/audio-pipeline.md): exact pins, complete corpus requirements,
  supported checks and direct-generation status.
- [Manual testing](../../../docs/manual-testing.md): rendered CV/PDF, typed answers, stored Replay
  and separately consented live voice. Source/build checks do not establish runtime acceptance.

## Sequence and stop conditions

1. Confirm the task scope and source authority. Edit only the canonical CV for CV claims; inspect
   career notes and `cv-gaps.md`, if present, for stale or contradicted facts.
2. Regenerate the whole answer index directly at `resources/cv/facts.json`. Author all cards from
   the canonical source, record mapped units and deliberate omissions, and obtain an independent
   source review of every answer.
3. Generate the complete matching audio corpus directly at `public/audio/assistant/` from the
   exact final facts bytes and pinned runtime inputs. Generate every catalog item afresh. Do not
   create a separate candidate, stage or backup output, or add a promotion or move step.
4. Run both installed-pair checks. Do not serve an incomplete or mismatched pair. If generation
   or validation fails, leave a truthful incomplete state and stop serving the pair.
5. Refresh the PDF and verify the rendered CV, typed answers and stored Replay. Use the manual
   testing guide for any separate browser, microphone or offline acceptance.

Routine in-scope edits, regeneration and local checks may proceed under the approved task. Facts
support direct final-path preparation and explicit embedding; follow the [facts interface](../cv-facts/SKILL.md#current-command-interface).
Preserve an existing reviewed whole index when its source/embedding identity already matches.
Audio supports explicit `--final` output with model-free tests, and the maintained CLI
remains Linux/CUDA only. Follow the [audio interface](../../../docs/audio-pipeline.md#current-command-interface)
and [workflow status](references/workflow.md#current-command-support); do not infer platform support
or use the legacy external stage as the target. Stop for unsupported claims,
private material, uncertain source provenance, absent independent review, failed checks, mismatched
identities or missing runtime pins. Do not migrate selected old cards or merge old clips.

A PDF build refreshes the PDF only. Git staging, committing, pushing, publication and archive remain
separate explicit actions. Use Git for committed tracked-file recovery; do not make backup copies.
