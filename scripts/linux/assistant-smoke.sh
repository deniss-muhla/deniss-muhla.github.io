#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
command -v node >/dev/null 2>&1 || { echo 'node is required' >&2; exit 1; }
[ -x "$root/node_modules/.bin/vite" ] && [ -d "$root/node_modules/puppeteer" ] || { echo 'Install project dependencies first (pnpm install --offline)' >&2; exit 1; }
[ -f "$root/dist/index.html" ] || { echo 'Build the site first (pnpm build)' >&2; exit 1; }
if [ -z "${CHROME_PATH:-}" ]; then
  for browser in chromium chromium-browser google-chrome; do
    if command -v "$browser" >/dev/null 2>&1; then CHROME_PATH=$(command -v "$browser"); export CHROME_PATH; break; fi
  done
fi
cd "$root"
exec node scripts/assistant-smoke.cjs "$@"
