import { describe, it, expect } from 'vitest'
import { analyzeCause } from '../src/causes.js'
import type { Regression, Snapshot } from '../src/types.js'

describe('causes', () => {
  const regression: Regression = {
    keyword: 'roof repair phoenix',
    provider: 'chatgpt',
    previousCitationUrl: 'https://example.com/roof',
    previousPosition: 2,
    currentRunId: 'run_002',
    previousRunId: 'run_001',
  }

  it('returns competitor_gain when competitor appeared in our lost-citation snapshot', () => {
    const snapshots: Snapshot[] = [
      // Our domain is NOT cited, but a competitor domain appeared in the response
      { keyword: 'roof repair phoenix', provider: 'chatgpt', cited: false, competitorDomain: 'roofco.com' },
    ]

    const result = analyzeCause(regression, snapshots)
    expect(result.cause).toBe('competitor_gain')
    expect(result.competitorDomain).toBe('roofco.com')
  })

  it('returns unknown when no specific cause identified', () => {
    const snapshots: Snapshot[] = [
      { keyword: 'roof repair phoenix', provider: 'chatgpt', cited: false },
    ]

    const result = analyzeCause(regression, snapshots)
    expect(result.cause).toBe('unknown')
  })
})
