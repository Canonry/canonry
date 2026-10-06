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
  WinnabilityClasses,
  winnabilityClassSchema,
  deriveWinnabilityClass,
  CEDED_SURFACE_THRESHOLD,
  contentBriefDtoSchema,
  recommendationBriefDtoSchema,
  domainClassificationDtoSchema,
  domainClassificationsResponseDtoSchema,
} from '../src/content.js'
import { SurfaceClasses } from '../src/surface-class.js'
import type { SurfaceClass } from '../src/surface-class.js'

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
    winnabilityClass: 'ownable',
    winnability: 0.8,
  }

  it('parses a complete CREATE row with no existing page', () => {
    const parsed = contentTargetRowDtoSchema.parse(completeRow)
    expect(parsed).toEqual(completeRow)
  })

  it('parses a REFRESH row with an existing page', () => {
    const input = {
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
    }
    const parsed = contentTargetRowDtoSchema.parse(input)
    expect(parsed).toEqual(input)
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
    const input = {
      ...completeRow,
      existingAction: {
        actionId: 'act_91f3',
        state: 'briefed',
        lastUpdated: '2026-04-26T12:00:00.000Z',
      },
    }
    const parsed = contentTargetRowDtoSchema.parse(input)
    expect(parsed).toEqual(input)
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
    const input = {
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
          winnabilityClass: 'ceded',
          winnability: 0.1,
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
          winnabilityClass: 'ownable',
          winnability: null,
        },
      ],
      contextMetrics: {
        totalAiReferralSessions: 142,
        latestRunId: 'run_99',
        runTimestamp: '2026-04-26T00:00:00.000Z',
      },
    }
    const parsed = contentTargetsResponseDtoSchema.parse(input)
    expect(parsed).toEqual(input)
  })
})

// ─── ContentSources ──────────────────────────────────────────────────────────

describe('contentSourceRowDtoSchema', () => {
  it('parses a row grouped by query', () => {
    const input = {
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
    }
    const parsed = contentSourceRowDtoSchema.parse(input)
    expect(parsed).toEqual(input)
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
    const input = {
      sources: [
        { query: 'q1', groundingSources: [] },
      ],
      latestRunId: 'run_1',
    }
    const parsed = contentSourcesResponseDtoSchema.parse(input)
    expect(parsed).toEqual(input)
  })
})

// ─── ContentGaps ─────────────────────────────────────────────────────────────

describe('contentGapRowDtoSchema', () => {
  it('parses a gap row', () => {
    const input = {
      query: 'best crm for saas',
      competitorDomains: ['competitor-a.com', 'competitor-b.com'],
      competitorCount: 2,
      missRate: 0.83,
      lastSeenInRunId: 'run_99',
    }
    const parsed = contentGapRowDtoSchema.parse(input)
    expect(parsed).toEqual(input)
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
    const input = {
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
    }
    const parsed = contentGapsResponseDtoSchema.parse(input)
    expect(parsed).toEqual(input)
  })

  it('parses an empty gaps response', () => {
    const parsed = contentGapsResponseDtoSchema.parse({
      gaps: [],
      latestRunId: 'run_1',
    })
    expect(parsed.gaps).toEqual([])
  })
})

// ─── winnabilityClass ────────────────────────────────────────────────────────────

describe('winnabilityClassSchema', () => {
  it('accepts ownable and ceded', () => {
    expect(winnabilityClassSchema.parse('ownable')).toBe('ownable')
    expect(winnabilityClassSchema.parse('ceded')).toBe('ceded')
  })

  it('rejects unknown values', () => {
    expect(() => winnabilityClassSchema.parse('winnable')).toThrow()
    expect(() => winnabilityClassSchema.parse('')).toThrow()
  })

  it('exposes WinnabilityClasses enum constants', () => {
    expect(WinnabilityClasses.ownable).toBe('ownable')
    expect(WinnabilityClasses.ceded).toBe('ceded')
  })

  it('contentTargetRowDtoSchema requires winnabilityClass and accepts nullable winnability', () => {
    const base = {
      targetRef: 't', query: 'q', action: 'create', ourBestPage: null, winningCompetitor: null,
      score: 1, scoreBreakdown: { demand: 0, competitor: 0, absence: 1, gapSeverity: 1 },
      drivers: [], demandSource: 'competitor-evidence', actionConfidence: 'low', existingAction: null,
    }
    expect(() => contentTargetRowDtoSchema.parse(base)).toThrow() // both gate fields missing
    expect(() => contentTargetRowDtoSchema.parse({ ...base, winnability: null })).toThrow()
    expect(() => contentTargetRowDtoSchema.parse({ ...base, winnabilityClass: 'ownable' })).toThrow()
    expect(contentTargetRowDtoSchema.parse({ ...base, winnabilityClass: 'ownable', winnability: null })).toEqual({ ...base, winnabilityClass: 'ownable', winnability: null })
    expect(contentTargetRowDtoSchema.parse({ ...base, winnabilityClass: 'ceded', winnability: 0.2 })).toEqual({ ...base, winnabilityClass: 'ceded', winnability: 0.2 })
    expect(() => contentTargetRowDtoSchema.parse({ ...base, winnabilityClass: 'ownable', winnability: 1.4 })).toThrow()
  })
})

describe('deriveWinnabilityClass', () => {
  const classes = (entries: [string, SurfaceClass][]) =>
    new Map<string, SurfaceClass>(entries)

  it('defaults the ceded threshold to 0.6', () => {
    expect(CEDED_SURFACE_THRESHOLD).toBe(0.6)
  })

  it('marks an OTA-aggregator-dominated surface ceded', () => {
    const result = deriveWinnabilityClass(
      [{ domain: 'booking.com', citationCount: 8 }, { domain: 'expedia.com', citationCount: 2 }],
      classes([
        ['booking.com', SurfaceClasses['ota-aggregator']],
        ['expedia.com', SurfaceClasses['ota-aggregator']],
      ]),
    )
    expect(result).toEqual({ winnabilityClass: 'ceded', winnability: 0 })
  })

  it('marks an editorial-media-dominated surface ceded', () => {
    const result = deriveWinnabilityClass(
      [{ domain: 'timeout.com', citationCount: 5 }, { domain: 'someblog.com', citationCount: 5 }],
      classes([
        ['timeout.com', SurfaceClasses['editorial-media']],
        ['someblog.com', SurfaceClasses['editorial-media']],
      ]),
    )
    expect(result).toEqual({ winnabilityClass: 'ceded', winnability: 0 })
  })

  it('marks a direct-competitor-dominated surface ownable (a competitor surface is winnable)', () => {
    const result = deriveWinnabilityClass(
      [{ domain: 'rival-a.com', citationCount: 6 }, { domain: 'rival-b.com', citationCount: 4 }],
      classes([
        ['rival-a.com', SurfaceClasses['direct-competitor']],
        ['rival-b.com', SurfaceClasses['direct-competitor']],
      ]),
    )
    expect(result).toEqual({ winnabilityClass: 'ownable', winnability: 1 })
  })

  it('treats the threshold as inclusive (cededShare === 0.6 is ceded)', () => {
    const result = deriveWinnabilityClass(
      [{ domain: 'booking.com', citationCount: 6 }, { domain: 'rival.com', citationCount: 4 }],
      classes([
        ['booking.com', SurfaceClasses['ota-aggregator']],
        ['rival.com', SurfaceClasses['direct-competitor']],
      ]),
    )
    expect(result).toEqual({ winnabilityClass: 'ceded', winnability: 0.4 })
  })

  it('stays ownable when ceded share is below the threshold', () => {
    const result = deriveWinnabilityClass(
      [{ domain: 'booking.com', citationCount: 5 }, { domain: 'rival.com', citationCount: 5 }],
      classes([
        ['booking.com', SurfaceClasses['ota-aggregator']],
        ['rival.com', SurfaceClasses['direct-competitor']],
      ]),
    )
    expect(result).toEqual({ winnabilityClass: 'ownable', winnability: 0.5 })
  })

  it('weights by citation count, not domain count (one heavily-cited OTA dominates many lightly-cited rivals)', () => {
    const result = deriveWinnabilityClass(
      [
        { domain: 'booking.com', citationCount: 40 },
        { domain: 'r1.com', citationCount: 1 },
        { domain: 'r2.com', citationCount: 1 },
        { domain: 'r3.com', citationCount: 1 },
        { domain: 'r4.com', citationCount: 1 },
      ],
      classes([
        ['booking.com', SurfaceClasses['ota-aggregator']],
        ['r1.com', SurfaceClasses['direct-competitor']],
        ['r2.com', SurfaceClasses['direct-competitor']],
        ['r3.com', SurfaceClasses['direct-competitor']],
        ['r4.com', SurfaceClasses['direct-competitor']],
      ]),
    )
    // 40/44 ≈ 0.91 → ceded. By domain count it would be 1/5 = 0.2 → ownable.
    expect(result).toEqual({ winnabilityClass: 'ceded', winnability: 1 - 40 / 44 })
  })

  it('fails open to ownable + null winnability when there is no cited surface', () => {
    const result = deriveWinnabilityClass([], classes([['booking.com', SurfaceClasses['ota-aggregator']]]))
    expect(result.winnabilityClass).toBe(WinnabilityClasses.ownable)
    expect(result.winnability).toBeNull()
  })

  it('fails open to ownable + null winnability when the classification map is empty', () => {
    const result = deriveWinnabilityClass(
      [{ domain: 'booking.com', citationCount: 10 }],
      classes([]),
    )
    expect(result.winnabilityClass).toBe(WinnabilityClasses.ownable)
    expect(result.winnability).toBeNull()
  })

  it('fails open when none of the cited domains have a classification (zero coverage)', () => {
    const result = deriveWinnabilityClass(
      [{ domain: 'unrated-a.com', citationCount: 5 }, { domain: 'unrated-b.com', citationCount: 5 }],
      classes([['booking.com', SurfaceClasses['ota-aggregator']]]),
    )
    expect(result.winnabilityClass).toBe(WinnabilityClasses.ownable)
    expect(result.winnability).toBeNull()
  })

  it('treats an explicit other surface as assessed and non-ceded', () => {
    const result = deriveWinnabilityClass(
      [{ domain: 'gov.example', citationCount: 10 }],
      classes([['gov.example', SurfaceClasses.other]]),
    )
    expect(result).toEqual({ winnabilityClass: 'ownable', winnability: 1 })
  })

  it('counts unclassified cited domains in the denominator (dilutes toward ownable)', () => {
    const result = deriveWinnabilityClass(
      [{ domain: 'booking.com', citationCount: 5 }, { domain: 'unrated.com', citationCount: 5 }],
      classes([['booking.com', SurfaceClasses['ota-aggregator']]]),
    )
    // numerator 5 (booking), denominator 10 (both) → 0.5 < 0.6 → ownable
    expect(result).toEqual({ winnabilityClass: 'ownable', winnability: 0.5 })
  })
})

// ─── Content brief ───────────────────────────────────────────────────────────

describe('contentBriefDtoSchema', () => {
  const validBrief = {
    targetQuery: 'best boutique hotel williamsburg',
    winnabilityClass: 'ownable',
    angle: 'Local-first guide leaning on first-party amenity detail',
    whyWinnable: 'Cited surface is rival hotels, not OTAs — first-party content can win.',
    schemaHookup: 'Add Hotel + FAQPage schema to the property page.',
    controllableSurfaceRationale: 'Direct competitors are cited; this surface is controllable.',
  }

  it('parses a complete brief', () => {
    const parsed = contentBriefDtoSchema.parse(validBrief)
    expect(parsed).toEqual(validBrief)
  })

  it('requires all six fields', () => {
    for (const key of ['targetQuery', 'winnabilityClass', 'angle', 'whyWinnable', 'schemaHookup', 'controllableSurfaceRationale']) {
      const { [key]: _omitted, ...without } = validBrief as Record<string, unknown>
      expect(() => contentBriefDtoSchema.parse(without)).toThrow()
    }
  })

  it('rejects an invalid winnabilityClass', () => {
    expect(() => contentBriefDtoSchema.parse({ ...validBrief, winnabilityClass: 'winnable' })).toThrow()
  })

  it('rejects blank string fields', () => {
    for (const key of ['targetQuery', 'angle', 'whyWinnable', 'schemaHookup', 'controllableSurfaceRationale']) {
      expect(() => contentBriefDtoSchema.parse({ ...validBrief, [key]: '   ' })).toThrow()
    }
  })

  it('recommendationBriefDtoSchema wraps the brief with provider metadata', () => {
    const input = {
      targetRef: 'tgt_1',
      promptVersion: 'v1',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      brief: validBrief,
      costMillicents: 120,
      generatedAt: '2026-06-01T00:00:00.000Z',
    }
    const parsed = recommendationBriefDtoSchema.parse(input)
    expect(parsed).toEqual(input)
  })

  it('recommendationBriefDtoSchema rejects negative cost', () => {
    expect(() => recommendationBriefDtoSchema.parse({
      targetRef: 'tgt_1', promptVersion: 'v1', provider: 'claude', model: 'm',
      brief: validBrief, costMillicents: -1, generatedAt: '2026-06-01T00:00:00.000Z',
    })).toThrow()
  })
})

describe('domainClassificationsResponseDtoSchema', () => {
  it('parses a classification row + response wrapper', () => {
    const row = { domain: 'booking.com', competitorType: 'ota-aggregator', hits: 7, updatedAt: '2026-06-01T00:00:00.000Z' }
    expect(domainClassificationDtoSchema.parse(row)).toEqual(row)
    const parsed = domainClassificationsResponseDtoSchema.parse({ classifications: [row] })
    expect(parsed).toEqual({ classifications: [row] })
  })

  it('rejects an unknown competitorType', () => {
    expect(() => domainClassificationDtoSchema.parse({
      domain: 'x.com', competitorType: 'frenemy', hits: 1, updatedAt: '2026-06-01T00:00:00.000Z',
    })).toThrow()
  })

  it('parses an empty classifications response', () => {
    expect(domainClassificationsResponseDtoSchema.parse({ classifications: [] }).classifications).toEqual([])
  })
})
