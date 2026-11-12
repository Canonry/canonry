/**
 * Aero on a viewer's own ChatGPT plan, and the `chatgpt` config block.
 *
 * The viewer-lane tests run a real turn through pi-ai with `fetch` stubbed, so
 * what is asserted is the request that would actually leave for OpenAI: the
 * host, the person's token, the namespaced tools, no system-role items, no
 * fields the plan route rejects. Failures are asserted as the plain messages a
 * viewer sees.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  chatgptPlanConnections,
  createClient,
  migrate,
  projects,
  userExternalIdentities,
  users,
  type DatabaseClient,
} from '@canonry/canonry-db'
import { CHATGPT_AERO_ERRORS, CHATGPT_ISSUER } from '@canonry/canonry-contracts'
import { ChatGptAccounts, encryptPlanTokens, parseChatGptTokenKey, type ChatGptSignInSettings } from '@canonry/canonry-api-routes'
import { chatGptRedirectUri, resolveChatGptSettings } from '../src/chatgpt-config.js'
import { loadConfig, type CanonryConfig } from '../src/config.js'
import { chatGptPlanFailure, chatGptPlanModel, namespaceChatGptPayload } from '../src/agent/chatgpt-plan.js'
import {
  VIEWER_AERO_DAILY_TURN_LIMIT,
  VIEWER_AERO_PLAN_DAILY_TURN_LIMIT,
  ViewerAeroSessions,
} from '../src/agent/viewer-sessions.js'

const ORIGIN = 'http://localhost:4100'
const TOKEN_KEY_HEX = 'c'.repeat(64)

describe('chatgpt config', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-config-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  function load(chatgpt: string): () => CanonryConfig {
    const file = path.join(dir, 'config.yaml')
    fs.writeFileSync(file, `apiUrl: http://localhost:4100\ndatabase: ${path.join(dir, 'data.db')}\napiKey: cnry_test\npublicUrl: https://dash.example.com\n${chatgpt}`)
    return () => loadConfig(file)
  }

  it('builds the callback from publicUrl, HTTPS only (loopback excepted)', () => {
    expect(chatGptRedirectUri('https://tractorbeam.canonry.ai')).toBe('https://tractorbeam.canonry.ai/api/v1/auth/chatgpt/callback')
    expect(chatGptRedirectUri('https://host.example/canonry/')).toBe('https://host.example/canonry/api/v1/auth/chatgpt/callback')
    expect(chatGptRedirectUri('http://localhost:4100')).toBe('http://localhost:4100/api/v1/auth/chatgpt/callback')
    expect(chatGptRedirectUri('http://dash.example.com')).toBeNull()
    expect(chatGptRedirectUri(undefined)).toBeNull()
    expect(chatGptRedirectUri('https://host.example/?x=1')).toBeNull()
  })

  it('resolves settings only when switched on with a client and a usable public URL', () => {
    const base = { publicUrl: 'https://dash.example.com' }
    expect(resolveChatGptSettings({ ...base })).toBeNull()
    expect(resolveChatGptSettings({ ...base, chatgpt: { clientId: 'c', signIn: false, planUsage: false } })).toBeNull()
    expect(resolveChatGptSettings({ publicUrl: 'http://dash.example.com', chatgpt: { clientId: 'c', signIn: true } })).toBeNull()
    const resolved = resolveChatGptSettings({ ...base, chatgpt: { clientId: ' c ', clientSecret: ' ', signIn: true, planUsage: true, tokenKey: TOKEN_KEY_HEX } }, {})
    expect(resolved).toMatchObject({ clientId: 'c', signIn: true, planUsage: true, redirectUri: 'https://dash.example.com/api/v1/auth/chatgpt/callback' })
    expect(resolved?.clientSecret).toBeUndefined()
    expect(resolved?.tokenKey?.equals(Buffer.from(TOKEN_KEY_HEX, 'hex'))).toBe(true)
    // The environment key wins over config.
    const fromEnv = resolveChatGptSettings({ ...base, chatgpt: { clientId: 'c', planUsage: true, tokenKey: TOKEN_KEY_HEX } }, { CANONRY_CHATGPT_TOKEN_KEY: 'd'.repeat(64) })
    expect(fromEnv?.tokenKey?.equals(Buffer.from('d'.repeat(64), 'hex'))).toBe(true)
  })

  it('refuses a block that cannot work, saying how to fix it', () => {
    expect(load('chatgpt:\n  signIn: true\n')).toThrow(/chatgpt.clientId is required/)
    expect(load('chatgpt:\n  clientId: c\n  planUsage: true\n')).toThrow(/openssl rand -hex 32/)
    expect(load('chatgpt:\n  clientId: c\n  signIn: "yes"\n')).toThrow(/chatgpt.signIn must be true, false/)
    expect(load('chatgpt:\n  clientId: c\n  signIn: true\n  requirePlan: true\n')).toThrow(/chatgpt.requirePlan needs chatgpt.planUsage/)
    expect(load(`chatgpt:\n  clientId: c\n  signIn: true\n  planUsage: true\n  tokenKey: ${TOKEN_KEY_HEX}\n`)().chatgpt?.planUsage).toBe(true)
  })
})

describe('plan request shape', () => {
  it('groups tools in the canonry namespace, namespaces earlier calls, and drops the system role', () => {
    const payload = namespaceChatGptPayload({
      model: 'gpt-6-luna',
      store: false,
      input: [
        { role: 'system', content: 'You are Aero.' },
        { role: 'user', content: 'hi' },
        { type: 'function_call', call_id: 'c1', name: 'canonry_project_get', arguments: '{}' },
        { type: 'function_call', call_id: 'c2', name: 'x', arguments: '{}', namespace: 'canonry' },
        { type: 'function_call_output', call_id: 'c1', output: '{}' },
      ],
      tools: [{ type: 'function', name: 'canonry_project_get', parameters: {} }],
    }) as Record<string, unknown>
    expect(payload.store).toBe(false)
    expect(payload.input).toEqual([
      { role: 'developer', content: 'You are Aero.' },
      { role: 'user', content: 'hi' },
      { type: 'function_call', call_id: 'c1', name: 'canonry_project_get', arguments: '{}', namespace: 'canonry' },
      { type: 'function_call', call_id: 'c2', name: 'x', arguments: '{}', namespace: 'canonry' },
      { type: 'function_call_output', call_id: 'c1', output: '{}' },
    ])
    expect(payload.tools).toEqual([{
      type: 'namespace',
      name: 'canonry',
      description: expect.any(String),
      tools: [{ type: 'function', name: 'canonry_project_get', parameters: {} }],
    }])
    expect((namespaceChatGptPayload({ input: [] }) as Record<string, unknown>).tools).toBeUndefined()
  })

  it('maps every documented failure to a plain message', () => {
    expect(chatGptPlanFailure(401, 'anything')).toBe(CHATGPT_AERO_ERRORS.reconnect)
    expect(chatGptPlanFailure(429, '{"code":"subscription_sharing_usage_limit_exceeded"}')).toBe(CHATGPT_AERO_ERRORS.usageLimit)
    expect(chatGptPlanFailure(403, 'subscription_sharing_user_not_eligible')).toBe(CHATGPT_AERO_ERRORS.notEligible)
    expect(chatGptPlanFailure(403, 'chatpass_v2_scope_not_authorized')).toBe(CHATGPT_AERO_ERRORS.reconnect)
    expect(chatGptPlanFailure(503, 'subscription_sharing_usage_unavailable')).toBe(CHATGPT_AERO_ERRORS.unavailable)
    expect(chatGptPlanFailure(400, 'subscription_sharing_unsupported_capability')).toBe(CHATGPT_AERO_ERRORS.failed)
    expect(chatGptPlanFailure(undefined, undefined)).toBe(CHATGPT_AERO_ERRORS.failed)
    // The status comes from the response itself, never from error wording.
    expect(chatGptPlanFailure(undefined, 'OpenAI API error (401): {"code":"x"}')).toBe(CHATGPT_AERO_ERRORS.failed)
    expect(chatGptPlanFailure(503, '')).toBe(CHATGPT_AERO_ERRORS.unavailable)
  })

  it('pins plan models to OpenAI, at no cost to the install', () => {
    for (const id of ['gpt-6-luna', 'some-model-only-the-plan-knows']) {
      const model = chatGptPlanModel(id)
      expect(model).toMatchObject({ id, provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' })
      expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    }
  })
})

describe('viewer Aero on a ChatGPT plan', () => {
  let tmpDir: string
  let db: DatabaseClient
  let accounts: ChatGptAccounts
  let settings: ChatGptSignInSettings
  const project = { id: 'proj_acme', name: 'acme' }
  const key = parseChatGptTokenKey(TOKEN_KEY_HEX)!

  const accountsFetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url === 'https://api.openai.com/v1/models') {
      return new Response(JSON.stringify({ models: [
        { slug: 'gpt-6.1-sol', display_name: 'Sol', visibility: 'list' },
        { slug: 'gpt-6-luna', display_name: 'Luna', visibility: 'list' },
      ] }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  })

  function config(overrides: Partial<CanonryConfig> = {}): CanonryConfig {
    return {
      apiUrl: ORIGIN,
      database: ':memory:',
      apiKey: 'cnry_test',
      providers: { openai: { apiKey: 'sk-install-key' } },
      agent: { provider: 'openai', model: 'gpt-6-luna', allowViewers: true },
      ...overrides,
    } as CanonryConfig
  }

  function seedViewer(id: string, plan: 'connected' | 'reconnect-required' | null): void {
    const now = new Date().toISOString()
    db.insert(users).values({ id, name: id, nameKey: id, passwordHash: 'external$chatgpt', role: 'viewer', createdAt: now }).run()
    if (!plan) return
    const identityId = `identity-${id}`
    db.insert(userExternalIdentities).values({
      id: identityId, userId: id, provider: 'chatgpt', issuer: CHATGPT_ISSUER, clientId: 'c', subject: `sub-${id}`, email: `${id}@x.com`, createdAt: now,
    }).run()
    const connectionId = `conn-${id}`
    db.insert(chatgptPlanConnections).values({
      userId: id, id: connectionId, identityId, status: plan,
      scopes: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      tokens: encryptPlanTokens(key, connectionId, id, { accessToken: `plan-token-${id}`, refreshToken: 'r' }),
      accessExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      connectedAt: now, updatedAt: now,
    }).run()
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-plan-aero-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    const now = new Date().toISOString()
    db.insert(projects).values({
      id: project.id, name: project.name, displayName: 'acme', canonicalDomain: 'acme.example.com',
      country: 'US', language: 'en', createdAt: now, updatedAt: now,
    }).run()
    settings = { clientId: 'c', signIn: true, planUsage: true, tokenKey: key, redirectUri: 'https://dash.example.com/api/v1/auth/chatgpt/callback' }
    accounts = new ChatGptAccounts({ db, settings: () => settings, fetch: accountsFetch })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function lane(): ViewerAeroSessions {
    return new ViewerAeroSessions({ db, config: config(), selfApiUrl: ORIGIN, chatgpt: accounts })
  }

  it('a connected plan funds the turn: OpenAI-pinned model, the person\'s token, the install\'s model when the plan lists it', async () => {
    seedViewer('viewer-a', 'connected')
    const turn = await lane().acquireForTurn(project, 'viewer-a')
    try {
      expect(turn.agent.state.model).toMatchObject({ id: 'gpt-6-luna', provider: 'openai', baseUrl: 'https://api.openai.com/v1' })
      expect(await turn.agent.getApiKey?.('openai')).toBe('plan-token-viewer-a')
      expect(await turn.agent.getApiKey?.('anthropic')).toBeUndefined()
    } finally {
      turn.release()
    }
  })

  it('without a plan, a viewer keeps the install\'s Aero', async () => {
    seedViewer('viewer-b', null)
    const turn = await lane().acquireForTurn(project, 'viewer-b')
    try {
      expect(turn.agent.state.model.baseUrl).not.toBe(undefined)
      expect(await turn.agent.getApiKey?.('openai')).toBe('sk-install-key')
    } finally {
      turn.release()
    }
  })

  it('with requirePlan, a viewer without a plan is asked to connect one instead of using the install\'s key', async () => {
    seedViewer('viewer-h', null)
    settings = { ...settings, requirePlan: true }
    await expect(lane().acquireForTurn(project, 'viewer-h')).rejects.toMatchObject({
      statusCode: 409,
      message: CHATGPT_AERO_ERRORS.connectRequired,
      details: { reason: 'chatgpt-connect-required' },
    })
    // A connected viewer is unaffected.
    seedViewer('viewer-i', 'connected')
    const turn = await lane().acquireForTurn(project, 'viewer-i')
    turn.release()
  })

  it('a plan that needs connecting again is refused, not charged to the install', async () => {
    seedViewer('viewer-c', 'reconnect-required')
    await expect(lane().acquireForTurn(project, 'viewer-c')).rejects.toMatchObject({
      statusCode: 409,
      message: CHATGPT_AERO_ERRORS.reconnect,
    })
  })

  it('plan turns get their own daily ceiling', async () => {
    seedViewer('viewer-d', 'connected')
    const sessions = lane()
    for (let i = 0; i < VIEWER_AERO_DAILY_TURN_LIMIT + 1; i++) (await sessions.acquireForTurn(project, 'viewer-d')).release()
    expect(VIEWER_AERO_PLAN_DAILY_TURN_LIMIT).toBeGreaterThan(VIEWER_AERO_DAILY_TURN_LIMIT)
  })

  it('connecting a plan starts a fresh conversation', async () => {
    seedViewer('viewer-e', null)
    const sessions = lane()
    const first = await sessions.acquireForTurn(project, 'viewer-e')
    first.agent.state.messages = [...first.agent.state.messages, { role: 'user', content: 'before', timestamp: 1 }]
    first.release()
    const now = new Date().toISOString()
    db.insert(userExternalIdentities).values({ id: 'identity-e', userId: 'viewer-e', provider: 'chatgpt', issuer: CHATGPT_ISSUER, clientId: 'c', subject: 's-e', createdAt: now }).run()
    db.insert(chatgptPlanConnections).values({
      userId: 'viewer-e', id: 'conn-e', identityId: 'identity-e', status: 'connected',
      scopes: 'resource.invoke chatgpt.tokens.use.direct',
      tokens: encryptPlanTokens(key, 'conn-e', 'viewer-e', { accessToken: 't', refreshToken: 'r' }),
      accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), connectedAt: now, updatedAt: now,
    }).run()
    const second = await sessions.acquireForTurn(project, 'viewer-e')
    try {
      expect(second.agent).not.toBe(first.agent)
      expect(second.agent.state.messages.some(message => message.role === 'user')).toBe(false)
    } finally {
      second.release()
    }
  })

  it('sends OpenAI the plan-route request and turns a usage limit into a plain message', async () => {
    seedViewer('viewer-f', 'connected')
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      const body = JSON.parse(await request.text() || '{}') as Record<string, unknown>
      requests.push({ url: request.url, headers: request.headers, body })
      return new Response(JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Plan limit reached for user@example.com' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    }))
    const turn = await lane().acquireForTurn(project, 'viewer-f')
    try {
      await turn.agent.prompt('How are we doing?')
      await turn.agent.waitForIdle()
    } finally {
      turn.release()
    }
    expect(requests.length).toBeGreaterThan(0)
    const sent = requests[0]!
    expect(sent.url).toBe('https://api.openai.com/v1/responses')
    expect(sent.headers.get('authorization')).toBe('Bearer plan-token-viewer-f')
    expect(sent.body).toMatchObject({ model: 'gpt-6-luna', store: false, stream: true })
    for (const field of ['max_output_tokens', 'temperature', 'prompt_cache_retention', 'metadata', 'user']) {
      expect(sent.body).not.toHaveProperty(field)
    }
    const input = sent.body.input as Array<Record<string, unknown>>
    expect(input.some(item => item.role === 'system')).toBe(false)
    const tools = sent.body.tools as Array<Record<string, unknown>>
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ type: 'namespace', name: 'canonry' })
    expect((tools[0]!.tools as unknown[]).length).toBeGreaterThan(0)

    const last = turn.agent.state.messages.at(-1) as { role: string; errorMessage?: string; content: unknown[] }
    expect(last.role).toBe('assistant')
    expect(last.errorMessage).toBe(CHATGPT_AERO_ERRORS.usageLimit)
    expect(last.content).toEqual([])
    // Nothing went to the install's key.
    expect(requests.every(request => request.headers.get('authorization') !== 'Bearer sk-install-key')).toBe(true)
  })

  it('a refused credential marks the plan for reconnecting', async () => {
    seedViewer('viewer-g', 'connected')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'invalid token' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    })))
    const turn = await lane().acquireForTurn(project, 'viewer-g')
    try {
      await turn.agent.prompt('hi')
      await turn.agent.waitForIdle()
    } finally {
      turn.release()
    }
    const last = turn.agent.state.messages.at(-1) as { errorMessage?: string }
    expect(last.errorMessage).toBe(CHATGPT_AERO_ERRORS.reconnect)
    expect(db.select().from(chatgptPlanConnections).where(eq(chatgptPlanConnections.userId, 'viewer-g')).get()?.status).toBe('reconnect-required')
  })
})

it('keeps the test key fixtures distinct', () => {
  expect(crypto.createHash('sha256').update(TOKEN_KEY_HEX).digest('hex')).not.toBe(TOKEN_KEY_HEX)
})
