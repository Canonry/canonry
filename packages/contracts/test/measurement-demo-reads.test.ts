import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  MEASUREMENT_CHANGES_DEFAULT_SORT,
  MEASUREMENT_CHANGES_NOISE_ANSWERS,
  MEASUREMENT_PORTFOLIO_DEFAULT_LIMIT,
  MEASUREMENT_PORTFOLIO_TIE_NOTE,
  measurementChangesQuerySchema,
  measurementChangesResponseSchema,
  measurementDataQualityQuerySchema,
  measurementDataQualityResponseSchema,
  measurementPortfolioMentionRankingSchema,
  measurementPortfolioSummaryQuerySchema,
  measurementPortfolioSummaryResponseSchema,
  measurementPortfolioWeakestPropertySchema,
  measurementPropertyCompetitorsQuerySchema,
  measurementPropertyCompetitorsResponseSchema,
  measurementPropertyQuestionsQuerySchema,
  measurementPropertyQuestionsResponseSchema,
  measurementQuestionResultQuerySchema,
  measurementQuestionResultResponseSchema,
} from '../src/measurement-demo-reads.js'

const METRIC = { state: 'available' as const, value: 0.5, numerator: 2, denominator: 4 }
const MEASUREMENT = {
  state: 'complete' as const,
  displayedRunId: 'run-cedar-01',
  planRevision: 2,
  completedAt: '2026-08-02T12:00:00.000Z',
}
const PROPERTY = { targetKey: 'cedar-bay', label: 'Cedar Bay' }
const PLACED = {
  ...PROPERTY,
  metro: { groupKey: 'harbor-metro', label: 'Harbor Metro' },
  submarkets: ['Harbor District'],
  queries: 2,
}
const SUMMARY = {
  portfolio: { groupKey: 'harbor-district', label: 'Harbor District', measurementScope: 'full' as const },
  measurement: MEASUREMENT,
  queryClass: 'non-brand' as const,
  engines: ['gemini', 'openai'],
  metrics: {
    propertiesMentioned: METRIC,
    mentionCoverage: METRIC,
    citationCoverage: METRIC,
  },
  mentionRanking: {
    eligiblePropertyCount: 1,
    strongest: [{ ...PLACED, mentionCoverage: METRIC, citationCoverage: METRIC }],
    weakest: [{ ...PLACED, mentionCoverage: METRIC, citationCoverage: METRIC }],
    excluded: [],
    truncated: false,
  },
  weakestProperties: [{
    ...PLACED,
    mentionCoverage: METRIC,
    citationCoverage: { state: 'unavailable' as const, reason: 'evidence_incomplete' as const },
    flags: 1,
    namedInsteadInAnswerText: [{ name: 'Harborline Homes', answers: 2 }],
    namedInsteadInAnswerTextTotal: 1,
    citedDomains: [{ domain: 'listings.example', answers: 3 }],
    citedDomainsTotal: 1,
    recommendedInstead: [{ name: 'Harborline Homes', occurrences: 2 }],
    recommendedInsteadTotal: 1,
    recommendedInsteadTruncated: false,
  }],
  tiedAtWeakest: { count: 2, mentionRate: 0, citationRate: 0, note: MEASUREMENT_PORTFOLIO_TIE_NOTE },
  weakestAnswerSources: { properties: 2, answers: 4, domains: [{ domain: 'listings.example', answers: 3 }], domainTotal: 1 },
  markets: [{
    groupKey: 'harbor-district',
    label: 'Harbor District',
    parentGroupKey: 'harbor-metro',
    childMarketCount: 0,
    propertyCount: 3,
    propertiesMentioned: METRIC,
    mentionCoverage: METRIC,
    citationCoverage: METRIC,
  }],
  totalMarkets: 1,
  marketsTruncated: false,
  totalProperties: 1,
  truncated: false,
}

describe('advanced measurement demo reads', () => {
  it('parses a bounded portfolio summary and defaults its comparison basket to non-brand', () => {
    expect(measurementPortfolioSummaryQuerySchema.parse({})).toEqual({ queryClass: 'non-brand' })
    expect(measurementPortfolioSummaryQuerySchema.safeParse({ limit: 51 }).success).toBe(false)
    expect(measurementPortfolioSummaryQuerySchema.parse({ queryClass: 'all' })).toEqual({ queryClass: 'all' })

    expect(measurementPortfolioSummaryResponseSchema.parse(SUMMARY)).toMatchObject({ measurement: { displayedRunId: 'run-cedar-01' } })

    expect(measurementPortfolioSummaryResponseSchema.safeParse({ ...SUMMARY, extra: true }).success).toBe(false)
  })

  it('accepts the nested-markets flag only as a boolean and leaves it unset by default', () => {
    expect(measurementPortfolioSummaryQuerySchema.parse({ includeNestedMarkets: true })).toEqual({ queryClass: 'non-brand', includeNestedMarkets: true })
    expect(measurementPortfolioSummaryQuerySchema.safeParse({ includeNestedMarkets: 'true' }).success).toBe(false)
    expect(MEASUREMENT_PORTFOLIO_DEFAULT_LIMIT).toBeLessThan(10)
  })

  it('names what an answer wrote instead without calling it a citation', () => {
    const [row] = SUMMARY.weakestProperties
    expect(measurementPortfolioSummaryResponseSchema.safeParse({
      ...SUMMARY,
      weakestProperties: [{ ...row, namedInsteadInAnswerTextTotal: 0 }],
    }).success).toBe(false)
    expect(measurementPortfolioSummaryResponseSchema.safeParse({
      ...SUMMARY,
      weakestProperties: [{ ...row, citedDomains: Array.from({ length: 6 }, (_, index) => ({ domain: `source-${index}.example`, answers: 1 })), citedDomainsTotal: 6 }],
    }).success).toBe(false)
  })

  it('keeps the deprecated recommendedInstead fields beside the new names for existing consumers', () => {
    const [row] = SUMMARY.weakestProperties
    const parse = (changes: Record<string, unknown>) => measurementPortfolioSummaryResponseSchema.safeParse({
      ...SUMMARY, weakestProperties: [{ ...row, ...changes }],
    }).success
    // A patch release cannot drop fields a consumer already reads.
    for (const field of ['recommendedInstead', 'recommendedInsteadTotal', 'recommendedInsteadTruncated'] as const) {
      const { [field]: _dropped, ...withoutField } = row
      expect(measurementPortfolioSummaryResponseSchema.safeParse({ ...SUMMARY, weakestProperties: [withoutField] }).success).toBe(false)
    }
    // The nested `occurrences` count keeps its name.
    expect(parse({ recommendedInstead: [{ name: 'Harborline Homes', answers: 2 }] })).toBe(false)
    // Its totals agree with what is returned and with the new field.
    expect(parse({ recommendedInsteadTruncated: true })).toBe(false)
    expect(parse({ recommendedInsteadTotal: 2, recommendedInsteadTruncated: true })).toBe(false)
    expect(parse({
      recommendedInstead: Array.from({ length: 6 }, (_, index) => ({ name: `Name ${index}`, occurrences: 1 })),
      recommendedInsteadTotal: 6, namedInsteadInAnswerTextTotal: 6,
    })).toBe(false)
    expect(parse({ recommendedInsteadTotal: 7, recommendedInsteadTruncated: true, namedInsteadInAnswerTextTotal: 7 })).toBe(true)

    // Published as deprecated, pointing at the recommended field.
    const json = z.toJSONSchema(measurementPortfolioWeakestPropertySchema, { target: 'openapi-3.0' }) as {
      properties: Record<string, { deprecated?: boolean; description?: string }>
    }
    for (const field of ['recommendedInstead', 'recommendedInsteadTotal', 'recommendedInsteadTruncated']) {
      expect(json.properties[field]).toMatchObject({ deprecated: true, description: expect.stringContaining('namedInsteadInAnswerText') })
    }
    // Only the old names: the shared count schema the new totals use is not marked.
    for (const field of ['namedInsteadInAnswerText', 'namedInsteadInAnswerTextTotal', 'citedDomainsTotal']) {
      expect(json.properties[field]?.deprecated).toBeUndefined()
    }
  })

  it('keeps tie, source and market totals consistent with what is returned', () => {
    expect(measurementPortfolioSummaryResponseSchema.safeParse({
      ...SUMMARY, tiedAtWeakest: { ...SUMMARY.tiedAtWeakest, note: 'ranked' },
    }).success).toBe(false)
    expect(measurementPortfolioSummaryResponseSchema.safeParse({
      ...SUMMARY, tiedAtWeakest: { ...SUMMARY.tiedAtWeakest, count: 1 },
    }).success).toBe(false)
    expect(measurementPortfolioSummaryResponseSchema.safeParse({
      ...SUMMARY, weakestAnswerSources: { properties: 2, answers: 3, domains: [{ domain: 'listings.example', answers: 4 }], domainTotal: 1 },
    }).success).toBe(false)
    expect(measurementPortfolioSummaryResponseSchema.safeParse({ ...SUMMARY, marketsTruncated: true }).success).toBe(false)
    expect(measurementPortfolioSummaryResponseSchema.safeParse({ ...SUMMARY, totalMarkets: 4, marketsTruncated: true }).success).toBe(true)
    // Before a run completes there is no tie and no answer to take sources from.
    expect(measurementPortfolioSummaryResponseSchema.safeParse({ ...SUMMARY, tiedAtWeakest: null, weakestAnswerSources: null, engines: [] }).success).toBe(true)
  })

  it('refuses to present an ambiguous mention as a ranked Property even when its citations are known', () => {
    const uncertain = { ...PLACED, mentionCoverage: { state: 'unavailable', reason: 'identity_ambiguous' }, citationCoverage: METRIC }
    expect(measurementPortfolioMentionRankingSchema.safeParse({
      eligiblePropertyCount: 1, strongest: [{ ...uncertain, mentionCoverage: METRIC }], weakest: [], excluded: [], truncated: false,
    }).success).toBe(true)
    expect(measurementPortfolioMentionRankingSchema.safeParse({
      eligiblePropertyCount: 1, strongest: [uncertain], weakest: [], excluded: [], truncated: false,
    }).success).toBe(false)
  })

  it('keeps unmeasured Property question rows explicitly nullable rather than false', () => {
    expect(measurementPropertyQuestionsQuerySchema.parse({ targetKey: 'cedar-bay', limit: 100 }))
      .toEqual({ targetKey: 'cedar-bay', limit: 100 })
    expect(measurementPropertyQuestionsQuerySchema.safeParse({ targetKey: 'cedar-bay', limit: 101 }).success).toBe(false)

    const response = measurementPropertyQuestionsResponseSchema.parse({
      property: PROPERTY,
      measurement: MEASUREMENT,
      queryClass: 'all',
      questions: [
        {
          resultId: 'result-cedar-01', queryId: 'question-cedar-01', text: 'Which homes are near Cedar Bay?',
          class: 'non-brand', provider: 'demo-engine', requestedModel: 'demo-model-a', servedModel: null,
          location: 'Cedar Bay, EX', status: 'answered', mentioned: false, cited: true,
          recommendedInstead: ['Harborline Homes'], answerExcerpt: 'A compact synthetic answer.',
        },
        {
          resultId: null, queryId: 'question-cedar-02', text: 'What is Cedar Bay?',
          class: 'branded', provider: 'demo-engine', requestedModel: null, servedModel: null,
          location: null, status: 'missing', mentioned: null, cited: null,
          recommendedInstead: [], answerExcerpt: null,
        },
      ],
      total: 2,
      truncated: false,
    })
    expect(response.questions[1]).toMatchObject({ status: 'missing', mentioned: null, cited: null })
    expect(measurementPropertyQuestionsResponseSchema.safeParse({
      ...response,
      questions: [{ ...response.questions[0], cited: null }, response.questions[1]],
    }).success).toBe(true)

    expect(measurementPropertyQuestionsResponseSchema.safeParse({
      property: PROPERTY, measurement: MEASUREMENT, queryClass: 'all', total: 1, truncated: false,
      questions: [{
        resultId: null, queryId: 'question-cedar-02', text: 'What is Cedar Bay?', class: 'branded',
        provider: 'demo-engine', requestedModel: null, servedModel: null, location: null,
        status: 'missing', mentioned: false, cited: null, recommendedInstead: [], answerExcerpt: null,
      }],
    }).success).toBe(false)
  })

  it('exposes one answer with explicit source, capture, and retrieval evidence', () => {
    expect(measurementQuestionResultQuerySchema.safeParse({ targetKey: 'cedar-bay' }).success).toBe(false)
    expect(measurementQuestionResultQuerySchema.parse({ targetKey: 'cedar-bay', resultId: 'result-cedar-01' }))
      .toEqual({ targetKey: 'cedar-bay', resultId: 'result-cedar-01' })

    const response = measurementQuestionResultResponseSchema.parse({
      property: PROPERTY,
      measurement: MEASUREMENT,
      question: {
        resultId: 'result-cedar-01', queryId: 'question-cedar-01', text: 'Which homes are near Cedar Bay?',
        class: 'non-brand', provider: 'demo-engine', requestedModel: 'demo-model-a', servedModel: null,
        location: 'Cedar Bay, EX', status: 'answered',
      },
      mentioned: false,
      cited: true,
      recommendedInstead: ['Harborline Homes'],
      answer: 'A full synthetic answer.',
      sources: [{
        url: 'https://harborline.example/listings', classification: 'external', matchedTargetKeys: [],
        assigned: false, historical: false, evidenceComplete: true,
      }],
      captureStatus: 'complete',
      retrievalStatus: 'used',
      retrievalContract: 'search-required-v1',
    })
    expect(response.sources[0]?.classification).toBe('external')

    expect(measurementQuestionResultResponseSchema.safeParse({
      ...response, sources: [{ ...response.sources[0], classification: 'invented' }],
    }).success).toBe(false)
  })

  it('keeps competitor frequencies tied to an explicit, counted target-miss basis', () => {
    expect(measurementPropertyCompetitorsQuerySchema.parse({ targetKey: 'cedar-bay', limit: 50 }))
      .toEqual({ targetKey: 'cedar-bay', limit: 50 })
    expect(measurementPropertyCompetitorsQuerySchema.safeParse({ targetKey: 'cedar-bay', limit: 51 }).success).toBe(false)

    const response = measurementPropertyCompetitorsResponseSchema.parse({
      property: PROPERTY,
      measurement: MEASUREMENT,
      queryClass: 'non-brand',
      basis: { state: 'available', answeredResults: 4, targetMissResults: 3, recommendationOccurrences: 5 },
      competitors: [{
        name: 'Harborline Homes', occurrences: 2, providers: ['demo-engine'],
        providerTotal: 1, providersTruncated: false,
        questions: ['Which homes are near Cedar Bay?'],
        questionTotal: 1, questionsTruncated: false,
      }],
      total: 1,
      truncated: false,
    })
    expect(response.basis).toMatchObject({ state: 'available', targetMissResults: 3 })

    expect(measurementPropertyCompetitorsResponseSchema.safeParse({
      ...response,
      basis: { state: 'unavailable', reason: 'no_completed_run', targetMissResults: 0 },
    }).success).toBe(false)
  })

  it('only admits comparisons with the same immutable plan and execution identity', () => {
    expect(measurementChangesQuerySchema.parse({})).toEqual({ scope: 'all', queryClass: 'all' })
    expect(measurementChangesQuerySchema.safeParse({ scope: 'group' }).success).toBe(false)

    const response = measurementChangesResponseSchema.parse({
      current: { ...MEASUREMENT, executionIdentity: 'identity-cedar-a', measurementScope: 'full' },
      comparison: {
        state: 'available',
        previous: {
          displayedRunId: 'run-cedar-00', planRevision: 2,
          completedAt: '2026-08-01T12:00:00.000Z', executionIdentity: 'identity-cedar-a',
          measurementScope: 'full',
        },
        metrics: {
          propertiesMentioned: { state: 'available', previous: METRIC, current: METRIC, delta: 0 },
          mentionCoverage: { state: 'available', previous: METRIC, current: METRIC, delta: 0 },
          citationCoverage: { state: 'available', previous: METRIC, current: METRIC, delta: 0 },
        },
        changedProperties: [{
          ...PROPERTY,
          mentionCoverage: { state: 'available', previous: METRIC, current: METRIC, delta: 0 },
          citationCoverage: { state: 'available', previous: METRIC, current: METRIC, delta: 0 },
          flags: 0,
        }],
        totalProperties: 1,
        truncated: false,
      },
    })
    expect(response.comparison.state).toBe('available')

    expect(measurementChangesResponseSchema.safeParse({
      ...response,
      comparison: {
        ...response.comparison,
        previous: { ...response.comparison.previous, planRevision: 1 },
      },
    }).success).toBe(false)
    expect(measurementChangesResponseSchema.parse({
      current: { ...MEASUREMENT, executionIdentity: 'identity-cedar-a', measurementScope: 'full' },
      comparison: { state: 'unavailable', reason: 'no_previous_run' },
    }).comparison).toEqual({ state: 'unavailable', reason: 'no_previous_run' })
  })

  it('reports data quality as exact status counts and explicit availability', () => {
    expect(measurementDataQualityQuerySchema.parse({ runId: 'run-cedar-01' })).toEqual({ runId: 'run-cedar-01' })
    expect(measurementDataQualityQuerySchema.safeParse({ runId: '' }).success).toBe(false)

    const response = measurementDataQualityResponseSchema.parse({
      run: { ...MEASUREMENT, executionIdentity: 'identity-cedar-a', measurementScope: 'full' },
      // A persisted snapshot can lack answer text yet still carry capture/retrieval evidence.
      completeness: { state: 'available', expected: 8, executed: 8, answered: 7, missing: 0 },
      capture: { state: 'available', complete: 6, partial: 1, failed: 0, unsupported: 0, notRecorded: 1 },
      retrieval: { state: 'available', used: 5, notUsed: 1, unknown: 1, notApplicable: 0, notRecorded: 1 },
      population: { state: 'available', expectedQuestions: 4, answeredQuestions: 4, missingQuestions: 0 },
      comparison: { state: 'unavailable', reason: 'no_previous_run' },
    })
    expect(response.run.measurementScope).toBe('full')

    expect(measurementDataQualityResponseSchema.safeParse({
      ...response,
      capture: { state: 'unavailable', reason: 'no_completed_run', complete: 0 },
    }).success).toBe(false)
  })

  it('places the whole weakest tie by metro and counts its names written instead against a total', () => {
    const tie = {
      ...SUMMARY.tiedAtWeakest,
      byMetro: [{ metro: 'Harbor Metro', count: 2 }, { metro: null, count: 1 }],
      namedInstead: [{ name: 'Harborline Homes', answers: 3 }],
      namedInsteadTotal: 4,
    }
    expect(measurementPortfolioSummaryResponseSchema.parse({ ...SUMMARY, tiedAtWeakest: tie }).tiedAtWeakest).toEqual(tie)
    // Absent on servers that predate the roll-ups.
    expect(measurementPortfolioSummaryResponseSchema.safeParse(SUMMARY).success).toBe(true)
    expect(measurementPortfolioSummaryResponseSchema.safeParse({ ...SUMMARY, tiedAtWeakest: { ...tie, namedInsteadTotal: 0 } }).success).toBe(false)
    expect(measurementPortfolioSummaryResponseSchema.safeParse({ ...SUMMARY, tiedAtWeakest: { ...tie, namedInsteadTotal: undefined } }).success).toBe(false)
    expect(measurementPortfolioSummaryResponseSchema.safeParse({ ...SUMMARY, tiedAtWeakest: { ...tie, byMetro: [{ metro: 'Harbor Metro', count: 0 }] } }).success).toBe(false)
  })

  it('bounds a Property\'s own cited domains by the answers they were counted over', () => {
    const response = {
      property: PROPERTY,
      measurement: MEASUREMENT,
      queryClass: 'non-brand' as const,
      basis: { state: 'available' as const, answeredResults: 4, targetMissResults: 3, recommendationOccurrences: 0 },
      competitors: [],
      total: 0,
      truncated: false,
    }
    const cited = { citedDomains: [{ domain: 'listings.example', answers: 4 }], citedDomainsTotal: 2, citedDomainsAnswers: 4 }
    expect(measurementPropertyCompetitorsResponseSchema.parse({ ...response, ...cited })).toMatchObject(cited)
    expect(measurementPropertyCompetitorsResponseSchema.safeParse(response).success).toBe(true)
    expect(measurementPropertyCompetitorsResponseSchema.safeParse({ ...response, ...cited, citedDomainsAnswers: 3 }).success).toBe(false)
    expect(measurementPropertyCompetitorsResponseSchema.safeParse({ ...response, ...cited, citedDomainsTotal: 0 }).success).toBe(false)
    expect(measurementPropertyCompetitorsResponseSchema.safeParse({ ...response, citedDomains: cited.citedDomains }).success).toBe(false)
  })

  it('orders changes by magnitude unless asked for labels, and splits every Property into one move bucket', () => {
    expect(MEASUREMENT_CHANGES_DEFAULT_SORT).toBe('magnitude')
    expect(MEASUREMENT_CHANGES_NOISE_ANSWERS).toBe(2)
    expect(measurementChangesQuerySchema.parse({ sort: 'label' })).toEqual({ scope: 'all', queryClass: 'all', sort: 'label' })
    expect(measurementChangesQuerySchema.safeParse({ sort: 'size' }).success).toBe(false)

    const delta = { state: 'available' as const, previous: METRIC, current: METRIC, delta: 0 }
    const metrics = { propertiesMentioned: delta, mentionCoverage: delta, citationCoverage: delta }
    const distribution = { improved: 1, declined: 0, mixed: 0, withinNoise: 1, unchanged: 3, notComparable: 0, total: 5, noiseAnswers: 2 }
    const response = {
      current: { ...MEASUREMENT, executionIdentity: 'identity-cedar-a', measurementScope: 'full' as const },
      queryClass: 'all' as const,
      comparison: {
        state: 'available' as const,
        previous: {
          displayedRunId: 'run-cedar-00', planRevision: 2,
          completedAt: '2026-08-01T12:00:00.000Z', executionIdentity: 'identity-cedar-a',
          measurementScope: 'full' as const,
        },
        metrics,
        metricsByClass: { branded: metrics, nonBrand: metrics },
        sort: 'magnitude' as const,
        distribution,
        changedProperties: [{
          ...PROPERTY, mentionCoverage: delta, citationCoverage: delta, flags: 0,
          mentionAnswersDelta: 3, citationAnswersDelta: null, withinNoise: false,
        }],
        totalProperties: 2,
        truncated: true,
      },
    }
    expect(measurementChangesResponseSchema.parse(response)).toMatchObject({ queryClass: 'all', comparison: { distribution } })
    const withDistribution = (changed: Partial<typeof distribution>) =>
      measurementChangesResponseSchema.safeParse({ ...response, comparison: { ...response.comparison, distribution: { ...distribution, ...changed } } }).success
    // The buckets must account for every Property, and the changed ones must match the rows' total.
    expect(withDistribution({ total: 6 })).toBe(false)
    expect(withDistribution({ unchanged: 2, mixed: 1 })).toBe(false)
    expect(withDistribution({ noiseAnswers: 3 } as never)).toBe(false)
    expect(measurementChangesResponseSchema.safeParse({
      ...response, comparison: { ...response.comparison, metricsByClass: { branded: metrics } },
    }).success).toBe(false)
  })

  it('reports unattributed answers per class and the newest fill beside the completeness counts', () => {
    const base = {
      run: { ...MEASUREMENT, executionIdentity: 'identity-cedar-a', measurementScope: 'full' as const },
      completeness: { state: 'available' as const, expected: 8, executed: 8, answered: 8, missing: 0 },
      capture: { state: 'available' as const, complete: 8, partial: 0, failed: 0, unsupported: 0, notRecorded: 0 },
      retrieval: { state: 'available' as const, used: 8, notUsed: 0, unknown: 0, notApplicable: 0, notRecorded: 0 },
      population: { state: 'available' as const, expectedQuestions: 4, answeredQuestions: 4, missingQuestions: 0 },
      comparison: { state: 'unavailable' as const, reason: 'no_previous_run' as const },
    }
    const extra = {
      unattributedByClass: {
        branded: { state: 'available' as const, answered: 4, unattributed: 1 },
        nonBrand: { state: 'unavailable' as const, reason: 'no_population' as const },
      },
      latestFill: { status: 'completed' as const, providers: ['gemini'], expected: 2, filled: 2, createdAt: '2026-08-02T12:30:00.000Z', finishedAt: '2026-08-02T12:35:00.000Z' },
    }
    expect(measurementDataQualityResponseSchema.parse({ ...base, ...extra })).toMatchObject(extra)
    expect(measurementDataQualityResponseSchema.safeParse({ ...base, ...extra, latestFill: null }).success).toBe(true)
    expect(measurementDataQualityResponseSchema.safeParse({
      ...base, ...extra, unattributedByClass: { ...extra.unattributedByClass, branded: { state: 'available', answered: 1, unattributed: 2 } },
    }).success).toBe(false)
    expect(measurementDataQualityResponseSchema.safeParse({ ...base, ...extra, latestFill: { ...extra.latestFill, status: 'done' } }).success).toBe(false)
  })
})
