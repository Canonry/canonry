import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GaOverviewResponse, GaOverviewValues } from '@canonry/canonry-contracts'

const mockGaOverview = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({ gaOverview: mockGaOverview }),
}))

const { gaOverview } = await import('../src/commands/ga.js')

function values(overrides: Partial<GaOverviewValues> = {}): GaOverviewValues {
  return {
    activeUsers: null,
    newUsers: null,
    totalUsers: null,
    sessions: null,
    organicSessions: null,
    views: null,
    eventCount: null,
    keyEvents: null,
    engagementRate: null,
    bounceRate: null,
    averageEngagementTimeSeconds: null,
    ...overrides,
  }
}

/** A `/ga/overview` document as the API sends it: the CLI only lays it out. */
function overview(overrides: Partial<GaOverviewResponse> = {}): GaOverviewResponse {
  return {
    window: '30d',
    current: { startDate: '2026-09-23', endDate: '2026-10-22' },
    previous: { startDate: '2026-08-24', endDate: '2026-09-22' },
    totals: values({ activeUsers: 2500, sessions: 4528, engagementRate: 0.6076, averageEngagementTimeSeconds: 91.42, keyEvents: 146 }),
    previousTotals: values({ activeUsers: 2356, sessions: 4256, engagementRate: 0.6106, averageEngagementTimeSeconds: 91.93, keyEvents: 0 }),
    changePct: values({ activeUsers: 6.112054, sessions: 6.390977, engagementRate: -0.476486, averageEngagementTimeSeconds: -0.550526 }),
    days: [],
    syncedAt: '2026-10-23T04:00:00.000Z',
    ...overrides,
  }
}

function captureLog(fn: () => Promise<void>): { run: Promise<void>; lines: () => string[] } {
  const logs: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')) })
  const run = fn().finally(() => spy.mockRestore())
  return { run, lines: () => logs.join('\n').split('\n') }
}

describe('canonry ga overview', () => {
  beforeEach(() => {
    mockGaOverview.mockReset()
  })

  it('prints each figure for both periods with the server\'s change', async () => {
    mockGaOverview.mockResolvedValue(overview())

    const cap = captureLog(() => gaOverview('demo', { window: '30d' }))
    await cap.run

    expect(mockGaOverview).toHaveBeenCalledWith('demo', '30d')
    const lines = cap.lines()
    expect(lines[0]).toBe('GA4 overview for "demo", 2026-09-23 to 2026-10-22 vs 2026-08-24 to 2026-09-22:')
    const row = (label: string) => lines.find(line => line.trimStart().startsWith(`${label} `))?.trim().split(/\s{2,}/)
    expect(row('Users')).toEqual(['Users', '2,500', '2,356', '+6.1%'])
    expect(row('Sessions')).toEqual(['Sessions', '4,528', '4,256', '+6.4%'])
    expect(row('Engagement rate')).toEqual(['Engagement rate', '60.8%', '61.1%', '-0.5%'])
    expect(row('Average engagement time')).toEqual(['Average engagement time', '1m 31s', '1m 32s', '-0.6%'])
    // No change from a zero previous total: a dash, never 0%.
    expect(row('Key events')).toEqual(['Key events', '146', '0', '—'])
    // A figure GA4 never reported reads as a dash in both periods.
    expect(row('Views')).toEqual(['Views', '—', '—', '—'])
  })

  it('prints the API document unchanged as json, and on one line as jsonl', async () => {
    const document = overview()
    mockGaOverview.mockResolvedValue(document)

    const json = captureLog(() => gaOverview('demo', { format: 'json' }))
    await json.run
    expect(JSON.parse(json.lines().join('\n'))).toEqual(document)
    expect(mockGaOverview).toHaveBeenLastCalledWith('demo', undefined)

    const jsonl = captureLog(() => gaOverview('demo', { format: 'jsonl' }))
    await jsonl.run
    expect(jsonl.lines()).toHaveLength(1)
    expect(JSON.parse(jsonl.lines()[0]!)).toEqual(document)
  })

  it('says when the overview has not been synced yet instead of printing an empty table', async () => {
    mockGaOverview.mockResolvedValue(overview({ totals: values(), previousTotals: values(), changePct: values(), syncedAt: null }))

    const cap = captureLog(() => gaOverview('demo'))
    await cap.run

    expect(cap.lines()).toContain('No GA4 overview figures yet. Run "canonry ga sync <project>" to fetch them.')
    expect(cap.lines().some(line => line.includes('METRIC'))).toBe(false)
  })

  it('refuses a window the overview does not have, before asking the API', async () => {
    await expect(gaOverview('demo', { window: '60d' })).rejects.toThrow(/7d, 30d or 90d/)
    expect(mockGaOverview).not.toHaveBeenCalled()
  })
})
