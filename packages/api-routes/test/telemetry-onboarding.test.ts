import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import type { OnboardingTelemetryEvent } from '@ainyc/canonry-contracts'
import { apiKeys, auditLog, createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { telemetryRoutes } from '../src/telemetry.js'

async function buildApp(recordOnboardingEvent?: (event: OnboardingTelemetryEvent) => void) {
  const app = Fastify()
  await app.register(telemetryRoutes, { recordOnboardingEvent })
  await app.ready()
  return app
}

describe('onboarding telemetry route', () => {
  const eventId = '30ed4717-c740-433f-9d37-05421e3f1a75'
  const onboardingSessionId = '02db91c9-98d6-4826-b2cf-a9d4bec84768'

  it('accepts and forwards an allowlisted event', async () => {
    const events: OnboardingTelemetryEvent[] = []
    const app = await buildApp(event => events.push(event))

    const response = await app.inject({
      method: 'POST',
      url: '/telemetry/onboarding',
      payload: {
        event: 'onboarding.started',
        eventId,
        flowVersion: 1,
        onboardingSessionId,
        step: 'project',
        resumed: true,
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({ accepted: true })
    // `surface` is absent from the payload and present on the forwarded event:
    // the wire keeps it optional so an older client stays valid, and the
    // historical default is applied HERE, at the one boundary every onboarding
    // event passes through, so the collector stores `wizard` rather than a null
    // every reader has to re-interpret.
    expect(events).toEqual([{
      event: 'onboarding.started',
      eventId,
      flowVersion: 1,
      onboardingSessionId,
      surface: 'wizard',
      step: 'project',
      resumed: true,
    }])
    await app.close()
  })

  it('is a safe no-op when the deployment does not collect telemetry', async () => {
    const app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/telemetry/onboarding',
      payload: {
        event: 'onboarding.started',
        eventId,
        flowVersion: 1,
        onboardingSessionId,
        step: 'system',
        resumed: false,
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toEqual({ accepted: false })
    await app.close()
  })

  it('rejects unknown fields before they can reach the collector', async () => {
    const app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/telemetry/onboarding',
      payload: {
        event: 'onboarding.blocked',
        eventId,
        flowVersion: 1,
        onboardingSessionId,
        step: 'run',
        action: 'launch_run',
        reasonCode: 'run_failed',
        rawError: 'credential leaked here',
      },
    })

    expect(response.statusCode).toBe(400)
    await app.close()
  })
})

describe('telemetry settings authorization', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  async function buildAuthenticatedApp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-telemetry-auth-'))
    dirs.push(dir)
    const db = createClient(path.join(dir, 'test.db'))
    migrate(db)
    let configuredEnabled = true
    const app = Fastify()
    await app.register(apiRoutes, {
      db,
      operatorApiKeyIds: ['root', 'settings'],
      getTelemetryStatus: () => ({
        enabled: configuredEnabled,
        configuredEnabled,
        reason: configuredEnabled ? 'enabled' : 'configured_disabled',
        anonymousId: '01234567-89ab-4cde-8fab-0123456789ab',
      }),
      setTelemetryEnabled: (enabled) => { configuredEnabled = enabled },
    })
    await app.ready()

    const seed = (name: string, scopes: string[]) => {
      const token = `cnry_${name}_${crypto.randomUUID().replaceAll('-', '')}`
      db.insert(apiKeys).values({
        id: name,
        name,
        keyHash: hashApiKey(token),
        keyPrefix: token.slice(0, 9),
        scopes,
        createdAt: new Date().toISOString(),
      }).run()
      return token
    }

    return { app, db, seed, configured: () => configuredEnabled }
  }

  it('allows host-approved root and settings.write keys, and rejects unrelated scopes', async () => {
    const { app, db, seed, configured } = await buildAuthenticatedApp()
    try {
      const root = seed('root', ['*'])
      const settings = seed('settings', ['settings.write'])
      const empty = seed('empty', [])
      const runs = seed('runs', ['runs.write'])
      const reader = seed('reader', ['read'])
      const research = seed('research', ['research.run'])

      for (const token of [empty, runs, reader, research]) {
        const denied = await app.inject({
          method: 'PUT', url: '/api/v1/telemetry',
          headers: { authorization: `Bearer ${token}` }, payload: { enabled: false },
        })
        expect(denied.statusCode).toBe(403)
        expect(configured()).toBe(true)
      }

      const settingsWrite = await app.inject({
        method: 'PUT', url: '/api/v1/telemetry',
        headers: { authorization: `Bearer ${settings}` }, payload: { enabled: false },
      })
      expect(settingsWrite.statusCode).toBe(200)
      expect(settingsWrite.json()).toMatchObject({
        enabled: false, configuredEnabled: false, reason: 'configured_disabled', target: 'server',
      })
      expect(settingsWrite.body).not.toContain('01234567-89ab')

      const rootWrite = await app.inject({
        method: 'PUT', url: '/api/v1/telemetry',
        headers: { authorization: `Bearer ${root}` }, payload: { enabled: true },
      })
      expect(rootWrite.statusCode).toBe(200)
      expect(configured()).toBe(true)
      const audit = db.select().from(auditLog).all()
      expect(audit).toHaveLength(2)
      expect(audit[0]).toMatchObject({ action: 'telemetry.updated', entityType: 'telemetry' })
      expect(audit[0].diff).not.toContain('01234567-89ab')
    } finally {
      await app.close()
    }
  })
})
