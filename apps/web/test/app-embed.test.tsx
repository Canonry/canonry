import { test, expect, beforeAll, afterEach } from 'vitest'

import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'

type EmbedBlock = { enabled: boolean; views?: string[]; theme?: Record<string, string> }

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

// The web suite runs in jsdom, so `window` (with `history`) already exists and
// TanStack Router needs it intact. Only mutate the injected config block —
// never replace or delete `window` itself.
afterEach(() => {
  delete window.__CANONRY_CONFIG__
})

async function renderAt(pathname: string, embed?: EmbedBlock): Promise<string> {
  if (embed) window.__CANONRY_CONFIG__ = { embed }
  else delete window.__CANONRY_CONFIG__

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

test('without embed config the full application chrome renders', async () => {
  const html = await renderAt('/')
  expect(html).toContain('class="sidebar"')
  expect(html).toContain('class="topbar"')
  expect(html).toContain('class="footer"')
  expect(html).toContain('id="mobile-nav"')
  expect(html).not.toContain('app-shell-embed')
})

test('embed mode renders chromeless: no nav / topbar / footer / toaster, only the view', async () => {
  const html = await renderAt('/projects/project_citypoint', { enabled: true })
  expect(html).toContain('app-shell-embed')
  // The requested view still renders through the <Outlet/>.
  expect(html).toContain('Citypoint Dental NYC')
  // All application chrome is suppressed (the embed branch returns before the
  // shell that mounts the nav, topbar, footer, drawers, Toaster and AeroBar).
  expect(html).not.toContain('class="sidebar"')
  expect(html).not.toContain('class="topbar"')
  expect(html).not.toContain('class="footer"')
  expect(html).not.toContain('id="mobile-nav"')
})

test('embed view allowlist blocks a non-allowlisted route (settings is not reachable)', async () => {
  const html = await renderAt('/settings', { enabled: true, views: ['overview'] })
  expect(html).toContain('embed-view-unavailable')
  expect(html).toContain('This view is not available')
  // Still chromeless, and the settings surface is not rendered.
  expect(html).not.toContain('class="sidebar"')
})

test('embed view allowlist permits an allowlisted route', async () => {
  const html = await renderAt('/projects/project_citypoint', { enabled: true, views: ['project'] })
  expect(html).toContain('app-shell-embed')
  expect(html).toContain('Citypoint Dental NYC')
  expect(html).not.toContain('embed-view-unavailable')
})

test('embed theme applies allowlisted CSS custom properties to the shell', async () => {
  const html = await renderAt('/projects/project_citypoint', {
    enabled: true,
    theme: { bg: '#00aaff' },
  })
  expect(html).toContain('--canonry-embed-bg:#00aaff')
})
