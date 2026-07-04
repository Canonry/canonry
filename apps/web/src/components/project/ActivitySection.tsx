import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
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
  CHART_NEUTRAL,
  CHART_SERIES_COLORS,
  formatChartDateLabel,
  formatChartDateTick,
} from '../shared/ChartPrimitives.js'

import { Link } from '@tanstack/react-router'
import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import type { MetricsWindow } from '@ainyc/canonry-contracts'
import type { MetricTone } from '../../view-models.js'
import {
  toneFromTrafficSourceStatus,
  useServerTrafficStatus,
} from '../../queries/server-traffic.js'
import {
  connectGa,
  triggerGaSync,
  disconnectGa,
  heyClient,
  isEmbed,
} from '../../api.js'
import {
  getApiV1ProjectsByNameGaAiReferralHistoryOptions,
  getApiV1ProjectsByNameGaSessionHistoryOptions,
  getApiV1ProjectsByNameGaSocialReferralHistoryOptions,
  getApiV1ProjectsByNameGaStatusOptions,
  getApiV1ProjectsByNameGaTrafficOptions,
} from '@ainyc/canonry-api-client/react-query'
import type { ApiGaStatus, ApiGaTraffic, ApiGaTrafficAiLandingPage, ApiGaTrafficPage, ApiGaTrafficReferral, ApiGaSocialReferral, GA4AiReferralHistoryEntry, GA4SessionHistoryEntry, GA4SocialReferralHistoryEntry } from '../../api.js'
import { TRAFFIC_STALE_MS } from '../../queries/query-client.js'
import { asyncHandler } from '../../lib/async-handler.js'
import {
  SOCIAL_OTHER_KEY,
  SOCIAL_TOTAL_KEY,
  aggregateSocialChartData,
  decodeSocialSourceLabel,
  truncateLabel,
} from '../../lib/social-chart-helpers.js'

const TRAFFIC_WINDOWS: MetricsWindow[] = ['7d', '30d', '90d', 'all']

const SOURCE_COLORS = CHART_SERIES_COLORS

const SOCIAL_OTHER_COLOR = CHART_NEUTRAL.textDim
const SOCIAL_TOTAL_COLOR = CHART_NEUTRAL.textFaint
const SOCIAL_TABLE_DEFAULT_LIMIT = 25
const AI_LANDING_PAGE_SIZE = 50

type PageSortKey = 'landingPage' | 'sessions' | 'organicSessions' | 'users'
type ReferralSortKey = 'source' | 'medium' | 'sessions' | 'users'
type SocialSortKey = 'source' | 'medium' | 'sessions' | 'users'
type AiLandingPageSortKey = 'landingPage' | 'source' | 'sessions' | 'users'
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

function ServerActivityPanel({ projectName }: { projectName: string }) {
  const { data, isLoading, isError } = useServerTrafficStatus(projectName)

  if (isLoading) {
    return (
      <Card className="p-5">
        <div className="text-sm text-muted">Loading server activity…</div>
      </Card>
    )
  }
  if (isError) {
    return (
      <Card className="p-5">
        <div className="text-sm text-negative-400">Failed to load server activity.</div>
      </Card>
    )
  }
  const sources = data?.sources ?? []

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="eyebrow">Server activity (last 24h)</div>
          <h2 className="text-lg font-semibold text-primary">Crawler hits, AI fetches &amp; AI referral sessions</h2>
          <p className="text-xs text-muted mt-1">
            Server-side log evidence of bulk crawlers, on-demand AI user fetches (ChatGPT-User, Perplexity-User),
            and AI referral sessions — orthogonal to GA4 click-through traffic below.{' '}
            {!isEmbed() && <Link to="/traffic" className="text-link hover:underline">Manage sources →</Link>}
          </p>
        </div>
      </div>

      {sources.length === 0 ? (
        <Card className="p-5">
          <div className="text-sm text-secondary">
            No server traffic source connected yet.{' '}
            {!isEmbed() && (
              <>
                <Link to="/traffic" className="text-link hover:underline">
                  Connect a traffic source
                </Link>{' '}
                to surface bot crawls and AI referrals straight from server logs.
              </>
            )}
          </div>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg-elevated/50 text-[10px] uppercase tracking-wide text-muted">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Source</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-right px-4 py-2 font-medium">Crawler hits 24h</th>
                <th className="text-right px-4 py-2 font-medium">AI hits 24h</th>
                <th className="text-right px-4 py-2 font-medium">AI sessions 24h</th>
                <th className="text-right px-4 py-2 font-medium">Last sync</th>
                <th className="text-left px-4 py-2 font-medium" aria-label="open" />
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id} className="border-t border-default">
                  <td className="px-4 py-3 text-heading">{s.displayName}</td>
                  <td className="px-4 py-3">
                    <ToneBadge tone={toneFromTrafficSourceStatus(s.status)}>{s.status}</ToneBadge>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-heading">
                    {s.totals24h.crawlerHits.toLocaleString('en-US')}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-heading">
                    {s.totals24h.aiUserFetchHits.toLocaleString('en-US')}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-heading">
                    {s.totals24h.aiReferralHits.toLocaleString('en-US')}
                  </td>
                  <td className="px-4 py-3 text-right text-secondary text-xs">
                    {s.lastSyncedAt ? relativeTime(s.lastSyncedAt) : 'never'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {isEmbed() ? (
                      <span className="text-muted text-xs">Detail</span>
                    ) : (
                      <Link
                        to="/traffic/$projectName/$sourceId"
                        params={{ projectName, sourceId: s.id }}
                        className="text-link hover:underline text-xs"
                      >
                        Detail →
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  )
}

export function ActivitySection({ projectName }: { projectName: string }) {
  return (
    <div className="space-y-10">
      <ServerActivityPanel projectName={projectName} />
      <ClickThroughActivity projectName={projectName} />
    </div>
  )
}

// Exported for focused testing of the GA4 click-through panel (e.g. landing-page
// pagination) without standing up a router for the sibling ServerActivityPanel's links.
export function ClickThroughActivity({ projectName }: { projectName: string }) {
  const queryClient = useQueryClient()
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
  const [aiLandingSortKey, setAiLandingSortKey] = useState<AiLandingPageSortKey>('sessions')
  const [aiLandingSortDir, setAiLandingSortDir] = useState<SortDir>('desc')
  const [aiLandingPage, setAiLandingPage] = useState(1)
  const [aiHistory, setAiHistory] = useState<GA4AiReferralHistoryEntry[]>([])
  const [sessionHistory, setSessionHistory] = useState<GA4SessionHistoryEntry[]>([])
  const [socialHistory, setSocialHistory] = useState<GA4SocialReferralHistoryEntry[]>([])
  const [socialTableExpanded, setSocialTableExpanded] = useState(false)
  const [trafficWindow, setTrafficWindow] = useState<MetricsWindow>('30d')

  async function loadData(cancelled: { current: boolean }) {
    setLoading(true)
    setError(null)
    try {
      // SDK `Ga4StatusDto.authMethod` types as `'service-account' | 'oauth'`
      // (Zod-to-JSON-Schema drops the `| null` on a nullable enum). Server
      // does return `null` for disconnected projects, so cast through the
      // hand-typed `ApiGaStatus` until that codegen edge is fixed upstream.
      const s = (await queryClient.fetchQuery({
        ...getApiV1ProjectsByNameGaStatusOptions({ client: heyClient, path: { name: projectName } }),
        staleTime: TRAFFIC_STALE_MS,
      })) as ApiGaStatus
      if (cancelled.current) return
      setStatus(s)

      if (!s.connected) {
        setTraffic(null)
        setAiHistory([])
        setSessionHistory([])
        setSocialHistory([])
        setLoading(false)
        return
      }

      // `window === 'all'` collapses to omitting the param; helper-level
      // contracts treat unset / 'all' identically.
      const windowParam = trafficWindow === 'all' ? undefined : trafficWindow
      const [trafficData, aiHistoryData, sessionHistoryData, socialHistoryData] = await Promise.all([
        // `/ga/traffic` still returns a loose-object response in the spec —
        // cast through `ApiGaTraffic` until `GaTrafficResponse` gains a Zod
        // schema and gets registered. SDK type is `{[k: string]: unknown}`.
        queryClient.fetchQuery({
          ...getApiV1ProjectsByNameGaTrafficOptions({
            client: heyClient,
            path: { name: projectName },
            query: windowParam ? { window: windowParam } : undefined,
          }),
          staleTime: TRAFFIC_STALE_MS,
        }).then((data) => data as unknown as ApiGaTraffic),
        queryClient.fetchQuery({
          ...getApiV1ProjectsByNameGaAiReferralHistoryOptions({
            client: heyClient,
            path: { name: projectName },
            query: windowParam ? { window: windowParam } : undefined,
          }),
          staleTime: TRAFFIC_STALE_MS,
        }).catch(() => [] as GA4AiReferralHistoryEntry[]),
        queryClient.fetchQuery({
          ...getApiV1ProjectsByNameGaSessionHistoryOptions({
            client: heyClient,
            path: { name: projectName },
            query: windowParam ? { window: windowParam } : undefined,
          }),
          staleTime: TRAFFIC_STALE_MS,
        }).catch(() => [] as GA4SessionHistoryEntry[]),
        queryClient.fetchQuery({
          ...getApiV1ProjectsByNameGaSocialReferralHistoryOptions({
            client: heyClient,
            path: { name: projectName },
            query: windowParam ? { window: windowParam } : undefined,
          }),
          staleTime: TRAFFIC_STALE_MS,
        }).catch(() => [] as GA4SocialReferralHistoryEntry[]),
      ])
      if (cancelled.current) return
      setTraffic(trafficData)
      setAiHistory(aiHistoryData)
      setSessionHistory(sessionHistoryData)
      setSocialHistory(socialHistoryData)
      setLoading(false)
    } catch (err) {
      if (cancelled.current) return
      setError(err instanceof Error ? err.message : 'Failed to load GA4 data')
      setLoading(false)
    }
  }

  useEffect(() => {
    const cancelled = { current: false }
    void loadData(cancelled)
    return () => {
      cancelled.current = true
    }
  }, [projectName, trafficWindow, queryClient])

  async function handleSync() {
    setSyncing(true)
    setError(null)
    setNotice(null)
    try {
      const result = await triggerGaSync(projectName)
      setNotice(`Synced ${result.rowCount.toLocaleString()} page rows, ${result.aiReferralCount.toLocaleString()} AI and ${result.socialReferralCount.toLocaleString()} social referral rows (${result.days} days)`)
      await queryClient.invalidateQueries({ predicate: (query) => { const head = query.queryKey[0] as { _id?: string } | undefined; return typeof head?._id === "string" && head._id.startsWith("getApiV1ProjectsByNameGa") } })
      await loadData({ current: false })
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
      await queryClient.invalidateQueries({ predicate: (query) => { const head = query.queryKey[0] as { _id?: string } | undefined; return typeof head?._id === "string" && head._id.startsWith("getApiV1ProjectsByNameGa") } })
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

  function handleAiLandingSort(key: AiLandingPageSortKey) {
    setAiLandingPage(1)
    if (aiLandingSortKey === key) {
      setAiLandingSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setAiLandingSortKey(key)
      setAiLandingSortDir('desc')
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

  const sortedAiLandingPages = useMemo(() => {
    if (!traffic?.aiReferralLandingPages) return []
    return [...traffic.aiReferralLandingPages].sort((a, b) => {
      const av = a[aiLandingSortKey]
      const bv = b[aiLandingSortKey]
      if (typeof av === 'string' && typeof bv === 'string') {
        return aiLandingSortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      return aiLandingSortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number)
    })
  }, [traffic?.aiReferralLandingPages, aiLandingSortKey, aiLandingSortDir])

  const aiLandingTotalPages = Math.max(1, Math.ceil(sortedAiLandingPages.length / AI_LANDING_PAGE_SIZE))
  // Clamp to a valid page so a stale page index (e.g. after a resync shrinks the list) still renders.
  const aiLandingCurrentPage = Math.min(Math.max(1, aiLandingPage), aiLandingTotalPages)
  const aiLandingPageStart = (aiLandingCurrentPage - 1) * AI_LANDING_PAGE_SIZE
  const pagedAiLandingPages = useMemo(
    () => sortedAiLandingPages.slice(aiLandingPageStart, aiLandingPageStart + AI_LANDING_PAGE_SIZE),
    [sortedAiLandingPages, aiLandingPageStart],
  )

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

  const { socialChartData, socialChartSources, socialOtherCount } = useMemo(() => {
    const agg = aggregateSocialChartData(socialHistory)
    return {
      socialChartData: agg.data,
      socialChartSources: agg.sources,
      socialOtherCount: agg.otherCount,
    }
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
    return <p className="text-sm text-muted py-8 text-center">Loading traffic data…</p>
  }

  // Not connected state
  if (!status?.connected) {
    if (isEmbed()) {
      return (
        <Card className="p-5">
          <div className="text-sm text-secondary">
            No Google Analytics 4 property connected yet.
          </div>
        </Card>
      )
    }
    return (
      <Ga4ConnectForm
        projectName={projectName}
        onConnected={() => {
          void (async () => {
            await queryClient.invalidateQueries({ predicate: (query) => { const head = query.queryKey[0] as { _id?: string } | undefined; return typeof head?._id === "string" && head._id.startsWith("getApiV1ProjectsByNameGa") } })
            await loadData({ current: false })
          })()
        }}
      />
    )
  }

  const organicPctDisplay = traffic?.organicSharePctDisplay ?? '0%'
  const breakdownOrganicPctDisplay = traffic?.channelBreakdown?.organic.sharePctDisplay ?? organicPctDisplay
  const breakdownOrganicSessions = traffic?.channelBreakdown?.organic.sessions ?? traffic?.totalOrganicSessions ?? 0
  const aiSessions = traffic?.aiSessionsDeduped ?? 0
  const aiSessionsBySession = traffic?.channelBreakdown?.ai.sessions ?? traffic?.aiSessionsBySession ?? 0
  const aiSharePctBySessionDisplay = traffic?.channelBreakdown?.ai.sharePctDisplay ?? traffic?.aiSharePctBySessionDisplay ?? '0%'
  const aiSourceCount = traffic ? new Set(traffic.aiReferrals.map((referral) => referral.source.toLowerCase())).size : 0
  const topAiSource = sortedAiReferrals[0] ?? null
  const directSessions = traffic?.totalDirectSessions ?? 0
  const directSharePctDisplay = traffic?.directSharePctDisplay ?? '0%'
  const breakdownDirectSessions = traffic?.channelBreakdown?.direct.sessions ?? directSessions
  const breakdownDirectPctDisplay = traffic?.channelBreakdown?.direct.sharePctDisplay ?? directSharePctDisplay
  const otherSessions = traffic?.channelBreakdown?.other.sessions ?? traffic?.otherSessions ?? 0
  const otherSharePctDisplay = traffic?.channelBreakdown?.other.sharePctDisplay ?? traffic?.otherSharePctDisplay ?? '0%'

  const socialSessions = traffic?.socialSessions ?? 0
  const socialSharePctDisplay = traffic?.socialSharePctDisplay ?? '0%'
  const breakdownSocialSessions = traffic?.channelBreakdown?.social.sessions ?? socialSessions
  const breakdownSocialPctDisplay = traffic?.channelBreakdown?.social.sharePctDisplay ?? socialSharePctDisplay
  const socialSourceCount = traffic ? new Set(traffic.socialReferrals.map((r) => r.source.toLowerCase())).size : 0
  const topSocialSource = sortedSocialReferrals[0] ?? null

  return (
    <>
      {/* Error / Notice banners */}
      {error && (
        <div className="mb-4 px-4 py-2 rounded-lg bg-negative-900/20 border border-negative-800/60 text-sm text-negative">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 px-4 py-2 rounded-lg bg-positive-900/20 border border-positive-800/60 text-sm text-positive">
          {notice}
        </div>
      )}

      {/* Connection info bar */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <span className="inline-block w-2 h-2 rounded-full bg-positive-500" />
          <span className="text-xs text-secondary">
            Property <span className="text-neutral">{status.propertyId}</span>
            {status.clientEmail && <> &middot; <span className="text-muted">{status.clientEmail}</span></>}
          </span>
        </div>
        {!isEmbed() && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={syncing}
              onClick={asyncHandler(handleSync)}
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing…' : 'Sync'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-negative-400 hover:text-negative"
              disabled={disconnecting}
              onClick={asyncHandler(handleDisconnect)}
            >
              <Unplug className="w-3.5 h-3.5 mr-1.5" />
              Disconnect
            </Button>
          </div>
        )}
      </div>

      {/* Summary gauges */}
      <section>
        <div className="mb-4 flex items-start justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1">Traffic Overview</p>
            <h2 className="text-base font-semibold text-primary flex items-center gap-1.5">
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
                    ? 'bg-mono-700 border-mono-600 text-primary'
                    : 'border-base text-secondary hover:border-strong hover:text-neutral'
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
              subtitle={`${organicPctDisplay} of total`}
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
          <div className="surface-card rounded-lg p-6 text-center border border-default">
            <p className="text-sm text-secondary mb-3">No traffic data yet.</p>
            {!isEmbed() && (
              <Button variant="outline" size="sm" disabled={syncing} onClick={asyncHandler(handleSync)}>
                <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${syncing ? 'animate-spin' : ''}`} />
                Sync from GA4
              </Button>
            )}
          </div>
        )}
      </section>

      {/* Traffic channel attribution */}
      {traffic && (
        <>
          <div className="page-section-divider" />

          <section>
            <div className="mb-4 flex items-end justify-between">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1">Traffic Attribution</p>
                <h2 className="text-base font-semibold text-primary flex items-center gap-1.5">
                  Traffic by channel
                  <InfoTooltip text="Decomposes GA4 sessions into five disjoint channels — known AI referrers first, then organic search, social, direct, and other channels. Known AI referrers are removed from their native GA4 channel before the residual Other bucket is computed. Other channels are the remaining GA4 session default channel groups, such as Referral, Email, Paid Search, Display, Cross-network, Shopping, Video, Affiliates, SMS, and Paid Other." />
                </h2>
              </div>
              {dateRange && (
                <p className="text-xs text-muted">
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
                    <h3 className="text-sm font-semibold text-heading">
                      {chartSources.length > 0 ? 'AI vs. total sessions' : 'All sessions (baseline)'}
                    </h3>
                    {chartSources.length === 0 && (
                      <p className="text-xs text-muted mt-0.5">AI referral sessions will be overlaid here once detected</p>
                    )}
                  </div>
                  {chartSources.length === 0 && (
                    <p className="text-xs text-muted">No AI referrals detected yet</p>
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
                        wrapperStyle={{ fontSize: 11, color: CHART_NEUTRAL.text }}
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
                        stroke={CHART_NEUTRAL.textFaint}
                        fill={CHART_NEUTRAL.surface}
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

            <Card className="surface-card p-5 mb-4">
              <div className="mb-4">
                <p className="eyebrow eyebrow-soft">Summary</p>
                <h3 className="text-sm font-semibold text-heading">Channel breakdown</h3>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <AttributionStat
                  label="Organic"
                  value={breakdownOrganicPctDisplay}
                  hint={`${breakdownOrganicSessions.toLocaleString()} sessions`}
                  tone="positive"
                  tooltip="Sessions from Google organic search (sessionDefaultChannelGrouping = 'Organic Search'), after known AI referrers are removed for a disjoint channel breakdown."
                />
                <AttributionStat
                  label="Social"
                  value={breakdownSocialPctDisplay}
                  hint={`${breakdownSocialSessions.toLocaleString()} sessions`}
                  tone="neutral"
                  tooltip="Sessions from social platforms (sessionDefaultChannelGrouping = 'Organic Social' or 'Paid Social'), after known AI referrers are removed for a disjoint channel breakdown."
                />
                <AttributionStat
                  label="Direct"
                  value={breakdownDirectPctDisplay}
                  hint={`${breakdownDirectSessions.toLocaleString()} sessions`}
                  tone="neutral"
                  tooltip="Sessions with no source — bookmarks, typed URLs, untagged email, in-app browsers, and AI-driven traffic whose referrer header was stripped. Known AI referrers are removed if GA4 classified them as Direct."
                />
                <AttributionStat
                  label="Known AI referrers (lower bound)"
                  value={aiSharePctBySessionDisplay}
                  hint={`${aiSessionsBySession.toLocaleString()} sessions`}
                  tone="positive"
                  tooltip="Sessions whose current sessionSource matched a known AI engine (e.g. chatgpt.com, claude.ai, gemini.google.com). These sessions are removed from their native GA4 channel in this card grid so the five buckets stay disjoint. This is a strict lower bound: most AI traffic strips the referrer and falls into Direct, so the true AI share is typically higher than what's shown here. The detail table below also surfaces firstUserSource and UTM-tagged AI signals."
                />
                <AttributionStat
                  label="Other channels"
                  value={otherSharePctDisplay}
                  hint={`${otherSessions.toLocaleString()} sessions`}
                  tone="neutral"
                  tooltip="Remaining GA4 session default channel groups after Known AI, Organic Search, Organic/Paid Social, and Direct are accounted for. This is a residual bucket, not a single source. It can include Referral, Email, Paid Search, Display, Cross-network, Shopping, Video, Affiliates, SMS, Mobile Push Notifications, Paid Other, and unclassified traffic."
                />
              </div>

              {topAiSource && (
                <div className="mt-4 rounded-lg border border-positive-800/40 bg-positive-500/6 px-4 py-3 text-sm text-positive-100">
                  Top AI referrer: <span className="font-medium">{topAiSource.source}</span> via {topAiSource.medium}, accounting for {topAiSource.sessions.toLocaleString()} sessions.
                </div>
              )}
            </Card>

            <Card className="surface-card p-5 mb-4">
              <div className="mb-4 flex items-end justify-between gap-3">
                <div>
                  <p className="eyebrow eyebrow-soft">Detail</p>
                  <h3 className="text-sm font-semibold text-heading">Known AI referrers by source</h3>
                </div>
                <p className="text-xs text-muted">
                  {traffic.aiReferrals.length > 0 ? `${aiSourceCount} unique sources, ${traffic.aiReferrals.length} rows` : 'No source rows'}
                </p>
              </div>

              {traffic.aiReferrals.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wider text-muted">
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
                  <p className="text-sm text-secondary mb-2">No AI referrer sessions detected yet</p>
                  <p className="text-xs text-muted max-w-sm">
                    AI engines that preserve a referrer (Perplexity, copy/paste from ChatGPT, etc.) will appear here. Most AI traffic strips the referrer — see the Direct cell above for the upper bound.
                  </p>
                </div>
              )}
            </Card>

            <Card className="surface-card p-5">
              <div className="mb-4 flex items-end justify-between gap-3">
                <div>
                  <p className="eyebrow eyebrow-soft">Detail</p>
                  <h3 className="text-sm font-semibold text-heading">Known AI referrers by landing page</h3>
                </div>
                <p className="text-xs text-muted">
                  {sortedAiLandingPages.length > AI_LANDING_PAGE_SIZE
                    ? `${aiLandingPageStart + 1}–${aiLandingPageStart + pagedAiLandingPages.length} of ${sortedAiLandingPages.length} rows`
                    : sortedAiLandingPages.length > 0
                      ? `${sortedAiLandingPages.length} rows`
                      : 'No landing-page rows'}
                </p>
              </div>

              {sortedAiLandingPages.length > 0 ? (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[10px] uppercase tracking-wider text-muted">
                          <SortHeader label="Landing Page" sortKey="landingPage" current={aiLandingSortKey} dir={aiLandingSortDir} onSort={handleAiLandingSort} align="left" />
                          <SortHeader label="Source" sortKey="source" current={aiLandingSortKey} dir={aiLandingSortDir} onSort={handleAiLandingSort} align="left" />
                          <th className="py-1 font-medium text-left">Attribution</th>
                          <SortHeader label="Sessions" sortKey="sessions" current={aiLandingSortKey} dir={aiLandingSortDir} onSort={handleAiLandingSort} align="right" />
                          <SortHeader label="Users" sortKey="users" current={aiLandingSortKey} dir={aiLandingSortDir} onSort={handleAiLandingSort} align="right" />
                        </tr>
                      </thead>
                      <tbody>
                        {pagedAiLandingPages.map((row) => (
                          <AiReferralLandingPageRow
                            key={`${row.landingPage}:${row.source}:${row.medium}:${row.sourceDimension}`}
                            row={row}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {aiLandingTotalPages > 1 && (
                    <div className="mt-3 flex items-center justify-center gap-2">
                      <button
                        type="button"
                        onClick={() => setAiLandingPage(aiLandingCurrentPage - 1)}
                        disabled={aiLandingCurrentPage <= 1}
                        className="text-xs text-secondary hover:text-strong disabled:opacity-40 disabled:hover:text-secondary px-3 py-1 rounded-full border border-base hover:border-strong disabled:hover:border-base transition-colors"
                      >
                        Previous
                      </button>
                      <span className="text-xs text-muted tabular-nums">
                        Page {aiLandingCurrentPage} of {aiLandingTotalPages}
                      </span>
                      <button
                        type="button"
                        onClick={() => setAiLandingPage(aiLandingCurrentPage + 1)}
                        disabled={aiLandingCurrentPage >= aiLandingTotalPages}
                        className="text-xs text-secondary hover:text-strong disabled:opacity-40 disabled:hover:text-secondary px-3 py-1 rounded-full border border-base hover:border-strong disabled:hover:border-base transition-colors"
                      >
                        Next
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <p className="text-sm text-secondary mb-2">No AI landing pages detected yet</p>
                  <p className="text-xs text-muted max-w-sm">
                    Known-AI landing pages appear after a GA4 sync records visits from AI referrers.
                  </p>
                </div>
              )}
            </Card>
          </section>
        </>
      )}

      {/* Social Media Referrals */}
      {traffic && (
        <>
          <div className="page-section-divider" />

          <section>
            <div className="mb-4">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1">Social Attribution</p>
              <h2 className="text-base font-semibold text-primary flex items-center gap-1.5">
                Social Media Traffic
                <InfoTooltip text="Tracks sessions classified as social traffic by GA4's default channel grouping (Organic Social and Paid Social). Google maintains the source-to-channel mapping." />
              </h2>
            </div>

            {socialChartData.length > 0 && (
              <Card className="surface-card p-5 mb-4">
                <div className="mb-4 flex items-end justify-between gap-3">
                  <div>
                    <p className="eyebrow eyebrow-soft">Trend</p>
                    <h3 className="text-sm font-semibold text-heading">Social sessions over time</h3>
                  </div>
                  {socialOtherCount > 0 && (
                    <p className="text-xs text-muted">
                      Showing top {socialChartSources.length - 1} sources · {socialOtherCount} more grouped as Other
                    </p>
                  )}
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
                          if (key === SOCIAL_TOTAL_KEY) return [formatted, 'Total Social']
                          if (key === SOCIAL_OTHER_KEY) {
                            const label = `Other (${socialOtherCount} source${socialOtherCount === 1 ? '' : 's'})`
                            return [formatted, label]
                          }
                          return [formatted, decodeSocialSourceLabel(key)]
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey={SOCIAL_TOTAL_KEY}
                        stroke={SOCIAL_TOTAL_COLOR}
                        fill={CHART_NEUTRAL.surface}
                        fillOpacity={0.4}
                        strokeWidth={1.5}
                        dot={false}
                      />
                      {socialChartSources.map((source, i) => {
                        const isOther = source === SOCIAL_OTHER_KEY
                        const color = isOther ? SOCIAL_OTHER_COLOR : SOURCE_COLORS[i % SOURCE_COLORS.length]
                        return (
                          <Area
                            key={source}
                            type="monotone"
                            dataKey={source}
                            stackId="social"
                            stroke={color}
                            fill={color}
                            fillOpacity={0.4}
                            strokeWidth={1.5}
                          />
                        )
                      })}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                <SocialChartLegend sources={socialChartSources} otherCount={socialOtherCount} />
              </Card>
            )}

            <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.5fr)]">
              <Card className="surface-card p-5">
                <div className="mb-4">
                  <p className="eyebrow eyebrow-soft">Summary</p>
                  <h3 className="text-sm font-semibold text-heading">Social media visits</h3>
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
                        value={socialSharePctDisplay}
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
                      <div className="mt-4 rounded-lg border border-info-800/40 bg-info-500/6 px-4 py-3 text-sm text-info-100">
                        <p className="text-xs uppercase tracking-wider text-info-300/70 mb-1">Top social source</p>
                        <p
                          className="font-medium truncate"
                          title={`${topSocialSource.source} via ${topSocialSource.medium}`}
                        >
                          {truncateLabel(decodeSocialSourceLabel(topSocialSource.source), 64)}
                        </p>
                        <p className="text-xs text-info-200/70 mt-0.5 truncate" title={topSocialSource.medium}>
                          via {decodeSocialSourceLabel(topSocialSource.medium)} · {topSocialSource.sessions.toLocaleString()} sessions
                        </p>
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
                    <div className="rounded-lg border border-default bg-surface px-4 py-3 text-sm text-secondary">
                      <p className="mb-1.5 text-neutral">Monitoring social media traffic via GA4 channel grouping</p>
                      <p className="text-xs text-muted">Sessions classified as Organic Social or Paid Social by GA4 will appear here. Google maintains the source-to-channel mapping, which includes Facebook, Instagram, X/Twitter, LinkedIn, Reddit, Pinterest, Snapchat, and other platforms.</p>
                    </div>
                  </div>
                )}
              </Card>

              <Card className="surface-card p-5">
                <div className="mb-4 flex items-end justify-between gap-3">
                  <div>
                    <p className="eyebrow eyebrow-soft">Breakdown</p>
                    <h3 className="text-sm font-semibold text-heading">Source / medium</h3>
                  </div>
                  <p className="text-xs text-muted">
                    {traffic.socialReferrals.length > 0
                      ? sortedSocialReferrals.length > SOCIAL_TABLE_DEFAULT_LIMIT && !socialTableExpanded
                        ? `Top ${SOCIAL_TABLE_DEFAULT_LIMIT} of ${sortedSocialReferrals.length}`
                        : `${sortedSocialReferrals.length} rows`
                      : 'No source rows'}
                  </p>
                </div>

                {traffic.socialReferrals.length > 0 ? (
                  <>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm table-fixed">
                        <colgroup>
                          <col className="w-[32%]" />
                          <col className="w-[22%]" />
                          <col className="w-[12%]" />
                          <col className="w-[11%]" />
                          <col className="w-[11%]" />
                          <col className="w-[12%]" />
                        </colgroup>
                        <thead>
                          <tr className="text-[10px] uppercase tracking-wider text-muted">
                            <SortHeader label="Source" sortKey="source" current={socialSortKey} dir={socialSortDir} onSort={handleSocialSort} align="left" />
                            <SortHeader label="Medium" sortKey="medium" current={socialSortKey} dir={socialSortDir} onSort={handleSocialSort} align="left" />
                            <th className="py-1 font-medium text-left">Channel</th>
                            <SortHeader label="Sessions" sortKey="sessions" current={socialSortKey} dir={socialSortDir} onSort={handleSocialSort} align="right" />
                            <th className="py-1 font-medium text-right">Share</th>
                            <SortHeader label="Users" sortKey="users" current={socialSortKey} dir={socialSortDir} onSort={handleSocialSort} align="right" />
                          </tr>
                        </thead>
                        <tbody>
                          {(socialTableExpanded
                            ? sortedSocialReferrals
                            : sortedSocialReferrals.slice(0, SOCIAL_TABLE_DEFAULT_LIMIT)
                          ).map((referral) => (
                            <SocialReferralRow key={`${referral.source}:${referral.medium}:${referral.channelGroup}`} referral={referral} totalSessions={socialSessions} />
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {sortedSocialReferrals.length > SOCIAL_TABLE_DEFAULT_LIMIT && (
                      <div className="mt-3 flex justify-center">
                        <button
                          type="button"
                          onClick={() => setSocialTableExpanded((v) => !v)}
                          className="text-xs text-secondary hover:text-strong px-3 py-1 rounded-full border border-base hover:border-strong transition-colors"
                        >
                          {socialTableExpanded
                            ? `Show top ${SOCIAL_TABLE_DEFAULT_LIMIT}`
                            : `Show all ${sortedSocialReferrals.length} sources`}
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center py-8 text-center">
                    <p className="text-sm text-secondary mb-2">No social media sessions detected yet</p>
                    <p className="text-xs text-muted max-w-sm">
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
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1">Page Performance</p>
              <h2 className="text-base font-semibold text-primary flex items-center gap-1.5">
                Top Landing Pages
                <InfoTooltip text="Landing pages ranked by session volume. Click column headers to sort. Organic % shows the share of sessions coming from Google organic search." />
              </h2>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-muted">
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
      <div className="mt-6 flex items-center justify-between text-xs text-muted">
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
        const parsed = JSON.parse(text) as { client_email?: string; private_key?: string }
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
      <h3 className="text-base font-semibold text-primary mb-1">Connect Google Analytics 4</h3>
      <p className="text-sm text-secondary mb-5">
        Connect a GA4 property to see traffic data for this project. You'll need a service account key file from Google Cloud Console.
      </p>

      {error && (
        <div className="mb-4 px-4 py-2 rounded-lg bg-negative-900/20 border border-negative-800/60 text-sm text-negative">
          {error}
        </div>
      )}

      {/* Step 1 — Property ID */}
      <div className="mb-4">
        <label htmlFor="ga4-property-id" className="block text-xs font-medium text-secondary mb-1.5">
          GA4 Property ID
        </label>
        <input
          id="ga4-property-id"
          type="text"
          placeholder="e.g. 123456789"
          value={propertyId}
          onChange={(e) => setPropertyId(e.target.value)}
          className="w-full rounded-lg bg-bg-elevated/60 border border-default px-3 py-2 text-sm text-strong placeholder-mono-600 focus:outline-none focus:ring-1 focus:ring-mono-600"
        />
        <p className="mt-1 text-[11px] text-muted">
          Find this in GA4 → Admin → Property Settings. It's a numeric ID, not the Measurement ID (G-XXXXXX).
        </p>
      </div>

      {/* Step 2 — Service account key file */}
      <div className="mb-5">
        <label className="block text-xs font-medium text-secondary mb-1.5">
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
          className="flex items-center gap-2 w-full rounded-lg bg-bg-elevated/60 border border-default border-dashed px-4 py-3 text-sm text-secondary hover:border-mono-600 hover:text-neutral transition-colors cursor-pointer"
        >
          <Upload className="w-4 h-4 shrink-0" />
          {fileName ? (
            <span className="text-strong truncate">{fileName}</span>
          ) : (
            <span>Upload .json key file</span>
          )}
        </button>
        <p className="mt-1 text-[11px] text-muted">
          Download from Google Cloud Console → IAM & Admin → Service Accounts → Keys → Add Key → JSON.
          The service account must have <span className="text-secondary">Viewer</span> access on the GA4 property.
        </p>
      </div>

      {/* Connect button */}
      <Button
        variant="default"
        size="sm"
        disabled={connecting || !propertyId.trim() || !keyJson}
        onClick={asyncHandler(handleConnect)}
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
    <th className={`py-1 ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button
        type="button"
        className="font-medium cursor-pointer select-none hover:text-neutral transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-mono-400 rounded"
        onClick={() => onSort(key)}
        aria-label={`Sort by ${label}${active ? ` (currently ${dir === 'asc' ? 'ascending' : 'descending'})` : ''}`}
      >
        {label}
        {active && <span className="ml-0.5">{dir === 'asc' ? '↑' : '↓'}</span>}
      </button>
    </th>
  )
}

const toneColor: Record<MetricTone, string> = {
  positive: 'text-positive-400',
  caution: 'text-caution-400',
  negative: 'text-negative-400',
  neutral: 'text-primary',
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
    <div className="rounded-lg bg-surface border border-default px-5 py-4">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1">{label}</p>
      <p className={`text-2xl font-bold tabular-nums ${toneColor[tone]}`}>{value}</p>
      <p className="text-xs text-muted mt-1">{subtitle}</p>
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
    <div className="rounded-lg border border-default bg-bg/40 px-4 py-3 flex flex-col">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1 flex items-center gap-1">
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </p>
      <p className={`text-xl font-semibold tabular-nums ${toneColor[tone]}`}>{value}</p>
      <p className="text-xs text-muted mt-1">{hint}</p>
    </div>
  )
}

function LandingPageRow({ page }: { page: ApiGaTrafficPage }) {
  const organicPct = page.sessions > 0
    ? ((page.organicSessions / page.sessions) * 100).toFixed(1)
    : '0.0'

  return (
    <tr className="border-t border-subtle">
      <td className="py-1.5 text-neutral max-w-[400px] truncate" title={page.landingPage}>
        {page.landingPage}
      </td>
      <td className="py-1.5 text-right text-strong tabular-nums">
        {page.sessions.toLocaleString()}
      </td>
      <td className="py-1.5 text-right text-positive-400 tabular-nums">
        {page.organicSessions.toLocaleString()}
      </td>
      <td className="py-1.5 text-right text-secondary tabular-nums">
        {organicPct}%
      </td>
      <td className="py-1.5 text-right text-strong tabular-nums">
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
    <tr className="border-t border-subtle">
      <td className="py-1.5 text-strong max-w-[220px] truncate" title={referral.source}>
        {referral.source}
      </td>
      <td className="py-1.5 text-muted max-w-[180px] truncate" title={referral.medium}>
        {referral.medium}
      </td>
      <td className="py-1.5">
        <span
          className="inline-block text-[10px] px-1.5 py-0.5 rounded-full border border-strong text-secondary"
          title={dimTooltip}
        >
          {dimLabel}
        </span>
      </td>
      <td className="py-1.5 text-right text-positive-400 tabular-nums">
        {referral.sessions.toLocaleString()}
      </td>
      <td className="py-1.5 text-right text-secondary tabular-nums">
        {share}%
      </td>
      <td className="py-1.5 text-right text-strong tabular-nums">
        {referral.users.toLocaleString()}
      </td>
    </tr>
  )
}

function AiReferralLandingPageRow({ row }: { row: ApiGaTrafficAiLandingPage }) {
  const dimLabel = DIMENSION_LABELS[row.sourceDimension] ?? row.sourceDimension
  const dimTooltip = DIMENSION_TOOLTIPS[row.sourceDimension] ?? ''

  return (
    <tr className="border-t border-subtle">
      <td className="py-1.5 text-neutral max-w-[360px] truncate" title={row.landingPage}>
        {row.landingPage}
      </td>
      <td className="py-1.5 text-strong max-w-[220px] truncate" title={row.source}>
        {row.source}
      </td>
      <td className="py-1.5">
        <span
          className="inline-block text-[10px] px-1.5 py-0.5 rounded-full border border-strong text-secondary"
          title={dimTooltip}
        >
          {dimLabel}
        </span>
      </td>
      <td className="py-1.5 text-right text-positive-400 tabular-nums">
        {row.sessions.toLocaleString()}
      </td>
      <td className="py-1.5 text-right text-strong tabular-nums">
        {row.users.toLocaleString()}
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
  const sourceDisplay = decodeSocialSourceLabel(referral.source)
  const mediumDisplay = decodeSocialSourceLabel(referral.medium)

  return (
    <tr className="border-t border-subtle">
      <td className="py-1.5 pr-3 text-strong truncate" title={referral.source}>
        {sourceDisplay}
      </td>
      <td className="py-1.5 pr-3 text-muted truncate" title={referral.medium}>
        {mediumDisplay}
      </td>
      <td className="py-1.5 pr-3">
        <span
          className="inline-block text-[10px] px-1.5 py-0.5 rounded-full border border-strong text-secondary"
          title={`GA4 channel group: ${referral.channelGroup}`}
        >
          {channelLabel}
        </span>
      </td>
      <td className="py-1.5 text-right text-info-400 tabular-nums">
        {referral.sessions.toLocaleString()}
      </td>
      <td className="py-1.5 text-right text-secondary tabular-nums">
        {share}%
      </td>
      <td className="py-1.5 text-right text-strong tabular-nums">
        {referral.users.toLocaleString()}
      </td>
    </tr>
  )
}

function SocialChartLegend({
  sources,
  otherCount,
}: {
  sources: string[]
  otherCount: number
}) {
  const items: Array<{ key: string; color: string; label: string; tooltip: string }> = [
    {
      key: SOCIAL_TOTAL_KEY,
      color: SOCIAL_TOTAL_COLOR,
      label: 'Total',
      tooltip: 'All social sessions across every source.',
    },
  ]

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]!
    if (source === SOCIAL_OTHER_KEY) {
      items.push({
        key: SOCIAL_OTHER_KEY,
        color: SOCIAL_OTHER_COLOR,
        label: `Other (${otherCount})`,
        tooltip: `${otherCount} smaller source${otherCount === 1 ? '' : 's'} grouped together`,
      })
    } else {
      const decoded = decodeSocialSourceLabel(source)
      items.push({
        key: source,
        color: SOURCE_COLORS[i % SOURCE_COLORS.length] ?? SOCIAL_OTHER_COLOR,
        label: truncateLabel(decoded, 32),
        tooltip: decoded,
      })
    }
  }

  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-secondary">
      {items.map((item) => (
        <div
          key={item.key}
          className="flex items-center gap-1.5 min-w-0 max-w-[260px]"
          title={item.tooltip}
        >
          <span
            className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
            style={{ backgroundColor: item.color }}
            aria-hidden="true"
          />
          <span className="truncate">{item.label}</span>
        </div>
      ))}
    </div>
  )
}
