import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  apiKeys,
  createClient,
  migrate,
  projects,
  userExternalIdentities,
  userInvitations,
  users,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { AppError, UserRoles } from '@ainyc/canonry-contracts'
import { authPlugin } from '../src/auth.js'
import { userInvitationRoutes } from '../src/user-invitations.js'

let dir: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>
let rootKey: string
let configCalls = 0

function addKey(scopes: string[], projectId?: string): string {
  const raw = `cnry_${crypto.randomBytes(32).toString('base64url')}`
  db.insert(apiKeys).values({
    id: crypto.randomUUID(), name: 'test key', keyHash: crypto.createHash('sha256').update(raw).digest('hex'),
    keyPrefix: raw.slice(0, 9), scopes, projectId, createdAt: new Date().toISOString(),
  }).run()
  return raw
}

beforeEach(async () => {
  configCalls = 0
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-invitation-routes-'))
  db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  db.insert(users).values({
    id: 'admin', name: 'admin', nameKey: 'admin', passwordHash: 'password-digest',
    role: UserRoles.admin, permissionsMigrated: true, createdAt: now,
  }).run()
  db.insert(projects).values({
    id: 'project', name: 'project', displayName: 'Project', canonicalDomain: 'example.test',
    country: 'US', language: 'en', createdAt: now, updatedAt: now,
  }).run()
  rootKey = addKey(['*'])
  app = Fastify()
  app.decorate('db', db)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.status(error.statusCode).send(error.toJSON())
    return reply.send(error)
  })
  await authPlugin(app)
  await userInvitationRoutes(app, {
    googleSignIn: {
      getConfig: () => {
        configCalls++
        return { enabled: true, clientId: 'client', clientSecret: 'secret' }
      },
      publicUrl: 'https://canonry.example.test/control/',
      basePath: '/control/',
    },
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
  db.$client.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('stores only a SHA-256 token digest and returns a fragment-only invitation link', async () => {
  const response = await app.inject({
    method: 'POST', url: '/users/invitations', headers: { authorization: `Bearer ${rootKey}` },
    payload: { email: 'Person@Example.test', role: UserRoles.analyst },
  })

  expect(response.statusCode).toBe(201)
  const body = JSON.parse(response.body) as { invitationUrl: string; invitation: { id: string; status: string } }
  const link = new URL(body.invitationUrl)
  const token = link.hash.slice('#invitation='.length)
  expect(link.pathname).toBe('/control/')
  expect(link.search).toBe('')
  expect(token).toHaveLength(43)
  const stored = db.select().from(userInvitations).where(eq(userInvitations.id, body.invitation.id)).get()!
  expect(stored.tokenHash).toBe(crypto.createHash('sha256').update(token).digest('hex'))
  expect(JSON.stringify(stored)).not.toContain(token)
  expect(body.invitation.status).toBe('pending')
})

test('revokes an expired pending invitation atomically before issuing a replacement invite', async () => {
  const now = new Date().toISOString()
  db.insert(userInvitations).values({
    id: 'expired', email: 'same@example.test', emailKey: 'same@example.test', role: UserRoles.viewer,
    tokenHash: crypto.createHash('sha256').update('old').digest('hex'), createdAt: now,
    expiresAt: '2020-01-01T00:00:00.000Z',
  }).run()

  const response = await app.inject({
    method: 'POST', url: '/users/invitations', headers: { authorization: `Bearer ${rootKey}` },
    payload: { email: ' SAME@example.test ', role: UserRoles.viewer },
  })
  expect(response.statusCode).toBe(201)
  expect(db.select().from(userInvitations).where(eq(userInvitations.id, 'expired')).get()?.revokedAt).toBeTruthy()
  expect(db.select().from(userInvitations).where(eq(userInvitations.emailKey, 'same@example.test')).all()).toHaveLength(2)
})

test('refuses project-scoped keys before it reads Google config or changes invitations', async () => {
  const scopedKey = addKey(['*'], 'project')
  const response = await app.inject({
    method: 'POST', url: '/users/invitations', headers: { authorization: `Bearer ${scopedKey}` },
    payload: { email: 'person@example.test', role: UserRoles.viewer },
  })
  expect(response.statusCode).toBe(403)
  expect(configCalls).toBe(0)
  expect(db.select().from(userInvitations).all()).toEqual([])
})

test('replacement invalidates the prior link and accepted or revoked invitations cannot be replaced', async () => {
  const create = await app.inject({
    method: 'POST', url: '/users/invitations', headers: { authorization: `Bearer ${rootKey}` },
    payload: { email: 'person@example.test', role: UserRoles.viewer },
  })
  const id = (JSON.parse(create.body) as { invitation: { id: string } }).invitation.id
  const before = db.select().from(userInvitations).where(eq(userInvitations.id, id)).get()!
  const replacement = await app.inject({ method: 'POST', url: `/users/invitations/${id}/replace`, headers: { authorization: `Bearer ${rootKey}` } })
  expect(replacement.statusCode).toBe(200)
  const after = db.select().from(userInvitations).where(eq(userInvitations.id, id)).get()!
  expect(after.tokenHash).not.toBe(before.tokenHash)
  await app.inject({ method: 'POST', url: `/users/invitations/${id}/revoke`, headers: { authorization: `Bearer ${rootKey}` } })
  const denied = await app.inject({ method: 'POST', url: `/users/invitations/${id}/replace`, headers: { authorization: `Bearer ${rootKey}` } })
  expect(denied.statusCode).toBe(400)
})

test('does not invite email addresses already attached to a user or external identity', async () => {
  db.insert(userExternalIdentities).values({
    id: 'identity', userId: 'admin', issuer: 'https://accounts.google.com', subject: 'person',
    email: 'Person@Example.test', createdAt: new Date().toISOString(),
  }).run()
  const response = await app.inject({
    method: 'POST', url: '/users/invitations', headers: { authorization: `Bearer ${rootKey}` },
    payload: { email: 'person@example.test', role: UserRoles.viewer },
  })
  expect(response.statusCode).toBe(400)
  expect(db.select().from(userInvitations).where(and(eq(userInvitations.emailKey, 'person@example.test'))).all()).toEqual([])
})
