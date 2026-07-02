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

test('semantic color utilities compile to runtime-overridable CSS variables', async () => {
  const css = await compileAppStyles([
    'bg-bg',
    'bg-surface/50',
    'border-default',
    'border-positive',
    'text-primary',
  ])

  expect(css).toContain('.bg-bg')
  expect(css).toContain('background-color: var(--color-bg)')
  expect(css).toContain('.text-primary')
  expect(css).toContain('color: var(--color-text-primary)')
  expect(css).toContain('.border-default')
  expect(css).toContain('border-color: var(--color-border)')
  expect(css).toContain('.border-positive')
  expect(css).toContain('border-color: var(--color-positive-border)')
  expect(css).toContain('--chart-series-1: #34d399')
  expect(css).toContain('color-mix(in oklab, var(--color-surface) 50%, transparent)')
})
