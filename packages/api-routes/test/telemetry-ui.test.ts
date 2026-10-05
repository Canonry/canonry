import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { UiTelemetryEvent } from '@ainyc/canonry-contracts'
import { telemetryRoutes } from '../src/telemetry.js'

async function buildApp(recordUiEvent?: (event: UiTelemetryEvent) => boolean) {
  const app = Fastify()
  await app.register(telemetryRoutes, { recordUiEvent })
  await app.ready()
  return app
}

const base = {
  eventId: '30ed4717-c740-433f-9d37-05421e3f1a75',
  uiSessionId: '02db91c9-98d6-4826-b2cf-a9d4bec84768',
}

describe('UI telemetry route', () => {
  it('accepts and forwards an allowlisted event', async () => {
    const events: UiTelemetryEvent[] = []
    const app = await buildApp(event => { events.push(event); return true })
    const payload = { ...base, event: 'ui.action', page: '/projects/:projectName', action: 'sweep.launch' }
    const response = await app.inject({ method: 'POST', url: '/telemetry/ui', payload })
    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({ accepted: true })
    expect(events).toEqual([payload])
  })

  it('rejects free text before forwarding anything', async () => {
    const events: UiTelemetryEvent[] = []
    const app = await buildApp(event => { events.push(event); return true })
    const response = await app.inject({
      method: 'POST',
      url: '/telemetry/ui',
      payload: { ...base, event: 'ui.error', page: '/', kind: 'render', message: 'secret text' },
    })
    expect(response.statusCode).toBe(400)
    expect(events).toEqual([])
  })

  it('answers accepted:false where telemetry is not collected', async () => {
    const app = await buildApp()
    const response = await app.inject({
      method: 'POST',
      url: '/telemetry/ui',
      payload: { ...base, event: 'ui.page_viewed', page: '/' },
    })
    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({ accepted: false })
  })

  it('answers accepted:false when the host declines (telemetry off or rate limited)', async () => {
    const app = await buildApp(() => false)
    const response = await app.inject({
      method: 'POST',
      url: '/telemetry/ui',
      payload: { ...base, event: 'ui.page_viewed', page: '/' },
    })
    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({ accepted: false })
  })
})
