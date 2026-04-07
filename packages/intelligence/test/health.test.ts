import { describe, it, expect } from 'vitest'
import { computeHealth, computeHealthTrend } from '../src/health.js'
import type { RunData } from '../src/types.js'

describe('health', () => {
  const run: RunData = {
    runId: 'run_001',
    projectId: 'proj_1',
    completedAt: '2026-04-01T00:00:00Z',
    snapshots: [
      { keyword: 'k1', provider: 'chatgpt', cited: true },
      { keyword: 'k1', provider: 'gemini', cited: true },
      { keyword: 'k2', provider: 'chatgpt', cited: false },
      { keyword: 'k2', provider: 'gemini', cited: true },
    ],
  }

  describe('computeHealth', () => {
    it('returns overall cited rate', () => {
      const health = computeHealth(run)
      expect(health.overallCitedRate).toBe(0.75) // 3/4
      expect(health.totalPairs).toBe(4)
      expect(health.citedPairs).toBe(3)
    })

    it('returns per-provider breakdown', () => {
      const health = computeHealth(run)
      expect(health.providerBreakdown.chatgpt.citedRate).toBe(0.5) // 1/2
      expect(health.providerBreakdown.gemini.citedRate).toBe(1.0) // 2/2
    })
  })

  describe('computeHealthTrend', () => {
    it('returns week-over-week delta', () => {
      const runs: RunData[] = [
        {
          runId: 'run_001',
          projectId: 'proj_1',
          completedAt: '2026-03-25T00:00:00Z',
          snapshots: [
            { keyword: 'k1', provider: 'chatgpt', cited: true },
            { keyword: 'k2', provider: 'chatgpt', cited: false },
          ],
        },
        {
          runId: 'run_002',
          projectId: 'proj_1',
          completedAt: '2026-04-01T00:00:00Z',
          snapshots: [
            { keyword: 'k1', provider: 'chatgpt', cited: true },
            { keyword: 'k2', provider: 'chatgpt', cited: true },
          ],
        },
      ]

      const trend = computeHealthTrend(runs)
      expect(trend.previous).toBe(0.5) // first run: 1/2
      expect(trend.current).toBe(1.0) // second run: 2/2
      expect(trend.delta).toBe(0.5)
    })

    it('handles edge case: no previous runs', () => {
      const trend = computeHealthTrend([run])
      expect(trend.current).toBe(0.75)
      expect(trend.previous).toBe(0)
      expect(trend.delta).toBe(0.75)
    })
  })
})
