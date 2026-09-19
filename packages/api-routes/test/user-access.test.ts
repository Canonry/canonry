import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  apiKeys,
  createClient,
  migrate,
  oauthAuthorizationCodes,
  oauthClients,
  oauthTokens,
  userAuthState,
  users,
  userSessions,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { UserRoles } from '@ainyc/canonry-contracts'
import { initializeUserAccess, namedAuthenticationRequired, revokeUserAccess } from '../src/user-access.js'

let dir: string
let db: DatabaseClient

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-user-access-'))
  db = createClient(path.join(dir, 'test.db'))
  migrate(db)
})

afterEach(() => {
  db.$client.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function seedUser(id: string, role = UserRoles.viewer) {
  db.insert(users).values({
    id,
    name: id,
    nameKey: id,
    passwordHash: 'stored-password-digest',
    role,
    createdAt: '2026-09-11T00:00:00.000Z',
  }).run()
}

test('permission migration is one-time and preserves the protected-instance state', () => {
  seedUser('viewer')
  initializeUserAccess(db, true)

  expect(db.select().from(users).where(eq(users.id, 'viewer')).get()).toMatchObject({
    role: UserRoles.analyst,
    permissionsMigrated: true,
  })
  expect(namedAuthenticationRequired(db)).toBe(true)
  expect(db.select().from(userAuthState).get()).toMatchObject({ permissionsMigrationComplete: true })

  initializeUserAccess(db, false)
  expect(db.select().from(users).where(eq(users.id, 'viewer')).get()?.role).toBe(UserRoles.analyst)

  // A row introduced after the durable completion marker (for example by a
  // briefly rolled-back binary) must not cause the deployment flag to be read
  // as a fresh grant.
  seedUser('late-viewer')
  initializeUserAccess(db, true)
  expect(db.select().from(users).where(eq(users.id, 'late-viewer')).get()).toMatchObject({
    role: UserRoles.viewer,
    permissionsMigrated: true,
  })
})

test('a fresh zero-account install retains API-key authentication mode', () => {
  initializeUserAccess(db, false)
  expect(namedAuthenticationRequired(db)).toBe(false)
})

test('revoking a user invalidates every user-bound credential and leaves service keys intact', () => {
  const now = '2026-09-11T01:00:00.000Z'
  seedUser('person', UserRoles.analyst)
  db.update(users).set({ authVersion: 7 }).where(eq(users.id, 'person')).run()
  db.insert(userSessions).values({ tokenHash: 'session', userId: 'person', createdAt: now, expiresAt: '2026-09-12T01:00:00.000Z' }).run()
  db.insert(oauthClients).values({ id: 'client', name: 'Client', redirectUris: [], createdAt: now }).run()
  db.insert(oauthAuthorizationCodes).values({
    codeHash: 'code', clientId: 'client', userId: 'person', redirectUri: 'https://client.example/callback',
    codeChallenge: 'challenge', expiresAt: '2026-09-12T01:00:00.000Z', createdAt: now,
  }).run()
  db.insert(oauthTokens).values({
    tokenHash: 'access', kind: 'access', clientId: 'client', userId: 'person', expiresAt: '2026-09-12T01:00:00.000Z', createdAt: now,
  }).run()
  db.insert(apiKeys).values({
    id: 'delegated', name: 'Delegated', keyHash: 'delegated-hash', keyPrefix: 'delegated', scopes: ['read'],
    delegatedUserId: 'person', delegatedUserAuthVersion: 7, createdAt: now,
  }).run()
  db.insert(apiKeys).values({
    id: 'service', name: 'Service', keyHash: 'service-hash', keyPrefix: 'service', scopes: ['*'], createdAt: now,
  }).run()

  revokeUserAccess(db, 'person', now)

  expect(db.select().from(users).where(eq(users.id, 'person')).get()?.authVersion).toBe(8)
  expect(db.select().from(userSessions).where(eq(userSessions.userId, 'person')).all()).toEqual([])
  expect(db.select().from(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.userId, 'person')).all()).toEqual([])
  expect(db.select().from(oauthTokens).where(eq(oauthTokens.userId, 'person')).get()?.revokedAt).toBe(now)
  expect(db.select().from(apiKeys).where(eq(apiKeys.id, 'delegated')).get()?.revokedAt).toBe(now)
  expect(db.select().from(apiKeys).where(and(eq(apiKeys.id, 'service'), isNull(apiKeys.revokedAt))).get()?.id).toBe('service')
})
