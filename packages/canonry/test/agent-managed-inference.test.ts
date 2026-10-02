import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Agent, type AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import { eq } from 'drizzle-orm'
import { AppError, agentViewContextSchema } from '@ainyc/canonry-contracts'
import { apiKeys, agentSessions, createClient, managedAgentSessions, managedAgentTurnGrants, migrate, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { hashApiKey } from '@ainyc/canonry-api-routes'
import { authPlugin } from '../../api-routes/src/auth.js'
import { aeroEvidenceFixture } from '../../contracts/test/fixtures/aero-evidence.js'
import type { ApiClient } from '../src/client.js'
import type { CanonryConfig } from '../src/config.js'
import { MANAGED_INFERENCE_HEADER, openManagedInferenceGrant, type ManagedInferenceTurnGrant } from '../src/agent/managed-inference.js'
import { managedChatGptModel, managedChatGptStream } from '../src/agent/managed-chatgpt.js'
import { ManagedAeroSessions } from '../src/agent/managed-sessions.js'
import { registerAgentRoutes } from '../src/agent/agent-routes.js'
import { SessionRegistry } from '../src/agent/session-registry.js'
import * as remoteMcp from '../src/agent/remote-mcp.js'

const key = '01'.repeat(32)
const rootKey = 'cnry_managed_root_test'
const readKey = 'cnry_managed_reader_test'
const projectKey = 'cnry_managed_project_test'
function grant(overrides: Partial<ManagedInferenceTurnGrant> = {}): ManagedInferenceTurnGrant {
  return { v: 1, grantId: crypto.randomUUID(), actorId: 'alice', connectionId: 'connection-1', projectName: 'demo', modelId: 'gpt-account-model', accessToken: 'personal-token-1', purpose: 'turn', expiresAt: Date.now() + 300_000, ...overrides }
}
function seal(value: unknown, encryptionKey = key): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), body.toString('hex')].join('.')
}
function readGrant(actorId = 'alice', connectionId = 'connection-1') {
  const { accessToken: _token, ...value } = grant({ actorId, connectionId })
  return { ...value, purpose: 'read' as const }
}
function sse(items: Array<Record<string, unknown>>, id = 'resp_test'): Response {
  const events: Array<Record<string, unknown>> = [{ type: 'response.created', response: { id } }]
  items.forEach((item, output_index) => {
    events.push({ type: 'response.output_item.added', output_index, item })
    events.push({ type: 'response.output_item.done', output_index, item })
  })
  events.push({ type: 'response.completed', response: { id, status: 'completed', output: items, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}
function answer(text = 'A personal answer') {
  return sse([{ type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }])
}

describe('encrypted personal inference grants', () => {
  it('accepts bound claims and requires an independent enabled host', () => {
    const value = grant()
    expect(openManagedInferenceGrant(seal(value), key, 'demo', 'turn')).toEqual(value)
    expect(openManagedInferenceGrant(undefined, undefined, 'demo', 'turn')).toBeUndefined()
    expect(() => openManagedInferenceGrant(seal(value), undefined, 'demo', 'turn')).toThrow(AppError)
  })
  it.each([
    ['wrong project', () => grant({ projectName: 'another' })],
    ['expired', () => grant({ expiresAt: Date.now() - 1 })],
    ['unbounded lifetime', () => grant({ expiresAt: Date.now() + 700_000 })],
    ['wrong purpose', () => readGrant()],
    ['malformed grant identity', () => ({ ...grant(), grantId: 'not-a-uuid' })],
    ['unknown claims', () => ({ ...grant(), dangerous: true })],
    ['missing token', () => ({ ...grant(), accessToken: undefined })],
  ])('refuses %s without exposing claims', (_label, make) => {
    const value = make()
    expect(() => openManagedInferenceGrant(seal(value), key, 'demo', 'turn')).toThrow(AppError)
  })
  it('refuses tampering, wrong encryption key, repeated headers and cross-purpose reads', () => {
    const token = seal(grant())
    for (const header of [token + 'ab', seal(grant(), '02'.repeat(32)), [token, token]]) {
      expect(() => openManagedInferenceGrant(header, key, 'demo', 'turn')).toThrow(AppError)
    }
    expect(() => openManagedInferenceGrant(token, key, 'demo', 'read')).toThrow(AppError)
    expect(() => openManagedInferenceGrant(seal({ ...readGrant(), accessToken: 'should-not-ride-read' }), key, 'demo', 'read')).toThrow(AppError)
    expect(openManagedInferenceGrant(seal({ ...readGrant(), modelId: '' }), key, 'demo', 'read')).toMatchObject({ modelId: '' })
    expect(() => openManagedInferenceGrant(seal(grant({ modelId: '' })), key, 'demo', 'turn')).toThrow(AppError)
  })
  it('enforces the exact expiry boundaries against a fixed clock', () => {
    const now = Date.now()
    expect(openManagedInferenceGrant(seal(grant({ expiresAt: now + 600_000 })), key, 'demo', 'turn', now)).toBeDefined()
    for (const expiresAt of [now, now - 1, now + 600_001]) expect(() => openManagedInferenceGrant(seal(grant({ expiresAt })), key, 'demo', 'turn', now)).toThrow(AppError)
  })
})

describe('the actual public Responses transport', () => {
  afterEach(() => vi.unstubAllEnvs())
  it('sends namespaced tools, normalizes replies and replays tool results with refreshed namespace', async () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://platform-proxy.invalid/v1')
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
      if (requests.length === 1) return sse([{ type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'canonry.inspect', namespace: 'canonry', arguments: '{}', status: 'completed' }])
      return answer('Checked your data')
    }) as unknown as typeof fetch
    const executed = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'stored evidence' }], details: {} }))
    const tool: AgentTool = { name: 'inspect', label: 'Inspect', description: 'Read evidence', parameters: Type.Object({}), execute: executed }
    const credential = managedChatGptStream(grant(), transport)
    const agent = new Agent({ initialState: { systemPrompt: 'Aero system instructions\nMounted Managed Ads instructions', model: managedChatGptModel('gpt-account-model'), tools: [tool] }, streamFn: credential.stream })
    await agent.prompt('Check my project')
    credential.release()
    expect(executed).toHaveBeenCalledTimes(1)
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.url).toBe('https://api.openai.com/v1/responses')
      expect(request.headers.get('authorization')).toBe('Bearer personal-token-1')
      for (const name of ['x-stainless-os', 'x-stainless-arch', 'x-stainless-runtime-version']) expect(request.headers.has(name)).toBe(false)
      expect(request.body).toMatchObject({ model: 'gpt-account-model', store: false, stream: true, tools: [{ type: 'namespace', name: 'canonry', tools: [{ type: 'function', name: 'inspect' }] }] })
      expect(request.body).not.toHaveProperty('max_output_tokens')
      expect(request.body).not.toHaveProperty('temperature')
      expect(Array.isArray(request.body.input)).toBe(true)
      expect(request.body.input).not.toEqual(expect.arrayContaining([expect.objectContaining({ role: 'system' })]))
      expect(JSON.stringify(request.body)).not.toContain('personal-token-1')
    }
    expect(requests[0]!.body.input).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'developer' })]))
    expect(JSON.stringify(requests[0]!.body.input)).toContain('Mounted Managed Ads instructions')
    expect(requests[1]!.body.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call', name: 'inspect', namespace: 'canonry' }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_test' }),
    ]))
    expect(agent.state.messages.find(message => message.role === 'assistant')?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'toolCall', name: 'inspect' })]))
    expect(() => credential.stream(agent.state.model, { messages: [] })).toThrow('ChatGPT could not finish')
  })
  it('sanitizes upstream errors including a reflected credential', async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'personal-token-1 was rejected', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const credential = managedChatGptStream(grant(), transport)
    const response = await credential.stream(managedChatGptModel('gpt-account-model'), { messages: [] })
    const events = []
    for await (const event of response) events.push(event)
    expect(JSON.stringify(events)).not.toContain('personal-token-1')
    expect((await response.result()).errorMessage).toContain('Reconnect your account')
    credential.release()
  })
  it.each([[401, 'CHATGPT_AUTH_REQUIRED', 1], [403, 'CHATGPT_AUTH_REQUIRED', 1], [429, 'CHATGPT_RATE_LIMITED', 3]] as const)('classifies upstream %s safely and retains provider backoff', async (status, code, attempts) => {
    const transport = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'secret echoed personal-token-1', type: 'request_error' } }), { status, headers: { 'content-type': 'application/json', 'retry-after': '0' } })) as unknown as typeof fetch
    const credential = managedChatGptStream(grant(), transport)
    const response = credential.stream(managedChatGptModel('gpt-account-model'), { messages: [] })
    const events = []
    for await (const event of response) events.push(event)
    expect((await response.result()).errorMessage).toContain(code)
    expect(JSON.stringify(events)).not.toContain('personal-token-1')
    expect(transport).toHaveBeenCalledTimes(attempts)
    credential.release()
  })
})

describe('personal sessions behind the existing real API credential boundary', () => {
  let directory: string
  let db: DatabaseClient
  let app: FastifyInstance
  let sessions: ManagedAeroSessions
  let transport: ReturnType<typeof vi.fn>
  const read = vi.fn()
  const config = { apiUrl: 'http://localhost:4100', database: ':memory:', apiKey: rootKey, providers: { claude: { apiKey: 'operator-key' } }, basePath: '/canonry/' } as CanonryConfig
  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-managed-'))
    db = createClient(path.join(directory, 'data.db'))
    migrate(db)
    const now = new Date().toISOString()
    db.insert(projects).values({ id: 'demo', name: 'demo', displayName: 'Demo', canonicalDomain: 'demo.example', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
    for (const [raw, scopes, projectId] of [[rootKey, ['*'], null], [readKey, ['read'], null], [projectKey, ['*'], 'demo']] as const) {
      db.insert(apiKeys).values({ id: raw, name: raw, keyHash: hashApiKey(raw), keyPrefix: raw.slice(0, 9), scopes: [...scopes], projectId, createdAt: now }).run()
    }
    db.insert(agentSessions).values({ id: 'operator-session', projectId: 'demo', systemPrompt: 'private operator prompt', modelProvider: 'claude', modelId: 'operator-model', messages: JSON.stringify([{ role: 'user', content: 'operator secret', timestamp: 1 }]), followUpQueue: '["operator follow-up"]', createdAt: now, updatedAt: now }).run()
    read.mockReset().mockResolvedValue(aeroEvidenceFixture('advanced'))
    transport = vi.fn(async () => answer())
    const client = { getVisibilityReport: read } as unknown as ApiClient
    sessions = new ManagedAeroSessions({ db, client, config, managedSweeps: true, transport: transport as unknown as typeof fetch })
    app = Fastify()
    app.decorate('db', db)
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError) return reply.status(error.statusCode).send(error.toJSON())
      return reply.status(500).send(error)
    })
    await authPlugin(app)
    registerAgentRoutes(app, { db, sessionRegistry: new SessionRegistry({ db, client, config }), managedInferenceKey: key, managedSessions: sessions })
    await app.ready()
  })
  afterEach(async () => {
    await app.close()
    db.$client.close()
    fs.rmSync(directory, { recursive: true, force: true })
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })
  const headers = (value: unknown, credential = rootKey) => ({ authorization: `Bearer ${credential}`, [MANAGED_INFERENCE_HEADER]: seal(value) })
  it('refuses missing/read-only/project-scoped API authority despite a valid personal grant', async () => {
    const url = '/projects/demo/agent/prompt'
    for (const credential of ['invalid', readKey, projectKey]) {
      const response = await app.inject({ method: 'POST', url, headers: headers(grant(), credential), payload: { prompt: 'Explain' } })
      expect(response.statusCode).toBe(credential === 'invalid' ? 401 : 403)
    }
    expect(transport).not.toHaveBeenCalled()
  })
  it.each([[401, 'CHATGPT_AUTH_REQUIRED', 1], [429, 'CHATGPT_RATE_LIMITED', 3]] as const)('streams one safe outer error when the actual provider fails with %s before stream start', async (status, code, attempts) => {
    transport.mockImplementation(async () => new Response(JSON.stringify({ error: { message: 'upstream private detail: personal-token-1', type: 'request_error' } }), { status, headers: { 'content-type': 'application/json', 'retry-after': '0' } }))
    const response = await app.inject({ method: 'POST', url: '/projects/demo/agent/prompt', headers: headers(grant()), payload: { prompt: 'Explain' } })
    expect(response.statusCode).toBe(200)
    const frames = response.body.trim().split('\n\n').map(frame => JSON.parse(frame.slice('data: '.length)) as { type: string; message?: string; status?: { reason: string } })
    expect(frames.filter(frame => frame.type === 'error')).toEqual([{ type: 'error', message: expect.stringContaining(code) }])
    expect(frames.filter(frame => frame.type === 'aero_turn_status')).toEqual([expect.objectContaining({ status: expect.objectContaining({ reason: 'error' }) })])
    expect(frames.at(-1)).toEqual({ type: 'stream_close' })
    expect(response.body).not.toContain('personal-token-1')
    expect(response.body).not.toContain('upstream private detail')
    expect(transport).toHaveBeenCalledTimes(attempts)
  })
  it('isolates two actors, connection replacement, read/reset, and refreshed turn credentials', async () => {
    for (const [actorId, accessToken] of [['alice', 'personal-token-1'], ['bob', 'personal-token-2'], ['alice', 'refreshed-token-1']]) {
      const response = await app.inject({ method: 'POST', url: '/projects/demo/agent/prompt', headers: headers(grant({ actorId, accessToken })), payload: { prompt: `${actorId} question` } })
      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('stream_close')
      expect(response.body).not.toContain(accessToken)
      expect(response.body).not.toContain('operator secret')
    }
    expect(transport.mock.calls.map(call => new Headers(call[1]?.headers).get('authorization'))).toEqual(['Bearer personal-token-1', 'Bearer personal-token-2', 'Bearer refreshed-token-1'])
    const alice = (await app.inject({ url: '/projects/demo/agent/transcript', headers: headers(readGrant()) })).json()
    const bob = (await app.inject({ url: '/projects/demo/agent/transcript', headers: headers(readGrant('bob')) })).json()
    expect(alice.messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(2)
    expect(bob.messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(1)
    expect(alice.conversationId).not.toBe(bob.conversationId)
    const replacement = (await app.inject({ url: '/projects/demo/agent/transcript', headers: headers(readGrant('alice', 'connection-2')) })).json()
    expect(replacement.messages).toEqual([])
    await app.inject({ method: 'DELETE', url: '/projects/demo/agent/transcript', headers: headers(readGrant()) })
    expect(db.select().from(managedAgentSessions).all()).toHaveLength(1)
    expect(db.select().from(agentSessions).get()?.messages).toContain('operator secret')
    expect(JSON.stringify(db.select().from(managedAgentSessions).all())).not.toContain('personal-token')
  })
  it('rejects turn replay across a fresh registry and read grants cannot generate', async () => {
    const value = grant()
    const call = () => app.inject({ method: 'POST', url: '/projects/demo/agent/prompt', headers: headers(value), payload: { prompt: 'Explain' } })
    expect((await call()).statusCode).toBe(200)
    expect((await call()).statusCode).toBe(401)
    const otherProcess = new ManagedAeroSessions({ db, client: {} as ApiClient, config })
    await expect(otherProcess.acquireForTurn({ id: 'demo', name: 'demo' }, value, { prompt: 'Explain' })).rejects.toMatchObject({ code: 'AUTH_INVALID' })
    expect((await app.inject({ method: 'POST', url: '/projects/demo/agent/prompt', headers: headers(readGrant()), payload: { prompt: 'Explain' } })).statusCode).toBe(401)
    expect(db.select().from(managedAgentTurnGrants).all()).toHaveLength(1)
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('retains durable history while sending only whole recent turns in the model context', async () => {
    const now = new Date().toISOString()
    const messages = Array.from({ length: 48 }, (_, index) => ({ role: 'user', content: `previous prompt ${index}`, timestamp: index }))
    db.insert(managedAgentSessions).values({ id: 'long-personal', projectId: 'demo', actorId: 'alice', connectionId: 'connection-1', modelId: 'gpt-account-model', messages, createdAt: now, updatedAt: now }).run()
    const value = grant()
    const turn = await sessions.acquireForTurn({ id: 'demo', name: 'demo' }, value, { prompt: 'Newest prompt' })
    expect(turn.agent.state.messages.filter(message => message.role === 'user')).toHaveLength(40)
    expect(JSON.stringify(turn.agent.state.messages)).not.toContain('previous prompt 0"')
    await turn.agent.prompt('Newest prompt')
    turn.save()
    turn.release()
    const saved = db.select().from(managedAgentSessions).where(eq(managedAgentSessions.id, 'long-personal')).get()!
    expect(saved.messages.filter(message => (message as { role: string }).role === 'user')).toHaveLength(49)
    expect(saved.messages[0]).toEqual(messages[0])
    expect(sessions.transcript('demo', readGrant()).messages[0]).toEqual(messages[0])
  })
  it('preserves exact Advanced context, limits and managed sweep controls without operator memory', async () => {
    const promptFile = path.join(directory, 'managed-ads.txt')
    fs.writeFileSync(promptFile, 'Mounted Managed Ads policy: use grounded ads evidence.')
    vi.stubEnv('AERO_SYSTEM_PROMPT_FILE', promptFile)
    const context = agentViewContextSchema.parse({ view: 'property', selection: { scope: 'property', scopeKey: 'hotel', marketKey: 'london', queryClass: 'non-brand', runId: 'run-3' } })
    const turn = await sessions.acquireForTurn({ id: 'demo', name: 'demo' }, grant(), { prompt: 'Explain', context, scope: 'all', limits: { maxToolCalls: 2, timeoutMs: 10000 } })
    expect(read).toHaveBeenCalledExactlyOnceWith('demo', context.selection)
    expect(turn.agent.state.systemPrompt).toContain('personal')
    expect(turn.agent.state.systemPrompt).not.toContain('operator secret')
    expect(turn.agent.state.systemPrompt).toContain('Mounted Managed Ads policy')
    expect(turn.agent.state.tools.map(tool => tool.name)).not.toContain('canonry_run_trigger')
    expect(turn.agent.state.tools.map(tool => tool.name)).not.toContain('canonry_memory_list')
    await turn.agent.prompt('Explain')
    const request = JSON.parse(String(transport.mock.calls[0]![1]?.body)) as { input: Array<{ role?: string; content?: unknown }> }
    expect(request.input.filter(item => item.role === 'developer').map(item => item.content).join('\n')).toContain('Mounted Managed Ads policy')
    expect(request.input.some(item => item.role === 'system')).toBe(false)
    turn.save()
    turn.release()
    for (const endpoint of ['memory', 'conversations', 'providers']) {
      expect((await app.inject({ url: `/projects/demo/agent/${endpoint}`, headers: headers(readGrant()) })).statusCode).toBe(403)
    }
  })
  it('retains Simple context and the remote grounding tools accepted by the read-only loader', async () => {
    read.mockResolvedValue(aeroEvidenceFixture('simple'))
    const remoteTool: AgentTool = { name: 'managed_ads_grounding', label: 'Managed ads evidence', description: 'Read grounded ads evidence', parameters: Type.Object({}), execute: async () => ({ content: [{ type: 'text', text: 'stored ads evidence' }], details: {} }) }
    const externalMcpServers = [{ url: 'https://managed-grounding.invalid/mcp', token: 'grounding-token' }]
    const loader = vi.spyOn(remoteMcp, 'loadExternalMcpTools').mockResolvedValue([remoteTool])
    const personal = new ManagedAeroSessions({ db, client: { getVisibilityReport: read } as unknown as ApiClient, config: { ...config, externalMcpServers }, transport: transport as unknown as typeof fetch })
    const context = agentViewContextSchema.parse({ view: 'project' })
    const turn = await personal.acquireForTurn({ id: 'demo', name: 'demo' }, grant(), { prompt: 'Explain', context })
    expect(read).toHaveBeenCalledExactlyOnceWith('demo', { scope: 'project', mode: 'auto', queryClass: 'all', limit: 10 })
    expect(loader).toHaveBeenCalledExactlyOnceWith(externalMcpServers)
    expect(turn.agent.state.tools.map(tool => tool.name)).toContain('managed_ads_grounding')
    expect(turn.agent.state.tools.map(tool => tool.name)).not.toContain('canonry_query_add')
    turn.release()
  })
  it('reserves context acquisition and cancels before generation on disconnect', async () => {
    let finish!: () => void
    read.mockImplementation(async () => { await new Promise<void>(resolve => { finish = resolve }); return aeroEvidenceFixture('advanced') })
    const context = agentViewContextSchema.parse({ view: 'project' })
    const controller = new AbortController()
    const value = grant()
    const acquiring = sessions.acquireForTurn({ id: 'demo', name: 'demo' }, value, { prompt: 'Explain', context }, controller.signal)
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    expect(sessions.transcript('demo', value).isStreaming).toBe(true)
    await expect(sessions.acquireForTurn({ id: 'demo', name: 'demo' }, grant(), { prompt: 'Explain' })).rejects.toMatchObject({ code: 'AGENT_BUSY' })
    controller.abort()
    finish()
    await expect(acquiring).rejects.toMatchObject({ name: 'AbortError' })
    expect(sessions.transcript('demo', value).isStreaming).toBe(false)
    expect(transport).not.toHaveBeenCalled()
  })
  it('aborts the active provider request and releases personal admission when the socket closes', async () => {
    let providerAborted = false
    transport.mockImplementation(async (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        providerAborted = true
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    }))
    const origin = await app.listen({ host: '127.0.0.1', port: 0 })
    const value = grant()
    const controller = new AbortController()
    const response = await fetch(`${origin}/projects/demo/agent/prompt`, { method: 'POST', headers: { ...headers(value), 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Explain' }), signal: controller.signal })
    expect(response.status).toBe(200)
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1))
    expect(sessions.transcript('demo', value).isStreaming).toBe(true)
    controller.abort()
    await vi.waitFor(() => {
      expect(providerAborted).toBe(true)
      expect(sessions.transcript('demo', value).isStreaming).toBe(false)
    })
    expect(JSON.stringify(db.select().from(managedAgentSessions).all())).not.toContain('personal-token-1')
  })
})
