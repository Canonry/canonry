import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Unplug, Upload } from 'lucide-react'
import {
  Area,
  ComposedChart,
  Legend,
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
import { InfoTooltip } from '../shared/InfoTooltip.js'
import type { MetricsWindow } from '@ainyc/canonry-contracts'
import type { MetricTone } from '../../view-models.js'
import {
  connectGa,
  fetchGaStatus,
  fetchGaTraffic,
  fetchGaAiReferralHistory,
  fetchGaSessionHistory,
  fetchGaSocialReferralHistory,
  triggerGaSync,
  disconnectGa,
} from '../../api.js'
import type { ApiGaStatus, ApiGaTraffic, ApiGaTrafficPage, ApiGaTrafficReferral, ApiGaSocialReferral, GA4AiReferralHistoryEntry, GA4SessionHistoryEntry, GA4SocialReferralHistoryEntry } from '../../api.js'

const TRAFFIC_WINDOWS: MetricsWindow[] = ['7d', '30d', '90d', 'all']

const SOURCE_COLORS = CHART_SERIES_COLORS

type PageSortKey = 'landingPage' | 'sessions' | 'organicSessions' | 'users'
type ReferralSortKey = 'source' | 'medium' | 'sessions' | 'users'
type SocialSortKey = 'source' | 'medium' | 'sessions' | 'users'
type SortDir = 'asc' | 'desc'

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
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

export function TrafficSection({ projectName }: { projectName: string }) {
  const [status, setStatus] = useState<ApiGaStatus | null>(null)
  const [traffic, setTraffic] = useState<ApiGaTraffic | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pageSortKey, setPageSortKey] = useState<PageSortKey>('sessions')
  const [pageSortDir, setPageSortDir] = useState<SortDir>('desc')
  const [referralSortKey, setReferralSortKey] = useState<ReferralSortKey>('sessions')
  const [referralSortDir, setReferralSortDir] = useState<SortDir>('desc')
  const [socialSortKey, setSocialSortKey] = useState<SocialSortKey>('sessions')
  const [socialSortDir, setSocialSortDir] = useState<SortDir>('desc')
  const [aiHistory, setAiHistory] = useState<GA4AiReferralHistoryEntry[]>([])
  const [sessionHistory, setSessionHistory] = useState<GA4SessionHistoryEntry[]>([])
  const [socialHistory, setSocialHistory] = useState<GA4SocialReferralHistoryEntry[]>([])
  const [trafficWindow, setTrafficWindow] = useState<MetricsWindow>('30d')

  function loadData(cancelled: { current: boolean }) {
    setLoading(true)
    fetchGaStatus(projectName)
      .then((s) => {
        if (cancelled.current) return
        setStatus(s)
        if (s.connected) {
          return Promise.all([
            fetchGaTraffic(projectName, undefined, trafficWindow),
            fetchGaAiReferralHistory(projectName, trafficWindow).catch(() => [] as GA4AiReferralHistoryEntry[]),
            fetchGaSessionHistory(projectName, trafficWindow).catch(() => [] as GA4SessionHistoryEntry[]),
            fetchGaSocialReferralHistory(projectName, trafficWindow).catch(() => [] as GA4SocialReferralHistoryEntry[]),
          ])
        }
        return null
      })
      .then((result) => {
        if (cancelled.current) return
        if (Array.isArray(result)) {
          setTraffic(result[0])
          setAiHistory(result[1])
          setSessionHistory(result[2])
          setSocialHistory(result[3])
        } else {
          setTraffic(null)
          setAiHistory([])
          setSessionHistory([])
          setSocialHistory([])
        }
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled.current) return
        setError(err instanceof Error ? err.message : 'Failed to load GA4 data')
        setLoading(false)
      })
  }

  useEffect(() => {
    const cancelled = { current: false }
    loadData(cancelled)
    return () => {
      cancelled.current = true
    }
  }, [projectName, trafficWindow])

  async function handleSync() {
    setSyncing(true)
    setError(null)
    setNotice(null)
    try {
      const result = await triggerGaSync(projectName)
      setNotice(`Synced ${result.rowCount.toLocaleString()} page rows, ${result.aiReferralCount.toLocaleString()} AI and ${result.socialReferralCount.toLocaleString()} social referral rows (${result.days} days)`)
      const [t, h, sh, soh] = await Promise.all([
        fetchGaTraffic(projectName, undefined, trafficWindow),
        fetchGaAiReferralHistory(projectName, trafficWindow).catch(() => [] as GA4AiReferralHistoryEntry[]),
        fetchGaSessionHistory(projectName, trafficWindow).catch(() => [] as GA4SessionHistoryEntry[]),
        fetchGaSocialReferralHistory(projectName, trafficWindow).catch(() => [] as GA4SocialReferralHistoryEntry[]),
      ])
      setTraffic(t)
      setAiHistory(h)
      setSessionHistory(sh)
      setSocialHistory(soh)
      const s = await fetchGaStatus(projectName)
      setStatus(s)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true)
    setError(null)
    setNotice(null)
    try {
      await disconnectGa(projectName)
      setStatus({ connected: false, propertyId: null, clientEmail: null, lastSyncedAt: null, createdAt: null, updatedAt: null })
      setTraffic(null)
      setNotice('GA4 disconnected')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Disconnect failed')
    } finally {
      setDisconnecting(false)
    }
  }

  function handlePageSort(key: PageSortKey) {
    if (pageSortKey === key) {
      setPageSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setPageSortKey(key)
      setPageSortDir('desc')
    }
  }

  function handleReferralSort(key: ReferralSortKey) {
    if (referralSortKey === key) {
      setReferralSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setReferralSortKey(key)
      setReferralSortDir('desc')
    }
  }

  function handleSocialSort(key: SocialSortKey) {
    if (socialSortKey === key) {
      setSocialSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSocialSortKey(key)
      setSocialSortDir('desc')
    }
  }

  const sortedPages = useMemo(() => {
    if (!traffic?.topPages) return []
    return [...traffic.topPages].sort((a, b) => {
      const av = a[pageSortKey]
      const bv = b[pageSortKey]
      if (typeof av === 'string' && typeof bv === 'string') {
        return pageSortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      return pageSortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number)
    })
  }, [traffic?.topPages, pageSortKey, pageSortDir])

  const sortedAiReferrals = useMemo(() => {
    if (!traffic?.aiReferrals) return []
    return [...traffic.aiReferrals].sort((a, b) => {
      const av = a[referralSortKey]
      const bv = b[referralSortKey]
      if (typeof av === 'string' && typeof bv === 'string') {
        return referralSortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      return referralSortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number)
    })
  }, [traffic?.aiReferrals, referralSortKey, referralSortDir])

  const sortedSocialReferrals = useMemo(() => {
    if (!traffic?.socialReferrals) return []
    return [...traffic.socialReferrals].sort((a, b) => {
      const av = a[socialSortKey]
      const bv = b[socialSortKey]
      if (typeof av === 'string' && typeof bv === 'string') {
        return socialSortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      return socialSortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number)
    })
  }, [traffic?.socialReferrals, socialSortKey, socialSortDir])

  const { socialChartData, socialChartSources } = useMemo(() => {
    const sources = [...new Set(socialHistory.map((r) => r.source))]
    const byDate = new Map<string, Record<string, number>>()

    for (const row of socialHistory) {
      let entry = byDate.get(row.date)
      if (!entry) {
        entry = { _socialTotal: 0 }
        byDate.set(row.date, entry)
      }
      entry[row.source] = (entry[row.source] ?? 0) + row.sessions
      entry._socialTotal = (entry._socialTotal ?? 0) + row.sessions
    }

    const data = [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, vals]) => ({ date, ...vals }))

    return { socialChartData: data, socialChartSources: sources }
  }, [socialHistory])

  // Keep this above the early returns so the hook order stays stable while the
  // component transitions from loading or disconnected to connected.
  const { chartData, chartSources, dateRange } = useMemo(() => {
    const sources = [...new Set(aiHistory.map((r) => r.source))]
    const byDate = new Map<string, Record<string, number>>()

    for (const row of sessionHistory) {
      byDate.set(row.date, { _totalSessions: row.sessions, _organicSessions: row.organicSessions })
    }

    // Deduplicate across attribution dimensions: sessionSource, firstUserSource,
    // and sessionManualSource are overlapping lenses, not disjoint visits. Take
    // MAX(sessions) per date+source across dimensions to avoid double-counting.
    const dedupedAi = new Map<string, number>()
    for (const row of aiHistory) {
      const key = `${row.date}::${row.source}`
      const prev = dedupedAi.get(key) ?? 0
      dedupedAi.set(key, Math.max(prev, row.sessions))
    }

    for (const [key, sessions] of dedupedAi) {
      const [date, source] = key.split('::')
      let entry = byDate.get(date!)
      if (!entry) {
        entry = { _totalSessions: 0, _organicSessions: 0 }
        byDate.set(date!, entry)
      }
      entry[source!] = (entry[source!] ?? 0) + sessions
    }

    const data = [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, vals]) => ({ date, ...vals }))

    const dates = data.map((d) => d.date)
    const range = dates.length > 0
      ? { start: dates[0], end: dates[dates.length - 1] }
      : null

    return { chartData: data, chartSources: sources, dateRange: range }
  }, [aiHistory, sessionHistory])

  if (loading && !status) {
    return <p className="text-sm text-zinc-500 py-8 text-center">Loading traffic data…</p>
  }

  // Not connected state
  if (!status?.connected) {
    return (
      <Ga4ConnectForm
        projectName={projectName}
        onConnected={() => loadData({ current: false })}
      />
    )
  }

  const organicPct = traffic?.organicSharePct ?? 0
  const aiSessions = traffic?.aiSessionsDeduped ?? 0
  const aiSharePct = traffic?.aiSharePct ?? 0
  const aiSourceCount = traffic ? new Set(traffic.aiReferrals.map((referral) => referral.source.toLowerCase())).size : 0
  const topAiSource = sortedAiReferrals[0] ?? null

  const socialSessions = traffic?.socialSessions ?? 0
  const socialSharePct = traffic?.socialSharePct ?? 0
  const socialSourceCount = traffic ? new Set(traffic.socialReferrals.map((r) => r.source.toLowerCase())).size : 0
  const topSocialSource = sortedSocialReferrals[0] ?? null

  return (
    <>
      {/* Error / Notice banners */}
      {error && (
        <div className="mb-4 px-4 py-2 rounded-lg bg-rose-900/20 border border-rose-800/60 text-sm text-rose-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 px-4 py-2 rounded-lg bg-emerald-900/20 border border-emerald-800/60 text-sm text-emerald-300">
          {notice}
        </div>
      )}

      {/* Connection info bar */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
          <span className="text-xs text-zinc-400">
            Property <span className="text-zinc-300">{status.propertyId}</span>
            {status.clientEmail && <> &middot; <span className="text-zinc-500">{status.clientEmail}</span></>}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={syncing}
            onClick={handleSync}
          >
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing…' : 'Sync'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-rose-400 hover:text-rose-300"
            disabled={disconnecting}
            onClick={handleDisconnect}
          >
            <Unplug className="w-3.5 h-3.5 mr-1.5" />
            Disconnect
          </Button>
        </div>
      </div>

      {/* Summary gauges */}
      <section>
        <div className="mb-4 flex items-start justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">Traffic Overview</p>
            <h2 className="text-base font-semibold text-zinc-50 flex items-center gap-1.5">
              Site Traffic
              <InfoTooltip text={`Aggregated traffic metrics from Google Analytics 4. Sessions and users are summed across the selected period.${traffic?.periodStart && traffic?.periodEnd ? ` Data available: ${new Date(traffic.periodStart + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} – ${new Date(traffic.periodEnd + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}.` : ''} Organic sessions are Google organic search sessions specifically.`} />
            </h2>
          </div>
          <div className="flex gap-1">
            {TRAFFIC_WINDOWS.map(w => (
              <button
                key={w}
                type="button"
                className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                  trafficWindow === w
                    ? 'bg-zinc-700 border-zinc-600 text-zinc-50'
                    : 'border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-300'
                }`}
                onClick={() => setTrafficWindow(w)}
              >
                {w === 'all' ? 'All' : w}
              </button>
            ))}
          </div>
        </div>

        {traffic ? (
          <div className="grid gap-4 md:grid-cols-3">
            <TrafficMetric
              value={formatCompact(traffic.totalSessions)}
              label="Total Sessions"
              subtitle={traffic.totalSessions.toLocaleString()}
              tone="neutral"
            />
            <TrafficMetric
              value={formatCompact(traffic.totalOrganicSessions)}
              label="Organic Sessions"
              subtitle={`${organicPct}% of total`}
              tone="positive"
            />
            <TrafficMetric
              value={formatCompact(traffic.totalUsers)}
              label="Total Users"
              subtitle={traffic.totalUsers.toLocaleString()}
              tone="neutral"
            />
          </div>
        ) : (
          <div className="surface-card rounded-lg p-6 text-center border border-zinc-800/60">
            <p className="text-sm text-zinc-400 mb-3">No traffic data yet.</p>
            <Button variant="outline" size="sm" disabled={syncing} onClick={handleSync}>
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${syncing ? 'animate-spin' : ''}`} />
              Sync from GA4
            </Button>
          </div>
        )}
      </section>

      {/* AI Referrals */}
      {traffic && (
        <>
          <div className="page-section-divider" />

          <section>
            <div className="mb-4 flex items-end justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">AI Attribution</p>
                <h2 className="text-base font-semibold text-zinc-50 flex items-center gap-1.5">
                  AI Referral Sources
                  <InfoTooltip text="Tracks sessions from known AI referrers and matching AI-tagged UTMs detected in GA4 sessionSource, firstUserSource, and sessionManualSource. Generic search sources are excluded to avoid false positives." />
                </h2>
              </div>
              {dateRange && (
                <p className="text-xs text-zinc-500">
                  {new Date(dateRange.start + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  {' \u2013 '}
                  {new Date(dateRange.end + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                </p>
              )}
            </div>

            {/* Always show the sessions chart when we have date-level data */}
            {chartData.length > 0 && (
              <Card className="surface-card p-5 mb-4">
                <div className="mb-4 flex items-end justify-between">
                  <div>
                    <p className="eyebrow eyebrow-soft">Trend</p>
                    <h3 className="text-sm font-semibold text-zinc-100">
                      {chartSources.length > 0 ? 'AI vs. total sessions' : 'All sessions (baseline)'}
                    </h3>
                    {chartSources.length === 0 && (
                      <p className="text-xs text-zinc-500 mt-0.5">AI referral sessions will be overlaid here once detected</p>
                    )}
                  </div>
                  {chartSources.length === 0 && (
                    <p className="text-xs text-zinc-500">No AI referrals detected yet</p>
                  )}
                </div>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                      <XAxis
                        dataKey="date"
                        tick={CHART_AXIS_TICK}
                        tickLine={false}
                        axisLine={{ stroke: CHART_AXIS_STROKE }}
                        tickFormatter={formatChartDateTick}
                      />
                      <YAxis
                        tick={CHART_AXIS_TICK}
                        tickLine={false}
                        axisLine={false}
                        allowDecimals={false}
                        width={36}
                      />
                      <RechartsTooltip
                        {...CHART_TOOLTIP_STYLE}
                        labelFormatter={formatChartDateLabel}
                        formatter={(value, name) => {
                          const formatted = typeof value === 'number' ? value.toLocaleString() : String(value ?? 0)
                          const key = String(name ?? '')
                          if (key === '_totalSessions') return [formatted, 'Total Sessions']
                          if (key === '_organicSessions') return [formatted, 'Organic Sessions']
                          return [formatted, key]
                        }}
                      />
                      <Legend
                        wrapperStyle={{ fontSize: 11, color: '#a1a1aa' }}
                        formatter={(value: string) => {
                          if (value === '_totalSessions') return 'Total Sessions'
                          if (value === '_organicSessions') return 'Organic Sessions'
                          return value
                        }}
                      />
                      {/* Total sessions as a subtle area */}
                      <Area
                        type="monotone"
                        dataKey="_totalSessions"
                        stroke="#52525b"
                        fill="#27272a"
                        fillOpacity={0.4}
                        strokeWidth={1.5}
                        dot={false}
                      />
                      {/* AI referral sources stacked on top */}
                      {chartSources.map((source, i) => (
                        <Area
                          key={source}
                          type="monotone"
                          dataKey={source}
                          stackId="ai"
                          stroke={SOURCE_COLORS[i % SOURCE_COLORS.length]}
                          fill={SOURCE_COLORS[i % SOURCE_COLORS.length]}
                          fillOpacity={0.4}
                          strokeWidth={1.5}
                        />
                      ))}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </Card>
            )}

            <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.5fr)]">
              <Card className="surface-card p-5">
                <div className="mb-4">
                  <p className="eyebrow eyebrow-soft">Summary</p>
                  <h3 className="text-sm font-semibold text-zinc-100">Attributable AI visits</h3>
                </div>

                {traffic.aiReferrals.length > 0 ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <AttributionStat
                        label="AI Sessions"
                        value={formatCompact(aiSessions)}
                        hint={`${aiSessions.toLocaleString()} sessions`}
                        tone="positive"
                        tooltip="Total sessions attributed to AI referral sources detected via GA4 sessionSource, firstUserSource, and sessionManualSource dimensions."
                      />
                      <AttributionStat
                        label="Share of Traffic"
                        value={`${aiSharePct}%`}
                        hint="of total sessions"
                        tone="neutral"
                        tooltip="Percentage of your total site sessions that originated from AI answer engines. A higher share indicates stronger AI-driven discovery."
                      />
                      <AttributionStat
                        label="Tracked Sources"
                        value={String(aiSourceCount)}
                        hint={`${traffic.aiReferrals.length} source rows`}
                        tone="neutral"
                        tooltip="Number of distinct AI referral sources detected. Each unique source/medium combination (e.g. chatgpt.com/referral) counts as one source row."
                      />
                    </div>

                    {topAiSource && (
                      <div className="mt-4 rounded-lg border border-emerald-800/40 bg-emerald-500/6 px-4 py-3 text-sm text-emerald-100">
                        Top AI referrer: <span className="font-medium">{topAiSource.source}</span> via {topAiSource.medium}, accounting for {topAiSource.sessions.toLocaleString()} sessions.
                      </div>
                    )}
                  </>
                ) : (
                  <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <AttributionStat label="AI Sessions" value="0" hint="0 sessions" tone="neutral" tooltip="Total sessions attributed to AI referral sources detected via GA4 sessionSource, firstUserSource, and sessionManualSource dimensions." />
                      <AttributionStat label="Share of Traffic" value="0%" hint="of total sessions" tone="neutral" tooltip="Percentage of your total site sessions that originated from AI answer engines." />
                      <AttributionStat label="Tracked Sources" value="0" hint="known AI sources" tone="neutral" tooltip="Number of distinct AI referral sources detected after matching known AI engine referrers and AI-tagged UTM sources." />
                    </div>
                    <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-4 py-3 text-sm text-zinc-400">
                      <p className="mb-1.5 text-zinc-300">Monitoring for AI referral traffic from:</p>
                      <p className="text-xs text-zinc-500">Known AI answer engines and matching UTM-tagged variants. Sessions will appear here once GA4 detects visits from tracked AI sources.</p>
                    </div>
                  </div>
                )}
              </Card>

              <Card className="surface-card p-5">
                <div className="mb-4 flex items-end justify-between gap-3">
                  <div>
                    <p className="eyebrow eyebrow-soft">Breakdown</p>
                    <h3 className="text-sm font-semibold text-zinc-100">Source / medium</h3>
                  </div>
                  <p className="text-xs text-zinc-500">
                    {traffic.aiReferrals.length > 0 ? `${traffic.aiReferrals.length} rows` : 'No source rows'}
                  </p>
                </div>

                {traffic.aiReferrals.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[10px] uppercase tracking-wider text-zinc-500">
                          <SortHeader label="Source" sortKey="source" current={referralSortKey} dir={referralSortDir} onSort={handleReferralSort} align="left" />
                          <SortHeader label="Medium" sortKey="medium" current={referralSortKey} dir={referralSortDir} onSort={handleReferralSort} align="left" />
                          <th className="py-1 font-medium text-left">Attribution</th>
                          <SortHeader label="Sessions" sortKey="sessions" current={referralSortKey} dir={referralSortDir} onSort={handleReferralSort} align="right" />
                          <th className="py-1 font-medium text-right">Share</th>
                          <SortHeader label="Users" sortKey="users" current={referralSortKey} dir={referralSortDir} onSort={handleReferralSort} align="right" />
                        </tr>
                      </thead>
                      <tbody>
                        {sortedAiReferrals.map((referral) => (
                          <AiReferralRow key={`${referral.source}:${referral.medium}:${referral.sourceDimension}`} referral={referral} totalSessions={aiSessions} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-8 text-center">
                    <p className="text-sm text-zinc-400 mb-2">No AI referrer sessions detected yet</p>
                    <p className="text-xs text-zinc-500 max-w-sm">
                      When visitors arrive from ChatGPT, Claude, Gemini, or other AI platforms, their sessions will be broken down here by source and medium.
                    </p>
                  </div>
                )}
              </Card>
            </div>
          </section>
        </>
      )}

      {/* Social Media Referrals */}
      {traffic && (
        <>
          <div className="page-section-divider" />

          <section>
            <div className="mb-4">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">Social Attribution</p>
              <h2 className="text-base font-semibold text-zinc-50 flex items-center gap-1.5">
                Social Media Traffic
                <InfoTooltip text="Tracks sessions classified as social traffic by GA4's default channel grouping (Organic Social and Paid Social). Google maintains the source-to-channel mapping." />
              </h2>
            </div>

            {socialChartData.length > 0 && (
              <Card className="surface-card p-5 mb-4">
                <div className="mb-4 flex items-end justify-between">
                  <div>
                    <p className="eyebrow eyebrow-soft">Trend</p>
                    <h3 className="text-sm font-semibold text-zinc-100">Social sessions over time</h3>
                  </div>
                </div>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={socialChartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                      <XAxis
                        dataKey="date"
                        tick={CHART_AXIS_TICK}
                        tickLine={false}
                        axisLine={{ stroke: CHART_AXIS_STROKE }}
                        tickFormatter={formatChartDateTick}
                      />
                      <YAxis
                        tick={CHART_AXIS_TICK}
                        tickLine={false}
                        axisLine={false}
                        allowDecimals={false}
                        width={36}
                      />
                      <RechartsTooltip
                        {...CHART_TOOLTIP_STYLE}
                        labelFormatter={formatChartDateLabel}
                        formatter={(value, name) => {
                          const formatted = typeof value === 'number' ? value.toLocaleString() : String(value ?? 0)
                          const key = String(name ?? '')
                          if (key === '_socialTotal') return [formatted, 'Total Social']
                          return [formatted, key]
                        }}
                      />
                      <Legend
                        wrapperStyle={{ fontSize: 11, color: '#a1a1aa' }}
                        formatter={(value: string) => {
                          if (value === '_socialTotal') return 'Total Social'
                          return value
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="_socialTotal"
                        stroke="#52525b"
                        fill="#27272a"
                        fillOpacity={0.4}
                        strokeWidth={1.5}
                        dot={false}
                      />
                      {socialChartSources.map((source, i) => (
                        <Area
                          key={source}
                          type="monotone"
                          dataKey={source}
                          stackId="social"
                          stroke={SOURCE_COLORS[i % SOURCE_COLORS.length]}
                          fill={SOURCE_COLORS[i % SOURCE_COLORS.length]}
                          fillOpacity={0.4}
                          strokeWidth={1.5}
                        />
                      ))}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </Card>
            )}

            <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.5fr)]">
              <Card className="surface-card p-5">
                <div className="mb-4">
                  <p className="eyebrow eyebrow-soft">Summary</p>
                  <h3 className="text-sm font-semibold text-zinc-100">Social media visits</h3>
                </div>

                {traffic.socialReferrals.length > 0 ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <AttributionStat
                        label="Social Sessions"
                        value={formatCompact(socialSessions)}
                        hint={`${socialSessions.toLocaleString()} sessions`}
                        tone="positive"
                        tooltip="Total sessions classified as Organic Social or Paid Social by GA4's default channel grouping."
                      />
                      <AttributionStat
                        label="Share of Traffic"
                        value={`${socialSharePct}%`}
                        hint="of total sessions"
                        tone="neutral"
                        tooltip="Percentage of your total site sessions that originated from social media platforms."
                      />
                      <AttributionStat
                        label="Platforms"
                        value={String(socialSourceCount)}
                        hint={`${traffic.socialReferrals.length} source rows`}
                        tone="neutral"
                        tooltip="Number of distinct social media platforms detected. Each unique source/medium combination counts as one source row."
                      />
                    </div>

                    {topSocialSource && (
                      <div className="mt-4 rounded-lg border border-sky-800/40 bg-sky-500/6 px-4 py-3 text-sm text-sky-100">
                        Top social source: <span className="font-medium">{topSocialSource.source}</span> via {topSocialSource.medium}, accounting for {topSocialSource.sessions.toLocaleString()} sessions.
                      </div>
                    )}
                  </>
                ) : (
                  <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <AttributionStat label="Social Sessions" value="0" hint="0 sessions" tone="neutral" tooltip="Total sessions attributed to social media platforms." />
                      <AttributionStat label="Share of Traffic" value="0%" hint="of total sessions" tone="neutral" tooltip="Percentage of your total site sessions from social media." />
                      <AttributionStat label="Platforms" value="0" hint="known platforms" tone="neutral" tooltip="Number of distinct social media platforms detected." />
                    </div>
                    <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-4 py-3 text-sm text-zinc-400">
                      <p className="mb-1.5 text-zinc-300">Monitoring social media traffic via GA4 channel grouping</p>
                      <p className="text-xs text-zinc-500">Sessions classified as Organic Social or Paid Social by GA4 will appear here. Google maintains the source-to-channel mapping, which includes Facebook, Instagram, X/Twitter, LinkedIn, Reddit, Pinterest, Snapchat, and other platforms.</p>
                    </div>
                  </div>
                )}
              </Card>

              <Card className="surface-card p-5">
                <div className="mb-4 flex items-end justify-between gap-3">
                  <div>
                    <p className="eyebrow eyebrow-soft">Breakdown</p>
                    <h3 className="text-sm font-semibold text-zinc-100">Source / medium</h3>
                  </div>
                  <p className="text-xs text-zinc-500">
                    {traffic.socialReferrals.length > 0 ? `${traffic.socialReferrals.length} rows` : 'No source rows'}
                  </p>
                </div>

                {traffic.socialReferrals.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[10px] uppercase tracking-wider text-zinc-500">
                          <SortHeader label="Source" sortKey="source" current={socialSortKey} dir={socialSortDir} onSort={handleSocialSort} align="left" />
                          <SortHeader label="Medium" sortKey="medium" current={socialSortKey} dir={socialSortDir} onSort={handleSocialSort} align="left" />
                          <th className="py-1 font-medium text-left">Channel</th>
                          <SortHeader label="Sessions" sortKey="sessions" current={socialSortKey} dir={socialSortDir} onSort={handleSocialSort} align="right" />
                          <th className="py-1 font-medium text-right">Share</th>
                          <SortHeader label="Users" sortKey="users" current={socialSortKey} dir={socialSortDir} onSort={handleSocialSort} align="right" />
                        </tr>
                      </thead>
                      <tbody>
                        {sortedSocialReferrals.map((referral) => (
                          <SocialReferralRow key={`${referral.source}:${referral.medium}:${referral.channelGroup}`} referral={referral} totalSessions={socialSessions} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-8 text-center">
                    <p className="text-sm text-zinc-400 mb-2">No social media sessions detected yet</p>
                    <p className="text-xs text-zinc-500 max-w-sm">
                      When visitors arrive from Facebook, X/Twitter, LinkedIn, or other social platforms, their sessions will be broken down here by source and medium.
                    </p>
                  </div>
                )}
              </Card>
            </div>
          </section>
        </>
      )}

      {/* Top Landing Pages */}
      {traffic && traffic.topPages.length > 0 && (
        <>
          <div className="page-section-divider" />

          <section>
            <div className="mb-4">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">Page Performance</p>
              <h2 className="text-base font-semibold text-zinc-50 flex items-center gap-1.5">
                Top Landing Pages
                <InfoTooltip text="Landing pages ranked by session volume. Click column headers to sort. Organic % shows the share of sessions coming from Google organic search." />
              </h2>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-zinc-500">
                    <SortHeader label="Landing Page" sortKey="landingPage" current={pageSortKey} dir={pageSortDir} onSort={handlePageSort} align="left" />
                    <SortHeader label="Sessions" sortKey="sessions" current={pageSortKey} dir={pageSortDir} onSort={handlePageSort} align="right" />
                    <SortHeader label="Organic" sortKey="organicSessions" current={pageSortKey} dir={pageSortDir} onSort={handlePageSort} align="right" />
                    <th className="text-right py-1 font-medium">Organic %</th>
                    <SortHeader label="Users" sortKey="users" current={pageSortKey} dir={pageSortDir} onSort={handlePageSort} align="right" />
                  </tr>
                </thead>
                <tbody>
                  {sortedPages.map((page) => (
                    <LandingPageRow key={page.landingPage} page={page} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {/* Footer */}
      <div className="mt-6 flex items-center justify-between text-xs text-zinc-500">
        <span>
          {traffic?.lastSyncedAt
            ? `Last synced ${relativeTime(traffic.lastSyncedAt)}`
            : 'Never synced'}
        </span>
        <span>{traffic ? `${traffic.topPages.length} pages · ${traffic.aiReferrals.length} AI rows · ${traffic.socialReferrals.length} social rows` : ''}</span>
      </div>
    </>
  )
}

function Ga4ConnectForm({ projectName, onConnected }: { projectName: string; onConnected: () => void }) {
  const [propertyId, setPropertyId] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [keyJson, setKeyJson] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = () => {
      const text = reader.result as string
      try {
        const parsed = JSON.parse(text)
        if (!parsed.client_email || !parsed.private_key) {
          setError('JSON file is missing required fields: client_email and private_key. Make sure you downloaded a service account key (not an OAuth client).')
          setKeyJson(null)
          return
        }
        setKeyJson(text)
      } catch {
        setError('File is not valid JSON. Please upload a service account key file (.json) downloaded from Google Cloud Console.')
        setKeyJson(null)
      }
    }
    reader.onerror = () => {
      setError('Failed to read file.')
      setKeyJson(null)
    }
    reader.readAsText(file)
  }, [])

  async function handleConnect() {
    setError(null)
    if (!propertyId.trim()) {
      setError('Property ID is required.')
      return
    }
    if (!keyJson) {
      setError('Please upload a service account key file.')
      return
    }
    setConnecting(true)
    try {
      await connectGa(projectName, { propertyId: propertyId.trim(), keyJson })
      // Trigger an initial sync so the user sees data immediately
      try {
        await triggerGaSync(projectName)
      } catch {
        // Sync failure is non-fatal — the connection succeeded and user can retry
      }
      onConnected()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect GA4')
    } finally {
      setConnecting(false)
    }
  }

  return (
    <Card className="surface-card p-6">
      <h3 className="text-base font-semibold text-zinc-50 mb-1">Connect Google Analytics 4</h3>
      <p className="text-sm text-zinc-400 mb-5">
        Connect a GA4 property to see traffic data for this project. You'll need a service account key file from Google Cloud Console.
      </p>

      {error && (
        <div className="mb-4 px-4 py-2 rounded-lg bg-rose-900/20 border border-rose-800/60 text-sm text-rose-300">
          {error}
        </div>
      )}

      {/* Step 1 — Property ID */}
      <div className="mb-4">
        <label htmlFor="ga4-property-id" className="block text-xs font-medium text-zinc-400 mb-1.5">
          GA4 Property ID
        </label>
        <input
          id="ga4-property-id"
          type="text"
          placeholder="e.g. 123456789"
          value={propertyId}
          onChange={(e) => setPropertyId(e.target.value)}
          className="w-full rounded-lg bg-zinc-900/60 border border-zinc-800/60 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600"
        />
        <p className="mt-1 text-[11px] text-zinc-500">
          Find this in GA4 → Admin → Property Settings. It's a numeric ID, not the Measurement ID (G-XXXXXX).
        </p>
      </div>

      {/* Step 2 — Service account key file */}
      <div className="mb-5">
        <label className="block text-xs font-medium text-zinc-400 mb-1.5">
          Service Account Key File
        </label>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          onChange={handleFileSelect}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-2 w-full rounded-lg bg-zinc-900/60 border border-zinc-800/60 border-dashed px-4 py-3 text-sm text-zinc-400 hover:border-zinc-600 hover:text-zinc-300 transition-colors cursor-pointer"
        >
          <Upload className="w-4 h-4 shrink-0" />
          {fileName ? (
            <span className="text-zinc-200 truncate">{fileName}</span>
          ) : (
            <span>Upload .json key file</span>
          )}
        </button>
        <p className="mt-1 text-[11px] text-zinc-500">
          Download from Google Cloud Console → IAM & Admin → Service Accounts → Keys → Add Key → JSON.
          The service account must have <span className="text-zinc-400">Viewer</span> access on the GA4 property.
        </p>
      </div>

      {/* Connect button */}
      <Button
        variant="default"
        size="sm"
        disabled={connecting || !propertyId.trim() || !keyJson}
        onClick={handleConnect}
      >
        {connecting ? 'Connecting & syncing…' : 'Connect GA4'}
      </Button>
    </Card>
  )
}

function SortHeader<K extends string>({
  label,
  sortKey: key,
  current,
  dir,
  onSort,
  align,
}: {
  label: string
  sortKey: K
  current: K
  dir: SortDir
  onSort: (key: K) => void
  align: 'left' | 'right'
}) {
  const active = current === key
  return (
    <th
      className={`py-1 font-medium cursor-pointer select-none hover:text-zinc-300 transition-colors ${align === 'right' ? 'text-right' : 'text-left'}`}
      onClick={() => onSort(key)}
    >
      {label}
      {active && <span className="ml-0.5">{dir === 'asc' ? '↑' : '↓'}</span>}
    </th>
  )
}

const toneColor: Record<MetricTone, string> = {
  positive: 'text-emerald-400',
  caution: 'text-amber-400',
  negative: 'text-rose-400',
  neutral: 'text-zinc-50',
}

function TrafficMetric({
  value,
  label,
  subtitle,
  tone,
}: {
  value: string
  label: string
  subtitle: string
  tone: MetricTone
}) {
  return (
    <div className="rounded-lg bg-zinc-900/30 border border-zinc-800/60 px-5 py-4">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold tabular-nums ${toneColor[tone]}`}>{value}</p>
      <p className="text-xs text-zinc-500 mt-1">{subtitle}</p>
    </div>
  )
}

function AttributionStat({
  value,
  label,
  hint,
  tone,
  tooltip,
}: {
  value: string
  label: string
  hint: string
  tone: MetricTone
  tooltip?: string
}) {
  return (
    <div className="rounded-lg border border-zinc-800/60 bg-zinc-950/40 px-4 py-3 flex flex-col">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1 flex items-center gap-1">
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </p>
      <p className={`text-xl font-semibold tabular-nums ${toneColor[tone]}`}>{value}</p>
      <p className="text-xs text-zinc-500 mt-1">{hint}</p>
    </div>
  )
}

function LandingPageRow({ page }: { page: ApiGaTrafficPage }) {
  const organicPct = page.sessions > 0
    ? ((page.organicSessions / page.sessions) * 100).toFixed(1)
    : '0.0'

  return (
    <tr className="border-t border-zinc-800/40">
      <td className="py-1.5 text-zinc-300 max-w-[400px] truncate" title={page.landingPage}>
        {page.landingPage}
      </td>
      <td className="py-1.5 text-right text-zinc-200 tabular-nums">
        {page.sessions.toLocaleString()}
      </td>
      <td className="py-1.5 text-right text-emerald-400 tabular-nums">
        {page.organicSessions.toLocaleString()}
      </td>
      <td className="py-1.5 text-right text-zinc-400 tabular-nums">
        {organicPct}%
      </td>
      <td className="py-1.5 text-right text-zinc-200 tabular-nums">
        {page.users.toLocaleString()}
      </td>
    </tr>
  )
}

const DIMENSION_LABELS: Record<string, string> = {
  session: 'Session',
  first_user: 'First Visit',
  manual_utm: 'UTM',
}

const DIMENSION_TOOLTIPS: Record<string, string> = {
  session: 'Detected via GA4 sessionSource (referrer or utm_source for this session)',
  first_user: 'Detected via GA4 firstUserSource (referrer from the user\'s first-ever visit)',
  manual_utm: 'Detected via GA4 sessionManualSource (explicit utm_source parameter for the session)',
}

function AiReferralRow({
  referral,
  totalSessions,
}: {
  referral: ApiGaTrafficReferral
  totalSessions: number
}) {
  const share = totalSessions > 0 ? ((referral.sessions / totalSessions) * 100).toFixed(1) : '0.0'
  const dimLabel = DIMENSION_LABELS[referral.sourceDimension] ?? referral.sourceDimension
  const dimTooltip = DIMENSION_TOOLTIPS[referral.sourceDimension] ?? ''

  return (
    <tr className="border-t border-zinc-800/40">
      <td className="py-1.5 text-zinc-200 max-w-[220px] truncate" title={referral.source}>
        {referral.source}
      </td>
      <td className="py-1.5 text-zinc-500 max-w-[180px] truncate" title={referral.medium}>
        {referral.medium}
      </td>
      <td className="py-1.5">
        <span
          className="inline-block text-[10px] px-1.5 py-0.5 rounded-full border border-zinc-700 text-zinc-400"
          title={dimTooltip}
        >
          {dimLabel}
        </span>
      </td>
      <td className="py-1.5 text-right text-emerald-400 tabular-nums">
        {referral.sessions.toLocaleString()}
      </td>
      <td className="py-1.5 text-right text-zinc-400 tabular-nums">
        {share}%
      </td>
      <td className="py-1.5 text-right text-zinc-200 tabular-nums">
        {referral.users.toLocaleString()}
      </td>
    </tr>
  )
}

function SocialReferralRow({
  referral,
  totalSessions,
}: {
  referral: ApiGaSocialReferral
  totalSessions: number
}) {
  const share = totalSessions > 0 ? ((referral.sessions / totalSessions) * 100).toFixed(1) : '0.0'
  const channelLabel = referral.channelGroup === 'Paid Social' ? 'Paid' : 'Organic'

  return (
    <tr className="border-t border-zinc-800/40">
      <td className="py-1.5 text-zinc-200 max-w-[220px] truncate" title={referral.source}>
        {referral.source}
      </td>
      <td className="py-1.5 text-zinc-500 max-w-[180px] truncate" title={referral.medium}>
        {referral.medium}
      </td>
      <td className="py-1.5">
        <span
          className="inline-block text-[10px] px-1.5 py-0.5 rounded-full border border-zinc-700 text-zinc-400"
          title={`GA4 channel group: ${referral.channelGroup}`}
        >
          {channelLabel}
        </span>
      </td>
      <td className="py-1.5 text-right text-sky-400 tabular-nums">
        {referral.sessions.toLocaleString()}
      </td>
      <td className="py-1.5 text-right text-zinc-400 tabular-nums">
        {share}%
      </td>
      <td className="py-1.5 text-right text-zinc-200 tabular-nums">
        {referral.users.toLocaleString()}
      </td>
    </tr>
  )
}
