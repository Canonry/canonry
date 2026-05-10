import { useMemo, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { ArrowLeft, RefreshCw } from 'lucide-react'

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
  CHART_AXIS_STROKE,
  CHART_AXIS_TICK,
  CHART_GRID_STROKE,
  CHART_SERIES_COLORS,
  CHART_TOOLTIP_STYLE,
  Legend,
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

type EventKindFilter = 'all' | 'crawler' | 'ai-referral'

const WINDOW_OPTIONS = [
  { value: 60, label: 'Last hour' },
  { value: 6 * 60, label: 'Last 6h' },
  { value: 24 * 60, label: 'Last 24h' },
  { value: 7 * 24 * 60, label: 'Last 7d' },
] as const

const CRAWLER_COLOR = CHART_SERIES_COLORS[0]
const AI_REFERRAL_COLOR = CHART_SERIES_COLORS[1]

function formatHourLabel(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00`
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

  const [kind, setKind] = useState<EventKindFilter>('all')
  const [windowMinutes, setWindowMinutes] = useState<number>(24 * 60)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<string | null>(null)

  const sourceQuery = useServerTrafficSource(projectName || null, sourceId || null)
  const eventsQuery = useServerTrafficEvents(projectName || null, {
    kind,
    sourceId: sourceId || undefined,
    sinceMinutes: windowMinutes,
    limit: 500,
  })
  const sync = useSyncServerTrafficSource(projectName || null, sourceId || null)

  const detail = sourceQuery.data
  const events = eventsQuery.data?.events ?? []
  const totals = eventsQuery.data?.totals

  const chartData = useMemo(() => buildChartData(events), [events])

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
        <div className="mb-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Events</p>
            <h2 className="mt-1 text-base font-semibold text-zinc-50">Hourly rollups</h2>
            {totals ? (
              <p className="mt-1.5 text-xs text-zinc-500">
                {totals.crawlerHits} crawler · {totals.aiReferralHits} AI referral · over the selected window
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="filter-row mb-0" role="toolbar" aria-label="Window">
              {WINDOW_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`filter-chip ${windowMinutes === opt.value ? 'filter-chip-active' : ''}`}
                  aria-pressed={windowMinutes === opt.value}
                  onClick={() => setWindowMinutes(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="filter-row mb-0" role="toolbar" aria-label="Event kind">
              {(['all', TrafficEventKinds.crawler, TrafficEventKinds['ai-referral']] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`filter-chip ${kind === option ? 'filter-chip-active' : ''}`}
                  aria-pressed={kind === option}
                  onClick={() => setKind(option)}
                >
                  {option === 'all' ? 'All' : option === 'crawler' ? 'Crawler' : 'AI referral'}
                </button>
              ))}
            </div>
          </div>
        </div>

        <Card className="p-4">
          {chartData.length === 0 ? (
            <p className="py-12 text-center text-xs text-zinc-500">No events in this window.</p>
          ) : (
            <div className="h-72">
              <ResponsiveContainer>
                <BarChart data={chartData}>
                  <CartesianGrid stroke={CHART_GRID_STROKE} strokeDasharray="3 3" />
                  <XAxis dataKey="label" tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} />
                  <YAxis tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} allowDecimals={false} />
                  <RechartsTooltip {...CHART_TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="crawler" name="Crawler" fill={CRAWLER_COLOR} stackId="a" />
                  <Bar dataKey="aiReferral" name="AI referral" fill={AI_REFERRAL_COLOR} stackId="a" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </section>

      <section>
        <p className="mb-4 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Event rows</p>
        <EventsTable events={events} />
      </section>
    </div>
  )
}

interface ChartRow {
  hour: string
  label: string
  crawler: number
  aiReferral: number
}

function buildChartData(events: readonly TrafficEventEntry[]): ChartRow[] {
  const byHour = new Map<string, ChartRow>()
  for (const event of events) {
    let row = byHour.get(event.tsHour)
    if (!row) {
      row = { hour: event.tsHour, label: formatHourLabel(event.tsHour), crawler: 0, aiReferral: 0 }
      byHour.set(event.tsHour, row)
    }
    if (event.kind === TrafficEventKinds.crawler) {
      row.crawler += event.hits
    } else {
      row.aiReferral += event.hits
    }
  }
  return [...byHour.values()].sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0))
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
