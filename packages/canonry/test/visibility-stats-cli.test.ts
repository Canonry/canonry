import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { VisibilityStatsDto } from '@ainyc/canonry-contracts'

const mockGetVisibilityStats = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getVisibilityStats: mockGetVisibilityStats,
  }),
}))

/** Capture process.stdout.write (jsonl path) AND console.log (text/json path). */
function captureOutput(fn: () => Promise<void>): { run: Promise<void>; text: () => string; lines: () => string[] } {
  let buf = ''
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    buf += String(chunk)
    return true
  })
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    buf += `${args.join(' ')}\n`
  })
  const run = fn().finally(() => {
    writeSpy.mockRestore()
    logSpy.mockRestore()
  })
  return { run, text: () => buf, lines: () => buf.split('\n').filter(Boolean) }
}

const { showVisibilityStats } = await import('../src/commands/visibility-stats.js')

const data: VisibilityStatsDto = {
  project: 'acme',
  groupBy: 'provider',
  window: { since: null, until: null, lastRuns: 3, runCount: 3 },
  totals: { total: 6, checked: 5, mentioned: 3, cited: 4, mentionRate: 0.6, citedRate: 0.6667 },
  byProvider: [
    { provider: 'gemini', total: 3, checked: 3, mentioned: 2, cited: 2, mentionRate: 0.6667, citedRate: 0.6667, firstObserved: '2026-06-01T00:00:00.000Z', lastObserved: '2026-06-05T00:00:00.000Z' },
    { provider: 'openai', total: 3, checked: 2, mentioned: 1, cited: 2, mentionRate: 0.5, citedRate: 0.6667, firstObserved: '2026-06-01T00:00:00.000Z', lastObserved: '2026-06-05T00:00:00.000Z' },
  ],
  queries: [
    {
      queryId: 'q1',
      query: 'best AEO platform',
      total: 4,
      checked: 4,
      mentioned: 3,
      cited: 3,
      mentionRate: 0.75,
      citedRate: 0.75,
      firstObserved: '2026-06-01T00:00:00.000Z',
      lastObserved: '2026-06-05T00:00:00.000Z',
      providers: [
        { provider: 'gemini', total: 2, checked: 2, mentioned: 2, cited: 2, mentionRate: 1, citedRate: 1, firstObserved: '2026-06-01T00:00:00.000Z', lastObserved: '2026-06-05T00:00:00.000Z' },
        { provider: 'openai', total: 2, checked: 2, mentioned: 1, cited: 1, mentionRate: 0.5, citedRate: 0.5, firstObserved: '2026-06-01T00:00:00.000Z', lastObserved: '2026-06-05T00:00:00.000Z' },
      ],
    },
    {
      queryId: 'q2',
      query: 'AI search optimization',
      total: 2,
      checked: 1,
      mentioned: 0,
      cited: 1,
      mentionRate: 0,
      citedRate: 0.5,
      firstObserved: '2026-06-01T00:00:00.000Z',
      lastObserved: '2026-06-05T00:00:00.000Z',
      providers: [],
    },
  ],
}

describe('showVisibilityStats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetVisibilityStats.mockResolvedValue(data)
  })

  it('json emits the full DTO unchanged', async () => {
    const cap = captureOutput(() => showVisibilityStats('acme', { format: 'json', byProvider: true }))
    await cap.run
    expect(JSON.parse(cap.text())).toEqual(data)
  })

  it('jsonl streams one record per query, stamped with project + runCount', async () => {
    const cap = captureOutput(() => showVisibilityStats('acme', { format: 'jsonl', byProvider: true }))
    await cap.run
    const rows = cap.lines().map((l) => JSON.parse(l))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ project: 'acme', runCount: 3, queryId: 'q1', mentionRate: 0.75 })
    // each record is self-contained and carries the nested providers
    expect(rows[0].providers).toHaveLength(2)
  })

  it('passes since/until/lastRuns/groupBy through to the client', async () => {
    await showVisibilityStats('acme', { since: '2026-06-01', byProvider: true, format: 'json' })
    expect(mockGetVisibilityStats).toHaveBeenCalledWith('acme', {
      since: '2026-06-01',
      until: undefined,
      lastRuns: undefined,
      groupBy: 'provider',
    })

    await showVisibilityStats('acme', { lastRuns: 5, format: 'json' })
    expect(mockGetVisibilityStats).toHaveBeenLastCalledWith('acme', {
      since: undefined,
      until: undefined,
      lastRuns: 5,
      groupBy: undefined,
    })
  })

  it('text renders both signals, the sample-size fractions, and a TOTAL row', async () => {
    const cap = captureOutput(() => showVisibilityStats('acme', { format: undefined, byProvider: true }))
    await cap.run
    const out = cap.text()
    expect(out).toContain('best AEO platform')
    expect(out).toContain('TOTAL')
    // cited shows cited/total; mentioned shows mentioned/checked
    expect(out).toContain('3/4') // q1 cited/total AND mentioned/checked are both 3/4
    expect(out).toContain('75.0%')
    // per-provider pooled section
    expect(out).toContain('By provider (pooled across queries)')
    expect(out).toContain('gemini')
  })

  it('text renders an empty-state hint when there are no rows', async () => {
    mockGetVisibilityStats.mockResolvedValue({
      ...data,
      queries: [],
      byProvider: [],
      totals: { total: 0, checked: 0, mentioned: 0, cited: 0, mentionRate: null, citedRate: null },
      window: { since: null, until: null, lastRuns: null, runCount: 0 },
    } satisfies VisibilityStatsDto)
    const cap = captureOutput(() => showVisibilityStats('acme', {}))
    await cap.run
    expect(cap.text()).toContain('No answer-visibility snapshots')
  })
})
