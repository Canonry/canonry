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
    const { app, tmpDir } = buildApp({
      providerAdapters: [
        { name: 'gemini', displayName: 'Gemini', mode: 'api', modelConfigurable: true, defaultModel: 'gemini-2.5-flash', knownModels: [], modelValidationPattern: /./, modelValidationHint: '' },
        { name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-5.4', knownModels: [], modelValidationPattern: /./, modelValidationHint: '' },
        { name: 'claude', displayName: 'Claude', mode: 'api', modelConfigurable: true, defaultModel: 'claude-sonnet-4-5', knownModels: [], modelValidationPattern: /^claude-/, modelValidationHint: '' },
        { name: 'local', displayName: 'Local', mode: 'api', modelConfigurable: true, defaultModel: 'local', knownModels: [], modelValidationPattern: /./, modelValidationHint: '' },
      ],
    })
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

  it('persists validated project model overrides and resets them when PUT omits the map', async () => {
    const { app, tmpDir } = buildApp({
      providerAdapters: [{
        name: 'gemini', displayName: 'Gemini', mode: 'api', modelConfigurable: true,
        defaultModel: 'gemini-2.5-flash', knownModels: [], modelValidationPattern: /^gemini-/,
        modelValidationHint: 'use a Gemini model ID',
      }],
    })
    await app.ready()
    const body = { displayName: 'Demo', canonicalDomain: 'example.com', country: 'US', language: 'en', providers: ['gemini'] }
    const created = await app.inject({ method: 'PUT', url: '/api/v1/projects/demo', payload: { ...body, providerModels: { gemini: ' gemini-2.5-pro ' } } })
    expect(created.statusCode).toBe(201)
    expect(created.json().providerModels).toEqual({ gemini: 'gemini-2.5-pro' })
    const reset = await app.inject({ method: 'PUT', url: '/api/v1/projects/demo', payload: body })
    expect(reset.statusCode).toBe(200)
    expect(reset.json().providerModels).toEqual({})
    const settings = await app.inject({ method: 'GET', url: '/api/v1/settings' })
    expect(settings.json().providerCatalog[0]).toMatchObject({ name: 'gemini', modelConfigurable: true, modelValidationPattern: { source: '^gemini-', flags: '' } })
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})
