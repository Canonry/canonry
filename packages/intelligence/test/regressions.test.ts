import { describe, it, expect } from 'vitest'
import { detectRegressions } from '../src/regressions.js'
import type { RunData } from '../src/types.js'

describe('regressions', () => {
  const previousRun: RunData = {
    runId: 'run_001',
    projectId: 'proj_1',
    completedAt: '2026-04-01T00:00:00Z',
    snapshots: [
      { keyword: 'roof repair phoenix', provider: 'chatgpt', cited: true, citationUrl: 'https://example.com/roof', position: 2 },
      { keyword: 'roof repair phoenix', provider: 'gemini', cited: true, citationUrl: 'https://example.com/roof', position: 1 },
      { keyword: 'roof coating', provider: 'chatgpt', cited: false },
    ],
  }

  const currentRun: RunData = {
    runId: 'run_002',
    projectId: 'proj_1',
    completedAt: '2026-04-02T00:00:00Z',
    snapshots: [
      { keyword: 'roof repair phoenix', provider: 'chatgpt', cited: false }, // REGRESSION
      { keyword: 'roof repair phoenix', provider: 'gemini', cited: true, citationUrl: 'https://example.com/roof', position: 1 },
      { keyword: 'roof coating', provider: 'chatgpt', cited: false },
    ],
  }

  it('returns lost citations', () => {
    const regressions = detectRegressions(currentRun, previousRun)
    expect(regressions).toHaveLength(1)
    expect(regressions[0].keyword).toBe('roof repair phoenix')
    expect(regressions[0].provider).toBe('chatgpt')
  })

  it('returns empty array when no regressions', () => {
    const regressions = detectRegressions(previousRun, previousRun)
    expect(regressions).toHaveLength(0)
  })

  it('correctly matches by keyword+provider pair', () => {
    const regressions = detectRegressions(currentRun, previousRun)
    // Only chatgpt regression, not gemini
    expect(regressions.every(r => r.provider === 'chatgpt')).toBe(true)
  })

  it('includes citation URL from previous run in regression record', () => {
    const regressions = detectRegressions(currentRun, previousRun)
    expect(regressions[0].previousCitationUrl).toBe('https://example.com/roof')
    expect(regressions[0].previousPosition).toBe(2)
  })
})
