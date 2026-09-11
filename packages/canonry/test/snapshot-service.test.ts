import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GroundingSource,
  NormalizedQueryResult,
  ProviderAdapter,
  ProviderConfig,
  ProviderHealthcheckResult,
  RawQueryResult,
  TrackedQueryInput,
  SnapshotRequestInput,
} from '@ainyc/canonry-contracts'
import { snapshotRequestSchema } from '@ainyc/canonry-contracts'
import { ProviderRegistry } from '../src/provider-registry.js'
import { SnapshotService } from '../src/snapshot-service.js'
import { formatAuditFactorScore } from '../src/snapshot-format.js'

const { fetchSiteTextMock, runAeoAuditMock } = vi.hoisted(() => ({
  fetchSiteTextMock: vi.fn(),
  runAeoAuditMock: vi.fn(),
}))

vi.mock('../src/site-fetch.js', () => ({
  fetchSiteText: fetchSiteTextMock,
}))

vi.mock('@canonry/aeo-audit', () => ({
  runAeoAudit: runAeoAuditMock,
}))

type TestProviderOptions = {
  name: string
  displayName: string
  executeResult?: RawQueryResult
  executeError?: Error
  generatedText?: string[]
}

function makeConfig(name: string): ProviderConfig {
  return {
    provider: name,
    apiKey: 'test-key',
    quotaPolicy: {
      maxConcurrency: 1,
      maxRequestsPerMinute: 60,
      maxRequestsPerDay: 500,
    },
  }
}

function healthcheck(name: string): ProviderHealthcheckResult {
  return {
    ok: true,
    provider: name,
    message: 'ok',
  }
}

function normalizeRawResult(name: string, raw: RawQueryResult): NormalizedQueryResult {
  const body = raw.rawResponse as {
    answerText?: string
    citedDomains?: string[]
    groundingSources?: GroundingSource[]
  }

  return {
    provider: name,
    answerText: body.answerText ?? '',
    citedDomains: body.citedDomains ?? [],
    groundingSources: body.groundingSources ?? raw.groundingSources,
    searchQueries: raw.searchQueries,
  }
}

function makeAdapter(opts: TestProviderOptions): ProviderAdapter {
  const generatedText = [...(opts.generatedText ?? [])]

  return {
    name: opts.name,
    displayName: opts.displayName,
    mode: 'api',
    modelRegistry: {
      defaultModel: `${opts.name}-model`,
      validationPattern: /./,
      validationHint: 'any model',
      knownModels: [{ id: `${opts.name}-model`, displayName: `${opts.displayName} Model`, tier: 'standard' }],
    },
    validateConfig: () => healthcheck(opts.name),
    healthcheck: async () => healthcheck(opts.name),
    executeTrackedQuery: async (_input: TrackedQueryInput) => {
      if (opts.executeError) throw opts.executeError
      if (!opts.executeResult) throw new Error(`No execute result configured for ${opts.name}`)
      return opts.executeResult
    },
    normalizeResult: (raw) => normalizeRawResult(opts.name, raw),
    generateText: async () => {
      const next = generatedText.shift()
      if (next === undefined) throw new Error(`Unexpected generateText call for ${opts.name}`)
      return next
    },
  }
}

function makeRawQueryResult(name: string, response: {
  answerText: string
  citedDomains?: string[]
  groundingSources?: GroundingSource[]
  searchQueries?: string[]
}): RawQueryResult {
  return {
    provider: name,
    model: `${name}-model`,
    rawResponse: {
      answerText: response.answerText,
      citedDomains: response.citedDomains ?? [],
      groundingSources: response.groundingSources ?? [],
    },
    groundingSources: response.groundingSources ?? [],
    searchQueries: response.searchQueries ?? ['best widget vendor'],
  }
}

describe('SnapshotService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchSiteTextMock.mockResolvedValue('Acme Corp builds enterprise widgets and provides support.')
    runAeoAuditMock.mockResolvedValue({
      url: 'https://acme.example.com',
      finalUrl: 'https://acme.example.com',
      auditedAt: '2026-03-29T12:00:00.000Z',
      overallScore: 58,
      overallGrade: 'D+',
      summary: 'Overall grade D+ with weak schema completeness.',
      factors: [
        {
          id: 'schema-completeness',
          name: 'Schema Completeness',
          weight: 8,
          score: 2,
          grade: 'F',
          status: 'fail',
          findings: [],
          recommendations: ['Add Organization and Service schema.'],
        },
      ],
    })
  })

  it('excludes provider failures from visibility totals and trusts reviewed competitor lists', async () => {
    const registry = new ProviderRegistry()
    registry.register(makeAdapter({
      name: 'openai',
      displayName: 'OpenAI',
      executeResult: makeRawQueryResult('openai', {
        answerText: 'Industry sources compare widget vendors and cite nytimes.com.',
        citedDomains: ['nytimes.com'],
        groundingSources: [{ uri: 'https://nytimes.com/review/widgets', title: 'Widget review' }],
      }),
      generatedText: [
        JSON.stringify({
          industry: 'Manufacturing',
          summary: 'Acme sells enterprise widget services.',
          services: ['Widget manufacturing'],
          categoryTerms: ['enterprise widgets'],
          queries: ['best enterprise widget vendor'],
        }),
        JSON.stringify({
          assessments: [
            {
              query: 'best enterprise widget vendor',
              provider: 'openai',
              mentioned: false,
              describedAccurately: 'not-mentioned',
              accuracyNotes: null,
              incorrectClaims: [],
              recommendedCompetitors: [],
            },
          ],
          whatThisMeans: [],
          recommendedActions: [],
        }),
      ],
    }), makeConfig('openai'))
    registry.register(makeAdapter({
      name: 'claude',
      displayName: 'Claude',
      executeError: new Error('rate limited'),
    }), makeConfig('claude'))

    const service = new SnapshotService(registry)
    const report = await service.createReport({
      companyName: 'Acme Corp',
      domain: 'acme.example.com',
    })

    expect(report.summary.totalComparisons).toBe(1)
    expect(report.summary.mentionCount).toBe(0)
    expect(report.summary.visibilityGap).toContain('1 successful provider response')
    expect(report.summary.visibilityGap).toContain('1 provider response failed')
    expect(report.summary.whatThisMeans).toContain(
      '1 provider response failed and was excluded from visibility totals.',
    )
    expect(report.queryResults[0]?.providerResults[0]?.recommendedCompetitors).toEqual([])
    expect(report.summary.topCompetitors).toEqual([])
    expect(report.summary.recommendedActions).toContain(
      'Improve schema completeness: 2/100 (8% weight)',
    )
  })

  it.each<{ selection: Partial<SnapshotRequestInput>; expected: string[] }>([
    { selection: {}, expected: ['openai', 'gemini', 'cdp:chatgpt'] },
    { selection: { providerMode: 'all' }, expected: ['openai', 'gemini', 'cdp:chatgpt'] },
    { selection: { providerMode: 'api' }, expected: ['openai', 'gemini'] },
    { selection: { providerMode: 'browser' }, expected: ['cdp:chatgpt'] },
    { selection: { providers: ['gemini', 'gemini'] }, expected: ['gemini'] },
    { selection: { providers: ['gemini'], providerMode: 'api' }, expected: ['gemini'] },
  ])('limits answers and analysis to $expected for $selection', async ({ selection, expected }) => {
    const registry = new ProviderRegistry()
    const adapters = ['openai', 'gemini', 'cdp:chatgpt'].map(name => {
      const adapter = makeAdapter({
        name, displayName: name,
        executeResult: makeRawQueryResult(name, { answerText: 'Acme Corp makes widgets.', citedDomains: ['acme.example.com'] }),
        generatedText: [JSON.stringify({ industry: 'Widgets' }), JSON.stringify({ assessments: [] })],
      })
      if (name === 'cdp:chatgpt') adapter.mode = 'browser'
      vi.spyOn(adapter, 'executeTrackedQuery')
      vi.spyOn(adapter, 'generateText')
      registry.register(adapter, makeConfig(name))
      return adapter
    })
    const report = await new SnapshotService(registry).createReport(snapshotRequestSchema.parse({
      companyName: 'Acme Corp', domain: 'acme.example.com', queries: ['best widgets'], ...selection,
    }))
    expect(report.queryResults[0]?.providerResults.map(result => result.provider)).toEqual(expected)
    expect(report.summary).toMatchObject({ totalProviders: expected.length, totalComparisons: expected.length, mentionCount: expected.length, citationCount: expected.length })
    const analysisName = expected.find(name => name !== 'cdp:chatgpt')
    for (const adapter of adapters) {
      expect(adapter.executeTrackedQuery).toHaveBeenCalledTimes(expected.includes(adapter.name) ? 1 : 0)
      expect(adapter.generateText).toHaveBeenCalledTimes(adapter.name === analysisName ? 2 : 0)
    }
  })

  it.each([
    { providers: ['missing'] },
    { providers: ['openai', 'missing'] },
    { providers: ['openai'], providerMode: 'browser' },
    { providerMode: 'browser' },
  ])('rejects unavailable or conflicting selection before external work: %j', async selection => {
    const registry = new ProviderRegistry()
    const adapter = makeAdapter({ name: 'openai', displayName: 'OpenAI' })
    const generate = vi.spyOn(adapter, 'generateText')
    const execute = vi.spyOn(adapter, 'executeTrackedQuery')
    registry.register(adapter, makeConfig('openai'))
    await expect(new SnapshotService(registry).createReport(snapshotRequestSchema.parse({
      companyName: 'Acme', domain: 'acme.example.com', queries: ['widgets'], ...selection,
    }))).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 })
    expect(fetchSiteTextMock).not.toHaveBeenCalled()
    expect(runAeoAuditMock).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('requires manual queries for browser-only selection even with an API provider configured', async () => {
    const registry = new ProviderRegistry()
    const browser = makeAdapter({ name: 'cdp:chatgpt', displayName: 'ChatGPT' })
    browser.mode = 'browser'
    registry.register(browser, makeConfig(browser.name))
    registry.register(makeAdapter({ name: 'openai', displayName: 'OpenAI' }), makeConfig('openai'))
    await expect(new SnapshotService(registry).createReport(snapshotRequestSchema.parse({
      companyName: 'Acme', domain: 'acme.example.com', providerMode: 'browser',
    }))).rejects.toThrow('pass manual queries')
    expect(fetchSiteTextMock).not.toHaveBeenCalled()
    expect(runAeoAuditMock).not.toHaveBeenCalled()
  })

  it('uses only the selected API provider to generate queries and analyze answers', async () => {
    const registry = new ProviderRegistry()
    const excluded = makeAdapter({ name: 'openai', displayName: 'OpenAI' })
    const generate = vi.spyOn(excluded, 'generateText')
    const execute = vi.spyOn(excluded, 'executeTrackedQuery')
    registry.register(excluded, makeConfig('openai'))
    registry.register(makeAdapter({
      name: 'gemini', displayName: 'Gemini',
      executeResult: makeRawQueryResult('gemini', { answerText: 'Acme Corp makes widgets.' }),
      generatedText: [JSON.stringify({ queries: ['best widgets'] }), JSON.stringify({ assessments: [] })],
    }), makeConfig('gemini'))
    const report = await new SnapshotService(registry).createReport(snapshotRequestSchema.parse({
      companyName: 'Acme', domain: 'acme.example.com', providers: ['gemini'],
    }))
    expect(report.queries).toEqual(['best widgets'])
    expect(report.summary.totalProviders).toBe(1)
    expect(generate).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('formats audit factor scores with a 100-point denominator and explicit weight', () => {
    expect(formatAuditFactorScore({ score: 2, weight: 8 })).toBe('2/100 (8% weight)')
  })
})
