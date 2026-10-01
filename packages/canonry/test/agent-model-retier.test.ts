import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  createClient,
  migrate,
  MIGRATION_VERSIONS,
  agentSessions,
  parseJsonColumn,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { SessionRegistry } from '../src/agent/session-registry.js'
import { AGENT_PROVIDERS, type SupportedAgentProvider } from '../src/agent/providers.js'
import { AeroToolScopes } from '../src/agent/tools.js'
import type { ApiClient } from '../src/client.js'
import type { CanonryConfig } from '../src/config.js'

// DeepInfra was an Aero provider until it was removed. Sessions it answered
// still carry `model_provider = 'deepinfra'` in `agent_sessions`, and so do the
// rows migration 158 retiered. Such a row must resume, transcript intact, on a
// provider Canonry still has instead of failing every turn for that project.

const PROJECT = 'acme'
const PROJECT_ID = 'proj_acme'
const RETIRED_PROVIDER = 'deepinfra'
/** The DeepInfra agent default after migration 158, and the slug it moved rows off. */
const STORED_MODEL_IDS = ['deepseek-ai/DeepSeek-V4-Flash', 'zai-org/GLM-5.2'] as const

// Every key comes from `cfg()`. A shell exporting a provider's env var would
// otherwise change which provider auto-detection picks.
const PROVIDER_KEY_ENV = [
  'ANTHROPIC_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GEMINI_BASE_URL',
  'ZAI_API_KEY',
]

function stubClient(): ApiClient {
  return {} as unknown as ApiClient
}

/**
 * An install that used DeepInfra: its old key is still in config.yaml, which
 * no longer counts for Aero, next to whatever direct keys the test adds.
 */
function cfg(
  providers: Record<string, { apiKey?: string }>,
  agent?: CanonryConfig['agent'],
): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: ':memory:',
    apiKey: 'cnry_test',
    providers: { [RETIRED_PROVIDER]: { apiKey: 'leftover-deepinfra-key' }, ...providers },
    ...(agent ? { agent } : {}),
  } as CanonryConfig
}

/** A tool-using exchange as DeepInfra's OpenAI-compatible host recorded it. */
function deepInfraTranscript(model: string): AgentMessage[] {
  const startedAt = Date.parse('2026-09-20T14:00:00.000Z')
  const usage = {
    input: 1840,
    output: 96,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1936,
    cost: { input: 0.0005, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0006 },
  }
  const answeredBy = { api: 'openai-completions', provider: RETIRED_PROVIDER, model, usage }
  return [
    { role: 'user', content: 'Which tracked queries lost a mention this week?', timestamp: startedAt },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call_0', name: 'canonry_visibility_report', arguments: { project: PROJECT } }],
      ...answeredBy,
      stopReason: 'toolUse',
      timestamp: startedAt + 1_000,
    },
    {
      role: 'toolResult',
      toolCallId: 'call_0',
      toolName: 'canonry_visibility_report',
      content: [{ type: 'text', text: '{"checked":12,"mentioned":9,"lost":["best crm for agencies"]}' }],
      isError: false,
      timestamp: startedAt + 2_000,
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'One query lost its mention: "best crm for agencies".' }],
      ...answeredBy,
      stopReason: 'stop',
      timestamp: startedAt + 3_000,
    },
  ] as unknown as AgentMessage[]
}

describe('a session row left on the removed deepinfra provider', () => {
  let tmpDir: string
  let db: DatabaseClient

  /**
   * Seed the row while the database is still at the schema DeepInfra shipped
   * with, then upgrade it, which is the path a real install takes.
   */
  function seedRetiredSession(modelId: string): AgentMessage[] {
    const transcript = deepInfraTranscript(modelId)
    const now = new Date().toISOString()
    db.insert(agentSessions).values({
      id: crypto.randomUUID(),
      projectId: PROJECT_ID,
      systemPrompt: 'system',
      modelProvider: RETIRED_PROVIDER,
      modelId,
      messages: JSON.stringify(transcript),
      followUpQueue: '[]',
      createdAt: now,
      updatedAt: now,
    }).run()
    migrate(db)
    return transcript
  }

  const storedRow = () =>
    db.select().from(agentSessions).where(eq(agentSessions.projectId, PROJECT_ID)).get()!

  const conversation = (messages: readonly AgentMessage[]) =>
    messages.filter((message) => message.role !== 'system')

  function expectOn(agent: { state: { model: { provider: string; id: string } } }, provider: SupportedAgentProvider, modelId: string) {
    expect(agent.state.model.provider).toBe(AGENT_PROVIDERS[provider].piAiProvider)
    expect(agent.state.model.id).toBe(modelId)
    expect(storedRow().modelProvider).toBe(provider)
    expect(storedRow().modelId).toBe(modelId)
  }

  beforeEach(() => {
    for (const name of PROVIDER_KEY_ENV) vi.stubEnv(name, '')
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-agent-retired-provider-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version < 158))
    const now = new Date().toISOString()
    // Physical columns only: Drizzle names every current project column, and
    // this database is still below v158.
    db.$client.prepare('INSERT INTO projects (id, name, display_name, canonical_domain, country, language, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(PROJECT_ID, PROJECT, PROJECT, 'acme.example.com', 'US', 'en', now, now)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it.each(STORED_MODEL_IDS)(
    'with no pin, a %s row resumes on the auto-detected provider and its default model',
    async (modelId) => {
      seedRetiredSession(modelId)
      const registry = new SessionRegistry({ db, client: stubClient(), config: cfg({ openai: { apiKey: 'sk-test' } }) })

      // Exactly what the prompt route passes when the request names neither a
      // provider nor a model.
      const agent = await registry.acquireForTurn(PROJECT, { toolScope: AeroToolScopes.readOnly })

      expectOn(agent, 'openai', AGENT_PROVIDERS.openai.defaultModel)
    },
  )

  it('with no direct key at all, fails like a fresh install and leaves the row for the key added later', async () => {
    const transcript = seedRetiredSession('deepseek-ai/DeepSeek-V4-Flash')
    const keyless = new SessionRegistry({ db, client: stubClient(), config: cfg({}) })

    // Nothing is pinned, stored, or detected. Recording a provider nobody chose
    // would outrank detection on every later turn, so the turn fails with the
    // fresh-install message and the row is not touched.
    await expect(keyless.acquireForTurn(PROJECT, { toolScope: AeroToolScopes.readOnly }))
      .rejects.toThrow(/No agent LLM provider configured/)
    expect(storedRow().modelProvider).toBe(RETIRED_PROVIDER)
    expect(storedRow().modelId).toBe('deepseek-ai/DeepSeek-V4-Flash')

    // The operator adds a direct key: detection picks it up on the next turn.
    const keyed = new SessionRegistry({ db, client: stubClient(), config: cfg({ zai: { apiKey: 'zai-test' } }) })
    const agent = await keyed.acquireForTurn(PROJECT, { toolScope: AeroToolScopes.readOnly })

    expectOn(agent, 'zai', AGENT_PROVIDERS.zai.defaultModel)
    expect(conversation(agent.state.messages)).toEqual(transcript)
  })

  it('with no direct key at all, does not pile up proactive follow-ups for the first keyed turn', () => {
    seedRetiredSession('deepseek-ai/DeepSeek-V4-Flash')
    const keyless = new SessionRegistry({ db, client: stubClient(), config: cfg({}) })
    const wake = { role: 'user', content: '[system] Run run_1 completed.', timestamp: Date.now() } as unknown as AgentMessage

    // A fresh install with no key cannot queue either: the wake is dropped
    // where it is raised instead of replaying in bulk once a key exists.
    expect(() => keyless.queueFollowUp(PROJECT, wake)).toThrow(/No agent LLM provider configured/)
    expect(parseJsonColumn<AgentMessage[]>(storedRow().followUpQueue, [])).toEqual([])
    expect(storedRow().modelProvider).toBe(RETIRED_PROVIDER)
  })

  it('a pinned agent.provider and agent.model win over auto-detection', async () => {
    seedRetiredSession('deepseek-ai/DeepSeek-V4-Flash')
    // OpenAI sorts ahead of Gemini for auto-detection, so landing on Gemini
    // proves the pin, not detection, chose the provider.
    const config = cfg(
      { openai: { apiKey: 'sk-test' }, gemini: { apiKey: 'gemini-test' } },
      { provider: 'gemini', model: 'gemini-2.5-pro' },
    )
    const registry = new SessionRegistry({ db, client: stubClient(), config })

    const agent = await registry.acquireForTurn(PROJECT, { toolScope: AeroToolScopes.readOnly })

    expectOn(agent, 'gemini', 'gemini-2.5-pro')
  })

  it('a pin without agent.model takes the pinned provider default, never the stored DeepInfra slug', async () => {
    // GLM-5.2 is a model zai also serves, but under its own id: the DeepInfra
    // slug must not be forwarded to a different host.
    seedRetiredSession('zai-org/GLM-5.2')
    const config = cfg({ openai: { apiKey: 'sk-test' }, zai: { apiKey: 'zai-test' } }, { provider: 'zai' })
    const registry = new SessionRegistry({ db, client: stubClient(), config })

    const agent = await registry.acquireForTurn(PROJECT, { toolScope: AeroToolScopes.readOnly })

    expectOn(agent, 'zai', AGENT_PROVIDERS.zai.defaultModel)
  })

  it('keeps the DeepInfra transcript intact through hydration and the next save', async () => {
    const transcript = seedRetiredSession('deepseek-ai/DeepSeek-V4-Flash')
    const registry = new SessionRegistry({ db, client: stubClient(), config: cfg({ openai: { apiKey: 'sk-test' } }) })

    const agent = await registry.acquireForTurn(PROJECT, { toolScope: AeroToolScopes.readOnly })

    expect(conversation(agent.state.messages)).toEqual(transcript)
    // Rewriting the row's provider and model must not touch the messages column.
    expect(parseJsonColumn<AgentMessage[]>(storedRow().messages, [])).toEqual(transcript)

    registry.save(PROJECT)
    expect(parseJsonColumn<AgentMessage[]>(storedRow().messages, [])).toEqual(transcript)

    // A restart hydrates the rewritten row: still on the new provider, same transcript.
    const restarted = new SessionRegistry({ db, client: stubClient(), config: cfg({ openai: { apiKey: 'sk-test' } }) })
    const resumed = restarted.getOrCreate(PROJECT)
    expectOn(resumed, 'openai', AGENT_PROVIDERS.openai.defaultModel)
    expect(conversation(resumed.state.messages)).toEqual(transcript)
  })

  it.each([
    { label: 'no pin', agent: undefined },
    { label: 'a gemini pin', agent: { provider: 'gemini', model: 'gemini-2.5-pro' } as const },
  ])('with $label, an explicit per-turn provider still wins', async ({ agent: pin }) => {
    seedRetiredSession('deepseek-ai/DeepSeek-V4-Flash')
    const config = cfg(
      { openai: { apiKey: 'sk-test' }, gemini: { apiKey: 'gemini-test' }, zai: { apiKey: 'zai-test' } },
      pin,
    )
    const registry = new SessionRegistry({ db, client: stubClient(), config })

    const defaulted = await registry.acquireForTurn(PROJECT, { provider: 'zai', toolScope: AeroToolScopes.readOnly })
    expectOn(defaulted, 'zai', AGENT_PROVIDERS.zai.defaultModel)

    const chosen = await registry.acquireForTurn(PROJECT, {
      provider: 'zai',
      modelId: 'glm-5-turbo',
      toolScope: AeroToolScopes.readOnly,
    })
    expectOn(chosen, 'zai', 'glm-5-turbo')
  })
})
