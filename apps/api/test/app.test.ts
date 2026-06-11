import { test, expect, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getPlatformEnv } from '@ainyc/canonry-config'
import { createClient, migrate } from '@ainyc/canonry-db'

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

test('first-run /session/setup always requires a bearer key (Cloud Run is network-reachable)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-setup-gate-'))
  const dbPath = path.join(tmpDir, 'test.db')
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  const db = createClient(dbPath)
  migrate(db)

  const env = getPlatformEnv({
    DATABASE_URL: dbPath,
    API_PORT: '3000',
    WORKER_PORT: '3001',
    CANONRY_API_KEY: 'cnry_setup_gate_test_key',
  })
  const app = buildApp(env)
  onTestFinished(async () => { await app.close() })

  // No bearer — the pre-auth escalation is closed (#690 posture).
  const unauth = await app.inject({
    method: 'POST',
    url: '/api/v1/session/setup',
    payload: { password: 'a-strong-password' },
  })
  expect(unauth.statusCode).toBe(401)

  // With the instance's own key (seeded into api_keys on boot), setup works.
  const ok = await app.inject({
    method: 'POST',
    url: '/api/v1/session/setup',
    headers: { authorization: 'Bearer cnry_setup_gate_test_key' },
    payload: { password: 'a-strong-password' },
  })
  expect(ok.statusCode).toBe(200)
})

test('rate limiting keys per client via the trusted proxy hop, not per proxy', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-trustproxy-'))
  const dbPath = path.join(tmpDir, 'test.db')
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  const db = createClient(dbPath)
  migrate(db)

  // Default CANONRY_TRUST_PROXY_HOPS=1 — the Cloud Run topology, where the
  // platform appends the client IP as the rightmost X-Forwarded-For entry.
  const env = getPlatformEnv({
    DATABASE_URL: dbPath,
    API_PORT: '3000',
    WORKER_PORT: '3001',
  })
  expect(env.trustProxyHops).toBe(1)
  const app = buildApp(env)
  onTestFinished(async () => { await app.close() })

  // Client A exhausts the 10/min login budget…
  let sawLimit = false
  for (let i = 0; i < 12; i++) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers: { 'x-forwarded-for': '198.51.100.1' },
      payload: { password: 'wrong-guess-xxxx' },
    })
    if (res.statusCode === 429) { sawLimit = true; break }
  }
  expect(sawLimit).toBe(true)

  // …client B (different forwarded IP through the same proxy socket) is NOT
  // throttled — without trustProxy both would share one bucket and this
  // request would be 429.
  const other = await app.inject({
    method: 'POST',
    url: '/api/v1/session',
    headers: { 'x-forwarded-for': '198.51.100.2' },
    payload: { password: 'wrong-guess-xxxx' },
  })
  expect(other.statusCode).not.toBe(429)
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
