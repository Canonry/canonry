import { test, expect, beforeAll, afterEach } from 'vitest'

import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import type { VisibilityReportResponse } from '@ainyc/canonry-contracts'
import { visibilityReportResponseSchema } from '@ainyc/canonry-contracts'

import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { parseVisibilitySelection } from '../src/lib/measurement-view-url.js'
import type { VisibilitySelectionState } from '../src/lib/measurement-view-url.js'
import {
  getApiV1ProjectsByNameMeasurementPlanQueryKey,
  getApiV1ProjectsByNameVisibilityReportQueryKey,
} from '@ainyc/canonry-api-client/react-query'
import { heyClient } from '../src/api.js'

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
  const url = new URL(pathname, 'http://localhost')
  const selection = parseVisibilitySelection(Object.fromEntries(url.searchParams.entries()))
  // One synchronous render pass, so no query settles. Embed hides the advanced
  // setup reads; seed its shared, read-only visibility report rather than the
  // retired dashboard composites so assertions exercise actual overview content.
  for (const entry of fixture.dashboard.projects) {
    queryClient.setQueryData(
      getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path: { name: entry.project.name } }),
      { active: null },
    )
    queryClient.setQueryData(
      getApiV1ProjectsByNameVisibilityReportQueryKey(visibilityReportQuery(entry.project.name, selection)),
      visibilityReportResponse(selection),
    )
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

function visibilityReportQuery(projectName: string, selection: VisibilitySelectionState) {
  return {
    client: heyClient,
    path: { name: projectName },
    query: {
      scope: selection.measurementScope,
      scopeKey: selection.measurementScopeKey,
      queryClass: selection.queryClass,
      provider: selection.provider,
      model: selection.model,
      location: selection.location,
      from: selection.from,
      to: selection.to,
      revision: selection.revision,
      runId: selection.measurementRunId,
      queryKey: selection.queryKey,
      limit: 50,
      cursor: undefined,
      search: undefined,
    },
  }
}

function visibilityReportResponse(selection: VisibilitySelectionState): VisibilityReportResponse {
  const scopeKind = selection.measurementScope
  const scopeId = scopeKind === 'project' ? 'project' : selection.measurementScopeKey ?? `${scopeKind}-synthetic`
  const scopeLabel = scopeKind === 'project' ? 'Whole site' : 'North'
  const rate = { numerator: 1, denominator: 1, rate: 1 }
  const classes = selection.queryClass === 'all'
    ? ['branded', 'non-brand', 'unknown'] as const
    : [selection.queryClass]

  return visibilityReportResponseSchema.parse({
    selection: {
      mode: 'simple',
      queryClass: selection.queryClass,
      scope: { id: scopeId, label: scopeLabel, kind: scopeKind, targetCount: 1 },
      provider: null,
      model: null,
      location: { kind: 'all' },
      time: { from: null, to: null },
      revision: null,
      run: { id: 'run-embed-synthetic', explicit: false },
      provenance: { kind: 'frozen-simple', definitionRevision: null },
      measurement: {
        state: 'measured',
        activeRevision: null,
        measuredRevision: null,
        awaitingSweep: false,
        pendingAssignmentCount: 0,
        completedAt: '2026-09-04T12:05:00.000Z',
      },
      availability: { state: 'available' },
    },
    scopeOptions: [{ id: scopeId, label: scopeLabel, kind: scopeKind, targetCount: 1 }],
    filterOptions: {
      providers: ['openai'],
      models: [{ provider: 'openai', model: 'search-model' }],
      locations: [{ kind: 'all' }],
    },
    populations: classes.map(queryClass => ({
      queryClass,
      summary: {
        queryCount: 1,
        answerCount: 1,
        mentionCoverage: rate,
        citationCoverage: rate,
        propertyReach: rate,
        outcomes: { bothSignals: 1, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 0, total: 1 },
      },
      trend: [{
        runId: 'run-embed-synthetic',
        createdAt: '2026-09-04T12:05:00.000Z',
        revision: null,
        provenance: { kind: 'frozen-simple', definitionRevision: null },
        queryCount: 1,
        answerCount: 1,
        mentionCoverage: rate,
        citationCoverage: rate,
        continuity: { state: 'first', comparedRunId: null },
      }],
      queries: {
        items: [{
          queryKey: 'embed-query',
          queryId: 'query-embed',
          query: 'emergency dentist near me',
          provider: 'openai',
          model: 'search-model',
          location: null,
          targetKeys: ['citypoint'],
          answerCount: 1,
          mentionCoverage: rate,
          citationCoverage: rate,
        }],
        nextCursor: null,
        total: 1,
      },
      evidence: { items: [], nextCursor: null, total: 0 },
      competitorAvailability: { state: 'available' },
      competitors: [],
      observedCompetitors: [],
      breakdown: {
        properties: [{ id: 'citypoint', label: 'Citypoint Dental NYC', queryCount: 1, mentionCoverage: rate, citationCoverage: rate }],
        groups: [],
      },
    })),
  })
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
test('embed hides the page-header run action that leaks on every tab', async () => {
  const embed = await renderAt('/projects/project_citypoint', { enabled: true })
  const operator = await renderAt('/projects/project_citypoint')

  // Operator sees the header action… (the YAML-export button was removed in
  // favor of the Settings-tab results downloads + `canonry export`. Deleting
  // the project is no longer here at all — it moved to the end of the Settings
  // tab, away from the button next to it.)
  expect(operator).toContain('AI sweep')
  // …the embed render does not (this renders OUTSIDE the tab switch, so it
  // would otherwise leak on the default overview embed).
  expect(embed).not.toContain('AI sweep')
  // Delete is absent from BOTH headers now, so its absence in the embed is no
  // longer evidence of anything — assert it left the header instead.
  expect(operator).not.toContain('Delete project')

  // A read-only report still renders in the embed, proving we hid controls,
  // not content.
  expect(embed).toContain('Citypoint Dental NYC')
  expect(embed).toContain('AI visibility results')
  expect(embed).toContain('Non-brand queries')
  expect(embed).toContain('Query performance')
  expect(embed).toContain('emergency dentist near me')
})

test('embed hides the shared-report query manager without reviving retired overview managers', async () => {
  const embed = await renderAt('/projects/project_citypoint', { enabled: true })
  const operator = await renderAt('/projects/project_citypoint')

  // Query administration stays an operator control even though the report is
  // otherwise readable in both surfaces. Competitor editing is no longer part
  // of the overview report, so do not accidentally restore the retired control.
  expect(operator).toContain('Manage queries')
  expect(embed).not.toContain('Manage queries')
  expect(operator).not.toContain('+ Add competitor')
  expect(embed).not.toContain('+ Add competitor')
  expect(embed).toContain('Query performance')
  expect(embed).toContain('View answers')
  expect(embed).toContain('Competitors')

  // The locale tag-row (US/EN pills) duplicates the "· US/EN" subtitle, so the
  // embed drops it while the operator keeps it. The locale still shows once in
  // the subtitle, so no information is lost.
  const embedDoc = parseHtml(embed)
  const operatorDoc = parseHtml(operator)
  expect(operatorDoc.querySelector('.page-header .tag-row')).not.toBeNull()
  expect(embedDoc.querySelector('.page-header .tag-row')).toBeNull()
})

test('embed keeps shared report drill-down readable without restoring legacy overview disclosures', async () => {
  const embedDoc = parseHtml(await renderAt('/projects/project_citypoint', { enabled: true, views: ['project'] }))
  const operatorDoc = parseHtml(await renderAt('/projects/project_citypoint'))

  // The shared report has its own measured-run disclosure and progressive
  // query/competitor drill-down. The old overview disclosures must not shadow
  // it in either operator or embed renders.
  expect([...operatorDoc.querySelectorAll('details summary')].some(summary => summary.textContent === 'Date, model and measured run')).toBe(true)
  expect([...embedDoc.querySelectorAll('details summary')].some(summary => summary.textContent === 'Date, model and measured run')).toBe(true)
  expect(operatorDoc.body.textContent).toContain('Query performance')
  expect(embedDoc.body.textContent).toContain('Query performance')
  expect(operatorDoc.body.textContent).toContain('Competitors')
  expect(embedDoc.body.textContent).toContain('Competitors')

  expect(detailsForTitle(operatorDoc, 'Query evidence')).toBeNull()
  expect(detailsForTitle(operatorDoc, 'Citation and engine diagnostics')).toBeNull()
  expect(detailsForTitle(operatorDoc, 'Recent execution history')).toBeNull()
  expect(detailsForTitle(embedDoc, 'Query evidence')).toBeNull()
  expect(detailsForTitle(embedDoc, 'Citation and engine diagnostics')).toBeNull()
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
