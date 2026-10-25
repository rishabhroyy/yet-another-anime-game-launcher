#!/usr/bin/env bash
# Dev run of the HoYoPlay app (fork equivalent of upstream's `pnpm start`, kept
# out of package.json so upstream merges don't conflict there).
# Usage: scripts/start-hoyoplay.sh [hoyoplay|hoyoplaycn]
set -euo pipefail
cd "$(dirname "$0")/.."

CHANNEL="${1:-hoyoplay}"
WD="${CHANNEL}wd"

./build-sophon.sh
YAAGL_CHANNEL_CLIENT="${CHANNEL}" pnpm exec vite build --mode=development
cp ./neutralino.js ./dist/neutralino.js
mkdir -p "${WD}"
cp neutralino.config.json "${WD}/neutralino.config.json"
rsync -rlptu dist "${WD}"
rsync -rlptu sidecar "${WD}"
rsync -rlptu src/icons "${WD}/src"
pnpm exec neu run -- --path="./${WD}"
