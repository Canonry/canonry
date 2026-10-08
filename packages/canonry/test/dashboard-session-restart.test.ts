import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { apiKeys, dashboardSessions, createClient, migrate, MIGRATION_VERSIONS, type DatabaseClient } from '@ainyc/canonry-db'
import { hashUserPassword } from '@ainyc/canonry-api-routes'
import { loadConfig, saveConfig, type CanonryConfig } from '../src/config.js'
import { bootstrapCommand } from '../src/commands/bootstrap.js'
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
  vi.stubEnv('CANONRY_API_KEY', undefined)
  vi.stubEnv('CANONRY_API_URL', undefined)
  vi.stubEnv('CANONRY_DATABASE_PATH', path.join(tmpDir, 'test.db'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.insert(apiKeys).values({
    id: 'root', name: 'default', keyHash: crypto.createHash('sha256').update(key).digest('hex'),
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

async function bootstrap(apiKey?: string) {
  saveConfig(config)
  vi.stubEnv('CANONRY_API_KEY', apiKey)
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    await bootstrapCommand({ format: 'json' })
  } finally {
    output.mockRestore()
  }
  config = loadConfig()
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
  await bootstrap()
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

test('upgrading a v173 database ends unfingerprinted sessions at native startup and permits fresh sign-in', async () => {
  await app.close()
  db.$client.close()
  config.database = path.join(tmpDir, 'legacy.db')
  db = createClient(config.database)
  migrate(db, MIGRATION_VERSIONS.filter(version => version.version <= 173))
  const now = new Date()
  const token = crypto.randomBytes(32).toString('hex')
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const keyHash = crypto.createHash('sha256').update(key).digest('hex')
  db.run(sql`INSERT INTO api_keys (id, name, key_hash, key_prefix, scopes, created_at)
    VALUES ('root', 'default', ${keyHash}, ${key.slice(0, 9)}, ${JSON.stringify(['*'])}, ${now.toISOString()})`)
  db.run(sql`INSERT INTO dashboard_sessions (token_hash, api_key_id, created_at, expires_at)
    VALUES (${tokenHash}, 'root', ${now.toISOString()}, ${new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString()})`)

  migrate(db)
  expect(db.select().from(dashboardSessions).all()).toHaveLength(1)
  app = await createServer({ config, db, logger: false })
  expect(db.select().from(dashboardSessions).all()).toHaveLength(0)
  const cookie = `canonry_session=${token}`
  expect((await app.inject({ method: 'GET', url: sessionPath, headers: { cookie } })).json().authenticated).toBe(false)
  expect((await app.inject({ method: 'GET', url: '/canonry/api/v1/projects', headers: { cookie } })).statusCode).toBe(401)
  const freshCookie = await login({ password })
  expect((await app.inject({ method: 'GET', url: '/canonry/api/v1/projects', headers: { cookie: freshCookie } })).statusCode).toBe(200)
})

test('changing the dashboard password ends password-derived sessions while API-key sessions remain usable', async () => {
  const passwordCookie = await login({ password })
  const unusedPasswordCookie = await login({ password })
  const keyCookie = await login({ apiKey: key })
  const originalPasswordHash = config.dashboardPasswordHash
  const nextPassword = 'the-replacement-dashboard-password'
  config.dashboardPasswordHash = await hashUserPassword(nextPassword)
  await restart()

  expect((await app.inject({ method: 'GET', url: sessionPath, headers: { cookie: passwordCookie } })).json().authenticated).toBe(false)
  expect((await app.inject({ method: 'GET', url: '/canonry/api/v1/projects', headers: { cookie: passwordCookie } })).statusCode).toBe(401)
  expect((await app.inject({ method: 'GET', url: '/canonry/api/v1/projects', headers: { cookie: keyCookie } })).statusCode).toBe(200)
  expect((await app.inject({ method: 'POST', url: sessionPath, headers, payload: { password } })).statusCode).toBe(401)
  const freshCookie = await login({ password: nextPassword })
  expect((await app.inject({ method: 'GET', url: '/canonry/api/v1/projects', headers: { cookie: freshCookie } })).statusCode).toBe(200)

  config.dashboardPasswordHash = originalPasswordHash
  await restart()
  expect((await app.inject({ method: 'GET', url: '/canonry/api/v1/projects', headers: { cookie: unusedPasswordCookie } })).statusCode).toBe(401)
  const restoredPasswordCookie = await login({ password })
  expect((await app.inject({ method: 'GET', url: '/canonry/api/v1/projects', headers: { cookie: restoredPasswordCookie } })).statusCode).toBe(200)
})

test.each(['password', 'api-key'])('bootstrap key rotation ends old %s sessions without changing the bound key id', async mode => {
  const cookie = await login(mode === 'password' ? { password } : { apiKey: key })
  const unusedCookie = await login(mode === 'password' ? { password } : { apiKey: key })
  const nextKey = 'cnry_dashboard_rotated_root'
  await bootstrap(nextKey)
  expect(db.select().from(apiKeys).where(eq(apiKeys.id, 'root')).get()).toMatchObject({
    id: 'root', keyHash: crypto.createHash('sha256').update(nextKey).digest('hex'), revokedAt: null,
  })
  await restart()

  expect((await app.inject({ method: 'GET', url: sessionPath, headers: { cookie } })).json().authenticated).toBe(false)
  expect((await app.inject({ method: 'GET', url: '/canonry/api/v1/projects', headers: { cookie } })).statusCode).toBe(401)
  const freshCookie = await login(mode === 'password' ? { password } : { apiKey: nextKey })
  expect((await app.inject({ method: 'GET', url: '/canonry/api/v1/projects', headers: { cookie: freshCookie } })).statusCode).toBe(200)

  await bootstrap(key)
  await restart()
  expect((await app.inject({ method: 'GET', url: '/canonry/api/v1/projects', headers: { cookie: unusedCookie } })).statusCode).toBe(401)
  const restoredKeyCookie = await login(mode === 'password' ? { password } : { apiKey: key })
  expect((await app.inject({ method: 'GET', url: '/canonry/api/v1/projects', headers: { cookie: restoredKeyCookie } })).statusCode).toBe(200)
})

test('bootstrap restoration of a revoked key cannot revive a cookie that was unused during revocation', async () => {
  const cookie = await login({ apiKey: key })
  const revoker = 'cnry_dashboard_revoker'
  db.insert(apiKeys).values({
    id: 'revoker', name: 'revoker', keyHash: crypto.createHash('sha256').update(revoker).digest('hex'),
    keyPrefix: revoker.slice(0, 9), scopes: ['*'], createdAt: new Date().toISOString(),
  }).run()
  const revoked = await app.inject({
    method: 'POST', url: '/canonry/api/v1/keys/root/revoke',
    headers: { authorization: `Bearer ${revoker}` },
  })
  expect(revoked.statusCode).toBe(200)
  expect(db.select().from(apiKeys).where(eq(apiKeys.id, 'root')).get()?.revokedAt).not.toBeNull()
  await bootstrap()
  expect(db.select().from(apiKeys).where(eq(apiKeys.id, 'root')).get()).toMatchObject({
    id: 'root', keyHash: crypto.createHash('sha256').update(key).digest('hex'), revokedAt: null,
  })
  await restart()

  expect((await app.inject({ method: 'GET', url: sessionPath, headers: { cookie } })).json().authenticated).toBe(false)
  expect((await app.inject({ method: 'GET', url: '/canonry/api/v1/projects', headers: { cookie } })).statusCode).toBe(401)
  const freshCookie = await login({ apiKey: key })
  expect((await app.inject({ method: 'GET', url: '/canonry/api/v1/projects', headers: { cookie: freshCookie } })).statusCode).toBe(200)
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
