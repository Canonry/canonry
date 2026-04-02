#!/usr/bin/env bash
# Check that every package/app has an AGENTS.md and CLAUDE.md.
# Run in CI or pre-push to catch missing documentation.
set -euo pipefail

errors=0

# Check packages and apps for AGENTS.md + CLAUDE.md
for dir in packages/*/  apps/*/; do
  # Skip if not a real package (no package.json or src/)
  if [[ ! -f "${dir}package.json" ]] && [[ ! -d "${dir}src" ]]; then
    continue
  fi

  if [[ ! -f "${dir}AGENTS.md" ]]; then
    echo "MISSING: ${dir}AGENTS.md"
    errors=$((errors + 1))
  fi

  if [[ ! -f "${dir}CLAUDE.md" ]]; then
    echo "MISSING: ${dir}CLAUDE.md"
    errors=$((errors + 1))
  fi
done

# Check root files
for file in AGENTS.md CLAUDE.md; do
  if [[ ! -f "$file" ]]; then
    echo "MISSING: $file (root)"
    errors=$((errors + 1))
  fi
done

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
