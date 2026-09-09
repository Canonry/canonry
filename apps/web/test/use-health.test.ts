import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchHealth } from '../src/queries/use-health.js'

afterEach(() => {
  delete window.__CANONRY_CONFIG__
  vi.unstubAllGlobals()
})

describe('fetchHealth', () => {
  it('discloses that background execution is disabled in the public demo', async () => {
    window.__CANONRY_CONFIG__ = { demo: { enabled: true, readOnly: true, sampleData: true } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))

    await expect(fetchHealth()).resolves.toMatchObject({
      apiStatus: { state: 'ok' },
      workerStatus: {
        label: 'Worker',
        state: 'ok',
        detail: 'Background execution is disabled in this public demo.',
      },
    })
  })

  it('keeps the standard deployment status outside the public demo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))

    await expect(fetchHealth()).resolves.toMatchObject({
      workerStatus: { detail: 'In-process job runner' },
    })
  })
})
