import { describe, expect, it } from 'vitest'
import { linearTrend } from '@canonry/canonry-contracts'
import { aiReferralDailyTrend } from '../src/ga.js'

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
