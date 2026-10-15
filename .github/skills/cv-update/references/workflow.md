# Update the CV and assistant pair

Run repository commands below from the explicit repository root, not the skill directory.
All example `/external/...` paths are placeholders for validated absolute external paths.
Read [source and publication rules](../../../../docs/cv-publication.md) before editing.

A CV change needs a new reviewed answer index and a complete matching speech corpus, not just a new PDF. Preparation does not author answers, and `pnpm build` does not refresh answers or audio. Authoring, independent review and installation are explicit work; the commands below are not a turnkey update.

1. **Edit the source.** Update [the canonical CV](../../../../resources/cv/source/cv.md). Review the [public career notes](../../../../resources/README.md) and `resources/cv/cv-gaps.md`, if present, for stale, contradicted or newly relevant facts. Only the canonical CV supplies assistant answer claims.

2. **Refresh the whole answer candidate.** Follow [cv-facts skill](../../cv-facts/SKILL.md). Use a new workspace outside the repository:

   ```bash
   workspace=/external/new-cv-update
   candidate="$workspace/facts.candidate.json"
   pnpm cv:facts --out "$workspace"
   ```

   Preparation extracts source units and an empty scaffold, not finished answers. Read `analysis.json`, author every card in the external candidate, and record mapped source units and deliberate omissions. Have an independent reviewer source-review the **whole regenerated index**, recording the reviewer, date, card ids, findings and corrections against the CV source lines. Then embed and check:

   ```bash
   pnpm cv:facts:embed --candidate "$candidate" --cache /external/embedding-cache
   pnpm cv:facts:check --candidate "$candidate"
   ```

   Embedding may download the pinned model; keep its cache external. The offline check proves structure and identity, not answer truth. Pass pnpm options directly after the script name, without an extra `--`.

3. **Regenerate the complete matching speech stage.** Use the [explicit external Kitten v2 stage recipe](../../../../docs/audio-pipeline.md#external-kitten-stage), including its time bounds. It requires the pinned external Kitten SDK/model/runtime, an explicit runtime-input record, an existing external temporary-workspace parent and a new external stage directory. Supply the final embedded candidate as `--facts` and the SHA-256 of its exact bytes as `--facts-sha256`:

   ```bash
   sha256sum "$candidate"
   ```

   Vectors change the facts file SHA too, so never stage from the pre-embedding scaffold or change/reformat the candidate after staging. Generate every clip afresh against that final candidate and the pinned runtime record. Only a completed, validated stage with its final `manifest.json` and all MP3s is eligible for installation; interrupted or partial output is not. Stage-only generation never installs public audio. `pnpm cv:audio:check` (`--check`) checks only the currently installed facts/audio pair, not an external candidate or stage.

4. **Install the reviewed pair deliberately.** With the recorded independent review and explicit owner authorization, back up the previous `resources/cv/facts.json` and complete `public/audio/assistant/` directory together outside the repository. Then promote the exact candidate used for staging:

   ```bash
   pnpm cv:facts:promote --candidate "$candidate" --confirm-reviewed
   ```

   Deliberately replace the **entire** `public/audio/assistant/` directory with the validated stage's final manifest and MP3s as the other half of this matched update. This directory replacement is manual: no `cv:audio:promote` or other audio installer exists. Do not merge old clips or hand-edit generated manifests, digests or vectors. Confirm the installed facts bytes match the staged candidate's SHA. Do not serve or publish the intermediate mismatched pair; if installation or checks fail, restore both filesets from the external previous-pair backup before serving again.

5. **Refresh the PDF and verify before publication.** After installing both halves, run:

   ```bash
   pnpm cv:build
   pnpm cv:facts:check
   pnpm cv:audio:check
   pnpm build
   pnpm preview:site
   ```

   `cv:build` regenerates the PDF, not assistant answers or clips. Check the preview's rendered CV and downloadable PDF manually, then check typed answers and explicit Replay, plus consented live voice where available; see [manual testing](../../../../docs/manual-testing.md) for detailed QA. Stop if either installed-pair check fails. Publication remains a separate, deliberate owner decision. Keep the generated PDF, `dist/`, model caches and external review/staging work out of Git; only the reviewed facts index and complete checked public audio set belong in the assistant asset update.

