import { describe, expect, it } from 'vitest'
import { evaluateSentimentCorpus } from '../src/evaluation.js'
import type { SentimentEvaluationExample } from '../src/evaluation.js'
import { createHash } from 'node:crypto'

function example(id: string, expected: 'favorable' | 'mixed' | 'unfavorable', predicted: 'favorable' | 'mixed' | 'unfavorable' | 'ambiguous-judgment'): SentimentEvaluationExample {
  const sourceText = 'Synthetic development statement.'
  return { id, sample: 'representative', queryClass: 'branded', industry: 'housing', provider: 'stub', language: 'en', propertyId: id, queryFamilyId: id, sweepId: id,
    sourceText, sourceHash: createHash('sha256').update(sourceText).digest('hex'),
    reviewers: [{ id: 'reviewer-a', labelHash: 'a', blinded: true }, { id: 'reviewer-b', labelHash: 'b', blinded: true }],
    adjudication: { reviewerId: 'adjudicator', correctSubject: true, judgeable: true, outcome: expected },
    prediction: { outcome: predicted, evidence: [{ id: 's1', text: sourceText, start: 0, end: sourceText.length }], evidenceSupported: true } }
}
describe('offline independent evaluation gates', () => {
  it('does not manufacture passing quality results without a reviewed held-out corpus', () => {
    const report = evaluateSentimentCorpus([], { evaluatorDefinitionId: 'frozen-definition', developmentGroups: [] })
    expect(report.releaseEligible).toBe(false)
    expect(report.blockers).toContain('branded: representative sample requires at least 150 independently reviewed answers.')
    expect(report.populations.branded.representative.metrics.coverage.value).toBeNull()
  })
  it('keeps abstentions in coverage and false-negative stance counts', () => {
    const report = evaluateSentimentCorpus([example('one', 'favorable', 'favorable'), example('two', 'favorable', 'ambiguous-judgment'), example('three', 'unfavorable', 'favorable')], { evaluatorDefinitionId: 'frozen', developmentGroups: [] })
    expect(report.populations.branded.representative.metrics.coverage).toMatchObject({ numerator: 2, denominator: 3, value: 2 / 3 })
    expect(report.populations.branded.representative.metrics.favorablePrecision).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 })
    expect(report.populations.branded.representative.stances.favorable).toMatchObject({ truePositive: 1, falseNegative: 1, falsePositive: 1 })
    expect(report.populations.branded.representative.abstentionsByStance.favorable).toBe(1)
  })
  it('detects changed source hashes, invalid quotes, reused development groups, and unblinded reviewers', () => {
    const row = example('one', 'favorable', 'favorable')
    row.sourceHash = 'changed'; row.prediction.evidence[0].text = 'fabricated'; row.reviewers[0].blinded = false
    const report = evaluateSentimentCorpus([row], { evaluatorDefinitionId: 'frozen', developmentGroups: ['property:one'] })
    expect(report.releaseEligible).toBe(false)
    expect(report.blockers.join(' ')).toContain('source hash')
    expect(report.blockers.join(' ')).toContain('development')
    expect(report.blockers.join(' ')).toContain('blinded')
    expect(report.populations.branded.representative.metrics.quotationIntegrity.value).toBe(0)
  })
  it('separates challenge cases and fails sparse industry/provider/language slices', () => {
    const challenge = example('challenge', 'mixed', 'mixed'); challenge.sample = 'challenge'
    const report = evaluateSentimentCorpus([example('one', 'favorable', 'favorable'), challenge], { evaluatorDefinitionId: 'frozen', developmentGroups: [] })
    expect(report.populations.branded.representative.count).toBe(1)
    expect(report.populations.branded.challenge.count).toBe(1)
    expect(report.populations.branded.slices.every(slice => !slice.releaseEligible)).toBe(true)
  })
})


describe('stance-only, separately scoped release gates', () => {
  it('never pools branded and non-brand favorable share or coverage', () => {
    const branded = example('branded', 'favorable', 'favorable')
    const nonBrand = example('non-brand', 'unfavorable', 'unfavorable'); nonBrand.queryClass = 'non-brand'
    const report = evaluateSentimentCorpus([branded, nonBrand], { evaluatorDefinitionId: 'frozen-v2', developmentGroups: [] })
    expect(report).not.toHaveProperty('representative')
    expect(report.populations.branded.representative.metrics.favorableShareError.measuredShare).toMatchObject({ numerator: 1, denominator: 1, value: 1 })
    expect(report.populations['non-brand'].representative.metrics.favorableShareError.measuredShare).toMatchObject({ numerator: 0, denominator: 1, value: 0 })
    expect(report.populations.branded.slices.every(slice => slice.queryClass === 'branded')).toBe(true)
    expect(report.populations['non-brand'].slices.every(slice => slice.queryClass === 'non-brand')).toBe(true)
  })
  it('does not require deferred theme labels in the active gate math', () => {
    // Synthetic unit data exercises thresholds; it is never a held-out quality artifact.
    const stances = ['favorable', 'mixed', 'unfavorable'] as const
    const rows = (['branded', 'non-brand'] as const).flatMap(queryClass => Array.from({ length: 150 }, (_, index) => {
      const row = example(`${queryClass}-${index}`, stances[index % 3], stances[index % 3])
      return { ...row, queryClass, industry: index % 2 ? 'housing' : 'services' }
    }))
    const report = evaluateSentimentCorpus(rows, { evaluatorDefinitionId: 'synthetic-unit-definition', developmentGroups: [] })
    expect(report.releaseEligible).toBe(true)
    expect(report.scope).toBe('stance-and-evidence-only')
    expect(report.deferredCapabilities).toEqual(['themes'])
    for (const population of Object.values(report.populations)) {
      expect(population.gates).not.toHaveProperty('complaintPrecision')
      expect(population.gates).not.toHaveProperty('complaintRecall')
      expect(population.representative.metrics).not.toHaveProperty('complaintPrecision')
    }
    expect(evaluateSentimentCorpus(rows.filter(row => row.queryClass === 'branded'), { evaluatorDefinitionId: 'synthetic-unit-definition', developmentGroups: [] }).releaseEligible).toBe(false)
  })
  it('keeps a known absent subject out of judged denominators and penalizes a fabricated unfavorable stance', () => {
    const absent = example('absent', 'unfavorable', 'unfavorable')
    absent.queryClass = 'non-brand'
    absent.adjudication = { reviewerId: 'adjudicator', correctSubject: false, judgeable: false, outcome: 'subject-not-mentioned' }
    absent.prediction = { outcome: 'subject-not-mentioned', evidence: [], evidenceSupported: null }
    const correct = evaluateSentimentCorpus([absent], { evaluatorDefinitionId: 'frozen-v2', developmentGroups: [] }).populations['non-brand'].representative
    expect(correct.metrics.favorableShareError.measuredShare.denominator).toBe(0)
    expect(correct.excludedFromShare).toBe(1)
    absent.prediction = { ...example('prediction', 'unfavorable', 'unfavorable').prediction }
    const wrong = evaluateSentimentCorpus([absent], { evaluatorDefinitionId: 'frozen-v2', developmentGroups: [] }).populations['non-brand'].representative
    expect(wrong.stances.unfavorable.falsePositive).toBe(1)
    expect(wrong.metrics.correctSubjectPrecision).toMatchObject({ numerator: 0, denominator: 1, value: 0 })
  })
  it('requires explicit population provenance and conclusion evidence for a claimed stance', () => {
    const row = example('missing', 'favorable', 'favorable')
    Reflect.deleteProperty(row, 'queryClass'); row.prediction.evidence = []
    const report = evaluateSentimentCorpus([row], { evaluatorDefinitionId: 'frozen-v2', developmentGroups: [] })
    expect(report.releaseEligible).toBe(false)
    expect(report.blockers.join(' ')).toContain('explicit branded or non-brand query class')
    expect(report.blockers.join(' ')).toContain('requires conclusion evidence')
  })
})
