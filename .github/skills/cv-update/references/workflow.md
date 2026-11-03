# Update the CV and assistant pair

Run repository commands from the validated repository root. Read the [source and publication
rules](../../../../docs/cv-publication.md) before editing.

## Owner-approved sequence

A CV change needs a newly reviewed whole answer index and a complete matching speech corpus, not
just a new PDF. The target uses the existing final paths. Do not write a separate candidate, audio
stage or backup copy, and do not add a promotion or move-after-generation step.

1. **Edit the source.** Update [the canonical CV](../../../../resources/cv/source/cv.md). Review
   the [public career notes](../../../../resources/README.md) and `resources/cv/cv-gaps.md`, if
   present, for stale, contradicted or newly relevant facts. Only the canonical CV supplies
   assistant answer claims.

2. **Regenerate and review the whole facts index.** Write the complete generated index directly to
   `resources/cv/facts.json`. Author every card from the canonical CV, retain exact source line
   references and embeddings, and record mapped units and deliberate omissions. An independent
   reviewer must source-review every answer in the regenerated index and record the cards reviewed,
   reviewer, date, findings and corrections. A shape/identity check does not prove answer truth.
   Use the [facts command interface](../../cv-facts/SKILL.md#current-command-interface) for direct
   preparation, authoring, review and explicit embedding. Preserve an existing reviewed whole index
   when its source/embedding identity already matches; do not overwrite completed owner work.

3. **Regenerate the complete matching audio corpus.** Write the complete v2 manifest and all
   content-addressed MP3s directly to `public/audio/assistant/`, using the exact final facts bytes
   and the pinned Kitten SDK, model, decoder and speech settings. Generate each catalog item
   afresh; do not merge clips or hand-edit generated files. Validate the full manifest, bytes,
   facts/greeting/catalog identities, text digests and directory coverage.

   For listening acceptance, identify changed and new clips against the prior committed corpus
   and listen to their final MP3s. Assess wording, meaningful names and technical terms, and clip
   endings. Report defects by clip ID and timestamp. If listening is unavailable, leave listening
   acceptance incomplete; technical checks do not replace it.

4. **Check the final pair and refresh the PDF.** Run the read-only facts and audio checks, then
   refresh the PDF and run the relevant build and manual checks:

   ```bash
   pnpm cv:facts:check
   pnpm cv:audio:check
   pnpm cv:build
   pnpm build
   pnpm preview:site
   ```

   Check the rendered CV and downloadable PDF, typed answers and explicit stored Replay. See
   [manual testing](../../../../docs/manual-testing.md) for browser details. A PDF build does not
   regenerate facts or audio. A local preview does not authorize publication.

## Failure and recovery

If generation stops or either check fails, keep the result labelled incomplete and do not serve a
mismatched pair. Do not make a backup copy or install a separate stage. Git is the recovery source
for committed tracked files; it does not contain uncommitted edits. Preserve pre-existing owner
changes and use only scoped Git recovery after confirming the exact paths and baseline. Do not stage,
commit, push, publish or archive without separate authority.

## Current command support

Facts support direct final-path preparation and embedding through the [facts command interface](../../cv-facts/SKILL.md#current-command-interface).
Preparation writes a scaffold only; authoring and independent whole-index review remain required.
No separate facts promotion is needed.

Audio supports explicit `--final` generation using only the canonical final facts and output paths;
follow the single [audio command recipe](../../../../docs/audio-pipeline.md#current-command-interface).
Its direct-output behavior is covered by model-free tests; the maintained CLI remains Linux/CUDA
only. Stop before real generation until runtime pins,
OS isolation and bounded sample prerequisites pass. The legacy external `--kitten-stage` is not
the target. Do not present facts-only completion as a valid complete pair.

These checks are currently supported and write nothing:

```bash
pnpm cv:facts:check
pnpm cv:audio:check
```

They validate the currently installed pair only. They do not prove source truth, pronunciation,
licensing or publication acceptance. No model download, synthesis, PDF build, Git operation or
publication follows from a read-only check.
