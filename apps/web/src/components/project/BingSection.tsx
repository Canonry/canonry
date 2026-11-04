import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, RefreshCw, Zap } from 'lucide-react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  calendarDateRange,
  describeError,
  formatPercent,
  formatTenthsMagnitude,
  RatioUnits,
  type BingSearchComparisonDto,
  type BingSiteSnapshotDto,
  type BingSiteSnapshotKind,
  type MetricsWindow,
} from '@canonry/canonry-contracts'
import {
  getApiV1ProjectsByNameBingCoverageOptions,
  getApiV1ProjectsByNameBingCrawlStatsOptions,
  getApiV1ProjectsByNameBingInspectionsOptions,
  getApiV1ProjectsByNameBingKeywordDemandOptions,
  getApiV1ProjectsByNameBingPageQueriesOptions,
  getApiV1ProjectsByNameBingPagesOptions,
  getApiV1ProjectsByNameBingQueriesOptions,
  getApiV1ProjectsByNameBingQueryPagesOptions,
  getApiV1ProjectsByNameBingSiteOptions,
  getApiV1ProjectsByNameBingSitemapsOptions,
  getApiV1ProjectsByNameBingSitesOptions,
  getApiV1ProjectsByNameBingStatusOptions,
  getApiV1ProjectsByNameBingTrafficOptions,
  getApiV1ProjectsByNameTrendsOptions,
} from '@canonry/canonry-api-client/react-query'

import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import { WriteButton } from '../shared/AccessControls.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { MetricsWindowPicker } from '../shared/MetricsWindowPicker.js'
import { DataTablePagination, DataTableSearch, MiddleTruncatedText, useClientTable } from '../shared/DataTableControls.js'
import { CHART_SERIES_COLORS, CHART_TONE, MultiAxisTrendChart, formatChartDateLabel, formatChartDateTick, type TrendChartSeries } from '../shared/ChartPrimitives.js'
import { TrendCard, levelTrendChange, sharedLevelBasis, type TrendCardChange, type TrendCardFigure, type TrendCardGroup } from '../shared/TrendCard.js'
import { KpiRow, type KpiItem } from './ActivityParts.js'
import { SitemapRowAction, SitemapTable, type SitemapRowView } from './SitemapTable.js'
import { useAccount, VIEW_ONLY_LABEL } from '../../contexts/account-context.js'
import { gscComparisonBasisText, gscTrendChange } from './GscSection.js'
import { formatTimestamp } from '../../lib/format-helpers.js'
import { addToast } from '../../lib/toast-store.js'
import { asyncHandler } from '../../lib/async-handler.js'
import { GSC_STALE_MS } from '../../queries/query-client.js'
import { invalidateProjectQueryDomain } from '../../queries/query-invalidation.js'
import {
  bingConnect as apiBingConnect,
  bingDisconnect as apiBingDisconnect,
  bingRequestIndexing,
  bingSetSite as apiBingSetSite,
  heyClient,
  inspectBingSitemap,
  inspectBingUrl,
  isEmbed,
  triggerBingSync,
  type ApiBingConnection,
  type ApiBingInspection,
} from '../../api.js'

const BING_WINDOWS: MetricsWindow[] = ['7d', '30d', '90d', 'all']
/** Rows per page in the Bing lists: the top of each list, the rest a page away. */
const BING_TABLE_PAGE_SIZE = 10

/**
 * The Bing search figures, each on its own chart axis like Search Console's.
 * Clicks, impressions and CTR are Bing's daily site totals; position comes from
 * the weekly query stats, because Bing's daily totals carry none.
 */
const BING_CHART_METRICS = [
  {
    key: 'clicks' as const,
    label: 'Clicks',
    color: CHART_SERIES_COLORS[1],
    format: (v: number) => v.toLocaleString(),
  },
  {
    key: 'impressions' as const,
    label: 'Impressions',
    color: CHART_SERIES_COLORS[4],
    format: (v: number) => v.toLocaleString(),
  },
  {
    key: 'ctr' as const,
    label: 'CTR',
    color: CHART_TONE.caution,
    format: (v: number) => formatPercent(v),
  },
  {
    key: 'position' as const,
    label: 'Avg position',
    color: CHART_SERIES_COLORS[2],
    inverted: true,
    format: (v: number) => v.toFixed(1),
  },
]
type BingChartMetric = (typeof BING_CHART_METRICS)[number]['key']
const BING_INDEXED_KEY = 'bing-indexed'
type BingChartKey = BingChartMetric | typeof BING_INDEXED_KEY

export const BING_POSITION_HELP = 'Impression-weighted across the queries Bing names. Bing reports these per week, so the line moves weekly.'
const BING_LIVE_HELP = 'Asks Bing directly. Counts against the shared Bing request limit for this key.'

/** The position figure's change, from the API's weekly comparison. A smaller number is a better rank. */
export function bingPositionChange(comparison: BingSearchComparisonDto | null | undefined): TrendCardChange {
  if (!comparison) return { kind: 'note', text: 'No comparison period' }
  const difference = comparison.difference.avgImpressionPosition
  const basis = `vs prior ${comparison.days} ${comparison.days === 1 ? 'day' : 'days'}`
  if (difference === null)
    return {
      kind: 'note',
      text: `No position in the prior ${comparison.days} days`,
    }
  if (difference === 0)
    return {
      kind: 'delta',
      amount: '0',
      direction: 'flat',
      tone: 'neutral',
      basis,
    }
  return {
    kind: 'delta',
    amount: formatTenthsMagnitude(difference),
    direction: difference > 0 ? 'up' : 'down',
    tone: difference > 0 ? 'worse' : 'better',
    basis,
  }
}

function formatPosition(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toFixed(1)
}

function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : Math.round(value).toLocaleString()
}

/** The site as a reader names it: no scheme, no trailing slash. */
function siteHost(siteUrl: string): string {
  return siteUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

/** A page URL shown by its path on the selected site, full URL in the title. */
function sitePath(url: string, siteUrl: string): string {
  const base = siteUrl.replace(/\/+$/, '')
  return url.startsWith(base) ? url.slice(base.length) || '/' : url
}

// ── Site settings payloads ───────────────────────────────────────────────────
// The API documents one normalised payload per kind; anything else reads as
// absent rather than crashing the tab.

interface QuotaPayload {
  dailyQuota: number
  monthlyQuota: number
}
interface CrawlSettingsPayload {
  crawlBoostAvailable: boolean
  crawlBoostEnabled: boolean
  crawlRate: number[]
}
type Row = Record<string, unknown>

function snapshotOf(snapshots: readonly BingSiteSnapshotDto[] | undefined, kind: BingSiteSnapshotKind): BingSiteSnapshotDto | undefined {
  return snapshots?.find((snapshot) => snapshot.kind === kind)
}

function quotaPayload(snapshot: BingSiteSnapshotDto | undefined): QuotaPayload | null {
  const payload = snapshot?.payload as Partial<QuotaPayload> | null | undefined
  return payload && typeof payload.dailyQuota === 'number' && typeof payload.monthlyQuota === 'number'
    ? { dailyQuota: payload.dailyQuota, monthlyQuota: payload.monthlyQuota }
    : null
}

function crawlSettingsPayload(snapshot: BingSiteSnapshotDto | undefined): CrawlSettingsPayload | null {
  const payload = snapshot?.payload as Partial<CrawlSettingsPayload> | null | undefined
  return payload && typeof payload.crawlBoostAvailable === 'boolean'
    ? {
        crawlBoostAvailable: payload.crawlBoostAvailable,
        crawlBoostEnabled: payload.crawlBoostEnabled === true,
        crawlRate: Array.isArray(payload.crawlRate) ? payload.crawlRate : [],
      }
    : null
}

function rowsPayload(snapshot: BingSiteSnapshotDto | undefined): Row[] | null {
  return Array.isArray(snapshot?.payload) ? (snapshot.payload as unknown[]).filter((row): row is Row => typeof row === 'object' && row !== null) : null
}

/** Columns that hold one of the API's enum words (`full-removal`), shown as words. */
const ENUM_COLUMNS = new Set(['entityType', 'requestType', 'type', 'role'])

function cellText(value: unknown, column: string): string {
  if (value === null || value === undefined || value === '') return '\u2014'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return value.toLocaleString()
  if (typeof value === 'string') {
    // Bing's settings carry calendar dates; the API sends them as midnight UTC.
    if (/^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z)?$/.test(value)) return formatChartDateLabel(value.slice(0, 10))
    if (ENUM_COLUMNS.has(column) && /^[a-z]+(?:-[a-z]+)*$/.test(value)) return value.charAt(0).toUpperCase() + value.slice(1).replaceAll('-', ' ')
    return value
  }
  return JSON.stringify(value)
}

// ── Section ──────────────────────────────────────────────────────────────────

function BingFrame({ status, right, children }: { status?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="page-section-divider">
      <div className="section-head section-head-inline">
        <div>
          <h2>Bing Webmaster Tools</h2>
          {status}
        </div>
        {right}
      </div>
      {children}
    </section>
  )
}

export function BingSection({ projectName, refreshNonce }: { projectName: string; refreshNonce: number }) {
  const queryClient = useQueryClient()
  const status = useQuery({
    ...getApiV1ProjectsByNameBingStatusOptions({
      client: heyClient,
      path: { name: projectName },
    }),
    staleTime: GSC_STALE_MS,
  })
  const connection = status.data ?? null
  const sites = useQuery({
    ...getApiV1ProjectsByNameBingSitesOptions({
      client: heyClient,
      path: { name: projectName },
    }),
    staleTime: GSC_STALE_MS,
    enabled: Boolean(connection?.connected && !connection.siteUrl),
  })
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [selectedSite, setSelectedSite] = useState('')
  const [error, setError] = useState<string | null>(null)

  // The page-level refresh invalidates the Bing reads before bumping this; the
  // refetch here covers a status read that was not stale yet.
  useEffect(() => {
    if (refreshNonce > 0) void status.refetch()
  }, [refreshNonce])

  async function handleConnect() {
    if (!apiKeyInput.trim()) return
    setError(null)
    try {
      await apiBingConnect(projectName, apiKeyInput.trim())
      setApiKeyInput('')
      await invalidateProjectQueryDomain(queryClient, 'bing')
    } catch (e) {
      setError(describeError(e))
    }
  }

  async function handleDisconnect() {
    setError(null)
    try {
      await apiBingDisconnect(projectName)
      setSelectedSite('')
      await invalidateProjectQueryDomain(queryClient, 'bing')
    } catch (e) {
      setError(describeError(e))
    }
  }

  async function handleSetSite() {
    if (!selectedSite) return
    setError(null)
    try {
      await apiBingSetSite(projectName, selectedSite)
      await invalidateProjectQueryDomain(queryClient, 'bing')
    } catch (e) {
      setError(describeError(e))
    }
  }

  if (status.isPending) {
    return (
      <BingFrame>
        <Card className="surface-card">
          <div className="text-label-14 text-secondary">Loading Bing data…</div>
        </Card>
      </BingFrame>
    )
  }

  if (status.isError) {
    return (
      <BingFrame>
        <Card className="surface-card">
          <p className="text-copy-14 text-negative">Could not load the Bing connection: {describeError(status.error)}</p>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void status.refetch()}>
            Retry
          </Button>
        </Card>
      </BingFrame>
    )
  }

  if (!connection?.connected) {
    return (
      <BingFrame>
        <Card className="surface-card">
          <div className="section-head section-head-inline">
            <div>
              <p className="eyebrow eyebrow-soft">Connection</p>
              <h3>Domain authorization</h3>
            </div>
            <ToneBadge tone="caution">Not connected</ToneBadge>
          </div>
          {isEmbed() ? (
            <p className="text-copy-14 text-neutral">Bing Webmaster Tools is not connected for this project.</p>
          ) : (
            <>
              <p className="text-copy-14 text-neutral">Connect Bing Webmaster Tools to inspect URLs, monitor index coverage, and submit pages for indexing.</p>
              <div className="mt-3">
                <label className="text-label-12 text-muted" htmlFor="bing-api-key">
                  API Key
                </label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    id="bing-api-key"
                    type="password"
                    className="flex-1 rounded border border-strong bg-transparent px-2 py-1.5 text-label-14 text-strong placeholder-mono-400 focus:border-mono-500 focus:outline-none"
                    placeholder="Bing Webmaster Tools API key"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleConnect()
                    }}
                  />
                  <WriteButton size="sm" disabled={!apiKeyInput.trim()} onClick={asyncHandler(handleConnect)}>
                    Connect
                  </WriteButton>
                </div>
                <p className="mt-1 text-copy-14 text-secondary">
                  Get your API key from{' '}
                  <a href="https://www.bing.com/webmasters/" target="_blank" rel="noopener noreferrer" className="text-secondary underline underline-offset-2 hover:text-neutral">
                    Bing Webmaster Tools
                  </a>
                </p>
              </div>
            </>
          )}
          {error && <p className="mt-3 text-copy-13 text-negative">{error}</p>}
        </Card>
      </BingFrame>
    )
  }

  if (!connection.siteUrl) {
    const siteList = sites.data?.sites ?? []
    return (
      <BingFrame>
        <Card className="surface-card">
          <div className="section-head section-head-inline">
            <div>
              <p className="eyebrow eyebrow-soft">Connection</p>
              <h3>Domain authorization</h3>
            </div>
            <div className="flex items-center gap-2">
              <ToneBadge tone="positive">Connected</ToneBadge>
              {!isEmbed() && (
                <WriteButton size="sm" variant="ghost" onClick={asyncHandler(handleDisconnect)}>
                  Disconnect
                </WriteButton>
              )}
            </div>
          </div>
          <div className="space-y-3">
            <div className="material-base px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="h-2 w-2 rounded-full bg-positive-500" />
                <span className="text-label-14 text-strong">Authorized for this project domain</span>
                <span className="text-label-12 text-muted">{connection.domain}</span>
              </div>
              <p className="mt-2 text-copy-13 text-muted">
                The API key is connected, but no Bing site is selected yet. Pick the verified site that should receive inspections and indexing requests.
              </p>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="material-base p-3">
                <p className="text-label-12 normal-case text-muted">Registered domain</p>
                <p className="mt-1 text-copy-14 text-strong">{connection.domain}</p>
              </div>
              <div className="material-base p-3">
                <p className="text-label-12 normal-case text-muted">Last auth update</p>
                <p className="mt-1 text-copy-14 text-strong">{connection.updatedAt ? formatTimestamp(connection.updatedAt) : '—'}</p>
              </div>
            </div>
            <div className="material-base p-3">
              <p className="text-label-12 normal-case text-muted">Select site</p>
              {siteList.length > 0 ? (
                <div className="mt-3 flex flex-col gap-2 lg:flex-row">
                  <select
                    aria-label="Bing site"
                    className="flex-1 rounded border border-strong bg-bg-elevated px-2 py-1.5 text-label-14 text-strong focus:border-mono-500 focus:outline-none"
                    value={selectedSite}
                    onChange={(e) => setSelectedSite(e.target.value)}
                  >
                    <option value="">Select a site...</option>
                    {siteList.map((s) => (
                      <option key={s.url} value={s.url}>
                        {s.url}
                        {s.verified ? ' (verified)' : ''}
                      </option>
                    ))}
                  </select>
                  {!isEmbed() && (
                    <WriteButton size="sm" disabled={!selectedSite} onClick={asyncHandler(handleSetSite)}>
                      Set Site
                    </WriteButton>
                  )}
                </div>
              ) : (
                <p className="mt-3 text-copy-13 text-muted">
                  {sites.isPending
                    ? 'Loading sites…'
                    : 'No verified Bing sites are available yet. Verify the domain in Bing Webmaster Tools, then use the page-level refresh to reload everything.'}
                </p>
              )}
            </div>
          </div>
          {error && <p className="mt-3 text-copy-13 text-negative">{error}</p>}
        </Card>
      </BingFrame>
    )
  }

  return <BingWorkspace projectName={projectName} connection={connection} siteUrl={connection.siteUrl} onDisconnect={handleDisconnect} error={error} />
}

// ── Workspace ────────────────────────────────────────────────────────────────

function BingWorkspace({
  projectName,
  connection,
  siteUrl,
  onDisconnect,
  error,
}: {
  projectName: string
  connection: ApiBingConnection
  siteUrl: string
  onDisconnect: () => Promise<void>
  error: string | null
}) {
  const [range, setRange] = useState<MetricsWindow>('30d')
  const path = { name: projectName }
  const traffic = useQuery({
    ...getApiV1ProjectsByNameBingTrafficOptions({
      client: heyClient,
      path,
      query: { window: range },
    }),
    staleTime: GSC_STALE_MS,
    placeholderData: keepPreviousData,
  })
  const site = useQuery({
    ...getApiV1ProjectsByNameBingSiteOptions({ client: heyClient, path }),
    staleTime: GSC_STALE_MS,
  })
  const sitemaps = useQuery({
    ...getApiV1ProjectsByNameBingSitemapsOptions({ client: heyClient, path }),
    staleTime: GSC_STALE_MS,
  })

  const synced = Boolean(traffic.data?.latestAvailableDate || site.data?.syncedAt || sitemaps.data?.syncedAt)
  const loaded = !traffic.isPending && !site.isPending && !sitemaps.isPending
  const blocked = rowsPayload(snapshotOf(site.data?.snapshots, 'blocked-urls'))?.length ?? 0

  return (
    <BingFrame
      status={
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-label-13 text-secondary">
          <span className="h-2 w-2 rounded-full bg-positive-500" aria-hidden="true" />
          <span>Connected</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono" title={siteUrl}>{siteHost(siteUrl)}</span>
          {traffic.data?.latestAvailableDate && (
            <>
              <span aria-hidden="true">·</span>
              <span>Data through {formatChartDateLabel(traffic.data.latestAvailableDate)}</span>
            </>
          )}
          {site.data?.syncedAt && (
            <>
              <span aria-hidden="true">·</span>
              <span>Synced {formatTimestamp(site.data.syncedAt)}</span>
            </>
          )}
          {blocked > 0 && (
            <span className="ml-1.5">
              <InfoTooltip
                tone="caution"
                label={`${blocked} blocked URL${blocked === 1 ? '' : 's'}`}
                text={`Bing is keeping ${blocked === 1 ? 'one URL' : `${blocked} URLs`} out of its results, which also keeps ${blocked === 1 ? 'it' : 'them'} out of Copilot answers. See Site settings.`}
              />
            </span>
          )}
        </p>
      }
      right={
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1 rounded px-2 py-1 text-button-14 text-secondary hover:text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 [&::-webkit-details-marker]:hidden">
            Connection <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="material-base mt-2 space-y-2 p-3 text-copy-13">
            <p>
              <span className="text-secondary">Domain</span> <span className="text-strong">{connection.domain}</span>
            </p>
            <p>
              <span className="text-secondary">Site</span> <span className="font-mono text-strong">{siteUrl}</span>
            </p>
            <p>
              <span className="text-secondary">Last auth update</span> <span className="text-strong">{connection.updatedAt ? formatTimestamp(connection.updatedAt) : '—'}</span>
            </p>
            {!isEmbed() && (
              <WriteButton size="sm" variant="ghost" onClick={asyncHandler(onDisconnect)}>
                Disconnect
              </WriteButton>
            )}
          </div>
        </details>
      }
    >
      <div className="space-y-3">
        {error && <p className="text-copy-13 text-negative">{error}</p>}

        {loaded && !synced ? (
          <BingFirstSyncCard projectName={projectName} />
        ) : (
          <BingPerformanceCard projectName={projectName} siteUrl={siteUrl} range={range} onRangeChange={setRange} />
        )}
        <BingIndexCard projectName={projectName} siteUrl={siteUrl} snapshots={site.data?.snapshots} />
        {synced && <BingSitemapsCard projectName={projectName} siteUrl={siteUrl} />}
        {synced && <BingDemandCard projectName={projectName} />}
        {synced && <BingSiteSettingsCard siteUrl={siteUrl} snapshots={site.data?.snapshots ?? []} />}
      </div>
    </BingFrame>
  )
}

function BingFirstSyncCard({ projectName }: { projectName: string }) {
  const [started, setStarted] = useState(false)
  async function handleSync() {
    try {
      await triggerBingSync(projectName)
      setStarted(true)
      addToast({
        title: 'Bing sync started',
        detail: 'Search data appears here when it finishes.',
        tone: 'neutral',
        dedupeKey: `bing:sync:${projectName}`,
        dedupeMode: 'replace',
      })
    } catch (e) {
      addToast({
        title: 'Bing sync could not start',
        detail: describeError(e),
        tone: 'negative',
        dedupeKey: `bing:sync:${projectName}`,
        dedupeMode: 'replace',
      })
    }
  }
  return (
    <Card className="surface-card">
      <h3 className="text-heading-16 text-strong">No Bing search data yet</h3>
      <p className="mt-1 text-copy-14 text-secondary">It arrives with the daily refresh.</p>
      {!isEmbed() && (
        <WriteButton className="mt-3" size="sm" disabled={started} onClick={asyncHandler(handleSync)}>
          {started ? 'Sync running…' : 'Sync Bing data now'}
        </WriteButton>
      )}
    </Card>
  )
}

// ── Search performance ───────────────────────────────────────────────────────

function BingPerformanceCard({
  projectName,
  siteUrl,
  range,
  onRangeChange,
}: {
  projectName: string
  siteUrl: string
  range: MetricsWindow
  onRangeChange: (range: MetricsWindow) => void
}) {
  const path = { name: projectName }
  const traffic = useQuery({
    ...getApiV1ProjectsByNameBingTrafficOptions({
      client: heyClient,
      path,
      query: { window: range },
    }),
    staleTime: GSC_STALE_MS,
    placeholderData: keepPreviousData,
  })
  // Weekly totals over every named query: the position figure, its change and its line.
  const weekly = useQuery({
    ...getApiV1ProjectsByNameBingQueriesOptions({
      client: heyClient,
      path,
      query: { window: range, groupBy: 'week' },
    }),
    staleTime: GSC_STALE_MS,
    placeholderData: keepPreviousData,
  })
  const coverageTrend = useQuery({
    ...getApiV1ProjectsByNameTrendsOptions({
      client: heyClient,
      path,
      query: { surface: 'index-coverage', window: range },
    }),
    staleTime: GSC_STALE_MS,
    placeholderData: keepPreviousData,
  })
  const [selected, setSelected] = useState<BingChartKey[]>(['clicks', 'impressions'])
  const [showTrend, setShowTrend] = useState(true)

  const data = traffic.data
  const bingIndexed = coverageTrend.data?.groups.find((group) => group.key === 'bing')?.figures.find((figure) => figure.key === 'indexed') ?? null
  const comparison = data?.periodComparison ?? null

  let body: ReactNode
  if (traffic.isPending) {
    body = <p className="mt-3 text-copy-14 text-secondary">Loading Bing search data…</p>
  } else if (traffic.isError || !data) {
    body = <p className="mt-3 text-copy-14 text-negative">Could not load Bing search data: {describeError(traffic.error)}</p>
  } else {
    const positionValue = weekly.data?.totals?.avgImpressionPosition ?? null
    const performanceGroup: TrendCardGroup = {
      key: 'performance',
      label: 'Bing search',
      basis: comparison?.comparable ? `vs prior ${comparison.days} ${comparison.days === 1 ? 'day' : 'days'}` : undefined,
      figures: BING_CHART_METRICS.map((metric): TrendCardFigure => {
        if (metric.key === 'position') {
          return {
            key: metric.key,
            label: metric.label,
            help: BING_POSITION_HELP,
            color: metric.color,
            value: positionValue === null ? '—' : metric.format(positionValue),
            change: bingPositionChange(weekly.data?.comparison),
            interactive: true,
            disabled: positionValue === null,
          }
        }
        const value = data.totals[metric.key]
        return {
          key: metric.key,
          label: metric.label,
          color: metric.color,
          value: metric.format(value),
          change: gscTrendChange(comparison, metric.key, false),
          interactive: true,
          disabled: data.rows.length === 0,
        }
      }),
    }
    const indexedGroup: TrendCardGroup | null = bingIndexed
      ? {
          key: 'indexed',
          label: 'Indexed pages',
          basis: sharedLevelBasis([bingIndexed]),
          figures: [
            {
              key: BING_INDEXED_KEY,
              label: 'Bing',
              color: CHART_SERIES_COLORS[6],
              value: bingIndexed.value === null ? '—' : bingIndexed.value.toLocaleString(),
              change: levelTrendChange(bingIndexed.change, bingIndexed.unit),
              interactive: true,
              disabled: bingIndexed.value === null,
            },
          ],
        }
      : null

    // One chart row per calendar day, from where the server's fit starts: the
    // window start, or the first stored day when the window reaches further
    // back than the sync. A day Bing sent no row for is a zero day.
    const first = data.rows[0]?.date
    const last = data.rows.at(-1)?.date
    const earliest = data.earliestAvailableDate
    const start = data.window.startDate && earliest && data.window.startDate > earliest ? data.window.startDate : (earliest ?? data.window.startDate ?? first)
    const end = data.window.endDate ?? last
    const byDate = new Map(data.rows.map((row) => [row.date, row]))
    const positionByWeek = new Map((weekly.data?.weekly ?? []).map((row) => [row.date, row.avgImpressionPosition]))
    const indexedByDate = new Map((bingIndexed?.series ?? []).map((point) => [point.date, point.value]))
    const chartRows =
      start && end
        ? calendarDateRange(start, end).map((date) => {
            const row = byDate.get(date)
            return {
              date,
              clicks: row?.clicks ?? 0,
              impressions: row?.impressions ?? 0,
              ctr: row && row.impressions > 0 ? row.ctr : null,
              position: positionByWeek.get(date) ?? null,
              [BING_INDEXED_KEY]: indexedByDate.get(date) ?? null,
            }
          })
        : []
    const series: TrendChartSeries[] = [
      ...BING_CHART_METRICS.filter((metric) => selected.includes(metric.key)).map((metric) => ({
        dataKey: metric.key,
        label: metric.label,
        color: metric.color,
        axisId: metric.key,
        inverted: 'inverted' in metric ? metric.inverted : undefined,
        formatValue: metric.format,
        trend: showTrend && metric.key !== 'position' ? data.trends[metric.key] : null,
        connectNulls: metric.key === 'position',
      })),
      ...(selected.includes(BING_INDEXED_KEY) && bingIndexed
        ? [
            {
              dataKey: BING_INDEXED_KEY,
              label: 'Bing indexed pages',
              color: CHART_SERIES_COLORS[6],
              axisId: BING_INDEXED_KEY,
              formatValue: (v: number) => v.toLocaleString(),
              connectNulls: true,
            },
          ]
        : []),
    ]

    body = (
      <div className="mt-3">
        <TrendCard
          name="Bing search figures"
          frame="none"
          mode="compare"
          groups={indexedGroup ? [performanceGroup, indexedGroup] : [performanceGroup]}
          selected={selected}
          refreshing={traffic.isFetching && traffic.isPlaceholderData}
          onSelect={(key) =>
            setSelected((current) =>
              current.includes(key as BingChartKey) ? (current.length === 1 ? current : current.filter((k) => k !== key)) : [...current, key as BingChartKey],
            )
          }
          chart={
            chartRows.length > 0 ? (
              <MultiAxisTrendChart
                data={chartRows}
                xKey="date"
                series={series}
                xTickFormatter={formatChartDateTick}
                labelFormatter={formatChartDateLabel}
                ariaLabel="Daily Bing search figures"
              />
            ) : undefined
          }
          emptyChartMessage="Bing reported no search traffic in this window."
          legendExtra={
            <label className="flex min-h-9 cursor-pointer items-center gap-2 pointer-coarse:min-h-11">
              <input
                type="checkbox"
                className="size-4 accent-mono-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
                checked={showTrend}
                onChange={(e) => setShowTrend(e.target.checked)}
              />
              Trend line
            </label>
          }
        />
        <BingSearchTable projectName={projectName} siteUrl={siteUrl} range={range} />
      </div>
    )
  }

  return (
    <Card className="surface-card">
      <div className="section-head section-head-inline">
        <div>
          <div className="flex items-center gap-1.5">
            <h3>Search performance</h3>
            <InfoTooltip
              text={`${gscComparisonBasisText(comparison)} Clicks, impressions and CTR are Bing's daily totals for the whole site. The queries and pages below are the ones Bing names, reported per week, so they do not add up to the site total.`}
            />
          </div>
          {data?.window.startDate && data.window.endDate && (
            <p className="text-copy-13 text-muted">
              {formatChartDateLabel(data.window.startDate)} to {formatChartDateLabel(data.window.endDate)}
            </p>
          )}
        </div>
        <MetricsWindowPicker windows={BING_WINDOWS} value={range} onChange={onRangeChange} label="Bing time period" formatOption={(w) => (w === 'all' ? 'All' : w)} />
      </div>
      {body}
    </Card>
  )
}

type SearchTab = 'queries' | 'pages'

function BingSearchTable({ projectName, siteUrl, range }: { projectName: string; siteUrl: string; range: MetricsWindow }) {
  const [tab, setTab] = useState<SearchTab>('queries')
  const [search, setSearch] = useState('')
  // The filter settles once typing pauses, so each keystroke is not a read.
  const [filter, setFilter] = useState<string | undefined>(undefined)
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<string | null>(null)
  const path = { name: projectName }
  const offset = (page - 1) * BING_TABLE_PAGE_SIZE
  useEffect(() => {
    const next = search.trim() || undefined
    if (next === undefined) {
      setFilter(undefined)
      return
    }
    const timer = setTimeout(() => setFilter(next), 300)
    return () => clearTimeout(timer)
  }, [search])
  const queriesRead = useQuery({
    ...getApiV1ProjectsByNameBingQueriesOptions({
      client: heyClient,
      path,
      query: {
        window: range,
        query: filter,
        limit: BING_TABLE_PAGE_SIZE,
        offset,
      },
    }),
    staleTime: GSC_STALE_MS,
    placeholderData: keepPreviousData,
    enabled: tab === 'queries',
  })
  const pagesRead = useQuery({
    ...getApiV1ProjectsByNameBingPagesOptions({
      client: heyClient,
      path,
      query: {
        window: range,
        page: filter,
        limit: BING_TABLE_PAGE_SIZE,
        offset,
      },
    }),
    staleTime: GSC_STALE_MS,
    placeholderData: keepPreviousData,
    enabled: tab === 'pages',
  })
  const read = tab === 'queries' ? queriesRead : pagesRead
  const rows =
    tab === 'queries'
      ? (queriesRead.data?.rows ?? []).map((row) => ({
          key: row.query,
          ...row,
        }))
      : (pagesRead.data?.rows ?? []).map((row) => ({ key: row.page, ...row }))
  const total = read.data?.totalMatching ?? 0
  const noun = tab === 'queries' ? 'Query' : 'Page'

  useEffect(() => {
    setPage(1)
    setOpen(null)
  }, [tab, range, filter])

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-base">
        <div className="flex gap-1" role="tablist" aria-label="Bing search rows">
          {(['queries', 'pages'] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`border-b-2 px-3 py-1.5 text-button-14 transition-colors ${tab === key ? 'border-mono-200 text-strong' : 'border-transparent text-muted hover:text-neutral'}`}
              onClick={() => setTab(key)}
            >
              {key === 'queries' ? 'Queries' : 'Pages'}
            </button>
          ))}
        </div>
        <DataTableSearch
          className="mb-1.5 w-full sm:w-64"
          value={search}
          onChange={setSearch}
          label={tab === 'queries' ? 'Filter Bing queries' : 'Filter Bing pages'}
          placeholder={tab === 'queries' ? 'Contains query…' : 'Contains page URL…'}
        />
      </div>
      {read.isError ? (
        <p className="mt-3 text-copy-14 text-negative">
          Could not load Bing {tab}: {describeError(read.error)}
        </p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="data-table w-full text-label-14">
            <thead>
              <tr>
                <th className="w-7">
                  <span className="sr-only">Expand</span>
                </th>
                <th className="text-left">{noun}</th>
                <th className="text-right">Clicks</th>
                <th className="text-right">Impressions</th>
                <th className="text-right">CTR</th>
                <th className="text-right">Position</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-secondary">
                    {read.isPending ? 'Loading…' : filter ? `No ${tab} match "${filter}" in this window.` : `Bing named no ${tab} in this window.`}
                  </td>
                </tr>
              )}
              {rows.map((row) => {
                const isOpen = open === row.key
                return (
                  <Fragment key={row.key}>
                    <tr>
                      <td>
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? 'Hide' : 'Show'} details for ${row.key}`}
                          className="rounded p-0.5 text-secondary hover:text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
                          onClick={() => setOpen(isOpen ? null : row.key)}
                        >
                          {isOpen ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
                        </button>
                      </td>
                      <td className="max-w-md text-strong">
                        {tab === 'pages' ? (
                          <MiddleTruncatedText value={sitePath(row.key, siteUrl)} title={row.key} className="font-mono text-label-13" />
                        ) : (
                          <span className="block truncate" title={row.key}>
                            {row.key}
                          </span>
                        )}
                      </td>
                      <td className="text-right tabular-nums text-neutral">{row.clicks.toLocaleString()}</td>
                      <td className="text-right tabular-nums text-secondary">{row.impressions.toLocaleString()}</td>
                      <td className="text-right tabular-nums text-secondary">{formatPercent(row.ctr)}</td>
                      <td className="text-right tabular-nums text-secondary">{formatPosition(row.avgImpressionPosition)}</td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td />
                        <td colSpan={5} className="pb-4">
                          <BingRowDetail projectName={projectName} siteUrl={siteUrl} range={range} tab={tab} rowKey={row.key} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-2 flex justify-end">
        <DataTablePagination
          page={page}
          pageSize={BING_TABLE_PAGE_SIZE}
          visibleRows={rows.length}
          totalRows={total}
          disabled={read.isFetching}
          itemLabel={tab}
          onPageChange={setPage}
        />
      </div>
    </div>
  )
}

/** A row's own weeks from the store, and on request the other side of the pair live from Bing. */
function BingRowDetail({ projectName, siteUrl, range, tab, rowKey }: { projectName: string; siteUrl: string; range: MetricsWindow; tab: SearchTab; rowKey: string }) {
  const path = { name: projectName }
  const [live, setLive] = useState(false)
  const queryWeeks = useQuery({
    ...getApiV1ProjectsByNameBingQueriesOptions({
      client: heyClient,
      path,
      query: { window: range, query: rowKey, match: 'exact', groupBy: 'week' },
    }),
    staleTime: GSC_STALE_MS,
    enabled: tab === 'queries',
  })
  const pageWeeks = useQuery({
    ...getApiV1ProjectsByNameBingPagesOptions({
      client: heyClient,
      path,
      query: { window: range, page: rowKey, match: 'exact', groupBy: 'week' },
    }),
    staleTime: GSC_STALE_MS,
    enabled: tab === 'pages',
  })
  const queryPages = useQuery({
    ...getApiV1ProjectsByNameBingQueryPagesOptions({
      client: heyClient,
      path,
      query: { query: rowKey },
    }),
    staleTime: GSC_STALE_MS,
    retry: false,
    enabled: live && tab === 'queries',
  })
  const pageQueries = useQuery({
    ...getApiV1ProjectsByNameBingPageQueriesOptions({
      client: heyClient,
      path,
      query: { page: rowKey },
    }),
    staleTime: GSC_STALE_MS,
    retry: false,
    enabled: live && tab === 'pages',
  })
  const weeks = (tab === 'queries' ? queryWeeks.data?.weekly : pageWeeks.data?.weekly) ?? []
  const liveRead = tab === 'queries' ? queryPages : pageQueries
  const liveRows = liveRead.data?.rows ?? []
  const otherNoun = tab === 'queries' ? 'Pages' : 'Queries'

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(260px,1fr)_minmax(280px,1.4fr)]">
      <div>
        <p className="mb-1.5 text-label-13-strong text-strong">By week</p>
        <table className="data-table w-full text-label-13">
          <thead>
            <tr>
              <th className="text-left">Week</th>
              <th className="text-right">Clicks</th>
              <th className="text-right">Impr.</th>
              <th className="text-right">Pos.</th>
            </tr>
          </thead>
          <tbody>
            {weeks.length === 0 && (
              <tr>
                <td colSpan={4} className="py-3 text-secondary">
                  {(tab === 'queries' ? queryWeeks : pageWeeks).isPending ? 'Loading…' : 'No weeks in this window.'}
                </td>
              </tr>
            )}
            {weeks.map((week) => (
              <tr key={week.date}>
                <td className="tabular-nums">{formatChartDateLabel(week.date)}</td>
                <td className="text-right tabular-nums">{week.clicks.toLocaleString()}</td>
                <td className="text-right tabular-nums text-secondary">{week.impressions.toLocaleString()}</td>
                <td className="text-right tabular-nums text-secondary">{formatPosition(week.avgImpressionPosition)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <p className="mb-1.5 flex items-baseline gap-2 text-label-13-strong text-strong">
          {otherNoun} for this {tab === 'queries' ? 'query' : 'page'}
          {liveRead.isSuccess && <span className="text-label-12 text-secondary">from Bing, by week</span>}
        </p>
        {!live &&
          (isEmbed() ? (
            <p className="text-copy-13 text-secondary">Not available here.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setLive(true)}>
                <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                Load {otherNoun.toLowerCase()} from Bing
              </Button>
              <InfoTooltip label="Live" text={BING_LIVE_HELP} />
            </div>
          ))}
        {live && liveRead.isPending && <p className="text-copy-13 text-secondary">Asking Bing…</p>}
        {live && liveRead.isError && (
          <div className="flex flex-wrap items-center gap-2">
            <InfoTooltip tone="caution" label="Bing refused this read" text={`${describeError(liveRead.error)} Nothing was stored.`} />
            <Button type="button" variant="outline" size="sm" onClick={() => void liveRead.refetch()}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Retry
            </Button>
          </div>
        )}
        {live &&
          liveRead.isSuccess &&
          (liveRows.length === 0 ? (
            <p className="text-copy-13 text-secondary">
              Bing named no {otherNoun.toLowerCase()} for this {tab === 'queries' ? 'query' : 'page'}.
            </p>
          ) : (
            <table className="data-table w-full text-label-13">
              <thead>
                <tr>
                  <th className="text-left">Week</th>
                  <th className="text-left">{tab === 'queries' ? 'Page' : 'Query'}</th>
                  <th className="text-right">Clicks</th>
                  <th className="text-right">Impr.</th>
                  <th className="text-right">Pos.</th>
                </tr>
              </thead>
              <tbody>
                {liveRows.map((row, index) => (
                  <tr key={`${row.date}:${row.key}:${index}`}>
                    <td className="tabular-nums text-secondary">{row.date ? formatChartDateLabel(row.date) : '—'}</td>
                    <td className="max-w-xs">
                      {tab === 'queries' ? (
                        <MiddleTruncatedText value={sitePath(row.key, siteUrl)} title={row.key} className="font-mono" />
                      ) : (
                        <span className="block truncate" title={row.key}>
                          {row.key}
                        </span>
                      )}
                    </td>
                    <td className="text-right tabular-nums">{row.clicks.toLocaleString()}</td>
                    <td className="text-right tabular-nums text-secondary">{row.impressions.toLocaleString()}</td>
                    <td className="text-right tabular-nums text-secondary">{formatPosition(row.avgImpressionPosition)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
      </div>
    </div>
  )
}

// ── Search demand ────────────────────────────────────────────────────────────

function BingDemandCard({ projectName }: { projectName: string }) {
  const demand = useQuery({
    ...getApiV1ProjectsByNameBingKeywordDemandOptions({
      client: heyClient,
      path: { name: projectName },
    }),
    staleTime: GSC_STALE_MS,
  })
  const [open, setOpen] = useState<string | null>(null)
  const market = demand.data?.market
  const rows = demand.data?.rows ?? []
  return (
    <Card className="surface-card">
      <div className="section-head section-head-inline">
        <h3>Search demand</h3>
        {market && (
          <InfoTooltip
            label={`${market.country.toUpperCase()} · ${market.language}`}
            text="Exact-match Bing searches per week for your tracked queries, averaged over the weeks stored. This is demand, not your traffic. Refreshed weekly."
          />
        )}
      </div>
      {demand.isError ? (
        <p className="text-copy-14 text-negative">Could not load search demand: {describeError(demand.error)}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table w-full text-label-14">
            <thead>
              <tr>
                <th className="w-7">
                  <span className="sr-only">Expand</span>
                </th>
                <th className="text-left">Tracked query</th>
                <th className="text-right">Searches / week</th>
                <th className="text-right">Latest week</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-secondary">
                    {demand.isPending ? 'Loading…' : 'No search demand stored yet. It is read weekly for tracked queries.'}
                  </td>
                </tr>
              )}
              {rows.map((row) => {
                const isOpen = open === row.query
                return (
                  <Fragment key={row.query}>
                    <tr>
                      <td>
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? 'Hide' : 'Show'} weekly searches for ${row.query}`}
                          className="rounded p-0.5 text-secondary hover:text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
                          onClick={() => setOpen(isOpen ? null : row.query)}
                        >
                          {isOpen ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
                        </button>
                      </td>
                      <td className="text-strong">{row.query}</td>
                      <td className="text-right tabular-nums text-neutral">{formatCount(row.avgWeeklyImpressions)}</td>
                      <td className="text-right tabular-nums text-secondary">{formatCount(row.latestImpressions)}</td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td />
                        <td colSpan={3} className="pb-4">
                          <BingDemandHistory projectName={projectName} query={row.query} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function BingDemandHistory({ projectName, query }: { projectName: string; query: string }) {
  const history = useQuery({
    ...getApiV1ProjectsByNameBingKeywordDemandOptions({
      client: heyClient,
      path: { name: projectName },
      query: { query },
    }),
    staleTime: GSC_STALE_MS,
  })
  const weeks = history.data?.history ?? []
  if (history.isPending) return <p className="text-copy-13 text-secondary">Loading…</p>
  if (weeks.length === 0) return <p className="text-copy-13 text-secondary">No weeks stored.</p>
  return (
    <table className="data-table w-full max-w-md text-label-13">
      <thead>
        <tr>
          <th className="text-left">Week</th>
          <th className="text-right">Exact</th>
          <th className="text-right">Broad</th>
        </tr>
      </thead>
      <tbody>
        {weeks.map((week) => (
          <tr key={week.date}>
            <td className="tabular-nums">{formatChartDateLabel(week.date)}</td>
            <td className="text-right tabular-nums">{week.impressions.toLocaleString()}</td>
            <td className="text-right tabular-nums text-secondary">{week.broadImpressions.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Index and crawl ──────────────────────────────────────────────────────────

type IndexTab = 'not-indexed' | 'unknown' | 'indexed' | 'inspections' | 'crawl'

function BingIndexCard({ projectName, siteUrl, snapshots }: { projectName: string; siteUrl: string; snapshots: readonly BingSiteSnapshotDto[] | undefined }) {
  const queryClient = useQueryClient()
  const path = { name: projectName }
  const coverage = useQuery({
    ...getApiV1ProjectsByNameBingCoverageOptions({ client: heyClient, path }),
    staleTime: GSC_STALE_MS,
  })
  const inspections = useQuery({
    ...getApiV1ProjectsByNameBingInspectionsOptions({
      client: heyClient,
      path,
    }),
    staleTime: GSC_STALE_MS,
  })
  const crawl = useQuery({
    ...getApiV1ProjectsByNameBingCrawlStatsOptions({
      client: heyClient,
      path,
      query: { days: '30' },
    }),
    staleTime: GSC_STALE_MS,
  })
  const [tab, setTab] = useState<IndexTab>('not-indexed')
  const [submitting, setSubmitting] = useState(false)
  const [inspectionUrl, setInspectionUrl] = useState('')
  const [inspectionResult, setInspectionResult] = useState<ApiBingInspection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const quota = quotaPayload(snapshotOf(snapshots, 'url-submission-quota'))
  const summary = coverage.data?.summary
  const latestCrawl = crawl.data?.rows[0]
  const notIndexed = coverage.data?.notIndexed ?? []
  const unknown = coverage.data?.unknown ?? []
  const indexed = coverage.data?.indexed ?? []
  const inspectionRows = inspections.data ?? []

  async function submit(body: { urls: string[] } | { allUnindexed: true }, key: string) {
    setSubmitting(true)
    setError(null)
    try {
      const result = await bingRequestIndexing(projectName, body)
      const { succeeded, failed, total } = result.summary
      addToast({
        title: failed === 0 ? 'Sent to Bing' : 'Some URLs were not sent',
        detail: failed === 0 ? `${succeeded} of ${total} URL${total === 1 ? '' : 's'} submitted.` : `${succeeded} of ${total} submitted, ${failed} not sent.`,
        tone: failed === 0 ? 'positive' : 'caution',
        dedupeKey: `bing:indexing:${projectName}:${key}`,
        dedupeMode: 'replace',
      })
      await invalidateProjectQueryDomain(queryClient, 'bing')
    } catch (e) {
      const message = describeError(e)
      setError(message)
      addToast({
        title: 'Bing submission failed',
        detail: message,
        tone: 'negative',
        dedupeKey: `bing:indexing:${projectName}:${key}`,
        dedupeMode: 'replace',
      })
    } finally {
      setSubmitting(false)
    }
  }

  async function inspect() {
    if (!inspectionUrl.trim()) return
    setError(null)
    try {
      const result = await inspectBingUrl(projectName, inspectionUrl.trim())
      setInspectionResult(result)
      await invalidateProjectQueryDomain(queryClient, 'bing')
    } catch (e) {
      setError(describeError(e))
    }
  }

  const coverageItems: KpiItem[] = summary
    ? [
        { label: 'Indexed', value: summary.indexed.toLocaleString() },
        {
          label: 'Not in index',
          value: (summary.notIndexed + (summary.unknown ?? 0)).toLocaleString(),
          tooltip: 'Pages Bing has not confirmed in its index, including those with an unknown status.',
        },
        {
          label: 'Status unknown',
          value: (summary.unknown ?? 0).toLocaleString(),
        },
        {
          label: 'Coverage',
          value: formatPercent(summary.percentage, RatioUnits.percent),
        },
      ]
    : []
  const listRows = tab === 'not-indexed' ? notIndexed : tab === 'unknown' ? unknown : tab === 'indexed' ? indexed : []
  const listTable = useClientTable({ rows: listRows, pageSize: BING_TABLE_PAGE_SIZE })
  const inspectionTable = useClientTable({ rows: inspectionRows, pageSize: BING_TABLE_PAGE_SIZE })
  const crawlTable = useClientTable({ rows: crawl.data?.rows ?? [], pageSize: BING_TABLE_PAGE_SIZE })

  const tabs: Array<{ key: IndexTab; label: string }> = [
    { key: 'not-indexed', label: `Not indexed (${notIndexed.length})` },
    { key: 'unknown', label: `Status unknown (${unknown.length})` },
    { key: 'indexed', label: `Indexed (${indexed.length})` },
    { key: 'inspections', label: `Inspections (${inspectionRows.length})` },
    { key: 'crawl', label: 'Crawl by day' },
  ]
  const showSubmit = !isEmbed() && (tab === 'not-indexed' || tab === 'unknown') && (tab === 'not-indexed' ? notIndexed.length : unknown.length) > 0

  return (
    <Card className="surface-card">
      <div className="section-head section-head-inline">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h3>Index and crawl</h3>
          {latestCrawl && latestCrawl.crawlErrors > 0 && (
            <InfoTooltip
              tone="caution"
              label={`${latestCrawl.crawlErrors.toLocaleString()} crawl error${latestCrawl.crawlErrors === 1 ? '' : 's'}`}
              text={`Bingbot got errors from ${latestCrawl.crawlErrors === 1 ? 'one URL' : `${latestCrawl.crawlErrors.toLocaleString()} URLs`} on ${formatChartDateLabel(latestCrawl.date)}. Crawl by day has the codes.`}
            />
          )}
        </div>
        <p className="text-copy-13 text-muted">
          {coverage.data?.lastInspectedAt ? `Last inspected ${formatTimestamp(coverage.data.lastInspectedAt)}` : 'No inspection history yet'}
        </p>
      </div>
      <div className="space-y-4">
        {coverageItems.length > 0 ? (
          <KpiRow label="Bing index coverage" items={coverageItems} />
        ) : (
          <p className="text-copy-13 text-muted">No coverage data yet. Inspect URLs to build coverage data.</p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-b border-base">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Bing index and crawl lists">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`border-b-2 px-3 py-1.5 text-button-14 transition-colors ${tab === t.key ? 'border-mono-200 text-strong' : 'border-transparent text-muted hover:text-neutral'}`}
              onClick={() => {
                setTab(t.key)
                listTable.setPage(1)
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        {showSubmit && (
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            {quota && <span className="text-label-13 text-secondary">{quota.dailyQuota.toLocaleString()} submissions left today</span>}
            <WriteButton size="sm" variant="outline" disabled={submitting} onClick={asyncHandler(() => submit({ allUnindexed: true }, 'all'))}>
              {submitting ? 'Submitting…' : 'Submit all to Bing'}
            </WriteButton>
          </div>
        )}
      </div>
      {error && <p className="mt-2 text-copy-13 text-negative">{error}</p>}

      <div className="mt-2 overflow-x-auto">
        {(tab === 'not-indexed' || tab === 'unknown' || tab === 'indexed') &&
          (() => {
            const canSubmit = tab !== 'indexed' && !isEmbed()
            return (
              <table className="data-table w-full text-label-14">
                <thead>
                  <tr>
                    <th className="text-left">URL</th>
                    <th className="text-right">{tab === 'not-indexed' ? 'HTTP' : 'Last crawled'}</th>
                    {canSubmit && (
                      <th className="text-right">
                        <span className="sr-only">Action</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {listTable.totalRows === 0 && (
                    <tr>
                      <td colSpan={canSubmit ? 3 : 2} className="py-6 text-center text-secondary">
                        {coverage.isPending ? 'Loading…' : 'None.'}
                      </td>
                    </tr>
                  )}
                  {listTable.rows.map((row) => (
                    <tr key={row.id} className="group">
                      <td className="max-w-lg">
                        <MiddleTruncatedText value={sitePath(row.url, siteUrl)} title={row.url} className="font-mono text-label-13 text-neutral" />
                      </td>
                      <td className="text-right tabular-nums text-secondary">
                        {tab === 'not-indexed' ? (row.httpCode ?? '—') : row.lastCrawledDate ? formatTimestamp(row.lastCrawledDate) : '—'}
                      </td>
                      {canSubmit && (
                        <td className="text-right">
                          <div className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100">
                            <WriteButton size="sm" variant="ghost" disabled={submitting} onClick={asyncHandler(() => submit({ urls: [row.url] }, row.url))}>
                              Submit
                            </WriteButton>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          })()}
        {(tab === 'not-indexed' || tab === 'unknown' || tab === 'indexed') && (
          <DataTablePagination page={listTable.page} pageSize={BING_TABLE_PAGE_SIZE} visibleRows={listTable.rows.length} totalRows={listTable.totalRows} onPageChange={listTable.setPage} itemLabel="URLs" />
        )}

        {tab === 'inspections' && (
          <div className="space-y-3 pt-2">
            {!isEmbed() && (
              <div className="flex flex-col gap-2 lg:flex-row">
                <input
                  type="text"
                  aria-label="URL to inspect"
                  className="flex-1 rounded border border-strong bg-transparent px-2 py-1.5 text-label-14 text-strong placeholder-mono-400 focus:border-mono-500 focus:outline-none"
                  placeholder="URL to inspect"
                  value={inspectionUrl}
                  onChange={(e) => setInspectionUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void inspect()
                  }}
                />
                <WriteButton size="sm" disabled={!inspectionUrl.trim()} onClick={asyncHandler(inspect)}>
                  Inspect
                </WriteButton>
              </div>
            )}
            {inspectionResult && (
              <div className="material-base space-y-1 p-3 text-label-13">
                <div className="text-label-13-strong text-strong">{inspectionResult.url}</div>
                <div className="text-secondary">
                  In index: <span className={inspectionResult.inIndex ? 'text-positive' : 'text-negative'}>{inspectionResult.inIndex ? 'Yes' : 'No'}</span>
                  {' · '}HTTP: {inspectionResult.httpCode ?? '—'}
                  {' · '}Crawled: {inspectionResult.lastCrawledDate ?? '—'}
                </div>
              </div>
            )}
            <table className="data-table w-full text-label-14">
              <thead>
                <tr>
                  <th className="text-left">URL</th>
                  <th className="text-left">Index</th>
                  <th className="text-right">HTTP</th>
                  <th className="text-right">Inspected</th>
                </tr>
              </thead>
              <tbody>
                {inspectionRows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-secondary">
                      {inspections.isPending ? 'Loading…' : 'No inspections yet.'}
                    </td>
                  </tr>
                )}
                {inspectionTable.rows.map((row) => (
                  <tr key={row.id}>
                    <td className="max-w-lg">
                      <MiddleTruncatedText value={sitePath(row.url, siteUrl)} title={row.url} className="font-mono text-label-13 text-neutral" />
                    </td>
                    <td>
                      <ToneBadge tone={row.inIndex ? 'positive' : 'negative'}>{row.inIndex ? 'Yes' : 'No'}</ToneBadge>
                    </td>
                    <td className="text-right tabular-nums text-secondary">{row.httpCode ?? '—'}</td>
                    <td className="text-right tabular-nums text-secondary">{formatTimestamp(row.inspectedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <DataTablePagination page={inspectionTable.page} pageSize={BING_TABLE_PAGE_SIZE} visibleRows={inspectionTable.rows.length} totalRows={inspectionTable.totalRows} onPageChange={inspectionTable.setPage} itemLabel="inspections" />
          </div>
        )}

        {tab === 'crawl' && (
          <>
          <table className="data-table w-full text-label-13">
            <thead>
              <tr>
                <th className="text-left">Day</th>
                <th className="text-right">Crawled</th>
                <th className="text-right">Errors</th>
                <th className="text-right">In index</th>
                <th className="text-right">2xx</th>
                <th className="text-right">301</th>
                <th className="text-right">302</th>
                <th className="text-right">4xx</th>
                <th className="text-right">5xx</th>
                <th className="text-right">Other</th>
                <th className="text-right">Robots.txt</th>
                <th className="text-right">Timeouts</th>
                <th className="text-right">DNS</th>
                <th className="text-right">Malware</th>
                <th className="text-right">Inbound links</th>
              </tr>
            </thead>
            <tbody>
              {(crawl.data?.rows ?? []).length === 0 && (
                <tr>
                  <td colSpan={15} className="py-6 text-center text-secondary">
                    {crawl.isPending ? 'Loading…' : 'No crawl stats stored yet.'}
                  </td>
                </tr>
              )}
              {crawlTable.rows.map((row) => (
                <tr key={row.date}>
                  <td className="tabular-nums">{formatChartDateLabel(row.date)}</td>
                  {[
                    row.crawledPages,
                    row.crawlErrors,
                    row.inIndex,
                    row.code2xx,
                    row.code301,
                    row.code302,
                    row.code4xx,
                    row.code5xx,
                    row.allOtherCodes,
                    row.blockedByRobotsTxt,
                    row.connectionTimeout,
                    row.dnsFailures,
                    row.containsMalware,
                    row.inLinks,
                  ].map((value, index) => (
                    <td key={index} className="text-right tabular-nums text-secondary">
                      {value.toLocaleString()}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <DataTablePagination page={crawlTable.page} pageSize={BING_TABLE_PAGE_SIZE} visibleRows={crawlTable.rows.length} totalRows={crawlTable.totalRows} onPageChange={crawlTable.setPage} itemLabel="days" />
          </>
        )}
      </div>
    </Card>
  )
}

// ── Sitemaps ─────────────────────────────────────────────────────────────────

/** Bing's status word as a tone: Success is good, an error or failure is bad, anything else is waiting. */
function bingSitemapTone(status: string): SitemapRowView['status']['tone'] {
  const word = status.toLowerCase()
  if (word === 'success') return 'positive'
  if (word.includes('error') || word.includes('fail')) return 'negative'
  if (word.includes('warn')) return 'caution'
  return 'neutral'
}

function BingSitemapsCard({ projectName, siteUrl }: { projectName: string; siteUrl: string }) {
  const { canWrite } = useAccount()
  const sitemaps = useQuery({
    ...getApiV1ProjectsByNameBingSitemapsOptions({
      client: heyClient,
      path: { name: projectName },
    }),
    staleTime: GSC_STALE_MS,
  })
  const [inspecting, setInspecting] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const all = sitemaps.data?.sitemaps ?? []
  const toView = (row: (typeof all)[number]): SitemapRowView => {
    const isIndex = row.type.toLowerCase().includes('index')
    return {
      url: row.url,
      label: sitePath(row.url, siteUrl),
      isIndex,
      kind: !isIndex && row.type.toLowerCase() !== 'sitemap' ? row.type : undefined,
      status: { label: row.status, tone: bingSitemapTone(row.status) },
      urls: row.urlCount,
      submittedAt: row.submittedAt,
      lastReadAt: row.lastCrawledAt,
    }
  }
  // Top-level submissions, each index carrying the sitemaps Bing found in it.
  // A listed sitemap whose index is gone stays visible at the top level.
  const topLevel = all.filter((row) => row.parentUrl === null || !all.some((parent) => parent.parentUrl === null && parent.url === row.parentUrl))
  const rows = topLevel.map((row) => {
    const view = toView(row)
    return view.isIndex ? { ...view, files: all.filter((child) => child.parentUrl === row.url).map(toView) } : view
  })

  async function inspect(sitemapUrl: string) {
    setInspecting(sitemapUrl)
    try {
      await inspectBingSitemap(projectName, { sitemapUrl })
      addToast({
        title: 'Checking sitemap URLs in Bing',
        detail: 'Coverage updates when the check finishes.',
        tone: 'neutral',
        dedupeKey: `bing:inspect-sitemap:${projectName}`,
        dedupeMode: 'replace',
      })
    } catch (e) {
      addToast({
        title: 'Sitemap check could not start',
        detail: describeError(e),
        tone: 'negative',
        dedupeKey: `bing:inspect-sitemap:${projectName}`,
        dedupeMode: 'replace',
      })
    } finally {
      setInspecting(null)
    }
  }

  return (
    <Card className="surface-card">
      <div className="section-head section-head-inline">
        <div className="flex items-center gap-1.5">
          <h3>Sitemaps</h3>
          <InfoTooltip text="What Bing reported for each submitted sitemap at the last sync. Inspect URLs checks every page in a sitemap against Bing's index." />
        </div>
        {sitemaps.data?.syncedAt && <p className="text-copy-13 text-muted">As of {formatTimestamp(sitemaps.data.syncedAt)}</p>}
      </div>
      {sitemaps.isError ? (
        <p className="text-copy-14 text-negative">Could not load sitemaps: {describeError(sitemaps.error)}</p>
      ) : (
        <SitemapTable
          rows={rows}
          expanded={expanded}
          onToggle={(url) => setExpanded((current) => {
            const next = new Set(current)
            if (next.has(url)) next.delete(url)
            else next.add(url)
            return next
          })}
          lastReadLabel="Last crawled"
          empty={sitemaps.isPending ? 'Loading\u2026' : 'Bing lists no sitemaps for this site.'}
          actions={isEmbed() ? undefined : (row) => (
            <SitemapRowAction
              disabled={!canWrite || inspecting !== null}
              title={canWrite ? undefined : VIEW_ONLY_LABEL}
              onClick={() => void inspect(row.url)}
            >
              {inspecting === row.url ? 'Starting\u2026' : 'Inspect URLs'}
            </SitemapRowAction>
          )}
        />
      )}
    </Card>
  )
}

// ── Site settings ────────────────────────────────────────────────────────────

const OWNER_ONLY_HELP = 'Bing shows this only to the site owner key. Not a failure.'

function BingSiteSettingsCard({ siteUrl, snapshots }: { siteUrl: string; snapshots: readonly BingSiteSnapshotDto[] }) {
  const urlQuota = quotaPayload(snapshotOf(snapshots, 'url-submission-quota'))
  const contentQuota = quotaPayload(snapshotOf(snapshots, 'content-submission-quota'))
  const crawlSettings = crawlSettingsPayload(snapshotOf(snapshots, 'crawl-settings'))
  const listKinds: Array<{
    kind: BingSiteSnapshotKind
    label: string
    columns: Array<{ key: string; label: string }>
  }> = [
    {
      kind: 'blocked-urls',
      label: 'Blocked URLs',
      columns: [
        { key: 'url', label: 'URL' },
        { key: 'entityType', label: 'Type' },
        { key: 'requestType', label: 'Removal' },
        { key: 'daysToExpire', label: 'Days left' },
        { key: 'date', label: 'Added' },
      ],
    },
    { kind: 'page-preview-blocks', label: 'Preview blocks', columns: [] },
    { kind: 'deep-link-blocks', label: 'Sitelink blocks', columns: [] },
    {
      kind: 'query-parameters',
      label: 'URL parameters',
      columns: [
        { key: 'parameter', label: 'Parameter' },
        { key: 'isEnabled', label: 'Enabled' },
        { key: 'source', label: 'Source' },
        { key: 'date', label: 'Added' },
      ],
    },
    {
      kind: 'country-region-settings',
      label: 'Geo-targeting',
      columns: [
        { key: 'url', label: 'URL' },
        { key: 'countryCode', label: 'Country' },
        { key: 'type', label: 'Applies to' },
        { key: 'date', label: 'Added' },
      ],
    },
    {
      kind: 'crawl-issues',
      label: 'Crawl issues',
      columns: [
        { key: 'url', label: 'URL' },
        { key: 'httpCode', label: 'HTTP' },
        { key: 'issues', label: 'Issues' },
        { key: 'inLinks', label: 'Inbound links' },
      ],
    },
    {
      kind: 'fetched-urls',
      label: 'Fetch as Bingbot',
      columns: [
        { key: 'url', label: 'URL' },
        { key: 'fetched', label: 'Fetched' },
        { key: 'expired', label: 'Expired' },
        { key: 'date', label: 'Requested' },
      ],
    },
    { kind: 'connected-pages', label: 'Connected pages', columns: [] },
    {
      kind: 'site-roles',
      label: 'Users and roles',
      columns: [
        { key: 'email', label: 'User' },
        { key: 'role', label: 'Role' },
        { key: 'expired', label: 'Expired' },
        { key: 'date', label: 'Added' },
      ],
    },
  ]

  /** A list setting's row value: its count, or why there is none. */
  function listValue(snapshot: BingSiteSnapshotDto | undefined, rows: Row[] | null): { value: string; help?: string } {
    if (!snapshot) return { value: '\u2014', help: 'Not read yet.' }
    if (snapshot.status === 'unauthorized') return { value: 'Owner key needed', help: OWNER_ONLY_HELP }
    if (snapshot.status === 'failed' && rows === null) return { value: '\u2014', help: `The last read failed: ${snapshot.error ?? 'no detail'}` }
    const count = rows?.length ?? 0
    return { value: count === 0 ? 'None' : count.toLocaleString() }
  }

  const listRows = listKinds.map(({ kind, label, columns }) => {
    const snapshot = snapshotOf(snapshots, kind)
    const rows = rowsPayload(snapshot)
    const { value, help } = listValue(snapshot, rows)
    const stale = snapshot?.status === 'failed' && rows !== null
    const keys = columns.length > 0 || !rows ? columns : [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((key) => key !== '__type').map((key) => ({ key, label: key }))
    return (
      <SettingRow key={kind} label={label} value={value} help={help} note={stale ? 'from an earlier sync' : undefined}>
        {rows && rows.length > 0 ? (
          <div className="overflow-x-auto">
            {stale && <p className="mb-2 text-copy-13 text-caution">The last read failed, so these rows are from an earlier sync: {snapshot?.error ?? 'no detail'}</p>}
            <table className="data-table w-full text-label-13">
              <thead>
                <tr>
                  {keys.map((column) => (
                    <th key={column.key} className="text-left">
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index}>
                    {keys.map((column) => {
                      const cell = row[column.key] ?? row[column.key.charAt(0).toUpperCase() + column.key.slice(1)]
                      return (
                        <td key={column.key} className={column.key.toLowerCase() === 'url' ? 'max-w-md' : 'text-secondary'}>
                          {column.key.toLowerCase() === 'url' && typeof cell === 'string' ? (
                            <MiddleTruncatedText value={sitePath(cell, siteUrl)} title={cell} className="font-mono text-neutral" />
                          ) : (
                            cellText(cell, column.key)
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : undefined}
      </SettingRow>
    )
  })
  const byKind = (kind: BingSiteSnapshotKind) => listRows[listKinds.findIndex((entry) => entry.kind === kind)]
  const quotaValue = (quota: QuotaPayload | null) => (quota ? `${quota.dailyQuota.toLocaleString()} today \u00b7 ${quota.monthlyQuota.toLocaleString()} this month` : '\u2014')

  return (
    <Card className="surface-card">
      <div className="section-head section-head-inline">
        <h3>Site settings</h3>
      </div>
      <div role="list" aria-label="Bing site settings">
        {byKind('blocked-urls')}
        {byKind('crawl-issues')}
        <SettingRow label="URL submissions left" value={quotaValue(urlQuota)} help="URL submissions Bing will still accept, as of the last sync." />
        <SettingRow label="Content submissions left" value={quotaValue(contentQuota)} />
        <SettingRow label="Crawl boost" value={crawlSettings ? (crawlSettings.crawlBoostEnabled ? 'On' : crawlSettings.crawlBoostAvailable ? 'Off' : 'Not offered') : '\u2014'} />
        {crawlSettings && crawlSettings.crawlRate.length === 24 && (
          <SettingRow label="Crawl rate by hour" value="24 hours">
            <div className="overflow-x-auto">
              <table className="data-table text-label-13">
                <thead>
                  <tr>
                    {crawlSettings.crawlRate.map((_, hour) => (
                      <th key={hour} className="text-right">
                        {hour}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    {crawlSettings.crawlRate.map((rate, hour) => (
                      <td key={hour} className="text-right tabular-nums text-secondary">
                        {rate}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </SettingRow>
        )}
        {byKind('fetched-urls')}
        {byKind('query-parameters')}
        {byKind('country-region-settings')}
        {byKind('page-preview-blocks')}
        {byKind('deep-link-blocks')}
        {byKind('connected-pages')}
        {byKind('site-roles')}
      </div>
    </Card>
  )
}

/**
 * One setting: its name and value on a line. A setting with rows opens in
 * place to show them. Help sits beside the value, never inside the toggle.
 */
function SettingRow({ label, value, help, note, children }: { label: string; value: string; help?: string; note?: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const name = <span className="flex-1 text-label-14 text-strong">{label}</span>
  const reading = (
    <span className="flex items-center gap-1.5 text-label-14 tabular-nums text-secondary">
      {note && <span className="text-label-12 text-caution">{note}</span>}
      {value}
    </span>
  )
  if (!children) {
    return (
      <div role="listitem" className="flex items-center gap-2 border-t border-default py-2.5 first:border-t-0">
        <span className="w-3.5 shrink-0" aria-hidden="true" />
        {name}
        {reading}
        {help && <InfoTooltip text={help} />}
      </div>
    )
  }
  return (
    <details role="listitem" className="group border-t border-default first:border-t-0" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-secondary transition-transform group-open:rotate-90" aria-hidden="true" />
        {name}
        {reading}
      </summary>
      {open && <div className="pb-4 pl-5.5">{children}</div>}
    </details>
  )
}
