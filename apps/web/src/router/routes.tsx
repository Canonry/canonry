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
import { SetupPage } from '../pages/SetupPage.js'
import { NotFoundPage } from '../pages/NotFoundPage.js'
import { heyClient } from '../api.js'
import { getApiV1ProjectsQueryKey } from '@ainyc/canonry-api-client/react-query'

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
const LazySettingsPage = lazyRouteComponent(() => import('../pages/SettingsPage.js'), 'SettingsPage')
const LazyBacklinksPage = lazyRouteComponent(() => import('../pages/BacklinksPage.js'), 'BacklinksPage')
const LazyTrafficPage = lazyRouteComponent(() => import('../pages/TrafficPage.js'), 'TrafficPage')
const LazyTrafficSourceDetailPage = lazyRouteComponent(() => import('../pages/TrafficSourceDetailPage.js'), 'TrafficSourceDetailPage')

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
    LazySettingsPage.preload?.(),
    LazyBacklinksPage.preload?.(),
    LazyTrafficPage.preload?.(),
    LazyTrafficSourceDetailPage.preload?.(),
  ])
}

export interface RouterContext {
  queryClient: QueryClient
}

type SearchParams = {
  runId?: string
  evidenceId?: string
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
    runId: typeof search.runId === 'string' ? search.runId : undefined,
    evidenceId: typeof search.evidenceId === 'string' ? search.evidenceId : undefined,
  }),
})

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: OverviewPage,
  beforeLoad: ({ context }) => {
    const projects = context.queryClient.getQueryData(getApiV1ProjectsQueryKey({ client: heyClient })) as unknown[] | undefined
    if (projects && projects.length === 0) {
      throw redirect({ to: '/setup' })
    }
  },
})

export const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  component: ProjectsPage,
})

// Layout route for project tabs — renders Outlet to pass through to sub-routes
export const projectLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  component: () => <Outlet />,
})

export const projectOverviewRoute = createRoute({
  getParentRoute: () => projectLayoutRoute,
  path: '/',
  component: () => <LazyProjectPage tab="overview" />,
})

export const projectSearchConsoleRoute = createRoute({
  getParentRoute: () => projectLayoutRoute,
  path: '/search-console',
  component: () => <LazyProjectPage tab="search-console" />,
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
  component: SetupPage,
  beforeLoad: ({ context }) => {
    const projects = context.queryClient.getQueryData(getApiV1ProjectsQueryKey({ client: heyClient })) as unknown[] | undefined
    if (projects && projects.length > 0) {
      throw redirect({ to: '/' })
    }
  },
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
    projectSearchConsoleRoute,
    projectLocalRoute,
    projectDiscoveryRoute,
    projectReportRoute,
    projectActivityRoute,
    projectBacklinksRoute,
    projectSettingsRoute,
  ]),
  runsRoute,
  settingsRoute,
  setupRoute,
  backlinksRoute,
  trafficRoute,
  trafficSourceDetailRoute,
  notFoundRoute,
])
