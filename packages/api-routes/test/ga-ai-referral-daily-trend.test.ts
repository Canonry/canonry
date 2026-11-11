import { describe, expect, it } from 'vitest'
import { calendarDateRange, linearTrend } from '@canonry/canonry-contracts'
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

/**
 * Months fold the same deduped days, so each month's sessions are the sum of
 * its days and its engines add up to it. A month counts as complete only when
 * the range and GA4's own history hold all of it and none of it is filling;
 * the line runs through the complete months.
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
  const measured = calendarDateRange('2026-04-27', '2026-11-06')
  const input = (firstAiDate = '2026-04-28') => ({
    days: engineDays.map(({ date, sessions }) => ({ date, sessions })),
    byEngine: {
      series: [{ key: 'chatgpt', label: 'ChatGPT' }, { key: 'claude', label: 'Claude' }, { key: 'gemini', label: 'Gemini' }, { key: 'perplexity', label: 'Perplexity' }],
      days: engineDays.map(({ date, values }) => ({ date, values })),
    },
    measuredDates: measured,
    range: { startDate: '2026-03-01', endDate: null },
    firstAiDate,
    // The AI sync reached every day GA4 reported a site total for.
    aiCoverageStart: '2026-04-27',
    now,
  })

  it('folds days into months with completeness and engines', () => {
    const { months } = aiReferralMonthlySeries(input())
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

  it('fits the complete months, with the change of the fitted line', () => {
    // May to October, 80 rising 10 a month to 130: up 62.5%.
    expect(aiReferralMonthlySeries(input()).monthlyTrend).toEqual({
      slope: 10, intercept: 60, r2: 1, start: 80, end: 130, n: 6, startIndex: 2, endIndex: 7,
      startMonth: '2026-05', endMonth: '2026-10', changePct: 62.5,
    })
  })

  it('keeps a month cut off by the requested end date out of the trend', () => {
    const fixture = input()
    const range = { startDate: '2026-05-01', endDate: '2026-10-15' }
    // The route supplies only rows inside the inclusive requested dates.
    const inRange = (date: string) => date >= range.startDate && date <= range.endDate
    const { months, monthlyTrend } = aiReferralMonthlySeries({
      ...fixture,
      range,
      days: fixture.days.filter(day => inRange(day.date)),
      byEngine: { ...fixture.byEngine, days: fixture.byEngine.days.filter(day => inRange(day.date)) },
      measuredDates: fixture.measuredDates.filter(inRange),
    })
    expect(months.map(month => [month.month, month.sessions, month.complete])).toEqual([
      ['2026-05', 80, true], ['2026-06', 90, true], ['2026-07', 100, true],
      ['2026-08', 110, true], ['2026-09', 120, true], ['2026-10', 130, false],
    ])
    expect(monthlyTrend).toMatchObject({
      n: 5, start: 80, end: 120, slope: 10,
      startMonth: '2026-05', endMonth: '2026-09', changePct: 50,
    })
  })

  it.each([
    { name: 'the last sync stopped midmonth', reportedThrough: '2026-10-15', missingDate: null },
    { name: 'a daily total is missing inside the month', reportedThrough: '2026-11-06', missingDate: '2026-10-15' },
  ])('marks a past month partial when $name', ({ reportedThrough, missingDate }) => {
    const fixture = input()
    const { months, monthlyTrend } = aiReferralMonthlySeries({
      ...fixture,
      days: fixture.days.filter(day => day.date <= reportedThrough),
      byEngine: { ...fixture.byEngine, days: fixture.byEngine.days.filter(day => day.date <= reportedThrough) },
      measuredDates: fixture.measuredDates.filter(date => date <= reportedThrough && date !== missingDate),
    })
    expect(months.find(month => month.month === '2026-10')).toEqual({
      month: '2026-10', sessions: 130, complete: false,
      engines: [{ key: 'chatgpt', label: 'ChatGPT', sessions: 120 }, { key: 'perplexity', label: 'Perplexity', sessions: 10 }],
    })
    expect(monthlyTrend).toMatchObject({
      n: 5, start: 80, end: 120, slope: 10,
      startMonth: '2026-05', endMonth: '2026-09', changePct: 50,
    })
  })

  it('keeps a fully measured first month when its first AI visit arrives midmonth', () => {
    const fixture = input('2026-05-10')
    const firstMeasuredDate = '2026-05-01'
    const { months, monthlyTrend } = aiReferralMonthlySeries({
      ...fixture,
      range: { startDate: null, endDate: null },
      days: fixture.days.filter(day => day.date >= firstMeasuredDate),
      byEngine: { ...fixture.byEngine, days: fixture.byEngine.days.filter(day => day.date >= firstMeasuredDate) },
      measuredDates: fixture.measuredDates.filter(date => date >= firstMeasuredDate),
      aiCoverageStart: firstMeasuredDate,
    })
    expect(months[0]).toEqual({
      month: '2026-05', sessions: 80, complete: true,
      engines: [{ key: 'chatgpt', label: 'ChatGPT', sessions: 70 }, { key: 'claude', label: 'Claude', sessions: 10 }],
    })
    expect(monthlyTrend).toMatchObject({
      n: 6, start: 80, end: 130, slope: 10,
      startMonth: '2026-05', endMonth: '2026-10', changePct: 62.5,
    })
  })

  it('has no line with fewer than two complete months', () => {
    expect(aiReferralMonthlySeries(input('2026-10-01')).monthlyTrend).toBeNull()
  })

  /**
   * GA4 site totals are kept for longer than the AI sync reaches back. Reading
   * them as AI coverage turned months the sync never fetched into months with
   * no AI visits, and made a half-fetched month complete: that half month then
   * anchored the line and inflated its change.
   */
  it('does not read site-total days the AI sync never reached as days without AI visits', () => {
    const fixture = input('2026-05-18')
    const fromJune = (date: string) => date >= '2026-06-01'
    const { months, monthlyTrend } = aiReferralMonthlySeries({
      ...fixture,
      days: [{ date: '2026-05-20', sessions: 40 }, ...fixture.days.filter(day => fromJune(day.date))],
      byEngine: {
        ...fixture.byEngine,
        days: [{ date: '2026-05-20', values: { chatgpt: 40 } }, ...fixture.byEngine.days.filter(day => fromJune(day.date))],
      },
      measuredDates: calendarDateRange('2026-03-01', '2026-11-06'),
      aiCoverageStart: '2026-05-18',
    })
    expect(months.map(m => [m.month, m.sessions, m.complete])).toEqual([
      ['2026-03', null, false],
      ['2026-04', null, false],
      // Only May 18 onward was fetched: a part month, kept off the line.
      ['2026-05', 40, false],
      ['2026-06', 90, true],
      ['2026-07', 100, true],
      ['2026-08', 110, true],
      ['2026-09', 120, true],
      ['2026-10', 130, true],
      ['2026-11', 20, false],
    ])
    // June to October, 90 rising 10 a month to 130. With the half May in the
    // line it would have started at 40.
    expect(monthlyTrend).toEqual({
      slope: 10, intercept: 60, r2: 1, start: 90, end: 130, n: 5, startIndex: 3, endIndex: 7,
      startMonth: '2026-06', endMonth: '2026-10', changePct: 44.444444,
    })
  })

  it('counts a day the AI sync reached before the first AI visit as no visits', () => {
    const fixture = input('2026-05-10')
    const fromMay = (date: string) => date >= '2026-05-01'
    const { months, monthlyTrend } = aiReferralMonthlySeries({
      ...fixture,
      range: { startDate: '2026-04-01', endDate: null },
      days: fixture.days.filter(day => fromMay(day.date)),
      byEngine: { ...fixture.byEngine, days: fixture.byEngine.days.filter(day => fromMay(day.date)) },
      measuredDates: calendarDateRange('2026-04-01', '2026-11-06'),
      aiCoverageStart: '2026-04-01',
    })
    expect(months[0]).toEqual({ month: '2026-04', sessions: 0, complete: true, engines: [] })
    // The line still starts with the first AI visit.
    expect(monthlyTrend).toMatchObject({ n: 6, start: 80, end: 130, startMonth: '2026-05', endMonth: '2026-10' })
  })

  it('has no AI months without AI coverage, even beside site totals', () => {
    const fixture = input()
    const { months, monthlyTrend } = aiReferralMonthlySeries({
      ...fixture,
      days: [],
      byEngine: { ...fixture.byEngine, days: [] },
      firstAiDate: null,
      aiCoverageStart: null,
    })
    expect(months.map(m => m.month)).toEqual(['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'])
    for (const month of months) expect(month).toMatchObject({ sessions: null, complete: false })
    expect(monthlyTrend).toBeNull()
  })
})
