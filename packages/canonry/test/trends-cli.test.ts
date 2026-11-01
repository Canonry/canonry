import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrendsResponse } from '@canonry/canonry-contracts'

const getTrends = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({ getTrends }),
}))

const { trendsCommand } = await import('../src/commands/trends.js')

function captureLog(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => lines.push(args.join(' '))
  return fn().finally(() => { console.log = original }).then(() => lines.join('\n'))
}

const BACKLINKS: TrendsResponse = {
  project: 'demo',
  surface: 'backlinks',
  window: 'all',
  startDate: '2026-07-02',
  endDate: '2026-10-05',
  groups: [{
    key: 'backlinks',
    label: 'Backlinks',
    figures: [
      {
        key: 'referring-domains', label: 'Referring domains', unit: 'count', better: 'higher', value: 1052, asOf: '2026-10-05',
        change: { difference: 12, ratio: 12 / 1040, tone: 'better', basis: { type: 'first-in-window', date: '2026-07-02', observedAt: '2026-07-02T00:00:00.000Z' } },
        series: [{ date: '2026-07-02', observedAt: '2026-07-02T00:00:00.000Z', value: 1040 }, { date: '2026-10-05', observedAt: '2026-10-05T00:00:00.000Z', value: 1052 }], recordedFrom: '2026-07-02',
      },
      {
        key: 'top-10-concentration', label: 'Top-10 concentration', unit: 'fraction', better: 'neither', value: 0.42, asOf: '2026-10-05',
        change: { difference: -0.08, ratio: -0.16, tone: 'neutral', basis: { type: 'first-in-window', date: '2026-07-02', observedAt: '2026-07-02T00:00:00.000Z' } },
        series: [{ date: '2026-07-02', observedAt: '2026-07-02T00:00:00.000Z', value: 0.5 }, { date: '2026-10-05', observedAt: '2026-10-05T00:00:00.000Z', value: 0.42 }], recordedFrom: '2026-07-02',
      },
      {
        key: 'hosts', label: 'Total linking hosts', unit: 'count', better: 'higher', value: 110, asOf: '2026-10-05',
        change: null, series: [{ date: '2026-10-05', observedAt: '2026-10-05T00:00:00.000Z', value: 110 }], recordedFrom: '2026-10-05',
      },
    ],
  }],
}

describe('canonry trends', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prints each figure with the server change in its own unit and the date it runs from', async () => {
    getTrends.mockResolvedValue(BACKLINKS)
    const out = await captureLog(() => trendsCommand('demo', { surface: 'backlinks', format: 'text' }))
    expect(getTrends).toHaveBeenCalledWith('demo', { surface: 'backlinks', window: undefined })
    expect(out).toContain('Backlinks for "demo", 2026-07-02 to 2026-10-05 (window all):')
    expect(out).toMatch(/Referring domains\s+1,052 {2}\+12 since 2026-07-02/)
    // A share moves in points, never as a ratio of a ratio.
    expect(out).toMatch(/Top-10 concentration\s+42\.0% {2}-8\.0 pts since 2026-07-02/)
    expect(out).toMatch(/Total linking hosts\s+110 {2}one reading in the window/)
  })

  it('says nothing is recorded instead of printing an empty table', async () => {
    getTrends.mockResolvedValue({ ...BACKLINKS, startDate: null, endDate: null, groups: [] })
    const out = await captureLog(() => trendsCommand('demo', { surface: 'backlinks', window: '90d', format: 'text' }))
    expect(getTrends).toHaveBeenCalledWith('demo', { surface: 'backlinks', window: '90d' })
    expect(out).toBe('Backlinks for "demo": nothing recorded yet.')
  })
})
