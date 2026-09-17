import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, expect, it, vi } from 'vitest'
import { apiKeys, auditLog, createClient, migrate } from '@ainyc/canonry-db'
import { hashApiKey } from '@ainyc/canonry-api-routes'
import { createServer } from '../src/server.js'
import { getConfigPath, saveConfig } from '../src/config.js'
import { createLogger } from '../src/logger.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

function approveFixtureOperator(db: ReturnType<typeof createClient>, token: string) {
  db.insert(apiKeys).values({ id: 'fixture-operator', name: 'operator', keyHash: hashApiKey(token), keyPrefix: token.slice(0, 9), scopes: ['*'], createdAt: new Date().toISOString() }).run()
  vi.stubEnv('CANONRY_OPERATOR_KEY_IDS', 'fixture-operator')
}

it('keeps health responsive when runtime capture encounters a database writer lock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-log-lock-smoke-'))
  vi.stubEnv('CANONRY_CONFIG_DIR', dir)
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
  const config = { apiUrl: 'http://localhost:4100', apiKey: 'cnry_lock_fixture', database: path.join(dir, 'test.db'), telemetry: false }
  saveConfig(config)
  const db = createClient(config.database)
  migrate(db)
  const lock = createClient(config.database)
  approveFixtureOperator(db, config.apiKey)
  let app: Awaited<ReturnType<typeof createServer>> | undefined
  try {
    app = await createServer({ config, db, logger: false, assetsDir: path.join(dir, 'assets') })
    await app.ready()
    lock.$client.exec('BEGIN IMMEDIATE')
    const started = performance.now()
    const health = await app.inject('/health')
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(health.statusCode).toBe(200)
    expect(db.$client.pragma('busy_timeout', { simple: true })).toBe(5_000)
    lock.$client.exec('ROLLBACK')
    const logs = await app.inject({ url: '/api/v1/operations/logs', headers: { authorization: `Bearer ${config.apiKey}` } })
    expect(logs.statusCode).toBe(200)
    expect(logs.json().captureErrors).toBeGreaterThan(0)
  } finally {
    if (lock.$client.inTransaction) lock.$client.exec('ROLLBACK')
    await app?.close()
    lock.$client.close()
    db.$client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)

it('serves bounded diagnostics and effective telemetry from the real server wiring', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-operations-server-'))
  vi.stubEnv('CANONRY_CONFIG_DIR', dir)
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
  const config = { apiUrl: 'http://localhost:4100', apiKey: 'cnry_fixture_only', database: path.join(dir, 'test.db'), telemetry: true }
  saveConfig(config)
  const db = createClient(config.database)
  migrate(db)
  approveFixtureOperator(db, config.apiKey)
  let app: Awaited<ReturnType<typeof createServer>> | undefined
  try {
    app = await createServer({ config, db, logger: false, assetsDir: path.join(dir, 'assets') })
    await app.ready()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const log = createLogger('OperationsSmoke')
    log.info('smoke.completed', { runId: 'fixture-run', apiKey: 'secret-never-exposed', query: 'private-query' })
    const headers = { authorization: `Bearer ${config.apiKey}` }
    const logs = await app.inject({ url: '/api/v1/operations/logs?module=OperationsSmoke', headers })
    expect(logs.statusCode).toBe(200)
    expect(logs.json()).toMatchObject({ retention: 'durable', entries: [expect.objectContaining({ action: 'smoke.completed', runId: 'fixture-run' })] })
    expect(logs.body).not.toMatch(/secret-never-exposed|private-query/)
    const telemetry = await app.inject({ url: '/api/v1/telemetry', headers })
    expect(telemetry.json()).toMatchObject({ enabled: false, configuredEnabled: true, reason: 'CANONRY_TELEMETRY_DISABLED', target: 'server' })
    expect(fs.readFileSync(getConfigPath(), 'utf8')).not.toContain('anonymousId')
  } finally {
    await app?.close()
    db.$client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)

it('keeps redacted Fastify runtime failures available after a server restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-durable-runtime-'))
  vi.stubEnv('CANONRY_CONFIG_DIR', dir)
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
  const config = { apiUrl: 'http://localhost:4100', apiKey: 'cnry_durable_fixture', database: path.join(dir, 'test.db'), telemetry: false }
  saveConfig(config)
  let db = createClient(config.database)
  migrate(db)
  approveFixtureOperator(db, config.apiKey)
  let app: Awaited<ReturnType<typeof createServer>> | undefined
  try {
    app = await createServer({ config, db, logger: false, assetsDir: path.join(dir, 'assets') })
    await app.ready()
    app.log.error({ runId: 'runtime-fixture', err: new Error('upstream failed at https://fake:password@provider.invalid/?api_key=runtime-secret') }, 'Research run failed')
    const headers = { authorization: `Bearer ${config.apiKey}` }
    const first = await app.inject({ url: '/api/v1/operations/logs?runId=runtime-fixture', headers })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.headers['x-request-id']).toMatch(/^[\da-f-]{36}$/)
    expect(first.json()).toMatchObject({
      retention: 'durable', retentionPolicy: { maxEntries: 10_000, maxAgeSeconds: 604_800 },
      entries: [expect.objectContaining({ level: 'error', runId: 'runtime-fixture', message: expect.stringContaining('Research run failed') })],
    })
    expect(first.body).not.toMatch(/runtime-secret|fake:password/)
    await app.close()
    app = undefined
    db.$client.close()
    db = createClient(config.database)
    migrate(db)
    app = await createServer({ config, db, logger: false, assetsDir: path.join(dir, 'assets') })
    await app.ready()
    const after = await app.inject({ url: '/api/v1/operations/logs?runId=runtime-fixture', headers })
    expect(after.statusCode, after.body).toBe(200)
    expect(after.headers['x-request-id']).toMatch(/^[\da-f-]{36}$/)
    expect(after.headers['x-request-id']).not.toBe(first.headers['x-request-id'])
    expect(after.json().entries).toEqual(first.json().entries)
    expect(after.json().retention).toBe('durable')
  } finally {
    await app?.close()
    db.$client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)

it('persists authenticated provider-setting attribution without exposing the preserved credential', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-provider-attribution-'))
  vi.stubEnv('CANONRY_CONFIG_DIR', dir)
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
  const config = {
    apiUrl: 'http://localhost:4100', apiKey: 'cnry_provider_fixture_only',
    database: path.join(dir, 'test.db'), telemetry: false,
    providers: { openai: { apiKey: 'provider-fixture-never-exposed', model: 'gpt-4.1' } },
  }
  saveConfig(config)
  const db = createClient(config.database)
  migrate(db)
  let app: Awaited<ReturnType<typeof createServer>> | undefined
  try {
    app = await createServer({ config, db, logger: false, assetsDir: path.join(dir, 'assets') })
    await app.ready()
    const headers = {
      authorization: `Bearer ${config.apiKey}`,
      'user-agent': 'canonry-mcp/provider-smoke',
      'x-canonry-actor-session': 'provider-smoke-session',
    }
    const self = await app.inject({ url: '/api/v1/keys/self', headers })
    expect(self.statusCode).toBe(200)
    const response = await app.inject({
      method: 'PUT', url: '/api/v1/settings/providers/openai', headers,
      payload: { model: 'gpt-4.1-mini' },
    })
    expect(response.statusCode, response.body).toBe(200)
    const rows = db.select().from(auditLog).all().filter(row => row.entityType === 'provider')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor: `api-key:${self.json().id}`, action: 'provider.updated',
      credentialId: self.json().id, requestId: response.headers['x-request-id'],
      userAgent: headers['user-agent'], actorSession: headers['x-canonry-actor-session'],
    })
    expect(JSON.stringify(rows)).not.toContain(config.providers.openai.apiKey)
    expect(JSON.stringify(rows)).not.toContain(config.apiKey)
    expect(config.providers.openai.apiKey).toBe('provider-fixture-never-exposed')
  } finally {
    await app?.close()
    db.$client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
