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
        .filter(r =>
          (r.status === 'completed' || r.status === 'partial')
          && r.kind === 'answer-visibility'
          // Probe runs are operator/agent test runs — they write a
          // snapshot for inspection but must never displace a real sweep
          // on the dashboard. /runs (the operator-facing list endpoint)
          // intentionally includes probes, so the dashboard has to filter
          // them out client-side.
          && r.trigger !== 'probe')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

      // Multi-location sweeps fan out into one run per location with an identical
      // `createdAt`. Group the top run with any siblings that share its timestamp
      // so all locations land in the latest-run aggregate. Without this, the
      // dashboard collapses to a single non-deterministic location and the other
      // locations' snapshots silently disappear.
      const latestCreatedAt = completedRuns[0]?.createdAt ?? null
      const latestRunIds = latestCreatedAt
        ? completedRuns.filter(r => r.createdAt === latestCreatedAt).map(r => r.id)
        : []
      // Mirror the fan-out grouping for the previous batch so snapshot-diff
      // and any other consumer of "previous run" sees every location, not
      // just the first one we happen to encounter.
      const previousBatchCreatedAt = completedRuns.find(r => r.createdAt !== latestCreatedAt)?.createdAt ?? null
      const previousRunIds = previousBatchCreatedAt
        ? completedRuns.filter(r => r.createdAt === previousBatchCreatedAt).map(r => r.id)
        : []
      // Sort IDs so the query key stays stable regardless of upstream ordering
      // (`GET /runs` has no ORDER BY, so SQLite can return rows in any order).
      const latestRunIdsKey = [...latestRunIds].sort().join(',')

      return {
        queryKey: queryKeys.projects.detail(project.id, latestRunIdsKey || undefined),
        queryFn: async (): Promise<ProjectData> => {
          const [qs, comps, timeline, latestRunDetails, previousRunDetails, gscCoverage, bingCoverage, dbInsights, overview] = await Promise.all([
            fetchQueries(project.name).catch(() => []),
            fetchCompetitors(project.name).catch(() => []),
            fetchTimeline(project.name).catch(() => []),
            latestRunIds.length
              ? Promise.all(latestRunIds.map(id => fetchRunDetail(id).catch(() => null)))
                  .then(results => results.filter((r): r is NonNullable<typeof r> => r != null))
              : Promise.resolve([]),
            previousRunIds.length
              ? Promise.all(previousRunIds.map(id => fetchRunDetail(id).catch(() => null)))
                  .then(results => results.filter((r): r is NonNullable<typeof r> => r != null))
              : Promise.resolve([]),
            fetchGscCoverage(project.name).catch(() => null),
            fetchBingCoverage(project.name).catch(() => null),
            // Project-wide insights — per-run filtering would miss the other
            // locations' runs when an answer-visibility sweep fans out.
            fetchInsights(project.name).catch(() => null),
            fetchProjectOverview(project.name).catch(() => null),
          ])

          return {
            project,
            runs: projectRuns,
            queries: qs,
            competitors: comps,
            timeline,
            latestRunDetails,
            previousRunDetails,
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
