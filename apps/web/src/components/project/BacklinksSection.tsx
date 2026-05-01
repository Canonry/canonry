import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { summarizeRunError } from '../../lib/format-helpers.js'
import { HelpCircle, Link2, Play, Download, Loader2, CheckCircle2 } from 'lucide-react'
import { RunKinds } from '@ainyc/canonry-contracts'
import {
  Area,
  ComposedChart,
  RechartsTooltip,
  ResponsiveContainer,
  XAxis,
  YAxis,
  CHART_TOOLTIP_STYLE,
  CHART_AXIS_TICK,
  CHART_AXIS_STROKE,
  CHART_SERIES_COLORS,
  formatChartDateLabel,
  formatChartDateTick,
} from '../shared/ChartPrimitives.js'
import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'

function Hint({
  children,
  label = 'More info',
  placement = 'top',
  className,
}: {
  children: ReactNode
  label?: string
  placement?: 'top' | 'bottom'
  className?: string
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  return (
    <span className={`relative inline-flex ${className ?? ''}`}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-zinc-500 hover:text-zinc-200 focus:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <HelpCircle className="h-3.5 w-3.5" aria-hidden />
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className={`absolute z-50 w-64 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-normal leading-relaxed text-zinc-200 shadow-lg ${
            placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'
          } left-1/2 -translate-x-1/2 whitespace-normal`}
        >
          {children}
        </span>
      )}
    </span>
  )
}
import { isTerminalRunStatus } from '../../lib/run-tracker-store.js'
import {
  fetchBacklinkDomains,
  fetchBacklinkHistory,
  fetchBacklinkSummary,
  fetchLatestReleaseSync,
  fetchProjectRuns,
  fetchRunDetail,
  triggerBacklinkExtract,
  ApiError,
} from '../../api.js'
import type {
  ApiRun,
  BacklinkDomainDto,
  BacklinkHistoryEntry,
  BacklinkListResponse,
  BacklinkSummaryDto,
  CcReleaseSyncDto,
} from '../../api.js'

const PAGE_SIZE = 50

function publicPath(path: string): string {
  if (typeof window === 'undefined') return path
  const base = window.__CANONRY_CONFIG__?.basePath?.replace(/\/$/, '') ?? ''
  return `${base}${path}`
}

function formatNumber(n: number): string {
  return n.toLocaleString()
}

function formatPct(share: string): string {
  const value = Number(share)
  if (!Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(1)}%`
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function findActiveExtractRun(runs: ApiRun[]): ApiRun | null {
  const inFlight = runs.filter(
    (r) => r.kind === RunKinds['backlink-extract'] && !isTerminalRunStatus(r.status),
  )
  if (inFlight.length === 0) return null
  return inFlight.reduce((a, b) => (a.createdAt > b.createdAt ? a : b))
}

function formatElapsed(startedAt: string | null, createdAt: string): string {
  const start = new Date(startedAt ?? createdAt).getTime()
  const secs = Math.max(0, Math.floor((Date.now() - start) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  return rem === 0 ? `${mins}m` : `${mins}m ${rem}s`
}

export function BacklinksSection({ projectName }: { projectName: string }) {
  const [summary, setSummary] = useState<BacklinkSummaryDto | null>(null)
  const [list, setList] = useState<BacklinkListResponse | null>(null)
  const [history, setHistory] = useState<BacklinkHistoryEntry[]>([])
  const [latestSync, setLatestSync] = useState<CcReleaseSyncDto | null>(null)
  const [activeRun, setActiveRun] = useState<ApiRun | null>(null)
  const [justCompletedRun, setJustCompletedRun] = useState<ApiRun | null>(null)
  const [now, setNow] = useState(Date.now())
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [extracting, setExtracting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastActiveIdRef = useRef<string | null>(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [sync, sum, rows, hist, runs] = await Promise.all([
        fetchLatestReleaseSync().catch(() => null),
        fetchBacklinkSummary(projectName, { excludeCrawlers: true }).catch(() => null),
        fetchBacklinkDomains(projectName, {
          limit: PAGE_SIZE,
          offset,
          excludeCrawlers: true,
        }).catch((err: unknown) => {
          if (err instanceof ApiError && err.code === 'NOT_FOUND') return null
          throw err
        }),
        fetchBacklinkHistory(projectName).catch(() => [] as BacklinkHistoryEntry[]),
        fetchProjectRuns(projectName).catch(() => [] as ApiRun[]),
      ])
      setLatestSync(sync)
      setSummary(sum)
      setList(rows)
      setHistory(hist)
      const active = findActiveExtractRun(runs)
      setActiveRun(active)
      lastActiveIdRef.current = active?.id ?? null
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load backlinks')
    } finally {
      setLoading(false)
    }
  }, [projectName, offset])

  useEffect(() => { void loadData() }, [loadData])

  // Poll the active extract run until it reaches a terminal state.
  useEffect(() => {
    if (!activeRun) return
    const runId = activeRun.id
    let cancelled = false
    const tick = async () => {
      try {
        const detail = await fetchRunDetail(runId)
        if (cancelled) return
        if (isTerminalRunStatus(detail.status)) {
          setActiveRun(null)
          setJustCompletedRun(detail)
          await loadData()
        } else {
          setActiveRun((prev) => (prev?.id === detail.id ? { ...prev, ...detail } : prev))
        }
      } catch {
        // swallow transient poll errors — next tick retries
      }
    }
    const interval = window.setInterval(() => { void tick() }, 3000)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [activeRun, loadData])

  // Clock tick for elapsed-time display while a run is in flight.
  useEffect(() => {
    if (!activeRun) return
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [activeRun])

  // Auto-dismiss the success banner after 10s. Failure stays visible until the
  // user starts a new extract — otherwise the stale "0 domains" summary re-appears
  // below and re-confuses them.
  useEffect(() => {
    if (!justCompletedRun) return
    if (justCompletedRun.status === 'failed') return
    const t = window.setTimeout(() => setJustCompletedRun(null), 10_000)
    return () => window.clearTimeout(t)
  }, [justCompletedRun])

  async function handleExtract() {
    setExtracting(true)
    setError(null)
    try {
      const run = await triggerBacklinkExtract(projectName)
      setActiveRun(run)
      lastActiveIdRef.current = run.id
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MISSING_DEPENDENCY') {
        setError('DuckDB is not installed. Visit the Backlinks admin page to install it.')
      } else {
        setError(err instanceof Error ? err.message : 'Failed to trigger extract')
      }
    } finally {
      setExtracting(false)
    }
  }

  const chartData = useMemo(() => {
    return history
      .slice()
      .sort((a, b) => a.queriedAt.localeCompare(b.queriedAt))
      .map((h) => ({
        date: h.queriedAt,
        linkingDomains: h.totalLinkingDomains,
      }))
  }, [history])

  const pageRows = list?.rows ?? []
  const visibleTotal = list?.total ?? 0
  const hiddenCount = summary?.excludedLinkingDomains ?? 0
  const canPage = visibleTotal > PAGE_SIZE
  const page = Math.floor(offset / PAGE_SIZE) + 1
  const totalPages = Math.max(1, Math.ceil(visibleTotal / PAGE_SIZE))

  useEffect(() => {
    if (offset > 0 && offset >= visibleTotal) setOffset(0)
  }, [offset, visibleTotal])

  return (
    <section className="page-section-divider">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Backlinks</p>
          <h2>Referring domains</h2>
          <p className="text-sm text-zinc-500 mt-1 max-w-2xl">
            Domains linking to {' '}
            <span className="text-zinc-300">{projectName}</span>, extracted from the Common Crawl hyperlink graph. Updates when a release sync completes — no live scraping, no paid API.
          </p>
        </div>
      </div>

      {error && (
        <Card className="surface-card p-4 mb-4 border-rose-800/60">
          <p className="text-sm text-rose-300">{error}</p>
        </Card>
      )}
      {activeRun && (
        <Card className="surface-card p-4 mb-4 border-sky-800/60">
          <div className="flex items-start gap-3">
            <Loader2 className="h-5 w-5 text-sky-400 animate-spin shrink-0 mt-0.5" aria-hidden />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-medium text-zinc-100">Extract running</p>
                <ToneBadge tone="neutral">{activeRun.status}</ToneBadge>
                <span className="text-xs text-zinc-500 tabular-nums">
                  {formatElapsed(activeRun.startedAt, activeRun.createdAt)} elapsed · refreshing every 3s
                </span>
                <span className="sr-only">now={now}</span>
              </div>
              <p className="text-xs text-zinc-500 mt-1">
                Re-querying the cached Common Crawl release for{' '}
                <span className="text-zinc-300">{projectName}</span>. No re-download — the ~16&nbsp;GB dump already lives at{' '}
                <code className="text-zinc-400">~/.canonry/cache/commoncrawl/</code>. Typically takes ~5 minutes.
              </p>
            </div>
          </div>
        </Card>
      )}
      {justCompletedRun && !activeRun && (
        <Card className={`surface-card p-4 mb-4 ${justCompletedRun.status === 'failed' ? 'border-rose-800/60' : 'border-emerald-800/60'}`}>
          <div className="flex items-start gap-3">
            {justCompletedRun.status === 'failed' ? (
              <span className="h-5 w-5 shrink-0 mt-0.5 text-rose-400 text-lg leading-none" aria-hidden>!</span>
            ) : (
              <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" aria-hidden />
            )}
            <div className="flex-1">
              <p className={`text-sm font-medium ${justCompletedRun.status === 'failed' ? 'text-rose-300' : 'text-emerald-300'}`}>
                {justCompletedRun.status === 'failed'
                  ? 'Extract failed'
                  : 'Extract complete'}
              </p>
              {justCompletedRun.error
                ? <p className="text-xs text-zinc-500 mt-1">{summarizeRunError(justCompletedRun.error)}</p>
                : justCompletedRun.status !== 'failed'
                  ? <p className="text-xs text-zinc-500 mt-1">Backlinks refreshed from the cached release.</p>
                  : null}
            </div>
          </div>
        </Card>
      )}

      {renderBody()}
    </section>
  )

  function renderBody() {
    if (loading) {
      return (
        <Card className="surface-card p-6">
          <p className="text-sm text-zinc-500">Loading backlinks…</p>
        </Card>
      )
    }

    const hasSummary = summary !== null && summary.totalLinkingDomains > 0
    const justFailed = justCompletedRun?.status === 'failed'
    const hasEmptySummary = summary !== null && summary.totalLinkingDomains === 0 && !justFailed
    const hasReadySync = latestSync?.status === 'ready'
    const hasFailedSync = latestSync?.status === 'failed'
    const hasRunningSync = latestSync && (latestSync.status === 'downloading' || latestSync.status === 'querying' || latestSync.status === 'queued')

    if (!hasSummary) {
      return (
        <Card className="surface-card p-6">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-zinc-400">
              <Link2 className="h-5 w-5" aria-hidden />
            </div>
            <div className="flex-1">
              {!latestSync && (
                <>
                  <h3 className="text-base font-semibold text-zinc-100">No release sync yet</h3>
                  <p className="text-sm text-zinc-500 mt-1">
                    Run a workspace release sync to populate backlinks for every project in this workspace.
                  </p>
                  <div className="mt-4">
                    <Button asChild type="button" size="sm">
                      <a href={publicPath('/backlinks')}>Set up backlinks</a>
                    </Button>
                  </div>
                </>
              )}
              {hasRunningSync && (
                <>
                  <h3 className="text-base font-semibold text-zinc-100">Sync in progress</h3>
                  <p className="text-sm text-zinc-500 mt-1">
                    A workspace release sync is running ({latestSync.status}
                    {latestSync.phaseDetail ? ` — ${latestSync.phaseDetail}` : ''}). Backlinks will appear here once it finishes.
                  </p>
                  <div className="mt-4">
                    <Button asChild type="button" variant="outline" size="sm">
                      <a href={publicPath('/backlinks')}>View sync status</a>
                    </Button>
                  </div>
                </>
              )}
              {hasFailedSync && (
                <>
                  <h3 className="text-base font-semibold text-zinc-100">Last sync failed</h3>
                  <p className="text-sm text-zinc-500 mt-1">
                    {latestSync.error ?? 'The workspace release sync failed. Retry from the Backlinks admin page.'}
                  </p>
                  <div className="mt-4">
                    <Button asChild type="button" size="sm">
                      <a href={publicPath('/backlinks')}>Go to Backlinks admin</a>
                    </Button>
                  </div>
                </>
              )}
              {hasReadySync && !hasRunningSync && !hasEmptySummary && !justFailed && (
                <>
                  <h3 className="text-base font-semibold text-zinc-100">No backlinks yet for this project</h3>
                  <p className="text-sm text-zinc-500 mt-1">
                    Release <code className="text-zinc-300">{latestSync.release}</code> is ready but no backlinks have been extracted for{' '}
                    <code className="text-zinc-300">{projectName}</code>. Run an extract to populate data using the cached release.
                  </p>
                  <div className="mt-4 flex items-center gap-3 flex-wrap">
                    <Button type="button" size="sm" disabled={extracting || activeRun !== null} onClick={handleExtract}>
                      <Play className="h-4 w-4 mr-1.5" aria-hidden />
                      {activeRun ? 'Extract running…' : extracting ? 'Queuing…' : 'Run extract'}
                    </Button>
                    <Hint label="What does Run extract do?">
                      <span className="block">
                        Runs a DuckDB query against the <span className="text-zinc-200">cached release files</span> at{' '}
                        <code className="text-zinc-300">~/.canonry/cache/commoncrawl/</code> to find referring domains for <span className="text-zinc-200">{projectName}</span>.
                      </span>
                      <span className="mt-2 block text-zinc-400">
                        No re-download. Typically takes <span className="text-zinc-200">~5 min</span>.
                      </span>
                    </Hint>
                  </div>
                </>
              )}
              {justFailed && (
                <>
                  <h3 className="text-base font-semibold text-zinc-100">Last extract failed</h3>
                  <p className="text-sm text-zinc-500 mt-1">
                    See the error above for details. If the cache files for release{' '}
                    <code className="text-zinc-300">{latestSync?.release}</code> are missing, re-sync the release from the Backlinks admin to restore the ~16 GB dump, then re-run the extract.
                  </p>
                  <div className="mt-4 flex items-center gap-3 flex-wrap">
                    <Button asChild type="button" size="sm">
                      <a href={publicPath('/backlinks')}>Go to Backlinks admin</a>
                    </Button>
                  </div>
                </>
              )}
              {hasEmptySummary && (
                <>
                  <h3 className="text-base font-semibold text-zinc-100">No referring domains found</h3>
                  <p className="text-sm text-zinc-500 mt-1">
                    The last extract against release <code className="text-zinc-300">{summary!.release}</code> found{' '}
                    <span className="text-zinc-300">0 referring domains</span> for{' '}
                    <code className="text-zinc-300">{summary!.targetDomain}</code>. This can happen when:
                  </p>
                  <ul className="mt-2 space-y-1 text-xs text-zinc-500 list-disc list-inside">
                    <li>the domain is newer than the release&rsquo;s crawl window</li>
                    <li>the Common Crawl snapshot didn&rsquo;t capture pages that link to it</li>
                    <li>the extract ran against a cache that was missing or incomplete</li>
                  </ul>
                  <p className="text-sm text-zinc-500 mt-3">
                    Try syncing a newer release — each Common Crawl dump is a different snapshot of the web graph.
                  </p>
                  <div className="mt-4 flex items-center gap-3 flex-wrap">
                    <Button asChild type="button" size="sm">
                      <a href={publicPath('/backlinks')}>Go to Backlinks admin</a>
                    </Button>
                    <Button type="button" variant="outline" size="sm" disabled={extracting || activeRun !== null} onClick={handleExtract}>
                      <Play className="h-4 w-4 mr-1.5" aria-hidden />
                      {activeRun ? 'Extract running…' : extracting ? 'Queuing…' : 'Re-run extract'}
                    </Button>
                    <Hint label="What does Re-run extract do?">
                      <span className="block">
                        Re-queries the cached release for <span className="text-zinc-200">{summary!.targetDomain}</span>. Only useful if the cache files were incomplete last time.
                      </span>
                      <span className="mt-2 block text-zinc-400">
                        No re-download. ~5 min. If the release genuinely has no links for your domain, this won&rsquo;t help — sync a different release instead.
                      </span>
                    </Hint>
                  </div>
                </>
              )}
            </div>
          </div>
        </Card>
      )
    }

    return (
      <>
        <div className="gauge-row">
          <div className="metric-card">
            <p className="metric-card-eyebrow">Referring domains</p>
            <p className="metric-card-big-value">
              <span className="text-zinc-50">{formatNumber(summary.totalLinkingDomains)}</span>
            </p>
            <p className="metric-card-sub">unique domains linking to {summary.targetDomain}</p>
          </div>
          <div className="metric-card">
            <p className="metric-card-eyebrow">Total linking hosts</p>
            <p className="metric-card-big-value">
              <span className="text-zinc-50">{formatNumber(summary.totalHosts)}</span>
            </p>
            <p className="metric-card-sub">aggregate host count across referring domains</p>
          </div>
          <div className="metric-card">
            <p className="metric-card-eyebrow">Top-10 concentration</p>
            <p className="metric-card-big-value">
              <span className="text-zinc-50">{formatPct(summary.top10HostsShare)}</span>
            </p>
            <p className="metric-card-sub">share of hosts from the 10 largest linking domains</p>
          </div>
        </div>

        <p className="text-xs text-zinc-600 mt-2">
          Release <code className="text-zinc-400">{summary.release}</code> · queried {relativeTime(summary.queriedAt)}
          {hiddenCount > 0 && (
            <> · <span className="text-zinc-500">{hiddenCount} crawler/proxy domain{hiddenCount === 1 ? '' : 's'} hidden</span></>
          )}
        </p>

        {chartData.length >= 2 && (
          <Card className="surface-card p-4 mt-4">
            <p className="eyebrow eyebrow-soft">Referring domains over releases</p>
            <div className="h-40 mt-2">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: 12 }}>
                  <defs>
                    <linearGradient id="bl-gradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CHART_SERIES_COLORS[0]} stopOpacity={0.4} />
                      <stop offset="100%" stopColor={CHART_SERIES_COLORS[0]} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} tickFormatter={formatChartDateTick} />
                  <YAxis tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} allowDecimals={false} />
                  <RechartsTooltip
                    contentStyle={CHART_TOOLTIP_STYLE.contentStyle}
                    labelStyle={CHART_TOOLTIP_STYLE.labelStyle}
                    itemStyle={CHART_TOOLTIP_STYLE.itemStyle}
                    labelFormatter={formatChartDateLabel}
                  />
                  <Area
                    type="monotone"
                    dataKey="linkingDomains"
                    name="Referring domains"
                    stroke={CHART_SERIES_COLORS[0]}
                    fill="url(#bl-gradient)"
                    strokeWidth={2}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </Card>
        )}

        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <p className="eyebrow eyebrow-soft">Top referring domains</p>
            {canPage && (
              <p className="text-xs text-zinc-600">
                Page {page} of {totalPages} · {formatNumber(visibleTotal)} total
              </p>
            )}
          </div>
          <Card className="surface-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs uppercase tracking-wide text-zinc-600">
                  <th className="px-4 py-2 font-medium">Domain</th>
                  <th className="px-4 py-2 text-right font-medium">Linking hosts</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row: BacklinkDomainDto) => (
                  <tr key={row.linkingDomain} className="border-b border-zinc-900 last:border-0">
                    <td className="px-4 py-2 text-zinc-200">{row.linkingDomain}</td>
                    <td className="px-4 py-2 text-right text-zinc-400 tabular-nums">{formatNumber(row.numHosts)}</td>
                  </tr>
                ))}
                {pageRows.length === 0 && (
                  <tr><td className="px-4 py-4 text-sm text-zinc-500" colSpan={2}>
                    {hiddenCount > 0 && visibleTotal === 0
                      ? `Every referring domain in this release was a crawler/proxy host (${hiddenCount} hidden).`
                      : 'No referring domains in this release.'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </Card>
          {canPage && (
            <div className="flex items-center justify-end gap-2 mt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset((v) => Math.max(0, v - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={offset + PAGE_SIZE >= visibleTotal}
                onClick={() => setOffset((v) => v + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <Button type="button" variant="outline" size="sm" disabled={extracting || activeRun !== null} onClick={handleExtract}>
            <Download className="h-4 w-4 mr-1.5" aria-hidden />
            {activeRun ? 'Extract running…' : extracting ? 'Queuing…' : 'Re-run extract'}
          </Button>
          <Hint label="What does Re-run extract do?">
            <span className="block">
              Re-queries the <span className="text-zinc-200">cached release files</span> at{' '}
              <code className="text-zinc-300">~/.canonry/cache/commoncrawl/</code> for <span className="text-zinc-200">{projectName}</span>. Replaces existing backlink rows for this project under the current release.
            </span>
            <span className="mt-2 block text-zinc-400">
              <span className="text-zinc-200">No re-download</span> of the ~16 GB dump. Typically <span className="text-zinc-200">~5 min</span>.
            </span>
          </Hint>
          <Button asChild type="button" variant="outline" size="sm">
            <a href={publicPath('/backlinks')}>Open admin</a>
          </Button>
        </div>
      </>
    )
  }
}
