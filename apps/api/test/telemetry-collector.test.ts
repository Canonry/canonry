import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { registerTelemetryCollectorRoutes } from '../src/routes/telemetry-collector.js'

// Ghost-event classification itself is covered in
// packages/contracts/test/telemetry.test.ts (isGhostTelemetryEvent); these
// tests verify the route wires that predicate to the test-traffic sink.
describe('telemetry collector', () => {
  it('routes ghost events to the internal telemetry_test sink', async () => {
    const app = Fastify()
    const writeTelemetryTest = vi.fn()
    registerTelemetryCollectorRoutes(app, { writeTelemetryTest })

    const res = await app.inject({
      method: 'POST',
      url: '/api/telemetry',
      payload: {
        event: 'run.aborted',
        properties: { location: 'chi', providerCount: 0 },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, accepted: false })
    expect(writeTelemetryTest).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('accepts normal telemetry events', async () => {
    const app = Fastify()
    const writeTelemetryTest = vi.fn()
    registerTelemetryCollectorRoutes(app, { writeTelemetryTest })

    const res = await app.inject({
      method: 'POST',
      url: '/api/telemetry',
      payload: {
        event: 'run.completed',
        properties: { location: 'nyc', providerCount: 1 },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, accepted: true })
    expect(writeTelemetryTest).not.toHaveBeenCalled()

    await app.close()
  })

  it('does not fail malformed telemetry payloads', async () => {
    const app = Fastify()
    const writeTelemetryTest = vi.fn()
    registerTelemetryCollectorRoutes(app, { writeTelemetryTest })

    const res = await app.inject({
      method: 'POST',
      url: '/api/telemetry',
      payload: null,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, accepted: true })
    expect(writeTelemetryTest).not.toHaveBeenCalled()

    await app.close()
  })
})
