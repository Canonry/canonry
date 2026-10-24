import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import React from 'react'
import { afterEach, beforeAll, expect, onTestFinished, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { getApiV1ProjectsQueryKey } from '@canonry/canonry-api-client/react-query'

import { heyClient } from '../src/api.js'
import { AccountProvider, type ApiKeyAccess } from '../src/contexts/account-context.js'

import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { fetchHealth } from '../src/queries/use-health.js'
import type { HealthSnapshot } from '../src/view-models.js'
import { compileAppStyles, compiledDeclarations, compiledElementProperty, parseCompiledCss } from './compiled-app-css.js'

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

/** The demo app as a visitor first gets it, before any interaction. */
async function demoAppElement(health?: HealthSnapshot, { path = '/', config = { demo: DEMO } }: { path?: string; config?: NonNullable<typeof window.__CANONRY_CONFIG__> } = {}): Promise<React.ReactElement> {
  window.__CANONRY_CONFIG__ = config
  const fixture = createDashboardFixture()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(getApiV1ProjectsQueryKey({ client: heyClient }), fixture.dashboard.projects.map((entry) => entry.project))
  const router = createAppRouter(queryClient, { initialEntries: [path] })
  await router.load()
  return (
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={null} apiKey={DEMO_READ_KEY}>
        <DashboardProvider value={{ dashboard: fixture.dashboard, health: health ?? fixture.health }}>
          <RouterProvider router={router} />
        </DashboardProvider>
      </AccountProvider>
    </QueryClientProvider>
  )
}

async function renderDemoApp(...args: Parameters<typeof demoAppElement>): Promise<Document> {
  const markup = renderToStaticMarkup(await demoAppElement(...args))
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

test.each([false, true])('agent setup navigation is available only outside the public demo (demo=%s)', async (demo) => {
  const config = demo ? { demo: DEMO } : {}
  const document = await renderDemoApp(undefined, { config })
  const sidebarLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('.sidebar-link'))
    .filter(link => link.textContent?.trim() === 'Agent setup')
  expect(sidebarLinks).toHaveLength(demo ? 0 : 1)
  if (!demo) expect(sidebarLinks[0]!.getAttribute('href')).toBe('/agent-setup')

  // The mobile navigation is a dialog, so its links exist only once it is open.
  onTestFinished(cleanup)
  const view = render(await demoAppElement(undefined, { config }))
  fireEvent.click(view.getByRole('button', { name: 'Open navigation' }))
  const navigation = await view.findByRole('dialog', { name: 'Navigation' })
  const mobileLinks = within(navigation).queryAllByRole('link', { name: 'Agent setup' })
  expect(mobileLinks).toHaveLength(demo ? 0 : 1)
  if (!demo) expect(mobileLinks[0]!.getAttribute('href')).toBe('/agent-setup')
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
  // The shell reserves room for the bar, so it never covers the page's end,
  // and the page scroller keeps the same lane clear when focus or
  // scrollIntoView brings a control into view, so the bar never sits on it.
  // The lane is on the wrapper that holds the page AND the footer, so the bar
  // never covers the footer's links at the end of the page either.
  const area = document.querySelector('.main-area')!
  expect(area.classList.contains('main-area-agent-bar')).toBe(true)
  expect(area.querySelector('footer')).toBeTruthy()
  const rules = parseCompiledCss(await compileAppStyles([...area.classList]))
  expect(compiledElementProperty(rules, area, 'padding-bottom')).toBe('6rem')
  expect(compiledDeclarations(rules, 'html:has(.main-area-agent-bar)')['scroll-padding-bottom']).toBe('6rem')
})

test('the same read-only key outside the demo gets no Aero bar', async () => {
  const project = createDashboardFixture().dashboard.projects[0]!.project
  const document = await renderDemoApp(undefined, { path: `/projects/${encodeURIComponent(project.name)}`, config: {} })
  expect(document.body.textContent).not.toMatch(/Ask Aero/)
  expect(document.querySelector('.main-area')?.classList.contains('main-area-agent-bar')).toBe(false)
})
