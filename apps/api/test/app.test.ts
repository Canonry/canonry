import { test, expect, onTestFinished } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getPlatformEnv } from '@ainyc/canonry-config'
import { PROVIDER_NAMES } from '@ainyc/canonry-contracts'
import { createClient, migrate, apiKeys } from '@ainyc/canonry-db'

import { buildApp } from '../src/app.js'
import { loadApiEnv } from '../src/plugins/env.js'

test('buildApp registers health and API routes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-test-'))
  const dbPath = path.join(tmpDir, 'test.db')

  onTestFinished(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // Pre-create and migrate the database
  const db = createClient(dbPath)
  migrate(db)

  const env = getPlatformEnv({
    DATABASE_URL: dbPath,
    API_PORT: '3000',
    WORKER_PORT: '3001',
    GOOGLE_STATE_SECRET: 'test-only-google-state-secret-32b',
  })
  const app = buildApp(env)

  onTestFinished(async () => {
    await app.close()
  })

  const healthResponse = await app.inject({
    method: 'GET',
    url: '/health',
  })
  expect(healthResponse.statusCode).toBe(200)
  expect(healthResponse.json()).toMatchObject({
    service: 'canonry',
    status: 'ok',
    version: '0.1.0',
    port: 3000,
    basePath: '/',
    databaseUrlConfigured: true,
  })
  expect(healthResponse.json().lastHeartbeatAt).toBeDefined()

  // API routes are registered — projects endpoint is available
  const projectsResponse = await app.inject({
    method: 'GET',
    url: '/api/v1/projects',
  })
  // Auth or success — either way, the route exists (not 404)
  expect(
    [200, 401].includes(projectsResponse.statusCode),
  ).toBeTruthy()

  const openApiResponse = await app.inject({
    method: 'GET',
    url: '/api/v1/openapi.json',
  })
  expect(openApiResponse.statusCode).toBe(200)
  expect(openApiResponse.json().info.version).toBe('0.1.0')
})

test('cloud accepts every registered provider name', async () => {
  // The cloud provider catalog is hand-mirrored (apps/api must not pull the
  // provider SDK graphs), and `apiRoutes` turns its NAMES into the allowlist
  // enforced on project / query / run / apply / schedule writes. A name missing
  // here silently makes that provider unwritable on Cloud while local `canonry
  // serve` — which validates against all registered adapters — still accepts
  // it. Pin the invariant so a future hand-edit cannot reintroduce the drift.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-providers-test-'))
  const dbPath = path.join(tmpDir, 'test.db')

  onTestFinished(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const db = createClient(dbPath)
  migrate(db)

  const rawKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name: 'test',
    keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.slice(0, 9),
    scopes: ['*'],
    createdAt: new Date().toISOString(),
  }).run()

  const app = buildApp(getPlatformEnv({
    DATABASE_URL: dbPath,
    API_PORT: '3000',
    WORKER_PORT: '3001',
    GOOGLE_STATE_SECRET: 'test-only-google-state-secret-32b',
  }))

  onTestFinished(async () => {
    await app.close()
  })

  const settings = await app.inject({
    method: 'GET',
    url: '/api/v1/settings',
    headers: { authorization: `Bearer ${rawKey}` },
  })
  expect(settings.statusCode).toBe(200)
  const catalogNames = settings.json().providerCatalog.map((entry: { name: string }) => entry.name)
  expect([...catalogNames].sort()).toEqual([...PROVIDER_NAMES].sort())

  // The allowlist is what actually 400s a write, so exercise it end to end.
  const upsert = await app.inject({
    method: 'PUT',
    url: '/api/v1/projects/acme',
    headers: { authorization: `Bearer ${rawKey}` },
    payload: {
      displayName: 'Acme',
      canonicalDomain: 'acme.example',
      country: 'US',
      language: 'en',
      providers: [...PROVIDER_NAMES],
    },
  })
  expect(upsert.statusCode).toBe(201)
  expect(upsert.json().providers).toEqual([...PROVIDER_NAMES])
})

test('loadApiEnv delegates to shared platform config', () => {
  const env = loadApiEnv({
    DATABASE_URL: 'postgresql://aeo:aeo@localhost:5432/aeo_platform',
    API_PORT: '4100',
    WORKER_PORT: '4101',
    WEB_PORT: '4173',
    CANONRY_BASE_PATH: '/canonry',
    BOOTSTRAP_SECRET: 'secret',
    GEMINI_API_KEY: 'gemini-key',
    GEMINI_MAX_CONCURRENCY: '4',
    GEMINI_MAX_REQUESTS_PER_MINUTE: '15',
    GEMINI_MAX_REQUESTS_PER_DAY: '500',
  })

  expect(env.apiPort).toBe(4100)
  expect(env.workerPort).toBe(4101)
  expect(env.basePath).toBe('/canonry')
  expect(env.bootstrapSecret).toBe('secret')
  expect(env.providers.gemini).toBeTruthy()
  expect(env.providers.gemini!.quota).toEqual({
    maxConcurrency: 4,
    maxRequestsPerMinute: 15,
    maxRequestsPerDay: 500,
  })
})
