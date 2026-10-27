import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { escapeRegExp } from '@canonry/canonry-contracts'
import { buttonVariants } from '../src/components/ui/button.js'
import { compileAppStyles, compiledDeclarations, parseCompiledCss } from './compiled-app-css.js'
import { expect, test } from 'vitest'

const stylesPath = resolve(import.meta.dirname, '../src/styles.css')
const mainPath = resolve(import.meta.dirname, '../src/main.tsx')
const appPath = resolve(import.meta.dirname, '../src/App.tsx')
const embedPath = resolve(import.meta.dirname, '../src/embed.ts')
const viteConfigPath = resolve(import.meta.dirname, '../vite.config.ts')

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

// The headline strip's frame lives in the stylesheet, not in a className, so a
// component test cannot see it: `.report-headline` reads the same whether the
// rule draws one bordered box with dividers or nothing at all. The tiles carry
// their own surface, and a partial revert that put the shared frame back would
// otherwise pass every suite.
test('the headline strip separates its tiles instead of sharing one frame', async () => {
  const css = await compileAppStyles([])
  const strip = ruleFor(css, '.report-headline')
  expect(strip).toContain('display: grid')
  expect(strip).toMatch(/gap:/)
  expect(strip).not.toMatch(/border|divide/)
  // `divide-*` compiles to a child rule, which never appears in the block above.
  expect(css).not.toMatch(/\.report-headline\s*>/)
  const tile = ruleFor(css, '.report-headline-tile')
  expect(tile).toContain('box-shadow: var(--shadow-material-base)')
  expect(tile).toContain('background-color: var(--color-bg)')
})

// Five collapsed rows end the AI Visibility tab, and they come from two
// components. They only read as one list while they resolve to one row style,
// which no component test can see.
test('every visibility detail row resolves to one collapsed row style', async () => {
  const css = await compileAppStyles([])
  const summary = ruleFor(css, '.visibility-disclosure-summary')
  expect(summary).toContain('cursor: pointer')
  expect(summary).toMatch(/min-height:/)
  expect(summary).toMatch(/padding/)
  expect(summary).toContain('&:focus-visible')
  expect(summary).toContain('--tw-ring-color: var(--color-mono-400)')
  expect(ruleFor(css, '.visibility-disclosure')).toMatch(/border-top/)
  expect(ruleFor(css, '.visibility-disclosure-meta')).toContain('color: var(--color-text-secondary)')
  // An opened panel pays its own bottom space and nothing else. The signals
  // panel used page-section rhythm in here, which opened the row on 32px of
  // margin, a stray divider and 24px of padding before its first line.
  const panel = ruleFor(css, '.visibility-disclosure-panel')
  expect(panel).toMatch(/padding-bottom:/)
  expect(panel).not.toMatch(/margin-top|border-top/)
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
  for (const selector of ['.metric-card', '.surface-card']) {
    expect(ruleFor(css, selector)).toContain('box-shadow: var(--shadow-material-base)')
    expect(ruleFor(css, selector)).toContain('background-color: var(--color-bg)')
  }
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
  expect(css).toContain('--color-on-inverse: var(--ds-background-100)')
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
  // Chart defaults remain available even without a corresponding utility.
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
  expect(ruleFor(css, '.toast-card')).toContain('var(--shadow-material-small)')
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
  expect(chip).toContain('font-size: 14px')
  expect(chip).toContain('&:focus-visible')
  expect(chip).toContain('--tw-ring-shadow:')
  expect(chipFocus).toContain('outline: 2px solid transparent')
  expect(chipFocus).toContain('outline-offset: 2px')
  expect(chipFocus).not.toContain('outline-style: none')
  expect(css).toContain('@media (forced-colors: active)')
  expect(css).toContain('outline-color: CanvasText')
})

test('component rules carry no literal palette utilities or raw colors', async () => {
  // Literal colors belong to token declarations. The guard spans every shared
  // component rule, so a new hardcoded value fails even without a positive case.
  const source = await readFile(stylesPath, 'utf8')
  const body = source
    .replace(/@theme\b[^{]*\{[\s\S]*?\n\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[\w-]+\s*:[^;]+;/g, '')

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

// CSS custom properties resolve at their defining element. Resolve each scope
// before inheriting it; flattening the raw declarations would miss stale aliases
// when an embedded theme differs from its host.
function computedTokens(local: Record<string, string>, inherited: Record<string, string> = {}) {
  const computed: Record<string, string> = { ...inherited }
  const resolving = new Set<string>()
  function resolveToken(name: string): string {
    if (!Object.hasOwn(local, name)) return inherited[name] ?? ''
    if (resolving.has(name)) throw new Error(`Circular CSS token: ${name}`)
    resolving.add(name)
    const value = local[name]!.replace(/var\((--[\w-]+)\)/g, (_match, dependency: string) => resolveToken(dependency))
    resolving.delete(name)
    return value
  }
  for (const name of Object.keys(local).filter(name => name.startsWith('--'))) computed[name] = resolveToken(name)
  return computed
}

function colorChannels(color: string): number[] {
  let rgb: number[]
  const hsl = color.match(/^hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%\)$/)
  if (hsl) {
    const hue = Number(hsl[1]) / 30, saturation = Number(hsl[2]) / 100, lightness = Number(hsl[3]) / 100
    const amplitude = saturation * Math.min(lightness, 1 - lightness)
    rgb = [0, 8, 4].map(offset => {
      const channel = (offset + hue) % 12
      return lightness - amplitude * Math.max(-1, Math.min(channel - 3, 9 - channel, 1))
    })
  } else if (/^#[\da-f]{6}$/i.test(color)) {
    rgb = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
  } else if (/^rgb\((?:[\d.]+ ){2}[\d.]+\)$/.test(color)) {
    rgb = color.slice(4, -1).split(' ').map(value => Number(value) / 255)
  } else {
    throw new Error(`Unsupported contrast color: ${color}`)
  }
  return rgb
}

function colorLuminance(color: string, background?: string): number {
  const mix = color.match(/^color-mix\(in oklab, (.+) ([\d.]+)%, transparent\)$/)
  let rgb: number[]
  if (mix && background) {
    // Mixing one color with transparent preserves its channels and changes
    // alpha. Composite it over the actual toast canvas before measuring text.
    const alpha = Number(mix[2]) / 100
    const canvas = colorChannels(background)
    rgb = colorChannels(mix[1]!).map((channel, index) => channel * alpha + canvas[index]! * (1 - alpha))
  } else {
    rgb = colorChannels(color)
  }
  const linear = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
}

function contrast(foreground: string, background: string): number {
  const values = [colorLuminance(foreground, background), colorLuminance(background)].sort((left, right) => right - left)
  return (values[0]! + 0.05) / (values[1]! + 0.05)
}

test('nested themes resolve their own surfaces, readable tone text, materials and chart/provider palettes', async () => {
  const actions = (['default', 'destructive'] as const).map(variant => ({
    variant, classes: buttonVariants({ variant }).split(/\s+/),
  }))
  const css = await compileAppStyles(actions.flatMap(action => action.classes))
  const rules = parseCompiledCss(css)
  // Supported color-mix declarations override their fallback in modern browsers.
  // The bounded parser retains that context but does not evaluate its cascade.
  const supportedDetailColor = rules
    .filter(rule => rule.selector === '.toast-detail' && rule.context.includes('@supports (color: color-mix(in lab, red, red))'))
    .flatMap(rule => rule.declarations)
    .filter(([property]) => property === 'color').at(-1)?.[1]
  const detailColor = supportedDetailColor ?? compiledDeclarations(rules, '.toast-detail').color!
  const root = computedTokens(compiledDeclarations(rules, ':root'))
  const boundary = compiledDeclarations(rules, '[data-theme]')
  const scope = (theme: 'light' | 'dark', parent: Record<string, string>) => computedTokens({
    ...compiledDeclarations(rules, `[data-theme='${theme}']`), ...boundary,
  }, parent)
  const light = scope('light', root), dark = scope('dark', light)

  expect(root['--color-bg']).toBe('hsl(0 0% 4%)')
  expect(light['--color-bg']).toBe('hsl(0 0% 100%)')
  expect(dark['--color-bg']).toBe(root['--color-bg'])
  for (const provider of ['gemini', 'openai', 'claude', 'perplexity', 'muse', 'local']) {
    for (const property of ['text', 'bg', 'border']) {
      const token = `--provider-${provider}-${property}`
      expect(light[token], `light ${provider} ${property}`).not.toBe(root[token])
      expect(dark[token], `nested dark ${provider} ${property}`).toBe(root[token])
    }
    expect(compiledDeclarations(rules, `.provider-badge--${provider}`)).toMatchObject({
      color: `var(--provider-${provider}-text)`, background: `var(--provider-${provider}-bg)`,
      'border-color': `var(--provider-${provider}-border)`,
    })
  }
  expect(light['--chart-series-2']).toBe('#3b82f6')
  expect(light['--color-chart-series-2']).toBe(light['--chart-series-2'])
  expect(dark['--chart-series-2']).toBe(root['--chart-series-2'])
  expect(dark['--color-chart-series-2']).toBe(root['--chart-series-2'])
  expect(light['--shadow-material-base']).toBe('0 0 0 1px #00000014, 0 0 0 1px hsl(0 0% 98%)')
  expect(dark['--shadow-material-base']).toBe('0 0 0 1px #ffffff25, 0 0 0 1px hsl(0 0% 0%)')
  for (const [name, tokens] of [['dark', dark], ['light', light]] as const) {
    for (const foreground of ['text-primary', 'text-secondary', 'text-faint', 'positive-400', 'caution-400', 'negative-400', 'info-400']) {
      expect(contrast(tokens[`--color-${foreground}`]!, tokens['--color-bg']!), `${name}: ${foreground}`).toBeGreaterThanOrEqual(4.5)
    }
    for (const tone of ['positive', 'caution', 'negative', 'neutral']) {
      expect(contrast(tokens[`--color-${tone}-text`]!, tokens[`--color-${tone}-bg-soft`]!), `${name}: ${tone} notice`).toBeGreaterThanOrEqual(4.5)
      const toast = compiledDeclarations(rules, `.toast-card-${tone}`)
      const resolveColor = (value: string) => value.replace(/var\((--[\w-]+)\)/g, (_match, token: string) => tokens[token]!)
      const inherited = resolveColor(toast.color!)
      const detail = resolveColor(detailColor).replace(/currentcolor/gi, inherited)
      expect(contrast(detail, resolveColor(toast['background-color']!)), `${name}: ${tone} toast detail`).toBeGreaterThanOrEqual(4.5)
    }
    for (const action of actions) {
      const background = (prefix: string) => {
        const candidate = action.classes.find(value => value.startsWith(prefix))!
        const selector = `.${candidate.replace(/([^\w-])/g, '\\$1')}`
        const declaration = ruleFor(css, selector).match(/background-color: ([^;]+);/)?.[1]
        if (!declaration) throw new Error(`Missing ${action.variant} ${prefix} background`)
        return declaration.replace(/var\((--[\w-]+)\)/g, (_match, token: string) => tokens[token]!)
      }
      const base = background('bg-'), hover = background('hover:bg-')
      const foreground = tokens[action.variant === 'default' ? '--color-on-inverse' : '--color-on-emphasis']!
      expect(hover, `${name}: ${action.variant} hover is visible`).not.toBe(base)
      for (const color of [base, hover]) {
        expect(contrast(foreground, color), `${name}: ${action.variant} action`).toBeGreaterThanOrEqual(4.5)
      }
    }
  }
})

// Independently sourced from vercel.com/geist/typography: the named roles are
// the public design contract. Compiling catches @apply/utility ordering and
// inherited line-height regressions that DOM text assertions cannot observe.
test('named Geist typography retains the published metrics and strong weights', async () => {
  const roles = [
    ['heading-72', 72, 72, 600, '-4.32px'], ['heading-64', 64, 64, 600, '-3.84px'],
    ['heading-56', 56, 56, 600, '-3.36px'], ['heading-48', 48, 56, 600, '-2.88px'],
    ['heading-40', 40, 48, 600, '-2.4px'], ['heading-32', 32, 40, 600, '-1.28px'],
    ['heading-24', 24, 32, 600, '-0.96px'], ['heading-20', 20, 26, 600, '-0.4px'],
    ['heading-16', 16, 24, 600, '-0.32px'], ['heading-14', 14, 20, 600, '-0.28px'],
    ['label-20', 20, 32, 400, 'normal'], ['label-18', 18, 20, 400, 'normal'],
    ['label-16', 16, 20, 400, 'normal'], ['label-14', 14, 20, 400, 'normal'],
    ['label-13', 13, 16, 400, 'normal'], ['label-12', 12, 16, 400, 'normal'],
    ['copy-24', 24, 36, 400, 'normal'], ['copy-20', 20, 36, 400, 'normal'],
    ['copy-18', 18, 28, 400, 'normal'], ['copy-16', 16, 24, 400, 'normal'],
    ['copy-14', 14, 20, 400, 'normal'], ['copy-13', 13, 18, 400, 'normal'],
    ['button-16', 16, 20, 500, 'normal'], ['button-14', 14, 20, 500, 'normal'],
    ['button-12', 12, 16, 500, 'normal'],
    ['label-13-mono', 13, 20, 400, 'normal'], ['copy-13-mono', 13, 18, 400, 'normal'],
    ['label-14-strong', 14, 20, 500, 'normal'], ['copy-14-strong', 14, 20, 550, 'normal'],
  ] as const
  const rules = parseCompiledCss(await compileAppStyles(roles.map(([role]) => `text-${role}`)))
  for (const [role, size, lineHeight, weight, tracking] of roles) {
    expect(compiledDeclarations(rules, `.text-${role}`), role).toMatchObject({
      'font-family': `var(--font-${role.includes('mono') ? 'mono' : 'sans'})`,
      'font-size': `${size}px`, 'line-height': `${lineHeight}px`,
      'font-weight': String(weight),
    })
    const actualTracking = compiledDeclarations(rules, `.text-${role}`)['letter-spacing']!
    if (tracking === 'normal') expect(actualTracking, role).toBe('normal')
    else expect(Number.parseFloat(actualTracking), role).toBe(Number.parseFloat(tracking))
  }
})

test('Geist materials keep their role radius, opaque fill and layered elevation', async () => {
  const roles = [['base', 6], ['small', 6], ['medium', 12], ['large', 12], ['tooltip', 6], ['menu', 12], ['modal', 12], ['fullscreen', 16]] as const
  const rules = parseCompiledCss(await compileAppStyles(roles.map(([role]) => `material-${role}`)))
  const root = computedTokens(compiledDeclarations(rules, ':root'))
  for (const [role, radius] of roles) {
    const material = compiledDeclarations(rules, `.material-${role}`)
    expect(material, role).toMatchObject({
      'background-color': 'var(--color-bg)', 'border-radius': `var(--radius-material-${role})`,
      'box-shadow': `var(--shadow-material-${role})`,
    })
    expect(root[`--radius-material-${role}`]).toBe(`${radius}px`)
  }
  expect(root['--shadow-material-menu']).toBe('0 0 0 1px #ffffff25, 0px 1px 1px #00000005, 0px 4px 8px -4px #0000000a, 0px 16px 24px -8px #0000000f, 0 0 0 1px hsl(0 0% 0%)')
  expect(root['--shadow-material-modal']).toBe('0 0 0 1px #ffffff25, 0px 1px 1px #00000005, 0px 8px 16px -4px #0000000a, 0px 24px 32px -8px #0000000f, 0 0 0 1px hsl(0 0% 0%)')
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

  for (const color of ['#56b4e9', '#e69f00', '#d55e00', '#a1a1aa', '#d4d4d8', '#9aa7b8']) {
    expect(contrast(color, '#18181b'), `${color} must remain visible on the dark graph`).toBeGreaterThanOrEqual(3)
  }
  for (const color of ['#0072b2', '#a86f00', '#b23a2b', '#52525b', '#3f3f46', '#4b5563']) {
    expect(contrast(color, '#ffffff'), `${color} must remain visible on the light graph`).toBeGreaterThanOrEqual(3)
  }
  expect(contrast('#71717a', '#18181b'), 'default links must remain visible on the dark graph').toBeGreaterThanOrEqual(3)
  expect(contrast('#71717a', '#ffffff'), 'default links must remain visible on the light graph').toBeGreaterThanOrEqual(3)
})
