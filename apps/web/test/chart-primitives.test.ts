import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, test } from 'vitest'

import {
  CHART_AXIS_STROKE,
  CHART_AXIS_TICK,
  CHART_GRID_STROKE,
  CHART_NEUTRAL,
  CHART_SERIES_COLORS,
  CHART_TONE,
  CHART_TOOLTIP_STYLE,
  PROVIDER_SERIES_COLORS,
} from '../src/components/shared/ChartPrimitives'

const stylesPath = resolve(import.meta.dirname, '../src/styles.css')

// Pull the leading `var(--name, fallback)` out of a value string. Handles a
// prefix (`1px solid var(...)`) and a fallback that itself contains parens
// (`rgba(...)`) by matching balanced parens.
function parseVar(value: string): { name: string; fallback: string } {
  const start = value.indexOf('var(')
  expect(start, `expected a var() in "${value}"`).toBeGreaterThanOrEqual(0)
  let depth = 0
  let end = -1
  for (let i = start + 3; i < value.length; i += 1) {
    if (value[i] === '(') depth += 1
    else if (value[i] === ')') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  expect(end, `unbalanced var() in "${value}"`).toBeGreaterThan(0)
  const inner = value.slice(start + 4, end)
  const comma = inner.indexOf(',')
  expect(comma, `var() has no fallback in "${value}"`).toBeGreaterThan(0)
  return { name: inner.slice(0, comma).trim(), fallback: inner.slice(comma + 1).trim() }
}

async function chartTokenDefaults(): Promise<Map<string, string>> {
  const css = await readFile(stylesPath, 'utf8')
  const map = new Map<string, string>()
  for (const m of css.matchAll(/(--chart-[a-z0-9-]+):([^;]+);/g)) {
    map.set(m[1]!, m[2]!.trim())
  }
  return map
}

// Every JS constant that Recharts consumes, paired with the --chart-* token it
// must bridge to.
const BRIDGED: Array<[string, string]> = [
  [CHART_TOOLTIP_STYLE.contentStyle.backgroundColor as string, '--chart-tooltip-bg'],
  [CHART_TOOLTIP_STYLE.contentStyle.border as string, '--chart-tooltip-border'],
  [CHART_TOOLTIP_STYLE.labelStyle.color as string, '--chart-tooltip-label'],
  [CHART_TOOLTIP_STYLE.itemStyle.color as string, '--chart-tooltip-item'],
  [CHART_AXIS_TICK.fill, '--chart-neutral-text-dim'],
  [CHART_GRID_STROKE, '--chart-grid'],
  [CHART_AXIS_STROKE, '--chart-axis'],
  [CHART_NEUTRAL.text, '--chart-neutral-text'],
  [CHART_NEUTRAL.textDim, '--chart-neutral-text-dim'],
  [CHART_NEUTRAL.textFaint, '--chart-neutral-text-faint'],
  [CHART_NEUTRAL.surface, '--chart-neutral-surface'],
  [CHART_NEUTRAL.gridLine, '--chart-neutral-grid-line'],
  [CHART_TONE.positive, '--chart-tone-positive'],
  [CHART_TONE.positiveDeep, '--chart-tone-positive-deep'],
  [CHART_TONE.caution, '--chart-tone-caution'],
  [CHART_TONE.negative, '--chart-tone-negative'],
  [CHART_TONE.neutral, '--chart-tone-neutral'],
  ...CHART_SERIES_COLORS.map((c, i): [string, string] => [c, `--chart-series-${i + 1}`]),
]

describe('ChartPrimitives ↔ CSS chart tokens', () => {
  test('every Recharts constant bridges to its --chart-* token', () => {
    for (const [value, token] of BRIDGED) {
      const { name } = parseVar(value)
      expect(name).toBe(token)
    }
  })

  test('each JS fallback matches the CSS token default (no two-source drift)', async () => {
    const defaults = await chartTokenDefaults()
    for (const [value, token] of BRIDGED) {
      const { name, fallback } = parseVar(value)
      expect(defaults.has(name), `${name} missing from styles.css @theme`).toBe(true)
      expect(fallback, `${token} fallback drifted from its CSS default`).toBe(defaults.get(name))
    }
  })

  test('provider identity colors stay fixed literal hex (not themeable)', () => {
    // ProviderBadge identity encodes WHICH engine, not tone — must not bridge.
    for (const hex of Object.values(PROVIDER_SERIES_COLORS)) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
})
