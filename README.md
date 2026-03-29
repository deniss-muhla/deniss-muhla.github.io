# deniss-muhla.github.io

Personal GitHub Pages site for Deniss Muhla.

## Stack

- React 19
- TypeScript 6.0.2
- CSS Modules
- Vite+ (`vp`)
- GitHub Pages via GitHub Actions

## Development

- `vp install`
- `vp dev`
- `vp run typecheck`
- `vp run cv:build`
- `vp run build:site`

The site uses a separate homepage and `/cv/` page. The downloadable PDF is generated from the markdown source before build output is produced.

## CV Source

- Canonical CV markdown: `resources/cv/source/cv.md`
- Original imported CV documents: `resources/cv/source/original/`
- Generated download artifact: `public/downloads/deniss-muhla-cv.pdf`

## Deployment

GitHub Pages deployment is handled by `.github/workflows/deploy-pages.yml`.
