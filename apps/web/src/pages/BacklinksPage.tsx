import { useCallback, useEffect, useState } from 'react'
import { Download, Play, Trash2, CheckCircle2, AlertCircle } from 'lucide-react'
import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import {
  fetchBacklinksStatus,
  fetchCachedReleases,
  fetchLatestReleaseSync,
  fetchReleaseSyncs,
  installBacklinks,
  pruneCachedRelease,
  triggerReleaseSync,
  ApiError,
} from '../api.js'
import type {
  BacklinksInstallStatusDto,
  CcCachedRelease,
  CcReleaseSyncDto,
} from '../api.js'

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
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [releaseInput, setReleaseInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [st, lat, hist, cac] = await Promise.all([
        fetchBacklinksStatus(),
        fetchLatestReleaseSync().catch(() => null),
        fetchReleaseSyncs().catch(() => [] as CcReleaseSyncDto[]),
        fetchCachedReleases().catch(() => [] as CcCachedRelease[]),
      ])
      setStatus(st)
      setLatest(lat)
      setHistory(hist)
      setCached(cac)
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
    const release = releaseInput.trim()
    if (!release) {
      setError('Enter a release id (e.g., cc-main-2026-jan-feb-mar).')
      return
    }
    setSyncing(true)
    setError(null)
    setNotice(null)
    try {
      await triggerReleaseSync(release)
      setNotice(`Queued sync for ${release}. Download + query runs in the background.`)
      setReleaseInput('')
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

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Backlinks</h1>
          <p className="page-subtitle">
            Referring domains from the Common Crawl hyperlink graph — an opt-in workspace feature that runs locally.
          </p>
        </div>
      </div>

      <section className="page-section-divider">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">About</p>
            <h2>How it works</h2>
          </div>
        </div>
        <Card className="surface-card p-5">
          <p className="text-sm text-zinc-400 leading-relaxed max-w-3xl">
            Common Crawl publishes a free monthly domain-level hyperlink graph. A workspace release sync downloads
            ~16 GB of vertex + edge files to <code className="text-zinc-300">~/.canonry/cache/commoncrawl/</code>,
            runs a DuckDB query that extracts referring domains for every project's canonical domain in one pass, and
            persists the results to SQLite. After the first sync, per-project reads are instant.
          </p>
          <p className="text-sm text-zinc-500 mt-3 max-w-3xl">
            Nothing is sent to third parties. DuckDB is installed on-demand into a canonry-owned plugin directory.
          </p>
        </Card>
      </section>

      {error && (
        <Card className="surface-card p-4 mb-4 border-rose-800/60">
          <p className="text-sm text-rose-300">{error}</p>
        </Card>
      )}
      {notice && (
        <Card className="surface-card p-4 mb-4 border-emerald-800/60">
          <p className="text-sm text-emerald-300">{notice}</p>
        </Card>
      )}

      <section className="page-section-divider">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Dependency</p>
            <h2>DuckDB install status</h2>
          </div>
          {status?.duckdbInstalled ? (
            <ToneBadge tone="positive">Installed</ToneBadge>
          ) : (
            <ToneBadge tone="caution">Not installed</ToneBadge>
          )}
        </div>
        <Card className="surface-card p-5">
          {loading ? (
            <p className="text-sm text-zinc-500">Checking…</p>
          ) : status?.duckdbInstalled ? (
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" aria-hidden />
              <div>
                <p className="text-sm text-zinc-200">
                  Version {status.duckdbVersion ?? 'unknown'} installed at{' '}
                  <code className="text-zinc-300">{status.pluginDir}</code>
                </p>
                <p className="text-xs text-zinc-500 mt-1">Required spec: {status.duckdbSpec}</p>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" aria-hidden />
              <div className="flex-1">
                <p className="text-sm text-zinc-200">
                  DuckDB is not installed. Required to run release syncs and per-project extracts.
                </p>
                {status && (
                  <p className="text-xs text-zinc-500 mt-1">
                    Will be installed into <code className="text-zinc-300">{status.pluginDir}</code>
                  </p>
                )}
                <div className="mt-3">
                  <Button type="button" size="sm" disabled={installing} onClick={handleInstall}>
                    <Download className="h-4 w-4 mr-1.5" aria-hidden />
                    {installing ? 'Installing…' : 'Install DuckDB'}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </Card>
      </section>

      <section className="page-section-divider">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Latest release sync</p>
            <h2>Workspace sync</h2>
          </div>
          {latest && <ToneBadge tone={syncStatusTone(latest.status)}>{latest.status}</ToneBadge>}
        </div>
        <Card className="surface-card p-5">
          {latest ? (
            <div className="space-y-2 text-sm">
              <p className="text-zinc-200">
                Release <code className="text-zinc-300">{latest.release}</code>
              </p>
              {latest.phaseDetail && (
                <p className="text-zinc-500">{latest.phaseDetail}</p>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs text-zinc-500 pt-2">
                <div>
                  <p className="text-zinc-600 uppercase tracking-wide">Projects</p>
                  <p className="text-zinc-300 mt-0.5">{latest.projectsProcessed ?? '—'}</p>
                </div>
                <div>
                  <p className="text-zinc-600 uppercase tracking-wide">Rows</p>
                  <p className="text-zinc-300 mt-0.5">{latest.domainsDiscovered ?? '—'}</p>
                </div>
                <div>
                  <p className="text-zinc-600 uppercase tracking-wide">Started</p>
                  <p className="text-zinc-300 mt-0.5">{relativeTime(latest.downloadStartedAt ?? latest.createdAt)}</p>
                </div>
                <div>
                  <p className="text-zinc-600 uppercase tracking-wide">Finished</p>
                  <p className="text-zinc-300 mt-0.5">{relativeTime(latest.queryFinishedAt)}</p>
                </div>
              </div>
              {latest.error && (
                <p className="text-sm text-rose-400 pt-2">{latest.error}</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-zinc-500">No release sync has run in this workspace yet.</p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input
              type="text"
              className="flex-1 min-w-[240px] rounded border border-zinc-700 bg-transparent px-2.5 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
              placeholder="cc-main-2026-jan-feb-mar"
              value={releaseInput}
              onChange={(e) => setReleaseInput(e.target.value)}
              disabled={syncing}
            />
            <Button
              type="button"
              size="sm"
              disabled={syncing || !status?.duckdbInstalled}
              onClick={handleSync}
            >
              <Play className="h-4 w-4 mr-1.5" aria-hidden />
              {syncing ? 'Queuing…' : 'Run sync'}
            </Button>
          </div>
          {!status?.duckdbInstalled && (
            <p className="text-xs text-zinc-600 mt-2">Install DuckDB first to enable sync.</p>
          )}
        </Card>
      </section>

      <section className="page-section-divider">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">Cached releases</p>
            <h2>Local disk cache</h2>
          </div>
        </div>
        <Card className="surface-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-xs uppercase tracking-wide text-zinc-600">
                <th className="px-4 py-2 font-medium">Release</th>
                <th className="px-4 py-2 font-medium">Sync status</th>
                <th className="px-4 py-2 text-right font-medium">Size</th>
                <th className="px-4 py-2 font-medium">Last used</th>
                <th className="px-4 py-2 font-medium sr-only">Actions</th>
              </tr>
            </thead>
            <tbody>
              {cached.map((row) => (
                <tr key={row.release} className="border-b border-zinc-900 last:border-0">
                  <td className="px-4 py-2 text-zinc-200"><code>{row.release}</code></td>
                  <td className="px-4 py-2">
                    {row.syncStatus ? (
                      <ToneBadge tone={syncStatusTone(row.syncStatus)}>{row.syncStatus}</ToneBadge>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-zinc-400 tabular-nums">{formatBytes(row.bytes)}</td>
                  <td className="px-4 py-2 text-zinc-400">{relativeTime(row.lastUsedAt)}</td>
                  <td className="px-4 py-2 text-right">
                    <Button type="button" variant="outline" size="sm" onClick={() => handlePrune(row.release)}>
                      <Trash2 className="h-4 w-4 mr-1.5" aria-hidden />
                      Prune
                    </Button>
                  </td>
                </tr>
              ))}
              {cached.length === 0 && (
                <tr><td className="px-4 py-4 text-sm text-zinc-500" colSpan={5}>No cached releases yet.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </section>

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
                <tr className="border-b border-zinc-800 text-left text-xs uppercase tracking-wide text-zinc-600">
                  <th className="px-4 py-2 font-medium">Release</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 text-right font-medium">Projects</th>
                  <th className="px-4 py-2 text-right font-medium">Rows</th>
                  <th className="px-4 py-2 font-medium">Finished</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id} className="border-b border-zinc-900 last:border-0">
                    <td className="px-4 py-2 text-zinc-200"><code>{row.release}</code></td>
                    <td className="px-4 py-2"><ToneBadge tone={syncStatusTone(row.status)}>{row.status}</ToneBadge></td>
                    <td className="px-4 py-2 text-right text-zinc-400 tabular-nums">{row.projectsProcessed ?? '—'}</td>
                    <td className="px-4 py-2 text-right text-zinc-400 tabular-nums">{row.domainsDiscovered ?? '—'}</td>
                    <td className="px-4 py-2 text-zinc-400">{relativeTime(row.queryFinishedAt ?? row.updatedAt)}</td>
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
