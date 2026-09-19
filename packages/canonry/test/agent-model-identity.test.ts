/**
 * Which model answers is administrator knowledge.
 *
 * `requireAdminSession` refuses signed-in VIEWERS, but it passes any API key,
 * because a key carries no role. So a narrow key (a read-only one, or one
 * scoped to a single project) used to reach these reads. It no longer does:
 * `requireInstanceAdministrator` asks both questions, so such a key is refused
 * outright rather than served a trimmed body.
 *
 * Refusal rather than redaction, because identity was never the only secret on
 * these routes. There is one Aero session per project, so the transcript is the
 * operator's conversation, and memory holds operator notes plus LLM-written
 * summaries OF that conversation. Stripping provenance would have hidden which
 * model answered while still handing over everything it said.
 *
 * Three places leak identity, and all three are covered here:
 *   - the transcript's `modelProvider` / `modelId`
 *   - per-message provenance on every persisted assistant message
 *     (`model`, `provider`, `api`, and `usage`, which carries cost)
 *   - the provider catalog, which names a default model per provider
 *
 * The leak scan is built FROM the registry rather than from a hand-written
 * list, so a model added later is covered without editing this file. Every
 * route it scans is SEEDED with content that would fail the scan if served:
 * an empty body passes a leak scan for the wrong reason.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { createClient, migrate, agentMemory, agentSessions, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { AGENT_PROVIDER_IDS, AppError } from '@ainyc/canonry-contracts'
import type { AuthPrincipal } from '@ainyc/canonry-api-routes'
import { registerAgentRoutes } from '../src/agent/agent-routes.js'
import { SessionRegistry } from '../src/agent/session-registry.js'
import { AGENT_PROVIDERS, PROVIDER_MODELS } from '../src/agent/providers.js'
import type { ApiClient } from '../src/client.js'
import type { CanonryConfig } from '../src/config.js'

const PROJECT = 'acme'
const SESSION_PROVIDER = 'deepinfra'
const SESSION_MODEL = 'deepseek-ai/DeepSeek-V4-Flash'
const ANSWER_TEXT = 'Coverage held steady across the tracked basket.'
const QUESTION_TEXT = 'How did coverage move this week?'

/**
 * Memory rows that name the provider and model outright. Without them the
 * memory route returns `{"entries":[]}` and its leak scan passes vacuously,
 * which is precisely the route with the most to disclose: `writeCompactionNote`
 * persists LLM summaries of the operator's transcript here.
 */
const MEMORY_NOTE = 'Aero answers through DeepInfra (GLM / DeepSeek) on deepseek-ai/DeepSeek-V4-Flash.'
const COMPACTION_NOTE = 'Earlier turns summarized: deepseek-ai/DeepSeek-V4-Flash reported the basket held.'

/**
 * Every string that would disclose provider or model identity, derived from
 * the registry itself: the provider ids, their user-facing labels, and every
 * model id shipped for any capability tier. A future provider or model tier
 * joins this set automatically.
 */
function identityStrings(): string[] {
  const out = new Set<string>()
  for (const id of AGENT_PROVIDER_IDS) {
    out.add(id)
    out.add(AGENT_PROVIDERS[id].label)
    out.add(AGENT_PROVIDERS[id].defaultModel)
    for (const model of Object.values(PROVIDER_MODELS[id])) out.add(model)
  }
  // The persisted session's own pair, plus the pi-ai transport name, which
  // embeds a vendor and is therefore just as disclosing.
  out.add(SESSION_PROVIDER)
  out.add(SESSION_MODEL)
  out.add('openai-completions')
  return [...out].filter(value => value.length > 0)
}

function stubClient(): ApiClient {
  return {} as unknown as ApiClient
}

function stubConfig(): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: ':memory:',
    apiKey: 'cnry_test',
    // Two configured providers, so the catalog is not empty for an admin and a
    // redacted catalog is visibly different rather than coincidentally equal.
    providers: { claude: { apiKey: 'anthropic-key' }, deepinfra: { apiKey: 'deepinfra-key' } },
  } as CanonryConfig
}

/** A full-instance install key: what the CLI and MCP present. */
const ROOT_KEY_PRINCIPAL: AuthPrincipal = {
  kind: 'api-key',
  id: 'root',
  name: 'root',
  scopes: ['*'],
  projectId: null,
  viaCookie: false,
}

/** A read-only key. Authorized to read, not to know what runs the agent. */
const READ_ONLY_PRINCIPAL: AuthPrincipal = {
  kind: 'api-key',
  id: 'reader',
  name: 'reader',
  scopes: ['read'],
  projectId: null,
  viaCookie: false,
}

/** A key confined to one project. Never an instance-wide administrator. */
const PROJECT_KEY_PRINCIPAL: AuthPrincipal = {
  kind: 'api-key',
  id: 'project-key',
  name: 'project-key',
  scopes: ['*'],
  projectId: 'proj_acme',
  viaCookie: false,
}

const ADMIN_SESSION_PRINCIPAL: AuthPrincipal = {
  kind: 'user',
  id: 'admin-user',
  name: 'owner',
  scopes: ['*'],
  projectId: null,
  role: 'admin',
  viaCookie: true,
}

describe('Aero model identity is administrator-only', () => {
  let tmpDir: string
  let db: DatabaseClient
  let app: FastifyInstance
  let principal: AuthPrincipal | undefined

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-agent-identity-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
    const now = new Date().toISOString()
    db.insert(projects).values({
      id: 'proj_acme',
      name: PROJECT,
      displayName: PROJECT,
      canonicalDomain: 'acme.example.com',
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()

    // A transcript that looks like a real one: the session pins a provider and
    // model, and the assistant turn carries pi's provenance and cost block.
    db.insert(agentSessions).values({
      id: crypto.randomUUID(),
      projectId: 'proj_acme',
      systemPrompt: 'system',
      modelProvider: SESSION_PROVIDER,
      modelId: SESSION_MODEL,
      messages: JSON.stringify([
        { role: 'user', content: QUESTION_TEXT, timestamp: 1 },
        {
          role: 'assistant',
          content: [{ type: 'text', text: ANSWER_TEXT }],
          api: 'openai-completions',
          provider: SESSION_PROVIDER,
          model: SESSION_MODEL,
          stopReason: 'stop',
          timestamp: 2,
          usage: {
            input: 1200,
            output: 340,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1540,
            cost: { input: 0.000108, output: 0.0000612, cacheRead: 0, cacheWrite: 0, total: 0.0001692 },
          },
        },
      ]),
      followUpQueue: '[]',
      createdAt: now,
      updatedAt: now,
    }).run()

    // An operator note and a compaction summary, both naming the model.
    db.insert(agentMemory).values([
      {
        id: crypto.randomUUID(),
        projectId: 'proj_acme',
        key: 'operator-note',
        value: MEMORY_NOTE,
        source: 'user',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: crypto.randomUUID(),
        projectId: 'proj_acme',
        key: 'compaction:session:1',
        value: COMPACTION_NOTE,
        source: 'compaction',
        createdAt: now,
        updatedAt: now,
      },
    ]).run()

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
      sessionRegistry: new SessionRegistry({ db, client: stubClient(), config: stubConfig() }),
    })
    await app.ready()
  })

  afterEach(async () => {
    principal = undefined
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const get = (url: string) => app.inject({ method: 'GET', url })

  describe.each([
    ['a read-only key', READ_ONLY_PRINCIPAL],
    ['a project-scoped key', PROJECT_KEY_PRINCIPAL],
  ])('%s', (_label, nonAdmin) => {
    it.each(['transcript', 'providers', 'memory'])('is refused on /%s', async (route) => {
      principal = nonAdmin
      expect((await get(`/projects/${PROJECT}/agent/${route}`)).statusCode).toBe(403)
    })

    it('does not get the conversation either', async () => {
      principal = nonAdmin
      const body = (await get(`/projects/${PROJECT}/agent/transcript`)).body

      expect(body).not.toContain(ANSWER_TEXT)
      expect(body).not.toContain(QUESTION_TEXT)
    })

    it('does not get the operator memory notes', async () => {
      principal = nonAdmin
      const body = (await get(`/projects/${PROJECT}/agent/memory`)).body

      expect(body).not.toContain(MEMORY_NOTE)
      expect(body).not.toContain(COMPACTION_NOTE)
    })

    it.each(['transcript', 'providers', 'memory'])(
      'leaks no provider or model string anywhere in the /%s body',
      async (route) => {
        principal = nonAdmin
        const body = (await get(`/projects/${PROJECT}/agent/${route}`)).body.toLowerCase()

        // A whole-body scan, not a field list: a field added later cannot
        // reintroduce the leak without failing here.
        for (const secret of identityStrings()) {
          expect(body, `"${secret}" appeared in the ${route} response`).not.toContain(secret.toLowerCase())
        }
      },
    )

    it('does not change what is stored', async () => {
      principal = nonAdmin
      await get(`/projects/${PROJECT}/agent/transcript`)

      const row = db.select().from(agentSessions).all()[0]!
      expect(row.modelProvider).toBe(SESSION_PROVIDER)
      expect(row.modelId).toBe(SESSION_MODEL)
      expect(row.messages).toContain(SESSION_MODEL)
    })
  })

  describe.each([
    ['an install root key', ROOT_KEY_PRINCIPAL],
    ['a signed-in administrator', ADMIN_SESSION_PRINCIPAL],
  ])('%s', (_label, admin) => {
    it('still sees the provider and model on the transcript', async () => {
      principal = admin
      const body = (await get(`/projects/${PROJECT}/agent/transcript`)).json() as {
        modelProvider: string
        modelId: string
        messages: Record<string, unknown>[]
      }

      expect(body.modelProvider).toBe(SESSION_PROVIDER)
      expect(body.modelId).toBe(SESSION_MODEL)
      const assistant = body.messages.find(message => message.role === 'assistant')!
      expect(assistant.model).toBe(SESSION_MODEL)
      expect(assistant.provider).toBe(SESSION_PROVIDER)
      expect(assistant.api).toBe('openai-completions')
      expect(assistant.usage).toBeDefined()
    })

    it('still sees the memory notes', async () => {
      principal = admin
      const body = (await get(`/projects/${PROJECT}/agent/memory`)).body

      // Also the anti-vacuity control for the non-admin memory scan above:
      // it proves the seeded rows exist and do reach this route.
      expect(body).toContain(MEMORY_NOTE)
      expect(body).toContain(COMPACTION_NOTE)
    })

    it('still sees the full provider catalog', async () => {
      principal = admin
      const body = (await get(`/projects/${PROJECT}/agent/providers`)).json() as {
        providers: { id: string; defaultModel: string }[]
        defaultProvider: string | null
      }

      expect(body.providers.length).toBe(AGENT_PROVIDER_IDS.length)
      const deepinfra = body.providers.find(entry => entry.id === SESSION_PROVIDER)
      expect(deepinfra?.defaultModel).toBe(AGENT_PROVIDERS[SESSION_PROVIDER].defaultModel)
      expect(body.defaultProvider).not.toBeNull()
    })
  })
})
