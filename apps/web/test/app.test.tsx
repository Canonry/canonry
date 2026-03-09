import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'

import { App, fetchServiceStatus } from '../src/App.js'

test('App renders the skeleton shell and docs links', () => {
  const html = renderToStaticMarkup(<App />)

  assert.match(html, /Platform skeleton/)
  assert.match(html, /aeo-monitor platform scaffold/)
  assert.match(html, /API status checking/)
  assert.match(html, /Worker status checking/)
  assert.match(html, /Architecture/)
  assert.match(html, /Self-Hosting/)
})

test('fetchServiceStatus reports ok details from a health payload', async (t) => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    version: 'phase-1',
    lastHeartbeatAt: '2026-03-09T00:00:00.000Z',
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  })) as typeof fetch

  t.after(() => {
    globalThis.fetch = realFetch
  })

  const result = await fetchServiceStatus('/worker-health', 'Worker')

  assert.deepEqual(result, {
    label: 'Worker',
    state: 'ok',
    detail: 'ok (phase-1, heartbeat 2026-03-09T00:00:00.000Z)',
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
