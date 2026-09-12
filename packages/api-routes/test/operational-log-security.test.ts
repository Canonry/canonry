import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { apiKeys, createClient, migrate, OperationalLogStore, projects, runtimeLogs } from '@ainyc/canonry-db'
import { apiRoutes, hashApiKey } from '../src/index.js'
import { addLogListener, createFastifyLogger } from '../src/runtime-logger.js'

afterEach(() => vi.restoreAllMocks())

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-log-security-'))
  const dbPath = path.join(dir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  const now = new Date().toISOString()
  db.insert(projects).values({ id: 'project-one', name: 'fixture', displayName: 'Fixture', canonicalDomain: 'fixture.invalid', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  for (const [name, scopes] of [['observer', ['logs.read']], ['explicit-reader', ['read', 'logs.read']], ['root', ['*']]] as const) {
    db.insert(apiKeys).values({ id: name, name, keyHash: hashApiKey(`cnry_fixture_${name}`), keyPrefix: 'cnry_fixture', scopes: [...scopes], createdAt: now }).run()
  }
  const store = new OperationalLogStore(db)
  const app = Fastify({ loggerInstance: createFastifyLogger({ module: 'SecurityFixture' }), genReqId: randomUUID })
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  await app.register(apiRoutes, { db, operatorApiKeyIds: ['observer', 'explicit-reader'], listOperationalLogs: query => store.list(query) })
  await app.ready()
  const stop = addLogListener(entry => store.append(entry))
  onTestFinished(async () => { stop(); await app.close(); db.$client.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { app, db, dbPath }
}

it.each(['observer', 'explicit-reader'])('allows %s to inspect logs but not change or delete project data', async name => {
  const { app, db } = await fixture()
  const headers = { authorization: `Bearer cnry_fixture_${name}` }
  expect((await app.inject({ url: '/api/v1/operations/logs', headers })).statusCode).toBe(200)
  const self = await app.inject({ url: '/api/v1/keys/self', headers })
  expect(self.json().readOnly).toBe(true)
  for (const request of [
    { method: 'POST' as const, url: '/api/v1/projects/fixture/competitors', payload: { competitors: ['other.invalid'] } },
    { method: 'DELETE' as const, url: '/api/v1/projects/fixture' },
    { method: 'PUT' as const, url: '/api/v1/telemetry', payload: { enabled: true } },
  ]) expect((await app.inject({ ...request, headers })).statusCode).toBe(403)
  expect(db.select().from(projects).all()).toHaveLength(1)
  // Explicit root authority still works; the change is not a blanket write ban.
  expect((await app.inject({ method: 'DELETE', url: '/api/v1/projects/fixture', headers: { authorization: 'Bearer cnry_fixture_root' } })).statusCode).toBe(204)
})

it('masks error-message credentials in console output, stored bytes, and observer reads after reopening SQLite', async () => {
  const { app, db, dbPath } = await fixture()
  const messages = [
    'Cookie: theme=dark; canonry_user_session=fixture-secret',
    'API key: fixture-secret',
    JSON.stringify({ message: JSON.stringify({ apiKey: 'fixture-secret' }) }),
    'upstream https://gateway.invalid/v1?key=fixture-secret',
  ]
  for (const message of messages) app.log.error({ err: new Error(message), runId: 'secret-formats' }, 'Provider failure')
  expect(JSON.stringify(vi.mocked(process.stderr.write).mock.calls)).not.toContain('fixture-secret')
  expect(JSON.stringify(db.select().from(runtimeLogs).all())).not.toContain('fixture-secret')
  const response = await app.inject({ url: '/api/v1/operations/logs?runId=secret-formats', headers: { authorization: 'Bearer cnry_fixture_observer' } })
  expect(response.statusCode).toBe(200)
  expect(response.json().entries).toHaveLength(messages.length)
  expect(response.body).not.toContain('fixture-secret')
  const reopened = createClient(dbPath)
  try {
    const result = new OperationalLogStore(reopened).list({ runId: 'secret-formats', limit: 100 })
    expect(result.entries).toHaveLength(messages.length)
    expect(JSON.stringify(result)).not.toContain('fixture-secret')
  } finally { reopened.$client.close() }
})
