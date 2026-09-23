import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { agentSessions, createClient, migrate, projects, type DatabaseClient } from '@ainyc/canonry-db'
import { buildAgentProvidersResponse } from '../src/agent/providers.js'
import { describeAgentPin, resolveConfiguredAgentProvider, resolveSessionProviderAndModel } from '../src/agent/session.js'
import { SessionRegistry } from '../src/agent/session-registry.js'
import { AeroToolScopes } from '../src/agent/tools.js'
import type { ApiClient } from '../src/client.js'
import type { CanonryConfig } from '../src/config.js'

// Every key comes from `cfg()`. A developer or CI shell exporting a provider's
// env var would otherwise make "no key" cases pass or fail by accident.
const PROVIDER_KEY_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ZAI_API_KEY', 'DEEPINFRA_TOKEN']
beforeEach(() => { for (const name of PROVIDER_KEY_ENV) vi.stubEnv(name, '') })
afterEach(() => { vi.unstubAllEnvs() })

/**
 * Install-shaped config: answer-engine keys for the sweep providers, which is
 * exactly the situation where auto-detection silently hands Aero to Claude
 * because it sorts first by `autoDetectPriority`.
 */
function cfg(agent?: CanonryConfig['agent'], providers?: Record<string, { apiKey?: string }>): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: ':memory:',
    apiKey: 'cnry_test',
    providers: providers ?? { claude: { apiKey: 'k' }, deepinfra: { apiKey: 'k' } },
    ...(agent ? { agent } : {}),
  } as CanonryConfig
}

describe('resolveConfiguredAgentProvider', () => {
  it('is undefined with no agent block and no pin', () => {
    expect(resolveConfiguredAgentProvider(cfg())).toBeUndefined()
    expect(resolveConfiguredAgentProvider(cfg({ mode: 'prompt-only' }))).toBeUndefined()
  })

  it('returns the pinned provider', () => {
    expect(resolveConfiguredAgentProvider(cfg({ provider: 'deepinfra' }))).toBe('deepinfra')
  })

  it('coerces an unknown id to undefined rather than trusting it', () => {
    expect(resolveConfiguredAgentProvider(cfg({ provider: 'nope' } as CanonryConfig['agent']))).toBeUndefined()
  })
})

describe('resolveSessionProviderAndModel', () => {
  it('without a pin, auto-detects by priority (claude wins over deepinfra)', () => {
    expect(resolveSessionProviderAndModel(cfg()).provider).toBe('claude')
  })

  it('a pin beats auto-detection even though claude sorts first and has a key', () => {
    const { provider, modelId } = resolveSessionProviderAndModel(cfg({ provider: 'deepinfra' }))
    expect(provider).toBe('deepinfra')
    expect(modelId).toBe('deepseek-ai/DeepSeek-V4-Flash')
  })

  it('agent.model pins the model id alongside the provider', () => {
    const { provider, modelId } = resolveSessionProviderAndModel(
      cfg({ provider: 'deepinfra', model: 'zai-org/GLM-5.2' }),
    )
    expect(provider).toBe('deepinfra')
    expect(modelId).toBe('zai-org/GLM-5.2')
  })

  it('an explicit request outranks the pin', () => {
    expect(resolveSessionProviderAndModel(cfg({ provider: 'deepinfra' }), { provider: 'claude' }).provider)
      .toBe('claude')
  })

  it('does NOT carry agent.model onto a provider the caller asked for instead', () => {
    // Forwarding DeepInfra's slug to Anthropic would be a request that cannot
    // succeed, so the requested provider must fall back to its own default.
    const { provider, modelId } = resolveSessionProviderAndModel(
      cfg({ provider: 'deepinfra', model: 'zai-org/GLM-5.2' }),
      { provider: 'claude' },
    )
    expect(provider).toBe('claude')
    expect(modelId).not.toBe('zai-org/GLM-5.2')
  })

  it('an explicit modelId outranks agent.model', () => {
    expect(resolveSessionProviderAndModel(
      cfg({ provider: 'deepinfra', model: 'zai-org/GLM-5.2' }),
      { modelId: 'deepseek-ai/DeepSeek-V4-Pro' },
    ).modelId).toBe('deepseek-ai/DeepSeek-V4-Pro')
  })

  it('throws the existing message when nothing is configured at all', () => {
    expect(() => resolveSessionProviderAndModel(cfg(undefined, {}))).toThrow(/No agent LLM provider configured/)
  })
})

describe('buildAgentProvidersResponse reports the pin', () => {
  it('without a pin, the default is still the auto-detect winner', () => {
    expect(buildAgentProvidersResponse(cfg()).defaultProvider).toBe('claude')
  })

  it('reports the pinned provider and its pinned model, not the auto-detect winner', () => {
    const res = buildAgentProvidersResponse(cfg({ provider: 'deepinfra', model: 'zai-org/GLM-5.2' }))
    expect(res.defaultProvider).toBe('deepinfra')
    expect(res.providers.find(p => p.id === 'deepinfra')?.defaultModel).toBe('zai-org/GLM-5.2')
    // Only the pinned provider's model is rewritten.
    expect(res.providers.find(p => p.id === 'claude')?.defaultModel).not.toBe('zai-org/GLM-5.2')
  })

  it('reports an unkeyed pin as the unconfigured default instead of hiding it behind detection', () => {
    const res = buildAgentProvidersResponse(cfg({ provider: 'deepinfra' }, { claude: { apiKey: 'k' } }))
    expect(res.defaultProvider).toBe('deepinfra')
    expect(res.providers.find(p => p.id === 'deepinfra')?.configured).toBe(false)
  })
})

describe('SessionRegistry keeps the pin across turns', () => {
  let dir: string
  let db: DatabaseClient
  const PIN = { provider: 'deepinfra', model: 'zai-org/GLM-5.2' } as const
  const row = () => db.select().from(agentSessions).where(eq(agentSessions.projectId, 'demo')).get()!
  const registry = (agent?: CanonryConfig['agent']) =>
    new SessionRegistry({ db, client: {} as ApiClient, config: cfg(agent), proactive: false })

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-pin-'))
    db = createClient(path.join(dir, 'data.db'))
    migrate(db)
    const now = '2026-09-01T10:00:00.000Z'
    db.insert(projects).values({ id: 'demo', name: 'demo', displayName: 'demo', canonicalDomain: 'demo.example', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('returns a live session to the pin on the next turn that names no provider', async () => {
    const r = registry(PIN)
    await r.acquireForTurn('demo', { provider: 'claude' })
    expect(row().modelProvider).toBe('claude')
    // The proactive drain's shape: scope only, never a provider.
    const agent = await r.acquireForTurn('demo', { toolScope: AeroToolScopes.readOnly })
    expect(row()).toMatchObject({ modelProvider: 'deepinfra', modelId: 'zai-org/GLM-5.2' })
    expect(agent.state.model.id).toBe('zai-org/GLM-5.2')
  })

  it('naming the pinned provider gets the pinned model, whatever ran before', async () => {
    const r = registry(PIN)
    await r.acquireForTurn('demo')
    expect(row().modelId).toBe('zai-org/GLM-5.2')
    await r.acquireForTurn('demo', { provider: 'claude' })
    const agent = await r.acquireForTurn('demo', { provider: 'deepinfra' })
    expect(row()).toMatchObject({ modelProvider: 'deepinfra', modelId: 'zai-org/GLM-5.2' })
    expect(agent.state.model.id).toBe('zai-org/GLM-5.2')
  })

  it('an explicit model id still wins for its turn, then the pin returns', async () => {
    const r = registry(PIN)
    await r.acquireForTurn('demo', { provider: 'deepinfra', modelId: 'deepseek-ai/DeepSeek-V4-Flash' })
    expect(row().modelId).toBe('deepseek-ai/DeepSeek-V4-Flash')
    await r.acquireForTurn('demo')
    expect(row().modelId).toBe('zai-org/GLM-5.2')
  })

  it('a restarted registry hydrates onto the pin, not the overridden row', async () => {
    await registry(PIN).acquireForTurn('demo', { provider: 'claude' })
    expect(row().modelProvider).toBe('claude')
    const agent = registry(PIN).getOrCreate('demo')
    expect(row()).toMatchObject({ modelProvider: 'deepinfra', modelId: 'zai-org/GLM-5.2' })
    expect(agent.state.model.id).toBe('zai-org/GLM-5.2')
  })

  it('without a pin, an override stays sticky as it always has', async () => {
    const r = registry()
    await r.acquireForTurn('demo', { provider: 'deepinfra', modelId: 'zai-org/GLM-5.2' })
    await r.acquireForTurn('demo')
    expect(row()).toMatchObject({ modelProvider: 'deepinfra', modelId: 'zai-org/GLM-5.2' })
  })
})

describe('a pin that cannot run fails early and by name', () => {
  let dir: string
  let db: DatabaseClient
  const row = () => db.select().from(agentSessions).where(eq(agentSessions.projectId, 'demo')).get()
  const registry = (agent: CanonryConfig['agent'], providers?: Record<string, { apiKey?: string }>) =>
    new SessionRegistry({ db, client: {} as ApiClient, config: cfg(agent, providers), proactive: false })

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-pin-fail-'))
    db = createClient(path.join(dir, 'data.db'))
    migrate(db)
    const now = '2026-09-01T10:00:00.000Z'
    db.insert(projects).values({ id: 'demo', name: 'demo', displayName: 'demo', canonicalDomain: 'demo.example', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('refuses a turn on an unkeyed pin before it starts, naming agent.provider and the env var', async () => {
    const r = registry({ provider: 'deepinfra' }, { claude: { apiKey: 'k' } })
    await expect(r.acquireForTurn('demo')).rejects.toMatchObject({
      code: 'MISSING_DEPENDENCY',
      message: expect.stringMatching(/pinned to deepinfra by agent\.provider.*DEEPINFRA_TOKEN/),
    })
  })

  it('an explicit override still runs when the pinned agent.model does not resolve', async () => {
    const r = registry({ provider: 'claude', model: 'not-a-claude-model' })
    const agent = await r.acquireForTurn('demo', { provider: 'deepinfra' })
    expect(row()?.modelProvider).toBe('deepinfra')
    expect(agent.state.model.id).toBe('deepseek-ai/DeepSeek-V4-Flash')
  })
})

describe('describeAgentPin', () => {
  it('is null without a pin', () => {
    expect(describeAgentPin(cfg())).toBeNull()
  })

  it('reports a keyed, resolvable pin as healthy', () => {
    expect(describeAgentPin(cfg({ provider: 'deepinfra', model: 'zai-org/GLM-5.2' }))).toMatchObject({
      provider: 'deepinfra', model: 'zai-org/GLM-5.2', configured: true, envVar: 'DEEPINFRA_TOKEN', modelError: null,
    })
  })

  it('reports an unkeyed pin and an unresolvable catalog model', () => {
    expect(describeAgentPin(cfg({ provider: 'deepinfra' }, { claude: { apiKey: 'k' } }))?.configured).toBe(false)
    expect(describeAgentPin(cfg({ provider: 'claude', model: 'not-a-claude-model' }))?.modelError).toBeTruthy()
  })
})
