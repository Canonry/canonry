#!/usr/bin/env node
// Progress reporter for the design-token migration (engine issue #767, Phase 3).
// Counts remaining raw Tailwind palette utilities per file under apps/web/src.
// The ENFORCED gate is the `design-tokens/no-literal-palette` ESLint rule (plus
// its allowlist in eslint.config.js); this script is just a "how much is left"
// view for tracking the ratchet across slices. Run: `pnpm --filter @ainyc/canonry-web scan:colors`.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = join(WEB_DIR, 'src')
const REPO_ROOT = join(WEB_DIR, '..', '..')

// Keep in sync with RAW_PALETTE_RE in eslint.config.js (kept literal in both
// places on purpose: the lint rule is the gate, this is a read-only report).
const RE =
  /\b(?:bg|text|border|ring|fill|stroke|from|via|to|divide|outline|decoration|accent|caret|placeholder|shadow|ring-offset)-(?:zinc|slate|gray|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950)\b/g

// PERMANENT exclusions (see eslint.config.js): engine identity + chart fallbacks.
const EXCLUDE = new Set(['ProviderBadge.tsx', 'ChartPrimitives.tsx'])

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith('.tsx') || name.endsWith('.ts')) out.push(p)
  }
  return out
}

let total = 0
const rows = []
for (const file of walk(SRC)) {
  if (EXCLUDE.has(file.split('/').pop())) continue
  const hits = (readFileSync(file, 'utf8').match(RE) ?? []).length
  if (hits > 0) {
    rows.push([hits, relative(REPO_ROOT, file)])
    total += hits
  }
}
rows.sort((a, b) => b[0] - a[0])
for (const [n, p] of rows) console.log(String(n).padStart(5), p)
console.log(`\n${total} raw-palette sites across ${rows.length} files (excludes ProviderBadge, ChartPrimitives)`)
