import { createRootRouteWithContext, createRoute, lazyRouteComponent, redirect, Outlet } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'

import { RootLayout } from '../App.js'
import { ErrorBoundary } from '../components/layout/ErrorBoundary.js'
// Home + ancillary routes stay eager: OverviewPage is what users land on,
// ProjectsPage is the next-most-common navigation, SetupPage is the
// first-run flow, NotFoundPage is tiny. Everything else (ProjectPage and
// friends) is dynamically imported via `lazyRouteComponent` so the
// home-page initial bundle drops from ~934KB to whatever OverviewPage
// actually needs (~618KB after this change).
import { OverviewPage } from '../pages/OverviewPage.js'
import { ProjectsPage } from '../pages/ProjectsPage.js'
import { OnboardingSetupPage } from '../pages/OnboardingSetupPage.js'
import { NotFoundPage } from '../pages/NotFoundPage.js'
import { heyClient } from '../api.js'
import { getApiV1ProjectsQueryKey, getApiV1ProjectsOptions } from '@ainyc/canonry-api-client/react-query'

// `lazyRouteComponent` (not React.lazy) handles route-level code splitting
// in TanStack Router. The key advantage over `React.lazy` + `Suspense` is
// that `router.load()` awaits the dynamic import as part of route loading,
// so the page component is fully resolved by the time React renders. That
// makes the lazy boundary invisible to `renderToStaticMarkup` (used in
// `apps/web/test/app.test.tsx`) — no Suspense fallback ever shows in
// SSR-style renders. Each `lazyRouteComponent(() => import('…'))` becomes
// its own Rollup chunk.
const LazyProjectPage = lazyRouteComponent(() => import('../pages/ProjectPage.js'), 'ProjectPage')
const LazyRunsPage = lazyRouteComponent(() => import('../pages/RunsPage.js'), 'RunsPage')
const LazyHistoryPage = lazyRouteComponent(() => import('../pages/HistoryPage.js'), 'HistoryPage')
const LazySettingsPage = lazyRouteComponent(() => import('../pages/SettingsPage.js'), 'SettingsPage')
const LazyBacklinksPage = lazyRouteComponent(() => import('../pages/BacklinksPage.js'), 'BacklinksPage')
const LazyTrafficPage = lazyRouteComponent(() => import('../pages/TrafficPage.js'), 'TrafficPage')
const LazyTrafficSourceDetailPage = lazyRouteComponent(() => import('../pages/TrafficSourceDetailPage.js'), 'TrafficSourceDetailPage')
const LazyMeasurementPropertyPage = lazyRouteComponent(() => import('../pages/MeasurementPropertyPage.js'), 'MeasurementPropertyPage')

/**
 * Resolve every lazy-loaded route component up front. Tests that render
 * via `renderToStaticMarkup` (`apps/web/test/app.test.tsx`) can't suspend
 * — without preloading, the page <main> renders empty. Each lazy
 * component exposes a `.preload()` method (TanStack Router's
 * `lazyRouteComponent` wraps the dynamic import in a preloadable closure);
 * awaiting them all before render means the component is synchronously
 * available when React reaches the route boundary.
 *
 * Also useful in production if we ever wire hover-to-prefetch on nav
 * links — same mechanism.
 */
export async function preloadAllLazyRoutes(): Promise<void> {
  // `.preload` is typed optional on `AsyncRouteComponent` even though
  // `lazyRouteComponent` always assigns it. Optional-chain to satisfy
  // TypeScript; `Promise.all` ignores undefined values.
  await Promise.all([
    LazyProjectPage.preload?.(),
    LazyRunsPage.preload?.(),
    LazyHistoryPage.preload?.(),
    LazySettingsPage.preload?.(),
    LazyBacklinksPage.preload?.(),
    LazyTrafficPage.preload?.(),
    LazyTrafficSourceDetailPage.preload?.(),
    LazyMeasurementPropertyPage.preload?.(),
  ])
}

export interface RouterContext {
  queryClient: QueryClient
}

type SearchParams = {
  /** Legacy handoff, redirected to the stable Queries workspace by ProjectPage. */
  manageQueries?: boolean
  /** The stable, URL-backed surface within the project Queries workspace. */
  queries?: 'tracked' | 'discover' | 'test'
  runId?: string
  /** Exact Site Health onboarding handoff; separate from the global run drawer. */
  siteHealthRunId?: string
  /** One-time handoff from the project header into the AI sweep editor. */
  schedule?: 'edit'
  evidenceId?: string
  runStatus?: string
  runKind?: string
  runProject?: string
  runWindow?: string
  runQuery?: string
  /** First-open Site Health handoff state; a durable run remains the authority. */
  onboarding?: 'site-health'
  /** Temporary rescue hatch while the platform launchpad rolls out. */
  experience?: 'legacy'
  /** Exact project handed from Site Health into the original visibility wizard. */
  setupProject?: string
  /**
   * Advanced-measurement view state, in the URL so a market is a place you can
   * link, bookmark, and reload. `all` (the default) is omitted rather than
   * written, so the common case leaves a clean URL.
   *   scope=group:<stableKey> | scope=all
   *   class=all | non-brand | branded
   */
  scope?: string
  class?: string
}

function RootLayoutWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <RootLayout />
    </ErrorBoundary>
  )
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayoutWithErrorBoundary,
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    manageQueries: search.manageQueries === true || search.manageQueries === 'true' ? true : undefined,
    queries: search.queries === 'tracked' || search.queries === 'discover' || search.queries === 'test'
      ? search.queries
      : undefined,
    runId: typeof search.runId === 'string' ? search.runId : undefined,
    siteHealthRunId: typeof search.siteHealthRunId === 'string' ? search.siteHealthRunId : undefined,
    schedule: search.schedule === 'edit' ? 'edit' : undefined,
    evidenceId: typeof search.evidenceId === 'string' ? search.evidenceId : undefined,
    runStatus: typeof search.runStatus === 'string' ? search.runStatus : undefined,
    runKind: typeof search.runKind === 'string' ? search.runKind : undefined,
    runProject: typeof search.runProject === 'string' ? search.runProject : undefined,
    runWindow: typeof search.runWindow === 'string' ? search.runWindow : undefined,
    runQuery: typeof search.runQuery === 'string' ? search.runQuery : undefined,
    onboarding: search.onboarding === 'site-health' ? 'site-health' : undefined,
    experience: search.experience === 'legacy' ? 'legacy' : undefined,
    setupProject: typeof search.setupProject === 'string' ? search.setupProject : undefined,
    scope: typeof search.scope === 'string' ? search.scope : undefined,
    class: typeof search.class === 'string' ? search.class : undefined,
  }),
})

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: OverviewPage,
  beforeLoad: async ({ context }) => {
    let projects = context.queryClient.getQueryData(
      getApiV1ProjectsQueryKey({ client: heyClient }),
    ) as unknown[] | undefined

    // A blank cache is not an empty installation. On a cold direct visit,
    // resolve the canonical list once before choosing first-run setup. A
    // network/auth failure deliberately stays on the portfolio route, whose
    // error shell offers retry instead of pretending there are no projects.
    if (projects === undefined) {
      try {
        projects = await context.queryClient.ensureQueryData(
          getApiV1ProjectsOptions({ client: heyClient }),
        )
      } catch {
        return
      }
    }

    if (projects.length === 0) {
      throw redirect({ to: '/setup' })
    }
  },
})

export const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  component: ProjectsPage,
})

// Project URLs key off the human-readable project name (a kebab-case slug),
// not the opaque UUID — `/projects/acme-co/report` instead of
// `/projects/<uuid>/report`. The API already resolves projects by name, so
// the name is the canonical identifier across the whole surface.
const PROJECT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Layout route for project tabs — renders Outlet to pass through to sub-routes
export const projectLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectName',
  component: () => <Outlet />,
  // Legacy compatibility: project URLs used to carry the UUID. When an old
  // UUID-shaped segment arrives (e.g. a stale bookmark), resolve it to the
  // current name and redirect to the clean URL, preserving the tab sub-path.
  // Name-shaped segments skip the lookup entirely — zero overhead on the
  // common path.
  beforeLoad: async ({ context, params, location }) => {
    const segment = params.projectName
    if (!PROJECT_UUID_RE.test(segment)) return
    // Read the already-loaded projects list synchronously (the sidebar /
    // overview populate it); only fetch if it's genuinely absent.
    let projects = context.queryClient.getQueryData(
      getApiV1ProjectsQueryKey({ client: heyClient }),
    ) as Array<{ id: string; name: string }> | undefined
    if (!projects) {
      try {
        projects = await context.queryClient.ensureQueryData(getApiV1ProjectsOptions({ client: heyClient }))
      } catch {
        // Best-effort: if the list can't be resolved (auth/network), don't
        // block navigation — ProjectPage resolves the id itself or shows
        // its not-found state.
        return
      }
    }
    const match = projects.find((p) => p.id === segment)
    if (!match) return
    throw redirect({
      to: location.pathname.replace(
        `/projects/${segment}`,
        `/projects/${encodeURIComponent(match.name)}`,
      ),
      replace: true,
    })
  },
})

export const projectOverviewRoute = createRoute({
  getParentRoute: () => projectLayoutRoute,
  path: '/',
  component: () => <LazyProjectPage tab="overview" />,
})

export const projectPortfolioRoute = createRoute({
  getParentRoute: () => projectLayoutRoute,
  path: '/portfolio',
  component: () => <LazyProjectPage tab="portfolio" />,
})

export const projectSearchConsoleRoute = createRoute({
  getParentRoute: () => projectLayoutRoute,
  path: '/search-console',
  component: () => <LazyProjectPage tab="search-console" />,
})

export const projectConversionsRoute = createRoute({
  getParentRoute: () => projectLayoutRoute,
  path: '/conversions',
  component: () => <LazyProjectPage tab="conversions" />,
})

export const projectLocalRoute = createRoute({
  getParentRoute: () => projectLayoutRoute,
  path: '/local',
  component: () => <LazyProjectPage tab="local" />,
})

export const projectDiscoveryRoute = createRoute({
  getParentRoute: () => projectLayoutRoute,
  path: '/discovery',
  component: () => <LazyProjectPage tab="discovery" />,
})

// One Property has its own page rather than an inline row expansion: it is a
// destination an operator links to and comes back to, and the row cannot hold
// the class comparison, the per-engine split, and paged evidence at once.
export const projectMeasurementPropertyRoute = createRoute({
  getParentRoute: () => projectLayoutRoute,
  path: '/properties/$targetKey',
  component: () => <LazyMeasurementPropertyPage />,
})

export const projectReportRoute = createRoute({
  getParentRoute: () => projectLayoutRoute,
  path: '/report',
  component: () => <LazyProjectPage tab="report" />,
})

export const projectActivityRoute = createRoute({
  getParentRoute: () => projectLayoutRoute,
  path: '/activity',
  component: () => <LazyProjectPage tab="activity" />,
})

export const projectBacklinksRoute = createRoute({
  getParentRoute: () => projectLayoutRoute,
  path: '/backlinks',
  component: () => <LazyProjectPage tab="backlinks" />,
})

export const projectTechnicalAeoRoute = createRoute({
  getParentRoute: () => projectLayoutRoute,
  path: '/technical-aeo',
  component: () => <LazyProjectPage tab="technical-aeo" />,
})

export const projectHistoryRoute = createRoute({
  getParentRoute: () => projectLayoutRoute,
  path: '/history',
  component: () => <LazyProjectPage tab="history" />,
})

export const projectSettingsRoute = createRoute({
  getParentRoute: () => projectLayoutRoute,
  path: '/settings',
  component: () => <LazyProjectPage tab="settings" />,
})

export const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runs',
  component: LazyRunsPage,
})

export const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/history',
  component: LazyHistoryPage,
})

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: LazySettingsPage,
  beforeLoad: ({ context }) => {
    void context // unused but available
  },
})

export const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  component: OnboardingSetupPage,
})

export const backlinksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/backlinks',
  component: LazyBacklinksPage,
})

export const trafficRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/traffic',
  component: LazyTrafficPage,
})

export const trafficSourceDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/traffic/$projectName/$sourceId',
  component: LazyTrafficSourceDetailPage,
})

export const notFoundRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '*',
  component: NotFoundPage,
})

export const routeTree = rootRoute.addChildren([
  indexRoute,
  projectsRoute,
  projectLayoutRoute.addChildren([
    projectOverviewRoute,
    projectPortfolioRoute,
    projectSearchConsoleRoute,
    projectConversionsRoute,
    projectLocalRoute,
    projectDiscoveryRoute,
    projectMeasurementPropertyRoute,
    projectReportRoute,
    projectActivityRoute,
    projectBacklinksRoute,
    projectTechnicalAeoRoute,
    projectHistoryRoute,
    projectSettingsRoute,
  ]),
  runsRoute,
  historyRoute,
  settingsRoute,
  setupRoute,
  backlinksRoute,
  trafficRoute,
  trafficSourceDetailRoute,
  notFoundRoute,
])
