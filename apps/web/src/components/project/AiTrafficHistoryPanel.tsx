/**
 * Daily history of machine and human AI traffic from the server-side lane.
 *
 * Deliberately fed by SERVER traffic only, and rendered as a sibling of the GA4
 * panel rather than inside it: the GA4 panel early-returns a connect prompt when
 * no property is bound, and this data exists with no GA4 at all. Nesting it
 * would hide it from exactly the projects it serves.
 *
 * "Pages crawled" reads `crawlerContentHits`, not `crawlerHits`. The latter
 * counts robots.txt and sitemap re-fetches, which are not pages an engine read.
 */
import { useMemo, useState, type Key } from 'react'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  Legend,
  RechartsTooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
  CHART_AXIS_TICK,
  CHART_AXIS_STROKE,
  CHART_GRID_STROKE,
  CHART_TOOLTIP_STYLE,
  ReferenceArea,
  ReferenceLine,
  CHART_SERIES_COLORS,
  formatChartDateLabel,
  formatChartDateTick,
} from '../shared/ChartPrimitives.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { MetricsWindowPicker } from '../shared/MetricsWindowPicker.js'
import { KpiRow } from './ActivityParts.js'
import { useServerTrafficEvents, useServerTrafficSources } from '../../queries/server-traffic.js'
import { TRAFFIC_STALE_MS } from '../../queries/query-client.js'
// The canonical compact formatter, from contracts. A local copy with a different
// threshold made the same magnitude read "5,000" in one tile and "5.0K" in the
// next. ActivitySection and TrafficPage still carry their own `formatCompact`
// with identical behaviour; folding those into this import is a separate change.
import { formatNumber } from '@canonry/canonry-contracts'
import { getApiV1ProjectsByNameGaAiReferralDailyOptions, getApiV1ProjectsByNameGaStatusOptions } from '@canonry/canonry-api-client/react-query'
import { useQuery } from '@tanstack/react-query'
import { heyClient } from '../../api.js'
import type { GA4AiReferralDailyDto } from '../../api.js'

const CRAWLER_COLOR = CHART_SERIES_COLORS[0]
const FETCH_COLOR = CHART_SERIES_COLORS[1]
const VISIT_COLOR = CHART_SERIES_COLORS[2]
const GA4_COLOR = CHART_SERIES_COLORS[3]
// The measurement-change marker colour the visibility trend uses for setup changes.
const COUNT_CHANGE_COLOR = CHART_SERIES_COLORS[4]

// The shared segmented control is not window-specific; it takes any token
// list. Hand-rolling it again is how the control drifted between tabs before.
const VISIT_SOURCES = ['both', 'server', 'ga4'] as const
type VisitSource = (typeof VISIT_SOURCES)[number]

// Months read the long view (the last year, the start marker, the trend since
// it); days keep the selected window.
const VISIT_GRAINS = ['days', 'months'] as const
type VisitGrain = (typeof VISIT_GRAINS)[number]
const MONTHS_SHOWN = 12
const STARTED_COLOR = 'var(--chart-neutral-text-dim, #a1a1a1)'

const monthDate = (month: string) => new Date(`${month}-01T00:00:00.000Z`)
const formatMonthTick = (month: string) => monthDate(month).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' })
const formatMonthLabel = (month: unknown) =>
  monthDate(String(month)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
const monthIndex = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7))

/**
 * Every numeric field is optional on the wire even though the schema requires
 * it. A deploy can put a newer client in front of an older API for minutes, and
 * this panel crashed exactly that way: the running API had no
 * `crawlerContentHits` on the series and `.toLocaleString()` on undefined took
 * the whole page down. A chart missing a series is a degraded chart; a chart
 * that throws is a blank page.
 */
interface Point {
  bucket: string
  measured?: boolean
  crawlerContentHits?: number
  aiUserFetchHits?: number
  aiReferralLandedHits?: number
}

const LEGEND_STYLE = { fontSize: 12, paddingTop: 6 } as const

/** Trend series carry tooltipType="none": a fitted line's per-point value is
 *  an interpolation ("46.928533333333334"), not a reading, so it has no place
 *  in the tooltip. This formatter guards the remaining series - all counts -
 *  so any future float series still renders as a whole number. */
const formatTooltipValue = (value: unknown) =>
  typeof value === 'number' ? formatNumber(Math.round(value)) : String(value)

const SERVER_VISITS_NAME = 'Visits, server'
/** Hover label for a server visit counted under the older arrival rule. */
const OLDER_SERVER_VISITS_NAME = `${SERVER_VISITS_NAME} (older count)`
/** Hover labels for a month only partly recorded: drawn hollow, off the line. */
const PART_MONTH_SERVER_NAME = `${SERVER_VISITS_NAME} (part month)`
const PART_MONTH_GA4_NAME = 'Visits, GA4 (part month)'

/** Coerce a wire number that an older API may not send at all. */
const num = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

interface Trend { start: number; end: number; startIndex: number; endIndex: number }

/**
 * Two endpoints of a server-fitted line, expanded to a per-point series so
 * Recharts can draw it. The fit itself is NOT computed here: a regression in a
 * chart component is invisible to the CLI and breaks UI/CLI parity.
 */
function trendSeries(trend: Trend | null | undefined, length: number): (number | null)[] {
  if (!trend || length < 2) return Array<number | null>(length).fill(null)
  const span = trend.endIndex - trend.startIndex
  if (span <= 0) return Array<number | null>(length).fill(null)
  const perStep = (trend.end - trend.start) / span
  return Array.from({ length }, (_, i) =>
    i < trend.startIndex || i > trend.endIndex
      ? null
      : trend.start + (i - trend.startIndex) * perStep)
}

/** The GA4 monthly fit's value in a month, or null outside the fitted span. */
function monthlyTrendAt(trend: { startMonth: string; endMonth: string; start: number; end: number } | null | undefined, month: string): number | null {
  if (!trend || month < trend.startMonth || month > trend.endMonth) return null
  const span = monthIndex(trend.endMonth) - monthIndex(trend.startMonth)
  if (span <= 0) return null
  return trend.start + (trend.end - trend.start) * ((monthIndex(month) - monthIndex(trend.startMonth)) / span)
}

/**
 * The GA4 fit's value on a calendar day, or null outside the fitted span. Its
 * ends carry dates rather than chart indices, so it lines up with any window.
 */
function ga4TrendAt(trend: { startDate: string; endDate: string; start: number; end: number } | null, day: string): number | null {
  if (!trend || day < trend.startDate || day > trend.endDate) return null
  const startMs = Date.parse(`${trend.startDate}T00:00:00.000Z`)
  const spanMs = Date.parse(`${trend.endDate}T00:00:00.000Z`) - startMs
  if (spanMs <= 0) return null
  return trend.start + (trend.end - trend.start) * ((Date.parse(`${day}T00:00:00.000Z`) - startMs) / spanMs)
}

/** Leading buckets before recording began, as one band; null when there are none. */
function unmeasuredSpan(points: readonly Point[]): { from: string; to: string } | null {
  // An API that predates `measured` sends undefined; treat that as measured,
  // otherwise the whole chart paints as a "not measured" band.
  const isMeasured = (pt: Point) => pt.measured !== false
  if (points.length === 0 || isMeasured(points[0]!)) return null
  const lastUnmeasured = points.findIndex(isMeasured) - 1
  if (lastUnmeasured < 0) return { from: points[0]!.bucket, to: points[points.length - 1]!.bucket }
  return { from: points[0]!.bucket, to: points[lastUnmeasured]!.bucket }
}

/**
 * Buckets whose server visits were counted by the older arrival rule: from the
 * first measured bucket through the one holding the change (`changedKey`, a day
 * or a month to match the buckets). Never overlaps the "not measured" band.
 */
function olderCountSpan(points: readonly Point[], changedKey: string | undefined): { from: string; to: string } | null {
  if (!changedKey) return null
  const firstMeasured = points.find((pt) => pt.measured !== false)
  const last = points[points.length - 1]?.bucket
  if (!firstMeasured || !last || changedKey < firstMeasured.bucket) return null
  return { from: firstMeasured.bucket, to: changedKey < last ? changedKey : last }
}

/**
 * A LONE reading has no neighbour to draw a segment to. With
 * `connectNulls={false}` and `dot={false}`, Recharts therefore renders it as
 * NOTHING, so a day's visits vanish from a chart whose whole job is visits.
 * This is not an edge case for GA4: days with no referrals are ABSENT rather
 * than zero, so isolated readings are the ordinary shape of a quiet week.
 *
 * Draw a marker exactly where a point stands alone. Two or more in a row still
 * render as a line, so a dense window is not speckled with dots.
 */
function isolatedPointDot(values: readonly (number | null)[], fill: string, hollow = false) {
  return (props: { cx?: number; cy?: number; index?: number; key?: Key | null }) => {
    const { cx, cy, index, key } = props
    const i = index ?? -1
    const alone = values[i] != null && values[i - 1] == null && values[i + 1] == null
    if (!alone || cx === undefined || cy === undefined) return <g key={key} />
    // Hollow: a part-period reading, drawn apart from the full ones it would otherwise dent.
    return hollow
      ? <circle key={key} cx={cx} cy={cy} r={3.2} fill="none" stroke={fill} strokeWidth={1.6} />
      : <circle key={key} cx={cx} cy={cy} r={2.6} fill={fill} stroke="none" />
  }
}

export function AiTrafficHistoryPanel({
  projectName,
  sinceMinutes,
  startedOn = null,
}: {
  projectName: string
  sinceMinutes: number
  /** The project's `startedOn` (YYYY-MM-DD): marked "We started" on the visits chart. */
  startedOn?: string | null
}) {
  const [showFetches, setShowFetches] = useState(true)
  const [showTrend, setShowTrend] = useState(true)
  const [visitSource, setVisitSource] = useState<VisitSource>('both')
  const [visitGrain, setVisitGrain] = useState<VisitGrain>('days')
  const monthly = visitGrain === 'months'
  // The last 12 calendar months, this one included. Fixed at mount so the
  // query key stays stable (see useServerTrafficEvents).
  const monthsRange = useMemo(() => {
    const now = new Date()
    return {
      since: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MONTHS_SHOWN - 1), 1)).toISOString(),
      until: now.toISOString(),
    }
  }, [])
  const monthlyEvents = useServerTrafficEvents(
    projectName,
    { range: monthsRange, granularity: 'month', limit: 1 },
    { enabled: monthly },
  )
  // limit: 1 because this panel reads `series` and never `events`. The default
  // 500 built and shipped ~1,500 event objects per lane that are discarded.
  const events = useServerTrafficEvents(projectName, { sinceMinutes, granularity: 'day', limit: 1 })
  // Connection state is a FACT about configuration, not something to infer from
  // the absence of recorded events. Only the empty state reads it; the query is
  // shared with the sibling traffic panels under the same key.
  const sources = useServerTrafficSources(projectName)
  // The route requires a bound GA4 property and throws without one, so firing
  // unconditionally guaranteed a failed request on every mount for every
  // project with no GA4. `staleTime` matches the sibling panel's, which fetches
  // the same operation under the same key: without it this remounted straight
  // through the shared cache entry.
  const gaStatus = useQuery({
    ...getApiV1ProjectsByNameGaStatusOptions({ client: heyClient, path: { name: projectName } }),
    enabled: Boolean(projectName),
    staleTime: TRAFFIC_STALE_MS,
  })
  const gaConnected = (gaStatus.data as { connected?: boolean } | undefined)?.connected === true
  const gaDaily = useQuery({
    ...getApiV1ProjectsByNameGaAiReferralDailyOptions({
      client: heyClient,
      path: { name: projectName },
      query: { window: sinceMinutes >= 180 * 24 * 60 ? '180d' : sinceMinutes >= 90 * 24 * 60 ? '90d' : sinceMinutes >= 30 * 24 * 60 ? '30d' : '7d' },
    }),
    enabled: Boolean(projectName) && gaConnected,
    staleTime: TRAFFIC_STALE_MS,
  })
  const gaMonthly = useQuery({
    ...getApiV1ProjectsByNameGaAiReferralDailyOptions({
      client: heyClient,
      path: { name: projectName },
      query: { startDate: monthsRange.since.slice(0, 10) },
    }),
    enabled: Boolean(projectName) && gaConnected && monthly,
    staleTime: TRAFFIC_STALE_MS,
  })

  const points: Point[] = useMemo(() => {
    const raw = (events.data as { series?: { points?: Point[] } } | undefined)?.series?.points
    return raw ?? []
  }, [events.data])

  // GA4 days with no referrals are ABSENT, not zero, so a missing day is null
  // rather than 0: the line breaks instead of implying a measured zero.
  const gaByDate = useMemo(() => {
    const dto = gaDaily.data as GA4AiReferralDailyDto | undefined
    return new Map((dto?.days ?? []).map((d) => [d.date, d.sessions]))
  }, [gaDaily.data])
  // Fitted server side over complete GA4 days. GA4 counted the same way the
  // whole time, so its line can span days the server count cannot.
  const gaTrend = (gaDaily.data as GA4AiReferralDailyDto | undefined)?.trend ?? null

  // The stretch before recording began. Charted as a band rather than left to
  // read as a flat zero, which is what an unmeasured day looks like otherwise.
  const unmeasured = useMemo(() => unmeasuredSpan(points), [points])

  const coverageStart = (events.data as { series?: { coverageStart?: string | null } } | undefined)?.series?.coverageStart ?? null

  // Server visits on days before the API's `aiReferralCountingChangedAt` were
  // counted by an older rule that also counted a visitor's later pages, assets
  // and API calls, so they can read high and cannot be recounted. The day the rule
  // changed is included: part of it was counted the old way. Banded from the
  // first measured day, so it never overlaps the "not measured" band. The
  // server-fitted trend already starts after it.
  const countingChangedAt = (events.data as { series?: { aiReferralCountingChangedAt?: string | null } } | undefined)
    ?.series?.aiReferralCountingChangedAt ?? null
  const olderCount = useMemo(() => olderCountSpan(points, countingChangedAt?.slice(0, 10)), [countingChangedAt, points])

  const trends = (events.data as { series?: { trends?: Record<string, Trend | null> } } | undefined)?.series?.trends

  const chartRows = useMemo(() => {
    const crawlTrend = trendSeries(trends?.crawlerContentHits, points.length)
    const fetchTrend = trendSeries(trends?.aiUserFetchHits, points.length)
    const visitTrend = trendSeries(trends?.aiReferralLandedHits, points.length)
    return points.map((pt, i) => ({
      ...pt,
      // Null, not the stored 0. An unmeasured day is the absence of a reading,
      // and spreading `...pt` unchanged drew a solid area flat on zero across
      // the whole pre-coverage band — the exact thing `measured` exists to stop.
      crawlerContentHits: pt.measured !== false ? num(pt.crawlerContentHits) : null,
      aiUserFetchHits: pt.measured !== false ? num(pt.aiUserFetchHits) : null,
      aiReferralLandedHits: pt.measured !== false ? num(pt.aiReferralLandedHits) : null,
      ga4Visits: gaByDate.get(pt.bucket) ?? null,
      ga4Trend: ga4TrendAt(gaTrend, pt.bucket),
      crawlTrend: crawlTrend[i],
      fetchTrend: fetchTrend[i],
      visitTrend: visitTrend[i],
    }))
  }, [points, gaByDate, gaTrend, trends])

  // Months: the same visits by calendar month over the last year. Part-month
  // readings (recording began inside the month, or it is still running) are
  // kept off the line and drawn hollow, as the API names them.
  const monthSeries = (monthlyEvents.data as {
    series?: { points?: Point[]; trends?: Record<string, Trend | null>; partialBuckets?: string[]; aiReferralCountingChangedAt?: string | null }
  } | undefined)?.series
  const gaMonthsDto = gaMonthly.data as GA4AiReferralDailyDto | undefined
  const monthPoints = useMemo(() => monthSeries?.points ?? [], [monthSeries])
  const monthRows = useMemo(() => {
    const partial = new Set(monthSeries?.partialBuckets ?? [])
    const gaMonths = new Map((gaMonthsDto?.months ?? []).map((m) => [m.month, m]))
    const visitTrend = trendSeries(monthSeries?.trends?.aiReferralLandedHits, monthPoints.length)
    const rows = monthPoints.map((pt, i) => {
      const server = pt.measured !== false ? num(pt.aiReferralLandedHits) : null
      const ga = gaMonths.get(pt.bucket)
      return {
        bucket: pt.bucket,
        aiReferralLandedHits: partial.has(pt.bucket) ? null : server,
        serverPartial: partial.has(pt.bucket) ? server : null,
        ga4Visits: ga?.complete ? ga.sessions : null,
        ga4Partial: ga && !ga.complete ? ga.sessions : null,
        visitTrend: visitTrend[i],
        ga4Trend: monthlyTrendAt(gaMonthsDto?.monthlyTrend, pt.bucket),
        recorded: pt.measured !== false || (ga?.sessions ?? null) !== null,
      }
    })
    // Start at the first month either count recorded, as a year of empty
    // months before a new project's first reading says nothing.
    const first = rows.findIndex((row) => row.recorded)
    return first > 0 ? rows.slice(first) : rows
  }, [monthPoints, monthSeries, gaMonthsDto])

  type VisitRow = { bucket: string } & Record<string, unknown>
  const visitRows: VisitRow[] = monthly ? monthRows : chartRows
  // Server recording only: the GA4 view has its own readings inside that span.
  const visitUnmeasured = useMemo(() => {
    if (visitSource === 'ga4') return null
    if (!monthly) return unmeasured
    const shown = new Set(monthRows.map((row) => row.bucket))
    return unmeasuredSpan(monthPoints.filter((pt) => shown.has(pt.bucket)))
  }, [visitSource, monthly, monthPoints, monthRows, unmeasured])
  const visitOlder = useMemo(
    () => (monthly ? olderCountSpan(monthPoints, monthSeries?.aiReferralCountingChangedAt?.slice(0, 7)) : olderCount),
    [monthly, monthPoints, monthSeries, olderCount],
  )
  const olderCountShown = visitOlder !== null && visitSource !== 'ga4'
  // "We started": the project's start day, or its month, when the chart spans it.
  const startedKey = startedOn ? (monthly ? startedOn.slice(0, 7) : startedOn) : null
  const startedShown = startedKey !== null && visitRows.length > 0
    && startedKey >= visitRows[0]!.bucket && startedKey <= visitRows[visitRows.length - 1]!.bucket
  const topRoom = olderCountShown || startedShown

  const visitsTooltipFormatter = (value: unknown, name: unknown, item: { payload?: { bucket?: string } }) => {
    const bucket = item.payload?.bucket
    if (visitOlder && name === SERVER_VISITS_NAME && bucket !== undefined && bucket <= visitOlder.to) {
      return [formatTooltipValue(value), OLDER_SERVER_VISITS_NAME] as [string, string]
    }
    return formatTooltipValue(value)
  }

  // The months strip: the newest complete month's figures, as the API reports them.
  const lastGaMonth = (gaMonthsDto?.months ?? []).filter((m) => m.complete && m.sessions !== null).at(-1) ?? null
  const lastServerMonth = monthRows.filter((r) => r.aiReferralLandedHits !== null).at(-1) ?? null
  const stripMonth = lastGaMonth?.month ?? lastServerMonth?.bucket ?? null
  const stripServer = stripMonth ? monthRows.find((r) => r.bucket === stripMonth)?.aiReferralLandedHits ?? null : null
  const monthlyTrend = gaMonthsDto?.monthlyTrend ?? null

  // Read from the response rather than re-summed here. AGENTS.md UI/CLI parity:
  // a component must not aggregate. The two also disagree — `totals` covers the
  // exact [since, until] instants while a sum of buckets is UTC-day-floored.
  const apiTotals = (events.data as { totals?: Record<string, number> } | undefined)?.totals
  const totalsFromApi = apiTotals && {
    crawlers: num(apiTotals.crawlerContentHits),
    fetches: num(apiTotals.aiUserFetchHits),
    visits: num(apiTotals.aiReferralLandedHits),
  }
  const summed = useMemo(() => points.reduce(
    (acc, p) => ({
      crawlers: acc.crawlers + num(p.crawlerContentHits),
      fetches: acc.fetches + num(p.aiUserFetchHits),
      visits: acc.visits + num(p.aiReferralLandedHits),
    }),
    { crawlers: 0, fetches: 0, visits: 0 },
  ), [points])
  // An API predating `totals.crawlerContentHits` falls back to the sum.
  const totals = totalsFromApi ?? summed

  // A failed request and a quiet window are different facts and must not share a
  // message. The API densifies the window, so a successful empty range returns
  // zero-valued points rather than none: "no activity" is an all-zero series,
  // NOT an absent one. Reading `points.length === 0` as "no activity" showed a
  // request error as a calm "nothing happened".
  const measuredAnything = totals.crawlers > 0 || totals.fetches > 0 || totals.visits > 0

  if (events.isLoading) {
    return <p className="text-copy-14 text-secondary">Loading AI traffic history…</p>
  }
  if (events.isError) {
    return (
      <div className="flex items-center gap-1.5">
        <p role="alert" className="text-copy-14 text-negative">Could not load AI traffic history.</p>
        <InfoTooltip text="The request failed, so this is not a reading of zero activity. Retry, or check the traffic source." />
      </div>
    )
  }
  if (!measuredAnything) {
    // "Nothing connected" and "nothing recorded" are DIFFERENT states, and
    // `coverageStart === null` cannot tell them apart: it is equally true of a
    // source connected an hour ago that has not reported yet. Reading it as the
    // former told an operator to connect a source while the connected badge sat
    // directly above this panel saying one already was. Take the connection fact
    // from the source list; absence of evidence is not evidence of absence.
    // Until that list resolves, claim nothing about connection state.
    const sourceList = sources.data?.sources
    const noSourceConnected = sourceList !== undefined && sourceList.length === 0
    const connectedButSilent = !noSourceConnected && coverageStart === null
    return (
      <div className="flex items-center gap-1.5">
        <p className="text-copy-14 text-secondary">
          {noSourceConnected
            ? 'No server-side traffic source connected yet.'
            : connectedButSilent
              ? 'No AI activity recorded yet.'
              : 'No AI activity recorded in this period.'}
        </p>
        <InfoTooltip
          text={noSourceConnected
            ? 'Connect a traffic source to see how AI engines read this site over time.'
            : connectedButSilent
              ? 'The source is connected but has not reported anything yet. A new source can take a few hours to appear.'
              : 'The window was measured and nothing was recorded. Try a longer range.'}
        />
      </div>
    )
  }

  return (
    <div>
      <div className="mb-5">
        <KpiRow
          label="AI traffic totals"
          items={[
            {
              label: 'AI crawlers',
              value: formatNumber(totals.crawlers),
              detail: 'pages crawled',
              tooltip: 'Requests from AI crawlers for a real content page. Robots.txt and sitemap re-fetches are excluded, because they are not a page an engine read.',
            },
            {
              label: 'AI page fetches',
              value: formatNumber(totals.fetches),
              detail: 'reading a page to answer',
              tooltip: 'An AI engine fetching a page live while answering someone, rather than crawling it for an index.',
            },
            {
              label: 'AI visitors',
              value: formatNumber(totals.visits),
              detail: olderCount ? 'older days may read high' : 'arrived from an AI answer',
              tooltip: 'Visits your server answered that came from an AI engine. Requests answered with a redirect are excluded: a redirect is a hop, not an arrival.'
                + (olderCount
                  ? ` Days through ${formatChartDateLabel(olderCount.to)} were counted by an older rule that also counted a visitor's later pages, so they can read high and cannot be recounted.`
                  : ''),
            },
          ]}
        />
      </div>

      {/* The newest bucket, which is the current UTC day SO FAR, not a rolling
          24 hours. It was labelled "Last 24h" and read near-zero for anyone west
          of UTC during their afternoon, contradicting the chart directly below.
          Labelled for what it actually is, and marked when still filling. */}
      {points.length > 0 && (
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 pb-3 mb-4 border-b border-default text-label-12 text-muted">
          <span className="text-secondary text-label-12-strong">Latest day (UTC)</span>
          <span><span className="text-heading text-label-12-strong tabular-nums mr-1">
            {num(points[points.length - 1]!.crawlerContentHits).toLocaleString()}</span>pages crawled</span>
          <span><span className="text-heading text-label-12-strong tabular-nums mr-1">
            {num(points[points.length - 1]!.aiUserFetchHits).toLocaleString()}</span>page fetches</span>
          <span><span className="text-heading text-label-12-strong tabular-nums mr-1">
            {num(points[points.length - 1]!.aiReferralLandedHits).toLocaleString()}</span>visits, server</span>
          <span><span className="text-heading text-label-12-strong tabular-nums mr-1">
            {gaByDate.get(points[points.length - 1]!.bucket)?.toLocaleString() ?? '—'}</span>visits, GA4</span>
          <span className="text-faint">still filling</span>
        </div>
      )}

      <div className="mb-2 flex items-center justify-between gap-3">
        {/* Tooltip is a SIBLING of the heading: nesting an interactive button
            inside <h3> changes the heading's accessible name. */}
        <div className="flex items-center gap-1.5">
          <h3 className="text-heading-14 text-heading">Machines reading your site</h3>
          <InfoTooltip text="Crawlers index pages for later. Page fetches happen while an engine is answering someone. Both are machines, not people." />
        </div>
        <div className="flex items-center gap-4">
        <label className="flex items-center gap-1.5 text-label-12 text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={showFetches}
            onChange={(e) => setShowFetches(e.target.checked)}
            className="accent-current"
          />
          Page fetches
        </label>
        <label className="flex items-center gap-1.5 text-label-12 text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={showTrend}
            onChange={(e) => setShowTrend(e.target.checked)}
            className="accent-current"
          />
          Trend line
        </label>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={206}>
        <ComposedChart data={chartRows} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid stroke={CHART_GRID_STROKE} vertical={false} />
          <XAxis dataKey="bucket" tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE}
                 tickFormatter={formatChartDateTick} minTickGap={28} />
          <YAxis tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} width={48} allowDecimals={false} />
          <RechartsTooltip contentStyle={CHART_TOOLTIP_STYLE.contentStyle}
                           labelStyle={CHART_TOOLTIP_STYLE.labelStyle}
                           itemStyle={CHART_TOOLTIP_STYLE.itemStyle}
                           labelFormatter={formatChartDateLabel}
                           formatter={formatTooltipValue} />
          {unmeasured && (
            <ReferenceArea x1={unmeasured.from} x2={unmeasured.to} fill="var(--color-overlay-hover)"
                           fillOpacity={0.5} stroke="none"
                           label={{ value: 'not measured', position: 'insideTop', fontSize: 12, fill: 'var(--chart-neutral-text-dim, #a1a1a1)' }} />
          )}
          <Legend wrapperStyle={LEGEND_STYLE} iconType="plainline" iconSize={14} />
          <Area type="monotone" dataKey="crawlerContentHits" name="Pages crawled"
                stroke={CRAWLER_COLOR} fill={CRAWLER_COLOR} fillOpacity={0.22} strokeWidth={1.8} />
          {showFetches && (
            <Area type="monotone" dataKey="aiUserFetchHits" name="Page fetches"
                  stroke={FETCH_COLOR} fill={FETCH_COLOR} fillOpacity={0.18} strokeWidth={1.6} />
          )}
          {showTrend && (
            <Line type="linear" dataKey="crawlTrend" legendType="none" name="Pages crawled trend" dot={false} tooltipType="none"
                  stroke={CRAWLER_COLOR} strokeWidth={1.4} strokeDasharray="5 4" connectNulls />
          )}
          {showTrend && showFetches && (
            <Line type="linear" dataKey="fetchTrend" legendType="none" name="Page fetches trend" dot={false} tooltipType="none"
                  stroke={FETCH_COLOR} strokeWidth={1.3} strokeDasharray="5 4" connectNulls />
          )}
        </ComposedChart>
      </ResponsiveContainer>

      <div className="flex items-center justify-between gap-3 mt-5 mb-2">
        <div className="flex items-center gap-1.5">
          <h3 className="text-heading-14 text-heading">People arriving from AI</h3>
          <InfoTooltip text="Two independent counts of the same thing. Server reads your own logs and misses nothing a browser blocks, but cannot see a page served from cache. GA4 needs the browser to run a tag. They rarely match, and neither is the correction of the other." />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <MetricsWindowPicker
            windows={VISIT_GRAINS}
            value={visitGrain}
            onChange={setVisitGrain}
            label="Visits by day or month"
            formatOption={(grain) => (grain === 'months' ? 'Months' : 'Days')}
          />
          <MetricsWindowPicker
            windows={VISIT_SOURCES}
            value={visitSource}
            onChange={setVisitSource}
            label="Visit measurement source"
            formatOption={(src) => (src === 'ga4' ? 'GA4' : src === 'both' ? 'Both' : 'Server')}
          />
        </div>
      </div>
      {monthly && stripMonth && (
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 pb-3 mb-3 text-label-12 text-muted">
          <span className="text-secondary text-label-12-strong">{formatMonthLabel(stripMonth)}</span>
          {visitSource !== 'server' && lastGaMonth?.month === stripMonth && (
            <span><span className="text-heading text-label-12-strong tabular-nums mr-1">
              {formatNumber(lastGaMonth.sessions ?? 0)}</span>visits, GA4</span>
          )}
          {visitSource !== 'ga4' && stripServer !== null && (
            <span><span className="text-heading text-label-12-strong tabular-nums mr-1">
              {formatNumber(stripServer)}</span>visits, server</span>
          )}
          {visitSource !== 'server' && monthlyTrend?.changePct != null && (
            <span><span className="text-heading text-label-12-strong tabular-nums mr-1">
              {monthlyTrend.changePct > 0 ? '▲' : monthlyTrend.changePct < 0 ? '▼' : ''}{Math.abs(monthlyTrend.changePct)}%</span>
              since {formatMonthTick(monthlyTrend.startMonth)}</span>
          )}
          {visitSource !== 'server' && lastGaMonth?.month === stripMonth && lastGaMonth.engines[0] && (
            <span><span className="text-heading text-label-12-strong tabular-nums mr-1">
              {formatNumber(lastGaMonth.engines[0].sessions)}</span>from {lastGaMonth.engines[0].label}</span>
          )}
        </div>
      )}
      <ResponsiveContainer width="100%" height={topRoom ? 192 : 176}>
        {/* Extra top margin holds the older-count and start labels above the
            plot, where the line can never run through them. */}
        <ComposedChart data={visitRows} margin={{ top: topRoom ? 20 : 4, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid stroke={CHART_GRID_STROKE} vertical={false} />
          <XAxis dataKey="bucket" tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE}
                 tickFormatter={monthly ? formatMonthTick : formatChartDateTick} minTickGap={monthly ? 8 : 28} />
          <YAxis tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} width={48} allowDecimals={false} />
          <RechartsTooltip contentStyle={CHART_TOOLTIP_STYLE.contentStyle}
                           labelStyle={CHART_TOOLTIP_STYLE.labelStyle}
                           itemStyle={CHART_TOOLTIP_STYLE.itemStyle}
                           labelFormatter={monthly ? formatMonthLabel : formatChartDateLabel}
                           formatter={visitsTooltipFormatter} />
          {/* A one-bucket span has no width to shade, and its label would spill off the plot. */}
          {visitUnmeasured && visitUnmeasured.from !== visitUnmeasured.to && (
            <ReferenceArea x1={visitUnmeasured.from} x2={visitUnmeasured.to} fill="var(--color-overlay-hover)"
                           fillOpacity={0.5} stroke="none"
                           label={{ value: 'not measured', position: 'insideTop', fontSize: 12, fill: 'var(--chart-neutral-text-dim, #a1a1a1)' }} />
          )}
          {/* Only where the server line is drawn: GA4 never used this rule. The
              dashed line marks the day the count changed, so the boundary reads
              even where the shading is faint. */}
          {visitOlder && olderCountShown && (
            <ReferenceArea x1={visitOlder.from} x2={visitOlder.to} fill="var(--color-overlay-hover)"
                           fillOpacity={0.3} stroke="none"
                           label={{ value: 'older server count, may read high', position: 'top', fontSize: 12, fill: 'var(--chart-neutral-text-dim, #a1a1a1)' }} />
          )}
          {visitOlder && olderCountShown && (
            <ReferenceLine x={visitOlder.to} stroke={COUNT_CHANGE_COLOR} strokeDasharray="4 4" strokeWidth={1.5} />
          )}
          {startedShown && (
            <ReferenceLine x={startedKey!} stroke={STARTED_COLOR} strokeDasharray="3 3" strokeWidth={1.2}
                           label={{ value: 'We started', position: 'insideTopRight', fontSize: 11, fill: STARTED_COLOR }} />
          )}
          <Legend wrapperStyle={LEGEND_STYLE} iconType="plainline" iconSize={14} />
          {visitSource !== 'ga4' && (
            <Line type="monotone" dataKey="aiReferralLandedHits" name={SERVER_VISITS_NAME}
                  stroke={VISIT_COLOR} strokeWidth={2} connectNulls={false}
                  dot={monthly ? isolatedPointDot(visitRows.map((r) => (r.aiReferralLandedHits as number | null) ?? null), VISIT_COLOR) : false} />
          )}
          {monthly && visitSource !== 'ga4' && (
            <Line type="monotone" dataKey="serverPartial" name={PART_MONTH_SERVER_NAME} legendType="none" connectNulls={false}
                  stroke={VISIT_COLOR} strokeWidth={0} activeDot={false}
                  dot={isolatedPointDot(visitRows.map((r) => (r.serverPartial as number | null) ?? null), VISIT_COLOR, true)} />
          )}
          {visitSource !== 'server' && (
            <Line type="monotone" dataKey="ga4Visits" name="Visits, GA4" connectNulls={false}
                  stroke={GA4_COLOR} strokeWidth={1.8} strokeDasharray="5 3"
                  dot={isolatedPointDot(visitRows.map((r) => (r.ga4Visits as number | null) ?? null), GA4_COLOR)} />
          )}
          {monthly && visitSource !== 'server' && (
            <Line type="monotone" dataKey="ga4Partial" name={PART_MONTH_GA4_NAME} legendType="none" connectNulls={false}
                  stroke={GA4_COLOR} strokeWidth={0} activeDot={false}
                  dot={isolatedPointDot(visitRows.map((r) => (r.ga4Partial as number | null) ?? null), GA4_COLOR, true)} />
          )}
          {showTrend && visitSource !== 'ga4' && (
            <Line type="linear" dataKey="visitTrend" legendType="none" name="Visits trend" dot={false} tooltipType="none"
                  stroke={VISIT_COLOR} strokeWidth={1.3} strokeDasharray="5 4" connectNulls />
          )}
          {showTrend && visitSource !== 'server' && (
            // Dotted, not dashed: the GA4 visits line is already dashed.
            <Line type="linear" dataKey="ga4Trend" legendType="none" name="GA4 visits trend" dot={false} tooltipType="none"
                  stroke={GA4_COLOR} strokeWidth={1.6} strokeDasharray="1 4" strokeLinecap="round" connectNulls />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
