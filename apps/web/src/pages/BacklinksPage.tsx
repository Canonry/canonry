import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
import { Download, HelpCircle, Play, Trash2, CheckCircle2, AlertCircle, AlertTriangle } from 'lucide-react'
import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'

function Hint({
  children,
  label = 'More info',
  placement = 'top',
  className,
}: {
  children: ReactNode
  label?: string
  placement?: 'top' | 'bottom'
  className?: string
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  return (
    <span className={`relative inline-flex ${className ?? ''}`}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-zinc-500 hover:text-zinc-200 focus:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-zinc-500"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <HelpCircle className="h-3.5 w-3.5" aria-hidden />
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className={`absolute z-50 w-64 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-normal leading-relaxed text-zinc-200 shadow-lg ${
            placement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2'
          } left-1/2 -translate-x-1/2 whitespace-normal`}
        >
          {children}
        </span>
      )}
    </span>
  )
}
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

  const latestReadyButCacheMissing =
    latest?.status === 'ready' &&
    cached.every((c) => c.release !== latest.release)

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Backlinks</h1>
          <p className="page-subtitle">
            Find domains that link to your projects, computed from the open Common Crawl web graph. Runs entirely on your machine — nothing is sent to third parties.
          </p>
        </div>
      </div>

      <Card className="surface-card p-4 mb-6 border-amber-800/60">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" aria-hidden />
          <div className="text-sm text-zinc-300 leading-relaxed">
            <p className="font-medium text-amber-200">Heads up — a release sync is a large download.</p>
            <ul className="mt-1.5 space-y-1 text-zinc-400">
              <li>
                <span className="text-zinc-200">~16 GB</span> of gzipped vertex + edge files per release, stored at{' '}
                <code className="text-zinc-300">~/.canonry/cache/commoncrawl/</code>.
              </li>
              <li>
                <span className="text-zinc-200">10–20 min on a fast connection</span> for the download, then ~5 min for the DuckDB query.
              </li>
              <li>
                One sync covers every project in this workspace. Releases are immutable, so the download only happens once per release.
              </li>
            </ul>
          </div>
        </div>
      </Card>

      <section className="page-section-divider">
        <div className="section-head section-head-inline">
          <div>
            <p className="eyebrow eyebrow-soft">About</p>
            <h2>How it works</h2>
          </div>
        </div>
        <Card className="surface-card p-5">
          <p className="text-sm text-zinc-400 leading-relaxed max-w-3xl mb-4">
            Common Crawl publishes a quarterly snapshot of the public web&rsquo;s hyperlink graph. Canonry downloads one{' '}
            <span className="text-zinc-200">release</span> at a time and extracts backlinks for every project in this
            workspace in a single pass.
          </p>
          <ol className="space-y-3 text-sm text-zinc-400 max-w-3xl">
            <li className="flex gap-3">
              <span className="shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-xs font-semibold text-zinc-300 tabular-nums">1</span>
              <span>
                <span className="text-zinc-200 font-medium">Download (one-time, ~16 GB)</span> — vertex + edge files cached to{' '}
                <code className="text-zinc-300">~/.canonry/cache/commoncrawl/</code>. Runs once per release; subsequent operations reuse the cache.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-xs font-semibold text-zinc-300 tabular-nums">2</span>
              <span>
                <span className="text-zinc-200 font-medium">Query (~5 min)</span> — one DuckDB pass scans the cached files and extracts referring domains for every project&rsquo;s canonical domain. DuckDB is only used to <span className="text-zinc-200">read</span> these dumps; it doesn&rsquo;t store any canonry state.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-xs font-semibold text-zinc-300 tabular-nums">3</span>
              <span>
                <span className="text-zinc-200 font-medium">Persist</span> — results land in the same SQLite database the rest of canonry uses. After the first sync, per-project reads (and re-run extracts against the cached release) are instant.
              </span>
            </li>
          </ol>
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
            <h2 className="flex items-center gap-2">
              DuckDB install status
              <Hint label="Why DuckDB?">
                <span className="block">
                  DuckDB is a query engine canonry uses to scan the ~16 GB Common Crawl dumps and pull out your referring domains.
                </span>
                <span className="mt-2 block text-zinc-400">
                  It does <span className="text-zinc-200">not</span> store any canonry data — your backlink results live in SQLite alongside the rest of your projects. DuckDB is purely a tool for processing the raw CSV files.
                </span>
                <span className="mt-2 block text-zinc-500">
                  Installed on demand (not bundled) into <code className="text-zinc-300">~/.canonry/plugins/</code> so users who never run backlinks don&rsquo;t pay the ~40 MB install cost.
                </span>
              </Hint>
            </h2>
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
                  DuckDB is not installed. It&rsquo;s the query engine canonry uses to scan Common Crawl dumps — required before you can run a release sync or per-project extract.
                </p>
                <p className="text-xs text-zinc-500 mt-1">
                  Installing doesn&rsquo;t touch your project data. DuckDB only reads the downloaded CSV files; backlink results are written to the same SQLite database canonry already uses.
                </p>
                {status && (
                  <p className="text-xs text-zinc-500 mt-1">
                    Will be installed into <code className="text-zinc-300">{status.pluginDir}</code> (~40 MB).
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
          <p className="text-xs text-zinc-500 max-w-3xl mb-4">
            A release is one Common Crawl dump (e.g. <code className="text-zinc-400">cc-main-2026-jan-feb-mar</code>). Syncing it downloads the graph and populates backlinks for every project in this workspace.
          </p>
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
                  <p className="text-zinc-600 uppercase tracking-wide flex items-center gap-1">
                    Rows
                    <Hint label="What are rows?">
                      Total number of (project, referring domain) pairs persisted in SQLite from this sync, across every project in the workspace.
                    </Hint>
                  </p>
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
          {latestReadyButCacheMissing && (
            <div className="mt-4 rounded border border-amber-800/60 bg-amber-950/20 p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" aria-hidden />
                <div className="text-xs text-zinc-300 leading-relaxed">
                  <p className="font-medium text-amber-200">Cached files for this release are missing.</p>
                  <p className="mt-1 text-zinc-400">
                    The sync record in the database says this release finished successfully, but the ~16 GB dump at{' '}
                    <code className="text-zinc-300">~/.canonry/cache/commoncrawl/{latest?.release}/</code> isn&rsquo;t on disk. Your backlink data is still intact (it lives in SQLite), but per-project re-run extracts will fail until you either re-sync this release or start a new one.
                  </p>
                </div>
              </div>
            </div>
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
            <Hint label="What does Run sync do?">
              <span className="block">
                Downloads the named Common Crawl release (~16 GB) to{' '}
                <code className="text-zinc-300">~/.canonry/cache/commoncrawl/</code>, then runs a single DuckDB query that extracts referring domains for every project in this workspace.
              </span>
              <span className="mt-2 block text-zinc-400">
                First time for a release: <span className="text-zinc-200">~10–20 min download + ~5 min query</span>. Re-running the same release later: <span className="text-zinc-200">skips download, just re-queries</span> (~5 min).
              </span>
            </Hint>
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
            <h2 className="flex items-center gap-2">
              Local disk cache
              <Hint label="What is this?">
                <span className="block">
                  Raw Common Crawl dumps stored at{' '}
                  <code className="text-zinc-300">~/.canonry/cache/commoncrawl/&lt;release&gt;/</code>. Each release takes ~16 GB.
                </span>
                <span className="mt-2 block text-zinc-400">
                  These files are needed to re-run per-project extracts against a release without re-downloading. Pruning here <span className="text-zinc-200">does not delete your backlink data</span> — that lives in SQLite.
                </span>
              </Hint>
            </h2>
          </div>
        </div>
        <p className="text-xs text-zinc-500 mb-3 max-w-3xl">
          Each cached release is a ~16 GB pair of gzipped files. They&rsquo;re needed to re-query the graph (e.g. for a newly-added project) without re-downloading. Safe to prune — backlink results persist in SQLite.
        </p>
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
                    <div className="inline-flex items-center gap-1">
                      <Button type="button" variant="outline" size="sm" onClick={() => handlePrune(row.release)}>
                        <Trash2 className="h-4 w-4 mr-1.5" aria-hidden />
                        Prune
                      </Button>
                      <Hint label="What does Prune do?" placement="top">
                        Deletes the ~16 GB cache for this release from disk. Backlink results already in SQLite remain untouched. To re-run extracts against this release, you&rsquo;d have to sync it again (another ~16 GB download).
                      </Hint>
                    </div>
                  </td>
                </tr>
              ))}
              {cached.length === 0 && (
                <tr><td className="px-4 py-4 text-sm text-zinc-500" colSpan={5}>
                  No cached releases on this machine. If you ran a sync from a different machine (or deleted the cache), the backlink data is still in the database — but you&rsquo;ll need to re-sync a release to run new extracts.
                </td></tr>
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
