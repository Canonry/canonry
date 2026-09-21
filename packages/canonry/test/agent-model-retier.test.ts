import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, MIGRATION_VERSIONS, agentSessions, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { SessionRegistry } from '../src/agent/session-registry.js'
import { AGENT_PROVIDERS } from '../src/agent/providers.js'
import { AeroToolScopes } from '../src/agent/tools.js'
import type { ApiClient } from '../src/client.js'
import type { CanonryConfig } from '../src/config.js'

const PROJECT = 'acme'
const PROJECT_ID = 'proj_acme'

/** What DeepInfra's agent tier used to be, and what old rows still carry. */
const RETIRED_MODEL = 'zai-org/GLM-5.2'
/** What it is now. */
const CURRENT_MODEL = AGENT_PROVIDERS.deepinfra.defaultModel

function stubClient(): ApiClient {
  return {} as unknown as ApiClient
}

function stubConfig(): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: ':memory:',
    apiKey: 'cnry_test',
    providers: { deepinfra: { apiKey: 'deepinfra-key' } },
  } as CanonryConfig
}

describe('the one-time agent model migration', () => {
  let tmpDir: string
  let db: DatabaseClient
  let registry: SessionRegistry

  /** Seed the row an install that already used DeepInfra would be carrying. */
  function seedSession(modelProvider: string, modelId: string): void {
    const now = new Date().toISOString()
    db.insert(agentSessions).values({
      id: crypto.randomUUID(),
      projectId: PROJECT_ID,
      systemPrompt: 'system',
      modelProvider,
      modelId,
      messages: '[]',
      followUpQueue: '[]',
      createdAt: now,
      updatedAt: now,
    }).run()
  }

  const storedModelId = () =>
    db.select().from(agentSessions).all()[0]!.modelId

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-agent-retier-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version < 158))
    const now = new Date().toISOString()
    db.insert(projects).values({
      id: PROJECT_ID,
      name: PROJECT,
      displayName: PROJECT,
      canonicalDomain: 'acme.example.com',
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()
    registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
  })

  afterEach(() => {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('answers on the current tier when the turn names no provider', async () => {
    seedSession('deepinfra', RETIRED_MODEL)
    migrate(db)

    // Exactly what the prompt route passes when the request body carries no
    // provider and no model, which is every turn until someone opens the
    // provider picker for this project.
    const agent = await registry.acquireForTurn(PROJECT, { toolScope: AeroToolScopes.readOnly })

    expect((agent.state.model as { id: string }).id).toBe(CURRENT_MODEL)
  })

  it('persists the upgraded default before a session is hydrated', () => {
    seedSession('deepinfra', RETIRED_MODEL)
    migrate(db)

    expect(storedModelId()).toBe(CURRENT_MODEL)
  })

  it('leaves a model that is still the provider current tier alone', async () => {
    seedSession('deepinfra', CURRENT_MODEL)
    migrate(db)

    const agent = await registry.acquireForTurn(PROJECT, { toolScope: AeroToolScopes.readOnly })

    expect((agent.state.model as { id: string }).id).toBe(CURRENT_MODEL)
    expect(storedModelId()).toBe(CURRENT_MODEL)
  })

  it('leaves an unrelated provider own pin alone', async () => {
    // Claude has retired nothing, so a Claude session must be untouched even
    // though the id it carries is not the current default.
    seedSession('claude', 'claude-opus-4-5')
    migrate(db)

    await registry.acquireForTurn(PROJECT, { toolScope: AeroToolScopes.readOnly })

    expect(storedModelId()).toBe('claude-opus-4-5')
  })

  it('still honours an explicit model the caller asked for', async () => {
    seedSession('deepinfra', RETIRED_MODEL)
    migrate(db)

    // DeepInfra is an OpenAI-compatible host: any slug it serves is valid, so
    // an explicit `--model` must not be overridden by the retirement rule.
    const agent = await registry.acquireForTurn(PROJECT, {
      provider: 'deepinfra',
      modelId: 'deepseek-ai/DeepSeek-V3.1',
      toolScope: AeroToolScopes.readOnly,
    })

    expect((agent.state.model as { id: string }).id).toBe('deepseek-ai/DeepSeek-V3.1')
    expect(storedModelId()).toBe('deepseek-ai/DeepSeek-V3.1')
  })

  it.each([RETIRED_MODEL, 'deepseek-ai/DeepSeek-V3.1'])(
    'preserves an explicit %s selection across migration reruns and cold hydration',
    async (modelId) => {
      seedSession('deepinfra', RETIRED_MODEL)
      migrate(db)
      const selected = await registry.acquireForTurn(PROJECT, {
        provider: 'deepinfra', modelId, toolScope: AeroToolScopes.readOnly,
      })
      expect(selected.state.model.id).toBe(modelId)
      expect(storedModelId()).toBe(modelId)

      migrate(db)
      registry = new SessionRegistry({ db, client: stubClient(), config: stubConfig() })
      const resumed = await registry.acquireForTurn(PROJECT, { toolScope: AeroToolScopes.readOnly })
      expect(resumed.state.model.id).toBe(modelId)
      expect(storedModelId()).toBe(modelId)
    },
  )
})
