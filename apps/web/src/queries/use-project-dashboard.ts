import { useCallback, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  fetchQueries,
  fetchTimeline,
  fetchRunDetail,
  fetchProjectOverview,
  heyClient,
} from '../api.js'
import {
  getApiV1ProjectsByNameOptions,
  getApiV1ProjectsByNameRunsOptions,
} from '@ainyc/canonry-api-client/react-query'
import { buildProjectCommandCenter } from '../build-dashboard.js'
import type { ProjectData } from '../build-dashboard.js'
import type { ProjectCommandCenterVm } from '../view-models.js'
import { useInitialDashboard } from '../contexts/dashboard-context.js'
import { RUNS_STALE_MS, STATIC_VISIBILITY_STALE_MS } from './query-client.js'
import { competitorEvidenceRevision } from './competitor-landscape-refresh.js'

const DASHBOARD_TIMELINE_RUN_LIMIT = 20

interface ProjectDashboardOptions {
  /** Summary metrics are only consumed by AI Visibility. */
  overview?: boolean
  /** Full answer history is needed by Simple evidence and the answer drawer. */
  evidence?: boolean
}

/** Project identity loads independently of optional summary and evidence reads. */
export function useProjectDashboard(
  projectName: string | null | undefined,
  options: ProjectDashboardOptions = {},
) {
  const queryClient = useQueryClient()
  // First-paint / SSR fallback: when the DashboardProvider has injected a
  // pre-built fixture (used by tests and the SSR shell), prefer the
  // matching `ProjectCommandCenterVm` from there until the per-project
  // queries resolve. Without this, the project page renders as a loading
  // skeleton during the first synchronous render — which breaks
  // `renderToStaticMarkup` tests and adds a layout-shift flash for users
  // on real loads.
  const contextDashboard = useInitialDashboard()
  const initialCommandCenter = useMemo<ProjectCommandCenterVm | null>(() => {
    if (!contextDashboard || !projectName) return null
    return contextDashboard.dashboard.projects.find(
      p => p.project.name === projectName,
    ) ?? null
  }, [contextDashboard, projectName])

  // The active project-page queries below override the global
  // `refetchOnWindowFocus: false` default. Rationale: CLI-driven
  // mutations (`cnry query add`, `cnry competitor add`, `cnry project
  // create`, etc.) bypass React Query entirely — the dashboard's cache
  // has no idea state changed on the server. Without focus-refetch,
  // the operator's typical workflow ("open dashboard → alt-tab to
  // terminal → run a CLI mutation → alt-tab back") shows stale data
  // for up to 30 minutes (STATIC_VISIBILITY_STALE_MS). Use `'always'`
  // (not just `true`) so the refetch fires regardless of staleTime —
  // a `true` value would only refetch if the cached data had aged
  // past staleTime, which defeats the alt-tab use case.
  const projectQuery = useQuery({
    ...getApiV1ProjectsByNameOptions({ client: heyClient, path: { name: projectName ?? '' } }),
    enabled: !!projectName && !initialCommandCenter,
    staleTime: STATIC_VISIBILITY_STALE_MS,
    refetchOnWindowFocus: 'always',
  })

  // Project-scoped runs list. MUST be the per-project endpoint, not the global
  // `/runs` list: that global list is capped to the most recent runs across ALL
  // projects, so a project that has gone quiet while others keep sweeping falls
  // off it entirely. Filtering that capped list to the project then yields an
  // empty `latestRunIds`, and the per-query views render blank even though the
  // project has plenty of (older) runs. The per-project endpoint always returns
  // this project's own runs, so the latest sweep is found regardless of cadence.
  const runsQuery = useQuery({
    ...getApiV1ProjectsByNameRunsOptions({ client: heyClient, path: { name: projectName ?? '' }, query: { kind: 'answer-visibility' } }),
    enabled: !!projectName,
    staleTime: RUNS_STALE_MS,
    refetchOnWindowFocus: 'always',
    refetchInterval: (query) => {
      const runs = query.state.data
      const hasActive = runs?.some(r =>
        r.projectId === projectQuery.data?.id
        && (r.status === 'running' || r.status === 'queued'),
      )
      return hasActive ? 3000 : RUNS_STALE_MS
    },
  })

  const project = projectQuery.data ?? null
  const projectRuns = useMemo(() => {
    if (!project) return []
    return (runsQuery.data ?? []).filter(r => r.projectId === project.id)
  }, [project, runsQuery.data])

  // Mirror the multi-location run-grouping logic from `useDashboard`:
  // pick all sibling runs with the same `createdAt` as the latest, so
  // every location's snapshot lands in `latestRunDetails`.
  const { latestRunIds, latestRunIdsKey, latestVisibilityRevision } = useMemo(() => {
    const completed = projectRuns
      .filter(r =>
        (r.status === 'completed' || r.status === 'partial')
        && r.kind === 'answer-visibility'
        && r.trigger !== 'probe')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const latestCreatedAt = completed[0]?.createdAt ?? null
    const latestIds = latestCreatedAt
      ? completed.filter(r => r.createdAt === latestCreatedAt).map(r => r.id)
      : []
    return {
      latestRunIds: latestIds,
      latestRunIdsKey: [...latestIds].sort().join(','),
      // The trend response depends on the same completed logical sweep as the
      // evidence/dashboard detail. Include both timestamp and sibling ids so a
      // just-completed external sweep changes the analytics query key even
      // when the user has not interacted with the chart.
      latestVisibilityRevision: latestCreatedAt
        ? `${latestCreatedAt}:${[...latestIds].sort().join(',')}`
        : 'none',
    }
  }, [projectRuns])

  const ready = !!project && !!projectName && runsQuery.isSuccess
  // Keep the shared prefix so query publication, identity edits, and run
  // completion invalidate both projections without refetching inactive tabs.
  const overviewQuery = useQuery({
    queryKey: ['project-dashboard-full', project?.id ?? null, latestRunIdsKey || 'none', 'overview'] as const,
    queryFn: async () => ({ project: project!, overview: await fetchProjectOverview(projectName!) }),
    enabled: ready && options.overview === true,
    staleTime: STATIC_VISIBILITY_STALE_MS,
    refetchOnWindowFocus: 'always',
  })
  const evidenceQuery = useQuery({
    queryKey: ['project-dashboard-full', project?.id ?? null, latestRunIdsKey || 'none', 'evidence'] as const,
    queryFn: async () => {
      const [queries, timeline, latestRunDetails] = await Promise.all([
        fetchQueries(projectName!),
        fetchTimeline(projectName!, undefined, DASHBOARD_TIMELINE_RUN_LIMIT),
        Promise.all(latestRunIds.map(id => fetchRunDetail(id))),
      ])
      return { project: project!, queries, timeline, latestRunDetails }
    },
    enabled: ready && options.evidence === true,
    staleTime: STATIC_VISIBILITY_STALE_MS,
    refetchOnWindowFocus: 'always',
  })

  const commandCenter = useMemo<ProjectCommandCenterVm | null>(() => {
    if (!project || !runsQuery.data) return initialCommandCenter
    const evidence = options.evidence ? evidenceQuery.data : undefined
    const data: ProjectData = {
      project,
      runs: projectRuns,
      queries: evidence?.queries ?? [],
      timeline: evidence?.timeline ?? [],
      latestRunDetails: evidence?.latestRunDetails ?? [],
      previousRunDetails: [],
      competitors: [],
      overview: options.overview ? overviewQuery.data?.overview ?? null : null,
    }
    const built = buildProjectCommandCenter(data)
    // Keep injected first-paint metrics while only project metadata refreshes.
    // A settings save must not turn a known baseline into an empty shell.
    if (initialCommandCenter && !(options.overview && overviewQuery.data)) {
      return {
        ...initialCommandCenter,
        project: built.project,
        recentRuns: runsQuery.data ? built.recentRuns : initialCommandCenter.recentRuns,
        visibilityEvidence: evidence ? built.visibilityEvidence : initialCommandCenter.visibilityEvidence,
      }
    }
    return built
  }, [project, projectRuns, evidenceQuery.data, overviewQuery.data, initialCommandCenter, options.evidence, options.overview, runsQuery.data])

  const refetch = useCallback(async () => {
    await Promise.all([
      projectQuery.refetch(),
      runsQuery.refetch(),
      queryClient.invalidateQueries({ queryKey: ['project-dashboard-full', project?.id ?? null] }),
    ])
  }, [projectQuery.refetch, runsQuery.refetch, queryClient, project?.id])

  const isError = projectQuery.isError || runsQuery.isError
  const isLoading = !initialCommandCenter && (projectQuery.isLoading || runsQuery.isLoading)
  const overviewLoading = !!projectName && options.overview === true && !initialCommandCenter && !isError && overviewQuery.isPending
  const evidenceLoading = !!projectName && options.evidence === true && !initialCommandCenter && !isError && evidenceQuery.isPending

  return {
    commandCenter,
    project,
    isLoading,
    isError,
    overviewLoading,
    overviewError: options.overview === true && overviewQuery.isError && !overviewQuery.data,
    evidenceLoading,
    evidenceError: options.evidence === true && evidenceQuery.isError && !evidenceQuery.data,
    latestVisibilityRevision,
    competitorHistoryRevision: competitorEvidenceRevision(projectRuns),
    refetch,
  }
}
