import { useMemo, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { ArrowLeft, RefreshCw, X } from 'lucide-react'

import { TrafficEventKinds, type TrafficEventEntry } from '@ainyc/canonry-contracts'

import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { ScoreGauge } from '../components/shared/ScoreGauge.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { ApiError } from '../api.js'
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
import {
  bucketForChartClick,
  bucketKeyFor,
  filterTrafficEvents,
  identityOf,
  type EventGranularity,
} from '../lib/traffic-event-filter.js'

type SeriesKind = 'crawler' | 'ai-referral'
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

const DEFAULT_WINDOW = WINDOW_OPTIONS.find((w) => w.label === '7d') ?? WINDOW_OPTIONS[2]

const CRAWLER_COLOR = CHART_SERIES_COLORS[0]
const AI_REFERRAL_COLOR = CHART_SERIES_COLORS[1]

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

export function TrafficSourceDetailPage() {
  const params = useParams({ strict: false }) as { projectName?: string; sourceId?: string }
  const projectName = params.projectName ?? ''
  const sourceId = params.sourceId ?? ''

  const [windowMinutes, setWindowMinutes] = useState<number>(DEFAULT_WINDOW.value)
  const [visibleSeries, setVisibleSeries] = useState<Set<SeriesKind>>(
    () => new Set<SeriesKind>(['crawler', 'ai-referral']),
  )
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null)
  const [identityFilter, setIdentityFilter] = useState<string>('')
  const [operatorFilter, setOperatorFilter] = useState<string>('')
  const [pathFilter, setPathFilter] = useState<string>('')
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<string | null>(null)

  const activeWindow = useMemo<WindowOption>(
    () => WINDOW_OPTIONS.find((w) => w.value === windowMinutes) ?? DEFAULT_WINDOW,
    [windowMinutes],
  )

  const sourceQuery = useServerTrafficSource(projectName || null, sourceId || null)
  const eventsQuery = useServerTrafficEvents(projectName || null, {
    kind: 'all',
    sourceId: sourceId || undefined,
    sinceMinutes: windowMinutes,
    limit: activeWindow.fetchLimit,
  })
  const sync = useSyncServerTrafficSource(projectName || null, sourceId || null)

  const detail = sourceQuery.data
  const allEvents = eventsQuery.data?.events ?? []
  const totals = eventsQuery.data?.totals

  const visibleEvents = useMemo(
    () =>
      allEvents.filter((event) =>
        event.kind === TrafficEventKinds.crawler
          ? visibleSeries.has('crawler')
          : visibleSeries.has('ai-referral'),
      ),
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
        },
        activeWindow.granularity,
      ),
    [visibleEvents, selectedBucket, identityFilter, operatorFilter, pathFilter, activeWindow.granularity],
  )

  const selectedBucketLabel = useMemo(
    () => (selectedBucket ? bucketLabelFor(selectedBucket, activeWindow.granularity) : null),
    [selectedBucket, activeWindow.granularity],
  )

  const chartData = useMemo(
    () => buildChartData(allEvents, activeWindow.granularity, eventsQuery.data?.windowStart, eventsQuery.data?.windowEnd),
    [allEvents, activeWindow.granularity, eventsQuery.data?.windowStart, eventsQuery.data?.windowEnd],
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
  }

  const hasRowFilter = Boolean(selectedBucket || identityFilter || operatorFilter || pathFilter.trim())

  const handleSync = async () => {
    setSyncError(null)
    setSyncResult(null)
    try {
      const result = await sync.mutateAsync({ sinceMinutes: 60 })
      setSyncResult(
        `Pulled ${result.pulledEvents} entries · ${result.crawlerHits} crawler · ${result.aiReferralHits} AI referral · ${result.unknownHits} unknown`,
      )
    } catch (e) {
      const message = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
      setSyncError(message)
    }
  }

  if (!projectName || !sourceId) {
    return (
      <div className="page-container">
        <p className="text-sm text-zinc-500">Missing project name or source id in URL.</p>
      </div>
    )
  }

  if (sourceQuery.isLoading) {
    return (
      <div className="page-container">
        <p className="text-sm text-zinc-500">Loading source…</p>
      </div>
    )
  }

  if (sourceQuery.isError || !detail) {
    return (
      <div className="page-container">
        <p className="text-sm text-rose-300">Could not load this source.</p>
        <Link to="/traffic" className="mt-2 inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200">
          <ArrowLeft className="size-3" /> Back to sources
        </Link>
      </div>
    )
  }

  return (
    <div className="page-container space-y-8">
      <div className="page-header">
        <div className="page-header-left">
          <Link to="/traffic" className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200">
            <ArrowLeft className="size-3" /> All sources
          </Link>
          <h1 className="page-title mt-2">{detail.displayName}</h1>
          <p className="page-subtitle">
            {detail.sourceType} · project <span className="text-zinc-300">{projectName}</span> ·
            <span className="ml-1 font-mono text-zinc-400">{detail.id}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ToneBadge tone={toneFromTrafficSourceStatus(detail.status)}>{detail.status}</ToneBadge>
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
        </div>
      </div>

      {syncError ? (
        <div className="rounded-md border border-rose-800/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{syncError}</div>
      ) : null}
      {syncResult ? (
        <div className="rounded-md border border-emerald-800/50 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">{syncResult}</div>
      ) : null}

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <ScoreGauge
          label="24h crawler hits"
          value={String(detail.totals24h.crawlerHits)}
          delta={detail.lastSyncedAt ? `last sync ${formatRelative(detail.lastSyncedAt)}` : 'never synced'}
          tone={detail.totals24h.crawlerHits > 0 ? 'positive' : 'neutral'}
          description="GPTBot, ChatGPT-User, PerplexityBot, etc. — verified crawler requests in the last 24h."
          isNumeric
          progress={Math.min(100, Math.round((detail.totals24h.crawlerHits / 1000) * 100))}
        />
        <ScoreGauge
          label="24h AI referral hits"
          value={String(detail.totals24h.aiReferralHits)}
          delta={detail.lastSyncedAt ? `last sync ${formatRelative(detail.lastSyncedAt)}` : 'never synced'}
          tone={detail.totals24h.aiReferralHits > 0 ? 'positive' : 'neutral'}
          description="Visits arriving from chat.openai.com, perplexity.ai, etc. (Referer header evidence)."
          isNumeric
          progress={Math.min(100, Math.round((detail.totals24h.aiReferralHits / 1000) * 100))}
        />
        <ScoreGauge
          label="24h sample rows"
          value={String(detail.totals24h.sampleCount)}
          delta="bounded per sync"
          tone="neutral"
          description="Per-request samples retained for evidence (capped to keep storage bounded)."
          isNumeric
          progress={Math.min(100, Math.round((detail.totals24h.sampleCount / 100) * 100))}
        />
      </section>

      <section>
        <p className="mb-4 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Latest sync run</p>
        {detail.latestRun ? (
          <Card className="p-4 text-sm">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5">
              <span className="text-zinc-100">Status: <span className="font-medium">{detail.latestRun.status}</span></span>
              <span className="text-zinc-500">Started: {formatRelative(detail.latestRun.startedAt)}</span>
              {detail.latestRun.finishedAt ? (
                <span className="text-zinc-500">Finished: {formatRelative(detail.latestRun.finishedAt)}</span>
              ) : null}
              <span className="font-mono text-[11px] text-zinc-600">{detail.latestRun.runId}</span>
            </div>
            {detail.latestRun.error ? (
              <p className="mt-2 rounded border border-rose-900/40 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
                {detail.latestRun.error}
              </p>
            ) : null}
          </Card>
        ) : (
          <Card className="px-4 py-3 text-sm text-zinc-500">No traffic-sync runs recorded yet. Hit "Sync now" above to create one.</Card>
        )}
      </section>

      <section>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Events</p>
            <h2 className="mt-1 text-base font-semibold text-zinc-50">
              {activeWindow.granularity === 'day' ? 'Daily rollups' : 'Hourly rollups'}
            </h2>
            {totals ? (
              <p className="mt-1.5 text-xs text-zinc-500">
                {totals.crawlerHits.toLocaleString('en-US')} crawler ·{' '}
                {totals.aiReferralHits.toLocaleString('en-US')} AI referral · last {activeWindow.label}
              </p>
            ) : null}
          </div>
          <div className="filter-row mb-0" role="toolbar" aria-label="Window">
            {WINDOW_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`filter-chip ${windowMinutes === opt.value ? 'filter-chip-active' : ''}`}
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
              label="AI referral"
              color={AI_REFERRAL_COLOR}
              count={totals?.aiReferralHits ?? 0}
              active={visibleSeries.has('ai-referral')}
              onToggle={() => toggleSeries('ai-referral')}
            />
          </div>
          {chartData.length === 0 ? (
            <p className="py-12 text-center text-xs text-zinc-500">No events in this window.</p>
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
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Event rows</p>
            <p className="mt-1 text-xs text-zinc-500">
              Showing <span className="tabular-nums text-zinc-300">{filteredEvents.length.toLocaleString('en-US')}</span> of{' '}
              <span className="tabular-nums text-zinc-500">{visibleEvents.length.toLocaleString('en-US')}</span> events
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Filter by identity"
              value={identityFilter}
              onChange={(e) => setIdentityFilter(e.target.value)}
              className="rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-600"
            >
              <option value="">All identities</option>
              {identityOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by operator"
              value={operatorFilter}
              onChange={(e) => setOperatorFilter(e.target.value)}
              className="rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-600"
            >
              <option value="">All operators</option>
              {operatorOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
            <input
              type="search"
              aria-label="Filter by path"
              placeholder="path contains…"
              value={pathFilter}
              onChange={(e) => setPathFilter(e.target.value)}
              className="w-44 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-600"
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
            <button
              type="button"
              onClick={clearAllFilters}
              className="text-xs text-zinc-500 underline-offset-4 hover:text-zinc-200 hover:underline"
            >
              Clear all
            </button>
          </div>
        ) : null}

        <EventsTable events={filteredEvents} />
      </section>
    </div>
  )
}

interface ChartRow {
  bucket: string
  label: string
  crawler: number
  aiReferral: number
}

function bucketLabelFor(key: string, granularity: Granularity): string {
  return granularity === 'day' ? formatDayLabel(key) : formatHourLabel(key)
}

function buildChartData(
  events: readonly TrafficEventEntry[],
  granularity: Granularity,
  windowStart?: string,
  windowEnd?: string,
): ChartRow[] {
  const byBucket = new Map<string, ChartRow>()
  for (const event of events) {
    const key = bucketKeyFor(event.tsHour, granularity)
    let row = byBucket.get(key)
    if (!row) {
      row = { bucket: key, label: bucketLabelFor(key, granularity), crawler: 0, aiReferral: 0 }
      byBucket.set(key, row)
    }
    if (event.kind === TrafficEventKinds.crawler) {
      row.crawler += event.hits
    } else {
      row.aiReferral += event.hits
    }
  }

  // Pad zero-value buckets for every partition in the window so the
  // chart renders a bar for each day (30d/90d) or hour (1h–7d).
  if (windowStart && windowEnd) {
    const start = new Date(windowStart)
    const end = new Date(windowEnd)

    if (granularity === 'day') {
      const current = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()))
      const endDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()))
      while (current <= endDay) {
        const y = current.getUTCFullYear()
        const m = String(current.getUTCMonth() + 1).padStart(2, '0')
        const d = String(current.getUTCDate()).padStart(2, '0')
        const key = `${y}-${m}-${d}`
        if (!byBucket.has(key)) {
          byBucket.set(key, { bucket: key, label: bucketLabelFor(key, granularity), crawler: 0, aiReferral: 0 })
        }
        current.setUTCDate(current.getUTCDate() + 1)
      }
    } else {
      const current = new Date(start)
      current.setUTCMinutes(0, 0, 0)
      while (current <= end) {
        const key = current.toISOString()
        if (!byBucket.has(key)) {
          byBucket.set(key, { bucket: key, label: bucketLabelFor(key, granularity), crawler: 0, aiReferral: 0 })
        }
        current.setUTCHours(current.getUTCHours() + 1)
      }
    }
  }

  return [...byBucket.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0))
}

function ActiveFilterPill({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/60 px-2.5 py-1 text-[11px] text-zinc-200">
      {label}
      <button
        type="button"
        onClick={onClear}
        aria-label={`Clear ${label}`}
        className="rounded-full p-0.5 text-zinc-400 hover:bg-zinc-700/60 hover:text-zinc-100"
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
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition ${
        active
          ? 'border-zinc-700 bg-zinc-800/60 text-zinc-100'
          : 'border-zinc-800 bg-transparent text-zinc-500 hover:text-zinc-300'
      }`}
    >
      <span
        aria-hidden="true"
        className={`size-2 rounded-full transition-opacity ${active ? 'opacity-100' : 'opacity-30'}`}
        style={{ backgroundColor: color }}
      />
      <span>{label}</span>
      <span className={`tabular-nums ${active ? 'text-zinc-400' : 'text-zinc-600'}`}>
        {count.toLocaleString('en-US')}
      </span>
    </button>
  )
}

function EventsTable({ events }: { events: readonly TrafficEventEntry[] }) {
  if (events.length === 0) {
    return <Card className="p-6 text-center text-sm text-zinc-500">No event rows match the current filters.</Card>
  }
  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-zinc-900/50 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          <tr>
            <th className="px-4 py-2 text-left">Hour</th>
            <th className="px-4 py-2 text-left">Kind</th>
            <th className="px-4 py-2 text-left">Identity</th>
            <th className="px-4 py-2 text-left">Evidence / status</th>
            <th className="px-4 py-2 text-left">Path</th>
            <th className="px-4 py-2 text-right">Hits</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/60">
          {events.map((event, i) => (
            <tr key={`${event.kind}:${event.tsHour}:${i}`} className="hover:bg-zinc-900/40 transition-colors">
              <td className="px-4 py-2 font-mono text-xs text-zinc-300">{formatHourLabel(event.tsHour)}</td>
              <td className="px-4 py-2 text-zinc-300">
                {event.kind === TrafficEventKinds.crawler ? 'Crawler' : 'AI referral'}
              </td>
              <td className="px-4 py-2 text-zinc-100">
                {event.kind === TrafficEventKinds.crawler ? event.botId : event.product}
                <span className="ml-2 text-[11px] text-zinc-500">{event.operator}</span>
              </td>
              <td className="px-4 py-2 text-zinc-300">
                {event.kind === TrafficEventKinds.crawler
                  ? `${event.verificationStatus} · HTTP ${event.status}`
                  : `${event.evidenceType} · ${event.sourceDomain}`}
              </td>
              <td className="px-4 py-2 truncate font-mono text-xs text-zinc-300">
                {event.kind === TrafficEventKinds.crawler ? event.pathNormalized : event.landingPathNormalized}
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-zinc-100">{event.hits}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
