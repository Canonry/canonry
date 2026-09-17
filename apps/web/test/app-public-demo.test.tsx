import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import React from 'react'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

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

async function renderDemoApp(health?: HealthSnapshot): Promise<Document> {
  window.__CANONRY_CONFIG__ = { demo: DEMO }
  const fixture = createDashboardFixture()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/'] })
  await router.load()
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: fixture.dashboard, health: health ?? fixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
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
