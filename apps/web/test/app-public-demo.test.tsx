import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import React from 'react'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { getApiV1ProjectsQueryKey } from '@ainyc/canonry-api-client/react-query'

import { heyClient } from '../src/api.js'
import { AccountProvider, type ApiKeyAccess } from '../src/contexts/account-context.js'

import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { fetchHealth } from '../src/queries/use-health.js'
import type { HealthSnapshot } from '../src/view-models.js'

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

afterEach(() => {
  delete window.__CANONRY_CONFIG__
  vi.unstubAllGlobals()
})

const DEMO = { enabled: true, readOnly: true, sampleData: true } as const

async function demoHealth(): Promise<HealthSnapshot> {
  window.__CANONRY_CONFIG__ = { demo: DEMO }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'ok', version: '1.0.0' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })))
  try {
    return await fetchHealth()
  } finally {
    // The app's own reads must not receive the health payload.
    vi.unstubAllGlobals()
  }
}

/** The demo signs every visitor in with this read-only, non-administrator key. */
const DEMO_READ_KEY: ApiKeyAccess = { id: 'public-demo-viewer', scopes: ['read'], projectId: null, readOnly: false }

async function renderDemoApp(health?: HealthSnapshot, { path = '/', config = { demo: DEMO } }: { path?: string; config?: NonNullable<typeof window.__CANONRY_CONFIG__> } = {}): Promise<Document> {
  window.__CANONRY_CONFIG__ = config
  const fixture = createDashboardFixture()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(getApiV1ProjectsQueryKey({ client: heyClient }), fixture.dashboard.projects.map((entry) => entry.project))
  const router = createAppRouter(queryClient, { initialEntries: [path] })
  await router.load()
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={null} apiKey={DEMO_READ_KEY}>
        <DashboardProvider value={{ dashboard: fixture.dashboard, health: health ?? fixture.health }}>
          <RouterProvider router={router} />
        </DashboardProvider>
      </AccountProvider>
    </QueryClientProvider>,
  )
  return new DOMParser().parseFromString(markup, 'text/html')
}

test('the skip link is the first stop for a keyboard, ahead of the demo banner', async () => {
  const document = await renderDemoApp()
  const banner = document.querySelector('.demo-banner')
  expect(banner).not.toBeNull()
  const focusable = Array.from(document.body.querySelectorAll('a[href], button, summary, input, select, textarea, [tabindex]'))
  expect(focusable[0]?.className).toBe('skip-link')
  expect(focusable[0]?.getAttribute('href')).toBe('#content')
  expect(focusable[0]!.compareDocumentPosition(banner!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('the demo worker pill reads as disabled, not healthy', async () => {
  const document = await renderDemoApp(await demoHealth())
  const pill = Array.from(document.querySelectorAll('.health-pill')).find(element => element.textContent?.startsWith('Worker'))
  expect(pill?.textContent).toBe('Worker disabled')
  expect(pill?.classList.contains('health-pill-ok')).toBe(false)
  expect(pill?.classList.contains('health-pill-disabled')).toBe(true)
  expect(pill?.getAttribute('title')).toBe('Background execution is disabled in this public demo.')

  const css = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8')
  const rule = css.match(/\.health-pill-disabled \{([^}]*)\}/)?.[1] ?? ''
  expect(rule).not.toBe('')
  expect(rule).not.toMatch(/positive|negative|caution/)
})

test('a demo project page offers the Aero preview to the read-only visitor', async () => {
  const project = createDashboardFixture().dashboard.projects[0]!.project
  const document = await renderDemoApp(undefined, {
    path: `/projects/${encodeURIComponent(project.name)}`,
    config: { demo: DEMO, dashboard: { showAgentBar: false } },
  })
  const bar = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes(`Ask Aero about ${project.name}`))
  expect(bar).toBeTruthy()
  // The shell reserves room for the bar, so it never covers the page's end.
  expect(document.querySelector('.page-shell')?.classList.contains('pb-20')).toBe(true)
})

test('the same read-only key outside the demo gets no Aero bar', async () => {
  const project = createDashboardFixture().dashboard.projects[0]!.project
  const document = await renderDemoApp(undefined, { path: `/projects/${encodeURIComponent(project.name)}`, config: {} })
  expect(document.body.textContent).not.toMatch(/Ask Aero/)
  expect(document.querySelector('.page-shell')?.classList.contains('pb-20')).toBe(false)
})
