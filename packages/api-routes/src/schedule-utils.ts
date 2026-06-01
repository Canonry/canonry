/**
 * Schedule preset resolution and cron validation utilities.
 * Lives in api-routes (not contracts) because these are runtime logic functions,
 * not shared data shapes.
 */

import { CronExpressionParser } from 'cron-parser'

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
