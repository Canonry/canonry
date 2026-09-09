import { useCallback, useMemo } from 'react'
import { useQuery, useQueries } from '@tanstack/react-query'
import {
  fetchProjectOverview,
  heyClient,
} from '../api.js'
import {
  getApiV1ProjectsOptions,
  getApiV1RunsOptions,
  getApiV1SettingsOptions,
} from '@ainyc/canonry-api-client/react-query'
import { buildDashboard } from '../build-dashboard.js'
import type { ProjectData } from '../build-dashboard.js'
import type { DashboardVm } from '../view-models.js'
import { PROJECTS_REFRESH_IDLE_MS, PROJECTS_REFRESH_MS, RUNS_STALE_MS, STATIC_VISIBILITY_STALE_MS } from './query-client.js'
import { useAccount } from '../contexts/account-context.js'
import { useInitialDashboard } from '../contexts/dashboard-context.js'

/**
 * Portfolio pages load one summary per project. The application shell opts
 * out with `includeOverviews: false` and builds navigation from project/run
 * metadata, using cached summaries when available. Project tabs own their
 * analytics and answer evidence through `useProjectDashboard`.
 *
 * Overview attention items come from the server summary; this hook does not
 * fetch answer bodies or derive evidence-based alerts in the browser.
 */
interface DashboardOverviewOptions {
  includeSettings?: boolean
  /** Keep project/run metadata available without starting per-project `/overview` reads. */
  includeOverviews?: boolean
  /** Setup owns project creation and invalidates this query explicitly. */
  pauseProjectPolling?: boolean
}

export function useDashboardOverview(initialDashboard?: DashboardVm | null, options: DashboardOverviewOptions = {}) {
  const contextDashboard = useInitialDashboard()
  const effectiveInitial = initialDashboard ?? contextDashboard?.dashboard ?? null
  const includeSettings = options.includeSettings ?? true
  const includeOverviews = options.includeOverviews ?? true
  const pauseProjectPolling = options.pauseProjectPolling ?? false
  const { isAdmin } = useAccount()

  // Scope to answer-visibility so integration syncs don't fill the 500-row
  // server cap and starve the dashboard of sweep runs (see PR #590).
  const runsQuery = useQuery({
    ...getApiV1RunsOptions({ client: heyClient, query: { kind: 'answer-visibility' } }),
    enabled: !effectiveInitial,
    staleTime: RUNS_STALE_MS,
    refetchInterval: (query) => {
      const runs = query.state.data
      const hasActive = runs?.some(r => r.status === 'running' || r.status === 'queued')
      return hasActive ? 3000 : RUNS_STALE_MS
    },
  })

  const projectsQuery = useQuery({
    ...getApiV1ProjectsOptions({ client: heyClient }),
    enabled: !effectiveInitial,
    refetchInterval: pauseProjectPolling ? false : (query) => {
      const data = query.state.data as unknown[] | undefined
      // Fast poll only when setup needs it (zero projects) or a sweep is active;
      // otherwise idle at 30s — cuts 30 req/min → ~2 req/min per tab.
      const hasActive = (runsQuery.data as { status: string }[] | undefined)?.some(
        r => r.status === 'running' || r.status === 'queued',
      )
      const needsFast = (data?.length ?? 0) === 0 || !!hasActive
      return needsFast ? PROJECTS_REFRESH_MS : PROJECTS_REFRESH_IDLE_MS
    },
  })

  // Instance settings carry provider credentials, so the server refuses that
  // read to a view-only account. Skipping it here — rather than at each of the
  // four call sites — keeps a viewer's dashboard free of a request that was
  // always going to come back refused. `buildDashboard` already accepts a null
  // settings (the embed path does the same), so the dashboard still renders.
  const settingsQuery = useQuery({
    ...getApiV1SettingsOptions({ client: heyClient }),
    enabled: !effectiveInitial && includeSettings && isAdmin,
  })

  const projects = projectsQuery.data ?? []
  const allRuns = runsQuery.data ?? []

  // Optional summaries are shared with portfolio-page consumers. Disabled
  // shell observers can use their cached results without starting requests.
  const projectOverviewQueries = useQueries({
    queries: projects.map((project) => {
      const projectRuns = allRuns.filter(r => r.projectId === project.id)
      // Use the latest run id as a cache-bust key so the overview refetches
      // after a sweep completes. Mirrors the pattern in `useDashboard`.
      const completedRuns = projectRuns
        .filter(r =>
          (r.status === 'completed' || r.status === 'partial')
          && r.kind === 'answer-visibility'
          && r.trigger !== 'probe')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      const cacheBustKey = completedRuns.length > 0 ? completedRuns[0]!.id : 'no-run'

      return {
        queryKey: ['project-overview-slim', project.id, cacheBustKey] as const,
        queryFn: async (): Promise<ProjectData> => {
          const overview = await fetchProjectOverview(project.name).catch(() => null)
          return {
            project,
            runs: projectRuns,
            queries: [],
            competitors: [],
            timeline: [],
            latestRunDetails: [],
            previousRunDetails: [],
            gscCoverage: null,
            bingCoverage: null,
            dbInsights: null,
            overview,
          }
        },
        enabled: !effectiveInitial && includeOverviews && projectsQuery.isSuccess && runsQuery.isSuccess,
        staleTime: STATIC_VISIBILITY_STALE_MS,
      }
    }),
  })

  const allProjectOverviewsLoaded = !includeOverviews || projectOverviewQueries.every(q => q.isSuccess)

  const dashboard = useMemo(() => {
    if (effectiveInitial) return effectiveInitial
    if (!projectsQuery.data || !runsQuery.data) return null
    if (projects.length > 0 && !allProjectOverviewsLoaded) return null

    const projectDataList: ProjectData[] = includeOverviews
      ? projectOverviewQueries
        .map((q) => {
          if (!q.data) return null
          // Re-project runs through the fresh allRuns array so in-progress
          // sweeps (queued / running, started after the overview was cached)
          // surface in the run badges. Same pattern as `useDashboard`.
          return {
            ...q.data,
            runs: allRuns.filter((r) => r.projectId === q.data!.project.id),
          }
        })
        .filter((d): d is ProjectData => d != null)
      : projects.map((project, index) => {
        const cached = projectOverviewQueries[index]?.data
        return {
          project,
          runs: allRuns.filter((r) => r.projectId === project.id),
          queries: [],
          competitors: [],
          timeline: [],
          latestRunDetails: [],
          previousRunDetails: [],
          gscCoverage: null,
          bingCoverage: null,
          dbInsights: null,
          overview: cached?.overview ?? null,
        }
      })

    return buildDashboard(projectDataList, settingsQuery.data ?? null)
  }, [effectiveInitial, projectsQuery.data, runsQuery.data, settingsQuery.data, includeOverviews, allProjectOverviewsLoaded, projectOverviewQueries, projects, allRuns])

  const isError = !effectiveInitial && (projectsQuery.isError || runsQuery.isError)
  const isLoading = !effectiveInitial && !dashboard && !isError

  const refetch = useCallback(async () => {
    const queries: Array<Promise<unknown>> = [
      projectsQuery.refetch(),
      runsQuery.refetch(),
      ...(includeOverviews ? projectOverviewQueries.map(query => query.refetch()) : []),
    ]
    if (includeSettings) {
      queries.push(settingsQuery.refetch())
    }
    await Promise.all(queries)
  }, [
    includeSettings,
    includeOverviews,
    projectOverviewQueries,
    projectsQuery.refetch,
    runsQuery.refetch,
    settingsQuery.refetch,
  ])

  return {
    dashboard,
    isLoading,
    isError,
    refetch,
  }
}
