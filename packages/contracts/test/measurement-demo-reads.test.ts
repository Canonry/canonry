import { describe, expect, it } from 'vitest'
import {
  measurementChangesQuerySchema,
  measurementChangesResponseSchema,
  measurementDataQualityQuerySchema,
  measurementDataQualityResponseSchema,
  measurementPortfolioMentionRankingSchema,
  measurementPortfolioSummaryQuerySchema,
  measurementPortfolioSummaryResponseSchema,
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

describe('advanced measurement demo reads', () => {
  it('parses a bounded portfolio summary and defaults its comparison basket to non-brand', () => {
    expect(measurementPortfolioSummaryQuerySchema.parse({})).toEqual({ queryClass: 'non-brand' })
    expect(measurementPortfolioSummaryQuerySchema.safeParse({ limit: 51 }).success).toBe(false)
    expect(measurementPortfolioSummaryQuerySchema.parse({ queryClass: 'all' })).toEqual({ queryClass: 'all' })

    expect(measurementPortfolioSummaryResponseSchema.parse({
      portfolio: { groupKey: 'harbor-district', label: 'Harbor District', measurementScope: 'full' },
      measurement: MEASUREMENT,
      queryClass: 'non-brand',
      metrics: {
        propertiesMentioned: METRIC,
        mentionCoverage: METRIC,
        citationCoverage: METRIC,
      },
      mentionRanking: { eligiblePropertyCount: 1, strongest: [{ ...PROPERTY, mentionCoverage: METRIC, citationCoverage: METRIC }], weakest: [{ ...PROPERTY, mentionCoverage: METRIC, citationCoverage: METRIC }], excluded: [], truncated: false },
      weakestProperties: [{
        ...PROPERTY,
        mentionCoverage: METRIC,
        citationCoverage: { state: 'unavailable', reason: 'evidence_incomplete' },
        flags: 1,
        recommendedInstead: [{ name: 'Harborline Homes', occurrences: 2 }],
        recommendedInsteadTotal: 1,
        recommendedInsteadTruncated: false,
      }],
      markets: [{
        groupKey: 'harbor-district',
        label: 'Harbor District',
        propertyCount: 3,
        propertiesMentioned: METRIC,
        mentionCoverage: METRIC,
        citationCoverage: METRIC,
      }],
      totalProperties: 1,
      truncated: false,
    })).toMatchObject({ measurement: { displayedRunId: 'run-cedar-01' } })

    expect(measurementPortfolioSummaryResponseSchema.safeParse({
      portfolio: { groupKey: null, label: null, measurementScope: null },
      measurement: MEASUREMENT,
      queryClass: 'non-brand',
      metrics: { propertiesMentioned: METRIC, mentionCoverage: METRIC, citationCoverage: METRIC },
      weakestProperties: [], markets: [], totalProperties: 0, truncated: false, extra: true,
    }).success).toBe(false)
  })

  it('refuses to present an ambiguous mention as a ranked Property even when its citations are known', () => {
    const uncertain = { ...PROPERTY, mentionCoverage: { state: 'unavailable', reason: 'identity_ambiguous' }, citationCoverage: METRIC }
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
})
