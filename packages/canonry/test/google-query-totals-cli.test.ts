import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { GscQueryTotalsDto } from '@ainyc/canonry-contracts'

const mockGscQueryTotals = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    gscQueryTotals: mockGscQueryTotals,
  }),
}))

const { googleQueryTotals } = await import('../src/commands/google.js')
const { runCli } = await import('../src/cli.js')

const PROJECT = 'widgets'

const WINDOW: GscQueryTotalsDto['window'] = {
  startDate: '2026-06-01',
  endDate: '2026-06-30',
  latestDataDate: '2026-07-02',
  daysSinceLatestData: 3,
}

/** Fictional per-query totals, as the route returns them. */
function envelope(overrides: Partial<GscQueryTotalsDto> = {}): GscQueryTotalsDto {
  return {
    rows: [
      { query: 'blue widget', clicks: 120, impressions: 800, ctr: 0.15, position: 2.8, days: 30, source: 'google' },
      { query: 'widget repair near me', clicks: 9, impressions: 300, ctr: 0.03, position: 7.25, days: 12, source: 'google' },
    ],
    totalMatching: 2,
    truncated: false,
    window: WINDOW,
    ...overrides,
  }
}

/** Capture `console.log` (the json and human paths). */
async function captureLog(fn: () => Promise<unknown>): Promise<string[]> {
  const logs: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')) })
  try {
    await fn()
  } finally {
    spy.mockRestore()
  }
  return logs
}

/** Capture `process.stdout.write` (the jsonl path). */
async function captureStdout(fn: () => Promise<unknown>): Promise<string[]> {
  let buf = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    buf += String(chunk)
    return true
  })
  try {
    await fn()
  } finally {
    spy.mockRestore()
  }
  return buf.split('\n').filter(Boolean)
}

async function captureError(fn: () => Promise<number>): Promise<{ exitCode: number; stderr: string }> {
  const errors: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')) })
  try {
    const exitCode = await fn()
    return { exitCode, stderr: errors.join('\n') }
  } finally {
    spy.mockRestore()
  }
}

describe('canonry google query-totals', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGscQueryTotals.mockResolvedValue(envelope())
  })

  it('passes --start, --end, --window, --limit and --offset through as query params', async () => {
    await captureLog(() => runCli([
      'google', 'query-totals', PROJECT,
      '--start', '2026-06-01', '--end', '2026-06-30', '--window', '90d',
      '--limit', '100', '--offset', '200', '--format', 'json',
    ]))
    expect(mockGscQueryTotals).toHaveBeenCalledTimes(1)
    expect(mockGscQueryTotals).toHaveBeenCalledWith(PROJECT, {
      startDate: '2026-06-01',
      endDate: '2026-06-30',
      window: '90d',
      limit: '100',
      offset: '200',
    })
  })

  it('sends no params when none are given', async () => {
    await captureLog(() => runCli(['google', 'query-totals', PROJECT, '--format', 'json']))
    expect(mockGscQueryTotals).toHaveBeenCalledWith(PROJECT, undefined)
  })

  it('--format json prints the API envelope unchanged', async () => {
    const data = envelope({ totalMatching: 9, truncated: true })
    mockGscQueryTotals.mockResolvedValue(data)
    const logs = await captureLog(() => googleQueryTotals(PROJECT, { format: 'json' }))
    expect(JSON.parse(logs.join(''))).toEqual(data)
  })

  it('--format jsonl emits one line per query tagged with project and window', async () => {
    const lines = await captureStdout(() => googleQueryTotals(PROJECT, { format: 'jsonl' }))
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toEqual({
      project: PROJECT,
      window: WINDOW,
      query: 'blue widget', clicks: 120, impressions: 800, ctr: 0.15, position: 2.8, days: 30, source: 'google',
    })
    expect(JSON.parse(lines[1]!).query).toBe('widget repair near me')
  })

  it('human output lists query, clicks, impressions, position and days', async () => {
    const logs = await captureLog(() => googleQueryTotals(PROJECT, {}))
    const text = logs.join('\n')
    expect(text).toContain('2 of 2 queries')
    expect(text).toContain('2026-06-01 to 2026-06-30')
    expect(text).toMatch(/QUERY\s+CLICKS\s+IMPR\s+CTR\s+POS\s+DAYS/)
    expect(text).toMatch(/blue widget\s+120\s+800\s+15\.0%\s+2\.8\s+30/)
    expect(text).toMatch(/widget repair near me\s+9\s+300\s+3\.0%\s+7\.3\s+12/)
    // Every row is `google`, so there is no SOURCE column and no legacy note.
    expect(text).not.toContain('SOURCE')
    expect(text).not.toContain('legacy')
    // Always: these are named queries, not the property total.
    expect(text).toContain('performance-daily')
  })

  it('explains the legacy source when a row is not google', async () => {
    mockGscQueryTotals.mockResolvedValue(envelope({
      rows: [
        { query: 'blue widget', clicks: 120, impressions: 800, ctr: 0.15, position: 2.8, days: 30, source: 'mixed' },
        { query: 'red widget', clicks: 4, impressions: 90, ctr: 0.044, position: 5, days: 3, source: 'page-summed' },
        { query: 'green widget', clicks: 1, impressions: 20, ctr: 0.05, position: 9, days: 1, source: 'google' },
      ],
      totalMatching: 3,
    }))
    const lines = await captureLog(() => googleQueryTotals(PROJECT, {}))
    const text = lines.join('\n')
    const rowFor = (query: string) => lines.find(line => line.trimStart().startsWith(query))
    expect(text).toMatch(/DAYS\s+SOURCE/)
    expect(rowFor('blue widget')?.trimEnd().endsWith(' mixed')).toBe(true)
    expect(rowFor('red widget')?.trimEnd().endsWith(' page-summed')).toBe(true)
    expect(rowFor('green widget')?.trimEnd().endsWith(' google')).toBe(true)
    expect(text).toContain('legacy page table')
    expect(text).toContain('canonry google sync')
  })

  it('reports an offset past the end instead of suggesting sync', async () => {
    mockGscQueryTotals.mockResolvedValue(envelope({ rows: [], totalMatching: 42, truncated: false }))
    const text = (await captureLog(() => googleQueryTotals(PROJECT, { offset: 500 }))).join('\n')
    expect(text).toContain('Offset 500 is past the end')
    expect(text).toContain('42 queries')
    expect(text).not.toContain('canonry google sync')
  })

  it('suggests sync when the window has no query data', async () => {
    mockGscQueryTotals.mockResolvedValue(envelope({ rows: [], totalMatching: 0 }))
    const text = (await captureLog(() => googleQueryTotals(PROJECT, {}))).join('\n')
    expect(text).toBe('No GSC query data found in this window. Run "canonry google sync" first.')
  })

  it('gives a paging hint when the page is truncated', async () => {
    mockGscQueryTotals.mockResolvedValue(envelope({ totalMatching: 1200, truncated: true }))
    const text = (await captureLog(() => googleQueryTotals(PROJECT, { limit: 2, offset: 0 }))).join('\n')
    expect(text).toContain('2 of 1,200 queries')
    expect(text).toContain('--offset 2')
  })

  it('rejects a non-integer --limit with exit 1 before calling the API', async () => {
    const { exitCode, stderr } = await captureError(() => runCli([
      'google', 'query-totals', PROJECT, '--limit', 'lots', '--format', 'json',
    ]))
    expect(exitCode).toBe(1)
    expect(mockGscQueryTotals).not.toHaveBeenCalled()
    const error = JSON.parse(stderr).error
    expect(error.message).toBe('--limit must be an integer')
    expect(error.details.command).toBe('google.query-totals')
  })

  it('requires a project', async () => {
    const { exitCode, stderr } = await captureError(() => runCli(['google', 'query-totals', '--format', 'json']))
    expect(exitCode).toBe(1)
    expect(mockGscQueryTotals).not.toHaveBeenCalled()
    const error = JSON.parse(stderr).error
    expect(error.message).toBe('project name is required')
    expect(error.details.command).toBe('google.query-totals')
  })
})
