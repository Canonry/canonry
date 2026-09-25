import { beforeEach, describe, expect, it, vi } from 'vitest'

const gscPerformanceDaily = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({ gscPerformanceDaily }),
}))

const { googlePerformanceDaily } = await import('../src/commands/google.js')

function captureLog(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => lines.push(args.join(' '))
  return fn().finally(() => { console.log = original }).then(() => lines.join('\n'))
}

const DAILY = [
  { date: '2026-07-01', clicks: 5, impressions: 1000, ctr: 0.005, position: 12 },
  { date: '2026-07-02', clicks: 10, impressions: 800, ctr: 0.0125, position: 11 },
  { date: '2026-07-03', clicks: 15, impressions: 600, ctr: 0.025, position: 10 },
  { date: '2026-07-04', clicks: 20, impressions: 400, ctr: 0.05, position: 9 },
]

function response(overrides: Record<string, unknown> = {}) {
  return {
    totals: { clicks: 50, impressions: 2800, ctr: 50 / 2800, position: 10.5, positionDays: 4, days: 4 },
    daily: DAILY,
    periodComparison: {
      days: 2,
      comparable: true,
      prior: {
        startDate: '2026-07-01', endDate: '2026-07-02',
        clicks: 15, impressions: 1800, ctr: 15 / 1800, position: 11.5556, source: 'property-daily' as const,
      },
      trailing: {
        startDate: '2026-07-03', endDate: '2026-07-04',
        clicks: 35, impressions: 1000, ctr: 35 / 1000, position: 9.6, source: 'property-daily' as const,
      },
      change: { clicks: 35 / 15 - 1, impressions: -0.4444, ctr: 3.2, position: -0.1692 },
    },
    ...overrides,
  }
}

/**
 * The dashboard tile and this block must print the SAME percentage. They read
 * one server-computed field precisely so they cannot drift, and this asserts
 * the CLI half actually renders it.
 */
describe('canonry google performance-daily — period comparison', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    gscPerformanceDaily.mockResolvedValue(response())
  })

  it('names both periods and their dates', async () => {
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))
    expect(out).toContain('Last 2 days (2026-07-03 to 2026-07-04) vs prior 2 (2026-07-01 to 2026-07-02)')
  })

  it('prints a signed percentage per metric', async () => {
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))
    expect(out).toMatch(/Clicks:\s+\+133\.3%\s+better/)
    expect(out).toMatch(/Impressions:\s+-44\.4%\s+worse/)
    expect(out).toMatch(/CTR:\s+\+320\.0%\s+better/)
  })

  /**
   * Position is the one metric where the sign and the verdict disagree: the
   * rank number FELL, which is an improvement. A naive `ratio > 0 = better`
   * gets this backwards, which is exactly the bug the old fitted-line label
   * shipped with.
   */
  it('calls a falling average position better, not worse', async () => {
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))
    expect(out).toMatch(/Position:\s+-16\.9%\s+better/)
  })

  it('calls a rising average position worse', async () => {
    gscPerformanceDaily.mockResolvedValue(response({
      periodComparison: { ...response().periodComparison, change: { clicks: 0, impressions: 0, ctr: 0, position: 0.25 } },
    }))
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))
    expect(out).toMatch(/Position:\s+\+25\.0%\s+worse/)
  })

  it('states the absence when the prior period gives nothing to divide by', async () => {
    gscPerformanceDaily.mockResolvedValue(response({
      periodComparison: {
        ...response().periodComparison,
        prior: {
          ...response().periodComparison.prior,
          clicks: 0, impressions: 0, ctr: null, position: null,
        },
        change: { clicks: null, impressions: null, ctr: null, position: null },
      },
    }))
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))
    expect(out).toMatch(/Clicks:\s+new in last 2 days/)
    expect(out).toContain('no prior period to compare')
    expect(out).not.toMatch(/Infinity|NaN/)
  })

  it('distinguishes an empty trailing metric from a missing prior baseline', async () => {
    gscPerformanceDaily.mockResolvedValue(response({
      periodComparison: {
        ...response().periodComparison,
        trailing: {
          ...response().periodComparison.trailing,
          clicks: 0, impressions: 0, ctr: null, position: null, source: 'empty' as const,
        },
        change: { clicks: -1, impressions: -1, ctr: null, position: null },
      },
    }))
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))
    expect(out).toMatch(/CTR:\s+no value in last 2 days/)
    expect(out).toMatch(/Position:\s+no value in last 2 days/)
    expect(out).not.toMatch(/CTR:\s+no prior period/)
  })

  it('prints the window CTR and every daily CTR as a percent of the 0..1 ratio', async () => {
    const lines = (await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))).split('\n')
    expect(lines).toContain('  CTR:         1.8%')
    const row = (date: string, clicks: string, impressions: string, ctr: string, position: string) =>
      `  ${date.padEnd(12)}${clicks.padStart(10)}${impressions.padStart(12)}${ctr.padStart(10)}${position.padStart(9)}`
    expect(lines).toContain(row('2026-07-01', '5', '1,000', '0.5%', '12.0'))
    // 1.25% rounds half up, the same way on every surface.
    expect(lines).toContain(row('2026-07-02', '10', '800', '1.3%', '11.0'))
    expect(lines).toContain(row('2026-07-04', '20', '400', '5.0%', '9.0'))
  })

  it('keeps a real movement below a tenth of a percent visible and a total loss exact', async () => {
    gscPerformanceDaily.mockResolvedValue(response({
      periodComparison: { ...response().periodComparison, change: { clicks: -1, impressions: 0.0004, ctr: -0.0004, position: 0 } },
    }))
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))
    expect(out).toMatch(/Clicks:\s+-100%\s+worse/)
    expect(out).toMatch(/Impressions:\s+\+<0\.1%\s+better/)
    expect(out).toMatch(/CTR:\s+-<0\.1%\s+worse/)
  })

  it('reports an exact zero as no change rather than a signed zero', async () => {
    gscPerformanceDaily.mockResolvedValue(response({
      periodComparison: {
        ...response().periodComparison,
        change: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
      },
    }))
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))
    expect(out).toMatch(/Clicks:\s+no change/)
    expect(out).not.toMatch(/[+-]0\.0%/)
  })

  /**
   * A server older than the field omits it entirely. The CLI must drop the
   * block rather than crash or imply the metrics did not move — the same skew
   * guard `window` and `trends` already carry.
   */
  it('omits the block against a server that predates the field', async () => {
    gscPerformanceDaily.mockResolvedValue(response({ periodComparison: undefined }))
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))
    expect(out).not.toContain('vs prior')
    expect(out).toContain('Clicks:')
  })

  it('carries the field verbatim in json mode', async () => {
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'json' }))
    const parsed = JSON.parse(out) as { periodComparison?: { days: number } }
    expect(parsed.periodComparison?.days).toBe(2)
  })
})

/**
 * The CLI half of the same refusal. Both surfaces read one server-computed
 * `comparable` flag so they cannot disagree about when a comparison is valid.
 */
describe('mixed data sources', () => {
  it('refuses to print percentages and says why', async () => {
    gscPerformanceDaily.mockResolvedValue(response({
      periodComparison: {
        ...response().periodComparison,
        comparable: false,
        prior: { ...response().periodComparison.prior, source: 'dimensioned' as const },
        change: { clicks: null, impressions: null, ctr: null, position: null },
      },
    }))
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))
    expect(out).toContain('needs property-level daily data')
    expect(out).not.toContain('vs prior 2')
    // A flat property would otherwise read +44% clicks / -23% impressions.
    expect(out).not.toMatch(/Clicks:\s+[+-]\d/)
  })
})

/**
 * The CLI names both date ranges outright, so a reader can always subtract them
 * and see the period length. The `basis` line says the thing subtraction does
 * NOT reveal: whether those dates are the window that was asked for, or half of
 * it because nothing comparable sits before it.
 */
describe('canonry google performance-daily — comparison basis', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('says nothing extra when the periods are the window and the one before it', async () => {
    gscPerformanceDaily.mockResolvedValue(response({
      periodComparison: { ...response().periodComparison, basis: 'prior-window' as const },
    }))
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))
    expect(out).toContain('Last 2 days (2026-07-03 to 2026-07-04) vs prior 2 (2026-07-01 to 2026-07-02)')
    expect(out).not.toContain('split in two')
  })

  it('says the window was split when that is what happened', async () => {
    gscPerformanceDaily.mockResolvedValue(response({
      periodComparison: { ...response().periodComparison, basis: 'split-window' as const },
    }))
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))
    expect(out).toContain('split in two')
  })

  /**
   * A server older than the field returns the comparison with no `basis`. It
   * never claimed the window was split, so neither does the CLI — asserting a
   * basis nobody sent is the same class of error as inventing a percentage.
   */
  it('claims no basis when the server sent none', async () => {
    gscPerformanceDaily.mockResolvedValue(response())
    const out = await captureLog(() => googlePerformanceDaily('demo', { format: 'text' }))
    expect(out).toContain('Last 2 days (2026-07-03 to 2026-07-04) vs prior 2 (2026-07-01 to 2026-07-02)')
    expect(out).not.toContain('split in two')
  })
})
