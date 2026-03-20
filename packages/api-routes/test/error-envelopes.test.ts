import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { expect, it, describe } from 'vitest'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'

function buildApp(opts: Partial<Omit<ApiRoutesOptions, 'db'>> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-error-envelope-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, ...opts })
  return { app, tmpDir }
}

describe('api error envelopes', () => {
  it('returns a typed envelope for unsupported telemetry status', async () => {
    const { app, tmpDir } = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/telemetry',
    })

    expect(res.statusCode).toBe(501)
    expect(JSON.parse(res.payload)).toEqual({
      error: {
        code: 'NOT_IMPLEMENTED',
        message: 'Telemetry status is not available in this deployment',
      },
    })

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns a typed envelope for invalid telemetry payloads', async () => {
    const { app, tmpDir } = buildApp({
      getTelemetryStatus: () => ({ enabled: true }),
      setTelemetryEnabled: () => {},
    })
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/telemetry',
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload)).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'enabled (boolean) is required',
      },
    })

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns a typed envelope for invalid provider settings names', async () => {
    const { app, tmpDir } = buildApp()
    await app.ready()

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/providers/not-a-provider',
      payload: { apiKey: 'test' },
    })

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload) as {
      error: {
        code: string
        message: string
        details: { provider: string; validProviders: string[] }
      }
    }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.provider).toBe('not-a-provider')
    expect(body.error.details.validProviders).toEqual(['gemini', 'openai', 'claude', 'local'])

    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
