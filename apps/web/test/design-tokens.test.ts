import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { compile } from 'tailwindcss'
import { expect, test } from 'vitest'

const stylesPath = resolve(import.meta.dirname, '../src/styles.css')
const mainPath = resolve(import.meta.dirname, '../src/main.tsx')
const appPath = resolve(import.meta.dirname, '../src/App.tsx')
const embedPath = resolve(import.meta.dirname, '../src/embed.ts')
const viteConfigPath = resolve(import.meta.dirname, '../vite.config.ts')
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

test('scope picker panels compile outside document flow with an opaque surface', async () => {
  const css = await compileAppStyles([])
  const panel = ruleFor(css, '.visibility-scope-menu')
  expect(panel).toContain('position: absolute')
  expect(panel).toContain('top: 100%')
  expect(panel).toContain('z-index: 30')
  expect(panel).toContain('background-color: var(--color-bg)')
})

test('measurement table actions stay visible on an opaque surface while columns scroll', async () => {
  const css = await compileAppStyles([])
  const actions = ruleFor(css, '.measurement-table-actions')
  expect(actions).toContain('position: sticky')
  expect(actions).toContain('right: 0')
  expect(actions).toContain('background-color: var(--color-bg)')
  expect(actions).toContain('white-space: nowrap')
  expect(actions).toContain('z-index: 1')
  expect(ruleFor(css, '.query-tracking-workspace')).toContain('container-type: inline-size')
  expect(ruleFor(css, '.tracking-row-actions')).toContain('flex-direction: column')
  expect(ruleFor(css, '.tracking-row-actions')).toContain('align-items: flex-start')
})

test('self-hosts the default Geist families and never loads Google Fonts', async () => {
  const [main, styles, app, embed, viteConfig] = await Promise.all([
    readFile(mainPath, 'utf8'),
    readFile(stylesPath, 'utf8'),
    readFile(appPath, 'utf8'),
    readFile(embedPath, 'utf8'),
    readFile(viteConfigPath, 'utf8'),
  ])

  expect(main).toContain("import '@fontsource-variable/geist/wght.css'")
  expect(main).toContain("import '@fontsource-variable/geist-mono/wght.css'")
  expect([main, styles, app, embed].join('\n')).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/)
  expect(styles).toContain('--font-sans: "Geist Variable"')
  expect(styles).toContain('--font-mono: "Geist Mono Variable"')
  expect(viteConfig).toContain("fileName: 'THIRD_PARTY_NOTICES.md'")
})

test('reduced motion disables global smooth scrolling', async () => {
  const styles = await readFile(stylesPath, 'utf8')

  expect(styles).toMatch(
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*html\s*\{\s*scroll-behavior:\s*auto;\s*\}/,
  )
})

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
    'border-info-800/40',
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
  expect(css).toContain('color-mix(in oklab, var(--color-info-800) 40%, transparent)')
  // the chart tokens are emitted unconditionally from @theme (the chart bridge
  // consumes them in a later phase)
  expect(css).toContain('--chart-series-1: #34d399')
  expect(css).toContain('--chart-neutral-track-subtle: rgb(255 255 255 / 0.04)')
})

test('highlight and effect primitives consume tokens', async () => {
  const css = await compileAppStyles([])

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
})

test('update notification fits the sidebar and wraps long version strings', async () => {
  const css = await compileAppStyles([])

  expect(ruleFor(css, '.brand-lockup-wrapper')).toContain('max-width: 100%')
  expect(ruleFor(css, '.brand-update-bubble')).toContain('grid-column: span 2 / span 2')
  expect(ruleFor(css, '.brand-update-bubble')).toContain('width: 100%')
  expect(ruleFor(css, '.brand-update-bubble-link')).toContain('flex-wrap: wrap')
  expect(ruleFor(css, '.brand-update-bubble-from')).toContain('overflow-wrap: anywhere')
  expect(ruleFor(css, '.brand-update-bubble-to')).toContain('overflow-wrap: anywhere')
})

test('filter chips preserve a 44px touch target and visible keyboard focus', async () => {
  const css = await compileAppStyles([])
  const chip = ruleFor(css, '.filter-chip')
  const chipFocus = ruleFor(css, '.filter-chip:focus-visible')

  expect(chip).toContain('min-height: calc(var(--spacing) * 11)')
  expect(chip).toContain('font-size: var(--text-sm)')
  expect(chip).toContain('&:focus-visible')
  expect(chip).toContain('--tw-ring-shadow:')
  expect(chipFocus).toContain('outline: 2px solid transparent')
  expect(chipFocus).toContain('outline-offset: 2px')
  expect(chipFocus).not.toContain('outline-style: none')
  expect(css).toContain('@media (forced-colors: active)')
  expect(css).toContain('outline-color: CanvasText')
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

test('the light theme deepens the tone-scale foreground steps (no bright tone text on white)', async () => {
  const source = await readFile(stylesPath, 'utf8')
  // The main [data-theme='light'] token block (not the .provider-badge-- rules).
  const light = source.match(/\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  expect(light, 'light theme block not found').not.toBe('')
  // Tone SCALE steps used as bright foreground text on the dark canvas must be
  // re-pointed to dark inks so they stay AA-legible on the light canvas
  // (regression guard for the invisible tone-colored text the review caught).
  for (const decl of [
    '--color-positive-400: var(--color-emerald-700)',
    '--color-caution-400: var(--color-amber-700)',
    '--color-negative-400: var(--color-rose-700)',
    '--color-info-400: var(--color-sky-700)',
    '--color-info-100: var(--color-sky-800)',
    '--color-caution-100: var(--color-amber-800)',
  ]) {
    expect(light, `light theme must re-point "${decl}"`).toContain(decl)
  }
})

test('the light theme gives visibility chart titles a semantic text color', async () => {
  const css = await compileAppStyles([])
  const rule = ruleFor(css, "[data-theme='light'] .visibility-trend-title")

  expect(rule).toContain('color: var(--color-text-heading)')
})

test('Site Health uses a color-vision-safe graph palette in both themes', async () => {
  const source = await readFile(stylesPath, 'utf8')
  const light = source.match(/\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''

  for (const declaration of [
    '--chart-site-health-eligible: #56b4e9',
    '--chart-site-health-hidden: #e69f00',
    '--chart-site-health-failed: #d55e00',
    '--chart-site-health-unchecked: #a1a1aa',
    '--chart-site-health-resource: #d4d4d8',
    '--chart-site-health-redirect: #9aa7b8',
  ]) {
    expect(source, `dark graph palette must contain "${declaration}"`).toContain(declaration)
  }

  for (const declaration of [
    '--chart-site-health-eligible: #0072b2',
    '--chart-site-health-hidden: #a86f00',
    '--chart-site-health-failed: #b23a2b',
    '--chart-site-health-unchecked: #52525b',
    '--chart-site-health-resource: #3f3f46',
    '--chart-site-health-redirect: #4b5563',
  ]) {
    expect(light, `light graph palette must contain "${declaration}"`).toContain(declaration)
  }

  const channel = (hex: string, offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
  const luminance = (hex: string) => {
    const linear = [channel(hex, 1), channel(hex, 3), channel(hex, 5)].map((value) => (
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    ))
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
  }
  const contrast = (foreground: string, background: string) => {
    const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left)
    return (values[0]! + 0.05) / (values[1]! + 0.05)
  }

  for (const color of ['#56b4e9', '#e69f00', '#d55e00', '#a1a1aa', '#d4d4d8', '#9aa7b8']) {
    expect(contrast(color, '#18181b'), `${color} must remain visible on the dark graph`).toBeGreaterThanOrEqual(3)
  }
  for (const color of ['#0072b2', '#a86f00', '#b23a2b', '#52525b', '#3f3f46', '#4b5563']) {
    expect(contrast(color, '#ffffff'), `${color} must remain visible on the light graph`).toBeGreaterThanOrEqual(3)
  }
  expect(contrast('#71717a', '#18181b'), 'default links must remain visible on the dark graph').toBeGreaterThanOrEqual(3)
  expect(contrast('#71717a', '#ffffff'), 'default links must remain visible on the light graph').toBeGreaterThanOrEqual(3)
})
