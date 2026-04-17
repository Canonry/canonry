import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  fauxAssistantMessage,
  registerFauxProvider,
  type FauxProviderRegistration,
} from '@mariozechner/pi-ai'
import type { HealthSnapshotDto, ProjectDto, RunDto } from '@ainyc/canonry-contracts'
import {
  createAeroSession,
  detectAgentProvider,
  loadAeroSystemPrompt,
} from '../src/agent/session.js'
import type { ApiClient, TimelineDto } from '../src/client.js'
import type { CanonryConfig } from '../src/config.js'
import type { AgentEvent } from '../src/agent/pi-runtime.js'

function stubClient(): ApiClient {
  const project = {
    name: 'demo',
    displayName: 'Demo',
    canonicalDomain: 'demo.example.com',
    country: 'US',
    language: 'en',
  } as ProjectDto
  const runs: RunDto[] = []
  const health = {
    id: 'h1',
    projectId: 'p1',
    runId: null,
    overallCitedRate: 0.5,
    totalPairs: 2,
    citedPairs: 1,
    providerBreakdown: {},
    createdAt: '2026-04-17T00:00:00Z',
  } as HealthSnapshotDto
  const timeline: TimelineDto[] = []
  return {
    getProject: async () => project,
    listRuns: async () => runs,
    getHealth: async () => health,
    getTimeline: async () => timeline,
  } as unknown as ApiClient
}

function stubConfig(overrides?: Partial<CanonryConfig>): CanonryConfig {
  return {
    apiUrl: 'http://localhost:4100',
    database: ':memory:',
    apiKey: 'cnry_test',
    providers: {
      claude: { apiKey: 'anthropic-key' },
    },
    ...overrides,
  } as CanonryConfig
}

describe('loadAeroSystemPrompt', () => {
  it('loads the aero SKILL.md content from the repo-root skills directory', () => {
    const content = loadAeroSystemPrompt()
    expect(content).toContain('Aero')
    expect(content.length).toBeGreaterThan(100)
  })
})

describe('detectAgentProvider', () => {
  it('returns anthropic when claude key is configured', () => {
    expect(detectAgentProvider(stubConfig())).toBe('anthropic')
  })

  it('returns openai when only openai key is configured', () => {
    expect(
      detectAgentProvider(
        stubConfig({ providers: { openai: { apiKey: 'openai-key' } } }),
      ),
    ).toBe('openai')
  })

  it('returns google when only gemini key is configured', () => {
    expect(
      detectAgentProvider(
        stubConfig({ providers: { gemini: { apiKey: 'gemini-key' } } }),
      ),
    ).toBe('google')
  })

  it('returns undefined when no LLM providers are configured', () => {
    expect(detectAgentProvider(stubConfig({ providers: {} }))).toBeUndefined()
  })
})

describe('createAeroSession — end-to-end with faux provider', () => {
  let faux: FauxProviderRegistration

  beforeEach(() => {
    faux = registerFauxProvider({
      api: 'faux-api',
      provider: 'faux',
      models: [{ id: 'faux-model' }],
    })
  })

  afterEach(() => {
    faux.unregister()
  })

  it('emits lifecycle events when running a simple prompt', async () => {
    faux.setResponses([fauxAssistantMessage('Hello from Aero.')])

    const agent = createAeroSession({
      projectName: 'demo',
      client: stubClient(),
      config: stubConfig(),
      systemPromptOverride: 'You are a test agent.',
      provider: 'anthropic',
      modelId: 'claude-opus-4-7',
    })

    // Swap in the faux model after construction — avoids needing the
    // session factory to know about the test-only provider.
    agent.state.model = faux.getModel()

    const eventTypes: AgentEvent['type'][] = []
    agent.subscribe((event) => {
      eventTypes.push(event.type)
    })

    await agent.prompt('Give me a status update.')
    await agent.waitForIdle()

    expect(eventTypes[0]).toBe('agent_start')
    expect(eventTypes).toContain('turn_start')
    expect(eventTypes).toContain('turn_end')
    expect(eventTypes[eventTypes.length - 1]).toBe('agent_end')

    const lastMessage = agent.state.messages[agent.state.messages.length - 1]
    expect(lastMessage.role).toBe('assistant')
  })

  it('throws a clear error when no provider is configured', () => {
    expect(() =>
      createAeroSession({
        projectName: 'demo',
        client: stubClient(),
        config: stubConfig({ providers: {} }),
        systemPromptOverride: 'test',
      }),
    ).toThrow(/No agent LLM provider configured/)
  })
})
