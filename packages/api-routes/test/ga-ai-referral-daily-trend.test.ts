import { describe, expect, it } from 'vitest'
import { linearTrend } from '@canonry/canonry-contracts'
import { aiReferralDailyTrend, aiReferralMonthlySeries } from '../src/ga.js'

/**
 * GA4 counted AI sessions the same way the whole time, so its fitted line can
 * span days the server count cannot. A day counts once GA4 reported the site's
 * total for it (a missing AI row is then a measured zero); history before the
 * first stored AI row and the two newest days (still filling) are left out.
 */
describe('aiReferralDailyTrend', () => {
  const now = new Date('2026-11-06T15:00:00.000Z')
  const measured = ['2026-10-28', '2026-10-29', '2026-10-30', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']
  const days = [
    { date: '2026-10-28', sessions: 9 },
    { date: '2026-10-29', sessions: 4 },
    { date: '2026-11-01', sessions: 6 },
    { date: '2026-11-02', sessions: 4 },
    { date: '2026-11-03', sessions: 8 },
    { date: '2026-11-04', sessions: 7 },
    { date: '2026-11-05', sessions: 1 },
  ]

  it('fits measured days with absent AI days as zero, keeping calendar gaps', () => {
    const fit = aiReferralDailyTrend(days, measured, '2026-10-29', now)
    // 10-28 predates the first AI row; 10-30 is a measured zero; 10-31 has no
    // GA4 total, so it is a gap; 11-05 and 11-06 are still filling.
    const expected = linearTrend([4, 0, null, 6, 4, 8, 7])!
    expect(fit).toEqual({ ...expected, startDate: '2026-10-29', endDate: '2026-11-04' })
    expect(fit?.n).toBe(6)
  })

  it('returns null without enough complete days', () => {
    expect(aiReferralDailyTrend(days, measured, null, now)).toBeNull()
    expect(aiReferralDailyTrend(days, ['2026-11-04', '2026-11-05', '2026-11-06'], '2026-10-01', now)).toBeNull()
  })
})

describe('aiReferralDailyTrend from the project start', () => {
  it('starts the line at startedOn when it falls after the first AI row', () => {
    const now = new Date('2026-11-06T15:00:00.000Z')
    const days = [
      { date: '2026-10-28', sessions: 9 }, { date: '2026-10-29', sessions: 4 },
      { date: '2026-11-01', sessions: 6 }, { date: '2026-11-02', sessions: 4 },
    ]
    const measured = ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']
    const fit = aiReferralDailyTrend(days, measured, '2026-10-01', now, '2026-10-30')
    expect(fit).toEqual({ ...linearTrend([0, 0, 6, 4, 0])!, startDate: '2026-10-30', endDate: '2026-11-03' })
    // A start date before the first AI row changes nothing.
    expect(aiReferralDailyTrend(days, measured, '2026-10-29', now, '2026-01-01')?.startDate).toBe('2026-10-29')
  })
})

/**
 * Months fold the same deduped days, so each month's sessions are the sum of
 * its days and its engines add up to it. A month counts as complete only when
 * the range and GA4's own history hold all of it and none of it is filling;
 * the line runs through complete months from the start month.
 */
describe('aiReferralMonthlySeries', () => {
  const now = new Date('2026-11-06T15:00:00.000Z')
  const day = (date: string, sessions: number, engines: Record<string, number> = { chatgpt: sessions }) =>
    ({ date, sessions, values: engines })
  const engineDays = [
    day('2026-04-28', 10), // GA4 history starts mid-April: April is not a whole month
    day('2026-05-10', 80, { chatgpt: 70, claude: 10 }),
    day('2026-06-10', 90),
    day('2026-07-10', 100, { chatgpt: 90, gemini: 10 }),
    day('2026-08-10', 110),
    day('2026-09-10', 120),
    day('2026-10-10', 130, { chatgpt: 120, perplexity: 10 }),
    day('2026-11-02', 20), // still running
  ]
  const measured = ['2026-04-27', '2026-04-28', ...['05', '06', '07', '08', '09', '10'].map(m => `2026-${m}-01`), '2026-11-02']
  const input = (startedOn: string | null) => ({
    days: engineDays.map(({ date, sessions }) => ({ date, sessions })),
    byEngine: {
      series: [{ key: 'chatgpt', label: 'ChatGPT' }, { key: 'claude', label: 'Claude' }, { key: 'gemini', label: 'Gemini' }, { key: 'perplexity', label: 'Perplexity' }],
      days: engineDays.map(({ date, values }) => ({ date, values })),
    },
    measuredDates: measured,
    range: { startDate: '2026-03-01', endDate: null },
    firstAiDate: '2026-04-28',
    startedOn,
    now,
  })

  it('folds days into months with completeness and engines', () => {
    const { months } = aiReferralMonthlySeries(input(null))
    expect(months.map(m => [m.month, m.sessions, m.complete])).toEqual([
      ['2026-03', null, false],
      ['2026-04', 10, false],
      ['2026-05', 80, true],
      ['2026-06', 90, true],
      ['2026-07', 100, true],
      ['2026-08', 110, true],
      ['2026-09', 120, true],
      ['2026-10', 130, true],
      ['2026-11', 20, false],
    ])
    expect(months.find(m => m.month === '2026-10')!.engines).toEqual([
      { key: 'chatgpt', label: 'ChatGPT', sessions: 120 },
      { key: 'perplexity', label: 'Perplexity', sessions: 10 },
    ])
    for (const m of months) expect(m.engines.reduce((sum, e) => sum + e.sessions, 0)).toBe(m.sessions ?? 0)
  })

  it('fits complete months from the start month, with the change of the fitted line', () => {
    // Without a start date: May to October, 80 rising 10 a month to 130.
    expect(aiReferralMonthlySeries(input(null)).monthlyTrend).toEqual({
      ...linearTrend([null, null, 80, 90, 100, 110, 120, 130, null])!,
      startMonth: '2026-05', endMonth: '2026-10', changePct: 63,
    })
    // From June 15: June onward, 90 to 130, up 44%.
    expect(aiReferralMonthlySeries(input('2026-06-15')).monthlyTrend).toEqual({
      ...linearTrend([null, null, null, 90, 100, 110, 120, 130, null])!,
      startMonth: '2026-06', endMonth: '2026-10', changePct: 44,
    })
  })

  it('has no line with fewer than two complete months', () => {
    expect(aiReferralMonthlySeries(input('2026-10-01')).monthlyTrend).toBeNull()
  })
})
