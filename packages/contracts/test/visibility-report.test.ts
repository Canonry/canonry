import { describe, expect, it } from 'vitest'
import {
  parseVisibilityReportScopeErrorDetails,
  VisibilityReportComparisonUnavailableReasons,
  visibilityReportQuerySchema,
  VisibilityReportRateChangeUnavailableReasons,
  visibilityReportRateChangeSchema,
  visibilityReportResponseSchema,
  visibilityReportScopeErrorDetailsSchema,
  VisibilityReportScopeErrorReasons,
} from '../src/visibility-report.js'

describe('visibility report contract', () => {
  it('defaults to the non-brand population and preserves explicit no-location', () => {
    expect(visibilityReportQuerySchema.parse({ location: 'none' })).toMatchObject({
      mode: 'auto',
      queryClass: 'non-brand',
      scope: 'project',
      location: { kind: 'none' },
    })
  })

  it('requires a scope key for a group, market, or Property selection', () => {
    expect(visibilityReportQuerySchema.safeParse({ scope: 'market' }).success).toBe(false)
    expect(visibilityReportQuerySchema.parse({ scope: 'market', scopeKey: 'alpha' })).toMatchObject({
      scope: 'market',
      scopeKey: 'alpha',
    })
  })

  it('accepts an optional market refinement alongside a project, group, or Property scope', () => {
    expect(visibilityReportQuerySchema.parse({ scope: 'group', scopeKey: 'collection', marketKey: 'north-market' }))
      .toMatchObject({ scope: 'group', scopeKey: 'collection', marketKey: 'north-market' })
  })

  it('rejects a duplicate marketKey when market scope already selects the market', () => {
    expect(visibilityReportQuerySchema.safeParse({ scope: 'market', scopeKey: 'north-market', marketKey: 'north-market' }).success).toBe(false)
  })

  it('carries optional frozen parent memberships without fabricating them for old definitions', () => {
    expect(visibilityReportResponseSchema.safeParse({ selection: { mode: 'advanced', queryClass: 'non-brand', scope: { id: 'project', label: 'Project', kind: 'project', targetCount: 1 }, provider: null, model: null, location: { kind: 'all' }, time: { from: null, to: null }, revision: 1, run: { id: null, explicit: false }, provenance: { kind: 'frozen-advanced', definitionRevision: 1 }, measurement: { state: 'not-measured', activeRevision: 1, measuredRevision: null, awaitingSweep: true, pendingAssignmentCount: 1, completedAt: null }, availability: { state: 'available' } }, scopeOptions: [{ id: 'metro', label: 'Metro', kind: 'group', targetCount: 1 }, { id: 'submarket', label: 'Submarket', kind: 'group', targetCount: 1, parentGroupIds: ['metro'] }, { id: 'property', label: 'Property', kind: 'property', targetCount: 1, parentGroupIds: ['metro', 'submarket'] }], filterOptions: { providers: [], models: [], locations: [{ kind: 'all' }] }, populations: [population('non-brand')] }).success).toBe(true)
  })

  it('keeps all classes as side-by-side populations rather than a pooled headline', () => {
    const parsed = visibilityReportResponseSchema.parse({
      selection: {
        mode: 'advanced',
        queryClass: 'all',
        scope: { kind: 'market', id: 'alpha', label: 'Alpha', targetCount: 1 },
        provider: null,
        model: null,
        location: { kind: 'exact', value: 'Alpha' },
        time: { from: null, to: null },
        revision: 3,
        run: { id: 'run-3', explicit: false },
        provenance: { kind: 'frozen-advanced', definitionRevision: 3 },
        measurement: { state: 'measured', activeRevision: 3, measuredRevision: 3, awaitingSweep: false, pendingAssignmentCount: 0, completedAt: '2026-09-04T12:00:00.000Z' },
        availability: { state: 'available' },
      },
      scopeOptions: [
        { id: 'project', label: 'Project', kind: 'project', targetCount: 1 },
        { id: 'alpha', label: 'Alpha', kind: 'market', targetCount: 1 },
      ],
      filterOptions: { providers: ['openai'], models: [{ provider: 'openai', model: 'gpt-5' }], locations: [{ kind: 'exact', value: 'Alpha' }] },
      populations: [
        population('branded'),
        population('non-brand'),
        population('unknown'),
      ],
    })

    expect(parsed.populations.map(population => population.queryClass)).toEqual([
      'branded',
      'non-brand',
      'unknown',
    ])
    expect('summary' in parsed).toBe(false)
  })

  it('requires each server-owned rate to carry its denominator', () => {
    const response = {
      selection: {
        mode: 'simple',
        queryClass: 'non-brand',
        scope: { kind: 'project', id: 'project', label: 'Project', targetCount: 1 },
        provider: null,
        model: null,
        location: { kind: 'all' },
        time: { from: null, to: null },
        revision: null,
        run: { id: null, explicit: false },
        provenance: { kind: 'legacy-simple', definitionRevision: null },
        measurement: { state: 'not-measured', activeRevision: null, measuredRevision: null, awaitingSweep: false, pendingAssignmentCount: 0, completedAt: null },
        availability: { state: 'available' },
      },
      scopeOptions: [{ id: 'project', label: 'Project', kind: 'project', targetCount: 1 }],
      filterOptions: { providers: [], models: [], locations: [{ kind: 'all' }] },
      populations: [population('non-brand')],
    }
    expect(visibilityReportResponseSchema.safeParse(response).success).toBe(true)

    const missingDenominator = structuredClone(response)
    delete (missingDenominator.populations[0] as { summary: { mentionCoverage: Record<string, unknown> } }).summary.mentionCoverage.denominator
    expect(visibilityReportResponseSchema.safeParse(missingDenominator).success).toBe(false)
  })
})

function population(queryClass: 'branded' | 'non-brand' | 'unknown') {
  return {
    queryClass,
    summary: {
      queryCount: 1,
      answerCount: 1,
      mentionCoverage: { numerator: 1, denominator: 1, rate: 1 },
      citationCoverage: { numerator: 1, denominator: 1, rate: 1 },
      propertyReach: { numerator: 1, denominator: 1, rate: 1 },
      outcomes: { bothSignals: 1, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 0, total: 1 },
    },
    trend: [{
      runId: 'run-3',
      createdAt: '2026-09-04T12:00:00.000Z',
      revision: 3,
      provenance: { kind: 'frozen-advanced', definitionRevision: 3 },
      queryCount: 1,
      answerCount: 1,
      mentionCoverage: { numerator: 1, denominator: 1, rate: 1 },
      citationCoverage: { numerator: 1, denominator: 1, rate: 1 },
      continuity: { state: 'first', comparedRunId: null },
    }],
    queries: { items: [{
      queryKey: 'question:1',
      queryId: 'q1',
      query: 'What is Northstar?',
      provider: 'openai',
      model: 'gpt-5',
      location: 'Alpha',
      targetKeys: ['property:1'],
      answerCount: 1,
      mentionCoverage: { numerator: 1, denominator: 1, rate: 1 },
      citationCoverage: { numerator: 1, denominator: 1, rate: 1 },
    }], nextCursor: null, total: 1 },
    evidence: { items: [{
      answerId: 'answer:1',
      runId: 'run-3',
      queryKey: 'question:1',
      query: 'What is Northstar?',
      provider: 'openai',
      model: 'gpt-5',
      location: 'Alpha',
      targetKeys: ['property:1'],
      mentioned: true,
      cited: true,
      answerText: null,
      createdAt: '2026-09-04T12:00:00.000Z',
      sources: ['https://northstar.example/'],
      observedCompetitors: [],
    }], nextCursor: null, total: 1 },
    competitorAvailability: { state: 'available' },
    competitors: [{
      domain: 'challenger.example',
      answerCount: 1,
      mentionCoverage: { numerator: 0, denominator: 1, rate: 0 },
      citationCoverage: { numerator: 0, denominator: 1, rate: 0 },
    }],
    observedCompetitors: [],
    breakdown: {
      properties: [{
        id: 'property:1',
        label: 'Property 1',
        queryCount: 1,
        mentionCoverage: { numerator: 1, denominator: 1, rate: 1 },
        citationCoverage: { numerator: 1, denominator: 1, rate: 1 },
      }],
      groups: [],
    },
  }
}

describe('visibility report comparison contract', () => {
  it('parses an available change with the previous rate and the exact server delta', () => {
    const parsed = visibilityReportResponseSchema.parse(comparedResponse(availableComparison()))

    expect(parsed.populations[0]?.comparison).toEqual({
      state: 'available',
      previousRun: { id: 'run-2', createdAt: '2026-09-06T12:00:00.000Z', completedAt: '2026-09-06T12:40:00.000Z' },
      mentionCoverage: { state: 'available', previous: { numerator: 18, denominator: 36, rate: 0.5 }, delta: 24 / 36 - 0.5 },
      citationCoverage: { state: 'available', previous: { numerator: 9, denominator: 36, rate: 0.25 }, delta: 12 / 36 - 0.25 },
      propertyReach: { state: 'available', previous: { numerator: 10, denominator: 12, rate: 10 / 12 }, delta: 1 - 10 / 12 },
    })
    // Current 24/36 minus previous 18/36, carried unrounded rather than as a display value.
    expect(parsed.populations[0]).toHaveProperty(['comparison', 'mentionCoverage', 'delta'], 0.16666666666666663)
  })

  it('parses every unavailable comparison reason, with or without a previous run', () => {
    expect(Object.values(VisibilityReportComparisonUnavailableReasons)).toEqual([
      'no-selected-run',
      'no-previous-run',
      'scoped-run',
      'partial-run',
      'definition-changed',
      'model-changed',
      'legacy-unknown',
    ])

    for (const reason of Object.values(VisibilityReportComparisonUnavailableReasons)) {
      for (const previousRun of [null, PREVIOUS_RUN]) {
        const comparison = { state: 'unavailable', reason, previousRun }
        const parsed = visibilityReportResponseSchema.parse(comparedResponse(comparison))
        expect(parsed.populations[0]?.comparison).toEqual(comparison)
      }
    }
  })

  it('parses every unavailable metric reason inside an available comparison', () => {
    expect(Object.values(VisibilityReportRateChangeUnavailableReasons)).toEqual([
      'current-unavailable',
      'previous-unavailable',
      'not-applicable',
    ])
    // The current Properties-reached rate each reason describes.
    const currentPropertyReach = {
      'current-unavailable': unavailableRate('incomplete'),
      'previous-unavailable': rate(12, 12),
      'not-applicable': unavailableRate('not-applicable'),
    }

    for (const reason of Object.values(VisibilityReportRateChangeUnavailableReasons)) {
      const comparison = { ...availableComparison(), propertyReach: { state: 'unavailable', reason } }
      const parsed = visibilityReportResponseSchema.parse(
        comparedResponse(comparison, { summary: { propertyReach: currentPropertyReach[reason] } }),
      )
      expect(parsed.populations[0]?.comparison).toEqual(comparison)
    }
  })

  it('still parses a population that carries no comparison', () => {
    const parsed = visibilityReportResponseSchema.parse(comparedResponse(undefined))

    expect(parsed.populations[0]).not.toHaveProperty('comparison')
  })

  it('bounds a rate change delta to the closed interval from -1 to 1', () => {
    expect(visibilityReportRateChangeSchema.parse({ state: 'available', previous: rate(0, 36), delta: 1 }))
      .toEqual({ state: 'available', previous: { numerator: 0, denominator: 36, rate: 0 }, delta: 1 })
    expect(visibilityReportRateChangeSchema.parse({ state: 'available', previous: rate(36, 36), delta: -1 }))
      .toEqual({ state: 'available', previous: { numerator: 36, denominator: 36, rate: 1 }, delta: -1 })

    expect(visibilityReportRateChangeSchema.safeParse({ state: 'available', previous: rate(0, 36), delta: 1.5 }).error?.issues)
      .toEqual([expect.objectContaining({ code: 'too_big', maximum: 1, path: ['delta'] })])
    expect(visibilityReportRateChangeSchema.safeParse({ state: 'available', previous: rate(36, 36), delta: -1.5 }).error?.issues)
      .toEqual([expect.objectContaining({ code: 'too_small', minimum: -1, path: ['delta'] })])
  })

  it('rejects unknown keys on every comparison object', () => {
    const cases = [
      {
        comparison: { ...availableComparison(), direction: 'up' },
        path: ['populations', 0, 'comparison'],
        keys: ['direction'],
      },
      {
        comparison: { state: 'unavailable', reason: 'no-previous-run', previousRun: null, delta: 0 },
        path: ['populations', 0, 'comparison'],
        keys: ['delta'],
      },
      {
        comparison: { ...availableComparison(), previousRun: { ...PREVIOUS_RUN, status: 'completed' } },
        path: ['populations', 0, 'comparison', 'previousRun'],
        keys: ['status'],
      },
      {
        comparison: {
          ...availableComparison(),
          mentionCoverage: { state: 'available', previous: rate(18, 36), delta: 24 / 36 - 0.5, current: rate(24, 36) },
        },
        path: ['populations', 0, 'comparison', 'mentionCoverage'],
        keys: ['current'],
      },
      {
        comparison: {
          ...availableComparison(),
          citationCoverage: { state: 'unavailable', reason: 'previous-unavailable', previous: rate(9, 36) },
        },
        path: ['populations', 0, 'comparison', 'citationCoverage'],
        keys: ['previous'],
      },
    ]

    for (const { comparison, path, keys } of cases) {
      expect(visibilityReportResponseSchema.safeParse(comparedResponse(comparison)).error?.issues)
        .toEqual([expect.objectContaining({ code: 'unrecognized_keys', keys, path })])
    }
  })
})

describe('visibility report comparison invariants', () => {
  it('rejects a delta that is not the current rate minus the previous rate', () => {
    // Current 24/36 minus previous 0.5 is 0.1667: neither 0.2 nor a near miss is that difference.
    for (const delta of [0.2, 24 / 36 - 0.5 + 1e-9]) {
      const comparison = { ...availableComparison(), mentionCoverage: { state: 'available', previous: rate(18, 36), delta } }

      expect(visibilityReportResponseSchema.safeParse(comparedResponse(comparison)).error?.issues).toEqual([
        expect.objectContaining({
          code: 'custom',
          path: ['populations', 0, 'comparison', 'mentionCoverage', 'delta'],
          message: 'Delta must equal current minus previous',
        }),
      ])
    }
  })

  it('rejects an available change whose current rate is unavailable', () => {
    const response = comparedResponse(availableComparison(), { summary: { mentionCoverage: unavailableRate('incomplete') } })

    expect(visibilityReportResponseSchema.safeParse(response).error?.issues).toEqual([
      expect.objectContaining({
        code: 'custom',
        path: ['populations', 0, 'comparison', 'mentionCoverage'],
        message: 'Available changes require a current rate',
      }),
    ])
  })

  it('rejects an available change whose previous rate is unavailable', () => {
    const comparison = {
      ...availableComparison(),
      citationCoverage: { state: 'available', previous: unavailableRate('no-population'), delta: 0 },
    }

    expect(visibilityReportResponseSchema.safeParse(comparedResponse(comparison)).error?.issues).toEqual([
      expect.objectContaining({
        code: 'custom',
        path: ['populations', 0, 'comparison', 'citationCoverage', 'previous', 'rate'],
        message: 'Available changes require a previous rate',
      }),
    ])
  })

  it('rejects available changes when the selection has no run', () => {
    const response = comparedResponse(availableComparison(), { runId: null })

    expect(visibilityReportResponseSchema.safeParse(response).error?.issues).toEqual(
      ['mentionCoverage', 'citationCoverage', 'propertyReach'].map(metric => expect.objectContaining({
        code: 'custom',
        path: ['populations', 0, 'comparison', metric],
        message: 'Available changes require a selected run',
      })),
    )
  })

  it('checks each query class population against its own summary, never a pooled one', () => {
    // Branded and unclassified summaries are 1 of 1; non-brand is 24 of 36.
    const populations = (unknownMentionDelta: number) => [
      { ...population('branded'), comparison: { state: 'unavailable', reason: 'no-previous-run', previousRun: null } },
      comparedPopulation(availableComparison()),
      {
        ...population('unknown'),
        comparison: {
          state: 'available',
          previousRun: PREVIOUS_RUN,
          mentionCoverage: { state: 'available', previous: rate(1, 2), delta: unknownMentionDelta },
          citationCoverage: { state: 'unavailable', reason: 'previous-unavailable' },
          propertyReach: { state: 'unavailable', reason: 'previous-unavailable' },
        },
      },
    ]

    expect(visibilityReportResponseSchema.safeParse(reportResponse(populations(1 - 0.5), { queryClass: 'all' })).success)
      .toBe(true)
    // The non-brand difference (24/36 - 0.5) is wrong for the unclassified 1 of 1 population.
    expect(visibilityReportResponseSchema.safeParse(reportResponse(populations(24 / 36 - 0.5), { queryClass: 'all' })).error?.issues)
      .toEqual([
        expect.objectContaining({
          code: 'custom',
          path: ['populations', 2, 'comparison', 'mentionCoverage', 'delta'],
          message: 'Delta must equal current minus previous',
        }),
      ])
  })

  it('accepts exact boundary and zero-change deltas', () => {
    const cases = [
      { current: rate(36, 36), previous: rate(0, 36), delta: 1 },
      { current: rate(0, 36), previous: rate(36, 36), delta: -1 },
      { current: rate(24, 36), previous: rate(24, 36), delta: 0 },
    ]

    for (const { current, previous, delta } of cases) {
      const comparison = { ...availableComparison(), mentionCoverage: { state: 'available', previous, delta } }
      const parsed = visibilityReportResponseSchema.parse(comparedResponse(comparison, { summary: { mentionCoverage: current } }))
      expect(parsed.populations[0]?.comparison).toEqual(comparison)
    }
  })

  it('does not require a selected run for an unavailable comparison', () => {
    const comparison = { state: 'unavailable', reason: 'no-selected-run', previousRun: null }
    const parsed = visibilityReportResponseSchema.parse(comparedResponse(comparison, { runId: null }))

    expect(parsed.populations[0]?.comparison).toEqual(comparison)
  })
})

describe('visibility report scope error details', () => {
  it('parses typed retired-scope details for a group, market, or Property', () => {
    expect(Object.values(VisibilityReportScopeErrorReasons)).toEqual(['retired-scope', 'retired-market'])

    for (const details of [
      { reason: 'retired-scope', kind: 'group', key: 'metro' },
      { reason: 'retired-scope', kind: 'property', key: 'harbor-point' },
      { reason: 'retired-market', kind: 'market', key: 'north-market' },
    ]) {
      expect(parseVisibilityReportScopeErrorDetails(details)).toEqual(details)
    }
  })

  it('pairs a retired market with the market kind, while a retired scope keeps any kind', () => {
    for (const details of [
      { reason: 'retired-market', kind: 'market', key: 'north-market' },
      // A retired market selected as the scope itself is a retired scope of kind market.
      { reason: 'retired-scope', kind: 'market', key: 'north-market' },
    ]) {
      expect(visibilityReportScopeErrorDetailsSchema.safeParse(details).success).toBe(true)
      expect(parseVisibilityReportScopeErrorDetails(details)).toEqual(details)
    }

    for (const kind of ['group', 'property']) {
      const details = { reason: 'retired-market', kind, key: 'north-market' }
      const parsed = visibilityReportScopeErrorDetailsSchema.safeParse(details)
      expect(parsed.success).toBe(false)
      expect(parsed.error?.issues.map(({ code, path, message }) => ({ code, path, message }))).toEqual([
        { code: 'custom', path: ['kind'], message: 'retired-market details must name a market' },
      ])
      expect(parseVisibilityReportScopeErrorDetails(details)).toBeUndefined()
    }
  })

  it('returns undefined for anything that is not exact retired-scope details', () => {
    for (const value of [
      { reason: 'retired-plan', kind: 'market', key: 'north-market' },
      { reason: 'retired-market', kind: 'market', key: 'north-market', message: 'Market retired' },
      { reason: 'retired-market', kind: 'market' },
      { reason: 'retired-scope', kind: 'project', key: 'project' },
      { reason: 'retired-market', kind: 'market', key: '   ' },
      'retired-market',
      null,
      undefined,
    ]) {
      expect(parseVisibilityReportScopeErrorDetails(value)).toBeUndefined()
    }
  })
})

const PREVIOUS_RUN = { id: 'run-2', createdAt: '2026-09-06T12:00:00.000Z', completedAt: '2026-09-06T12:40:00.000Z' }

function rate(numerator: number, denominator: number) {
  return { numerator, denominator, rate: numerator / denominator }
}

function unavailableRate(reason: 'no-population' | 'incomplete' | 'not-applicable') {
  return { numerator: null, denominator: null, rate: null, reason }
}

/** Mentioned 18/36 then 24/36, cited 9/36 then 12/36, Properties reached 10/12 then 12/12. */
function availableComparison() {
  return {
    state: 'available',
    previousRun: PREVIOUS_RUN,
    mentionCoverage: { state: 'available', previous: rate(18, 36), delta: 24 / 36 - 0.5 },
    citationCoverage: { state: 'available', previous: rate(9, 36), delta: 12 / 36 - 0.25 },
    propertyReach: { state: 'available', previous: rate(10, 12), delta: 1 - 10 / 12 },
  }
}

/** A non-brand population whose current summary is 24/36 mentioned, 12/36 cited, and 12/12 Properties. */
function comparedPopulation(comparison: unknown, summary: Record<string, unknown> = {}) {
  const base = population('non-brand')
  return {
    ...base,
    summary: {
      ...base.summary,
      queryCount: 12,
      answerCount: 36,
      mentionCoverage: rate(24, 36),
      citationCoverage: rate(12, 36),
      propertyReach: rate(12, 12),
      outcomes: { bothSignals: 12, mentionedOnly: 12, citedOnly: 0, neither: 12, notMeasured: 0, total: 36 },
      ...summary,
    },
    ...(comparison === undefined ? {} : { comparison }),
  }
}

function comparedResponse(comparison: unknown, options: { runId?: string | null; summary?: Record<string, unknown> } = {}) {
  return reportResponse([comparedPopulation(comparison, options.summary)], { runId: options.runId })
}

function reportResponse(populations: unknown[], options: { queryClass?: 'non-brand' | 'all'; runId?: string | null } = {}) {
  return {
    selection: {
      mode: 'advanced',
      queryClass: options.queryClass ?? 'non-brand',
      scope: { kind: 'project', id: 'project', label: 'Project', targetCount: 12 },
      provider: null,
      model: null,
      location: { kind: 'all' },
      time: { from: null, to: null },
      revision: 3,
      run: { id: options.runId === undefined ? 'run-3' : options.runId, explicit: false },
      provenance: { kind: 'frozen-advanced', definitionRevision: 3 },
      measurement: {
        state: 'measured',
        activeRevision: 3,
        measuredRevision: 3,
        awaitingSweep: false,
        pendingAssignmentCount: 0,
        completedAt: '2026-09-13T12:40:00.000Z',
      },
      availability: { state: 'available' },
    },
    scopeOptions: [{ id: 'project', label: 'Project', kind: 'project', targetCount: 12 }],
    filterOptions: { providers: ['openai'], models: [], locations: [{ kind: 'all' }] },
    populations,
  }
}
