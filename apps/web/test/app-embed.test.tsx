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

// White-label de-leak: the read-only embed render hides every write/operator
// control that would 403 on click against the read-only project-scoped key,
// while keeping every read-only view. Not a security boundary (the API key
// scope is) — purely UI cleanliness. See isEmbed() in src/api.ts.
test('embed hides the page-header write cluster (export / delete / run) that leaks on every tab', async () => {
  const embed = await renderAt('/projects/project_citypoint', { enabled: true })
  const operator = await renderAt('/projects/project_citypoint')

  // Operator sees the header action cluster…
  expect(operator).toContain('Export project as YAML')
  expect(operator).toContain('Delete project')
  // …the embed render does not (this cluster renders OUTSIDE the tab switch, so
  // it would otherwise leak on the default overview embed).
  expect(embed).not.toContain('Export project as YAML')
  expect(embed).not.toContain('Delete project')

  // A read-only view still renders in the embed (the project name + a section
  // heading + a metric label), proving we hid controls, not content.
  expect(embed).toContain('Citypoint Dental NYC')
  expect(embed).toContain('Where competitors are winning')
  expect(embed).toContain('Mention share')
})

test('embed hides the overview competitor + query managers and the identity editors', async () => {
  const embed = await renderAt('/projects/project_citypoint', { enabled: true })
  const operator = await renderAt('/projects/project_citypoint')

  // Operator sees the overview write affordances + the alias editor row…
  expect(operator).toContain('+ Add competitor')
  expect(operator).toContain('Manage queries')
  expect(operator).toContain('Also known as')
  // …none of which render in the embed.
  expect(embed).not.toContain('+ Add competitor')
  expect(embed).not.toContain('Manage queries')
  expect(embed).not.toContain('Also known as')
})

// A default embed config (enabled, no `views` allowlist) makes every top-level
// route reachable inside the iframe — `embedViewIdForPath` maps them but the
// unset allowlist permits them all. These admin pages (/runs, /traffic,
// /backlinks) must therefore hide their own operator write controls too, not
// just the project-tab buttons. Same rule: hide the mutating control, keep the
// read-only view.
test('embed hides the operator write controls on the top-level admin pages (default config, no views allowlist)', async () => {
  // /runs — "Run all projects" triggers a sweep across every project.
  const runsEmbed = await renderAt('/runs', { enabled: true })
  const runsOperator = await renderAt('/runs')
  expect(runsOperator).toContain('Run all projects')
  expect(runsEmbed).not.toContain('Run all projects')
  expect(runsEmbed).toContain('Runs') // the read-only page still renders

  // /traffic — "Connect a source" opens the write drawer.
  const trafficEmbed = await renderAt('/traffic', { enabled: true })
  const trafficOperator = await renderAt('/traffic')
  expect(trafficOperator).toContain('Connect a source')
  expect(trafficEmbed).not.toContain('Connect a source')
  expect(trafficEmbed).toContain('Server traffic') // the read-only page still renders

  // /backlinks — "Run sync" downloads + queries a Common Crawl release.
  const backlinksEmbed = await renderAt('/backlinks', { enabled: true })
  const backlinksOperator = await renderAt('/backlinks')
  expect(backlinksOperator).toContain('Run sync')
  expect(backlinksEmbed).not.toContain('Run sync')
  expect(backlinksEmbed).toContain('Backlinks') // the read-only page still renders
})
