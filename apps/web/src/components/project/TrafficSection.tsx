import { useEffect, useMemo, useState } from 'react'
import { RefreshCw, Unplug } from 'lucide-react'

import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { ScoreGauge } from '../shared/ScoreGauge.js'
import {
  fetchGaStatus,
  fetchGaTraffic,
  triggerGaSync,
  disconnectGa,
} from '../../api.js'
import type { ApiGaStatus, ApiGaTraffic, ApiGaTrafficPage } from '../../api.js'

type SortKey = 'landingPage' | 'sessions' | 'organicSessions' | 'users'
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

export function TrafficSection({ projectName }: { projectName: string }) {
  const [status, setStatus] = useState<ApiGaStatus | null>(null)
  const [traffic, setTraffic] = useState<ApiGaTraffic | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('sessions')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  function loadData(cancelled: { current: boolean }) {
    setLoading(true)
    fetchGaStatus(projectName)
      .then((s) => {
        if (cancelled.current) return
        setStatus(s)
        if (s.connected) {
          return fetchGaTraffic(projectName)
        }
        return null
      })
      .then((t) => {
        if (cancelled.current) return
        if (t) setTraffic(t)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled.current) return
        setError(err instanceof Error ? err.message : 'Failed to load GA4 data')
        setLoading(false)
      })
  }

  useEffect(() => {
    const cancelled = { current: false }
    loadData(cancelled)
    return () => {
      cancelled.current = true
    }
  }, [projectName])

  async function handleSync() {
    setSyncing(true)
    setError(null)
    setNotice(null)
    try {
      const result = await triggerGaSync(projectName)
      setNotice(`Synced ${result.rowCount.toLocaleString()} rows (${result.days} days)`)
      const t = await fetchGaTraffic(projectName)
      setTraffic(t)
      const s = await fetchGaStatus(projectName)
      setStatus(s)
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
      setStatus({ connected: false, propertyId: null, clientEmail: null, lastSyncedAt: null, createdAt: null, updatedAt: null })
      setTraffic(null)
      setNotice('GA4 disconnected')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Disconnect failed')
    } finally {
      setDisconnecting(false)
    }
  }

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sortedPages = useMemo(() => {
    if (!traffic?.topPages) return []
    return [...traffic.topPages].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      return sortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number)
    })
  }, [traffic?.topPages, sortKey, sortDir])

  if (loading && !status) {
    return <p className="text-sm text-zinc-500 py-8 text-center">Loading traffic data…</p>
  }

  // Not connected state
  if (!status?.connected) {
    return (
      <Card className="surface-card p-6">
        <h3 className="text-base font-semibold text-zinc-50 mb-2">Google Analytics 4</h3>
        <p className="text-sm text-zinc-400 mb-4">
          Connect a GA4 property via the CLI to see traffic data for this project.
        </p>
        <div className="bg-zinc-900/60 rounded-lg p-3 border border-zinc-800/60">
          <code className="text-sm text-zinc-300">canonry ga connect {projectName} --key-file service-account.json --property-id 123456789</code>
        </div>
      </Card>
    )
  }

  const organicPct = traffic && traffic.totalSessions > 0
    ? Math.round((traffic.totalOrganicSessions / traffic.totalSessions) * 100)
    : 0

  return (
    <>
      {/* Error / Notice banners */}
      {error && (
        <div className="mb-4 px-4 py-2 rounded-lg bg-rose-900/20 border border-rose-800/60 text-sm text-rose-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 px-4 py-2 rounded-lg bg-emerald-900/20 border border-emerald-800/60 text-sm text-emerald-300">
          {notice}
        </div>
      )}

      {/* Connection info bar */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
          <span className="text-xs text-zinc-400">
            Property <span className="text-zinc-300">{status.propertyId}</span>
            {status.clientEmail && <> &middot; <span className="text-zinc-500">{status.clientEmail}</span></>}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={syncing}
            onClick={handleSync}
          >
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing…' : 'Sync'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-rose-400 hover:text-rose-300"
            disabled={disconnecting}
            onClick={handleDisconnect}
          >
            <Unplug className="w-3.5 h-3.5 mr-1.5" />
            Disconnect
          </Button>
        </div>
      </div>

      {/* Summary gauges */}
      <section>
        <div className="mb-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">Traffic Overview</p>
          <h2 className="text-base font-semibold text-zinc-50 flex items-center gap-1.5">
            Site Traffic
            <InfoTooltip text="Aggregated traffic metrics from Google Analytics 4. Sessions and users are summed across all synced dates. Organic sessions are Google organic search sessions specifically." />
          </h2>
        </div>

        {traffic ? (
          <div className="flex items-center gap-6">
            <ScoreGauge
              value={formatCompact(traffic.totalSessions)}
              label="Total Sessions"
              delta={traffic.totalSessions.toLocaleString()}
              tone="neutral"
              description="All traffic sources"
              isNumeric={false}
            />
            <ScoreGauge
              value={formatCompact(traffic.totalOrganicSessions)}
              label="Organic Sessions"
              delta={`${organicPct}% of total`}
              tone="positive"
              description="Google organic search"
              isNumeric={false}
            />
            <ScoreGauge
              value={formatCompact(traffic.totalUsers)}
              label="Total Users"
              delta={traffic.totalUsers.toLocaleString()}
              tone="neutral"
              description="Unique users"
              isNumeric={false}
            />
          </div>
        ) : (
          <div className="surface-card rounded-lg p-6 text-center border border-zinc-800/60">
            <p className="text-sm text-zinc-400 mb-3">No traffic data yet.</p>
            <Button variant="outline" size="sm" disabled={syncing} onClick={handleSync}>
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${syncing ? 'animate-spin' : ''}`} />
              Sync from GA4
            </Button>
          </div>
        )}
      </section>

      {/* Top Landing Pages */}
      {traffic && traffic.topPages.length > 0 && (
        <>
          <div className="page-section-divider" />

          <section>
            <div className="mb-4">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1">Page Performance</p>
              <h2 className="text-base font-semibold text-zinc-50 flex items-center gap-1.5">
                Top Landing Pages
                <InfoTooltip text="Landing pages ranked by session volume. Click column headers to sort. Organic % shows the share of sessions coming from Google organic search." />
              </h2>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-zinc-500">
                    <SortHeader label="Landing Page" sortKey="landingPage" current={sortKey} dir={sortDir} onSort={handleSort} align="left" />
                    <SortHeader label="Sessions" sortKey="sessions" current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                    <SortHeader label="Organic" sortKey="organicSessions" current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                    <th className="text-right py-1 font-medium">Organic %</th>
                    <SortHeader label="Users" sortKey="users" current={sortKey} dir={sortDir} onSort={handleSort} align="right" />
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
      <div className="mt-6 flex items-center justify-between text-xs text-zinc-500">
        <span>
          {traffic?.lastSyncedAt
            ? `Last synced ${relativeTime(traffic.lastSyncedAt)}`
            : 'Never synced'}
        </span>
        <span>{traffic ? `${traffic.topPages.length} pages shown` : ''}</span>
      </div>
    </>
  )
}

function SortHeader({
  label,
  sortKey: key,
  current,
  dir,
  onSort,
  align,
}: {
  label: string
  sortKey: SortKey
  current: SortKey
  dir: SortDir
  onSort: (key: SortKey) => void
  align: 'left' | 'right'
}) {
  const active = current === key
  return (
    <th
      className={`py-1 font-medium cursor-pointer select-none hover:text-zinc-300 transition-colors ${align === 'right' ? 'text-right' : 'text-left'}`}
      onClick={() => onSort(key)}
    >
      {label}
      {active && <span className="ml-0.5">{dir === 'asc' ? '↑' : '↓'}</span>}
    </th>
  )
}

function LandingPageRow({ page }: { page: ApiGaTrafficPage }) {
  const organicPct = page.sessions > 0
    ? ((page.organicSessions / page.sessions) * 100).toFixed(1)
    : '0.0'

  return (
    <tr className="border-t border-zinc-800/40">
      <td className="py-1.5 text-zinc-300 max-w-[400px] truncate" title={page.landingPage}>
        {page.landingPage}
      </td>
      <td className="py-1.5 text-right text-zinc-200 tabular-nums">
        {page.sessions.toLocaleString()}
      </td>
      <td className="py-1.5 text-right text-emerald-400 tabular-nums">
        {page.organicSessions.toLocaleString()}
      </td>
      <td className="py-1.5 text-right text-zinc-400 tabular-nums">
        {organicPct}%
      </td>
      <td className="py-1.5 text-right text-zinc-200 tabular-nums">
        {page.users.toLocaleString()}
      </td>
    </tr>
  )
}
