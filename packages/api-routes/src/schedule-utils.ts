/**
 * Schedule preset resolution and cron validation utilities.
 * Lives in api-routes (not contracts) because these are runtime logic functions,
 * not shared data shapes.
 */

import { CronExpressionParser } from 'cron-parser'
import type { CalendarRecurrence } from '@ainyc/canonry-contracts'

const DAY_MAP: Record<string, string> = {
  sun: '0', mon: '1', tue: '2', wed: '3', thu: '4', fri: '5', sat: '6',
}

/**
 * Resolve a schedule preset string to a cron expression.
 *
 * Supported presets:
 *   daily        → 0 6 * * *
 *   weekly       → 0 6 * * 1
 *   twice-daily  → 0 6,18 * * *
 *   daily@HH     → 0 HH * * *
 *   weekly@DAY   → 0 6 * * DAY
 *   weekly@DAY@HH → 0 HH * * DAY
 */
export function resolvePreset(preset: string): string {
  if (preset === 'daily') return '0 6 * * *'
  if (preset === 'weekly') return '0 6 * * 1'
  if (preset === 'twice-daily') return '0 6,18 * * *'

  const dailyMatch = preset.match(/^daily@(\d{1,2})$/)
  if (dailyMatch) {
    const hour = parseInt(dailyMatch[1]!, 10)
    if (hour < 0 || hour > 23) throw new Error(`Invalid hour in preset: ${preset}`)
    return `0 ${hour} * * *`
  }

  const weeklyDayMatch = preset.match(/^weekly@([a-z]{3})$/)
  if (weeklyDayMatch) {
    const day = DAY_MAP[weeklyDayMatch[1]!]
    if (day === undefined) throw new Error(`Invalid day in preset: ${preset}`)
    return `0 6 * * ${day}`
  }

  const weeklyDayHourMatch = preset.match(/^weekly@([a-z]{3})@(\d{1,2})$/)
  if (weeklyDayHourMatch) {
    const day = DAY_MAP[weeklyDayHourMatch[1]!]
    const hour = parseInt(weeklyDayHourMatch[2]!, 10)
    if (day === undefined) throw new Error(`Invalid day in preset: ${preset}`)
    if (hour < 0 || hour > 23) throw new Error(`Invalid hour in preset: ${preset}`)
    return `0 ${hour} * * ${day}`
  }

  throw new Error(`Unknown schedule preset: ${preset}`)
}

/** Validate a cron expression (5-field standard cron). */
export function validateCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false

  const ranges = [
    { min: 0, max: 59 },  // minute
    { min: 0, max: 23 },  // hour
    { min: 1, max: 31 },  // day of month
    { min: 1, max: 12 },  // month
    { min: 0, max: 7 },   // day of week (0 and 7 = Sunday)
  ]

  for (let i = 0; i < 5; i++) {
    if (!validateCronField(parts[i]!, ranges[i]!.min, ranges[i]!.max)) {
      return false
    }
  }
  return true
}

function validateCronField(field: string, min: number, max: number): boolean {
  if (field === '*') return true

  const segments = field.split(',')
  for (const segment of segments) {
    const stepParts = segment.split('/')
    if (stepParts.length > 2) return false
    if (stepParts.length === 2) {
      const step = parseInt(stepParts[1]!, 10)
      if (isNaN(step) || step < 1) return false
    }

    const base = stepParts[0]!
    if (base === '*') continue

    const rangeParts = base.split('-')
    if (rangeParts.length > 2) return false
    for (const part of rangeParts) {
      const num = parseInt(part, 10)
      if (isNaN(num) || num < min || num > max) return false
    }
  }
  return true
}

/** Check whether a timezone identifier is valid using the Intl API. */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * Compute the next fire time of a 5-field cron expression as an ISO-8601 string.
 *
 * This exists because node-cron's own `task.getNextRun()` is broken for
 * day-of-week-constrained expressions: e.g. `0 6 * * 1` (every Monday at 06:00)
 * returns the next January 1st that happens to fall on a Monday — years out —
 * instead of next Monday. A future timestamp corrupts the stored `nextRunAt`
 * AND silently disables the scheduler's downtime catch-up, because a missed
 * slot then never reads as "in the past". node-cron's firing matcher is
 * correct, so the scheduler keeps node-cron for firing and uses cron-parser
 * here for the displayed / catch-up timestamp.
 *
 * @param cronExpr 5-field standard cron expression (e.g. `0 6 * * 1`)
 * @param timezone IANA timezone the cron fields are interpreted in (e.g. `UTC`)
 * @param from     compute the next run strictly after this instant (default: now)
 * @returns ISO-8601 string, or null when the expression or timezone can't be
 *          parsed (callers fall back to null, preserving the prior `?? null`
 *          behavior of `getNextRun()?.toISOString() ?? null`).
 */
export function nextRunFromCron(
  cronExpr: string,
  timezone: string,
  from: Date = new Date(),
): string | null {
  try {
    const interval = CronExpressionParser.parse(cronExpr, {
      currentDate: from,
      tz: timezone,
    })
    return interval.next().toDate().toISOString()
  } catch {
    return null
  }
}


export interface ScheduleTiming {
  cronExpr: string
  timezone: string
  recurrence?: CalendarRecurrence | null
}

const MS_PER_CALENDAR_DAY = 24 * 60 * 60 * 1000

function calendarOrdinal(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const parsed = new Date(`${date}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null
  return Math.floor(parsed.getTime() / MS_PER_CALENDAR_DAY)
}

function dateFromOrdinal(ordinal: number): string | null {
  const date = new Date(ordinal * MS_PER_CALENDAR_DAY)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

/** Date.UTC treats years 0..99 as 1900..1999; calendar anchors do not. */
function utcMillis(year: number, month: number, day: number, hour = 0, minute = 0): number {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, 0, 0)
  return date.getTime()
}

interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function zonedParts(instant: Date, timezone: string): ZonedParts | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(instant)
    const values = Object.fromEntries(parts
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)]))
    const { year, month, day, hour, minute } = values
    return Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)
      && Number.isInteger(hour) && Number.isInteger(minute)
      ? { year: year!, month: month!, day: day!, hour: hour!, minute: minute! }
      : null
  } catch {
    return null
  }
}

function recurrenceDate(recurrence: CalendarRecurrence, timezone: string, ordinal: number): Date | null {
  const date = dateFromOrdinal(ordinal)
  if (!date || !/^\d{2}:\d{2}$/.test(recurrence.time)) return null
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = recurrence.time.split(':').map(Number)
  if ([year, month, day, hour, minute].some(value => value === undefined || Number.isNaN(value))) return null
  const localAsUtc = utcMillis(year!, month!, day!, hour!, minute!)
  const offsets = new Set<number>()
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const probe = new Date(localAsUtc + hours * 60 * 60 * 1000)
    const local = zonedParts(probe, timezone)
    if (!local) continue
    offsets.add(utcMillis(local.year, local.month, local.day, local.hour, local.minute) - probe.getTime())
  }
  const matches = [...offsets]
    .map(offset => new Date(localAsUtc - offset))
    .filter(candidate => {
      const local = zonedParts(candidate, timezone)
      return local?.year === year && local.month === month && local.day === day && local.hour === hour && local.minute === minute
    })
  return matches.length ? new Date(Math.min(...matches.map(candidate => candidate.getTime()))) : null
}

/** Return the next anchored calendar occurrence strictly after `from`. */
export function nextRunFromRecurrence(
  recurrence: CalendarRecurrence,
  timezone: string,
  from: Date = new Date(),
): string | null {
  if (!Number.isInteger(recurrence.everyDays) || recurrence.everyDays < 1 || recurrence.everyDays > 3650 || !isValidTimezone(timezone)) return null
  const anchor = calendarOrdinal(recurrence.startDate)
  if (anchor === null || !/^\d{2}:\d{2}$/.test(recurrence.time)) return null
  const [hour, minute] = recurrence.time.split(':').map(Number)
  if (hour === undefined || minute === undefined || hour > 23 || minute > 59) return null
  const local = zonedParts(from, timezone)
  const localOrdinal = local
    ? calendarOrdinal(`${String(local.year).padStart(4, '0')}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`)
    : null
  if (localOrdinal === null) return null
  let occurrenceIndex = Math.max(0, Math.floor((localOrdinal - anchor) / recurrence.everyDays))
  // A spring-forward gap has no matching instant. Skip that slot while retaining
  // the recurrence's original N-day phase; bound retries for corrupt input.
  for (let attempts = 0; attempts < 8; attempts += 1, occurrenceIndex += 1) {
    const occurrence = recurrenceDate(recurrence, timezone, anchor + occurrenceIndex * recurrence.everyDays)
    if (occurrence && occurrence > from) return occurrence.toISOString()
  }
  return null
}

/** Resolve the next run for either a legacy cron row or a calendar recurrence. */
export function nextRunFromSchedule(schedule: ScheduleTiming, from: Date = new Date()): string | null {
  return schedule.recurrence
    ? nextRunFromRecurrence(schedule.recurrence, schedule.timezone, from)
    : nextRunFromCron(schedule.cronExpr, schedule.timezone, from)
}
