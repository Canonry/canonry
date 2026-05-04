import { describe, expect, test } from 'vitest'
import { groupInsights, type GroupedInsight } from '../src/insight-grouping.js'
import type { Insight } from '../src/types.js'

function makeInsight(overrides: Partial<Insight> & {
  keyword: string
  provider: string
  type: Insight['type']
  createdAt: string
}): Insight {
  return {
    id: `ins_${overrides.keyword}_${overrides.provider}_${overrides.createdAt}`,
    title: `${overrides.type} for ${overrides.keyword}`,
    severity: 'low',
    ...overrides,
  }
}

describe('groupInsights', () => {
  test('returns empty array for empty input', () => {
    expect(groupInsights([])).toEqual([])
  })

  test('collapses insights with same (keyword, provider, type) into one group', () => {
    const insights = [
      makeInsight({ keyword: 'k1', provider: 'gemini', type: 'gain', createdAt: '2026-01-01T00:00:00Z' }),
      makeInsight({ keyword: 'k1', provider: 'gemini', type: 'gain', createdAt: '2026-01-02T00:00:00Z' }),
      makeInsight({ keyword: 'k1', provider: 'gemini', type: 'gain', createdAt: '2026-01-03T00:00:00Z' }),
    ]
    const groups = groupInsights(insights)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.count).toBe(3)
    expect(groups[0]!.instances).toHaveLength(3)
  })

  test('representative is the most-recent insight in each group', () => {
    const insights = [
      makeInsight({ keyword: 'k1', provider: 'gemini', type: 'gain', createdAt: '2026-01-01T00:00:00Z', title: 'old' }),
      makeInsight({ keyword: 'k1', provider: 'gemini', type: 'gain', createdAt: '2026-01-03T00:00:00Z', title: 'newest' }),
      makeInsight({ keyword: 'k1', provider: 'gemini', type: 'gain', createdAt: '2026-01-02T00:00:00Z', title: 'middle' }),
    ]
    const [group] = groupInsights(insights)
    expect(group!.representative.title).toBe('newest')
  })

  test('keeps separate groups for different keyword / provider / type tuples', () => {
    const insights = [
      makeInsight({ keyword: 'k1', provider: 'gemini', type: 'gain', createdAt: '2026-01-01T00:00:00Z' }),
      makeInsight({ keyword: 'k2', provider: 'gemini', type: 'gain', createdAt: '2026-01-01T00:00:00Z' }),
      makeInsight({ keyword: 'k1', provider: 'openai', type: 'gain', createdAt: '2026-01-01T00:00:00Z' }),
      makeInsight({ keyword: 'k1', provider: 'gemini', type: 'regression', createdAt: '2026-01-01T00:00:00Z' }),
    ]
    const groups = groupInsights(insights)
    expect(groups).toHaveLength(4)
    for (const g of groups) expect(g.count).toBe(1)
  })

  test('preserves the input order of first-seen group keys', () => {
    const insights = [
      makeInsight({ keyword: 'b', provider: 'gemini', type: 'gain', createdAt: '2026-01-01T00:00:00Z' }),
      makeInsight({ keyword: 'a', provider: 'gemini', type: 'gain', createdAt: '2026-01-01T00:00:00Z' }),
      makeInsight({ keyword: 'b', provider: 'gemini', type: 'gain', createdAt: '2026-01-02T00:00:00Z' }),
    ]
    const groups = groupInsights(insights)
    expect(groups.map((g: GroupedInsight) => g.representative.keyword)).toEqual(['b', 'a'])
  })

  test('accepts a custom key function', () => {
    const insights = [
      makeInsight({ keyword: 'k1', provider: 'gemini', type: 'gain', createdAt: '2026-01-01T00:00:00Z' }),
      makeInsight({ keyword: 'k2', provider: 'gemini', type: 'gain', createdAt: '2026-01-01T00:00:00Z' }),
    ]
    // Group by provider only — should collapse both into one group of 2
    const groups = groupInsights(insights, (i) => i.provider)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.count).toBe(2)
  })
})
