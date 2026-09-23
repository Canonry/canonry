/**
 * Aero for viewer accounts (`agent.allowViewers`).
 *
 * The operator's Aero is one persisted conversation per project, hydrated with
 * memory notes, whose tools run with the install root key. A viewer must get
 * none of that: their own conversation, the viewer's own authority on every
 * tool call, read tools only, and nothing that spends on a live provider read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq, like } from 'drizzle-orm'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { agentSessions, apiKeys, createClient, migrate, projects, users, type DatabaseClient } from '@ainyc/canonry-db'
import { AppError, MemorySources } from '@ainyc/canonry-contracts'
import { hashUserPassword, type AuthPrincipal } from '@ainyc/canonry-api-routes'
import { resolveAgentAllowViewers } from '../src/agent-config.js'
import { createServer } from '../src/server.js'
import { registerAgentRoutes } from '../src/agent/agent-routes.js'
import { AERO_MANAGED_SWEEP_MCP_TOOLS } from '../src/agent/mcp-to-agent-tool.js'
import { upsertMemoryEntry } from '../src/agent/memory-store.js'
import { SessionRegistry } from '../src/agent/session-registry.js'
import { AeroToolScopes, buildAeroStateTools } from '../src/agent/tools.js'
import {
  AERO_VIEWER_EXCLUDED_MCP_TOOLS,
  MAX_VIEWER_MESSAGES,
  VIEWER_AERO_DAILY_TURN_LIMIT,
  VIEWER_AERO_KEY_PREFIX,
  trimViewerTranscript,
  buildViewerAeroTools,
  mintViewerAeroKey,
  VIEWER_AERO_PROMPT,
  ViewerAeroSessions,
} from '../src/agent/viewer-sessions.js'
import { canonryMcpTools } from '../src/mcp/tool-registry.js'
import { ApiClient } from '../src/client.js'
import type { CanonryConfig } from '../src/config.js'

const ORIGIN = 'http://localhost:4100'
const HOST = 'localhost:4100'
const ADMIN_ONLY = 'Only an administrator account can use this.'
const OPERATOR_SECRET = 'operator-only renewal notes'

function config(overrides: Partial<CanonryConfig> = {}): CanonryConfig {
  return {
    apiUrl: ORIGIN,
    database: ':memory:',
    apiKey: 'cnry_test',
    providers: { claude: { apiKey: 'anthropic-key' } },
    ...overrides,
  } as CanonryConfig
}

function seedProject(db: DatabaseClient): { id: string; name: string } {
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: 'proj_acme',
    name: 'acme',
    displayName: 'acme',
    canonicalDomain: 'acme.example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  return { id: 'proj_acme', name: 'acme' }
}

function seedViewer(db: DatabaseClient, id: string): void {
  db.insert(users).values({
    id,
    name: id,
    nameKey: id,
    passwordHash: 'unused',
    role: 'viewer',
    createdAt: new Date().toISOString(),
  }).run()
}

/** Seed the operator's own conversation and a memory note a viewer must never see. */
function seedOperatorAero(db: DatabaseClient, projectId: string): void {
  const now = new Date().toISOString()
  db.insert(agentSessions).values({
    id: 'operator-session',
    projectId,
    systemPrompt: 'operator prompt',
    modelProvider: 'claude',
    modelId: 'claude-model',
    messages: JSON.stringify([{ role: 'user', content: OPERATOR_SECRET, timestamp: 1 }]),
    createdAt: now,
    updatedAt: now,
  }).run()
  upsertMemoryEntry(db, { projectId, key: 'renewal', value: OPERATOR_SECRET, source: MemorySources.user })
}

/** Everything Aero can reach this turn, including tools behind aero_load_toolkit. */
async function reachableToolNames(tools: AgentTool[]): Promise<string[]> {
  const names = new Set(tools.map(t => t.name))
  const list = tools.find(t => t.name === 'aero_list_toolkits')
  const load = tools.find(t => t.name === 'aero_load_toolkit')
  if (list && load) {
    const kits = (await list.execute('list', {})).details as Array<{ name: string }>
    for (const kit of kits) {
      const loaded = (await load.execute('load', { toolkit: kit.name })).details as { tools: Array<{ name: string }> }
      for (const tool of loaded.tools) names.add(tool.name)
    }
  }
  return [...names]
}

describe('resolveAgentAllowViewers', () => {
  it.each([
    [{}, undefined, false],
    [{}, true, true],
    [{}, false, false],
    [{ CANONRY_AGENT_ALLOW_VIEWERS: '1' }, undefined, true],
    [{ CANONRY_AGENT_ALLOW_VIEWERS: 'true' }, false, true],
    [{ CANONRY_AGENT_ALLOW_VIEWERS: '0' }, true, false],
  ] as const)('env %j, config %s -> %s', (env, allowViewers, expected) => {
    expect(resolveAgentAllowViewers(env as NodeJS.ProcessEnv, config({ agent: { allowViewers } }))).toBe(expected)
  })
})

describe('ViewerAeroSessions', () => {
  let tmpDir: string
  let db: DatabaseClient
  let project: { id: string; name: string }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-viewer-aero-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    project = seedProject(db)
    seedViewer(db, 'viewer-a')
    seedViewer(db, 'viewer-b')
    seedOperatorAero(db, project.id)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function sessions(managedSweeps = false) {
    return new ViewerAeroSessions({ db, config: config(), selfApiUrl: ORIGIN, managedSweeps })
  }

  it('runs each turn on a read-only key delegated to the viewer, deleted when the turn ends', async () => {
    const lane = sessions()
    const turn = await lane.acquireForTurn(project, 'viewer-a')
    const keys = db.select().from(apiKeys).where(like(apiKeys.name, `${VIEWER_AERO_KEY_PREFIX}%`)).all()

    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatchObject({ delegatedUserId: 'viewer-a', scopes: ['read'], revokedAt: null })

    turn.release()
    expect(db.select().from(apiKeys).where(eq(apiKeys.id, keys[0]!.id)).all()).toEqual([])
  })

  it('offers read tools only, without live paid reads or sweep controls', async () => {
    const lane = sessions(true)
    const turn = await lane.acquireForTurn(project, 'viewer-a')
    const names = await reachableToolNames(turn.agent.state.tools)
    turn.release()

    const writes = canonryMcpTools.filter(t => t.access === 'write').map(t => t.name)
    for (const name of writes) expect(names).not.toContain(name)
    for (const name of AERO_VIEWER_EXCLUDED_MCP_TOOLS) expect(names).not.toContain(name)
    for (const name of AERO_MANAGED_SWEEP_MCP_TOOLS) expect(names).not.toContain(name)
    expect(names).toContain('canonry_project_overview')
  })

  it('never puts the operator memory in the prompt', async () => {
    const lane = sessions()
    const turn = await lane.acquireForTurn(project, 'viewer-a')
    turn.release()

    expect(turn.agent.state.systemPrompt).toContain(VIEWER_AERO_PROMPT.trim())
    expect(turn.agent.state.systemPrompt).not.toContain(OPERATOR_SECRET)
    expect(turn.agent.state.messages).toEqual([])
  })

  it('keeps one conversation per viewer, and a reset touches only its own', async () => {
    const lane = sessions()
    const a = await lane.acquireForTurn(project, 'viewer-a')
    a.release()
    const b = await lane.acquireForTurn(project, 'viewer-b')
    b.release()
    expect(a.agent).not.toBe(b.agent)

    a.agent.state.messages = [{ role: 'user', content: 'hello', timestamp: 1 }]
    lane.reset(project.name, 'viewer-b')

    expect(lane.transcript(project.name, 'viewer-a')).toHaveLength(1)
    expect(lane.transcript(project.name, 'viewer-b')).toEqual([])
  })

  it('does not leave the lane busy when the key cannot be minted', async () => {
    const lane = sessions()
    // No users row: the delegated key's foreign key fails the insert.
    await expect(lane.acquireForTurn(project, 'no-such-viewer')).rejects.toThrow()
    expect(lane.isBusy(project.name, 'no-such-viewer')).toBe(false)
  })

  it('refuses a second turn for the same viewer while one is running', async () => {
    const lane = sessions()
    const first = await lane.acquireForTurn(project, 'viewer-a')

    await expect(lane.acquireForTurn(project, 'viewer-a')).rejects.toMatchObject({ code: 'AGENT_BUSY' })
    const other = await lane.acquireForTurn(project, 'viewer-b')
    other.release()
    first.release()
  })

  it('caps turns per viewer per UTC day, and the cap is per viewer', async () => {
    let clock = Date.parse('2026-09-23T10:00:00Z')
    const lane = new ViewerAeroSessions({ db, config: config(), selfApiUrl: ORIGIN, now: () => clock })
    for (let i = 0; i < VIEWER_AERO_DAILY_TURN_LIMIT; i++) (await lane.acquireForTurn(project, 'viewer-a')).release()

    await expect(lane.acquireForTurn(project, 'viewer-a')).rejects.toMatchObject({ statusCode: 429 })
    ;(await lane.acquireForTurn(project, 'viewer-b')).release()
    clock = Date.parse('2026-09-24T00:00:01Z')
    ;(await lane.acquireForTurn(project, 'viewer-a')).release()
  })

  it('trims old turns whole, never splitting a tool call from its result', () => {
    const turn = [{ role: 'user' }, { role: 'assistant' }, { role: 'toolResult' }, { role: 'assistant' }]
    const long = Array.from({ length: 20 }, () => turn).flat()
    const trimmed = trimViewerTranscript(long)

    expect(trimmed.length).toBeLessThanOrEqual(MAX_VIEWER_MESSAGES)
    expect(trimmed[0]!.role).toBe('user')
    expect(trimmed).toEqual(long.slice(long.length - trimmed.length))
    expect(trimViewerTranscript(turn)).toBe(turn)
  })

  it('drops tools that only ever answer an operator', async () => {
    const turn = await sessions().acquireForTurn(project, 'viewer-a')
    const names = await reachableToolNames(turn.agent.state.tools)
    turn.release()

    const operatorOnly = canonryMcpTools.filter(t => t.tier === 'agent' || t.requiresOperator).map(t => t.name)
    expect(operatorOnly.length).toBeGreaterThan(0)
    for (const name of operatorOnly) expect(names).not.toContain(name)
  })

  it('removes keys a crash left behind when it starts, and only those', () => {
    db.insert(apiKeys).values({
      id: 'operator-named-alike',
      name: `${VIEWER_AERO_KEY_PREFIX}looks-similar`,
      keyHash: 'hash2',
      keyPrefix: 'cnry_oper',
      scopes: ['*'],
      createdAt: new Date().toISOString(),
    }).run()
    db.insert(apiKeys).values({
      id: 'orphan',
      name: `${VIEWER_AERO_KEY_PREFIX}viewer-a`,
      keyHash: 'hash',
      keyPrefix: 'cnry_orph',
      scopes: ['read'],
      delegatedUserId: 'viewer-a',
      createdAt: new Date().toISOString(),
    }).run()

    sessions()

    expect(db.select().from(apiKeys).where(eq(apiKeys.id, 'orphan')).all()).toEqual([])
    expect(db.select().from(apiKeys).where(eq(apiKeys.id, 'operator-named-alike')).all()).toHaveLength(1)
  })

  it('leaves the operator\'s prompt extras out of a viewer\'s prompt', async () => {
    const previous = process.env.AERO_SYSTEM_PROMPT_APPEND
    process.env.AERO_SYSTEM_PROMPT_APPEND = 'operator-only instruction'
    try {
      const turn = await sessions().acquireForTurn(project, 'viewer-a')
      turn.release()
      expect(turn.agent.state.systemPrompt).not.toContain('operator-only instruction')
    } finally {
      if (previous === undefined) delete process.env.AERO_SYSTEM_PROMPT_APPEND
      else process.env.AERO_SYSTEM_PROMPT_APPEND = previous
    }
  })
})

describe('agent routes with viewers allowed', () => {
  let tmpDir: string
  let db: DatabaseClient
  let app: FastifyInstance
  let principal: AuthPrincipal | undefined
  let lane: ViewerAeroSessions

  const viewer: AuthPrincipal = {
    kind: 'user', id: 'viewer-a', name: 'viewer-a', scopes: ['read'], projectId: null, role: 'viewer', viaCookie: true,
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-viewer-aero-routes-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    const project = seedProject(db)
    seedViewer(db, 'viewer-a')
    seedOperatorAero(db, project.id)

    app = Fastify()
    app.setErrorHandler((error, _req, reply) => {
      if (error instanceof AppError) return reply.status(error.statusCode).send(error.toJSON())
      return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: error.message } })
    })
    app.addHook('onRequest', async (request) => {
      request.principal = principal
    })
    registerAgentRoutes(app, {
      db,
      sessionRegistry: new SessionRegistry({ db, client: {} as unknown as ApiClient, config: config() }),
      viewerSessions: (lane = new ViewerAeroSessions({ db, config: config(), selfApiUrl: ORIGIN })),
    })
    await app.ready()
  })

  afterEach(async () => {
    principal = undefined
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('gives a viewer their own empty conversation, never the operator one', async () => {
    principal = viewer
    const res = await app.inject({ method: 'GET', url: '/projects/acme/agent/transcript' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ messages: [], conversationId: null, modelProvider: null, modelId: null })
    expect(res.body).not.toContain(OPERATOR_SECRET)
  })

  it('hides which model answered, what it cost, and tool details from a viewer', async () => {
    const turn = await lane.acquireForTurn({ id: 'proj_acme', name: 'acme' }, 'viewer-a')
    turn.agent.state.messages = [
      { role: 'user', content: 'how are we doing?', timestamp: 1 },
      { role: 'toolResult', toolCallId: 't1', toolName: 'canonry_project_overview', content: [{ type: 'text', text: 'ok' }], details: { big: 'payload' }, isError: false, timestamp: 2 },
      {
        role: 'assistant', content: [{ type: 'text', text: 'Mentioned in 3 of 4 answers.' }], api: 'openai-completions', provider: 'deepinfra',
        model: 'secret-model-id', responseId: 'resp_1', usage: { cost: { total: 0.01 } }, errorMessage: 'org org-123 rate limited', stopReason: 'stop', timestamp: 3,
      },
    ] as never
    turn.release()
    principal = viewer
    const res = await app.inject({ method: 'GET', url: '/projects/acme/agent/transcript' })

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Mentioned in 3 of 4 answers.')
    for (const hidden of ['secret-model-id', 'deepinfra', 'openai-completions', 'resp_1', 'cost', 'org-123', 'payload']) {
      expect(res.body).not.toContain(hidden)
    }
  })

  it('refuses an overlong viewer question before any turn starts', async () => {
    principal = viewer
    const res = await app.inject({ method: 'POST', url: '/projects/acme/agent/prompt', payload: { prompt: 'x'.repeat(4_001) } })

    expect(res.statusCode).toBe(400)
  })

  it('lets a viewer reset only their own conversation', async () => {
    principal = viewer
    const res = await app.inject({ method: 'DELETE', url: '/projects/acme/agent/transcript' })

    expect(res.statusCode).toBe(200)
    const [row] = db.select().from(agentSessions).all()
    expect(row!.messages).toContain(OPERATOR_SECRET)
  })

  it('validates a viewer prompt instead of refusing it', async () => {
    principal = viewer
    const res = await app.inject({ method: 'POST', url: '/projects/acme/agent/prompt', payload: { prompt: '' } })

    expect(res.statusCode).toBe(400)
  })

  it.each([
    ['GET', '/projects/acme/agent/providers'],
    ['GET', '/projects/acme/agent/memory'],
    ['GET', '/projects/acme/agent/conversations'],
    ['PUT', '/projects/acme/agent/memory'],
  ] as const)('still refuses a viewer on %s %s', async (method, url) => {
    principal = viewer
    const res = await app.inject({ method, url, ...(method === 'PUT' ? { payload: {} } : {}) })

    expect(res.statusCode).toBe(403)
    expect((res.json() as { error: { message: string } }).error.message).toBe(ADMIN_ONLY)
  })

  it('still refuses a read-only API key, which is not a viewer', async () => {
    principal = { kind: 'api-key', id: 'reader', name: 'reader', scopes: ['read'], projectId: null, viaCookie: false }
    for (const [method, url] of [['GET', '/projects/acme/agent/transcript'], ['POST', '/projects/acme/agent/prompt']] as const) {
      const res = await app.inject({ method, url, ...(method === 'POST' ? { payload: { prompt: '' } } : {}) })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
  })
})

describe.each([
  ['viewers allowed', true, false],
  ['viewers allowed, viewer research on', true, true],
  ['viewers not allowed', false, false],
])('a signed-in viewer on a real server (%s)', (_label, allowViewers, researchViewers) => {
  let tmpDir: string
  let db: DatabaseClient
  let app: Awaited<ReturnType<typeof createServer>>

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-viewer-aero-server-'))
    const dbPath = path.join(tmpDir, 'test.db')
    db = createClient(dbPath)
    migrate(db)
    const apiKey = `cnry_${crypto.randomBytes(16).toString('hex')}`
    // A stand-in dashboard page, so the injected client config can be read.
    const assetsDir = path.join(tmpDir, 'assets')
    fs.mkdirSync(assetsDir, { recursive: true })
    fs.writeFileSync(path.join(assetsDir, 'index.html'), '<!doctype html><html><head></head><body><div id="root"></div></body></html>')
    app = await createServer({
      config: { ...config({ agent: { allowViewers }, research: { allowViewers: researchViewers } }), database: dbPath, apiKey } as CanonryConfig,
      db,
      logger: false,
      assetsDir,
    })
    const seeded = await app.inject({
      method: 'PUT',
      url: '/api/v1/projects/acme',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { displayName: 'acme', canonicalDomain: 'acme.example.com', country: 'US', language: 'en' },
    })
    expect(seeded.statusCode).toBe(201)
    db.insert(users).values({
      id: crypto.randomUUID(),
      name: 'analyst',
      nameKey: 'analyst',
      passwordHash: await hashUserPassword('a-long-enough-viewer-password'),
      role: 'viewer',
      createdAt: new Date().toISOString(),
    }).run()
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function signIn(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: ORIGIN, host: HOST },
      payload: { name: 'analyst', password: 'a-long-enough-viewer-password' },
    })
    expect(res.statusCode).toBe(200)
    return res.cookies.map(({ name, value }) => `${name}=${value}`).join('; ')
  }

  it('serves the viewer lane only when the install opts in', async () => {
    const cookie = await signIn()
    const headers = { cookie, origin: ORIGIN, host: HOST }
    const transcript = await app.inject({ method: 'GET', url: '/api/v1/projects/acme/agent/transcript', headers })
    const prompt = await app.inject({ method: 'POST', url: '/api/v1/projects/acme/agent/prompt', headers, payload: { prompt: '' } })
    const memory = await app.inject({ method: 'GET', url: '/api/v1/projects/acme/agent/memory', headers })

    expect(transcript.statusCode).toBe(allowViewers ? 200 : 403)
    expect(prompt.statusCode).toBe(allowViewers ? 400 : 403)
    expect(memory.statusCode).toBe(403)
  })

  it('refuses a viewer prompt from another site', async () => {
    const cookie = await signIn()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/acme/agent/prompt',
      headers: { cookie, origin: 'https://attacker.example', host: HOST },
      payload: { prompt: 'hello' },
    })

    expect(res.statusCode).toBe(403)
  })

  it('runs viewer tools with the viewer\'s authority, so the operator memory and history stay closed', async () => {
    const address = await app.listen({ port: 0, host: '127.0.0.1' })
    const viewerId = db.select().from(users).all().find(u => u.role === 'viewer')!.id
    const operatorProject = db.select().from(projects).all()[0]!
    upsertMemoryEntry(db, { projectId: operatorProject.id, key: 'renewal', value: OPERATOR_SECRET, source: MemorySources.user })
    // The same key the lane mints for a turn. The lane leaves these tools out
    // of the catalog; here they run anyway, to prove the key itself is refused.
    const key = mintViewerAeroKey(db, viewerId)
    const client = new ApiClient(address, key.raw, { skipProbe: true, surface: 'aero' })
    const everyReadTool = buildAeroStateTools({ client, projectName: operatorProject.name }, { scope: AeroToolScopes.readOnly })

    for (const name of ['canonry_memory_list', 'canonry_agent_conversations_list']) {
      const tool = everyReadTool.find(t => t.name === name)
      expect(tool, name).toBeDefined()
      const outcome = await tool!.execute('call', {}).then(r => JSON.stringify(r.details), (err: unknown) => String(err))
      expect(outcome, name).not.toContain(OPERATOR_SECRET)
      expect(outcome, name).toMatch(/administrator/i)
    }
    const tools = buildViewerAeroTools(client, operatorProject.name)
    const overview = await tools.find(t => t.name === 'canonry_project_overview')!.execute('call', {})
    expect(JSON.stringify(overview.details)).toContain('acme')
  })

  it('advertises the opt-in to the dashboard only when it is on', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    const injected = res.body.match(/window\.__CANONRY_CONFIG__=(.*?)<\/script>/)?.[1] ?? ''

    if (allowViewers) expect(injected).toContain('"agent":{"allowViewers":true}')
    else expect(injected).not.toContain('allowViewers":true}')
  })
})
