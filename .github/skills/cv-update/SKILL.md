---
name: cv-update
description: >
  Update the canonical public CV, regenerate the complete reviewed answer index at its final path, refresh the PDF and verify
  the site. Use for CV changes or stale CV/facts identities. The skill does not authorize publication.
---

# CV update

## Read before acting

- [Canonical source and publication rules](../../../docs/cv-publication.md): public-only
  evidence, private exclusions, career-note staleness and artifact boundaries.
- [Complete update workflow](references/workflow.md): direct final path, whole-index review,
  checks and failure handling.
- [Facts skill](../cv-facts/SKILL.md): source-qualified answers, coverage, whole-index review and
  offline validation.
- [Audio pipeline](../../../docs/audio-pipeline.md): runtime speech and local smoke checks.
- [Manual testing](../../../docs/manual-testing.md): rendered CV/PDF, typed answers, stored Replay
  and separately consented live voice. Source/build checks do not establish runtime acceptance.

## Sequence and stop conditions

1. Confirm the task scope and source authority. Edit only the canonical CV for CV claims; inspect
   career notes and `cv-gaps.md`, if present, for stale or contradicted facts.
2. Regenerate the whole answer index directly at `resources/cv/facts.json`. Author all cards from
   the canonical source, record mapped units and deliberate omissions, and obtain an independent
   source review of every answer.
3. After review, embed with the pinned model using `pnpm cv:facts:embed --final --confirm-reviewed`
   and run `pnpm cv:facts:check`. Do not serve an incomplete index.
4. Refresh the PDF and verify the rendered CV, typed answers and stored Replay. Use the manual
   testing guide for separate browser, microphone or offline acceptance.

Routine in-scope edits, regeneration and local checks may proceed under the approved task. Follow
the [facts interface](../cv-facts/SKILL.md#current-command-interface). Preserve an existing reviewed
whole index when its source/embedding identity already matches. Stop for unsupported claims, private
material, uncertain provenance, absent independent review, failed checks or missing runtime pins.
Legacy Kitten audio tooling is not used by the runtime or build.

A PDF build refreshes the PDF only. Git staging, committing, pushing, publication and archive remain
separate explicit actions. Use Git for committed tracked-file recovery; do not make backup copies.
