import { createHash } from 'node:crypto'
import { SentimentOutcomes, wilsonInterval } from '@ainyc/canonry-contracts'
import type { SentimentEvidence, SentimentOutcome } from '@ainyc/canonry-contracts'

const STANCES = [SentimentOutcomes.favorable, SentimentOutcomes.mixed, SentimentOutcomes.unfavorable] as const
type Stance = typeof STANCES[number]
export interface SentimentEvaluationExample {
  id: string
  sample: 'representative' | 'challenge'
  industry: string
  provider: string
  language: string
  propertyId: string
  queryFamilyId: string
  sweepId: string
  sourceText: string
  sourceHash: string
  reviewers: Array<{ id: string; labelHash: string; blinded: boolean }>
  adjudication: { reviewerId: string; correctSubject: boolean; judgeable: boolean; outcome: SentimentOutcome; complaints: Record<string, boolean> }
  prediction: { outcome: SentimentOutcome; evidence: SentimentEvidence[]; evidenceSupported: boolean | null; complaints: Record<string, boolean | null> }
}
export interface SentimentEvaluationOptions { evaluatorDefinitionId: string; developmentGroups: string[] }
function isStance(outcome: SentimentOutcome): outcome is Stance { return STANCES.some(stance => stance === outcome) }
function proportion(numerator: number, denominator: number) {
  return { numerator, denominator, value: denominator ? numerator / denominator : null, interval: wilsonInterval(numerator, denominator) }
}
function stanceCounts(rows: SentimentEvaluationExample[]) {
  return Object.fromEntries(STANCES.map(stance => {
    const truePositive = rows.filter(row => row.adjudication.outcome === stance && row.prediction.outcome === stance).length
    const falsePositive = rows.filter(row => row.adjudication.outcome !== stance && row.prediction.outcome === stance).length
    const falseNegative = rows.filter(row => row.adjudication.outcome === stance && row.prediction.outcome !== stance).length
    return [stance, { truePositive, falsePositive, falseNegative, f1: 2 * truePositive + falsePositive + falseNegative ? 2 * truePositive / (2 * truePositive + falsePositive + falseNegative) : null }]
  })) as Record<Stance, { truePositive: number; falsePositive: number; falseNegative: number; f1: number | null }>
}
function macroF1(rows: SentimentEvaluationExample[]): number | null {
  const counts = Object.values(stanceCounts(rows))
  return counts.some(value => value.f1 === null) ? null : counts.reduce((sum, value) => sum + value.f1!, 0) / 3
}
function bootstrapMacroInterval(rows: SentimentEvaluationExample[]) {
  if (!rows.length || macroF1(rows) === null) return null
  let seed = 90210
  const values: number[] = []
  for (let iteration = 0; iteration < 500; iteration++) {
    const sample = rows.map(() => { seed = (1664525 * seed + 1013904223) >>> 0; return rows[Math.floor(seed / 4294967296 * rows.length)] })
    const value = macroF1(sample)
    if (value !== null) values.push(value)
  }
  values.sort((a, b) => a - b)
  return values.length ? { low: values[Math.floor(values.length * 0.025)], high: values[Math.min(values.length - 1, Math.floor(values.length * 0.975))] } : null
}
function validEvidence(source: string, evidence: SentimentEvidence): boolean {
  return Number.isSafeInteger(evidence.start) && Number.isSafeInteger(evidence.end) && evidence.start >= 0 && evidence.end > evidence.start && evidence.end <= source.length && source.slice(evidence.start, evidence.end) === evidence.text
}
function score(rows: SentimentEvaluationExample[]) {
  const accepted = rows.filter(row => isStance(row.prediction.outcome) || row.prediction.outcome === SentimentOutcomes.factual)
  const eligible = rows.filter(row => row.adjudication.correctSubject && row.adjudication.judgeable && isStance(row.adjudication.outcome))
  const judged = eligible.filter(row => isStance(row.prediction.outcome))
  const favorable = rows.filter(row => row.prediction.outcome === SentimentOutcomes.favorable)
  const quotations = rows.flatMap(row => row.prediction.evidence.map(evidence => ({ row, evidence })))
    const complaints = rows.flatMap(row => [...new Set([...Object.keys(row.adjudication.complaints), ...Object.keys(row.prediction.complaints)])].map(theme => ({ expected: row.adjudication.complaints[theme] === true, predicted: row.prediction.complaints[theme] === true })))
  const complaintsByTheme = [...new Set(rows.flatMap(row => [...Object.keys(row.adjudication.complaints), ...Object.keys(row.prediction.complaints)]))].map(themeId => {
    const truePositive = rows.filter(row => row.adjudication.complaints[themeId] === true && row.prediction.complaints[themeId] === true).length
    const precision = proportion(truePositive, rows.filter(row => row.prediction.complaints[themeId] === true).length)
    const recall = proportion(truePositive, rows.filter(row => row.adjudication.complaints[themeId] === true).length)
    return { themeId, precision, recall, passed: precision.value !== null && precision.value >= 0.9 && recall.value !== null && recall.value >= 0.85 }
  })
  const complaintTruePositive = complaints.filter(value => value.expected && value.predicted).length
  const expectedShare = proportion(eligible.filter(row => row.adjudication.outcome === SentimentOutcomes.favorable).length, eligible.length)
  const measuredJudgments = rows.filter(row => isStance(row.prediction.outcome))
  const measuredShare = proportion(measuredJudgments.filter(row => row.prediction.outcome === SentimentOutcomes.favorable).length, measuredJudgments.length)
  const metrics = {
    quotationIntegrity: proportion(quotations.filter(({ row, evidence }) => validEvidence(row.sourceText, evidence)).length, quotations.length),
    correctSubjectPrecision: proportion(accepted.filter(row => row.adjudication.correctSubject).length, accepted.length),
    favorablePrecision: proportion(favorable.filter(row => row.adjudication.correctSubject && row.adjudication.outcome === SentimentOutcomes.favorable).length, favorable.length),
    stanceMacroF1: { value: macroF1(rows), interval: bootstrapMacroInterval(rows) },
    coverage: proportion(judged.length, eligible.length),
    evidenceSupport: proportion(quotations.filter(({ row }) => row.prediction.evidenceSupported === true).length, quotations.length),
    complaintPrecision: proportion(complaintTruePositive, complaints.filter(value => value.predicted).length),
    complaintRecall: proportion(complaintTruePositive, complaints.filter(value => value.expected).length),
    favorableShareError: { value: expectedShare.value === null || measuredShare.value === null ? null : Math.abs(expectedShare.value - measuredShare.value), expectedShare, measuredShare,
      differenceInterval: expectedShare.interval && measuredShare.interval ? { low: measuredShare.interval.low - expectedShare.interval.high, high: measuredShare.interval.high - expectedShare.interval.low } : null },
  }
  return { count: rows.length, eligible: eligible.length, excludedFromShare: rows.length - measuredJudgments.length,
    abstentionsByStance: Object.fromEntries(STANCES.map(stance => [stance, eligible.filter(row => row.adjudication.outcome === stance && !isStance(row.prediction.outcome)).length])),
    stances: stanceCounts(rows), complaintsByTheme, metrics }
}
function metricGates(result: ReturnType<typeof score>) {
  const targets = { quotationIntegrity: 1, correctSubjectPrecision: 0.95, favorablePrecision: 0.9, stanceMacroF1: 0.85, coverage: 0.9, evidenceSupport: 0.95, complaintPrecision: 0.9, complaintRecall: 0.85 } as const
  return { ...Object.fromEntries(Object.entries(targets).map(([name, target]) => {
    const value = result.metrics[name as keyof typeof targets].value
    return [name, { target, value, passed: value !== null && value >= target }]
  })), favorableShareError: { target: 0.05, value: result.metrics.favorableShareError.value, passed: result.metrics.favorableShareError.value !== null && result.metrics.favorableShareError.value <= 0.05 } }
}

/** Offline scoring only. Human labels and semantic evidence reviews must be supplied separately. */
export function evaluateSentimentCorpus(rows: SentimentEvaluationExample[], options: SentimentEvaluationOptions) {
  const blockers: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.id)) blockers.push(`Duplicate example ID: ${row.id}.`)
    seen.add(row.id)
    if (createHash('sha256').update(row.sourceText).digest('hex') !== row.sourceHash) blockers.push(`Example ${row.id} has a mismatched source hash.`)
    if (new Set(row.reviewers.map(reviewer => reviewer.id)).size < 2 || row.reviewers.some(reviewer => !reviewer.blinded || !reviewer.labelHash) || !row.adjudication.reviewerId) blockers.push(`Example ${row.id} requires two blinded reviewers and retained adjudication.`)
    if (isStance(row.adjudication.outcome) && (!row.adjudication.correctSubject || !row.adjudication.judgeable)) blockers.push(`Example ${row.id} assigns a stance to an ineligible subject or judgment.`)
    const groups = [`property:${row.propertyId}`, `query-family:${row.queryFamilyId}`, `sweep:${row.sweepId}`]
    if (groups.some(group => options.developmentGroups.includes(group))) blockers.push(`Example ${row.id} overlaps a development group.`)
    if (![row.industry, row.provider, row.language, row.propertyId, row.queryFamilyId, row.sweepId].every(Boolean)) blockers.push(`Example ${row.id} lacks slice or grouping provenance.`)
  }
  const representativeRows = rows.filter(row => row.sample === 'representative')
  const representative = score(representativeRows)
  const challenge = score(rows.filter(row => row.sample === 'challenge'))
  const gates = metricGates(representative)
  if (representativeRows.length < 150) blockers.push('Representative sample requires at least 150 independently reviewed answers.')
  if (new Set(representativeRows.map(row => row.industry)).size < 2) blockers.push('Representative sample requires at least two industries.')
  for (const stance of STANCES) if (rows.filter(row => row.adjudication.outcome === stance).length < 25) blockers.push(`At least 25 adjudicated ${stance} examples are required across representative and challenge samples.`)
  if (!options.evaluatorDefinitionId) blockers.push('A frozen evaluator definition is required.')
  const slices = (['industry', 'provider', 'language'] as const).flatMap(dimension => [...new Set(rows.map(row => row[dimension]))].flatMap(value => (['representative', 'challenge'] as const).map(sample => {
    const members = rows.filter(row => row[dimension] === value && row.sample === sample)
    const result = score(members)
    const sliceGates = metricGates(result)
    const sufficient = members.length >= 25 && STANCES.every(stance => members.filter(row => row.adjudication.outcome === stance).length >= 5)
    return { dimension, value, sample, ...result, gates: sliceGates, releaseEligible: sufficient && Object.values(sliceGates).every(gate => gate.passed), limitation: sufficient ? null : 'Sparse slice: at least 25 examples and five examples of each stance are required.' }
  })))
  return { schemaVersion: 1, evaluatorDefinitionId: options.evaluatorDefinitionId, releaseEligible: blockers.length === 0 && Object.values(gates).every(gate => gate.passed) && representative.complaintsByTheme.every(theme => theme.passed) && slices.filter(slice => slice.sample === 'representative').every(slice => slice.releaseEligible), blockers,
    representative, challenge, gates, slices,
    limitations: ['Synthetic fixture labels and live smoke do not establish independent held-out quality.', 'Proportions use Wilson 95% intervals. Macro F1 uses 500 seeded ordinary bootstrap resamples; intervals do not account for Property, query-family, or sweep clustering.', 'Favorable-share difference interval uses independent marginal Wilson bounds; abstentions and excluded cases are disclosed.', 'Vendor confidence is not interpreted as probability of correctness. Custom themes and non-brand sentiment remain unvalidated.'] }
}
