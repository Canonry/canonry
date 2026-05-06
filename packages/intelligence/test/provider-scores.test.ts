import { describe, expect, it } from 'vitest'
import {
  buildProviderScores,
  type ProviderScoreSnapshot,
} from '../src/provider-scores.js'

function snap(overrides: Partial<ProviderScoreSnapshot> = {}): ProviderScoreSnapshot {
  return {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    citationState: 'cited',
    ...overrides,
  }
}

describe('buildProviderScores', () => {
  it('returns empty for empty input', () => {
    expect(buildProviderScores([])).toEqual([])
  })

  it('groups by (provider, model) pair', () => {
    const snapshots = [
      snap({ provider: 'gemini', model: 'flash', citationState: 'cited' }),
      snap({ provider: 'gemini', model: 'flash', citationState: 'not-cited' }),
      snap({ provider: 'gemini', model: 'pro', citationState: 'cited' }),
    ]
    const result = buildProviderScores(snapshots)
    expect(result).toHaveLength(2)
    const flash = result.find(r => r.model === 'flash')!
    const pro = result.find(r => r.model === 'pro')!
    expect(flash.cited).toBe(1)
    expect(flash.total).toBe(2)
    expect(pro.cited).toBe(1)
    expect(pro.total).toBe(1)
  })

  it('rounds score to integer percent', () => {
    const snapshots = [
      snap({ citationState: 'cited' }),
      snap({ citationState: 'cited' }),
      snap({ citationState: 'not-cited' }),
    ]
    const result = buildProviderScores(snapshots)
    expect(result[0]?.score).toBe(67) // 2/3 = 67%
  })

  it('returns score 0 when no snapshots are cited', () => {
    const snapshots = [
      snap({ citationState: 'not-cited' }),
      snap({ citationState: 'not-cited' }),
    ]
    const result = buildProviderScores(snapshots)
    expect(result[0]?.score).toBe(0)
  })

  it('sorts by provider then model', () => {
    const snapshots = [
      snap({ provider: 'openai', model: 'gpt-4o' }),
      snap({ provider: 'claude', model: 'sonnet' }),
      snap({ provider: 'claude', model: 'haiku' }),
      snap({ provider: 'gemini', model: 'flash' }),
    ]
    const result = buildProviderScores(snapshots)
    expect(result.map(r => `${r.provider}/${r.model}`)).toEqual([
      'claude/haiku',
      'claude/sonnet',
      'gemini/flash',
      'openai/gpt-4o',
    ])
  })

  it('treats null model as a distinct group sortable to the start', () => {
    const snapshots = [
      snap({ provider: 'gemini', model: 'flash' }),
      snap({ provider: 'gemini', model: null }),
    ]
    const result = buildProviderScores(snapshots)
    expect(result.map(r => r.model)).toEqual([null, 'flash'])
  })

  it('ignores unknown citationState values (treated as not-cited)', () => {
    const snapshots = [
      snap({ citationState: 'pending' }),
      snap({ citationState: 'unknown' }),
    ]
    const result = buildProviderScores(snapshots)
    expect(result[0]?.cited).toBe(0)
    expect(result[0]?.total).toBe(2)
  })
})
