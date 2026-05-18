import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apiKeys, createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

/**
 * Integration test for the runtime-state pre-request guard. The guard
 * exists so deleting the DB or config file out from under `canonry serve`
 * fails loudly with a 503 instead of silently serving cached data from
 * the now-orphaned SQLite inode. The doctor endpoint and `/health` must
 * still be reachable so operators can diagnose.
 */
describe('runtime-state guard hook', () => {
  let tmp: string
  let dbPath: string
  let cfgPath: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-state-guard-'))
    dbPath = path.join(tmp, 'data.db')
    cfgPath = path.join(tmp, 'config.yaml')
    fs.writeFileSync(cfgPath, 'apiKey: cnry_test\n')
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  async function buildApp() {
    const db = createClient(dbPath)
    migrate(db)
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash: crypto.createHash('sha256').update('cnry_test').digest('hex'),
      keyPrefix: 'cnry_test',
      scopes: ['*'],
      createdAt: new Date().toISOString(),
    }).run()
    const app = Fastify()
    await app.register(apiRoutes, {
      db,
      runtimeStatePaths: { databasePath: dbPath, configPath: cfgPath },
    })
    await app.ready()
    return app
  }

  const authHeader = { authorization: 'Bearer cnry_test' }

  it('passes through when both files are present', async () => {
    const app = await buildApp()
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: authHeader })
      expect(res.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('returns 503 RUNTIME_STATE_MISSING when the DB file is deleted while serving', async () => {
    const app = await buildApp()
    try {
      // Simulate `rm ~/.canonry/data.db` mid-flight.
      fs.unlinkSync(dbPath)
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: authHeader })
      expect(res.statusCode).toBe(503)
      const body = JSON.parse(res.body) as { error: { code: string; message: string; details?: { missing: string[] } } }
      expect(body.error.code).toBe('RUNTIME_STATE_MISSING')
      expect(body.error.message).toMatch(/database file/i)
      expect(body.error.message).toMatch(/restart `canonry serve`/i)
      expect(body.error.details?.missing[0]).toContain(dbPath)
    } finally {
      await app.close()
    }
  })

  it('returns 503 with both files listed when DB and config are both deleted', async () => {
    const app = await buildApp()
    try {
      fs.unlinkSync(dbPath)
      fs.unlinkSync(cfgPath)
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: authHeader })
      expect(res.statusCode).toBe(503)
      const body = JSON.parse(res.body) as { error: { code: string; details?: { missing: string[] } } }
      expect(body.error.code).toBe('RUNTIME_STATE_MISSING')
      expect(body.error.details?.missing).toHaveLength(2)
    } finally {
      await app.close()
    }
  })

  it('still serves /api/v1/doctor so operators can diagnose with files missing', async () => {
    const app = await buildApp()
    try {
      fs.unlinkSync(dbPath)
      // Doctor must respond so the user can read the db.file.missing /
      // config.file.missing diagnostics, not get blocked at the gate.
      const res = await app.inject({ method: 'GET', url: '/api/v1/doctor', headers: authHeader })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body) as { checks: { id: string; status: string; code: string }[] }
      const dbFileCheck = body.checks.find((c) => c.id === 'db.file.present')
      expect(dbFileCheck).toBeDefined()
      expect(dbFileCheck?.status).toBe('fail')
      expect(dbFileCheck?.code).toBe('db.file.missing')
    } finally {
      await app.close()
    }
  })

  it('does not engage when runtimeStatePaths is not wired (cloud deployments)', async () => {
    // Cloud `apps/api` registers apiRoutes without runtimeStatePaths,
    // so the guard must be a no-op there even if other paths don't exist.
    const db = createClient(dbPath)
    migrate(db)
    db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      name: 'test',
      keyHash: crypto.createHash('sha256').update('cnry_test').digest('hex'),
      keyPrefix: 'cnry_test',
      scopes: ['*'],
      createdAt: new Date().toISOString(),
    }).run()
    const app = Fastify()
    await app.register(apiRoutes, { db })
    await app.ready()
    try {
      // Even with cfg deleted, no runtimeStatePaths = no guard.
      fs.unlinkSync(cfgPath)
      const res = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: authHeader })
      expect(res.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })
})
