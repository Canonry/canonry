import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { expect, it } from 'vitest'
import { apiRoutes, hashApiKey } from '@ainyc/canonry-api-routes'
import { apiKeys, createClient, migrate, OperationalLogStore } from '@ainyc/canonry-db'
import { redactLogString, redactLogValue } from '@ainyc/canonry-contracts'
import { addLogListener, createFastifyLogger, createLogger } from '../src/logger.js'

it('preserves boolean/null diagnostics and removes credentials even when a URL crosses the string bound', () => {
  expect(redactLogValue({ success: false, cancelled: true, missing: null })).toEqual({ success: false, cancelled: true, missing: null })
  const oversized = `https://name:${'privatevalue'.repeat(800)}@example.invalid/`
  expect(redactLogString(oversized)).not.toContain('privatevalue')
  expect(redactLogString(oversized).length).toBeLessThanOrEqual(4096)
})

it('keeps authenticated identity, error detail, and typed diagnostics through log capture and REST', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-observability-'))
  const db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  const token = 'cnry_observability_test_only'
  db.insert(apiKeys).values({ id: 'key-fixture', name: 'fixture', keyHash: hashApiKey(token), keyPrefix: token.slice(0, 9), scopes: ['*'], createdAt: new Date().toISOString() }).run()
  const store = new OperationalLogStore(db)
  const app = Fastify({ loggerInstance: createFastifyLogger({ enabled: false, module: 'RuntimeFixture' }) })
  const remove = addLogListener(entry => store.append(entry))
  const log = createLogger('RuntimeFixture')
  try {
    await app.register(apiRoutes, {
      db, operatorApiKeyIds: ['key-fixture'], listOperationalLogs: query => store.list(query),
      registerAuthenticatedRoutes: async scope => {
        scope.post('/observability-fixture', async request => {
          log.info('diagnostic.fixture', { runId: 'run-fixture', success: false, actor: 'spoofed', credentialId: 'spoofed' })
          request.log.error(new Error('fixture failure with token=must-not-leak'))
          return { ok: true }
        })
      },
    })
    const headers = { authorization: `Bearer ${token}`, 'x-canonry-actor-session': 'session-fixture' }
    expect((await app.inject({ method: 'POST', url: '/api/v1/observability-fixture', headers })).statusCode).toBe(200)
    const result = await app.inject({ url: '/api/v1/operations/logs?actor=api-key%3Akey-fixture&module=RuntimeFixture', headers })
    expect(result.statusCode, result.body).toBe(200)
    const entries = result.json().entries as Array<{ level: string; action: string; message?: string; context: Record<string, unknown> }>
    expect(entries.find(entry => entry.action === 'diagnostic.fixture')).toMatchObject({ context: { success: false, actor: 'api-key:key-fixture', credentialId: 'key-fixture', actorSession: 'session-fixture', requestId: expect.any(String), method: 'POST', route: '/api/v1/observability-fixture' } })
    expect(entries.find(entry => entry.level === 'error')).toMatchObject({ message: expect.stringContaining('fixture failure') })
    expect(entries.find(entry => entry.message === 'request completed')).toMatchObject({ context: { statusCode: 200, method: 'POST' } })
    expect(result.body).not.toMatch(/must-not-leak|spoofed|cnry_observability_test_only/)
  } finally {
    remove()
    await app.close()
    db.$client.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

it('treats equivalent ISO time representations as the same inclusive filter boundary', () => {
  const db = createClient(':memory:')
  migrate(db)
  try {
    const store = new OperationalLogStore(db, { now: () => new Date('2026-09-11T00:00:01.000Z'), retention: 'process' })
    store.append({ ts: '2026-09-11T00:00:00.000Z', level: 'info', module: 'TimeFixture', action: 'event' })
    expect(store.list({ limit: 10, since: '2026-09-11T00:00:00Z', until: '2026-09-11T00:00:00Z' }).entries).toHaveLength(1)
    store.append({ ts: '2026-09-11T00:00:00Z', level: 'info', module: 'TimeFixture', action: 'event' })
    expect(store.list({ limit: 10, since: '2026-09-11T00:00:00.000Z', until: '2026-09-11T00:00:00.000Z' }).entries).toHaveLength(2)
  } finally {
    db.$client.close()
  }
})
