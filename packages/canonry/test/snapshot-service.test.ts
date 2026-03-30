import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GroundingSource,
  NormalizedQueryResult,
  ProviderAdapter,
  ProviderConfig,
  ProviderHealthcheckResult,
  RawQueryResult,
  TrackedQueryInput,
} from '@ainyc/canonry-contracts'
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

vi.mock('@ainyc/aeo-audit', () => ({
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
          phrases: ['best enterprise widget vendor'],
        }),
        JSON.stringify({
          assessments: [
            {
              phrase: 'best enterprise widget vendor',
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

  it('formats audit factor scores with a 100-point denominator and explicit weight', () => {
    expect(formatAuditFactorScore({ score: 2, weight: 8 })).toBe('2/100 (8% weight)')
  })
})
