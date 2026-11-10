# Update the CV and assistant index

Run repository commands from the validated repository root. Read the [source and publication
rules](../../../../docs/cv-publication.md) before editing.

## Owner-approved sequence

A CV change needs a newly reviewed whole answer index, not just a new PDF. The assistant synthesizes
speech on device; it does not need a matching prerecorded corpus.

1. **Edit the source.** Update [the canonical CV](../../../../resources/cv/source/cv.md). Review
   the [public career notes](../../../../resources/README.md) and `resources/cv/cv-gaps.md`, if
   present, for stale, contradicted or newly relevant facts. Only the canonical CV supplies
   assistant answer claims.
2. **Regenerate and review the whole facts index.** Write the complete index directly to
   `resources/cv/facts.json`. Author atomic and perspective cards from the canonical CV, use
   "Denis" in answer prose, retain exact source references, and record mapped units and deliberate
   omissions. Perspective card generation is tracked as follow-up task 5.1. An independent reviewer
   must source-review every answer and record the cards reviewed, reviewer, date, findings and
   corrections. A shape/identity check does not prove answer truth. Preserve an existing reviewed
   whole index when its source/embedding identity already matches; do not overwrite owner work.
3. **Embed and check.** Follow the [facts command interface](../../cv-facts/SKILL.md#current-command-interface).
   After review, run `pnpm cv:facts:embed --final --confirm-reviewed` with model-use authority,
   then `pnpm cv:facts:check`. Keep the pinned embedding model and do not hand-edit vectors.
4. **Refresh the PDF and verify.** Run relevant build and manual checks:

   ```bash
   pnpm cv:build
   pnpm build
   pnpm preview:site
   ```

   Check the rendered CV and downloadable PDF, typed answers and stored Replay. See
   [manual testing](../../../../docs/manual-testing.md) for browser details. A PDF build does not
   regenerate facts. A local preview does not authorize publication.

## Failure and recovery

If generation or validation fails, keep the index labelled incomplete and do not serve it. Do not
make a backup copy, separate candidate or stage, or add a promotion or move-after-generation step.
Git recovers committed tracked files, not uncommitted edits. Preserve pre-existing owner changes and
use only scoped Git recovery after confirming exact paths and baseline. Do not stage, commit, push,
publish or archive without separate authority.

## Current command support

Facts support direct final-path preparation and embedding through the [facts command interface](../../cv-facts/SKILL.md#current-command-interface).
Preparation writes a scaffold only; authoring and independent whole-index review remain required.
`pnpm cv:facts:check` is read-only and does not prove source truth, pronunciation, licensing or
publication acceptance. Legacy Kitten audio commands are not used by the runtime or build; see
[audio pipeline](../../../../docs/audio-pipeline.md).
