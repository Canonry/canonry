import { describe, expect, it } from 'vitest'
import { sentimentFixtureSummary, sentimentCompleteFixtureSummary } from './fixtures/sentiment.js'
import { sentimentSummarySchema } from '../src/sentiment.js'
import { aggregateSentiment, canonicalSentimentDefinitionJson, createSentimentEvaluationDefinition, sentimentClassifierOutputSchema, sentimentPresetThemes, sentimentRateDisplay, sentimentThemesSchema, type SentimentAggregateItem, type SentimentOutcome, type SentimentThemeResult } from '../src/sentiment.js'

const outcomes: SentimentOutcome[] = ['favorable', 'favorable', 'favorable', 'mixed', 'unfavorable', 'factual', 'wrong-subject', 'invalid-conclusion-evidence', 'failed', 'pending']
const price = sentimentPresetThemes()[2]!
function themeResult(praised: boolean, criticized: boolean): SentimentThemeResult {
  return { themeId: price.id, discussed: true, praised, criticized, evidence: { discussed: [], praised: [], criticized: [] }, reason: null }
}
const canonical: SentimentAggregateItem[] = outcomes.map((outcome, index) => ({ assessmentId: `a${index}`, sourceSnapshotId: `s${index}`, outcome, themes: index < 3 ? [themeResult(index < 2, true)] : [] }))

describe('sentiment measurement invariants', () => {
  it('shares strict partial and complete DTO fixtures across every surface', () => {
    expect(sentimentSummarySchema.parse(sentimentFixtureSummary)).toEqual(sentimentFixtureSummary)
    expect(sentimentSummarySchema.parse(sentimentCompleteFixtureSummary).state).toBe('complete')
    for (const state of ['disabled', 'not-measured', 'processing', 'partial', 'complete', 'failed', 'canceled', 'unsupported'] as const) {
      expect(sentimentSummarySchema.safeParse({ ...sentimentFixtureSummary, state }).success).toBe(true)
    }
  })
  it('counts five judgments out of ten assessments with no mixed favorable credit', () => {
    const result = aggregateSentiment(canonical, [price])
    expect(result.coverage).toMatchObject({ selected: 10, judged: 5, distinctSourceAnswers: 10 })
    expect(Object.values(result.coverage.counts).reduce((a, b) => a + b, 0)).toBe(10)
    expect(result.score).toMatchObject({ favorableRate: 0.6, mixedRate: 0.2, unfavorableRate: 0.2, favorableDisplay: '60%', mixedDisplay: '20%', unfavorableDisplay: '20%', interval: { low: 0.2307, high: 0.8824 } })
    expect(result.state).toBe('partial')
    expect(result.provisional).toBe(true)
    expect(result.themes[0]).toMatchObject({ discussed: 3, praised: 2, criticized: 3, both: 2, unclassified: 7 })
  })
  it('discloses eligible assessments that have not been admitted without calling them pending', () => {
    const result = aggregateSentiment([canonical[0]!], [], { eligibleAssessments: 3 })
    expect(result.coverage).toMatchObject({ selected: 1, eligibleAssessments: 3, unadmittedAssessments: 2, judged: 1, counts: { pending: 0 } })
  })
  it('deduplicates usage edges, preserving two subjects for one source answer', () => {
    const items = [{ ...canonical[0]!, sourceSnapshotId: 'shared' }, { ...canonical[4]!, sourceSnapshotId: 'shared' }]
    expect(aggregateSentiment([...items, items[0]!]).coverage).toMatchObject({ selected: 2, judged: 2, distinctSourceAnswers: 1 })
    expect(aggregateSentiment(items).score.favorableRate).toBe(0.5)
  })
  it('does not fabricate zero when no judgments or when disabled', () => {
    for (const items of [[], [canonical[5]!]]) expect(aggregateSentiment(items).score).toMatchObject({ favorableRate: null, mixedRate: null, unfavorableRate: null, interval: null, favorableDisplay: 'Unavailable' })
    expect(aggregateSentiment(canonical, [], { disabled: true })).toMatchObject({ state: 'disabled', score: { favorableRate: null, interval: null } })
  })
  it('keeps canceled work in the state partition and factual theme discussion independent', () => {
    expect(aggregateSentiment([{ ...canonical[0]!, outcome: 'canceled' }])).toMatchObject({ state: 'canceled', coverage: { selected: 1, judged: 0, counts: { canceled: 1 } } })
    expect(aggregateSentiment([{ ...canonical[0]!, outcome: 'factual', themes: [themeResult(false, false)] }], [price]).themes[0]).toMatchObject({ discussed: 1, praised: 0, criticized: 0, both: 0, unclassified: 0 })
  })
  it('treats contradictory theme flags as unclassified', () => {
    expect(aggregateSentiment([{ ...canonical[0]!, themes: [{ ...themeResult(true, false), discussed: false }] }], [price]).themes[0]).toMatchObject({ discussed: 0, praised: 0, criticized: 0, both: 0, unclassified: 1 })
  })
  it('keeps reusable evaluation identity independent from new answer text', () => {
    const definition = createSentimentEvaluationDefinition()
    const json = canonicalSentimentDefinitionJson(definition)
    expect(canonicalSentimentDefinitionJson({ ...definition, themes: [...definition.themes] })).toBe(json)
    expect(canonicalSentimentDefinitionJson({ ...definition, themes: definition.themes.map((theme, i) => i ? theme : { ...theme, description: 'A different criterion' }) })).not.toBe(json)
    expect(json).not.toContain('sourceTextHash')
  })
  it('requires unique normalized theme names and rejects unevaluated custom quality claims', () => {
    expect(sentimentThemesSchema.safeParse([price, { ...price, id: 'other', name: ' PRICE AND VALUE ' }]).success).toBe(false)
    expect(sentimentThemesSchema.safeParse([{ ...price, source: 'custom', evaluationStatus: 'evaluated' }]).success).toBe(false)
    expect(sentimentThemesSchema.safeParse(Array.from({ length: 25 }, (_, i) => ({ ...price, id: `${i}`, name: `${i}` }))).success).toBe(false)
  })
  it('displays zero, full, small and rounded proportions honestly', () => {
    expect([null, 0, 1, 0.001, 0.0049, 0.01, 0.599].map(sentimentRateDisplay)).toEqual(['Unavailable', '0%', '100%', '<1%', '<1%', '1%', '60%'])
  })
  it('rejects a judged classifier output without conclusion evidence', () => {
    expect(sentimentClassifierOutputSchema.safeParse({ kind: 'classified', outcome: 'favorable', conclusion: [], complaint: null, themes: [], returnedModel: 'jev-1.13.0', usage: { kind: 'reported', inputTokens: 10, outputTokens: 0 }, confidence: null }).success).toBe(false)
  })
})
