import { describe, it, expect } from 'vitest'
import { analyzeCause } from '../src/causes.js'
import type { Regression, Snapshot } from '../src/types.js'

function makeRegression(overrides?: Partial<Regression>): Regression {
  return {
    keyword: 'roof repair phoenix',
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
      { keyword: 'roof repair phoenix', provider: 'chatgpt', cited: false, competitorDomain: 'roofco.com' },
    ]

    const result = analyzeCause(reg, snapshots)
    expect(result.cause).toBe('competitor_gain')
    expect(result.competitorDomain).toBe('roofco.com')
    expect(result.details).toContain('roofco.com')
    expect(result.details).toContain('roof repair phoenix')
    expect(result.details).toContain('chatgpt')
  })

  it('returns unknown when no competitor domain is present', () => {
    const reg = makeRegression()
    const snapshots: Snapshot[] = [
      { keyword: 'roof repair phoenix', provider: 'chatgpt', cited: false },
    ]

    const result = analyzeCause(reg, snapshots)
    expect(result.cause).toBe('unknown')
    expect(result.competitorDomain).toBeUndefined()
  })

  it('returns unknown when snapshots array is empty', () => {
    const result = analyzeCause(makeRegression(), [])
    expect(result.cause).toBe('unknown')
  })

  it('ignores snapshots for different keywords', () => {
    const reg = makeRegression({ keyword: 'roof repair phoenix' })
    const snapshots: Snapshot[] = [
      { keyword: 'different keyword', provider: 'chatgpt', cited: false, competitorDomain: 'rival.com' },
    ]

    const result = analyzeCause(reg, snapshots)
    expect(result.cause).toBe('unknown')
  })

  it('ignores snapshots for different providers', () => {
    const reg = makeRegression({ provider: 'chatgpt' })
    const snapshots: Snapshot[] = [
      { keyword: 'roof repair phoenix', provider: 'gemini', cited: false, competitorDomain: 'rival.com' },
    ]

    const result = analyzeCause(reg, snapshots)
    expect(result.cause).toBe('unknown')
  })

  it('ignores snapshots where cited is true (competitor domain on a cited snapshot is irrelevant)', () => {
    const reg = makeRegression()
    const snapshots: Snapshot[] = [
      { keyword: 'roof repair phoenix', provider: 'chatgpt', cited: true, competitorDomain: 'rival.com' },
    ]

    const result = analyzeCause(reg, snapshots)
    expect(result.cause).toBe('unknown')
  })

  it('picks the first matching snapshot when multiple competitors exist', () => {
    const reg = makeRegression()
    const snapshots: Snapshot[] = [
      { keyword: 'roof repair phoenix', provider: 'chatgpt', cited: false, competitorDomain: 'first-rival.com' },
      { keyword: 'roof repair phoenix', provider: 'chatgpt', cited: false, competitorDomain: 'second-rival.com' },
    ]

    const result = analyzeCause(reg, snapshots)
    expect(result.cause).toBe('competitor_gain')
    expect(result.competitorDomain).toBe('first-rival.com')
  })

  it('analyzes different regressions independently', () => {
    const snapshots: Snapshot[] = [
      { keyword: 'k1', provider: 'chatgpt', cited: false, competitorDomain: 'rival-a.com' },
      { keyword: 'k2', provider: 'gemini', cited: false },
    ]

    const r1 = analyzeCause(makeRegression({ keyword: 'k1', provider: 'chatgpt' }), snapshots)
    const r2 = analyzeCause(makeRegression({ keyword: 'k2', provider: 'gemini' }), snapshots)

    expect(r1.cause).toBe('competitor_gain')
    expect(r1.competitorDomain).toBe('rival-a.com')
    expect(r2.cause).toBe('unknown')
  })
})
