import { createHmac, timingSafeEqual } from 'node:crypto'
import { and, desc, eq, inArray, ne } from 'drizzle-orm'
import {
  aggregateSentiment, AppError, canonicalSentimentJson, createSentimentEvaluationDefinition,
  emptySentimentCounts, notFound, SENTIMENT_INTERVAL_LIMITATION, SENTIMENT_MODEL,
  sentimentBackfillSelectionSchema, sentimentClassifierInputSchema, sentimentClassifierOutputSchema,
  sentimentEvaluationDefinitionSchema, sentimentJobSchema, sentimentOutcomeSchema,
  sentimentPresetThemes, sentimentSettingsUpdateSchema, sentimentThemesSchema,
  validationError, type SentimentBackfillPreview, type SentimentBackfillSelection, type SentimentClassifierInput,
  type SentimentComparison, type SentimentEvidenceItem, type SentimentJob, type SentimentResolvedSelection,
  type SentimentSelection, type SentimentSettings, type SentimentSummary,
} from '@ainyc/canonry-contracts'
import {
  measurementPlanVersions, runs, sentimentAttempts, sentimentDefinitions, sentimentJobItems, sentimentJobs,
  sentimentResults, sentimentWorkItems, SentimentIdempotencyConflict, SentimentRepository, type DatabaseClient,
} from '@ainyc/canonry-db'
import { selectSentimentSources, type SentimentSourceFilter } from './sentiment-source.js'
import { sentimentClassifierInput, sentimentHash } from './sentiment-input.js'

export interface SentimentInstallState { enabled: boolean; ready: boolean; reason: string | null; model: string }
export interface SentimentServiceOptions { install: () => SentimentInstallState; previewSecret: string; now?: () => Date; estimate?: (input: SentimentClassifierInput) => number }
type StoredItem = { work: typeof sentimentWorkItems.$inferSelect; result: typeof sentimentResults.$inferSelect | null; input: SentimentClassifierInput; evidence: SentimentEvidenceItem }
type PreviewToken = { projectId: string; selection: SentimentBackfillSelection; definitionId: string; fingerprint: string; expiresAt: string }
const DISCLOSURE = 'Experimental English sentiment classification. Enabling sends stored answer text and frozen subject identity to TypeSafe. Custom themes have not been evaluated.'

export class SentimentService {
  readonly repository: SentimentRepository
  constructor(readonly db: DatabaseClient, readonly options: SentimentServiceOptions) { this.repository = new SentimentRepository(db) }
  now(): string { return (this.options.now?.() ?? new Date()).toISOString() }
  settings(projectId: string, administrator = false): SentimentSettings {
    const install = this.options.install()
    const row = this.repository.getSettings(projectId)
    const configuration = sentimentSettingsUpdateSchema.safeParse(row?.configuration)
    const preset = configuration.success ? configuration.data.preset ?? 'default' : 'default'
    const custom = configuration.success ? configuration.data.customThemes ?? [] : []
    return {
      installEnabled: install.enabled, enabled: row?.enabled ?? false, ready: install.ready,
      readinessReasons: install.reason ? [install.reason] : [], model: install.model, enablementEpoch: row?.enablementEpoch ?? 0,
      completionBoundary: row?.completionBoundary ?? 0, preset,
      themes: sentimentThemesSchema.parse([...sentimentPresetThemes(preset), ...custom.map(theme => ({ ...theme, source: 'custom', evaluationStatus: 'custom-not-evaluated' }))]),
      evaluationDefinitionId: row?.evaluationDefinitionId ?? null,
      actions: { configure: administrator && install.enabled, backfill: administrator && install.ready && Boolean(row?.enabled) }, experimental: true, disclosure: DISCLOSURE,
    }
  }
  configure(projectId: string, value: unknown): SentimentSettings {
    const update = parse(sentimentSettingsUpdateSchema, value)
    const previous = this.settings(projectId, true)
    if (!previous.installEnabled) throw validationError('Sentiment is disabled in install configuration.')
    if ((update.enabled ?? previous.enabled) && !previous.ready) throw validationError('Sentiment provider is not ready.', { reasons: previous.readinessReasons })
    const prior = sentimentSettingsUpdateSchema.safeParse(this.repository.getSettings(projectId)?.configuration)
    const configuration = { enabled: update.enabled ?? previous.enabled, preset: update.preset ?? previous.preset, customThemes: update.customThemes ?? (prior.success ? prior.data.customThemes ?? [] : []) }
    const themes = parse(sentimentThemesSchema, [...sentimentPresetThemes(configuration.preset), ...configuration.customThemes.map(theme => ({ ...theme, source: 'custom', evaluationStatus: 'custom-not-evaluated' }))])
    const definition = createSentimentEvaluationDefinition(themes)
    const definitionId = sentimentHash(definition)
    this.repository.putDefinition({ id: definitionId, contentHash: definitionId, requestedModel: SENTIMENT_MODEL, definition, createdAt: this.now() })
    this.repository.configure({ projectId, enabled: configuration.enabled, evaluationDefinitionId: definitionId, configuration, now: this.now() })
    return this.settings(projectId, true)
  }
  private sign(value: unknown): string {
    const payload = Buffer.from(canonicalSentimentJson(value)).toString('base64url')
    return `${payload}.${createHmac('sha256', this.options.previewSecret).update(payload).digest('base64url')}`
  }
  private verify<T>(token: string): T {
    const [payload, signature, extra] = token.split('.')
    if (!payload || !signature || extra) throw validationError('Invalid sentiment token.')
    const expected = createHmac('sha256', this.options.previewSecret).update(payload).digest()
    const actual = Buffer.from(signature, 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw validationError('Invalid sentiment token.')
    try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T } catch { throw validationError('Invalid sentiment token.') }
  }
  preview(projectId: string, value: unknown): SentimentBackfillPreview {
    const selection = parse(sentimentBackfillSelectionSchema, value)
    if (!selection.runId && !selection.runIds && !(selection.from && selection.to)) throw validationError('Backfill requires explicit runs or a bounded from/to date range.')
    if (selection.from && selection.to && selection.from > selection.to) throw validationError('Backfill from must be before to.')
    if (selection.queryClass !== 'branded') throw validationError('Non-brand sentiment is not supported.')
    const settings = this.settings(projectId)
    const source = selectSentimentSources(this.db, projectId, sourceFilter(selection))
    const frozenSelection = { ...selection, runIds: source.runIds }
    const definitionId = settings.evaluationDefinitionId
    const definition = definitionId ? this.definition(definitionId) : null
    const inputs = definition ? source.assessments.map(item => sentimentClassifierInput(item, definition)) : []
    const existing = this.db.select({ work: sentimentWorkItems }).from(sentimentWorkItems).innerJoin(sentimentResults, eq(sentimentResults.workItemId, sentimentWorkItems.id)).where(and(eq(sentimentWorkItems.projectId, projectId), definitionId ? eq(sentimentWorkItems.evaluationDefinitionId, definitionId) : undefined)).all()
    const completed = new Set(existing.map(({ work }) => `${work.snapshotId}:${work.sourceTextHash}:${work.subjectHash}`))
    const alreadyClassified = inputs.filter(input => completed.has(`${input.sourceSnapshotId}:${input.sourceTextHash}:${input.subjectHash}`)).length
    const estimatedInputTokens = this.options.estimate ? inputs.reduce((sum, input) => sum + this.options.estimate!(input), 0) : 0
    const expiresAt = new Date(Date.parse(this.now()) + 15 * 60_000).toISOString()
    const previewToken = definitionId && settings.enabled && settings.ready ? this.sign({ projectId, selection: frozenSelection, definitionId, fingerprint: sentimentHash(source.assessments), expiresAt } satisfies PreviewToken) : null
    const skipped = source.runIds.flatMap(runId => {
      const single = selectSentimentSources(this.db, projectId, { ...sourceFilter(selection), runIds: [runId] })
      return Object.entries(single.skipped).map(([reason, count]) => ({ runId, reason, count }))
    })
    return { previewToken, expiresAt: previewToken ? expiresAt : null, selection: frozenSelection, evaluationDefinitionId: definitionId, eligibleAssessments: source.assessments.length, alreadyClassified, skipped, estimatedInputTokens, estimatedCostUsd: null, estimateMethod: this.options.estimate ? 'Adapter estimate of the full request including all questions and evidence candidates; final billed usage is recorded per attempt.' : 'Token and cost estimates unavailable on this host.' }
  }
  submit(projectId: string, previewToken: string, idempotencyKey: string, actor: string): SentimentJob {
    const payloadHash = sentimentHash({ previewToken })
    // Receipt replay precedes expiry and enablement checks after caller authorization.
    try {
      const prior = this.repository.lookupJob(projectId, 'backfill', idempotencyKey, payloadHash)
      if (prior) return this.job(projectId, prior.id)
    } catch (error) { if (error instanceof SentimentIdempotencyConflict) throw new AppError('ALREADY_EXISTS', 'Idempotency key was used with a different sentiment request.', 409); throw error }
    const token = this.verify<PreviewToken>(previewToken)
    if (token.projectId !== projectId) throw validationError('Preview belongs to a different project.')
    if (token.expiresAt <= this.now()) throw validationError('Sentiment preview expired; create a fresh preview.')
    const settings = this.settings(projectId)
    if (!settings.enabled || !settings.ready) throw validationError('Sentiment must be enabled and ready before backfill.')
    if (settings.evaluationDefinitionId !== token.definitionId) throw validationError('Sentiment configuration changed; create a fresh preview.')
    const source = selectSentimentSources(this.db, projectId, sourceFilter(token.selection))
    if (sentimentHash(source.assessments) !== token.fingerprint) throw validationError('Stored source selection changed; create a fresh preview.')
    const definition = this.definition(token.definitionId)
    const row = this.repository.admitJob({ projectId, action: 'backfill', origin: 'backfill', enablementEpoch: settings.enablementEpoch, evaluationDefinitionId: token.definitionId, idempotencyKey, payloadHash, selection: token.selection, actor, now: this.now(), allowReplayCanceled: true,
      work: source.assessments.map(item => { const input = sentimentClassifierInput(item, definition); return { runId: item.runId, snapshotId: item.snapshotId, sourceTextHash: input.sourceTextHash, subjectHash: input.subjectHash, input, edges: item.edges } }),
    })
    return this.job(projectId, row.id)
  }
  definition(id: string) {
    const row = this.db.select().from(sentimentDefinitions).where(eq(sentimentDefinitions.id, id)).get()
    if (!row) throw notFound('Sentiment definition', id)
    return sentimentEvaluationDefinitionSchema.parse(row.definition)
  }
  jobs(projectId: string): { jobs: SentimentJob[] } {
    return { jobs: this.db.select({ id: sentimentJobs.id }).from(sentimentJobs).where(eq(sentimentJobs.projectId, projectId)).orderBy(desc(sentimentJobs.createdAt)).limit(100).all().map(row => this.job(projectId, row.id)) }
  }
  job(projectId: string, jobId: string): SentimentJob {
    const row = this.repository.getJob(projectId, jobId)
    if (!row) throw notFound('Sentiment job', jobId)
    const items = this.db.select({ item: sentimentJobItems, work: sentimentWorkItems, result: sentimentResults }).from(sentimentJobItems).innerJoin(sentimentWorkItems, eq(sentimentWorkItems.id, sentimentJobItems.workItemId)).leftJoin(sentimentResults, eq(sentimentResults.workItemId, sentimentWorkItems.id)).where(and(eq(sentimentJobItems.projectId, projectId), eq(sentimentJobItems.jobId, jobId))).all()
    const counts = emptySentimentCounts()
    for (const { item, work, result } of items) counts[item.canceledAt ? 'canceled' : outcome(work.status, result?.outcome)]++
    const attempts = items.length ? this.db.select().from(sentimentAttempts).where(and(eq(sentimentAttempts.projectId, projectId), inArray(sentimentAttempts.workItemId, items.map(item => item.work.id)))).all() : []
    return sentimentJobSchema.parse({ id: row.id, projectId: row.projectId, origin: row.origin, state: row.state, enablementEpoch: row.enablementEpoch, evaluationDefinitionId: row.evaluationDefinitionId, selection: row.selection, createdAt: row.createdAt, updatedAt: row.updatedAt, cancellationReason: row.cancellationReason, counts, selected: items.length, attempts: attempts.map(attempt => ({ id: attempt.id, workItemId: attempt.workItemId, dispatchedAt: attempt.dispatchedAt, completedAt: attempt.completedAt, returnedModel: attempt.returnedModel, usage: { kind: attempt.usageStatus, inputTokens: attempt.usage?.inputTokens ?? null, outputTokens: attempt.usage?.outputTokens ?? null }, errorCode: attempt.safeFailure })) })
  }
  private resolve(projectId: string, selection: SentimentSelection): SentimentResolvedSelection {
    const run = selection.runId ? this.db.select().from(runs).where(and(eq(runs.id, selection.runId), eq(runs.projectId, projectId))).get() : this.db.select().from(runs).where(and(eq(runs.projectId, projectId), eq(runs.kind, 'answer-visibility'), ne(runs.trigger, 'probe'))).orderBy(desc(runs.createdAt)).get()
    if (selection.runId && !run) throw notFound('Run', selection.runId)
    const source = run ? selectSentimentSources(this.db, projectId, { ...sourceFilter(selection), runId: run.id }) : null
    const allowedSubjects = new Set(source?.assessments.map(item => `${item.snapshotId}:${item.subject.key}`) ?? [])
    const latest = run ? this.db.select({ definitionId: sentimentWorkItems.evaluationDefinitionId, input: sentimentWorkItems.input }).from(sentimentWorkItems)
      .innerJoin(sentimentJobItems, eq(sentimentJobItems.workItemId, sentimentWorkItems.id)).innerJoin(sentimentJobs, eq(sentimentJobs.id, sentimentJobItems.jobId))
      .where(and(eq(sentimentWorkItems.projectId, projectId), eq(sentimentWorkItems.runId, run.id))).orderBy(desc(sentimentJobs.createdAt)).all()
      .find(row => { const input = sentimentClassifierInputSchema.parse(row.input); return allowedSubjects.has(`${input.sourceSnapshotId}:${input.subject.id}`) }) : undefined
    const revision = run?.measurementPlanVersionId ? this.db.select({ revision: measurementPlanVersions.revision }).from(measurementPlanVersions).where(eq(measurementPlanVersions.id, run.measurementPlanVersionId)).get()?.revision ?? null : null
    return { ...selection, runId: run?.id ?? null, revision: selection.revision ?? revision, mode: run?.measurementPlanVersionId ? 'advanced' : 'simple', evaluationDefinitionId: selection.evaluationDefinitionId ?? latest?.definitionId ?? null }
  }
  private items(projectId: string, selection: SentimentResolvedSelection): StoredItem[] {
    if (!selection.runId || !selection.evaluationDefinitionId || selection.queryClass !== 'branded') return []
    const source = selectSentimentSources(this.db, projectId, sourceFilter({ ...selection, runId: selection.runId, evaluationDefinitionId: selection.evaluationDefinitionId, revision: selection.revision ?? undefined }))
    const allowed = new Set(source.assessments.map(item => { const input = sentimentClassifierInput(item, this.definition(selection.evaluationDefinitionId!)); return `${item.snapshotId}:${input.sourceTextHash}:${input.subjectHash}` }))
    return this.db.select({ work: sentimentWorkItems, result: sentimentResults }).from(sentimentWorkItems).leftJoin(sentimentResults, eq(sentimentResults.workItemId, sentimentWorkItems.id)).where(and(eq(sentimentWorkItems.projectId, projectId), eq(sentimentWorkItems.runId, selection.runId), eq(sentimentWorkItems.evaluationDefinitionId, selection.evaluationDefinitionId))).all().flatMap(({ work, result }) => {
      if (!allowed.has(`${work.snapshotId}:${work.sourceTextHash}:${work.subjectHash}`)) return []
      const input = sentimentClassifierInputSchema.parse(work.input)
      const classification = result ? sentimentClassifierOutputSchema.parse(result.result) : null
      const evidence: SentimentEvidenceItem = { assessmentId: work.id, runId: work.runId, sourceSnapshotId: work.snapshotId, sourceText: input.sourceText, sourceTextHash: work.sourceTextHash, subject: input.subject, subjectHash: work.subjectHash, context: input.context, evaluationDefinitionId: work.evaluationDefinitionId, outcome: outcome(work.status, result?.outcome), conclusion: classification?.kind === 'classified' ? classification.conclusion : [], complaint: classification?.kind === 'classified' ? classification.complaint : null, themes: classification && classification.kind !== 'failed' ? classification.themes : [], returnedModel: result?.returnedModel ?? null, reason: work.cancellationReason ?? work.errorCode ?? (classification?.kind === 'abstained' ? classification.reason : null) }
      return [{ work, result, input, evidence }]
    })
  }
  private aggregate(projectId: string, selection: SentimentResolvedSelection, items: StoredItem[]): SentimentSummary {
    const settings = this.settings(projectId)
    const definition = selection.evaluationDefinitionId ? this.definition(selection.evaluationDefinitionId) : null
    const source = selection.runId ? selectSentimentSources(this.db, projectId, { ...sourceFilter(selection), runId: selection.runId }) : null
    const options = { disabled: !settings.enabled || !settings.installEnabled, expectedProviderSlots: source?.sourceCoverage.expected ?? 0, completedProviderSlots: source?.sourceCoverage.completed ?? 0 }
    const aggregates = items.map(item => ({ assessmentId: item.work.id, sourceSnapshotId: item.work.snapshotId, outcome: item.evidence.outcome, themes: item.evidence.themes }))
    const summary = aggregateSentiment(aggregates, definition?.themes, options)
    const breakdowns: SentimentSummary['breakdowns'] = []
    for (const dimension of ['provider', 'property', 'market'] as const) {
      const groups = new Map<string, StoredItem[]>()
      for (const item of items) {
        const keys = dimension === 'provider' ? [item.input.context.provider] : dimension === 'property' ? [item.input.subject.id] : item.input.context.usageEdges.flatMap(edge => edge.marketId ? [edge.marketId] : [])
        for (const key of new Set(keys)) groups.set(key, [...(groups.get(key) ?? []), item])
      }
      for (const [key, selected] of groups) { const result = aggregateSentiment(selected.map(item => ({ assessmentId: item.work.id, sourceSnapshotId: item.work.snapshotId, outcome: item.evidence.outcome, themes: item.evidence.themes })), [], options); breakdowns.push({ dimension, key, label: dimension === 'property' ? selected[0]!.input.subject.displayName : key, coverage: result.coverage, score: result.score }) }
    }
    return { ...summary, ...(selection.queryClass !== 'branded' ? { state: 'unsupported' as const } : {}), reason: options.disabled ? 'Sentiment is disabled.' : selection.queryClass !== 'branded' ? 'Non-brand sentiment is not supported.' : source?.skipped['incomplete-run'] ? 'Source sweep is incomplete.' : null, selection, evaluationDefinition: definition, breakdowns }
  }
  summary(projectId: string, query: SentimentSelection): SentimentSummary { const selection = this.resolve(projectId, query); return this.aggregate(projectId, selection, this.items(projectId, selection)) }
  evidence(projectId: string, query: SentimentSelection, limit: number, cursor?: string) {
    const selection = this.resolve(projectId, query)
    let after = ''
    if (cursor) { const token = this.verify<{ projectId: string; selection: SentimentResolvedSelection; after: string }>(cursor); if (token.projectId !== projectId || sentimentHash(token.selection) !== sentimentHash(selection)) throw validationError('Evidence cursor does not match the resolved selection.'); after = token.after }
    const all = this.items(projectId, selection)
    const items = all.sort((a, b) => a.work.id.localeCompare(b.work.id)).filter(item => item.work.id > after)
    const page = items.slice(0, limit)
    return { state: this.aggregate(projectId, selection, all).state, selection, items: page.map(item => item.evidence), nextCursor: items.length > limit ? this.sign({ projectId, selection, after: page.at(-1)!.work.id }) : null }
  }
  compare(projectId: string, query: SentimentSelection, fromRunId: string, toRunId: string): SentimentComparison {
    const fromSelection = this.resolve(projectId, { ...query, runId: fromRunId }), toSelection = this.resolve(projectId, { ...query, runId: toRunId })
    const fromItems = this.items(projectId, fromSelection), toItems = this.items(projectId, toSelection)
    const unit = (item: StoredItem) => sentimentHash({ query: item.input.context.queryId, queryText: item.input.context.queryText, provider: item.input.context.provider, subject: item.input.subject, context: item.input.context.locationContext, language: item.input.language, usageEdges: item.input.context.usageEdges })
    const fromKeys = new Set(fromItems.map(unit)), toKeys = new Set(toItems.map(unit))
    const common = new Set([...fromKeys].filter(key => toKeys.has(key)))
    const from = this.aggregate(projectId, fromSelection, fromItems.filter(item => common.has(unit(item))))
    const to = this.aggregate(projectId, toSelection, toItems.filter(item => common.has(unit(item))))
    const refusalReasons: string[] = []
    const expectedFrom = selectSentimentSources(this.db, projectId, { ...sourceFilter(fromSelection), runId: fromRunId }).assessments.length
    const expectedTo = selectSentimentSources(this.db, projectId, { ...sourceFilter(toSelection), runId: toRunId }).assessments.length
    if (fromItems.length < expectedFrom || toItems.length < expectedTo) refusalReasons.push('classification-coverage-gap')
    if (fromSelection.evaluationDefinitionId !== toSelection.evaluationDefinitionId) refusalReasons.push('evaluation-definition-changed')
    if (from.state !== 'complete' || to.state !== 'complete') refusalReasons.push('incomplete-classification')
    if (!common.size || !from.coverage.judged || !to.coverage.judged) refusalReasons.push('insufficient-judgments')
    const changedScope = common.size !== fromKeys.size || common.size !== toKeys.size
    if (changedScope) refusalReasons.push('source-scope-changed')
    for (const key of common) {
      const left = fromItems.find(item => unit(item) === key)!, right = toItems.find(item => unit(item) === key)!
      if (!left.input.context.requestedModel || !left.input.context.servedModel || !right.input.context.requestedModel || !right.input.context.servedModel) refusalReasons.push('missing-source-model-provenance')
      else if (left.input.context.requestedModel !== right.input.context.requestedModel || left.input.context.servedModel !== right.input.context.servedModel) refusalReasons.push('source-model-changed')
      if (!left.evidence.returnedModel || left.evidence.returnedModel !== right.evidence.returnedModel) refusalReasons.push('classifier-model-changed')
    }
    const intervalFrom = from.score.interval, intervalTo = to.score.interval
    const verdict = refusalReasons.length || !intervalFrom || !intervalTo ? null : intervalTo.low > intervalFrom.high ? 'improved' : intervalTo.high < intervalFrom.low ? 'declined' : 'no-clear-change'
    return { from, to, verdict, favorableRateDelta: verdict && from.score.favorableRate !== null && to.score.favorableRate !== null ? to.score.favorableRate - from.score.favorableRate : null, refusalReasons: [...new Set(refusalReasons)], commonUnits: common.size, excludedFrom: expectedFrom - from.coverage.selected, excludedTo: expectedTo - to.coverage.selected, changedScope, method: 'wilson-independent-v1', limitation: SENTIMENT_INTERVAL_LIMITATION }
  }
}
function sourceFilter(selection: Partial<SentimentBackfillSelection> | SentimentResolvedSelection): SentimentSourceFilter {
  const extra = selection as Partial<SentimentBackfillSelection>
  return { mode: selection.mode, runId: selection.runId ?? undefined, runIds: extra.runIds, since: extra.from, until: extra.to, revision: selection.revision ?? undefined, queryClass: selection.queryClass, scope: selection.scope, scopeKey: selection.scopeKey, marketKey: selection.marketKey, provider: selection.provider, sourceModel: selection.model, location: selection.location }
}
function outcome(status: string, result?: string) { return sentimentOutcomeSchema.parse(status === 'completed' ? result ?? 'failed' : status) }
function parse<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown } } }, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw validationError('Invalid sentiment request.', { issues: result.error.issues }); return result.data }
export { parse as parseSentimentRequest }
