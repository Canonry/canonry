#!/usr/bin/env bash
set -euo pipefail

echo "Installing dependencies..."
pnpm install

echo "Building all packages..."
pnpm -r run build

echo "Installing canonry globally..."
npm install -g ./packages/canonry

echo ""
echo "Done. Run 'canonry --version' to verify."
