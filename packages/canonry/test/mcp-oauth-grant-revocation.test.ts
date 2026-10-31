import crypto from 'node:crypto'

import { apiKeys, dashboardSessions, oauthTokens, users } from '@canonry/canonry-db'
import { createUserSession, hashApiKey, resolveOAuthAccessToken, USER_SESSION_COOKIE_NAME } from '@canonry/canonry-api-routes'
import { UserRoles } from '@canonry/canonry-contracts'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { authorizeSyntheticMcp, startSyntheticMcpInstance, type SyntheticMcpInstance, type SyntheticOAuthTokens } from './mcp-gateway-fixture.js'

let instance: SyntheticMcpInstance | undefined
beforeEach(() => {
  vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
  vi.stubEnv('CANONRY_DISABLE_UPDATE_CHECK', '1')
  vi.stubEnv('CANONRY_NO_AUTO_SKILLS_SYNC', '1')
  vi.stubEnv('CANONRY_AGENT_DISABLED', '1')
  vi.stubEnv('CANONRY_BASE_PATH', undefined)
})
afterEach(async () => {
  await instance?.close()
  instance = undefined
  vi.unstubAllEnvs()
})

async function initialize(instance: SyntheticMcpInstance, token: string): Promise<string> {
  const response = await fetch(instance.transportUrl, {
    method: 'POST', headers: {
      authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream',
      'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'grant-revocation-test', version: '1' },
    } }),
  })
  await response.text()
  expect(response.status).toBe(200)
  const sessionId = response.headers.get('mcp-session-id')
  expect(sessionId).toBeTruthy()
  return sessionId!
}

test('revokes every real delegated session key and bound dashboard session only for the selected authorization', async () => {
  instance = await startSyntheticMcpInstance({ name: 'synthetic-grant-cleanup' })
  const host = instance
  const original = await authorizeSyntheticMcp(host)
  const sibling = await authorizeSyntheticMcp(host)
  const originalGrantId = resolveOAuthAccessToken(host.db, original.access_token, host.resource)?.grantId
  const siblingGrantId = resolveOAuthAccessToken(host.db, sibling.access_token, host.resource)?.grantId
  expect(originalGrantId).toBeTruthy()
  expect(siblingGrantId).toBeTruthy()
  expect(originalGrantId).not.toBe(siblingGrantId)
  const otherUserId = crypto.randomUUID()
  host.db.insert(users).values({ id: otherUserId, name: 'Second synthetic reader', nameKey: 'second synthetic reader', passwordHash: 'unused', role: UserRoles.viewer, createdAt: new Date().toISOString() }).run()
  const otherUserTokens = await authorizeSyntheticMcp({
    ...host, sessionCookie: `${USER_SESSION_COOKIE_NAME}=${createUserSession(host.db, otherUserId)}`,
  })
  const otherGrantId = resolveOAuthAccessToken(host.db, otherUserTokens.access_token, host.resource)?.grantId
  expect(otherGrantId).toBeTruthy()
  await initialize(host, original.access_token)
  await initialize(host, sibling.access_token)
  await initialize(host, otherUserTokens.access_token)
  const refreshed = await fetch(`${host.origin}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: host.clientId, refresh_token: original.refresh_token }),
  })
  expect(refreshed.status).toBe(200)
  const rotated = await refreshed.json() as SyntheticOAuthTokens
  await initialize(host, rotated.access_token)
  const targetKeys = host.db.select().from(apiKeys).where(eq(apiKeys.delegatedOAuthGrantId, originalGrantId!)).all()
  const siblingKeys = host.db.select().from(apiKeys).where(eq(apiKeys.delegatedOAuthGrantId, siblingGrantId!)).all()
  const otherKeys = host.db.select().from(apiKeys).where(eq(apiKeys.delegatedOAuthGrantId, otherGrantId!)).all()
  expect(targetKeys).toHaveLength(2)
  expect(siblingKeys).toHaveLength(1)
  expect(otherKeys).toHaveLength(1)
  // Seed persisted browser-session references to the keys the real transport
  // just minted. Revocation owns removing those references atomically.
  const now = new Date().toISOString()
  for (const key of [...targetKeys, ...siblingKeys, ...otherKeys]) {
    expect(key.revokedAt).toBeNull()
    host.db.insert(dashboardSessions).values({
      tokenHash: crypto.randomBytes(32).toString('hex'), apiKeyId: key.id, apiKeyHash: key.keyHash,
      createdAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }).run()
  }
  const revoke = await fetch(`${host.origin}/oauth/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: original.access_token, client_id: host.clientId }),
  })
  expect(revoke.status).toBe(200)
  await revoke.text()
  for (const key of targetKeys) {
    expect(host.db.select().from(apiKeys).where(eq(apiKeys.id, key.id)).get()?.revokedAt).not.toBeNull()
    expect(host.db.select().from(dashboardSessions).where(eq(dashboardSessions.apiKeyId, key.id)).all()).toEqual([])
  }
  for (const key of [...siblingKeys, ...otherKeys]) {
    expect(host.db.select().from(apiKeys).where(eq(apiKeys.id, key.id)).get()?.revokedAt).toBeNull()
    expect(host.db.select().from(dashboardSessions).where(eq(dashboardSessions.apiKeyId, key.id)).all()).toHaveLength(1)
  }
  for (const tokens of [original, rotated, sibling, otherUserTokens]) {
    const profile = await fetch(host.profileUrl, { headers: { authorization: `Bearer ${tokens.access_token}` } })
    await profile.text()
    expect(profile.status).toBe(tokens === original || tokens === rotated ? 401 : 200)
  }
})


test('adopts an older-binary access token before minting its revocable delegated key', async () => {
  instance = await startSyntheticMcpInstance({ name: 'synthetic-legacy-access-adoption' })
  const host = instance
  const tokens = await authorizeSyntheticMcp(host)
  const previous = host.db.select().from(oauthTokens).where(eq(oauthTokens.tokenHash, hashApiKey(tokens.access_token))).get()!
  // Model an older binary writing tokens after the migration already ran.
  host.db.update(oauthTokens).set({ grantId: null }).where(eq(oauthTokens.grantId, previous.grantId!)).run()
  await initialize(host, tokens.access_token)
  const delegated = host.db.select().from(apiKeys).where(eq(apiKeys.delegatedUserId, host.user.id)).all()
  expect(delegated).toHaveLength(1)
  const key = delegated[0]!
  expect(key.delegatedOAuthGrantId).toBeTruthy()
  expect(key.revokedAt).toBeNull()
  for (const token of [tokens.access_token, tokens.refresh_token]) {
    expect(host.db.select().from(oauthTokens).where(eq(oauthTokens.tokenHash, hashApiKey(token))).get()?.grantId).toBe(key.delegatedOAuthGrantId)
  }
  const revoke = await fetch(`${host.origin}/oauth/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: tokens.refresh_token, client_id: host.clientId }),
  })
  await revoke.text()
  expect(revoke.status).toBe(200)
  expect(host.db.select().from(apiKeys).where(eq(apiKeys.id, key.id)).get()?.revokedAt).not.toBeNull()
  const rejected = await fetch(host.profileUrl, { headers: { authorization: `Bearer ${tokens.access_token}` } })
  await rejected.text()
  expect(rejected.status).toBe(401)
})
