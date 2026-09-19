#!/usr/bin/env bash
# Check that every package/app has an AGENTS.md.
# Run in CI to catch missing documentation.
set -euo pipefail

errors=0

# Check packages and apps for AGENTS.md
for dir in packages/*/  apps/*/; do
  # Skip if not a real package (no package.json or src/)
  if [[ ! -f "${dir}package.json" ]] && [[ ! -d "${dir}src" ]]; then
    continue
  fi

  if [[ ! -f "${dir}AGENTS.md" ]]; then
    echo "MISSING: ${dir}AGENTS.md"
    errors=$((errors + 1))
  fi
done

# Check root files
if [[ ! -f AGENTS.md ]]; then
  echo "MISSING: AGENTS.md (root)"
  errors=$((errors + 1))
fi

# Check key docs exist
for file in docs/architecture.md docs/data-model.md docs/providers/README.md; do
  if [[ ! -f "$file" ]]; then
    echo "MISSING: $file"
    errors=$((errors + 1))
  fi
done

if [[ $errors -gt 0 ]]; then
  echo ""
  echo "$errors missing documentation file(s). See AGENTS.md 'Keeping Documentation Current' for guidance."
  exit 1
fi

echo "All documentation files present."
