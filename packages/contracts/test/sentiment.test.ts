import { describe, expect, it } from 'vitest'
import { sentimentFixtureSummary, sentimentCompleteFixtureSummary } from './fixtures/sentiment.js'
import { sentimentCoverageSchema, sentimentSummarySchema, sentimentOverviewSchema, sentimentOverallHeadlineSchema, sentimentEvidencePageSchema, sentimentOutcomeSchema } from '../src/sentiment.js'
import { RatioUnits, ratioUnitOf } from '../src/ratio-unit.js'
import { aggregateSentiment, canonicalSentimentDefinitionJson, createSentimentEvaluationDefinition, hasCurrentSentimentTemplate, sentimentJobRequestSchema, sentimentJobsSchema, sentimentSummaryRequestSchema, sentimentClassifierOutputSchema, sentimentRateDisplay, sentimentSettingsUpdateSchema, sentimentSelectionSchema, sentimentCompareRequestSchema, sentimentAssessmentSummarySchema, sentimentEvidenceRequestSchema, storedSentimentEvaluationDefinitionSchema, storedSentimentClassifierOutputSchema, type SentimentAggregateItem, type SentimentOutcome } from '../src/sentiment.js'

const outcomes: SentimentOutcome[] = ['favorable', 'favorable', 'favorable', 'mixed', 'unfavorable', 'factual', 'wrong-subject', 'invalid-conclusion-evidence', 'failed', 'pending']
const canonical: SentimentAggregateItem[] = outcomes.map((outcome, index) => ({ assessmentId: `a${index}`, sourceSnapshotId: `s${index}`, outcome }))

describe('sentiment measurement invariants', () => {
  it('adds an explicitly combined overview without requiring it from older servers', () => {
    const { state, reason, provisional, coverage, score, selection } = sentimentFixtureSummary
    const headline = { state, reason, provisional, coverage, score, selection, runIds: ['run'] }
    const prior = { configured: true, branded: headline, nonBrand: { ...headline, selection: { ...selection, queryClass: 'non-brand' } } }
    expect(sentimentOverviewSchema.parse(prior)).toEqual(prior)
    const overall = { state, reason, provisional, coverage, score, queryClass: 'all', runIds: ['run'] }
    expect(sentimentOverviewSchema.parse({ ...prior, overall }).overall).toEqual(overall)
    expect(sentimentOverallHeadlineSchema.safeParse({ ...overall, queryClass: 'branded' }).success).toBe(false)
    expect(sentimentOverallHeadlineSchema.safeParse({ ...overall, selection }).success).toBe(false)
    expect(sentimentSelectionSchema.safeParse({ queryClass: 'all' }).success).toBe(false)
  })
  it('shares strict partial and complete DTO fixtures across every surface', () => {
    expect(sentimentSummarySchema.parse(sentimentFixtureSummary)).toEqual(sentimentFixtureSummary)
    expect(sentimentSummarySchema.parse(sentimentCompleteFixtureSummary).state).toBe('complete')
    for (const state of ['disabled', 'not-measured', 'processing', 'partial', 'complete', 'failed', 'canceled', 'unsupported'] as const) {
      expect(sentimentSummarySchema.safeParse({ ...sentimentFixtureSummary, state }).success).toBe(true)
    }
  })
  it('keeps per-engine rows compact and assessment filters exclusive to evidence requests', () => {
    const row = { assessmentId: null, sourceSnapshotId: 'snapshot', runId: 'run', subjectId: 'subject', subjectLabel: 'Subject', executionNodeKey: null, provider: 'openai', requestedModel: 'requested', servedModel: null, location: null, evaluationDefinitionId: null, state: 'not-measured', outcome: null, reason: 'Not admitted.' }
    expect(sentimentAssessmentSummarySchema.parse(row)).toEqual(row)
    expect(sentimentAssessmentSummarySchema.safeParse({ ...row, sourceText: 'Do not embed answer bodies.' }).success).toBe(false)
    expect(sentimentEvidenceRequestSchema.parse({ assessmentId: 'assessment' }).assessmentId).toBe('assessment')
    expect(sentimentSelectionSchema.safeParse({ assessmentId: 'assessment' }).success).toBe(false)
  })
  it('parses the evidence outcome filter from a comma list or repeated values, and nowhere else', () => {
    const outcome = (value: unknown) => sentimentEvidenceRequestSchema.safeParse({ runId: 'run', outcome: value })
    // The schema keeps the caller's order; the service sorts the echo.
    expect(sentimentEvidenceRequestSchema.parse({ outcome: 'mixed,unfavorable' }).outcome).toEqual(['mixed', 'unfavorable'])
    expect(sentimentEvidenceRequestSchema.parse({ outcome: ['unfavorable', 'mixed'] }).outcome).toEqual(['unfavorable', 'mixed'])
    expect(sentimentEvidenceRequestSchema.parse({ outcome: ' mixed , unfavorable ' }).outcome).toEqual(['mixed', 'unfavorable'])
    expect(sentimentEvidenceRequestSchema.parse({ outcome: 'mixed,,unfavorable,' }).outcome).toEqual(['mixed', 'unfavorable'])
    expect(sentimentEvidenceRequestSchema.parse({ outcome: 'favorable' }).outcome).toEqual(['favorable'])
    expect(sentimentEvidenceRequestSchema.parse({ outcome: ['pending'] }).outcome).toEqual(['pending'])
    // Fastify hands repeated params over as an array whose items may themselves be comma lists or padded: one normalization for both forms.
    expect(sentimentEvidenceRequestSchema.parse({ outcome: ['mixed,unfavorable', 'favorable'] }).outcome).toEqual(['mixed', 'unfavorable', 'favorable'])
    expect(sentimentEvidenceRequestSchema.parse({ outcome: [' mixed', 'unfavorable '] }).outcome).toEqual(['mixed', 'unfavorable'])
    // Duplicates collapse to one, keeping first-seen order.
    expect(sentimentEvidenceRequestSchema.parse({ outcome: ['unfavorable', 'mixed,unfavorable'] }).outcome).toEqual(['unfavorable', 'mixed'])
    expect(sentimentEvidenceRequestSchema.parse({ outcome: [...sentimentOutcomeSchema.options, 'mixed'] }).outcome).toEqual([...sentimentOutcomeSchema.options])
    // Every known outcome at once is the widest filter.
    const every = sentimentEvidenceRequestSchema.parse({ outcome: [...sentimentOutcomeSchema.options] }).outcome
    expect(every).toHaveLength(18)
    expect(every).toEqual([...sentimentOutcomeSchema.options])
    // Absent means no filter, never a default.
    expect(sentimentEvidenceRequestSchema.parse({ runId: 'run' })).not.toHaveProperty('outcome')
    expect(sentimentEvidenceRequestSchema.parse({ runId: 'run', assessmentId: 'assessment', outcome: 'mixed' })).toMatchObject({ assessmentId: 'assessment', outcome: ['mixed'], limit: 50 })
    for (const invalid of ['positive', 'mixed,positive', ['mixed', 'positive'], ['mixed,positive'], 'Mixed', '', ',', ' , ', [], [''], [','], 7, [7]]) {
      expect(outcome(invalid).success, JSON.stringify(invalid)).toBe(false)
    }
    // An outcome filter narrows evidence only; summaries and selections reject it.
    expect(sentimentSummaryRequestSchema.safeParse({ runId: 'run', outcome: 'mixed' }).success).toBe(false)
    expect(sentimentSelectionSchema.safeParse({ outcome: 'mixed' }).success).toBe(false)
    expect(sentimentEvidenceRequestSchema.safeParse({ runId: 'run', runIds: ['run'], outcome: 'mixed' }).success).toBe(false)
  })
  it('echoes the evidence outcome filter on the page selection and rejects an unknown echoed outcome', () => {
    const selection = { ...sentimentFixtureSummary.selection, outcome: ['mixed', 'unfavorable'] }
    const page = { state: 'complete', selection, items: [], nextCursor: null }
    expect(sentimentEvidencePageSchema.parse(page).selection.outcome).toEqual(['mixed', 'unfavorable'])
    const { outcome: _outcome, ...unfiltered } = selection
    expect(sentimentEvidencePageSchema.parse({ ...page, selection: unfiltered }).selection).not.toHaveProperty('outcome')
    expect(sentimentEvidencePageSchema.safeParse({ ...page, selection: { ...selection, outcome: ['positive'] } }).success).toBe(false)
    expect(sentimentEvidencePageSchema.safeParse({ ...page, selection: { ...selection, outcome: 'mixed' } }).success).toBe(false)
  })
  it('counts five judgments out of ten assessments with no mixed favorable credit', () => {
    const result = aggregateSentiment(canonical)
    expect(result.coverage).toMatchObject({ selected: 10, judged: 5, distinctSourceAnswers: 10, eligibleAnswers: 10, ratedAnswers: 5, ratedAnswerRate: 0.5 })
    expect(Object.values(result.coverage.counts).reduce((a, b) => a + b, 0)).toBe(10)
    expect(result.score).toMatchObject({ favorableRate: 0.6, mixedRate: 0.2, unfavorableRate: 0.2, favorableDisplay: '60.0%', mixedDisplay: '20.0%', unfavorableDisplay: '20.0%', interval: { low: 0.2307, high: 0.8824 } })
    expect(result.state).toBe('partial')
    expect(result.provisional).toBe(true)
  })
  it('discloses eligible assessments that have not been admitted without calling them pending', () => {
    const result = aggregateSentiment([canonical[0]!], { eligibleAssessments: 3 })
    expect(result.coverage).toMatchObject({ selected: 1, eligibleAssessments: 3, unadmittedAssessments: 2, judged: 1, counts: { pending: 0 } })
  })
  it('deduplicates usage edges, preserving two subjects for one source answer', () => {
    const items = [{ ...canonical[0]!, sourceSnapshotId: 'shared' }, { ...canonical[4]!, sourceSnapshotId: 'shared' }]
    expect(aggregateSentiment([...items, items[0]!]).coverage).toMatchObject({ selected: 2, judged: 2, distinctSourceAnswers: 1, eligibleAnswers: 1, ratedAnswers: 1, ratedAnswerRate: 1 })
    expect(aggregateSentiment(items).score.favorableRate).toBe(0.5)
  })
  it('rates answers, not assessments: each source answer counts once over every eligible answer, admitted or not', () => {
    const answer = (assessmentId: string, sourceSnapshotId: string, outcome: SentimentOutcome): SentimentAggregateItem => ({ assessmentId, sourceSnapshotId, outcome })
    // Two eligible answers, one admitted and rated favorable: 1 of 2, never 1 of 1.
    expect(aggregateSentiment([answer('a', 'openai', 'favorable')], { eligibleAssessments: 2, eligibleAnswers: 2 }).coverage).toMatchObject({ selected: 1, judged: 1, distinctSourceAnswers: 1, eligibleAnswers: 2, ratedAnswers: 1, ratedAnswerRate: 0.5 })
    // Before admission the eligible answers are still the denominator: a measured 0 of 2.
    expect(aggregateSentiment([], { eligibleAssessments: 2, eligibleAnswers: 2 }).coverage).toMatchObject({ selected: 0, judged: 0, distinctSourceAnswers: 0, eligibleAnswers: 2, ratedAnswers: 0, ratedAnswerRate: 0 })
    // Admitted but still pending, failed or nonjudged answers are not rated.
    expect(aggregateSentiment([answer('a', 'one', 'pending'), answer('b', 'two', 'failed'), answer('c', 'three', 'factual')], { eligibleAnswers: 4 }).coverage).toMatchObject({ eligibleAnswers: 4, ratedAnswers: 0, ratedAnswerRate: 0 })
    // No eligible answers: no share at all, not 0%.
    expect(aggregateSentiment([]).coverage).toMatchObject({ eligibleAnswers: 0, ratedAnswers: 0, ratedAnswerRate: null })
    // An Advanced answer assessed for two subjects is one answer: rated once when either subject is judged.
    const advanced = [answer('harbor', 'shared', 'favorable'), answer('bayside', 'shared', 'factual'), answer('harbor-2', 'other', 'unfavorable'), answer('bayside-2', 'other', 'mixed')]
    expect(aggregateSentiment(advanced, { eligibleAssessments: 4, eligibleAnswers: 2 }).coverage).toMatchObject({ selected: 4, judged: 3, distinctSourceAnswers: 2, eligibleAnswers: 2, ratedAnswers: 2, ratedAnswerRate: 1 })
    // Mixed admitted and unadmitted: 3 eligible answers, 2 admitted, 1 rated.
    expect(aggregateSentiment([answer('a', 'one', 'mixed'), answer('b', 'two', 'subject-not-mentioned')], { eligibleAssessments: 3, eligibleAnswers: 3 }).coverage).toMatchObject({ selected: 2, unadmittedAssessments: 1, judged: 1, eligibleAnswers: 3, ratedAnswers: 1, ratedAnswerRate: 0.33333333 })
    // A denominator below the admitted answers never shrinks under them.
    expect(aggregateSentiment(canonical, { eligibleAnswers: 3 }).coverage).toMatchObject({ distinctSourceAnswers: 10, eligibleAnswers: 10, ratedAnswers: 5, ratedAnswerRate: 0.5 })
    // Disabled withholds the share like every other rate.
    expect(aggregateSentiment(canonical, { disabled: true, eligibleAnswers: 10 }).coverage.ratedAnswerRate).toBeNull()
  })
  it('takes a wider rated count from the caller, never one below the answers its items rate', () => {
    const answer = (assessmentId: string, sourceSnapshotId: string, outcome: SentimentOutcome): SentimentAggregateItem => ({ assessmentId, sourceSnapshotId, outcome })
    // A comparison scores one matched unit but its period rated both answers: 2 of 2, not 1 of 2.
    expect(aggregateSentiment([answer('a', 'one', 'favorable')], { eligibleAssessments: 2, eligibleAnswers: 2, ratedAnswers: 2 }).coverage).toMatchObject({ selected: 1, judged: 1, eligibleAnswers: 2, ratedAnswers: 2, ratedAnswerRate: 1 })
    // A caller count below the rated items is raised to them.
    expect(aggregateSentiment([answer('a', 'one', 'favorable'), answer('b', 'two', 'mixed')], { eligibleAnswers: 4, ratedAnswers: 1 }).coverage).toMatchObject({ ratedAnswers: 2, ratedAnswerRate: 0.5 })
  })
  it('adds the answer-level Rated fields optionally, so a response from an older server stays valid', () => {
    const { eligibleAnswers, ratedAnswers, ratedAnswerRate, ...older } = sentimentFixtureSummary.coverage
    expect({ eligibleAnswers, ratedAnswers, ratedAnswerRate }).toEqual({ eligibleAnswers: 10, ratedAnswers: 5, ratedAnswerRate: 0.5 })
    expect(sentimentSummarySchema.parse({ ...sentimentFixtureSummary, coverage: older }).coverage).toEqual(older)
    expect(sentimentCoverageSchema.parse({ ...older, eligibleAnswers: 0, ratedAnswers: 0, ratedAnswerRate: null }).ratedAnswerRate).toBeNull()
    for (const bad of [{ eligibleAnswers: -1 }, { ratedAnswers: 1.5 }, { ratedAnswerRate: 1.01 }, { ratedAnswerRate: -0.1 }]) {
      expect(sentimentCoverageSchema.safeParse({ ...sentimentFixtureSummary.coverage, ...bad }).success, JSON.stringify(bad)).toBe(false)
    }
    expect(ratioUnitOf(sentimentCoverageSchema.shape.ratedAnswerRate)).toBe(RatioUnits.fraction)
  })
  it('does not fabricate zero when no judgments or when disabled', () => {
    for (const items of [[], [canonical[5]!]]) expect(aggregateSentiment(items).score).toMatchObject({ favorableRate: null, mixedRate: null, unfavorableRate: null, interval: null, favorableDisplay: 'Unavailable' })
    expect(aggregateSentiment(canonical, { disabled: true })).toMatchObject({ state: 'disabled', score: { favorableRate: null, interval: null } })
  })
  it('keeps absent subjects and canceled work outside the judged denominator', () => {
    expect(aggregateSentiment([{ ...canonical[0]!, outcome: 'canceled' }])).toMatchObject({ state: 'canceled', coverage: { selected: 1, judged: 0, counts: { canceled: 1 } } })
    const result = aggregateSentiment([{ ...canonical[0]!, outcome: 'subject-not-mentioned' }, canonical[1]!])
    expect(result.coverage).toMatchObject({ selected: 2, judged: 1, subjectNotMentioned: 1, counts: { 'subject-not-mentioned': 1, unfavorable: 0 } })
    expect(result.score.favorableRate).toBe(1)
    const shared = [{ ...canonical[0]!, outcome: 'subject-not-mentioned' as const }, { ...canonical[1]!, sourceSnapshotId: canonical[0]!.sourceSnapshotId }]
    expect(aggregateSentiment([...shared, shared[0]!]).coverage).toMatchObject({ selected: 2, distinctSourceAnswers: 1, ratedAnswers: 1, subjectNotMentioned: 0 })
    expect(aggregateSentiment(shared, { disabled: true }).coverage.subjectNotMentioned).toBeNull()
  })
  it('pins the stance-only evaluator identity independently of answer text', () => {
    const definition = createSentimentEvaluationDefinition()
    const json = canonicalSentimentDefinitionJson(definition)
    expect(definition).toMatchObject({ schemaVersion: 2, verdictVersion: 'stance-v2', identityVersion: 'qualified-subject-v3', segmentationVersion: 'sentence-spans-v2' })
    expect(Object.keys(definition.questions)).toEqual(['identity', 'judgment', 'stance', 'conclusion', 'complaint'])
    expect(canonicalSentimentDefinitionJson({ ...definition, confidenceThreshold: 0.8 })).not.toBe(json)
    expect(json).not.toContain('sourceTextHash')
    expect(json).not.toContain('themes')
  })
  it('dispatches only definitions frozen under the pinned request template', () => {
    const current = createSentimentEvaluationDefinition()
    expect(hasCurrentSentimentTemplate(current)).toBe(true)
    // Tuning outside the template (a threshold) keeps the template; any version string does not.
    expect(hasCurrentSentimentTemplate({ ...current, confidenceThreshold: 0.8 })).toBe(true)
    for (const field of ['verdictVersion', 'identityVersion', 'evidenceVersion', 'segmentationVersion', 'preprocessingVersion'] as const) {
      expect(hasCurrentSentimentTemplate({ ...current, [field]: `${current[field]}-earlier` }), field).toBe(false)
    }
    expect(hasCurrentSentimentTemplate({ ...current, identityVersion: 'qualified-subject-v2', segmentationVersion: 'sentence-spans-v1' })).toBe(false)
    expect(hasCurrentSentimentTemplate({ ...current, schemaVersion: 1 })).toBe(false)
  })
  it('parses summary paging and job attempt paging as tuning beside the identity selection', () => {
    expect(sentimentSummaryRequestSchema.parse({ runId: 'r' })).toMatchObject({ runId: 'r', queryLimit: 25, queryClass: 'branded' })
    expect(sentimentSummaryRequestSchema.parse({ runId: 'r', include: 'assessments, locations', queryLimit: '500', executionNodeKey: 'node' })).toMatchObject({ include: ['assessments', 'locations'], queryLimit: 500, executionNodeKey: 'node' })
    expect(sentimentSummaryRequestSchema.parse({ include: ['locations'] }).include).toEqual(['locations'])
    for (const invalid of [{ include: 'answers' }, { queryLimit: 0 }, { queryLimit: 501 }, { runId: 'r', runIds: ['r'] }]) expect(sentimentSummaryRequestSchema.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false)
    expect(sentimentJobRequestSchema.parse({})).toEqual({ attemptLimit: 50 })
    expect(sentimentJobRequestSchema.safeParse({ attemptLimit: 201 }).success).toBe(false)
    const summary = { id: 'j', projectId: 'p', origin: 'automatic', state: 'complete', enablementEpoch: 1, evaluationDefinitionId: 'd', selection: { mode: 'auto', queryClass: 'branded', scope: 'project', runId: 'r' }, createdAt: 't', updatedAt: 't', counts: aggregateSentiment([]).coverage.counts, selected: 0, cancellationReason: null, attemptCount: 0 }
    expect(sentimentJobsSchema.parse({ jobs: [summary] }).jobs[0]).toEqual(summary)
    // The list never carries attempt receipts.
    expect(sentimentJobsSchema.safeParse({ jobs: [{ ...summary, attempts: [] }] }).success).toBe(false)
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
  it('accepts exact bounded run groups and rejects ambiguous or duplicate selectors', () => {
    expect(sentimentSelectionSchema.parse({ runIds: 'one' }).runIds).toEqual(['one'])
    expect(sentimentSelectionSchema.safeParse({ runId: 'one', runIds: ['two'] }).success).toBe(false)
    expect(sentimentSelectionSchema.safeParse({ runIds: ['one', 'one'] }).success).toBe(false)
    expect(sentimentCompareRequestSchema.safeParse({ fromRunId: 'one', toRunId: 'two', runIds: ['one', 'two'] }).success).toBe(false)
  })
  it('displays zero, full, small and rounded proportions honestly', () => {
    expect([null, 0, 1, 0.0004, 0.001, 0.0049, 0.01, 0.599, 199 / 200, 0.9996].map(sentimentRateDisplay))
      .toEqual(['Unavailable', '0%', '100%', '<0.1%', '0.1%', '0.5%', '1.0%', '59.9%', '99.5%', '>99.9%'])
  })
  it('rejects a judged classifier output without conclusion evidence', () => {
    expect(sentimentClassifierOutputSchema.safeParse({ kind: 'classified', outcome: 'favorable', conclusion: [], complaint: null, returnedModel: 'jev-1.13.0', usage: { kind: 'reported', inputTokens: 10, outputTokens: 0 }, confidence: null }).success).toBe(false)
  })
})
