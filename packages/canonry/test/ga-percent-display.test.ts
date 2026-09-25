import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GaAttributionTrendResponse, GaChannelTrend, GaSocialReferralTrendResponse, GaSourceMover, GaTrafficResponse } from '@ainyc/canonry-contracts'
import { gaAttributionTrendResponseSchema, gaSocialReferralTrendResponseSchema } from '@ainyc/canonry-contracts'

const gaTraffic = vi.fn()
const gaAttributionTrend = vi.fn()
const gaSocialReferralTrend = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({ gaTraffic, gaAttributionTrend, gaSocialReferralTrend }),
}))

const { gaAttribution, gaSocialReferralSummary, gaTraffic: showGaTraffic } = await import('../src/commands/ga.js')

async function lines(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(...args.join(' ').split('\n'))
  })
  try {
    await fn()
  } finally {
    log.mockRestore()
  }
  return logs
}

/**
 * The share display strings deliberately differ from what the counts would
 * round to under the old whole-percent CLI math (123 / 1000 was `12%`): the CLI
 * prints the server's string for each share, the same one the dashboard shows,
 * and never re-derives it from the counts.
 */
function traffic(overrides: Partial<GaTrafficResponse> = {}): GaTrafficResponse {
  return {
    totalSessions: 1000,
    totalOrganicSessions: 575,
    totalDirectSessions: 200,
    totalUsers: 800,
    topPages: [],
    aiReferrals: [{ source: 'chatgpt.com', medium: 'referral', trafficClass: 'organic', sourceDimension: 'session', sessions: 123 }],
    aiReferralLandingPages: [],
    aiSessionsDeduped: 123,
    paidAiSessionsDeduped: 4,
    organicAiSessionsDeduped: 119,
    aiSessionsBySession: 80,
    paidAiSessionsBySession: 3,
    organicAiSessionsBySession: 77,
    socialReferrals: [{ source: 'reddit.com', medium: 'referral', channelGroup: 'Organic Social', sessions: 80, users: 70 }],
    socialSessions: 80,
    channelBreakdown: {
      organic: { sessions: 575, sharePct: 58, sharePctDisplay: '57.5%' },
      social: { sessions: 1, sharePct: 0, sharePctDisplay: '<0.1%' },
      direct: { sessions: 999, sharePct: 100, sharePctDisplay: '>99.9%' },
      ai: { sessions: 80, sharePct: 8, sharePctDisplay: '8.0%' },
      other: { sessions: 300, sharePct: 30, sharePctDisplay: '30.0%' },
    },
    organicSharePct: 58,
    aiSharePct: 12,
    aiSharePctBySession: 8,
    paidAiSharePct: 0,
    paidAiSharePctBySession: 0,
    organicAiSharePct: 12,
    organicAiSharePctBySession: 8,
    directSharePct: 20,
    socialSharePct: 8,
    organicSharePctDisplay: '57.5%',
    aiSharePctDisplay: '12.3%',
    aiSharePctBySessionDisplay: '8.0%',
    paidAiSharePctDisplay: '0.4%',
    paidAiSharePctBySessionDisplay: '0.3%',
    organicAiSharePctDisplay: '11.9%',
    organicAiSharePctBySessionDisplay: '7.7%',
    directSharePctDisplay: '20.0%',
    socialSharePctDisplay: '8.0%',
    otherSessions: 300,
    otherSharePct: 30,
    otherSharePctDisplay: '30.0%',
    lastSyncedAt: null,
    windowStart: '2026-05-01',
    windowEnd: '2026-05-30',
    windowDays: 30,
    periodStart: '2026-05-01',
    periodEnd: '2026-05-30',
    ...overrides,
  } as GaTrafficResponse
}

function channelTrend(trend7dPct: number | null, trend30dPct: number | null): GaChannelTrend {
  return { sessions7d: 10, sessionsPrev7d: 10, trend7dPct, sessions30d: 40, sessionsPrev30d: 40, trend30dPct }
}

/** Movers exactly as the server states them (see `buildSourceMover`). */
const NEW_SOURCE: GaSourceMover = { source: 'perplexity.ai', sessions7d: 9, sessionsPrev7d: 0, changeSessions: 9, changePct: null, changeBasis: 'new' }
const STOPPED_SOURCE: GaSourceMover = { source: 'reddit.com', sessions7d: 0, sessionsPrev7d: 40, changeSessions: -40, changePct: -100, changeBasis: 'percent' }
const SMALL_BASE_SOURCE: GaSourceMover = { source: 'reddit.com', sessions7d: 2, sessionsPrev7d: 8, changeSessions: -6, changePct: -75, changeBasis: 'small-base' }
const PERCENT_SOURCE: GaSourceMover = { source: 'chatgpt.com', sessions7d: 75, sessionsPrev7d: 30, changeSessions: 45, changePct: 150, changeBasis: 'percent' }

function attributionTrend(overrides: Partial<GaAttributionTrendResponse> = {}): GaAttributionTrendResponse {
  return gaAttributionTrendResponseSchema.parse({
    organic: channelTrend(12, -3),
    ai: channelTrend(150, null),
    social: channelTrend(0, 100),
    direct: channelTrend(-100, 7),
    total: channelTrend(1, -1),
    aiBiggestMover: PERCENT_SOURCE,
    socialBiggestMover: SMALL_BASE_SOURCE,
    ...overrides,
  })
}

async function stdoutJson(fn: () => Promise<void>): Promise<Record<string, unknown>> {
  return JSON.parse((await lines(fn)).join('\n')) as Record<string, unknown>
}

describe('ga human output — percentages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('ga traffic prints the server share strings, not a share re-derived from counts', async () => {
    gaTraffic.mockResolvedValue(traffic())
    const out = await lines(() => showGaTraffic('p', {}))
    expect(out).toContain('  AI Sessions (deduped):   123 (12.3% of total)')
    expect(out).toContain('    Paid AI:               4 (0.4% of total)')
    expect(out).toContain('  Social Sessions:         80 (8.0% of total)')
  })

  it('ga traffic keeps an undefined share visibly absent during a partial sync', async () => {
    // Referral rows are synced but the totals that drive the denominator are
    // not: the share is undefined, which the server says with a dash.
    gaTraffic.mockResolvedValue(traffic({ totalSessions: 0, aiSessionsDeduped: 5, paidAiSessionsDeduped: 0, aiSharePctDisplay: '—' }))
    const out = await lines(() => showGaTraffic('p', {}))
    expect(out).toContain('  AI Sessions (deduped):   5 (— of total)')
    expect(out).not.toContain('  AI Sessions (deduped):   5 (0% of total)')
  })

  it('ga social-referral-summary prints the share string and 0..100 trends through formatPercent', async () => {
    gaTraffic.mockResolvedValue(traffic())
    const socialTrend: GaSocialReferralTrendResponse = gaSocialReferralTrendResponseSchema.parse({
      socialSessions7d: 115,
      socialSessionsPrev7d: 100,
      trend7dPct: 15,
      socialSessions30d: 0,
      socialSessionsPrev30d: 0,
      trend30dPct: null,
      biggestMover: { source: 'reddit.com', sessions7d: 4, sessionsPrev7d: 0, changeSessions: 4, changePct: null, changeBasis: 'new' },
    })
    gaSocialReferralTrend.mockResolvedValue(socialTrend)

    expect(await lines(() => gaSocialReferralSummary('p', {}))).toContain('  Sessions: 80 (8.0% of 1000 total)')

    const withTrend = await lines(() => gaSocialReferralSummary('p', { trend: true }))
    expect(withTrend).toContain('  Sessions: 80 (8.0% of 1000 total)')
    expect(withTrend).toContain('  7d trend:  +15.0% (115 vs 100)')
    expect(withTrend).toContain('  30d trend: n/a (0 vs 0)')
    // A source with no sessions last week is new: a change from zero has no percentage.
    expect(withTrend).toContain('  Mover:     reddit.com (new, 0→4)')
    expect(withTrend.find((line) => line.startsWith('  Mover:'))).not.toMatch(/%/)
  })

  it('ga social-referral-summary --trend --format json passes the new mover through with no percentage', async () => {
    gaTraffic.mockResolvedValue(traffic())
    gaSocialReferralTrend.mockResolvedValue(gaSocialReferralTrendResponseSchema.parse({
      socialSessions7d: 9,
      socialSessionsPrev7d: 0,
      trend7dPct: null,
      socialSessions30d: 9,
      socialSessionsPrev30d: 0,
      trend30dPct: null,
      biggestMover: NEW_SOURCE,
    }))
    const out = await stdoutJson(() => gaSocialReferralSummary('p', { trend: true, format: 'json' }))
    expect((out.trend as GaSocialReferralTrendResponse).biggestMover).toEqual({
      source: 'perplexity.ai',
      sessions7d: 9,
      sessionsPrev7d: 0,
      changeSessions: 9,
      changePct: null,
      changeBasis: 'new',
    })
  })

  it('ga attribution --trend keeps every row under the trend headings with six-wide share cells', async () => {
    gaTraffic.mockResolvedValue(traffic())
    gaAttributionTrend.mockResolvedValue(attributionTrend())

    const out = await lines(() => gaAttribution('p', { trend: true }))
    const header = out.find((line) => line.startsWith('  CHANNEL BREAKDOWN'))!
    const row = (label: string) => out.find((line) => line.startsWith(`    ${label}`))!
    expect(row('Organic Search:')).toBe('    Organic Search: 575    ( 57.5%)    +12.0%       -3.0%')
    expect(row('Direct:')).toBe('    Direct:         999    (>99.9%)    -100%        +7.0%')
    expect(row('Social:')).toBe('    Social:         1      ( <0.1%)    +0%          +100%')
    expect(row('Total:')).toBe('    Total:          1000               +1.0%        -1.0%')
    const sevenDay = header.indexOf('7d trend')
    const thirtyDay = header.indexOf('30d trend')
    for (const [label, sevenDayValue, thirtyDayValue] of [
      ['Organic Search:', '+12.0%', '-3.0%'],
      ['Direct:', '-100%', '+7.0%'],
      ['Total:', '+1.0%', '-1.0%'],
    ] as const) {
      expect(row(label).indexOf(sevenDayValue)).toBe(sevenDay)
      expect(row(label).indexOf(thirtyDayValue)).toBe(thirtyDay)
    }
    // A percent on a base of 30 or more; the session change below it (MIN_PCT_BASE).
    expect(out).toContain('  AI Mover:     chatgpt.com (+150.0%, 30→75 sessions/7d)')
    expect(out).toContain('  Social Mover: reddit.com (-6 sessions, 8→2 sessions/7d)')
  })

  it('ga attribution --trend calls a source with no prior sessions new and one that stopped -100%', async () => {
    gaTraffic.mockResolvedValue(traffic())
    gaAttributionTrend.mockResolvedValue(attributionTrend({ aiBiggestMover: NEW_SOURCE, socialBiggestMover: STOPPED_SOURCE }))

    const out = await lines(() => gaAttribution('p', { trend: true }))
    expect(out.filter((line) => line.includes('Mover:'))).toEqual([
      '  AI Mover:     perplexity.ai (new, 0→9 sessions/7d)',
      '  Social Mover: reddit.com (-100%, 40→0 sessions/7d)',
    ])

    const json = await stdoutJson(() => gaAttribution('p', { trend: true, format: 'json' }))
    const trend = json.trend as GaAttributionTrendResponse
    expect(trend.aiBiggestMover).toEqual(NEW_SOURCE)
    expect(trend.aiBiggestMover?.changePct).toBeNull()
    expect(trend.socialBiggestMover).toEqual(STOPPED_SOURCE)
  })
})
