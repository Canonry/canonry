import { useMemo, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowRight, Plus } from 'lucide-react'

import type { TrafficSourceDto } from '@canonry/canonry-contracts'

import { heyClient, isEmbed, type ApiProject, type ApiTrafficSourceDetail } from '../api.js'
import {
  getApiV1ProjectsByNameTrafficSourcesByIdOptions,
  getApiV1ProjectsOptions,
} from '@canonry/canonry-api-client/react-query'
import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { shouldNavigateFromRowClick } from '../lib/row-navigation.js'
import { ConnectSourceDrawer } from '../components/server-traffic/ConnectSourceDrawer.js'
import {
  toneFromTrafficSourceStatus,
  useServerTrafficSources,
} from '../queries/server-traffic.js'

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

export function TrafficPage() {
  const [selectedProject, setSelectedProject] = useState<string>('')
  const [connectOpen, setConnectOpen] = useState(false)

  const projectsQuery = useQuery(getApiV1ProjectsOptions({ client: heyClient }))
  const projects: ApiProject[] = projectsQuery.data ?? []

  const activeProject = useMemo(() => {
    if (selectedProject) return selectedProject
    return projects[0]?.name ?? ''
  }, [selectedProject, projects])

  const sourcesQuery = useServerTrafficSources(activeProject || null)
  const sources = sourcesQuery.data?.sources ?? []

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="page-header-left">
          <h1 className="page-title">Traffic sources</h1>
          <p className="page-subtitle">
            AI crawler hits and referral sessions from your server logs.
          </p>
        </div>
        {!isEmbed() && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConnectOpen(true)}
              disabled={!activeProject}
            >
              <Plus className="size-3.5" />
              Connect a source
            </Button>
          </div>
        )}
      </div>

      <section>
        {projects.length > 1 && (
          <label className="mb-4 flex w-fit items-center gap-2 text-sm font-medium text-secondary" htmlFor="traffic-project">
            Project
            <select
              id="traffic-project"
              className="h-8 min-w-44 rounded-md border border-base bg-bg px-2 text-sm text-heading outline-none transition focus:border-mono-500 focus:ring-1 focus:ring-mono-500"
              value={activeProject}
              onChange={(event) => setSelectedProject(event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.name}>
                  {project.displayName ?? project.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {!activeProject ? (
          <Card className="p-6 text-center text-sm text-muted">No projects yet.</Card>
        ) : sourcesQuery.isLoading ? (
          <Card className="p-6 text-center text-sm text-muted">Loading sources…</Card>
        ) : sources.length === 0 ? (
          <Card className="p-8 text-center">
            <p className="text-sm text-neutral">No traffic sources connected for {activeProject}.</p>
            {!isEmbed() && (
              <>
                <p className="mt-1 text-sm text-secondary">Connect a source to start collecting traffic.</p>
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setConnectOpen(true)}>
                    <Plus className="size-3.5" />
                    Connect a source
                  </Button>
                </div>
              </>
            )}
          </Card>
        ) : (
          <SourcesTable projectName={activeProject} sources={sources} />
        )}
      </section>

      {!isEmbed() && (
        <ConnectSourceDrawer
          open={connectOpen}
          onOpenChange={setConnectOpen}
          projectName={activeProject}
        />
      )}
    </div>
  )
}

function SourcesTable({ projectName, sources }: { projectName: string; sources: TrafficSourceDto[] }) {
  const navigate = useNavigate()
  // UI/CLI parity: this view shows last-24h totals + latest run, the same shape `canonry traffic status`
  // returns. Rather than denormalize the totals onto the list endpoint, fan out to /traffic/sources/:id.
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
    <div className="rounded-xl border border-default bg-surface overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-bg-elevated/50 text-[10px] font-semibold uppercase tracking-wider text-muted">
          <tr>
            <th className="px-4 py-2 text-left">Source</th>
            <th className="px-4 py-2 text-left">Status</th>
            <th className="px-4 py-2 text-left">Last sync</th>
            <th className="px-4 py-2 text-right">Content crawls</th>
            <th className="px-4 py-2 text-right">Infra crawls</th>
            <th className="px-4 py-2 text-right">AI fetches</th>
            <th className="px-4 py-2 text-right">AI referrals</th>
            <th className="px-4 py-2 text-right" />
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
                {/* The real anchor. The row's onClick is a mouse convenience on
                    top of this; keyboard and assistive tech use the link. */}
                <Link
                  to="/traffic/$projectName/$sourceId"
                  params={{ projectName, sourceId: source.id }}
                  className="font-medium text-heading hover:underline"
                >
                  {source.displayName}
                </Link>
              </td>
              <td className="px-4 py-3">
                <ToneBadge tone={toneFromTrafficSourceStatus(source.status)}>
                  {source.status}
                </ToneBadge>
                {source.lastError ? (
                  <p className="mt-1 max-w-[18rem] truncate text-sm text-negative-400" title={source.lastError}>
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
                  className="inline-flex items-center gap-1 text-sm text-secondary hover:text-heading"
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
