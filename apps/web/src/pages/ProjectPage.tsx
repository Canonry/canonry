import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { ChevronDown, RefreshCw, Trash2 } from 'lucide-react'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { Link } from '@tanstack/react-router'

import { DEFAULT_MEASUREMENT_VIEW, measurementViewSearch, parseMeasurementViewSearch, shouldResetMeasurementView } from '../lib/measurement-view-url.js'
import { useQueryClient } from '@tanstack/react-query'
import { RunKinds, RunStatuses } from '@ainyc/canonry-contracts'
import type { MeasurementOverviewSort } from '@ainyc/canonry-contracts'

import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { WriteButton } from '../components/shared/AccessControls.js'
import { InfoTooltip } from '../components/shared/InfoTooltip.js'
import { MentionShare } from '../components/project/MentionShare.js'
import { CitationBadge } from '../components/shared/CitationBadge.js'
import { ProviderBadge } from '../components/shared/ProviderBadge.js'
import { RunRow } from '../components/shared/RunRow.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { EvidenceTable } from '../components/project/EvidenceTable.js'
import { CompetitorTable } from '../components/project/CompetitorTable.js'
import { BingSummaryMetric } from '../components/project/BingSummaryMetric.js'
import { ActivitySection } from '../components/project/ActivitySection.js'
import { GscSection } from '../components/project/GscSection.js'
import { GbpSection } from '../components/project/GbpSection.js'
import { BacklinksSection } from '../components/project/BacklinksSection.js'
import { CitationVisibilitySection } from '../components/project/CitationVisibilitySection.js'
import { VisibilityTrendSection } from '../components/project/VisibilityTrendSection.js'
import { DiscoverySection } from '../components/project/DiscoverySection.js'
import { SiteHealthSection } from '../components/project/SiteHealthSection.js'
import { ProjectHistorySection } from '../components/project/ProjectHistorySection.js'
import { ConversionIntegrityWorkspace } from '../components/project/ConversionIntegrityWorkspace.js'
import { GoogleAdsPerformanceSection } from '../components/project/GoogleAdsPerformanceSection.js'
import { AdvancedMeasurementSection } from '../components/project/advanced-measurement/AdvancedMeasurementSection.js'
import { AdvancedMeasurementLanding } from '../components/project/advanced-measurement/AdvancedMeasurementLanding.js'
import {
  advancedMeasurementSetupActionLabel,
  resolveAdvancedMeasurementMode,
} from '../components/project/advanced-measurement/model.js'
import { adaptVersionOneMeasurementReport } from '../components/project/advanced-measurement/v1-report-adapter.js'
import {
  adaptV2MeasurementOverview,
  areV2OverviewPagesCompatible,
} from '../components/project/advanced-measurement/v2-overview-adapter.js'
import { ReportPage } from './ReportPage.js'
import { formatTimestamp, SEARCH_METRIC_SHORT_LABELS, SearchMetric } from '../lib/format-helpers.js'
import { METRIC_TONE_TEXT_CLASS } from '../lib/tone-helpers.js'
import { addToast } from '../lib/toast-store.js'
import { asyncHandler } from '../lib/async-handler.js'
import { ProjectSettingsSection } from '../components/project/ProjectSettingsSection.js'
import { ProjectEngineSettingsSection } from '../components/project/ProjectEngineSettingsSection.js'
import { ScheduleSection } from '../components/project/ScheduleSection.js'
import { NotificationsSection } from '../components/project/NotificationsSection.js'
import {
  fetchTimeline,
  deleteProject as apiDeleteProject,
  appendCompetitors as apiAppendCompetitors,
  removeCompetitorById as apiRemoveCompetitorById,
  updateProject as apiUpdateProject,
  bingConnect as apiBingConnect,
  bingDisconnect as apiBingDisconnect,
  bingSetSite as apiBingSetSite,
  inspectBingUrl,
  inspectBingSitemap,
  bingRequestIndexing,
  triggerGscSync,
  fetchRunDetail,
  heyClient,
  getEmbedConfig,
  isEmbed,
  type ApiBingConnection,
  type ApiBingSite,
  type ApiBingInspection,
  type ApiBingCoverageSummary,
  type ApiBingKeywordStats,
  type ApiGoogleConnection,
  type ApiProject,
} from '../api.js'
import { filterEmbedProjectTabs, isEmbedProjectTabAllowed, resolveEmbedProjectTab } from '../embed.js'
import {
  getApiV1ProjectsByNameBingCoverageOptions,
  getApiV1ProjectsByNameBingInspectionsOptions,
  getApiV1ProjectsByNameBingPerformanceOptions,
  getApiV1ProjectsByNameBingSitesOptions,
  getApiV1ProjectsByNameBingStatusOptions,
  getApiV1ProjectsByNameGoogleConnectionsOptions,
  getApiV1ProjectsByNameMeasurementOverviewInfiniteOptions,
  getApiV1ProjectsByNameMeasurementPlanOptions,
  getApiV1ProjectsByNameMeasurementPortfolioSummaryOptions,
  getApiV1ProjectsByNameScheduleOptions,
  getApiV1ProjectsByNameMeasurementReportOptions,
  getApiV1ProjectsByNameMeasurementSetupOptions,
  getApiV1ProjectsByNameQueriesOptions,
  getApiV1ProjectsQueryKey,
  getApiV1ProjectsByNameQueryKey,
} from '@ainyc/canonry-api-client/react-query'
import { useAppendQueries, useTriggerRun } from '../queries/mutations.js'
import { GSC_STALE_MS } from '../queries/query-client.js'
import { invalidateProjectQueryDomain } from '../queries/query-invalidation.js'
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { getApiV1ProjectsOptions } from '@ainyc/canonry-api-client/react-query'
import { useProjectDashboard } from '../queries/use-project-dashboard.js'
import { useInitialDashboard } from '../contexts/dashboard-context.js'
import { useDrawer } from '../hooks/use-drawer.js'
import { useAccount } from '../contexts/account-context.js'
import type { ProjectCommandCenterVm, RunHistoryPoint } from '../view-models.js'

export type ProjectPageTab = 'overview' | 'portfolio' | 'search-console' | 'conversions' | 'local' | 'discovery' | 'report' | 'activity' | 'backlinks' | 'technical-aeo' | 'history' | 'settings'

type SearchConsoleWorkspace = 'google' | 'bing'

/**
 * Patch the cached `useProjectDashboard` detail entries for a single project
 * with a freshly-saved project object.
 *
 * The detail key is `['project-dashboard-full', projectId, latestRunIdsKey]`
 * (see `use-project-dashboard.ts`), so a project has one entry per run-ids
 * revision and the id MUST be part of the match. A head-only predicate wrote
 * the saved project into every other project's cached entry; because
 * `commandCenter` is built from that entry, the settings form on a
 * previously-visited project then rendered — and saved to — the wrong project.
 */
/**
 * How often the "Refresh search data" flow polls a triggered sweep, and how long it
 * waits before reporting the run as still in flight.
 *
 * The old 120s deadline was shorter than a normal sweep: a paced Bing run over
 * ~45 URLs is around 90s healthy and a throttled one ran 335s, so the poll gave
 * up on runs that were about to succeed and reported "still running" instead of
 * the real outcome. The run itself is server-side and unaffected by this — only
 * whether the user is told what happened.
 */
const REFRESH_POLL_INTERVAL_MS = 2_000
const REFRESH_POLL_TIMEOUT_MS = 300_000

export function patchProjectDashboardCache(
  queryClient: ReturnType<typeof useQueryClient>,
  updated: ApiProject,
): void {
  queryClient.setQueriesData({
    predicate: query => query.queryKey[0] === 'project-dashboard-full' && query.queryKey[1] === updated.id,
  }, (current: unknown) => {
    if (!current || typeof current !== 'object' || !('project' in current)) return current
    return { ...current, project: updated }
  })
}

function BingSection({
  projectName,
  refreshNonce,
}: {
  projectName: string
  refreshNonce: number
}) {
  const queryClient = useQueryClient()
  const [connection, setConnection] = useState<ApiBingConnection | null>(null)
  const [sites, setSites] = useState<ApiBingSite[]>([])
  const [coverage, setCoverage] = useState<ApiBingCoverageSummary | null>(null)
  const [inspections, setInspections] = useState<ApiBingInspection[]>([])
  const [performance, setPerformance] = useState<ApiBingKeywordStats[]>([])
  const [inspectionResult, setInspectionResult] = useState<ApiBingInspection | null>(null)
  const [inspectionUrl, setInspectionUrl] = useState('')
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [selectedSite, setSelectedSite] = useState('')
  const [loading, setLoading] = useState(true)
  const [requestingIndexing, setRequestingIndexing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Performance is the default — it's the highest-signal view (per-query
  // impressions, clicks, position) and mirrors how the GSC tab leads.
  const [activeTab, setActiveTab] = useState<'performance' | 'coverage' | 'inspections'>('performance')

  useEffect(() => {
    void loadData()
  }, [projectName, refreshNonce])

  async function loadData() {
    setLoading(true)
    setError(null)
    try {
      const status = await queryClient.fetchQuery({
        ...getApiV1ProjectsByNameBingStatusOptions({ client: heyClient, path: { name: projectName } }),
        staleTime: GSC_STALE_MS,
      })
      setConnection(status)

      if (status.connected) {
        const [coverageData, inspectionData, perfData, sitesData] = await Promise.all([
          queryClient.fetchQuery({
            ...getApiV1ProjectsByNameBingCoverageOptions({ client: heyClient, path: { name: projectName } }),
            staleTime: GSC_STALE_MS,
          }).catch(() => null),
          queryClient.fetchQuery({
            ...getApiV1ProjectsByNameBingInspectionsOptions({ client: heyClient, path: { name: projectName } }),
            staleTime: GSC_STALE_MS,
          }).catch(() => [] as ApiBingInspection[]),
          queryClient.fetchQuery({
            ...getApiV1ProjectsByNameBingPerformanceOptions({ client: heyClient, path: { name: projectName } }),
            staleTime: GSC_STALE_MS,
          }).catch(() => [] as ApiBingKeywordStats[]),
          !status.siteUrl
            ? queryClient.fetchQuery({
                ...getApiV1ProjectsByNameBingSitesOptions({ client: heyClient, path: { name: projectName } }),
                staleTime: GSC_STALE_MS,
              }).then((result) => result.sites).catch(() => [] as ApiBingSite[])
            : Promise.resolve([] as ApiBingSite[]),
        ])
        setCoverage(coverageData)
        setInspections(inspectionData)
        setPerformance(perfData)
        setSites(sitesData)
      } else {
        setCoverage(null)
        setInspections([])
        setPerformance([])
        setSites([])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load Bing data')
    } finally {
      setLoading(false)
    }
  }

  async function handleConnect() {
    if (!apiKeyInput.trim()) return
    setError(null)
    try {
      const result = await apiBingConnect(projectName, apiKeyInput.trim())
      await invalidateProjectQueryDomain(queryClient, 'bing')
      setApiKeyInput('')
      if (result.availableSites.length > 0) {
        setSites(result.availableSites)
      }
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to connect')
    }
  }

  async function handleDisconnect() {
    try {
      await apiBingDisconnect(projectName)
      await invalidateProjectQueryDomain(queryClient, 'bing')
      setConnection(null)
      setSites([])
      setCoverage(null)
      setInspections([])
      setPerformance([])
      setInspectionResult(null)
      setSelectedSite('')
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to disconnect')
    }
  }

  async function handleSetSite() {
    if (!selectedSite) return
    try {
      await apiBingSetSite(projectName, selectedSite)
      await invalidateProjectQueryDomain(queryClient, 'bing')
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set site')
    }
  }

  async function handleInspect() {
    if (!inspectionUrl.trim()) return
    try {
      const result = await inspectBingUrl(projectName, inspectionUrl.trim())
      await invalidateProjectQueryDomain(queryClient, 'bing')
      setInspectionResult(result)
      setInspections((prev) => [result, ...prev])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Inspection failed')
    }
  }

  async function handleSubmitUrl(url: string) {
    setRequestingIndexing(true)
    setError(null)
    try {
      const result = await bingRequestIndexing(projectName, { urls: [url] })
      const { succeeded, failed, total } = result.summary
      addToast({
        title: 'Bing submission requested',
        detail: failed === 0
          ? `${succeeded} URL submitted to Bing.`
          : `${succeeded}/${total} submitted successfully, ${failed} failed.`,
        tone: failed === 0 ? 'positive' : 'caution',
        dedupeKey: `bing:indexing:${projectName}:${url}`,
        dedupeMode: 'replace',
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Submission failed'
      setError(message)
      addToast({
        title: 'Bing submission failed',
        detail: message,
        tone: 'negative',
        dedupeKey: `bing:indexing:${projectName}:${url}`,
        dedupeMode: 'replace',
      })
    } finally {
      setRequestingIndexing(false)
    }
  }

  async function handleSubmitAllUnindexed() {
    setRequestingIndexing(true)
    setError(null)
    addToast({
      title: 'Submitting URLs to Bing',
      detail: 'Requesting indexing for all currently unindexed URLs.',
      tone: 'neutral',
      dedupeKey: `bing:indexing-all:${projectName}`,
      dedupeMode: 'replace',
    })
    try {
      const result = await bingRequestIndexing(projectName, { allUnindexed: true })
      const { succeeded, failed, total } = result.summary
      addToast({
        title: 'Bing submissions requested',
        detail: failed === 0
          ? `${succeeded}/${total} URL${total !== 1 ? 's' : ''} submitted to Bing.`
          : `${succeeded}/${total} submitted successfully, ${failed} failed.`,
        tone: failed === 0 ? 'positive' : 'caution',
        dedupeKey: `bing:indexing-all:${projectName}`,
        dedupeMode: 'replace',
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Batch submission failed'
      setError(message)
      addToast({
        title: 'Bing submissions failed',
        detail: message,
        tone: 'negative',
        dedupeKey: `bing:indexing-all:${projectName}`,
        dedupeMode: 'replace',
      })
    } finally {
      setRequestingIndexing(false)
    }
  }

  if (loading) {
    return (
      <Card className="surface-card">
        <div className="text-sm text-secondary">Loading Bing data...</div>
      </Card>
    )
  }

  if (!connection?.connected) {
    if (isEmbed()) {
      return (
        <Card className="surface-card">
          <div className="section-head section-head-inline">
            <div>
              <p className="eyebrow eyebrow-soft">Connection</p>
              <h3>Domain authorization</h3>
            </div>
            <ToneBadge tone="caution">Not connected</ToneBadge>
          </div>
          <p className="text-sm text-neutral">Bing Webmaster Tools is not connected for this project.</p>
        </Card>
      )
    }
    return (
      <Card className="surface-card">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Connection</p>
            <h3>Domain authorization</h3>
          </div>
          <ToneBadge tone="caution">Not connected</ToneBadge>
        </div>
        <p className="text-sm text-neutral">
          Connect Bing Webmaster Tools to inspect URLs, monitor index coverage, and submit pages for indexing.
        </p>
        <div className="mt-3">
          <label className="text-xs text-muted" htmlFor="bing-api-key">API Key</label>
          <div className="flex items-center gap-2 mt-1">
            <input
              id="bing-api-key"
              type="password"
              className="flex-1 rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
              placeholder="Bing Webmaster Tools API key"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { void handleConnect() } }}
            />
            <WriteButton size="sm" disabled={!apiKeyInput.trim()} onClick={asyncHandler(handleConnect)}>
              Connect
            </WriteButton>
          </div>
          <p className="mt-1 text-sm text-secondary">
            Get your API key from{' '}
            <a
              href="https://www.bing.com/webmasters/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-secondary hover:text-neutral underline underline-offset-2"
            >
              Bing Webmaster Tools
            </a>
          </p>
        </div>
        {error && <p className="mt-3 text-xs text-negative-400">{error}</p>}
      </Card>
    )
  }

  if (!connection.siteUrl) {
    return (
      <Card className="surface-card">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Connection</p>
            <h3>Domain authorization</h3>
          </div>
          <div className="flex items-center gap-2">
            <ToneBadge tone="positive">Connected</ToneBadge>
            {!isEmbed() && <WriteButton size="sm" variant="ghost" onClick={asyncHandler(handleDisconnect)}>Disconnect</WriteButton>}
          </div>
        </div>
        <div className="space-y-3">
          <div className="rounded-lg border border-default bg-surface px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="h-2 w-2 rounded-full bg-positive-500" />
              <span className="text-sm text-strong">Authorized for this project domain</span>
              <span className="text-xs text-muted">{connection.domain}</span>
            </div>
            <p className="mt-2 text-xs text-muted">
              The API key is connected, but no Bing site is selected yet. Pick the verified site that should receive inspections and indexing requests.
            </p>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border border-default bg-surface-subtle p-3">
              <p className="text-xs uppercase tracking-wide text-muted">Registered domain</p>
              <p className="mt-1 text-sm text-strong">{connection.domain}</p>
            </div>
            <div className="rounded-lg border border-default bg-surface-subtle p-3">
              <p className="text-xs uppercase tracking-wide text-muted">Last auth update</p>
              <p className="mt-1 text-sm text-strong">{connection.updatedAt ? formatTimestamp(connection.updatedAt) : '\u2014'}</p>
            </div>
          </div>
          <div className="rounded-lg border border-default bg-surface-subtle p-3">
            <p className="text-xs uppercase tracking-wide text-muted">Select site</p>
            {sites.length > 0 ? (
              <div className="mt-3 flex flex-col gap-2 lg:flex-row">
                <select
                  className="flex-1 rounded border border-strong bg-bg-elevated px-2 py-1.5 text-sm text-strong focus:border-mono-500 focus:outline-none"
                  value={selectedSite}
                  onChange={(e) => setSelectedSite(e.target.value)}
                >
                  <option value="">Select a site...</option>
                  {sites.map((s) => (
                    <option key={s.url} value={s.url}>{s.url}{s.verified ? ' (verified)' : ''}</option>
                  ))}
                </select>
                {!isEmbed() && <WriteButton size="sm" disabled={!selectedSite} onClick={asyncHandler(handleSetSite)}>Set Site</WriteButton>}
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted">
                No verified Bing sites are available yet. Verify the domain in Bing Webmaster Tools, then use the page-level refresh to reload everything.
              </p>
            )}
          </div>
        </div>
        {error && <p className="mt-3 text-xs text-negative-400">{error}</p>}
      </Card>
    )
  }

  const tabs = [
    { key: 'performance' as const, label: 'Performance', eyebrow: 'Performance', title: 'Search performance' },
    { key: 'coverage' as const, label: 'Coverage', eyebrow: 'Coverage', title: 'Index monitoring' },
    { key: 'inspections' as const, label: 'Inspections', eyebrow: 'Inspection', title: 'URL inspection history' },
  ]
  const activeTabMeta = tabs.find(t => t.key === activeTab) ?? tabs[0]!

  return (
    <div className="space-y-3">
      <Card className="surface-card">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Connection</p>
            <h3>Domain authorization</h3>
          </div>
          <div className="flex items-center gap-2">
            <ToneBadge tone="positive">Connected</ToneBadge>
            {!isEmbed() && <WriteButton size="sm" variant="ghost" onClick={asyncHandler(handleDisconnect)}>Disconnect</WriteButton>}
          </div>
        </div>
        {error && <p className="mb-3 text-xs text-negative-400">{error}</p>}
        <div className="space-y-3">
          <div className="rounded-lg border border-default bg-surface px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="h-2 w-2 rounded-full bg-positive-500" />
              <span className="text-sm text-strong">Authorized for this project domain</span>
              <span className="text-xs text-muted">{connection.domain}</span>
            </div>
            <p className="mt-2 text-sm text-secondary">This project uses <code>{connection.siteUrl}</code>.</p>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border border-default bg-surface-subtle p-3">
              <p className="text-xs uppercase tracking-wide text-muted">Selected site</p>
              <p className="mt-1 text-sm text-strong">{connection.siteUrl}</p>
            </div>
            <div className="rounded-lg border border-default bg-surface-subtle p-3">
              <p className="text-xs uppercase tracking-wide text-muted">Last auth update</p>
              <p className="mt-1 text-sm text-strong">{connection.updatedAt ? formatTimestamp(connection.updatedAt) : '\u2014'}</p>
            </div>
          </div>
        </div>
      </Card>

      <Card className="surface-card">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">{activeTabMeta.eyebrow}</p>
            <h3>{activeTabMeta.title}</h3>
          </div>
          <p className="text-xs text-muted">
            {coverage?.lastInspectedAt ? `Last inspected ${formatTimestamp(coverage.lastInspectedAt)}` : 'No inspection history yet'}
          </p>
        </div>

        <div className="flex gap-1 border-b border-base">
          {tabs.map((t) => (
            <button
              key={t.key}
              className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
                activeTab === t.key
                  ? 'border-mono-200 text-strong'
                  : 'border-transparent text-muted hover:text-neutral'
              }`}
              onClick={() => setActiveTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {activeTab === 'coverage' && coverage && (
          <div className="mt-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <BingSummaryMetric label="Indexed" value={coverage.summary.indexed} tone="positive" />
              <BingSummaryMetric label="Not in index" value={coverage.summary.notIndexed + (coverage.summary.unknown ?? 0)} tone="negative" />
              <BingSummaryMetric label="Status unknown" value={coverage.summary.unknown ?? 0} tone="neutral" />
              <BingSummaryMetric label="Coverage" value={`${coverage.summary.percentage}%`} tone="neutral" />
            </div>

            {coverage.notIndexed.length > 0 && (
              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h4 className="text-xs font-medium text-secondary">Not Indexed ({coverage.notIndexed.length})</h4>
                  {!isEmbed() && (
                    <WriteButton size="sm" variant="ghost" disabled={requestingIndexing} onClick={asyncHandler(handleSubmitAllUnindexed)}>
                      {requestingIndexing ? 'Submitting…' : 'Submit all to Bing'}
                    </WriteButton>
                  )}
                </div>
                <div className="overflow-x-auto rounded-lg border border-default">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-base">
                        <th className="text-left py-1.5 px-3 text-muted font-medium">URL</th>
                        <th className="text-left py-1.5 px-3 text-muted font-medium w-16">HTTP</th>
                        {!isEmbed() && <th className="text-right py-1.5 px-3 text-muted font-medium w-20">Action</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {coverage.notIndexed.map((row) => (
                        <tr key={row.id} className="border-b border-subtle">
                          <td className="py-1.5 px-3 text-neutral truncate max-w-[480px]">{row.url}</td>
                          <td className="py-1.5 px-3 text-secondary">{row.httpCode ?? '\u2014'}</td>
                          {!isEmbed() && (
                            <td className="py-1.5 px-3 text-right">
                              <button
                                className="text-sm text-secondary hover:text-strong underline underline-offset-2"
                                disabled={requestingIndexing}
                                onClick={() => { void handleSubmitUrl(row.url) }}
                              >
                                Submit
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {(coverage.unknown ?? []).length > 0 && (
              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h4 className="text-sm font-medium text-secondary">Unknown, not yet confirmed ({(coverage.unknown ?? []).length})</h4>
                  {!isEmbed() && (
                    <WriteButton size="sm" variant="ghost" disabled={requestingIndexing} onClick={asyncHandler(handleSubmitAllUnindexed)}>
                      {requestingIndexing ? 'Submitting…' : 'Submit all to Bing'}
                    </WriteButton>
                  )}
                </div>
                <div className="overflow-x-auto rounded-lg border border-default">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-base">
                        <th className="text-left py-1.5 px-3 text-muted font-medium">URL</th>
                        <th className="text-left py-1.5 px-3 text-muted font-medium w-32">Last Crawled</th>
                        {!isEmbed() && <th className="text-right py-1.5 px-3 text-muted font-medium w-20">Action</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {(coverage.unknown ?? []).map((row) => (
                        <tr key={row.id} className="border-b border-subtle">
                          <td className="py-1.5 px-3 text-neutral truncate max-w-[480px]">{row.url}</td>
                          <td className="py-1.5 px-3 text-secondary">{row.lastCrawledDate ? formatTimestamp(row.lastCrawledDate) : '\u2014'}</td>
                          {!isEmbed() && (
                            <td className="py-1.5 px-3 text-right">
                              <button
                                className="text-sm text-secondary hover:text-strong underline underline-offset-2"
                                disabled={requestingIndexing}
                                onClick={() => { void handleSubmitUrl(row.url) }}
                              >
                                Submit
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {coverage.indexed.length > 0 && (
              <div>
                <h4 className="mb-2 text-xs font-medium text-secondary">Indexed ({coverage.indexed.length})</h4>
                <div className="overflow-x-auto rounded-lg border border-default">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-base">
                        <th className="text-left py-1.5 px-3 text-muted font-medium">URL</th>
                        <th className="text-left py-1.5 px-3 text-muted font-medium w-32">Last Crawled</th>
                      </tr>
                    </thead>
                    <tbody>
                      {coverage.indexed.map((row) => (
                        <tr key={row.id} className="border-b border-subtle">
                          <td className="py-1.5 px-3 text-neutral truncate max-w-[480px]">{row.url}</td>
                          <td className="py-1.5 px-3 text-secondary">{row.lastCrawledDate ? formatTimestamp(row.lastCrawledDate) : '\u2014'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'coverage' && !coverage && (
          <p className="mt-4 text-xs text-muted">No coverage data yet. Inspect URLs to build coverage data.</p>
        )}

        {activeTab === 'inspections' && (
          <div className="mt-4 space-y-3">
            {!isEmbed() && (
              <div className="flex flex-col gap-2 lg:flex-row">
                <input
                  type="text"
                  className="flex-1 rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                  placeholder="URL to inspect"
                  value={inspectionUrl}
                  onChange={(e) => setInspectionUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { void handleInspect() } }}
                />
                <WriteButton size="sm" disabled={!inspectionUrl.trim()} onClick={asyncHandler(handleInspect)}>
                  Inspect
                </WriteButton>
              </div>
            )}

            {inspectionResult && (
              <div className="rounded border border-base bg-bg-elevated/40 p-3 text-xs space-y-1">
                <div className="font-medium text-strong">{inspectionResult.url}</div>
                <div className="text-secondary">
                  In Index: <span className={inspectionResult.inIndex ? 'text-positive-400' : 'text-negative-400'}>
                    {inspectionResult.inIndex ? 'Yes' : 'No'}
                  </span>
                  {' \u00b7 '}HTTP: {inspectionResult.httpCode ?? '\u2014'}
                  {' \u00b7 '}Crawled: {inspectionResult.lastCrawledDate ?? '\u2014'}
                </div>
              </div>
            )}

            {inspections.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-default">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-base">
                      <th className="text-left py-1.5 px-3 text-muted font-medium">URL</th>
                      <th className="text-left py-1.5 px-3 text-muted font-medium w-16">Index</th>
                      <th className="text-left py-1.5 px-3 text-muted font-medium w-14">HTTP</th>
                      <th className="text-left py-1.5 px-3 text-muted font-medium w-32">Inspected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inspections.map((row) => (
                      <tr key={row.id} className="border-b border-subtle">
                        <td className="py-1.5 px-3 text-neutral truncate max-w-[480px]">{row.url}</td>
                        <td className="py-1.5 px-3">
                          <ToneBadge tone={row.inIndex ? 'positive' : 'negative'}>{row.inIndex ? 'Yes' : 'No'}</ToneBadge>
                        </td>
                        <td className="py-1.5 px-3 text-secondary">{row.httpCode ?? '\u2014'}</td>
                        <td className="py-1.5 px-3 text-secondary">{formatTimestamp(row.inspectedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === 'performance' && (
          <div className="mt-4">
            {performance.length === 0 ? (
              <p className="text-xs text-muted">No Bing performance data available.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-default">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-base">
                      <th className="text-left py-1.5 px-3 text-muted font-medium">Query</th>
                      <th className="text-right py-1.5 px-3 text-muted font-medium w-16">{SEARCH_METRIC_SHORT_LABELS[SearchMetric.Clicks]}</th>
                      <th className="text-right py-1.5 px-3 text-muted font-medium w-16">{SEARCH_METRIC_SHORT_LABELS[SearchMetric.Impressions]}</th>
                      <th className="text-right py-1.5 px-3 text-muted font-medium w-14">{SEARCH_METRIC_SHORT_LABELS[SearchMetric.CTR]}</th>
                      <th className="text-right py-1.5 px-3 text-muted font-medium w-14">{SEARCH_METRIC_SHORT_LABELS[SearchMetric.Position]}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {performance.map((row, i) => (
                      <tr key={i} className="border-b border-subtle">
                        <td className="py-1.5 px-3 text-neutral truncate max-w-[480px]">{row.query}</td>
                        <td className="py-1.5 px-3 text-right text-strong">{row.clicks}</td>
                        <td className="py-1.5 px-3 text-right text-secondary">{row.impressions}</td>
                        <td className="py-1.5 px-3 text-right text-secondary">{(Number.isFinite(row.ctr) ? row.ctr * 100 : 0).toFixed(1)}%</td>
                        <td className="py-1.5 px-3 text-right text-secondary">{row.averagePosition.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  )
}

function SearchConsoleSection({
  projectName,
}: {
  projectName: string
}) {
  const queryClient = useQueryClient()
  const [workspace, setWorkspace] = useState<SearchConsoleWorkspace>('google')
  const [loading, setLoading] = useState(true)
  const [refreshState, setRefreshState] = useState<'idle' | 'syncing' | 'reloading'>('idle')
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const [googleConnection, setGoogleConnection] = useState<ApiGoogleConnection | null>(null)
  const [bingConnection, setBingConnection] = useState<ApiBingConnection | null>(null)
  const [workspaceRefreshNonce, setWorkspaceRefreshNonce] = useState(0)

  async function loadConnectionState(silent = false) {
    if (!silent) setLoading(true)
    setError(null)

    try {
      const [connections, bingStatus] = await Promise.all([
        queryClient.fetchQuery({
          ...getApiV1ProjectsByNameGoogleConnectionsOptions({ client: heyClient, path: { name: projectName } }),
          staleTime: GSC_STALE_MS,
        }).catch(() => [] as ApiGoogleConnection[]),
        queryClient.fetchQuery({
          ...getApiV1ProjectsByNameBingStatusOptions({ client: heyClient, path: { name: projectName } }),
          staleTime: GSC_STALE_MS,
        }).catch(() => null),
      ])

      const gscConnection = connections.find((connection) => connection.connectionType === 'gsc') ?? null
      setGoogleConnection(gscConnection)
      setBingConnection(bingStatus)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load search engine connections')
    } finally {
      setLoading(false)
    }
  }

  /**
   * Trigger live queries against both Google (GSC sync job) and Bing (per-URL re-inspection),
   * run them in parallel, wait for both to settle, then reload coverage data.
   */
  async function handleRefresh() {
    if (refreshState !== 'idle') return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const signal = controller.signal

    setRefreshState('syncing')
    setError(null)
    addToast({
      title: 'Refreshing search coverage',
      detail: 'Queueing Google and Bing checks, then reloading the workspaces.',
      tone: 'neutral',
      dedupeKey: `search-console-refresh:${projectName}`,
      dedupeMode: 'replace',
    })

    const failures: string[] = []
    // Things that are neither success nor failure: work that is still running
    // and will land on its own. Reporting these keeps a slow-but-healthy sync
    // from reading as either "done" or "broken".
    const notices: string[] = []

    try {
      // --- Google: trigger a background GSC sync job and poll to completion ---
      async function syncGoogle() {
        if (!googleConnection) return
        const run = await triggerGscSync(projectName)
        if (!run?.id) return

        const deadline = Date.now() + REFRESH_POLL_TIMEOUT_MS

        while (Date.now() < deadline) {
          if (signal.aborted) return
          await new Promise<void>((resolve) => setTimeout(resolve, REFRESH_POLL_INTERVAL_MS))
          if (signal.aborted) return
          const detail = await fetchRunDetail(run.id).catch(() => null)
          if (!detail) break
          if (['completed', 'failed', 'cancelled'].includes(detail.status)) {
            if (detail.status !== 'completed') failures.push(`Google sync ${detail.status}`)
            return
          }
        }

        // Deadline reached with the run still going. This used to fall out of
        // the loop recording nothing, so the refresh reported success while the
        // panels below reloaded pre-sync numbers — indistinguishable from "the
        // button did nothing". Say what is actually true instead: the sync is
        // still running and its data will appear on its own.
        notices.push('Google sync is still running — search data will appear shortly')
      }

      // --- Bing: trigger the server-side sweep and poll, like syncGoogle ---
      //
      // This used to loop here, issuing one HTTP call per URL from the browser.
      // Every failure mode traced to that: the sweep died when you navigated
      // away (it is client JS guarded by `signal.aborted`), a cached bundle
      // silently kept the old batch size, and the burst size was tuned in the
      // UI against a limit enforced on the server. Bing throttles per HOST,
      // shared by every project on the instance, so a browser is the wrong
      // place to decide the rate.
      //
      // `bing-inspect-sitemap` already walks the sitemap server-side at ~1
      // req/sec. Triggering it means the run survives closing the tab, the
      // pacing lives in one place, and the CLI/MCP get the same capability —
      // the UI/CLI parity rule this loop was violating.
      async function syncBing() {
        if (!bingConnection?.connected) return
        const run = await inspectBingSitemap(projectName).catch(() => null)
        if (!run?.id) {
          failures.push('Bing sweep could not be started')
          return
        }

        const deadline = Date.now() + REFRESH_POLL_TIMEOUT_MS

        while (Date.now() < deadline) {
          if (signal.aborted) return
          await new Promise<void>((resolve) => setTimeout(resolve, REFRESH_POLL_INTERVAL_MS))
          if (signal.aborted) return
          const detail = await fetchRunDetail(run.id).catch(() => null)
          if (!detail) break
          if (['completed', 'failed', 'cancelled', 'partial'].includes(detail.status)) {
            if (detail.status === 'failed') failures.push('Bing sweep failed')
            else if (detail.status === 'partial') notices.push('Bing sweep finished with some pages unverified')
            return
          }
        }

        // Still running at the deadline. The run continues in the engine — say
        // so rather than reporting a failure the user cannot act on.
        notices.push('Bing sweep is still running — coverage will update shortly')
      }

      const results = await Promise.allSettled([syncGoogle(), syncBing()])
      for (const r of results) {
        if (r.status === 'rejected') {
          failures.push(r.reason instanceof Error ? r.reason.message : 'Sync failed')
        }
      }

      // Invalidate BEFORE the abort check, deliberately.
      //
      // The sweeps ran on the server and the stored coverage changed whether or
      // not this component is still mounted. Discarding the invalidation on
      // unmount is what made a completed refresh look like it never happened:
      // the user navigated away, the cached payload stayed "fresh" for its 60s
      // staleTime, and coming back re-served the PRE-refresh numbers. Cache
      // state is app-wide, so it must not be conditional on this view's life.
      await Promise.all([
        invalidateProjectQueryDomain(queryClient, 'gsc'),
        invalidateProjectQueryDomain(queryClient, 'bing'),
      ])

      if (signal.aborted) return

      // Everything below touches THIS component's state, so it stays guarded.
      setRefreshState('reloading')
      await loadConnectionState(true)
      setWorkspaceRefreshNonce((current) => current + 1)

      if (failures.length > 0) {
        const message = `Partial refresh: ${[...failures, ...notices].join('; ')}`
        setError(message)
        addToast({
          title: 'Search coverage partially refreshed',
          detail: message,
          tone: 'caution',
          dedupeKey: `search-console-refresh:${projectName}`,
          dedupeMode: 'replace',
        })
      } else if (notices.length > 0) {
        // Nothing failed, but the refresh did NOT finish — so it must not claim
        // it did. This branch titled itself "Search coverage refreshed" while
        // the detail said the sweep was still running or had left pages
        // unverified, and it was the only signal a 0-of-45 sweep produced.
        // A user reading the title alone was told the opposite of the truth.
        addToast({
          title: 'Search coverage refresh incomplete',
          detail: notices.join('; '),
          tone: 'caution',
          dedupeKey: `search-console-refresh:${projectName}`,
          dedupeMode: 'replace',
        })
      } else {
        addToast({
          title: 'Search coverage refreshed',
          detail: 'Google and Bing workspaces are reloaded with the latest stored coverage.',
          tone: 'positive',
          dedupeKey: `search-console-refresh:${projectName}`,
          dedupeMode: 'replace',
        })
      }
    } catch (err) {
      if (!signal.aborted) {
        const message = err instanceof Error ? err.message : 'Refresh failed'
        setError(message)
        addToast({
          title: 'Search coverage refresh failed',
          detail: message,
          tone: 'negative',
          dedupeKey: `search-console-refresh:${projectName}`,
          dedupeMode: 'replace',
        })
      }
    } finally {
      if (!signal.aborted) {
        setRefreshState('idle')
      }
    }
  }

  useEffect(() => {
    void loadConnectionState()
    return () => {
      abortRef.current?.abort()
    }
  }, [projectName])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Search engine workspaces">
          {([
            ['google', 'Google'],
            ['bing', 'Bing'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={workspace === key}
              className={`project-subnav-link ${workspace === key ? 'project-subnav-link-active' : ''}`}
              onClick={() => setWorkspace(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {!isEmbed() && (
          <WriteButton
            type="button"
            variant="outline"
            size="sm"
            aria-label="Refresh search data"
            disabled={loading || refreshState !== 'idle'}
            onClick={() => void handleRefresh()}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshState !== 'idle' ? 'animate-spin' : ''}`} aria-hidden="true" />
            {loading ? 'Loading…' : refreshState === 'syncing' ? 'Refreshing search data…' : refreshState === 'reloading' ? 'Reloading workspaces…' : 'Refresh search data'}
          </WriteButton>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-negative-800/40 bg-negative-950/20 px-3 py-2 text-sm text-negative">
          {error}
        </div>
      )}

      {workspace === 'google' && (
        <GscSection projectName={projectName} refreshNonce={workspaceRefreshNonce} />
      )}

      {workspace === 'bing' && (
        <section className="page-section-divider">
          <div className="section-head section-head-inline">
            <div>
              <p className="eyebrow eyebrow-soft">Search engine</p>
              <h2>Bing Webmaster Tools</h2>
            </div>
          </div>
          <BingSection projectName={projectName} refreshNonce={workspaceRefreshNonce} />
        </section>
      )}
    </div>
  )
}

function OverviewMetricRow({
  label,
  summary,
  displayValue,
  tooltip,
}: {
  label: string
  summary: ProjectCommandCenterVm['mentionSummary']
  displayValue?: React.ReactNode
  tooltip?: string
}) {
  const numeric = summary.value.trim() !== '' && Number.isFinite(Number(summary.value))
  const progress = summary.progress !== undefined
    ? Math.min(Math.max(summary.progress, 0), 100)
    : 0

  return (
    <div className="aeo-hero-row">
      <p className="aeo-hero-row-label">
        {label}
        {(tooltip || summary.tooltip) && <InfoTooltip text={tooltip || summary.tooltip || ''} />}
      </p>
      <p className={`aeo-hero-row-value ${METRIC_TONE_TEXT_CLASS[summary.tone]}`}>
        {displayValue ?? (
          <>
            {summary.value}
            {numeric ? <span className="text-faint">%</span> : null}
          </>
        )}
      </p>
      <div className="aeo-hero-row-bar" aria-hidden="true">
        <div
          className={`metric-card-bar-fill progress-fill-${summary.tone}`}
          style={{ width: `${progress}%` }}
        />
      </div>
      <p className="aeo-hero-row-detail">{summary.delta}</p>
    </div>
  )
}

function OverviewBrief({
  model,
  sweepRunning,
}: {
  model: ProjectCommandCenterVm
  sweepRunning: boolean
}) {
  const citationMovement = model.citationMovement
  const mentionMovement = model.mentionMovement
  const comparison = model.movementComparison
  const latestSweep = model.recentRuns.find(run => run.kind === RunKinds['answer-visibility'])

  const movementDirection = (movement: ProjectCommandCenterVm['mentionMovement']) => {
    if (movement.tone === 'positive') return 'improved'
    if (movement.tone === 'negative') return 'declined'
    if (movement.gained > 0 || movement.lost > 0) return 'mixed'
    return 'steady'
  }
  const mentionDirection = movementDirection(mentionMovement)
  const citationDirection = movementDirection(citationMovement)

  const headline = (() => {
    if (sweepRunning) return 'A fresh sweep is running now'
    if (!comparison.hasPreviousRun) return 'Baseline captured. The next sweep will show change.'
    if (comparison.querySetChanged) return 'Tracking scope changed since the previous sweep'
    if (mentionDirection === citationDirection) {
      if (mentionDirection === 'steady') return 'Answer mentions and citation coverage held steady'
      if (mentionDirection === 'mixed') return 'Answer mention and citation movement was mixed'
      return `Answer mentions and citation coverage ${mentionDirection}`
    }
    const mentionPhrase = mentionDirection === 'mixed'
      ? 'Answer mention movement was mixed'
      : mentionDirection === 'steady'
        ? 'Answer mentions held steady'
        : `Answer mentions ${mentionDirection}`
    const citationPhrase = citationDirection === 'mixed'
      ? 'citation movement was mixed'
      : citationDirection === 'steady'
        ? 'citation coverage held steady'
        : `citation coverage ${citationDirection}`
    return `${mentionPhrase}; ${citationPhrase}`
  })()

  const scopeChange = [
    comparison.addedQueryCount > 0 && `${comparison.addedQueryCount} ${comparison.addedQueryCount === 1 ? 'query' : 'queries'} added`,
    comparison.removedQueryCount > 0 && `${comparison.removedQueryCount} ${comparison.removedQueryCount === 1 ? 'query' : 'queries'} removed`,
  ].filter(Boolean).join(', ')
  const comparableScope = `${comparison.comparableQueryCount} comparable ${comparison.comparableQueryCount === 1 ? 'query' : 'queries'}`

  return (
    <section className="overview-brief" aria-labelledby="overview-brief-title">
      <div className="overview-brief-head">
        <div>
          <p className="eyebrow eyebrow-soft">
            Visibility
            <InfoTooltip text="Each sweep records two independent signals: answer mentions (your brand named in the answer text) and source citations (your domain in the engine's source list). They move separately." />
          </p>
          <h2 id="overview-brief-title" className="overview-brief-title">{headline}</h2>
        </div>
        <p className="overview-brief-updated">
          {latestSweep ? `Updated ${latestSweep.startedAt}` : 'No completed sweep'}
        </p>
      </div>

      <div className="overview-brief-grid">
        <div className="overview-brief-panel overview-brief-coverage">
          <p className="overview-brief-label">Coverage now</p>
          <div className="aeo-hero-rows">
            <OverviewMetricRow label="Mentioned" summary={model.mentionSummary} />
            <OverviewMetricRow label="Cited" summary={model.visibilitySummary} />
          </div>
          {model.mentionSummary.providerCoverage && (
            <p className="overview-brief-note">Partial sweep: {model.mentionSummary.providerCoverage}</p>
          )}
        </div>

        <div className="overview-brief-panel">
          <p className="overview-brief-label">Since last sweep</p>
          {!comparison.hasPreviousRun ? (
            <>
              <p className="overview-brief-panel-title">No comparison yet</p>
              <p className="overview-brief-panel-copy">Run another sweep to measure mention and citation movement.</p>
            </>
          ) : (
            <>
              <div className="overview-signal-change-list">
                <div className="overview-signal-change-row">
                  <span className="overview-signal-change-label">Mentioned</span>
                  {mentionMovement.gained === 0 && mentionMovement.lost === 0 ? (
                    <span className="text-secondary">No change</span>
                  ) : (
                    <span className="flex gap-3 tabular-nums">
                      {mentionMovement.gained > 0 && <span className="text-positive-400">+{mentionMovement.gained}</span>}
                      {mentionMovement.lost > 0 && <span className="text-negative-400">-{mentionMovement.lost}</span>}
                    </span>
                  )}
                </div>
                <div className="overview-signal-change-row">
                  <span className="overview-signal-change-label">Cited</span>
                  {citationMovement.gained === 0 && citationMovement.lost === 0 ? (
                    <span className="text-secondary">No change</span>
                  ) : (
                    <span className="flex gap-3 tabular-nums">
                      {citationMovement.gained > 0 && <span className="text-positive-400">+{citationMovement.gained}</span>}
                      {citationMovement.lost > 0 && <span className="text-negative-400">-{citationMovement.lost}</span>}
                    </span>
                  )}
                </div>
              </div>
              <p className={`overview-brief-panel-copy ${comparison.querySetChanged ? 'text-caution-400/80' : ''}`}>
                {comparison.querySetChanged
                  ? `${scopeChange || 'Query set changed'} · ${comparableScope}.`
                  : `${comparableScope}.`}
              </p>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

function OverviewDisclosure({
  id,
  eyebrow,
  title,
  meta,
  defaultOpen = false,
  children,
}: {
  id?: string
  eyebrow: string
  title: string
  meta?: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  return (
    <details id={id} className="overview-disclosure page-section-divider scroll-mt-24" open={defaultOpen || undefined}>
      <summary className="overview-disclosure-summary">
        <span>
          <span className="eyebrow eyebrow-soft">{eyebrow}</span>
          <span className="overview-disclosure-title">{title}</span>
        </span>
        <span className="overview-disclosure-meta">
          {meta && <span>{meta}</span>}
          <ChevronDown className="overview-disclosure-icon" size={16} aria-hidden="true" />
        </span>
      </summary>
      <div className="overview-disclosure-body">{children}</div>
    </details>
  )
}

function OverviewSignals({
  insights,
  suggestedQueries,
  projectName,
}: {
  insights: ProjectCommandCenterVm['insights']
  suggestedQueries: ProjectCommandCenterVm['suggestedQueries']
  projectName: string
}) {
  const { openEvidence } = useDrawer()
  const appendQueries = useAppendQueries()
  const [pendingQueries, setPendingQueries] = useState<Set<string>>(new Set())

  if (insights.length === 0 && suggestedQueries.rows.length === 0) return null

  const clearPending = (query: string) => {
    setPendingQueries(current => {
      const next = new Set(current)
      next.delete(query)
      return next
    })
  }

  const handleTrackQuery = (query: string) => {
    setPendingQueries(current => new Set(current).add(query))
    appendQueries.mutate(
      { projectName, queries: [query] },
      {
        onSuccess: () => {
          addToast({ tone: 'positive', title: `Tracking "${query}"` })
          clearPending(query)
        },
        onError: (error) => {
          addToast({ tone: 'negative', title: `Could not track "${query}"`, detail: String(error) })
          clearPending(query)
        },
      },
    )
  }

  const renderInsight = (insight: ProjectCommandCenterVm['insights'][number]) => (
    <div key={insight.id} className="py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-heading">{insight.title}</p>
          {insight.detail ? <p className="mt-1 max-w-3xl text-sm leading-6 text-secondary">{insight.detail}</p> : null}
        </div>
        <ToneBadge tone={insight.tone}>{insight.actionLabel}</ToneBadge>
      </div>

      {insight.affectedPhrases.length > 0 ? (
        <details className="mt-2">
          <summary className="w-fit cursor-pointer text-sm font-medium text-secondary transition-colors hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500/60">
            Evidence · {insight.affectedPhrases.length} affected {insight.affectedPhrases.length === 1 ? 'query' : 'queries'}
          </summary>
          <ul className="mt-2 divide-y divide-subtle border-y border-subtle">
            {insight.affectedPhrases.map((phrase, index) => (
              <li key={phrase.evidenceId || `${insight.id}-${index}`} className="flex flex-wrap items-center gap-2 py-2">
                <CitationBadge state={phrase.citationState} />
                <span className="min-w-0 flex-1 text-sm text-strong">{phrase.query}</span>
                {phrase.provider ? <ProviderBadge provider={phrase.provider} /> : null}
                {!isEmbed() && phrase.evidenceId ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => { void openEvidence(phrase.evidenceId) }}>
                    View evidence
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  )

  const renderSuggestion = (suggestion: ProjectCommandCenterVm['suggestedQueries']['rows'][number]) => {
    const isPending = pendingQueries.has(suggestion.query)
    return (
      <div key={suggestion.query} className="flex items-center justify-between gap-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Suggested query</p>
          <p className="mt-1 text-sm font-medium text-strong">{suggestion.query}</p>
          <p className="mt-0.5 text-sm text-secondary">{suggestion.reason}</p>
        </div>
        {!isEmbed() ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isPending}
            aria-label={`Track query "${suggestion.query}"`}
            onClick={() => handleTrackQuery(suggestion.query)}
          >
            {isPending ? 'Tracking…' : 'Track'}
          </Button>
        ) : null}
      </div>
    )
  }

  const primaryInsights = insights.slice(0, 1)
  const primarySuggestions = suggestedQueries.rows.slice(0, 1)
  const remainingInsights = insights.slice(1)
  const remainingSuggestions = suggestedQueries.rows.slice(1)
  const remainingCount = remainingInsights.length + remainingSuggestions.length

  return (
    <section className="page-section-divider" aria-labelledby="overview-signals-title">
      <div className="section-head">
        <h2 id="overview-signals-title">Latest signals</h2>
      </div>

      <div className="divide-y divide-default border-y border-default">
        {primaryInsights.map(renderInsight)}
        {primarySuggestions.map(renderSuggestion)}
      </div>
      {remainingCount > 0 ? (
        <details className="mt-2">
          <summary className="w-fit cursor-pointer text-sm font-medium text-secondary transition-colors hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-500/60">
            {remainingCount} more {remainingCount === 1 ? 'signal' : 'signals'}
          </summary>
          <div className="mt-2 divide-y divide-default border-y border-default">
            {remainingInsights.map(renderInsight)}
            {remainingSuggestions.map(renderSuggestion)}
          </div>
        </details>
      ) : null}
    </section>
  )
}

/**
 * Thin shell that guards on project-dashboard readiness. The real
 * component (`ProjectPageContent`) declares all the page's ~60 hooks,
 * and React requires the same hook count on every render of a given
 * component instance. Inlining the early-return-then-hooks pattern
 * here (as the original code did before this refactor) trips React
 * error #310 the first time the query cache is cold, because the
 * loading-branch render calls fewer hooks than the loaded-branch
 * render that follows. See PR #592 for the matching fix on the
 * pre-refactor code path.
 */
export function ProjectPage(props: { tab: ProjectPageTab }) {
  const { projectName: routeIdentifier } = useParams({ from: '/projects/$projectName' })
  // The URL carries the project name (the canonical identifier). Match by name
  // first; fall back to matching by id so a legacy UUID-shaped URL that wasn't
  // caught by the route-level redirect (e.g. cold cache, SSR) still resolves.
  // Prefer the SSR/test fixture (synchronous, no query needed); otherwise hit
  // the shared `/projects` cache that `useDashboardOverview` populates.
  const contextDashboard = useInitialDashboard()
  const nameFromContext = contextDashboard?.dashboard.projects.find(
    p => p.project.name === routeIdentifier || p.project.id === routeIdentifier,
  )?.project.name ?? null
  const projectsListQuery = useQuery({
    ...getApiV1ProjectsOptions({ client: heyClient }),
    enabled: !nameFromContext,
  })
  const lookupProjectName = nameFromContext
    ?? projectsListQuery.data?.find(p => p.name === routeIdentifier || p.id === routeIdentifier)?.name
    ?? null
  const {
    commandCenter: model,
    isLoading: dashboardLoading,
    latestVisibilityRevision,
    refetch,
  } = useProjectDashboard(lookupProjectName)
  const isLoading = (!nameFromContext && projectsListQuery.isLoading) || dashboardLoading

  // Not-found state: both context and the projects-list query resolved
  // (loading is done), but neither could match the URL's identifier to a
  // known project. Render the explicit not-found rather than the
  // indefinite skeleton so the user can navigate away.
  const isNotFound = !lookupProjectName
    && !nameFromContext
    && projectsListQuery.isSuccess
    && !dashboardLoading

  if (isNotFound) {
    return (
      <div className="page-container">
        <Card className="surface-card empty-card">
          <h1>Project not found</h1>
          <p>Could not find a project named "{routeIdentifier}".</p>
          <Button asChild>
            <Link to="/">Return to overview</Link>
          </Button>
        </Card>
      </div>
    )
  }

  if (!model || isLoading) {
    return (
      <div className="page-skeleton">
        <div className="page-skeleton-header">
          <div className="skeleton-text h-6 w-48" />
          <div className="skeleton-text-sm w-32" />
        </div>
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="page-skeleton-card flex flex-col items-center">
              <div className="skeleton-circle size-20" />
              <div className="skeleton-text w-16 mt-3" />
            </div>
          ))}
        </div>
        <div className="page-skeleton-card">
          <div className="skeleton-text w-28" />
          <div className="space-y-2 mt-2">
            {[1, 2, 3, 4].map((j) => (
              <div key={j} className="skeleton-text-sm w-full" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  return <ProjectPageContent
    model={model}
    refetch={refetch}
    latestVisibilityRevision={latestVisibilityRevision}
    {...props}
  />
}

type ProjectTabItem = { key: ProjectPageTab; label: string; href: string }

function preserveRunDrawerSearch(previous: Record<string, unknown>) {
  return typeof previous.runId === 'string' ? { runId: previous.runId } : {}
}

/**
 * Trailing overflow ("More") menu for low-frequency project sections (Report).
 * A standard disclosure: button toggles a `role="menu"`, closes on outside
 * pointerdown, Escape, or item selection. Self-contained so its hooks don't
 * sit below ProjectPageContent's early returns. Lives here (not in its own
 * file) because it's a one-off for this subnav.
 */
function ProjectSubnavMore({ items, activeTab }: { items: ProjectTabItem[]; activeTab: ProjectPageTab }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (items.length === 0) return null
  const hasActive = items.some((item) => item.key === activeTab)

  return (
    <div className="project-subnav-more" ref={ref}>
      <button
        type="button"
        className={`project-subnav-link project-subnav-more-trigger ${hasActive ? 'project-subnav-link-active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        More
        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open ? (
        <div className="project-subnav-menu" role="menu">
          {items.map((item) => (
            <Link
              key={item.key}
              to={item.href}
              search={preserveRunDrawerSearch}
              role="menuitem"
              className={`project-subnav-menu-item ${item.key === activeTab ? 'project-subnav-menu-item-active' : ''}`}
              aria-current={item.key === activeTab ? 'page' : undefined}
              onClick={() => setOpen(false)}
            >
              {item.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ProjectPageContent({
  tab: requestedTab,
  model,
  refetch,
  latestVisibilityRevision,
}: {
  tab: ProjectPageTab
  model: ProjectCommandCenterVm
  refetch: () => Promise<void>
  latestVisibilityRevision: string
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { canWrite } = useAccount()
  // Read-only embed mode (#716): an optional project-tab allowlist hides operator
  // surfaces (Search Engines, Activity, Backlinks, ...) from the embedded client
  // dashboard. Unset (or non-embed) = all tabs. The subnav below is filtered to
  // the allowlist; a direct-URL hit on a hidden tab falls back to a visible board.
  const embedProjectTabs = useMemo(() => {
    const embed = getEmbedConfig()
    return embed ? filterEmbedProjectTabs(embed.projectTabs) : undefined
  }, [])
  const tab = resolveEmbedProjectTab(requestedTab, embedProjectTabs)
  const competitorDomains = useMemo(() => model.competitors.map(c => c.domain), [model.competitors])
  // "Local Presence" is always shown — GbpSection renders a setup guide when no
  // Google Business Profile is connected, so the tab is the entry point to
  // connecting one rather than being hidden until after connection.
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const appendQueries = useAppendQueries()
  const projectSearchParams = useSearch({ strict: false }) as {
    manageQueries?: boolean
    queries?: 'tracked' | 'discover' | 'test'
    runId?: string
    siteHealthRunId?: string
    scope?: string
    class?: string
  }
  const manageQueriesRequested = projectSearchParams.manageQueries === true
  const releaseInitialSiteHealthRun = useCallback(() => {
    void navigate({
      to: '.',
      replace: true,
      search: (previous: Record<string, unknown>) => ({ ...previous, siteHealthRunId: undefined }),
    })
  }, [navigate])
  const [addingCompetitor, setAddingCompetitor] = useState(false)
  const [newCompetitorDomain, setNewCompetitorDomain] = useState('')
  const [competitorSaving, setCompetitorSaving] = useState(false)
  const [locationFilter, setLocationFilter] = useState<string | undefined>(undefined)
  const [compareLocations, setCompareLocations] = useState(false)
  const [competitorFilter, setCompetitorFilter] = useState<string | null>(null)
  const [locationTimeline, setLocationTimeline] = useState<import('../api.js').ApiTimelineEntry[] | null>(null)
  const [_locationTimelineLoading, setLocationTimelineLoading] = useState(false)
  // Scope and query class come from the URL so a market is a place you can
  // link, bookmark and reload — at hundreds of markets, re-picking one after
  // every navigation IS the interaction. `search` stays local: it changes on
  // every keystroke and belongs in neither the URL nor the history stack.
  const urlMeasurementView = parseMeasurementViewSearch(projectSearchParams)
  const [advancedMeasurementSearch, setAdvancedMeasurementSearch] = useState<string | undefined>(undefined)
  // Sort is a within-view refinement, not what the page is ABOUT, so it stays
  // in component state rather than the URL alongside scope and class.
  const [advancedMeasurementSort, setAdvancedMeasurementSort] = useState<MeasurementOverviewSort | undefined>(undefined)
  const setAdvancedMeasurementView = useCallback((next: {
    scope: 'all' | 'group'
    groupKey?: string
    queryClass: 'all' | 'non-brand' | 'branded'
    search?: string
    sort?: MeasurementOverviewSort
  }) => {
    setAdvancedMeasurementSearch(next.search)
    if (next.sort) setAdvancedMeasurementSort(next.sort)
    // Scope and class are deliberate, low-frequency choices, so they PUSH:
    // pressing back after picking a market should return to the previous
    // market, which is what a reader expects of a control that changes what
    // the page is about.
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, ...measurementViewSearch(next) }),
      replace: false,
    })
  }, [navigate])
  const [hasExpandedAdvancedProperty, setHasExpandedAdvancedProperty] = useState(false)

  const visibilityEvidence = model?.visibilityEvidence ?? []
  const projectName = model?.project.name ?? ''
  const projectLabel = model?.project.displayName || model?.project.name || projectName
  // `manageQueries` was an overview-local drawer state. Preserve old links by
  // translating it once into the stable Queries URL, retaining a run drawer or
  // any other valid project search state while clearing the legacy flag.
  useEffect(() => {
    if (!manageQueriesRequested || !projectName) return
    void navigate({
      to: '/projects/$projectName/discovery',
      params: { projectName },
      search: (previous: Record<string, unknown>) => ({
        ...previous,
        manageQueries: undefined,
        queries: 'tracked' as const,
      }),
      replace: true,
    })
  }, [manageQueriesRequested, navigate, projectName])
  const triggerRunMutation = useTriggerRun()
  const portfolioQueriesQuery = useQuery({
    ...getApiV1ProjectsByNameQueriesOptions({ client: heyClient, path: { name: projectName } }),
    enabled: tab === 'portfolio' && Boolean(projectName),
    staleTime: 0,
    refetchOnMount: 'always',
  })
  // The header states when the next AI sweep fires. On a managed instance the
  // sweep is scheduled, so "it runs itself" is the honest headline and the
  // manual trigger beside it is the override. `nextRunAt` is computed from the
  // cron server-side (`schedules.ts`) — the browser never parses a cron.
  // 404 means no schedule for this project, which the query surfaces as an
  // error and the header renders as nothing.
  const sweepScheduleQuery = useQuery({
    ...getApiV1ProjectsByNameScheduleOptions({ client: heyClient, path: { name: projectName } }),
    enabled: !isEmbed() && Boolean(projectName),
    retry: false,
  })
  const activeMeasurementPlanQuery = useQuery({
    ...getApiV1ProjectsByNameMeasurementPlanOptions({ client: heyClient, path: { name: projectName } }),
    enabled: !isEmbed() && (tab === 'portfolio' || tab === 'overview' || tab === 'settings') && Boolean(projectName),
    staleTime: 0,
    refetchOnMount: 'always',
  })
  const measurementSetupQuery = useQuery({
    ...getApiV1ProjectsByNameMeasurementSetupOptions({ client: heyClient, path: { name: projectName } }),
    enabled: !isEmbed() && (tab === 'portfolio' || tab === 'overview' || tab === 'settings') && Boolean(projectName),
    staleTime: 0,
    refetchOnMount: 'always',
  })
  // Only claim a next sweep when one is genuinely coming: a schedule that
  // exists, is enabled, and carries a next-run time. A disabled schedule still
  // returns a row with a stale `nextRunAt`, and announcing that would promise a
  // sweep that never fires.
  const sweepSchedule = sweepScheduleQuery.data
  const nextSweepLabel = sweepSchedule?.enabled && sweepSchedule.nextRunAt
    ? `Next AI sweep ${new Date(sweepSchedule.nextRunAt).toLocaleString()}`
    : null
  const activeMeasurementPlan = activeMeasurementPlanQuery.data?.active ?? null

  // A bookmark outlives the group it names. Once the plan has actually loaded
  // and we can see which groups exist, a URL naming one that does not is
  // resolved to all-properties BEFORE any request goes out — otherwise the page
  // asks the server for a scope that cannot exist and paints a skeleton at
  // someone who simply followed an old link. While the plan is still in flight
  // the key is left alone: absence of an answer is not evidence the group is
  // gone.
  const planGroupKeysLoaded = activeMeasurementPlanQuery.data !== undefined
  const planGroupKeys = new Set(
    activeMeasurementPlan && Number(activeMeasurementPlan.plan.schemaVersion) === 2
      ? (activeMeasurementPlan.plan as { groups?: { stableKey: string }[] }).groups?.map(group => group.stableKey) ?? []
      : [],
  )
  const measurementScopeIsStale = urlMeasurementView.scope === 'group'
    && Boolean(urlMeasurementView.groupKey)
    && planGroupKeysLoaded
    && !planGroupKeys.has(urlMeasurementView.groupKey!)
  const advancedMeasurementView = {
    ...(measurementScopeIsStale
      ? { scope: 'all' as const, queryClass: urlMeasurementView.queryClass }
      : urlMeasurementView),
    ...(advancedMeasurementSearch ? { search: advancedMeasurementSearch } : {}),
  }
  const activeMeasurementPlanSchemaVersion = activeMeasurementPlan === null
    ? null
    : Number(activeMeasurementPlan.plan.schemaVersion)
  const activeMeasurementRevision = activeMeasurementPlan?.revision ?? 0
  // Reset the view only when the plan it belongs to actually CHANGES. The
  // identity is null until the plan resolves, and the first identity we ever
  // see is not a change — see `shouldResetMeasurementView`, which is where the
  // two "not a change" cases are pinned by tests.
  const measurementPlanIdentity = planGroupKeysLoaded
    ? `${projectName}:${activeMeasurementRevision}`
    : null
  const lastMeasurementPlanIdentity = useRef<string | null>(null)
  useEffect(() => {
    const previous = lastMeasurementPlanIdentity.current
    if (measurementPlanIdentity !== null) lastMeasurementPlanIdentity.current = measurementPlanIdentity
    if (!shouldResetMeasurementView(previous, measurementPlanIdentity)) return
    setAdvancedMeasurementView(DEFAULT_MEASUREMENT_VIEW)
    setHasExpandedAdvancedProperty(false)
  }, [measurementPlanIdentity, setAdvancedMeasurementView])
  const advancedMeasurementOverviewQueryInput = {
    client: heyClient,
    path: { name: projectName },
    query: {
      scope: advancedMeasurementView.scope,
      ...(advancedMeasurementView.groupKey ? { groupKey: advancedMeasurementView.groupKey } : {}),
      queryClass: advancedMeasurementView.queryClass,
      ...(advancedMeasurementView.search ? { search: advancedMeasurementView.search } : {}),
      ...(advancedMeasurementSort ? { sort: advancedMeasurementSort } : {}),
      limit: 50,
    },
  } as const
  const advancedMeasurementOverviewQuery = useInfiniteQuery({
    ...getApiV1ProjectsByNameMeasurementOverviewInfiniteOptions(advancedMeasurementOverviewQueryInput),
    enabled: tab === 'overview'
      && Boolean(projectName)
      && activeMeasurementPlanSchemaVersion === 2,
    initialPageParam: advancedMeasurementOverviewQueryInput,
    getNextPageParam: (lastPage, pages) => {
      if (!lastPage.properties.nextCursor) return undefined
      const displayedRunId = pages[0]?.measurement.displayedRunId
      return {
        path: advancedMeasurementOverviewQueryInput.path,
        query: {
          ...advancedMeasurementOverviewQueryInput.query,
          cursor: lastPage.properties.nextCursor,
          ...(displayedRunId ? { runId: displayedRunId } : {}),
        },
      }
    },
    placeholderData: keepPreviousData,
    staleTime: 0,
    refetchOnMount: 'always',
  })
  const advancedMeasurementDisplayedRunId = advancedMeasurementOverviewQuery.data?.pages[0]?.measurement.displayedRunId
  const advancedMeasurementReportQuery = useQuery({
    ...getApiV1ProjectsByNameMeasurementReportOptions({
      client: heyClient,
      path: { name: projectName },
      query: {
        revision: activeMeasurementRevision,
        ...(advancedMeasurementDisplayedRunId
          ? { runId: advancedMeasurementDisplayedRunId }
          : {}),
      },
    }),
    enabled: tab === 'overview'
      && Boolean(projectName)
      && activeMeasurementPlan !== null
      && (activeMeasurementPlanSchemaVersion === 1
        || hasExpandedAdvancedProperty && advancedMeasurementDisplayedRunId !== undefined),
    staleTime: 0,
    refetchOnMount: 'always',
  })
  const hasCachedMeasurementPlan = activeMeasurementPlanQuery.data !== undefined
  const hasCachedPortfolioQueries = portfolioQueriesQuery.data !== undefined
  const isActiveMeasurementPlanLoading = activeMeasurementPlanQuery.isPending && !hasCachedMeasurementPlan
  const isActiveMeasurementPlanError = activeMeasurementPlanQuery.isError && !hasCachedMeasurementPlan
  const isPortfolioQueriesLoading = portfolioQueriesQuery.isPending && !hasCachedPortfolioQueries
  const isPortfolioQueriesError = portfolioQueriesQuery.isError && !hasCachedPortfolioQueries
  const hasCachedAdvancedMeasurementReport = advancedMeasurementReportQuery.data !== undefined
  const advancedMeasurementMode = resolveAdvancedMeasurementMode({
    activePlanSchemaVersion: measurementSetupQuery.data?.activeSchemaVersion ?? activeMeasurementPlanSchemaVersion,
    hasDraft: measurementSetupQuery.data?.draft !== null && measurementSetupQuery.data?.draft !== undefined,
  })
  /**
   * Which overview to show is not known until one of the two plan reads lands.
   * Until then the expression above is `undefined ?? null`, and `null` is what
   * `resolveAdvancedMeasurementMode` reads as "this project has no plan" — so a
   * project WITH a plan rendered the legacy overview first and swapped it out a
   * moment later. Pending and absent cannot share a value here.
   *
   * Known as soon as EITHER read has data, because the setup read only refines
   * a decision the plan read can already make (it is the `??` fallback above).
   * Waiting on both would hold a skeleton over an answer already in hand.
   *
   * `isLoading`, not `isPending`: both queries are disabled on tabs that do not
   * read the plan, and a disabled TanStack v5 query reports `isPending` forever,
   * which would strand those tabs on a skeleton. `isLoading` is false when
   * disabled and false while refetching over cached data, so this fires once per
   * cold load and never again. Once both have settled — data or error — `null`
   * means what it says, and the legacy overview is the right answer.
   */
  const isMeasurementModeUnresolved =
    measurementSetupQuery.data === undefined
    && activeMeasurementPlanQuery.data === undefined
    && (activeMeasurementPlanQuery.isLoading || measurementSetupQuery.isLoading)
  const measurementSetupDisplayState = measurementSetupQuery.data !== undefined
    ? 'success' as const
    : measurementSetupQuery.isError
      ? 'error' as const
      : 'pending' as const
  const advancedMeasurementOverviewPagesInconsistent = useMemo(() => {
    const pages = advancedMeasurementOverviewQuery.data?.pages
    return pages ? !areV2OverviewPagesCompatible(pages) : false
  }, [advancedMeasurementOverviewQuery.data])
  const mergedAdvancedMeasurementOverview = useMemo(() => {
    const pages = advancedMeasurementOverviewQuery.data?.pages
    const firstPage = pages?.[0]
    const lastPage = pages?.at(-1)
    if (!firstPage || !lastPage || advancedMeasurementOverviewPagesInconsistent) return undefined
    return {
      ...firstPage,
      properties: {
        ...firstPage.properties,
        items: pages.flatMap(page => page.properties.items),
        nextCursor: lastPage.properties.nextCursor,
      },
    }
  }, [advancedMeasurementOverviewPagesInconsistent, advancedMeasurementOverviewQuery.data])
  const advancedMeasurementPortfolioSummaryQuery = useQuery({
    ...getApiV1ProjectsByNameMeasurementPortfolioSummaryOptions({
      client: heyClient,
      path: { name: projectName },
      query: {
        queryClass: advancedMeasurementView.queryClass,
        ...(advancedMeasurementView.scope === 'group' && advancedMeasurementView.groupKey
          ? { groupKey: advancedMeasurementView.groupKey }
          : {}),
        ...(advancedMeasurementDisplayedRunId
          ? { runId: advancedMeasurementDisplayedRunId }
          : {}),
      },
    }),
    enabled: tab === 'overview'
      && Boolean(projectName)
      && activeMeasurementPlanSchemaVersion === 2
      && mergedAdvancedMeasurementOverview !== undefined,
    staleTime: 0,
    refetchOnMount: 'always',
  })
  const advancedMeasurementReport = useMemo(() => {
    if (!activeMeasurementPlan) return undefined
    if (activeMeasurementPlan.plan.schemaVersion === 1) {
      return advancedMeasurementReportQuery.data
        ? adaptVersionOneMeasurementReport(activeMeasurementPlan, advancedMeasurementReportQuery.data)
        : undefined
    }
    return mergedAdvancedMeasurementOverview
      ? adaptV2MeasurementOverview({
          overview: mergedAdvancedMeasurementOverview,
          activePlan: activeMeasurementPlan,
          sort: advancedMeasurementSort,
          report: advancedMeasurementReportQuery.data,
          reportState: mergedAdvancedMeasurementOverview.measurement.displayedRunId === undefined
            ? 'ready'
            : advancedMeasurementReportQuery.isFetching && advancedMeasurementReportQuery.data === undefined
            ? 'loading'
            : advancedMeasurementReportQuery.isError && advancedMeasurementReportQuery.data === undefined
            ? 'error'
            : advancedMeasurementReportQuery.data
              ? 'ready'
              : 'loading',
        })
      : undefined
  }, [
    activeMeasurementPlan,
    advancedMeasurementReportQuery.data,
    advancedMeasurementReportQuery.isError,
    advancedMeasurementReportQuery.isFetching,
    mergedAdvancedMeasurementOverview,
  ])
  const advancedMeasurementReportState = activeMeasurementPlanSchemaVersion === 2
    ? advancedMeasurementOverviewPagesInconsistent
      ? 'error' as const
      : advancedMeasurementOverviewQuery.isPending
      ? 'loading' as const
      : advancedMeasurementOverviewQuery.isError && advancedMeasurementReport === undefined
        ? 'error' as const
        : 'ready' as const
    : advancedMeasurementReportQuery.isPending && !hasCachedAdvancedMeasurementReport
      ? 'loading' as const
      : advancedMeasurementReportQuery.isError && !hasCachedAdvancedMeasurementReport
        ? 'error' as const
        : 'ready' as const
  const advancedMeasurementPortfolioSummaryState = advancedMeasurementPortfolioSummaryQuery.data !== undefined
    ? 'ready' as const
    : advancedMeasurementPortfolioSummaryQuery.isError
      ? 'error' as const
      : 'loading' as const
  const hasActiveVisibilitySweep = (model?.recentRuns ?? []).some(
    r => r.kind === RunKinds['answer-visibility'] && (r.status === RunStatuses.running || r.status === RunStatuses.queued),
  )

  // Show every configured location as a filter chip, regardless of whether the
  // current evidence aggregate has rows for it. Multi-location sweeps can land
  // a chip-less location whenever the latest-run aggregate drops snapshots; we
  // still want the user to be able to select it (the table renders an empty
  // state if there are no matching rows).
  const configuredLocationLabels = useMemo(
    () => (model?.project.locations ?? []).map((loc: { label: string }) => loc.label),
    [model?.project.locations],
  )
  const locationLabelsInEvidence = useMemo(() => new Set(visibilityEvidence.map(e => e.location ?? '')), [visibilityEvidence])
  const hasNullLocationEvidence = locationLabelsInEvidence.has('')
  const distinctLocationsForCompare = useMemo(() => {
    // "Compare" needs ≥2 locations with selectable data. Prefer evidence-backed
    // locations, but fall back to configured locations so a fresh project that
    // hasn't aggregated evidence yet still surfaces the compare control once
    // it has multiple locations configured.
    const evidenceLabels = [...locationLabelsInEvidence].filter(Boolean)
    if (evidenceLabels.length > 1) return evidenceLabels
    return configuredLocationLabels
  }, [locationLabelsInEvidence, configuredLocationLabels])

  useEffect(() => {
    if (locationFilter === undefined || locationFilter === '' || !projectName) {
      setLocationTimeline(null)
      setLocationTimelineLoading(false)
      return
    }
    setLocationTimelineLoading(true)
    fetchTimeline(projectName, locationFilter, 20)
      .then(tl => { setLocationTimeline(tl); setLocationTimelineLoading(false) })
      .catch(() => { setLocationTimeline(null); setLocationTimelineLoading(false) })
  }, [locationFilter, projectName])

  // Build a runHistory override map keyed by query::provider from the location-scoped timeline
  const locationRunHistoryMap = useMemo<Map<string, RunHistoryPoint[]> | null>(() => {
    if (!locationTimeline) return null
    const map = new Map<string, RunHistoryPoint[]>()
    for (const entry of locationTimeline) {
      for (const [provider, runs] of Object.entries(entry.providerRuns ?? {})) {
        map.set(`${entry.query}::${provider}`, runs.map(r => ({
          runId: r.runId,
          citationState: r.citationState,
          createdAt: r.createdAt,
          answerMentioned: r.answerMentioned,
          visibilityState: r.visibilityState as RunHistoryPoint['visibilityState'] | undefined,
          visibilityTransition: r.visibilityTransition,
          mentionState: r.mentionState as RunHistoryPoint['mentionState'] | undefined,
          mentionTransition: r.mentionTransition,
        })))
      }
      // Fallback: query-level history when no per-provider data
      if (!entry.providerRuns || Object.keys(entry.providerRuns).length === 0) {
        map.set(`${entry.query}::`, entry.runs.map(r => ({
          runId: r.runId,
          citationState: r.citationState,
          createdAt: r.createdAt,
          answerMentioned: r.answerMentioned,
          visibilityState: r.visibilityState as RunHistoryPoint['visibilityState'] | undefined,
          visibilityTransition: r.visibilityTransition,
          mentionState: r.mentionState as RunHistoryPoint['mentionState'] | undefined,
          mentionTransition: r.mentionTransition,
        })))
      }
    }
    return map
  }, [locationTimeline])

  const filteredEvidence = useMemo(() => {
    let filtered = locationFilter !== undefined
      ? visibilityEvidence.filter(e => locationFilter === '' ? !e.location : e.location === locationFilter)
      : visibilityEvidence
    if (competitorFilter) {
      const needle = competitorFilter.toLowerCase()
      // Neutral navigation union: a competitor may be present in answer text,
      // source links, or a legacy mixed row. Signal-labelled evidence views
      // use the split fields and never infer one signal from this filter.
      filtered = filtered.filter(e => e.competitorDomains.some(d => d.toLowerCase() === needle))
    }
    if (!locationRunHistoryMap) return filtered
    return filtered.map(item => {
      const history = locationRunHistoryMap.get(`${item.query}::${item.provider}`)
        ?? locationRunHistoryMap.get(`${item.query}::`)
      return history ? { ...item, runHistory: history } : item
    })
  }, [visibilityEvidence, locationFilter, competitorFilter, locationRunHistoryMap])

  // `if (!model)` branch removed — the wrapper guarantees `model` is set
  // by the time we render `ProjectPageContent`. The wrapper also owns the
  // "project not found" state (when both context and /projects list have
  // resolved but neither matched the URL's identifier).

  async function handleTriggerRun() {
    try {
      await triggerRunMutation.mutateAsync({
        projectName,
        projectLabel,
        sourceAction: 'project-run',
      })
      void refetch()
    } catch {
      // Mutation hook surfaces the toast and error state.
    }
  }

  async function handleDeleteProject() {
    setDeleting(true)
    try {
      await apiDeleteProject(projectName)
      addToast({
        title: 'Project deleted',
        detail: `${projectLabel} was removed.`,
        tone: 'positive',
        dedupeKey: `project:delete:${projectName}`,
        dedupeMode: 'drop',
      })
      void navigate({ to: '/' })
      void refetch()
    } catch (err) {
      console.error('Failed to delete project:', err)
    } finally {
      setDeleting(false)
    }
  }

  async function handleAddCompetitor() {
    const domain = newCompetitorDomain.trim()
    if (!domain) return
    setCompetitorSaving(true)
    try {
      await apiAppendCompetitors(projectName, [domain])
      // No `['analytics-metrics', projectName]` invalidation — same mechanism
      // as the answer-visibility case in `queries/run-invalidations.ts`. The
      // trend key's `metricsFrameKey` segment is `competitorFrameKey(...)` of
      // `model.competitors`, i.e. the exact DB list the server builds the
      // mention-share denominator from. `refetch()` reloads that list, the
      // frame key rotates, and the chart mounts a new key — one fetch.
      // Invalidating first refetched the outgoing key too: a second
      // full-history analytics scan whose result is unreachable once the
      // frame key moves. If `refetch()` fails, the project detail query polls
      // every PROJECT_DETAIL_REFRESH_MS, so the rotation still lands.
      void refetch()
      setNewCompetitorDomain('')
      setAddingCompetitor(false)
    } finally {
      setCompetitorSaving(false)
    }
  }

  async function handleRemoveCompetitor(domain: string) {
    const competitor = model.competitors.find(c => c.domain === domain)
    if (!competitor) {
      addToast({
        title: 'Could not remove competitor',
        detail: `Could not find ${domain} in the tracked competitor list`,
        tone: 'negative',
        dedupeKey: 'competitor:remove',
        dedupeMode: 'replace',
      })
      return
    }

    try {
      await apiRemoveCompetitorById(projectName, competitor.id)
      // See handleAddCompetitor: the frame key rotation is the refetch.
      void refetch()
    } catch (err) {
      addToast({
        title: 'Could not remove competitor',
        detail: err instanceof Error ? err.message : `Failed to remove ${competitor.domain}`,
        tone: 'negative',
        dedupeKey: 'competitor:remove',
        dedupeMode: 'replace',
      })
    }
  }

  async function handleUpdateProject(pName: string, updates: { displayName?: string; canonicalDomain?: string; ownedDomains?: string[]; aliases?: string[]; country?: string; language?: string; locations?: Array<{ label: string; city: string; region: string; country: string; timezone?: string }>; defaultLocation?: string | null; providers?: string[]; providerModels?: Record<string, string> }) {
    const updated = await apiUpdateProject(pName, updates)
    // Invalidate the whole 'projects' branch (prefix match) so every consumer
    // — sidebar, project page, per-project detail queries — refetches the new
    // displayName before the user sees the next render. `refetch()` alone only
    // covers the top-level lists; detail queries were keyed on run IDs and
    // would silently hold the stale project object.
    // Project rename / metadata edit — refresh the top-level projects list
    // so sidebar/dashboard pick up the new displayName. Use the exact key
    // (not a prefix) so we don't churn every Bing/GSC/GA cache under the
    // project's sub-tree.
    await queryClient.invalidateQueries({ queryKey: getApiV1ProjectsQueryKey({ client: heyClient }) })
    queryClient.setQueryData(getApiV1ProjectsByNameQueryKey({ client: heyClient, path: { name: pName } }), updated)
    // Scoped to the edited project's own cache entries — see the helper.
    patchProjectDashboardCache(queryClient, updated)
    return updated
  }

  // Quiet underline tabs (Vercel/Linear lineage), not a pill rack. Section nav
  // is chrome: plain text that recedes, the active tab marked by a Snow
  // underline on the bar's hairline. Low-frequency sections (Report) live in a
  // trailing "More" overflow; Settings is split out at the far right (universal
  // convention). "Local Presence" only appears once GBP is connected.
  const projectTabBase = `/projects/${encodeURIComponent(model.project.name)}`
  const projectTabItemsAll: ProjectTabItem[] = [
    // `key` is a WIRE value: embed installs list it in CANONRY_EMBED_PROJECT_TABS
    // and it appears in saved URLs, so it stays `overview` however the label reads.
    { key: 'overview', label: 'AI Visibility', href: projectTabBase },
    { key: 'search-console', label: 'Search Engines', href: `${projectTabBase}/search-console` },
    { key: 'activity', label: 'Activity', href: `${projectTabBase}/activity` },
    // `technical-aeo` is a stable route and embed token. Site Health is the product label.
    { key: 'technical-aeo', label: 'Site Health', href: `${projectTabBase}/technical-aeo` },
    { key: 'conversions', label: 'Conversions', href: `${projectTabBase}/conversions` },
    { key: 'local', label: 'Local Presence', href: `${projectTabBase}/local` },
    { key: 'discovery', label: 'Queries', href: `${projectTabBase}/discovery` },
    { key: 'backlinks', label: 'Backlinks', href: `${projectTabBase}/backlinks` },
  ]
  const projectOverflowTabItemsAll: ProjectTabItem[] = [
    { key: 'report', label: 'Report', href: `${projectTabBase}/report` },
    { key: 'history', label: 'Change History', href: `${projectTabBase}/history` },
  ]
  // The embed projectTabs allowlist (when set) narrows the subnav to the curated
  // client-facing tabs; with no allowlist every tab shows (today's behavior).
  const projectTabItems = projectTabItemsAll.filter((item) => isEmbedProjectTabAllowed(item.key, embedProjectTabs))
  const projectOverflowTabItems = projectOverflowTabItemsAll.filter((item) =>
    isEmbedProjectTabAllowed(item.key, embedProjectTabs),
  )
  const projectSettingsTab = isEmbedProjectTabAllowed('settings', embedProjectTabs)
    ? { key: 'settings' as const, label: 'Settings', href: `${projectTabBase}/settings` }
    : null

  function focusOverviewSection(id: string, openDetails = false) {
    const section = document.getElementById(id)
    if (!section) return
    if (openDetails && section instanceof HTMLDetailsElement) section.open = true
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    window.requestAnimationFrame(() => {
      section.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
      const focusTarget = section instanceof HTMLDetailsElement
        ? section.querySelector<HTMLElement>('summary')
        : section
      focusTarget?.focus({ preventScroll: true })
    })
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">{model.project.displayName || model.project.name}</h1>
          <p className="page-subtitle">
            {model.project.canonicalDomain} · {model.contextLabel}
          </p>
          {!isEmbed() && (
            <div className="tag-row">
              <span className="tag">{model.project.country}</span>
              <span className="tag">{model.project.language.toUpperCase()}</span>
              {model.project.tags.map((tag) => (
                <span key={tag} className="tag">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="page-header-right">
          <p className="text-sm text-muted">{model.dateRangeLabel}</p>
          {!isEmbed() && (
            <div className="flex items-center gap-3">
              {nextSweepLabel ? <p className="text-sm text-secondary">{nextSweepLabel}</p> : null}
              {/* Secondary, not primary. The schedule beside it is what actually
                  runs the sweep; this is the override for when you can't wait
                  for it. Deleting the project used to sit here too — an
                  irreversible action one misclick from the page's most-used
                  button — and now lives at the bottom of the Settings tab. */}
              <WriteButton
                type="button"
                variant="outline"
                disabled={triggerRunMutation.isPending || hasActiveVisibilitySweep}
                onClick={asyncHandler(handleTriggerRun)}
              >
                {triggerRunMutation.isPending
                  ? 'Starting…'
                  : hasActiveVisibilitySweep
                    ? 'AI sweep running…'
                    : 'Run AI sweep'}
              </WriteButton>
            </div>
          )}
        </div>
      </div>

      <nav className="project-subnav" aria-label="Project sections">
        {projectTabItems.map((item) => {
          return (
            <Link
              key={item.key}
              to={item.href}
              search={preserveRunDrawerSearch}
              className={`project-subnav-link ${item.key === tab ? 'project-subnav-link-active' : ''}`}
              aria-current={item.key === tab ? 'page' : undefined}
            >
              {item.label}
            </Link>
          )
        })}
        <div className="project-subnav-trailing">
          <ProjectSubnavMore items={projectOverflowTabItems} activeTab={tab} />
          {projectSettingsTab && (
            <Link
              key={projectSettingsTab.key}
              to={projectSettingsTab.href}
              search={preserveRunDrawerSearch}
              className={`project-subnav-link ${tab === 'settings' ? 'project-subnav-link-active' : ''}`}
              aria-current={tab === 'settings' ? 'page' : undefined}
            >
              {projectSettingsTab.label}
            </Link>
          )}
        </div>
      </nav>

      {tab === 'portfolio' && !isEmbed() ? (
        <AdvancedMeasurementSection
          key={projectName}
          projectName={projectName}
          canEdit={canWrite}
          queries={portfolioQueriesQuery.data ?? []}
          isQueryLoading={isPortfolioQueriesLoading}
          isQueryError={isPortfolioQueriesError}
          onRetryQueries={() => { void portfolioQueriesQuery.refetch() }}
          publishedPlan={activeMeasurementPlan}
          onCreateQueries={async texts => {
            // The shared mutation carries the write guard and invalidates both
            // the projects list and the per-project detail. Calling the raw
            // client skipped all of that, so other surfaces kept showing the
            // old basket.
            await appendQueries.mutateAsync({ projectName, queries: [...texts] })
            // The step selects from this list, so it has to reflect the new
            // queries before the operator can apply them. A refetch failure
            // must not read as success, hence throwOnError.
            const refreshed = await portfolioQueriesQuery.refetch({ throwOnError: true })
            // The caller pairs each query back to the Property it was written
            // for, and can only do that once the ids exist.
            return refreshed.data ?? []
          }}
          onManageProjectQueries={() => {
            void navigate({
              to: '/projects/$projectName/discovery',
              params: { projectName },
              search: (previous: Record<string, unknown>) => ({
                ...previous,
                manageQueries: undefined,
                queries: 'tracked' as const,
              }),
            })
          }}
          onPublished={() => {
            void Promise.all([
              measurementSetupQuery.refetch(),
              activeMeasurementPlanQuery.refetch(),
            ]).finally(() => {
              void navigate({ to: '/projects/$projectName', params: { projectName } })
            })
          }}
        />
      ) : tab === 'overview' ? (
        isMeasurementModeUnresolved ? (
          <div role="status" aria-live="polite">
            <span className="sr-only">Loading project overview</span>
            <div className="h-32 animate-pulse rounded-md bg-surface-subtle" aria-hidden="true" />
          </div>
        ) : (
        <>
          {isActiveMeasurementPlanError ? (
            <div role="alert" className="mb-5 flex flex-wrap items-center gap-3 border-y border-negative-800/40 bg-negative-950/20 py-4 text-sm text-negative">
              <span>Could not check the advanced measurement setup. Existing project-wide results remain available.</span>
              <Button type="button" size="sm" variant="outline" onClick={() => { void activeMeasurementPlanQuery.refetch() }}>
                Retry setup check
              </Button>
            </div>
          ) : null}
          <AdvancedMeasurementLanding
            key={`${projectName}:${activeMeasurementRevision}`}
            mode={advancedMeasurementMode}
            canEdit={canWrite && !isEmbed() && !isActiveMeasurementPlanLoading && !isActiveMeasurementPlanError}
            simpleOverview={(
              <>
          <section className="page-section-divider">
            <VisibilityTrendSection
              projectName={model.project.name}
              competitorDomains={competitorDomains}
              analyticsRevision={latestVisibilityRevision}
            />
          </section>

          <OverviewBrief
            model={model}
            sweepRunning={hasActiveVisibilitySweep}
          />

          <OverviewSignals
            insights={model.insights}
            suggestedQueries={model.suggestedQueries}
            projectName={model.project.name}
          />

          <section className="page-section-divider">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">Competitive</p>
                <h2>Where competitors are winning</h2>
              </div>
              <div className="flex items-center gap-3">
                <p className="supporting-copy">{model.competitors.length} tracked</p>
                {!isEmbed() && (
                  <WriteButton type="button" variant="outline" size="sm" onClick={() => setAddingCompetitor(!addingCompetitor)}>
                    {addingCompetitor ? 'Cancel' : '+ Add competitor'}
                  </WriteButton>
                )}
              </div>
            </div>

            <div className="aeo-hero competitive-summary">
              <MentionShare
                key={model.project.name}
                summary={model.mentionShareSummary}
                projectLabel={model.project.displayName || model.project.name}
                competitorDomains={competitorDomains}
              />

              <div className="competitive-gaps">
                <div className="aeo-hero-rows">
                  <OverviewMetricRow
                    label="Mention gaps"
                    summary={model.mentionGaps}
                    displayValue={<><span className="text-primary">{model.mentionGaps.value}</span><span className="text-faint"> / {model.queryCounts.total}</span></>}
                    tooltip="Queries where a competitor was mentioned in the answer but your brand was not."
                  />
                  <OverviewMetricRow
                    label="Citation gaps"
                    summary={model.gapQueries}
                    displayValue={<><span className="text-primary">{model.gapQueries.value}</span><span className="text-faint"> / {model.queryCounts.total}</span></>}
                    tooltip="Queries where a competitor was cited as a source but you were not."
                  />
                </div>
              </div>
            </div>

            {addingCompetitor && (
              <div className="mt-4 mb-3 flex gap-2 rounded-lg border border-base bg-bg-elevated/40 p-3">
                <input
                  className="flex-1 rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                  type="text"
                  placeholder="competitor.com"
                  value={newCompetitorDomain}
                  onChange={(e) => setNewCompetitorDomain(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { void handleAddCompetitor() } }}
                />
                <WriteButton type="button" size="sm" disabled={!newCompetitorDomain.trim() || competitorSaving} onClick={asyncHandler(handleAddCompetitor)}>
                  {competitorSaving ? 'Adding...' : 'Add'}
                </WriteButton>
              </div>
            )}

            {model.competitors.length > 0 && (
              <details className="inline-disclosure mt-4">
                <summary>Review tracked competitors</summary>
                <div className="mt-3">
                  <CompetitorTable
                    competitors={model.competitors}
                    onSelectCompetitor={(domain) => {
                      setCompetitorFilter(domain)
                      focusOverviewSection('evidence-section', true)
                    }}
                    onRemoveCompetitor={isEmbed() ? undefined : (domain) => { void handleRemoveCompetitor(domain) }}
                    activeFilter={competitorFilter}
                  />
                </div>
              </details>
            )}
          </section>

          <OverviewDisclosure
            id="evidence-section"
            eyebrow="Tracked coverage"
            title="Query evidence"
            meta={`${model.queryCounts.total} ${model.queryCounts.total === 1 ? 'query' : 'queries'}`}
            defaultOpen={isEmbed()}
          >
            {model.project.locations.length > 0 && (
              <div className="filter-row mb-3" role="toolbar" aria-label="Location filters">
                <button
                  className={`filter-chip ${locationFilter === undefined ? 'filter-chip-active' : ''}`}
                  type="button"
                  aria-pressed={locationFilter === undefined}
                  onClick={() => { setLocationFilter(undefined) }}
                >
                  All locations
                </button>
                {model.project.locations.map((loc: { label: string }) => (
                  <button
                    key={loc.label}
                    className={`filter-chip ${locationFilter === loc.label ? 'filter-chip-active' : ''}`}
                    type="button"
                    aria-pressed={locationFilter === loc.label}
                    onClick={() => { setLocationFilter(loc.label); setCompareLocations(false) }}
                  >
                    {loc.label}
                  </button>
                ))}
                {hasNullLocationEvidence && (
                  <button
                    className={`filter-chip ${locationFilter === '' ? 'filter-chip-active' : ''}`}
                    type="button"
                    aria-pressed={locationFilter === ''}
                    onClick={() => { setLocationFilter(''); setCompareLocations(false) }}
                  >
                    No location
                  </button>
                )}
                {distinctLocationsForCompare.length > 1 && locationFilter === undefined && (
                  <button
                    className={`filter-chip filter-chip-compare ${compareLocations ? 'filter-chip-active' : ''}`}
                    type="button"
                    aria-pressed={compareLocations}
                    onClick={() => setCompareLocations(v => !v)}
                    title="Side-by-side location comparison"
                  >
                    Compare
                  </button>
                )}
              </div>
            )}
            {competitorFilter && (
              <div className="mb-3 flex items-center gap-2 rounded-md border border-negative-900/40 bg-negative-950/20 px-3 py-2">
                <span className="text-[11px] uppercase tracking-wide text-negative-400">Competitor filter</span>
                <span className="text-sm text-strong">Showing queries where <span className="font-semibold">{competitorFilter}</span> surfaced</span>
                <button
                  type="button"
                  className="ml-auto text-xs text-secondary hover:text-strong"
                  onClick={() => setCompetitorFilter(null)}
                >
                  Clear filter ×
                </button>
              </div>
            )}
            <EvidenceTable
              evidence={filteredEvidence}
              compareLocations={compareLocations}
            />
          </OverviewDisclosure>

          <OverviewDisclosure eyebrow="Analysis" title="Citation and engine diagnostics" meta="Deep dive" defaultOpen={isEmbed()}>
            <CitationVisibilitySection projectName={model.project.name} />

            {model.providerScores.length > 1 && (
              <section className="page-section-divider">
                <div className="section-head section-head-inline">
                  <div>
                    <p className="eyebrow eyebrow-soft">Model breakdown</p>
                    <h2>Citation rate by model <InfoTooltip text="Per-model citation rate in the latest sweep. The same query set can perform differently across engines." /></h2>
                  </div>
                </div>
                <div className="evidence-table-wrap">
                  <table className="evidence-table">
                    <thead>
                      <tr>
                        <th scope="col">Model</th>
                        <th scope="col">Citation rate</th>
                        <th scope="col">Cited queries</th>
                      </tr>
                    </thead>
                    <tbody>
                      {model.providerScores.map((ps) => (
                        <tr key={`${ps.provider}::${ps.model ?? 'unknown'}`}>
                          <td>
                            <div className="flex flex-col items-start gap-0.5">
                              <ProviderBadge provider={ps.provider} />
                              {ps.model && <span className="text-[11px] font-mono text-muted">{ps.model}</span>}
                            </div>
                          </td>
                          <td><span className="font-semibold text-strong">{ps.score}%</span></td>
                          <td className="text-muted">{ps.cited} of {ps.total}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </OverviewDisclosure>

          {!isEmbed() && (
            <OverviewDisclosure eyebrow="Run history" title="Recent execution history" meta={`${model.recentRuns.length} recent`}>
              <div className="run-list">
                {model.recentRuns.map((run) => (
                  <RunRow key={run.id} run={run} />
                ))}
              </div>
            </OverviewDisclosure>
          )}

              </>
            )}
            report={advancedMeasurementReport}
            reportState={advancedMeasurementReportState}
            portfolioSummary={activeMeasurementPlanSchemaVersion === 2
              ? advancedMeasurementPortfolioSummaryQuery.data
              : undefined}
            portfolioSummaryState={activeMeasurementPlanSchemaVersion === 2
              ? advancedMeasurementPortfolioSummaryState
              : undefined}
            onRetryPortfolioSummary={() => { void advancedMeasurementPortfolioSummaryQuery.refetch() }}
            projectTrend={activeMeasurementPlanSchemaVersion === 2 ? (
              <VisibilityTrendSection
                projectName={model.project.name}
                competitorDomains={competitorDomains}
                analyticsRevision={latestVisibilityRevision}
              />
            ) : undefined}
            renderGroupLink={activeMeasurementPlanSchemaVersion === 2 && !isEmbed()
              ? ({ id, name }) => (
                  <Link
                    to="/projects/$projectName"
                    params={{ projectName }}
                    search={(previous: Record<string, unknown>) => ({
                      ...previous,
                      ...measurementViewSearch({
                        scope: 'group',
                        groupKey: id,
                        queryClass: advancedMeasurementView.queryClass,
                      }),
                    })}
                    className="rounded-sm font-medium text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-mono-400"
                  >
                    {name}
                  </Link>
                )
              : undefined}
            renderPortfolioLink={activeMeasurementPlanSchemaVersion === 2 && !isEmbed()
              ? () => (
                  <Link
                    to="/projects/$projectName"
                    params={{ projectName }}
                    search={(previous: Record<string, unknown>) => ({
                      ...previous,
                      ...measurementViewSearch({ scope: 'all', queryClass: advancedMeasurementView.queryClass }),
                    })}
                    className="rounded-sm text-link outline-none hover:underline focus-visible:ring-2 focus-visible:ring-mono-400"
                  >
                    Portfolio
                  </Link>
                )
              : undefined}
            onOpenSetup={!isEmbed() ? () => {
              void navigate({ to: '/projects/$projectName/portfolio', params: { projectName } })
            } : undefined}
            onRetryReport={() => {
              if (activeMeasurementPlanSchemaVersion === 2) {
                void Promise.all([
                  advancedMeasurementOverviewQuery.refetch(),
                  advancedMeasurementReportQuery.refetch(),
                  advancedMeasurementPortfolioSummaryQuery.refetch(),
                ])
              }
              else void advancedMeasurementReportQuery.refetch()
            }}
            onViewChange={(view) => {
              setAdvancedMeasurementView({
                scope: view.scope,
                ...(view.groupKey ? { groupKey: view.groupKey } : {}),
                queryClass: view.queryClass,
                ...(view.search?.trim() ? { search: view.search.trim() } : {}),
              })
            }}
            onLoadMore={(cursor) => {
              if (cursor === mergedAdvancedMeasurementOverview?.properties.nextCursor) {
                void advancedMeasurementOverviewQuery.fetchNextPage()
              }
            }}
            onPropertyExpand={() => {
              if (hasExpandedAdvancedProperty && advancedMeasurementReportQuery.isError) {
                void advancedMeasurementReportQuery.refetch()
              }
              setHasExpandedAdvancedProperty(true)
            }}
            onRetryEvidence={() => { void advancedMeasurementReportQuery.refetch() }}
            renderPropertyLink={activeMeasurementPlanSchemaVersion === 2 && !isEmbed()
              ? ({ id, name }) => (
                  <Link
                    to="/projects/$projectName/properties/$targetKey"
                    params={{ projectName, targetKey: id }}
                    className="text-link hover:underline"
                  >
                    {name}
                  </Link>
                )
              : undefined}
            isViewLoading={advancedMeasurementOverviewQuery.isPlaceholderData}
            isLoadingMore={advancedMeasurementOverviewQuery.isFetchingNextPage}
            isLoadMoreError={advancedMeasurementOverviewQuery.isFetchNextPageError}
            viewSearch={advancedMeasurementView.search ?? ''}
          />
        </>
        )
      ) : tab === 'settings' ? (
        <>
          <ProjectSettingsSection project={{ ...model.project, displayName: model.project.displayName ?? model.project.name, defaultLocation: model.project.defaultLocation ?? null }} onUpdateProject={async (name, updates) => { await handleUpdateProject(name, updates) }} onRefresh={() => void refetch()} />
          <ProjectEngineSettingsSection project={model.project} onSave={async next => { await handleUpdateProject(model.project.name, next) }} />
          {canWrite && !isEmbed() ? (
            <section className="page-section-divider">
              <h2 className="text-lg font-semibold text-heading">Advanced measurement</h2>
              <p className="supporting-copy mt-1 mb-3">
                Measure individual properties, locations, or site sections with separate query sets.
              </p>
              {measurementSetupDisplayState === 'pending' ? (
                <p role="status" className="text-sm text-secondary">Loading setup…</p>
              ) : measurementSetupDisplayState === 'error' ? (
                <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-negative">
                  <span>Could not load advanced measurement setup.</span>
                  <Button type="button" size="sm" variant="outline" onClick={() => { void measurementSetupQuery.refetch() }}>
                    Retry
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => { void navigate({ to: '/projects/$projectName/portfolio', params: { projectName } }) }}
                >
                  {advancedMeasurementSetupActionLabel(advancedMeasurementMode.setupAction)}
                </Button>
              )}
            </section>
          ) : null}
          <ScheduleSection projectName={model.project.name} />
          <NotificationsSection projectName={model.project.name} />
          {/* Deleting the project lives here, at the far end of Settings, rather
              than as an icon in the page header where it sat one misclick from
              "Run AI sweep". It destroys every query, run and snapshot, and a
              confirm dialog was the only thing standing between the two. */}
          {canWrite && !isEmbed() ? (
            <section className="page-section-divider">
              <h2 className="text-lg font-semibold text-negative-400">Delete project</h2>
              <p className="supporting-copy mt-1 mb-3">
                Permanently deletes this project and all its queries, competitors, runs, and snapshots.
              </p>
              {showDeleteConfirm ? (
                <Card className="surface-card p-6 border-negative-800/60">
                  <h3 className="text-base font-semibold text-negative-400 mb-2">Delete project?</h3>
                  <p className="text-sm text-secondary mb-4">
                    This will permanently delete <strong className="text-strong">{model.project.displayName || model.project.name}</strong> and
                    all its queries, competitors, runs, and snapshots. This cannot be undone.
                  </p>
                  <div className="flex items-center gap-3">
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={deleting}
                      onClick={asyncHandler(handleDeleteProject)}
                    >
                      {deleting ? 'Deleting...' : 'Yes, delete project'}
                    </Button>
                    <Button type="button" variant="outline" disabled={deleting} onClick={() => setShowDeleteConfirm(false)}>
                      Cancel
                    </Button>
                  </div>
                </Card>
              ) : (
                <WriteButton type="button" variant="outline" onClick={() => setShowDeleteConfirm(true)}>
                  <Trash2 className="h-4 w-4 text-secondary" />
                  Delete project
                </WriteButton>
              )}
            </section>
          ) : null}
        </>
      ) : tab === 'report' ? (
        <ReportPage projectName={model.project.name} />
      ) : tab === 'discovery' ? (
        <DiscoverySection projectName={projectName} workspace={projectSearchParams.queries} />
      ) : tab === 'technical-aeo' ? (
        <SiteHealthSection
          projectName={model.project.name}
          projectId={model.project.id}
          initialRunId={projectSearchParams.siteHealthRunId}
          onReleaseInitialRun={releaseInitialSiteHealthRun}
        />
      ) : tab === 'conversions' ? (
        <>
          {/* Delivery first, plumbing second: spend and conversions are what an
              operator opens this tab for, and Conversion Integrity below is how
              the numbers earn their trust. */}
          <GoogleAdsPerformanceSection key={`${model.project.id}:performance`} projectName={model.project.name} />
          <ConversionIntegrityWorkspace
            key={model.project.id}
            projectId={model.project.id}
            projectName={model.project.name}
          />
        </>
      ) : tab === 'history' ? (
        <ProjectHistorySection projectName={model.project.name} />
      ) : tab === 'activity' ? (
        <ActivitySection projectName={model.project.name} />
      ) : tab === 'backlinks' ? (
        <BacklinksSection projectName={model.project.name} />
      ) : tab === 'local' ? (
        // Local presence (Google Business Profile + Places). GbpSection
        // self-gates on the connection and renders its own empty state.
        <GbpSection projectName={model.project.name} projectId={model.project.id} />
      ) : tab === 'search-console' ? (
        <SearchConsoleSection projectName={model.project.name} />
      ) : null}
    </div>
  )
}
