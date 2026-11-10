#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
command -v node >/dev/null 2>&1 || { echo 'node is required' >&2; exit 1; }
[ -x "$root/node_modules/.bin/vite" ] && [ -d "$root/node_modules/puppeteer" ] || { echo 'Install project dependencies first (pnpm install --offline)' >&2; exit 1; }
[ -f "$root/dist/index.html" ] || { echo 'Build the site first (pnpm build)' >&2; exit 1; }
cd "$root"
exec node scripts/assistant-smoke.cjs "$@"
