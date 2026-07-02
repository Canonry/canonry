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

function ruleFor(css: string, selector: string) {
  const selectorStart = css.indexOf(`${selector} {`)
  if (selectorStart === -1) {
    throw new Error(`Could not find compiled rule for ${selector}`)
  }

  const openBrace = css.indexOf('{', selectorStart)
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
  expect(css).toContain('--chart-series-1: #34d399')
  expect(css).toContain('color-mix(in oklab, var(--color-surface) 50%, transparent)')
})

test('shared stylesheet primitives consume semantic tokens', async () => {
  const css = await compileAppStyles([])

  expect(ruleFor(css, 'body')).toContain('background-color: var(--color-bg)')
  expect(ruleFor(css, 'body')).toContain('color: var(--color-text-primary)')
  expect(ruleFor(css, '.sidebar')).toContain('border-color: var(--color-border)')
  expect(ruleFor(css, '.sidebar')).toContain('background-color: var(--color-bg)')
  expect(ruleFor(css, '.topbar')).toContain('border-color: var(--color-border)')
  expect(ruleFor(css, '.topbar')).toContain('var(--color-bg)')
  expect(ruleFor(css, '.page-title')).toContain('color: var(--color-text-heading)')
  expect(ruleFor(css, '.metric-card')).toContain('border-color: var(--color-border)')
  expect(ruleFor(css, '.metric-card')).toContain('background-color: var(--color-surface)')
  expect(ruleFor(css, '.surface-card')).toContain('border-color: var(--color-border)')
  expect(ruleFor(css, '.surface-card')).toContain('background-color: var(--color-surface)')
  expect(ruleFor(css, '.page-section-divider')).toContain('border-color: var(--color-border-subtle)')
  expect(ruleFor(css, '.sidebar-link')).toContain('background-color: var(--color-surface-inset-hover)')
})

test('neutral and tone scale utilities compile through CSS variables', async () => {
  const css = await compileAppStyles([
    'bg-mono-800',
    'bg-mono-800/30',
    'ring-mono-500/60',
    'text-positive-400',
    'bg-caution-950/25',
    'border-negative-800',
    'bg-overlay-hover',
  ])

  expect(css).toContain('.bg-mono-800')
  expect(css).toContain('background-color: var(--color-mono-800)')
  expect(css).toContain('.text-positive-400')
  expect(css).toContain('color: var(--color-positive-400)')
  expect(css).toContain('.border-negative-800')
  expect(css).toContain('border-color: var(--color-negative-800)')
  expect(css).toContain('.bg-overlay-hover')
  expect(css).toContain('background-color: var(--color-overlay-hover)')
  // opacity modifiers must resolve against the scale tokens (this is why the
  // one-off zinc/tone alphas could migrate onto a single base token each)
  expect(css).toContain('color-mix(in oklab, var(--color-mono-800) 30%, transparent)')
  expect(css).toContain('color-mix(in oklab, var(--color-caution-950) 25%, transparent)')
})

test('gauge, highlight, and effect primitives consume tokens', async () => {
  const css = await compileAppStyles([])

  expect(ruleFor(css, '.gauge-bg')).toContain('stroke: var(--color-track)')
  expect(ruleFor(css, '.gauge-fill-positive')).toContain('stroke: var(--color-positive-400)')
  expect(ruleFor(css, '.gauge-fill-neutral')).toContain('stroke: var(--color-mono-400)')
  expect(ruleFor(css, '.answer-highlight-brand')).toContain('var(--color-positive-400)')
  expect(ruleFor(css, '.brand-update-bubble')).toContain('var(--color-caution-glow)')
  expect(ruleFor(css, '.brand-icon')).toContain('var(--color-shadow-drop)')
})
