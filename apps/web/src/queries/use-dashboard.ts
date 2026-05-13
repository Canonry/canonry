import { useCallback, useMemo } from 'react'
import { useQuery, useQueries } from '@tanstack/react-query'
import {
  fetchProjects,
  fetchAllRuns,
  fetchSettings,
  fetchQueries,
  fetchCompetitors,
  fetchGscCoverage,
  fetchTimeline,
  fetchRunDetail,
  fetchBingCoverage,
  fetchInsights,
  fetchProjectOverview,
} from '../api.js'
import { buildDashboard } from '../build-dashboard.js'
import type { ProjectData } from '../build-dashboard.js'
import type { DashboardVm } from '../view-models.js'
import { queryKeys } from './query-keys.js'
import { RUNS_STALE_MS, STATIC_VISIBILITY_STALE_MS } from './query-client.js'
import { useInitialDashboard } from '../contexts/dashboard-context.js'

export function useDashboard(initialDashboard?: DashboardVm | null) {
  const contextDashboard = useInitialDashboard()
  const effectiveInitial = initialDashboard ?? contextDashboard?.dashboard ?? null

  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.all,
    queryFn: fetchProjects,
    enabled: !effectiveInitial,
  })

  const runsQuery = useQuery({
    queryKey: queryKeys.runs.all,
    queryFn: fetchAllRuns,
    enabled: !effectiveInitial,
    staleTime: RUNS_STALE_MS,
    refetchInterval: (query) => {
      const runs = query.state.data
      const hasActive = runs?.some(r => r.status === 'running' || r.status === 'queued')
      return hasActive ? 3000 : RUNS_STALE_MS
    },
  })

  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => fetchSettings().catch(() => null),
    enabled: !effectiveInitial,
  })

  const projects = projectsQuery.data ?? []
  const allRuns = runsQuery.data ?? []

  // Per-project detail queries
  const projectDetailQueries = useQueries({
    queries: projects.map((project) => {
      const projectRuns = allRuns.filter(r => r.projectId === project.id)
      const completedRuns = projectRuns
        .filter(r => (r.status === 'completed' || r.status === 'partial') && r.kind === 'answer-visibility')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

      // Multi-location sweeps fan out into one run per location with an identical
      // `createdAt`. Group the top run with any siblings that share its timestamp
      // so all locations land in the latest-run aggregate. Without this, the
      // dashboard collapses to a single non-deterministic location and the other
      // locations' snapshots silently disappear.
      const latestCreatedAt = completedRuns[0]?.createdAt ?? null
      const latestRunGroup = latestCreatedAt
        ? completedRuns.filter(r => r.createdAt === latestCreatedAt)
        : []
      const latestRunIds = latestRunGroup.map(r => r.id)
      const previousCreatedAt = completedRuns.find(r => r.createdAt !== latestCreatedAt)?.createdAt ?? null
      const previousRun = previousCreatedAt
        ? completedRuns.find(r => r.createdAt === previousCreatedAt) ?? null
        : null

      return {
        queryKey: queryKeys.projects.detail(project.id, latestRunIds.join(',') || undefined),
        queryFn: async (): Promise<ProjectData> => {
          const [qs, comps, timeline, latestRunDetails, previousRunDetail, gscCoverage, bingCoverage, dbInsights, overview] = await Promise.all([
            fetchQueries(project.name).catch(() => []),
            fetchCompetitors(project.name).catch(() => []),
            fetchTimeline(project.name).catch(() => []),
            latestRunIds.length
              ? Promise.all(latestRunIds.map(id => fetchRunDetail(id).catch(() => null)))
                  .then(results => results.filter((r): r is NonNullable<typeof r> => r != null))
              : Promise.resolve([]),
            previousRun ? fetchRunDetail(previousRun.id).catch(() => null) : Promise.resolve(null),
            fetchGscCoverage(project.name).catch(() => null),
            fetchBingCoverage(project.name).catch(() => null),
            latestRunIds[0] ? fetchInsights(project.name, latestRunIds[0]).catch(() => null) : Promise.resolve(null),
            fetchProjectOverview(project.name).catch(() => null),
          ])

          return {
            project,
            runs: projectRuns,
            queries: qs,
            competitors: comps,
            timeline,
            latestRunDetails,
            previousRunDetail,
            gscCoverage,
            bingCoverage,
            dbInsights,
            overview,
          }
        },
        enabled: !effectiveInitial && projectsQuery.isSuccess && runsQuery.isSuccess,
        staleTime: STATIC_VISIBILITY_STALE_MS,
      }
    }),
  })

  const allProjectDetailsLoaded = projectDetailQueries.every(q => q.isSuccess)

  const dashboard = useMemo(() => {
    if (effectiveInitial) return effectiveInitial
    if (!projectsQuery.data || !runsQuery.data) return null
    if (projects.length > 0 && !allProjectDetailsLoaded) return null

    // Override `runs` with fresh allRuns. The detail query is keyed by the latest
    // completed run id, so its cached `runs` field misses runs that started after
    // the last completion (queued/running). Polling refreshes runsQuery every 3s
    // while a run is active — projecting it through here lets the dashboard
    // reflect in-progress state without waiting for the detail query to refetch.
    const projectDataList: ProjectData[] = projectDetailQueries
      .map((q) => {
        if (!q.data) return null
        return {
          ...q.data,
          runs: allRuns.filter((r) => r.projectId === q.data!.project.id),
        }
      })
      .filter((d): d is ProjectData => d != null)

    return buildDashboard(projectDataList, settingsQuery.data ?? null)
  }, [effectiveInitial, projectsQuery.data, runsQuery.data, settingsQuery.data, allProjectDetailsLoaded, projectDetailQueries, projects.length, allRuns])

  const isError = !effectiveInitial && (projectsQuery.isError || runsQuery.isError)
  const isLoading = !effectiveInitial && !dashboard && !isError

  const refetch = useCallback(async () => {
    await Promise.all([
      projectsQuery.refetch(),
      runsQuery.refetch(),
      settingsQuery.refetch(),
    ])
  }, [projectsQuery.refetch, runsQuery.refetch, settingsQuery.refetch])

  return {
    dashboard,
    isLoading,
    isError,
    refetch,
  }
}
