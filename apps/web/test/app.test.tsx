import { test, expect, onTestFinished } from 'vitest'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { App, fetchServiceStatus } from '../src/App.js'
import { createDashboardFixture } from '../src/mock-data.js'

function renderApp(
  pathname: string,
  options: Parameters<typeof createDashboardFixture>[0] = {},
): string {
  const fixture = createDashboardFixture(options)

  return renderToStaticMarkup(
    <App
      enableLiveStatus={false}
      initialPathname={pathname}
      initialDashboard={fixture.dashboard}
      initialHealthSnapshot={fixture.health}
    />,
  )
}

test('overview route renders the premium portfolio dashboard', () => {
  const html = renderApp('/')

  expect(html).toMatch(/Portfolio/)
  expect(html).toMatch(/Visibility and execution state/)
  expect(html).toMatch(/Infrastructure/)
  expect(html).toMatch(/Citypoint Dental NYC/)
  expect(html).toMatch(/Harbor Legal Group/)
  expect(html).toMatch(/src="\.\/favicon\.svg"/)
})

test('project route renders a single command center with visibility sections', () => {
  const html = renderApp('/projects/project_citypoint')

  expect(html).toMatch(/Citypoint Dental NYC/)
  expect(html).toMatch(/Overview/)
  expect(html).toMatch(/Search Console/)
  expect(html).toMatch(/Citation signals/)
  expect(html).toMatch(/Key phrase citation tracking/)
  expect(html).toMatch(/Recent execution history/)
  expect(html).not.toMatch(/Google Search Console/)
})

test('runs route renders the operational timeline and filters', () => {
  const html = renderApp('/runs')

  expect(html).toMatch(/Runs/)
  expect(html).toMatch(/All runs/)
  expect(html).toMatch(/Queued follow-up after local ranking movement/)
  expect(html).toMatch(/Citation losses on emergency-intent prompts/)
})

test('settings route renders provider state, quota summary, and service health', () => {
  const html = renderApp('/settings')

  expect(html).toMatch(/Settings/)
  expect(html).toMatch(/Rate limit/)
  expect(html).toMatch(/Service health/)
  expect(html).toMatch(/Gemini/)
})

test('settings route renders the Google Search Console OAuth configuration card', () => {
  const html = renderApp('/settings')

  expect(html).toMatch(/Search Console OAuth/)
  expect(html).toMatch(/~\/\.canonry\/config\.yaml/)
  expect(html).toMatch(/Configure Google OAuth|Update OAuth app/)
})

test('setup route renders the step wizard with system check first', () => {
  const html = renderApp('/setup')

  expect(html).toMatch(/Setup/)
  expect(html).toMatch(/System ready/)
  expect(html).toMatch(/Step 1 of 5/)
  expect(html).toMatch(/Continue/)
})

test('overview route renders first-run onboarding guidance when there are no projects', () => {
  const html = renderApp('/', { emptyPortfolio: true })

  expect(html).toMatch(/No projects yet/)
  expect(html).toMatch(/Canonry becomes useful after one project/)
  expect(html).toMatch(/Launch setup/)
})

test('default overview covers multiple projects and recent runs', () => {
  const html = renderApp('/')

  expect(html).toMatch(/Northstar Orthopedics/)
  expect(html).toMatch(/One follow-up run is queued/)
  expect(html).toMatch(/System health/)
})

test('setup route renders step indicator with all step labels', () => {
  const html = renderApp('/setup')

  expect(html).toMatch(/System check/)
  expect(html).toMatch(/Create project/)
  expect(html).toMatch(/Key phrases/)
  expect(html).toMatch(/Competitors/)
  expect(html).toMatch(/Launch/)
})

test('runs route renders partial runs clearly', () => {
  const html = renderApp('/runs', { runScenario: 'partial' })

  expect(html).toMatch(/Partial visibility sweep after quota cap/)
  expect(html).toMatch(/Quota window closed mid-run/)
})

test('runs route renders failed runs clearly', () => {
  const html = renderApp('/runs', { runScenario: 'failed' })

  expect(html).toMatch(/Provider retries exhausted before results were captured/)
  expect(html).toMatch(/Worker could not reach the provider after repeated retry exhaustion/)
})

test('project route renders visibility drop insights', () => {
  const html = renderApp('/projects/project_citypoint', { visibilityDropProjectId: 'project_citypoint' })

  expect(html).toMatch(/Sharp citation drop detected/)
})

test('project search console route renders the Google Search Console section shell', () => {
  const html = renderApp('/projects/project_citypoint/search-console')

  expect(html).toMatch(/Google Search Console/)
  expect(html).toMatch(/Loading…|Loading\.\.\./)
  expect(html).not.toMatch(/Citation signals/)
})

test('fetchServiceStatus reports ok details from a health payload', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        version: 'phase-1',
        databaseUrlConfigured: true,
        lastHeartbeatAt: '2026-03-09T00:00:00.000Z',
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    )) as typeof fetch

  onTestFinished(() => {
    globalThis.fetch = realFetch
  })

  const result = await fetchServiceStatus('/worker-health', 'Worker')

  expect(result).toEqual({
    label: 'Worker',
    state: 'ok',
    detail: 'phase-1 · database configured · heartbeat 2026-03-09T00:00:00.000Z',
    version: 'phase-1',
    databaseConfigured: true,
    lastHeartbeatAt: '2026-03-09T00:00:00.000Z',
  })
})

test('fetchServiceStatus reports transport failures', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('connection refused')
  }) as typeof fetch

  onTestFinished(() => {
    globalThis.fetch = realFetch
  })

  const result = await fetchServiceStatus('/api-health', 'API')

  expect(result).toEqual({
    label: 'API',
    state: 'error',
    detail: 'connection refused',
  })
})
