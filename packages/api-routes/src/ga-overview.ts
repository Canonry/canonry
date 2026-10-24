import {
  deltaPercent,
  validationError,
  GA_OVERVIEW_METRIC_ORDER,
  inclusiveDayCount,
  isGaOverviewWindow,
  shiftIsoCalendarDate,
  type GaOverviewChange,
  type GaOverviewDay,
  type GaOverviewResponse,
  type GaOverviewValues,
  type GaOverviewWindow,
} from '@canonry/canonry-contracts'


/** The overview's `window` query value: 30d when absent; GA4 comparisons exist for 7d, 30d and 90d only. */
export function parseGaOverviewWindow(value: string | undefined): GaOverviewWindow {
  if (value === undefined || value === '') return '30d'
  if (!isGaOverviewWindow(value)) throw validationError(`Invalid window "${value}": the GA4 overview supports 7d, 30d or 90d.`)
  return value
}

/** One period's totals as `ga_window_metrics` stores them. */
export interface GaOverviewPeriodRow {
  startDate: string
  endDate: string
  activeUsers: number | null
  newUsers: number | null
  totalUsers: number | null
  sessions: number | null
  organicSessions: number | null
  views: number | null
  eventCount: number | null
  keyEvents: number | null
  engagementRate: number | null
  bounceRate: number | null
  engagementSeconds: number | null
  syncedAt: string
}

/** One day as `ga_daily_totals` stores it. `users` is GA4's `totalUsers`. */
export interface GaOverviewDailyRow {
  date: string
  sessions: number
  users: number
  activeUsers: number | null
  newUsers: number | null
  organicSessions: number | null
  views: number | null
  eventCount: number | null
  keyEvents: number | null
  engagementRate: number | null
  bounceRate: number | null
  engagementSeconds: number | null
}

interface Period { startDate: string; endDate: string }

const NO_VALUES: GaOverviewValues = {
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
  averageEngagementTimeSeconds: null,
}

/**
 * A day inside a synced period that GA4 sent no row for: GA4 omits a day with
 * no data, so its counts are zero. Its rates and average engagement time have
 * no sessions to be measured over, so they stay unknown rather than read 0%.
 */
const NO_TRAFFIC_DAY: GaOverviewValues = {
  ...NO_VALUES,
  activeUsers: 0,
  newUsers: 0,
  totalUsers: 0,
  sessions: 0,
  organicSessions: 0,
  views: 0,
  eventCount: 0,
  keyEvents: 0,
}

/**
 * GA4's "Average engagement time": engaged seconds over active users in the
 * same span. Null without both figures, or with no active users to divide by.
 */
function averageEngagementSeconds(engagementSeconds: number | null, activeUsers: number | null): number | null {
  if (engagementSeconds === null || activeUsers === null || activeUsers <= 0) return null
  return engagementSeconds / activeUsers
}

function periodValues(row: GaOverviewPeriodRow | null): GaOverviewValues {
  if (!row) return NO_VALUES
  return {
    activeUsers: row.activeUsers,
    newUsers: row.newUsers,
    totalUsers: row.totalUsers,
    sessions: row.sessions,
    organicSessions: row.organicSessions,
    views: row.views,
    eventCount: row.eventCount,
    keyEvents: row.keyEvents,
    engagementRate: row.engagementRate,
    bounceRate: row.bounceRate,
    averageEngagementTimeSeconds: averageEngagementSeconds(row.engagementSeconds, row.activeUsers),
  }
}

function dayValues(row: GaOverviewDailyRow): GaOverviewValues {
  return {
    activeUsers: row.activeUsers,
    newUsers: row.newUsers,
    totalUsers: row.users,
    sessions: row.sessions,
    organicSessions: row.organicSessions,
    views: row.views,
    eventCount: row.eventCount,
    keyEvents: row.keyEvents,
    engagementRate: row.engagementRate,
    bounceRate: row.bounceRate,
    averageEngagementTimeSeconds: averageEngagementSeconds(row.engagementSeconds, row.activeUsers),
  }
}

function changeOf(totals: GaOverviewValues, previous: GaOverviewValues): GaOverviewChange {
  const change = {} as GaOverviewChange
  for (const key of GA_OVERVIEW_METRIC_ORDER) {
    const current = totals[key]
    const prior = previous[key]
    change[key] = current === null || prior === null ? null : deltaPercent(current, prior)
  }
  return change
}

/**
 * The GA4 overview for one window, from stored rows only.
 *
 * Totals are GA4's own figures for each period (`ga_window_metrics`); the days
 * come from `ga_daily_totals`, each beside the day in the same position of the
 * previous period. When the window has never been synced with the overview
 * metrics, its periods fall back to `fallback` (the ranges a sync would ask
 * for), the totals are unknown, and each day shows whatever older daily rows
 * hold.
 */
export function buildGaOverview(input: {
  window: GaOverviewWindow
  current: GaOverviewPeriodRow | null
  previous: GaOverviewPeriodRow | null
  daily: readonly GaOverviewDailyRow[]
  fallback: { current: Period; previous: Period }
}): GaOverviewResponse {
  const current: Period = input.current ?? input.fallback.current
  const previous: Period = input.previous ?? input.fallback.previous
  // Both periods were drawn by the sync that wrote the window rows, and that
  // same sync replaced every daily row across them, so a missing day there is
  // a day GA4 had no data for. Without window rows nothing says that.
  const synced = input.current !== null && input.previous !== null
  const byDate = new Map(input.daily.map((row) => [row.date, row]))
  const valuesOn = (date: string): GaOverviewValues => {
    const row = byDate.get(date)
    if (row) return dayValues(row)
    return synced ? NO_TRAFFIC_DAY : NO_VALUES
  }

  const dayCount = inclusiveDayCount(current.startDate, current.endDate) ?? 0
  const days: GaOverviewDay[] = []
  for (let index = 0; index < dayCount; index++) {
    const date = shiftIsoCalendarDate(current.startDate, index)
    const previousDate = shiftIsoCalendarDate(previous.startDate, index)
    days.push({ date, previousDate, values: valuesOn(date), previousValues: valuesOn(previousDate) })
  }

  const totals = periodValues(input.current)
  const previousTotals = periodValues(input.previous)
  return {
    window: input.window,
    current: { startDate: current.startDate, endDate: current.endDate },
    previous: { startDate: previous.startDate, endDate: previous.endDate },
    totals,
    previousTotals,
    changePct: changeOf(totals, previousTotals),
    days,
    syncedAt: input.current?.syncedAt ?? null,
  }
}
