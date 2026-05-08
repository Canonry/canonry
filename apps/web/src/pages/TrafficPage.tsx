import { useMemo, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Plus, RefreshCw } from 'lucide-react'

import { TrafficSourceStatuses, type TrafficSourceDto } from '@ainyc/canonry-contracts'

import { fetchProjects, fetchServerTrafficSource, type ApiProject, type ApiTrafficSourceDetail } from '../api.js'
import { Button } from '../components/ui/button.js'
import { Card } from '../components/ui/card.js'
import { ToneBadge } from '../components/shared/ToneBadge.js'
import { ConnectCloudRunDrawer } from '../components/server-traffic/ConnectCloudRunDrawer.js'
import { queryKeys } from '../queries/query-keys.js'
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

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.all,
    queryFn: fetchProjects,
  })
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
          <h1 className="page-title">Server traffic</h1>
          <p className="page-subtitle">
            Crawler hits and AI-referral arrivals pulled directly from server logs (Cloud Run, etc.). Independent of GA — useful when you need server-side evidence that GPTBot or ChatGPT-User actually hit a page.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setConnectOpen(true)}
          disabled={!activeProject}
        >
          <Plus className="size-3.5" />
          Connect Cloud Run
        </Button>
      </div>

      <section>
        <div className="filter-row" role="toolbar" aria-label="Project picker">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              className={`filter-chip ${activeProject === project.name ? 'filter-chip-active' : ''}`}
              aria-pressed={activeProject === project.name}
              onClick={() => setSelectedProject(project.name)}
            >
              {project.displayName ?? project.name}
            </button>
          ))}
        </div>

        {!activeProject ? (
          <Card className="p-6 text-center text-sm text-zinc-500">No projects yet.</Card>
        ) : sourcesQuery.isLoading ? (
          <Card className="p-6 text-center text-sm text-zinc-500">Loading sources…</Card>
        ) : sources.length === 0 ? (
          <Card className="p-8 text-center">
            <p className="text-sm text-zinc-300">No traffic sources connected for {activeProject}.</p>
            <p className="mt-1 text-xs text-zinc-500">Connect a Cloud Run service to start ingesting crawler and AI-referral hits from server logs.</p>
            <div className="mt-4">
              <Button type="button" variant="outline" size="sm" onClick={() => setConnectOpen(true)}>
                <Plus className="size-3.5" />
                Connect Cloud Run
              </Button>
            </div>
          </Card>
        ) : (
          <SourcesTable projectName={activeProject} sources={sources} />
        )}
      </section>

      <ConnectCloudRunDrawer
        open={connectOpen}
        onOpenChange={setConnectOpen}
        projectName={activeProject}
      />
    </div>
  )
}

function SourcesTable({ projectName, sources }: { projectName: string; sources: TrafficSourceDto[] }) {
  // UI/CLI parity: this view shows last-24h totals + latest run, the same shape `canonry traffic status`
  // returns. Rather than denormalize the totals onto the list endpoint, fan out to /traffic/sources/:id —
  // v1 caps a project at one active Cloud Run source so the fan-out is bounded.
  const detailQueries = useQueries({
    queries: sources.map((source) => ({
      queryKey: queryKeys.serverTraffic.sourceDetail(projectName, source.id),
      queryFn: () => fetchServerTrafficSource(projectName, source.id),
      staleTime: 30_000,
    })),
  })

  const rows = sources.map((source, i) => ({
    source,
    detail: detailQueries[i]?.data as ApiTrafficSourceDetail | undefined,
    isLoading: detailQueries[i]?.isLoading ?? false,
  }))

  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-zinc-900/50 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          <tr>
            <th className="px-4 py-2 text-left">Source</th>
            <th className="px-4 py-2 text-left">Status</th>
            <th className="px-4 py-2 text-left">Last sync</th>
            <th className="px-4 py-2 text-right">24h crawler</th>
            <th className="px-4 py-2 text-right">24h AI referral</th>
            <th className="px-4 py-2 text-right">24h samples</th>
            <th className="px-4 py-2 text-right" />
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/60">
          {rows.map(({ source, detail, isLoading }) => (
            <tr key={source.id} className="hover:bg-zinc-900/40 transition-colors">
              <td className="px-4 py-3">
                <div className="font-medium text-zinc-100">{source.displayName}</div>
                <div className="text-[11px] text-zinc-500 font-mono">{source.sourceType} · {source.id.slice(0, 8)}</div>
              </td>
              <td className="px-4 py-3">
                <ToneBadge tone={toneFromTrafficSourceStatus(source.status)}>
                  {source.status}
                </ToneBadge>
                {source.lastError ? (
                  <p className="mt-1 max-w-[18rem] truncate text-[11px] text-rose-400/80" title={source.lastError}>
                    {source.lastError}
                  </p>
                ) : null}
              </td>
              <td className="px-4 py-3 text-zinc-300">{relativeTime(source.lastSyncedAt)}</td>
              <td className="px-4 py-3 text-right tabular-nums text-zinc-100">
                {isLoading ? '—' : formatCompact(detail?.totals24h.crawlerHits ?? 0)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-zinc-100">
                {isLoading ? '—' : formatCompact(detail?.totals24h.aiReferralHits ?? 0)}
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-zinc-300">
                {isLoading ? '—' : formatCompact(detail?.totals24h.sampleCount ?? 0)}
              </td>
              <td className="px-4 py-3 text-right">
                <Link
                  to="/traffic/$projectName/$sourceId"
                  params={{ projectName, sourceId: source.id }}
                  className="inline-flex items-center gap-1 text-xs text-zinc-300 hover:text-zinc-100"
                >
                  <RefreshCw className="size-3" />
                  View
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-zinc-800/60 px-4 py-2 text-[11px] text-zinc-600">
        Showing {sources.filter((s) => s.status !== TrafficSourceStatuses.archived).length} active source{sources.length === 1 ? '' : 's'} for {projectName}.
        Same shape as <code className="text-zinc-400">canonry traffic status {projectName} --format json</code>.
      </p>
    </div>
  )
}
