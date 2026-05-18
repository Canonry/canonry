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
import { PROJECTS_REFRESH_MS, RUNS_STALE_MS, STATIC_VISIBILITY_STALE_MS } from './query-client.js'
import { useInitialDashboard } from '../contexts/dashboard-context.js'

/**
 * Slim dashboard hook for the portfolio surface (overview, projects list,
 * runs, setup, settings, sidebar). Fetches the absolute minimum needed to
 * render multi-project widgets: one `/overview` per project instead of the
 * 9-endpoint fan-out the project page needs.
 *
 * Replaces `useDashboard` for every consumer except ProjectPage, which
 * needs the heavy fan-out (timeline, latestRunDetails, GSC/Bing coverage,
 * DB insights) to render evidence tables and the full command center.
 *
 * The per-project queryFn populates only the `overview` field on
 * `ProjectData`. `buildDashboard` already tolerates the rest being empty —
 * the resulting `ProjectCommandCenterVm` has empty `visibilityEvidence`
 * (the timeline-derived table that only ProjectPage renders), but
 * `mentionSummary`, `recentRuns`, `competitors`, `providerScores`, and
 * everything else the overview surfaces are populated from `/overview`
 * alone.
 *
 * Cost comparison on a 5-project portfolio:
 *   - `useDashboard`         → 1 + 1 + 1 + (9 × 5)  = 48 requests on cold load
 *   - `useDashboardOverview` → 1 + 1 + 1 + (1 × 5)  =  8 requests on cold load
 *
 * Side effect: client-side attention items derived from `visibilityEvidence`
 * (lost-citation alerts) won't fire on the overview because evidence is
 * empty. Server-side `overview.attentionItems` (the canonical source per
 * AGENTS.md "no UI-only calculations") continues to surface every real
 * signal. The duplicated client derivation in `buildAttentionItems` is
 * tracked for removal in a follow-up.
 */
export function useDashboardOverview(initialDashboard?: DashboardVm | null) {
  const contextDashboard = useInitialDashboard()
  const effectiveInitial = initialDashboard ?? contextDashboard?.dashboard ?? null

  const projectsQuery = useQuery({
    ...getApiV1ProjectsOptions({ client: heyClient }),
    enabled: !effectiveInitial,
    refetchInterval: PROJECTS_REFRESH_MS,
  })

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

  const settingsQuery = useQuery({
    ...getApiV1SettingsOptions({ client: heyClient }),
    enabled: !effectiveInitial,
  })

  const projects = projectsQuery.data ?? []
  const allRuns = runsQuery.data ?? []

  // Per-project: ONLY /overview. The other 8 endpoints `useDashboard`
  // fetches (timeline, queries, competitors, latestRunDetails × N,
  // previousRunDetails × N, gscCoverage, bingCoverage, dbInsights) are
  // only consumed by ProjectPage and live in `useProjectDashboard`.
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
        enabled: !effectiveInitial && projectsQuery.isSuccess && runsQuery.isSuccess,
        staleTime: STATIC_VISIBILITY_STALE_MS,
      }
    }),
  })

  const allProjectOverviewsLoaded = projectOverviewQueries.every(q => q.isSuccess)

  const dashboard = useMemo(() => {
    if (effectiveInitial) return effectiveInitial
    if (!projectsQuery.data || !runsQuery.data) return null
    if (projects.length > 0 && !allProjectOverviewsLoaded) return null

    const projectDataList: ProjectData[] = projectOverviewQueries
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

    return buildDashboard(projectDataList, settingsQuery.data ?? null)
  }, [effectiveInitial, projectsQuery.data, runsQuery.data, settingsQuery.data, allProjectOverviewsLoaded, projectOverviewQueries, projects.length, allRuns])

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
