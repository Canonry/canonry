import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { within } from '@testing-library/react'
import { afterEach, beforeAll, expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import type { ProjectDto } from '@canonry/canonry-contracts'
import {
  getApiV1ProjectsByNameMeasurementPlanQueryKey,
  getApiV1ProjectsByNameSchedulesQueryKey,
  getApiV1ProjectsQueryKey,
} from '@canonry/canonry-api-client/react-query'

import { heyClient } from '../src/api.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { createDashboardFixture } from '../src/mock-data.js'
import type { ProjectPageTab } from '../src/pages/ProjectPage.js'
import { createAppRouter } from '../src/router/router.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'

type Dashboard = ReturnType<typeof createDashboardFixture>['dashboard']

beforeAll(async () => {
  await preloadAllLazyRoutes()
}, 60_000)

afterEach(() => {
  delete window.__CANONRY_CONFIG__
})

const PROJECT_PAGE_TABS = [
  'overview', 'portfolio', 'search-console', 'seo-data', 'journeys', 'conversions', 'local', 'queries', 'client-queries', 'discovery',
  'activity', 'traffic', 'backlinks', 'agent-readiness', 'history', 'settings',
] as const satisfies readonly ProjectPageTab[]

const CONTEXT_TITLE_CLASS = 'project-context-title md:sr-only'

function project(dashboard: Dashboard, id: string): ProjectDto {
  return dashboard.projects.find(entry => entry.project.id === id)!.project
}

/** Display names that differ from the stored names prove which field the chrome reads. */
function withDisplayNames(dashboard: Dashboard) {
  project(dashboard, 'project_citypoint').displayName = 'Citypoint Dental'
  const harbor = project(dashboard, 'project_harbor')
  harbor.name = 'harbor-legal'
  harbor.displayName = 'Harbor Legal Group'
}

function visibilitySchedule(overrides: { timezone?: string } = {}) {
  return {
    id: 'schedule-visibility',
    projectId: 'project_citypoint',
    kind: 'answer-visibility' as const,
    cronExpr: '30 22 * * *',
    preset: 'daily',
    timezone: 'America/New_York',
    enabled: true,
    providers: [],
    nextRunAt: '2026-09-23T02:30:00.000Z',
    lastRunAt: '2026-09-22T02:30:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

function advancedPlan() {
  return {
    active: {
      revision: 2,
      checksum: 'a'.repeat(64),
      createdAt: '2026-08-01T12:00:00.000Z',
      plan: {
        schemaVersion: 2 as const,
        identities: {
          projectBrand: { canonicalHost: 'citypointdental.com', ownedHosts: ['citypointdental.com'], names: ['Citypoint'] },
        },
        targets: [{
          stableKey: 'midtown',
          label: 'Midtown',
          aliases: ['Midtown'],
          urlMatchers: [{ kind: 'prefix' as const, host: 'citypointdental.com', pathPrefix: '/midtown', pathCase: 'insensitive' as const }],
          mentionNotApplicable: false,
          discoveryIdentity: 'sitemap:midtown',
        }],
        groups: [{ stableKey: 'north', label: 'North', targetKeys: ['midtown'], competitors: [] }],
        querySnapshots: [{
          queryId: 'query-midtown',
          queryText: 'dentist in midtown',
          provenance: { source: 'manual' as const, sourceId: null, capturedAt: '2026-08-01T12:00:00.000Z' },
        }],
        assignments: [{ targetKey: 'midtown', queryId: 'query-midtown', queryClass: 'non-brand' as const, executionNodeKey: 'node-midtown' }],
        executionNodes: [{
          stableKey: 'node-midtown',
          queryId: 'query-midtown',
          queryText: 'dentist in midtown',
          context: { providers: ['openai' as const], models: { openai: 'search-model' }, location: null },
          expectedSnapshots: 1,
        }],
        usageEdges: [{ executionNodeKey: 'node-midtown', targetKey: 'midtown', queryId: 'query-midtown' }],
        compiledChecksum: 'b'.repeat(64),
      },
    },
  }
}

async function renderAt(pathname: string, options: {
  embed?: boolean
  demo?: boolean
  configureFixture?: (dashboard: Dashboard) => void
  plan?: ReturnType<typeof advancedPlan>
  schedule?: ReturnType<typeof visibilitySchedule>
  seedProjectList?: boolean
} = {}) {
  if (options.embed) window.__CANONRY_CONFIG__ = { embed: { enabled: true } }
  else if (options.demo) window.__CANONRY_CONFIG__ = { demo: { enabled: true, readOnly: true, sampleData: true } }
  else delete window.__CANONRY_CONFIG__

  const fixture = createDashboardFixture({})
  options.configureFixture?.(fixture.dashboard)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // One synchronous render pass, so no query settles. Seed each read an
  // assertion depends on under the exact key the page requests.
  for (const { project: entry } of fixture.dashboard.projects) {
    const path = { name: entry.name }
    queryClient.setQueryData(
      getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path }),
      options.plan ?? { active: null },
    )
    if (options.schedule) {
      queryClient.setQueryData(getApiV1ProjectsByNameSchedulesQueryKey({ client: heyClient, path }), [options.schedule])
    }
  }
  if (options.seedProjectList) {
    queryClient.setQueryData(getApiV1ProjectsQueryKey({ client: heyClient }), fixture.dashboard.projects.map(entry => entry.project))
  }
  const router = createAppRouter(queryClient, { initialEntries: [pathname] })
  await router.load()

  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>,
  )
  return { doc: new DOMParser().parseFromString(html, 'text/html'), router }
}

function breadcrumbCurrent(doc: Document): string[] {
  return [...doc.querySelectorAll('.breadcrumb-current')].map(crumb => crumb.textContent ?? '')
}

function contextRowParts(doc: Document): Array<string | null> | null {
  const row = doc.querySelector('.project-context-row')
  return row ? [...row.children].map(child => child.getAttribute('class')) : null
}

function nextSweepLabels(doc: Document): string[] {
  return [...doc.querySelectorAll('p')]
    .map(paragraph => paragraph.textContent ?? '')
    .filter(text => text.startsWith('Next AI Visibility check'))
}

function settingsRow(doc: Document, label: string): HTMLTableRowElement | null {
  return [...doc.querySelectorAll('tr')].find(row => row.firstElementChild?.textContent === label) ?? null
}

// ── Breadcrumb ──

test.each([
  { label: 'a name URL', path: '/projects/harbor-legal', crumb: 'Harbor Legal Group' },
  { label: 'an id URL resolved by the route resolver', path: '/projects/project_harbor', crumb: 'Harbor Legal Group' },
  { label: 'a percent-encoded name URL', path: '/projects/Citypoint%20Dental%20NYC/activity', crumb: 'Citypoint Dental' },
])('the breadcrumb names the project by displayName for $label', async ({ path, crumb }) => {
  const { doc } = await renderAt(path, { configureFixture: withDisplayNames })
  expect(breadcrumbCurrent(doc)).toEqual([crumb])
})

test('the breadcrumb names the project by displayName after a legacy UUID URL redirects', async () => {
  const uuid = '11111111-2222-4333-8444-555555555555'
  const { doc, router } = await renderAt(`/projects/${uuid}/activity`, {
    seedProjectList: true,
    configureFixture(dashboard) {
      const citypoint = project(dashboard, 'project_citypoint')
      citypoint.id = uuid
      citypoint.name = 'acme-co'
      citypoint.displayName = 'Acme Co'
    },
  })
  expect(router.state.location.pathname).toBe('/projects/acme-co/activity')
  expect(breadcrumbCurrent(doc)).toEqual(['Acme Co'])
})

test('the breadcrumb falls back to the project name, then to the decoded URL segment', async () => {
  const named = await renderAt('/projects/Citypoint%20Dental%20NYC')
  expect(breadcrumbCurrent(named.doc)).toEqual(['Citypoint Dental NYC'])

  const unresolved = await renderAt('/projects/not%20tracked%20yet')
  expect(breadcrumbCurrent(unresolved.doc)).toEqual(['not tracked yet'])
})

// ── Headings ──

test('the heading matrix covers every ProjectPageTab', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../src/pages/ProjectPage.tsx'), 'utf8')
  const union = source.match(/export type ProjectPageTab = ([^\n]+)/)?.[1] ?? ''
  const declared = [...union.matchAll(/'([^']+)'/g)].map(match => match[1])
  expect(declared.sort()).toEqual([...PROJECT_PAGE_TABS].sort())
})

test.each(PROJECT_PAGE_TABS)('the operator %s tab renders exactly one h1', async tab => {
  const path = tab === 'overview' ? '/projects/project_citypoint' : `/projects/project_citypoint/${tab}`
  const { doc } = await renderAt(path, { configureFixture: withDisplayNames })

  const headings = [...doc.querySelectorAll('h1')]
  expect(headings.map(heading => heading.textContent)).toEqual(['Citypoint Dental'])
  expect(headings[0]!.getAttribute('class')).toBe(CONTEXT_TITLE_CLASS)
  expect(headings[0]!.closest('.project-context-row')).not.toBeNull()
  expect(doc.querySelector('.project-context-row .project-context-domain')?.textContent).toBe('citypointdental.com')
})

// ── Context row structure (Simple and Advanced) ──

const RANGE_QUERY = '?measurementFrom=2026-09-01T00:00:00.000Z&measurementTo=2026-09-08T23:59:59.999Z'

test.each([
  {
    // No range label: the Simple overview's cards read different windows.
    label: 'Simple overview',
    path: '/projects/project_citypoint',
    advanced: false,
    parts: [CONTEXT_TITLE_CLASS, 'project-context-domain'],
    meta: null,
  },
  {
    label: 'Simple Agent Readiness',
    path: '/projects/project_citypoint/agent-readiness',
    advanced: false,
    parts: [CONTEXT_TITLE_CLASS, 'project-context-domain'],
    meta: null,
  },
  {
    label: 'Advanced overview without an explicit range',
    path: '/projects/project_citypoint',
    advanced: true,
    // The v2 overview's measurement scope slot sits between identity and domain.
    parts: [CONTEXT_TITLE_CLASS, 'project-context-scope', 'project-context-domain'],
    meta: null,
  },
  {
    // The explicit range is a filter token in the results toolbar
    // (portfolio-route.test.tsx), so the row renders no meta element.
    label: 'Advanced overview with an explicit range',
    path: `/projects/project_citypoint${RANGE_QUERY}`,
    advanced: true,
    parts: [CONTEXT_TITLE_CLASS, 'project-context-scope', 'project-context-domain'],
    meta: null,
  },
])('the $label context row orders project identity and scope', async ({ path, advanced, parts, meta }) => {
  const { doc } = await renderAt(path, advanced ? { plan: advancedPlan() } : {})
  expect(contextRowParts(doc)).toEqual(parts)
  expect(doc.querySelector('.project-context-meta')?.textContent ?? null).toBe(meta)
})

test.each([
  { stored: 'https://www.CitypointDental.com/', shown: 'https://www.CitypointDental.com/' },
  { stored: '', shown: null },
])('the context row shows the canonical domain exactly as stored ("$stored")', async ({ stored, shown }) => {
  const { doc } = await renderAt('/projects/project_citypoint/activity', {
    configureFixture(dashboard) {
      project(dashboard, 'project_citypoint').canonicalDomain = stored
    },
  })
  expect(doc.querySelector('.project-context-row')).not.toBeNull()
  expect(doc.querySelector('.project-context-domain')?.textContent ?? null).toBe(shown)
})

// ── Advanced tag (public demo only) ──

function modeTag(doc: Document): string | null {
  const tag = doc.querySelector('.project-context-row .project-mode-tag')
  return tag ? [...tag.children].map(part => part.textContent).join('|') : null
}

test.each(PROJECT_PAGE_TABS)('the public demo tags an advanced project on the %s tab', async tab => {
  const path = tab === 'overview' ? '/projects/project_citypoint' : `/projects/project_citypoint/${tab}`
  const { doc } = await renderAt(path, { demo: true, plan: advancedPlan() })
  expect(modeTag(doc)).toBe('Advanced|1 property · 1 market')
})

test('the public demo renders no tag for a project without an advanced setup', async () => {
  const overview = await renderAt('/projects/project_citypoint', { demo: true })
  expect(modeTag(overview.doc)).toBeNull()
  const activity = await renderAt('/projects/project_citypoint/activity', { demo: true })
  expect(modeTag(activity.doc)).toBeNull()
})

test('outside the public demo an advanced project renders no tag', async () => {
  for (const path of ['/projects/project_citypoint', '/projects/project_citypoint/activity']) {
    const { doc } = await renderAt(path, { plan: advancedPlan() })
    expect(modeTag(doc)).toBeNull()
  }
})

// ── Embed ──

test('an embed keeps its page header, with no Simple date range and no project context row', async () => {
  const { doc } = await renderAt('/projects/project_citypoint', { embed: true })

  expect(doc.querySelector('.project-context-row')).toBeNull()
  expect(doc.querySelector('[data-project-actions]')).toBeNull()
  expect(doc.querySelectorAll('h1')).toHaveLength(1)
  expect(doc.querySelector('.page-header')?.outerHTML).toBe(
    '<div class="page-header"><div class="page-header-left">'
    + '<h1 class="page-title">Citypoint Dental NYC</h1>'
    + '<p class="page-subtitle">citypointdental.com · US / English / Local-intent monitoring</p>'
    + '</div><div class="page-header-right"></div></div>',
  )
})

// ── Section tabs ──

test('the project tabs lead with AI Visibility and end with Queries, in sentence case', async () => {
  const { doc } = await renderAt('/projects/project_citypoint')
  const tabs = [...doc.querySelectorAll('.project-subnav .project-subnav-link')]
    .filter(link => !link.closest('.project-subnav-measure'))
    .map(link => link.textContent)
  expect(tabs).toEqual(['AI Visibility', 'Search engines', 'SEO', 'Activity', 'Agent Readiness', 'Journeys', 'Server traffic', 'Queries', 'More'])
})

// ── AI Visibility checks ──

const VISIBILITY_CHECK_ACTION = /^(Starting…|AI Visibility check running…|Checking AI engines…|Retry engine check|Set up AI Visibility|Review and publish plan|AI Visibility checks on hold|Run AI Visibility check)$/

function renderedRoles(doc: Document) {
  const container = document.createElement('div')
  container.innerHTML = doc.body.innerHTML
  return within(container)
}

test.each(['Simple', 'Advanced'])('the %s project offers the check only below the AI Visibility tab', async mode => {
  const options = { ...(mode === 'Advanced' ? { plan: advancedPlan() } : {}), schedule: visibilitySchedule() }
  const { doc } = await renderAt('/projects/project_citypoint', options)
  const page = renderedRoles(doc)
  const tabs = page.getByRole('navigation', { name: 'Project sections' })
  expect(within(tabs).getByRole('link', { name: 'AI Visibility', current: 'page' })).toBeTruthy()
  const checks = page.getByRole('group', { name: 'AI Visibility checks' })
  expect(checks.contains(page.getByRole('button', { name: VISIBILITY_CHECK_ACTION }))).toBe(true)
  expect(tabs.compareDocumentPosition(checks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

  for (const suffix of ['/search-console', '/seo-data', '/activity', '/queries', '/portfolio', '/settings']) {
    const { doc: other } = await renderAt(`/projects/project_citypoint${suffix}`, options)
    const otherPage = renderedRoles(other)
    expect(otherPage.getByRole('navigation', { name: 'Project sections' })).toBeTruthy()
    expect(otherPage.queryByRole('group', { name: 'AI Visibility checks' })).toBeNull()
    expect(otherPage.queryByRole('button', { name: VISIBILITY_CHECK_ACTION })).toBeNull()
    expect(nextSweepLabels(other)).toEqual([])
  }
})

test('Agent Readiness keeps its own scan action when an AI Visibility check is scheduled', async () => {
  const { doc } = await renderAt('/projects/project_citypoint/agent-readiness', { schedule: visibilitySchedule() })
  const page = renderedRoles(doc)
  expect(page.getByRole('button', { name: /^(Run scan|Checking scan)$/ })).toBeTruthy()
  expect(page.queryByRole('button', { name: VISIBILITY_CHECK_ACTION })).toBeNull()
  expect(nextSweepLabels(doc)).toEqual([])
})

// ── Next-sweep label ──

test('the next-sweep label is the calendar date in the schedule timezone, with no clock time', async () => {
  // 02:30 UTC on Sep 23 is still the evening of Sep 22 in New York.
  const { doc } = await renderAt('/projects/project_citypoint', { schedule: visibilitySchedule() })

  expect(nextSweepLabels(doc)).toEqual(['Next AI Visibility check Sep 22'])
  const checks = renderedRoles(doc).getByRole('group', { name: 'AI Visibility checks' })
  expect(within(checks).getByText('Next AI Visibility check Sep 22')).toBeTruthy()
})

test('an invalid schedule timezone renders no next-sweep label instead of "null" or a clock time', async () => {
  const { doc } = await renderAt('/projects/project_citypoint', { schedule: visibilitySchedule({ timezone: 'Not/A_Zone' }) })

  expect(nextSweepLabels(doc)).toEqual([])
  const checks = renderedRoles(doc).getByRole('group', { name: 'AI Visibility checks' })
  expect(checks.textContent).not.toContain('null')
})

// ── Settings ──

test('project Settings lists the project tags in a read-only Tags row', async () => {
  const { doc } = await renderAt('/projects/project_citypoint/settings')

  const row = settingsRow(doc, 'Tags')
  expect(row).not.toBeNull()
  expect([...row!.querySelectorAll('td:last-child span')].map(tag => tag.textContent)).toEqual(['local intent', 'priority'])
  expect(row!.querySelectorAll('button, input')).toHaveLength(0)
})

test('project Settings omits the Tags row when the project has no tags', async () => {
  const { doc } = await renderAt('/projects/project_citypoint/settings', {
    configureFixture(dashboard) {
      project(dashboard, 'project_citypoint').tags = []
    },
  })

  expect(settingsRow(doc, 'Display name')).not.toBeNull()
  expect(settingsRow(doc, 'Tags')).toBeNull()
})
