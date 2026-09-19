import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apiKeys, createClient, migrate, oauthClients, oauthTokens, projects, users, type DatabaseClient } from '@ainyc/canonry-db'
import { createUserSession, USER_SESSION_COOKIE_NAME } from '@ainyc/canonry-api-routes'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CanonryConfig } from '../src/config.js'
import { createServer } from '../src/server.js'

type Role = 'admin' | 'analyst' | 'viewer'

interface Built {
  app: Awaited<ReturnType<typeof createServer>>
  db: DatabaseClient
  keys: Record<string, string>
  cookies: Record<Role, string>
}

let tmpDir: string
let built: Built

function insertKey(db: DatabaseClient, name: string, scopes: string[], projectId?: string): string {
  const raw = `cnry_${crypto.randomBytes(24).toString('hex')}`
  db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    name,
    keyHash: crypto.createHash('sha256').update(raw).digest('hex'),
    keyPrefix: raw.slice(0, 9),
    scopes,
    ...(projectId ? { projectId } : {}),
    createdAt: new Date().toISOString(),
  }).run()
  return raw
}

function insertUser(db: DatabaseClient, role: Role): string {
  const id = crypto.randomUUID()
  db.insert(users).values({
    id,
    name: role,
    nameKey: role,
    passwordHash: 'test-password-hash',
    role,
    createdAt: new Date().toISOString(),
  }).run()
  return `${USER_SESSION_COOKIE_NAME}=${createUserSession(db, id)}`
}

async function buildServer(): Promise<Built> {
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  const projectId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId,
    name: 'scoped-project',
    displayName: 'Scoped project',
    canonicalDomain: 'scoped.example.test',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  const keys = {
    wildcard: insertKey(db, 'wildcard', ['*']),
    usersRead: insertKey(db, 'users-read', ['users.read']),
    usersWrite: insertKey(db, 'users-write', ['users.write']),
    read: insertKey(db, 'read', ['read']),
    unrelated: insertKey(db, 'unrelated', ['runs.write']),
    empty: insertKey(db, 'empty', []),
    scopedWildcard: insertKey(db, 'scoped-wildcard', ['*'], projectId),
    scopedUsersWrite: insertKey(db, 'scoped-users-write', ['users.write'], projectId),
  }
  const root = insertKey(db, 'server-root', ['*'])
  const config: CanonryConfig = {
    apiUrl: 'http://127.0.0.1:4100',
    database: dbPath,
    apiKey: root,
    publicUrl: 'https://canonry.example.test',
    providers: {},
  }
  const app = await createServer({ config, db, logger: false })
  return {
    app,
    db,
    keys,
    cookies: {
      admin: insertUser(db, 'admin'),
      analyst: insertUser(db, 'analyst'),
      viewer: insertUser(db, 'viewer'),
    },
  }
}

function insertClientWithTokens(db: DatabaseClient, id = crypto.randomUUID()): string {
  const now = new Date()
  const userId = db.select({ id: users.id }).from(users).get()?.id
  if (!userId) throw new Error('OAuth test tokens require a user subject.')
  db.insert(oauthClients).values({
    id,
    name: 'OAuth test client',
    secretHash: null,
    redirectUris: ['https://client.example.test/callback'],
    createdAt: now.toISOString(),
  }).run()
  for (const kind of ['access', 'refresh'] as const) {
    db.insert(oauthTokens).values({
      tokenHash: crypto.randomBytes(32).toString('hex'),
      kind,
      clientId: id,
      userId,
      userAuthVersion: 0,
      resource: 'https://canonry.example.test/api/v1/mcp',
      scope: 'read',
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      createdAt: now.toISOString(),
    }).run()
  }
  return id
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-oauth-admin-access-'))
  built = await buildServer()
})

afterEach(async () => {
  await built?.app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('OAuth client administration', () => {
  it('lists OAuth clients for a signed-in administrator', async () => {
    insertClientWithTokens(built.db)
    const response = await built.app.inject({
      method: 'GET',
      url: '/api/v1/oauth/clients',
      headers: { cookie: built.cookies.admin },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json<{ clients: unknown[] }>().clients).toHaveLength(1)
  })

  it.each(['wildcard', 'usersRead', 'usersWrite'] as const)(
    'lists OAuth clients for the permitted full-instance %s key',
    async (key) => {
      insertClientWithTokens(built.db)
      const response = await built.app.inject({
        method: 'GET',
        url: '/api/v1/oauth/clients',
        headers: { authorization: `Bearer ${built.keys[key]}` },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json<{ clients: unknown[] }>().clients).toHaveLength(1)
    },
  )

  it.each([
    { name: 'viewer', headers: () => ({ cookie: built.cookies.viewer }) },
    { name: 'analyst', headers: () => ({ cookie: built.cookies.analyst }) },
    { name: 'read key', headers: () => ({ authorization: `Bearer ${built.keys.read}` }) },
    { name: 'unrelated key', headers: () => ({ authorization: `Bearer ${built.keys.unrelated}` }) },
    { name: 'empty-scope key', headers: () => ({ authorization: `Bearer ${built.keys.empty}` }) },
    { name: 'project-scoped wildcard key', headers: () => ({ authorization: `Bearer ${built.keys.scopedWildcard}` }) },
    { name: 'project-scoped users.write key', headers: () => ({ authorization: `Bearer ${built.keys.scopedUsersWrite}` }) },
  ])('refuses OAuth-client listing to $name', async ({ headers }) => {
    insertClientWithTokens(built.db)
    const response = await built.app.inject({ method: 'GET', url: '/api/v1/oauth/clients', headers: headers() })
    expect(response.statusCode).toBe(403)
  })

  it.each([
    { name: 'viewer', headers: () => ({ cookie: built.cookies.viewer }) },
    { name: 'analyst', headers: () => ({ cookie: built.cookies.analyst }) },
    { name: 'users.read key', headers: () => ({ authorization: `Bearer ${built.keys.usersRead}` }) },
    { name: 'read key', headers: () => ({ authorization: `Bearer ${built.keys.read}` }) },
    { name: 'unrelated key', headers: () => ({ authorization: `Bearer ${built.keys.unrelated}` }) },
    { name: 'empty-scope key', headers: () => ({ authorization: `Bearer ${built.keys.empty}` }) },
    { name: 'project-scoped wildcard key', headers: () => ({ authorization: `Bearer ${built.keys.scopedWildcard}` }) },
    { name: 'project-scoped users.write key', headers: () => ({ authorization: `Bearer ${built.keys.scopedUsersWrite}` }) },
  ])('refuses OAuth-client revocation to $name without changing the client or tokens', async ({ headers }) => {
    const clientId = insertClientWithTokens(built.db)
    const response = await built.app.inject({
      method: 'DELETE',
      url: `/api/v1/oauth/clients/${clientId}`,
      headers: headers(),
    })
    expect(response.statusCode).toBe(403)
    expect(built.db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).get()?.revokedAt).toBeNull()
    expect(built.db.select().from(oauthTokens).where(eq(oauthTokens.clientId, clientId)).all().map(token => token.revokedAt)).toEqual([null, null])
  })

  it.each(['wildcard', 'usersWrite'] as const)(
    'revokes an OAuth client and all of its tokens for the permitted %s key',
    async (key) => {
      const clientId = insertClientWithTokens(built.db)
      const response = await built.app.inject({
        method: 'DELETE',
        url: `/api/v1/oauth/clients/${clientId}`,
        headers: { authorization: `Bearer ${built.keys[key]}` },
      })
      expect(response.statusCode).toBe(200)
      expect(built.db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).get()?.revokedAt).toBeTruthy()
      expect(built.db.select().from(oauthTokens).where(eq(oauthTokens.clientId, clientId)).all().every(token => token.revokedAt)).toBe(true)
    },
  )

  it('revokes an OAuth client and all of its tokens for a signed-in administrator', async () => {
    const clientId = insertClientWithTokens(built.db)
    const response = await built.app.inject({
      method: 'DELETE',
      url: `/api/v1/oauth/clients/${clientId}`,
      headers: { cookie: built.cookies.admin, host: '127.0.0.1:4100', origin: 'http://127.0.0.1:4100' },
    })
    expect(response.statusCode).toBe(200)
    expect(built.db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).get()?.revokedAt).toBeTruthy()
    expect(built.db.select().from(oauthTokens).where(eq(oauthTokens.clientId, clientId)).all().every(token => token.revokedAt)).toBe(true)
  })
})
