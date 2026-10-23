import type { GaOverviewWindow } from '@canonry/canonry-contracts'
import type { GA4DailyTotalRow, GA4DailyTotals, GA4WindowMetrics, GA4WindowMetricsPeriod } from '@canonry/canonry-integration-google-analytics'

type DailyRowInput = Pick<GA4DailyTotalRow, 'date' | 'sessions' | 'users' | 'engagementRate' | 'newUsers'> & Partial<GA4DailyTotalRow>

/**
 * `fetchDailyTotals` as a sync test stubs it: the rows given, each overview
 * figure the test does not name left unknown, over the span the rows cover
 * (one fixed day when there are none).
 */
export function dailyTotals(rows: readonly DailyRowInput[] = []): GA4DailyTotals {
  const dates = rows.map(row => row.date).sort()
  return {
    startDate: dates[0] ?? '2026-01-01',
    endDate: dates.at(-1) ?? '2026-01-01',
    rows: rows.map(row => ({
      activeUsers: null,
      organicSessions: null,
      views: null,
      eventCount: null,
      keyEvents: null,
      engagementSeconds: null,
      bounceRate: null,
      ...row,
    })),
  }
}

const UNKNOWN_PERIOD: Omit<GA4WindowMetricsPeriod, 'startDate' | 'endDate'> = {
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
  engagementSeconds: null,
}

/** `fetchWindowMetrics` with nothing reported, for a sync test about something else. */
export function unknownWindowMetrics(windowKey: GaOverviewWindow): GA4WindowMetrics {
  return {
    windowKey,
    current: { startDate: '2026-01-01', endDate: '2026-01-30', ...UNKNOWN_PERIOD },
    previous: { startDate: '2025-12-02', endDate: '2025-12-31', ...UNKNOWN_PERIOD },
  }
}
