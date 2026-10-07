import { useCallback, useEffect, useState } from 'react'
import { Download, ExternalLink, Play, Trash2, AlertTriangle } from 'lucide-react'
import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { Hint } from '../components/shared/Hint.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { asyncHandler } from '../lib/async-handler.js'
import {
  fetchBacklinksStatus,
  fetchCachedReleases,
  fetchLatestAvailableRelease,
  fetchLatestReleaseSync,
  fetchReleaseSyncs,
  installBacklinks,
  isEmbed,
  pruneCachedRelease,
  triggerReleaseSync,
  ApiError,
} from '../api.js'
import type {
  BacklinksInstallStatusDto,
  CcAvailableRelease,
  CcCachedRelease,
  CcReleaseSyncDto,
} from '../api.js'

const COMMON_CRAWL_RELEASES_URL = 'https://commoncrawl.org/web-graphs'

function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`
  return `${n} B`
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function syncStatusTone(status: CcReleaseSyncDto['status']): 'positive' | 'caution' | 'negative' | 'neutral' {
  switch (status) {
    case 'ready': return 'positive'
    case 'failed': return 'negative'
    case 'downloading':
    case 'querying':
    case 'queued':
      return 'caution'
  }
}

export function BacklinksPage() {
  const [status, setStatus] = useState<BacklinksInstallStatusDto | null>(null)
  const [latest, setLatest] = useState<CcReleaseSyncDto | null>(null)
  const [history, setHistory] = useState<CcReleaseSyncDto[]>([])
  const [cached, setCached] = useState<CcCachedRelease[]>([])
  const [latestAvailable, setLatestAvailable] = useState<CcAvailableRelease | null>(null)
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [releaseInput, setReleaseInput] = useState('')
  const [showOverride, setShowOverride] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [st, lat, hist, cac, avail] = await Promise.all([
        fetchBacklinksStatus(),
        fetchLatestReleaseSync().catch(() => null),
        fetchReleaseSyncs().catch(() => [] as CcReleaseSyncDto[]),
        fetchCachedReleases().catch(() => [] as CcCachedRelease[]),
        fetchLatestAvailableRelease().catch(() => null),
      ])
      setStatus(st)
      setLatest(lat)
      setHistory(hist)
      setCached(cac)
      setLatestAvailable(avail)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load backlinks status')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  async function handleInstall() {
    setInstalling(true)
    setError(null)
    setNotice(null)
    try {
      const result = await installBacklinks()
      setNotice(result.alreadyPresent
        ? `DuckDB already installed (${result.version}).`
        : `Installed DuckDB ${result.version}.`)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to install DuckDB')
    } finally {
      setInstalling(false)
    }
  }

  async function handleSync() {
    const release = releaseInput.trim() || undefined
    setSyncing(true)
    setError(null)
    setNotice(null)
    try {
      const sync = await triggerReleaseSync(release)
      setNotice(
        release
          ? `Queued sync for ${sync.release}. Download + query runs in the background.`
          : `Queued sync for auto-discovered release ${sync.release}. Download + query runs in the background.`,
      )
      setReleaseInput('')
      setShowOverride(false)
      await reload()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MISSING_DEPENDENCY') {
        setError('DuckDB is not installed. Install it first.')
      } else {
        setError(err instanceof Error ? err.message : 'Failed to trigger sync')
      }
    } finally {
      setSyncing(false)
    }
  }

  async function handlePrune(release: string) {
    setError(null)
    setNotice(null)
    try {
      await pruneCachedRelease(release)
      setNotice(`Pruned cached release ${release}.`)
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to prune release')
    }
  }

  const latestReadyButCacheMissing =
    latest?.status === 'ready' &&
    cached.every((c) => c.release !== latest.release)

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Backlink data</h1>
          <p className="page-subtitle">Manage the shared backlink source and review its latest data.</p>
        </div>
      </div>

      {error && (
        <Card className="surface-card p-4 mb-4 border-negative-800/60">
          <p className="text-sm text-negative">{error}</p>
        </Card>
      )}
      {notice && (
        <Card className="surface-card p-4 mb-4 border-positive-800/60">
          <p className="text-sm text-positive">{notice}</p>
        </Card>
      )}

      <section className="page-section-divider">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Readiness</p>
            <h2>Backlink source</h2>
          </div>
          {status?.duckdbInstalled ? (
            <ToneBadge tone="positive">Installed</ToneBadge>
          ) : (
            <ToneBadge tone="caution">Not installed</ToneBadge>
          )}
        </div>
        <Card className="surface-card p-4">
          {loading ? (
            <p className="text-sm text-muted">Checking…</p>
          ) : status?.duckdbInstalled ? (
            <p className="text-sm text-secondary">Ready to sync a Common Crawl release.</p>
          ) : (
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-secondary">Install the local query engine to enable release syncs.</p>
              {!isEmbed() && <Button type="button" size="sm" disabled={installing} onClick={asyncHandler(handleInstall)}><Download className="h-4 w-4 mr-1.5" aria-hidden />{installing ? 'Installing…' : 'Install DuckDB'}</Button>}
            </div>
          )}
        </Card>
      </section>

      <section className="page-section-divider">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Latest sync</p>
            <h2 className="flex items-center gap-2">
              Release sync
              <Hint label="What is a release sync?">
                A release sync downloads one Common Crawl dump (~16 GB) and extracts backlinks for every project in this workspace in one pass. This is the heavy job — subsequent per-project re-runs skip the download and just re-query the cached files.
              </Hint>
            </h2>
          </div>
          {latest && <ToneBadge tone={syncStatusTone(latest.status)}>{latest.status}</ToneBadge>}
        </div>
        <Card className="surface-card p-5">
          {latest ? (
            <div className="space-y-2 text-sm">
              <p className="text-strong">
                Release <code className="text-neutral">{latest.release}</code>
              </p>
              {latest.phaseDetail && (
                <p className="text-secondary">{latest.phaseDetail}</p>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs text-muted pt-2">
                <div>
                  <p className="text-faint uppercase tracking-wide">Projects</p>
                  <p className="text-neutral mt-0.5">{latest.projectsProcessed ?? '—'}</p>
                </div>
                <div>
                  <p className="text-faint uppercase tracking-wide flex items-center gap-1">
                    Rows
                    <Hint label="What are rows?">
                      Total number of (project, referring domain) pairs persisted in SQLite from this sync, across every project in the workspace.
                    </Hint>
                  </p>
                  <p className="text-neutral mt-0.5">{latest.domainsDiscovered ?? '—'}</p>
                </div>
                <div>
                  <p className="text-faint uppercase tracking-wide">Started</p>
                  <p className="text-neutral mt-0.5">{relativeTime(latest.downloadStartedAt ?? latest.createdAt)}</p>
                </div>
                <div>
                  <p className="text-faint uppercase tracking-wide">Finished</p>
                  <p className="text-neutral mt-0.5">{relativeTime(latest.queryFinishedAt)}</p>
                </div>
              </div>
              {latest.error && (
                <p className="text-sm text-negative-400 pt-2">{latest.error}</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted">No release sync has run in this workspace yet.</p>
          )}
          {latestReadyButCacheMissing && (
            <div className="mt-4 rounded border border-caution-800/60 bg-caution-950/20 p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-caution-400 shrink-0 mt-0.5" aria-hidden />
                <div className="text-sm text-neutral leading-relaxed">
                  <p className="font-medium text-caution-200">Cached files for this release are missing.</p>
                  <p className="mt-1 text-secondary">
                    Sync this release again, or sync the newest release, before refreshing individual projects.
                  </p>
                </div>
              </div>
            </div>
          )}
          <div className="mt-4 rounded border border-base bg-bg-elevated/40 p-3">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted">
                  Auto-detected release
                </p>
                {latestAvailable ? (
                  <p className="text-sm text-strong mt-0.5">
                    <code className="text-heading">{latestAvailable.release}</code>
                    <span className="ml-2 text-xs text-muted">
                      Vertex {formatBytes(latestAvailable.vertexBytes)}, edges {formatBytes(latestAvailable.edgesBytes)}
                    </span>
                  </p>
                ) : (
                  <p className="text-sm text-muted mt-0.5">
                    {loading ? 'Checking Common Crawl…' : 'Could not find a release. Choose one below.'}
                  </p>
                )}
                <a
                  href={COMMON_CRAWL_RELEASES_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-xs text-secondary hover:text-strong focus:text-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-mono-500 rounded"
                >
                  Browse all Common Crawl web-graph releases
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              </div>
              {!isEmbed() && (
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    type="button"
                    size="sm"
                    disabled={syncing || !status?.duckdbInstalled || (!latestAvailable && !releaseInput.trim())}
                    onClick={asyncHandler(handleSync)}
                  >
                    <Play className="h-4 w-4 mr-1.5" aria-hidden />
                    {syncing ? 'Queuing…' : 'Run sync'}
                  </Button>
                  <Hint label="What does Run sync do?">
                    <span className="block">
                      Downloads the auto-detected (or chosen) Common Crawl release (~16 GB) to{' '}
                      <code className="text-neutral">~/.canonry/cache/commoncrawl/</code>, then runs a single DuckDB query that extracts referring domains for every project in this workspace.
                    </span>
                    <span className="mt-2 block text-secondary">
                      First time for a release: <span className="text-strong">~10–20 min download + ~5 min query</span>. Re-running the same release later: <span className="text-strong">skips download, just re-queries</span> (~5 min).
                    </span>
                  </Hint>
                </div>
              )}
            </div>
            {isEmbed() ? null : !showOverride ? (
              <button
                type="button"
                className="text-sm text-secondary hover:text-neutral focus:text-neutral focus:outline-none focus-visible:ring-1 focus-visible:ring-mono-500 rounded"
                onClick={() => setShowOverride(true)}
                disabled={syncing}
              >
                Use a different release →
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  className="flex-1 min-w-[240px] rounded border border-strong bg-transparent px-2.5 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none"
                  placeholder="cc-main-2026-jan-feb-mar"
                  value={releaseInput}
                  onChange={(e) => setReleaseInput(e.target.value)}
                  disabled={syncing}
                  autoFocus
                />
                <button
                  type="button"
                  className="text-sm text-secondary hover:text-neutral focus:text-neutral focus:outline-none focus-visible:ring-1 focus-visible:ring-mono-500 rounded"
                  onClick={() => { setReleaseInput(''); setShowOverride(false) }}
                  disabled={syncing}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
          {!status?.duckdbInstalled && (
            <p className="text-sm text-secondary mt-2">Install DuckDB first to enable sync.</p>
          )}
        </Card>
      </section>

      <details className="page-section-divider group">
        <summary className="cursor-pointer text-sm font-medium text-secondary hover:text-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-mono-500 rounded">Technical details and cache</summary>
        <div className="mt-4">
          <p className="text-sm text-secondary mb-3">Cached releases support project re-extracts. Pruning a release does not remove saved backlink results.</p>
        <Card className="surface-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-base text-left text-xs uppercase tracking-wide text-faint">
                <th className="px-4 py-2 font-medium">Release</th>
                <th className="px-4 py-2 font-medium">Sync status</th>
                <th className="px-4 py-2 text-right font-medium">Size</th>
                <th className="px-4 py-2 font-medium">Last used</th>
                {!isEmbed() && <th className="px-4 py-2 font-medium sr-only">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {cached.map((row) => (
                <tr key={row.release} className="border-b border-mono-900 last:border-0">
                  <td className="px-4 py-2 text-strong"><code>{row.release}</code></td>
                  <td className="px-4 py-2">
                    {row.syncStatus ? (
                      <ToneBadge tone={syncStatusTone(row.syncStatus)}>{row.syncStatus}</ToneBadge>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-secondary tabular-nums">{formatBytes(row.bytes)}</td>
                  <td className="px-4 py-2 text-secondary">{relativeTime(row.lastUsedAt)}</td>
                  {!isEmbed() && (
                    <td className="px-4 py-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        <Button type="button" variant="outline" size="sm" onClick={() => { void handlePrune(row.release) }}>
                          <Trash2 className="h-4 w-4 mr-1.5" aria-hidden />
                          Prune
                        </Button>
                        <Hint label="What does Prune do?" placement="top">
                          Deletes the ~16 GB cache for this release from disk. Backlink results already in SQLite remain untouched. To re-run extracts against this release, you&rsquo;d have to sync it again (another ~16 GB download).
                        </Hint>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
              {cached.length === 0 && (
                <tr><td className="px-4 py-4 text-sm text-muted" colSpan={isEmbed() ? 4 : 5}>
                  No cached releases on this machine. If you ran a sync from a different machine (or deleted the cache), the backlink data is still in the database — but you&rsquo;ll need to re-sync a release to run new extracts.
                </td></tr>
              )}
            </tbody>
          </table>
        </Card>
          <p className="mt-3 text-xs text-muted">Common Crawl files are stored locally. DuckDB reads them; Canonry stores results in its normal database.</p>
        </div>
      </details>

      {history.length > 1 && (
        <section className="page-section-divider">
          <div className="section-head section-head-inline">
            <div>
              <p className="eyebrow eyebrow-soft">History</p>
              <h2>Past release syncs</h2>
            </div>
          </div>
          <Card className="surface-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-base text-left text-xs uppercase tracking-wide text-faint">
                  <th className="px-4 py-2 font-medium">Release</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 text-right font-medium">Projects</th>
                  <th className="px-4 py-2 text-right font-medium">Rows</th>
                  <th className="px-4 py-2 font-medium">Finished</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id} className="border-b border-mono-900 last:border-0">
                    <td className="px-4 py-2 text-strong"><code>{row.release}</code></td>
                    <td className="px-4 py-2"><ToneBadge tone={syncStatusTone(row.status)}>{row.status}</ToneBadge></td>
                    <td className="px-4 py-2 text-right text-secondary tabular-nums">{row.projectsProcessed ?? '—'}</td>
                    <td className="px-4 py-2 text-right text-secondary tabular-nums">{row.domainsDiscovered ?? '—'}</td>
                    <td className="px-4 py-2 text-secondary">{relativeTime(row.queryFinishedAt ?? row.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      )}
    </div>
  )
}
