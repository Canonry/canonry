import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'

import { InfoTooltip } from '../src/components/shared/InfoTooltip.js'
import { Button } from '../src/components/ui/button.js'
import { Card, CardTitle } from '../src/components/ui/card.js'
import { cn } from '../src/lib/utils.js'
import { compileAppStyles, compiledElementProperty, parseCompiledCss } from './compiled-app-css.js'

afterEach(cleanup)

test('component composition preserves typography independently from semantic color', async () => {
  render(<Card><CardTitle>Saved evidence</CardTitle><Button size="sm" className="text-negative">Delete query</Button></Card>)
  const title = screen.getByRole('heading', { name: 'Saved evidence' })
  const button = screen.getByRole('button', { name: 'Delete query' })
  const rules = parseCompiledCss(await compileAppStyles([...title.classList, ...button.classList]))
  expect(compiledElementProperty(rules, title, 'font-size')).toBe('16px')
  expect(compiledElementProperty(rules, title, 'font-weight')).toBe('600')
  expect(compiledElementProperty(rules, button, 'font-size')).toBe('14px')
  expect(compiledElementProperty(rules, button, 'font-weight')).toBe('500')
  expect(compiledElementProperty(rules, button, 'color')).toBe('var(--color-negative-text)')
})

test.each([
  ['text-label-13 text-secondary', 'text-copy-14 text-primary', 'text-copy-14 text-primary'],
  ['text-sm font-bold leading-8 tracking-wide', 'text-heading-16 text-heading', 'text-heading-16 text-heading'],
  ['text-label-13 text-secondary', 'text-label-13-mono-strong text-primary', 'text-label-13-mono-strong text-primary'],
  ['text-copy-14 text-secondary', 'text-copy-14-mono-strong text-primary', 'text-copy-14-mono-strong text-primary'],
  ['material-base p-4', 'material-menu', 'p-4 material-menu'],
  ['rounded-xl border border-base bg-bg shadow-xl', 'material-tooltip', 'material-tooltip'],
])('later design roles replace conflicting styling: %s', (base, next, expected) => {
  expect(cn(base, next)).toBe(expected)
})

test.each(['top', 'bottom'] as const)('help retains its embed theme scope when opened at %s', placement => {
  const text = 'Citations count source links separately from brand mentions.'
  render(<section className="app-shell-embed" data-theme="light" aria-label="Embedded report"><InfoTooltip text={text} placement={placement} /></section>)
  fireEvent.focus(screen.getByRole('button', { name: text }))
  const embeddedReport = screen.getByRole('region', { name: 'Embedded report' })
  expect(within(embeddedReport).getByText(text).closest('[data-theme]')).toBe(embeddedReport)
  fireEvent.keyDown(screen.getByRole('button', { name: text }), { key: 'Escape' })
  expect(screen.queryByText(text)).toBeNull()
})
