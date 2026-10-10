import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { validationError } from '@ainyc/canonry-contracts'
import { withFeatureOutcome } from '../src/feature-outcome.js'
import { createOutcomeEmitter, type OutcomeTelemetryEvent } from '../src/outcome-telemetry.js'
import { featureOutcomes } from './feature-outcome-capture.js'

const apps: FastifyInstance[] = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })

function harness(sink?: (event: OutcomeTelemetryEvent) => void) {
  const events: OutcomeTelemetryEvent[] = []
  const app = Fastify()
  apps.push(app)
  app.decorate('emitOutcome', createOutcomeEmitter(sink ?? (event => { events.push(event) })))
  return { app, events }
}

const target = { feature: 'exports', operation: 'export' } as const
const reported = { feature: 'exports', operation: 'export', durationBucket: 'under_1s' }

describe('withFeatureOutcome', () => {
  it('reports one outcome per operation: success by default, or what the operation settled on', async () => {
    const { app, events } = harness()
    await expect(withFeatureOutcome(app, target, async () => 'plain')).resolves.toBe('plain')
    await withFeatureOutcome(app, target, async (settle) => {
      settle({ status: 'succeeded', counts: { rows: 3, bytes: 120 } })
      return 'counted'
    })
    await withFeatureOutcome(app, { ...target, trigger: 'scheduled' }, async (settle) => {
      settle({ status: 'skipped', reasonCode: 'NO_DATA' })
    })
    expect(featureOutcomes(events)).toEqual([
      { ...reported, status: 'succeeded' },
      { ...reported, status: 'succeeded', counts: { rows: 3, bytes: 120 } },
      { ...reported, trigger: 'scheduled', status: 'skipped', reasonCode: 'NO_DATA' },
    ])
  })

  it('reports a throw as failed by code and class, keeps a refusal the route settled first, and rethrows', async () => {
    const { app, events } = harness()
    const refused = validationError('profile for https://example.com is invalid')
    await expect(withFeatureOutcome(app, target, async () => { throw refused })).rejects.toBe(refused)
    await expect(withFeatureOutcome(app, target, async () => { throw refused }, () => 'UNSUPPORTED')).rejects.toBe(refused)
    await expect(withFeatureOutcome(app, target, async (settle) => {
      settle({ status: 'skipped', reasonCode: 'GATE_REFUSED' })
      throw refused
    })).rejects.toBe(refused)
    // A success recorded before a later throw never reached the caller.
    await expect(withFeatureOutcome(app, target, async (settle) => {
      settle({ status: 'succeeded', counts: { rows: 1 } })
      throw refused
    })).rejects.toBe(refused)
    expect(featureOutcomes(events)).toEqual([
      { ...reported, status: 'failed', reasonCode: 'VALIDATION', errorName: 'AppError' },
      { ...reported, status: 'failed', reasonCode: 'UNSUPPORTED', errorName: 'AppError' },
      { ...reported, status: 'skipped', reasonCode: 'GATE_REFUSED' },
      { ...reported, status: 'failed', reasonCode: 'VALIDATION', errorName: 'AppError' },
    ])
    expect(JSON.stringify(events)).not.toContain('example.com')
  })

  it('reports nothing for settle(null), and a missing or failing sink never changes the result', async () => {
    const { app, events } = harness()
    await withFeatureOutcome(app, target, async (settle) => { settle(null) })
    await expect(withFeatureOutcome(app, target, async (settle) => {
      settle(null)
      throw new Error('handed off, then failed')
    })).rejects.toThrow('handed off')
    expect(events).toEqual([])

    const throwing = harness(() => { throw new Error('collector down') })
    await expect(withFeatureOutcome(throwing.app, target, async () => 'kept')).resolves.toBe('kept')
    const bare = Fastify()
    apps.push(bare)
    await expect(withFeatureOutcome(bare, target, async () => 'kept')).resolves.toBe('kept')
  })
})
