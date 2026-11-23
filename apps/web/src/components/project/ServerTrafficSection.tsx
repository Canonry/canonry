import { Suspense, useEffect, useRef, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { lazyRouteComponent, Link, useNavigate } from '@tanstack/react-router'
import { ArrowRight, Plus } from 'lucide-react'

import { TrafficSourceStatuses, type CloudRunTrafficSetup, type TrafficSourceDto } from '@canonry/canonry-contracts'

import { heyClient, isEmbed, isPublicDemo, type ApiTrafficSourceDetail } from '../../api.js'
import { getApiV1ProjectsByNameTrafficSourcesByIdOptions } from '@canonry/canonry-api-client/react-query'
import { Button } from '../ui/button.js'
import { Card } from '../ui/card.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { shouldNavigateFromRowClick } from '../../lib/row-navigation.js'
import { ConnectSourceDrawer } from '../server-traffic/ConnectSourceDrawer.js'
import { useAccount } from '../../contexts/account-context.js'
import { toneFromTrafficSourceStatus, useServerTrafficSources } from '../../queries/server-traffic.js'

const TrafficSourceDetail = lazyRouteComponent(() => import('../../pages/TrafficSourceDetailPage.js'), 'TrafficSourceDetail')

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

type ServerTrafficProps = { projectName: string } & (
  | { view: 'sources' }
  | { view: 'project'; sourceId?: string; initialCloudRunTarget?: CloudRunTrafficSetup; onSelectSource: (id: string) => void }
)

export function ServerTrafficSection(props: ServerTrafficProps) {
  const { projectName } = props
  const { canWrite } = useAccount()
  const canConnect = canWrite && !isEmbed() && !isPublicDemo()
  const initialCloudRunTarget = props.view === 'project' ? props.initialCloudRunTarget : undefined
  const [connectOpen, setConnectOpen] = useState<boolean | undefined>(initialCloudRunTarget ? true : undefined)
  const connectOpener = useRef<HTMLButtonElement | null>(null)
  const sourcesQuery = useServerTrafficSources(projectName)
  const sources = sourcesQuery.data?.sources
  const needsSetup = props.view === 'project' && canConnect && sourcesQuery.isSuccess && !sourcesQuery.isFetching && sources?.length === 0
  useEffect(() => {
    if (needsSetup) setConnectOpen(previous => previous ?? true)
  }, [needsSetup])

  const connectButton = canConnect && (
    <Button ref={connectOpener} type="button" variant="outline" size="sm" onClick={() => setConnectOpen(true)}>
      <Plus className="size-3.5" /> Connect a source
    </Button>
  )
  const activeSource = props.view === 'project' && sources
    ? sources.find(source => source.id === props.sourceId)
      ?? sources.find(source => source.status === TrafficSourceStatuses.connected)
      ?? sources[0]
    : undefined

  return (
    <section aria-label="Server traffic">
      {props.view === 'sources' && canConnect && <div className="mb-3 flex justify-end">{connectButton}</div>}
      {sourcesQuery.isError && !sources?.length ? (
        <div role="alert" className="flex items-center gap-3">
          <p className="text-copy-14 text-negative">Could not load traffic sources.</p>
          <Button variant="outline" size="sm" onClick={() => { void sourcesQuery.refetch() }}>Retry</Button>
        </div>
      ) : !sources || (props.view === 'project' && !sources.length && sourcesQuery.isFetching && connectOpen === undefined) ? (
        <p role="status" className="text-copy-14 text-secondary">Loading sources…</p>
      ) : sources.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <p className="text-copy-14 text-neutral">No traffic sources connected for {projectName}.</p>
          {props.view === 'project' && connectButton}
        </Card>
      ) : props.view === 'project' && activeSource ? (
        <>
          <div className="page-header">
            <div className="page-header-left">
              {sources.length > 1 ? (
                <label className="flex flex-wrap items-center gap-2 text-label-14-strong text-secondary">
                  Source
                  <select
                    className="h-8 max-w-full rounded-md border border-base bg-bg px-2 text-label-14 text-heading"
                    value={activeSource.id}
                    onChange={event => props.onSelectSource(event.target.value)}
                  >
                    {sources.map(source => <option key={source.id} value={source.id}>{source.displayName}</option>)}
                  </select>
                </label>
              ) : <h2 className="text-heading-20 text-heading">{activeSource.displayName}</h2>}
              <p className="page-subtitle">{activeSource.lastSyncedAt ? `Last synced ${relativeTime(activeSource.lastSyncedAt)}` : 'Never synced'}</p>
            </div>
            <div className="flex items-center gap-2">
              <ToneBadge tone={toneFromTrafficSourceStatus(activeSource.status)}>{activeSource.status}</ToneBadge>
              {connectButton}
            </div>
          </div>
          <Suspense fallback={<p role="status" className="text-copy-14 text-secondary">Loading source…</p>}>
            <TrafficSourceDetail key={activeSource.id} projectName={projectName} sourceId={activeSource.id} />
          </Suspense>
        </>
      ) : (
        <SourcesTable projectName={projectName} sources={sources} />
      )}

      {canConnect && (
        <ConnectSourceDrawer
          initialCloudRunTarget={initialCloudRunTarget}
          open={connectOpen === true}
          onOpenChange={open => {
            setConnectOpen(open)
            // CLI-based setup can add the first source outside this browser.
            if (!open && props.view === 'project' && sources?.length === 0 && !sourcesQuery.isFetching) void sourcesQuery.refetch()
          }}
          onClosed={() => connectOpener.current?.focus()}
          onSourceConnected={props.view === 'project' ? props.onSelectSource : undefined}
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
