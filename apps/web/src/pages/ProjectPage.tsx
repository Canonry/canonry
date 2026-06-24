import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Download, Trash2 } from 'lucide-react'
import { useParams, useNavigate } from '@tanstack/react-router'
import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { RunKinds, RunStatuses } from '@ainyc/canonry-contracts'

import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { CitationBadge } from '../components/shared/CitationBadge.js'
import { InfoTooltip } from '../components/shared/InfoTooltip.js'
import { ProviderBadge } from '../components/shared/ProviderBadge.js'
import { RunRow } from '../components/shared/RunRow.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { EvidenceTable } from '../components/project/EvidenceTable.js'
import { CompetitorTable } from '../components/project/CompetitorTable.js'
import { SearchConsoleSummaryCard } from '../components/project/SearchConsoleSummaryCard.js'
import { BingSummaryMetric } from '../components/project/BingSummaryMetric.js'
import { ActivitySection } from '../components/project/ActivitySection.js'
import { GscSection } from '../components/project/GscSection.js'
import { GbpSection } from '../components/project/GbpSection.js'
import { BacklinksSection } from '../components/project/BacklinksSection.js'
import { CitationVisibilitySection } from '../components/project/CitationVisibilitySection.js'
import { VisibilityTrendSection } from '../components/project/VisibilityTrendSection.js'
import { DiscoverySection } from '../components/project/DiscoverySection.js'
import { TechnicalAeoSection } from '../components/project/TechnicalAeoSection.js'
import { ReportPage } from './ReportPage.js'
import { formatTimestamp, SEARCH_METRIC_SHORT_LABELS, SearchMetric } from '../lib/format-helpers.js'
import { METRIC_TONE_TEXT_CLASS } from '../lib/tone-helpers.js'
import { addToast } from '../lib/toast-store.js'
import { asyncHandler } from '../lib/async-handler.js'
import { ProjectSettingsSection } from '../components/project/ProjectSettingsSection.js'
import { ScheduleSection } from '../components/project/ScheduleSection.js'
import { NotificationsSection } from '../components/project/NotificationsSection.js'
import {
  fetchExport,
  fetchTimeline,
  deleteProject as apiDeleteProject,
  appendQueries as apiAppendQueries,
  removeQueries as apiRemoveQueries,
  fetchCompetitors as apiFetchCompetitors,
  setCompetitors as apiSetCompetitors,
  removeCompetitors as apiRemoveCompetitors,
  updateOwnedDomains as apiUpdateOwnedDomains,
  updateAliases as apiUpdateAliases,
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
  type ApiBingConnection,
  type ApiBingSite,
  type ApiBingInspection,
  type ApiBingCoverageSummary,
  type ApiBingKeywordStats,
  type ApiGoogleConnection,
  type ApiGscCoverageSummary,
} from '../api.js'
import {
  getApiV1ProjectsByNameBingCoverageOptions,
  getApiV1ProjectsByNameBingInspectionsOptions,
  getApiV1ProjectsByNameBingPerformanceOptions,
  getApiV1ProjectsByNameBingSitesOptions,
  getApiV1ProjectsByNameBingStatusOptions,
  getApiV1ProjectsByNameGoogleConnectionsOptions,
  getApiV1ProjectsByNameGoogleGscCoverageOptions,
  getApiV1ProjectsQueryKey,
  getApiV1SettingsOptions,
} from '@ainyc/canonry-api-client/react-query'
import { useAppendQueries, useTriggerRun } from '../queries/mutations.js'
import { GSC_STALE_MS } from '../queries/query-client.js'
import { useQuery } from '@tanstack/react-query'
import { getApiV1ProjectsOptions } from '@ainyc/canonry-api-client/react-query'
import { useProjectDashboard } from '../queries/use-project-dashboard.js'
import { useInitialDashboard } from '../contexts/dashboard-context.js'
import { useDrawer } from '../hooks/use-drawer.js'
import type { ProjectCommandCenterVm, RunHistoryPoint } from '../view-models.js'

export type ProjectPageTab = 'overview' | 'search-console' | 'local' | 'discovery' | 'report' | 'activity' | 'backlinks' | 'technical-aeo' | 'settings'

type SearchConsoleWorkspace = 'google' | 'bing'

/**
 * Invalidate every generated TanStack query whose operation id starts
 * with `prefix`. Used to replace the legacy hierarchical `queryKeys.X.project(name)`
 * invalidations now that all cache keys come from the SDK helpers — the
 * generated keys are flat (`[{_id: 'getApiV1...', ...}]`) and don't share
 * a hierarchical prefix.
 */
function invalidateByOpPrefix(queryClient: ReturnType<typeof useQueryClient>, prefix: string) {
  return queryClient.invalidateQueries({
    predicate: (query) => {
      const head = query.queryKey[0] as { _id?: string } | undefined
      return typeof head?._id === 'string' && head._id.startsWith(prefix)
    },
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
      await invalidateByOpPrefix(queryClient, "getApiV1ProjectsByNameBing")
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
      await invalidateByOpPrefix(queryClient, "getApiV1ProjectsByNameBing")
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
      await invalidateByOpPrefix(queryClient, "getApiV1ProjectsByNameBing")
      await loadData()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set site')
    }
  }

  async function handleInspect() {
    if (!inspectionUrl.trim()) return
    try {
      const result = await inspectBingUrl(projectName, inspectionUrl.trim())
      await invalidateByOpPrefix(queryClient, "getApiV1ProjectsByNameBing")
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
        <div className="text-sm text-zinc-400">Loading Bing data...</div>
      </Card>
    )
  }

  if (!connection?.connected) {
    return (
      <Card className="surface-card">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Connection</p>
            <h3>Domain authorization</h3>
          </div>
          <ToneBadge tone="caution">Not connected</ToneBadge>
        </div>
        <p className="text-sm text-zinc-300">
          Connect Bing Webmaster Tools to inspect URLs, monitor index coverage, and submit pages for indexing.
        </p>
        <div className="mt-3">
          <label className="text-xs text-zinc-500" htmlFor="bing-api-key">API Key</label>
          <div className="flex items-center gap-2 mt-1">
            <input
              id="bing-api-key"
              type="password"
              className="flex-1 rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
              placeholder="Bing Webmaster Tools API key"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { void handleConnect() } }}
            />
            <Button size="sm" disabled={!apiKeyInput.trim()} onClick={asyncHandler(handleConnect)}>
              Connect
            </Button>
          </div>
          <p className="mt-1 text-[11px] text-zinc-500">
            Get your API key from{' '}
            <a
              href="https://www.bing.com/webmasters/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-400 hover:text-zinc-300 underline underline-offset-2"
            >
              Bing Webmaster Tools
            </a>
          </p>
        </div>
        {error && <p className="mt-3 text-xs text-rose-400">{error}</p>}
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
            <Button size="sm" variant="ghost" onClick={asyncHandler(handleDisconnect)}>Disconnect</Button>
          </div>
        </div>
        <div className="space-y-3">
          <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="text-sm text-zinc-200">Authorized for this project domain</span>
              <span className="text-xs text-zinc-500">{connection.domain}</span>
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              The API key is connected, but no Bing site is selected yet. Pick the verified site that should receive inspections and indexing requests.
            </p>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3">
              <p className="text-xs uppercase tracking-wide text-zinc-500">Registered domain</p>
              <p className="mt-1 text-sm text-zinc-200">{connection.domain}</p>
            </div>
            <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3">
              <p className="text-xs uppercase tracking-wide text-zinc-500">Last auth update</p>
              <p className="mt-1 text-sm text-zinc-200">{connection.updatedAt ? formatTimestamp(connection.updatedAt) : '\u2014'}</p>
            </div>
          </div>
          <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3">
            <p className="text-xs uppercase tracking-wide text-zinc-500">Select site</p>
            {sites.length > 0 ? (
              <div className="mt-3 flex flex-col gap-2 lg:flex-row">
                <select
                  className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 focus:border-zinc-500 focus:outline-none"
                  value={selectedSite}
                  onChange={(e) => setSelectedSite(e.target.value)}
                >
                  <option value="">Select a site...</option>
                  {sites.map((s) => (
                    <option key={s.url} value={s.url}>{s.url}{s.verified ? ' (verified)' : ''}</option>
                  ))}
                </select>
                <Button size="sm" disabled={!selectedSite} onClick={asyncHandler(handleSetSite)}>Set Site</Button>
              </div>
            ) : (
              <p className="mt-3 text-xs text-zinc-500">
                No verified Bing sites are available yet. Verify the domain in Bing Webmaster Tools, then use the page-level refresh to reload everything.
              </p>
            )}
          </div>
        </div>
        {error && <p className="mt-3 text-xs text-rose-400">{error}</p>}
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
            <Button size="sm" variant="ghost" onClick={asyncHandler(handleDisconnect)}>Disconnect</Button>
          </div>
        </div>
        {error && <p className="mb-3 text-xs text-rose-400">{error}</p>}
        <div className="space-y-3">
          <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="text-sm text-zinc-200">Authorized for this project domain</span>
              <span className="text-xs text-zinc-500">{connection.domain}</span>
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              Canonry stores Bing connections per canonical domain. This project is currently mapped to <code>{connection.siteUrl}</code>.
            </p>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3">
              <p className="text-xs uppercase tracking-wide text-zinc-500">Selected site</p>
              <p className="mt-1 text-sm text-zinc-200">{connection.siteUrl}</p>
            </div>
            <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3">
              <p className="text-xs uppercase tracking-wide text-zinc-500">Last auth update</p>
              <p className="mt-1 text-sm text-zinc-200">{connection.updatedAt ? formatTimestamp(connection.updatedAt) : '\u2014'}</p>
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
          <p className="text-xs text-zinc-500">
            {coverage?.lastInspectedAt ? `Last inspected ${formatTimestamp(coverage.lastInspectedAt)}` : 'No inspection history yet'}
          </p>
        </div>

        <div className="flex gap-1 border-b border-zinc-800">
          {tabs.map((t) => (
            <button
              key={t.key}
              className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
                activeTab === t.key
                  ? 'border-zinc-200 text-zinc-200'
                  : 'border-transparent text-zinc-500 hover:text-zinc-300'
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
                  <h4 className="text-xs font-medium text-zinc-400">Not Indexed ({coverage.notIndexed.length})</h4>
                  <Button size="sm" variant="ghost" disabled={requestingIndexing} onClick={asyncHandler(handleSubmitAllUnindexed)}>
                    {requestingIndexing ? 'Submitting…' : 'Submit all to Bing'}
                  </Button>
                </div>
                <div className="overflow-x-auto rounded-lg border border-zinc-800/60">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-zinc-800">
                        <th className="text-left py-1.5 px-3 text-zinc-500 font-medium">URL</th>
                        <th className="text-left py-1.5 px-3 text-zinc-500 font-medium w-16">HTTP</th>
                        <th className="text-right py-1.5 px-3 text-zinc-500 font-medium w-20">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {coverage.notIndexed.map((row) => (
                        <tr key={row.id} className="border-b border-zinc-800/50">
                          <td className="py-1.5 px-3 text-zinc-300 truncate max-w-[480px]">{row.url}</td>
                          <td className="py-1.5 px-3 text-zinc-400">{row.httpCode ?? '\u2014'}</td>
                          <td className="py-1.5 px-3 text-right">
                            <button
                              className="text-[10px] text-zinc-400 hover:text-zinc-200 underline underline-offset-2"
                              disabled={requestingIndexing}
                              onClick={() => { void handleSubmitUrl(row.url) }}
                            >
                              Submit
                            </button>
                          </td>
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
                  <h4 className="text-xs font-medium text-zinc-400">Unknown — not yet confirmed ({(coverage.unknown ?? []).length})</h4>
                  <Button size="sm" variant="ghost" disabled={requestingIndexing} onClick={asyncHandler(handleSubmitAllUnindexed)}>
                    {requestingIndexing ? 'Submitting…' : 'Submit all to Bing'}
                  </Button>
                </div>
                <div className="overflow-x-auto rounded-lg border border-zinc-800/60">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-zinc-800">
                        <th className="text-left py-1.5 px-3 text-zinc-500 font-medium">URL</th>
                        <th className="text-left py-1.5 px-3 text-zinc-500 font-medium w-32">Last Crawled</th>
                        <th className="text-right py-1.5 px-3 text-zinc-500 font-medium w-20">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(coverage.unknown ?? []).map((row) => (
                        <tr key={row.id} className="border-b border-zinc-800/50">
                          <td className="py-1.5 px-3 text-zinc-300 truncate max-w-[480px]">{row.url}</td>
                          <td className="py-1.5 px-3 text-zinc-400">{row.lastCrawledDate ? formatTimestamp(row.lastCrawledDate) : '\u2014'}</td>
                          <td className="py-1.5 px-3 text-right">
                            <button
                              className="text-[10px] text-zinc-400 hover:text-zinc-200 underline underline-offset-2"
                              disabled={requestingIndexing}
                              onClick={() => { void handleSubmitUrl(row.url) }}
                            >
                              Submit
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {coverage.indexed.length > 0 && (
              <div>
                <h4 className="mb-2 text-xs font-medium text-zinc-400">Indexed ({coverage.indexed.length})</h4>
                <div className="overflow-x-auto rounded-lg border border-zinc-800/60">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-zinc-800">
                        <th className="text-left py-1.5 px-3 text-zinc-500 font-medium">URL</th>
                        <th className="text-left py-1.5 px-3 text-zinc-500 font-medium w-32">Last Crawled</th>
                      </tr>
                    </thead>
                    <tbody>
                      {coverage.indexed.map((row) => (
                        <tr key={row.id} className="border-b border-zinc-800/50">
                          <td className="py-1.5 px-3 text-zinc-300 truncate max-w-[480px]">{row.url}</td>
                          <td className="py-1.5 px-3 text-zinc-400">{row.lastCrawledDate ? formatTimestamp(row.lastCrawledDate) : '\u2014'}</td>
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
          <p className="mt-4 text-xs text-zinc-500">No coverage data yet. Inspect URLs to build coverage data.</p>
        )}

        {activeTab === 'inspections' && (
          <div className="mt-4 space-y-3">
            <div className="flex flex-col gap-2 lg:flex-row">
              <input
                type="text"
                className="flex-1 rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                placeholder="URL to inspect"
                value={inspectionUrl}
                onChange={(e) => setInspectionUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { void handleInspect() } }}
              />
              <Button size="sm" disabled={!inspectionUrl.trim()} onClick={asyncHandler(handleInspect)}>
                Inspect
              </Button>
            </div>

            {inspectionResult && (
              <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3 text-xs space-y-1">
                <div className="font-medium text-zinc-200">{inspectionResult.url}</div>
                <div className="text-zinc-400">
                  In Index: <span className={inspectionResult.inIndex ? 'text-emerald-400' : 'text-rose-400'}>
                    {inspectionResult.inIndex ? 'Yes' : 'No'}
                  </span>
                  {' \u00b7 '}HTTP: {inspectionResult.httpCode ?? '\u2014'}
                  {' \u00b7 '}Crawled: {inspectionResult.lastCrawledDate ?? '\u2014'}
                </div>
              </div>
            )}

            {inspections.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-zinc-800/60">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-zinc-800">
                      <th className="text-left py-1.5 px-3 text-zinc-500 font-medium">URL</th>
                      <th className="text-left py-1.5 px-3 text-zinc-500 font-medium w-16">Index</th>
                      <th className="text-left py-1.5 px-3 text-zinc-500 font-medium w-14">HTTP</th>
                      <th className="text-left py-1.5 px-3 text-zinc-500 font-medium w-32">Inspected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inspections.map((row) => (
                      <tr key={row.id} className="border-b border-zinc-800/50">
                        <td className="py-1.5 px-3 text-zinc-300 truncate max-w-[480px]">{row.url}</td>
                        <td className="py-1.5 px-3">
                          <ToneBadge tone={row.inIndex ? 'positive' : 'negative'}>{row.inIndex ? 'Yes' : 'No'}</ToneBadge>
                        </td>
                        <td className="py-1.5 px-3 text-zinc-400">{row.httpCode ?? '\u2014'}</td>
                        <td className="py-1.5 px-3 text-zinc-400">{formatTimestamp(row.inspectedAt)}</td>
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
              <p className="text-xs text-zinc-500">No Bing performance data available.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-zinc-800/60">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-zinc-800">
                      <th className="text-left py-1.5 px-3 text-zinc-500 font-medium">Query</th>
                      <th className="text-right py-1.5 px-3 text-zinc-500 font-medium w-16">{SEARCH_METRIC_SHORT_LABELS[SearchMetric.Clicks]}</th>
                      <th className="text-right py-1.5 px-3 text-zinc-500 font-medium w-16">{SEARCH_METRIC_SHORT_LABELS[SearchMetric.Impressions]}</th>
                      <th className="text-right py-1.5 px-3 text-zinc-500 font-medium w-14">{SEARCH_METRIC_SHORT_LABELS[SearchMetric.CTR]}</th>
                      <th className="text-right py-1.5 px-3 text-zinc-500 font-medium w-14">{SEARCH_METRIC_SHORT_LABELS[SearchMetric.Position]}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {performance.map((row, i) => (
                      <tr key={i} className="border-b border-zinc-800/50">
                        <td className="py-1.5 px-3 text-zinc-300 truncate max-w-[480px]">{row.query}</td>
                        <td className="py-1.5 px-3 text-right text-zinc-200">{row.clicks}</td>
                        <td className="py-1.5 px-3 text-right text-zinc-400">{row.impressions}</td>
                        <td className="py-1.5 px-3 text-right text-zinc-400">{(Number.isFinite(row.ctr) ? row.ctr * 100 : 0).toFixed(1)}%</td>
                        <td className="py-1.5 px-3 text-right text-zinc-400">{row.averagePosition.toFixed(1)}</td>
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
  const [googleConfigured, setGoogleConfigured] = useState(false)
  const [googleConnection, setGoogleConnection] = useState<ApiGoogleConnection | null>(null)
  const [googleCoverage, setGoogleCoverage] = useState<ApiGscCoverageSummary | null>(null)
  const [bingConfigured, setBingConfigured] = useState(false)
  const [bingConnection, setBingConnection] = useState<ApiBingConnection | null>(null)
  const [bingCoverage, setBingCoverage] = useState<ApiBingCoverageSummary | null>(null)
  const [workspaceRefreshNonce, setWorkspaceRefreshNonce] = useState(0)

  async function loadSummary(silent = false) {
    if (!silent) setLoading(true)
    setError(null)

    try {
      const [settings, connections, bingStatus] = await Promise.all([
        queryClient.fetchQuery(getApiV1SettingsOptions({ client: heyClient })).catch(() => null),
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
      setGoogleConfigured(Boolean(settings?.google?.configured))
      setBingConfigured(Boolean(settings?.bing?.configured))
      setGoogleConnection(gscConnection)
      setBingConnection(bingStatus)

      const [googleCoverageData, bingCoverageData] = await Promise.all([
        gscConnection
          ? queryClient.fetchQuery({
              ...getApiV1ProjectsByNameGoogleGscCoverageOptions({ client: heyClient, path: { name: projectName } }),
              staleTime: GSC_STALE_MS,
            }).catch(() => null)
          : Promise.resolve(null),
        bingStatus?.connected
          ? queryClient.fetchQuery({
              ...getApiV1ProjectsByNameBingCoverageOptions({ client: heyClient, path: { name: projectName } }),
              staleTime: GSC_STALE_MS,
            }).catch(() => null)
          : Promise.resolve(null),
      ])

      setGoogleCoverage(googleCoverageData)
      setBingCoverage(bingCoverageData)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load search console overview')
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

    const failures: string[] = []

    try {
      // --- Google: trigger a background GSC sync job and poll to completion ---
      async function syncGoogle() {
        if (!googleConnection) return
        const run = await triggerGscSync(projectName)
        if (!run?.id) return

        const POLL_INTERVAL_MS = 2000
        const TIMEOUT_MS = 120_000
        const deadline = Date.now() + TIMEOUT_MS

        while (Date.now() < deadline) {
          if (signal.aborted) return
          await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
          if (signal.aborted) return
          const detail = await fetchRunDetail(run.id).catch(() => null)
          if (!detail) break
          if (['completed', 'failed', 'cancelled'].includes(detail.status)) {
            if (detail.status !== 'completed') failures.push(`Google sync ${detail.status}`)
            break
          }
        }
      }

      // --- Bing: re-inspect previously known URLs, or fall back to sitemap ---
      const BING_CONCURRENCY = 10
      async function syncBing() {
        if (!bingConnection?.connected) return
        const inspections = await queryClient.fetchQuery({
          ...getApiV1ProjectsByNameBingInspectionsOptions({ client: heyClient, path: { name: projectName } }),
          staleTime: 0,
        }).catch(() => [] as ApiBingInspection[])
        const uniqueUrls = [...new Set(inspections.map((i) => i.url))]

        if (uniqueUrls.length === 0) {
          // No prior inspections — launch a sitemap inspection to discover URLs
          await inspectBingSitemap(projectName).catch(() => null)
          return
        }

        for (let i = 0; i < uniqueUrls.length; i += BING_CONCURRENCY) {
          if (signal.aborted) return
          const batch = uniqueUrls.slice(i, i + BING_CONCURRENCY)
          const results = await Promise.allSettled(batch.map((url) => inspectBingUrl(projectName, url)))
          const batchFailures = results.filter((r) => r.status === 'rejected').length
          if (batchFailures > 0) failures.push(`${batchFailures} Bing inspection(s) failed`)
        }
      }

      const results = await Promise.allSettled([syncGoogle(), syncBing()])
      for (const r of results) {
        if (r.status === 'rejected') {
          failures.push(r.reason instanceof Error ? r.reason.message : 'Sync failed')
        }
      }

      if (signal.aborted) return

      // Reload both coverage summaries from fresh DB values
      setRefreshState('reloading')
      await Promise.all([
        invalidateByOpPrefix(queryClient, "getApiV1ProjectsByNameGoogleGsc"),
        invalidateByOpPrefix(queryClient, "getApiV1ProjectsByNameBing"),
      ])
      await loadSummary(true)
      setWorkspaceRefreshNonce((current) => current + 1)

      if (failures.length > 0) {
        setError(`Partial refresh: ${failures.join('; ')}`)
      }
    } catch (err) {
      if (!signal.aborted) {
        setError(err instanceof Error ? err.message : 'Refresh failed')
      }
    } finally {
      if (!signal.aborted) {
        setRefreshState('idle')
      }
    }
  }

  useEffect(() => {
    void loadSummary()
    return () => {
      abortRef.current?.abort()
    }
  }, [projectName])

  const googleTone = googleConnection ? 'positive' : googleConfigured ? 'caution' : 'negative'
  const googleStatus = googleConnection ? 'Connected' : googleConfigured ? 'Ready to connect' : 'Needs setup'
  const googleCoverageValue = googleCoverage
    ? `${googleCoverage.summary.percentage}% indexed`
    : googleConnection
      ? 'Awaiting coverage'
      : 'No coverage data'
  const googleNote = googleCoverage
    ? `${googleCoverage.summary.notIndexed} not indexed${googleCoverage.summary.deindexed > 0 ? ` · ${googleCoverage.summary.deindexed} deindexed` : ''}`
    : googleConnection
      ? 'Run sitemap inspection to populate coverage'
      : googleConfigured
        ? 'Connect Search Console for this domain'
        : 'Add Google OAuth credentials in Settings'
  const googleUpdatedAt = googleCoverage?.lastSyncedAt ?? googleCoverage?.lastInspectedAt ?? googleConnection?.updatedAt ?? null

  const bingTone = bingConnection?.connected ? 'positive' : bingConfigured ? 'caution' : 'negative'
  const bingStatus = bingConnection?.connected ? 'Connected' : bingConfigured ? 'Ready to connect' : 'Needs setup'
  const bingCoverageValue = bingCoverage
    ? `${bingCoverage.summary.percentage}% indexed`
    : bingConnection?.connected
      ? 'Awaiting coverage'
      : 'No coverage data'
  const bingNotInIndex = bingCoverage
    ? bingCoverage.summary.notIndexed + (bingCoverage.summary.unknown ?? 0)
    : 0
  const bingNote = bingCoverage
    ? `${bingNotInIndex} not in index`
    : bingConnection?.connected
      ? 'Inspect URLs to populate coverage'
      : bingConfigured
        ? 'Connect Bing Webmaster Tools for this domain'
        : 'Add a Bing API key in Settings'
  const bingUpdatedAt = bingCoverage?.lastInspectedAt ?? bingConnection?.updatedAt ?? null

  return (
    <div className="space-y-6">
      <Card className="surface-card">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Search engines</p>
            <h2>Coverage &amp; performance</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-zinc-500">
              Scan both engines at a glance, then open the Google or Bing workspace when you need to inspect coverage or take action.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" disabled={loading || refreshState !== 'idle'} onClick={() => void handleRefresh()}>
            {loading ? 'Loading…' : refreshState === 'syncing' ? 'Refreshing Google & Bing…' : refreshState === 'reloading' ? 'Reloading workspaces…' : 'Refresh all'}
          </Button>
        </div>

        {error && (
          <div className="mb-3 rounded-lg border border-rose-800/40 bg-rose-950/20 px-3 py-2 text-sm text-rose-300">
            {error}
          </div>
        )}

        <div className="grid gap-3 lg:grid-cols-2">
          <SearchConsoleSummaryCard
            eyebrow="Google"
            title="Google Search Console"
            status={loading ? 'Loading…' : googleStatus}
            tone={loading ? 'neutral' : googleTone}
            targetLabel="Selected property"
            targetValue={googleConnection?.propertyId ?? 'No property selected'}
            coverageValue={loading ? 'Loading…' : googleCoverageValue}
            note={loading ? 'Loading overview…' : googleNote}
            updatedAt={googleUpdatedAt}
            active={workspace === 'google'}
            onClick={() => setWorkspace('google')}
          />
          <SearchConsoleSummaryCard
            eyebrow="Bing"
            title="Bing Webmaster Tools"
            status={loading ? 'Loading…' : bingStatus}
            tone={loading ? 'neutral' : bingTone}
            targetLabel="Selected site"
            targetValue={bingConnection?.siteUrl ?? 'No site selected'}
            coverageValue={loading ? 'Loading…' : bingCoverageValue}
            note={loading ? 'Loading overview…' : bingNote}
            updatedAt={bingUpdatedAt}
            active={workspace === 'bing'}
            onClick={() => setWorkspace('bing')}
          />
        </div>
      </Card>

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

function formatQueryList(queries: string[], max = 4): string {
  if (queries.length <= max) return queries.map(q => `"${q}"`).join(', ')
  const shown = queries.slice(0, max).map(q => `"${q}"`).join(', ')
  return `${shown}, and ${queries.length - max} more`
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
            {numeric ? <span className="text-zinc-600">%</span> : null}
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
  onJumpToEvidence,
  onJumpToActions,
}: {
  model: ProjectCommandCenterVm
  sweepRunning: boolean
  onJumpToEvidence: () => void
  onJumpToActions: () => void
}) {
  const citationMovement = model.citationMovement
  const mentionMovement = model.mentionMovement
  const comparison = model.movementComparison
  const latestSweep = model.recentRuns.find(run => run.kind === RunKinds['answer-visibility'])
  const primaryAction = model.insights.find(insight => insight.actionGroup === 'investigate')
    ?? model.insights.find(insight => insight.actionGroup === 'write')
    ?? model.insights.at(0)
  const suggestedQuery = model.suggestedQueries.rows.at(0)
  const engineCount = new Set(model.providerScores.map(score => score.provider)).size
  const locationCount = model.project.locations.length

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

  const movedQueries = [...new Set([
    ...(mentionMovement.lostQueries ?? []),
    ...(citationMovement.lostQueries ?? []),
    ...(mentionMovement.gainedQueries ?? []),
    ...(citationMovement.gainedQueries ?? []),
  ])]

  const scope = `${model.queryCounts.total} ${model.queryCounts.total === 1 ? 'query' : 'queries'} across ${engineCount} ${engineCount === 1 ? 'engine' : 'engines'}`
  const locationScope = locationCount > 0
    ? `${locationCount} ${locationCount === 1 ? 'location' : 'locations'}`
    : 'project-wide'

  return (
    <section className="overview-brief" aria-labelledby="overview-brief-title">
      <div className="overview-brief-head">
        <div>
          <p className="eyebrow eyebrow-soft">
            Operator brief
            <InfoTooltip text="Each sweep records two independent signals: answer mentions (your brand named in the answer text) and source citations (your domain in the engine's source list). They move separately." />
          </p>
          <h2 id="overview-brief-title" className="overview-brief-title">{headline}</h2>
          <p className="overview-brief-scope">
            Tracking {scope}, {locationScope}.
          </p>
        </div>
        <p className="overview-brief-updated">
          {latestSweep ? `Latest sweep ${latestSweep.startedAt}` : 'No sweep completed yet'}
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
          <p className="overview-brief-label">Since previous sweep</p>
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
                  <span className="text-emerald-400">+{mentionMovement.gained}</span>
                  <span className="text-rose-400">-{mentionMovement.lost}</span>
                </div>
                <div className="overview-signal-change-row">
                  <span className="overview-signal-change-label">Cited</span>
                  <span className="text-emerald-400">+{citationMovement.gained}</span>
                  <span className="text-rose-400">-{citationMovement.lost}</span>
                </div>
              </div>
              <p className={`overview-brief-panel-copy ${comparison.querySetChanged ? 'text-amber-400/80' : ''}`}>
                {comparison.querySetChanged
                  ? `Query basket changed: +${comparison.addedQueryCount} added, -${comparison.removedQueryCount} removed. Movement compares ${comparison.comparableQueryCount} shared queries.`
                  : `Same ${comparison.comparableQueryCount}-query basket${comparison.previousRunAt ? ` since ${formatTimestamp(comparison.previousRunAt)}` : ''}.`}
              </p>
              {movedQueries.length > 0 && (
                <p className="overview-brief-panel-copy">Affected: {formatQueryList(movedQueries, 2)}</p>
              )}
              <button type="button" className="overview-brief-link" onClick={onJumpToEvidence}>
                Review query evidence
              </button>
            </>
          )}
        </div>

        <div className="overview-brief-panel">
          <p className="overview-brief-label">Next action</p>
          {primaryAction ? (
            <>
              <p className="overview-brief-panel-title">{primaryAction.title}</p>
              {primaryAction.detail && <p className="overview-brief-panel-copy">{primaryAction.detail}</p>}
              <button type="button" className="overview-brief-link" onClick={onJumpToActions}>
                Open action queue
              </button>
            </>
          ) : suggestedQuery ? (
            <>
              <p className="overview-brief-panel-title">Consider tracking “{suggestedQuery.query}”</p>
              <p className="overview-brief-panel-copy">{suggestedQuery.reason}</p>
              <button type="button" className="overview-brief-link" onClick={onJumpToActions}>
                Review query suggestions
              </button>
            </>
          ) : (
            <>
              <p className="overview-brief-panel-title">No outstanding action</p>
              <p className="overview-brief-panel-copy">Keep monitoring. Canonry will surface regressions and new query opportunities here.</p>
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
  children,
}: {
  id?: string
  eyebrow: string
  title: string
  meta?: string
  children: React.ReactNode
}) {
  return (
    <details id={id} className="overview-disclosure page-section-divider scroll-mt-24">
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

function MentionShareBreakdown({
  summary,
  projectLabel,
}: {
  summary: ProjectCommandCenterVm['mentionShareSummary']
  projectLabel: string
}) {
  const breakdown = summary.breakdown
  if (breakdown.perCompetitor.length === 0) return null
  const combinedTotal = breakdown.projectMentionSnapshots + breakdown.competitorMentionSnapshots
  if (combinedTotal === 0) return null

  // Rows merge the project (you) with each tracked competitor, sorted by
  // mention count. Share is computed against the combined total so the rows
  // read as "% of all brand mentions in the run" — matching the headline.
  const rows = [
    { label: `${projectLabel} (you)`, mentions: breakdown.projectMentionSnapshots, isYou: true },
    ...breakdown.perCompetitor.map(c => ({ label: c.domain, mentions: c.mentionSnapshots, isYou: false })),
  ].sort((a, b) => b.mentions - a.mentions)
  const maxMentions = rows[0]?.mentions ?? 1

  return (
    <div className="mention-share-breakdown">
      <p className="mention-share-breakdown-title">Mention share breakdown · latest run</p>
      <ul className="mention-share-breakdown-rows">
        {rows.map(row => {
          const share = (row.mentions / combinedTotal) * 100
          return (
            <li key={row.label} className="mention-share-breakdown-row">
              <span className={`mention-share-breakdown-label ${row.isYou ? 'text-zinc-100 font-medium' : 'text-zinc-400'}`}>
                {row.label}
              </span>
              <div className="mention-share-breakdown-bar">
                <div
                  className={`mention-share-breakdown-bar-fill ${row.isYou ? 'bg-emerald-500/70' : 'bg-zinc-500/60'}`}
                  style={{ width: `${Math.max((row.mentions / maxMentions) * 100, 2)}%` }}
                />
              </div>
              <span className="mention-share-breakdown-count">{row.mentions}</span>
              <span className="mention-share-breakdown-share">{share.toFixed(1)}%</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

const ACTION_GROUP_META: Record<'write' | 'investigate' | 'monitor', { title: string; subtitle: string }> = {
  write: {
    title: 'Write or update content',
    subtitle: 'Queries with no answer, persistent gaps, or competitors winning the spot',
  },
  investigate: {
    title: 'Investigate what changed',
    subtitle: 'Citations or mentions you lost since the previous run',
  },
  monitor: {
    title: 'Keep monitoring',
    subtitle: 'Gains, new providers picking you up, holding ground',
  },
}

function InsightSignals({
  insights,
  suggestedQueries,
  projectName,
}: {
  insights: ProjectCommandCenterVm['insights']
  suggestedQueries: ProjectCommandCenterVm['suggestedQueries']
  projectName: string
}) {
  const { openEvidence } = useDrawer()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const hasSuggestions = suggestedQueries.rows.length > 0
  if (insights.length === 0 && !hasSuggestions) {
    return (
      <p className="text-sm text-zinc-500">
        No outstanding opportunities. Trigger a sweep to surface fresh signals.
      </p>
    )
  }

  const groups: Array<'write' | 'investigate' | 'monitor'> = ['investigate', 'write', 'monitor']
  const grouped = new Map<string, typeof insights>()
  for (const ins of insights) {
    const bucket = grouped.get(ins.actionGroup) ?? []
    bucket.push(ins)
    grouped.set(ins.actionGroup, bucket)
  }

  return (
    <div className="opportunities-grid">
      {groups.map(group => {
        const items = grouped.get(group)
        if (!items || items.length === 0) return null
        const meta = ACTION_GROUP_META[group]
        const itemRows = (
          <div className="opportunity-card-list">
            {items.map((insight) => {
                const isExpanded = expandedId === insight.id
                const hasAffected = insight.affectedPhrases.length > 0
                return (
                  <div key={insight.id}>
                    <div
                      className={`opportunity-item opportunity-item-${insight.tone} ${hasAffected ? 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400' : ''}`}
                      onClick={hasAffected ? () => setExpandedId(isExpanded ? null : insight.id) : undefined}
                      onKeyDown={hasAffected ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setExpandedId(isExpanded ? null : insight.id)
                        }
                      } : undefined}
                      tabIndex={hasAffected ? 0 : undefined}
                      role={hasAffected ? 'button' : undefined}
                      aria-expanded={hasAffected ? isExpanded : undefined}
                    >
                      <div className="flex items-start gap-1.5 min-w-0">
                        {hasAffected && (
                          <ChevronRight
                            size={12}
                            className={`mt-1 shrink-0 text-zinc-500 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
                          />
                        )}
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-zinc-100 leading-snug">{insight.title}</p>
                          {insight.detail && <p className="text-[11px] text-zinc-500 mt-0.5 leading-snug">{insight.detail}</p>}
                        </div>
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="opportunity-item-detail">
                        {insight.affectedPhrases.map((ap, i) => (
                          <div
                            key={ap.evidenceId || `${insight.id}-${i}`}
                            className="flex items-center justify-between gap-2"
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              <CitationBadge state={ap.citationState} />
                              <span className="text-xs text-zinc-300 truncate">{ap.query}</span>
                              {ap.provider && <ProviderBadge provider={ap.provider} />}
                            </div>
                            {ap.evidenceId && (
                              <button
                                type="button"
                                className="text-[11px] text-zinc-400 hover:text-zinc-200 whitespace-nowrap"
                                onClick={(e) => { e.stopPropagation(); void openEvidence(ap.evidenceId) }}
                              >
                                View →
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
            })}
          </div>
        )

        if (group === 'monitor') {
          return (
            <details key={group} className="opportunity-card opportunity-card-monitor opportunity-monitor">
              <summary className="opportunity-monitor-summary">
                <span>
                  <span className="opportunity-card-title">{meta.title}</span>
                  <span className="opportunity-card-subtitle mt-1 block">{meta.subtitle}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="opportunity-card-count">{items.length}</span>
                  <ChevronDown className="opportunity-monitor-icon text-zinc-500" size={14} aria-hidden="true" />
                </span>
              </summary>
              {itemRows}
            </details>
          )
        }

        return (
          <div key={group} className={`opportunity-card opportunity-card-${group}`}>
            <div className="opportunity-card-head">
              <p className="opportunity-card-title">{meta.title}</p>
              <span className="opportunity-card-count">{items.length}</span>
            </div>
            <p className="opportunity-card-subtitle">{meta.subtitle}</p>
            {itemRows}
          </div>
        )
      })}
      {hasSuggestions && (
        <SuggestedQueriesCard suggestedQueries={suggestedQueries} projectName={projectName} />
      )}
    </div>
  )
}

function SuggestedQueriesCard({
  suggestedQueries,
  projectName,
}: {
  suggestedQueries: ProjectCommandCenterVm['suggestedQueries']
  projectName: string
}) {
  const appendQueries = useAppendQueries()
  // Track per-row pending state so users can add several at once without
  // each click disabling the whole card. Cleared after invalidation refetches
  // the dashboard and the suggestion drops off the list.
  const [pending, setPending] = useState<Set<string>>(new Set())

  const handleAdd = (query: string) => {
    setPending(prev => new Set(prev).add(query))
    appendQueries.mutate(
      { projectName, queries: [query] },
      {
        // Clear pending on BOTH success and error. The mutation's
        // invalidation refetches the dashboard, but the suggestion row may
        // still appear in the next payload (GSC suggestions don't drop off
        // instantly), so relying on unmount-on-refetch to clear `pending`
        // leaves the button stuck on "Adding…" indefinitely. The explicit
        // clears here are the source of truth for per-row UI state.
        onSuccess: () => {
          addToast({ tone: 'positive', title: `Tracking "${query}"` })
          setPending(prev => {
            const next = new Set(prev)
            next.delete(query)
            return next
          })
        },
        onError: (err) => {
          addToast({ tone: 'negative', title: `Couldn't add "${query}"`, detail: String(err) })
          setPending(prev => {
            const next = new Set(prev)
            next.delete(query)
            return next
          })
        },
      },
    )
  }

  const { rows, totalCandidates, skippedAlreadyTracked } = suggestedQueries
  const subtitle = skippedAlreadyTracked > 0
    ? `GSC queries you're getting impressions for · ${skippedAlreadyTracked} already tracked`
    : `GSC queries you're getting impressions for but aren't tracking yet`

  return (
    <div className="opportunity-card opportunity-card-track">
      <div className="opportunity-card-head">
        <p className="opportunity-card-title">Track new queries</p>
        <span className="opportunity-card-count">
          {totalCandidates > rows.length ? `${rows.length} of ${totalCandidates}` : rows.length}
        </span>
      </div>
      <p className="opportunity-card-subtitle">{subtitle}</p>
      <div className="opportunity-card-list">
        {rows.map(suggestion => {
          const isPending = pending.has(suggestion.query)
          return (
            <div
              key={suggestion.query}
              className="opportunity-item opportunity-item-neutral flex items-center justify-between gap-2"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-zinc-100 leading-snug truncate" title={suggestion.query}>
                  {suggestion.query}
                </p>
                <p className="text-[11px] text-zinc-500 mt-0.5 leading-snug">{suggestion.reason}</p>
              </div>
              <button
                type="button"
                className="suggested-query-add"
                disabled={isPending}
                onClick={() => handleAdd(suggestion.query)}
              >
                {isPending ? 'Adding…' : '+ Track'}
              </button>
            </div>
          )
        })}
      </div>
    </div>
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

  return <ProjectPageContent model={model} refetch={refetch} {...props} />
}

type ProjectTabItem = { key: ProjectPageTab; label: string; href: string }

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
  tab,
  model,
  refetch,
}: {
  tab: ProjectPageTab
  model: ProjectCommandCenterVm
  refetch: () => Promise<void>
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  // "Local Presence" is always shown — GbpSection renders a setup guide when no
  // Google Business Profile is connected, so the tab is the entry point to
  // connecting one rather than being hidden until after connection.
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [managingQueries, setManagingQueries] = useState(false)
  const [newQueryText, setNewQueryText] = useState('')
  const [querySaving, setQuerySaving] = useState(false)
  const [removingQuery, setRemovingQuery] = useState<string | null>(null)
  const [addingCompetitor, setAddingCompetitor] = useState(false)
  const [newCompetitorDomain, setNewCompetitorDomain] = useState('')
  const [competitorSaving, setCompetitorSaving] = useState(false)
  const [addingOwnedDomain, setAddingOwnedDomain] = useState(false)
  const [newOwnedDomain, setNewOwnedDomain] = useState('')
  const [ownedDomainSaving, setOwnedDomainSaving] = useState(false)
  const [addingAlias, setAddingAlias] = useState(false)
  const [newAlias, setNewAlias] = useState('')
  const [aliasSaving, setAliasSaving] = useState(false)
  const [locationFilter, setLocationFilter] = useState<string | undefined>(undefined)
  const [compareLocations, setCompareLocations] = useState(false)
  const [competitorFilter, setCompetitorFilter] = useState<string | null>(null)
  const [locationTimeline, setLocationTimeline] = useState<import('../api.js').ApiTimelineEntry[] | null>(null)
  const [_locationTimelineLoading, setLocationTimelineLoading] = useState(false)

  const visibilityEvidence = model?.visibilityEvidence ?? []
  const projectName = model?.project.name ?? ''
  const projectLabel = model?.project.displayName || model?.project.name || projectName
  const triggerRunMutation = useTriggerRun()

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
  // The authoritative tracked-query set — every query the project tracks,
  // including ones added but not yet run (build-dashboard seeds a "pending"
  // evidence row for those). This is the same source as the "N queries tracked"
  // header count, so the manage list and the count never diverge. Sorted for a
  // stable order in the manage panel.
  const trackedQueries = useMemo(
    () => [...new Set(visibilityEvidence.map(e => e.query))].sort((a, b) => a.localeCompare(b)),
    [visibilityEvidence],
  )
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
    fetchTimeline(projectName, locationFilter)
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

  async function handleExport() {
    try {
      const data = await fetchExport(projectName)
      const yaml = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
      const blob = new Blob([yaml], { type: 'text/yaml' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${projectName}.yaml`
      a.click()
      // Blob URL is revoked asynchronously — a.click() returns void with no
      // completion signal, so revoking synchronously can break the download.
      // The blob is small and will be GC'd when the page unloads.
    } catch (err) {
      addToast({
        title: 'Export failed',
        detail: err instanceof Error ? err.message : 'Could not export project YAML.',
        tone: 'negative',
      })
    }
  }

  async function handleAddQueries() {
    const queries = newQueryText.split('\n').map(k => k.trim()).filter(Boolean)
    if (queries.length === 0) return
    setQuerySaving(true)
    try {
      await apiAppendQueries(projectName, queries)
      void refetch()
      setNewQueryText('')
    } finally {
      setQuerySaving(false)
    }
  }

  async function handleRemoveQuery(query: string) {
    setRemovingQuery(query)
    try {
      await apiRemoveQueries(projectName, [query])
      void refetch()
    } catch (err) {
      addToast({
        title: 'Could not remove query',
        detail: err instanceof Error ? err.message : `Failed to remove "${query}"`,
        tone: 'negative',
        dedupeKey: 'query:remove',
        dedupeMode: 'replace',
      })
    } finally {
      setRemovingQuery(null)
    }
  }

  async function handleAddCompetitor() {
    const domain = newCompetitorDomain.trim()
    if (!domain) return
    setCompetitorSaving(true)
    try {
      const existing = await apiFetchCompetitors(projectName)
      const existingDomains = existing.map(c => c.domain)
      const merged = [...new Set([...existingDomains, domain])]
      await apiSetCompetitors(projectName, merged)
      void refetch()
      setNewCompetitorDomain('')
      setAddingCompetitor(false)
    } finally {
      setCompetitorSaving(false)
    }
  }

  async function handleRemoveCompetitor(domain: string) {
    try {
      await apiRemoveCompetitors(projectName, [domain])
      void refetch()
    } catch (err) {
      addToast({
        title: 'Could not remove competitor',
        detail: err instanceof Error ? err.message : `Failed to remove ${domain}`,
        tone: 'negative',
        dedupeKey: 'competitor:remove',
        dedupeMode: 'replace',
      })
    }
  }

  async function handleAddOwnedDomain() {
    const domain = newOwnedDomain.trim()
    if (!domain) return
    setOwnedDomainSaving(true)
    try {
      const current = model?.project.ownedDomains ?? []
      await apiUpdateOwnedDomains(projectName, [...current, domain])
      void refetch()
      setNewOwnedDomain('')
      setAddingOwnedDomain(false)
    } finally {
      setOwnedDomainSaving(false)
    }
  }

  async function handleRemoveOwnedDomain(domain: string) {
    setOwnedDomainSaving(true)
    try {
      const current = model?.project.ownedDomains ?? []
      await apiUpdateOwnedDomains(projectName, current.filter(d => d !== domain))
      void refetch()
    } finally {
      setOwnedDomainSaving(false)
    }
  }

  async function handleAddAlias() {
    const alias = newAlias.trim()
    if (!alias) return
    setAliasSaving(true)
    try {
      const current = model?.project.aliases ?? []
      // Case-insensitive dedupe in the UI so the user gets immediate
      // feedback if they type a duplicate; the server normalizes again on save.
      const key = alias.toLowerCase()
      if (current.some(a => a.toLowerCase() === key)) {
        setNewAlias('')
        setAddingAlias(false)
        return
      }
      await apiUpdateAliases(projectName, [...current, alias])
      void refetch()
      setNewAlias('')
      setAddingAlias(false)
    } finally {
      setAliasSaving(false)
    }
  }

  async function handleRemoveAlias(alias: string) {
    setAliasSaving(true)
    try {
      const current = model?.project.aliases ?? []
      await apiUpdateAliases(projectName, current.filter(a => a !== alias))
      void refetch()
    } finally {
      setAliasSaving(false)
    }
  }

  async function handleUpdateProject(pName: string, updates: { displayName?: string; canonicalDomain?: string; ownedDomains?: string[]; aliases?: string[]; country?: string; language?: string; locations?: Array<{ label: string; city: string; region: string; country: string; timezone?: string }>; defaultLocation?: string | null }) {
    await apiUpdateProject(pName, updates)
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
  }

  // Quiet underline tabs (Vercel/Linear lineage), not a pill rack. Section nav
  // is chrome: plain text that recedes, the active tab marked by a Snow
  // underline on the bar's hairline. Low-frequency sections (Report) live in a
  // trailing "More" overflow; Settings is split out at the far right (universal
  // convention). "Local Presence" only appears once GBP is connected.
  const projectTabBase = `/projects/${encodeURIComponent(model.project.name)}`
  const projectTabItems: ProjectTabItem[] = [
    { key: 'overview', label: 'Overview', href: projectTabBase },
    { key: 'search-console', label: 'Search Engines', href: `${projectTabBase}/search-console` },
    { key: 'activity', label: 'Activity', href: `${projectTabBase}/activity` },
    { key: 'technical-aeo', label: 'Technical AEO', href: `${projectTabBase}/technical-aeo` },
    { key: 'local', label: 'Local Presence', href: `${projectTabBase}/local` },
    { key: 'discovery', label: 'Query Discovery', href: `${projectTabBase}/discovery` },
    { key: 'backlinks', label: 'Backlinks', href: `${projectTabBase}/backlinks` },
  ]
  const projectOverflowTabItems: ProjectTabItem[] = [
    { key: 'report', label: 'Report', href: `${projectTabBase}/report` },
  ]
  const projectSettingsTab = { key: 'settings' as const, label: 'Settings', href: `${projectTabBase}/settings` }

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
      {showDeleteConfirm ? (
        <Card className="surface-card p-6 mb-6 border-rose-800/60">
          <h3 className="text-base font-semibold text-rose-400 mb-2">Delete project?</h3>
          <p className="text-sm text-zinc-400 mb-4">
            This will permanently delete <strong className="text-zinc-200">{model.project.displayName || model.project.name}</strong> and
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
      ) : null}
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">{model.project.displayName || model.project.name}</h1>
          <p className="page-subtitle">
            {model.project.canonicalDomain}
            {(model.project.ownedDomains ?? []).length === 0 && !addingOwnedDomain && (
              <button
                type="button"
                className="ml-2 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors"
                onClick={() => setAddingOwnedDomain(true)}
              >+ add domain</button>
            )}
            {' '} · {model.contextLabel}
          </p>
          <div className="tag-row">
            <span className="tag">{model.project.country}</span>
            <span className="tag">{model.project.language.toUpperCase()}</span>
            {model.project.tags.map((tag) => (
              <span key={tag} className="tag">
                {tag}
              </span>
            ))}
          </div>
          {((model.project.ownedDomains ?? []).length > 0 || addingOwnedDomain) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wide text-zinc-500 mr-1">Also tracking</span>
              {(model.project.ownedDomains ?? []).map((d) => (
                <span key={d} className="inline-flex items-center gap-1 rounded-full border border-zinc-700/60 bg-zinc-800/40 px-2 py-0.5 text-xs text-zinc-300">
                  {d}
                  <button
                    type="button"
                    className="-mr-1 ml-0.5 inline-flex items-center justify-center rounded p-1 leading-none text-zinc-500 hover:bg-zinc-700/40 hover:text-zinc-200 transition-colors"
                    disabled={ownedDomainSaving}
                    onClick={() => { void handleRemoveOwnedDomain(d) }}
                    aria-label={`Remove ${d}`}
                  >×</button>
                </span>
              ))}
              {addingOwnedDomain ? (
                <span className="inline-flex items-center gap-1">
                  <input
                    className="rounded border border-zinc-700 bg-transparent px-1.5 py-0.5 text-xs text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none w-40"
                    type="text"
                    placeholder="docs.example.com"
                    value={newOwnedDomain}
                    onChange={(e) => setNewOwnedDomain(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { void handleAddOwnedDomain() } }}
                    autoFocus
                  />
                  <Button type="button" size="sm" disabled={!newOwnedDomain.trim() || ownedDomainSaving} onClick={asyncHandler(handleAddOwnedDomain)}>
                    {ownedDomainSaving ? '...' : 'Add'}
                  </Button>
                  <button type="button" className="text-xs text-zinc-500 hover:text-zinc-300" onClick={() => { setAddingOwnedDomain(false); setNewOwnedDomain('') }}>Cancel</button>
                </span>
              ) : (
                <button
                  type="button"
                  className="rounded-full border border-dashed border-zinc-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 transition-colors"
                  onClick={() => setAddingOwnedDomain(true)}
                >+ domain</button>
              )}
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-zinc-500 mr-1">
              Also known as
              <InfoTooltip text="Extra brand names checked against LLM answer text alongside the project name. Use for product names, prior names, or DBAs (e.g. add Meta as an alias to facebook.com). Changing these recomputes mentions on historical runs." />
            </span>
            {(model.project.aliases ?? []).map((a) => (
              <span key={a} className="inline-flex items-center gap-1 rounded-full border border-zinc-700/60 bg-zinc-800/40 px-2 py-0.5 text-xs text-zinc-300">
                {a}
                <button
                  type="button"
                  className="-mr-1 ml-0.5 inline-flex items-center justify-center rounded p-1 leading-none text-zinc-500 hover:bg-zinc-700/40 hover:text-zinc-200 transition-colors"
                  disabled={aliasSaving}
                  onClick={() => { void handleRemoveAlias(a) }}
                  aria-label={`Remove ${a}`}
                >×</button>
              </span>
            ))}
            {addingAlias ? (
              <span className="inline-flex items-center gap-1">
                <input
                  className="rounded border border-zinc-700 bg-transparent px-1.5 py-0.5 text-xs text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none w-40"
                  type="text"
                  placeholder="LlamaParse"
                  value={newAlias}
                  onChange={(e) => setNewAlias(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { void handleAddAlias() } }}
                  autoFocus
                />
                <Button type="button" size="sm" disabled={!newAlias.trim() || aliasSaving} onClick={asyncHandler(handleAddAlias)}>
                  {aliasSaving ? '...' : 'Add'}
                </Button>
                <button type="button" className="text-xs text-zinc-500 hover:text-zinc-300" onClick={() => { setAddingAlias(false); setNewAlias('') }}>Cancel</button>
              </span>
            ) : (
              <button
                type="button"
                className="rounded-full border border-dashed border-zinc-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 transition-colors"
                onClick={() => setAddingAlias(true)}
              >+ alias</button>
            )}
          </div>
        </div>
        <div className="page-header-right">
          <p className="text-sm text-zinc-500">{model.dateRangeLabel}</p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="icon" onClick={asyncHandler(handleExport)} aria-label="Export project as YAML">
              <Download className="h-4 w-4 text-zinc-400" />
            </Button>
            <Button type="button" variant="outline" size="icon" onClick={() => setShowDeleteConfirm(true)} aria-label="Delete project">
              <Trash2 className="h-4 w-4 text-zinc-400" />
            </Button>
            <Button
              type="button"
              disabled={triggerRunMutation.isPending || hasActiveVisibilitySweep}
              onClick={asyncHandler(handleTriggerRun)}
            >
              {triggerRunMutation.isPending
                ? 'Starting…'
                : hasActiveVisibilitySweep
                  ? 'Sweep running…'
                  : 'Run now'}
            </Button>
          </div>
        </div>
      </div>

      <nav className="project-subnav" aria-label="Project sections">
        {projectTabItems.map((item) => (
          <Link
            key={item.key}
            to={item.href}
            className={`project-subnav-link ${item.key === tab ? 'project-subnav-link-active' : ''}`}
            aria-current={item.key === tab ? 'page' : undefined}
          >
            {item.label}
          </Link>
        ))}
        <div className="project-subnav-trailing">
          <ProjectSubnavMore items={projectOverflowTabItems} activeTab={tab} />
          <Link
            key={projectSettingsTab.key}
            to={projectSettingsTab.href}
            className={`project-subnav-link ${tab === 'settings' ? 'project-subnav-link-active' : ''}`}
            aria-current={tab === 'settings' ? 'page' : undefined}
          >
            {projectSettingsTab.label}
          </Link>
        </div>
      </nav>

      {tab === 'overview' ? (
        <>
          <OverviewBrief
            model={model}
            sweepRunning={hasActiveVisibilitySweep}
            onJumpToEvidence={() => focusOverviewSection('evidence-section', true)}
            onJumpToActions={() => focusOverviewSection('action-queue')}
          />

          <section id="action-queue" className="page-section-divider scroll-mt-24 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500/60" tabIndex={-1}>
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">Action queue</p>
                <h2>What needs your attention</h2>
              </div>
            </div>
            <InsightSignals
              insights={model.insights}
              suggestedQueries={model.suggestedQueries}
              projectName={projectName}
            />
          </section>

          <section className="page-section-divider">
            <VisibilityTrendSection projectName={model.project.name} />
          </section>

          <section className="page-section-divider">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">Competitive</p>
                <h2>Where competitors are winning</h2>
              </div>
              <div className="flex items-center gap-3">
                <p className="supporting-copy">{model.competitors.length} tracked</p>
                <Button type="button" variant="outline" size="sm" onClick={() => setAddingCompetitor(!addingCompetitor)}>
                  {addingCompetitor ? 'Cancel' : '+ Add competitor'}
                </Button>
              </div>
            </div>

            <div className="aeo-hero competitive-summary">
              <div className="aeo-hero-rows">
                <OverviewMetricRow
                  label="Mention share"
                  summary={model.mentionShareSummary}
                  tooltip="Of all brand mentions in answer text across your tracked queries (you + tracked competitors), the percentage that were you. Measured from the latest sweep."
                />
                <OverviewMetricRow
                  label="Mention gaps"
                  summary={model.mentionGaps}
                  displayValue={<><span className="text-zinc-50">{model.mentionGaps.value}</span><span className="text-zinc-600"> / {model.queryCounts.total}</span></>}
                  tooltip="Queries where a competitor was mentioned in the answer but your brand was not."
                />
                <OverviewMetricRow
                  label="Citation gaps"
                  summary={model.gapQueries}
                  displayValue={<><span className="text-zinc-50">{model.gapQueries.value}</span><span className="text-zinc-600"> / {model.queryCounts.total}</span></>}
                  tooltip="Queries where a competitor was cited as a source but you were not."
                />
              </div>

              <MentionShareBreakdown
                summary={model.mentionShareSummary}
                projectLabel={model.project.displayName || model.project.name}
              />
            </div>

            {addingCompetitor && (
              <div className="mt-4 mb-3 flex gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                <input
                  className="flex-1 rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                  type="text"
                  placeholder="competitor.com"
                  value={newCompetitorDomain}
                  onChange={(e) => setNewCompetitorDomain(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { void handleAddCompetitor() } }}
                />
                <Button type="button" size="sm" disabled={!newCompetitorDomain.trim() || competitorSaving} onClick={asyncHandler(handleAddCompetitor)}>
                  {competitorSaving ? 'Adding...' : 'Add'}
                </Button>
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
                    onRemoveCompetitor={(domain) => { void handleRemoveCompetitor(domain) }}
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
          >
            <div className="mb-3 flex items-center justify-end">
              <Button type="button" variant="outline" size="sm" onClick={() => setManagingQueries(!managingQueries)}>
                {managingQueries ? 'Done' : 'Manage queries'}
              </Button>
            </div>
            {managingQueries && (
              <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                {trackedQueries.length > 0 ? (
                  <ul className="mb-3 max-h-64 divide-y divide-zinc-800/60 overflow-y-auto rounded border border-zinc-800/60">
                    {trackedQueries.map((q) => (
                      <li key={q} className="flex items-center justify-between gap-3 px-3 py-2">
                        <span className="min-w-0 truncate text-sm text-zinc-200" title={q}>{q}</span>
                        <button
                          type="button"
                          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-zinc-500 transition-colors hover:text-rose-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rose-500 disabled:opacity-50"
                          aria-label={`Remove query ${q}`}
                          title={`Stop tracking "${q}"`}
                          disabled={removingQuery !== null}
                          onClick={() => { void handleRemoveQuery(q) }}
                        >
                          {removingQuery === q ? 'Removing…' : 'Remove'}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mb-3 text-xs text-zinc-500">No queries tracked yet. Add some below.</p>
                )}
                <textarea
                  className="w-full resize-none rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                  rows={3}
                  placeholder="Enter queries to add, one per line"
                  value={newQueryText}
                  onChange={(e) => setNewQueryText(e.target.value)}
                />
                <div className="mt-2 flex items-center justify-between">
                  <p className="text-xs text-zinc-500">{newQueryText.split('\n').filter(k => k.trim()).length} to add</p>
                  <Button type="button" size="sm" disabled={!newQueryText.trim() || querySaving} onClick={asyncHandler(handleAddQueries)}>
                    {querySaving ? 'Adding...' : 'Add queries'}
                  </Button>
                </div>
              </div>
            )}
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
              <div className="mb-3 flex items-center gap-2 rounded-md border border-rose-900/40 bg-rose-950/20 px-3 py-2">
                <span className="text-[11px] uppercase tracking-wide text-rose-400">Competitor filter</span>
                <span className="text-sm text-zinc-200">Showing queries where <span className="font-semibold">{competitorFilter}</span> surfaced</span>
                <button
                  type="button"
                  className="ml-auto text-xs text-zinc-400 hover:text-zinc-200"
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

          <OverviewDisclosure eyebrow="Analysis" title="Citation and engine diagnostics" meta="Deep dive">
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
                              {ps.model && <span className="text-[11px] font-mono text-zinc-500">{ps.model}</span>}
                            </div>
                          </td>
                          <td><span className="font-semibold text-zinc-200">{ps.score}%</span></td>
                          <td className="text-zinc-500">{ps.cited} of {ps.total}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </OverviewDisclosure>

          <OverviewDisclosure eyebrow="Run history" title="Recent execution history" meta={`${model.recentRuns.length} recent`}>
            <div className="run-list">
              {model.recentRuns.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </div>
          </OverviewDisclosure>

        </>
      ) : tab === 'settings' ? (
        <>
          <ProjectSettingsSection project={{ ...model.project, displayName: model.project.displayName ?? model.project.name, defaultLocation: model.project.defaultLocation ?? null }} onUpdateProject={handleUpdateProject} onRefresh={() => void refetch()} />
          <ScheduleSection projectName={model.project.name} />
          <NotificationsSection projectName={model.project.name} />
        </>
      ) : tab === 'report' ? (
        <ReportPage projectName={model.project.name} />
      ) : tab === 'discovery' ? (
        <DiscoverySection projectName={projectName} />
      ) : tab === 'technical-aeo' ? (
        <TechnicalAeoSection projectName={model.project.name} />
      ) : tab === 'activity' ? (
        <ActivitySection projectName={model.project.name} />
      ) : tab === 'backlinks' ? (
        <BacklinksSection projectName={model.project.name} />
      ) : tab === 'local' ? (
        // Local presence (Google Business Profile + Places). GbpSection
        // self-gates on the connection and renders its own empty state.
        <GbpSection projectName={model.project.name} projectId={model.project.id} />
      ) : (
        <SearchConsoleSection projectName={model.project.name} />
      )}
    </div>
  )
}
