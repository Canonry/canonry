import { describe, expect, it } from 'vitest'
import { canonicalSentimentJson, createSentimentEvaluationDefinition } from '@ainyc/canonry-contracts'
import { evaluateSentimentCorpus, frozenSentimentEvaluationDefinitionId } from '../src/evaluation.js'
import type { SentimentEvaluationExample } from '../src/evaluation.js'
import { createHash } from 'node:crypto'

const FROZEN = frozenSentimentEvaluationDefinitionId()
function example(id: string, expected: 'favorable' | 'mixed' | 'unfavorable', predicted: 'favorable' | 'mixed' | 'unfavorable' | 'ambiguous-judgment'): SentimentEvaluationExample {
  const sourceText = 'Synthetic development statement.'
  return { id, sample: 'representative', queryClass: 'branded', industry: 'housing', provider: 'stub', language: 'en', propertyId: id, queryFamilyId: id, sweepId: id,
    sourceText, sourceHash: createHash('sha256').update(sourceText).digest('hex'),
    reviewers: [{ id: 'reviewer-a', labelHash: 'a', blinded: true }, { id: 'reviewer-b', labelHash: 'b', blinded: true }],
    adjudication: { reviewerId: 'adjudicator', correctSubject: true, judgeable: true, outcome: expected },
    prediction: { outcome: predicted, evidence: [{ id: 's1', text: sourceText, start: 0, end: sourceText.length }], evidenceSupported: true, evaluatorDefinitionId: FROZEN, returnedModel: 'jev-1.13.0' } }
}
/** Synthetic threshold data only: a corpus that clears every gate, so each test can break exactly one. */
function passingCorpus(options: { sameNamePredicted?: 'wrong-subject' | 'favorable'; provider?: (index: number) => string } = {}): SentimentEvaluationExample[] {
  const stances = ['favorable', 'mixed', 'unfavorable'] as const
  return (['branded', 'non-brand'] as const).flatMap(queryClass => [
    ...Array.from({ length: 150 }, (_, index) => {
      const row = example(`${queryClass}-${index}`, stances[index % 3], stances[index % 3])
      return { ...row, queryClass, industry: index % 2 ? 'housing' : 'services', provider: options.provider?.(index) ?? 'stub' }
    }),
    ...Array.from({ length: 25 }, (_, index): SentimentEvaluationExample => {
      const row = example(`${queryClass}-same-name-${index}`, 'favorable', 'favorable')
      const accepted = options.sameNamePredicted === 'favorable'
      return { ...row, queryClass, sample: 'challenge', challengeTags: ['same-name'], adjudication: { ...row.adjudication, correctSubject: false, judgeable: false, outcome: 'wrong-subject' },
        prediction: accepted ? row.prediction : { ...row.prediction, outcome: 'wrong-subject', evidence: [], evidenceSupported: null } }
    }),
    ...Array.from({ length: 25 }, (_, index): SentimentEvaluationExample => ({ ...example(`${queryClass}-caveat-${index}`, 'favorable', 'favorable'), queryClass, sample: 'challenge', challengeTags: ['caveated-favorable'] })),
  ])
}
describe('offline independent evaluation gates', () => {
  it('does not manufacture passing quality results without a reviewed held-out corpus', () => {
    const report = evaluateSentimentCorpus([], { evaluatorDefinitionId: FROZEN, developmentGroups: [] })
    expect(report.releaseEligible).toBe(false)
    expect(report.blockers).toContain('branded: representative sample requires at least 150 independently reviewed answers.')
    expect(report.populations.branded.representative.metrics.coverage.value).toBeNull()
  })
  it('keeps abstentions in coverage and false-negative stance counts', () => {
    const report = evaluateSentimentCorpus([example('one', 'favorable', 'favorable'), example('two', 'favorable', 'ambiguous-judgment'), example('three', 'unfavorable', 'favorable')], { evaluatorDefinitionId: FROZEN, developmentGroups: [] })
    expect(report.populations.branded.representative.metrics.coverage).toMatchObject({ numerator: 2, denominator: 3, value: 2 / 3 })
    expect(report.populations.branded.representative.metrics.favorablePrecision).toMatchObject({ numerator: 1, denominator: 2, value: 0.5 })
    expect(report.populations.branded.representative.stances.favorable).toMatchObject({ truePositive: 1, falseNegative: 1, falsePositive: 1 })
    expect(report.populations.branded.representative.abstentionsByStance.favorable).toBe(1)
  })
  it('detects changed source hashes, invalid quotes, reused development groups, and unblinded reviewers', () => {
    const row = example('one', 'favorable', 'favorable')
    row.sourceHash = 'changed'; row.prediction.evidence[0].text = 'fabricated'; row.reviewers[0].blinded = false
    const report = evaluateSentimentCorpus([row], { evaluatorDefinitionId: FROZEN, developmentGroups: ['property:one'] })
    expect(report.releaseEligible).toBe(false)
    expect(report.blockers.join(' ')).toContain('source hash')
    expect(report.blockers.join(' ')).toContain('development')
    expect(report.blockers.join(' ')).toContain('blinded')
    expect(report.populations.branded.representative.metrics.quotationIntegrity.value).toBe(0)
  })
  it('separates challenge cases and reports sparse industry/provider/language slices as not gated', () => {
    const challenge = example('challenge', 'mixed', 'mixed'); challenge.sample = 'challenge'
    const report = evaluateSentimentCorpus([example('one', 'favorable', 'favorable'), challenge], { evaluatorDefinitionId: FROZEN, developmentGroups: [] })
    expect(report.populations.branded.representative.count).toBe(1)
    expect(report.populations.branded.challenge.count).toBe(1)
    expect(report.populations.branded.slices.every(slice => !slice.gated && slice.releaseEligible === null)).toBe(true)
    expect(report.populations.branded.slices.find(slice => slice.sample === 'representative')?.limitation).toContain('not gated')
  })
})


describe('stance-only, separately scoped release gates', () => {
  it('never pools branded and non-brand favorable share or coverage', () => {
    const branded = example('branded', 'favorable', 'favorable')
    const nonBrand = example('non-brand', 'unfavorable', 'unfavorable'); nonBrand.queryClass = 'non-brand'
    const report = evaluateSentimentCorpus([branded, nonBrand], { evaluatorDefinitionId: FROZEN, developmentGroups: [] })
    expect(report).not.toHaveProperty('representative')
    expect(report.populations.branded.representative.metrics.favorableShareError.measuredShare).toMatchObject({ numerator: 1, denominator: 1, value: 1 })
    expect(report.populations['non-brand'].representative.metrics.favorableShareError.measuredShare).toMatchObject({ numerator: 0, denominator: 1, value: 0 })
    expect(report.populations.branded.slices.every(slice => slice.queryClass === 'branded')).toBe(true)
    expect(report.populations['non-brand'].slices.every(slice => slice.queryClass === 'non-brand')).toBe(true)
  })
  it('does not require deferred theme labels in the active gate math', () => {
    // Synthetic unit data exercises thresholds; it is never a held-out quality artifact.
    const rows = passingCorpus()
    const report = evaluateSentimentCorpus(rows, { evaluatorDefinitionId: FROZEN, developmentGroups: [] })
    expect(report.releaseEligible).toBe(true)
    expect(report.scope).toBe('stance-and-evidence-only')
    expect(report.deferredCapabilities).toEqual(['themes'])
    for (const population of Object.values(report.populations)) {
      expect(population.gates).not.toHaveProperty('complaintPrecision')
      expect(population.gates).not.toHaveProperty('complaintRecall')
      expect(population.representative.metrics).not.toHaveProperty('complaintPrecision')
    }
    expect(evaluateSentimentCorpus(rows.filter(row => row.queryClass === 'branded'), { evaluatorDefinitionId: FROZEN, developmentGroups: [] }).releaseEligible).toBe(false)
  })
  it('gates tagged challenge recall so accepting same-name subjects cannot pass on representative precision', () => {
    const accepted = evaluateSentimentCorpus(passingCorpus({ sameNamePredicted: 'favorable' }), { evaluatorDefinitionId: FROZEN, developmentGroups: [] })
    expect(accepted.populations.branded.gates.correctSubjectPrecision.passed).toBe(true)
    expect(accepted.populations.branded.challenge.gates['same-name']).toMatchObject({ passed: false, recall: { numerator: 0, denominator: 25 } })
    expect(accepted.populations.branded.releaseEligible).toBe(false)
    expect(accepted.releaseEligible).toBe(false)
    const missingTags = passingCorpus().map(row => row.challengeTags?.includes('caveated-favorable') ? { ...row, challengeTags: ['caveat'] } : row)
    const untagged = evaluateSentimentCorpus(missingTags, { evaluatorDefinitionId: FROZEN, developmentGroups: [] })
    expect(untagged.releaseEligible).toBe(false)
    expect(untagged.blockers).toContain('branded: at least 25 challenge examples tagged caveated-favorable with adjudicated outcome favorable are required.')
  })
  it('does not fail release on a naturally sparse slice but still gates sufficient slices', () => {
    // Four answers from one engine, one of them misread: too few to support any slice claim.
    const sparseRows = passingCorpus({ provider: index => index < 4 ? 'rare-engine' : 'stub' }).map(row => row.id === 'branded-1' ? { ...row, prediction: { ...row.prediction, outcome: 'favorable' as const } } : row)
    const sparse = evaluateSentimentCorpus(sparseRows, { evaluatorDefinitionId: FROZEN, developmentGroups: [] })
    const rare = sparse.populations.branded.slices.find(slice => slice.value === 'rare-engine' && slice.sample === 'representative')
    expect(rare).toMatchObject({ gated: false, releaseEligible: null, count: 4 })
    expect(rare?.gates.favorablePrecision.passed).toBe(false)
    expect(sparse.blockers).toEqual([])
    expect(sparse.releaseEligible).toBe(true)
    // A sufficient provider slice whose favorable precision fails still blocks the population.
    const rows = passingCorpus({ provider: index => index < 30 ? 'weak-engine' : 'stub' }).map(row => row.queryClass === 'branded' && row.provider === 'weak-engine' && row.adjudication.outcome === 'mixed' && Number(row.id.split('-').pop()) < 15
      ? { ...row, prediction: { ...row.prediction, outcome: 'favorable' as const } } : row)
    const weak = evaluateSentimentCorpus(rows, { evaluatorDefinitionId: FROZEN, developmentGroups: [] })
    expect(weak.populations.branded.gates.favorablePrecision.passed).toBe(true)
    expect(weak.populations.branded.slices.find(slice => slice.value === 'weak-engine' && slice.sample === 'representative')).toMatchObject({ gated: true, releaseEligible: false })
    expect(weak.releaseEligible).toBe(false)
  })
  it('accepts only the frozen definition hash and rows scored with it by the pinned model', () => {
    expect(FROZEN).toBe(createHash('sha256').update(canonicalSentimentJson(createSentimentEvaluationDefinition())).digest('hex'))
    const rows = passingCorpus()
    const other = evaluateSentimentCorpus(rows.map(row => ({ ...row, prediction: { ...row.prediction, evaluatorDefinitionId: 'pending-v2-independent-corpus-freeze' } })), { evaluatorDefinitionId: 'pending-v2-independent-corpus-freeze', developmentGroups: [] })
    expect(other.releaseEligible).toBe(false)
    expect(other.frozenEvaluatorDefinitionId).toBe(FROZEN)
    expect(other.blockers).toContain(`The evaluator definition ID must equal the frozen definition hash ${FROZEN}.`)
    const mixedRows = rows.map((row, index) => index === 0 ? { ...row, prediction: { ...row.prediction, evaluatorDefinitionId: 'older-definition' } } : index === 1 ? { ...row, prediction: { ...row.prediction, returnedModel: 'jev-2.0.0' } } : index === 2 ? { ...row, prediction: { ...row.prediction, returnedModel: null } } : row)
    const mixed = evaluateSentimentCorpus(mixedRows, { evaluatorDefinitionId: FROZEN, developmentGroups: [] })
    expect(mixed.releaseEligible).toBe(false)
    expect(mixed.blockers).toEqual([
      `Example ${rows[0].id} was not scored with the frozen evaluator definition.`,
      `Example ${rows[1].id} must record jev-1.13.0 as the model that returned its prediction.`,
      `Example ${rows[2].id} must record jev-1.13.0 as the model that returned its prediction.`,
    ])
    const preDispatch = rows.map((row, index) => index === 0 ? { ...row, adjudication: { ...row.adjudication, correctSubject: false, judgeable: false, outcome: 'subject-not-mentioned' as const }, prediction: { ...row.prediction, outcome: 'subject-not-mentioned' as const, evidence: [], evidenceSupported: null, returnedModel: null } } : row)
    expect(evaluateSentimentCorpus(preDispatch, { evaluatorDefinitionId: FROZEN, developmentGroups: [] }).blockers.filter(blocker => blocker.includes(rows[0].id))).toEqual([])
  })
  it('keeps a known absent subject out of judged denominators and penalizes a fabricated unfavorable stance', () => {
    const absent = example('absent', 'unfavorable', 'unfavorable')
    absent.queryClass = 'non-brand'
    absent.adjudication = { reviewerId: 'adjudicator', correctSubject: false, judgeable: false, outcome: 'subject-not-mentioned' }
    absent.prediction = { outcome: 'subject-not-mentioned', evidence: [], evidenceSupported: null, evaluatorDefinitionId: FROZEN, returnedModel: null }
    const correct = evaluateSentimentCorpus([absent], { evaluatorDefinitionId: FROZEN, developmentGroups: [] }).populations['non-brand'].representative
    expect(correct.metrics.favorableShareError.measuredShare.denominator).toBe(0)
    expect(correct.excludedFromShare).toBe(1)
    absent.prediction = { ...example('prediction', 'unfavorable', 'unfavorable').prediction }
    const wrong = evaluateSentimentCorpus([absent], { evaluatorDefinitionId: FROZEN, developmentGroups: [] }).populations['non-brand'].representative
    expect(wrong.stances.unfavorable.falsePositive).toBe(1)
    expect(wrong.metrics.correctSubjectPrecision).toMatchObject({ numerator: 0, denominator: 1, value: 0 })
  })
  it('requires explicit population provenance and conclusion evidence for a claimed stance', () => {
    const row = example('missing', 'favorable', 'favorable')
    Reflect.deleteProperty(row, 'queryClass'); row.prediction.evidence = []
    const report = evaluateSentimentCorpus([row], { evaluatorDefinitionId: FROZEN, developmentGroups: [] })
    expect(report.releaseEligible).toBe(false)
    expect(report.blockers.join(' ')).toContain('explicit branded or non-brand query class')
    expect(report.blockers.join(' ')).toContain('requires conclusion evidence')
  })
})
