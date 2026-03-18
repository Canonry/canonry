import { useMemo } from 'react'
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

export function useDashboard(initialDashboard?: DashboardVm | null) {
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.all,
    queryFn: fetchProjects,
    enabled: !initialDashboard,
  })

  const runsQuery = useQuery({
    queryKey: queryKeys.runs.all,
    queryFn: fetchAllRuns,
    enabled: !initialDashboard,
    refetchInterval: (query) => {
      const runs = query.state.data
      const hasActive = runs?.some(r => r.status === 'running' || r.status === 'queued')
      return hasActive ? 3000 : false
    },
  })

  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => fetchSettings().catch(() => null),
    enabled: !initialDashboard,
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
        queryKey: queryKeys.projects.detail(project.id),
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
        enabled: !initialDashboard && projectsQuery.isSuccess && runsQuery.isSuccess,
      }
    }),
  })

  const allProjectDetailsLoaded = projectDetailQueries.every(q => q.isSuccess)

  const dashboard = useMemo(() => {
    if (initialDashboard) return initialDashboard
    if (!projectsQuery.data || !runsQuery.data) return null
    if (projects.length > 0 && !allProjectDetailsLoaded) return null

    const projectDataList: ProjectData[] = projectDetailQueries
      .map(q => q.data)
      .filter((d): d is ProjectData => d != null)

    return buildDashboard(projectDataList, settingsQuery.data ?? null)
  }, [initialDashboard, projectsQuery.data, runsQuery.data, settingsQuery.data, allProjectDetailsLoaded, projectDetailQueries, projects.length])

  const isLoading = !initialDashboard && (projectsQuery.isLoading || runsQuery.isLoading)
  const isError = !initialDashboard && (projectsQuery.isError && runsQuery.isError)

  return {
    dashboard,
    isLoading,
    isError,
    refetch: async () => {
      await Promise.all([
        projectsQuery.refetch(),
        runsQuery.refetch(),
        settingsQuery.refetch(),
      ])
    },
  }
}
