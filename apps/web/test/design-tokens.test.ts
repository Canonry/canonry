import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { compile } from 'tailwindcss'
import { expect, test } from 'vitest'

const stylesPath = resolve(import.meta.dirname, '../src/styles.css')
const tailwindRoot = resolve(import.meta.dirname, '../node_modules/tailwindcss')

async function loadTailwindStylesheet(id: string) {
  if (id !== 'tailwindcss' && !id.startsWith('tailwindcss/')) {
    throw new Error(`Unexpected stylesheet import: ${id}`)
  }

  const filename = id === 'tailwindcss'
    ? 'index.css'
    : `${id.slice('tailwindcss/'.length)}.css`
  const path = resolve(tailwindRoot, filename)
  return {
    path,
    base: dirname(path),
    content: await readFile(path, 'utf8'),
  }
}

async function compileAppStyles(candidates: string[]) {
  const compiler = await compile(await readFile(stylesPath, 'utf8'), {
    from: stylesPath,
    base: dirname(stylesPath),
    loadStylesheet: loadTailwindStylesheet,
  })

  return compiler.build(candidates)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Return the body of the compiled rule whose selector list contains `selector`.
// Matches `selector` only as a standalone member of a selector prelude, so it
// handles comma-grouped selectors (`.a, .b { … }`) and never matches a prefix
// of a longer class (`.answer-highlight` inside `.answer-highlight-brand`).
function ruleFor(css: string, selector: string) {
  const anchor = new RegExp(`${escapeRegExp(selector)}(?=[\\s,{:>~+])`)
  const match = anchor.exec(css)
  if (!match) {
    throw new Error(`Could not find compiled rule for ${selector}`)
  }

  const openBrace = css.indexOf('{', match.index)
  let depth = 0

  for (let index = openBrace; index < css.length; index += 1) {
    const char = css[index]
    if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return css.slice(openBrace + 1, index)
      }
    }
  }

  throw new Error(`Compiled rule for ${selector} was not closed`)
}

test('semantic color utilities compile to runtime-overridable CSS variables', async () => {
  const css = await compileAppStyles([
    'bg-bg',
    'bg-surface/50',
    'bg-surface-active',
    'bg-surface-inset-hover',
    'border-base',
    'border-default',
    'border-positive',
    'text-heading',
    'text-primary',
    'text-strong',
  ])

  expect(css).toContain('.bg-bg')
  expect(css).toContain('background-color: var(--color-bg)')
  expect(css).toContain('.bg-surface-active')
  expect(css).toContain('background-color: var(--color-surface-active)')
  expect(css).toContain('.bg-surface-inset-hover')
  expect(css).toContain('background-color: var(--color-surface-inset-hover)')
  expect(css).toContain('.text-primary')
  expect(css).toContain('color: var(--color-text-primary)')
  expect(css).toContain('.text-heading')
  expect(css).toContain('color: var(--color-text-heading)')
  expect(css).toContain('.text-strong')
  expect(css).toContain('color: var(--color-text-strong)')
  expect(css).toContain('.border-base')
  expect(css).toContain('border-color: var(--color-border-base)')
  expect(css).toContain('.border-default')
  expect(css).toContain('border-color: var(--color-border)')
  expect(css).toContain('.border-positive')
  expect(css).toContain('border-color: var(--color-positive-border)')
  expect(css).toContain('color-mix(in oklab, var(--color-surface) 50%, transparent)')
})

test('shared stylesheet primitives consume semantic tokens', async () => {
  const css = await compileAppStyles([])

  expect(ruleFor(css, 'body')).toContain('background-color: var(--color-bg)')
  expect(ruleFor(css, 'body')).toContain('color: var(--color-text-primary)')
  expect(ruleFor(css, '.sidebar')).toContain('border-color: var(--color-border)')
  expect(ruleFor(css, '.sidebar')).toContain('background-color: var(--color-bg)')
  expect(ruleFor(css, '.topbar')).toContain('border-color: var(--color-border)')
  // bg-bg/95 — assert the alpha step so the match can't pass on --color-bg-elevated
  expect(ruleFor(css, '.topbar')).toContain('var(--color-bg) 95%')
  expect(ruleFor(css, '.page-title')).toContain('color: var(--color-text-heading)')
  expect(ruleFor(css, '.metric-card')).toContain('border-color: var(--color-border)')
  expect(ruleFor(css, '.metric-card')).toContain('background-color: var(--color-surface)')
  expect(ruleFor(css, '.surface-card')).toContain('border-color: var(--color-border)')
  expect(ruleFor(css, '.surface-card')).toContain('background-color: var(--color-surface)')
  expect(ruleFor(css, '.page-section-divider')).toContain('border-color: var(--color-border-subtle)')
  expect(ruleFor(css, '.sidebar-link')).toContain('background-color: var(--color-surface-inset-hover)')
  expect(ruleFor(css, '.sidebar-link-active')).toContain('background-color: var(--color-surface-active)')
})

test('neutral, tone, and info scale utilities compile through CSS variables', async () => {
  const css = await compileAppStyles([
    'bg-mono-800',
    'bg-mono-800/30',
    'ring-mono-500/60',
    'text-positive-400',
    'bg-caution-950/25',
    'border-negative-800',
    'bg-overlay-hover',
    'bg-overlay-scrim/70',
    'text-on-inverse',
    'text-on-emphasis',
    'text-link',
    'bg-negative-600',
    'bg-mono-200',
    'bg-mono-950/75',
    'placeholder-mono-600',
    'ring-offset-bg',
    'focus:border-mono-500',
    'border-caution-400/30',
    'bg-chart-series-2',
    'bg-info-500/10',
    'text-info-300',
  ])

  expect(css).toContain('.bg-mono-800')
  expect(css).toContain('background-color: var(--color-mono-800)')
  expect(css).toContain('.text-positive-400')
  expect(css).toContain('color: var(--color-positive-400)')
  expect(css).toContain('.border-negative-800')
  expect(css).toContain('border-color: var(--color-negative-800)')
  expect(css).toContain('.bg-overlay-hover')
  expect(css).toContain('background-color: var(--color-overlay-hover)')
  expect(css).toContain('.text-on-inverse')
  expect(css).toContain('color: var(--color-on-inverse)')
  expect(css).toContain('.text-on-emphasis')
  expect(css).toContain('color: var(--color-on-emphasis)')
  expect(css).toContain('--color-on-inverse: rgb(0 0 0)')
  expect(css).toContain('--color-on-emphasis: rgb(255 255 255)')
  expect(css).toContain('.text-link')
  expect(css).toContain('color: var(--color-link)')
  expect(css).toContain('.bg-negative-600')
  expect(css).toContain('background-color: var(--color-negative-600)')
  expect(css).toContain('.placeholder-mono-600')
  expect(css).toContain('color: var(--color-mono-600)')
  expect(css).toContain('.ring-offset-bg')
  expect(css).toContain('--tw-ring-offset-color: var(--color-bg)')
  expect(css).toContain('.bg-chart-series-2')
  expect(css).toContain('background-color: var(--color-chart-series-2)')
  expect(css).toContain('.text-info-300')
  expect(css).toContain('color: var(--color-info-300)')
  // opacity modifiers must resolve against the scale tokens (this is why the
  // one-off zinc/tone/sky alphas could migrate onto a single base token each)
  expect(css).toContain('color-mix(in oklab, var(--color-mono-800) 30%, transparent)')
  expect(css).toContain('color-mix(in oklab, var(--color-caution-950) 25%, transparent)')
  expect(css).toContain('color-mix(in oklab, var(--color-overlay-scrim) 70%, transparent)')
  expect(css).toContain('color-mix(in oklab, var(--color-mono-950) 75%, transparent)')
  // the chart tokens are emitted unconditionally from @theme (the chart bridge
  // consumes them in a later phase)
  expect(css).toContain('--chart-series-1: #34d399')
})

test('gauge, highlight, and effect primitives consume tokens', async () => {
  const css = await compileAppStyles([])

  // gauges/sparklines consume the CHART tone tokens (shared with ChartPrimitives,
  // Phase 4) so they can't drift from the charts
  expect(ruleFor(css, '.gauge-bg')).toContain('stroke: var(--chart-neutral-grid-line)')
  expect(ruleFor(css, '.gauge-fill-positive')).toContain('stroke: var(--chart-tone-positive)')
  expect(ruleFor(css, '.gauge-fill-neutral')).toContain('stroke: var(--chart-tone-neutral)')
  expect(ruleFor(css, '.answer-highlight-brand')).toContain('var(--color-positive-400)')
  expect(ruleFor(css, '.brand-icon')).toContain('var(--color-shadow-drop)')
  // both glow layers must be present — assert each distinctly so the outer-glow
  // match can't pass on the `-inset` occurrence
  expect(ruleFor(css, '.brand-update-bubble')).toContain('-10px var(--color-caution-glow),')
  expect(ruleFor(css, '.brand-update-bubble')).toContain('var(--color-caution-glow-inset)')
  // effect tokens consumed via raw properties in their real rules (not just the
  // standalone utility) — a literal regression in these rules must fail here
  expect(ruleFor(css, '.toast-card')).toContain('var(--color-shadow-panel)')
  expect(ruleFor(css, '.toast-action')).toContain('var(--color-overlay-hover)')
  expect(css).toContain('background: var(--color-scrollbar-thumb)')
  // the info (sky) accent — real consumers
  expect(ruleFor(css, '.opportunity-card-track')).toContain('var(--color-info-950)')
  expect(ruleFor(css, '.suggested-query-add')).toContain('var(--color-info-300)')
})

test('styles.css carries no literal palette utilities or raw hex outside the @theme block', async () => {
  // @theme token definitions legitimately reference the raw Tailwind palette
  // (var(--color-zinc-800)) and literal rgb()/hex; every rule OUTSIDE @theme
  // must resolve through a semantic/scale token. Strip the @theme blocks and CSS
  // comments, then assert the remaining source is clean. This is the guard that
  // keeps the "fully tokenized" invariant honest — a stray literal in any rule,
  // even one no positive assertion covers, fails here.
  const source = await readFile(stylesPath, 'utf8')
  const body = source
    .replace(/@theme\b[^{]*\{[\s\S]*?\n\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')

  const PALETTES = [
    'zinc', 'slate', 'gray', 'neutral', 'stone', 'red', 'orange', 'amber',
    'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue',
    'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
  ].join('|')
  const literalPaletteUtility = new RegExp(
    `\\b(?:bg|text|border|border-[lrtxy]|fill|stroke|ring|divide|decoration|outline|accent|caret|placeholder|from|via|to)-(?:${PALETTES})-\\d`,
    'g',
  )

  expect(body.match(literalPaletteUtility) ?? []).toEqual([])
  expect(body.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([])
  expect(body.match(/\brgba?\(/g) ?? []).toEqual([])
})
