import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { createOutcomeEmitter, type OutcomeTelemetryEvent } from '../src/outcome-telemetry.js'
import { registerRequestContext } from '../src/request-context.js'

describe('createOutcomeEmitter', () => {
  it('attaches the request’s raw usage labels for the host to classify', async () => {
    const seen: OutcomeTelemetryEvent[] = []
    const app = Fastify()
    registerRequestContext(app)
    const emit = createOutcomeEmitter(event => seen.push(event))
    app.post('/backlinks/install', async () => {
      emit({ event: 'feature.completed', properties: { feature: 'backlinks', operation: 'install', status: 'succeeded' } })
      return { ok: true }
    })
    await app.inject({
      method: 'POST',
      url: '/backlinks/install',
      headers: { 'user-agent': 'canonry-mcp', 'x-canonry-surface': 'mcp-stdio', 'x-canonry-agent': 'claude' },
    })
    expect(seen).toEqual([{
      event: 'feature.completed',
      properties: { feature: 'backlinks', operation: 'install', status: 'succeeded' },
      attribution: { userAgent: 'canonry-mcp', surfaceLabel: 'mcp-stdio', agentLabel: 'claude' },
    }])
    await app.close()
  })

  it('is a no-op without a sink and never throws into a request', async () => {
    expect(() => createOutcomeEmitter(undefined)({ event: 'feature.completed', properties: { feature: 'ga4', operation: 'sync', status: 'succeeded' } })).not.toThrow()
    const throwing = createOutcomeEmitter(() => { throw new Error('collector down') })
    expect(() => throwing({ event: 'feature.completed', properties: { feature: 'ga4', operation: 'sync', status: 'succeeded' } })).not.toThrow()
  })

  it('reports outside a request without attribution, so the host marks it as the server acting alone', () => {
    const seen: OutcomeTelemetryEvent[] = []
    createOutcomeEmitter(event => seen.push(event))({ event: 'feature.completed', properties: { feature: 'ga4', operation: 'sync', status: 'succeeded' } })
    expect(seen[0]?.attribution).toBeUndefined()
  })
})
