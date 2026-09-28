import { createHmac, timingSafeEqual } from 'node:crypto'
import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm'
import {
  aggregateSentiment, AppError, canonicalSentimentJson, createSentimentEvaluationDefinition, hasCurrentSentimentTemplate,
  emptySentimentCounts, notFound, SENTIMENT_ATTEMPT_PAGE_DEFAULT, SENTIMENT_INTERVAL_LIMITATION, SENTIMENT_MODEL, SENTIMENT_QUERY_PAGE_DEFAULT, SentimentOutcomes,
  sentimentBackfillSelectionSchema, storedSentimentClassifierInputSchema, storedSentimentClassifierOutputSchema,
  storedSentimentEvaluationDefinitionSchema, sentimentJobSchema, sentimentOutcomeSchema, sentimentSettingsUpdateSchema,
  validationError, type SentimentBackfillPreview, type SentimentBackfillSelection, type SentimentClassifierInput,
  type SentimentComparison, type SentimentCounts, type SentimentEvidenceItem, type SentimentHeadline, type SentimentJob, type SentimentOutcome,
  type SentimentQuerySummary, type SentimentResolvedSelection, type SentimentSelection, type SentimentEvidenceSelection,
  type SentimentSettings, type SentimentSummary, type SentimentOverview, type SentimentSummaryInclude, type SentimentJobSummary,
} from '@ainyc/canonry-contracts'
import {
  measurementPlanVersions, querySnapshots, runs, sentimentAttempts, sentimentDefinitions, sentimentJobItems, sentimentJobs,
  sentimentResults, sentimentWorkItems, SentimentIdempotencyConflict, SentimentRepository, type DatabaseClient,
} from '@ainyc/canonry-db'
import { matchesSentimentEdge, selectSentimentSources, type SentimentSourceAssessment, type SentimentSourceEdge, type SentimentSourceSelection, type SentimentSourceFilter } from './sentiment-source.js'
import { sentimentClassifierInput, sentimentHash } from './sentiment-input.js'

export interface SentimentInstallState { enabled: boolean; ready: boolean; reason: string | null; model: string }
export interface SentimentServiceOptions { install: () => SentimentInstallState; previewSecret: string; now?: () => Date; estimate?: (input: SentimentClassifierInput) => number }
/**
 * Opt-in summary shape. With a view, per-engine assessments and locations are
 * returned only when included or when the selection names one queryId, and
 * query rows are paged. Without one, every row carries both (the pre-paging DTO).
 */
export interface SentimentSummaryView { include?: readonly SentimentSummaryInclude[]; queryLimit?: number; queryCursor?: string }
export interface SentimentQueryPage { total: number; limit: number; nextCursor: string | null }
/** Advanced rows are per frozen execution node; Simple rows carry null. */
export type SentimentQueryRow = SentimentQuerySummary & { executionNodeKey: string | null }
export type SentimentSummaryPage = Omit<SentimentSummary, 'queries'> & { queries: SentimentQueryRow[]; queryPage: SentimentQueryPage }
export interface SentimentAttemptPageRequest { limit?: number; cursor?: string }
export type SentimentJobPage = SentimentJob & { attemptCount: number; nextAttemptCursor: string | null }

type WorkColumns = { id: string; runId: string; snapshotId: string; sourceTextHash: string; subjectHash: string; evaluationDefinitionId: string; status: string; errorCode: string | null; cancellationReason: string | null }
/** One admitted assessment inside the selected source. Frozen input loads only for evidence and comparison. */
type StoredItem = { work: WorkColumns; member: SentimentSourceAssessment; edges: SentimentSourceEdge[]; outcome: SentimentOutcome; reason: string | null; returnedModel: string | null }
type DetailedItem = StoredItem & { input: SentimentClassifierInput; evidence: SentimentEvidenceItem }
type Resolved = { selection: SentimentResolvedSelection; source: SentimentSourceSelection }
type Read<T extends StoredItem> = { selection: SentimentResolvedSelection; items: T[]; source: SentimentSourceSelection; reason: string | null; fingerprint: string }
type RowKey = { queryText: string; queryId: string; executionNodeKey: string | null }
type RowDetail = { include: ReadonlySet<SentimentSummaryInclude>; limit: number | null; after: RowKey | null }
type RowGroup = RowKey & { eligible: SentimentSourceAssessment[]; measured: StoredItem[] }
type PreviewToken = { projectId: string; selection: SentimentBackfillSelection; definitionId: string; fingerprint: string; expiresAt: string }
type QueryCursor = { kind: 'query-page'; projectId: string; selection: SentimentResolvedSelection; fingerprint: string; after: RowKey }
type AttemptCursor = { kind: 'attempt-page'; projectId: string; jobId: string; after: { dispatchedAt: string; id: string } }
type AttemptRow = typeof sentimentAttempts.$inferSelect
type JobTally = { counts: SentimentCounts; selected: number }
type Aggregate = { summary: Omit<SentimentSummary, 'queries'>; queries: SentimentQueryRow[]; total: number; next: RowKey | null }
const DISCLOSURE = 'Experimental English sentiment classification. Enabling sends each stored answer\'s text to TypeSafe with the frozen subject identity (name, aliases and URLs), the tracked query text and query class, the answer engine with its requested and served models, the location, and internal query, subject, Property, group and market identifiers.'
const FULL_ROWS: RowDetail = { include: new Set(['assessments', 'locations']), limit: null, after: null }
/** Every query row without per-engine or location detail; that detail stays on the paged summary read. */
const COMPACT_ROWS: RowDetail = { include: new Set(), limit: null, after: null }
/** Operational states stay readable while sentiment is off; every classified or abstained outcome is withheld. */
const OPERATIONAL_OUTCOMES: ReadonlySet<SentimentOutcome> = new Set([SentimentOutcomes.pending, SentimentOutcomes.running, SentimentOutcomes['waiting-to-retry'], SentimentOutcomes.failed, SentimentOutcomes.canceled])

export class SentimentService {
  readonly repository: SentimentRepository
  constructor(readonly db: DatabaseClient, readonly options: SentimentServiceOptions) { this.repository = new SentimentRepository(db) }
  now(): string { return (this.options.now?.() ?? new Date()).toISOString() }
  settings(projectId: string, administrator = false): SentimentSettings {
    const install = this.options.install()
    const row = this.repository.getSettings(projectId)
    const supportedDefinition = !row || hasCurrentSentimentTemplate(this.definition(row.evaluationDefinitionId))
    // The install-wide provider pause: a credential refusal holds every project, a rate limit only delays.
    const pause = this.repository.dispatchState()
    const pauseReason = pause?.blockedReason === 'provider-authorization'
      ? 'provider-authorization: TypeSafe rejected the configured credentials. Dispatch is paused for every project until the key changes; one request retries each hour.'
      : pause?.blockedReason === 'provider-rate-limit' && pause.nextDispatchAt ? `provider-rate-limit: TypeSafe is rate limiting this install. Dispatch resumes after ${pause.nextDispatchAt}.` : null
    const ready = install.ready && supportedDefinition && pause?.blockedReason !== 'provider-authorization'
    return {
      installEnabled: install.enabled, enabled: row?.enabled ?? false, ready,
      readinessReasons: [...(install.reason ? [install.reason] : []), ...(!supportedDefinition ? ['unsupported-evaluator-definition: configure sentiment again to use the current evaluator.'] : []), ...(pauseReason ? [pauseReason] : [])], model: install.model, enablementEpoch: row?.enablementEpoch ?? 0,
      completionBoundary: row?.completionBoundary ?? 0,
      evaluationDefinitionId: row?.evaluationDefinitionId ?? null,
      // A project that is still on can always be switched off, even while the install switch is off.
      actions: { configure: administrator && (install.enabled || Boolean(row?.enabled)), backfill: administrator && ready && Boolean(row?.enabled) }, experimental: true, disclosure: DISCLOSURE,
    }
  }
  configure(projectId: string, value: unknown, actor = 'system'): SentimentSettings {
    const update = parse(sentimentSettingsUpdateSchema, value)
    const previous = this.settings(projectId, true)
    const enabled = update.enabled ?? previous.enabled
    // Only enabling depends on the install; withdrawing a project never waits for it.
    if (enabled && !previous.installEnabled) throw validationError('Sentiment is disabled in install configuration.')
    if (enabled && !this.options.install().ready) throw validationError('Sentiment provider is not ready.', { reasons: previous.readinessReasons })
    const configuration = { enabled }
    const definition = createSentimentEvaluationDefinition()
    const definitionId = sentimentHash(definition)
    this.repository.putDefinition({ id: definitionId, contentHash: definitionId, requestedModel: SENTIMENT_MODEL, definition, createdAt: this.now() })
    this.repository.configure({ projectId, enabled: configuration.enabled, evaluationDefinitionId: definitionId, configuration, actor, now: this.now(), forceNewEpoch: Boolean(previous.evaluationDefinitionId && !hasCurrentSentimentTemplate(this.definition(previous.evaluationDefinitionId))) })
    return this.settings(projectId, true)
  }
  private disabled(projectId: string): boolean {
    const settings = this.settings(projectId)
    return !settings.enabled || !settings.installEnabled
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
    // A date range that matched no runs keeps its bounds and freezes no empty run list.
    const frozenSelection: SentimentBackfillSelection = selection.runId ? { ...selection, runId: source.runIds[0]! } : source.runIds.length ? { ...selection, runIds: source.runIds } : selection
    const definitionId = settings.evaluationDefinitionId
    // A never-configured project is estimated against the evaluator that enabling would create.
    const definition = definitionId ? this.definition(definitionId) : createSentimentEvaluationDefinition()
    const inputs = source.assessments.map(item => sentimentClassifierInput(item, definition))
    // Only identity columns of the selected runs' completed work; frozen inputs stay unread.
    const existing = definitionId && source.runIds.length ? this.db.select({ snapshotId: sentimentWorkItems.snapshotId, sourceTextHash: sentimentWorkItems.sourceTextHash, subjectHash: sentimentWorkItems.subjectHash }).from(sentimentWorkItems)
      .innerJoin(sentimentResults, eq(sentimentResults.workItemId, sentimentWorkItems.id))
      .where(and(eq(sentimentWorkItems.projectId, projectId), eq(sentimentWorkItems.evaluationDefinitionId, definitionId), inArray(sentimentWorkItems.runId, source.runIds))).all() : []
    const completed = new Set(existing.map(work => `${work.snapshotId}:${work.sourceTextHash}:${work.subjectHash}`))
    const alreadyClassified = inputs.filter(input => completed.has(`${input.sourceSnapshotId}:${input.sourceTextHash}:${input.subjectHash}`)).length
    const estimatedInputTokens = this.options.estimate ? inputs.reduce((sum, input) => sum + this.options.estimate!(input), 0) : 0
    const expiresAt = new Date(Date.parse(this.now()) + 15 * 60_000).toISOString()
    const previewToken = definitionId && settings.enabled && settings.ready && source.assessments.length ? this.sign({ projectId, selection: frozenSelection, definitionId, fingerprint: sentimentHash(source.assessments), expiresAt } satisfies PreviewToken) : null
    // The selection attributes each skip to its run, so no run is selected a second time.
    const skipped = source.runIds.flatMap(runId => Object.entries(source.skippedByRun?.[runId] ?? {}).map(([reason, count]) => ({ runId, reason, count })))
    const estimateMethod = this.options.estimate
      ? `Adapter estimate of the full request including all questions and evidence candidates; final billed usage is recorded per attempt.${definitionId ? '' : ' Sentiment is not configured for this project, so the estimate uses the current evaluator definition.'}`
      : 'Token and cost estimates unavailable on this host.'
    return { previewToken, expiresAt: previewToken ? expiresAt : null, selection: frozenSelection, evaluationDefinitionId: definitionId, eligibleAssessments: source.assessments.length, alreadyClassified, skipped, estimatedInputTokens, estimatedCostUsd: this.options.estimate ? estimatedInputTokens * 0.042 / 1_000_000 : null, estimateMethod }
  }
  /** The receipt carries the first page of attempts; a replay of a long-running job never returns all of them. */
  submit(projectId: string, previewToken: string, idempotencyKey: string, actor: string): SentimentJobPage {
    const payloadHash = sentimentHash({ previewToken })
    // Receipt replay precedes expiry and enablement checks after caller authorization.
    try {
      const prior = this.repository.lookupJob(projectId, 'backfill', idempotencyKey, payloadHash)
      if (prior) return this.job(projectId, prior.id, {})
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
    return this.job(projectId, row.id, {})
  }
  definition(id: string) {
    const row = this.db.select().from(sentimentDefinitions).where(eq(sentimentDefinitions.id, id)).get()
    if (!row) throw notFound('Sentiment definition', id)
    return storedSentimentEvaluationDefinitionSchema.parse(row.definition)
  }
  /** Newest 100 jobs with SQL-counted outcomes and attempt totals; attempt receipts are paged on the job read. */
  jobList(projectId: string): { jobs: SentimentJobSummary[] } {
    const rows = this.recentJobs(projectId)
    const ids = rows.map(row => row.id)
    const tallies = this.jobTallies(projectId, ids, this.disabled(projectId))
    const attemptCounts = new Map(ids.length ? this.db.select({ jobId: sentimentJobItems.jobId, count: sql<number>`count(*)` }).from(sentimentAttempts).innerJoin(sentimentJobItems, jobAttemptJoin)
      .where(and(eq(sentimentJobItems.projectId, projectId), inArray(sentimentJobItems.jobId, ids))).groupBy(sentimentJobItems.jobId).all().map(row => [row.jobId, row.count]) : [])
    return { jobs: rows.map(row => { const { attempts: _attempts, ...summary } = jobReceipt(row, tallies.get(row.id)!, []); return { ...summary, attemptCount: attemptCounts.get(row.id) ?? 0 } }) }
  }
  job(projectId: string, jobId: string): SentimentJob
  job(projectId: string, jobId: string, page: SentimentAttemptPageRequest): SentimentJobPage
  job(projectId: string, jobId: string, page?: SentimentAttemptPageRequest): SentimentJob | SentimentJobPage {
    const row = this.repository.getJob(projectId, jobId)
    if (!row) throw notFound('Sentiment job', jobId)
    const tally = this.jobTallies(projectId, [jobId], this.disabled(projectId)).get(jobId)!
    const scope = and(eq(sentimentJobItems.projectId, projectId), eq(sentimentJobItems.jobId, jobId))
    if (!page) return jobReceipt(row, tally, this.db.select({ attempt: sentimentAttempts }).from(sentimentAttempts).innerJoin(sentimentJobItems, jobAttemptJoin).where(scope).orderBy(sentimentAttempts.dispatchedAt, sentimentAttempts.id).all().map(({ attempt }) => attempt))
    const limit = Math.max(1, page.limit ?? SENTIMENT_ATTEMPT_PAGE_DEFAULT)
    let after: AttemptCursor['after'] | null = null
    if (page.cursor) {
      const token = this.verify<Omit<AttemptCursor, 'kind'> & { kind?: string }>(page.cursor)
      if (token.kind !== 'attempt-page' || token.projectId !== projectId || token.jobId !== jobId) throw validationError('Attempt cursor does not match this sentiment job.')
      after = token.after
    }
    const attemptCount = this.db.select({ count: sql<number>`count(*)` }).from(sentimentAttempts).innerJoin(sentimentJobItems, jobAttemptJoin).where(scope).get()?.count ?? 0
    // Newest first, keyed on (dispatchedAt, id) so attempts started while paging never shift a page.
    const rows = this.db.select({ attempt: sentimentAttempts }).from(sentimentAttempts).innerJoin(sentimentJobItems, jobAttemptJoin)
      .where(and(scope, after ? or(lt(sentimentAttempts.dispatchedAt, after.dispatchedAt), and(eq(sentimentAttempts.dispatchedAt, after.dispatchedAt), lt(sentimentAttempts.id, after.id))) : undefined))
      .orderBy(desc(sentimentAttempts.dispatchedAt), desc(sentimentAttempts.id)).limit(limit + 1).all().map(({ attempt }) => attempt)
    const shown = rows.slice(0, limit), last = shown.at(-1)
    return { ...jobReceipt(row, tally, shown), attemptCount, nextAttemptCursor: rows.length > limit && last ? this.sign({ kind: 'attempt-page', projectId, jobId, after: { dispatchedAt: last.dispatchedAt, id: last.id } } satisfies AttemptCursor) : null }
  }
  private recentJobs(projectId: string) {
    return this.db.select().from(sentimentJobs).where(eq(sentimentJobs.projectId, projectId)).orderBy(desc(sentimentJobs.createdAt)).limit(100).all()
  }
  /** Outcome partitions counted in SQL over identity columns; frozen inputs are never loaded. */
  private jobTallies(projectId: string, jobIds: string[], disabled: boolean): Map<string, JobTally> {
    const tallies = new Map(jobIds.map(id => [id, { counts: emptySentimentCounts(), selected: 0 }]))
    if (!jobIds.length) return tallies
    const canceled = sql<number>`${sentimentJobItems.canceledAt} is not null`
    const groups = this.db.select({ jobId: sentimentJobItems.jobId, canceled, status: sentimentWorkItems.status, result: sentimentResults.outcome, count: sql<number>`count(*)` })
      .from(sentimentJobItems).innerJoin(sentimentWorkItems, eq(sentimentWorkItems.id, sentimentJobItems.workItemId)).leftJoin(sentimentResults, eq(sentimentResults.workItemId, sentimentWorkItems.id))
      .where(and(eq(sentimentJobItems.projectId, projectId), inArray(sentimentJobItems.jobId, jobIds)))
      .groupBy(sentimentJobItems.jobId, canceled, sentimentWorkItems.status, sentimentResults.outcome).all()
    for (const group of groups) {
      const tally = tallies.get(group.jobId)!
      tally.counts[group.canceled ? SentimentOutcomes.canceled : outcome(group.status, group.result ?? undefined)] += group.count
      tally.selected += group.count
    }
    if (disabled) for (const tally of tallies.values()) tally.counts = withheldCounts(tally.counts)
    return tallies
  }
  private resolve(projectId: string, selection: SentimentSelection): Resolved {
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
    // One frozen source selection per run serves evaluator resolution, stored items and every aggregate.
    const source = run ? selectSentimentSources(this.db, projectId, { ...sourceFilter(selection), runId: run.id }) : emptySource()
    const allowedSubjects = new Set(source.assessments.map(item => `${item.snapshotId}:${item.subject.key}`))
    const latest = run && !selection.evaluationDefinitionId ? this.db.select({ definitionId: sentimentWorkItems.evaluationDefinitionId, snapshotId: sentimentWorkItems.snapshotId, subjectId: sql<string | null>`json_extract(${sentimentWorkItems.input}, '$.subject.id')` }).from(sentimentWorkItems)
      .innerJoin(sentimentJobItems, eq(sentimentJobItems.workItemId, sentimentWorkItems.id)).innerJoin(sentimentJobs, eq(sentimentJobs.id, sentimentJobItems.jobId))
      .where(and(eq(sentimentWorkItems.projectId, projectId), eq(sentimentWorkItems.runId, run.id))).orderBy(desc(sentimentJobs.createdAt), sql`${sentimentJobs}.rowid desc`).all()
      .find(row => allowedSubjects.has(`${row.snapshotId}:${row.subjectId}`)) : undefined
    const revision = run?.measurementPlanVersionId ? this.db.select({ revision: measurementPlanVersions.revision }).from(measurementPlanVersions).where(eq(measurementPlanVersions.id, run.measurementPlanVersionId)).get()?.revision ?? null : null
    return { selection: { ...selection, runId: run?.id ?? null, runIds: undefined, revision: selection.revision ?? revision, mode: run?.measurementPlanVersionId ? 'advanced' : 'simple', evaluationDefinitionId: selection.evaluationDefinitionId ?? latest?.definitionId ?? null }, source }
  }
  private items(projectId: string, selection: SentimentResolvedSelection, source: SentimentSourceSelection): StoredItem[]
  private items(projectId: string, selection: SentimentResolvedSelection, source: SentimentSourceSelection, withInput: true): DetailedItem[]
  private items(projectId: string, selection: SentimentResolvedSelection, source: SentimentSourceSelection, withInput = false): StoredItem[] {
    if (!selection.runId || !selection.evaluationDefinitionId) return []
    const definition = this.definition(selection.evaluationDefinitionId)
    const filter = sourceFilter(selection)
    const allowed = new Map(source.assessments.map(item => { const input = sentimentClassifierInput(item, definition); return [`${item.snapshotId}:${input.sourceTextHash}:${input.subjectHash}`, item] }))
    const scope = and(eq(sentimentWorkItems.projectId, projectId), eq(sentimentWorkItems.runId, selection.runId), eq(sentimentWorkItems.evaluationDefinitionId, selection.evaluationDefinitionId))
    const rows = this.db.select({
      id: sentimentWorkItems.id, runId: sentimentWorkItems.runId, snapshotId: sentimentWorkItems.snapshotId, sourceTextHash: sentimentWorkItems.sourceTextHash, subjectHash: sentimentWorkItems.subjectHash,
      evaluationDefinitionId: sentimentWorkItems.evaluationDefinitionId, status: sentimentWorkItems.status, errorCode: sentimentWorkItems.errorCode, cancellationReason: sentimentWorkItems.cancellationReason,
      resultOutcome: sentimentResults.outcome, result: sentimentResults.result, returnedModel: sentimentResults.returnedModel,
    }).from(sentimentWorkItems).leftJoin(sentimentResults, eq(sentimentResults.workItemId, sentimentWorkItems.id)).where(scope).all()
    const inputs = withInput ? new Map(this.db.select({ id: sentimentWorkItems.id, input: sentimentWorkItems.input }).from(sentimentWorkItems).where(scope).all().map(row => [row.id, row.input])) : null
    return rows.flatMap(({ resultOutcome, result, returnedModel, ...work }) => {
      const member = allowed.get(`${work.snapshotId}:${work.sourceTextHash}:${work.subjectHash}`)
      if (!member) return []
      const edges = member.edges.filter(edge => matchesSentimentEdge(edge, filter))
      const classification = resultOutcome === null ? null : storedSentimentClassifierOutputSchema.parse(result)
      const item: StoredItem = { work, member, edges, outcome: outcome(work.status, resultOutcome ?? undefined), reason: work.cancellationReason ?? work.errorCode ?? (classification?.kind === 'abstained' ? classification.reason : null), returnedModel: returnedModel ?? null }
      if (!inputs) return [item]
      const input = storedSentimentClassifierInputSchema.parse(inputs.get(work.id))
      const primary = edges[0]!
      // Reads project only the selected usage edges; the canonical frozen input retains all of them.
      const projected = sentimentClassifierInput({ ...member, edges }, definition).context
      const context = { ...input.context, ...projected, queryText: primary.queryText }
      const evidence: SentimentEvidenceItem = { assessmentId: work.id, runId: work.runId, sourceSnapshotId: work.snapshotId, sourceText: input.sourceText, sourceTextHash: work.sourceTextHash, subject: input.subject, subjectHash: work.subjectHash, context, evaluationDefinitionId: work.evaluationDefinitionId, outcome: item.outcome, conclusion: classification?.kind === 'classified' ? classification.conclusion : [], complaint: classification?.kind === 'classified' ? classification.complaint : null, returnedModel: item.returnedModel, reason: item.reason }
      return [{ ...item, input, evidence } satisfies DetailedItem]
    })
  }
  private aggregate(selection: SentimentResolvedSelection, items: readonly StoredItem[], source: SentimentSourceSelection, settings: SentimentSettings, rows: RowDetail | null): Aggregate {
    const definition = selection.evaluationDefinitionId ? this.definition(selection.evaluationDefinitionId) : null
    const disabled = !settings.enabled || !settings.installEnabled
    const options = { disabled, incomplete: Boolean(source.skipped['incomplete-run']) }
    const base = { ...scoreAssessments(items, source.assessments, { ...options, slots: source.sourceCoverage }), configured: settings.enabled && settings.installEnabled, selection, evaluationDefinition: definition }
    if (!rows) return { summary: { ...base, breakdowns: [] }, queries: [], total: 0, next: null }
    const filter = sourceFilter(selection)
    const selectedEdges = new Map(source.assessments.map(item => [item, item.edges.filter(edge => matchesSentimentEdge(edge, filter))]))
    const breakdowns: SentimentSummary['breakdowns'] = []
    for (const dimension of ['provider', 'property', 'market'] as const) {
      const edgeKeys = (edge: SentimentSourceEdge) => dimension === 'provider' ? [edge.provider] : dimension === 'property' ? [edge.propertyKey] : edge.marketKeys
      const eligible = new Map<string, SentimentSourceAssessment[]>()
      const measured = new Map<string, StoredItem[]>()
      for (const item of source.assessments) for (const key of new Set(selectedEdges.get(item)!.flatMap(edgeKeys))) append(eligible, key, item)
      for (const item of items) for (const key of new Set(item.edges.flatMap(edgeKeys))) append(measured, key, item)
      for (const [key, members] of eligible) breakdowns.push({ ...scoreAssessments(measured.get(key) ?? [], members, options), dimension, key, label: dimension === 'property' ? members[0]!.subject.name : key, queryClass: selection.queryClass })
    }
    // Build every query row in one pass; never issue one read per query. Query rows are the
    // per-query breakdown, so they are not repeated under breakdowns.
    const groups = new Map<string, RowGroup>()
    for (const item of source.assessments) for (const edge of new Map(selectedEdges.get(item)!.map(edge => [queryRowKey(edge), edge])).values()) {
      const key = queryRowKey(edge)
      const group = groups.get(key) ?? { queryId: edge.queryKey, queryText: edge.queryText, executionNodeKey: edge.executionNodeKey, eligible: [], measured: [] }
      group.eligible.push(item); groups.set(key, group)
    }
    for (const item of items) for (const key of new Set(item.edges.map(queryRowKey))) groups.get(key)?.measured.push(item)
    const ordered = [...groups.values()].sort(compareRows)
    const start = rows.after ? ordered.findIndex(group => compareRows(group, rows.after!) > 0) : 0
    const from = start === -1 ? ordered.length : start
    const page = rows.limit === null ? ordered.slice(from) : ordered.slice(from, from + rows.limit)
    const measuredBySourceSubject = new Map(items.map(item => [`${item.work.snapshotId}\0${item.member.subject.key}`, item]))
    const queries = page.map((group): SentimentQueryRow => {
      const key = queryRowKey(group)
      const inRow = (edge: SentimentSourceEdge) => queryRowKey(edge) === key
      const assessments = !rows.include.has('assessments') ? [] : group.eligible.map(member => {
        const item = measuredBySourceSubject.get(`${member.snapshotId}\0${member.subject.key}`)
        const edge = selectedEdges.get(member)!.find(inRow)!
        const state = aggregateSentiment(item ? [{ assessmentId: item.work.id, sourceSnapshotId: member.snapshotId, outcome: item.outcome }] : [], { disabled }).state
        return {
          assessmentId: item?.work.id ?? null, sourceSnapshotId: member.snapshotId, runId: member.runId,
          subjectId: member.subject.key, subjectLabel: member.subject.name, executionNodeKey: edge.executionNodeKey,
          provider: edge.provider, requestedModel: edge.sourceModel, servedModel: edge.servedModel, location: edge.context?.label ?? null,
          evaluationDefinitionId: item?.work.evaluationDefinitionId ?? null, state,
          outcome: disabled ? null : item?.outcome ?? null,
          reason: disabled ? 'Sentiment is disabled.' : item ? item.reason : 'This source assessment has not been admitted.',
        }
      }).sort((left, right) => left.sourceSnapshotId.localeCompare(right.sourceSnapshotId) || left.subjectId.localeCompare(right.subjectId))
      const locations = !rows.include.has('locations') ? [] : (() => {
        const eligibleByLocation = new Map<string | null, SentimentSourceAssessment[]>()
        const measuredByLocation = new Map<string | null, StoredItem[]>()
        for (const item of group.eligible) for (const location of new Set(selectedEdges.get(item)!.filter(inRow).map(edge => edge.context?.label ?? null))) append(eligibleByLocation, location, item)
        for (const item of group.measured) for (const location of new Set(item.edges.filter(inRow).map(edge => edge.context?.label ?? null))) append(measuredByLocation, location, item)
        return [...eligibleByLocation].map(([location, eligible]) => ({ ...scoreAssessments(measuredByLocation.get(location) ?? [], eligible, options), location, sourceSnapshotIds: [...new Set(eligible.map(item => item.snapshotId))].sort() }))
      })()
      return { ...scoreAssessments(group.measured, group.eligible, options), queryId: group.queryId, queryText: group.queryText, queryClass: selection.queryClass, sourceSnapshotIds: [...new Set(group.eligible.map(item => item.snapshotId))].sort(), assessments, locations, executionNodeKey: group.executionNodeKey }
    })
    const next = rows.limit !== null && from + rows.limit < ordered.length ? rowKey(page.at(-1)!) : null
    return { summary: { ...base, breakdowns }, queries, total: ordered.length, next }
  }
  private readSelection(projectId: string, query: SentimentSelection): Read<StoredItem>
  private readSelection(projectId: string, query: SentimentSelection, withInput: true): Read<DetailedItem>
  private readSelection(projectId: string, query: SentimentSelection, withInput = false): Read<StoredItem> {
    if (query.runId && query.runIds) throw validationError('Choose runId or runIds, not both.')
    const requested = query.runIds ? [...new Set(query.runIds)].sort() : undefined
    const resolved = requested ? requested.map(runId => this.resolve(projectId, { ...query, runIds: undefined, runId })) : [this.resolve(projectId, query)]
    const items = resolved.flatMap(({ selection, source }) => withInput ? this.items(projectId, selection, source, true) : this.items(projectId, selection, source))
    const selections = resolved.map(entry => entry.selection), sources = resolved.map(entry => entry.source)
    const runIds = selections.flatMap(selection => selection.runId ? [selection.runId] : []).sort()
    const definitions = new Set(selections.flatMap(selection => selection.evaluationDefinitionId ? [selection.evaluationDefinitionId] : []))
    const modes = new Set(selections.map(selection => selection.mode))
    const revisions = new Set(selections.map(selection => selection.revision))
    const source: SentimentSourceSelection = { assessments: sources.flatMap(source => source.assessments), runIds, sourceCoverage: { expected: sources.reduce((sum, source) => sum + source.sourceCoverage.expected, 0), completed: sources.reduce((sum, source) => sum + source.sourceCoverage.completed, 0) }, skipped: sources.reduce<Record<string, number>>((counts, source) => { for (const [reason, count] of Object.entries(source.skipped)) counts[reason] = (counts[reason] ?? 0) + count; return counts }, {}) }
    const selection: SentimentResolvedSelection = { ...selections[0]!, runId: runIds.length === 1 ? runIds[0]! : null, runIds: runIds.length > 1 ? runIds : undefined, evaluationDefinitionId: definitions.size === 1 ? [...definitions][0]! : null }
    let reason: string | null = definitions.size > 1 ? 'evaluation-definition-changed' : modes.size > 1 ? 'source-mode-changed' : revisions.size > 1 ? 'measurement-revision-changed' : null
    const subjects = new Map<string, string>(), queries = new Map<string, string>()
    const filter = sourceFilter(query)
    for (const assessment of source.assessments) {
      const identity = sentimentHash(assessment.subject), prior = subjects.get(assessment.subject.key)
      if (prior && prior !== identity) reason ??= 'subject-identity-changed'
      subjects.set(assessment.subject.key, identity)
      for (const edge of assessment.edges.filter(edge => matchesSentimentEdge(edge, filter))) {
        const previous = queries.get(edge.queryKey)
        if (previous && previous !== edge.queryText) reason ??= 'query-identity-changed'
        queries.set(edge.queryKey, edge.queryText)
      }
    }
    return { selection, items, source, reason, fingerprint: sentimentHash(selections) }
  }
  /** Incompatible pooled identities replace every score in the response with an unavailable one. */
  private present(read: Read<StoredItem>, settings: SentimentSettings, rows: RowDetail | null): Aggregate {
    const result = this.aggregate(read.selection, read.items, read.source, settings, rows)
    if (!read.reason) return result
    const unavailable = { state: 'unsupported' as const, reason: read.reason, provisional: true, score: aggregateSentiment([]).score }
    return {
      ...result, summary: { ...result.summary, ...unavailable, breakdowns: result.summary.breakdowns.map(row => ({ ...row, ...unavailable })) },
      queries: result.queries.map(row => ({ ...row, ...unavailable, assessments: row.assessments.map(assessment => ({ ...assessment, state: 'unsupported' as const, outcome: null, reason: read.reason })), locations: row.locations.map(location => ({ ...location, ...unavailable })) })),
    }
  }
  summary(projectId: string, query: SentimentSelection): SentimentSummary
  summary(projectId: string, query: SentimentSelection, view: SentimentSummaryView): SentimentSummaryPage
  summary(projectId: string, query: SentimentSelection, view?: SentimentSummaryView): SentimentSummary | SentimentSummaryPage {
    const read = this.readSelection(projectId, query)
    const settings = this.settings(projectId)
    if (!view) return withoutNodeKeys(this.present(read, settings, FULL_ROWS))
    const limit = Math.max(1, view.queryLimit ?? SENTIMENT_QUERY_PAGE_DEFAULT)
    let after: RowKey | null = null
    if (view.queryCursor) {
      const token = this.verify<Omit<QueryCursor, 'kind'> & { kind?: string }>(view.queryCursor)
      if (token.kind !== 'query-page' || token.projectId !== projectId || sentimentHash(token.selection) !== sentimentHash(read.selection) || token.fingerprint !== read.fingerprint) throw validationError('Query cursor does not match the resolved selection.')
      after = token.after
    }
    // One named query is a drill-down, so its per-engine and location detail comes by default.
    const include = new Set<SentimentSummaryInclude>(query.queryId ? ['assessments', 'locations'] : view.include ?? [])
    const { summary, queries, total, next } = this.present(read, settings, { include, limit, after })
    return { ...summary, queries, queryPage: { total, limit, nextCursor: next ? this.sign({ kind: 'query-page', projectId, selection: read.selection, fingerprint: read.fingerprint, after: next } satisfies QueryCursor) : null } }
  }
  overview(projectId: string, runIds: string[], location?: string): SentimentOverview {
    const settings = this.settings(projectId)
    const configured = settings.enabled && settings.installEnabled
    const headline = (queryClass: 'branded' | 'non-brand'): SentimentHeadline => {
      // Off (the default) and no-run projects answer from settings alone: no source selection or stored read.
      if (!configured || !runIds.length) {
        const empty: SentimentResolvedSelection = { mode: 'simple', scope: 'project', queryClass, runId: null, revision: null, evaluationDefinitionId: null }
        const result = scoreAssessments([], [], { disabled: !configured, incomplete: false })
        return { state: result.state, reason: result.reason, provisional: result.provisional, coverage: result.coverage, score: result.score, selection: empty, runIds: [] }
      }
      const read = this.readSelection(projectId, { mode: 'auto', scope: 'project', queryClass, runIds, ...(location ? { location } : {}) })
      const { summary: result } = this.present(read, settings, null)
      return { state: result.state, reason: result.reason, provisional: result.provisional, coverage: result.coverage, score: result.score, selection: result.selection, runIds: result.selection.runIds ?? (result.selection.runId ? [result.selection.runId] : []) }
    }
    return { configured, branded: headline('branded'), nonBrand: headline('non-brand') }
  }
  evidence(projectId: string, query: SentimentEvidenceSelection, limit: number, cursor?: string) {
    const { assessmentId, ...sourceSelection } = query
    const settings = this.settings(projectId)
    const disabled = !settings.enabled || !settings.installEnabled
    // Disabled reads withhold verdicts and quotations, so they never load frozen inputs.
    const read = disabled ? this.readSelection(projectId, sourceSelection) : this.readSelection(projectId, sourceSelection, true)
    const selection = { ...read.selection, ...(assessmentId ? { assessmentId } : {}) }
    let after = ''
    if (cursor) {
      const token = this.verify<{ kind?: string; projectId: string; selection: SentimentResolvedSelection; fingerprint: string; after: string }>(cursor)
      if (token.kind !== undefined || token.projectId !== projectId || sentimentHash(token.selection) !== sentimentHash(selection) || token.fingerprint !== read.fingerprint) throw validationError('Evidence cursor does not match the resolved selection.')
      after = token.after
    }
    const state = this.present(read, settings, null).summary.state
    if (disabled) return { state, selection, items: [], nextCursor: null }
    const items = (read.items as DetailedItem[]).filter(item => !assessmentId || item.work.id === assessmentId).sort((a, b) => a.work.id.localeCompare(b.work.id)).filter(item => item.work.id > after)
    const page = items.slice(0, limit)
    return { state, selection, items: page.map(item => item.evidence), nextCursor: items.length > limit ? this.sign({ projectId, selection, fingerprint: read.fingerprint, after: page.at(-1)!.work.id }) : null }
  }
  compare(projectId: string, query: SentimentSelection, fromRunId: string, toRunId: string): SentimentComparison {
    if (query.runIds) throw validationError('Comparison requires one explicit run per period.')
    const from = this.resolve(projectId, { ...query, runId: fromRunId }), to = this.resolve(projectId, { ...query, runId: toRunId })
    const fromItems = this.items(projectId, from.selection, from.source, true), toItems = this.items(projectId, to.selection, to.source, true)
    const unit = (item: DetailedItem) => sentimentHash({ query: item.evidence.context.queryId, queryText: item.evidence.context.queryText, provider: item.input.context.provider, subject: item.input.subject, context: item.evidence.context.locationContext, language: item.input.language, usageEdges: item.evidence.context.usageEdges })
    const units = (items: DetailedItem[]) => { const byItem = new Map(items.map(item => [item, unit(item)])), byUnit = new Map<string, DetailedItem>(); for (const [item, key] of byItem) if (!byUnit.has(key)) byUnit.set(key, item); return { byItem, byUnit } }
    const fromUnits = units(fromItems), toUnits = units(toItems)
    const common = new Set([...fromUnits.byUnit.keys()].filter(key => toUnits.byUnit.has(key)))
    const settings = this.settings(projectId)
    const fromSummary = withoutNodeKeys(this.aggregate(from.selection, fromItems.filter(item => common.has(fromUnits.byItem.get(item)!)), from.source, settings, COMPACT_ROWS))
    const toSummary = withoutNodeKeys(this.aggregate(to.selection, toItems.filter(item => common.has(toUnits.byItem.get(item)!)), to.source, settings, COMPACT_ROWS))
    const refusalReasons: string[] = []
    const expectedFrom = from.source.assessments.length, expectedTo = to.source.assessments.length
    if (fromItems.length < expectedFrom || toItems.length < expectedTo) refusalReasons.push('classification-coverage-gap')
    if (from.selection.evaluationDefinitionId !== to.selection.evaluationDefinitionId) refusalReasons.push('evaluation-definition-changed')
    // Disabled summaries withhold every judgment, so judgment-based reasons would misstate why.
    if (!settings.enabled || !settings.installEnabled) refusalReasons.push('sentiment-disabled')
    else {
      if (fromSummary.state !== 'complete' || toSummary.state !== 'complete') refusalReasons.push('incomplete-classification')
      if (!common.size || !fromSummary.coverage.judged || !toSummary.coverage.judged) refusalReasons.push('insufficient-judgments')
    }
    const changedScope = common.size !== fromUnits.byUnit.size || common.size !== toUnits.byUnit.size
    if (changedScope) refusalReasons.push('source-scope-changed')
    // A null returned model marks a local abstention that never reached the classifier, so it
    // cannot disagree with any model. Every model that did answer, in either period, must match.
    const classifierModels = new Set<string>()
    for (const key of common) {
      const left = fromUnits.byUnit.get(key)!, right = toUnits.byUnit.get(key)!
      if (!left.input.context.requestedModel || !left.input.context.servedModel || !right.input.context.requestedModel || !right.input.context.servedModel) refusalReasons.push('missing-source-model-provenance')
      else if (left.input.context.requestedModel !== right.input.context.requestedModel || left.input.context.servedModel !== right.input.context.servedModel) refusalReasons.push('source-model-changed')
      for (const model of [left.returnedModel, right.returnedModel]) if (model) classifierModels.add(model)
    }
    if (classifierModels.size > 1) refusalReasons.push('classifier-model-changed')
    const intervalFrom = fromSummary.score.interval, intervalTo = toSummary.score.interval
    const verdict = refusalReasons.length || !intervalFrom || !intervalTo ? null : intervalTo.low > intervalFrom.high ? 'improved' : intervalTo.high < intervalFrom.low ? 'declined' : 'no-clear-change'
    return { from: fromSummary, to: toSummary, verdict, favorableRateDelta: verdict && fromSummary.score.favorableRate !== null && toSummary.score.favorableRate !== null ? toSummary.score.favorableRate - fromSummary.score.favorableRate : null, refusalReasons: [...new Set(refusalReasons)], commonUnits: common.size, excludedFrom: expectedFrom - fromSummary.coverage.selected, excludedTo: expectedTo - toSummary.coverage.selected, changedScope, method: 'wilson-independent-v1', limitation: SENTIMENT_INTERVAL_LIMITATION }
  }
}
const jobAttemptJoin = and(eq(sentimentJobItems.workItemId, sentimentAttempts.workItemId), eq(sentimentJobItems.projectId, sentimentAttempts.projectId))
function emptySource(): SentimentSourceSelection { return { assessments: [], runIds: [], sourceCoverage: { expected: 0, completed: 0 }, skipped: {} } }
function append<K, V>(map: Map<K, V[]>, key: K, value: V) { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]) }
function queryRowKey(edge: Pick<SentimentSourceEdge, 'executionNodeKey'> & ({ queryKey: string } | { queryId: string })): string {
  return `${'queryKey' in edge ? edge.queryKey : edge.queryId}\0${edge.executionNodeKey ?? ''}`
}
/** The stored DTO has no row-level node key; Advanced rows stay distinct by their exact sourceSnapshotIds. */
function withoutNodeKeys({ summary, queries }: Aggregate): SentimentSummary {
  return { ...summary, queries: queries.map(({ executionNodeKey: _node, ...row }) => row) }
}
function rowKey(row: RowKey): RowKey { return { queryText: row.queryText, queryId: row.queryId, executionNodeKey: row.executionNodeKey } }
function compareRows(left: RowKey, right: RowKey): number {
  const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
  return left.queryText.localeCompare(right.queryText, 'en') || order(left.queryText, right.queryText) || order(left.queryId, right.queryId) || order(left.executionNodeKey ?? '', right.executionNodeKey ?? '')
}
function withheldCounts(counts: SentimentCounts): SentimentCounts {
  return Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, OPERATIONAL_OUTCOMES.has(key as SentimentOutcome) ? value : 0])) as SentimentCounts
}
/** One class-scoped aggregate. A disabled read withholds judged and completed-outcome counts along with the rates. */
function scoreAssessments(selected: readonly StoredItem[], eligible: readonly SentimentSourceAssessment[], options: { disabled: boolean; incomplete: boolean; slots?: { expected: number; completed: number } }) {
  const distinct = new Set(eligible.map(item => item.snapshotId)).size
  const slots = options.slots ?? { expected: distinct, completed: distinct }
  const result = aggregateSentiment(selected.map(item => ({ assessmentId: item.work.id, sourceSnapshotId: item.work.snapshotId, outcome: item.outcome })), { disabled: options.disabled, eligibleAssessments: eligible.length, expectedProviderSlots: slots.expected, completedProviderSlots: slots.completed })
  const gap = selected.length > 0 && selected.length < eligible.length
  const coverage = options.disabled ? { ...result.coverage, judged: 0, counts: withheldCounts(result.coverage.counts) } : result.coverage
  return { ...result, coverage, ...((gap || options.incomplete) && !options.disabled ? { state: selected.length ? 'partial' as const : 'not-measured' as const, provisional: true } : {}), reason: options.disabled ? 'Sentiment is disabled.' : options.incomplete ? 'Source sweep is incomplete.' : gap ? 'classification-coverage-gap: some source assessments have not been admitted.' : null }
}
function jobReceipt(row: typeof sentimentJobs.$inferSelect, tally: JobTally, attempts: readonly AttemptRow[]): SentimentJob {
  // Legacy previews persisted both selectors; their source resolver gave runIds
  // precedence. Project the receipt on read without rewriting its stored JSON.
  let selection = row.selection
  if (selection && typeof selection === 'object' && 'runId' in selection && 'runIds' in selection && Array.isArray(selection.runIds) && selection.runIds.length) {
    selection = selection.runIds.length === 1 && selection.runIds[0] === selection.runId ? { ...selection, runIds: undefined } : { ...selection, runId: undefined }
  }
  return sentimentJobSchema.parse({ id: row.id, projectId: row.projectId, origin: row.origin, state: row.state, enablementEpoch: row.enablementEpoch, evaluationDefinitionId: row.evaluationDefinitionId, selection, createdAt: row.createdAt, updatedAt: row.updatedAt, cancellationReason: row.cancellationReason, counts: tally.counts, selected: tally.selected, attempts: attempts.map(attempt => ({ id: attempt.id, workItemId: attempt.workItemId, dispatchedAt: attempt.dispatchedAt, completedAt: attempt.completedAt, returnedModel: attempt.returnedModel, usage: { kind: attempt.usageStatus, inputTokens: attempt.usage?.inputTokens ?? null, outputTokens: attempt.usage?.outputTokens ?? null }, errorCode: attempt.safeFailure })) })
}
function sourceFilter(selection: Partial<SentimentBackfillSelection> | SentimentResolvedSelection): SentimentSourceFilter {
  const extra = selection as Partial<SentimentBackfillSelection>
  return { mode: selection.mode, runId: selection.runId ?? undefined, runIds: selection.runId ? undefined : extra.runIds, since: extra.from, until: extra.to, revision: selection.revision ?? undefined, queryClass: selection.queryClass, queryId: selection.queryId, executionNodeKey: selection.executionNodeKey, scope: selection.scope, scopeKey: selection.scopeKey, marketKey: selection.marketKey, provider: selection.provider, sourceModel: selection.model, location: selection.location }
}
function outcome(status: string, result?: string) { return sentimentOutcomeSchema.parse(status === 'completed' ? result ?? 'failed' : status) }
function parse<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown } } }, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw validationError('Invalid sentiment request.', { issues: result.error.issues }); return result.data }
export { parse as parseSentimentRequest }
