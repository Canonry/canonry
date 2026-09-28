import { describe, expect, it } from 'vitest'
import { sentimentFixtureSummary, sentimentCompleteFixtureSummary } from './fixtures/sentiment.js'
import { sentimentSummarySchema } from '../src/sentiment.js'
import { aggregateSentiment, canonicalSentimentDefinitionJson, createSentimentEvaluationDefinition, sentimentClassifierOutputSchema, sentimentRateDisplay, sentimentSettingsUpdateSchema, storedSentimentEvaluationDefinitionSchema, storedSentimentClassifierOutputSchema, type SentimentAggregateItem, type SentimentOutcome } from '../src/sentiment.js'

const outcomes: SentimentOutcome[] = ['favorable', 'favorable', 'favorable', 'mixed', 'unfavorable', 'factual', 'wrong-subject', 'invalid-conclusion-evidence', 'failed', 'pending']
const canonical: SentimentAggregateItem[] = outcomes.map((outcome, index) => ({ assessmentId: `a${index}`, sourceSnapshotId: `s${index}`, outcome }))

describe('sentiment measurement invariants', () => {
  it('shares strict partial and complete DTO fixtures across every surface', () => {
    expect(sentimentSummarySchema.parse(sentimentFixtureSummary)).toEqual(sentimentFixtureSummary)
    expect(sentimentSummarySchema.parse(sentimentCompleteFixtureSummary).state).toBe('complete')
    for (const state of ['disabled', 'not-measured', 'processing', 'partial', 'complete', 'failed', 'canceled', 'unsupported'] as const) {
      expect(sentimentSummarySchema.safeParse({ ...sentimentFixtureSummary, state }).success).toBe(true)
    }
  })
  it('counts five judgments out of ten assessments with no mixed favorable credit', () => {
    const result = aggregateSentiment(canonical)
    expect(result.coverage).toMatchObject({ selected: 10, judged: 5, distinctSourceAnswers: 10 })
    expect(Object.values(result.coverage.counts).reduce((a, b) => a + b, 0)).toBe(10)
    expect(result.score).toMatchObject({ favorableRate: 0.6, mixedRate: 0.2, unfavorableRate: 0.2, favorableDisplay: '60%', mixedDisplay: '20%', unfavorableDisplay: '20%', interval: { low: 0.2307, high: 0.8824 } })
    expect(result.state).toBe('partial')
    expect(result.provisional).toBe(true)
  })
  it('discloses eligible assessments that have not been admitted without calling them pending', () => {
    const result = aggregateSentiment([canonical[0]!], { eligibleAssessments: 3 })
    expect(result.coverage).toMatchObject({ selected: 1, eligibleAssessments: 3, unadmittedAssessments: 2, judged: 1, counts: { pending: 0 } })
  })
  it('deduplicates usage edges, preserving two subjects for one source answer', () => {
    const items = [{ ...canonical[0]!, sourceSnapshotId: 'shared' }, { ...canonical[4]!, sourceSnapshotId: 'shared' }]
    expect(aggregateSentiment([...items, items[0]!]).coverage).toMatchObject({ selected: 2, judged: 2, distinctSourceAnswers: 1 })
    expect(aggregateSentiment(items).score.favorableRate).toBe(0.5)
  })
  it('does not fabricate zero when no judgments or when disabled', () => {
    for (const items of [[], [canonical[5]!]]) expect(aggregateSentiment(items).score).toMatchObject({ favorableRate: null, mixedRate: null, unfavorableRate: null, interval: null, favorableDisplay: 'Unavailable' })
    expect(aggregateSentiment(canonical, { disabled: true })).toMatchObject({ state: 'disabled', score: { favorableRate: null, interval: null } })
  })
  it('keeps absent subjects and canceled work outside the judged denominator', () => {
    expect(aggregateSentiment([{ ...canonical[0]!, outcome: 'canceled' }])).toMatchObject({ state: 'canceled', coverage: { selected: 1, judged: 0, counts: { canceled: 1 } } })
    const result = aggregateSentiment([{ ...canonical[0]!, outcome: 'subject-not-mentioned' }, canonical[1]!])
    expect(result.coverage).toMatchObject({ selected: 2, judged: 1, counts: { 'subject-not-mentioned': 1, unfavorable: 0 } })
    expect(result.score.favorableRate).toBe(1)
  })
  it('pins the stance-only evaluator identity independently of answer text', () => {
    const definition = createSentimentEvaluationDefinition()
    const json = canonicalSentimentDefinitionJson(definition)
    expect(definition).toMatchObject({ schemaVersion: 2, verdictVersion: 'stance-v2', identityVersion: 'qualified-subject-v2' })
    expect(Object.keys(definition.questions)).toEqual(['identity', 'judgment', 'stance', 'conclusion', 'complaint'])
    expect(canonicalSentimentDefinitionJson({ ...definition, confidenceThreshold: 0.8 })).not.toBe(json)
    expect(json).not.toContain('sourceTextHash')
    expect(json).not.toContain('themes')
  })
  it('projects archived definitions and results without rewriting their immutable version or JSON', () => {
    const old = { ...createSentimentEvaluationDefinition(), schemaVersion: 1, verdictVersion: 'stance-v1', identityVersion: 'qualified-subject-v1', themes: [{ id: 'old-theme' }], questions: { ...createSentimentEvaluationDefinition().questions, theme: 'Old frozen theme question' } }
    const before = JSON.stringify(old)
    expect(storedSentimentEvaluationDefinitionSchema.parse(old)).toMatchObject({ schemaVersion: 1, verdictVersion: 'stance-v1', identityVersion: 'qualified-subject-v1' })
    expect(storedSentimentEvaluationDefinitionSchema.parse(old)).not.toHaveProperty('themes')
    expect(JSON.stringify(old)).toBe(before)
    const result = { kind: 'abstained', outcome: 'factual', reason: 'No judgment', themes: [], returnedModel: null, usage: { kind: 'unknown', inputTokens: null, outputTokens: null } }
    expect(storedSentimentClassifierOutputSchema.parse(result)).not.toHaveProperty('themes')
    expect(sentimentClassifierOutputSchema.safeParse(result).success).toBe(false)
  })
  it('rejects retired theme configuration at the active contract boundary', () => {
    expect(sentimentSettingsUpdateSchema.parse({ enabled: true })).toEqual({ enabled: true })
    expect(sentimentSettingsUpdateSchema.safeParse({ enabled: true, preset: 'general' }).success).toBe(false)
    expect(sentimentSettingsUpdateSchema.safeParse({ customThemes: [] }).success).toBe(false)
  })
  it('displays zero, full, small and rounded proportions honestly', () => {
    expect([null, 0, 1, 0.001, 0.0049, 0.01, 0.599].map(sentimentRateDisplay)).toEqual(['Unavailable', '0%', '100%', '<1%', '<1%', '1%', '60%'])
  })
  it('rejects a judged classifier output without conclusion evidence', () => {
    expect(sentimentClassifierOutputSchema.safeParse({ kind: 'classified', outcome: 'favorable', conclusion: [], complaint: null, returnedModel: 'jev-1.13.0', usage: { kind: 'reported', inputTokens: 10, outputTokens: 0 }, confidence: null }).success).toBe(false)
  })
})
