import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, expect, test } from 'vitest'
import {
  apiKeys,
  createClient,
  googleLoginTransactions,
  migrate,
  users,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { AppError, UserRoles, UserStatuses, type GoogleSignInConfig } from '@ainyc/canonry-contracts'
import { createNamedUserSession, USER_SESSION_COOKIE_NAME } from '../src/user-session.js'
import { revokeUserAccess } from '../src/user-access.js'
import { authPlugin } from '../src/auth.js'
import { googleSignInSettingsRoutes } from '../src/google-sign-in-settings.js'

const contexts: Array<{ app: ReturnType<typeof Fastify>; db: DatabaseClient; dir: string }> = []

function build(config: GoogleSignInConfig, overrides: { environmentOverride?: boolean; writable?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-google-settings-'))
  const db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  db.insert(users).values({
    id: 'admin', name: 'admin', nameKey: 'admin', passwordHash: 'password-digest', role: UserRoles.admin,
    permissionsMigrated: true, createdAt: now,
  }).run()
  const key = `cnry_${crypto.randomBytes(32).toString('base64url')}`
  db.insert(apiKeys).values({
    id: 'root', name: 'root', keyHash: crypto.createHash('sha256').update(key).digest('hex'),
    keyPrefix: key.slice(0, 9), scopes: ['*'], createdAt: now,
  }).run()
  const app = Fastify()
  app.decorate('db', db)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.status(error.statusCode).send(error.toJSON())
    return reply.send(error)
  })
  const state = { value: config, writes: 0 }
  const googleSignIn = {
    getConfig: () => state.value,
    ...(overrides.writable === false ? {} : { updateConfig: async (value: GoogleSignInConfig) => { state.value = value; state.writes++ } }),
    publicUrl: 'https://canonry.example.test/control/',
    basePath: '/control/',
    environmentOverride: overrides.environmentOverride,
  }
  contexts.push({ app, db, dir })
  return { app, db, key, state, googleSignIn }
}

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.app.close()
    context.db.$client.close()
    fs.rmSync(context.dir, { recursive: true, force: true })
  }
})

test('reports safe Google configuration and replaces, never returns, the client secret', async () => {
  const ctx = build({ enabled: false, clientId: 'old-client', clientSecret: 'old-secret' })
  await authPlugin(ctx.app)
  await googleSignInSettingsRoutes(ctx.app, { googleSignIn: ctx.googleSignIn })
  await ctx.app.ready()

  const before = await ctx.app.inject({ method: 'GET', url: '/settings/auth/google', headers: { authorization: `Bearer ${ctx.key}` } })
  expect(before.statusCode).toBe(200)
  expect(JSON.parse(before.body)).toEqual(expect.objectContaining({
    configured: true, enabled: false, clientId: 'old-client', hasClientSecret: true,
    callbackUrl: 'https://canonry.example.test/control/api/v1/auth/google/callback',
  }))
  expect(before.body).not.toContain('old-secret')

  ctx.db.insert(googleLoginTransactions).values({ stateHash: 'transaction', expiresAt: '2099-01-01T00:00:00.000Z' }).run()
  const put = await ctx.app.inject({
    method: 'PUT', url: '/settings/auth/google', headers: { authorization: `Bearer ${ctx.key}` },
    payload: { enabled: true, clientId: 'new-client', clientSecret: 'new-secret' },
  })
  expect(put.statusCode).toBe(200)
  expect(ctx.state.value).toEqual({ enabled: true, clientId: 'new-client', clientSecret: 'new-secret' })
  expect(ctx.state.writes).toBe(1)
  expect(ctx.db.select().from(googleLoginTransactions).all()).toEqual([])
  expect(put.body).not.toContain('new-secret')
})

test('fails closed when configuration is environment-managed or has no update callback', async () => {
  const ctx = build({ enabled: false }, { environmentOverride: true })
  await authPlugin(ctx.app)
  await googleSignInSettingsRoutes(ctx.app, { googleSignIn: ctx.googleSignIn })
  await ctx.app.ready()
  const response = await ctx.app.inject({
    method: 'PUT', url: '/settings/auth/google', headers: { authorization: `Bearer ${ctx.key}` }, payload: { enabled: false },
  })
  expect(response.statusCode).toBe(403)
  expect(ctx.state.writes).toBe(0)
})

test('disabling Google sign-in refuses to strand the install without password-admin recovery', async () => {
  const ctx = build({ enabled: true, clientId: 'client', clientSecret: 'secret' })
  await authPlugin(ctx.app)
  await googleSignInSettingsRoutes(ctx.app, { googleSignIn: ctx.googleSignIn })
  await ctx.app.ready()
  ctx.db.update(users).set({ status: UserStatuses.suspended }).where(eq(users.id, 'admin')).run()
  const response = await ctx.app.inject({
    method: 'PUT', url: '/settings/auth/google', headers: { authorization: `Bearer ${ctx.key}` }, payload: { enabled: false },
  })
  expect(response.statusCode).toBe(400)
  expect(ctx.state.value.enabled).toBe(true)
  expect(ctx.state.writes).toBe(0)
})

test('restores host config when the caller is revoked during an async write', async () => {
  const original = { enabled: false, clientId: 'old-client', clientSecret: 'old-secret' }
  const ctx = build(original)
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  ctx.googleSignIn.updateConfig = async (value: GoogleSignInConfig) => {
    ctx.state.value = value
    ctx.state.writes++
    if (ctx.state.writes === 1) {
      entered()
      await waiting
    }
  }
  await authPlugin(ctx.app)
  await googleSignInSettingsRoutes(ctx.app, { googleSignIn: ctx.googleSignIn })
  await ctx.app.ready()

  const pending = ctx.app.inject({
    method: 'PUT', url: '/settings/auth/google', headers: { authorization: `Bearer ${ctx.key}` },
    payload: { clientId: 'new-client' },
  })
  await started
  ctx.db.update(apiKeys).set({ revokedAt: new Date().toISOString() }).where(eq(apiKeys.id, 'root')).run()
  release()

  const response = await pending
  expect(response.statusCode).toBe(403)
  expect(ctx.state.value).toEqual(original)
  expect(ctx.state.writes).toBe(2)
})


test('restores configuration when a browser administrator session is revoked during a save', async () => {
  const original = { enabled: true, clientId: crypto.randomUUID(), clientSecret: crypto.randomUUID() }
  const ctx = build(original)
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  ctx.googleSignIn.updateConfig = async (value: GoogleSignInConfig) => {
    ctx.state.value = value
    ctx.state.writes++
    if (ctx.state.writes === 1) { entered(); await waiting }
  }
  await authPlugin(ctx.app)
  await googleSignInSettingsRoutes(ctx.app, { googleSignIn: ctx.googleSignIn })
  await ctx.app.ready()
  const session = createNamedUserSession(ctx.db, 'admin', 0)!
  const pending = ctx.app.inject({
    method: 'PUT', url: '/settings/auth/google',
    headers: { cookie: USER_SESSION_COOKIE_NAME + '=' + session.token, origin: 'http://localhost', host: 'localhost' },
    payload: { clientId: crypto.randomUUID() },
  })
  await started
  ctx.db.transaction(tx => revokeUserAccess(tx, 'admin'))
  release()
  expect((await pending).statusCode).toBe(403)
  expect(ctx.state.value).toEqual(original)
})


test('exposes the callback URL before client credentials are configured', async () => {
  const ctx = build({ enabled: false })
  await authPlugin(ctx.app)
  await googleSignInSettingsRoutes(ctx.app, { googleSignIn: ctx.googleSignIn })
  await ctx.app.ready()
  const response = await ctx.app.inject({
    method: 'GET', url: '/settings/auth/google', headers: { authorization: 'Bearer ' + ctx.key },
  })
  const callback = new URL('api/v1/auth/google/callback', ctx.googleSignIn.publicUrl).href
  expect(response.statusCode).toBe(200)
  expect(response.json()).toMatchObject({ enabled: false, configured: false, hasClientSecret: false, clientId: null, callbackUrl: callback })
})
