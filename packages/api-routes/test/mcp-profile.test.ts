import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { apiKeys, createClient, migrate, oauthClients, oauthTokens, users, type DatabaseClient } from '@canonry/canonry-db'
import { UserRoles, type McpProfileDto } from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

const PREFIX = '/team/api/v1'
const RESOURCE = `https://instance.example${PREFIX}/mcp`
const USER_ID = 'immutable-account-id'
const ACCESS_TOKEN = 'profile-oauth-access'
const ROOT_KEY = 'cnry_profile_root'
const DELEGATED_KEY = 'cnry_profile_delegated'
let directory: string
let db: DatabaseClient
let app: ReturnType<typeof Fastify>

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-mcp-profile-'))
  db = createClient(path.join(directory, 'fixture.db'))
  migrate(db)
  const createdAt = new Date().toISOString()
  db.insert(users).values({ id: USER_ID, name: 'Synthetic Reader', nameKey: 'synthetic reader', passwordHash: 'unused', role: UserRoles.admin, createdAt }).run()
  db.insert(oauthClients).values({ id: 'profile-client', name: 'Synthetic connector', redirectUris: ['https://client.example/callback'], createdAt }).run()
  db.insert(oauthTokens).values({
    tokenHash: hashApiKey(ACCESS_TOKEN), kind: 'access', clientId: 'profile-client', userId: USER_ID,
    resource: RESOURCE, scope: 'read offline_access', expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt,
  }).run()
  for (const [token, delegatedUserId] of [[ROOT_KEY, null], [DELEGATED_KEY, USER_ID]] as const) {
    db.insert(apiKeys).values({ id: crypto.randomUUID(), name: 'Synthetic key', keyHash: hashApiKey(token), keyPrefix: token.slice(0, 9), scopes: ['read'], delegatedUserId, createdAt }).run()
  }
  app = Fastify()
  await app.register(apiRoutes, {
    db, routePrefix: PREFIX, oauthResourceUrl: RESOURCE,
    registerAuthenticatedRoutes: scope => {
      scope.post('/mcp/profile', async () => ({ unexpected: true }))
      scope.get('/mcp/profile/extra', async () => ({ unexpected: true }))
    },
  })
})

afterEach(async () => {
  await app.close()
  fs.rmSync(directory, { recursive: true, force: true })
})

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

test('returns stable account identity and configured resource, without broadening the OAuth audience', async () => {
  const response = await app.inject({ url: `${PREFIX}/mcp/profile`, headers: bearer(ACCESS_TOKEN) })
  expect(response.statusCode).toBe(200)
  expect(response.headers['cache-control']).toBe('no-store')
  expect(response.json<McpProfileDto>()).toEqual({
    userId: USER_ID,
    displayName: 'Synthetic Reader',
    instance: { issuer: 'https://instance.example', resource: RESOURCE },
    scopes: ['read'],
  })
  for (const url of [`${PREFIX}/projects`, `${PREFIX}/users`, `${PREFIX}/keys/self`, `${PREFIX}/mcp/profile/extra`]) {
    const denied = await app.inject({ url, headers: bearer(ACCESS_TOKEN) })
    expect(denied.statusCode, url).toBe(401)
  }
  expect((await app.inject({ method: 'POST', url: `${PREFIX}/mcp/profile`, headers: bearer(ACCESS_TOKEN) })).statusCode).toBe(401)
  expect((await app.inject({ url: `${PREFIX}/mcp/profile` })).statusCode).toBe(401)
})

test('uses the current account name and authority for both OAuth and delegated MCP credentials', async () => {
  db.update(users).set({ name: 'Renamed Reader', nameKey: 'renamed reader', role: UserRoles.viewer }).where(eq(users.id, USER_ID)).run()
  for (const token of [ACCESS_TOKEN, DELEGATED_KEY]) {
    const response = await app.inject({ url: `${PREFIX}/mcp/profile`, headers: bearer(token) })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ userId: USER_ID, displayName: 'Renamed Reader', scopes: ['read'] })
  }
  db.delete(users).where(eq(users.id, USER_ID)).run()
  for (const token of [ACCESS_TOKEN, DELEGATED_KEY]) {
    expect((await app.inject({ url: `${PREFIX}/mcp/profile`, headers: bearer(token) })).statusCode).toBe(401)
  }
})

test('requires an actual person and read grant instead of reporting a key as a user', async () => {
  expect((await app.inject({ url: `${PREFIX}/mcp/profile`, headers: bearer(ROOT_KEY) })).statusCode).toBe(403)
  db.update(oauthTokens).set({ scope: 'research.run' }).where(eq(oauthTokens.tokenHash, hashApiKey(ACCESS_TOKEN))).run()
  expect((await app.inject({ url: `${PREFIX}/mcp/profile`, headers: bearer(ACCESS_TOKEN) })).statusCode).toBe(403)
  db.update(oauthTokens).set({ scope: 'read', resource: 'https://another.example/api/v1/mcp' }).where(eq(oauthTokens.tokenHash, hashApiKey(ACCESS_TOKEN))).run()
  expect((await app.inject({ url: `${PREFIX}/mcp/profile`, headers: bearer(ACCESS_TOKEN) })).statusCode).toBe(401)
})
