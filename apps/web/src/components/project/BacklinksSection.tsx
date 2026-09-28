import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { summarizeRunError } from '../../lib/format-helpers.js'
import { HelpCircle, Link2, Play, Download, Loader2, CheckCircle2 } from 'lucide-react'
import { formatPercent, RunKinds } from '@ainyc/canonry-contracts'
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
  formatObservedInstantLabel,
  formatObservedInstantTick,
  observedInstant,
} from '../shared/ChartPrimitives.js'
import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import {
  DataTablePagination,
  DEFAULT_TABLE_PAGE_SIZE,
} from '../shared/DataTableControls.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { asyncHandler } from '../../lib/async-handler.js'

/**
 * The x value on the referring-domains chart is a history entry's `queriedAt` —
 * the moment the backlink sync actually ran (`deps.now().toISOString()` in
 * `commoncrawl-sync`), not a day stamp. It is a real
 * instant, so it localizes to the viewer: a sync at 2026-07-20T01:52Z reads
 * "Jul 19" in New York, the day that viewer was actually on when it ran.
 * Recharts hands its formatters the raw axis value, so the brand is restored
 * here, at the one place a `queriedAt` enters a date formatter.
 */
function formatQueriedAtTick(value: string): string {
  return formatObservedInstantTick(observedInstant(String(value)))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatQueriedAtLabel(value: any): string {
  return formatObservedInstantLabel(observedInstant(String(value)))
}

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
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted hover:text-strong focus:text-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-mono-500"
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
          className={`absolute z-50 w-64 rounded border border-strong bg-bg-elevated px-3 py-2 text-xs font-normal leading-relaxed text-strong shadow-lg ${
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
  isEmbed,
  isPublicDemo,
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

const PAGE_SIZE = DEFAULT_TABLE_PAGE_SIZE

function publicPath(path: string): string {
  if (typeof window === 'undefined') return path
  const base = window.__CANONRY_CONFIG__?.basePath?.replace(/\/$/, '') ?? ''
  return `${base}${path}`
}

function formatNumber(n: number): string {
  return n.toLocaleString()
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
  const publicDemo = isPublicDemo()
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
  const page = Math.floor(offset / PAGE_SIZE) + 1

  useEffect(() => {
    if (offset > 0 && offset >= visibleTotal) setOffset(0)
  }, [offset, visibleTotal])

  return (
    <section className="page-section-divider">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Backlinks</p>
          <h2>Referring domains</h2>
        </div>
      </div>

      {error && (
        <Card className="surface-card p-4 mb-4 border-negative-800/60">
          <p className="text-sm text-negative">{error}</p>
        </Card>
      )}
      {activeRun && (
        <Card className="surface-card p-4 mb-4 border-info-800/60">
          <div className="flex items-start gap-3">
            <Loader2 className="h-5 w-5 text-info-400 animate-spin shrink-0 mt-0.5" aria-hidden />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-medium text-heading">
                  Extract running
                </p>
                <ToneBadge tone="neutral">{activeRun.status}</ToneBadge>
                <span className="text-sm text-secondary tabular-nums">
                  {formatElapsed(activeRun.startedAt ?? null, activeRun.createdAt)} elapsed · refreshing every 3s
                </span>
                <span className="sr-only">now={now}</span>
              </div>
              <p className="text-sm text-secondary mt-1">Refreshing this project from the current Common Crawl release.</p>
            </div>
          </div>
        </Card>
      )}
      {justCompletedRun && !activeRun && (
        <Card className={`surface-card p-4 mb-4 ${justCompletedRun.status === 'failed' ? 'border-negative-800/60' : 'border-positive-800/60'}`}>
          <div className="flex items-start gap-3">
            {justCompletedRun.status === 'failed' ? (
              <span className="h-5 w-5 shrink-0 mt-0.5 text-negative-400 text-lg leading-none" aria-hidden>!</span>
            ) : (
              <CheckCircle2 className="h-5 w-5 text-positive-400 shrink-0 mt-0.5" aria-hidden />
            )}
            <div className="flex-1">
              <p className={`text-sm font-medium ${justCompletedRun.status === 'failed' ? 'text-negative' : 'text-positive'}`}>
                {justCompletedRun.status === 'failed' ? 'Extract failed' : 'Extract complete'}
              </p>
              {justCompletedRun.error
                ? <p className="text-sm text-secondary mt-1">{summarizeRunError(justCompletedRun.error)}</p>
                : justCompletedRun.status !== 'failed'
                  ? <p className="text-sm text-secondary mt-1">Backlinks refreshed from the cached release.</p>
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
          <p className="text-sm text-muted">Loading backlinks…</p>
        </Card>
      )
    }
    return renderCommonCrawlBody()
  }

  function renderCommonCrawlBody() {
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
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-bg-elevated text-secondary">
              <Link2 className="h-5 w-5" aria-hidden />
            </div>
            <div className="flex-1">
              {!latestSync && (
                <>
                  <h3 className="text-base font-semibold text-heading">No release sync yet</h3>
                  <p className="text-sm text-muted mt-1">
                    Run a workspace release sync to populate backlinks for every project in this workspace.
                  </p>
                  {!isEmbed() && !publicDemo && (
                    <div className="mt-4">
                      <Button asChild type="button" size="sm">
                        <a href={publicPath('/backlinks')}>Set up backlinks</a>
                      </Button>
                    </div>
                  )}
                </>
              )}
              {hasRunningSync && (
                <>
                  <h3 className="text-base font-semibold text-heading">Sync in progress</h3>
                  <p className="text-sm text-muted mt-1">
                    A workspace release sync is running ({latestSync.status}
                    {latestSync.phaseDetail ? ` — ${latestSync.phaseDetail}` : ''}). Backlinks will appear here once it finishes.
                  </p>
                  {!isEmbed() && !publicDemo && (
                    <div className="mt-4">
                      <Button asChild type="button" variant="outline" size="sm">
                        <a href={publicPath('/backlinks')}>View sync status</a>
                      </Button>
                    </div>
                  )}
                </>
              )}
              {hasFailedSync && (
                <>
                  <h3 className="text-base font-semibold text-heading">Last sync failed</h3>
                  <p className="text-sm text-muted mt-1">
                    {latestSync.error ?? 'The workspace release sync failed. Retry from the Backlinks admin page.'}
                  </p>
                  {!isEmbed() && !publicDemo && (
                    <div className="mt-4">
                      <Button asChild type="button" size="sm">
                        <a href={publicPath('/backlinks')}>Go to Backlinks admin</a>
                      </Button>
                    </div>
                  )}
                </>
              )}
              {hasReadySync && !hasRunningSync && !hasEmptySummary && !justFailed && (
                <>
                  <h3 className="text-base font-semibold text-heading">No backlinks yet for this project</h3>
                  <p className="text-sm text-secondary mt-1">Release <code className="text-neutral">{latestSync.release}</code> is ready. Run an extract for this project.</p>
                  {!isEmbed() && !publicDemo && (
                    <div className="mt-4 flex items-center gap-3 flex-wrap">
                      <Button type="button" size="sm" disabled={extracting || activeRun !== null} onClick={asyncHandler(handleExtract)}>
                        <Play className="h-4 w-4 mr-1.5" aria-hidden />
                        {activeRun ? 'Extract running…' : extracting ? 'Queuing…' : 'Run extract'}
                      </Button>
                      <Hint label="About extraction">Queries the current release for this project without downloading it again.</Hint>
                    </div>
                  )}
                </>
              )}
              {justFailed && (
                <>
                  <h3 className="text-base font-semibold text-heading">Last extract failed</h3>
                  <p className="text-sm text-secondary mt-1">See the error above, then check the workspace source before retrying.</p>
                  {!isEmbed() && !publicDemo && (
                    <div className="mt-4 flex items-center gap-3 flex-wrap">
                      <Button asChild type="button" size="sm">
                        <a href={publicPath('/backlinks')}>Go to Backlinks admin</a>
                      </Button>
                    </div>
                  )}
                </>
              )}
              {hasEmptySummary && (
                <>
                  <h3 className="text-base font-semibold text-heading">No referring domains found</h3>
                  <p className="text-sm text-secondary mt-1">The latest release found no referring domains for {summary!.targetDomain}. Try a newer release or re-run this extract.</p>
                  {!isEmbed() && !publicDemo && (
                    <div className="mt-4 flex items-center gap-3 flex-wrap">
                      <Button asChild type="button" size="sm">
                        <a href={publicPath('/backlinks')}>Go to Backlinks admin</a>
                      </Button>
                      <Button type="button" variant="outline" size="sm" disabled={extracting || activeRun !== null} onClick={asyncHandler(handleExtract)}>
                        <Play className="h-4 w-4 mr-1.5" aria-hidden />
                        {activeRun ? 'Extract running…' : extracting ? 'Queuing…' : 'Re-run extract'}
                      </Button>
                      <Hint label="What does Re-run extract do?">
                        <span className="block">
                          Re-queries the cached release for <span className="text-strong">{summary!.targetDomain}</span>. Only useful if the cache files were incomplete last time.
                        </span>
                        <span className="mt-2 block text-secondary">
                          No re-download. ~5 min. If the release genuinely has no links for your domain, this won&rsquo;t help — sync a different release instead.
                        </span>
                      </Hint>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </Card>
      )
    }

    return renderDataView(
      <>
        {!isEmbed() && !publicDemo && (
          <>
            <Button type="button" variant="outline" size="sm" disabled={extracting || activeRun !== null} onClick={asyncHandler(handleExtract)}>
              <Download className="h-4 w-4 mr-1.5" aria-hidden />
              {activeRun ? 'Extract running…' : extracting ? 'Queuing…' : 'Re-run extract'}
            </Button>
            <Hint label="About re-running">Re-queries the current release for this project without downloading it again.</Hint>
          </>
        )}
        {!isEmbed() && !publicDemo && (
          <Button asChild type="button" variant="outline" size="sm">
            <a href={publicPath('/backlinks')}>Open admin</a>
          </Button>
        )}
      </>,
    )
  }

  // Common Crawl summary, history, and referring-domain table.
  function renderDataView(actions: ReactNode) {
    if (!summary) return null
    const countLabel = 'Linking hosts'
    const countNoun = 'linking hosts'
    const windowNoun = 'release'
    return (
      <>
        <div className="gauge-row">
          <div className="metric-card">
            <p className="metric-card-eyebrow">Referring domains</p>
            <p className="metric-card-big-value">
              <span className="text-primary">{formatNumber(summary.totalLinkingDomains)}</span>
            </p>
            <p className="metric-card-sub">unique domains linking to {summary.targetDomain}</p>
          </div>
          <div className="metric-card">
            <p className="metric-card-eyebrow">Total {countNoun}</p>
            <p className="metric-card-big-value">
              <span className="text-primary">{formatNumber(summary.totalHosts)}</span>
            </p>
            <p className="metric-card-sub">aggregate {countNoun} across referring domains</p>
          </div>
          <div className="metric-card">
            <p className="metric-card-eyebrow">Top-10 concentration</p>
            <p className="metric-card-big-value">
              {/* The share travels as a decimal string (0..1); a malformed one reads as a dash. */}
              <span className="text-primary">{formatPercent(Number(summary.top10HostsShare))}</span>
            </p>
            <p className="metric-card-sub">share of {countNoun} from the 10 largest linking domains</p>
          </div>
        </div>

        <p className="text-xs text-muted mt-2">
          <span className="text-secondary">Common Crawl</span> · {windowNoun}{' '}
          <code className="text-secondary">{summary.release}</code> · queried {relativeTime(summary.queriedAt)}
          {hiddenCount > 0 && <> · {hiddenCount} excluded domain{hiddenCount === 1 ? '' : 's'}</>}
        </p>
        {chartData.length >= 2 && (
          <Card className="surface-card p-4 mt-4">
            <p className="eyebrow eyebrow-soft">Referring domains over time</p>
            <div className="h-40 mt-2">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: 12 }}>
                  <defs>
                    <linearGradient id="bl-gradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CHART_SERIES_COLORS[0]} stopOpacity={0.4} />
                      <stop offset="100%" stopColor={CHART_SERIES_COLORS[0]} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} tickFormatter={formatQueriedAtTick} />
                  <YAxis tick={CHART_AXIS_TICK} stroke={CHART_AXIS_STROKE} allowDecimals={false} />
                  <RechartsTooltip
                    contentStyle={CHART_TOOLTIP_STYLE.contentStyle}
                    labelStyle={CHART_TOOLTIP_STYLE.labelStyle}
                    itemStyle={CHART_TOOLTIP_STYLE.itemStyle}
                    labelFormatter={formatQueriedAtLabel}
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
          <p className="eyebrow eyebrow-soft mb-2">Top referring domains</p>
          <Card className="surface-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-base text-left text-xs uppercase tracking-wide text-faint">
                  <th className="px-4 py-2 font-medium">Domain</th>
                  <th className="px-4 py-2 text-right font-medium">{countLabel}</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row: BacklinkDomainDto) => (
                  <tr key={row.linkingDomain} className="border-b border-mono-900 last:border-0">
                    <td className="px-4 py-2 text-strong">{row.linkingDomain}</td>
                    <td className="px-4 py-2 text-right text-secondary tabular-nums">{formatNumber(row.numHosts)}</td>
                  </tr>
                ))}
                {pageRows.length === 0 && (
                  <tr><td className="px-4 py-4 text-sm text-muted" colSpan={2}>
                    {hiddenCount > 0 && visibleTotal === 0
                      ? `Every referring domain in this ${windowNoun} was a crawler/proxy host (${hiddenCount} hidden).`
                      : `No referring domains in this ${windowNoun}.`}
                  </td></tr>
                )}
              </tbody>
            </table>
          </Card>
          <DataTablePagination
            page={page}
            pageSize={PAGE_SIZE}
            visibleRows={pageRows.length}
            totalRows={visibleTotal}
            onPageChange={(nextPage) => setOffset((nextPage - 1) * PAGE_SIZE)}
          />
        </div>

        <div className="mt-4 flex items-center gap-3 flex-wrap">
          {actions}
        </div>
      </>
    )
  }
}
