import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { BrandMetricsDto, GapAnalysisDto, SourceBreakdownDto } from '@ainyc/canonry-contracts'

const mockGetMetrics = vi.fn()
const mockGetGaps = vi.fn()
const mockGetSources = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getAnalyticsMetrics: mockGetMetrics,
    getAnalyticsGaps: mockGetGaps,
    getAnalyticsSources: mockGetSources,
  }),
}))

/** Capture console.log lines (the json / jsonl degrade path uses console.log). */
function captureLog(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  return fn()
    .finally(() => {
      console.log = origLog
    })
    .then(() => logs.join('\n'))
}

const { showAnalytics } = await import('../src/commands/analytics.js')

const metrics: BrandMetricsDto = {
  window: '30d',
  overall: { cited: 3, total: 10, citationRate: 0.3 },
  trend: 'up',
  byProvider: { openai: { cited: 2, total: 5, citationRate: 0.4 } },
  buckets: [{ startDate: '2026-05-01T00:00:00.000Z', endDate: '2026-05-08T00:00:00.000Z', cited: 1, total: 5, citationRate: 0.2 }],
} as unknown as BrandMetricsDto

const gaps: GapAnalysisDto = {
  cited: [],
  gap: [],
  uncited: [],
} as unknown as GapAnalysisDto

const sources: SourceBreakdownDto = {
  overall: [],
} as unknown as SourceBreakdownDto

describe('showAnalytics — jsonl degrades to the json document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMetrics.mockResolvedValue(metrics)
    mockGetGaps.mockResolvedValue(gaps)
    mockGetSources.mockResolvedValue(sources)
  })

  it('format=jsonl emits parseable JSON equal to format=json (the degrade)', async () => {
    const jsonOut = await captureLog(() => showAnalytics('demo', { format: 'json' }))
    const jsonlOut = await captureLog(() => showAnalytics('demo', { format: 'jsonl' }))

    // jsonl emits the same JSON document as json — byte-identical, both parseable.
    expect(jsonlOut).toBe(jsonOut)
    expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
    expect(JSON.parse(jsonlOut)).toMatchObject({ metrics, gaps, sources })
  })

  it('format=jsonl with a single feature emits only that feature, equal to json', async () => {
    const jsonOut = await captureLog(() => showAnalytics('demo', { feature: 'metrics', format: 'json' }))
    const jsonlOut = await captureLog(() => showAnalytics('demo', { feature: 'metrics', format: 'jsonl' }))

    expect(jsonlOut).toBe(jsonOut)
    const parsed = JSON.parse(jsonlOut)
    expect(parsed).toHaveProperty('metrics')
    expect(parsed).not.toHaveProperty('gaps')
    expect(parsed).not.toHaveProperty('sources')
  })

  it('format=jsonl does NOT print the human metrics table', async () => {
    const out = await captureLog(() => showAnalytics('demo', { format: 'jsonl' }))
    expect(out).not.toMatch(/Citation Rate Trends/)
    expect(out).not.toMatch(/Brand Gap Analysis/)
    expect(out).not.toMatch(/Source Origin Breakdown/)
  })

  it('no format → human text output is unchanged (prints the decorated tables)', async () => {
    const out = await captureLog(() => showAnalytics('demo', {}))
    expect(out).toMatch(/Citation Rate Trends/)
    expect(out).toMatch(/Brand Gap Analysis/)
    expect(out).toMatch(/Source Origin Breakdown/)
    // Human path must not emit the JSON envelope.
    expect(() => JSON.parse(out)).toThrow()
  })
})
