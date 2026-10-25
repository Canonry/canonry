import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Unplug, Upload } from 'lucide-react'

import { Link } from '@tanstack/react-router'
import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import {
  DataTablePagination,
  DataTableSearch,
  MiddleTruncatedText,
  urlSearchText,
  useClientTable,
} from '../shared/DataTableControls.js'
import { AiTrafficHistoryPanel } from './AiTrafficHistoryPanel.js'
import {
  DisclosureRow,
  DisclosureRows,
  GroupedReferralTable,
  KpiRow,
  PlainHeader,
  SectionHeading,
  SiteTrafficCard,
  SortHeader,
  StackedSeriesChart,
  type SortDir,
} from './ActivityParts.js'
import { MetricsWindowPicker } from '../shared/MetricsWindowPicker.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import {
  GA_SEARCH_LANDING_DEFAULT_WINDOW,
  GA_SEARCH_LANDING_MAX_LIMIT,
  GA_SEARCH_LANDING_WINDOWS,
  formatDate,
  formatPercent,
  gaSearchLandingHasSearchData,
  gaSearchLandingPageLabel,
  type GaSearchLandingPageRow,
  type GaSearchLandingPagesResponse,
  type GaOverviewResponse,
  type GaSearchLandingWindow,
  type MetricsWindow,
  isGaOverviewWindow,
} from '@canonry/canonry-contracts'
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
  isPublicDemo,
} from '../../api.js'
import {
  getApiV1ProjectsByNameGaAiReferralDailyOptions,
  getApiV1ProjectsByNameGaOverviewOptions,
  getApiV1ProjectsByNameGaSearchLandingPagesOptions,
  getApiV1ProjectsByNameGaSessionHistoryOptions,
  getApiV1ProjectsByNameGaStatusOptions,
  getApiV1ProjectsByNameGaTrafficOptions,
} from '@canonry/canonry-api-client/react-query'
import type { ApiGaStatus, ApiGaTraffic, ApiGaTrafficAiLandingPage, ApiGaTrafficPage, ApiGaTrafficReferral, ApiGaSocialReferral, GA4AiReferralDailyDto, GA4SessionHistoryEntry } from '../../api.js'
import { TRAFFIC_STALE_MS } from '../../queries/query-client.js'
import { invalidateProjectQueryDomain } from '../../queries/query-invalidation.js'
import { asyncHandler } from '../../lib/async-handler.js'
import { decodeSocialSourceLabel } from '../../lib/social-source-label.js'

// 'all' is deliberately absent. GA treats it as unbounded retention; the
// server lane is queried with `since`, which has no unbounded form (omitting it
// means 24h, not everything). One control offering 'all' therefore labelled two
// incomparable ranges identically. 7d/30d/90d mean the same thing in both lanes.
const TRAFFIC_WINDOWS: MetricsWindow[] = ['7d', '30d', '90d']

// The server-side lane is queried in minutes, the GA lane by window name. One
// control drives both, so the mapping lives here rather than in either consumer.
// 'all' is capped at 90 days: `sinceMinutes` has no unbounded representation,
// and an uncapped scan is not what the operator is asking for from a chart.
const TRAFFIC_WINDOW_MINUTES: Record<MetricsWindow, number> = {
  '7d': 7 * 24 * 60,
  '30d': 30 * 24 * 60,
  '90d': 90 * 24 * 60,
  // Unreachable from the control (see TRAFFIC_WINDOWS); present only to satisfy
  // the MetricsWindow key set. Never rendered as a selectable range.
  all: 90 * 24 * 60,
}

function aiLandingPageSearchText(row: ApiGaTrafficAiLandingPage): string {
  return urlSearchText(row.landingPage)
}
const AI_LANDING_PAGE_SIZE = 25
const TOP_PAGE_SIZE = 10

const EMPTY_AI_DAILY: GA4AiReferralDailyDto = {
  days: [],
  sources: [],
  totalSessions: 0,
  totalPaidSessions: 0,
  totalOrganicSessions: 0,
  byEngine: { series: [], otherCount: 0, days: [] },
}

// No 'users': GA counts users DISTINCT at the grain requested, so an AI
// landing-page user total cannot be summed and is no longer emitted.
type PageSortKey = 'landingPage' | 'sessions' | 'organicSessions'
type AiLandingPageSortKey = 'landingPage' | 'source' | 'sessions'

export const ACTIVITY_COPY = {
  siteTrafficTooltip: 'GA4\'s own figures for the complete days ending yesterday, as GA4 counts them, each against the period of the same length before it. Pick a figure in any slot to chart it by day.',
  siteTrafficFallbackTooltip: 'Sessions, Google organic search sessions and distinct users from GA4. Distinct users are unavailable when the selected range has no stored GA4 aggregate.',
  channelTooltip: 'GA4 sessions split into five channels that do not overlap. AI sessions are taken out of the channel GA4 filed them under before the rest is counted.',
  organicTooltip: 'Sessions from Google organic search, after AI sessions are taken out.',
  socialTooltip: 'Organic Social and Paid Social sessions, after AI sessions are taken out.',
  directTooltip: 'Sessions with no source: bookmarks, typed URLs, untagged email and in-app browsers. AI visits that send no referrer land here too.',
  aiTooltip: 'Sessions in GA4\'s AI Assistant channel or from a known AI source. Paid AI comes from paid UTM values or a GA4 paid channel group. AI visits that send no referrer count as Direct, so this is a floor.',
  otherTooltip: 'Every other GA4 channel, such as Referral, Email, Paid Search, Display and Video.',
  aiEnginesTooltip: 'AI referral sessions by engine. Open an engine to see the sources GA4 reported. Unattributed AI is AI traffic whose source names no engine.',
  aiChartLabel: 'AI sessions by engine',
  socialTooltip2: 'Sessions GA4 classifies as Organic Social or Paid Social, grouped by platform. Open a platform to see the sources GA4 reported for it.',
  platformsTooltip: 'Platforms with sessions in this period. A source no platform matches counts as its own platform.',
  paidSocialTooltip: 'Sessions in GA4\'s Paid Social channel.',
  socialChartLabel: 'Social sessions by platform',
  noAiReferrals: 'No AI referrals in this period.',
  noAiLandingPages: 'No AI landing pages in this period.',
  noSocial: 'No social sessions in this period.',
  noneInPeriod: 'None in this period',
  aiHistoryTooltip: 'Daily AI crawls, page fetches and visits from connected traffic sources, with GA4 visits beside server visits.',
} as const

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

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

/** "Oct 7 to Oct 20, 2026" for the window every figure was measured over. */
function formatWindow(start: string | null, end: string | null): string | null {
  if (!start || !end) return null
  const from = new Date(`${start}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const to = new Date(`${end}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  return `${from} to ${to}`
}

function ServerActivityPanel({ projectName }: { projectName: string }) {
  const { data, isLoading, isError } = useServerTrafficStatus(projectName)
  const sources = data?.sources ?? []

  return (
    <section aria-labelledby="server-activity-heading">
      <SectionHeading
        id="server-activity-heading"
        title="Server activity"
        tooltip="Crawler, AI fetch and AI referral activity from connected traffic sources over the last 24 hours."
        meta="Last 24 hours"
        actions={!isEmbed() && sources.length > 0 ? <Link to="/traffic" className="text-sm text-link hover:underline">Manage sources</Link> : undefined}
      />
      {isLoading ? (
        <p className="text-sm text-secondary">Loading server activity…</p>
      ) : isError ? (
        <p role="alert" className="text-sm text-negative">Could not load server activity.</p>
      ) : sources.length === 0 ? (
        <p className="text-sm text-secondary">
          No traffic source connected.{' '}
          {!isEmbed() && <Link to="/traffic" className="text-link hover:underline">Connect a source</Link>}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b border-default">
                <PlainHeader label="Source" align="left" />
                <PlainHeader label="Status" align="left" />
                <PlainHeader label="Crawler hits" align="right" />
                <PlainHeader label="AI hits" align="right" />
                <PlainHeader label="AI sessions" align="right" />
                <PlainHeader label="Last sync" align="right" />
                <th className="py-2" aria-label="Detail" />
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id} className="border-t border-subtle">
                  <td className="py-2 pr-3 text-strong">{s.displayName}</td>
                  <td className="py-2 pr-3">
                    <ToneBadge tone={toneFromTrafficSourceStatus(s.status)}>{s.status}</ToneBadge>
                  </td>
                  <td className="py-2 pl-4 text-right tabular-nums text-primary">{s.totals24h.crawlerHits.toLocaleString('en-US')}</td>
                  <td className="py-2 pl-4 text-right tabular-nums text-primary">{s.totals24h.aiUserFetchHits.toLocaleString('en-US')}</td>
                  <td className="py-2 pl-4 text-right tabular-nums text-primary">{s.totals24h.aiReferralLandedHits.toLocaleString('en-US')}</td>
                  <td className="py-2 pl-4 text-right text-secondary">{s.lastSyncedAt ? relativeTime(s.lastSyncedAt) : 'never'}</td>
                  <td className="py-2 pl-3 text-right">
                    {!isEmbed() && (
                      <Link
                        to="/traffic/$projectName/$sourceId"
                        params={{ projectName, sourceId: s.id }}
                        className="text-link hover:underline"
                        aria-label={`${s.displayName} detail`}
                      >
                        Detail
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export function ActivitySection({ projectName }: { projectName: string }) {
  // Owned here so every panel below reads the same range. The GA4 overview only
  // shows the control in its heading; no GA4 state can take it away.
  const [trafficWindow, setTrafficWindow] = useState<MetricsWindow>('30d')
  return (
    <div>
      <ServerActivityPanel projectName={projectName} />
      <div className="page-section-divider" />
      <ClickThroughActivity
        projectName={projectName}
        window={trafficWindow}
        periodControl={(
          <MetricsWindowPicker
            windows={TRAFFIC_WINDOWS}
            value={trafficWindow}
            onChange={setTrafficWindow}
            label="Traffic time period"
          />
        )}
        between={(
          <>
            <div className="page-section-divider" />
            <section aria-labelledby="ai-traffic-history-heading">
              <SectionHeading
                id="ai-traffic-history-heading"
                title="AI traffic history"
                tooltip={ACTIVITY_COPY.aiHistoryTooltip}
              />
              <AiTrafficHistoryPanel
                projectName={projectName}
                sinceMinutes={TRAFFIC_WINDOW_MINUTES[trafficWindow]}
              />
            </section>
          </>
        )}
      />
    </div>
  )
}

const DIMENSION_LABELS: Record<string, string> = {
  session: 'Session',
  first_user: 'First visit',
  manual_utm: 'UTM',
}

const DIMENSION_TOOLTIPS: Record<string, string> = {
  session: 'Detected via GA4 sessionSource (referrer or utm_source for this session)',
  first_user: 'Detected via GA4 firstUserSource (referrer from the user\'s first-ever visit)',
  manual_utm: 'Detected via GA4 sessionManualSource (explicit utm_source parameter for the session)',
}

const AI_SOURCE_COLUMNS = [
  { label: 'Source', align: 'left' },
  { label: 'Medium', align: 'left' },
  { label: 'Class', align: 'left' },
  { label: 'Attribution', align: 'left' },
  { label: 'Sessions', align: 'right' },
  { label: 'Share', align: 'right' },
] as const

const SOCIAL_SOURCE_COLUMNS = [
  { label: 'Source', align: 'left' },
  { label: 'Medium', align: 'left' },
  { label: 'Channel', align: 'left' },
  { label: 'Sessions', align: 'right' },
  { label: 'Share', align: 'right' },
] as const

/** AI traffic whose source names no engine: counted, never given an engine, listed last. */
function isUnattributedAiGroup(group: { engine: string | null }): boolean {
  return group.engine === null
}

function AiSourceCells({ row }: { row: ApiGaTrafficReferral }) {
  return (
    <>
      <td className="max-w-[220px] truncate py-1.5 pr-3 text-strong" title={row.source}>{row.source}</td>
      <td className="max-w-[160px] truncate py-1.5 pr-3 text-secondary" title={row.medium}>{row.medium}</td>
      <td
        className="py-1.5 pr-3 text-secondary"
        title={row.trafficClass === 'paid'
          ? 'Paid AI traffic, from paid UTM values or a GA4 paid channel group'
          : 'AI traffic without a paid attribution signal'}
      >
        {row.trafficClass === 'paid' ? 'Paid' : 'Organic'}
      </td>
      <td className="py-1.5 pr-3 text-secondary" title={DIMENSION_TOOLTIPS[row.sourceDimension] ?? ''}>
        {DIMENSION_LABELS[row.sourceDimension] ?? row.sourceDimension}
      </td>
      <td className="py-1.5 pl-4 text-right text-primary tabular-nums">{row.sessions.toLocaleString()}</td>
      <td className="py-1.5 pl-4 text-right text-secondary tabular-nums">{formatPercent(row.share)}</td>
    </>
  )
}

function SocialSourceCells({ row }: { row: ApiGaSocialReferral }) {
  return (
    <>
      <td className="max-w-[240px] truncate py-1.5 pr-3 text-strong" title={row.source}>{decodeSocialSourceLabel(row.source)}</td>
      <td className="max-w-[160px] truncate py-1.5 pr-3 text-secondary" title={row.medium}>{decodeSocialSourceLabel(row.medium)}</td>
      <td className="py-1.5 pr-3 text-secondary" title={`GA4 channel group: ${row.channelGroup}`}>
        {row.channelGroup === 'Paid Social' ? 'Paid social' : 'Organic social'}
      </td>
      <td className="py-1.5 pl-4 text-right text-primary tabular-nums">{row.sessions.toLocaleString()}</td>
      <td className="py-1.5 pl-4 text-right text-secondary tabular-nums">{formatPercent(row.share)}</td>
    </>
  )
}

/** GA4 reads and actions for the Activity tab, shared by its overview and its detail sections. */
function useGaActivity(projectName: string, trafficWindow: MetricsWindow) {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<ApiGaStatus | null>(null)
  const [traffic, setTraffic] = useState<ApiGaTraffic | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [aiDaily, setAiDaily] = useState<GA4AiReferralDailyDto>(EMPTY_AI_DAILY)
  const [sessionHistory, setSessionHistory] = useState<GA4SessionHistoryEntry[]>([])
  const [overview, setOverview] = useState<GaOverviewResponse | null>(null)

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
        setAiDaily(EMPTY_AI_DAILY)
        setSessionHistory([])
        setOverview(null)
        setLoading(false)
        return
      }

      // `window === 'all'` collapses to omitting the param; helper-level
      // contracts treat unset / 'all' identically. The Social chart rides in
      // the traffic response, so it shares that response's window by
      // construction.
      const windowParam = trafficWindow === 'all' ? undefined : trafficWindow
      const [trafficData, aiDailyData, sessionHistoryData, overviewData] = await Promise.all([
        queryClient.fetchQuery({
          ...getApiV1ProjectsByNameGaTrafficOptions({
            client: heyClient,
            path: { name: projectName },
            query: windowParam ? { window: windowParam } : undefined,
          }),
          staleTime: TRAFFIC_STALE_MS,
        }),
        queryClient.fetchQuery({
          ...getApiV1ProjectsByNameGaAiReferralDailyOptions({
            client: heyClient,
            path: { name: projectName },
            query: windowParam ? { window: windowParam } : undefined,
          }),
          staleTime: TRAFFIC_STALE_MS,
        }).catch(() => EMPTY_AI_DAILY),
        queryClient.fetchQuery({
          ...getApiV1ProjectsByNameGaSessionHistoryOptions({
            client: heyClient,
            path: { name: projectName },
            query: windowParam ? { window: windowParam } : undefined,
          }),
          staleTime: TRAFFIC_STALE_MS,
        }).catch(() => [] as GA4SessionHistoryEntry[]),
        // The GA4 overview has no 'all' window; the page never offers one.
        // A server too old for the read leaves the plain figures in its place.
        queryClient.fetchQuery({
          ...getApiV1ProjectsByNameGaOverviewOptions({
            client: heyClient,
            path: { name: projectName },
            query: { window: isGaOverviewWindow(trafficWindow) ? trafficWindow : '30d' },
          }),
          staleTime: TRAFFIC_STALE_MS,
        }).catch(() => null),
      ])
      if (cancelled.current) return
      setTraffic(trafficData)
      setAiDaily(aiDailyData)
      setSessionHistory(sessionHistoryData)
      setOverview(overviewData)
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
      await invalidateProjectQueryDomain(queryClient, 'ga')
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
      await invalidateProjectQueryDomain(queryClient, 'ga')
      setStatus({ connected: false, propertyId: null, clientEmail: null, lastSyncedAt: null, createdAt: null, updatedAt: null })
      setTraffic(null)
      setOverview(null)
      setNotice('GA4 disconnected')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Disconnect failed')
    } finally {
      setDisconnecting(false)
    }
  }

  async function handleConnected() {
    await invalidateProjectQueryDomain(queryClient, 'ga')
    await loadData({ current: false })
  }

  return {
    status,
    traffic,
    loading,
    syncing,
    disconnecting,
    error,
    notice,
    aiDaily,
    sessionHistory,
    overview,
    handleSync,
    handleDisconnect,
    handleConnected,
  }
}

type GaActivity = ReturnType<typeof useGaActivity>

// Exported for focused testing of the GA4 panels (e.g. landing-page pagination)
// without standing up a router for the ServerActivityPanel's links.
export function ClickThroughActivity({ projectName, window: windowProp, periodControl, between }: {
  projectName: string
  /** Owned by ActivitySection, which renders the only picker on the page. */
  window?: MetricsWindow
  /** That picker, shown in the Site traffic heading. Absent when mounted alone. */
  periodControl?: ReactNode
  /**
   * Rendered between the GA4 overview and the GA4 detail sections, and outside
   * every GA4 state: GaOverview and GaDetails own the loading state and the
   * connect prompt, so a disconnected GA4 cannot take this away. ActivitySection
   * puts the AI traffic history here, which needs no GA4 at all.
   */
  between?: ReactNode
}) {
  // Read-only here: ActivitySection owns the control. Defaulted so this
  // component stays independently mountable in tests.
  const ga = useGaActivity(projectName, windowProp ?? '30d')
  return (
    <>
      <GaOverview ga={ga} projectName={projectName} periodControl={periodControl} />
      {between}
      <GaDetails ga={ga} projectName={projectName} />
    </>
  )
}

/** "Site traffic": the GA4 figures and sessions per day, or the state that stands in for them. */
function GaOverview({ ga, projectName, periodControl }: {
  ga: GaActivity
  projectName: string
  periodControl?: ReactNode
}) {
  const { status, traffic, syncing, disconnecting, handleSync, handleDisconnect } = ga
  const connected = status?.connected === true
  const canManage = connected && !isEmbed() && !isPublicDemo()
  const windowLabel = traffic ? formatWindow(traffic.windowStart, traffic.windowEnd) : null

  let body: ReactNode
  if (ga.loading && !status) {
    body = <p className="text-sm text-secondary">Loading traffic data…</p>
  } else if (!connected) {
    body = isEmbed() || isPublicDemo()
      ? <p className="text-sm text-secondary">No Google Analytics 4 property connected.</p>
      : <Ga4ConnectForm projectName={projectName} onConnected={() => { void ga.handleConnected() }} />
  } else if (traffic && ga.overview) {
    body = <SiteTrafficCard overview={ga.overview} refreshing={ga.loading} />
  } else if (traffic) {
    body = (
      <>
        <KpiRow
          label="Site traffic"
          items={[
            { label: 'Total sessions', value: formatCompact(traffic.totalSessions), detail: traffic.totalSessions.toLocaleString() },
            { label: 'Organic sessions', value: formatCompact(traffic.totalOrganicSessions), detail: `${traffic.organicSharePctDisplay} of total` },
            {
              label: 'Total users',
              value: traffic.totalUsers === null ? 'n/a' : formatCompact(traffic.totalUsers),
              detail: traffic.totalUsers === null ? 'Unavailable for this range' : traffic.totalUsers.toLocaleString(),
            },
          ]}
        />
      </>
    )
  } else {
    body = (
      <div className="flex flex-wrap items-center gap-3 border-y border-default py-4">
        <p className="text-sm text-secondary">No traffic data yet.</p>
        {!isEmbed() && !isPublicDemo() && (
          <Button variant="outline" size="sm" disabled={syncing} onClick={asyncHandler(handleSync)}>
            <RefreshCw className={`mr-1.5 size-3.5 ${syncing ? 'animate-spin' : ''}`} />
            Sync from GA4
          </Button>
        )}
      </div>
    )
  }

  return (
    <section aria-labelledby="site-traffic-heading">
      <SectionHeading
        id="site-traffic-heading"
        title="Site traffic"
        tooltip={ga.overview
          ? ACTIVITY_COPY.siteTrafficTooltip
          : windowLabel ? `${ACTIVITY_COPY.siteTrafficFallbackTooltip} Data covers ${windowLabel}.` : ACTIVITY_COPY.siteTrafficFallbackTooltip}
        meta={connected ? (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block size-2 rounded-full bg-positive-500" />
            GA4 property <span className="text-strong">{status.propertyId}</span>
            {status.clientEmail && <span className="text-muted">· {status.clientEmail}</span>}
          </span>
        ) : undefined}
        actions={periodControl || canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            {periodControl}
            {canManage && (
              <>
                <Button variant="outline" size="sm" disabled={syncing} onClick={asyncHandler(handleSync)}>
                  <RefreshCw className={`mr-1.5 size-3.5 ${syncing ? 'animate-spin' : ''}`} />
                  {syncing ? 'Syncing…' : 'Sync'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-negative-400 hover:text-negative"
                  disabled={disconnecting}
                  onClick={asyncHandler(handleDisconnect)}
                >
                  <Unplug className="mr-1.5 size-3.5" />
                  Disconnect
                </Button>
              </>
            )}
          </div>
        ) : undefined}
      />
      {ga.error && (
        <div role="alert" className="mb-4 rounded-lg border border-negative-800/60 bg-negative-900/20 px-4 py-2 text-sm text-negative">
          {ga.error}
        </div>
      )}
      {ga.notice && (
        <div role="status" className="mb-4 rounded-lg border border-positive-800/60 bg-positive-900/20 px-4 py-2 text-sm text-positive">
          {ga.notice}
        </div>
      )}
      {body}
    </section>
  )
}

/** The GA4 sections under the overview. Each section's figures stay in view; its charts and tables open in place. */
function GaDetails({ ga, projectName }: { ga: GaActivity; projectName: string }) {
  const { traffic, aiDaily, sessionHistory } = ga
  const [pageSort, setPageSort] = useState<{ key: PageSortKey; dir: SortDir }>({ key: 'sessions', dir: 'desc' })
  const [aiLandingSort, setAiLandingSort] = useState<{ key: AiLandingPageSortKey; dir: SortDir }>({ key: 'sessions', dir: 'desc' })

  const sortedPages = useMemo(() => {
    if (!traffic?.topPages) return []
    const { key, dir } = pageSort
    return [...traffic.topPages].sort((a, b) => {
      const av = a[key]
      const bv = b[key]
      const order = typeof av === 'string' && typeof bv === 'string' ? av.localeCompare(bv) : Number(av) - Number(bv)
      return dir === 'asc' ? order : -order
    })
  }, [traffic?.topPages, pageSort])

  const topPagesTable = useClientTable({
    rows: sortedPages,
    getSearchText: (page) => urlSearchText(page.landingPage),
    pageSize: TOP_PAGE_SIZE,
  })

  const sortedAiLandingPages = useMemo(() => {
    if (!traffic?.aiReferralLandingPages) return []
    const { key, dir } = aiLandingSort
    return [...traffic.aiReferralLandingPages].sort((a, b) => {
      const av = a[key]
      const bv = b[key]
      const order = typeof av === 'string' && typeof bv === 'string' ? av.localeCompare(bv) : Number(av) - Number(bv)
      return dir === 'asc' ? order : -order
    })
  }, [traffic?.aiReferralLandingPages, aiLandingSort])

  const aiLandingTable = useClientTable({
    rows: sortedAiLandingPages,
    getSearchText: aiLandingPageSearchText,
    pageSize: AI_LANDING_PAGE_SIZE,
  })

  // The total-sessions reference line beside the AI stack. Kept above the
  // early returns so the hook order stays stable while connection state changes.
  const sessionBaseline = useMemo(
    () => sessionHistory.map((entry) => ({ date: entry.date, value: entry.sessions })),
    [sessionHistory],
  )

  function sortPages(key: PageSortKey) {
    topPagesTable.setPage(1)
    setPageSort((current) => (current.key === key ? { key, dir: current.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }))
  }

  function sortAiLanding(key: AiLandingPageSortKey) {
    aiLandingTable.setPage(1)
    setAiLandingSort((current) => (current.key === key ? { key, dir: current.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }))
  }

  if (!ga.status?.connected) return null

  const windowLabel = traffic ? formatWindow(traffic.windowStart, traffic.windowEnd) : null
  const breakdown = traffic?.channelBreakdown
  const paidAiSessions = traffic?.paidAiSessionsBySession ?? 0
  // Optional only for an API older than the grouping: a degraded table, not a crash.
  const aiEngines = traffic?.aiEngines ?? []
  const socialPlatforms = traffic?.socialPlatforms ?? []
  const topPlatform = socialPlatforms[0] ?? null
  // A row is one landing page under one source, so the count is of rows, not pages.
  const aiLandingRowCount = aiLandingTable.totalRows > 0
    ? `${aiLandingTable.totalRows.toLocaleString()} ${
      aiLandingTable.hasQuery
        ? (aiLandingTable.totalRows === 1 ? 'match' : 'matches')
        : (aiLandingTable.totalRows === 1 ? 'row' : 'rows')
    }`
    : aiLandingTable.hasQuery && (traffic?.aiReferralLandingPages.length ?? 0) > 0
      ? '0 matches'
      : null

  return (
    <>
      {traffic && breakdown && (
        <>
          <div className="page-section-divider" />

          <section aria-labelledby="traffic-by-channel-heading">
            <SectionHeading
              id="traffic-by-channel-heading"
              title="Traffic by channel"
              tooltip={ACTIVITY_COPY.channelTooltip}
              meta={windowLabel}
            />
            <KpiRow
              label="Sessions by channel"
              items={[
                { label: 'Organic search', value: breakdown.organic.sharePctDisplay, detail: `${breakdown.organic.sessions.toLocaleString()} sessions`, tooltip: ACTIVITY_COPY.organicTooltip },
                { label: 'Social', value: breakdown.social.sharePctDisplay, detail: `${breakdown.social.sessions.toLocaleString()} sessions`, tooltip: ACTIVITY_COPY.socialTooltip },
                { label: 'Direct', value: breakdown.direct.sharePctDisplay, detail: `${breakdown.direct.sessions.toLocaleString()} sessions`, tooltip: ACTIVITY_COPY.directTooltip },
                {
                  label: 'AI (at least)',
                  value: breakdown.ai.sharePctDisplay,
                  detail: paidAiSessions > 0
                    ? `${breakdown.ai.sessions.toLocaleString()} sessions · ${paidAiSessions.toLocaleString()} paid`
                    : `${breakdown.ai.sessions.toLocaleString()} sessions`,
                  tooltip: ACTIVITY_COPY.aiTooltip,
                },
                { label: 'Other channels', value: breakdown.other.sharePctDisplay, detail: `${breakdown.other.sessions.toLocaleString()} sessions`, tooltip: ACTIVITY_COPY.otherTooltip },
              ]}
            />

            <DisclosureRows>
              <DisclosureRow
                label={ACTIVITY_COPY.aiChartLabel}
                meta={aiDaily.days.length > 0 ? countOf(aiDaily.totalSessions, 'session') : ACTIVITY_COPY.noneInPeriod}
              >
                {aiDaily.days.length > 0 ? (
                  <StackedSeriesChart
                    input={aiDaily.byEngine}
                    baseline={sessionBaseline}
                    baselineLabel="Total sessions"
                    label={ACTIVITY_COPY.aiChartLabel}
                  />
                ) : (
                  <p className="text-sm text-secondary">{ACTIVITY_COPY.noAiReferrals}</p>
                )}
              </DisclosureRow>

              <DisclosureRow
                label="Where AI visitors came from"
                meta={aiEngines.length > 0
                  ? `${countOf(aiEngines.filter((group) => group.engine !== null).length, 'engine')} · ${countOf(traffic.aiReferrals.length, 'source')}`
                  : ACTIVITY_COPY.noneInPeriod}
              >
                {aiEngines.length > 0 ? (
                  // The help sits beside the table, never in the row: a button
                  // inside a summary toggles it and joins its accessible name.
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <GroupedReferralTable
                        groups={aiEngines}
                        groupLabel="Engine"
                        caption="AI referral sessions by engine"
                        childColumns={AI_SOURCE_COLUMNS}
                        childRowKey={(row) => `${row.source}:${row.medium}:${row.sourceDimension}:${row.trafficClass}`}
                        renderChildCells={(row) => <AiSourceCells row={row} />}
                        pinLast={isUnattributedAiGroup}
                      />
                    </div>
                    <InfoTooltip text={ACTIVITY_COPY.aiEnginesTooltip} />
                  </div>
                ) : (
                  <p className="text-sm text-secondary">{ACTIVITY_COPY.noAiReferrals}</p>
                )}
              </DisclosureRow>

              <DisclosureRow label="Pages AI visitors landed on" meta={aiLandingRowCount ?? ACTIVITY_COPY.noneInPeriod}>
                {traffic.aiReferralLandingPages.length > 0 ? (
                  <>
                    <DataTableSearch
                      value={aiLandingTable.query}
                      onChange={aiLandingTable.setQuery}
                      label="Filter landing page URLs or query parameters"
                      placeholder="Filter URL or query parameters"
                      className="mb-4 max-w-md"
                    />
                    {aiLandingTable.totalRows > 0 ? (
                      <>
                        <div className="overflow-x-auto">
                          <table className="w-full min-w-[36rem] text-sm">
                            <thead>
                              <tr className="border-b border-default">
                                <SortHeader label="Landing page" sortKey="landingPage" current={aiLandingSort.key} dir={aiLandingSort.dir} onSort={sortAiLanding} align="left" />
                                <SortHeader label="Source" sortKey="source" current={aiLandingSort.key} dir={aiLandingSort.dir} onSort={sortAiLanding} align="left" />
                                <PlainHeader label="Attribution" align="left" />
                                <SortHeader label="Sessions" sortKey="sessions" current={aiLandingSort.key} dir={aiLandingSort.dir} onSort={sortAiLanding} align="right" />
                              </tr>
                            </thead>
                            <tbody>
                              {aiLandingTable.rows.map((row) => (
                                <AiReferralLandingPageRow
                                  key={`${row.landingPage}:${row.source}:${row.medium}:${row.sourceDimension}`}
                                  row={row}
                                />
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <DataTablePagination
                          page={aiLandingTable.page}
                          pageSize={aiLandingTable.pageSize}
                          visibleRows={aiLandingTable.rows.length}
                          totalRows={aiLandingTable.totalRows}
                          onPageChange={aiLandingTable.setPage}
                          itemLabel={aiLandingTable.hasQuery ? 'matches' : 'rows'}
                        />
                      </>
                    ) : (
                      <div className="flex flex-wrap items-center gap-3 py-4">
                        <p className="text-sm text-secondary">No landing pages match this filter</p>
                        <Button variant="outline" size="sm" onClick={() => aiLandingTable.setQuery('')}>Clear filter</Button>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-secondary">{ACTIVITY_COPY.noAiLandingPages}</p>
                )}
              </DisclosureRow>
            </DisclosureRows>
          </section>

          <div className="page-section-divider" />

          <section aria-labelledby="social-heading">
            <SectionHeading id="social-heading" title="Social" tooltip={ACTIVITY_COPY.socialTooltip2} meta={windowLabel} />
            <KpiRow
              label="Social sessions"
              items={[
                { label: 'Social sessions', value: traffic.socialSessions.toLocaleString(), detail: `${traffic.socialSharePctDisplay} of all sessions` },
                { label: 'Platforms', value: String(socialPlatforms.length), detail: `${traffic.socialReferrals.length} sources`, tooltip: ACTIVITY_COPY.platformsTooltip },
                {
                  label: 'Paid social',
                  value: (traffic.paidSocialSessions ?? 0).toLocaleString(),
                  detail: `${formatPercent(traffic.paidSocialShare ?? 0)} of social`,
                  tooltip: ACTIVITY_COPY.paidSocialTooltip,
                },
                {
                  label: 'Top platform',
                  value: topPlatform?.label ?? 'None',
                  detail: topPlatform ? `${topPlatform.sessions.toLocaleString()} sessions` : undefined,
                },
              ]}
            />

            <DisclosureRows>
              <DisclosureRow
                label={ACTIVITY_COPY.socialChartLabel}
                meta={socialPlatforms.length > 0 ? countOf(traffic.socialSessions, 'session') : ACTIVITY_COPY.noneInPeriod}
              >
                {socialPlatforms.length > 0
                  ? <StackedSeriesChart input={traffic.socialPlatformDaily} label={ACTIVITY_COPY.socialChartLabel} />
                  : <p className="text-sm text-secondary">{ACTIVITY_COPY.noSocial}</p>}
              </DisclosureRow>

              <DisclosureRow
                label="Social platforms"
                meta={socialPlatforms.length > 0
                  ? `${countOf(socialPlatforms.length, 'platform')} · ${countOf(traffic.socialReferrals.length, 'source')}`
                  : ACTIVITY_COPY.noneInPeriod}
              >
                {socialPlatforms.length > 0 ? (
                  <GroupedReferralTable
                    groups={socialPlatforms}
                    groupLabel="Platform"
                    caption="Social sessions by platform"
                    childColumns={SOCIAL_SOURCE_COLUMNS}
                    childRowKey={(row) => `${row.source}:${row.medium}:${row.channelGroup}`}
                    renderChildCells={(row) => <SocialSourceCells row={row} />}
                  />
                ) : (
                  <p className="text-sm text-secondary">{ACTIVITY_COPY.noSocial}</p>
                )}
              </DisclosureRow>
            </DisclosureRows>
          </section>
        </>
      )}

      {traffic && traffic.topPages.length > 0 && (
        <>
          <div className="page-section-divider" />

          <section aria-labelledby="top-landing-pages-heading">
            <SectionHeading
              id="top-landing-pages-heading"
              title="Top landing pages"
              tooltip="Landing pages by sessions. Organic share is the share of a page's sessions that came from Google organic search."
            />
            <DataTableSearch
              value={topPagesTable.query}
              onChange={topPagesTable.setQuery}
              label="Filter landing page URLs"
              placeholder="Filter landing pages"
              className="mb-4 max-w-md"
            />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-sm">
                <thead>
                  <tr className="border-b border-default">
                    <SortHeader label="Landing page" sortKey="landingPage" current={pageSort.key} dir={pageSort.dir} onSort={sortPages} align="left" />
                    <SortHeader label="Sessions" sortKey="sessions" current={pageSort.key} dir={pageSort.dir} onSort={sortPages} align="right" />
                    <SortHeader label="Organic" sortKey="organicSessions" current={pageSort.key} dir={pageSort.dir} onSort={sortPages} align="right" />
                    <PlainHeader label="Organic share" align="right" />
                  </tr>
                </thead>
                <tbody>
                  {topPagesTable.rows.map((page) => (
                    <LandingPageRow key={page.landingPage} page={page} />
                  ))}
                </tbody>
              </table>
            </div>
            {topPagesTable.totalRows === 0 && topPagesTable.hasQuery && (
              <p className="mt-3 text-sm text-secondary">No landing pages match this filter</p>
            )}
            <DataTablePagination
              page={topPagesTable.page}
              pageSize={topPagesTable.pageSize}
              visibleRows={topPagesTable.rows.length}
              totalRows={topPagesTable.totalRows}
              onPageChange={topPagesTable.setPage}
              itemLabel={topPagesTable.hasQuery ? 'matches' : 'pages'}
            />
          </section>
        </>
      )}

      {/* GA4's Search Console landing-page report: its own window picker,
          because GA4 stores it for 7, 28 and 90 days ending yesterday. */}
      <GoogleOrganicSearchPagesPanel projectName={projectName} />

      <p className="mt-6 text-xs text-secondary">
        {traffic?.lastSyncedAt ? `Last synced ${relativeTime(traffic.lastSyncedAt)}` : 'Never synced'}
      </p>
    </>
  )
}

/** "1 engine", "8 engines": a row's count with its noun. */
function countOf(count: number, noun: string): string {
  return `${count.toLocaleString()} ${count === 1 ? noun : `${noun}s`}`
}

type SearchLandingSortKey = 'landingPage' | 'clicks' | 'impressions' | 'ctr' | 'position' | 'activeUsers'

const SEARCH_LANDING_PAGE_SIZE = 25
/** How a ratio with no impressions reads: undefined, never 0. */
const SEARCH_LANDING_NOT_AVAILABLE = 'n/a'

export const SEARCH_LANDING_COPY = {
  heading: 'Google organic search traffic',
  tooltip: 'GA4\'s "Google organic search traffic: Landing page + query string" report, from the property\'s Search Console link. Each window ends yesterday in the property time zone, as GA4\'s own date ranges do. The Total row is GA4\'s own total for all pages, not a sum of the rows, and it does not change with the filter. Search Console data arrives about two days late.',
  windowLabel: 'Google organic search time period',
  loading: 'Loading Google organic search pages…',
  loadError: 'Could not load Google organic search pages.',
  neverSynced: 'No Google organic search data has been synced yet.',
  neverSyncedAction: 'Sync GA4 to load the Search Console landing-page report.',
  unavailable: 'GA4 did not return Search Console data for this property.',
  unavailableAction: 'Link Search Console to this GA4 property (Admin, Product links, Search Console links), then sync GA4 again.',
  refreshFailed: 'The last refresh failed.',
  /** The window's Total has 0 clicks and 0 impressions, whether or not pages are listed. */
  noSearchTraffic: 'No landing pages had Google organic search traffic in this window.',
  noSearchTrafficAction: 'If this property should have some, check its Search Console link in GA4 (Admin, Product links, Search Console links).',
  /** Search Console's own data confirms the site had no Google search traffic either. */
  noSearchTrafficConfirmed: 'Search Console also recorded no impressions for these days.',
  notLinkedBadge: 'Search Console not linked',
  /** GA4 has 0 clicks and 0 impressions while Canonry's Search Console data has impressions for the same days. */
  notLinked: (impressions: number) => `GA4 has no Search Console data for this site, but Search Console recorded ${impressions.toLocaleString()} impressions in this window. Link the site's Search Console property in GA4 (Admin, Product links, Search Console links).`,
  thresholded: 'GA4 applied thresholding to this report, so it may withhold some rows.',
  retry: 'Retry',
  refreshFailedBadge: 'Last refresh failed',
  unavailableBadge: 'Search Console unavailable',
  thresholdedBadge: 'Thresholded',
  previousSnapshot: 'Showing the last good snapshot, synced',
  totalLabel: 'Total',
  totalScope: 'all pages',
  noFilterMatch: 'No landing pages match this filter',
  /** The filter and sorts see only the rows loaded, the top ones by clicks. */
  noFilterMatchInLoaded: (loaded: number) => `No landing pages in the top ${loaded.toLocaleString()} by clicks match this filter. The filter searches only the pages loaded here.`,
} as const

function searchLandingSortValue(row: GaSearchLandingPageRow, key: SearchLandingSortKey): string | number | null {
  switch (key) {
    case 'landingPage': return row.landingPage
    case 'clicks': return row.organicGoogleSearchClicks
    case 'impressions': return row.organicGoogleSearchImpressions
    case 'ctr': return row.organicGoogleSearchClickThroughRate
    case 'position': return row.organicGoogleSearchAveragePosition
    case 'activeUsers': return row.activeUsers
  }
}

function formatSearchLandingPosition(value: number | null): string {
  return value === null ? SEARCH_LANDING_NOT_AVAILABLE : value.toFixed(1)
}

function formatSearchLandingCtr(value: number | null): string {
  return value === null ? SEARCH_LANDING_NOT_AVAILABLE : formatPercent(value)
}

/**
 * GA4's "Google organic search traffic: Landing page + query string" report as
 * the last GA sync stored it. Every figure is the API's: the Total row is GA4's
 * own Total, pinned above the rows and untouched by the filter, because a
 * filtered subset's Total cannot be rebuilt from its rows.
 */
export function GoogleOrganicSearchPagesPanel({ projectName }: { projectName: string }) {
  const [searchWindow, setSearchWindow] = useState<GaSearchLandingWindow>(GA_SEARCH_LANDING_DEFAULT_WINDOW)
  const [sortKey, setSortKey] = useState<SearchLandingSortKey>('clicks')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const query = useQuery({
    ...getApiV1ProjectsByNameGaSearchLandingPagesOptions({
      client: heyClient,
      path: { name: projectName },
      query: { window: searchWindow, limit: GA_SEARCH_LANDING_MAX_LIMIT },
    }),
    staleTime: TRAFFIC_STALE_MS,
  })
  const data: GaSearchLandingPagesResponse | undefined = query.data

  const sortedRows = useMemo(() => {
    const rows = data?.rows ?? []
    return [...rows].sort((a, b) => {
      const av = searchLandingSortValue(a, sortKey)
      const bv = searchLandingSortValue(b, sortKey)
      // Rows with no reading stay last in either direction.
      if (av === null || bv === null) return av === bv ? 0 : av === null ? 1 : -1
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      return sortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number)
    })
  }, [data?.rows, sortKey, sortDir])

  const table = useClientTable({
    rows: sortedRows,
    getSearchText: (row) => urlSearchText(gaSearchLandingPageLabel(row.landingPage)),
    pageSize: SEARCH_LANDING_PAGE_SIZE,
  })

  function handleSort(key: SearchLandingSortKey) {
    table.setPage(1)
    if (sortKey === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'landingPage' ? 'asc' : 'desc')
    }
  }

  const total = data?.total ?? null
  // GA4 reports no search data while Canonry's own Search Console data has impressions.
  const searchConsoleNotLinked = data?.searchConsoleLink?.state === 'not-linked'
  const canSync = !isEmbed() && !isPublicDemo()

  return (
    <>
      <div className="page-section-divider" />

      <section aria-labelledby="ga-search-landing-heading">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            {/* The tooltip is the heading's SIBLING: the section and the table
                take their accessible name from this heading. */}
            <div className="flex items-center gap-1.5">
              <h2 id="ga-search-landing-heading" className="text-base font-semibold text-primary">
                {SEARCH_LANDING_COPY.heading}
              </h2>
              <InfoTooltip text={SEARCH_LANDING_COPY.tooltip} />
            </div>
            {data?.windowStart && data.windowEnd && (
              <p className="text-sm text-secondary mt-1">
                {formatDate(data.windowStart)} to {formatDate(data.windowEnd)}
                {data.timeZone ? ` (${data.timeZone})` : ''}
              </p>
            )}
          </div>
          <MetricsWindowPicker
            windows={GA_SEARCH_LANDING_WINDOWS}
            value={searchWindow}
            onChange={(next) => {
              table.setPage(1)
              setSearchWindow(next)
            }}
            label={SEARCH_LANDING_COPY.windowLabel}
          />
        </div>

        {query.isPending ? (
          <p className="text-sm text-secondary py-6 text-center">{SEARCH_LANDING_COPY.loading}</p>
        ) : query.isError || !data ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 px-4 py-2 rounded-lg bg-negative-900/20 border border-negative-800/60 text-sm text-negative">
            <span>{SEARCH_LANDING_COPY.loadError}</span>
            <Button variant="outline" size="sm" onClick={() => { void query.refetch() }}>
              {SEARCH_LANDING_COPY.retry}
            </Button>
          </div>
        ) : (
          <>
            {(data.status === 'error' || data.status === 'unavailable' || data.subjectToThresholding || searchConsoleNotLinked) && (
              <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="ga-search-landing-status">
                {searchConsoleNotLinked && (
                  <span className="inline-flex items-center gap-1" data-testid="ga-search-landing-not-linked">
                    <ToneBadge tone="caution">{SEARCH_LANDING_COPY.notLinkedBadge}</ToneBadge>
                    <InfoTooltip text={SEARCH_LANDING_COPY.notLinked(data.searchConsoleLink?.searchConsoleImpressions ?? 0)} />
                  </span>
                )}
                {data.status === 'error' && (
                  <span className="inline-flex items-center gap-1">
                    <ToneBadge tone="negative">{SEARCH_LANDING_COPY.refreshFailedBadge}</ToneBadge>
                    {data.error && <InfoTooltip text={data.error} />}
                  </span>
                )}
                {data.status === 'unavailable' && (
                  <span className="inline-flex items-center gap-1">
                    <ToneBadge tone="caution">{SEARCH_LANDING_COPY.unavailableBadge}</ToneBadge>
                    {data.error && <InfoTooltip text={data.error} />}
                  </span>
                )}
                {data.subjectToThresholding && (
                  <span className="inline-flex items-center gap-1">
                    <ToneBadge tone="caution">{SEARCH_LANDING_COPY.thresholdedBadge}</ToneBadge>
                    <InfoTooltip text={SEARCH_LANDING_COPY.thresholded} />
                  </span>
                )}
                {/* A failed or refused refresh keeps the last good snapshot;
                    say so, or the old numbers read as current. */}
                {data.status !== 'ready' && total && data.syncedAt && (
                  <span className="text-sm text-secondary">
                    {SEARCH_LANDING_COPY.previousSnapshot} {relativeTime(data.syncedAt)}.
                  </span>
                )}
                {/* Same fix as the no-snapshot card and the CLI give. */}
                {data.status === 'unavailable' && total && (
                  <p className="w-full text-sm text-secondary">{SEARCH_LANDING_COPY.unavailableAction}</p>
                )}
              </div>
            )}

            {!total ? (
              <Card className="p-5">
                {data.status === 'unavailable' ? (
                  <div className="text-sm text-secondary space-y-1">
                    <p className="text-neutral">{SEARCH_LANDING_COPY.unavailable}</p>
                    <p>{SEARCH_LANDING_COPY.unavailableAction}</p>
                  </div>
                ) : data.status === 'error' ? (
                  <div className="text-sm text-secondary space-y-1">
                    <p className="text-neutral">{SEARCH_LANDING_COPY.refreshFailed}</p>
                    {data.error && <p>{data.error}</p>}
                  </div>
                ) : (
                  <div className="text-sm text-secondary space-y-1">
                    <p className="text-neutral">{SEARCH_LANDING_COPY.neverSynced}</p>
                    {canSync && <p>{SEARCH_LANDING_COPY.neverSyncedAction}</p>}
                  </div>
                )}
              </Card>
            ) : (
              <>
                <DataTableSearch
                  value={table.query}
                  onChange={table.setQuery}
                  label="Filter Google organic search landing pages"
                  placeholder="Filter landing pages"
                  className="mb-4 max-w-md"
                />

                <div className="overflow-x-auto">
                  <table className="w-full min-w-[40rem] text-sm" aria-labelledby="ga-search-landing-heading">
                    <thead>
                      <tr className="border-b border-default">
                        <SortHeader label="Landing page" sortKey="landingPage" current={sortKey} dir={sortDir} onSort={handleSort} align="left" />
                        <SortHeader label="Clicks" sortKey="clicks" current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                        <SortHeader label="Impressions" sortKey="impressions" current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                        <SortHeader label="CTR" sortKey="ctr" current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                        <SortHeader label="Avg. position" sortKey="position" current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                        <SortHeader label="Active users" sortKey="activeUsers" current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t border-subtle font-semibold" data-testid="ga-search-landing-total">
                        <td className="py-1.5 text-primary">
                          {SEARCH_LANDING_COPY.totalLabel} <span className="font-normal text-secondary">{SEARCH_LANDING_COPY.totalScope}</span>
                        </td>
                        <td className="py-1.5 pl-4 text-right text-primary tabular-nums">{total.organicGoogleSearchClicks.toLocaleString()}</td>
                        <td className="py-1.5 pl-4 text-right text-primary tabular-nums">{total.organicGoogleSearchImpressions.toLocaleString()}</td>
                        <td className="py-1.5 pl-4 text-right text-primary tabular-nums">{formatSearchLandingCtr(total.organicGoogleSearchClickThroughRate)}</td>
                        <td className="py-1.5 pl-4 text-right text-primary tabular-nums">{formatSearchLandingPosition(total.organicGoogleSearchAveragePosition)}</td>
                        <td className="py-1.5 pl-4 text-right text-primary tabular-nums">{total.activeUsers.toLocaleString()}</td>
                      </tr>
                      {table.rows.map((row) => (
                        <tr key={row.landingPage} className="border-t border-subtle">
                          <td className="py-1.5 text-neutral max-w-[400px] truncate" title={gaSearchLandingPageLabel(row.landingPage)}>{gaSearchLandingPageLabel(row.landingPage)}</td>
                          <td className="py-1.5 pl-4 text-right text-strong tabular-nums">{row.organicGoogleSearchClicks.toLocaleString()}</td>
                          <td className="py-1.5 pl-4 text-right text-secondary tabular-nums">{row.organicGoogleSearchImpressions.toLocaleString()}</td>
                          <td className="py-1.5 pl-4 text-right text-secondary tabular-nums">{formatSearchLandingCtr(row.organicGoogleSearchClickThroughRate)}</td>
                          <td className="py-1.5 pl-4 text-right text-secondary tabular-nums">{formatSearchLandingPosition(row.organicGoogleSearchAveragePosition)}</td>
                          <td className="py-1.5 pl-4 text-right text-secondary tabular-nums">{row.activeUsers.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* GA4's Total, not the row count: pages with active users
                    and no clicks or impressions are still listed. */}
                {/* The not-linked badge above already explains a zero Total. */}
                {!gaSearchLandingHasSearchData(total) && !searchConsoleNotLinked && (
                  <div className="text-sm text-secondary mt-3 space-y-1">
                    <p>{SEARCH_LANDING_COPY.noSearchTraffic}</p>
                    <p>
                      {data.searchConsoleLink?.state === 'no-search-data'
                        ? SEARCH_LANDING_COPY.noSearchTrafficConfirmed
                        : SEARCH_LANDING_COPY.noSearchTrafficAction}
                    </p>
                  </div>
                )}
                {table.totalRows === 0 && table.hasQuery && (
                  <p className="text-sm text-secondary mt-3">
                    {data.totalRows > data.rows.length
                      ? SEARCH_LANDING_COPY.noFilterMatchInLoaded(data.rows.length)
                      : SEARCH_LANDING_COPY.noFilterMatch}
                  </p>
                )}

                <DataTablePagination
                  page={table.page}
                  pageSize={table.pageSize}
                  visibleRows={table.rows.length}
                  totalRows={table.totalRows}
                  onPageChange={table.setPage}
                  itemLabel={table.hasQuery ? 'matches' : 'pages'}
                />

                {(data.totalRows > data.rows.length || data.rowsCapped) && (
                  <p className="text-sm text-secondary mt-3">
                    {data.totalRows > data.rows.length
                      ? `Showing the top ${data.rows.length.toLocaleString()} of ${data.totalRows.toLocaleString()} stored pages by clicks.`
                      : ''}
                    {data.totalRows > data.rows.length && data.rowsCapped ? ' ' : ''}
                    {data.rowsCapped && data.reportRowCount !== null
                      ? `GA4 reported ${data.reportRowCount.toLocaleString()} pages; the ${data.totalRows.toLocaleString()} with the most clicks are stored.`
                      : ''}
                  </p>
                )}
                {data.syncedAt && (
                  <p className="mt-2 text-xs text-muted">Synced {relativeTime(data.syncedAt)}</p>
                )}
              </>
            )}
          </>
        )}
      </section>
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

function LandingPageRow({ page }: { page: ApiGaTrafficPage }) {
  return (
    <tr className="border-t border-subtle">
      <td className="max-w-[400px] truncate py-1.5 pr-3 text-strong" title={page.landingPage}>
        {page.landingPage}
      </td>
      <td className="py-1.5 pl-4 text-right text-primary tabular-nums">{page.sessions.toLocaleString()}</td>
      <td className="py-1.5 pl-4 text-right text-secondary tabular-nums">{page.organicSessions.toLocaleString()}</td>
      <td className="py-1.5 pl-4 text-right text-secondary tabular-nums">{formatPercent(page.organicShare)}</td>
    </tr>
  )
}

function AiReferralLandingPageRow({ row }: { row: ApiGaTrafficAiLandingPage }) {
  return (
    <tr className="border-t border-subtle">
      <td className="max-w-[400px] py-1.5 pr-3 text-strong">
        <MiddleTruncatedText value={row.landingPage} className="whitespace-nowrap" />
      </td>
      <td className="max-w-[220px] truncate py-1.5 pr-3 text-secondary" title={row.source}>{row.source}</td>
      <td className="py-1.5 pr-3 text-secondary" title={DIMENSION_TOOLTIPS[row.sourceDimension] ?? ''}>
        {DIMENSION_LABELS[row.sourceDimension] ?? row.sourceDimension}
      </td>
      <td className="py-1.5 pl-4 text-right text-primary tabular-nums">{row.sessions.toLocaleString()}</td>
    </tr>
  )
}
