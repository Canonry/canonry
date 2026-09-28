import { createHash } from 'node:crypto'
import { SENTIMENT_MODEL, SentimentOutcomes, canonicalSentimentDefinitionJson, createSentimentEvaluationDefinition, wilsonInterval } from '@ainyc/canonry-contracts'
import type { SentimentEvidence, SentimentOutcome } from '@ainyc/canonry-contracts'

const STANCES = [SentimentOutcomes.favorable, SentimentOutcomes.mixed, SentimentOutcomes.unfavorable] as const
type Stance = typeof STANCES[number]
const MIN_GATED_EXAMPLES = 25
/** Tagged challenge cases gated per population: recall of the adjudicated outcome among cases carrying the tag. */
export const SENTIMENT_CHALLENGE_GATES = {
  'same-name': { outcome: SentimentOutcomes['wrong-subject'], target: 0.9 },
  'caveated-favorable': { outcome: SentimentOutcomes.favorable, target: 0.9 },
} as const
export type SentimentChallengeTag = keyof typeof SENTIMENT_CHALLENGE_GATES
export interface SentimentEvaluationExample {
  id: string
  sample: 'representative' | 'challenge'
  queryClass: 'branded' | 'non-brand'
  industry: string
  provider: string
  language: string
  propertyId: string
  queryFamilyId: string
  sweepId: string
  sourceText: string
  sourceHash: string
  reviewers: Array<{ id: string; labelHash: string; blinded: boolean }>
  adjudication: { reviewerId: string; correctSubject: boolean; judgeable: boolean; outcome: SentimentOutcome }
  /** Challenge-sample labels such as `same-name` or `caveated-favorable`; other descriptive tags are kept but not gated. */
  challengeTags?: string[]
  prediction: { outcome: SentimentOutcome; evidence: SentimentEvidence[]; evidenceSupported: boolean | null; evaluatorDefinitionId: string; returnedModel: string | null }
}
export interface SentimentEvaluationOptions { evaluatorDefinitionId: string; developmentGroups: string[] }
function isStance(outcome: SentimentOutcome): outcome is Stance { return STANCES.some(stance => stance === outcome) }
/** SHA-256 of the canonical current definition: the ID the runtime stores for it and the only ID a release report accepts. */
export function frozenSentimentEvaluationDefinitionId(): string {
  return createHash('sha256').update(canonicalSentimentDefinitionJson(createSentimentEvaluationDefinition())).digest('hex')
}
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
    favorableShareError: { value: expectedShare.value === null || measuredShare.value === null ? null : Math.abs(expectedShare.value - measuredShare.value), expectedShare, measuredShare,
      differenceInterval: expectedShare.interval && measuredShare.interval ? { low: measuredShare.interval.low - expectedShare.interval.high, high: measuredShare.interval.high - expectedShare.interval.low } : null },
  }
  return { count: rows.length, eligible: eligible.length, excludedFromShare: rows.length - measuredJudgments.length,
    abstentionsByStance: Object.fromEntries(STANCES.map(stance => [stance, eligible.filter(row => row.adjudication.outcome === stance && !isStance(row.prediction.outcome)).length])),
    stances: stanceCounts(rows), metrics }
}
const METRIC_TARGETS = { quotationIntegrity: 1, correctSubjectPrecision: 0.95, favorablePrecision: 0.9, stanceMacroF1: 0.85, coverage: 0.9, evidenceSupport: 0.95 } as const
type MetricGate = { target: number; value: number | null; passed: boolean }
function metricGates(result: ReturnType<typeof score>): Record<keyof typeof METRIC_TARGETS | 'favorableShareError', MetricGate> {
  return { ...Object.fromEntries(Object.entries(METRIC_TARGETS).map(([name, target]) => {
    const value = result.metrics[name as keyof typeof METRIC_TARGETS].value
    return [name, { target, value, passed: value !== null && value >= target }]
  })) as Record<keyof typeof METRIC_TARGETS, MetricGate>, favorableShareError: { target: 0.05, value: result.metrics.favorableShareError.value, passed: result.metrics.favorableShareError.value !== null && result.metrics.favorableShareError.value <= 0.05 } }
}

function challengeGates(rows: SentimentEvaluationExample[]) {
  return Object.fromEntries(Object.entries(SENTIMENT_CHALLENGE_GATES).map(([tag, gate]) => {
    const tagged = rows.filter(row => Array.isArray(row.challengeTags) && row.challengeTags.includes(tag) && row.adjudication.outcome === gate.outcome)
    const recall = proportion(tagged.filter(row => row.prediction.outcome === gate.outcome).length, tagged.length)
    return [tag, { expectedOutcome: gate.outcome, target: gate.target, minimumExamples: MIN_GATED_EXAMPLES, recall, passed: tagged.length >= MIN_GATED_EXAMPLES && recall.value !== null && recall.value >= gate.target }]
  })) as Record<SentimentChallengeTag, { expectedOutcome: SentimentOutcome; target: number; minimumExamples: number; recall: ReturnType<typeof proportion>; passed: boolean }>
}

function evaluatePopulation(rows: SentimentEvaluationExample[], queryClass: SentimentEvaluationExample['queryClass']) {
  const members = rows.filter(row => row.queryClass === queryClass)
  const representativeRows = members.filter(row => row.sample === 'representative')
  const challengeRows = members.filter(row => row.sample === 'challenge')
  const representative = score(representativeRows)
  const challenge = { ...score(challengeRows), gates: challengeGates(challengeRows) }
  const gates = metricGates(representative)
  const blockers: string[] = []
  if (representativeRows.length < 150) blockers.push(`${queryClass}: representative sample requires at least 150 independently reviewed answers.`)
  if (new Set(representativeRows.map(row => row.industry)).size < 2) blockers.push(`${queryClass}: representative sample requires at least two industries.`)
  for (const stance of STANCES) if (members.filter(row => row.adjudication.outcome === stance).length < MIN_GATED_EXAMPLES) blockers.push(`${queryClass}: at least 25 adjudicated ${stance} examples are required across representative and challenge samples.`)
  for (const [tag, gate] of Object.entries(challenge.gates)) if (gate.recall.denominator < MIN_GATED_EXAMPLES) blockers.push(`${queryClass}: at least 25 challenge examples tagged ${tag} with adjudicated outcome ${gate.expectedOutcome} are required.`)
  const slices = (['industry', 'provider', 'language'] as const).flatMap(dimension => [...new Set(members.map(row => row[dimension]))].flatMap(value => (['representative', 'challenge'] as const).map(sample => {
    const sliceRows = members.filter(row => row[dimension] === value && row.sample === sample)
    const result = score(sliceRows)
    const sliceGates = metricGates(result)
    const sufficient = sliceRows.length >= MIN_GATED_EXAMPLES && STANCES.every(stance => sliceRows.filter(row => row.adjudication.outcome === stance).length >= 5)
    // Sparse representative slices are reported but not gated; challenge slices are diagnostic and gated by tag above.
    const gated = sample === 'representative' && sufficient
    const limitation = sample === 'challenge' ? 'Challenge slice: diagnostic only; tagged challenge recall is gated for the whole population.'
      : sufficient ? null : 'Sparse slice: not gated. Gating a slice requires at least 25 examples and five examples of each stance.'
    return { queryClass, dimension, value, sample, ...result, gates: sliceGates, gated, releaseEligible: gated ? Object.values(sliceGates).every(gate => gate.passed) : null, limitation }
  })))
  return { queryClass, representative, challenge, gates, slices, blockers,
    releaseEligible: blockers.length === 0 && Object.values(gates).every(gate => gate.passed) && Object.values(challenge.gates).every(gate => gate.passed) && slices.every(slice => !slice.gated || slice.releaseEligible === true) }
}

/** Offline scoring only. Human labels and semantic evidence reviews must be supplied separately. */
export function evaluateSentimentCorpus(rows: SentimentEvaluationExample[], options: SentimentEvaluationOptions) {
  const blockers: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.id)) blockers.push(`Duplicate example ID: ${row.id}.`)
    seen.add(row.id)
    if (!(['branded', 'non-brand'] as readonly unknown[]).includes(row.queryClass)) blockers.push(`Example ${row.id} requires an explicit branded or non-brand query class.`)
    if (createHash('sha256').update(row.sourceText).digest('hex') !== row.sourceHash) blockers.push(`Example ${row.id} has a mismatched source hash.`)
    if (new Set(row.reviewers.map(reviewer => reviewer.id)).size < 2 || row.reviewers.some(reviewer => !reviewer.blinded || !reviewer.labelHash) || !row.adjudication.reviewerId) blockers.push(`Example ${row.id} requires two blinded reviewers and retained adjudication.`)
    if (isStance(row.adjudication.outcome) && (!row.adjudication.correctSubject || !row.adjudication.judgeable)) blockers.push(`Example ${row.id} assigns a stance to an ineligible subject or judgment.`)
    if (isStance(row.prediction.outcome) && !row.prediction.evidence.length) blockers.push(`Example ${row.id} requires conclusion evidence for its predicted stance.`)
    if (row.prediction.evaluatorDefinitionId !== options.evaluatorDefinitionId) blockers.push(`Example ${row.id} was not scored with the frozen evaluator definition.`)
    const returnedModel = row.prediction.returnedModel as unknown
    if (isStance(row.prediction.outcome) ? returnedModel !== SENTIMENT_MODEL : returnedModel !== null && returnedModel !== SENTIMENT_MODEL) blockers.push(`Example ${row.id} must record ${SENTIMENT_MODEL} as the model that returned its prediction.`)
    const groups = [`property:${row.propertyId}`, `query-family:${row.queryFamilyId}`, `sweep:${row.sweepId}`]
    if (groups.some(group => options.developmentGroups.includes(group))) blockers.push(`Example ${row.id} overlaps a development group.`)
    if (![row.industry, row.provider, row.language, row.propertyId, row.queryFamilyId, row.sweepId].every(Boolean)) blockers.push(`Example ${row.id} lacks slice or grouping provenance.`)
  }
  const frozenEvaluatorDefinitionId = frozenSentimentEvaluationDefinitionId()
  if (options.evaluatorDefinitionId !== frozenEvaluatorDefinitionId) blockers.push(`The evaluator definition ID must equal the frozen definition hash ${frozenEvaluatorDefinitionId}.`)
  const populations = { branded: evaluatePopulation(rows, 'branded'), 'non-brand': evaluatePopulation(rows, 'non-brand') }
  blockers.push(...Object.values(populations).flatMap(population => population.blockers))
  return { schemaVersion: 2, evaluatorDefinitionId: options.evaluatorDefinitionId, frozenEvaluatorDefinitionId, count: rows.length,
    releaseEligible: blockers.length === 0 && Object.values(populations).every(population => population.releaseEligible), blockers, populations,
    scope: 'stance-and-evidence-only', deferredCapabilities: ['themes'],
    limitations: ['Synthetic fixture labels and live smoke do not establish independent held-out quality.', 'Branded and non-brand populations are evaluated separately; their favorable shares, denominators, and quality gates are never pooled.', 'Proportions use Wilson 95% intervals. Macro F1 uses 500 seeded ordinary bootstrap resamples; intervals do not account for Property, query-family, or sweep clustering.', 'Favorable-share difference interval uses independent marginal Wilson bounds; abstentions and excluded cases are disclosed.', 'Representative slices below 25 examples or five of any stance are reported as not gated. Challenge slices are diagnostic; same-name and caveated-favorable challenge recall is gated per population.', 'Vendor confidence is not interpreted as probability of correctness. Themes are deferred and do not participate in this release gate; non-English sentiment requires separate evaluation.'] }
}
