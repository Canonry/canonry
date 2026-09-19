import crypto from 'node:crypto'
import Fastify from 'fastify'
import { and, eq, isNull } from 'drizzle-orm'
import { afterEach, expect, test } from 'vitest'
import {
  apiKeys,
  auditLog,
  createClient,
  migrate,
  oauthAuthorizationCodes,
  oauthClients,
  oauthTokens,
  userExternalIdentities,
  users,
  userSessions,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { AppError, UserRoles, USER_ACTIVITY_INTERVAL_MS } from '@ainyc/canonry-contracts'
import { authPlugin } from '../src/auth.js'
import { userAccountDetailsRoutes } from '../src/user-account-details.js'
import { createNamedUserSession, USER_SESSION_COOKIE_NAME } from '../src/user-session.js'

const ORIGIN = 'https://console.example.test'
const contexts: Array<{ app: ReturnType<typeof Fastify>; db: DatabaseClient }> = []

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.app.close()
    context.db.$client.close()
  }
})

function browserHeaders(token: string, extra: Record<string, string> = {}) {
  return {
    cookie: `${USER_SESSION_COOKIE_NAME}=${token}`,
    origin: ORIGIN,
    host: 'console.example.test',
    ...extra,
  }
}

function seedUser(db: DatabaseClient, input: {
  id?: string
  name?: string
  displayName?: string | null
  password?: boolean
  role?: 'admin' | 'analyst' | 'viewer'
}) {
  const id = input.id ?? crypto.randomUUID()
  const name = input.name ?? `person-${id}`
  db.insert(users).values({
    id,
    name,
    nameKey: name,
    displayName: input.displayName,
    passwordHash: input.password === false ? null : `digest-${id}`,
    role: input.role ?? UserRoles.analyst,
    permissionsMigrated: true,
    createdAt: new Date().toISOString(),
  }).run()
  return id
}

function seedGoogleIdentity(db: DatabaseClient, userId: string, email = `${crypto.randomUUID()}@example.test`) {
  const id = crypto.randomUUID()
  db.insert(userExternalIdentities).values({
    id,
    userId,
    issuer: `https://issuer.example.test/${crypto.randomUUID()}`,
    subject: crypto.randomUUID(),
    email,
    createdAt: new Date().toISOString(),
  }).run()
  return id
}

async function fixture() {
  const db = createClient(':memory:')
  migrate(db)
  const app = Fastify()
  app.decorate('db', db)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.status(error.statusCode).send(error.toJSON())
    return reply.send(error)
  })
  contexts.push({ app, db })
  await authPlugin(app)
  await userAccountDetailsRoutes(app, {
    googleSignIn: { getConfig: () => ({ enabled: true, clientId: 'client', clientSecret: 'secret' }), publicUrl: ORIGIN },
  })
  await app.ready()

  const sessionFor = (userId: string) => {
    const user = db.select().from(users).where(eq(users.id, userId)).get()!
    return createNamedUserSession(db, userId, user.authVersion)!.token
  }
  return { app, db, sessionFor }
}

test('lists only the caller’s safe sign-in method metadata', async () => {
  const f = await fixture()
  const ownerId = seedUser(f.db, { name: 'owner', displayName: 'Owner', password: true })
  const ownIdentityId = seedGoogleIdentity(f.db, ownerId, 'owner@example.test')
  const ownIdentity = f.db.select().from(userExternalIdentities).where(eq(userExternalIdentities.id, ownIdentityId)).get()!
  const otherId = seedUser(f.db, { name: 'other', password: false })
  seedGoogleIdentity(f.db, otherId, 'other@example.test')

  const response = await f.app.inject({ method: 'GET', url: '/auth/methods', headers: browserHeaders(f.sessionFor(ownerId)) })

  expect(response.statusCode).toBe(200)
  expect(response.headers['cache-control']).toBe('no-store')
  expect(response.json()).toEqual({ methods: [
    expect.objectContaining({ id: 'password', provider: 'password', email: null }),
    expect.objectContaining({ id: ownIdentityId, provider: 'google', email: 'owner@example.test' }),
  ] })
  expect(response.body).not.toContain('other@example.test')
  expect(response.body).not.toContain(ownerId)
  expect(response.body).not.toContain('https://issuer.example.test/')
  expect(response.body).not.toContain(ownIdentity.subject)
  expect(response.body).not.toContain('digest-')
})

test('refuses unlinking the last usable Google method for a Google-only account', async () => {
  const f = await fixture()
  const userId = seedUser(f.db, { password: false })
  const identityId = seedGoogleIdentity(f.db, userId)
  const session = f.sessionFor(userId)

  const response = await f.app.inject({
    method: 'DELETE',
    url: `/auth/methods/${identityId}`,
    headers: browserHeaders(session),
  })

  expect(response.statusCode).toBe(400)
  expect(f.db.select().from(userExternalIdentities).where(eq(userExternalIdentities.id, identityId)).get()).toBeDefined()
  expect(f.db.select().from(userSessions).where(eq(userSessions.userId, userId)).get()).toBeDefined()
})

test('a password-backed unlink revokes browser, OAuth, and delegated access', async () => {
  const f = await fixture()
  const userId = seedUser(f.db, { password: true })
  const identityId = seedGoogleIdentity(f.db, userId)
  const currentSession = f.sessionFor(userId)
  f.sessionFor(userId)
  const clientId = crypto.randomUUID()
  const now = new Date().toISOString()
  f.db.insert(oauthClients).values({ id: clientId, name: 'client', redirectUris: [], createdAt: now }).run()
  f.db.insert(oauthAuthorizationCodes).values({
    codeHash: crypto.randomUUID(), clientId, userId, redirectUri: 'https://client.example.test/callback',
    codeChallenge: 'challenge', expiresAt: '2099-01-01T00:00:00.000Z', createdAt: now,
  }).run()
  f.db.insert(oauthTokens).values({
    tokenHash: crypto.randomUUID(), kind: 'access', clientId, userId,
    expiresAt: '2099-01-01T00:00:00.000Z', createdAt: now,
  }).run()
  f.db.insert(apiKeys).values({
    id: crypto.randomUUID(), name: 'delegated', keyHash: crypto.randomUUID(), keyPrefix: 'delegated', scopes: ['read'],
    delegatedUserId: userId, delegatedUserAuthVersion: 0, createdAt: now,
  }).run()
  f.db.insert(apiKeys).values({
    id: crypto.randomUUID(), name: 'service', keyHash: crypto.randomUUID(), keyPrefix: 'service', scopes: ['*'], createdAt: now,
  }).run()

  const response = await f.app.inject({
    method: 'DELETE',
    url: `/auth/methods/${identityId}`,
    headers: browserHeaders(currentSession),
  })

  expect(response.statusCode).toBe(200)
  expect(response.json()).toEqual({ ok: true })
  expect(f.db.select().from(userExternalIdentities).where(eq(userExternalIdentities.id, identityId)).get()).toBeUndefined()
  expect(f.db.select().from(users).where(eq(users.id, userId)).get()?.authVersion).toBe(1)
  expect(f.db.select().from(userSessions).where(eq(userSessions.userId, userId)).all()).toEqual([])
  expect(f.db.select().from(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.userId, userId)).all()).toEqual([])
  expect(f.db.select().from(oauthTokens).where(eq(oauthTokens.userId, userId)).get()?.revokedAt).not.toBeNull()
  expect(f.db.select().from(apiKeys).where(eq(apiKeys.delegatedUserId, userId)).get()?.revokedAt).not.toBeNull()
  expect(f.db.select().from(apiKeys).where(and(eq(apiKeys.name, 'service'), isNull(apiKeys.revokedAt))).get()).toBeDefined()
})

test('foreground activity is throttled and will not overwrite activity after an auth-version race', async () => {
  const f = await fixture()
  const userId = seedUser(f.db, { password: true })
  const session = f.sessionFor(userId)

  const first = await f.app.inject({ method: 'POST', url: '/auth/activity', headers: browserHeaders(session) })
  expect(first.statusCode).toBe(200)
  const firstSeenAt = f.db.select().from(users).where(eq(users.id, userId)).get()?.lastSeenAt
  expect(firstSeenAt).not.toBeNull()

  const second = await f.app.inject({ method: 'POST', url: '/auth/activity', headers: browserHeaders(session) })
  expect(second.statusCode).toBe(200)
  expect(f.db.select().from(users).where(eq(users.id, userId)).get()?.lastSeenAt).toBe(firstSeenAt)

  const oldSeenAt = new Date(Date.now() - USER_ACTIVITY_INTERVAL_MS - 1).toISOString()
  f.db.update(users).set({ lastSeenAt: oldSeenAt }).where(eq(users.id, userId)).run()
  const originalUpdate = f.db.update.bind(f.db)
  const originalDescriptor = Object.getOwnPropertyDescriptor(f.db, 'update')
  let raced = false
  Object.defineProperty(f.db, 'update', {
    configurable: true,
    value: (table: typeof users) => {
      if (!raced && table === users) {
        raced = true
        originalUpdate(users).set({ authVersion: 1 }).where(eq(users.id, userId)).run()
      }
      return originalUpdate(table)
    },
  })
  let racedRequest
  try {
    racedRequest = await f.app.inject({ method: 'POST', url: '/auth/activity', headers: browserHeaders(session) })
  } finally {
    if (originalDescriptor) Object.defineProperty(f.db, 'update', originalDescriptor)
    else Reflect.deleteProperty(f.db, 'update')
  }

  expect(racedRequest!.statusCode).toBe(200)
  expect(raced).toBe(true)
  expect(f.db.select().from(users).where(eq(users.id, userId)).get()).toMatchObject({ authVersion: 1, lastSeenAt: oldSeenAt })
})

test('admin history preserves the recorded actor despite caller trace headers', async () => {
  const f = await fixture()
  const adminId = seedUser(f.db, { name: 'admin', role: UserRoles.admin, password: true })
  const memberId = seedUser(f.db, { name: 'member', displayName: 'Stable member', password: true })
  const identityId = seedGoogleIdentity(f.db, memberId)
  const memberSession = f.sessionFor(memberId)

  const unlink = await f.app.inject({
    method: 'DELETE',
    url: `/auth/methods/${identityId}`,
    headers: browserHeaders(memberSession, {
      'x-canonry-actor-session': 'untrusted-trace',
      'x-canonry-actor-name': 'untrusted-name',
    }),
  })
  expect(unlink.statusCode).toBe(200)

  const stored = f.db.select().from(auditLog).where(and(
    eq(auditLog.entityType, 'user'), eq(auditLog.entityId, memberId), eq(auditLog.action, 'user.google-unlinked'),
  )).get()!
  expect(stored).toMatchObject({ actor: 'api', actorUserId: memberId, actorName: 'Stable member', actorSession: null })

  const history = await f.app.inject({
    method: 'GET',
    url: `/users/${memberId}/access-history`,
    headers: browserHeaders(f.sessionFor(adminId), { 'x-canonry-actor-session': 'different-untrusted-trace' }),
  })

  expect(history.statusCode).toBe(200)
  expect(history.headers['cache-control']).toBe('no-store')
  expect(history.json()).toEqual({ events: expect.arrayContaining([expect.objectContaining({
    id: stored.id, action: 'user.google-unlinked', actorUserId: memberId, actorName: 'Stable member',
  })]) })
  expect(history.body).not.toContain('untrusted-trace')
  expect(history.body).not.toContain('untrusted-name')
})
