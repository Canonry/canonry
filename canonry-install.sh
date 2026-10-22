#!/usr/bin/env bash
set -euo pipefail

node scripts/check-node.mjs

if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm not found. Install it with: npm install -g pnpm@12.14.0" >&2
  exit 1
fi

echo "Installing dependencies..."
pnpm install

echo "Building all packages..."
pnpm -r run build

echo "Installing canonry globally..."
npm install -g ./packages/canonry

# PATH sanity: a registry install (npm i -g @canonry/canonry) and this folder
# install can coexist in different prefixes; PATH order then silently decides
# which binary runs, and the loser goes stale.
for bin in canonry cnry; do
  dupes=$(which -a "$bin" 2>/dev/null | while IFS= read -r p; do
    readlink -f "$p" 2>/dev/null || printf '%s\n' "$p"
  done | sort -u | grep -c . || true)
  if [ "${dupes:-0}" -gt 1 ]; then
    echo "" >&2
    echo "warning: multiple '$bin' installs resolve to different targets on PATH:" >&2
    which -a "$bin" >&2
    echo "The first one wins. Remove the stale copy (npm rm -g @canonry/canonry in the other prefix)." >&2
  fi
done

echo ""
echo "Done. Run 'canonry --version' to verify."
