# CV sources and publication

## Public source rules

The [canonical CV](../resources/cv/source/cv.md) is authoritative for the site, derived PDF
and assistant answer claims. Do not copy the full CV into components, docs, notes or fixtures.
The [career vault](../resources/README.md) holds reviewed public professional facts, skills,
credentials and attributed source notes, not another canonical CV. After a CV edit, inspect
those notes and `resources/cv/cv-gaps.md`, if present, for stale, contradicted or newly relevant facts.

Never put contracts, invoices, rates, salaries, banking details, signatures, identity numbers,
credential verification codes, residential addresses, private correspondence, family details,
travel bookings, third-party photos or authenticated browser captures in this public repository
or its history. Ignored directories are not a private store. Keep detailed originals in an
external private document store. Logged-in profiles may include owner-only panels; summarize
only public professional fields.

Every vault claim needs published professional evidence or a clearly attributed source.
Do not infer historical dates, proficiency levels or experience totals from filenames or
automated summaries. Keep conflicting dates visible in the timeline; obtain owner resolution
before changing the published CV. The assistant index has a narrower rule: only the canonical
CV supplies its claims, not sibling notes, websites, job descriptions or recollection.

## Derived artifacts

- `resources/cv/facts.json` is the generated answer index kept beside the CV. It contains concise
  reviewed answers, source line references and stored vectors, not a full CV copy.
- `public/audio/assistant/` is the final generated audio set. It may contain only a complete,
  reviewed and corpus-checked v2 manifest/MP3 pair. Never merge partial clips, hand-edit
  digests, populated vectors or manifests, or add a runtime TTS fallback. Pending answer edits
  may clear vectors only as described in the [facts skill](../.github/skills/cv-facts/SKILL.md).
- Generate the whole facts index directly at `resources/cv/facts.json`, then generate the complete
  matching audio directly at `public/audio/assistant/` from the exact final facts bytes and pinned
  settings. Do not create a separate candidate, stage or backup output, or add a promotion or
  move-after-generation step. Independently source-review the whole answer index and validate the
  complete pair. A failed or interrupted run must remain clearly incomplete; do not serve a
  mismatched pair.
- Model weights and runtime caches, browser profiles, build output and the generated
  `public/downloads/deniss-muhla-cv.pdf` stay out of Git. Test media stays outside the repository;
  use public-domain or licensed content and record its source. Do not retain owner recordings as
  repository fixtures.

Facts preparation and explicit embedding support the final path without promotion; use the
[facts interface](../.github/skills/cv-facts/SKILL.md#current-command-interface), including required
authoring and independent whole-index review. Audio supports explicit direct-final output with model-free regression coverage; the maintained CLI
remains Linux/CUDA only (see the audio provenance note). Follow the
[audio interface](audio-pipeline.md#current-command-interface) for its fixed paths, preflight and
incomplete-state behavior. The legacy external stage is not the CV-update target. See the
[CV-update workflow](../.github/skills/cv-update/references/workflow.md) for whole-pair acceptance.

## Authority and acceptance

An offline check proves shape, provenance and identity, not truth or retrieval quality. Source
review requires an independent reviewer and a record. A PDF build does not generate the answer
index or speech corpus. The exact model, SDK and decoder pins must remain intact unless a separate
owner decision changes them. Their terms are distinct; [third-party provenance](third-party.md)
is not permission to distribute generated audio.

Routine in-scope CV editing, complete regeneration and local checks may proceed under the approved
task. A local update is not publication. Publication, Git staging, committing, pushing or archiving
needs separate explicit authority. Use Git for recovery of committed tracked files; do not create
extra backup copies. Git does not preserve uncommitted changes. Preserve existing dirty owner work.
Source/build checks, older browser receipts and a small UI check do not establish final physical
microphone, offline, mobile, pronunciation or legal acceptance.
