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

- `resources/cv/facts.json` is the one generated answer index kept beside the CV. It contains
  concise reviewed answers, source line references and stored vectors, not a full CV copy.
- Analysis, candidate files, snapshots, source-review records and model caches stay in an
  external workspace. Model weights, browser profiles, build output and the generated
  `public/downloads/deniss-muhla-cv.pdf` stay out of Git.
- `public/audio/assistant/` is the permitted generated audio set: only a complete explicitly
  generated, reviewed and corpus-checked manifest/MP3 pair belongs there. Never merge partial
  clips, edit digests/vectors/manifests by hand or add a runtime TTS fallback.
- Test media stays external. Use public-domain or licensed content and record its source;
  do not retain owner recordings as repository fixtures.

A CV change invalidates the raw source identity. Regenerate and independently source-review
**the whole answer index**, embed/check the exact external candidate and prepare complete
matching speech from its final bytes. Install the reviewed facts and audio together with an
external previous-pair backup; do not serve a mismatched intermediate pair. Then refresh the
PDF and verify. Follow the [CV-update skill](../.github/skills/cv-update/SKILL.md) for the sequence,
the [facts skill](../.github/skills/cv-facts/SKILL.md) for authoring/review, and the
[audio pipeline](audio-pipeline.md) for exact staging requirements.

## Authority and acceptance

Preparation is scaffolding, not answer authoring. An offline check proves shape, provenance
and identity, not truth or retrieval quality. Source review requires an independent reviewer
and a record. Audio staging is preparation, not installation; no audio installer exists.
Facts promotion acknowledges review but does not prove it or grant publication permission.
A PDF build does not generate the answer index or speech corpus.

Require explicit owner authority before installing/promoting a pair. Publication, staging in
Git, committing, pushing or archiving needs separate explicit authority. Source/build checks,
older browser receipts and a small UI check do not establish final physical microphone,
offline, mobile, pronunciation or legal acceptance. The model and SDK terms are distinct;
[third-party provenance](third-party.md) is not permission to distribute generated audio.
