import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport as V1Transport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { users } from '@canonry/canonry-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { authorizeSyntheticMcp, startSyntheticMcpInstance, type SyntheticMcpInstance, type SyntheticOAuthTokens } from './mcp-gateway-fixture.js'

interface RecordedRequest { method?: string; headers: Headers }

function authenticatedTransport(url: string, bearer: () => string, recorded?: RecordedRequest[]) {
  return new StreamableHTTPClientTransport(new URL(url), {
    fetch: async (input, init) => {
      const request = new Request(input, init)
      request.headers.set('authorization', `Bearer ${bearer()}`)
      if (recorded && request.method === 'POST') {
        const body = await request.clone().json() as { method?: string }
        recorded.push({ method: body.method, headers: new Headers(request.headers) })
      }
      return fetch(request)
    },
  })
}

async function form(instance: SyntheticMcpInstance, operation: 'token' | 'revoke', fields: Record<string, string>) {
  return fetch(`${instance.origin}/oauth/${operation}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  })
}

/** Restart can reset a pooled TCP socket. Replay one stored read without renegotiating MCP. */
async function retryRestartRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined
    const reset = [error, cause].some(value => value instanceof Error && 'code' in value
      && (value.code === 'ECONNRESET' || value.code === 'UND_ERR_SOCKET'))
    if (!reset) throw error
    return read()
  }
}

describe('official SDK v2 modern and legacy interoperability', () => {
  const instances: SyntheticMcpInstance[] = []
  const clients: { close: () => Promise<void> }[] = []
  let alpha: SyntheticMcpInstance
  let beta: SyntheticMcpInstance

  beforeEach(async () => {
    vi.stubEnv('CANONRY_TELEMETRY_DISABLED', '1')
    vi.stubEnv('CANONRY_DISABLE_UPDATE_CHECK', '1')
    vi.stubEnv('CANONRY_NO_AUTO_SKILLS_SYNC', '1')
    vi.stubEnv('CANONRY_AGENT_DISABLED', '1')
    vi.stubEnv('CANONRY_BASE_PATH', undefined)
    alpha = await startSyntheticMcpInstance({ name: 'modern-alpha' })
    instances.push(alpha)
    beta = await startSyntheticMcpInstance({ name: 'modern-beta', basePath: '/nested' })
    instances.push(beta)
  })

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => {})
    for (const instance of instances.splice(0)) await instance.close()
    vi.unstubAllEnvs()
  })

  it('negotiates modern, preserves v2 legacy and v1 clients, and isolates both instances', async () => {
    const tokenA = await authorizeSyntheticMcp(alpha)
    const tokenB = await authorizeSyntheticMcp(beta)
    for (const [instance, tokens, project] of [[alpha, tokenA, 'modern-alpha'], [beta, tokenB, 'modern-beta']] as const) {
      const recorded: RecordedRequest[] = []
      const modern = new Client({ name: 'gateway-modern', version: '1' }, { versionNegotiation: { mode: 'auto' } })
      const transport = authenticatedTransport(instance.transportUrl, () => tokens.access_token, recorded)
      clients.push(modern)
      await modern.connect(transport)
      expect(modern.getProtocolEra()).toBe('modern')
      expect(transport.sessionId).toBeUndefined()
      const modernTools = await modern.listTools()
      const modernResources = await modern.listResources()
      const profile = await modern.callTool({ name: 'canonry_mcp_profile', arguments: {} })
      expect(profile.isError).not.toBe(true)
      expect(profile.structuredContent).toEqual({
        userId: instance.user.id, displayName: instance.user.name,
        instance: { issuer: instance.origin, resource: instance.resource }, scopes: ['read'],
      })
      const projects = await modern.callTool({ name: 'canonry_projects_list', arguments: {} })
      expect(projects.structuredContent).toEqual(expect.objectContaining({ items: [expect.objectContaining({ name: project })] }))
      for (const tool of modernTools.tools) {
        expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
      }
      for (const mode of ['legacy', 'v1'] as const) {
        const legacy = mode === 'v1' ? new V1Client({ name: 'gateway-v1', version: '1' })
          : new Client({ name: 'gateway-v2-legacy', version: '1' }, { versionNegotiation: { mode: 'legacy' } })
        clients.push(legacy)
        const oldTransport = mode === 'v1'
          ? new V1Transport(new URL(instance.transportUrl), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } })
          : authenticatedTransport(instance.transportUrl, () => tokens.access_token)
        await legacy.connect(oldTransport)
        expect(oldTransport.sessionId).toBeTruthy()
        expect((await legacy.listTools()).tools.map(tool => tool.name)).toEqual(modernTools.tools.map(tool => tool.name))
        expect((await legacy.listResources()).resources).toEqual(modernResources.resources)
        const legacyProfile = await legacy.callTool({ name: 'canonry_mcp_profile', arguments: {} })
        expect(legacyProfile.structuredContent).toEqual(profile.structuredContent)
      }
      expect(recorded[0]?.method).toBe('server/discover')
      expect(recorded.some(request => request.method === 'initialize')).toBe(false)
      expect(recorded.every(request => !request.headers.has('mcp-session-id'))).toBe(true)
      await expect(modern.callTool({ name: 'canonry_research_run_start', arguments: { project } })).rejects.toThrow('Tool canonry_research_run_start not found')
    }
    const wrongInstance = new Client({ name: 'wrong-instance', version: '1' }, { versionNegotiation: { mode: 'auto' } })
    clients.push(wrongInstance)
    await expect(wrongInstance.connect(authenticatedTransport(beta.transportUrl, () => tokenA.access_token))).rejects.toThrow()
  })

  it('uses fresh bearer authority after refresh, survives a durable restart and honors revocation', async () => {
    const tokens = await authorizeSyntheticMcp(alpha)
    let bearer = tokens.access_token
    const recorded: RecordedRequest[] = []
    const modern = new Client({ name: 'persistent-modern', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } })
    clients.push(modern)
    await modern.connect(authenticatedTransport(alpha.transportUrl, () => bearer, recorded))
    const rotatedResponse = await form(alpha, 'token', { grant_type: 'refresh_token', client_id: alpha.clientId, refresh_token: tokens.refresh_token })
    expect(rotatedResponse.status).toBe(200)
    const rotated = await rotatedResponse.json() as SyntheticOAuthTokens
    bearer = rotated.access_token
    expect((await modern.callTool({ name: 'canonry_mcp_profile', arguments: {} })).isError).not.toBe(true)
    const old = new V1Client({ name: 'persistent-legacy', version: '1' })
    clients.push(old)
    const oldTransport = new V1Transport(new URL(alpha.transportUrl), { requestInit: { headers: { authorization: `Bearer ${bearer}` } } })
    await old.connect(oldTransport)
    const oldSession = oldTransport.sessionId!
    expect((await old.listTools()).tools.map(tool => tool.name)).toContain('canonry_mcp_profile')
    await oldTransport.close()
    await alpha.restart()
    const legacyAfterRestart = await retryRestartRead(() => fetch(alpha.transportUrl, {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'mcp-session-id': oldSession, 'mcp-protocol-version': '2025-11-25', accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    }))
    expect(legacyAfterRestart.status).toBe(404)
    await legacyAfterRestart.text()
    expect((await retryRestartRead(() => modern.callTool({ name: 'canonry_mcp_profile', arguments: {} }))).structuredContent).toMatchObject({ userId: alpha.user.id })
    expect(recorded.filter(request => request.method === 'server/discover')).toHaveLength(1)
    expect(recorded.some(request => request.method === 'initialize')).toBe(false)
    expect((await form(alpha, 'revoke', { token: rotated.refresh_token, client_id: alpha.clientId })).status).toBe(200)
    await expect(modern.listTools()).rejects.toThrow()
    expect((await form(alpha, 'token', { grant_type: 'refresh_token', client_id: alpha.clientId, refresh_token: rotated.refresh_token })).status).toBe(400)
  })

  it('rechecks current roles and deletion on every modern request', async () => {
    alpha.db.update(users).set({ role: 'admin' }).where(eq(users.id, alpha.user.id)).run()
    const tokens = await authorizeSyntheticMcp(alpha, 'read research.run offline_access')
    const modern = new Client({ name: 'current-role', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } })
    clients.push(modern)
    await modern.connect(authenticatedTransport(alpha.transportUrl.replace(/\/readonly$/, ''), () => tokens.access_token))
    expect((await modern.listTools()).tools.map(tool => tool.name)).toContain('canonry_research_run_start')
    alpha.db.update(users).set({ role: 'viewer', name: 'Renamed reader' }).where(eq(users.id, alpha.user.id)).run()
    expect((await modern.listTools()).tools.map(tool => tool.name)).not.toContain('canonry_research_run_start')
    expect((await modern.callTool({ name: 'canonry_mcp_profile', arguments: {} })).structuredContent).toMatchObject({ displayName: 'Renamed reader' })
    alpha.db.delete(users).where(eq(users.id, alpha.user.id)).run()
    await expect(modern.listTools()).rejects.toThrow()
  })
})
