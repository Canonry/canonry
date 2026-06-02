import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ContentTargetRowDto } from '@ainyc/canonry-contracts'

// Stub `complete` at module-load time so the explainer's `import { complete }`
// resolves to the mock. Each test seeds `mockState.completeImpl` to control
// what `complete` returns / throws for that test.
const mockState: {
  completeImpl: ((model: unknown, context: unknown, opts: unknown) => Promise<unknown>) | null
  callCount: number
  lastCall: { model: unknown; context: unknown; opts: unknown } | null
} = { completeImpl: null, callCount: 0, lastCall: null }

vi.mock('@mariozechner/pi-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mariozechner/pi-ai')>()
  return {
    ...actual,
    complete: async (model: unknown, context: unknown, opts: unknown) => {
      mockState.callCount++
      mockState.lastCall = { model, context, opts }
      if (!mockState.completeImpl) {
        throw new Error('test did not seed mockState.completeImpl before invoking complete()')
      }
      return mockState.completeImpl(model, context, opts)
    },
  }
})

const {
  RECOMMENDATION_EXPLAIN_PROMPT_VERSION,
  RECOMMENDATION_BRIEF_PROMPT_VERSION,
  buildRecommendationPrompt,
  buildBriefPrompt,
  createRecommendationExplainer,
  createRecommendationBriefSynthesizer,
} = await import('../src/agent/recommendation-explainer.js')

function makeRecommendation(overrides: Partial<ContentTargetRowDto> = {}): ContentTargetRowDto {
  return {
    targetRef: 'tgt_abc123',
    query: 'best crm for saas',
    action: 'create',
    ourBestPage: null,
    winningCompetitor: {
      domain: 'competitor.com',
      url: 'https://competitor.com/best-crm',
      title: 'The Best CRM Tools for SaaS',
      citationCount: 7,
    },
    score: 0.82,
    scoreBreakdown: { demand: 0.6, competitor: 0.9, absence: 1.0, gapSeverity: 0.7 },
    drivers: ['3 competitors cited', 'no current page', 'high GSC demand'],
    demandSource: 'both',
    actionConfidence: 'high',
    existingAction: null,
    surfaceClass: 'ownable',
    winnability: 0.8,
    ...overrides,
  }
}

beforeEach(() => {
  mockState.completeImpl = null
  mockState.callCount = 0
  mockState.lastCall = null
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('buildRecommendationPrompt', () => {
  it('includes the project context, query, action label, and score breakdown', () => {
    const prompt = buildRecommendationPrompt({
      projectName: 'acme',
      canonicalDomain: 'acme.com',
      recommendation: makeRecommendation(),
    })
    expect(prompt).toContain('Project: acme (acme.com)')
    expect(prompt).toContain('Query: "best crm for saas"')
    expect(prompt).toContain('Recommended action: Create')
    expect(prompt).toContain('Action confidence: High')
    expect(prompt).toContain('Priority score: 0.82')
    expect(prompt).toContain('demand: 0.60')
    expect(prompt).toContain('competitor: 0.90')
    expect(prompt).toContain('absence: 1.00')
    expect(prompt).toContain('gap severity: 0.70')
  })

  it('renders the demand-source label in human form', () => {
    const bothPrompt = buildRecommendationPrompt({
      projectName: 'acme',
      canonicalDomain: 'acme.com',
      recommendation: makeRecommendation({ demandSource: 'both' }),
    })
    expect(bothPrompt).toContain('GSC impressions + competitor citations')

    const gscPrompt = buildRecommendationPrompt({
      projectName: 'acme',
      canonicalDomain: 'acme.com',
      recommendation: makeRecommendation({ demandSource: 'gsc' }),
    })
    expect(gscPrompt).toContain('Google Search Console impressions')
  })

  it('renders "none" when ourBestPage is null', () => {
    const prompt = buildRecommendationPrompt({
      projectName: 'acme',
      canonicalDomain: 'acme.com',
      recommendation: makeRecommendation({ ourBestPage: null }),
    })
    expect(prompt).toContain('Our current best page: none')
  })

  it('renders ourBestPage with avg position and impression formatting', () => {
    const prompt = buildRecommendationPrompt({
      projectName: 'acme',
      canonicalDomain: 'acme.com',
      recommendation: makeRecommendation({
        ourBestPage: {
          url: 'https://acme.com/crm-guide',
          gscImpressions: 12_500,
          gscClicks: 320,
          gscAvgPosition: 8.4,
          organicSessions: 540,
        },
      }),
    })
    expect(prompt).toContain('Our current best page: https://acme.com/crm-guide')
    expect(prompt).toContain('12.5K GSC impressions')
    expect(prompt).toContain('320 clicks')
    expect(prompt).toContain('avg position 8.4')
  })

  it('marks the page as unranked when gscAvgPosition is null', () => {
    const prompt = buildRecommendationPrompt({
      projectName: 'acme',
      canonicalDomain: 'acme.com',
      recommendation: makeRecommendation({
        ourBestPage: {
          url: 'https://acme.com/fallback',
          gscImpressions: 0,
          gscClicks: 0,
          gscAvgPosition: null,
          organicSessions: 5,
        },
      }),
    })
    expect(prompt).toContain('unranked')
  })

  it('omits drivers line when drivers array is empty', () => {
    const prompt = buildRecommendationPrompt({
      projectName: 'acme',
      canonicalDomain: 'acme.com',
      recommendation: makeRecommendation({ drivers: [] }),
    })
    expect(prompt).not.toContain('Drivers:')
  })

  it('includes existingAction context when present', () => {
    const prompt = buildRecommendationPrompt({
      projectName: 'acme',
      canonicalDomain: 'acme.com',
      recommendation: makeRecommendation({
        existingAction: { actionId: 'act_1', state: 'briefed', lastUpdated: '2026-05-01' },
      }),
    })
    expect(prompt).toContain('Existing work in progress')
    expect(prompt).toContain('act_1')
    expect(prompt).toContain('briefed')
  })
})

describe('createRecommendationExplainer', () => {
  function fakeUsage(costTotal: number) {
    return {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
    }
  }

  function fakeAssistantMessage(text: string, costTotal = 0.0042) {
    return {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text }],
      api: 'anthropic-messages' as never,
      provider: 'anthropic' as never,
      model: 'claude-sonnet-4-6',
      usage: fakeUsage(costTotal),
      stopReason: 'stop' as const,
      timestamp: Date.now(),
    }
  }

  it('throws a PROVIDER_ERROR AppError when no provider is configured', async () => {
    const explainer = createRecommendationExplainer({ config: { providers: {} } })
    // Ensure no env var leaks a key
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('GEMINI_API_KEY', '')
    vi.stubEnv('GOOGLE_API_KEY', '')
    vi.stubEnv('ZAI_API_KEY', '')

    await expect(
      explainer({
        projectId: 'p1',
        projectName: 'acme',
        canonicalDomain: 'acme.com',
        recommendation: makeRecommendation(),
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR', statusCode: 502 })
    expect(mockState.callCount).toBe(0)
  })

  it('throws a VALIDATION_ERROR when an unknown provider override is supplied', async () => {
    const explainer = createRecommendationExplainer({
      config: { providers: { claude: { apiKey: 'sk-test-claude' } } },
    })

    await expect(
      explainer({
        projectId: 'p1',
        projectName: 'acme',
        canonicalDomain: 'acme.com',
        recommendation: makeRecommendation(),
        providerOverride: 'totally-fake-provider',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 })
  })

  it('throws PROVIDER_ERROR when the override provider exists but has no key', async () => {
    const explainer = createRecommendationExplainer({
      config: { providers: { claude: { apiKey: 'sk-test-claude' } } },
    })
    vi.stubEnv('OPENAI_API_KEY', '')

    await expect(
      explainer({
        projectId: 'p1',
        projectName: 'acme',
        canonicalDomain: 'acme.com',
        recommendation: makeRecommendation(),
        providerOverride: 'openai',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR', statusCode: 502 })
  })

  it('uses the first configured provider by priority when no override is given', async () => {
    const explainer = createRecommendationExplainer({
      config: { providers: { gemini: { apiKey: 'gm-key' } } },
    })
    mockState.completeImpl = async () => fakeAssistantMessage('- gemini reason\n- action\n- outcome')

    const result = await explainer({
      projectId: 'p1',
      projectName: 'acme',
      canonicalDomain: 'acme.com',
      recommendation: makeRecommendation(),
    })

    expect(result.provider).toBe('gemini')
    expect(result.promptVersion).toBe(RECOMMENDATION_EXPLAIN_PROMPT_VERSION)
    expect(result.responseText).toContain('gemini reason')
    expect(mockState.callCount).toBe(1)
    // The chosen model id should match the analyze tier for that provider.
    const callModel = (mockState.lastCall?.model ?? { id: '' }) as { id: string; provider: string }
    expect(callModel.provider).toBe('google')
    // pi-ai's gemini analyze tier is gemini-2.5-flash today; assert at least
    // that it is one of the configured flash variants.
    expect(callModel.id).toMatch(/^gemini-2\.5-flash/)
  })

  it('honors a provider override that has a configured key', async () => {
    const explainer = createRecommendationExplainer({
      config: {
        providers: {
          claude: { apiKey: 'sk-claude' },
          openai: { apiKey: 'sk-openai' },
        },
      },
    })
    mockState.completeImpl = async () => fakeAssistantMessage('- openai reason')

    const result = await explainer({
      projectId: 'p1',
      projectName: 'acme',
      canonicalDomain: 'acme.com',
      recommendation: makeRecommendation(),
      providerOverride: 'openai',
    })

    expect(result.provider).toBe('openai')
    const callModel = (mockState.lastCall?.model ?? { id: '' }) as { id: string; provider: string }
    expect(callModel.provider).toBe('openai')
  })

  it('forwards the api key to pi-ai via options.apiKey', async () => {
    const explainer = createRecommendationExplainer({
      config: { providers: { claude: { apiKey: 'sk-from-config' } } },
    })
    mockState.completeImpl = async () => fakeAssistantMessage('- claude reason')

    await explainer({
      projectId: 'p1',
      projectName: 'acme',
      canonicalDomain: 'acme.com',
      recommendation: makeRecommendation(),
    })

    expect(mockState.lastCall?.opts).toEqual({ apiKey: 'sk-from-config' })
  })

  it('converts dollar costs to millicents (rounds to int)', async () => {
    const explainer = createRecommendationExplainer({
      config: { providers: { claude: { apiKey: 'sk' } } },
    })
    // $0.00347 → 347 millicents (×100,000, rounded).
    mockState.completeImpl = async () => fakeAssistantMessage('- text', 0.00347)

    const result = await explainer({
      projectId: 'p1',
      projectName: 'acme',
      canonicalDomain: 'acme.com',
      recommendation: makeRecommendation(),
    })

    expect(result.costMillicents).toBe(347)
    expect(Number.isInteger(result.costMillicents)).toBe(true)
  })

  it('returns 0 cost when pi-ai reports a non-positive cost', async () => {
    const explainer = createRecommendationExplainer({
      config: { providers: { claude: { apiKey: 'sk' } } },
    })
    mockState.completeImpl = async () => fakeAssistantMessage('- text', 0)

    const result = await explainer({
      projectId: 'p1',
      projectName: 'acme',
      canonicalDomain: 'acme.com',
      recommendation: makeRecommendation(),
    })

    expect(result.costMillicents).toBe(0)
  })

  it('throws when the model returns no text content', async () => {
    const explainer = createRecommendationExplainer({
      config: { providers: { claude: { apiKey: 'sk' } } },
    })
    mockState.completeImpl = async () => ({
      role: 'assistant' as const,
      content: [],
      api: 'anthropic-messages' as never,
      provider: 'anthropic' as never,
      model: 'claude-sonnet-4-6',
      usage: fakeUsage(0),
      stopReason: 'stop' as const,
      timestamp: Date.now(),
    })

    await expect(
      explainer({
        projectId: 'p1',
        projectName: 'acme',
        canonicalDomain: 'acme.com',
        recommendation: makeRecommendation(),
      }),
    ).rejects.toThrow(/no text content/)
  })

  it('passes the rendered prompt as a user message to complete()', async () => {
    const explainer = createRecommendationExplainer({
      config: { providers: { claude: { apiKey: 'sk' } } },
    })
    mockState.completeImpl = async () => fakeAssistantMessage('- text')

    await explainer({
      projectId: 'p1',
      projectName: 'acme',
      canonicalDomain: 'acme.com',
      recommendation: makeRecommendation(),
    })

    const ctx = mockState.lastCall?.context as {
      systemPrompt?: string
      messages: { role: string; content: string }[]
    }
    expect(ctx.systemPrompt).toContain('AEO')
    expect(ctx.messages).toHaveLength(1)
    expect(ctx.messages[0].role).toBe('user')
    expect(ctx.messages[0].content).toContain('Project: acme (acme.com)')
    expect(ctx.messages[0].content).toContain('best crm for saas')
  })
})

describe('buildBriefPrompt', () => {
  it('includes the recommendation context plus the surfaceClass + winnability signal', () => {
    const prompt = buildBriefPrompt({
      projectName: 'acme',
      canonicalDomain: 'acme.com',
      recommendation: makeRecommendation({ surfaceClass: 'ownable', winnability: 0.8 }),
    })
    expect(prompt).toContain('Project: acme (acme.com)')
    expect(prompt).toContain('best crm for saas')
    expect(prompt).toContain('Surface class: ownable')
    expect(prompt).toContain('0.8') // winnability surfaced for the model to cite
  })
})

describe('createRecommendationBriefSynthesizer', () => {
  function fakeUsage(costTotal: number) {
    return {
      input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
    }
  }
  function fakeAssistantMessage(text: string, costTotal = 0.0042) {
    return {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text }],
      api: 'anthropic-messages' as never,
      provider: 'anthropic' as never,
      model: 'claude-sonnet-4-6',
      usage: fakeUsage(costTotal),
      stopReason: 'stop' as const,
      timestamp: Date.now(),
    }
  }
  const validBriefJson = JSON.stringify({
    targetQuery: 'ignored — overridden from recommendation',
    surfaceClass: 'ceded', // ignored — overridden from recommendation
    angle: 'Differentiated first-party CRM comparison with real pricing data',
    whyWinnable: 'Cited surface is rival vendors, not aggregators, so first-party content can win.',
    schemaHookup: 'Add FAQPage + Product schema to the comparison page.',
    controllableSurfaceRationale: 'Direct competitors are cited — the surface is controllable.',
  })

  it('parses a valid JSON brief and overrides targetQuery + surfaceClass deterministically', async () => {
    const synth = createRecommendationBriefSynthesizer({ config: { providers: { claude: { apiKey: 'sk' } } } })
    mockState.completeImpl = async () => fakeAssistantMessage(validBriefJson)

    const result = await synth({
      projectId: 'p1', projectName: 'acme', canonicalDomain: 'acme.com',
      recommendation: makeRecommendation({ query: 'best crm for saas', surfaceClass: 'ownable' }),
    })

    expect(result.promptVersion).toBe(RECOMMENDATION_BRIEF_PROMPT_VERSION)
    expect(result.provider).toBe('claude')
    // Deterministic fields come from the recommendation, NOT the model output.
    expect(result.brief.targetQuery).toBe('best crm for saas')
    expect(result.brief.surfaceClass).toBe('ownable')
    expect(result.brief.angle).toContain('Differentiated')
    expect(result.brief.schemaHookup).toContain('FAQPage')
    expect(result.costMillicents).toBe(420)
    expect(mockState.callCount).toBe(1)
  })

  it('strips ```json fences before parsing', async () => {
    const synth = createRecommendationBriefSynthesizer({ config: { providers: { claude: { apiKey: 'sk' } } } })
    mockState.completeImpl = async () => fakeAssistantMessage('```json\n' + validBriefJson + '\n```')

    const result = await synth({
      projectId: 'p1', projectName: 'acme', canonicalDomain: 'acme.com',
      recommendation: makeRecommendation(),
    })
    expect(result.brief.angle).toContain('Differentiated')
  })

  it('retries once on invalid JSON, then succeeds, summing cost across both calls', async () => {
    const synth = createRecommendationBriefSynthesizer({ config: { providers: { claude: { apiKey: 'sk' } } } })
    let call = 0
    mockState.completeImpl = async () => {
      call++
      return call === 1
        ? fakeAssistantMessage('sorry, here is the brief: not json', 0.001)
        : fakeAssistantMessage(validBriefJson, 0.002)
    }

    const result = await synth({
      projectId: 'p1', projectName: 'acme', canonicalDomain: 'acme.com',
      recommendation: makeRecommendation(),
    })
    expect(mockState.callCount).toBe(2)
    expect(result.brief.angle).toContain('Differentiated')
    expect(result.costMillicents).toBe(300) // (0.001 + 0.002) × 100_000
  })

  it('throws PROVIDER_ERROR after two unparseable attempts', async () => {
    const synth = createRecommendationBriefSynthesizer({ config: { providers: { claude: { apiKey: 'sk' } } } })
    mockState.completeImpl = async () => fakeAssistantMessage('definitely not json')

    await expect(
      synth({
        projectId: 'p1', projectName: 'acme', canonicalDomain: 'acme.com',
        recommendation: makeRecommendation(),
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(mockState.callCount).toBe(2)
  })

  it('throws PROVIDER_ERROR when no provider is configured (never calls complete)', async () => {
    const synth = createRecommendationBriefSynthesizer({ config: { providers: {} } })
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('GEMINI_API_KEY', '')
    vi.stubEnv('GOOGLE_API_KEY', '')
    vi.stubEnv('ZAI_API_KEY', '')

    await expect(
      synth({
        projectId: 'p1', projectName: 'acme', canonicalDomain: 'acme.com',
        recommendation: makeRecommendation(),
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR', statusCode: 502 })
    expect(mockState.callCount).toBe(0)
  })

  it('uses the analyze capability tier', async () => {
    const synth = createRecommendationBriefSynthesizer({ config: { providers: { gemini: { apiKey: 'gm' } } } })
    mockState.completeImpl = async () => fakeAssistantMessage(validBriefJson)
    await synth({
      projectId: 'p1', projectName: 'acme', canonicalDomain: 'acme.com',
      recommendation: makeRecommendation(),
    })
    const callModel = (mockState.lastCall?.model ?? { id: '' }) as { id: string; provider: string }
    expect(callModel.provider).toBe('google')
    expect(callModel.id).toMatch(/^gemini-2\.5-flash/)
  })
})
