import { useAccount } from '../../contexts/account-context.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { MetricsWindowPicker } from '../shared/MetricsWindowPicker.js'
import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import type { GscPerformanceDailyDto, MetricsWindow } from '@ainyc/canonry-contracts'

import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import {
  DataTablePagination,
  DataTableSearch,
  DEFAULT_TABLE_PAGE_SIZE,
  MiddleTruncatedText,
  useClientTable,
} from '../shared/DataTableControls.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import {
  CHART_NEUTRAL,
  CHART_TONE,
  CHART_SERIES_COLORS,
  MultiAxisTrendChart,
  formatChartDateLabel,
  formatChartDateTick,
  type TrendChartSeries,
} from '../shared/ChartPrimitives.js'
import { calendarDateRange, type GscPeriodComparison } from '@ainyc/canonry-contracts'
import { formatTimestamp, formatBooleanState, SearchMetric, SEARCH_METRIC_LABELS } from '../../lib/format-helpers.js'
import { addToast } from '../../lib/toast-store.js'
import { asyncHandler } from '../../lib/async-handler.js'
import { extractApiErrorInfo } from '../../lib/extract-error-message.js'
import { gscActionNeededFromError, type GscActionNeeded } from '../../lib/gsc-remediation.js'
import { safeExternalUrl } from '../../lib/safe-url.js'
import {
  fetchSettings,
  googleConnect,
  googleDisconnect,
  saveGoogleProperty,
  inspectGscUrl,
  saveSitemapUrl,
  fetchGscSitemaps,
  submitGscSitemaps,
  requestIndexing,
  heyClient,
  type ApiGscSitemap,
  type ApiGoogleConnection,
  type ApiGoogleProperty,
  type ApiGscPerformanceRow,
  type ApiGscInspection,
  type ApiGscDeindexedRow,
  type ApiGscCoverageSummary,
} from '../../api.js'
import {
  getApiV1ProjectsByNameGoogleConnectionsOptions,
  getApiV1ProjectsByNameGoogleGscCoverageHistoryOptions,
  getApiV1ProjectsByNameGoogleGscCoverageOptions,
  getApiV1ProjectsByNameGoogleGscDeindexedOptions,
  getApiV1ProjectsByNameGoogleGscInspectionsOptions,
  getApiV1ProjectsByNameGoogleGscPerformanceDailyOptions,
  getApiV1ProjectsByNameGoogleGscPerformanceOptions,
  getApiV1ProjectsByNameGoogleGscSitemapsQueryKey,
  getApiV1ProjectsByNameGooglePropertiesOptions,
} from '@ainyc/canonry-api-client/react-query'
import {
  useTriggerGscSync,
  useTriggerInspectSitemap,
} from '../../queries/mutations.js'
import { GSC_STALE_MS } from '../../queries/query-client.js'
import { invalidateProjectQueryDomain } from '../../queries/query-invalidation.js'

export const GSC_MANAGED_EMPTY_COPY = 'Search Console is not connected yet. Your Canonry team can set this up.'

const GSC_WINDOWS: MetricsWindow[] = ['7d', '30d', '90d', 'all']
const EXPANDED_PERFORMANCE_LIMIT = 500

/**
 * The four Search Console metrics, each on its OWN axis.
 *
 * Sharing one axis is what made the previous chart unreadable: 29 clicks
 * against 1,174 impressions rendered as a flat line on the baseline. Per-metric
 * axes let each series use the full plot height, which is why the same data
 * reads as a trend here and as nothing on a shared scale.
 *
 * `inverted` on position is not styling — rank 1 beats rank 13, so the axis
 * has to run the other way for "up" to keep meaning "better" across all four.
 */
const GSC_CHART_METRICS = [
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
    format: (v: number) => `${(v * 100).toFixed(1)}%`,
  },
  {
    key: 'position' as const,
    label: 'Avg position',
    color: CHART_SERIES_COLORS[2],
    inverted: true,
    format: (v: number) => v.toFixed(1),
  },
]

type GscChartMetric = (typeof GSC_CHART_METRICS)[number]['key']
const COVERAGE_PAGE_SIZE = 25
const GOOGLE_OAUTH_COMPLETE_MESSAGE = 'canonry:google-oauth-complete'

const GSC_TREND_PERCENT_FORMATTER = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
})

/**
 * Express the trailing period's change against the equal period before it.
 *
 * This replaced a percentage taken off the fitted trend line's own start value.
 * That baseline was a value the property never had: the fit is unconstrained,
 * so it predicted a NEGATIVE day-one figure for impressions on a real property
 * and the tile printed nothing at all on a metric that had grown six-fold. Where
 * it did print, it described the line rather than the data — average position
 * read as a 45.8% improvement across a window in which the real position got
 * worse. Both periods here are stretches the property actually recorded.
 *
 * Position reverses only the desirability arrow, not the math: a rank number
 * going UP is a WORSE result, so `inverted` flips which direction reads as an
 * improvement.
 *
 * `comparison.days` is the length of ONE period, and under
 * `basis: 'split-window'` that is half the selected window — which is why
 * pressing `90d` could produce "vs prior 45d". The number was always accurate;
 * it names the period it measured, not the button. Every string here is built
 * from `days` for that reason, and the heading tooltip explains which basis is
 * in force.
 */
export function formatGscPeriodChange(
  comparison: GscPeriodComparison | null | undefined,
  metric: GscChartMetric,
  inverted: boolean | undefined,
): string {
  // A server older than this field, or a window too short to split, gives us
  // nothing to compare. Say so plainly rather than imply a flat period.
  if (!comparison) return 'no comparison period'

  const days = comparison.days
  // Any dimensioned fallback makes property totals unavailable. This can be
  // true even when both halves carry the same source.
  if (!comparison.comparable) return 'property-level comparison unavailable'

  const ratio = comparison.change[metric]
  // The prior period was zero or unmeasured. Growth from nothing has no
  // percentage; naming the two figures is more use than "no baseline" was.
  if (ratio === null || !Number.isFinite(ratio)) {
    const prior = comparison.prior[metric]
    const trailing = comparison.trailing[metric]
    if (prior !== null && trailing !== null && prior <= 0 && trailing > 0) {
      return `new in the last ${days}d`
    }
    if (prior === null || prior <= 0) return `no prior ${days}d to compare`
    if (trailing === null) return `no value in the last ${days}d`
    return 'comparison unavailable'
  }

  if (ratio === 0) return `→ no change vs prior ${days}d`

  const percent = Math.abs(ratio * 100)
  // Rounding must not turn a real movement into a flat reading.
  const formatted = percent < 0.1
    ? '<0.1%'
    : `${GSC_TREND_PERCENT_FORMATTER.format(percent)}%`
  const improving = inverted ? ratio < 0 : ratio > 0
  return `${improving ? '↑' : '↓'} ${formatted} vs prior ${days}d`
}

/**
 * The sentence in the section tooltip that says which two periods the tiles
 * compare, and — when they are not the ones the window control implies — why.
 *
 * Pressing `90d` and reading "vs prior 45d" was the whole confusion this
 * answers: the tile names the period it measured, and under `split-window` that
 * period is half the selection. Naming both date ranges outright means a reader
 * never has to infer it from a length.
 */
export function gscComparisonBasisText(
  comparison: GscPeriodComparison | null | undefined,
): string {
  if (!comparison) {
    return 'Tile percentages compare the selected window with the equal-length period before it.'
  }
  const { days, basis, prior, trailing } = comparison
  const unit = days === 1 ? 'day' : 'days'
  const priorRange = `${prior.startDate} to ${prior.endDate}`
  const trailingRange = `${trailing.startDate} to ${trailing.endDate}`
  // True under either basis: the two periods are always adjacent and equal
  // length, and naming both ranges is what makes the percentage checkable.
  const ranges = `Tile percentages compare these ${days} ${unit} (${trailingRange})`
    + ` with the ${days} ${unit} before them (${priorRange}).`
  // Only an EXPLICIT split-window earns the explanation. Absent basis is a
  // server older than the field: it did not say the window was split, so
  // neither do we — the ranges above already say everything it sent.
  if (basis !== 'split-window') return ranges
  // Either the selection has no lower bound (all history) or the period before
  // it was never synced, and unsynced days counted as zero would manufacture
  // growth. Both come out as one honest statement.
  return `${ranges} That is the trailing half of the selected window against its own`
    + ' earlier half: there is no equal-length period before the window with synced data'
    + ' to compare it against.'
}

function sitemapDiscoveredUrlCount(sitemap: ApiGscSitemap): number {
  return sitemap.contents?.reduce((total, content) => total + Number(content.submitted || 0), 0) ?? 0
}

function sitemapIssueText(sitemap: ApiGscSitemap): string {
  const errors = Number(sitemap.errors ?? 0)
  const warnings = Number(sitemap.warnings ?? 0)
  return [
    errors > 0 ? `${errors} error${errors === 1 ? '' : 's'}` : '',
    warnings > 0 ? `${warnings} warning${warnings === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ')
}

function sitemapGoogleStatus(sitemap: ApiGscSitemap): string {
  if (sitemap.isPending) return 'Processing'
  if (Number(sitemap.errors ?? 0) > 0) return 'Errors'
  if (Number(sitemap.warnings ?? 0) > 0) return 'Warnings'
  return 'Success'
}

export function GscSection({
  projectName,
  refreshNonce,
}: {
  projectName: string
  refreshNonce: number
}) {
  const queryClient = useQueryClient()
  const { isAdmin } = useAccount()
  const [googleConfigured, setGoogleConfigured] = useState(false)
  const [connections, setConnections] = useState<ApiGoogleConnection[]>([])
  const [properties, setProperties] = useState<ApiGoogleProperty[]>([])
  const [performance, setPerformance] = useState<ApiGscPerformanceRow[]>([])
  const [performanceDaily, setPerformanceDaily] = useState<GscPerformanceDailyDto | null>(null)
  const [inspections, setInspections] = useState<ApiGscInspection[]>([])
  const [deindexed, setDeindexed] = useState<ApiGscDeindexedRow[]>([])
  const [inspectionResult, setInspectionResult] = useState<ApiGscInspection | null>(null)
  const [selectedProperty, setSelectedProperty] = useState('')
  const [inspectionUrl, setInspectionUrl] = useState('')
  const [syncDays, setSyncDays] = useState('30')
  const [fullSync, setFullSync] = useState(false)
  const [gscWindow, setGscWindow] = useState<MetricsWindow>('30d')
  // Clicks + impressions selected by default, matching Search Console.
  const [chartMetrics, setChartMetrics] = useState<GscChartMetric[]>(['clicks', 'impressions'])
  const [showTrend, setShowTrend] = useState(true)
  // The day the table is drilled into, or null for the whole window. Bumping
  // the nonce is what re-runs the fetch, so re-clicking the same day still
  // reloads and the effect never reads a stale filter value.
  const [drillDay, setDrillDay] = useState<string | null>(null)
  const [drillNonce, setDrillNonce] = useState(0)
  const [performanceFilters, setPerformanceFilters] = useState({
    startDate: '',
    endDate: '',
    query: '',
    page: '',
  })
  const [performanceOffset, setPerformanceOffset] = useState(0)
  const [performanceHasMore, setPerformanceHasMore] = useState(false)
  const [performanceTotalLoaded, setPerformanceTotalLoaded] = useState(0)
  // Mode the *currently displayed* rows were fetched in. Decoupled from the
  // live filter inputs so the footer stays consistent with the table until
  // the user clicks Apply filters.
  const [performanceDisplayedExpanded, setPerformanceDisplayedExpanded] = useState(false)
  const [inspectionFilterUrl, setInspectionFilterUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [propertiesLoading, setPropertiesLoading] = useState(false)
  const [savingProperty, setSavingProperty] = useState(false)
  const [loadingPerformance, setLoadingPerformance] = useState(false)
  const [loadingInspections, setLoadingInspections] = useState(false)
  const [inspecting, setInspecting] = useState(false)
  const [coverage, setCoverage] = useState<ApiGscCoverageSummary | null>(null)
  const [loadingCoverage, setLoadingCoverage] = useState(false)
  const [listingSitemaps, setListingSitemaps] = useState(false)
  const [discoveredSitemaps, setDiscoveredSitemaps] = useState<ApiGscSitemap[] | null>(null)
  const [sitemapSummary, setSitemapSummary] = useState<{ total: number; indexes: number; files: number } | null>(null)
  const [preferredSubmissionUrls, setPreferredSubmissionUrls] = useState<string[]>([])
  const [expandedSitemapIndexes, setExpandedSitemapIndexes] = useState<Set<string>>(new Set())
  const [sitemapChildren, setSitemapChildren] = useState<Partial<Record<string, ApiGscSitemap[]>>>({})
  const [loadingSitemapChildren, setLoadingSitemapChildren] = useState<Set<string>>(new Set())
  const [sitemapSearch, setSitemapSearch] = useState('')
  const [sitemapSubmissionProgress, setSitemapSubmissionProgress] = useState<{ completed: number; total: number } | null>(null)
  const [sitemapUrlInput, setSitemapUrlInput] = useState('')
  const [savingSitemap, setSavingSitemap] = useState(false)
  const [submittingSitemaps, setSubmittingSitemaps] = useState(false)
  const [setupExpanded, setSetupExpanded] = useState(false)
  const [coverageHistoryExpanded, setCoverageHistoryExpanded] = useState(false)
  const [coverageTab, setCoverageTab] = useState<'indexed' | 'notIndexed' | 'deindexed'>('indexed')
  const [perfSort, setPerfSort] = useState<{ key: SearchMetric; dir: 'asc' | 'desc' } | null>(null)

  // Expanded mode: when any filter or sort is active, fetch up to EXPANDED_PERFORMANCE_LIMIT
  // rows so client-side sort/filter operates over the full matching set instead of one page.
  const isPerformanceExpanded = Boolean(
    performanceFilters.query.trim() ||
      performanceFilters.page.trim() ||
      perfSort,
  )
  const hasPerfSort = perfSort !== null

  const sortedPerformance = useMemo(() => {
    if (!perfSort) return performance
    const { key, dir } = perfSort
    return [...performance].sort((a, b) => {
      const av = key === SearchMetric.CTR ? (Number.isFinite(a.ctr) ? a.ctr : 0) : a[key]
      const bv = key === SearchMetric.CTR ? (Number.isFinite(b.ctr) ? b.ctr : 0) : b[key]
      return dir === 'asc' ? av - bv : bv - av
    })
  }, [performance, perfSort])
  const performanceTable = useClientTable({
    rows: sortedPerformance,
    pageSize: DEFAULT_TABLE_PAGE_SIZE,
  })
  const displayedPerformanceRows = performanceDisplayedExpanded ? performanceTable.rows : sortedPerformance
  const sitemapTable = useClientTable({
    rows: (discoveredSitemaps ?? []).filter((sitemap) => sitemap.path.toLowerCase().includes(sitemapSearch.trim().toLowerCase())),
    pageSize: DEFAULT_TABLE_PAGE_SIZE,
  })
  const [_coverageHistory, setCoverageHistory] = useState<Array<{ date: string; indexed: number; notIndexed: number; reasonBreakdown: Record<string, number> }>>([])
  const [selectedReason, setSelectedReason] = useState<string | null>(null)
  const [coveragePage, setCoveragePage] = useState<number>(1)
  const coverageHistoryDelta = useMemo(() => {
    if (_coverageHistory.length < 2) return null
    const current = _coverageHistory[_coverageHistory.length - 1]!
    const previous = _coverageHistory[_coverageHistory.length - 2]!
    return { indexed: current.indexed - previous.indexed, notIndexed: current.notIndexed - previous.notIndexed }
  }, [_coverageHistory])

  // Reset to page 1 whenever the active URL list changes (tab switch, drill-down
  // enter/exit, or a fresh coverage sync), so the user doesn't land on a stale
  // (now empty) page after the underlying slice shrinks or shifts.
  useEffect(() => {
    setCoveragePage(1)
  }, [coverage, coverageTab, selectedReason])

  const activeReasonGroup = useMemo(
    () => (selectedReason ? (coverage?.reasonGroups ?? []).find((g) => g.reason === selectedReason) : undefined),
    [coverage, selectedReason],
  )

  // The active paginated URL list — the one being displayed as a URL table.
  // The reason-groups summary view (a small roll-up by reason) is intentionally
  // not paginated; it's a category index, not a URL list.
  const coverageList = useMemo<readonly unknown[]>(() => {
    if (!coverage) return []
    if (coverageTab === 'indexed') return coverage.indexed
    if (coverageTab === 'deindexed') return coverage.deindexed
    if (coverageTab === 'notIndexed') {
      if (selectedReason) return activeReasonGroup?.urls ?? []
      if ((coverage.reasonGroups ?? []).length === 0) return coverage.notIndexed
      return []
    }
    return []
  }, [coverage, coverageTab, selectedReason, activeReasonGroup])

  const coverageTotalPages = Math.max(1, Math.ceil(coverageList.length / COVERAGE_PAGE_SIZE))
  const coverageCurrentPage = Math.min(Math.max(1, coveragePage), coverageTotalPages)
  const coveragePageStart = (coverageCurrentPage - 1) * COVERAGE_PAGE_SIZE

  const pagedIndexed = useMemo(
    () => coverage?.indexed.slice(coveragePageStart, coveragePageStart + COVERAGE_PAGE_SIZE) ?? [],
    [coverage, coveragePageStart],
  )
  const pagedNotIndexedFlat = useMemo(
    () => coverage?.notIndexed.slice(coveragePageStart, coveragePageStart + COVERAGE_PAGE_SIZE) ?? [],
    [coverage, coveragePageStart],
  )
  const pagedDeindexed = useMemo(
    () => coverage?.deindexed.slice(coveragePageStart, coveragePageStart + COVERAGE_PAGE_SIZE) ?? [],
    [coverage, coveragePageStart],
  )
  const pagedReasonUrls = useMemo(
    () => (activeReasonGroup?.urls ?? []).slice(coveragePageStart, coveragePageStart + COVERAGE_PAGE_SIZE),
    [activeReasonGroup, coveragePageStart],
  )
  const [requestingIndexing, setRequestingIndexing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // First-class remediation for the self-hosted "I used my own OAuth client but
  // never enabled the Search Console API" 403 — rendered as a one-click banner
  // instead of a raw error string. Mutually exclusive with `error`.
  const [actionNeeded, setActionNeeded] = useState<GscActionNeeded | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Classify a thrown GSC error: a recognized "Action needed" remediation
  // (enable-API) renders as the amber banner; everything else is a plain inline
  // error. Reading `details` works whether the throw was an ApiError (api.ts
  // wrappers) or the raw envelope the generated SDK throws via fetchQuery.
  function reportGscError(err: unknown, fallback: string) {
    const info = extractApiErrorInfo(err)
    const action = gscActionNeededFromError(info)
    if (action) {
      setActionNeeded(action)
      setError(null)
    } else {
      setActionNeeded(null)
      setError(info.message || fallback)
    }
  }

  const gscConn = connections.find((c) => c.connectionType === 'gsc')
  const canSubmitSitemaps = (gscConn?.scopes ?? []).includes('https://www.googleapis.com/auth/webmasters')
  const primarySitemapSubmissionUrls = preferredSubmissionUrls.length > 0
    ? preferredSubmissionUrls
    : (discoveredSitemaps ?? []).map((sitemap) => sitemap.path)
  const preferredIndexCount = primarySitemapSubmissionUrls.filter((url) =>
    discoveredSitemaps?.some((sitemap) => sitemap.path === url && sitemap.isSitemapsIndex),
  ).length
  const primarySitemapSubmissionLabel = preferredIndexCount === 1
    ? 'Resubmit sitemap index'
    : preferredIndexCount > 1
      ? 'Resubmit sitemap indexes'
      : 'Resubmit all sitemaps'
  const hasHistoricalData = performance.length > 0 || inspections.length > 0 || deindexed.length > 0
  const triggerGscSyncMutation = useTriggerGscSync()
  const triggerInspectSitemapMutation = useTriggerInspectSitemap()

  async function loadProperties(currentConn: ApiGoogleConnection | undefined, force = false) {
    if (!currentConn) {
      setProperties([])
      setSelectedProperty('')
      return
    }

    setPropertiesLoading(true)
    try {
      const { sites } = await queryClient.fetchQuery({
        ...getApiV1ProjectsByNameGooglePropertiesOptions({ client: heyClient, path: { name: projectName } }),
        staleTime: force ? 0 : GSC_STALE_MS,
      })
      setProperties(sites)
      setSelectedProperty(currentConn.propertyId ?? sites[0]?.siteUrl ?? '')
      setActionNeeded(null)
    } catch (err) {
      setProperties([])
      reportGscError(err, 'Failed to load Search Console properties')
    } finally {
      setPropertiesLoading(false)
    }
  }

  async function loadPerformanceRows(offsetOverride?: number) {
    setLoadingPerformance(true)
    const offset = offsetOverride ?? performanceOffset
    try {
      // Expanded mode (filter or sort active) fetches up to EXPANDED_PERFORMANCE_LIMIT
      // so client-side sort/filter sees the full matching set, not just one page.
      // Paged mode fetches pageSize+1 to detect "has more" without a COUNT query.
      // No sentinel row: `totalMatching` answers "is there more" exactly, so
      // fetching PAGE_SIZE + 1 and then rendering PAGE_SIZE made the last row
      // of an exactly-PAGE_SIZE+1 result set unreachable (fetched, counted
      // toward "no more pages", never displayed).
      const fetchLimit = isPerformanceExpanded ? EXPANDED_PERFORMANCE_LIMIT : DEFAULT_TABLE_PAGE_SIZE
      const fetchOffset = isPerformanceExpanded ? 0 : offset
      // URL-string query params per the spec — empty strings stripped so the
      // generated cache key only varies on values the server actually sees.
      const queryParams: Record<string, string> = {
        limit: String(fetchLimit),
      }
      if (performanceFilters.startDate) queryParams.startDate = performanceFilters.startDate
      if (performanceFilters.endDate) queryParams.endDate = performanceFilters.endDate
      if (performanceFilters.query) queryParams.query = performanceFilters.query
      if (performanceFilters.page) queryParams.page = performanceFilters.page
      if (fetchOffset > 0) queryParams.offset = String(fetchOffset)
      if (gscWindow && gscWindow !== 'all' && !performanceFilters.startDate) queryParams.window = gscWindow
      const data = await queryClient.fetchQuery({
        ...getApiV1ProjectsByNameGoogleGscPerformanceOptions({
          client: heyClient,
          path: { name: projectName },
          query: queryParams as never,
        }),
        staleTime: GSC_STALE_MS,
      })
      const rows = data.rows
      if (isPerformanceExpanded) {
        setPerformanceHasMore(false)
        setPerformance(rows)
        setPerformanceTotalLoaded(rows.length)
        setPerformanceDisplayedExpanded(true)
      } else {
        // `totalMatching` is the COUNT over the same WHERE, so "has more" no
        // longer depends on over-fetching a sentinel row.
        setPerformanceHasMore(fetchOffset + rows.length < data.totalMatching)
        setPerformance(rows)
        setPerformanceTotalLoaded(0)
        setPerformanceDisplayedExpanded(false)
      }
    } catch (err) {
      setPerformance([])
      setPerformanceHasMore(false)
      setPerformanceTotalLoaded(0)
      setError(err instanceof Error ? err.message : 'Failed to load GSC performance data')
    } finally {
      setLoadingPerformance(false)
    }
  }

  async function loadPerformanceDaily() {
    try {
      const queryParams: Record<string, string> = {}
      if (performanceFilters.startDate) queryParams.startDate = performanceFilters.startDate
      if (performanceFilters.endDate) queryParams.endDate = performanceFilters.endDate
      if (gscWindow && gscWindow !== 'all' && !performanceFilters.startDate) queryParams.window = gscWindow
      const data = await queryClient.fetchQuery({
        ...getApiV1ProjectsByNameGoogleGscPerformanceDailyOptions({
          client: heyClient,
          path: { name: projectName },
          query: queryParams as never,
        }),
        staleTime: GSC_STALE_MS,
      })
      setPerformanceDaily(data)
    } catch {
      setPerformanceDaily(null)
    }
  }

  async function loadInspectionHistory(force = false) {
    setLoadingInspections(true)
    try {
      const filterUrl = inspectionFilterUrl.trim() || undefined
      const inspectionsQuery: Record<string, string> = { limit: '20' }
      if (filterUrl) inspectionsQuery.url = filterUrl
      const [history, deindexedRows] = await Promise.all([
        queryClient.fetchQuery({
          ...getApiV1ProjectsByNameGoogleGscInspectionsOptions({
            client: heyClient,
            path: { name: projectName },
            query: inspectionsQuery as never,
          }),
          staleTime: force ? 0 : GSC_STALE_MS,
        }),
        queryClient.fetchQuery({
          ...getApiV1ProjectsByNameGoogleGscDeindexedOptions({ client: heyClient, path: { name: projectName } }),
          staleTime: force ? 0 : GSC_STALE_MS,
        }),
      ])
      setInspections(history)
      setDeindexed(deindexedRows)
    } catch (err) {
      setInspections([])
      setDeindexed([])
      setError(err instanceof Error ? err.message : 'Failed to load GSC inspection history')
    } finally {
      setLoadingInspections(false)
    }
  }

  async function loadCoverage(force = false) {
    setLoadingCoverage(true)
    try {
      const [data, history] = await Promise.all([
        queryClient.fetchQuery({
          ...getApiV1ProjectsByNameGoogleGscCoverageOptions({ client: heyClient, path: { name: projectName } }),
          staleTime: force ? 0 : GSC_STALE_MS,
        }),
        queryClient.fetchQuery({
          ...getApiV1ProjectsByNameGoogleGscCoverageHistoryOptions({ client: heyClient, path: { name: projectName } }),
          staleTime: force ? 0 : GSC_STALE_MS,
        }).catch(() => []),
      ])
      setCoverage(data)
      setCoverageHistory(history)
    } catch (err) {
      setCoverage(null)
      setCoverageHistory([])
      setError(err instanceof Error ? err.message : 'Failed to load coverage data')
    } finally {
      setLoadingCoverage(false)
    }
  }

  async function handleRequestIndexing(urls: string[]) {
    setRequestingIndexing(true)
    setError(null)
    try {
      const result = await requestIndexing(projectName, { urls })
      const { succeeded, failed, total } = result.summary
      addToast({
        title: 'Indexing requested',
        detail: failed === 0
          ? `${succeeded} URL${succeeded !== 1 ? 's' : ''} submitted for indexing.`
          : `${succeeded}/${total} submitted successfully, ${failed} failed.`,
        tone: failed === 0 ? 'positive' : 'caution',
        dedupeKey: `gsc:indexing:${projectName}`,
        dedupeMode: 'replace',
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to request indexing')
    } finally {
      setRequestingIndexing(false)
    }
  }

  async function handleRequestIndexingAllUnindexed() {
    setRequestingIndexing(true)
    setError(null)
    try {
      const result = await requestIndexing(projectName, { urls: [], allUnindexed: true })
      const { succeeded, failed, total } = result.summary
      addToast({
        title: 'Indexing requested',
        detail: failed === 0
          ? `${succeeded} unindexed URL${succeeded !== 1 ? 's' : ''} submitted for indexing.`
          : `${succeeded}/${total} submitted successfully, ${failed} failed.`,
        tone: failed === 0 ? 'positive' : 'caution',
        dedupeKey: `gsc:indexing-all:${projectName}`,
        dedupeMode: 'replace',
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to request indexing')
    } finally {
      setRequestingIndexing(false)
    }
  }

  async function handleListSitemaps() {
    setListingSitemaps(true)
    setError(null)
    try {
      const result = await fetchGscSitemaps(projectName)
      queryClient.setQueryData(
        getApiV1ProjectsByNameGoogleGscSitemapsQueryKey({ client: heyClient, path: { name: projectName } }),
        result,
      )
      setDiscoveredSitemaps(result.sitemaps)
      setSitemapSummary(result.summary)
      setPreferredSubmissionUrls(result.preferredSubmissionUrls)
      setExpandedSitemapIndexes(new Set())
      setSitemapChildren({})
      if (result.sitemaps.length === 0) {
        setNotice('No sitemaps found in this GSC property. Submit one here to start Google processing it.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to list sitemaps')
    } finally {
      setListingSitemaps(false)
    }
  }

  async function toggleSitemapIndex(sitemapIndex: string) {
    const isExpanded = expandedSitemapIndexes.has(sitemapIndex)
    setExpandedSitemapIndexes((current) => {
      const next = new Set(current)
      if (isExpanded) next.delete(sitemapIndex)
      else next.add(sitemapIndex)
      return next
    })
    if (isExpanded || sitemapChildren[sitemapIndex]) return
    setLoadingSitemapChildren((current) => new Set(current).add(sitemapIndex))
    try {
      const result = await fetchGscSitemaps(projectName, sitemapIndex)
      setSitemapChildren((current) => ({ ...current, [sitemapIndex]: result.sitemaps }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sitemap files')
    } finally {
      setLoadingSitemapChildren((current) => {
        const next = new Set(current)
        next.delete(sitemapIndex)
        return next
      })
    }
  }

  async function handleSubmitSitemaps(sitemapUrls: string[]) {
    if (!canSubmitSitemaps || sitemapUrls.length === 0) return
    const uniqueUrls = [...new Set(sitemapUrls)]
    setSubmittingSitemaps(true)
    setError(null)
    setSitemapSubmissionProgress({ completed: 0, total: uniqueUrls.length })
    let accepted = 0
    let failed = 0
    let attempted = 0
    let partialFailureMessage: string | null = null
    try {
      for (let start = 0; start < uniqueUrls.length; start += 50) {
        const batch = uniqueUrls.slice(start, start + 50)
        try {
          const result = await submitGscSitemaps(projectName, batch)
          accepted += result.summary.accepted
          failed += result.summary.failed
          attempted += batch.length
          setSitemapSubmissionProgress({ completed: attempted, total: uniqueUrls.length })
        } catch (err) {
          attempted += batch.length
          const unconfirmed = batch.length
          const remaining = uniqueUrls.length - attempted
          const reason = err instanceof Error ? err.message : 'The batch request failed'
          const detail = `${accepted} accepted, ${failed} failed, ${unconfirmed} unconfirmed, ${remaining} not attempted. Google may still process accepted sitemaps; indexing is not guaranteed.`
          partialFailureMessage = `Sitemap submission stopped after a batch request failed. ${detail} ${reason}`
          setError(partialFailureMessage)
          addToast({
            title: 'Sitemap resubmission partially completed',
            detail,
            tone: 'caution',
            dedupeKey: `gsc:sitemap-submit:${projectName}`,
            dedupeMode: 'replace',
          })
          return
        }
      }
      const total = uniqueUrls.length
      addToast({
        title: failed === 0 ? 'Sitemap submitted to Google' : 'Some sitemap submissions need attention',
        detail: failed === 0
          ? 'Google accepted the sitemap submission/refetch request; indexing is not guaranteed.'
          : `Google accepted ${accepted}/${total} sitemap submissions; ${failed} failed. Indexing is not guaranteed.`,
        tone: failed === 0 ? 'positive' : 'caution',
        dedupeKey: `gsc:sitemap-submit:${projectName}`,
        dedupeMode: 'replace',
      })
      setSitemapUrlInput('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit sitemap to Google')
    } finally {
      setSubmittingSitemaps(false)
      setSitemapSubmissionProgress(null)
      await handleListSitemaps()
      if (partialFailureMessage) setError(partialFailureMessage)
    }
  }

  async function handleResubmitAllFiles() {
    setSubmittingSitemaps(true)
    const topLevel = discoveredSitemaps ?? []
    try {
      const indexes = topLevel.filter((sitemap) => sitemap.isSitemapsIndex)
      const expandedIndexUrls: string[] = []
      for (let start = 0; start < indexes.length; start += 4) {
        const batch = await Promise.all(indexes.slice(start, start + 4).map(async (index) => {
          const cachedChildren = sitemapChildren[index.path]
          if (cachedChildren) return cachedChildren
          const result = await fetchGscSitemaps(projectName, index.path)
          setSitemapChildren((current) => ({ ...current, [index.path]: result.sitemaps }))
          return result.sitemaps
        }))
        batch.forEach((children, index) => {
          expandedIndexUrls.push(...(
            children.length > 0
              ? children.map((sitemap) => sitemap.path)
              : [indexes[start + index]!.path]
          ))
        })
      }
      await handleSubmitSitemaps(
        [
          ...topLevel.filter((sitemap) => !sitemap.isSitemapsIndex).map((sitemap) => sitemap.path),
          ...expandedIndexUrls,
        ],
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sitemap files')
      setSubmittingSitemaps(false)
    }
  }

  async function handleSetDefaultSitemap(sitemapUrl: string) {
    setSavingSitemap(true)
    setError(null)
    try {
      await saveSitemapUrl(projectName, 'gsc', sitemapUrl)
      await invalidateProjectQueryDomain(queryClient, 'google')
      setConnections((prev) => prev.map((connection) => (
        connection.connectionType === 'gsc' ? { ...connection, sitemapUrl } : connection
      )))
      addToast({ title: 'Default sitemap updated', detail: sitemapUrl, tone: 'positive', dedupeKey: `gsc:sitemap-default:${projectName}`, dedupeMode: 'replace' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set the default sitemap')
    } finally {
      setSavingSitemap(false)
    }
  }

  async function handleInspectSitemap(sitemapUrl?: string) {
    try {
      await triggerInspectSitemapMutation.mutateAsync({
        projectName,
        projectLabel: projectName,
        opts: sitemapUrl ? { sitemapUrl } : undefined,
      })
    } catch {
      // Mutation hook presents failures and keeps the current table available.
    }
  }

  async function loadSection() {
    setLoading(true)
    setError(null)
    try {
      const [settings, conns] = await Promise.all([
        isAdmin ? fetchSettings().catch(() => null) : Promise.resolve(null),
        queryClient.fetchQuery({
          ...getApiV1ProjectsByNameGoogleConnectionsOptions({ client: heyClient, path: { name: projectName } }),
          staleTime: GSC_STALE_MS,
        }).catch(() => [] as ApiGoogleConnection[]),
      ])
      setGoogleConfigured(Boolean(settings?.google?.configured))
      setConnections(conns)

      const currentConn = conns.find((c) => c.connectionType === 'gsc')
      await Promise.all([
        loadProperties(currentConn),
        loadPerformanceRows(),
        loadPerformanceDaily(),
        loadInspectionHistory(),
        loadCoverage(),
        currentConn?.propertyId ? handleListSitemaps() : Promise.resolve(),
      ])
    } finally {
      setLoading(false)
    }
  }

  // Reloads on mount, on project switch, and when a project-level "Refresh search data"
  // bumps refreshNonce (after it syncs Google data and invalidates the cache).
  useEffect(() => {
    void loadSection()
  }, [projectName, refreshNonce, isAdmin])

  useEffect(() => {
    setPerformanceOffset(0)
    // Clear the drill's DATE FILTERS too, not just the highlight. Dropping only
    // `drillDay` left the request pinned to that one date while the header said
    // 30d, so the table showed a single day under a month's label.
    setDrillDay(null)
    setPerformanceFilters((prev) => (
      prev.startDate || prev.endDate ? { ...prev, startDate: '', endDate: '' } : prev
    ))
    setDrillNonce((n) => n + 1)
    void loadPerformanceDaily()
  }, [gscWindow])

  // Drill into (or out of) a single day. Only the table reloads — the chart
  // keeps the whole window so the selected day stays in context.
  const drillMountRef = useRef(false)
  useEffect(() => {
    if (!drillMountRef.current) {
      drillMountRef.current = true
      return
    }
    setPerformanceOffset(0)
    performanceTable.setPage(1)
    void loadPerformanceRows(0)
  }, [drillNonce])

  function selectDay(date: string) {
    const next = drillDay === date ? null : date
    setDrillDay(next)
    setPerformanceFilters((prev) => ({
      ...prev,
      startDate: next ?? '',
      endDate: next ?? '',
    }))
    setDrillNonce((n) => n + 1)
  }

  // Refetch when sort toggles between "off" and "on" so the fetched row set
  // matches the mode (paged vs expanded). Direction flips within "on" don't
  // refetch — client-side sort handles those over the already-fetched 500.
  const perfSortMountRef = useRef(false)
  useEffect(() => {
    if (!perfSortMountRef.current) {
      perfSortMountRef.current = true
      return
    }
    setPerformanceOffset(0)
    void loadPerformanceRows(0)
  }, [hasPerfSort])

  async function handleConnect() {
    if (!googleConfigured) {
      setError('Google OAuth app credentials are not configured yet. Set them on the Settings page first.')
      return
    }

    setConnecting(true)
    setError(null)
    setNotice(null)
    try {
      const { authUrl, redirectUri } = await googleConnect(projectName, 'gsc')
      if (!authUrl.startsWith('https://accounts.google.com/')) {
        setError('Unexpected OAuth redirect URL. Please try again.')
        return
      }
      const popup = window.open(authUrl, '_blank', 'width=600,height=700')
      if (!popup) {
        window.location.assign(authUrl)
        return
      }
      const callbackOrigin = redirectUri ? new URL(redirectUri).origin : window.location.origin
      let refreshStarted = false
      let timer: number | null = null

      const cleanup = () => {
        if (timer !== null) window.clearInterval(timer)
        window.removeEventListener('message', handleOAuthComplete)
      }
      const refreshConnection = async (completed: boolean) => {
        if (refreshStarted) return
        refreshStarted = true
        cleanup()
        setNotice(completed ? 'Google connected. Refreshing access…' : 'Refreshing Google connection…')
        try {
          await invalidateProjectQueryDomain(queryClient, 'google')
          await loadSection()
        } finally {
          setNotice(null)
        }
      }
      function handleOAuthComplete(event: MessageEvent) {
        if (event.source !== popup || event.origin !== callbackOrigin) return
        if (!event.data || typeof event.data !== 'object') return
        const message = event.data as { type?: unknown; connectionType?: unknown }
        if (message.type !== GOOGLE_OAUTH_COMPLETE_MESSAGE || message.connectionType !== 'gsc') return
        void refreshConnection(true)
      }

      window.addEventListener('message', handleOAuthComplete)
      setNotice('Finish the Google consent flow in the popup. This page will refresh automatically.')
      timer = window.setInterval(() => {
        if (popup.closed) {
          void refreshConnection(false)
        }
      }, 1000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start OAuth flow')
    } finally {
      setConnecting(false)
    }
  }

  async function handleDisconnect() {
    setError(null)
    setNotice(null)
    try {
      await googleDisconnect(projectName, 'gsc')
      await invalidateProjectQueryDomain(queryClient, 'google')
      setConnections((prev) => prev.filter((c) => c.connectionType !== 'gsc'))
      setProperties([])
      setSelectedProperty('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect')
    }
  }

  async function handleSaveProperty() {
    if (!selectedProperty) return
    setSavingProperty(true)
    setError(null)
    try {
      await saveGoogleProperty(projectName, 'gsc', selectedProperty)
      await invalidateProjectQueryDomain(queryClient, 'google')
      setConnections((prev) => prev.map((connection) => (
        connection.connectionType === 'gsc'
          ? { ...connection, propertyId: selectedProperty }
          : connection
      )))
      addToast({
        title: 'GSC property updated',
        detail: `${projectName} is now linked to ${selectedProperty}.`,
        tone: 'positive',
        dedupeKey: `gsc:property:${projectName}`,
        dedupeMode: 'drop',
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save GSC property')
    } finally {
      setSavingProperty(false)
    }
  }

  async function handleSync() {
    setError(null)
    setNotice(null)
    try {
      await triggerGscSyncMutation.mutateAsync({
        projectName,
        projectLabel: projectName,
        opts: {
          days: parseInt(syncDays, 10) || undefined,
          full: fullSync || undefined,
        },
      })
      await invalidateProjectQueryDomain(queryClient, 'gsc')
    } catch {
      // Mutation hook handles the toast-only failure path for queued syncs.
    }
  }

  async function handleInspect() {
    if (!inspectionUrl.trim()) return
    setInspecting(true)
    setError(null)
    setNotice(null)
    try {
      const result = await inspectGscUrl(projectName, inspectionUrl.trim())
      await invalidateProjectQueryDomain(queryClient, 'gsc')
      setInspectionResult(result)
      setInspectionUrl('')
      await loadInspectionHistory()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to inspect URL')
    } finally {
      setInspecting(false)
    }
  }

  return (
    <section className="page-section-divider">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Search Console</p>
          <h2>Google Search Console</h2>
        </div>
      </div>

      {actionNeeded && (
        <div className="mb-3 rounded-lg border border-caution-800/40 bg-caution-950/20 px-3 py-2.5 text-sm text-caution-200">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-medium text-caution-100">{actionNeeded.title}</p>
              <p className="mt-0.5 text-caution-200/90">{actionNeeded.message}</p>
              {(safeExternalUrl(actionNeeded.enableUrl) || safeExternalUrl(actionNeeded.indexingApiUrl)) && (
                <div className="mt-2 flex flex-wrap gap-3">
                  {safeExternalUrl(actionNeeded.enableUrl) && (
                    <a
                      href={safeExternalUrl(actionNeeded.enableUrl)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-caution-100 underline decoration-caution-500/50 underline-offset-2 hover:text-caution-50"
                    >
                      {'Enable Search Console API ↗'}
                    </a>
                  )}
                  {safeExternalUrl(actionNeeded.indexingApiUrl) && (
                    <a
                      href={safeExternalUrl(actionNeeded.indexingApiUrl)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-caution-100 underline decoration-caution-500/50 underline-offset-2 hover:text-caution-50"
                    >
                      {'Enable Indexing API ↗'}
                    </a>
                  )}
                </div>
              )}
            </div>
            <button type="button" className="text-caution-400 hover:text-caution-200" onClick={() => setActionNeeded(null)}>×</button>
          </div>
        </div>
      )}
      {error && (
        <div className="mb-3 rounded-lg border border-negative-800/40 bg-negative-950/20 px-3 py-2 text-sm text-negative">
          {error}
          <button type="button" className="ml-2 text-negative-400 hover:text-negative-200" onClick={() => setError(null)}>×</button>
        </div>
      )}
      {notice && (
        <div className="mb-3 rounded-lg border border-positive-800/40 bg-positive-950/20 px-3 py-2 text-sm text-positive">
          {notice}
          <button type="button" className="ml-2 text-positive-400 hover:text-positive-200" onClick={() => setNotice(null)}>×</button>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted">{'Loading\u2026'}</p>
      ) : (
        <div className="space-y-3">
          {gscConn ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-muted">
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-positive-500" />
                <span className="text-neutral">Authorized</span>
              </span>
              <span className="text-mono-700">·</span>
              <code className="text-secondary">{gscConn.domain}</code>
              <span className="text-mono-700">·</span>
              {/*
                * Freshness must describe the DATA, not the credential.
                *
                * This read `gscConn.updatedAt`, which is when the OAuth
                * connection row was last written — i.e. when the access token
                * was last refreshed. A sync that inspected every URL left it
                * untouched (the token was still valid), while an idle hour that
                * happened to rotate the token moved it. A user pressed refresh,
                * watched the sync succeed, and saw "Last updated" stay pinned to
                * the token's rotation time.
                *
                * `lastInspectedAt` is the newest `inspectedAt` across stored
                * inspections — the moment a URL was genuinely last measured.
                */}
              <span>
                Coverage measured{' '}
                {coverage?.lastInspectedAt ? formatTimestamp(coverage.lastInspectedAt) : 'never'}
              </span>
              <button
                type="button"
                className="ml-auto text-muted transition-colors hover:text-negative-400"
                onClick={asyncHandler(handleDisconnect)}
              >
                Disconnect
              </button>
            </div>
          ) : !isAdmin ? (
            <Card className="surface-card"><p className="text-sm text-secondary">{GSC_MANAGED_EMPTY_COPY}</p></Card>
          ) : (
            <Card className="surface-card">
              <div className="section-head section-head-inline">
                <div>
                  <p className="eyebrow eyebrow-soft">Connection</p>
                  <h3>Domain authorization</h3>
                </div>
                <ToneBadge tone={googleConfigured ? 'caution' : 'negative'}>
                  {googleConfigured ? 'Ready to connect' : 'App credentials missing'}
                </ToneBadge>
              </div>
              <div className="mt-3 rounded-lg border border-default bg-surface px-4 py-5">
                <p className="text-sm text-neutral">
                  {googleConfigured
                    ? 'Generate a Google OAuth link for this project and have the client sign in with a Google account that already has access to the correct Search Console property.'
                    : 'Set Google OAuth client credentials first. Once configured, you can generate a consent link for this project domain.'}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {googleConfigured ? (
                    <Button type="button" variant="outline" size="sm" disabled={connecting} onClick={asyncHandler(handleConnect)}>
                      {connecting ? 'Opening\u2026' : 'Connect Google Search Console'}
                    </Button>
                  ) : (
                    <Button type="button" variant="outline" size="sm" asChild>
                      <Link to="/settings">Open Settings</Link>
                    </Button>
                  )}
                  {!googleConfigured && (
                    <p className="text-xs text-muted">The same Google OAuth app credentials are shared across all projects.</p>
                  )}
                </div>
              </div>
            </Card>
          )}

          {/* ── DATA SECTIONS (shown first for connected projects) ── */}

          {(gscConn || hasHistoricalData) && (
           <div className="space-y-3">
              {/* Performance summary + charts */}
              <Card className="surface-card">
                <div className="section-head section-head-inline">
                  <div>
                    <p className="eyebrow eyebrow-soft">Performance</p>
                    <div className="flex items-center gap-1.5">
                      <h3>Search performance</h3>
                      <InfoTooltip text={`${gscComparisonBasisText(performanceDaily?.periodComparison)} The optional trend line shows the fitted direction. Click any day to filter the table below to that date. Query and page filters match case-insensitive substrings and run on Apply filters. Filtering and sorting examine up to ${EXPANDED_PERFORMANCE_LIMIT.toLocaleString()} matching rows while the table shows ${DEFAULT_TABLE_PAGE_SIZE} per page.`} />
                    </div>
                    {/* The window ends where Google's data ends, not today.
                        Naming the real range is what stops a lagging tail
                        reading as a drop, and lets this be compared against
                        the Search Console UI, which anchors the same way. */}
                    {/* Optional at RUNTIME even though the DTO requires it: a
                        cached response from a server older than this field
                        must degrade to no label, never take the section down. */}
                    {performanceDaily?.window?.startDate && performanceDaily.window.endDate && (
                      <p className="text-xs text-muted">
                        {performanceDaily.window.startDate} to {performanceDaily.window.endDate}
                        {/* "data through X", never "Google is N days behind":
                            a zero-traffic day returns no row, so a quiet tail
                            is indistinguishable from an unpublished one. */}
                        {(performanceDaily.window.daysSinceLatestData ?? 0) > 0
                          && ` · latest data ${performanceDaily.window.daysSinceLatestData} day${performanceDaily.window.daysSinceLatestData === 1 ? '' : 's'} ago`}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <MetricsWindowPicker
                      windows={GSC_WINDOWS}
                      value={gscWindow}
                      onChange={(next) => {
                        setGscWindow(next)
                        setPerformanceOffset(0)
                        performanceTable.setPage(1)
                      }}
                      label="Search Console time period"
                      formatOption={(w) => (w === 'all' ? 'All' : w)}
                    />
                    <Button type="button" variant="outline" size="sm" disabled={loadingPerformance} onClick={() => { setPerformanceOffset(0); performanceTable.setPage(1); void loadPerformanceRows(0); void loadPerformanceDaily() }}>
                      {loadingPerformance ? 'Loading\u2026' : 'Apply filters'}
                    </Button>
                  </div>
                </div>

                {/* Search-performance chart — one axis PER METRIC (Search
                    Console's own shape), driven by the daily aggregate endpoint
                    so it reflects the whole window, not the current page. The
                    dashed fits come from the API; nothing is regressed here. */}
                {performanceDaily && performanceDaily.daily.length > 0 && (() => {
                  // `trends` is optional at RUNTIME: a server older than the
                  // field omits it, and the chart must degrade to plain lines
                  // rather than crash. Same skew guard as `window`.
                  const { totals, daily, trends, periodComparison } = performanceDaily
                  const selected = GSC_CHART_METRICS.filter((m) => chartMetrics.includes(m.key))
                  const series: TrendChartSeries[] = selected.map((m) => ({
                    dataKey: m.key,
                    label: m.label,
                    color: m.color,
                    axisId: m.key,
                    inverted: m.inverted,
                    formatValue: m.format,
                    trend: showTrend ? trends?.[m.key] ?? null : null,
                  }))
                  // `undefined` when the server predates the field; a missing
                  // metric is the same "not measured" as an explicit null, and
                  // must never reach a formatter.
                  const totalFor = (key: GscChartMetric): number | null => totals[key] ?? null

                  // Plot one row per CALENDAR DAY, not per returned row.
                  // `daily` holds only dates that produced data, but the server
                  // fits over the calendar, so its `startIndex`/`endIndex` only
                  // line up with a calendar-dense series — against row
                  // positions the trend line traversed a fraction of its range
                  // and ended on the wrong value. It is also the honest x-axis:
                  // a six-day quiet stretch should look like six days.
                  const byDate = new Map(daily.map((d) => [d.date, d]))
                  const chartRows = daily.length === 0
                    ? []
                    : calendarDateRange(daily[0]!.date, daily[daily.length - 1]!.date)
                      .map((date) => byDate.get(date) ?? { date })

                  return (
                    <div className="mt-3">
                      {/* Tiles are the metric selector, as in Search Console:
                          pressing one adds or removes its line. The last
                          selected tile cannot be turned off — an empty chart
                          is a dead end, not a state worth reaching. */}
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {GSC_CHART_METRICS.map((m) => {
                          const on = chartMetrics.includes(m.key)
                          const value = totalFor(m.key)
                          const unavailable = value === null
                          return (
                            <button
                              key={m.key}
                              type="button"
                              aria-pressed={on}
                              disabled={unavailable}
                              className={`rounded-md border px-3 py-2 text-left transition-colors ${
                                on ? 'border-strong bg-surface-active' : 'border-subtle bg-surface-subtle hover:bg-surface-hover'
                              } ${unavailable ? 'cursor-not-allowed opacity-50' : ''}`}
                              onClick={() => {
                                setChartMetrics((current) => current.includes(m.key)
                                  ? (current.length === 1 ? current : current.filter((k) => k !== m.key))
                                  : [...current, m.key])
                              }}
                            >
                              <span className="flex items-center gap-1.5">
                                <span
                                  className="inline-block h-2 w-2 rounded-full"
                                  style={{ backgroundColor: on ? m.color : 'transparent', border: `1px solid ${m.color}` }}
                                />
                                <span className="text-xs text-secondary">{m.label}</span>
                              </span>
                              <span className="mt-0.5 block text-lg tabular-nums text-strong">
                                {value === null ? '—' : m.format(value)}
                              </span>
                              <span className="block text-[11px] tabular-nums text-muted">
                                {/* Position improves downward, so the arrow
                                    tracks BETTER/WORSE, not up/down. */}
                                {formatGscPeriodChange(periodComparison, m.key, m.inverted)}
                              </span>
                            </button>
                          )
                        })}
                      </div>

                      <div className="mt-2 flex items-center justify-end">
                        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-secondary">
                          <input
                            type="checkbox"
                            className="accent-mono-400"
                            checked={showTrend}
                            onChange={(e) => setShowTrend(e.target.checked)}
                          />
                          Trend line
                        </label>
                      </div>

                      <div className="mt-1">
                        <MultiAxisTrendChart
                          data={chartRows}
                          xKey="date"
                          series={series}
                          xTickFormatter={formatChartDateTick}
                          labelFormatter={formatChartDateLabel}
                          onSelectX={selectDay}
                          selectedX={drillDay}
                        />
                      </div>

                      {/* Keyboard + screen-reader path to the same drill-in the
                          chart offers on click. Recharts owns the SVG and gives
                          no focusable day, so the accessible control is a real
                          button per day: reachable by Tab, visible on focus. */}
                      <div role="group" aria-label="Filter the table to a single day">
                        {daily.map((d) => (
                          <button
                            key={d.date}
                            type="button"
                            className="sr-only focus:not-sr-only focus:inline-block focus:rounded focus:border focus:border-strong focus:bg-surface-active focus:px-2 focus:py-1 focus:text-xs focus:text-strong"
                            aria-pressed={drillDay === d.date}
                            onClick={() => selectDay(d.date)}
                          >
                            {formatChartDateLabel(d.date)}: {d.clicks} clicks, {d.impressions} impressions
                          </button>
                        ))}
                      </div>

                      {drillDay && (
                        <div className="mt-1 flex items-center gap-2 text-xs">
                          <span className="text-secondary">
                            Table showing {formatChartDateLabel(drillDay)}
                          </span>
                          <button
                            type="button"
                            className="text-link hover:underline"
                            onClick={() => selectDay(drillDay)}
                          >
                            Show all {totals.days} days
                          </button>
                        </div>
                      )}

                      {totals.position !== null
                        && (totals.positionDays ?? totals.days) < totals.days && (
                        <p className="mt-1 text-[11px] text-muted">
                          Average position covers {totals.positionDays} of {totals.days} days. The
                          rest have no property-level position recorded.
                        </p>
                      )}

                      {(totals.position === null || totals.position === undefined) && (
                        <p className="mt-1 text-[11px] text-muted">
                          Average position needs a property-level sync. Run <code>canonry google sync</code> to record it.
                        </p>
                      )}
                    </div>
                  )
                })()}

                <div className="mt-3 grid gap-2 lg:grid-cols-4">
                  <input
                    className="rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                    type="date"
                    aria-label="Start date"
                    title="Start date (inclusive). Leave blank to use the window above."
                    value={performanceFilters.startDate}
                    onChange={(e) => setPerformanceFilters((prev) => ({ ...prev, startDate: e.target.value }))}
                  />
                  <input
                    className="rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                    type="date"
                    aria-label="End date"
                    title="End date (inclusive)."
                    value={performanceFilters.endDate}
                    onChange={(e) => setPerformanceFilters((prev) => ({ ...prev, endDate: e.target.value }))}
                  />
                  <DataTableSearch
                    value={performanceFilters.query}
                    onChange={(value) => setPerformanceFilters((prev) => ({ ...prev, query: value }))}
                    label="Filter search queries"
                    placeholder="Contains query…"
                  />
                  <DataTableSearch
                    value={performanceFilters.page}
                    onChange={(value) => setPerformanceFilters((prev) => ({ ...prev, page: value }))}
                    label="Filter page URLs"
                    placeholder="Contains page URL…"
                  />
                </div>
                {performance.length > 0 ? (
                  <>
                    <div className="mt-3 overflow-x-auto">
                      <table className="data-table w-full text-sm">
                        <thead>
                          <tr>
                            <th className="text-left">Date</th>
                            <th className="text-left">Query</th>
                            <th className="text-left">Page</th>
                            {Object.values(SearchMetric).map((col) => (
                              <th
                                key={col}
                                className="text-right"
                                aria-sort={perfSort?.key === col ? (perfSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                              >
                                <button
                                  type="button"
                                  className="w-full cursor-pointer select-none text-right hover:text-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-mono-400 rounded px-1 -mx-1"
                                  onClick={() => {
                                    performanceTable.setPage(1)
                                    setPerfSort((prev) =>
                                      prev?.key === col
                                        ? prev.dir === 'desc'
                                          ? { key: col, dir: 'asc' }
                                          : null
                                        : { key: col, dir: 'desc' },
                                    )
                                  }}
                                >
                                  {SEARCH_METRIC_LABELS[col]}
                                  {perfSort?.key === col ? (perfSort.dir === 'desc' ? ' \u2193' : ' \u2191') : ''}
                                </button>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {displayedPerformanceRows.map((row, i) => (
                            <tr key={`${row.date}:${row.query}:${row.page}:${i}`}>
                              <td className="text-secondary">{row.date}</td>
                              <td className="max-w-xs truncate text-strong">{row.query}</td>
                              <td className="max-w-xs text-secondary">
                                <MiddleTruncatedText value={row.page} />
                              </td>
                              <td className="text-right tabular-nums text-neutral">{row.clicks.toLocaleString()}</td>
                              <td className="text-right tabular-nums text-secondary">{row.impressions.toLocaleString()}</td>
                              <td className="text-right tabular-nums text-secondary">{(Number.isFinite(row.ctr) ? row.ctr * 100 : 0).toFixed(1)}%</td>
                              <td className="text-right tabular-nums text-secondary">{row.position.toFixed(1)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <DataTablePagination
                      page={performanceDisplayedExpanded
                        ? performanceTable.page
                        : Math.floor(performanceOffset / DEFAULT_TABLE_PAGE_SIZE) + 1}
                      pageSize={DEFAULT_TABLE_PAGE_SIZE}
                      visibleRows={displayedPerformanceRows.length}
                      totalRows={performanceDisplayedExpanded ? performanceTotalLoaded : undefined}
                      hasNextPage={performanceDisplayedExpanded ? undefined : performanceHasMore}
                      disabled={loadingPerformance}
                      itemLabel={performanceDisplayedExpanded ? 'matches' : 'rows'}
                      onPageChange={(nextPage) => {
                        if (performanceDisplayedExpanded) {
                          performanceTable.setPage(nextPage)
                          return
                        }
                        const nextOffset = (nextPage - 1) * DEFAULT_TABLE_PAGE_SIZE
                        setPerformanceOffset(nextOffset)
                        void loadPerformanceRows(nextOffset)
                      }}
                    />
                    {performanceDisplayedExpanded && performanceTotalLoaded >= EXPANDED_PERFORMANCE_LIMIT ? (
                      <p className="mt-2 text-xs text-muted">
                        Results are capped at {EXPANDED_PERFORMANCE_LIMIT.toLocaleString()}; narrow the filters to search beyond this set.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="mt-3 text-sm text-muted">No performance rows match the current filters yet.</p>
                )}
              </Card>

             <Card className="surface-card">
                <div className="section-head section-head-inline">
                  <div>
                    <p className="eyebrow eyebrow-soft">Coverage</p>
                    <div className="flex items-center gap-1.5">
                      <h3>Index coverage</h3>
                      <InfoTooltip text="Google's Indexing API is intended for eligible JobPosting and BroadcastEvent pages. Sitemap resubmission is the general-site bulk path." />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {coverage && coverage.notIndexed.length > 0 && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={requestingIndexing}
                        onClick={() => void handleRequestIndexingAllUnindexed()}
                      >
                        {requestingIndexing ? 'Requesting\u2026' : `Request indexing (${coverage.notIndexed.length})`}
                      </Button>
                    )}
                    <Button type="button" variant="outline" size="sm" disabled={loadingCoverage} onClick={() => void loadCoverage(true)}>
                      {loadingCoverage ? 'Loading\u2026' : 'Reload saved coverage'}
                    </Button>
                  </div>
                </div>

                {coverage && coverage.summary.total > 0 ? (
                  <>
                    {/* Hero donut — centered, front and center */}
                    <div className="mt-6 flex flex-col items-center">
                      {(() => {
                        const total = coverage.summary.indexed + coverage.summary.notIndexed
                        const pct = total > 0 ? coverage.summary.indexed / total : 0
                        const notPct = total > 0 ? coverage.summary.notIndexed / total : 0
                        const r = 54
                        const circ = 2 * Math.PI * r
                        const indexedOffset = circ * (1 - pct)
                        const notIndexedArc = circ * notPct
                        const notIndexedStart = circ * pct
                        return (
                          <>
                            <div className="relative h-48 w-48">
                              <svg viewBox="0 0 128 128" className="h-full w-full" aria-hidden="true">
                                {/* Background track */}
                                <circle cx="64" cy="64" r={r} fill="none" stroke={CHART_NEUTRAL.trackSubtle} strokeWidth="14" />
                                {/* Indexed arc — emerald */}
                                <circle
                                  cx="64" cy="64" r={r} fill="none"
                                  stroke={CHART_TONE.positiveDeep} strokeWidth="14"
                                  strokeDasharray={circ} strokeDashoffset={indexedOffset}
                                  strokeLinecap="round"
                                  transform="rotate(-90 64 64)"
                                  style={{ transition: 'stroke-dashoffset 0.6s ease' }}
                                />
                                {/* Not-indexed arc — zinc */}
                                {coverage.summary.notIndexed > 0 && (
                                  <circle
                                    cx="64" cy="64" r={r} fill="none"
                                    stroke={CHART_NEUTRAL.textFaint} strokeWidth="14"
                                    strokeDasharray={`${notIndexedArc} ${circ - notIndexedArc}`}
                                    strokeDashoffset={-notIndexedStart}
                                    transform="rotate(-90 64 64)"
                                    style={{ transition: 'stroke-dasharray 0.6s ease, stroke-dashoffset 0.6s ease' }}
                                  />
                                )}
                              </svg>
                              <div className="absolute inset-0 flex flex-col items-center justify-center">
                                <span className="text-3xl font-bold tabular-nums text-primary">{(pct * 100).toFixed(0)}%</span>
                                <span className="text-xs uppercase tracking-widest text-muted mt-0.5">Indexed</span>
                              </div>
                            </div>

                            {/* Counts row beneath donut */}
                            <div className="mt-4 flex items-center justify-center gap-8">
                              <div className="flex items-center gap-2">
                                <span className="inline-block h-2.5 w-2.5 rounded-full bg-positive-500" />
                                <div>
                                  <p className="text-2xl font-semibold tabular-nums text-primary">{coverage.summary.indexed.toLocaleString()}</p>
                                  <p className="text-[11px] uppercase tracking-wide text-muted">Indexed</p>
                                </div>
                              </div>
                              <div className="h-8 w-px bg-mono-800" />
                              <div className="flex items-center gap-2">
                                <span className="inline-block h-2.5 w-2.5 rounded-full bg-mono-500" />
                                <div>
                                  <p className="text-2xl font-semibold tabular-nums text-primary">{coverage.summary.notIndexed.toLocaleString()}</p>
                                  <p className="text-[11px] uppercase tracking-wide text-muted">
                                    Not indexed
                                    {(coverage.reasonGroups ?? []).length > 0 && (
                                      <span className="ml-1 text-faint">
                                        · {(coverage.reasonGroups ?? []).length} {(coverage.reasonGroups ?? []).length === 1 ? 'reason' : 'reasons'}
                                      </span>
                                    )}
                                  </p>
                                </div>
                              </div>
                              {coverage.summary.deindexed > 0 && (
                                <>
                                  <div className="h-8 w-px bg-mono-800" />
                                  <div className="flex items-center gap-2">
                                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-negative-500" />
                                    <div>
                                      <p className="text-2xl font-semibold tabular-nums text-primary">{coverage.summary.deindexed.toLocaleString()}</p>
                                      <p className="text-[11px] uppercase tracking-wide text-muted">Deindexed</p>
                                    </div>
                                  </div>
                                </>
                              )}
                            </div>
                          </>
                        )
                      })()}
                    </div>


                    <div className="mt-3 flex border-b border-default" role="tablist" aria-label="Coverage status">
                      {(['indexed', 'notIndexed', 'deindexed'] as const).map((tab) => {
                        const count = tab === 'indexed' ? coverage.indexed.length
                          : tab === 'notIndexed' ? coverage.notIndexed.length
                          : coverage.deindexed.length
                        const label = tab === 'indexed' ? 'Indexed' : tab === 'notIndexed' ? 'Not Indexed' : 'Deindexed'
                        return (
                          <button
                            key={tab}
                            type="button"
                            role="tab"
                            aria-selected={coverageTab === tab}
                            className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                              coverageTab === tab
                                ? 'border-accent text-heading'
                                : 'border-transparent text-secondary hover:border-mono-600 hover:text-strong'
                            }`}
                            onClick={() => { setCoverageTab(tab); setSelectedReason(null) }}
                          >
                            {label} ({count})
                          </button>
                        )
                      })}
                    </div>

                    <div className="mt-3 overflow-x-auto">
                      {/* Indexed URL table */}
                      {coverageTab === 'indexed' && coverage.indexed.length > 0 && (
                        <table className="data-table w-full text-sm">
                          <thead>
                            <tr>
                              <th className="text-left">URL</th>
                              <th className="text-left">Verdict</th>
                              <th className="text-left">Last Crawl</th>
                              <th className="text-left">Mobile</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pagedIndexed.map((row) => (
                              <tr key={row.id}>
                                <td className="max-w-sm truncate text-strong">{row.url}</td>
                                <td className="text-secondary">{row.verdict ?? 'Unknown'}</td>
                                <td className="text-secondary">{row.crawlTime ? row.crawlTime.split('T')[0] : '\u2014'}</td>
                                <td className="text-secondary">{row.isMobileFriendly === true ? 'Yes' : row.isMobileFriendly === false ? 'No' : '\u2014'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}

                      {/* Not Indexed — reason groups + detail drill-down */}
                      {coverageTab === 'notIndexed' && !selectedReason && (coverage.reasonGroups ?? []).length > 0 && (
                        <table className="data-table w-full text-sm">
                          <thead>
                            <tr>
                              <th className="text-left">Reason</th>
                              <th className="text-right">Pages</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(coverage.reasonGroups ?? []).map((group) => (
                              <tr
                                key={group.reason}
                                className="cursor-pointer hover:bg-surface-inset-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
                                onClick={() => setSelectedReason(group.reason)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault()
                                    setSelectedReason(group.reason)
                                  }
                                }}
                                tabIndex={0}
                                role="button"
                                aria-label={`View ${group.reason} pages`}
                              >
                                <td className="text-strong">{group.reason}</td>
                                <td className="text-right tabular-nums text-secondary">{group.count}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}

                      {/* Not Indexed — no reason groups, show flat list */}
                      {coverageTab === 'notIndexed' && !selectedReason && (coverage.reasonGroups ?? []).length === 0 && coverage.notIndexed.length > 0 && (
                        <table className="data-table w-full text-sm">
                          <thead>
                            <tr>
                              <th className="text-left">URL</th>
                              <th className="text-left">Indexing State</th>
                              <th className="text-left">Coverage</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pagedNotIndexedFlat.map((row) => (
                              <tr key={row.id}>
                                <td className="max-w-sm truncate text-strong">{row.url}</td>
                                <td className="text-secondary">{row.indexingState ?? 'Unknown'}</td>
                                <td className="text-secondary">{row.coverageState ?? 'Unknown'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}

                      {/* Reason detail view — drill-down for a specific reason */}
                      {coverageTab === 'notIndexed' && selectedReason && (() => {
                        const group = (coverage.reasonGroups ?? []).find((g) => g.reason === selectedReason)
                        if (!group) return null
                        return (
                          <div>
                            <div className="flex items-center gap-2 mb-3">
                              <button
                                type="button"
                                className="text-xs text-secondary hover:text-strong transition-colors"
                                onClick={() => setSelectedReason(null)}
                              >
                                {'\u2190'} Back to reasons
                              </button>
                            </div>
                            <div className="mb-3 flex items-center justify-between rounded-lg border border-default bg-surface-subtle p-3">
                              <div>
                                <p className="text-sm font-medium text-strong">{group.reason}</p>
                                <p className="mt-1 text-xs text-muted">{group.count} affected page{group.count !== 1 ? 's' : ''}</p>
                              </div>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={requestingIndexing}
                                onClick={() => void handleRequestIndexing(group.urls.map((u) => u.url))}
                              >
                                {requestingIndexing ? 'Requesting\u2026' : `Request indexing (${group.count})`}
                              </Button>
                            </div>

                            <table className="data-table w-full text-sm">
                              <thead>
                                <tr>
                                  <th className="text-left">URL</th>
                                  <th className="text-left">Last Crawl</th>
                                  <th className="w-8"></th>
                                </tr>
                              </thead>
                              <tbody>
                                {pagedReasonUrls.map((row) => (
                                  <tr key={row.id}>
                                    <td className="max-w-sm truncate text-strong">{row.url}</td>
                                    <td className="text-secondary">{row.crawlTime ? row.crawlTime.split('T')[0] : '\u2014'}</td>
                                    <td>
                                      <button
                                        type="button"
                                        className="text-xs text-muted hover:text-strong transition-colors"
                                        disabled={requestingIndexing}
                                        onClick={() => void handleRequestIndexing([row.url])}
                                        title="Request indexing"
                                      >
                                        Index
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )
                      })()}

                      {/* Deindexed table */}
                      {coverageTab === 'deindexed' && coverage.deindexed.length > 0 && (
                        <table className="data-table w-full text-sm">
                          <thead>
                            <tr>
                              <th className="text-left">URL</th>
                              <th className="text-left">Previous</th>
                              <th className="text-left">Current</th>
                              <th className="text-left">Detected</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pagedDeindexed.map((row, i) => (
                              <tr key={`${row.url}-${i}`}>
                                <td className="max-w-sm truncate text-strong">{row.url}</td>
                                <td className="text-secondary">{row.previousState}</td>
                                <td className="text-secondary">{row.currentState}</td>
                                <td className="text-secondary">{row.transitionDate.split('T')[0]}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {((coverageTab === 'indexed' && coverage.indexed.length === 0) ||
                        (coverageTab === 'notIndexed' && !selectedReason && coverage.notIndexed.length === 0) ||
                        (coverageTab === 'deindexed' && coverage.deindexed.length === 0)) && (
                        <p className="text-sm text-muted">No URLs in this category.</p>
                      )}

                      <DataTablePagination
                        page={coverageCurrentPage}
                        pageSize={COVERAGE_PAGE_SIZE}
                        visibleRows={Math.min(COVERAGE_PAGE_SIZE, coverageList.length - coveragePageStart)}
                        totalRows={coverageList.length}
                        onPageChange={setCoveragePage}
                        itemLabel="URLs"
                      />
                    </div>

                    <div className="mt-4 border-t border-default pt-3">
                      <button
                        type="button"
                        className="flex w-full items-center justify-between text-left text-xs text-secondary hover:text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400"
                        aria-expanded={coverageHistoryExpanded}
                        onClick={() => setCoverageHistoryExpanded((value) => !value)}
                      >
                        <span>Coverage history</span>
                        <span>{coverageHistoryExpanded ? 'Hide snapshots' : _coverageHistory.length > 0 ? `View ${_coverageHistory.length} snapshots` : 'View history'}</span>
                      </button>
                      <p className="mt-1 text-xs text-muted">Current: {coverage.summary.indexed.toLocaleString()} indexed, {coverage.summary.notIndexed.toLocaleString()} not indexed.{coverageHistoryDelta && <> Since the last snapshot: {coverageHistoryDelta.indexed >= 0 ? '+' : ''}{coverageHistoryDelta.indexed.toLocaleString()} indexed, {coverageHistoryDelta.notIndexed >= 0 ? '+' : ''}{coverageHistoryDelta.notIndexed.toLocaleString()} not indexed.</>}</p>
                      {coverageHistoryExpanded && (
                        <div className="mt-3 overflow-x-auto">
                          {_coverageHistory.length > 0 ? (
                            <table className="data-table w-full text-sm">
                              <thead><tr><th className="text-left">Date</th><th className="text-right">Indexed</th><th className="text-right">Not indexed</th></tr></thead>
                              <tbody>{_coverageHistory.map((snapshot) => <tr key={snapshot.date}><td className="text-secondary">{snapshot.date}</td><td className="text-right tabular-nums text-neutral">{snapshot.indexed.toLocaleString()}</td><td className="text-right tabular-nums text-secondary">{snapshot.notIndexed.toLocaleString()}</td></tr>)}</tbody>
                            </table>
                          ) : <p className="text-sm text-muted">No saved coverage snapshots yet.</p>}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="mt-3 text-sm text-muted">
                    {loadingCoverage ? 'Loading coverage data\u2026' : 'No coverage data yet. Inspect your sitemap to populate this view.'}
                  </p>
                )}
              </Card>

              <Card className="surface-card">
                <div className="section-head section-head-inline">
                  <div>
                    <p className="eyebrow eyebrow-soft">Sitemaps</p>
                    <div className="flex items-center gap-1.5">
                      <h3>Sitemap operations</h3>
                      <InfoTooltip text="Submitting asks Google to refetch these sitemaps. Indexing is not guaranteed." />
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={listingSitemaps || !gscConn?.propertyId}
                    onClick={() => void handleListSitemaps()}
                  >
                    {listingSitemaps ? 'Reloading\u2026' : 'Reload from Google'}
                  </Button>
                </div>
                <div className="mt-3 flex flex-col gap-2 lg:flex-row">
                  <input
                    className="flex-1 rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                    type="url"
                    placeholder="https://example.com/sitemap.xml"
                    value={sitemapUrlInput}
                    onChange={(event) => setSitemapUrlInput(event.target.value)}
                    onKeyDown={(event) => event.key === 'Enter' && void handleSubmitSitemaps([sitemapUrlInput.trim()])}
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={!canSubmitSitemaps || submittingSitemaps || !sitemapUrlInput.trim()}
                    onClick={() => void handleSubmitSitemaps([sitemapUrlInput.trim()])}
                  >
                    {submittingSitemaps ? 'Submitting\u2026' : 'Submit sitemap to Google'}
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!canSubmitSitemaps || submittingSitemaps || primarySitemapSubmissionUrls.length === 0}
                    onClick={() => void handleSubmitSitemaps(primarySitemapSubmissionUrls)}
                  >
                    {submittingSitemaps ? 'Resubmitting\u2026' : primarySitemapSubmissionLabel}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!canSubmitSitemaps || submittingSitemaps || !discoveredSitemaps?.length}
                    onClick={() => void handleResubmitAllFiles()}
                  >
                    Resubmit all files
                  </Button>
                  {sitemapSummary && (
                    <span className="text-xs text-muted">
                      Top level: {sitemapSummary.indexes} index{sitemapSummary.indexes === 1 ? '' : 'es'}, {sitemapSummary.files} file{sitemapSummary.files === 1 ? '' : 's'}
                    </span>
                  )}
                  {sitemapSubmissionProgress && <span className="text-xs text-secondary">Submitting {sitemapSubmissionProgress.completed}/{sitemapSubmissionProgress.total}</span>}
                </div>
                {!canSubmitSitemaps && gscConn && (
                  <div className="mt-2 flex items-center gap-2 text-xs text-caution">
                    <span>Reconnect to let Canonry submit sitemaps. Your current Canonry OAuth grant is read-only.</span>
                    <button type="button" className="text-secondary underline hover:text-strong" onClick={asyncHandler(handleConnect)}>Reconnect</button>
                  </div>
                )}
                {discoveredSitemaps && (
                  <div className="mt-3 overflow-x-auto">
                    {discoveredSitemaps.length > 0 ? (
                      <>
                        <DataTableSearch value={sitemapSearch} onChange={(value) => { setSitemapSearch(value); sitemapTable.setPage(1) }} label="Filter sitemaps" placeholder="Filter sitemaps…" />
                        <table className="data-table mt-3 w-full text-sm">
                        <thead>
                          <tr>
                            <th className="text-left">Sitemap</th>
                            <th className="text-left">Type</th>
                            <th className="text-left">Google status</th>
                            <th className="text-left">Last submitted</th>
                            <th className="text-left">Last read</th>
                            <th className="text-right">Discovered URLs</th>
                            <th className="text-left">Issues</th>
                            <th className="text-left">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sitemapTable.rows.flatMap((sitemap) => {
                            const discoveredUrls = sitemapDiscoveredUrlCount(sitemap)
                            const issues = sitemapIssueText(sitemap)
                            const googleStatus = sitemapGoogleStatus(sitemap)
                            const children = sitemapChildren[sitemap.path] ?? []
                            const expanded = expandedSitemapIndexes.has(sitemap.path)
                            const row = (
                              <tr key={sitemap.path}>
                                <td className="max-w-xs text-strong"><MiddleTruncatedText value={sitemap.path} /></td>
                                <td className="text-secondary">{sitemap.isSitemapsIndex ? <button type="button" className="text-secondary hover:text-strong" aria-expanded={expanded} aria-label={`${expanded ? 'Collapse' : 'Expand'} files in ${sitemap.path}`} onClick={() => void toggleSitemapIndex(sitemap.path)}>{loadingSitemapChildren.has(sitemap.path) ? 'Loading…' : `${expanded ? '▾' : '▸'} Index${sitemapChildren[sitemap.path] ? ` (${children.length})` : ''}`}</button> : 'Sitemap'}</td>
                                <td className="text-secondary">{googleStatus}</td>
                                <td className="text-secondary">{sitemap.lastSubmitted ? sitemap.lastSubmitted.split('T')[0] : '—'}</td>
                                <td className="text-secondary">{sitemap.lastDownloaded ? sitemap.lastDownloaded.split('T')[0] : '—'}</td>
                                <td className="text-right tabular-nums text-neutral">{discoveredUrls.toLocaleString()}</td>
                                <td className="max-w-48 text-secondary">{issues || '—'}</td>
                                <td><div className="flex flex-wrap gap-2"><button type="button" className="text-xs text-secondary hover:text-strong" disabled={!canSubmitSitemaps || submittingSitemaps} onClick={() => void handleSubmitSitemaps([sitemap.path])}>{sitemap.lastSubmitted ? 'Resubmit to Google' : 'Submit to Google'}</button>{gscConn?.sitemapUrl === sitemap.path ? <span className="text-xs text-muted" title="Used when no sitemap URL is provided for Canonry GSC operations.">Default sitemap</span> : <button type="button" className="text-xs text-secondary hover:text-strong" disabled={savingSitemap} title="Use this sitemap by default for Canonry GSC operations." onClick={() => void handleSetDefaultSitemap(sitemap.path)}>Set as default</button>}<button type="button" className="text-xs text-secondary hover:text-strong" disabled={triggerInspectSitemapMutation.isPending} onClick={() => void handleInspectSitemap(sitemap.path)}>Inspect URLs</button></div></td>
                              </tr>
                            )
                            const childRows = sitemap.isSitemapsIndex && expanded ? children.map((child) => (
                              <tr key={`${sitemap.path}:${child.path}`}>
                                <td className="max-w-xs pl-6 text-secondary"><MiddleTruncatedText value={child.path} /></td>
                                <td className="text-secondary">File</td>
                                <td className="text-secondary">{sitemapGoogleStatus(child)}</td>
                                <td className="text-secondary">{child.lastSubmitted ? child.lastSubmitted.split('T')[0] : '—'}</td>
                                <td className="text-secondary">{child.lastDownloaded ? child.lastDownloaded.split('T')[0] : '—'}</td>
                                <td className="text-right tabular-nums text-neutral">{sitemapDiscoveredUrlCount(child).toLocaleString()}</td>
                                <td className="text-secondary">{sitemapIssueText(child) || '—'}</td>
                                <td><div className="flex flex-wrap gap-2"><button type="button" className="text-xs text-secondary hover:text-strong" disabled={!canSubmitSitemaps || submittingSitemaps} onClick={() => void handleSubmitSitemaps([child.path])}>Resubmit</button>{gscConn?.sitemapUrl === child.path ? <span className="text-xs text-muted" title="Used when no sitemap URL is provided for Canonry GSC operations.">Default sitemap</span> : <button type="button" className="text-xs text-secondary hover:text-strong" disabled={savingSitemap} title="Use this sitemap by default for Canonry GSC operations." onClick={() => void handleSetDefaultSitemap(child.path)}>Set as default</button>}<button type="button" className="text-xs text-secondary hover:text-strong" disabled={triggerInspectSitemapMutation.isPending} onClick={() => void handleInspectSitemap(child.path)}>Inspect URLs</button></div></td>
                              </tr>
                            )) : []
                            return [row, ...childRows]
                          })}
                        </tbody>
                      </table>
                      <DataTablePagination page={sitemapTable.page} pageSize={DEFAULT_TABLE_PAGE_SIZE} visibleRows={sitemapTable.rows.length} totalRows={sitemapTable.totalRows} onPageChange={sitemapTable.setPage} itemLabel="sitemaps" />
                      </>
                    ) : <p className="text-sm text-muted">No sitemaps found for this property.</p>}
                  </div>
                )}
              </Card>

             {/* URL Inspection */}
              <Card className="surface-card">
                <div className="section-head">
                  <div>
                    <p className="eyebrow eyebrow-soft">Inspection</p>
                    <h3>Inspect a URL</h3>
                  </div>
                </div>
                <div className="mt-3 flex flex-col gap-2 lg:flex-row">
                  <input
                    className="flex-1 rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                    type="url"
                    placeholder="https://example.com/page"
                    value={inspectionUrl}
                    onChange={(e) => setInspectionUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void handleInspect()}
                  />
                  <Button type="button" size="sm" disabled={inspecting || !gscConn?.propertyId || !inspectionUrl.trim()} onClick={asyncHandler(handleInspect)}>
                    {inspecting ? 'Inspecting\u2026' : 'Inspect URL'}
                  </Button>
                </div>
                {inspectionResult && (
                  <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-lg border border-default bg-surface-subtle p-3">
                      <p className="text-xs uppercase tracking-wide text-muted">Indexing state</p>
                      <p className="mt-1 text-sm text-strong">{inspectionResult.indexingState ?? 'Unknown'}</p>
                    </div>
                    <div className="rounded-lg border border-default bg-surface-subtle p-3">
                      <p className="text-xs uppercase tracking-wide text-muted">Verdict</p>
                      <p className="mt-1 text-sm text-strong">{inspectionResult.verdict ?? 'Unknown'}</p>
                    </div>
                    <div className="rounded-lg border border-default bg-surface-subtle p-3">
                      <p className="text-xs uppercase tracking-wide text-muted">Mobile friendly</p>
                      <p className="mt-1 text-sm text-strong">{formatBooleanState(inspectionResult.isMobileFriendly ?? null)}</p>
                    </div>
                    <div className="rounded-lg border border-default bg-surface-subtle p-3">
                      <p className="text-xs uppercase tracking-wide text-muted">Last crawl</p>
                      <p className="mt-1 text-sm text-strong">{formatTimestamp(inspectionResult.crawlTime)}</p>
                    </div>
                  </div>
                )}
              </Card>

              {/* Inspection log */}
              <Card className="surface-card">
                <div className="section-head section-head-inline">
                  <div>
                    <p className="eyebrow eyebrow-soft">History</p>
                    <h3>Inspection log</h3>
                  </div>
                  <Button type="button" variant="outline" size="sm" disabled={loadingInspections} onClick={() => void loadInspectionHistory(true)}>
                    {loadingInspections ? 'Loading\u2026' : 'Refresh history'}
                  </Button>
                </div>
                <div className="mt-3 flex flex-col gap-2 lg:flex-row">
                  <input
                    className="flex-1 rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                    type="text"
                    placeholder="Filter exact URL"
                    value={inspectionFilterUrl}
                    onChange={(e) => setInspectionFilterUrl(e.target.value)}
                  />
                  <Button type="button" size="sm" variant="outline" disabled={loadingInspections} onClick={() => void loadInspectionHistory(true)}>
                    Apply filter
                  </Button>
                </div>
                {inspections.length > 0 ? (
                  <div className="mt-3 overflow-x-auto">
                    <table className="data-table w-full text-sm">
                      <thead>
                        <tr>
                          <th className="text-left">URL</th>
                          <th className="text-left">Indexing</th>
                          <th className="text-left">Verdict</th>
                          <th className="text-left">Coverage</th>
                          <th className="text-left">Mobile</th>
                          <th className="text-left">Inspected</th>
                        </tr>
                      </thead>
                      <tbody>
                        {inspections.map((row) => (
                          <tr key={row.id}>
                            <td className="max-w-sm truncate text-strong">{row.url}</td>
                            <td className="text-neutral">{row.indexingState ?? 'Unknown'}</td>
                            <td className="text-secondary">{row.verdict ?? 'Unknown'}</td>
                            <td className="text-secondary">{row.coverageState ?? 'Unknown'}</td>
                            <td className="text-secondary">{formatBooleanState(row.isMobileFriendly ?? null)}</td>
                            <td className="text-secondary">{formatTimestamp(row.inspectedAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-muted">No inspection history yet.</p>
                )}
              </Card>

              {/* Recent indexing losses */}
              <Card className="surface-card">
                <div className="section-head">
                  <div>
                    <p className="eyebrow eyebrow-soft">Deindexed</p>
                    <h3>Recent indexing losses</h3>
                  </div>
                </div>
                {deindexed.length > 0 ? (
                  <div className="mt-3 overflow-x-auto">
                    <table className="data-table w-full text-sm">
                      <thead>
                        <tr>
                          <th className="text-left">URL</th>
                          <th className="text-left">Previous</th>
                          <th className="text-left">Current</th>
                          <th className="text-left">Changed at</th>
                        </tr>
                      </thead>
                      <tbody>
                        {deindexed.map((row) => (
                          <tr key={`${row.url}:${row.transitionDate}`}>
                            <td className="max-w-sm truncate text-strong">{row.url}</td>
                            <td className="text-secondary">{row.previousState ?? 'Unknown'}</td>
                            <td className="text-neutral">{row.currentState ?? 'Unknown'}</td>
                            <td className="text-secondary">{formatTimestamp(row.transitionDate)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-muted">No deindexed transitions recorded.</p>
                )}
              </Card>
            </div>
          )}

          {/* ── SETUP SECTION (at bottom, collapsible for connected projects) ── */}
          {gscConn && (
            <>
              <div className="border-t border-default pt-3">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 text-left"
                  onClick={() => setSetupExpanded((prev) => !prev)}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"
                    className={`h-4 w-4 text-muted transition-transform ${setupExpanded ? 'rotate-90' : ''}`}
                    aria-hidden="true"
                  >
                    <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
                  </svg>
                  <span className="text-xs uppercase tracking-wide text-muted">Setup &amp; Configuration</span>
                </button>
              </div>

              {setupExpanded && (
                <div className="space-y-3">
                  <div className="grid gap-3 xl:grid-cols-2">
                    <Card className="surface-card">
                      <div className="section-head">
                        <div>
                          <p className="eyebrow eyebrow-soft">Property</p>
                          <div className="flex items-center gap-1.5">
                            <h3>Pick the Search Console property</h3>
                            <InfoTooltip text="The selected property is used for future syncs and URL inspections for this project." />
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 space-y-2">
                        <label className="text-xs text-muted" htmlFor={`gsc-property-${projectName}`}>Property URL</label>
                        <select
                          id={`gsc-property-${projectName}`}
                          className="w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong focus:border-mono-500 focus:outline-none"
                          value={selectedProperty}
                          disabled={propertiesLoading || properties.length === 0}
                          onChange={(e) => setSelectedProperty(e.target.value)}
                        >
                          {properties.length === 0 ? (
                            <option value="">{propertiesLoading ? 'Loading properties\u2026' : 'No properties available'}</option>
                          ) : (
                            properties.map((site) => (
                              <option key={site.siteUrl} value={site.siteUrl}>
                                {site.siteUrl} · {site.permissionLevel}
                              </option>
                            ))
                          )}
                        </select>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button type="button" size="sm" variant="outline" disabled={propertiesLoading} onClick={() => void loadProperties(gscConn, true)}>
                            {propertiesLoading ? 'Refreshing\u2026' : 'Refresh properties'}
                          </Button>
                          <Button type="button" size="sm" disabled={!selectedProperty || savingProperty} onClick={asyncHandler(handleSaveProperty)}>
                            {savingProperty ? 'Saving\u2026' : 'Save property'}
                          </Button>
                        </div>
                      </div>
                    </Card>

                    <Card className="surface-card">
                      <div className="section-head">
                        <div>
                          <p className="eyebrow eyebrow-soft">Sync</p>
                          <h3>Import GSC performance data</h3>
                        </div>
                      </div>
                      <div className="mt-3 space-y-3">
                        <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
                          <div>
                            <label className="text-xs text-muted" htmlFor={`gsc-sync-days-${projectName}`}>Days</label>
                            <input
                              id={`gsc-sync-days-${projectName}`}
                              type="number"
                              min="1"
                              className="mt-0.5 w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                              value={syncDays}
                              onChange={(e) => setSyncDays(e.target.value)}
                            />
                          </div>
                          <label className="flex items-center gap-2 rounded border border-default bg-surface-subtle px-3 py-2 text-sm text-neutral">
                            <input
                              type="checkbox"
                              checked={fullSync}
                              onChange={(e) => setFullSync(e.target.checked)}
                            />
                            Replace existing imported rows for the requested range
                          </label>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          disabled={triggerGscSyncMutation.isPending || !gscConn.propertyId}
                          onClick={asyncHandler(handleSync)}
                        >
                          {triggerGscSyncMutation.isPending ? 'Queueing\u2026' : 'Queue sync'}
                        </Button>
                        {!gscConn.propertyId && (
                          <p className="text-xs text-caution-400">Select a Search Console property before queueing a sync.</p>
                        )}
                      </div>
                    </Card>
                  </div>

                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
