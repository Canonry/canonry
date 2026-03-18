import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'

import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { formatTimestamp, formatBooleanState } from '../../lib/format-helpers.js'
import {
  fetchSettings,
  fetchGoogleConnections,
  fetchGoogleProperties,
  googleConnect,
  googleDisconnect,
  saveGoogleProperty,
  triggerGscSync,
  fetchGscPerformance,
  inspectGscUrl,
  fetchGscInspections,
  fetchGscDeindexed,
  fetchGscCoverage,
  fetchGscCoverageHistory,
  triggerInspectSitemap,
  triggerDiscoverSitemaps,
  saveSitemapUrl,
  fetchGscSitemaps,
  requestIndexing,
  type ApiGscSitemap,
  type ApiGoogleConnection,
  type ApiGoogleProperty,
  type ApiGscPerformanceRow,
  type ApiGscInspection,
  type ApiGscDeindexedRow,
  type ApiGscCoverageSummary,
} from '../../api.js'

export function GscSection({
  projectName,
}: {
  projectName: string
}) {
  const [googleConfigured, setGoogleConfigured] = useState(false)
  const [connections, setConnections] = useState<ApiGoogleConnection[]>([])
  const [properties, setProperties] = useState<ApiGoogleProperty[]>([])
  const [performance, setPerformance] = useState<ApiGscPerformanceRow[]>([])
  const [inspections, setInspections] = useState<ApiGscInspection[]>([])
  const [deindexed, setDeindexed] = useState<ApiGscDeindexedRow[]>([])
  const [inspectionResult, setInspectionResult] = useState<ApiGscInspection | null>(null)
  const [selectedProperty, setSelectedProperty] = useState('')
  const [inspectionUrl, setInspectionUrl] = useState('')
  const [syncDays, setSyncDays] = useState('30')
  const [fullSync, setFullSync] = useState(false)
  const [performanceFilters, setPerformanceFilters] = useState({
    startDate: '',
    endDate: '',
    query: '',
    page: '',
    limit: '20',
  })
  const [inspectionFilterUrl, setInspectionFilterUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [propertiesLoading, setPropertiesLoading] = useState(false)
  const [savingProperty, setSavingProperty] = useState(false)
  const [loadingPerformance, setLoadingPerformance] = useState(false)
  const [loadingInspections, setLoadingInspections] = useState(false)
  const [inspecting, setInspecting] = useState(false)
  const [coverage, setCoverage] = useState<ApiGscCoverageSummary | null>(null)
  const [loadingCoverage, setLoadingCoverage] = useState(false)
  const [inspectingSitemap, setInspectingSitemap] = useState(false)
  const [discoveringSitemaps, setDiscoveringSitemaps] = useState(false)
  const [listingSitemaps, setListingSitemaps] = useState(false)
  const [discoveredSitemaps, setDiscoveredSitemaps] = useState<ApiGscSitemap[] | null>(null)
  const [sitemapUrlInput, setSitemapUrlInput] = useState('')
  const [savingSitemap, setSavingSitemap] = useState(false)
  const [setupExpanded, setSetupExpanded] = useState(false)
  const [coverageTab, setCoverageTab] = useState<'indexed' | 'notIndexed' | 'deindexed'>('indexed')
  const [_coverageHistory, setCoverageHistory] = useState<Array<{ date: string; indexed: number; notIndexed: number; reasonBreakdown: Record<string, number> }>>([])
  const [selectedReason, setSelectedReason] = useState<string | null>(null)
  const [requestingIndexing, setRequestingIndexing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const gscConn = connections.find((c) => c.connectionType === 'gsc')
  const hasHistoricalData = performance.length > 0 || inspections.length > 0 || deindexed.length > 0

  async function loadProperties(currentConn: ApiGoogleConnection | undefined) {
    if (!currentConn) {
      setProperties([])
      setSelectedProperty('')
      return
    }

    setPropertiesLoading(true)
    try {
      const { sites } = await fetchGoogleProperties(projectName)
      setProperties(sites)
      setSelectedProperty(currentConn.propertyId ?? sites[0]?.siteUrl ?? '')
    } catch (err) {
      setProperties([])
      setError(err instanceof Error ? err.message : 'Failed to load Search Console properties')
    } finally {
      setPropertiesLoading(false)
    }
  }

  async function loadPerformanceRows() {
    setLoadingPerformance(true)
    try {
      const rows = await fetchGscPerformance(projectName, {
        startDate: performanceFilters.startDate || undefined,
        endDate: performanceFilters.endDate || undefined,
        query: performanceFilters.query || undefined,
        page: performanceFilters.page || undefined,
        limit: parseInt(performanceFilters.limit, 10) || 20,
      })
      setPerformance(rows)
    } catch (err) {
      setPerformance([])
      setError(err instanceof Error ? err.message : 'Failed to load GSC performance data')
    } finally {
      setLoadingPerformance(false)
    }
  }

  async function loadInspectionHistory() {
    setLoadingInspections(true)
    try {
      const [history, deindexedRows] = await Promise.all([
        fetchGscInspections(projectName, {
          url: inspectionFilterUrl.trim() || undefined,
          limit: 20,
        }),
        fetchGscDeindexed(projectName),
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

  async function loadCoverage() {
    setLoadingCoverage(true)
    try {
      const [data, history] = await Promise.all([
        fetchGscCoverage(projectName),
        fetchGscCoverageHistory(projectName).catch(() => []),
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
      if (failed === 0) {
        setNotice(`Indexing requested for ${succeeded} URL${succeeded !== 1 ? 's' : ''}.`)
      } else {
        setNotice(`Indexing requested: ${succeeded}/${total} succeeded, ${failed} failed.`)
      }
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
      if (failed === 0) {
        setNotice(`Indexing requested for ${succeeded} unindexed URL${succeeded !== 1 ? 's' : ''}.`)
      } else {
        setNotice(`Indexing requested: ${succeeded}/${total} succeeded, ${failed} failed.`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to request indexing')
    } finally {
      setRequestingIndexing(false)
    }
  }

  async function handleSaveSitemap() {
    if (!sitemapUrlInput.trim()) return
    setSavingSitemap(true)
    setError(null)
    try {
      await saveSitemapUrl(projectName, 'gsc', sitemapUrlInput.trim())
      setConnections((prev) => prev.map((c) => (
        c.connectionType === 'gsc' ? { ...c, sitemapUrl: sitemapUrlInput.trim() } : c
      )))
      setNotice('Sitemap URL saved.')
      setSitemapUrlInput('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save sitemap URL')
    } finally {
      setSavingSitemap(false)
    }
  }

  async function handleDiscoverSitemaps() {
    setDiscoveringSitemaps(true)
    setError(null)
    try {
      const result = await triggerDiscoverSitemaps(projectName)
      setDiscoveredSitemaps(result.sitemaps)
      setConnections((prev) => prev.map((c) => (
        c.connectionType === 'gsc' ? { ...c, sitemapUrl: result.primarySitemapUrl } : c
      )))
      setNotice(`Discovered ${result.sitemaps.length} sitemap(s). Primary sitemap saved and inspection queued (run ${result.run.id}).`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to discover sitemaps')
    } finally {
      setDiscoveringSitemaps(false)
    }
  }

  async function handleListSitemaps() {
    setListingSitemaps(true)
    setError(null)
    try {
      const result = await fetchGscSitemaps(projectName)
      setDiscoveredSitemaps(result.sitemaps)
      if (result.sitemaps.length === 0) {
        setNotice('No sitemaps found in this GSC property. Submit a sitemap in Google Search Console first.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to list sitemaps')
    } finally {
      setListingSitemaps(false)
    }
  }

  async function loadSection() {
    setLoading(true)
    setError(null)
    try {
      const [settings, conns] = await Promise.all([
        fetchSettings().catch(() => null),
        fetchGoogleConnections(projectName).catch(() => [] as ApiGoogleConnection[]),
      ])
      setGoogleConfigured(Boolean(settings?.google?.configured))
      setConnections(conns)

      const currentConn = conns.find((c) => c.connectionType === 'gsc')
      await Promise.all([
        loadProperties(currentConn),
        loadPerformanceRows(),
        loadInspectionHistory(),
        loadCoverage(),
      ])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadSection()
  }, [projectName])

  async function handleConnect() {
    if (!googleConfigured) {
      setError('Google OAuth app credentials are not configured yet. Set them on the Settings page first.')
      return
    }

    setConnecting(true)
    setError(null)
    setNotice(null)
    try {
      const { authUrl } = await googleConnect(projectName, 'gsc')
      if (!authUrl.startsWith('https://accounts.google.com/')) {
        setError('Unexpected OAuth redirect URL. Please try again.')
        return
      }
      const popup = window.open(authUrl, '_blank', 'width=600,height=700')
      if (!popup) {
        window.location.assign(authUrl)
        return
      }
      setNotice('Finish the Google consent flow in the popup, then close it to refresh this project.')
      const timer = window.setInterval(() => {
        if (popup.closed) {
          window.clearInterval(timer)
          setNotice(null)
          void loadSection()
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
      setConnections((prev) => prev.map((connection) => (
        connection.connectionType === 'gsc'
          ? { ...connection, propertyId: selectedProperty }
          : connection
      )))
      setNotice('GSC property updated.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save GSC property')
    } finally {
      setSavingProperty(false)
    }
  }

  async function handleSync() {
    setSyncing(true)
    setError(null)
    setNotice(null)
    try {
      await triggerGscSync(projectName, {
        days: parseInt(syncDays, 10) || undefined,
        full: fullSync || undefined,
      })
      setNotice('GSC sync queued. Refresh after the run completes to see imported data.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger sync')
    } finally {
      setSyncing(false)
    }
  }

  async function handleInspect() {
    if (!inspectionUrl.trim()) return
    setInspecting(true)
    setError(null)
    setNotice(null)
    try {
      const result = await inspectGscUrl(projectName, inspectionUrl.trim())
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
        <div className="flex items-center gap-2">
          {gscConn && (
            <Button type="button" variant="outline" size="sm" disabled={loadingPerformance} onClick={() => void loadPerformanceRows()}>
              {loadingPerformance ? 'Refreshing\u2026' : 'Refresh data'}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-rose-800/40 bg-rose-950/20 px-3 py-2 text-sm text-rose-300">
          {error}
          <button type="button" className="ml-2 text-rose-400 hover:text-rose-200" onClick={() => setError(null)}>×</button>
        </div>
      )}
      {notice && (
        <div className="mb-3 rounded-lg border border-emerald-800/40 bg-emerald-950/20 px-3 py-2 text-sm text-emerald-300">
          {notice}
          <button type="button" className="ml-2 text-emerald-400 hover:text-emerald-200" onClick={() => setNotice(null)}>×</button>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-zinc-500">{'Loading\u2026'}</p>
      ) : (
        <div className="space-y-3">
          <Card className="surface-card">
            <div className="section-head section-head-inline">
              <div>
                <p className="eyebrow eyebrow-soft">Connection</p>
                <h3>Domain authorization</h3>
              </div>
              <ToneBadge tone={gscConn ? 'positive' : googleConfigured ? 'caution' : 'negative'}>
                {gscConn ? 'Connected' : googleConfigured ? 'Ready to connect' : 'App credentials missing'}
              </ToneBadge>
            </div>
            {gscConn ? (
              <div className="mt-3 space-y-3">
                <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    <span className="text-sm text-zinc-200">Authorized for this project domain</span>
                    <span className="text-xs text-zinc-500">{gscConn.domain}</span>
                    <button
                      type="button"
                      className="ml-auto text-xs text-zinc-500 hover:text-rose-400 transition-colors"
                      onClick={handleDisconnect}
                    >
                      Disconnect
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-zinc-500">
                    Canonry stores OAuth tokens per canonical domain. This project currently maps to <code>{gscConn.domain}</code>.
                  </p>
                </div>
                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3">
                    <p className="text-xs uppercase tracking-wide text-zinc-500">Selected property</p>
                    <p className="mt-1 text-sm text-zinc-200">{gscConn.propertyId ?? 'No property selected yet'}</p>
                  </div>
                  <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3">
                    <p className="text-xs uppercase tracking-wide text-zinc-500">Last auth update</p>
                    <p className="mt-1 text-sm text-zinc-200">{formatTimestamp(gscConn.updatedAt)}</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-3 rounded-lg border border-zinc-800/60 bg-zinc-900/30 px-4 py-5">
                <p className="text-sm text-zinc-300">
                  {googleConfigured
                    ? 'Generate a Google OAuth link for this project and have the client sign in with a Google account that already has access to the correct Search Console property.'
                    : 'Set Google OAuth client credentials first. Once configured, you can generate a consent link for this project domain.'}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {googleConfigured ? (
                    <Button type="button" variant="outline" size="sm" disabled={connecting} onClick={handleConnect}>
                      {connecting ? 'Opening\u2026' : 'Connect Google Search Console'}
                    </Button>
                  ) : (
                    <Button type="button" variant="outline" size="sm" asChild>
                      <Link to="/settings">Open Settings</Link>
                    </Button>
                  )}
                  {!googleConfigured && (
                    <p className="text-xs text-zinc-500">The same Google OAuth app credentials are shared across all projects.</p>
                  )}
                </div>
              </div>
            )}
          </Card>

          {/* One-time sitemap prompt — shown when connected but no sitemap URL stored */}
          {gscConn && !gscConn.sitemapUrl && (
            <div className="rounded-lg border border-amber-800/40 bg-amber-950/20 px-4 py-3">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 text-amber-400">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
                    <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                  </svg>
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-amber-300">Set your sitemap URL</p>
                  <p className="mt-1 text-xs text-amber-400/70">Canonry uses your sitemap to discover URLs for index coverage inspection. Auto-discover from GSC or enter it manually.</p>
                  <div className="mt-2 flex flex-col gap-2">
                    <div className="flex flex-col gap-2 lg:flex-row">
                      <Button
                        type="button"
                        size="sm"
                        disabled={discoveringSitemaps || !gscConn.propertyId}
                        onClick={handleDiscoverSitemaps}
                      >
                        {discoveringSitemaps ? 'Discovering\u2026' : 'Auto-discover from GSC'}
                      </Button>
                      <span className="self-center text-xs text-amber-400/60">or enter manually:</span>
                    </div>
                    <div className="flex flex-col gap-2 lg:flex-row">
                      <input
                        className="flex-1 rounded border border-amber-800/40 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 focus:border-amber-600 focus:outline-none"
                        type="url"
                        placeholder="https://example.com/sitemap.xml"
                        value={sitemapUrlInput}
                        onChange={(e) => setSitemapUrlInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && void handleSaveSitemap()}
                      />
                      <Button type="button" size="sm" variant="outline" disabled={savingSitemap || !sitemapUrlInput.trim()} onClick={handleSaveSitemap}>
                        {savingSitemap ? 'Saving\u2026' : 'Save sitemap URL'}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── DATA SECTIONS (shown first for connected projects) ── */}

          {(gscConn || hasHistoricalData) && (
            <>
              {/* Coverage overview + donut + history chart — shown first for relevance */}
              <Card className="surface-card">
                <div className="section-head section-head-inline">
                  <div>
                    <p className="eyebrow eyebrow-soft">Coverage</p>
                    <h3>Index coverage</h3>
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
                    <Button type="button" variant="outline" size="sm" disabled={loadingCoverage} onClick={() => void loadCoverage()}>
                      {loadingCoverage ? 'Loading\u2026' : 'Refresh coverage'}
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
                                <circle cx="64" cy="64" r={r} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="14" />
                                {/* Indexed arc — emerald */}
                                <circle
                                  cx="64" cy="64" r={r} fill="none"
                                  stroke="#10b981" strokeWidth="14"
                                  strokeDasharray={circ} strokeDashoffset={indexedOffset}
                                  strokeLinecap="round"
                                  transform="rotate(-90 64 64)"
                                  style={{ transition: 'stroke-dashoffset 0.6s ease' }}
                                />
                                {/* Not-indexed arc — zinc */}
                                {coverage.summary.notIndexed > 0 && (
                                  <circle
                                    cx="64" cy="64" r={r} fill="none"
                                    stroke="#52525b" strokeWidth="14"
                                    strokeDasharray={`${notIndexedArc} ${circ - notIndexedArc}`}
                                    strokeDashoffset={-notIndexedStart}
                                    transform="rotate(-90 64 64)"
                                    style={{ transition: 'stroke-dasharray 0.6s ease, stroke-dashoffset 0.6s ease' }}
                                  />
                                )}
                              </svg>
                              <div className="absolute inset-0 flex flex-col items-center justify-center">
                                <span className="text-3xl font-bold tabular-nums text-zinc-50">{(pct * 100).toFixed(0)}%</span>
                                <span className="text-xs uppercase tracking-widest text-zinc-500 mt-0.5">Indexed</span>
                              </div>
                            </div>

                            {/* Counts row beneath donut */}
                            <div className="mt-4 flex items-center justify-center gap-8">
                              <div className="flex items-center gap-2">
                                <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500" />
                                <div>
                                  <p className="text-2xl font-semibold tabular-nums text-zinc-50">{coverage.summary.indexed.toLocaleString()}</p>
                                  <p className="text-[11px] uppercase tracking-wide text-zinc-500">Indexed</p>
                                </div>
                              </div>
                              <div className="h-8 w-px bg-zinc-800" />
                              <div className="flex items-center gap-2">
                                <span className="inline-block h-2.5 w-2.5 rounded-full bg-zinc-500" />
                                <div>
                                  <p className="text-2xl font-semibold tabular-nums text-zinc-50">{coverage.summary.notIndexed.toLocaleString()}</p>
                                  <p className="text-[11px] uppercase tracking-wide text-zinc-500">
                                    Not indexed
                                    {(coverage.reasonGroups ?? []).length > 0 && (
                                      <span className="ml-1 text-zinc-600">
                                        · {(coverage.reasonGroups ?? []).length} {(coverage.reasonGroups ?? []).length === 1 ? 'reason' : 'reasons'}
                                      </span>
                                    )}
                                  </p>
                                </div>
                              </div>
                              {coverage.summary.deindexed > 0 && (
                                <>
                                  <div className="h-8 w-px bg-zinc-800" />
                                  <div className="flex items-center gap-2">
                                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-rose-500" />
                                    <div>
                                      <p className="text-2xl font-semibold tabular-nums text-zinc-50">{coverage.summary.deindexed.toLocaleString()}</p>
                                      <p className="text-[11px] uppercase tracking-wide text-zinc-500">Deindexed</p>
                                    </div>
                                  </div>
                                </>
                              )}
                            </div>
                          </>
                        )
                      })()}
                    </div>


                    {/* Tab pills */}
                    <div className="mt-3 flex gap-1">
                      {(['indexed', 'notIndexed', 'deindexed'] as const).map((tab) => {
                        const count = tab === 'indexed' ? coverage.indexed.length
                          : tab === 'notIndexed' ? coverage.notIndexed.length
                          : coverage.deindexed.length
                        const label = tab === 'indexed' ? 'Indexed' : tab === 'notIndexed' ? 'Not Indexed' : 'Deindexed'
                        return (
                          <button
                            key={tab}
                            type="button"
                            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                              coverageTab === tab
                                ? 'bg-zinc-700 text-zinc-100'
                                : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
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
                            {coverage.indexed.map((row) => (
                              <tr key={row.id}>
                                <td className="max-w-sm truncate text-zinc-200">{row.url}</td>
                                <td className="text-zinc-400">{row.verdict ?? 'Unknown'}</td>
                                <td className="text-zinc-400">{row.crawlTime ? row.crawlTime.split('T')[0] : '\u2014'}</td>
                                <td className="text-zinc-400">{row.isMobileFriendly === true ? 'Yes' : row.isMobileFriendly === false ? 'No' : '\u2014'}</td>
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
                                className="cursor-pointer hover:bg-zinc-800/40"
                                onClick={() => setSelectedReason(group.reason)}
                              >
                                <td className="text-zinc-200">{group.reason}</td>
                                <td className="text-right tabular-nums text-zinc-400">{group.count}</td>
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
                            {coverage.notIndexed.map((row) => (
                              <tr key={row.id}>
                                <td className="max-w-sm truncate text-zinc-200">{row.url}</td>
                                <td className="text-zinc-400">{row.indexingState ?? 'Unknown'}</td>
                                <td className="text-zinc-400">{row.coverageState ?? 'Unknown'}</td>
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
                                className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                                onClick={() => setSelectedReason(null)}
                              >
                                \u2190 Back to reasons
                              </button>
                            </div>
                            <div className="mb-3 flex items-center justify-between rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3">
                              <div>
                                <p className="text-sm font-medium text-zinc-200">{group.reason}</p>
                                <p className="mt-1 text-xs text-zinc-500">{group.count} affected page{group.count !== 1 ? 's' : ''}</p>
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
                                {group.urls.map((row) => (
                                  <tr key={row.id}>
                                    <td className="max-w-sm truncate text-zinc-200">{row.url}</td>
                                    <td className="text-zinc-400">{row.crawlTime ? row.crawlTime.split('T')[0] : '\u2014'}</td>
                                    <td>
                                      <button
                                        type="button"
                                        className="text-xs text-zinc-500 hover:text-zinc-200 transition-colors"
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
                            {coverage.deindexed.map((row, i) => (
                              <tr key={`${row.url}-${i}`}>
                                <td className="max-w-sm truncate text-zinc-200">{row.url}</td>
                                <td className="text-zinc-400">{row.previousState}</td>
                                <td className="text-zinc-400">{row.currentState}</td>
                                <td className="text-zinc-400">{row.transitionDate.split('T')[0]}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {((coverageTab === 'indexed' && coverage.indexed.length === 0) ||
                        (coverageTab === 'notIndexed' && !selectedReason && coverage.notIndexed.length === 0) ||
                        (coverageTab === 'deindexed' && coverage.deindexed.length === 0)) && (
                        <p className="text-sm text-zinc-500">No URLs in this category.</p>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="mt-3 text-sm text-zinc-500">
                    {loadingCoverage ? 'Loading coverage data\u2026' : 'No coverage data yet. Inspect your sitemap to populate this view.'}
                  </p>
                )}
              </Card>

              {/* Performance summary + charts */}
              <Card className="surface-card">
                <div className="section-head section-head-inline">
                  <div>
                    <p className="eyebrow eyebrow-soft">Performance</p>
                    <h3>Search performance</h3>
                  </div>
                  <Button type="button" variant="outline" size="sm" disabled={loadingPerformance} onClick={() => void loadPerformanceRows()}>
                    {loadingPerformance ? 'Loading\u2026' : 'Apply filters'}
                  </Button>
                </div>

                {/* Clicks + Impressions bar chart */}
                {performance.length > 0 && (() => {
                  const byDate = new Map<string, { clicks: number; impressions: number }>()
                  for (const row of performance) {
                    const existing = byDate.get(row.date)
                    if (existing) {
                      existing.clicks += row.clicks
                      existing.impressions += row.impressions
                    } else {
                      byDate.set(row.date, { clicks: row.clicks, impressions: row.impressions })
                    }
                  }
                  const sorted = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))
                  if (sorted.length === 0) return null
                  const maxImpressions = Math.max(...sorted.map(([, d]) => d.impressions), 1)
                  const totalClicks = sorted.reduce((sum, [, d]) => sum + d.clicks, 0)
                  const totalImpressions = sorted.reduce((sum, [, d]) => sum + d.impressions, 0)
                  const avgCtr = totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(1) : '0.0'

                  const w = 700
                  const h = 220
                  const pad = { top: 12, bottom: 36, left: 48, right: 12 }
                  const plotW = w - pad.left - pad.right
                  const plotH = h - pad.top - pad.bottom
                  const barGroupW = plotW / sorted.length
                  const barW = Math.max(Math.min(barGroupW * 0.35, 24), 4)
                  const barGap = Math.max(barW * 0.15, 1)

                  // Y-axis ticks
                  const niceMax = (v: number) => {
                    if (v <= 0) return 1
                    const mag = Math.pow(10, Math.floor(Math.log10(v)))
                    const norm = v / mag
                    const nice = norm <= 1.5 ? 1.5 : norm <= 3 ? 3 : norm <= 5 ? 5 : 10
                    return Math.ceil(nice * mag)
                  }
                  const tickCount = 4
                  const ceilVal = Math.ceil(niceMax(maxImpressions) / tickCount) * tickCount
                  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => (ceilVal / tickCount) * i)
                  const fmtNum = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)

                  return (
                    <div className="mt-3">
                      <div className="flex items-center gap-5 mb-2">
                        <div className="flex items-center gap-1.5">
                          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500" />
                          <span className="text-xs text-zinc-400">Clicks <span className="text-zinc-200 tabular-nums font-medium">{totalClicks.toLocaleString()}</span></span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-blue-500" />
                          <span className="text-xs text-zinc-400">Impressions <span className="text-zinc-200 tabular-nums font-medium">{totalImpressions.toLocaleString()}</span></span>
                        </div>
                        <span className="text-xs text-zinc-500">CTR <span className="text-amber-400 tabular-nums font-medium">{avgCtr}%</span></span>
                      </div>
                      <div className="relative w-full" style={{ aspectRatio: `${w} / ${h}` }}>
                        <svg viewBox={`0 0 ${w} ${h}`} className="h-full w-full">
                          {/* Grid lines + Y-axis */}
                          {ticks.map((tick, i) => {
                            const y = pad.top + plotH - (tick / ceilVal) * plotH
                            return (
                              <g key={`t-${i}`}>
                                <line x1={pad.left} y1={y} x2={w - pad.right} y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
                                <text x={pad.left - 6} y={y + 3.5} textAnchor="end" fill="#a1a1aa" fontSize="10" fontFamily="inherit">{fmtNum(tick)}</text>
                              </g>
                            )
                          })}
                          {/* Bars */}
                          {sorted.map(([date, d], i) => {
                            const cx = pad.left + barGroupW * i + barGroupW / 2
                            const impressionH = (d.impressions / ceilVal) * plotH
                            const clickH = (d.clicks / ceilVal) * plotH
                            return (
                              <g key={date}>
                                <title>{`${date}\nClicks: ${d.clicks}\nImpressions: ${d.impressions}\nCTR: ${d.impressions > 0 ? ((d.clicks / d.impressions) * 100).toFixed(1) : 0}%`}</title>
                                <rect
                                  x={cx - barW - barGap / 2}
                                  y={pad.top + plotH - impressionH}
                                  width={barW}
                                  height={Math.max(impressionH, 1)}
                                  rx={2}
                                  fill="#3b82f6"
                                  opacity={0.85}
                                />
                                <rect
                                  x={cx + barGap / 2}
                                  y={pad.top + plotH - clickH}
                                  width={barW}
                                  height={Math.max(clickH, 1)}
                                  rx={2}
                                  fill="#10b981"
                                  opacity={0.85}
                                />
                              </g>
                            )
                          })}
                          {/* X-axis date labels — pick up to 7 evenly spaced */}
                          {(() => {
                            const labelCount = Math.min(sorted.length, 7)
                            return Array.from({ length: labelCount }, (_, i) => {
                              const idx = sorted.length === 1 ? 0 : Math.round((i / (labelCount - 1)) * (sorted.length - 1))
                              const cx = pad.left + barGroupW * idx + barGroupW / 2
                              return (
                                <text key={`xl-${idx}`} x={cx} y={h - 8} textAnchor="middle" fill="#71717a" fontSize="10" fontFamily="inherit">
                                  {sorted[idx]![0].slice(5)}
                                </text>
                              )
                            })
                          })()}
                        </svg>
                      </div>
                    </div>
                  )
                })()}

                <div className="mt-3 grid gap-2 lg:grid-cols-5">
                  <input
                    className="rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                    type="date"
                    value={performanceFilters.startDate}
                    onChange={(e) => setPerformanceFilters((prev) => ({ ...prev, startDate: e.target.value }))}
                  />
                  <input
                    className="rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                    type="date"
                    value={performanceFilters.endDate}
                    onChange={(e) => setPerformanceFilters((prev) => ({ ...prev, endDate: e.target.value }))}
                  />
                  <input
                    className="rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                    type="text"
                    placeholder="Filter query"
                    value={performanceFilters.query}
                    onChange={(e) => setPerformanceFilters((prev) => ({ ...prev, query: e.target.value }))}
                  />
                  <input
                    className="rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                    type="text"
                    placeholder="Filter page"
                    value={performanceFilters.page}
                    onChange={(e) => setPerformanceFilters((prev) => ({ ...prev, page: e.target.value }))}
                  />
                  <input
                    className="rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                    type="number"
                    min="1"
                    placeholder="Limit"
                    value={performanceFilters.limit}
                    onChange={(e) => setPerformanceFilters((prev) => ({ ...prev, limit: e.target.value }))}
                  />
                </div>
                {performance.length > 0 ? (
                  <div className="mt-3 overflow-x-auto">
                    <table className="data-table w-full text-sm">
                      <thead>
                        <tr>
                          <th className="text-left">Date</th>
                          <th className="text-left">Query</th>
                          <th className="text-left">Page</th>
                          <th className="text-right">Clicks</th>
                          <th className="text-right">Impressions</th>
                          <th className="text-right">CTR</th>
                          <th className="text-right">Position</th>
                        </tr>
                      </thead>
                      <tbody>
                        {performance.map((row, i) => (
                          <tr key={`${row.date}:${row.query}:${row.page}:${i}`}>
                            <td className="text-zinc-400">{row.date}</td>
                            <td className="max-w-xs truncate text-zinc-200">{row.query}</td>
                            <td className="max-w-xs truncate text-zinc-400">{row.page}</td>
                            <td className="text-right tabular-nums text-zinc-300">{row.clicks.toLocaleString()}</td>
                            <td className="text-right tabular-nums text-zinc-400">{row.impressions.toLocaleString()}</td>
                            <td className="text-right tabular-nums text-zinc-400">{(row.ctr * 100).toFixed(1)}%</td>
                            <td className="text-right tabular-nums text-zinc-400">{row.position.toFixed(1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-zinc-500">No performance rows match the current filters yet.</p>
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
                    className="flex-1 rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                    type="url"
                    placeholder="https://example.com/page"
                    value={inspectionUrl}
                    onChange={(e) => setInspectionUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void handleInspect()}
                  />
                  <Button type="button" size="sm" disabled={inspecting || !gscConn?.propertyId || !inspectionUrl.trim()} onClick={handleInspect}>
                    {inspecting ? 'Inspecting\u2026' : 'Inspect URL'}
                  </Button>
                </div>
                {inspectionResult && (
                  <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3">
                      <p className="text-xs uppercase tracking-wide text-zinc-500">Indexing state</p>
                      <p className="mt-1 text-sm text-zinc-200">{inspectionResult.indexingState ?? 'Unknown'}</p>
                    </div>
                    <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3">
                      <p className="text-xs uppercase tracking-wide text-zinc-500">Verdict</p>
                      <p className="mt-1 text-sm text-zinc-200">{inspectionResult.verdict ?? 'Unknown'}</p>
                    </div>
                    <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3">
                      <p className="text-xs uppercase tracking-wide text-zinc-500">Mobile friendly</p>
                      <p className="mt-1 text-sm text-zinc-200">{formatBooleanState(inspectionResult.isMobileFriendly)}</p>
                    </div>
                    <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3">
                      <p className="text-xs uppercase tracking-wide text-zinc-500">Last crawl</p>
                      <p className="mt-1 text-sm text-zinc-200">{formatTimestamp(inspectionResult.crawlTime)}</p>
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
                  <Button type="button" variant="outline" size="sm" disabled={loadingInspections} onClick={() => void loadInspectionHistory()}>
                    {loadingInspections ? 'Loading\u2026' : 'Refresh history'}
                  </Button>
                </div>
                <div className="mt-3 flex flex-col gap-2 lg:flex-row">
                  <input
                    className="flex-1 rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                    type="text"
                    placeholder="Filter exact URL"
                    value={inspectionFilterUrl}
                    onChange={(e) => setInspectionFilterUrl(e.target.value)}
                  />
                  <Button type="button" size="sm" variant="outline" disabled={loadingInspections} onClick={() => void loadInspectionHistory()}>
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
                            <td className="max-w-sm truncate text-zinc-200">{row.url}</td>
                            <td className="text-zinc-300">{row.indexingState ?? 'Unknown'}</td>
                            <td className="text-zinc-400">{row.verdict ?? 'Unknown'}</td>
                            <td className="text-zinc-400">{row.coverageState ?? 'Unknown'}</td>
                            <td className="text-zinc-400">{formatBooleanState(row.isMobileFriendly)}</td>
                            <td className="text-zinc-400">{formatTimestamp(row.inspectedAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-zinc-500">No inspection history yet.</p>
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
                            <td className="max-w-sm truncate text-zinc-200">{row.url}</td>
                            <td className="text-zinc-400">{row.previousState ?? 'Unknown'}</td>
                            <td className="text-zinc-300">{row.currentState ?? 'Unknown'}</td>
                            <td className="text-zinc-400">{formatTimestamp(row.transitionDate)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-zinc-500">No deindexed transitions recorded.</p>
                )}
              </Card>
            </>
          )}

          {/* ── SETUP SECTION (at bottom, collapsible for connected projects) ── */}
          {gscConn && (
            <>
              <div className="border-t border-zinc-800/60 pt-3">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 text-left"
                  onClick={() => setSetupExpanded((prev) => !prev)}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"
                    className={`h-4 w-4 text-zinc-500 transition-transform ${setupExpanded ? 'rotate-90' : ''}`}
                    aria-hidden="true"
                  >
                    <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
                  </svg>
                  <span className="text-xs uppercase tracking-wide text-zinc-500">Setup &amp; Configuration</span>
                </button>
              </div>

              {setupExpanded && (
                <div className="space-y-3">
                  <div className="grid gap-3 xl:grid-cols-2">
                    <Card className="surface-card">
                      <div className="section-head">
                        <div>
                          <p className="eyebrow eyebrow-soft">Property</p>
                          <h3>Pick the Search Console property</h3>
                        </div>
                      </div>
                      <div className="mt-3 space-y-2">
                        <label className="text-xs text-zinc-500" htmlFor={`gsc-property-${projectName}`}>Property URL</label>
                        <select
                          id={`gsc-property-${projectName}`}
                          className="w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 focus:border-zinc-500 focus:outline-none"
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
                          <Button type="button" size="sm" variant="outline" disabled={propertiesLoading} onClick={() => void loadProperties(gscConn)}>
                            {propertiesLoading ? 'Refreshing\u2026' : 'Refresh properties'}
                          </Button>
                          <Button type="button" size="sm" disabled={!selectedProperty || savingProperty} onClick={handleSaveProperty}>
                            {savingProperty ? 'Saving\u2026' : 'Save property'}
                          </Button>
                        </div>
                        <p className="text-xs text-zinc-500">The selected property is used for future syncs and URL inspections for this project.</p>
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
                            <label className="text-xs text-zinc-500" htmlFor={`gsc-sync-days-${projectName}`}>Days</label>
                            <input
                              id={`gsc-sync-days-${projectName}`}
                              type="number"
                              min="1"
                              className="mt-0.5 w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                              value={syncDays}
                              onChange={(e) => setSyncDays(e.target.value)}
                            />
                          </div>
                          <label className="flex items-center gap-2 rounded border border-zinc-800/60 bg-zinc-900/20 px-3 py-2 text-sm text-zinc-300">
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
                          disabled={syncing || !gscConn.propertyId}
                          onClick={handleSync}
                        >
                          {syncing ? 'Queueing\u2026' : 'Queue sync'}
                        </Button>
                        {!gscConn.propertyId && (
                          <p className="text-xs text-amber-400">Select a Search Console property before queueing a sync.</p>
                        )}
                      </div>
                    </Card>
                  </div>

                  {/* Sitemap configuration */}
                  <Card className="surface-card">
                    <div className="section-head">
                      <div>
                        <p className="eyebrow eyebrow-soft">Sitemap</p>
                        <h3>Sitemap configuration</h3>
                      </div>
                    </div>
                    <div className="mt-3 space-y-3">
                      {gscConn.sitemapUrl && (
                        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3">
                          <p className="text-xs uppercase tracking-wide text-zinc-500">Current sitemap URL</p>
                          <p className="mt-1 text-sm text-zinc-200 break-all">{gscConn.sitemapUrl}</p>
                        </div>
                      )}
                      {/* Sitemap actions: list (no run) or auto-discover (saves + queues run) */}
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={listingSitemaps || !gscConn.propertyId}
                          onClick={() => void handleListSitemaps()}
                        >
                          {listingSitemaps ? 'Loading\u2026' : 'Browse sitemaps from GSC'}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={discoveringSitemaps || !gscConn.propertyId}
                          onClick={handleDiscoverSitemaps}
                        >
                          {discoveringSitemaps ? 'Discovering\u2026' : 'Auto-discover and queue inspection'}
                        </Button>
                      </div>
                      <p className="text-xs text-zinc-500">Browse lists available sitemaps without queueing a run. Auto-discover saves the primary sitemap and queues an inspection.</p>
                      {discoveredSitemaps && discoveredSitemaps.length > 0 && (
                        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 p-3 space-y-2">
                          <p className="text-xs uppercase tracking-wide text-zinc-500">Sitemaps ({discoveredSitemaps.length})</p>
                          {discoveredSitemaps.map((s) => {
                            const content = s.contents?.[0]
                            return (
                              <div key={s.path} className="flex items-start justify-between gap-2 text-xs">
                                <div>
                                  <p className="text-zinc-200 break-all">{s.path}</p>
                                  {s.lastSubmitted && (
                                    <p className="text-zinc-500">Submitted: {s.lastSubmitted.split('T')[0]}</p>
                                  )}
                                </div>
                                <div className="flex items-center gap-3 shrink-0">
                                  {content && (
                                    <div className="text-right">
                                      <p className="text-zinc-300">{content.indexed} / {content.submitted}</p>
                                      <p className="text-zinc-500">indexed</p>
                                    </div>
                                  )}
                                  <button
                                    type="button"
                                    className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                                    onClick={() => setSitemapUrlInput(s.path)}
                                  >
                                    Use
                                  </button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                      <div className="flex flex-col gap-2 lg:flex-row">
                        <input
                          className="flex-1 rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                          type="url"
                          placeholder={gscConn.sitemapUrl ? 'Update sitemap URL\u2026' : 'https://example.com/sitemap.xml'}
                          value={sitemapUrlInput}
                          onChange={(e) => setSitemapUrlInput(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && sitemapUrlInput.trim() && void handleSaveSitemap()}
                        />
                        <Button type="button" size="sm" disabled={savingSitemap || !sitemapUrlInput.trim()} onClick={handleSaveSitemap}>
                          {savingSitemap ? 'Saving\u2026' : gscConn.sitemapUrl ? 'Update' : 'Save'}
                        </Button>
                      </div>
                      <div className="flex flex-col gap-2 lg:flex-row">
                        <input
                          className="flex-1 rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
                          type="url"
                          placeholder="Sitemap URL for inspection (leave empty for saved default)"
                          id={`gsc-sitemap-inspect-${projectName}`}
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={inspectingSitemap || !gscConn.propertyId}
                          onClick={() => {
                            const el = document.getElementById(`gsc-sitemap-inspect-${projectName}`) as HTMLInputElement | null
                            const url = el?.value?.trim() || gscConn.sitemapUrl || undefined
                            setInspectingSitemap(true)
                            void triggerInspectSitemap(projectName, { sitemapUrl: url }).then((run) => {
                              setNotice(`Sitemap inspection queued (run ${run.id}). Refresh coverage after the run completes.`)
                            }).catch((err) => {
                              setError(err instanceof Error ? err.message : 'Failed to queue sitemap inspection')
                            }).finally(() => setInspectingSitemap(false))
                          }}
                        >
                          {inspectingSitemap ? 'Queueing\u2026' : 'Inspect sitemap'}
                        </Button>
                      </div>
                      {!gscConn.propertyId && (
                        <p className="text-xs text-amber-400">Select a Search Console property first.</p>
                      )}
                    </div>
                  </Card>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
