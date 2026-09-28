import { createHmac, timingSafeEqual } from 'node:crypto'
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import {
  aggregateSentiment, AppError, canonicalSentimentJson, createSentimentEvaluationDefinition,
  emptySentimentCounts, notFound, SENTIMENT_INTERVAL_LIMITATION, SENTIMENT_MODEL,
  sentimentBackfillSelectionSchema, storedSentimentClassifierInputSchema, storedSentimentClassifierOutputSchema,
  storedSentimentEvaluationDefinitionSchema, sentimentJobSchema, sentimentOutcomeSchema, sentimentSettingsUpdateSchema,
  validationError, type SentimentBackfillPreview, type SentimentBackfillSelection, type SentimentClassifierInput,
  type SentimentComparison, type SentimentEvidenceItem, type SentimentJob, type SentimentResolvedSelection,
  type SentimentSelection, type SentimentSettings, type SentimentSummary, type SentimentOverview,
} from '@ainyc/canonry-contracts'
import {
  measurementPlanVersions, querySnapshots, runs, sentimentAttempts, sentimentDefinitions, sentimentJobItems, sentimentJobs,
  sentimentResults, sentimentWorkItems, SentimentIdempotencyConflict, SentimentRepository, type DatabaseClient,
} from '@ainyc/canonry-db'
import { matchesSentimentEdge, selectSentimentSources, type SentimentSourceAssessment, type SentimentSourceEdge, type SentimentSourceSelection, type SentimentSourceFilter } from './sentiment-source.js'
import { sentimentClassifierInput, sentimentHash } from './sentiment-input.js'

export interface SentimentInstallState { enabled: boolean; ready: boolean; reason: string | null; model: string }
export interface SentimentServiceOptions { install: () => SentimentInstallState; previewSecret: string; now?: () => Date; estimate?: (input: SentimentClassifierInput) => number }
type StoredItem = { edges: SentimentSourceEdge[]; work: typeof sentimentWorkItems.$inferSelect; result: typeof sentimentResults.$inferSelect | null; input: SentimentClassifierInput; evidence: SentimentEvidenceItem }
type PreviewToken = { projectId: string; selection: SentimentBackfillSelection; definitionId: string; fingerprint: string; expiresAt: string }
const DISCLOSURE = 'Experimental English sentiment classification. Enabling sends stored answer text and frozen subject identity to TypeSafe.'

export class SentimentService {
  readonly repository: SentimentRepository
  constructor(readonly db: DatabaseClient, readonly options: SentimentServiceOptions) { this.repository = new SentimentRepository(db) }
  now(): string { return (this.options.now?.() ?? new Date()).toISOString() }
  settings(projectId: string, administrator = false): SentimentSettings {
    const install = this.options.install()
    const row = this.repository.getSettings(projectId)
    const supportedDefinition = !row || this.definition(row.evaluationDefinitionId).schemaVersion === 2
    const ready = install.ready && supportedDefinition
    return {
      installEnabled: install.enabled, enabled: row?.enabled ?? false, ready,
      readinessReasons: [...(install.reason ? [install.reason] : []), ...(!supportedDefinition ? ['unsupported-evaluator-definition: configure sentiment again to use the current evaluator.'] : [])], model: install.model, enablementEpoch: row?.enablementEpoch ?? 0,
      completionBoundary: row?.completionBoundary ?? 0,
      evaluationDefinitionId: row?.evaluationDefinitionId ?? null,
      actions: { configure: administrator && install.enabled, backfill: administrator && ready && Boolean(row?.enabled) }, experimental: true, disclosure: DISCLOSURE,
    }
  }
  configure(projectId: string, value: unknown, actor = 'system'): SentimentSettings {
    const update = parse(sentimentSettingsUpdateSchema, value)
    const previous = this.settings(projectId, true)
    if (!previous.installEnabled) throw validationError('Sentiment is disabled in install configuration.')
    if ((update.enabled ?? previous.enabled) && !this.options.install().ready) throw validationError('Sentiment provider is not ready.', { reasons: previous.readinessReasons })
    const configuration = { enabled: update.enabled ?? previous.enabled }
    const definition = createSentimentEvaluationDefinition()
    const definitionId = sentimentHash(definition)
    this.repository.putDefinition({ id: definitionId, contentHash: definitionId, requestedModel: SENTIMENT_MODEL, definition, createdAt: this.now() })
    this.repository.configure({ projectId, enabled: configuration.enabled, evaluationDefinitionId: definitionId, configuration, actor, now: this.now(), forceNewEpoch: Boolean(previous.evaluationDefinitionId && this.definition(previous.evaluationDefinitionId).schemaVersion !== definition.schemaVersion) })
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
    const settings = this.settings(projectId)
    const source = selectSentimentSources(this.db, projectId, sourceFilter(selection))
    const frozenSelection = { ...selection, ...(selection.runId ? { runId: source.runIds[0]! } : { runIds: source.runIds }) }
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
    return { previewToken, expiresAt: previewToken ? expiresAt : null, selection: frozenSelection, evaluationDefinitionId: definitionId, eligibleAssessments: source.assessments.length, alreadyClassified, skipped, estimatedInputTokens, estimatedCostUsd: this.options.estimate ? estimatedInputTokens * 0.042 / 1_000_000 : null, estimateMethod: this.options.estimate ? 'Adapter estimate of the full request including all questions and evidence candidates; final billed usage is recorded per attempt.' : 'Token and cost estimates unavailable on this host.' }
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
    return storedSentimentEvaluationDefinitionSchema.parse(row.definition)
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
    // Legacy previews persisted both selectors; their source resolver gave runIds
    // precedence. Project the receipt on read without rewriting its stored JSON.
    let selection = row.selection
    if (selection && typeof selection === 'object' && 'runId' in selection && 'runIds' in selection && Array.isArray(selection.runIds) && selection.runIds.length) {
      selection = selection.runIds.length === 1 && selection.runIds[0] === selection.runId ? { ...selection, runIds: undefined } : { ...selection, runId: undefined }
    }
    return sentimentJobSchema.parse({ id: row.id, projectId: row.projectId, origin: row.origin, state: row.state, enablementEpoch: row.enablementEpoch, evaluationDefinitionId: row.evaluationDefinitionId, selection, createdAt: row.createdAt, updatedAt: row.updatedAt, cancellationReason: row.cancellationReason, counts, selected: items.length, attempts: attempts.map(attempt => ({ id: attempt.id, workItemId: attempt.workItemId, dispatchedAt: attempt.dispatchedAt, completedAt: attempt.completedAt, returnedModel: attempt.returnedModel, usage: { kind: attempt.usageStatus, inputTokens: attempt.usage?.inputTokens ?? null, outputTokens: attempt.usage?.outputTokens ?? null }, errorCode: attempt.safeFailure })) })
  }
  private resolve(projectId: string, selection: SentimentSelection): SentimentResolvedSelection {
    if (selection.runId && selection.runIds) throw validationError('Choose runId or runIds, not both.')
    if (selection.scope !== 'project' && !selection.scopeKey) throw validationError('A scopeKey is required for property, group, and market sentiment selections.')
    if (selection.evaluationDefinitionId && this.repository.getSettings(projectId)?.evaluationDefinitionId !== selection.evaluationDefinitionId) {
      const admitted = this.db.select({ id: sentimentWorkItems.id }).from(sentimentWorkItems).where(and(eq(sentimentWorkItems.projectId, projectId), eq(sentimentWorkItems.evaluationDefinitionId, selection.evaluationDefinitionId))).get()
      if (!admitted) throw notFound('Sentiment definition', selection.evaluationDefinitionId)
    }
    const conditions = [eq(runs.projectId, projectId), eq(runs.kind, 'answer-visibility'), ne(runs.trigger, 'probe')]
    if (selection.mode === 'simple') conditions.push(isNull(runs.measurementPlanVersionId))
    if (selection.mode === 'advanced') conditions.push(isNotNull(runs.measurementPlanVersionId))
    if (selection.revision !== undefined) {
      const version = this.db.select({ id: measurementPlanVersions.id }).from(measurementPlanVersions).where(and(eq(measurementPlanVersions.projectId, projectId), eq(measurementPlanVersions.revision, selection.revision))).get()
      conditions.push(eq(runs.measurementPlanVersionId, version?.id ?? '__missing-revision__'))
    }
    if (selection.provider || selection.model || selection.location) {
      conditions.push(inArray(runs.id, this.db.select({ runId: querySnapshots.runId }).from(querySnapshots).where(and(selection.provider ? eq(querySnapshots.provider, selection.provider) : undefined, selection.model ? eq(querySnapshots.servedModel, selection.model) : undefined, selection.location ? selection.location === 'none' ? isNull(querySnapshots.location) : eq(querySnapshots.location, selection.location) : undefined))))
    }
    const run = selection.runId ? this.db.select().from(runs).where(and(eq(runs.id, selection.runId), eq(runs.projectId, projectId))).get() : this.db.select().from(runs).where(and(...conditions)).orderBy(desc(runs.createdAt)).get()
    if (selection.runId && !run) throw notFound('Run', selection.runId)
    const source = run ? selectSentimentSources(this.db, projectId, { ...sourceFilter(selection), runId: run.id }) : null
    const allowedSubjects = new Set(source?.assessments.map(item => `${item.snapshotId}:${item.subject.key}`) ?? [])
    const latest = run ? this.db.select({ definitionId: sentimentWorkItems.evaluationDefinitionId, input: sentimentWorkItems.input }).from(sentimentWorkItems)
      .innerJoin(sentimentJobItems, eq(sentimentJobItems.workItemId, sentimentWorkItems.id)).innerJoin(sentimentJobs, eq(sentimentJobs.id, sentimentJobItems.jobId))
      .where(and(eq(sentimentWorkItems.projectId, projectId), eq(sentimentWorkItems.runId, run.id))).orderBy(desc(sentimentJobs.createdAt), sql`${sentimentJobs}.rowid desc`).all()
      .find(row => { const input = storedSentimentClassifierInputSchema.parse(row.input); return allowedSubjects.has(`${input.sourceSnapshotId}:${input.subject.id}`) }) : undefined
    const revision = run?.measurementPlanVersionId ? this.db.select({ revision: measurementPlanVersions.revision }).from(measurementPlanVersions).where(eq(measurementPlanVersions.id, run.measurementPlanVersionId)).get()?.revision ?? null : null
    return { ...selection, runId: run?.id ?? null, runIds: undefined, revision: selection.revision ?? revision, mode: run?.measurementPlanVersionId ? 'advanced' : 'simple', evaluationDefinitionId: selection.evaluationDefinitionId ?? latest?.definitionId ?? null }
  }
  private sources(projectId: string, selection: SentimentResolvedSelection): SentimentSourceSelection {
    return selection.runId ? selectSentimentSources(this.db, projectId, { ...sourceFilter(selection), runIds: undefined }) : { assessments: [], runIds: [], sourceCoverage: { expected: 0, completed: 0 }, skipped: {} }
  }
  private items(projectId: string, selection: SentimentResolvedSelection, source = this.sources(projectId, selection)): StoredItem[] {
    if (!selection.runId || !selection.evaluationDefinitionId) return []
    const definition = this.definition(selection.evaluationDefinitionId)
    const allowed = new Map(source.assessments.map(item => { const input = sentimentClassifierInput(item, definition); return [`${item.snapshotId}:${input.sourceTextHash}:${input.subjectHash}`, item] }))
    return this.db.select({ work: sentimentWorkItems, result: sentimentResults }).from(sentimentWorkItems).leftJoin(sentimentResults, eq(sentimentResults.workItemId, sentimentWorkItems.id)).where(and(eq(sentimentWorkItems.projectId, projectId), eq(sentimentWorkItems.runId, selection.runId), eq(sentimentWorkItems.evaluationDefinitionId, selection.evaluationDefinitionId))).all().flatMap(({ work, result }) => {
      const member = allowed.get(`${work.snapshotId}:${work.sourceTextHash}:${work.subjectHash}`)
      if (!member) return []
      const input = storedSentimentClassifierInputSchema.parse(work.input)
      const edges = member.edges.filter(edge => matchesSentimentEdge(edge, sourceFilter(selection)))
      const primary = edges[0]!
      // Reads project only the selected usage edges; the canonical frozen input retains all of them.
      const projected = sentimentClassifierInput({ ...member, edges }, definition).context
      const context = { ...input.context, ...projected, queryText: primary.queryText }
      const classification = result ? storedSentimentClassifierOutputSchema.parse(result.result) : null
      const evidence: SentimentEvidenceItem = { assessmentId: work.id, runId: work.runId, sourceSnapshotId: work.snapshotId, sourceText: input.sourceText, sourceTextHash: work.sourceTextHash, subject: input.subject, subjectHash: work.subjectHash, context, evaluationDefinitionId: work.evaluationDefinitionId, outcome: outcome(work.status, result?.outcome), conclusion: classification?.kind === 'classified' ? classification.conclusion : [], complaint: classification?.kind === 'classified' ? classification.complaint : null, returnedModel: result?.returnedModel ?? null, reason: work.cancellationReason ?? work.errorCode ?? (classification?.kind === 'abstained' ? classification.reason : null) }
      return [{ work, result, input, evidence, edges }]
    })
  }
  private aggregate(projectId: string, selection: SentimentResolvedSelection, items: StoredItem[], source = this.sources(projectId, selection)): SentimentSummary {
    const settings = this.settings(projectId)
    const definition = selection.evaluationDefinitionId ? this.definition(selection.evaluationDefinitionId) : null
    const disabled = !settings.enabled || !settings.installEnabled
    const aggregate = (selected: StoredItem[], eligible: SentimentSourceAssessment[], slots = { expected: new Set(eligible.map(item => item.snapshotId)).size, completed: new Set(eligible.map(item => item.snapshotId)).size }) => {
      const result = aggregateSentiment(selected.map(item => ({ assessmentId: item.work.id, sourceSnapshotId: item.work.snapshotId, outcome: item.evidence.outcome })), { disabled, eligibleAssessments: eligible.length, expectedProviderSlots: slots.expected, completedProviderSlots: slots.completed })
      const gap = selected.length > 0 && selected.length < eligible.length
      return { ...result, ...((gap || source.skipped['incomplete-run']) && !disabled ? { state: selected.length ? 'partial' as const : 'not-measured' as const, provisional: true } : {}), reason: disabled ? 'Sentiment is disabled.' : source.skipped['incomplete-run'] ? 'Source sweep is incomplete.' : gap ? 'classification-coverage-gap: some source assessments have not been admitted.' : null }
    }
    const selectedEdges = (item: SentimentSourceAssessment) => item.edges.filter(edge => matchesSentimentEdge(edge, sourceFilter(selection)))
    const breakdowns: SentimentSummary['breakdowns'] = []
    for (const dimension of ['provider', 'property', 'market'] as const) {
      const edgeKeys = (edge: SentimentSourceEdge) => dimension === 'provider' ? [edge.provider] : dimension === 'property' ? [edge.propertyKey] : edge.marketKeys
      const eligible = new Map<string, SentimentSourceAssessment[]>()
      const measured = new Map<string, StoredItem[]>()
      for (const item of source.assessments) for (const key of new Set(selectedEdges(item).flatMap(edgeKeys))) eligible.set(key, [...(eligible.get(key) ?? []), item])
      for (const item of items) for (const key of new Set(item.edges.flatMap(edgeKeys))) measured.set(key, [...(measured.get(key) ?? []), item])
      for (const [key, members] of eligible) breakdowns.push({ ...aggregate(measured.get(key) ?? [], members), dimension, key, label: dimension === 'property' ? members[0]!.subject.name : key, queryClass: selection.queryClass })
    }
    // Build all query and location baskets in one pass; never issue one read per query.
    const queries = new Map<string, { queryText: string; eligible: SentimentSourceAssessment[]; measured: StoredItem[] }>()
    for (const item of source.assessments) for (const edge of new Map(selectedEdges(item).map(edge => [edge.queryKey, edge])).values()) {
      const group = queries.get(edge.queryKey) ?? { queryText: edge.queryText, eligible: [], measured: [] }
      group.eligible.push(item); queries.set(edge.queryKey, group)
    }
    for (const item of items) for (const key of new Set(item.edges.map(edge => edge.queryKey))) queries.get(key)?.measured.push(item)
    const queryRows: SentimentSummary['queries'] = [...queries].map(([queryId, group]) => {
      const eligibleByLocation = new Map<string | null, SentimentSourceAssessment[]>()
      const measuredByLocation = new Map<string | null, StoredItem[]>()
      for (const item of group.eligible) for (const location of new Set(selectedEdges(item).filter(edge => edge.queryKey === queryId).map(edge => edge.context?.label ?? null))) eligibleByLocation.set(location, [...(eligibleByLocation.get(location) ?? []), item])
      for (const item of group.measured) for (const location of new Set(item.edges.filter(edge => edge.queryKey === queryId).map(edge => edge.context?.label ?? null))) measuredByLocation.set(location, [...(measuredByLocation.get(location) ?? []), item])
      const sourceSnapshotIds = [...new Set(group.eligible.map(item => item.snapshotId))].sort()
      const result = aggregate(group.measured, group.eligible)
      breakdowns.push({ ...result, dimension: 'query', key: queryId, label: group.queryText, queryClass: selection.queryClass })
      return { ...result, queryId, queryText: group.queryText, queryClass: selection.queryClass, sourceSnapshotIds, locations: [...eligibleByLocation].map(([location, eligible]) => ({ ...aggregate(measuredByLocation.get(location) ?? [], eligible), location, sourceSnapshotIds: [...new Set(eligible.map(item => item.snapshotId))].sort() })) }
    })
    return { ...aggregate(items, source.assessments, source.sourceCoverage), configured: settings.enabled && settings.installEnabled, selection, evaluationDefinition: definition, breakdowns, queries: queryRows }
  }
  private readSelection(projectId: string, query: SentimentSelection) {
    if (query.runId && query.runIds) throw validationError('Choose runId or runIds, not both.')
    const requested = query.runIds ? [...new Set(query.runIds)].sort() : undefined
    const selections = requested ? requested.map(runId => this.resolve(projectId, { ...query, runIds: undefined, runId })) : [this.resolve(projectId, query)]
    const sources = selections.map(selection => this.sources(projectId, selection))
    const items = selections.flatMap((selection, index) => this.items(projectId, selection, sources[index]!))
    const runIds = selections.flatMap(selection => selection.runId ? [selection.runId] : []).sort()
    const definitions = new Set(selections.flatMap(selection => selection.evaluationDefinitionId ? [selection.evaluationDefinitionId] : []))
    const modes = new Set(selections.map(selection => selection.mode))
    const revisions = new Set(selections.map(selection => selection.revision))
    const source: SentimentSourceSelection = { assessments: sources.flatMap(source => source.assessments), runIds, sourceCoverage: { expected: sources.reduce((sum, source) => sum + source.sourceCoverage.expected, 0), completed: sources.reduce((sum, source) => sum + source.sourceCoverage.completed, 0) }, skipped: sources.reduce<Record<string, number>>((counts, source) => { for (const [reason, count] of Object.entries(source.skipped)) counts[reason] = (counts[reason] ?? 0) + count; return counts }, {}) }
    const selection: SentimentResolvedSelection = { ...selections[0]!, runId: runIds.length === 1 ? runIds[0]! : null, runIds: runIds.length > 1 ? runIds : undefined, evaluationDefinitionId: definitions.size === 1 ? [...definitions][0]! : null }
    let reason: string | null = definitions.size > 1 ? 'evaluation-definition-changed' : modes.size > 1 ? 'source-mode-changed' : revisions.size > 1 ? 'measurement-revision-changed' : null
    const subjects = new Map<string, string>(), queries = new Map<string, string>()
    for (const assessment of source.assessments) {
      const identity = sentimentHash(assessment.subject), prior = subjects.get(assessment.subject.key)
      if (prior && prior !== identity) reason ??= 'subject-identity-changed'
      subjects.set(assessment.subject.key, identity)
      for (const edge of assessment.edges.filter(edge => matchesSentimentEdge(edge, sourceFilter(query)))) {
        const previous = queries.get(edge.queryKey)
        if (previous && previous !== edge.queryText) reason ??= 'query-identity-changed'
        queries.set(edge.queryKey, edge.queryText)
      }
    }
    const result = this.aggregate(projectId, selection, items, source)
    const unavailable = { state: 'unsupported' as const, reason, provisional: true, score: aggregateSentiment([]).score }
    const summary: SentimentSummary = reason ? { ...result, ...unavailable, breakdowns: result.breakdowns.map(row => ({ ...row, ...unavailable })), queries: result.queries.map(row => ({ ...row, ...unavailable, locations: row.locations.map(location => ({ ...location, ...unavailable })) })) } : result
    return { selection, items, summary, fingerprint: sentimentHash(selections) }
  }
  summary(projectId: string, query: SentimentSelection): SentimentSummary { return this.readSelection(projectId, query).summary }
  overview(projectId: string, runIds: string[], location?: string): SentimentOverview {
    const headline = (queryClass: 'branded' | 'non-brand') => {
      const empty: SentimentResolvedSelection = { mode: 'simple', scope: 'project', queryClass, runId: null, revision: null, evaluationDefinitionId: null }
      const result = runIds.length ? this.summary(projectId, { mode: 'auto', scope: 'project', queryClass, runIds, ...(location ? { location } : {}) }) : this.aggregate(projectId, empty, [])
      return { state: result.state, reason: result.reason, provisional: result.provisional, coverage: result.coverage, score: result.score, selection: result.selection, runIds: result.selection.runIds ?? (result.selection.runId ? [result.selection.runId] : []) }
    }
    const settings = this.settings(projectId)
    return { configured: settings.enabled && settings.installEnabled, branded: headline('branded'), nonBrand: headline('non-brand') }
  }
  evidence(projectId: string, query: SentimentSelection, limit: number, cursor?: string) {
    const { selection, items: all, summary, fingerprint } = this.readSelection(projectId, query)
    let after = ''
    if (cursor) { const token = this.verify<{ projectId: string; selection: SentimentResolvedSelection; fingerprint: string; after: string }>(cursor); if (token.projectId !== projectId || sentimentHash(token.selection) !== sentimentHash(selection) || token.fingerprint !== fingerprint) throw validationError('Evidence cursor does not match the resolved selection.'); after = token.after }
    const items = all.sort((a, b) => a.work.id.localeCompare(b.work.id)).filter(item => item.work.id > after)
    const page = items.slice(0, limit)
    return { state: summary.state, selection, items: page.map(item => item.evidence), nextCursor: items.length > limit ? this.sign({ projectId, selection, fingerprint, after: page.at(-1)!.work.id }) : null }
  }
  compare(projectId: string, query: SentimentSelection, fromRunId: string, toRunId: string): SentimentComparison {
    if (query.runIds) throw validationError('Comparison requires one explicit run per period.')
    const fromSelection = this.resolve(projectId, { ...query, runId: fromRunId }), toSelection = this.resolve(projectId, { ...query, runId: toRunId })
    const fromItems = this.items(projectId, fromSelection), toItems = this.items(projectId, toSelection)
    const unit = (item: StoredItem) => sentimentHash({ query: item.evidence.context.queryId, queryText: item.evidence.context.queryText, provider: item.input.context.provider, subject: item.input.subject, context: item.evidence.context.locationContext, language: item.input.language, usageEdges: item.evidence.context.usageEdges })
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
  return { mode: selection.mode, runId: selection.runId ?? undefined, runIds: selection.runId ? undefined : extra.runIds, since: extra.from, until: extra.to, revision: selection.revision ?? undefined, queryClass: selection.queryClass, queryId: selection.queryId, scope: selection.scope, scopeKey: selection.scopeKey, marketKey: selection.marketKey, provider: selection.provider, sourceModel: selection.model, location: selection.location }
}
function outcome(status: string, result?: string) { return sentimentOutcomeSchema.parse(status === 'completed' ? result ?? 'failed' : status) }
function parse<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown } } }, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw validationError('Invalid sentiment request.', { issues: result.error.issues }); return result.data }
export { parse as parseSentimentRequest }
