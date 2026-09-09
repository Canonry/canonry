export function formatRatio(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0%'
  return `${(value * 100).toFixed(1)}%`
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString('en-US')
}

export function formatDate(iso: string): string {
  if (!iso) return '—'
  try {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
    const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }
    const d = dateOnly && dateOnly[1] && dateOnly[2] && dateOnly[3]
      ? new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])))
      : new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleDateString('en-US', dateOnly ? { ...options, timeZone: 'UTC' } : options)
  } catch {
    return iso
  }
}

export function formatIsoDate(iso: string): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const yyyy = d.getUTCFullYear()
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(d.getUTCDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
  } catch {
    return iso
  }
}

/**
 * The single place this package asks the platform what a named timezone's wall
 * clock reads. Everything zone-aware below is built on it, so there is one
 * formatter configuration to reason about rather than several near-copies.
 *
 * `hourCycle: 'h23'` is what makes the hour a plain 0-23 number: the default
 * for many locales is a 12-hour clock, which would render midnight as `12`.
 */
function zonedClockFormat(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
}

/** The formatted pieces of a zoned wall clock, keyed by part type. */
function readZonedParts(
  format: Intl.DateTimeFormat,
  date: Date,
): Partial<Record<Intl.DateTimeFormatPartTypes, string>> {
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {}
  for (const part of format.formatToParts(date)) values[part.type] = part.value
  return values
}

interface ZonedClockReading {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/**
 * The wall clock in the formatter's zone at `date` as numbers, or null if any
 * piece of it is missing or unparseable. Callers that only need the calendar
 * date use `readZonedParts` directly, so a missing time part can never cost
 * them a date they could have read.
 */
function readZonedClock(format: Intl.DateTimeFormat, date: Date): ZonedClockReading | null {
  const parts = readZonedParts(format, date)
  const value = (raw: string | undefined): number | null => {
    if (raw === undefined) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }
  const year = value(parts.year)
  const month = value(parts.month)
  const day = value(parts.day)
  const hour = value(parts.hour)
  const minute = value(parts.minute)
  const second = value(parts.second)
  if (year === null || month === null || day === null) return null
  if (hour === null || minute === null || second === null) return null
  return { year, month, day, hour, minute, second }
}

/**
 * `YYYY-MM-DD` for an instant as observed in `timeZone`, not in UTC.
 *
 * Use this, not `formatIsoDate`, whenever the resulting date has to line up
 * with a third party that buckets its data by its own local calendar day. For
 * a zone east of UTC the local day rolls over first, so a UTC-derived date is
 * a whole day behind for part of every day.
 *
 * An unusable input or zone falls back to the UTC date rather than throwing:
 * a window boundary should degrade, not take the request down.
 */
export function formatIsoDateInTimeZone(iso: string, timeZone: string): string {
  if (!iso) return formatIsoDate(iso)
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  try {
    const parts = readZonedParts(zonedClockFormat(timeZone), d)
    const yyyy = parts.year
    const mm = parts.month
    const dd = parts.day
    if (!yyyy || !mm || !dd) return formatIsoDate(iso)
    return `${yyyy}-${mm}-${dd}`
  } catch {
    return formatIsoDate(iso)
  }
}

/**
 * The calendar date `days` days after `isoDate`, both plain `YYYY-MM-DD`.
 *
 * Step a `YYYY-MM-DD` calendar date by `days`, forward or back.
 *
 * Pure calendar arithmetic. `Date.UTC` is only a convenient month/year rollover
 * engine here: UTC has no daylight saving, so adding to its day field cannot
 * gain or lose an hour and cannot land on a different date than a paper
 * calendar would. Doing the same step in milliseconds against a ZONED instant
 * is what produces the off-by-one this exists to prevent, which is why
 * `isoDateDaysBeforeInTimeZone` converts to a calendar date FIRST and steps
 * second.
 *
 * Use this directly when the input is ALREADY a calendar date with no instant
 * behind it — a GSC reporting day, a rollup's `tsHour` date. Those have no
 * clock reading, so there is no zone to resolve and
 * `isoDateDaysBeforeInTimeZone` would be asking a question the value cannot
 * answer.
 *
 * A value that is not a calendar date comes back untouched, so a degraded
 * upstream reading degrades once rather than turning into a wrong date.
 */
/**
 * Every `YYYY-MM-DD` from `startDate` to `endDate`, inclusive.
 *
 * The single source of the CALENDAR INDEX SPACE. Anything that fits, plots, or
 * indexes a dated series must derive its positions from this one function:
 * a series built from "rows that exist" and a fit built from "days that exist"
 * are different index spaces, and mixing them silently rescales the result.
 * That is not hypothetical — a trend fitted over a 10-day calendar and drawn
 * over 4 row positions traversed a third of its range and stopped at the wrong
 * value.
 *
 * `cap` bounds the walk so a corrupt or inverted range cannot spin; a reversed
 * range returns empty, since it names no days.
 */
export function calendarDateRange(startDate: string, endDate: string, cap = 800): string[] {
  const dates: string[] = []
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return dates
  for (let cursor = startDate; cursor <= endDate; cursor = shiftIsoCalendarDate(cursor, 1)) {
    dates.push(cursor)
    if (dates.length >= cap) break
  }
  return dates
}

/**
 * How many calendar days a `YYYY-MM-DD` range covers, counting BOTH ends.
 *
 * The unit a window is labelled in. `2026-03-01`..`2026-03-30` is 30 days, not
 * 29: a window that names 30 dates contains 30 days of data, and an off-by-one
 * here turns a "30 days" label on a response into a claim the numbers do not
 * support. Pure calendar arithmetic on UTC midnights, so no local timezone and
 * no daylight-saving transition can move the count.
 *
 * `null` for a malformed or inverted range — those name no window, and a `0`
 * would read as a real, empty one.
 */
export function inclusiveDayCount(startDate: string, endDate: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return null
  const startMs = Date.parse(`${startDate}T00:00:00.000Z`)
  const endMs = Date.parse(`${endDate}T00:00:00.000Z`)
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null
  // Date.parse normalizes impossible dates (`2026-02-30` -> March 2). A
  // round-trip keeps a well-shaped but invalid boundary from naming a window.
  if (new Date(startMs).toISOString().slice(0, 10) !== startDate) return null
  if (new Date(endMs).toISOString().slice(0, 10) !== endDate) return null
  if (endMs < startMs) return null
  return Math.round((endMs - startMs) / 86_400_000) + 1
}

export function shiftIsoCalendarDate(isoDate: string, days: number): string {
  if (!Number.isFinite(days)) return isoDate
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (!match?.[1] || !match[2] || !match[3]) return isoDate
  const shifted = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + Math.trunc(days),
  ))
  if (Number.isNaN(shifted.getTime())) return isoDate
  const yyyy = shifted.getUTCFullYear()
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(shifted.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * `YYYY-MM-DD` for the calendar date `days` CALENDAR days before the date that
 * `iso` falls on as observed in `timeZone`.
 *
 * Use this for every "N days back" window boundary that is a calendar date. The
 * tempting alternative, subtracting `days × 24h` from the instant and then
 * formatting in the zone, is not calendar arithmetic: a spring-forward local day
 * is 23 hours long and a fall-back local day is 25, so a fixed 24-hour step
 * skips the short day or fails to leave the long one. Concretely, a one-day
 * New York lookback from just after midnight on 2026-03-09 lands on March 7
 * instead of March 8, and from late on 2026-11-01 it lands on November 1 instead
 * of October 31, which silently adds a metric date to the window or drops one.
 *
 * Stepping the CALENDAR instead is exact by construction: the zone decides which
 * date the instant is, and the count is then applied to that date, so no
 * duration is ever converted into a number of days.
 *
 * Degrades the same way the rest of this module does: an unusable zone falls
 * back to the UTC date, and an unusable input comes back unchanged.
 */
export function isoDateDaysBeforeInTimeZone(iso: string, days: number, timeZone: string): string {
  return shiftIsoCalendarDate(formatIsoDateInTimeZone(iso, timeZone), -days)
}

const HOURS_PER_DAY = 24
const ONE_DAY_MS = 24 * 60 * 60 * 1_000

/**
 * Does the wall clock in the formatter's zone ever read exactly
 * `year-month-day hour:00:00`?
 *
 * A local wall-clock time is not guaranteed to exist. On the day a zone springs
 * forward, the clock jumps over a span of local time that no instant maps to.
 * The test is a round trip: guess the instant by removing the zone's offset
 * from the wall time, then ask the zone what that instant actually reads as. A
 * skipped wall time never reads back as itself.
 *
 * The offset has to be sampled a day to either side rather than at the wall
 * time itself, because near a transition the "wrong" side's offset is what
 * lands on the right instant. Both are tried, and a match on either proves
 * existence.
 */
function localHourExists(
  format: Intl.DateTimeFormat,
  year: number,
  month: number,
  day: number,
  hour: number,
): boolean {
  const asIfUtcMs = Date.UTC(year, month - 1, day, hour)
  for (const probeMs of [asIfUtcMs - ONE_DAY_MS, asIfUtcMs + ONE_DAY_MS]) {
    const probeClock = readZonedClock(format, new Date(probeMs))
    if (!probeClock) continue
    const offsetMs = Date.UTC(
      probeClock.year,
      probeClock.month - 1,
      probeClock.day,
      probeClock.hour,
      probeClock.minute,
      probeClock.second,
    ) - probeMs
    const candidate = readZonedClock(format, new Date(asIfUtcMs - offsetMs))
    if (!candidate) continue
    if (
      candidate.year === year && candidate.month === month && candidate.day === day
      && candidate.hour === hour && candidate.minute === 0 && candidate.second === 0
    ) return true
  }
  return false
}

/**
 * `YYYY-MM-DDTHH` for the start of the calendar day `isoDate` as the wall clock
 * in `timeZone` actually runs it: the day's first local hour that EXISTS.
 *
 * Almost always `${isoDate}T00`. It is not in a zone whose daylight-saving
 * transition happens AT midnight, where the clock goes straight from 23:59:59
 * to 01:00:00 and local hour 00 never occurs on that one day of the year
 * (America/Santiago and America/Havana both do this; the set is not fixed, so
 * it is derived from the zone rather than listed). Naming that hour to a third
 * party asks about a wall-clock time its own calendar does not contain, and
 * nothing in the request says what should happen to it. Walking forward to the
 * first hour that does exist asks for the day the zone really has.
 *
 * Degrades to `${isoDate}T00` on an unusable date or zone, and on the rare
 * whole day a zone skips (a date-line move), for the same reason the rest of
 * this module degrades: a window boundary must not take the request down.
 */
export function startOfDayHourInTimeZone(isoDate: string, timeZone: string): string {
  const hourBoundary = (hour: number): string => `${isoDate}T${String(hour).padStart(2, '0')}`
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (!match?.[1] || !match[2] || !match[3]) return hourBoundary(0)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  try {
    const format = zonedClockFormat(timeZone)
    for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
      if (localHourExists(format, year, month, day, hour)) return hourBoundary(hour)
    }
    return hourBoundary(0)
  } catch {
    return hourBoundary(0)
  }
}

/**
 * `YYYY-MM-DDTHH` for where the calendar day AFTER `isoDate` starts on the wall
 * clock in `timeZone`. This is the EXCLUSIVE upper edge of `isoDate` itself.
 *
 * Use it to say where a local day ENDS: whether a bucket is wholly inside a
 * window, how long a local day actually was, where the next one begins.
 *
 * NOT for the upper edge of a live request over the day currently in progress.
 * That edge is by definition in the future, and a third party may refuse it
 * outright rather than clamp it: the OpenAI Ads insights API answers
 * `400: time_ranges.end cannot be in the future`, which fails the whole call.
 * Bound such a request by the CURRENT day's start (`startOfDayHourInTimeZone`)
 * and read the open day some other way.
 *
 * The step is a CALENDAR step, never `+24h`: the local day a zone springs
 * forward on is 23 hours and the one it falls back on is 25, so adding a fixed
 * duration lands on the wrong date around a transition. Where the resulting day
 * actually starts is then resolved by `startOfDayHourInTimeZone`, which is hour
 * 00 except on the one day a year a zone that springs forward AT midnight has
 * no hour 00.
 *
 * Degrades the way the rest of this module does: an unusable date comes back as
 * its own hour 00 rather than throwing, so a window boundary never takes a read
 * down.
 */
export function startOfNextDayHourInTimeZone(isoDate: string, timeZone: string): string {
  return startOfDayHourInTimeZone(shiftIsoCalendarDate(isoDate, 1), timeZone)
}

export function formatDateRange(start: string, end: string): string {
  if (!start && !end) return ''
  if (start && end) return `${formatDate(start)} → ${formatDate(end)}`
  return formatDate(start || end)
}

/** Matches a date-only ISO calendar date with no time component, e.g. "2026-06-30". */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Parse an ISO 8601 date or date-time into epoch milliseconds for use as an
 * INCLUSIVE upper bound on full-timestamp values. A date-only string (no time
 * component, parsed as UTC) is widened to the END of that UTC day
 * (`23:59:59.999`) so the whole day is included rather than just its midnight
 * instant; a date-time keeps its exact instant. Returns `null` when the input
 * cannot be parsed. The inclusive lower bound needs no helper — a date-only
 * value already parses to the day's start (`00:00:00`).
 */
export function parseInclusiveEndMs(iso: string): number | null {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  return DATE_ONLY_PATTERN.test(iso) ? ms + 86_400_000 - 1 : ms
}

export interface DeltaWindow {
  current: number
  prior: number
  deltaPct: number | null
}

/**
 * Signed relative change from `baseline` to `current`, expressed as a ratio.
 * Returns null when either value is non-finite or the baseline is not positive,
 * because a relative change from zero or a negative baseline is undefined for
 * the count and rate metrics that consume this helper.
 */
export function relativeChangeRatio(current: number, baseline: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline <= 0) return null
  const ratio = (current - baseline) / baseline
  return Number.isFinite(ratio) ? ratio : null
}

export function deltaPercent(current: number, prior: number): number | null {
  const ratio = relativeChangeRatio(current, prior)
  return ratio === null ? null : Math.round(ratio * 100)
}

export type DeltaTone = 'positive' | 'negative' | 'neutral'

export function deltaTone(deltaPct: number | null): DeltaTone {
  if (deltaPct === null || deltaPct === 0) return 'neutral'
  return deltaPct > 0 ? 'positive' : 'negative'
}

// Canonical subtitle copy for a "current vs prior window" tile. Used by
// both the SPA and the HTML renderer so they stay verbatim-identical per
// the report-parity rule.
export function formatDeltaCopy(d: DeltaWindow, suffix: string, windowLabel = 'vs prior 7 days'): string {
  if (d.deltaPct === null) {
    return d.prior === 0 ? 'First baseline week' : ''
  }
  if (d.deltaPct > 0) return `Up ${d.deltaPct}% ${windowLabel} (${formatNumber(d.prior)} ${suffix})`
  if (d.deltaPct < 0) return `Down ${Math.abs(d.deltaPct)}% ${windowLabel} (${formatNumber(d.prior)} ${suffix})`
  return `Flat ${windowLabel} (${formatNumber(d.prior)} ${suffix})`
}

/**
 * Smart-percent base threshold. When the PRIOR-window value is at least this
 * large, a delta is expressed as a percentage; below it, a raw rounded delta
 * is shown instead so a tiny base never produces a misleading percentage
 * (e.g. "+50%" off a base of 2). Same rule the Discord orchestrator uses.
 */
export const MIN_PCT_BASE = 30

/** Round to one decimal place: round1(0.3333) → 0.3, round1(3.3333) → 3.3. */
function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * "Smart %" subtitle for an AVERAGE metric (e.g. cited-query count averaged
 * over a rolling window). When the prior average is a large-enough base
 * (`prior >= MIN_PCT_BASE`) and a percentage is computable, render the signed
 * percent — otherwise fall back to a clean rounded raw delta vs the prior
 * average. `deltaPct` is already signed (negative = down); we only add a '+'
 * for positive values.
 *
 * Pure. Shared by the report SPA and HTML renderer so both surfaces produce
 * byte-identical copy per the report-parity rule.
 */
export function formatAverageDelta(d: { deltaAbs: number; prior: number; deltaPct: number | null }): string {
  if (d.prior >= MIN_PCT_BASE && d.deltaPct !== null) {
    const sign = d.deltaPct > 0 ? '+' : ''
    return `${sign}${d.deltaPct}% vs prior`
  }
  const sign = d.deltaAbs > 0 ? '+' : ''
  return `${sign}${round1(d.deltaAbs)} vs ${round1(d.prior)}`
}

/**
 * "Smart %" subtitle for a WINDOW-COUNT metric (e.g. GSC clicks summed over a
 * trailing window vs the prior window). When the prior total is a large-enough
 * base and a percentage is computable, render the signed percent followed by
 * the window label; otherwise render a rounded absolute delta with the count
 * label (`visits`, `clicks`, …) and the window label.
 *
 * Pure. Shared by the report SPA and HTML renderer.
 */
export function formatWindowCountDelta(
  d: { deltaAbs: number; prior: number; deltaPct: number | null },
  countLabel: string,
  windowLabel: string,
): string {
  if (d.prior >= MIN_PCT_BASE && d.deltaPct !== null) {
    const sign = d.deltaPct > 0 ? '+' : ''
    return `${sign}${d.deltaPct}% ${windowLabel}`
  }
  const sign = d.deltaAbs > 0 ? '+' : ''
  return `${sign}${formatNumber(Math.round(d.deltaAbs))} ${countLabel} ${windowLabel}`
}

/**
 * Convert a compact `YYYYMMDD` calendar date to ISO `YYYY-MM-DD`.
 *
 * Google's reporting APIs return the `date` dimension in the compact form
 * while canonry stores and compares ISO dates everywhere. Values that are
 * already ISO (or any other shape) are returned unchanged, so this is safe to
 * apply to a mixed series and safe to re-apply.
 *
 * Pure string surgery — no Date construction, so no timezone can shift the day.
 */
export function compactDateToIso(value: string): string {
  if (value.length !== 8 || !/^\d{8}$/.test(value)) return value
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

/**
 * Parse a GA4 rate metric that the contract bounds to 0..1.
 *
 * `parseOptionalMetric` accepts any finite number, so an out-of-range value
 * from GA4 would pass the client and only fail at the Zod boundary, throwing
 * instead of degrading. An out-of-range rate is not a usable measurement, so it
 * is reported as unavailable rather than as a wrong number or an exception.
 */
export function parseBoundedRate(value: number | null): number | null {
  if (value === null) return null
  return value >= 0 && value <= 1 ? value : null
}


/** A scheduled instant in its configured timezone, with an explicit zone label. */
export function formatZonedTimestamp(iso: string, timeZone = 'UTC'): string | null {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return null
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }
  try {
    return date.toLocaleString('en-US', { ...options, timeZone })
  } catch {
    return date.toLocaleString('en-US', { ...options, timeZone: 'UTC' })
  }
}
