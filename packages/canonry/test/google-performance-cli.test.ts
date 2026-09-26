import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliCommandSpec } from '../src/cli-dispatch.js'

const gscPerformance = vi.fn()
const gscTopPages = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({ gscPerformance, gscTopPages }),
}))

const { googlePerformance, googleTopPages } = await import('../src/commands/google.js')
const { GOOGLE_CLI_COMMANDS } = await import('../src/cli-commands/google.js')

function performanceSpec(): CliCommandSpec {
  const spec = GOOGLE_CLI_COMMANDS.find((entry) => entry.path.join('.') === 'google.performance')
  if (!spec) throw new Error('google performance command is not registered')
  return spec
}

function runSpec(values: Record<string, string | boolean>): Promise<void> {
  return Promise.resolve(performanceSpec().run({
    positionals: ['demo'],
    values,
    format: 'text',
    dryRun: false,
  }))
}

function captureLog(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => lines.push(args.join(' '))
  return fn().finally(() => { console.log = original }).then(() => lines.join('\n'))
}

const EMPTY_RESPONSE = {
  rows: [],
  totalMatching: 0,
  truncated: false,
  latestAvailableDate: '2026-07-25',
}

describe('canonry google performance CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    gscPerformance.mockResolvedValue(EMPTY_RESPONSE)
  })

  it('errors when both --days and --start are passed instead of silently picking one', async () => {
    await expect(runSpec({ days: '30', start: '2026-07-01' })).rejects.toThrow(/--days/)
    await expect(runSpec({ days: '30', start: '2026-07-01' })).rejects.toThrow(/--start/)
    expect(gscPerformance).not.toHaveBeenCalled()
  })

  it('lets --start/--end drive the window', async () => {
    await captureLog(() => runSpec({ start: '2026-07-01', end: '2026-07-10' }))
    expect(gscPerformance).toHaveBeenCalledWith('demo', expect.objectContaining({
      startDate: '2026-07-01',
      endDate: '2026-07-10',
    }))
  })

  it('passes --limit, --offset and --order-by through to the API', async () => {
    await captureLog(() => runSpec({ limit: '2000', offset: '500', 'order-by': 'impressions' }))
    expect(gscPerformance).toHaveBeenCalledWith('demo', expect.objectContaining({
      limit: '2000',
      offset: '500',
      orderBy: 'impressions',
    }))
  })

  it('names both dates when an empty result sits inside the GSC reporting lag', async () => {
    const output = await captureLog(() => googlePerformance('demo', {
      startDate: '2026-07-28',
      endDate: '2026-07-31',
    }))
    expect(output).toContain('2026-07-31')
    expect(output).toContain('2026-07-25')
    expect(output).toMatch(/lag/i)
    expect(output).not.toMatch(/Run "canonry google sync" first/)
  })

  it('names the offset when the page starts past the end, not the lag or a sync', async () => {
    // Rows exist, this page just begins past the last one. Neither the lag
    // message nor the sync message applies, and both would send the operator
    // somewhere that cannot help.
    gscPerformance.mockResolvedValue({
      rows: [],
      totalMatching: 700,
      truncated: false,
      latestAvailableDate: '2026-07-25',
    })
    const output = await captureLog(() => googlePerformance('demo', { offset: 700 }))
    expect(output).toMatch(/offset/i)
    expect(output).toContain('700')
    expect(output).not.toMatch(/lag/i)
    expect(output).not.toMatch(/Run "canonry google sync" first/)
  })

  it('still points at sync when the project holds no GSC data at all', async () => {
    gscPerformance.mockResolvedValue({ ...EMPTY_RESPONSE, latestAvailableDate: null })
    const output = await captureLog(() => googlePerformance('demo', {}))
    expect(output).toMatch(/Run "canonry google sync" first/)
  })

  it('reports the matching total when the page is truncated', async () => {
    gscPerformance.mockResolvedValue({
      rows: [{ date: '2026-07-20', query: 'roof coating', page: '/p', clicks: 9, impressions: 100, ctr: 0.09, position: 3.2 }],
      totalMatching: 1421,
      truncated: true,
      latestAvailableDate: '2026-07-25',
    })
    const output = await captureLog(() => googlePerformance('demo', {}))
    expect(output).toContain('1,421')
  })
})

/** GSC's `ctr` is a 0..1 fraction on every read; the tables print it as a percent. */
describe('canonry google CTR columns', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prints each performance row CTR through formatPercent', async () => {
    gscPerformance.mockResolvedValue({
      rows: [
        { date: '2026-07-20', query: 'roof coating', page: '/p', clicks: 9, impressions: 100, ctr: 0.09, position: 3.2 },
        { date: '2026-07-20', query: 'roof', page: '/q', clicks: 1, impressions: 2500, ctr: 0.0004, position: 11 },
      ],
      totalMatching: 2,
      truncated: false,
      latestAvailableDate: '2026-07-25',
    })
    const lines = (await captureLog(() => googlePerformance('demo', {}))).split('\n')
    const row = (query: string, clicks: string, impressions: string, cells: string) =>
      `  ${'2026-07-20'.padEnd(12)}${query.padEnd(30)}${clicks.padEnd(8)}${impressions.padEnd(8)}${cells}`
    expect(lines).toContain(row('roof coating', '9', '100', '  9.0%    3.2'))
    expect(lines).toContain(row('roof', '1', '2500', ' <0.1%   11.0'))
  })

  it('prints top-page and property-total CTRs through formatPercent', async () => {
    gscTopPages.mockResolvedValue({
      rows: [
        { page: '/pricing', clicks: 120, impressions: 1600, ctr: 0.075 },
        { page: '/blog/archive', clicks: 0, impressions: 900, ctr: 0 },
      ],
      totals: { clicks: 1142, impressions: 34916, ctr: 1142 / 34916, days: 28, coveredFrom: '2026-06-28', coveredThrough: '2026-07-25', complete: true },
      totalsSource: 'property-daily',
      rankedFrom: '2026-06-28',
      rankedThrough: '2026-07-25',
    })
    const lines = (await captureLog(() => googleTopPages('demo', {}))).split('\n')
    const row = (page: string, clicks: string, impressions: string, ctr: string) =>
      `  ${page.padEnd(20)}${clicks.padStart(10)}${impressions.padStart(12)}${ctr.padStart(10)}`
    expect(lines).toContain(row('/pricing', '120', '1,600', '7.5%'))
    expect(lines).toContain(row('/blog/archive', '0', '900', '0%'))
    expect(lines).toContain('  CTR:         3.3%')
  })
})
