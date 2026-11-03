# deniss-muhla.github.io

Deniss Muhla's public CV and portfolio site, hosted on GitHub Pages.

The single-page site renders the canonical Markdown CV and offers a derived PDF.
Its on-device assistant selects reviewed answers and plays matching prerecorded clips.
Questions and speech recognition stay on the device; there is no hosted answer service
or runtime speech synthesis. Models and site assets need an initial download.

## Get started

```bash
pnpm install
pnpm dev
```

The stack uses React, TypeScript, CSS Modules and Vite. GitHub Actions handles
[Pages deployment](.github/workflows/deploy-pages.yml); publication needs explicit owner approval.
Site-absolute routes assume deployment at the domain root.

## Update and verify

- [CV-update skill](.github/skills/cv-update/SKILL.md): edit the source, regenerate the full
  facts index and matching audio directly at their final paths, check the pair and refresh the PDF.
- [Answer-index skill](.github/skills/cv-facts/SKILL.md): author source-qualified answers, review
  the whole index and check its source/embedding identity.
- [Public career resources](resources/README.md): supporting notes and provenance.
- [Development and checks](docs/development.md): commands and bounded QA workloads.
- [Manual browser testing](docs/manual-testing.md): consent, controls and final owner checks.
- [Assistant runtime contracts](docs/assistant-runtime.md): boundaries, caching and known limits.
- [Audio pipeline](docs/audio-pipeline.md): direct-to-final target, read-only checks and the
  current generation interface.
- [Third-party assets](docs/third-party.md): pinned sources, attribution and license limits.

A CV change needs a complete, independently reviewed facts/audio pair, not only a new PDF.
Offline checks validate identity and completeness, not answer truth. Facts support direct final-path
preparation and embedding. Audio supports [explicit direct-final output](docs/audio-pipeline.md#current-command-interface)
with model-free coverage; the maintained CLI remains Linux/CUDA only (see the [audio provenance](docs/audio-pipeline.md#current-command-interface)). Local generation and checks do not authorize Git staging or publication.
