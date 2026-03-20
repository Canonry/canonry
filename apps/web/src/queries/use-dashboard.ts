import { useCallback, useMemo } from 'react'
import { useQuery, useQueries } from '@tanstack/react-query'
import {
  fetchProjects,
  fetchAllRuns,
  fetchSettings,
  fetchKeywords,
  fetchCompetitors,
  fetchTimeline,
  fetchRunDetail,
} from '../api.js'
import { buildDashboard } from '../build-dashboard.js'
import type { ProjectData } from '../build-dashboard.js'
import type { DashboardVm } from '../view-models.js'
import { queryKeys } from './query-keys.js'
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
    refetchInterval: (query) => {
      const runs = query.state.data
      const hasActive = runs?.some(r => r.status === 'running' || r.status === 'queued')
      return hasActive ? 3000 : false
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

      return {
        queryKey: queryKeys.projects.detail(project.id, completedRuns[0]?.id),
        queryFn: async (): Promise<ProjectData> => {
          const [kws, comps, timeline, latestRunDetail, previousRunDetail] = await Promise.all([
            fetchKeywords(project.name).catch(() => []),
            fetchCompetitors(project.name).catch(() => []),
            fetchTimeline(project.name).catch(() => []),
            completedRuns[0] ? fetchRunDetail(completedRuns[0].id).catch(() => null) : Promise.resolve(null),
            completedRuns[1] ? fetchRunDetail(completedRuns[1].id).catch(() => null) : Promise.resolve(null),
          ])

          return {
            project,
            runs: projectRuns,
            keywords: kws,
            competitors: comps,
            timeline,
            latestRunDetail,
            previousRunDetail,
          }
        },
        enabled: !effectiveInitial && projectsQuery.isSuccess && runsQuery.isSuccess,
      }
    }),
  })

  const allProjectDetailsLoaded = projectDetailQueries.every(q => q.isSuccess)

  const dashboard = useMemo(() => {
    if (effectiveInitial) return effectiveInitial
    if (!projectsQuery.data || !runsQuery.data) return null
    if (projects.length > 0 && !allProjectDetailsLoaded) return null

    const projectDataList: ProjectData[] = projectDetailQueries
      .map(q => q.data)
      .filter((d): d is ProjectData => d != null)

    return buildDashboard(projectDataList, settingsQuery.data ?? null)
  }, [effectiveInitial, projectsQuery.data, runsQuery.data, settingsQuery.data, allProjectDetailsLoaded, projectDetailQueries, projects.length])

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
