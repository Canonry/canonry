import { createRootRouteWithContext, createRoute, redirect, Outlet } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'

import { RootLayout } from '../App.js'
import { ErrorBoundary } from '../components/layout/ErrorBoundary.js'
import { OverviewPage } from '../pages/OverviewPage.js'
import { ProjectsPage } from '../pages/ProjectsPage.js'
import { ProjectPage } from '../pages/ProjectPage.js'
import { RunsPage } from '../pages/RunsPage.js'
import { SettingsPage } from '../pages/SettingsPage.js'
import { SetupPage } from '../pages/SetupPage.js'
import { BacklinksPage } from '../pages/BacklinksPage.js'
import { TrafficPage } from '../pages/TrafficPage.js'
import { TrafficSourceDetailPage } from '../pages/TrafficSourceDetailPage.js'
import { NotFoundPage } from '../pages/NotFoundPage.js'
import { queryKeys } from '../queries/query-keys.js'

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
    const projects = context.queryClient.getQueryData(queryKeys.projects.all) as unknown[] | undefined
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
  component: () => <ProjectPage tab="overview" />,
})

export const projectSearchConsoleRoute = createRoute({
  getParentRoute: () => projectLayoutRoute,
  path: '/search-console',
  component: () => <ProjectPage tab="search-console" />,
})

export const projectDiscoveryRoute = createRoute({
  getParentRoute: () => projectLayoutRoute,
  path: '/discovery',
  component: () => <ProjectPage tab="discovery" />,
})

export const projectReportRoute = createRoute({
  getParentRoute: () => projectLayoutRoute,
  path: '/report',
  component: () => <ProjectPage tab="report" />,
})

export const projectActivityRoute = createRoute({
  getParentRoute: () => projectLayoutRoute,
  path: '/activity',
  component: () => <ProjectPage tab="activity" />,
})

export const projectBacklinksRoute = createRoute({
  getParentRoute: () => projectLayoutRoute,
  path: '/backlinks',
  component: () => <ProjectPage tab="backlinks" />,
})

export const projectSettingsRoute = createRoute({
  getParentRoute: () => projectLayoutRoute,
  path: '/settings',
  component: () => <ProjectPage tab="settings" />,
})

export const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runs',
  component: RunsPage,
})

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
  beforeLoad: ({ context }) => {
    void context // unused but available
  },
})

export const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  component: SetupPage,
  beforeLoad: ({ context }) => {
    const projects = context.queryClient.getQueryData(queryKeys.projects.all) as unknown[] | undefined
    if (projects && projects.length > 0) {
      throw redirect({ to: '/' })
    }
  },
})

export const backlinksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/backlinks',
  component: BacklinksPage,
})

export const trafficRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/traffic',
  component: TrafficPage,
})

export const trafficSourceDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/traffic/$projectName/$sourceId',
  component: TrafficSourceDetailPage,
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
