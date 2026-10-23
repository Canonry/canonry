import { GA_OVERVIEW_HISTORY_DAYS, GA_OVERVIEW_WINDOWS, GaOverviewPeriods, gaOverviewComparisonRanges, type GaOverviewWindow } from '@canonry/canonry-contracts'
import { gaDailyTotals, gaWindowMetrics, type DatabaseClient } from '@canonry/canonry-db'

interface DemoDay {
  date: string
  sessions: number
  users: number
  activeUsers: number
  newUsers: number
  organicSessions: number
  views: number
  eventCount: number
  keyEvents: number
  engagementRate: number
  bounceRate: number
  engagementSeconds: number
}

/** Distinct users over a window are fewer than the sum of each day's: people come back. */
const DISTINCT_USER_SHARE: Record<GaOverviewWindow, number> = { '7d': 0.86, '30d': 0.71, '90d': 0.62 }

/** A repeatable 0..1 jitter: the demo must render the same every time, so no Math.random. */
function jitter(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453
  return value - Math.floor(value)
}

function isoDaysAgo(now: Date, days: number): string {
  const value = new Date(now)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

/**
 * One fictional GA4 day: a weekday rhythm, slow growth, a spike in each of the
 * last two months, and a little jitter, so the overview reads like a real
 * property instead of a straight line.
 */
function demoDay(now: Date, daysAgo: number, variant: number): DemoDay {
  const date = isoDaysAgo(now, daysAgo)
  const age = GA_OVERVIEW_HISTORY_DAYS - daysAgo
  const seed = age * 31 + variant * 977
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
  const rhythm = weekday === 0 || weekday === 6 ? 0.72 : weekday === 5 ? 0.95 : 1.07
  const spike = daysAgo === 15 ? 2.3 : daysAgo === 14 ? 1.45 : daysAgo === 47 ? 1.9 : daysAgo === 46 ? 1.25 : 1
  const sessions = Math.round((118 + variant * 14) * (1 + age * 0.0016) * rhythm * spike * (0.9 + 0.2 * jitter(seed)))
  const activeUsers = Math.round(sessions * (0.76 + 0.04 * jitter(seed + 1)))
  const engagementRate = Math.min(0.9, 0.55 + age * 0.0002 + 0.06 * jitter(seed + 2))
  return {
    date,
    sessions,
    users: activeUsers + Math.round(activeUsers * 0.03),
    activeUsers,
    newUsers: Math.round(activeUsers * (0.44 + 0.06 * jitter(seed + 3))),
    organicSessions: Math.round(sessions * (0.58 + 0.05 * jitter(seed + 4))),
    views: Math.round(sessions * (2.05 + 0.3 * jitter(seed + 5))),
    eventCount: Math.round(sessions * (7.2 + 0.8 * jitter(seed + 6))),
    keyEvents: Math.round(sessions * (0.028 + 0.01 * jitter(seed + 7))),
    engagementRate,
    bounceRate: 1 - engagementRate,
    engagementSeconds: activeUsers * (58 + 14 * jitter(seed + 8)),
  }
}

/**
 * The GA4 overview's stored rows for one demo project: every daily total the
 * sync keeps (GA_OVERVIEW_HISTORY_DAYS of complete days), and each window's
 * GA4-style totals for both periods, over the same ranges a real sync asks for.
 */
export function seedGaOverview(
  db: DatabaseClient,
  input: { projectId: string; prefix: string; syncRunId: string; now: Date; variant: number },
): void {
  const { projectId, prefix, syncRunId, now, variant } = input
  const nowIso = now.toISOString()
  const days: DemoDay[] = []
  for (let daysAgo = GA_OVERVIEW_HISTORY_DAYS; daysAgo >= 1; daysAgo--) days.push(demoDay(now, daysAgo, variant))

  for (const row of days) {
    db.insert(gaDailyTotals).values({
      id: `${prefix}-ga-total-${row.date}`,
      projectId,
      date: row.date,
      sessions: row.sessions,
      users: row.users,
      engagementRate: row.engagementRate,
      newUsers: row.newUsers,
      activeUsers: row.activeUsers,
      organicSessions: row.organicSessions,
      views: row.views,
      eventCount: row.eventCount,
      keyEvents: row.keyEvents,
      engagementSeconds: row.engagementSeconds,
      bounceRate: row.bounceRate,
      syncedAt: nowIso,
      syncRunId,
      createdAt: `${row.date}T12:00:00.000Z`,
    }).run()
  }

  for (const windowKey of GA_OVERVIEW_WINDOWS) {
    const ranges = gaOverviewComparisonRanges(windowKey, now)
    for (const [period, range] of [[GaOverviewPeriods.current, ranges.current], [GaOverviewPeriods.previous, ranges.previous]] as const) {
      const inRange = days.filter((row) => row.date >= range.startDate && row.date <= range.endDate)
      const sum = (pick: (row: DemoDay) => number) => inRange.reduce((total, row) => total + pick(row), 0)
      const sessions = sum((row) => row.sessions)
      const activeUsers = Math.round(sum((row) => row.activeUsers) * DISTINCT_USER_SHARE[windowKey])
      const engagementRate = sessions > 0 ? sum((row) => row.engagementRate * row.sessions) / sessions : 0
      db.insert(gaWindowMetrics).values({
        id: `${prefix}-ga-window-metrics-${windowKey}-${period}`,
        projectId,
        windowKey,
        period,
        startDate: range.startDate,
        endDate: range.endDate,
        activeUsers,
        newUsers: sum((row) => row.newUsers),
        totalUsers: activeUsers + Math.round(activeUsers * 0.03),
        sessions,
        organicSessions: sum((row) => row.organicSessions),
        views: sum((row) => row.views),
        eventCount: sum((row) => row.eventCount),
        keyEvents: sum((row) => row.keyEvents),
        engagementRate,
        bounceRate: 1 - engagementRate,
        engagementSeconds: sum((row) => row.engagementSeconds),
        syncedAt: nowIso,
        syncRunId,
      }).run()
    }
  }
}
