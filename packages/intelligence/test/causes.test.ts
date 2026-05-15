import { describe, it, expect } from 'vitest'
import { analyzeCause } from '../src/causes.js'
import type { Regression, Snapshot } from '../src/types.js'

function makeRegression(overrides?: Partial<Regression>): Regression {
  return {
    query: 'roof repair phoenix',
    provider: 'chatgpt',
    previousCitationUrl: 'https://example.com/roof',
    previousPosition: 2,
    currentRunId: 'run_002',
    previousRunId: 'run_001',
    ...overrides,
  }
}

describe('analyzeCause', () => {
  it('identifies competitor_gain when a competitor domain appeared in the lost snapshot', () => {
    const reg = makeRegression()
    const snapshots: Snapshot[] = [
      { query: 'roof repair phoenix', provider: 'chatgpt', cited: false, competitorDomains: ['roofco.com'] },
    ]

    const result = analyzeCause(reg, snapshots)
    expect(result.cause).toBe('competitor_gain')
    expect(result.competitorDomain).toBe('roofco.com')
    expect(result.details).toContain('roofco.com')
    expect(result.details).toContain('roof repair phoenix')
    expect(result.details).toContain('chatgpt')
  })

  it('returns unknown when no competitor or third-party domain is present', () => {
    const reg = makeRegression()
    const snapshots: Snapshot[] = [
      { query: 'roof repair phoenix', provider: 'chatgpt', cited: false },
    ]

    const result = analyzeCause(reg, snapshots)
    expect(result.cause).toBe('unknown')
    expect(result.competitorDomain).toBeUndefined()
  })

  it('identifies third_party_displacement when no tracked competitor is in the snapshot but the engine cited other domains', () => {
    // The May 2026 azcoatings case: openai stopped citing the project for
    // "polyurea roof coating michigan" and grounded on michigan.gov + gaf.com
    // instead. Neither was in the configured competitor list, so the old
    // detector returned `cause: unknown` and the recommendation was the
    // useless "audit yourself, position unknown."
    const reg = makeRegression()
    const snapshots: Snapshot[] = [
      {
        query: 'roof repair phoenix',
        provider: 'chatgpt',
        cited: false,
        competitorDomains: [],
        citedDomains: ['phoenix.gov', 'angi.com', 'somebody-else.com'],
      },
    ]

    const result = analyzeCause(reg, snapshots)
    expect(result.cause).toBe('third_party_displacement')
    expect(result.competitorDomain).toBeUndefined()
    expect(result.details).toContain('phoenix.gov')
    expect(result.details).toContain('angi.com')
    expect(result.details).toContain('roof repair phoenix')
    expect(result.details).toContain('chatgpt')
  })

  it('prefers competitor_gain over third_party_displacement when both are present', () => {
    const reg = makeRegression()
    const snapshots: Snapshot[] = [
      {
        query: 'roof repair phoenix',
        provider: 'chatgpt',
        cited: false,
        competitorDomains: ['rival.com'],
        citedDomains: ['rival.com', 'phoenix.gov'],
      },
    ]

    const result = analyzeCause(reg, snapshots)
    expect(result.cause).toBe('competitor_gain')
    expect(result.competitorDomain).toBe('rival.com')
  })

  it('caps third_party_displacement detail at the top 3 displacing domains', () => {
    const reg = makeRegression()
    const snapshots: Snapshot[] = [
      {
        query: 'roof repair phoenix',
        provider: 'chatgpt',
        cited: false,
        citedDomains: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com'],
      },
    ]

    const result = analyzeCause(reg, snapshots)
    expect(result.cause).toBe('third_party_displacement')
    expect(result.details).toContain('a.com')
    expect(result.details).toContain('b.com')
    expect(result.details).toContain('c.com')
    expect(result.details).not.toContain('d.com')
    expect(result.details).not.toContain('e.com')
  })

  it('returns unknown when snapshots array is empty', () => {
    const result = analyzeCause(makeRegression(), [])
    expect(result.cause).toBe('unknown')
  })

  it('ignores snapshots for different queries', () => {
    const reg = makeRegression({ query: 'roof repair phoenix' })
    const snapshots: Snapshot[] = [
      { query: 'different query', provider: 'chatgpt', cited: false, competitorDomains: ['rival.com'] },
    ]

    const result = analyzeCause(reg, snapshots)
    expect(result.cause).toBe('unknown')
  })

  it('ignores snapshots for different providers', () => {
    const reg = makeRegression({ provider: 'chatgpt' })
    const snapshots: Snapshot[] = [
      { query: 'roof repair phoenix', provider: 'gemini', cited: false, competitorDomains: ['rival.com'] },
    ]

    const result = analyzeCause(reg, snapshots)
    expect(result.cause).toBe('unknown')
  })

  it('ignores snapshots where cited is true (competitor domain on a cited snapshot is irrelevant)', () => {
    const reg = makeRegression()
    const snapshots: Snapshot[] = [
      { query: 'roof repair phoenix', provider: 'chatgpt', cited: true, competitorDomains: ['rival.com'] },
    ]

    const result = analyzeCause(reg, snapshots)
    expect(result.cause).toBe('unknown')
  })

  it('picks the first matching snapshot when multiple competitors exist', () => {
    const reg = makeRegression()
    const snapshots: Snapshot[] = [
      { query: 'roof repair phoenix', provider: 'chatgpt', cited: false, competitorDomains: ['first-rival.com'] },
      { query: 'roof repair phoenix', provider: 'chatgpt', cited: false, competitorDomains: ['second-rival.com'] },
    ]

    const result = analyzeCause(reg, snapshots)
    expect(result.cause).toBe('competitor_gain')
    expect(result.competitorDomain).toBe('first-rival.com')
  })

  it('picks the first competitor when a single snapshot has multiple', () => {
    const reg = makeRegression()
    const snapshots: Snapshot[] = [
      {
        query: 'roof repair phoenix',
        provider: 'chatgpt',
        cited: false,
        competitorDomains: ['first-rival.com', 'second-rival.com'],
      },
    ]

    const result = analyzeCause(reg, snapshots)
    expect(result.cause).toBe('competitor_gain')
    expect(result.competitorDomain).toBe('first-rival.com')
  })

  it('analyzes different regressions independently', () => {
    const snapshots: Snapshot[] = [
      { query: 'k1', provider: 'chatgpt', cited: false, competitorDomains: ['rival-a.com'] },
      { query: 'k2', provider: 'gemini', cited: false },
    ]

    const r1 = analyzeCause(makeRegression({ query: 'k1', provider: 'chatgpt' }), snapshots)
    const r2 = analyzeCause(makeRegression({ query: 'k2', provider: 'gemini' }), snapshots)

    expect(r1.cause).toBe('competitor_gain')
    expect(r1.competitorDomain).toBe('rival-a.com')
    expect(r2.cause).toBe('unknown')
  })
})
