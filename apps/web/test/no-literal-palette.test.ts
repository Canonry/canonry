import { describe, expect, it } from 'vitest'
import { RAW_PALETTE_SOURCE } from '../../../eslint-rules/no-literal-palette.js'

/**
 * Locks the design-token ratchet regex (engine issue #767, Phase 3). This is the
 * whole value of the `design-tokens/no-literal-palette` ESLint rule: if the
 * pattern is wrong, the gate is wrong. Assert it flags every raw-palette form in
 * use and, critically, does NOT flag the token scales / semantic tokens.
 */
const re = () => new RegExp(RAW_PALETTE_SOURCE)

describe('RAW_PALETTE_SOURCE', () => {
  it('flags the raw Tailwind palette utilities the migration removes', () => {
    for (const cls of [
      'bg-zinc-950',
      'text-zinc-400',
      'text-emerald-400',
      'border-rose-500/25',
      'bg-amber-500/10',
      'ring-zinc-500',
      'fill-sky-400',
      'placeholder-zinc-600',
      'divide-zinc-800',
      'decoration-blue-400',
      'from-emerald-500',
    ]) {
      expect(re().test(cls), cls).toBe(true)
    }
  })

  it('flags a variant-prefixed utility (hover:, dark:, sm:)', () => {
    expect(re().test('hover:bg-zinc-900')).toBe(true)
    expect(re().test('sm:text-rose-300')).toBe(true)
    expect(re().test('flex items-center bg-zinc-900/30 text-zinc-50')).toBe(true)
  })

  it('flags directional / logical border colors (the latent hole this closes)', () => {
    expect(re().test('border-t-zinc-800')).toBe(true)
    expect(re().test('border-l-rose-500')).toBe(true)
    expect(re().test('border-s-amber-400')).toBe(true)
    expect(re().test('border-x-zinc-800/60')).toBe(true)
  })

  it('does NOT flag the design tokens (the whole point of the migration)', () => {
    for (const cls of [
      'bg-surface',
      'bg-surface-subtle',
      'bg-surface-hover',
      'bg-bg-elevated/40',
      'border-default',
      'border-strong',
      'text-primary',
      'text-secondary',
      'text-muted',
      'text-faint',
      'text-mono-500',
      'bg-mono-800/30',
      'text-positive-400',
      'border-caution-500/25',
      'bg-negative-950/25',
      'text-info-400',
      'placeholder-mono-600',
    ]) {
      expect(re().test(cls), cls).toBe(false)
    }
  })

  it('does NOT flag non-color utilities that merely contain a number', () => {
    for (const cls of ['border-t-2', 'ring-offset-2', 'gap-500', 'w-500', 'z-500', 'divide-x-2']) {
      expect(re().test(cls), cls).toBe(false)
    }
  })
})
