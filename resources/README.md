# Public career resources

Publication-ready career facts and skills for the personal website and future CVs.
This entire directory, including its Git history, must be safe to publish.

## Navigation

- [Current CV](cv/source/cv.md), the website and PDF build source and the single authoritative fact source.
- [Reviewed answer index](cv/facts.json), one derived file prepared for assistant retrieval.
- [Career overview](career.md) — professional experience, with source discrepancies explicit.
- [Skills](skills.md) — technical capabilities and examples of their use.
- [Credentials and languages](credentials.md) — public qualifications without identifiers.
- [Public sources](sources.md) — provenance and verification rules.
- [Profile photos](photo/) — existing website portraits only.

## Publication rules

Keep only public professional information and reviewed, non-confidential summaries.
Do not add contracts, invoices, rates, compensation, banking details, signatures, identity
numbers, credential verification codes, residential addresses, private correspondence,
family details, travel bookings, third-party photos or authenticated browser dumps.
Do not store private originals here, even in a git-ignored subdirectory. Detailed supporting
material belongs in an external private document store, not in this repository.

A document's existence does not make its contents public. Likewise, a logged-in profile view
can contain owner-only panels; only public professional fields may be summarized here.

Keep claims source-qualified. Historical role dates, proficiency labels and experience totals
must not be inferred from filenames, contracts or automatically generated summaries. Resolve
conflicting dates with the profile owner before changing the published CV.

## Reviewed answer index

`cv/facts.json` is the one derived file kept here. It holds reviewed cards, each with a topic,
descriptive tags, the CV line ranges the answer came from, one concise answer and a stored
embedding vector. It is generated from `cv/source/cv.md` and from nothing else.

`cv/source/cv.md` stays authoritative. This index never becomes a second source: it is regenerated
from the CV, and a CV change means regenerating the whole candidate and source-reviewing the whole
regenerated index, not only the answers that look affected. A card text change invalidates it too.

Everything used to produce it stays outside this repository in an external workspace: the source
analysis, the candidate, the per-section snapshots, the review records and the model caches. The
order is prepare, author, source review, embed, offline check, then explicit promotion. The offline
check runs in `build` and `build:site`, so a stale index fails the build. The commands are
`pnpm cv:facts`, `pnpm cv:facts:embed`, `pnpm cv:facts:check` and `pnpm cv:facts:promote`; the
[cv-facts skill](../.github/skills/cv-facts/SKILL.md) documents them in full.

Coverage is recorded as mapped source units plus deliberate omissions. Every extracted unit has at
least one card drawing on it, and the omissions that remain are recorded individually with their
reasons in the external workspace. A mapped unit means only that some card draws on it, not that
every fact inside it is answered, so this is neither a claim that every visitor question is covered
nor a claim that every fact in the CV is answered.

## Build compatibility

The build continues to use `cv/source/cv.md` and `photo/cv-photo.jpg`.
Additional notes are reference material; they are not automatically included in the website.
The assistant answers from the reviewed index in `cv/facts.json`; the canonical CV stays authoritative.
