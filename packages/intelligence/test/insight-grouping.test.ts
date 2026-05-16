import { describe, expect, test } from 'vitest'
import { groupInsights, type GroupedInsight } from '../src/insight-grouping.js'
import type { Insight } from '../src/types.js'

function makeInsight(overrides: Partial<Insight> & {
  query: string
  provider: string
  type: Insight['type']
  createdAt: string
}): Insight {
  return {
    id: `ins_${overrides.query}_${overrides.provider}_${overrides.createdAt}`,
    title: `${overrides.type} for ${overrides.query}`,
    severity: 'low',
    ...overrides,
  }
}

describe('groupInsights', () => {
  test('returns empty array for empty input', () => {
    expect(groupInsights([])).toEqual([])
  })

  test('collapses insights with same (query, provider, type) into one group', () => {
    const insights = [
      makeInsight({ query: 'k1', provider: 'gemini', type: 'gain', createdAt: '2026-01-01T00:00:00Z' }),
      makeInsight({ query: 'k1', provider: 'gemini', type: 'gain', createdAt: '2026-01-02T00:00:00Z' }),
      makeInsight({ query: 'k1', provider: 'gemini', type: 'gain', createdAt: '2026-01-03T00:00:00Z' }),
    ]
    const groups = groupInsights(insights)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.count).toBe(3)
    expect(groups[0]!.instances).toHaveLength(3)
  })

  test('representative is the most-recent insight in each group', () => {
    const insights = [
      makeInsight({ query: 'k1', provider: 'gemini', type: 'gain', createdAt: '2026-01-01T00:00:00Z', title: 'old' }),
      makeInsight({ query: 'k1', provider: 'gemini', type: 'gain', createdAt: '2026-01-03T00:00:00Z', title: 'newest' }),
      makeInsight({ query: 'k1', provider: 'gemini', type: 'gain', createdAt: '2026-01-02T00:00:00Z', title: 'middle' }),
    ]
    const [group] = groupInsights(insights)
    expect(group!.representative.title).toBe('newest')
  })

  test('keeps separate groups for different query / provider / type tuples', () => {
    const insights = [
      makeInsight({ query: 'k1', provider: 'gemini', type: 'gain', createdAt: '2026-01-01T00:00:00Z' }),
      makeInsight({ query: 'k2', provider: 'gemini', type: 'gain', createdAt: '2026-01-01T00:00:00Z' }),
      makeInsight({ query: 'k1', provider: 'openai', type: 'gain', createdAt: '2026-01-01T00:00:00Z' }),
      makeInsight({ query: 'k1', provider: 'gemini', type: 'regression', createdAt: '2026-01-01T00:00:00Z' }),
    ]
    const groups = groupInsights(insights)
    expect(groups).toHaveLength(4)
    for (const g of groups) expect(g.count).toBe(1)
  })

  test('preserves the input order of first-seen group keys', () => {
    const insights = [
      makeInsight({ query: 'b', provider: 'gemini', type: 'gain', createdAt: '2026-01-01T00:00:00Z' }),
      makeInsight({ query: 'a', provider: 'gemini', type: 'gain', createdAt: '2026-01-01T00:00:00Z' }),
      makeInsight({ query: 'b', provider: 'gemini', type: 'gain', createdAt: '2026-01-02T00:00:00Z' }),
    ]
    const groups = groupInsights(insights)
    expect(groups.map((g: GroupedInsight) => g.representative.query)).toEqual(['b', 'a'])
  })

  test('accepts a custom key function', () => {
    const insights = [
      makeInsight({ query: 'k1', provider: 'gemini', type: 'gain', createdAt: '2026-01-01T00:00:00Z' }),
      makeInsight({ query: 'k2', provider: 'gemini', type: 'gain', createdAt: '2026-01-01T00:00:00Z' }),
    ]
    // Group by provider only — should collapse both into one group of 2
    const groups = groupInsights(insights, (i) => i.provider)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.count).toBe(2)
  })

  test('does not collide when field boundaries fall on whitespace', () => {
    // Tracked queries almost always contain spaces ("HVAC lead generation",
    // "best polyurea roof coating"). If the dedup key is built by joining
    // (query, provider, type) with a space, two genuinely different inputs
    // can produce the same key — and two distinct insights silently merge
    // into a single row. The pair below produces identical concat strings
    // under a space-joined key.
    const insights = [
      makeInsight({ query: 'HVAC lead', provider: 'openai', type: 'gain', createdAt: '2026-01-01T00:00:00Z', title: 'A' }),
      makeInsight({ query: 'HVAC', provider: 'lead openai', type: 'gain', createdAt: '2026-01-01T00:00:00Z', title: 'B' }),
    ]
    const groups = groupInsights(insights)
    expect(groups).toHaveLength(2)
    const titles = groups.map(g => g.representative.title).sort()
    expect(titles).toEqual(['A', 'B'])
  })

  test('does not collide when boundary tokens are reshuffled across fields', () => {
    // Same total tokens, different field assignment. With a space-joined
    // key, both produce "best HVAC openai gain" — distinct insights merge.
    const insights = [
      makeInsight({ query: 'best HVAC openai', provider: 'gain', type: 'gain', createdAt: '2026-01-01T00:00:00Z', title: 'A' }),
      makeInsight({ query: 'best HVAC', provider: 'openai gain', type: 'gain', createdAt: '2026-01-01T00:00:00Z', title: 'B' }),
    ]
    const groups = groupInsights(insights)
    expect(groups).toHaveLength(2)
  })
})
