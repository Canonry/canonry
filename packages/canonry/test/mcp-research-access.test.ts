import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { apiRoutes, createUserSession, hashApiKey, USER_SESSION_COOKIE_NAME } from '@ainyc/canonry-api-routes'
import { apiKeys, createClient, migrate, oauthClients, oauthTokens, projects, researchRuns, users } from '@ainyc/canonry-db'
import { ApiClient } from '../src/client.js'
import { registerMcpHttpRoutes, type McpHttpOptions } from '../src/mcp-http.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function harness(allowViewers = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-mcp-research-'))
  const db = createClient(path.join(dir, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  db.insert(projects).values({ id: 'demo', name: 'demo', displayName: 'Demo', canonicalDomain: 'demo.example', country: 'US', language: 'en', providers: ['openai'], createdAt: now, updatedAt: now }).run()
  db.insert(users).values({ id: 'analyst', name: 'Analyst', nameKey: 'analyst', role: 'viewer', passwordHash: 'unused', createdAt: now }).run()
  db.insert(oauthClients).values({ id: 'agent', name: 'Agent', redirectUris: ['https://agent.example/callback'], createdAt: now }).run()
  for (const [token, scopes] of [['cnry_research', ['read', 'research.run']], ['cnry_read', ['read']]] as const) {
    db.insert(apiKeys).values({ id: token, name: token, keyHash: hashApiKey(token), keyPrefix: token.slice(0, 9), scopes: [...scopes], projectId: 'demo', createdAt: now }).run()
  }
  const audience = 'https://instance.example/api/v1/mcp'
  for (const [token, scope] of [['oauth-research', 'read research.run'], ['oauth-read', 'read']]) {
    db.insert(oauthTokens).values({ tokenHash: hashApiKey(token!), kind: 'access', clientId: 'agent', userId: 'analyst', resource: audience, scope, createdAt: now, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }).run()
  }
  const app = Fastify()
  const mcpOptions: McpHttpOptions = { db, selfApiUrl: '' }
  const dispatch = vi.fn()
  app.register(apiRoutes, {
    db, oauthResourceUrl: audience, researchAllowViewers: allowViewers, researchViewerDailyRunLimit: 3,
    onResearchRunRequested: dispatch,
    providerSummary: [{ name: 'openai', configured: true }],
    providerAdapters: [{ name: 'openai', displayName: 'OpenAI', mode: 'api', modelConfigurable: true, defaultModel: 'gpt-test', knownModels: [], modelValidationPattern: /^gpt-[\w.-]+$/, modelValidationHint: 'gpt model' }],
    registerAuthenticatedRoutes: scope => registerMcpHttpRoutes(scope, mcpOptions),
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test listener')
  const origin = `http://127.0.0.1:${address.port}`
  mcpOptions.selfApiUrl = origin
  cleanups.push(async () => { await app.close(); db.$client.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  async function connect(token: string, suffix = '') {
    const client = new Client({ name: 'research-test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/api/v1/mcp${suffix}`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
    cleanups.push(() => client.close())
    return client
  }
  return { app, db, origin, connect, dispatch }
}

function request(idempotencyKey: string) {
  return { queries: ['  Which platform fits an agency?  '], provider: 'openai' as const, model: 'gpt-test', location: null, idempotencyKey }
}

function content(result: Awaited<ReturnType<Client['callTool']>>) {
  const blocks = result.content as Array<{ type: string; text?: string }>
  return JSON.parse(blocks.find(block => block.type === 'text')!.text!)
}

describe('research capability across the real MCP and REST boundary', () => {
  it('runs, lists, and inspects research while sharing browser/API/MCP budgets and attribution', async () => {
    const { app, db, origin, connect, dispatch } = await harness()
    const mcp = await connect('oauth-research')
    const tools = (await mcp.listTools()).tools
    expect(tools.filter(tool => tool.annotations?.readOnlyHint === false).map(tool => tool.name)).toEqual(['canonry_research_run_start'])
    const cookie = createUserSession(db, 'analyst')
    const browser = await app.inject({ method: 'POST', url: '/api/v1/projects/demo/research/runs', headers: { cookie: `${USER_SESSION_COOKIE_NAME}=${cookie}`, origin, host: new URL(origin).host }, payload: request('browser') })
    expect(browser.statusCode).toBe(202)
    // This is the same HTTP client used by CLI research commands.
    const api = new ApiClient(origin, 'cnry_research', { skipProbe: true })
    expect((await api.startResearchRun('demo', request('api'))).initiatedBy).toMatchObject({ kind: 'api-key', limited: true })
    const args = { project: 'demo', request: request('mcp') }
    const started = await mcp.callTool({ name: 'canonry_research_run_start', arguments: args })
    expect(started.isError).not.toBe(true)
    const receipt = content(started)
    expect(receipt.initiatedBy).toEqual({ kind: 'user', id: 'analyst', name: 'Analyst', role: 'viewer', limited: true })
    expect(receipt.queries[0].query).toBe(args.request.queries[0])
    expect(receipt).toMatchObject({ provider: 'openai', resolvedModel: 'gpt-test', location: null })
    const listed = content(await mcp.callTool({ name: 'canonry_research_runs_list', arguments: { project: 'demo' } }))
    expect(listed.runs).toHaveLength(3)
    expect(listed.access).toEqual({ canRun: true, dailyRunLimit: 3 })
    expect(content(await mcp.callTool({ name: 'canonry_research_run_get', arguments: { project: 'demo', runId: receipt.id } })).id).toBe(receipt.id)
    expect(content(await mcp.callTool({ name: 'canonry_research_run_start', arguments: args })).id).toBe(receipt.id)
    const reconnected = await connect('oauth-research', '/x/discovery')
    const overBudget = await reconnected.callTool({ name: 'canonry_research_run_start', arguments: { ...args, request: request('reconnected') } })
    expect(overBudget.isError).toBe(true)
    expect(JSON.stringify(overBudget)).toContain('RESEARCH_DAILY_LIMIT_EXCEEDED')
    expect(db.select().from(researchRuns).all()).toHaveLength(3)
    expect(dispatch).toHaveBeenCalled()
    db.update(users).set({ role: 'admin' }).where(eq(users.id, 'analyst')).run()
    // A promotion never enlarges the consent grant into root authority.
    expect((await reconnected.callTool({ name: 'canonry_research_run_start', arguments: { ...args, request: request('promoted') } })).isError).toBe(true)
  })

  it.each([
    ['oauth-read', '', true],
    ['oauth-research', '', false],
    ['oauth-research', '/readonly', true],
    ['cnry_research', '/x/discovery/readonly', true],
    ['cnry_read', '', true],
  ])('never widens %s on %s (viewer opt-in %s)', async (token, suffix, allowViewers) => {
    const { connect, db } = await harness(allowViewers)
    const mcp = await connect(token, suffix)
    const tools = (await mcp.listTools()).tools
    expect(tools.some(tool => tool.name === 'canonry_research_run_start')).toBe(false)
    expect(tools.every(tool => tool.annotations?.readOnlyHint === true)).toBe(true)
    expect((await mcp.callTool({ name: 'canonry_research_run_start', arguments: { project: 'demo', request: request('forbidden') } })).isError).toBe(true)
    expect(db.select().from(researchRuns).all()).toHaveLength(0)
  })
})
