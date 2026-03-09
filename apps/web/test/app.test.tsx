import assert from 'node:assert/strict'
import test from 'node:test'

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

  assert.match(html, /Portfolio/)
  assert.match(html, /Portfolio ranking/)
  assert.match(html, /Infrastructure/)
  assert.match(html, /Citypoint Dental NYC/)
  assert.match(html, /Harbor Legal Group/)
})

test('project route renders a single command center with visibility and readiness sections', () => {
  const html = renderApp('/projects/project_citypoint')

  assert.match(html, /Citypoint Dental NYC/)
  assert.match(html, /Interpretation before raw evidence/)
  assert.match(html, /Keyword citation tracking/)
  assert.match(html, /Readiness signals/)
  assert.match(html, /Recent execution history/)
})

test('runs route renders the operational timeline and filters', () => {
  const html = renderApp('/runs')

  assert.match(html, /Runs/)
  assert.match(html, /All runs/)
  assert.match(html, /Queued follow-up after local ranking movement/)
  assert.match(html, /Citation losses on emergency-intent prompts/)
})

test('settings route renders provider state, quota summary, and service health', () => {
  const html = renderApp('/settings')

  assert.match(html, /Settings/)
  assert.match(html, /Conservative defaults/)
  assert.match(html, /Service health/)
  assert.match(html, /Gemini/)
})

test('setup route renders the guided onboarding flow', () => {
  const html = renderApp('/setup')

  assert.match(html, /Setup/)
  assert.match(html, /System ready/)
  assert.match(html, /Create project/)
  assert.match(html, /Import or paste keywords/)
  assert.match(html, /Add competitors/)
  assert.match(html, /Launch first run/)
})

test('overview route renders first-run onboarding guidance when there are no projects', () => {
  const html = renderApp('/', { emptyPortfolio: true })

  assert.match(html, /No projects yet/)
  assert.match(html, /Canonry becomes useful after one project/)
  assert.match(html, /Launch setup/)
})

test('default overview covers multiple projects and recent runs', () => {
  const html = renderApp('/')

  assert.match(html, /Northstar Orthopedics/)
  assert.match(html, /One follow-up run is queued/)
  assert.match(html, /System health/)
})

test('setup route blocks launch when worker health is degraded', () => {
  const html = renderApp('/setup', { degradedWorker: true })

  assert.match(html, /heartbeat stale/)
  assert.match(html, /Launch is blocked until the worker is healthy and heartbeats are current/)
})

test('runs route renders partial runs clearly', () => {
  const html = renderApp('/runs', { runScenario: 'partial' })

  assert.match(html, /Partial visibility sweep after quota cap/)
  assert.match(html, /Quota window closed mid-run/)
})

test('runs route renders failed runs clearly', () => {
  const html = renderApp('/runs', { runScenario: 'failed' })

  assert.match(html, /Provider retries exhausted before results were captured/)
  assert.match(html, /Worker could not reach the provider after repeated retry exhaustion/)
})

test('project route renders visibility drop insights linked to technical findings', () => {
  const html = renderApp('/projects/project_citypoint', { visibilityDropProjectId: 'project_citypoint' })

  assert.match(html, /Sharp citation drop detected/)
  assert.match(html, /Primary supporting page fell out of crawl emphasis/)
})

test('fetchServiceStatus reports ok details from a health payload', async (t) => {
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

  t.after(() => {
    globalThis.fetch = realFetch
  })

  const result = await fetchServiceStatus('/worker-health', 'Worker')

  assert.deepEqual(result, {
    label: 'Worker',
    state: 'ok',
    detail: 'phase-1 · database configured · heartbeat 2026-03-09T00:00:00.000Z',
    version: 'phase-1',
    databaseConfigured: true,
    lastHeartbeatAt: '2026-03-09T00:00:00.000Z',
  })
})

test('fetchServiceStatus reports transport failures', async (t) => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('connection refused')
  }) as typeof fetch

  t.after(() => {
    globalThis.fetch = realFetch
  })

  const result = await fetchServiceStatus('/api-health', 'API')

  assert.deepEqual(result, {
    label: 'API',
    state: 'error',
    detail: 'connection refused',
  })
})
