import { test, expect, beforeAll, afterEach } from 'vitest'

import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { getApiV1ProjectsByNameMeasurementPlanQueryKey } from '@ainyc/canonry-api-client/react-query'
import { heyClient } from '../src/api.js'
import { projectScheduleQueryOptions } from '../src/queries/schedule-query.js'

type EmbedBlock = { enabled: boolean; views?: string[]; theme?: Record<string, string> }
type DashboardBlock = { showResourceLinks?: boolean; showUpdateNotification?: boolean; showAgentBar?: boolean }

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

// The web suite runs in jsdom, so `window` (with `history`) already exists and
// TanStack Router needs it intact. Only mutate the injected config block —
// never replace or delete `window` itself.
afterEach(() => {
  delete window.__CANONRY_CONFIG__
})

async function renderAt(
  pathname: string,
  embed?: EmbedBlock,
  dashboard?: DashboardBlock,
  withUpdateNotification = false,
): Promise<string> {
  if (embed || dashboard) {
    window.__CANONRY_CONFIG__ = {
      ...(embed ? { embed } : {}),
      ...(dashboard ? { dashboard } : {}),
    }
  } else {
    delete window.__CANONRY_CONFIG__
  }

  const fixture = createDashboardFixture({})
  if (withUpdateNotification) {
    fixture.health.apiStatus.updateAvailable = {
      current: '4.139.0',
      latest: '4.139.1',
      url: 'https://www.npmjs.com/package/@canonry/canonry',
      upgradeCommand: 'npm install -g @canonry/canonry',
    }
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // One synchronous render pass, so no query settles. Seed the "no advanced
  // plan" answer these embed assertions describe, or the overview paints its
  // loading skeleton instead of the surface under test.
  for (const entry of fixture.dashboard.projects) {
    queryClient.setQueryData(
      getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path: { name: entry.project.name } }),
      { active: null },
    )
    // Resolve the schedule too: the header's operator action must be present
    // before an embed assertion can prove that it is hidden.
    queryClient.setQueryData(projectScheduleQueryOptions(entry.project.name).queryKey, null)
  }
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

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

function detailsForTitle(doc: Document, title: string): HTMLDetailsElement | null {
  return [...doc.querySelectorAll<HTMLDetailsElement>('details.overview-disclosure')]
    .find((details) => details.querySelector('.overview-disclosure-title')?.textContent === title) ?? null
}

test('without embed config the full application chrome renders', async () => {
  const html = await renderAt('/')
  expect(html).toContain('class="sidebar"')
  expect(html).toContain('class="sidebar-footer"')
  expect(html).toContain('class="footer-links"')
  expect(html).toContain('aria-label="GitHub"')
  expect(html).toContain('aria-label="Docs"')
  expect(html).toContain('aria-label="Changelog"')
  expect(html).toContain('class="topbar"')
  expect(html).toContain('class="footer"')
  expect(html).toContain('id="mobile-nav"')
  expect(html).not.toContain('app-shell-embed')
})

test('dashboard resource-link opt-out removes the sidebar and footer icon clusters', async () => {
  const html = await renderAt('/', undefined, { showResourceLinks: false })
  expect(html).toContain('class="sidebar"')
  expect(html).toContain('class="footer"')
  expect(html).toContain('class="footer-brand"')
  expect(html).not.toContain('class="sidebar-footer"')
  expect(html).not.toContain('class="footer-links"')
  expect(html).not.toContain('aria-label="GitHub"')
  expect(html).not.toContain('aria-label="Docs"')
  expect(html).not.toContain('aria-label="Changelog"')
})

test('dashboard update-notification opt-out removes the version badge without disabling the static version', async () => {
  const visible = await renderAt('/', undefined, undefined, true)
  const hidden = await renderAt('/', undefined, { showUpdateNotification: false }, true)

  expect(visible).toContain('New version v4.139.1 available')
  expect(visible).toContain('brand-update-bubble')
  expect(hidden).not.toContain('New version v4.139.1 available')
  expect(hidden).not.toContain('brand-update-bubble')
  expect(hidden).toContain('vphase-1')
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
test('embed hides page-header schedule management while keeping measured content', async () => {
  const embed = await renderAt('/projects/project_citypoint', { enabled: true })
  const operator = await renderAt('/projects/project_citypoint')

  // The header offers schedule management, never a one-click full sweep.
  // Pin the real operator control so the embed assertion cannot pass vacuously.
  const scheduleLink = 'a[aria-label="Create AI visibility sweep schedule"]'
  expect(parseHtml(operator).querySelector(scheduleLink)).not.toBeNull()
  expect(parseHtml(embed).querySelector(scheduleLink)).toBeNull()
  expect(operator).not.toContain('Run AI sweep')
  expect(embed).not.toContain('Run AI sweep')
  // Delete is absent from BOTH headers now, so its absence in the embed is no
  // longer evidence of anything — assert it left the header instead.
  expect(operator).not.toContain('Delete project')

  // A read-only view still renders in the embed (the project name + a section
  // heading + a metric label), proving we hid controls, not content.
  expect(embed).toContain('Citypoint Dental NYC')
  expect(embed).toContain('Where competitors are winning')
  expect(embed).toContain('Mention share')
})

test('embed hides the overview competitor manager', async () => {
  const embed = await renderAt('/projects/project_citypoint', { enabled: true })
  const operator = await renderAt('/projects/project_citypoint')

  // Operator sees the overview write affordances. Identity editing now lives
  // in project Settings instead of the overview header.
  expect(operator).toContain('+ Add competitor')
  expect(operator).not.toContain('+ add domain')
  expect(operator).not.toContain('Also known as')
  // The write affordances do not render in the embed.
  expect(embed).not.toContain('+ Add competitor')

  // The locale tag-row (US/EN pills) duplicates the "· US/EN" subtitle, so the
  // embed drops it while the operator keeps it. The locale still shows once in
  // the subtitle, so no information is lost.
  const embedDoc = parseHtml(embed)
  const operatorDoc = parseHtml(operator)
  expect(operatorDoc.querySelector('.page-header .tag-row')).not.toBeNull()
  expect(embedDoc.querySelector('.page-header .tag-row')).toBeNull()
})

test('embed defaults client-value overview disclosures open and omits run history', async () => {
  const embedDoc = parseHtml(await renderAt('/projects/project_citypoint', { enabled: true, views: ['project'] }))
  const operatorDoc = parseHtml(await renderAt('/projects/project_citypoint'))

  expect(detailsForTitle(operatorDoc, 'Query evidence')?.hasAttribute('open')).toBe(false)
  expect(detailsForTitle(operatorDoc, 'Citation and engine diagnostics')?.hasAttribute('open')).toBe(false)
  expect(detailsForTitle(operatorDoc, 'Recent execution history')).not.toBeNull()

  expect(detailsForTitle(embedDoc, 'Query evidence')?.hasAttribute('open')).toBe(true)
  expect(detailsForTitle(embedDoc, 'Citation and engine diagnostics')?.hasAttribute('open')).toBe(true)
  expect(detailsForTitle(embedDoc, 'Recent execution history')).toBeNull()
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
  expect(trafficEmbed).toContain('Traffic sources') // the read-only page still renders

  // /backlinks — "Run sync" downloads + queries a Common Crawl release.
  const backlinksEmbed = await renderAt('/backlinks', { enabled: true })
  const backlinksOperator = await renderAt('/backlinks')
  expect(backlinksOperator).toContain('Run sync')
  expect(backlinksEmbed).not.toContain('Run sync')
  expect(backlinksEmbed).toContain('Backlink data') // the read-only page still renders
})
