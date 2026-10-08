import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { apiKeys, dashboardSessions, createClient, migrate, type DatabaseClient } from '@ainyc/canonry-db'
import { hashUserPassword } from '@ainyc/canonry-api-routes'
import type { CanonryConfig } from '../src/config.js'
import { createServer } from '../src/server.js'

let tmpDir: string
let db: DatabaseClient
let app: Awaited<ReturnType<typeof createServer>>
let config: CanonryConfig
const key = 'cnry_dashboard_restart_root'
const password = 'restart-keeps-this-session'
const headers = { origin: 'http://localhost:4100', host: 'localhost:4100' }
const sessionPath = '/canonry/api/v1/session'

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-dashboard-restart-'))
  vi.stubEnv('CANONRY_CONFIG_DIR', tmpDir)
  vi.stubEnv('CANONRY_BASE_PATH', undefined)
  vi.stubEnv('CANONRY_PORT', undefined)
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.insert(apiKeys).values({
    id: 'root', name: 'root', keyHash: crypto.createHash('sha256').update(key).digest('hex'),
    keyPrefix: key.slice(0, 9), scopes: ['*'], createdAt: new Date().toISOString(),
  }).run()
  config = {
    apiUrl: headers.origin, database: path.join(tmpDir, 'test.db'), apiKey: key,
    basePath: '/canonry/', dashboardPasswordHash: await hashUserPassword(password),
  }
  app = await createServer({ config, db, logger: false })
})

afterEach(async () => {
  vi.useRealTimers()
  await app.close()
  db.$client.close()
  vi.unstubAllEnvs()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

async function login(body: { password: string } | { apiKey: string }) {
  const response = await app.inject({ method: 'POST', url: sessionPath, headers, payload: body })
  expect(response.statusCode).toBe(200)
  const cookie = String(response.headers['set-cookie'])
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('SameSite=Lax')
  expect(cookie).toContain('Path=/canonry/')
  expect(cookie).toContain('Max-Age=43200')
  return cookie.split(';')[0]!
}

async function restart() {
  await app.close()
  db.$client.close()
  db = createClient(config.database)
  migrate(db)
  app = await createServer({ config, db, logger: false })
}

test.each(['password', 'api-key'])('%s dashboard login survives a server restart and logout remains durable', async mode => {
  const readKey = 'cnry_dashboard_restart_read'
  if (mode === 'api-key') {
    db.insert(apiKeys).values({
      id: 'read', name: 'read', keyHash: crypto.createHash('sha256').update(readKey).digest('hex'),
      keyPrefix: readKey.slice(0, 9), scopes: ['read'], createdAt: new Date().toISOString(),
    }).run()
  }
  const cookie = await login(mode === 'password' ? { password } : { apiKey: readKey })
  await restart()
  const status = await app.inject({ method: 'GET', url: sessionPath, headers: { cookie } })
  expect(status.json()).toEqual({ authenticated: true, setupRequired: false })
  const access = await app.inject({ method: 'GET', url: '/canonry/api/v1/keys/self', headers: { cookie } })
  expect(access.statusCode).toBe(200)
  expect(access.json()).toMatchObject(mode === 'password' ? { id: 'root', scopes: ['*'] } : { id: 'read', scopes: ['read'] })
  if (mode === 'api-key') {
    expect((await app.inject({ method: 'POST', url: '/canonry/api/v1/projects', headers: { ...headers, cookie }, payload: {} })).statusCode).toBe(403)
  }
  const token = cookie.slice(cookie.indexOf('=') + 1)
  const stored = db.select().from(dashboardSessions).all()
  expect(stored).toHaveLength(1)
  expect(stored[0]?.tokenHash).toBe(crypto.createHash('sha256').update(token).digest('hex'))
  expect(stored[0]?.tokenHash).not.toBe(token)
  expect((await app.inject({ method: 'GET', url: '/canonry/api/v1/projects', headers: { cookie: `canonry_session=${stored[0]?.tokenHash}` } })).statusCode).toBe(401)

  const logout = await app.inject({ method: 'DELETE', url: sessionPath, headers: { ...headers, cookie } })
  expect(logout.statusCode).toBe(204)
  expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0')
  await restart()
  expect((await app.inject({ method: 'GET', url: '/canonry/api/v1/projects', headers: { cookie } })).statusCode).toBe(401)
})

test('a revoked bound key stays revoked after restart', async () => {
  const cookie = await login({ password })
  db.update(apiKeys).set({ revokedAt: new Date().toISOString() }).where(eq(apiKeys.id, 'root')).run()
  await restart()
  expect((await app.inject({ method: 'GET', url: sessionPath, headers: { cookie } })).json().authenticated).toBe(false)
  expect((await app.inject({ method: 'GET', url: '/canonry/api/v1/projects', headers: { cookie } })).statusCode).toBe(401)
})

test('restart does not extend the original twelve-hour lifetime', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const cookie = await login({ password })
  vi.setSystemTime(Date.now() + 12 * 60 * 60 * 1000 - 1)
  await restart()
  expect((await app.inject({ method: 'GET', url: sessionPath, headers: { cookie } })).json().authenticated).toBe(true)
  vi.setSystemTime(Date.now() + 1)
  expect((await app.inject({ method: 'GET', url: sessionPath, headers: { cookie } })).json().authenticated).toBe(false)
  expect((await app.inject({ method: 'GET', url: '/canonry/api/v1/projects', headers: { cookie } })).statusCode).toBe(401)
})
