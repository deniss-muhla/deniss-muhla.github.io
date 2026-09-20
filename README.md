# deniss-muhla.github.io

Personal GitHub Pages site for Deniss Muhla.

## Stack

- React 19
- TypeScript 6.0.2
- CSS Modules
- Vite+ (`vp`)
- GitHub Pages via GitHub Actions

## Development

- `pnpm install`
- `pnpm dev`
- `pnpm typecheck`
- `pnpm cv:build`
- `pnpm build`

The site is a single-page experience with the CV embedded in the main page. The downloadable PDF is generated from the markdown source during the build pipeline.

## CV Source

- Canonical CV markdown: `resources/cv/source/cv.md`
- Public career facts, skills and source policy: [resources/README.md](resources/README.md)
- Detailed supporting documents are stored outside this public repository.
- Generated download artifact: `public/downloads/deniss-muhla-cv.pdf`

## Deployment

GitHub Pages deployment is handled by `.github/workflows/deploy-pages.yml`.
