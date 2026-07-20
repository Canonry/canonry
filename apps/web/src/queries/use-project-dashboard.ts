import { useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  fetchQueries,
  fetchCompetitors,
  fetchGscCoverage,
  fetchTimeline,
  fetchRunDetail,
  fetchBingCoverage,
  fetchInsights,
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

const DASHBOARD_TIMELINE_RUN_LIMIT = 20

/**
 * Heavy dashboard hook scoped to a single project. Fetches everything
 * `ProjectPage` needs to render the full command center: project metadata,
 * runs, timeline, latest + previous run details (for evidence + diffs),
 * GSC / Bing coverage, DB-backed insights, and the server overview
 * composite.
 *
 * Pairs with `useDashboardOverview`, which is the slim portfolio-shaped
 * counterpart used by every other page. The split fixes the per-project
 * fan-out tax that `useDashboard` paid on every dashboard mount across
 * all projects regardless of which one the user navigated to.
 *
 * Cost: 9 endpoints for the requested project only — never fans out
 * across other projects.
 */
export function useProjectDashboard(projectName: string | null | undefined) {
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

  // The three project-page queries below all override the global
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
  const { latestRunIds, previousRunIds, latestRunIdsKey, latestVisibilityRevision } = useMemo(() => {
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
    const previousCreatedAt = completed.find(r => r.createdAt !== latestCreatedAt)?.createdAt ?? null
    const previousIds = previousCreatedAt
      ? completed.filter(r => r.createdAt === previousCreatedAt).map(r => r.id)
      : []
    return {
      latestRunIds: latestIds,
      previousRunIds: previousIds,
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

  const detailQuery = useQuery({
    queryKey: ['project-dashboard-full', project?.id ?? null, latestRunIdsKey || 'none'] as const,
    queryFn: async (): Promise<ProjectData | null> => {
      if (!project || !projectName) return null
      const [qs, comps, timeline, latestRunDetails, previousRunDetails, gscCoverage, bingCoverage, dbInsights, overview] = await Promise.all([
        fetchQueries(projectName).catch(() => []),
        fetchCompetitors(projectName).catch(() => []),
        fetchTimeline(projectName, undefined, DASHBOARD_TIMELINE_RUN_LIMIT).catch(() => []),
        latestRunIds.length
          ? Promise.all(latestRunIds.map(id => fetchRunDetail(id).catch(() => null)))
              .then(results => results.filter((r): r is NonNullable<typeof r> => r != null))
          : Promise.resolve([]),
        previousRunIds.length
          ? Promise.all(previousRunIds.map(id => fetchRunDetail(id).catch(() => null)))
              .then(results => results.filter((r): r is NonNullable<typeof r> => r != null))
          : Promise.resolve([]),
        fetchGscCoverage(projectName).catch(() => null),
        fetchBingCoverage(projectName).catch(() => null),
        fetchInsights(projectName).catch(() => null),
        fetchProjectOverview(projectName).catch(() => null),
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
    enabled: !!project && !!projectName && runsQuery.isSuccess,
    staleTime: STATIC_VISIBILITY_STALE_MS,
    refetchOnWindowFocus: 'always',
    // This is a nine-endpoint fan-out, including evidence snapshots and
    // integration summaries. Refetch on focus and when the latest run id
    // changes; do not poll the full historical payload on a timer.
  })

  const commandCenter = useMemo<ProjectCommandCenterVm | null>(() => {
    if (detailQuery.data) {
      // Re-project runs through the fresh runsQuery so queued/running runs
      // that started after the detail query cached still surface in badges.
      return buildProjectCommandCenter({
        ...detailQuery.data,
        runs: projectRuns,
      })
    }
    // SSR / test fallback (see initialCommandCenter rationale above).
    if (initialCommandCenter) return initialCommandCenter
    return null
  }, [detailQuery.data, projectRuns, initialCommandCenter])

  const refetch = useCallback(async () => {
    await Promise.all([
      projectQuery.refetch(),
      runsQuery.refetch(),
      detailQuery.refetch(),
    ])
  }, [projectQuery.refetch, runsQuery.refetch, detailQuery.refetch])

  // Once we have a renderable commandCenter — from either the live query
  // or the SSR fixture — stop reporting `isLoading`. Background refetches
  // (runs polling, etc.) shouldn't put the page back into the loading
  // skeleton state.
  const isLoading = !commandCenter
    && (projectQuery.isLoading || runsQuery.isLoading || detailQuery.isLoading)

  return {
    commandCenter,
    project,
    isLoading,
    isError: projectQuery.isError || runsQuery.isError || detailQuery.isError,
    latestVisibilityRevision,
    refetch,
  }
}
