import { describe, it, expect } from 'vitest'

import {
  ContentActions,
  contentActionSchema,
  DemandSources,
  demandSourceSchema,
  ActionConfidences,
  actionConfidenceSchema,
  PageTypes,
  pageTypeSchema,
  ContentActionStates,
  contentActionStateSchema,
  contentTargetRowDtoSchema,
  contentTargetsResponseDtoSchema,
  contentSourceRowDtoSchema,
  contentSourcesResponseDtoSchema,
  contentGapRowDtoSchema,
  contentGapsResponseDtoSchema,
} from '../src/content.js'

// ─── Enums ───────────────────────────────────────────────────────────────────

describe('contentActionSchema', () => {
  it('accepts all four action values', () => {
    expect(contentActionSchema.parse('create')).toBe('create')
    expect(contentActionSchema.parse('expand')).toBe('expand')
    expect(contentActionSchema.parse('refresh')).toBe('refresh')
    expect(contentActionSchema.parse('add-schema')).toBe('add-schema')
  })

  it('rejects unknown action values', () => {
    expect(() => contentActionSchema.parse('publish')).toThrow()
    expect(() => contentActionSchema.parse('')).toThrow()
  })

  it('exposes ContentActions enum constants', () => {
    expect(ContentActions.create).toBe('create')
    expect(ContentActions.expand).toBe('expand')
    expect(ContentActions.refresh).toBe('refresh')
    expect(ContentActions['add-schema']).toBe('add-schema')
  })
})

describe('demandSourceSchema', () => {
  it('accepts gsc, competitor-evidence, both', () => {
    expect(demandSourceSchema.parse('gsc')).toBe('gsc')
    expect(demandSourceSchema.parse('competitor-evidence')).toBe('competitor-evidence')
    expect(demandSourceSchema.parse('both')).toBe('both')
  })

  it('rejects unknown demand sources', () => {
    expect(() => demandSourceSchema.parse('manual')).toThrow()
  })

  it('exposes DemandSources enum constants', () => {
    expect(DemandSources.gsc).toBe('gsc')
    expect(DemandSources['competitor-evidence']).toBe('competitor-evidence')
    expect(DemandSources.both).toBe('both')
  })
})

describe('actionConfidenceSchema', () => {
  it('accepts high, medium, low', () => {
    expect(actionConfidenceSchema.parse('high')).toBe('high')
    expect(actionConfidenceSchema.parse('medium')).toBe('medium')
    expect(actionConfidenceSchema.parse('low')).toBe('low')
  })

  it('rejects unknown confidence values', () => {
    expect(() => actionConfidenceSchema.parse('unknown')).toThrow()
  })

  it('exposes ActionConfidences enum constants', () => {
    expect(ActionConfidences.high).toBe('high')
    expect(ActionConfidences.medium).toBe('medium')
    expect(ActionConfidences.low).toBe('low')
  })
})

describe('pageTypeSchema', () => {
  it('accepts all six blog-shaped page types', () => {
    for (const type of ['blog-post', 'comparison', 'listicle', 'how-to', 'guide', 'glossary']) {
      expect(pageTypeSchema.parse(type)).toBe(type)
    }
  })

  it('rejects non-blog page types from earlier draft (product, pricing, landing)', () => {
    expect(() => pageTypeSchema.parse('product')).toThrow()
    expect(() => pageTypeSchema.parse('pricing')).toThrow()
    expect(() => pageTypeSchema.parse('landing')).toThrow()
  })

  it('exposes PageTypes enum constants', () => {
    expect(PageTypes['blog-post']).toBe('blog-post')
    expect(PageTypes.comparison).toBe('comparison')
  })
})

describe('contentActionStateSchema', () => {
  it('accepts all seven lifecycle states', () => {
    for (const state of [
      'proposed',
      'briefed',
      'payload-generated',
      'draft-created',
      'published',
      'validated',
      'dismissed',
    ]) {
      expect(contentActionStateSchema.parse(state)).toBe(state)
    }
  })

  it('rejects unknown states', () => {
    expect(() => contentActionStateSchema.parse('completed')).toThrow()
    expect(() => contentActionStateSchema.parse('drafted')).toThrow()
  })

  it('exposes ContentActionStates enum constants', () => {
    expect(ContentActionStates.briefed).toBe('briefed')
    expect(ContentActionStates['draft-created']).toBe('draft-created')
    expect(ContentActionStates.dismissed).toBe('dismissed')
  })
})

// ─── ContentTargetRowDto ─────────────────────────────────────────────────────

describe('contentTargetRowDtoSchema', () => {
  const completeRow = {
    targetRef: 'tgt_a3f9',
    query: 'best crm for saas',
    action: 'create',
    ourBestPage: null,
    winningCompetitor: {
      domain: 'competitor-a.com',
      url: 'https://competitor-a.com/guides/crm-comparison',
      title: 'CRM Comparison for SaaS Startups',
      citationCount: 8,
    },
    score: 72.4,
    scoreBreakdown: {
      demand: 0,
      competitor: 4.2,
      absence: 1.0,
      gapSeverity: 1.0,
    },
    drivers: ['3 competitors cited', 'no existing page'],
    demandSource: 'competitor-evidence',
    actionConfidence: 'high',
    existingAction: null,
  }

  it('parses a complete CREATE row with no existing page', () => {
    const parsed = contentTargetRowDtoSchema.parse(completeRow)
    expect(parsed.action).toBe('create')
    expect(parsed.ourBestPage).toBeNull()
    expect(parsed.winningCompetitor?.citationCount).toBe(8)
    expect(parsed.drivers).toHaveLength(2)
    expect(parsed.demandSource).toBe('competitor-evidence')
  })

  it('parses a REFRESH row with an existing page', () => {
    const parsed = contentTargetRowDtoSchema.parse({
      ...completeRow,
      action: 'refresh',
      ourBestPage: {
        url: 'https://example.com/blog/email-marketing-comparison',
        gscImpressions: 2400,
        gscClicks: 95,
        gscAvgPosition: 4,
        organicSessions: 340,
      },
      demandSource: 'gsc',
    })
    expect(parsed.action).toBe('refresh')
    expect(parsed.ourBestPage?.gscAvgPosition).toBe(4)
  })

  it('accepts null gscAvgPosition for inventory-matched pages with no GSC ranking', () => {
    const parsed = contentTargetRowDtoSchema.parse({
      ...completeRow,
      action: 'create',
      ourBestPage: {
        url: '/blog/payment-processor-guide',
        gscImpressions: 0,
        gscClicks: 0,
        gscAvgPosition: null,
        organicSessions: 120,
      },
      demandSource: 'competitor-evidence',
    })
    expect(parsed.ourBestPage?.gscAvgPosition).toBeNull()
  })

  it('parses a row with an existingAction annotation', () => {
    const parsed = contentTargetRowDtoSchema.parse({
      ...completeRow,
      existingAction: {
        actionId: 'act_91f3',
        state: 'briefed',
        lastUpdated: '2026-04-26T12:00:00.000Z',
      },
    })
    expect(parsed.existingAction?.actionId).toBe('act_91f3')
    expect(parsed.existingAction?.state).toBe('briefed')
  })

  it('rejects unknown action values', () => {
    expect(() => contentTargetRowDtoSchema.parse({ ...completeRow, action: 'publish' })).toThrow()
  })

  it('rejects unknown demandSource values', () => {
    expect(() => contentTargetRowDtoSchema.parse({ ...completeRow, demandSource: 'inferred' })).toThrow()
  })

  it('rejects invalid existingAction.state values', () => {
    expect(() => contentTargetRowDtoSchema.parse({
      ...completeRow,
      existingAction: { actionId: 'act_1', state: 'completed', lastUpdated: '2026-04-26T00:00:00.000Z' },
    })).toThrow()
  })

  it('requires drivers array (no default)', () => {
    const { drivers: _omitted, ...without } = completeRow
    expect(() => contentTargetRowDtoSchema.parse(without)).toThrow()
  })

  it('requires score and scoreBreakdown', () => {
    const { score: _s, ...withoutScore } = completeRow
    expect(() => contentTargetRowDtoSchema.parse(withoutScore)).toThrow()
    const { scoreBreakdown: _b, ...withoutBreakdown } = completeRow
    expect(() => contentTargetRowDtoSchema.parse(withoutBreakdown)).toThrow()
  })
})

// ─── ContentTargetsResponseDto ──────────────────────────────────────────────

describe('contentTargetsResponseDtoSchema', () => {
  it('parses with empty targets array', () => {
    const parsed = contentTargetsResponseDtoSchema.parse({
      targets: [],
      contextMetrics: {
        totalAiReferralSessions: 0,
        latestRunId: 'run_1',
        runTimestamp: '2026-04-26T00:00:00.000Z',
      },
    })
    expect(parsed.targets).toEqual([])
    expect(parsed.contextMetrics.totalAiReferralSessions).toBe(0)
  })

  it('parses with multiple targets', () => {
    const parsed = contentTargetsResponseDtoSchema.parse({
      targets: [
        {
          targetRef: 'tgt_1',
          query: 'q1',
          action: 'create',
          ourBestPage: null,
          winningCompetitor: null,
          score: 10,
          scoreBreakdown: { demand: 0, competitor: 1, absence: 1, gapSeverity: 1 },
          drivers: ['driver one'],
          demandSource: 'competitor-evidence',
          actionConfidence: 'low',
          existingAction: null,
        },
        {
          targetRef: 'tgt_2',
          query: 'q2',
          action: 'refresh',
          ourBestPage: {
            url: 'https://example.com/p',
            gscImpressions: 100,
            gscClicks: 5,
            gscAvgPosition: 8,
            organicSessions: 30,
          },
          winningCompetitor: null,
          score: 20,
          scoreBreakdown: { demand: 1, competitor: 1, absence: 0.5, gapSeverity: 1 },
          drivers: ['driver two'],
          demandSource: 'gsc',
          actionConfidence: 'high',
          existingAction: null,
        },
      ],
      contextMetrics: {
        totalAiReferralSessions: 142,
        latestRunId: 'run_99',
        runTimestamp: '2026-04-26T00:00:00.000Z',
      },
    })
    expect(parsed.targets).toHaveLength(2)
    expect(parsed.targets[0].action).toBe('create')
    expect(parsed.targets[1].action).toBe('refresh')
  })
})

// ─── ContentSources ──────────────────────────────────────────────────────────

describe('contentSourceRowDtoSchema', () => {
  it('parses a row grouped by query', () => {
    const parsed = contentSourceRowDtoSchema.parse({
      query: 'best crm for saas',
      groundingSources: [
        {
          uri: 'https://competitor-a.com/guides/crm-comparison',
          title: 'CRM Comparison',
          domain: 'competitor-a.com',
          isOurDomain: false,
          isCompetitor: true,
          citationCount: 8,
          providers: ['gemini', 'openai'],
        },
        {
          uri: 'https://competitor-b.com/blog/best-crm-saas',
          title: 'Best CRM for SaaS',
          domain: 'competitor-b.com',
          isOurDomain: false,
          isCompetitor: true,
          citationCount: 5,
          providers: ['gemini'],
        },
      ],
    })
    expect(parsed.query).toBe('best crm for saas')
    expect(parsed.groundingSources).toHaveLength(2)
    expect(parsed.groundingSources[0].providers).toContain('gemini')
  })

  it('allows empty groundingSources', () => {
    const parsed = contentSourceRowDtoSchema.parse({
      query: 'q with no citations yet',
      groundingSources: [],
    })
    expect(parsed.groundingSources).toEqual([])
  })
})

describe('contentSourcesResponseDtoSchema', () => {
  it('parses a response wrapping rows', () => {
    const parsed = contentSourcesResponseDtoSchema.parse({
      sources: [
        { query: 'q1', groundingSources: [] },
      ],
      latestRunId: 'run_1',
    })
    expect(parsed.sources).toHaveLength(1)
    expect(parsed.latestRunId).toBe('run_1')
  })
})

// ─── ContentGaps ─────────────────────────────────────────────────────────────

describe('contentGapRowDtoSchema', () => {
  it('parses a gap row', () => {
    const parsed = contentGapRowDtoSchema.parse({
      query: 'best crm for saas',
      competitorDomains: ['competitor-a.com', 'competitor-b.com'],
      competitorCount: 2,
      missRate: 0.83,
      lastSeenInRunId: 'run_99',
    })
    expect(parsed.competitorCount).toBe(2)
    expect(parsed.missRate).toBeCloseTo(0.83)
  })

  it('rejects negative missRate', () => {
    expect(() => contentGapRowDtoSchema.parse({
      query: 'q',
      competitorDomains: [],
      competitorCount: 0,
      missRate: -0.1,
      lastSeenInRunId: 'run_1',
    })).toThrow()
  })

  it('rejects missRate above 1', () => {
    expect(() => contentGapRowDtoSchema.parse({
      query: 'q',
      competitorDomains: [],
      competitorCount: 0,
      missRate: 1.1,
      lastSeenInRunId: 'run_1',
    })).toThrow()
  })
})

describe('contentGapsResponseDtoSchema', () => {
  it('parses a response wrapping gap rows', () => {
    const parsed = contentGapsResponseDtoSchema.parse({
      gaps: [
        {
          query: 'q1',
          competitorDomains: ['competitor-a.com'],
          competitorCount: 1,
          missRate: 1.0,
          lastSeenInRunId: 'run_99',
        },
      ],
      latestRunId: 'run_99',
    })
    expect(parsed.gaps).toHaveLength(1)
  })

  it('parses an empty gaps response', () => {
    const parsed = contentGapsResponseDtoSchema.parse({
      gaps: [],
      latestRunId: 'run_1',
    })
    expect(parsed.gaps).toEqual([])
  })
})
