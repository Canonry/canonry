import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { users } from '@canonry/canonry-db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { invokeCli } from './cli-test-utils.js'
import { authorizeSyntheticMcp, startSyntheticMcpInstance, type SyntheticMcpInstance, type SyntheticOAuthTokens } from './mcp-gateway-fixture.js'

interface RpcMessage {
  result?: { structuredContent?: Record<string, unknown>; isError?: boolean }
  error?: { code: number; message: string }
}

async function rpc(instance: SyntheticMcpInstance, token: string, method: string, params: unknown, sessionId?: string) {
  const response = await fetch(instance.transportUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream',
      'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = await response.text()
  const data = body.split('\n').find(line => line.startsWith('data:'))?.replace(/^data:\s*/, '') ?? body
  return { response, message: JSON.parse(data) as RpcMessage }
}

async function initialize(instance: SyntheticMcpInstance, token: string): Promise<string> {
  const result = await rpc(instance, token, 'initialize', {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic-gateway', version: '1' },
  })
  expect(result.response.status).toBe(200)
  const sessionId = result.response.headers.get('mcp-session-id')
  expect(sessionId).toBeTruthy()
  return sessionId!
}

async function profile(instance: SyntheticMcpInstance, token: string) {
  return fetch(instance.profileUrl, { headers: { authorization: `Bearer ${token}` } })
}

async function form(instance: SyntheticMcpInstance, operation: 'token' | 'revoke', body: Record<string, string>) {
  return fetch(`${instance.origin}/oauth/${operation}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
}

describe('gateway contract across isolated real Canonry instances', () => {
  const instances: SyntheticMcpInstance[] = []
  let alpha: SyntheticMcpInstance
  let beta: SyntheticMcpInstance

  beforeAll(async () => {
    vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
    vi.stubEnv('CANONRY_DISABLE_UPDATE_CHECK', '1')
    vi.stubEnv('CANONRY_NO_AUTO_SKILLS_SYNC', '1')
    vi.stubEnv('CANONRY_AGENT_DISABLED', '1')
    vi.stubEnv('CANONRY_BASE_PATH', undefined)
    alpha = await startSyntheticMcpInstance({ name: 'synthetic-alpha' })
    instances.push(alpha)
    beta = await startSyntheticMcpInstance({ name: 'synthetic-beta', basePath: '/nested' })
    instances.push(beta)
  })

  afterAll(async () => {
    for (const instance of instances) await instance.close()
    vi.unstubAllEnvs()
  })

  it('keeps discovery, identity, data and session authority separate across instances', async () => {
    const tokensA = await authorizeSyntheticMcp(alpha)
    const tokensB = await authorizeSyntheticMcp(beta)
    expect(alpha.user.name).toBe(beta.user.name)
    expect(alpha.user.id).not.toBe(beta.user.id)
    const sessions: string[] = []
    for (const [instance, tokens, projectName] of [
      [alpha, tokensA, 'synthetic-alpha'], [beta, tokensB, 'synthetic-beta'],
    ] as const) {
      const discovery = await fetch(`${instance.origin}/.well-known/oauth-protected-resource${instance.basePath}/api/v1/mcp/readonly`)
      expect(await discovery.json()).toMatchObject({ resource: instance.resource, authorization_servers: [instance.origin] })
      const expected = {
        userId: instance.user.id, displayName: instance.user.name,
        instance: { issuer: instance.origin, resource: instance.resource }, scopes: ['read'],
      }
      const identity = await profile(instance, tokens.access_token)
      expect(identity.status).toBe(200)
      expect(identity.headers.get('cache-control')).toBe('no-store')
      expect(await identity.json()).toEqual(expected)
      const session = await initialize(instance, tokens.access_token)
      sessions.push(session)
      const who = await rpc(instance, tokens.access_token, 'tools/call', { name: 'canonry_mcp_profile', arguments: {} }, session)
      expect(who.message.result?.isError).not.toBe(true)
      expect(who.message.result?.structuredContent).toEqual(expected)
      const projects = await rpc(instance, tokens.access_token, 'tools/call', { name: 'canonry_projects_list', arguments: {} }, session)
      expect(projects.message.result?.isError).not.toBe(true)
      expect(projects.message.result?.structuredContent).toMatchObject({ items: [{ name: projectName }] })
      expect(projects.message.result?.structuredContent?.items).toHaveLength(1)
      const rest = await fetch(`${instance.origin}${instance.basePath}/api/v1/projects`, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      })
      expect(rest.status).toBe(401)
    }
    expect((await profile(beta, tokensA.access_token)).status).toBe(401)
    expect((await profile(alpha, tokensB.access_token)).status).toBe(401)
    const crossed = await rpc(beta, tokensB.access_token, 'tools/list', {}, sessions[0])
    expect(crossed.response.status).toBe(404)

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-gateway-cli-'))
    const previous = process.env.CANONRY_CONFIG_DIR
    try {
      fs.writeFileSync(path.join(configDir, 'config.yaml'), JSON.stringify({
        apiUrl: beta.origin, basePath: beta.basePath, apiKey: tokensB.access_token,
        database: path.join(configDir, 'unused.db'), providers: {}, telemetry: { enabled: false }, updateCheck: false,
      }))
      process.env.CANONRY_CONFIG_DIR = configDir
      const result = await invokeCli(['mcp', 'profile', '--format', 'json'])
      expect(result.exitCode).toBeUndefined()
      expect(JSON.parse(result.stdout)).toEqual({
        userId: beta.user.id, displayName: beta.user.name,
        instance: { issuer: beta.origin, resource: beta.resource }, scopes: ['read'],
      })
    } finally {
      if (previous === undefined) delete process.env.CANONRY_CONFIG_DIR
      else process.env.CANONRY_CONFIG_DIR = previous
      fs.rmSync(configDir, { recursive: true, force: true })
    }
  })

  it('requires reinitialization after refresh and revokes only the selected grant', async () => {
    const original = await authorizeSyntheticMcp(alpha)
    const sibling = await authorizeSyntheticMcp(alpha)
    const originalSession = await initialize(alpha, original.access_token)
    const siblingSession = await initialize(alpha, sibling.access_token)
    const refresh = await form(alpha, 'token', {
      grant_type: 'refresh_token', client_id: alpha.clientId, refresh_token: original.refresh_token,
    })
    expect(refresh.status).toBe(200)
    const rotated = await refresh.json() as SyntheticOAuthTokens
    expect(rotated.refresh_token).not.toBe(original.refresh_token)
    expect((await rpc(alpha, rotated.access_token, 'tools/list', {}, originalSession)).response.status).toBe(404)
    const rotatedSession = await initialize(alpha, rotated.access_token)
    expect((await rpc(alpha, rotated.access_token, 'tools/call', { name: 'canonry_mcp_profile', arguments: {} }, rotatedSession)).message.result?.isError).not.toBe(true)

    const revoked = await form(alpha, 'revoke', { token: original.access_token, client_id: alpha.clientId })
    expect(revoked.status).toBe(200)
    for (const token of [original.access_token, rotated.access_token]) {
      expect((await profile(alpha, token)).status).toBe(401)
      expect((await rpc(alpha, token, 'tools/list', {}, rotatedSession)).response.status).toBe(401)
    }
    const refreshRevoked = await form(alpha, 'token', {
      grant_type: 'refresh_token', client_id: alpha.clientId, refresh_token: rotated.refresh_token,
    })
    expect(refreshRevoked.status).toBe(400)
    expect(await refreshRevoked.json()).toMatchObject({ error: 'invalid_grant' })
    const siblingRead = await rpc(alpha, sibling.access_token, 'tools/call', { name: 'canonry_mcp_profile', arguments: {} }, siblingSession)
    expect(siblingRead.response.status).toBe(200)
    expect(siblingRead.message.result?.isError).not.toBe(true)
    expect((await profile(alpha, sibling.access_token)).status).toBe(200)

    alpha.db.delete(users).where(eq(users.id, alpha.user.id)).run()
    expect((await rpc(alpha, sibling.access_token, 'tools/list', {}, siblingSession)).response.status).toBe(401)
  })
})
