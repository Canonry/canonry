import { beforeAll, expect, test } from 'vitest'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'

import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

async function renderRoute(pathname: string): Promise<string> {
  const fixture = createDashboardFixture({})
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: [pathname] })
  await router.load()

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )
}

function classFor(html: string, selector: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const element = doc.querySelector(selector)
  if (!element) {
    const classes = [...doc.querySelectorAll('[class]')]
      .map((candidate) => candidate.getAttribute('class') ?? '')
      .filter((className) => className.includes('page') || className.includes('surface') || className.includes('metric'))
      .slice(0, 80)
      .join('\n')
    throw new Error(`Missing element for selector: ${selector}\nRendered classes:\n${classes}`)
  }
  return element.getAttribute('class') ?? ''
}

test('overview route keeps the dark dashboard class baseline stable', async () => {
  const html = await renderRoute('/')

  expect({
    appShell: classFor(html, '.app-shell'),
    sidebar: classFor(html, '.sidebar'),
    topbar: classFor(html, '.topbar'),
    pageShell: classFor(html, '.page-shell'),
    pageContainer: classFor(html, '.page-container'),
    pageHeader: classFor(html, '.page-header'),
    pageTitle: classFor(html, '.page-title'),
    firstSurface: classFor(html, '.surface-card'),
    firstHealthPill: classFor(html, '.health-pill'),
  }).toMatchInlineSnapshot(`
    {
      "appShell": "app-shell ",
      "firstHealthPill": "health-pill health-pill-ok",
      "firstSurface": "rounded-xl border border-base bg-bg/75 shadow-[0_0_0_1px_var(--color-shadow-hairline)] surface-card compact-card",
      "pageContainer": "page-container",
      "pageHeader": "page-header",
      "pageShell": "page-shell",
      "pageTitle": "page-title",
      "sidebar": "sidebar",
      "topbar": "topbar",
    }
  `)
})

test('project route keeps the core metric and evidence class baseline stable', async () => {
  const html = await renderRoute('/projects/Citypoint%20Dental%20NYC')

  expect({
    pageContainer: classFor(html, '.page-container'),
    pageHeader: classFor(html, '.page-header'),
    pageTitle: classFor(html, '.page-title'),
    firstSectionDivider: classFor(html, '.page-section-divider'),
    firstMetricFill: classFor(html, '.metric-card-bar-fill'),
    evidenceDisclosure: classFor(html, '#evidence-section'),
  }).toMatchInlineSnapshot(`
    {
      "evidenceDisclosure": "overview-disclosure page-section-divider scroll-mt-24",
      "firstMetricFill": "metric-card-bar-fill progress-fill-positive",
      "firstSectionDivider": "page-section-divider",
      "pageContainer": "page-container",
      "pageHeader": "page-header",
      "pageTitle": "page-title",
    }
  `)
})
