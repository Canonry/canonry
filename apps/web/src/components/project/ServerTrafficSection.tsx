import { useRef, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowRight, Plus } from 'lucide-react'

import type { TrafficSourceDto } from '@canonry/canonry-contracts'

import { heyClient, isEmbed, type ApiTrafficSourceDetail } from '../../api.js'
import { getApiV1ProjectsByNameTrafficSourcesByIdOptions } from '@canonry/canonry-api-client/react-query'
import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { shouldNavigateFromRowClick } from '../../lib/row-navigation.js'
import { ConnectSourceDrawer } from '../server-traffic/ConnectSourceDrawer.js'
import { toneFromTrafficSourceStatus, useServerTrafficSources } from '../../queries/server-traffic.js'

function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
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

/** This project's server-log sources: crawler hits, AI fetches, and referral sessions. */
export function ServerTrafficSection({ projectName, heading = true }: { projectName: string; heading?: boolean }) {
  const [connectOpen, setConnectOpen] = useState(false)
  const connectOpener = useRef<HTMLButtonElement | null>(null)
  const sourcesQuery = useServerTrafficSources(projectName)
  const sources = sourcesQuery.data?.sources ?? []
  const openConnection = (button: HTMLButtonElement) => { connectOpener.current = button; setConnectOpen(true) }

  return (
    <section aria-labelledby={heading ? 'server-traffic-heading' : undefined} aria-label={heading ? undefined : 'Server traffic'}>
      <div className="section-head section-head-inline">
        <div>
          {heading ? (
            <>
              <h2 id="server-traffic-heading" className="text-heading-20 text-heading">Server traffic</h2>
              <p className="page-subtitle">AI crawler hits and referral sessions from your server logs.</p>
            </>
          ) : null}
        </div>
        {!isEmbed() && (
          <Button type="button" variant="outline" size="sm" onClick={event => openConnection(event.currentTarget)}>
            <Plus className="size-3.5" />
            Connect a source
          </Button>
        )}
      </div>

      {sourcesQuery.isLoading ? (
        <Card className="p-6 text-center text-label-14 text-muted">Loading sources…</Card>
      ) : sources.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-copy-14 text-neutral">No traffic sources connected for {projectName}.</p>
          {!isEmbed() && <p className="mt-1 text-copy-14 text-secondary">Connect a source to start collecting traffic.</p>}
        </Card>
      ) : (
        <SourcesTable projectName={projectName} sources={sources} />
      )}

      {!isEmbed() && (
        <ConnectSourceDrawer
          open={connectOpen}
          onOpenChange={setConnectOpen}
          onClosed={() => { if (connectOpener.current?.isConnected) connectOpener.current.focus() }}
          projectName={projectName}
        />
      )}
    </section>
  )
}

function SourcesTable({ projectName, sources }: { projectName: string; sources: TrafficSourceDto[] }) {
  const navigate = useNavigate()
  const detailQueries = useQueries({
    queries: sources.map((source) => ({
      ...getApiV1ProjectsByNameTrafficSourcesByIdOptions({
        client: heyClient,
        path: { name: projectName, id: source.id },
      }),
      staleTime: 30_000,
    })),
  })

  const rows = sources.map((source, i) => ({
    source,
    detail: detailQueries[i]?.data as ApiTrafficSourceDetail | undefined,
    isLoading: detailQueries[i]?.isLoading ?? false,
  }))

  return (
    <div className="material-base overflow-hidden">
      <table className="w-full text-label-14">
        <caption className="sr-only">Server traffic sources for the last 24 hours</caption>
        <thead className="bg-bg-elevated/50 text-label-12-strong normal-case text-muted">
          <tr>
            <th className="px-4 py-2 text-left">Source</th>
            <th className="px-4 py-2 text-left">Status</th>
            <th className="px-4 py-2 text-left">Last sync</th>
            <th className="px-4 py-2 text-right">Content crawls</th>
            <th className="px-4 py-2 text-right">Infra crawls</th>
            <th className="px-4 py-2 text-right">AI fetches</th>
            <th className="px-4 py-2 text-right">AI referrals</th>
            <th className="px-4 py-2 text-right"><span className="sr-only">Detail</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-mono-800/60">
          {rows.map(({ source, detail, isLoading }) => (
            <tr
              key={source.id}
              className="cursor-pointer transition-colors hover:bg-bg-elevated/40 focus-within:bg-bg-elevated/40"
              onClick={(event) => {
                if (!shouldNavigateFromRowClick(event)) return
                void navigate({
                  to: '/traffic/$projectName/$sourceId',
                  params: { projectName, sourceId: source.id },
                })
              }}
            >
              <td className="px-4 py-3">
                <Link
                  to="/traffic/$projectName/$sourceId"
                  params={{ projectName, sourceId: source.id }}
                  className="text-label-14-strong text-heading hover:underline"
                >
                  {source.displayName}
                </Link>
              </td>
              <td className="px-4 py-3">
                <ToneBadge tone={toneFromTrafficSourceStatus(source.status)}>
                  {source.status}
                </ToneBadge>
                {source.lastError ? (
                  <p className="mt-1 max-w-[18rem] truncate text-copy-14 text-negative-400" title={source.lastError}>
                    {source.lastError}
                  </p>
                ) : null}
              </td>
              <td className="px-4 py-3 text-neutral">{relativeTime(source.lastSyncedAt)}</td>
              <td
                className="px-4 py-3 text-right tabular-nums text-heading"
                title={detail ? `${detail.totals24h.crawlerHits.toLocaleString('en-US')} total crawler hits` : undefined}
              >
                {isLoading ? '—' : formatCompact(detail?.totals24h.crawlerContentHits ?? 0)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-muted">
                {isLoading ? '—' : formatCompact(detail?.totals24h.crawlerInfraHits ?? 0)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-heading">
                {isLoading ? '—' : formatCompact(detail?.totals24h.aiUserFetchHits ?? 0)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-heading">
                {isLoading ? '—' : formatCompact(detail?.totals24h.aiReferralLandedHits ?? 0)}
              </td>
              <td className="px-4 py-3 text-right">
                <Link
                  to="/traffic/$projectName/$sourceId"
                  params={{ projectName, sourceId: source.id }}
                  className="inline-flex items-center gap-1 text-label-14 text-secondary hover:text-heading"
                >
                  View
                  <ArrowRight className="size-3.5" />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
