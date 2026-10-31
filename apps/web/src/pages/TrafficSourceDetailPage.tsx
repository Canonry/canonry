import { useEffect, useMemo, useState } from 'react'
import { Link, useCanGoBack, useParams } from '@tanstack/react-router'
import { ArrowLeft, ChevronLeft, ChevronRight, RefreshCw, X } from 'lucide-react'

import {
  TrafficEventKinds,
  type TrafficEventEntry,
  type TrafficSeriesPoint,
} from '@canonry/canonry-contracts'

import { isEmbed } from '../api.js'
import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { InfoTooltip } from '../components/shared/InfoTooltip.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { extractErrorMessage } from '../lib/extract-error-message.js'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  CHART_AXIS_STROKE,
  CHART_AXIS_TICK,
  CHART_GRID_STROKE,
  CHART_SERIES_COLORS,
  CHART_TOOLTIP_STYLE,
  RechartsTooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from '../components/shared/ChartPrimitives.js'
import {
  toneFromTrafficSourceStatus,
  useServerTrafficEvents,
  useServerTrafficSource,
  useSyncServerTrafficSource,
} from '../queries/server-traffic.js'
import { localTimeZoneLabel } from '../lib/format-helpers.js'
import {
  bucketForChartClick,
  filterTrafficEvents,
  identityOf,
  pathOf,
  STATUS_CLASS_OPTIONS,
  VERIFICATION_OPTIONS,
  type EventGranularity,
  type StatusClassFilter,
  type VerificationFilter,
} from '../lib/traffic-event-filter.js'

type SeriesKind = 'crawler' | 'ai-user-fetch' | 'ai-referral'
type Granularity = EventGranularity

interface WindowOption {
  value: number
  label: string
  granularity: Granularity
  fetchLimit: number
}

const WINDOW_OPTIONS: readonly WindowOption[] = [
  { value: 60, label: '1h', granularity: 'hour', fetchLimit: 500 },
  { value: 6 * 60, label: '6h', granularity: 'hour', fetchLimit: 500 },
  { value: 24 * 60, label: '24h', granularity: 'hour', fetchLimit: 500 },
  { value: 7 * 24 * 60, label: '7d', granularity: 'hour', fetchLimit: 1000 },
  { value: 30 * 24 * 60, label: '30d', granularity: 'day', fetchLimit: 2000 },
  { value: 90 * 24 * 60, label: '90d', granularity: 'day', fetchLimit: 5000 },
] as const

const DEFAULT_WINDOW = WINDOW_OPTIONS.find((w) => w.label === '24h') ?? WINDOW_OPTIONS[2]

const EVENTS_PAGE_SIZE = 50

const CRAWLER_COLOR = CHART_SERIES_COLORS[0]
const AI_USER_FETCH_COLOR = CHART_SERIES_COLORS[2]
const AI_REFERRAL_COLOR = CHART_SERIES_COLORS[1]

/** The viewer's timezone — hour labels on this page are rendered in local time. */
const LOCAL_TZ = localTimeZoneLabel()

function formatHourLabel(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00`
}

function formatDayLabel(yyyymmdd: string): string {
  const d = new Date(`${yyyymmdd}T00:00:00`)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * Which event kind to ASK THE SERVER for, given the series the user has on.
 *
 * Exported for test: this one value decides whether a narrow series is
 * reachable at all. The events fetch is row-capped, so requesting 'all' returns
 * the most recent N rows across every series and the browser then filters them.
 * Where one series dominates, the others never make the cut and the table
 * reports an honest but misleading "no rows".
 */
export function trafficFetchKind(visibleSeries: ReadonlySet<SeriesKind>): 'all' | SeriesKind {
  // Exactly one selected is both the case that breaks and the case where the
  // caller has already told us what it wants. Zero or several means the union,
  // which is what 'all' returns anyway.
  return visibleSeries.size === 1 ? [...visibleSeries][0]! : 'all'
}

/**
 * "← Back" affordance on the source detail page. Prefers browser history
 * (so a user arriving from `/projects/$id/activity` goes back to that
 * tab, not to /traffic) and falls back to a hard `/traffic` link when
 * there's no prior in-app history (deep-link, page refresh, opened in a
 * new tab). The label tracks the behavior — "Back" when popping
 * history, "All sources" when falling back to the list.
 */
function BackLink({
  canGoBack,
  className,
}: {
  canGoBack: boolean
  className?: string
}) {
  const baseClasses = 'inline-flex items-center gap-1'
  if (canGoBack) {
    // TanStack Router's `router.history.back()` is typed `any` by its
    // generics (trips the no-unsafe-call lint rule). `window.history.back()`
    // is equivalent — the router's history adapter delegates to the same
    // browser history object — and is fully typed.
    const handleBack = () => {
      window.history.back()
    }
    return (
      <button
        type="button"
        onClick={handleBack}
        className={`${baseClasses} ${className ?? ''}`}
      >
        <ArrowLeft className="size-3" /> Back
      </button>
    )
  }
  return (
    <Link to="/traffic" className={`${baseClasses} ${className ?? ''}`}>
      <ArrowLeft className="size-3" /> All sources
    </Link>
  )
}

export function TrafficSourceDetailPage() {
  const params = useParams({ strict: false }) as { projectName?: string; sourceId?: string }
  const projectName = params.projectName ?? ''
  // `useCanGoBack` reports whether the browser-history-style back action
  // would land on a previous in-app page. Avoids the dead-end case where
  // the user landed on this page directly (deep link, refresh) — there's
  // no prior history entry, so we render a deterministic Link to /traffic
  // instead of a back button that would no-op or leave the app.
  const canGoBack = useCanGoBack()
  const sourceId = params.sourceId ?? ''

  const [windowMinutes, setWindowMinutes] = useState<number>(DEFAULT_WINDOW.value)
  const [visibleSeries, setVisibleSeries] = useState<Set<SeriesKind>>(
    () => new Set<SeriesKind>(['crawler', 'ai-user-fetch', 'ai-referral']),
  )
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null)
  const [identityFilter, setIdentityFilter] = useState<string>('')
  const [operatorFilter, setOperatorFilter] = useState<string>('')
  const [pathFilter, setPathFilter] = useState<string>('')
  const [statusClassFilter, setStatusClassFilter] = useState<StatusClassFilter>('all')
  const [verificationFilter, setVerificationFilter] = useState<VerificationFilter>('all')
  const [eventsPage, setEventsPage] = useState<number>(1)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<string | null>(null)

  const activeWindow = useMemo<WindowOption>(
    () => WINDOW_OPTIONS.find((w) => w.value === windowMinutes) ?? DEFAULT_WINDOW,
    [windowMinutes],
  )

  // Ask the server for the series the user is actually looking at.
  //
  // `kind: 'all'` with a 500-row cap made the series checkboxes cosmetic: the
  // fetch returned the 500 most RECENT rows regardless of selection, then the
  // table filtered them in the browser. On a source where one series dominates
  // that hides the others entirely. Measured on a live project: 2,199 crawler
  // rows against 8 AI-referral rows in 24h, and every AI-referral row sat at
  // position 640 or later, so none were ever fetched. The chart aggregates
  // server-side and drew the bar correctly; clicking it filtered a set that had
  // never contained the rows, and the table truthfully reported "0 of 0".
  //
  // A single selected series is the case worth scoping, and it is the case that
  // breaks: the caller already knows it wants one narrow slice. With several
  // selected the union is what 'all' already returns.
  const selectedKind = useMemo(() => trafficFetchKind(visibleSeries), [visibleSeries])

  const sourceQuery = useServerTrafficSource(projectName || null, sourceId || null)
  const eventsQuery = useServerTrafficEvents(projectName || null, {
    kind: selectedKind,
    sourceId: sourceId || undefined,
    sinceMinutes: windowMinutes,
    limit: activeWindow.fetchLimit,
    granularity: activeWindow.granularity,
  })
  const sync = useSyncServerTrafficSource(projectName || null, sourceId || null)

  const detail = sourceQuery.data
  const allEvents = eventsQuery.data?.events ?? []
  const totals = eventsQuery.data?.totals
  const eventRows = eventsQuery.data?.eventRows

  const visibleEvents = useMemo(
    () =>
      allEvents.filter((event) => {
        switch (event.kind) {
          case TrafficEventKinds.crawler: return visibleSeries.has('crawler')
          case TrafficEventKinds['ai-user-fetch']: return visibleSeries.has('ai-user-fetch')
          case TrafficEventKinds['ai-referral']: return visibleSeries.has('ai-referral')
        }
      }),
    [allEvents, visibleSeries],
  )

  const identityOptions = useMemo(() => {
    const set = new Set<string>()
    for (const e of allEvents) set.add(identityOf(e))
    if (identityFilter) set.add(identityFilter)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [allEvents, identityFilter])

  const operatorOptions = useMemo(() => {
    const set = new Set<string>()
    for (const e of allEvents) set.add(e.operator)
    if (operatorFilter) set.add(operatorFilter)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [allEvents, operatorFilter])

  const filteredEvents = useMemo(
    () =>
      filterTrafficEvents(
        visibleEvents,
        {
          selectedBucket,
          identity: identityFilter,
          operator: operatorFilter,
          pathQuery: pathFilter,
          statusClass: statusClassFilter,
          verification: verificationFilter,
        },
        activeWindow.granularity,
      ),
    [visibleEvents, selectedBucket, identityFilter, operatorFilter, pathFilter, statusClassFilter, verificationFilter, activeWindow.granularity],
  )

  // Reset to page 1 whenever the underlying event slice changes — filter
  // tweaks, series toggles, or a different time window — so the user doesn't
  // land on a stale (now empty) page after a filter narrows the result set.
  useEffect(() => {
    setEventsPage(1)
  }, [
    visibleEvents,
    selectedBucket,
    identityFilter,
    operatorFilter,
    pathFilter,
    statusClassFilter,
    verificationFilter,
  ])

  const totalEventsPages = Math.max(1, Math.ceil(filteredEvents.length / EVENTS_PAGE_SIZE))
  const currentEventsPage = Math.min(Math.max(1, eventsPage), totalEventsPages)
  const eventsPageStart = (currentEventsPage - 1) * EVENTS_PAGE_SIZE
  const pagedEvents = useMemo(
    () => filteredEvents.slice(eventsPageStart, eventsPageStart + EVENTS_PAGE_SIZE),
    [filteredEvents, eventsPageStart],
  )
  const showPagination = filteredEvents.length > EVENTS_PAGE_SIZE
  const pageRangeStart = filteredEvents.length === 0 ? 0 : eventsPageStart + 1
  const pageRangeEnd = Math.min(eventsPageStart + EVENTS_PAGE_SIZE, filteredEvents.length)

  const selectedBucketLabel = useMemo(
    () => (selectedBucket ? bucketLabelFor(selectedBucket, activeWindow.granularity) : null),
    [selectedBucket, activeWindow.granularity],
  )

  const chartData = useMemo(
    () => buildChartData(eventsQuery.data?.series.points ?? [], activeWindow.granularity),
    [eventsQuery.data?.series.points, activeWindow.granularity],
  )

  const toggleSeries = (series: SeriesKind) => {
    setVisibleSeries((prev) => {
      const next = new Set(prev)
      if (next.has(series)) {
        if (next.size > 1) next.delete(series)
      } else {
        next.add(series)
      }
      return next
    })
  }

  const handleChartClick = (state: unknown) => {
    const bucket = bucketForChartClick(state, chartData)
    if (!bucket) return
    setSelectedBucket((prev) => (prev === bucket ? null : bucket))
  }

  const clearAllFilters = () => {
    setSelectedBucket(null)
    setIdentityFilter('')
    setOperatorFilter('')
    setPathFilter('')
    setStatusClassFilter('all')
    setVerificationFilter('all')
  }

  const hasRowFilter = Boolean(
    selectedBucket
      || identityFilter
      || operatorFilter
      || pathFilter.trim()
      || statusClassFilter !== 'all'
      || verificationFilter !== 'all',
  )

  const handleSync = async () => {
    setSyncError(null)
    setSyncResult(null)
    try {
      const result = await sync.mutateAsync({ sinceMinutes: 60 })
      setSyncResult(
        `Pulled ${result.pulledEvents} entries · ${result.crawlerHits} crawler · ${result.aiUserFetchHits} AI user fetch · ${result.aiReferralHits} AI referral · ${result.unknownHits} unknown`,
      )
    } catch (e) {
      setSyncError(extractErrorMessage(e))
    }
  }

  if (!projectName || !sourceId) {
    return (
      <div className="page-container">
        <p className="text-copy-14 text-muted">Missing project name or source id in URL.</p>
      </div>
    )
  }

  if (sourceQuery.isLoading) {
    return (
      <div className="page-container">
        <p className="text-copy-14 text-muted">Loading source…</p>
      </div>
    )
  }

  if (sourceQuery.isError || !detail) {
    return (
      <div className="page-container">
        <p className="text-copy-14 text-negative">Could not load this source.</p>
        <BackLink canGoBack={canGoBack} className="mt-2 text-label-12 text-secondary hover:text-strong" />
      </div>
    )
  }

  return (
    <div className="page-container space-y-8">
      <div className="page-header">
        <div className="page-header-left">
          <BackLink canGoBack={canGoBack} className="text-label-12 text-muted hover:text-strong" />
          <h1 className="page-title mt-2">{detail.displayName}</h1>
          <p className="page-subtitle">{detail.sourceType} source for {projectName}</p>
        </div>
        <div className="flex items-center gap-2">
          <ToneBadge tone={toneFromTrafficSourceStatus(detail.status)}>{detail.status}</ToneBadge>
          {!isEmbed() && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={sync.isPending}
              onClick={() => void handleSync()}
            >
              <RefreshCw className={`size-3.5 ${sync.isPending ? 'animate-spin' : ''}`} />
              {sync.isPending ? 'Syncing…' : 'Sync now'}
            </Button>
          )}
        </div>
      </div>

      {syncError ? (
        <div className="rounded-md border border-negative-800/50 bg-negative-950/30 px-3 py-2 text-label-14 text-negative-200">{syncError}</div>
      ) : null}
      {syncResult ? (
        <div className="rounded-md border border-positive-800/50 bg-positive-950/30 px-3 py-2 text-label-14 text-positive-200">{syncResult}</div>
      ) : null}

      <section aria-labelledby="traffic-24h-heading">
        <h2 id="traffic-24h-heading" className="mb-3 text-heading-14 text-heading">Last 24 hours</h2>
        <div className="grid grid-cols-1 divide-y divide-default border-y border-default sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <TrafficKpi
            label="Content crawls"
            value={detail.totals24h.crawlerContentHits}
            tooltip={`Content and document paths only. Excludes sitemap ${detail.totals24h.crawlerSegments.sitemap.toLocaleString('en-US')}, robots ${detail.totals24h.crawlerSegments.robots.toLocaleString('en-US')}, assets ${detail.totals24h.crawlerSegments.asset.toLocaleString('en-US')}, and ${detail.totals24h.crawlerSegments.other.toLocaleString('en-US')} other requests such as feeds, API paths, or downloads. Total crawler hits: ${detail.totals24h.crawlerHits.toLocaleString('en-US')}.`}
          />
          <TrafficKpi
            label="AI user fetches"
            value={detail.totals24h.aiUserFetchHits}
            tooltip="ChatGPT-User/Perplexity-User fetches initiated by a real user in an AI surface."
          />
          <TrafficKpi
            label="AI referral sessions"
            value={detail.totals24h.aiReferralLandedHits}
            tooltip={`Browser click-throughs from AI surfaces, identified by Referer or UTM evidence. Excludes ${detail.totals24h.aiReferralRedirectedHits.toLocaleString('en-US')} request(s) answered with a redirect: a hop is not an arrival. Total including hops: ${detail.totals24h.aiReferralHits.toLocaleString('en-US')}.`}
          />
        </div>
      </section>

      <section>
        <p className="eyebrow mb-4">Latest sync run</p>
        {detail.latestRun ? (
          <Card className="p-4 text-label-14">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5">
              <span className="text-heading">Status: <span className="text-label-14-strong">{detail.latestRun.status}</span></span>
              <span className="text-muted">Started: {formatRelative(detail.latestRun.startedAt)}</span>
              {detail.latestRun.finishedAt ? (
                <span className="text-muted">Finished: {formatRelative(detail.latestRun.finishedAt)}</span>
              ) : null}
            </div>
            <details className="mt-3">
              <summary className="cursor-pointer text-label-14 text-secondary hover:text-strong">Run details</summary>
              <code className="mt-2 block text-label-12 text-muted">{detail.latestRun.runId}</code>
            </details>
            {detail.latestRun.error ? (
              <p className="mt-2 rounded border border-negative-900/40 bg-negative-950/30 px-3 py-2 text-copy-13 text-negative">
                {detail.latestRun.error}
              </p>
            ) : null}
          </Card>
        ) : (
          <Card className="px-4 py-3 text-label-14 text-muted">{isEmbed() ? 'No traffic-sync runs recorded yet.' : 'No traffic-sync runs recorded yet. Hit "Sync now" above to create one.'}</Card>
        )}
      </section>

      <section>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div>
            <p className="text-label-12-strong normal-case text-muted">Events</p>
            <h2 className="mt-1 text-heading-16 text-primary">
              {activeWindow.granularity === 'day' ? 'Daily rollups' : 'Hourly rollups'}
            </h2>
            {totals ? (
              <p className="mt-1.5 text-copy-13 text-muted">
                {totals.crawlerContentHits.toLocaleString('en-US')} content crawls ·{' '}
                {totals.crawlerInfraHits.toLocaleString('en-US')} infra (sitemap/robots/assets) ·{' '}
                {totals.aiUserFetchHits.toLocaleString('en-US')} AI user fetches ·{' '}
                {totals.aiReferralLandedHits.toLocaleString('en-US')} AI referral sessions · last {activeWindow.label} · {LOCAL_TZ}
              </p>
            ) : null}
          </div>
          <div className="inline-flex rounded-md border border-base p-0.5" role="toolbar" aria-label="Window">
            {WINDOW_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`rounded px-2.5 py-1 text-button-14 ${windowMinutes === opt.value ? 'bg-bg-elevated text-heading' : 'text-secondary hover:text-strong'}`}
                aria-pressed={windowMinutes === opt.value}
                onClick={() => {
                  setWindowMinutes(opt.value)
                  setSelectedBucket(null)
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2" role="toolbar" aria-label="Series">
            <SeriesToggle
              label="Crawler"
              color={CRAWLER_COLOR}
              count={totals?.crawlerHits ?? 0}
              active={visibleSeries.has('crawler')}
              onToggle={() => toggleSeries('crawler')}
            />
            <SeriesToggle
              label="AI user fetches"
              color={AI_USER_FETCH_COLOR}
              count={totals?.aiUserFetchHits ?? 0}
              active={visibleSeries.has('ai-user-fetch')}
              onToggle={() => toggleSeries('ai-user-fetch')}
            />
            <SeriesToggle
              label="AI referral sessions"
              color={AI_REFERRAL_COLOR}
              count={totals?.aiReferralLandedHits ?? 0}
              active={visibleSeries.has('ai-referral')}
              onToggle={() => toggleSeries('ai-referral')}
            />
          </div>
          {eventsQuery.isError ? (
            <p className="py-12 text-center text-copy-13 text-negative-400">
              Failed to load events: {eventsQuery.error instanceof Error ? eventsQuery.error.message : 'Unknown error'}
            </p>
          ) : eventsQuery.isLoading ? (
            <p className="py-12 text-center text-copy-13 text-muted">Loading events…</p>
          ) : chartData.length === 0 ? (
            <p className="py-12 text-center text-copy-13 text-muted">No events in this window.</p>
          ) : (
            <div className="h-72">
              <ResponsiveContainer>
                <BarChart
                  data={chartData}
                  margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
                  onClick={handleChartClick}
                  style={{ cursor: 'pointer' }}
                >
                  <CartesianGrid stroke={CHART_GRID_STROKE} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="label"
                    tick={CHART_AXIS_TICK}
                    stroke={CHART_AXIS_STROKE}
                    interval="preserveStartEnd"
                    minTickGap={activeWindow.granularity === 'day' ? 24 : 32}
                  />
                  <YAxis tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} allowDecimals={false} />
                  <RechartsTooltip {...CHART_TOOLTIP_STYLE} />
                  {visibleSeries.has('crawler') ? (
                    <Bar dataKey="crawler" name="Crawler" fill={CRAWLER_COLOR} stackId="a">
                      {chartData.map((row) => (
                        <Cell
                          key={row.bucket}
                          fillOpacity={selectedBucket && selectedBucket !== row.bucket ? 0.25 : 1}
                        />
                      ))}
                    </Bar>
                  ) : null}
                  {visibleSeries.has('ai-user-fetch') ? (
                    <Bar dataKey="aiUserFetch" name="AI user fetch" fill={AI_USER_FETCH_COLOR} stackId="a">
                      {chartData.map((row) => (
                        <Cell
                          key={row.bucket}
                          fillOpacity={selectedBucket && selectedBucket !== row.bucket ? 0.25 : 1}
                        />
                      ))}
                    </Bar>
                  ) : null}
                  {visibleSeries.has('ai-referral') ? (
                    <Bar dataKey="aiReferral" name="AI referral" fill={AI_REFERRAL_COLOR} stackId="a">
                      {chartData.map((row) => (
                        <Cell
                          key={row.bucket}
                          fillOpacity={selectedBucket && selectedBucket !== row.bucket ? 0.25 : 1}
                        />
                      ))}
                    </Bar>
                  ) : null}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </section>

      <section>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div>
            <p className="text-label-12-strong normal-case text-muted">Event rows</p>
            <p className="mt-1 text-copy-13 text-muted">
              Showing <span className="tabular-nums text-neutral">{filteredEvents.length.toLocaleString('en-US')}</span> of{' '}
              <span className="tabular-nums text-muted">{visibleEvents.length.toLocaleString('en-US')}</span>{' '}
              {eventRows?.truncated ? 'loaded events' : 'events'}
              {eventRows?.truncated ? (
                <>
                  {' '}· loaded <span className="tabular-nums text-neutral">{eventRows.returned.toLocaleString('en-US')}</span> of{' '}
                  <span className="tabular-nums text-muted">{eventRows.total.toLocaleString('en-US')}</span> rows
                </>
              ) : null}{' '}· {LOCAL_TZ}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center text-secondary">
              <select
                aria-label="Filter by identity"
                value={identityFilter}
                onChange={(e) => setIdentityFilter(e.target.value)}
                className="rounded-md border border-base bg-bg px-2.5 py-1.5 text-label-12 text-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-mono-600"
              >
                <option value="">All identities</option>
                {identityOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
              <InfoTooltip text="The specific bot or AI product making the request (e.g., GPTBot, ChatGPT-User, Perplexity). One operator usually runs several identities." />
            </span>
            <span className="inline-flex items-center text-secondary">
              <select
                aria-label="Filter by operator"
                value={operatorFilter}
                onChange={(e) => setOperatorFilter(e.target.value)}
                className="rounded-md border border-base bg-bg px-2.5 py-1.5 text-label-12 text-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-mono-600"
              >
                <option value="">All operators</option>
                {operatorOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
              <InfoTooltip text="The company that runs the bot or product (e.g., OpenAI, Anthropic, Perplexity). Filtering by operator includes every identity under that company." />
            </span>
            <select
              aria-label="Filter by HTTP status class"
              value={statusClassFilter}
              onChange={(e) => setStatusClassFilter(e.target.value as StatusClassFilter)}
              className="rounded-md border border-base bg-bg px-2.5 py-1.5 text-label-12 text-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-mono-600"
            >
              {STATUS_CLASS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by verification claim"
              value={verificationFilter}
              onChange={(e) => setVerificationFilter(e.target.value as VerificationFilter)}
              className="rounded-md border border-base bg-bg px-2.5 py-1.5 text-label-12 text-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-mono-600"
            >
              {VERIFICATION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <input
              type="search"
              aria-label="Filter by path"
              placeholder="path contains…"
              value={pathFilter}
              onChange={(e) => setPathFilter(e.target.value)}
              className="w-44 rounded-md border border-base bg-bg px-2.5 py-1.5 text-label-12 text-strong placeholder:text-faint focus:outline-none focus-visible:ring-1 focus-visible:ring-mono-600"
            />
          </div>
        </div>

        {hasRowFilter ? (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {selectedBucketLabel ? (
              <ActiveFilterPill label={`Bucket: ${selectedBucketLabel}`} onClear={() => setSelectedBucket(null)} />
            ) : null}
            {identityFilter ? (
              <ActiveFilterPill label={`Identity: ${identityFilter}`} onClear={() => setIdentityFilter('')} />
            ) : null}
            {operatorFilter ? (
              <ActiveFilterPill label={`Operator: ${operatorFilter}`} onClear={() => setOperatorFilter('')} />
            ) : null}
            {pathFilter.trim() ? (
              <ActiveFilterPill label={`Path: ${pathFilter.trim()}`} onClear={() => setPathFilter('')} />
            ) : null}
            {statusClassFilter !== 'all' ? (
              <ActiveFilterPill
                label={`Status: ${statusClassFilter}`}
                onClear={() => setStatusClassFilter('all')}
              />
            ) : null}
            {verificationFilter !== 'all' ? (
              <ActiveFilterPill
                label={`Claim: ${labelForVerification(verificationFilter)}`}
                onClear={() => setVerificationFilter('all')}
              />
            ) : null}
            <button
              type="button"
              onClick={clearAllFilters}
              className="text-button-14 text-muted underline-offset-4 hover:text-strong hover:underline"
            >
              Clear all
            </button>
          </div>
        ) : null}

        <EventsTable events={pagedEvents} truncated={eventRows?.truncated ?? false} />

        {showPagination ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-label-12 text-secondary">
            <p className="tabular-nums">
              Showing <span className="text-neutral">{pageRangeStart.toLocaleString('en-US')}</span>–
              <span className="text-neutral">{pageRangeEnd.toLocaleString('en-US')}</span> of{' '}
              <span className="text-neutral">{filteredEvents.length.toLocaleString('en-US')}</span> events
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setEventsPage((p) => Math.max(1, p - 1))}
                disabled={currentEventsPage <= 1}
                aria-label="Previous page"
                className="inline-flex items-center gap-1 rounded-md border border-base bg-bg px-2.5 py-1.5 text-strong transition hover:border-strong hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-base disabled:hover:text-strong"
              >
                <ChevronLeft className="size-3.5" />
                Prev
              </button>
              <span className="tabular-nums">
                Page <span className="text-strong">{currentEventsPage}</span> of{' '}
                <span className="text-strong">{totalEventsPages}</span>
              </span>
              <button
                type="button"
                onClick={() => setEventsPage((p) => Math.min(totalEventsPages, p + 1))}
                disabled={currentEventsPage >= totalEventsPages}
                aria-label="Next page"
                className="inline-flex items-center gap-1 rounded-md border border-base bg-bg px-2.5 py-1.5 text-strong transition hover:border-strong hover:text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-base disabled:hover:text-strong"
              >
                Next
                <ChevronRight className="size-3.5" />
              </button>
            </div>
          </div>
        ) : null}
      </section>
      <details className="border-t border-default pt-4">
        <summary className="cursor-pointer text-label-14 text-secondary hover:text-strong">How traffic is classified</summary>
        <p className="mt-2 max-w-3xl text-copy-14 text-secondary">Crawler requests, AI user fetches, and referrals are recorded separately. Filters expose the underlying evidence.</p>
      </details>
    </div>
  )
}

interface ChartRow {
  bucket: string
  label: string
  crawler: number
  aiUserFetch: number
  aiReferral: number
}

function bucketLabelFor(key: string, granularity: Granularity): string {
  return granularity === 'day' ? formatDayLabel(key) : formatHourLabel(key)
}

function buildChartData(
  points: readonly TrafficSeriesPoint[],
  granularity: Granularity,
): ChartRow[] {
  return points.map((point) => ({
    bucket: point.bucket,
    label: bucketLabelFor(point.bucket, granularity),
    crawler: point.crawlerHits,
    aiUserFetch: point.aiUserFetchHits,
    aiReferral: point.aiReferralLandedHits,
  }))
}

function labelForVerification(value: VerificationFilter): string {
  return VERIFICATION_OPTIONS.find((opt) => opt.value === value)?.label ?? value
}

function ActiveFilterPill({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-strong bg-surface-inset px-2.5 py-1 text-label-14 text-strong">
      {label}
      <button
        type="button"
        onClick={onClear}
        aria-label={`Clear ${label}`}
        className="rounded p-0.5 text-secondary hover:bg-mono-700/60 hover:text-heading"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

function SeriesToggle({
  label,
  color,
  count,
  active,
  onToggle,
}: {
  label: string
  color: string
  count: number
  active: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={`inline-flex items-center gap-2 rounded border px-3 py-1.5 text-button-14 transition ${
        active
          ? 'border-strong bg-surface-inset text-heading'
          : 'border-base bg-transparent text-muted hover:text-neutral'
      }`}
    >
      <span
        aria-hidden="true"
        className={`flex size-3 items-center justify-center rounded-sm border transition-opacity ${active ? 'border-transparent opacity-100' : 'border-strong opacity-60'}`}
        style={active ? { backgroundColor: color } : undefined}
      >{active ? '✓' : ''}</span>
      <span>{label}</span>
      <span className={`tabular-nums ${active ? 'text-secondary' : 'text-faint'}`}>
        {count.toLocaleString('en-US')}
      </span>
    </button>
  )
}

export function TrafficKpi({
  label,
  value,
  tooltip,
}: {
  label: string
  value: number
  tooltip?: string
}) {
  return (
    <div className="px-4 py-3">
      <p className="flex items-center gap-1 text-copy-14 text-secondary">
        {label}
        {tooltip ? <InfoTooltip text={tooltip} /> : null}
      </p>
      <p className="mt-1 text-copy-24-strong tabular-nums text-heading">{value.toLocaleString('en-US')}</p>
    </div>
  )
}

function renderKindLabel(kind: TrafficEventEntry['kind']): string {
  switch (kind) {
    case TrafficEventKinds.crawler: return 'Crawler'
    case TrafficEventKinds['ai-user-fetch']: return 'AI hit'
    case TrafficEventKinds['ai-referral']: return 'AI referral'
  }
}

function renderIdentity(event: TrafficEventEntry): string {
  switch (event.kind) {
    case TrafficEventKinds.crawler:
    case TrafficEventKinds['ai-user-fetch']:
      return event.botId
    case TrafficEventKinds['ai-referral']:
      return event.product
  }
}

function renderEvidence(event: TrafficEventEntry): string {
  switch (event.kind) {
    case TrafficEventKinds.crawler:
    case TrafficEventKinds['ai-user-fetch']:
      return `${event.verificationStatus} · HTTP ${event.status}`
    case TrafficEventKinds['ai-referral']:
      return `${event.evidenceType} · ${event.sourceDomain}`
  }
}

export function EventsTable({
  events,
  truncated = false,
}: {
  events: readonly TrafficEventEntry[]
  /** The fetch hit its row cap, so filtering ran over a prefix of the window. */
  truncated?: boolean
}) {
  if (events.length === 0) {
    // A confident "nothing matched" is a lie when the filter ran over a
    // truncated set: rows beyond the cap were never loaded, so their absence
    // was never tested. Say which of the two it is.
    return (
      <Card className="p-6 text-center text-label-14 text-muted">
        {truncated
          ? 'No matches in the rows loaded so far. More rows exist beyond the load limit, so narrow the time window to search them.'
          : 'No event rows match the current filters.'}
      </Card>
    )
  }
  return (
    <div className="material-base overflow-hidden">
      <table className="w-full text-label-14">
        <thead className="bg-bg-elevated/50 text-label-12-strong normal-case text-muted">
          <tr>
            <th className="px-4 py-2 text-left">Hour</th>
            <th className="px-4 py-2 text-left">Kind</th>
            <th className="px-4 py-2 text-left">Identity</th>
            <th className="px-4 py-2 text-left">Evidence / status</th>
            <th className="px-4 py-2 text-left">Path</th>
            <th className="px-4 py-2 text-right">
              <span className="inline-flex items-center">
                Hits
                <InfoTooltip text="Each row is one hour-bucket, not one request. Hits is the number of requests in that hour that shared the same identity, path, HTTP status, and verification claim." />
              </span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-mono-800/60">
          {events.map((event, i) => (
            <tr key={`${event.kind}:${event.tsHour}:${i}`} className="hover:bg-bg-elevated/40 transition-colors">
              <td className="px-4 py-2 text-label-12-mono text-neutral">{formatHourLabel(event.tsHour)}</td>
              <td className="px-4 py-2 text-neutral">{renderKindLabel(event.kind)}</td>
              <td className="px-4 py-2 text-heading">
                {renderIdentity(event)}
                <span className="ml-2 text-label-12 text-muted">{event.operator}</span>
              </td>
              <td className="px-4 py-2 text-neutral">{renderEvidence(event)}</td>
              <td className="px-4 py-2 truncate text-label-12-mono text-neutral">{pathOf(event)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-heading">{event.hits}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
