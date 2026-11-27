import { z } from 'zod'
import { metricsWindowSchema, type MetricsWindow } from './analytics.js'
import { shiftIsoCalendarDate } from './formatting.js'
import { isCalendarDate } from './google-ads.js'
import { fraction, roundRatio, RatioUnits } from './ratio-unit.js'
import { windowDays } from './time-window.js'

/**
 * Trend cards: the figures a dashboard tab leads with, each with its readings
 * over the selected window and a change the server computed. The dashboard,
 * `canonry trends` and the MCP tool read this one payload, so a change shown on
 * a card is the same number an agent reads (UI/CLI parity).
 *
 * Every figure here is a LEVEL: a standing count read at its latest date
 * (indexed pages, referring domains, the site score). Its change runs from the
 * first reading inside the window to the latest one, and says so in `basis`.
 */
export const trendSurfaceSchema = z.enum(['index-coverage', 'site-health', 'backlinks'])
export type TrendSurface = z.infer<typeof trendSurfaceSchema>
export const TrendSurfaces = trendSurfaceSchema.enum

/** The window a surface opens on when the caller names none. */
export const TREND_SURFACE_DEFAULT_WINDOW: Readonly<Record<TrendSurface, MetricsWindow>> = {
  'index-coverage': '90d',
  'site-health': 'all',
  backlinks: 'all',
}

export const trendUnitSchema = z.enum(['count', 'score', 'fraction'])
export type TrendUnit = z.infer<typeof trendUnitSchema>
export const TrendUnits = trendUnitSchema.enum

/** Which direction of change is good news. `neither` never colours a change. */
export const trendBetterSchema = z.enum(['higher', 'lower', 'neither'])
export type TrendBetter = z.infer<typeof trendBetterSchema>
export const TrendBetter = trendBetterSchema.enum

export const trendToneSchema = z.enum(['better', 'worse', 'neutral'])
export type TrendTone = z.infer<typeof trendToneSchema>
export const TrendTones = trendToneSchema.enum

export const trendPointSchema = z.object({
  /** Calendar date (YYYY-MM-DD) of the reading; a UTC day for a reading taken at a moment. */
  date: z.string(),
  /**
   * The moment the reading was taken, for readings that are moments (a scan, a
   * backlink query). Show it in the viewer's timezone: its UTC `date` can be the
   * viewer's tomorrow. Null for a reading that is a calendar day (a coverage
   * snapshot).
   */
  observedAt: z.string().nullable(),
  /**
   * What the reading covers when its date alone does not say: a Common Crawl
   * release is a crawl window ("May-Jul 2026"), dated by its last month.
   * Null for a reading its date describes.
   */
  label: z.string().nullable(),
  value: z.number(),
})
export type TrendPoint = z.infer<typeof trendPointSchema>

export const trendChangeSchema = z.object({
  /** The latest reading minus the basis reading, in the figure's own unit (a share's at fraction wire precision). */
  difference: z.number(),
  /** `difference` over the basis reading, at fraction wire precision; null when the basis reading is zero. */
  ratio: fraction().nullable(),
  tone: trendToneSchema,
  /** What the change is measured from: the first reading inside the window. */
  basis: z.object({
    type: z.literal('first-in-window'),
    date: z.string(),
    /** The basis reading's moment, when readings are moments; see `trendPointSchema`. */
    observedAt: z.string().nullable(),
    /** The basis reading's label, when readings carry one; see `trendPointSchema`. */
    label: z.string().nullable(),
  }),
})
export type TrendChange = z.infer<typeof trendChangeSchema>

export const trendFigureSchema = z.object({
  key: z.string(),
  label: z.string(),
  unit: trendUnitSchema,
  better: trendBetterSchema,
  /** The latest reading inside the window; null when the window holds none. */
  value: z.number().nullable(),
  /** Calendar date of `value`. */
  asOf: z.string().nullable(),
  /** Null with fewer than two readings in the window: one reading has nothing to change from. */
  change: trendChangeSchema.nullable(),
  /**
   * Readings inside the window, oldest first. A date without a reading is
   * absent, never zero: a missed sync is not a day with no indexed pages.
   */
  series: z.array(trendPointSchema),
  /**
   * The figure's first reading ever. Window dates before it were never
   * recorded, which a chart shows as such rather than as an empty stretch.
   */
  recordedFrom: z.string().nullable(),
})
export type TrendFigure = z.infer<typeof trendFigureSchema>

export const trendGroupSchema = z.object({
  key: z.string(),
  label: z.string(),
  figures: z.array(trendFigureSchema),
})
export type TrendGroup = z.infer<typeof trendGroupSchema>

export const trendsResponseSchema = z.object({
  project: z.string(),
  surface: trendSurfaceSchema,
  /** The window the span reaches back; null when the caller named a date range instead. */
  window: metricsWindowSchema.nullable(),
  /**
   * Inclusive calendar span every figure in the response covers, ending on the
   * surface's latest reading. Null when the surface has no readings at all.
   */
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  /** Groups with at least one reading ever; a source never connected is left out. */
  groups: z.array(trendGroupSchema),
})
export type TrendsResponse = z.infer<typeof trendsResponseSchema>

/**
 * One stored reading. A reading taken at a moment passes `observedAt` and is
 * kept on its own; calendar-day readings on the same date keep the last given.
 */
export interface TrendReading {
  date: string
  observedAt?: string | null
  label?: string | null
  value: number | null
}

/** A caller's own calendar range; either end may be left to the readings. */
export interface TrendDateRange {
  startDate?: string
  endDate?: string
}

/**
 * The inclusive span a surface's figures share. With a window it ends on the
 * latest reading of any figure and reaches back the window's length, or to the
 * earliest reading for `all`. With a date range it is that range, an open end
 * falling back to the earliest or latest reading. Null when there is no reading
 * at all.
 */
export function trendWindowSpan(
  readingDates: readonly string[],
  selection: MetricsWindow | TrendDateRange,
): { startDate: string; endDate: string } | null {
  const valid = readingDates.map(date => date.slice(0, 10)).filter(isCalendarDate).sort()
  const latest = valid.at(-1)
  if (!latest) return null
  if (typeof selection === 'object') {
    return { startDate: selection.startDate ?? valid[0]!, endDate: selection.endDate ?? latest }
  }
  const days = windowDays(selection)
  const startDate = days === null ? valid[0]! : shiftIsoCalendarDate(latest, -(days - 1))
  return { startDate, endDate: latest }
}

function toneFor(better: TrendBetter, difference: number): TrendTone {
  if (difference === 0 || better === TrendBetter.neither) return TrendTones.neutral
  return (difference > 0) === (better === TrendBetter.higher) ? TrendTones.better : TrendTones.worse
}

/**
 * A level figure over a span: its readings inside the span, the latest one as
 * the value, and the change from the first reading inside the span.
 */
export function buildLevelTrendFigure(input: {
  key: string
  label: string
  unit: TrendUnit
  better: TrendBetter
  readings: readonly TrendReading[]
  span: { startDate: string; endDate: string } | null
}): TrendFigure {
  const byKey = new Map<string, TrendPoint>()
  for (const reading of input.readings) {
    if (reading.value === null || !Number.isFinite(reading.value)) continue
    const date = reading.date.slice(0, 10)
    if (!isCalendarDate(date)) continue
    const observedAt = reading.observedAt ?? null
    byKey.set(observedAt ?? date, { date, observedAt, label: reading.label ?? null, value: reading.value })
  }
  const points = [...byKey.values()].sort((a, b) => (a.observedAt ?? a.date).localeCompare(b.observedAt ?? b.date))
  const recordedFrom = points[0]?.date ?? null
  const series = input.span
    ? points.filter(point => point.date >= input.span!.startDate && point.date <= input.span!.endDate)
    : []
  const first = series[0]
  const last = series.at(-1)
  let change: TrendChange | null = null
  if (first && last && first !== last) {
    // A share's difference is itself a fraction (0.08 = 8 points), so it goes
    // out at the same precision as the shares, without float noise.
    const raw = last.value - first.value
    const difference = input.unit === TrendUnits.fraction ? roundRatio(raw, RatioUnits.fraction) : raw
    change = {
      difference,
      ratio: first.value === 0 ? null : roundRatio(raw / first.value, RatioUnits.fraction),
      tone: toneFor(input.better, difference),
      basis: { type: 'first-in-window', date: first.date, observedAt: first.observedAt, label: first.label },
    }
  }
  return {
    key: input.key,
    label: input.label,
    unit: input.unit,
    better: input.better,
    value: last?.value ?? null,
    asOf: last?.date ?? null,
    change,
    series,
    recordedFrom,
  }
}
