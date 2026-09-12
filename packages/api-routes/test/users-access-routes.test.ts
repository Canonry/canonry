import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  apiKeys,
  createClient,
  migrate,
  users,
  userSessions,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { UserRoles, UserStatuses } from '@ainyc/canonry-contracts'
import { userRoutes } from '../src/users.js'

let dir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-user-routes-'))
  db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  db.insert(users).values({
    id: 'admin', name: 'admin', nameKey: 'admin', passwordHash: 'password-digest',
    role: UserRoles.admin, createdAt: '2026-09-11T00:00:00.000Z', permissionsMigrated: true,
  }).run()
  db.insert(users).values({
    id: 'analyst', name: 'analyst', nameKey: 'analyst', passwordHash: 'password-digest',
    role: UserRoles.analyst, createdAt: '2026-09-11T00:00:00.000Z', permissionsMigrated: true,
  }).run()
  db.insert(userSessions).values({ tokenHash: 'session', userId: 'analyst', createdAt: '2026-09-11T00:00:00.000Z', expiresAt: '2026-09-12T00:00:00.000Z' }).run()
  app = Fastify()
  app.decorate('db', db)
  app.addHook('onRequest', async (request) => {
    if (request.headers['x-test-stale-key'] !== '1') return
    request.principal = {
      kind: 'api-key', id: 'revoked-admin-key', name: 'revoked', scopes: ['users.write'],
      projectId: null, viaCookie: false,
    }
  })
  await app.register(userRoutes)
  await app.ready()
})

afterEach(async () => {
  await app.close()
  db.$client.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('role/status updates return safe metadata and revoke active browser access', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: '/users/analyst',
    payload: { status: UserStatuses.suspended, displayName: 'Analyst' },
  })

  expect(res.statusCode).toBe(200)
  expect(JSON.parse(res.body)).toMatchObject({
    id: 'analyst', role: UserRoles.analyst, status: UserStatuses.suspended,
    displayName: 'Analyst', hasPassword: true, authVersion: 1,
  })
  expect(JSON.parse(res.body)).not.toHaveProperty('passwordHash')
  expect(db.select().from(userSessions).where(eq(userSessions.userId, 'analyst')).all()).toEqual([])
})

test('the last active password administrator cannot be demoted or suspended', async () => {
  const demote = await app.inject({ method: 'PATCH', url: '/users/admin', payload: { role: UserRoles.analyst } })
  const suspend = await app.inject({ method: 'PATCH', url: '/users/admin', payload: { status: UserStatuses.suspended } })

  expect(demote.statusCode).toBe(400)
  expect(suspend.statusCode).toBe(400)
  expect(db.select().from(users).where(eq(users.id, 'admin')).get()).toMatchObject({
    role: UserRoles.admin,
    status: UserStatuses.active,
  })
})

test('account creation revalidates a revoked key after password hashing', async () => {
  db.insert(apiKeys).values({
    id: 'revoked-admin-key', name: 'revoked', keyHash: 'hash', keyPrefix: 'prefix',
    scopes: ['users.write'], createdAt: '2026-09-11T00:00:00.000Z',
    revokedAt: '2026-09-11T00:00:01.000Z',
  }).run()

  const response = await app.inject({
    method: 'POST',
    url: '/users',
    headers: { 'x-test-stale-key': '1' },
    payload: { name: 'blocked', password: 'a sufficiently long password', role: UserRoles.viewer },
  })

  expect(response.statusCode).toBe(403)
  expect(db.select().from(users).where(eq(users.nameKey, 'blocked')).get()).toBeUndefined()
})
