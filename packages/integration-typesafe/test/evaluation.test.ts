import { describe, expect, it } from 'vitest'
import { evaluateSentimentCorpus } from '../src/evaluation.js'
import type { SentimentEvaluationExample } from '../src/evaluation.js'
import { createHash } from 'node:crypto'

function example(id: string, expected: 'favorable' | 'mixed' | 'unfavorable', predicted: 'favorable' | 'mixed' | 'unfavorable' | 'ambiguous-judgment'): SentimentEvaluationExample {
  const sourceText = 'Synthetic development statement.'
  return { id, sample: 'representative', industry: 'housing', provider: 'stub', language: 'en', propertyId: id, queryFamilyId: id, sweepId: id,
    sourceText, sourceHash: createHash('sha256').update(sourceText).digest('hex'),
    reviewers: [{ id: 'reviewer-a', labelHash: 'a', blinded: true }, { id: 'reviewer-b', labelHash: 'b', blinded: true }],
    adjudication: { reviewerId: 'adjudicator', correctSubject: true, judgeable: true, outcome: expected, complaints: { price: expected === 'unfavorable' } },
    prediction: { outcome: predicted, evidence: [{ id: 's1', text: sourceText, start: 0, end: sourceText.length }], evidenceSupported: true, complaints: { price: predicted === 'unfavorable' } } }
}
describe('offline independent evaluation gates', () => {
  it('does not manufacture passing quality results without a reviewed held-out corpus', () => {
    const report = evaluateSentimentCorpus([], { evaluatorDefinitionId: 'frozen-definition', developmentGroups: [] })
    expect(report.releaseEligible).toBe(false)
    expect(report.blockers).toContain('Representative sample requires at least 150 independently reviewed answers.')
    expect(report.representative.metrics.coverage.value).toBeNull()
  })
  it('keeps abstentions in coverage and false-negative stance counts', () => {
    const report = evaluateSentimentCorpus([example('one', 'favorable', 'favorable'), example('two', 'favorable', 'ambiguous-judgment'), example('three', 'unfavorable', 'favorable')], { evaluatorDefinitionId: 'frozen', developmentGroups: [] })
    expect(report.representative.metrics.coverage).toMatchObject({ numerator: 2, denominator: 3, value: 2 / 3 })
    expect(report.representative.metrics.favorablePrecision).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 })
    expect(report.representative.stances.favorable).toMatchObject({ truePositive: 1, falseNegative: 1, falsePositive: 1 })
    expect(report.representative.abstentionsByStance.favorable).toBe(1)
    expect(report.representative.metrics.complaintRecall).toMatchObject({ numerator: 0, denominator: 1, value: 0 })
  })
  it('detects changed source hashes, invalid quotes, reused development groups, and unblinded reviewers', () => {
    const row = example('one', 'favorable', 'favorable')
    row.sourceHash = 'changed'; row.prediction.evidence[0].text = 'fabricated'; row.reviewers[0].blinded = false
    const report = evaluateSentimentCorpus([row], { evaluatorDefinitionId: 'frozen', developmentGroups: ['property:one'] })
    expect(report.releaseEligible).toBe(false)
    expect(report.blockers.join(' ')).toContain('source hash')
    expect(report.blockers.join(' ')).toContain('development')
    expect(report.blockers.join(' ')).toContain('blinded')
    expect(report.representative.metrics.quotationIntegrity.value).toBe(0)
  })
  it('separates challenge cases and fails sparse industry/provider/language slices', () => {
    const challenge = example('challenge', 'mixed', 'mixed'); challenge.sample = 'challenge'
    const report = evaluateSentimentCorpus([example('one', 'favorable', 'favorable'), challenge], { evaluatorDefinitionId: 'frozen', developmentGroups: [] })
    expect(report.representative.count).toBe(1)
    expect(report.challenge.count).toBe(1)
    expect(report.slices.every(slice => !slice.releaseEligible)).toBe(true)
  })
})
