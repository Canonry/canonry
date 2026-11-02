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
  startDate: '2026-07-01',
  endDate: '2026-10-01',
  groups: [{
    key: 'backlinks',
    label: 'Backlinks',
    figures: [
      {
        key: 'referring-domains', label: 'Referring domains', unit: 'count', better: 'higher', value: 1052, asOf: '2026-10-01',
        change: { difference: 12, ratio: 0.01153846, tone: 'better', basis: { type: 'first-in-window', date: '2026-07-01', observedAt: null, label: 'May-Jul 2026' } },
        series: [{ date: '2026-07-01', observedAt: null, label: 'May-Jul 2026', value: 1040 }, { date: '2026-10-01', observedAt: null, label: 'Aug-Oct 2026', value: 1052 }], recordedFrom: '2026-07-01',
      },
      {
        key: 'top-10-concentration', label: 'Top-10 concentration', unit: 'fraction', better: 'neither', value: 0.42, asOf: '2026-10-01',
        change: { difference: -0.08, ratio: -0.16, tone: 'neutral', basis: { type: 'first-in-window', date: '2026-07-01', observedAt: null, label: 'May-Jul 2026' } },
        series: [{ date: '2026-07-01', observedAt: null, label: 'May-Jul 2026', value: 0.5 }, { date: '2026-10-01', observedAt: null, label: 'Aug-Oct 2026', value: 0.42 }], recordedFrom: '2026-07-01',
      },
      {
        key: 'hosts', label: 'Total linking hosts', unit: 'count', better: 'higher', value: 110, asOf: '2026-10-01',
        change: null, series: [{ date: '2026-10-01', observedAt: null, label: 'Aug-Oct 2026', value: 110 }], recordedFrom: '2026-10-01',
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
    expect(getTrends).toHaveBeenCalledWith('demo', { surface: 'backlinks', window: undefined, startDate: undefined, endDate: undefined })
    expect(out).toContain('Backlinks for "demo", 2026-07-01 to 2026-10-01 (window all):')
    // A release is named by its crawl window, not the day it reads at.
    expect(out).toMatch(/Referring domains\s+1,052 {2}\+12 since May-Jul 2026/)
    // A share moves in points, never as a ratio of a ratio.
    expect(out).toMatch(/Top-10 concentration\s+42\.0% {2}-8\.0 pts since May-Jul 2026/)
    expect(out).toMatch(/Total linking hosts\s+110 {2}one reading in the window/)
  })

  it('reads a calendar range instead of a window when given one', async () => {
    getTrends.mockResolvedValue({ ...BACKLINKS, window: null, startDate: '2026-08-01', endDate: '2026-10-31' })
    const out = await captureLog(() => trendsCommand('demo', { surface: 'backlinks', startDate: '2026-08-01', endDate: '2026-10-31', format: 'text' }))
    expect(getTrends).toHaveBeenCalledWith('demo', { surface: 'backlinks', window: undefined, startDate: '2026-08-01', endDate: '2026-10-31' })
    expect(out).toContain('Backlinks for "demo", 2026-08-01 to 2026-10-31 (your date range):')
  })

  it('says nothing is recorded instead of printing an empty table', async () => {
    getTrends.mockResolvedValue({ ...BACKLINKS, startDate: null, endDate: null, groups: [] })
    const out = await captureLog(() => trendsCommand('demo', { surface: 'backlinks', window: '90d', format: 'text' }))
    expect(getTrends).toHaveBeenCalledWith('demo', { surface: 'backlinks', window: '90d', startDate: undefined, endDate: undefined })
    expect(out).toBe('Backlinks for "demo": nothing recorded yet.')
  })
})
