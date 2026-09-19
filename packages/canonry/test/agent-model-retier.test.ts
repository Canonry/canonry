/**
 * A retired agent-tier model must not keep answering after an upgrade.
 *
 * `PROVIDER_MODELS[deepinfra].agent` used to be GLM-5.2 and is now
 * DeepSeek-V4-Flash. Every install that had already used DeepInfra carries the
 * old id in `agent_sessions.model_id`, and nothing in the turn path re-reads a
 * persisted pin against its provider's current tier:
 *
 *   - the dashboard bar sends `provider` only after someone opens the picker
 *     for that project (it is remembered per project in localStorage), so an
 *     ordinary turn sends no provider and no model at all,
 *   - `acquireForTurn` only calls `alignModel` when the caller passed one of
 *     them,
 *   - and the hydrate path takes `row.modelId` verbatim.
 *
 * So the session stays pinned to the retired model indefinitely, on a provider
 * whose whole point was the cheaper tier. These tests drive the no-preference
 * path, which is the common one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, migrate, agentSessions, projects, type DatabaseClient } from '@ainyc/canonry-db'
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

describe('a session pinned to a retired agent model', () => {
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
    migrate(db)
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
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('answers on the current tier when the turn names no provider', async () => {
    seedSession('deepinfra', RETIRED_MODEL)

    // Exactly what the prompt route passes when the request body carries no
    // provider and no model, which is every turn until someone opens the
    // provider picker for this project.
    const agent = await registry.acquireForTurn(PROJECT, { toolScope: AeroToolScopes.readOnly })

    expect((agent.state.model as { id: string }).id).toBe(CURRENT_MODEL)
  })

  it('persists the repin, so the next process does not pay for it again', async () => {
    seedSession('deepinfra', RETIRED_MODEL)

    await registry.acquireForTurn(PROJECT, { toolScope: AeroToolScopes.readOnly })

    expect(storedModelId()).toBe(CURRENT_MODEL)
  })

  it('leaves a model that is still the provider current tier alone', async () => {
    seedSession('deepinfra', CURRENT_MODEL)

    const agent = await registry.acquireForTurn(PROJECT, { toolScope: AeroToolScopes.readOnly })

    expect((agent.state.model as { id: string }).id).toBe(CURRENT_MODEL)
    expect(storedModelId()).toBe(CURRENT_MODEL)
  })

  it('leaves an unrelated provider own pin alone', async () => {
    // Claude has retired nothing, so a Claude session must be untouched even
    // though the id it carries is not the current default.
    seedSession('claude', 'claude-opus-4-5')

    await registry.acquireForTurn(PROJECT, { toolScope: AeroToolScopes.readOnly })

    expect(storedModelId()).toBe('claude-opus-4-5')
  })

  it('still honours an explicit model the caller asked for', async () => {
    seedSession('deepinfra', RETIRED_MODEL)

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
})
