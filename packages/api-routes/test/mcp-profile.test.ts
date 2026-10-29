import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { apiKeys, createClient, migrate, oauthClients, oauthGrants, oauthTokens, users, type DatabaseClient } from '@canonry/canonry-db'
import { UserRoles, type McpProfileDto } from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'

const PREFIX = '/team/api/v1'
const RESOURCE = `https://instance.example${PREFIX}/mcp`
const USER_ID = 'immutable-account-id'
const GRANT_ID = 'profile-grant'
const ACCESS_TOKEN = 'profile-oauth-access'
const ROOT_KEY = 'cnry_profile_root'
const DELEGATED_KEY = 'cnry_profile_delegated'
let directory: string
let db: DatabaseClient
let app: FastifyInstance

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-mcp-profile-'))
  db = createClient(path.join(directory, 'fixture.db'))
  migrate(db)
  const createdAt = new Date().toISOString()
  db.insert(users).values({ id: USER_ID, name: 'Synthetic Reader', nameKey: 'synthetic reader', passwordHash: 'unused', role: UserRoles.admin, createdAt }).run()
  db.insert(oauthClients).values({ id: 'profile-client', name: 'Synthetic connector', redirectUris: ['https://client.example/callback'], createdAt }).run()
  db.insert(oauthGrants).values({ id: GRANT_ID, clientId: 'profile-client', userId: USER_ID, resource: RESOURCE, scope: 'read offline_access', createdAt }).run()
  db.insert(oauthTokens).values({
    tokenHash: hashApiKey(ACCESS_TOKEN), kind: 'access', clientId: 'profile-client', userId: USER_ID, grantId: GRANT_ID,
    resource: RESOURCE, scope: 'read offline_access', expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt,
  }).run()
  for (const [token, delegatedUserId] of [[ROOT_KEY, null], [DELEGATED_KEY, USER_ID]] as const) {
    db.insert(apiKeys).values({ id: crypto.randomUUID(), name: 'Synthetic key', keyHash: hashApiKey(token), keyPrefix: token.slice(0, 9), scopes: ['read'], delegatedUserId, delegatedOAuthGrantId: delegatedUserId ? GRANT_ID : null, createdAt }).run()
  }
  app = Fastify()
  await app.register(apiRoutes, {
    db, routePrefix: PREFIX, oauthResourceUrl: RESOURCE, researchAllowViewers: false,
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
  const head = await app.inject({ method: 'HEAD', url: `${PREFIX}/mcp/profile`, headers: bearer(ACCESS_TOKEN) })
  expect(head.statusCode).toBe(200)
  expect(head.headers['cache-control']).toBe('no-store')
  expect(head.body).toBe('')
  expect((await app.inject({ method: 'HEAD', url: `${PREFIX}/mcp/profile/extra`, headers: bearer(ACCESS_TOKEN) })).statusCode).toBe(401)
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

test.each([
  { scopes: ['research.run'], expectedStatus: 403 },
  { scopes: ['read', 'research.run'], expectedStatus: 200 },
])('role downgrade preserves only consented authority for $scopes', async ({ scopes, expectedStatus }) => {
  db.update(oauthTokens).set({ scope: scopes.join(' ') }).where(eq(oauthTokens.tokenHash, hashApiKey(ACCESS_TOKEN))).run()
  db.update(apiKeys).set({ scopes }).where(eq(apiKeys.keyHash, hashApiKey(DELEGATED_KEY))).run()
  for (const token of [ACCESS_TOKEN, DELEGATED_KEY]) {
    expect((await app.inject({ url: `${PREFIX}/mcp/profile`, headers: bearer(token) })).statusCode).toBe(expectedStatus)
  }
  db.update(users).set({ role: UserRoles.viewer }).where(eq(users.id, USER_ID)).run()
  for (const token of [ACCESS_TOKEN, DELEGATED_KEY]) {
    const response = await app.inject({ url: `${PREFIX}/mcp/profile`, headers: bearer(token) })
    expect(response.statusCode).toBe(expectedStatus)
    if (expectedStatus === 200) expect(response.json()).toMatchObject({ userId: USER_ID, scopes: ['read'] })
    else expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })
  }
  const authority = await app.inject({ url: `${PREFIX}/keys/self`, headers: bearer(DELEGATED_KEY) })
  expect(authority.statusCode).toBe(expectedStatus)
  if (expectedStatus === 200) expect(authority.json()).toMatchObject({ scopes: ['read'], readOnly: true })
})

test.each(['expired', 'invalid', 'future'] as const)('rejects a %s OAuth delegated key without expiring ordinary keys', async (state) => {
  expect((await app.inject({ url: `${PREFIX}/mcp/profile`, headers: bearer(DELEGATED_KEY) })).statusCode).toBe(200)
  const createdAt = state === 'invalid' ? 'not-a-timestamp'
    : new Date(Date.now() + (state === 'future' ? 60_000 : -60 * 60 * 1000)).toISOString()
  db.update(apiKeys).set({ createdAt }).run()
  const rejected = await app.inject({ url: `${PREFIX}/mcp/profile`, headers: bearer(DELEGATED_KEY) })
  expect(rejected.statusCode).toBe(401)
  expect(rejected.json()).toMatchObject({ error: { code: 'AUTH_INVALID' } })
  expect((await app.inject({ url: `${PREFIX}/projects`, headers: bearer(ROOT_KEY) })).statusCode).toBe(200)
  expect((await app.inject({ url: `${PREFIX}/mcp/profile`, headers: bearer(ACCESS_TOKEN) })).statusCode).toBe(200)
})


test('preserves the historical read default only for null OAuth scopes', async () => {
  db.update(oauthTokens).set({ scope: null }).where(eq(oauthTokens.tokenHash, hashApiKey(ACCESS_TOKEN))).run()
  const response = await app.inject({ url: `${PREFIX}/mcp/profile`, headers: bearer(ACCESS_TOKEN) })
  expect(response.statusCode).toBe(200)
  expect(response.json()).toMatchObject({ userId: USER_ID, scopes: ['read'] })
  db.update(oauthTokens).set({ scope: 'offline_access' }).where(eq(oauthTokens.tokenHash, hashApiKey(ACCESS_TOKEN))).run()
  expect((await app.inject({ url: `${PREFIX}/mcp/profile`, headers: bearer(ACCESS_TOKEN) })).statusCode).toBe(403)
})
