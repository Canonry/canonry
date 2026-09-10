/**
 * Compact Property question reads and one expanded stored result.
 *
 * These routes deliberately start from the active immutable v2 plan and the
 * selected run's manifest. Project queries are mutable authoring assets; the
 * assignments and slots below are the questions this particular revision
 * actually promised to ask.
 */

import { and, eq, getTableColumns, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION,
  RunKinds,
  RunStatuses,
  brandKeyFromText,
  measurementPropertyQuestionsQuerySchema,
  measurementPropertyQuestionsResponseSchema,
  measurementQuestionResultQuerySchema,
  measurementQuestionResultResponseSchema,
  notFound,
  validationError,
  type MeasurementPlanV2,
} from '@ainyc/canonry-contracts'
import {
  measurementPlanVersions,
  querySnapshots,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { resolveProject } from './helpers.js'
import {
  activeMeasurementPlan,
  displayedState,
  runRevisionMismatch,
  type ActiveMeasurementPlan,
} from './measurement-overview.js'
import {
  buildMeasurementEvidence,
  normalizeMeasurementLocation,
} from './measurement-report.js'
import {
  buildMeasurementPlanV2ReportInput,
  latestMeasurementRun,
  measurementRunExpectedSlots,
  runVersionServesActiveVersion,
} from './measurement-report-adapter.js'

const DEFAULT_LIMIT = 50
const TERMINAL_STATUSES = new Set<string>([
  RunStatuses.completed,
  RunStatuses.partial,
])

// Provider payloads can be much larger than a question read needs. Keep the
// normal materialization projection honest: legacy raw evidence is loaded only
// below, and only for a selected row that has no captured URL column.
const { rawResponse: omittedRawResponse, ...measurementQuestionSnapshotColumns } = getTableColumns(querySnapshots)
void omittedRawResponse

type MeasurementQuestionSnapshot = Omit<typeof querySnapshots.$inferSelect, 'rawResponse'>

interface MeasurementQuestionRunScope {
  executionIds: readonly string[]
  provider?: string
  location?: string
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
}

function excerptOf(answer: string): string {
  const normalized = answer.normalize('NFKC').trim().replace(/\s+/g, ' ')
  return normalized.length <= 240 ? normalized : normalized.slice(0, 240)
}

function parsePropertyQuestionsQuery(raw: Record<string, unknown>) {
  const candidate = {
    ...raw,
    ...(raw.offset === undefined ? {} : { offset: Number(raw.offset) }),
    ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }),
  }
  const parsed = measurementPropertyQuestionsQuerySchema.safeParse(candidate)
  if (!parsed.success) {
    throw validationError('Invalid measurement property questions query', { issues: parsed.error.issues })
  }
  return parsed.data
}

function parseQuestionResultQuery(raw: Record<string, unknown>) {
  const parsed = measurementQuestionResultQuerySchema.safeParse(raw)
  if (!parsed.success) {
    throw validationError('Invalid measurement question result query', { issues: parsed.error.issues })
  }
  return parsed.data
}

function measurementDto(
  active: ActiveMeasurementPlan,
  run: typeof runs.$inferSelect | undefined,
) {
  return {
    state: run === undefined ? 'not_measured' : displayedState(run.status),
    displayedRunId: run?.id ?? null,
    planRevision: active.version.revision,
    completedAt: run?.finishedAt ?? null,
  }
}

function activeV2Plan(db: DatabaseClient, projectId: string): { active: ActiveMeasurementPlan; plan: MeasurementPlanV2 } {
  const active = activeMeasurementPlan(db, projectId)
  if (!active) throw notFound('Active measurement plan', projectId)
  if (active.plan.schemaVersion !== MEASUREMENT_PLAN_V2_SCHEMA_VERSION) {
    throw validationError(
      'Property questions are not available for a schema v1 revision. Republish setup before reading individual questions.',
    )
  }
  return { active, plan: active.plan }
}

function requireTarget(plan: MeasurementPlanV2, targetKey: string) {
  const target = plan.targets.find(candidate => candidate.stableKey === targetKey)
  if (!target) throw validationError(`Measurement Property "${targetKey}" is not in the active revision.`)
  return target
}

function targetExecutionIds(
  plan: MeasurementPlanV2,
  targetKey: string,
  queryClass: 'all' | 'branded' | 'non-brand',
): string[] {
  return [...new Set(plan.assignments
    .filter(assignment => assignment.targetKey === targetKey)
    .filter(assignment => queryClass === 'all' || assignment.queryClass === queryClass)
    .map(assignment => assignment.executionNodeKey))]
}

/**
 * A named spot check may reuse an execution that another Property shares.
 * Its resolved target list is authoritative when it exists; deriving from
 * execution IDs in that case would accidentally disclose the sibling.
 */
export function assertMeasurementQuestionTargetScope(
  plan: MeasurementPlanV2,
  run: typeof runs.$inferSelect,
  targetKey: string,
): void {
  if (run.measurementScope === null) return
  if (run.measurementScope.resolvedTargets.length > 0) {
    if (run.measurementScope.resolvedTargets.includes(targetKey)) return
    throw validationError('The requested Property is outside the selected spot check.')
  }
  const executionIds = new Set(measurementRunExpectedSlots(run, plan).expectedSlots
    .map(slot => slot.executionId))
  const scopedTargets = new Set(plan.usageEdges
    .filter(edge => executionIds.has(edge.executionNodeKey))
    .map(edge => edge.targetKey))
  if (!scopedTargets.has(targetKey)) {
    throw validationError('The requested Property is outside the selected spot check.')
  }
}

/**
 * Default selection intentionally excludes probes and scoped work. A caller
 * that knows it needs a spot check (or a partial terminal run) may name it
 * explicitly; both paths still require the active immutable revision.
 */
export function selectMeasurementQuestionRun(
  db: DatabaseClient,
  projectId: string,
  active: ActiveMeasurementPlan,
  runId: string | undefined,
): typeof runs.$inferSelect | undefined {
  if (runId === undefined) {
    return latestMeasurementRun(db, projectId, active.version.id, [RunStatuses.completed])
  }

  const run = db.select().from(runs).where(and(
    eq(runs.id, runId),
    eq(runs.projectId, projectId),
  )).get()
  if (!run) throw notFound('Run', runId)
  // A run pinned to a comparable prior revision (a label-only republish chain)
  // measured exactly the questions the active revision asks, so naming it is
  // continuity, not cross-revision mixing.
  if (!runVersionServesActiveVersion(db, projectId, active.version.id, run.measurementPlanVersionId)) {
    const pinned = run.measurementPlanVersionId === null
      ? null
      : db.select({ revision: measurementPlanVersions.revision }).from(measurementPlanVersions)
          .where(eq(measurementPlanVersions.id, run.measurementPlanVersionId)).get()?.revision ?? null
    throw runRevisionMismatch(run.id, pinned, active.version.revision)
  }
  if (run.kind !== RunKinds['answer-visibility']) {
    throw validationError(`Run "${run.id}" is not an answer-visibility measurement run.`)
  }
  // A plan slice is deliberately stored as a probe so it never contaminates
  // full-plan reporting. It is still a valid explicit drill-down because its
  // frozen scope and active revision identify exactly what it measured.
  if (run.trigger === 'probe' && run.measurementScope === null) {
    throw validationError(`Run "${run.id}" is a probe and cannot be used for a measurement result read.`)
  }
  if (!TERMINAL_STATUSES.has(run.status)) {
    throw validationError(`Run "${run.id}" is not terminal. Wait for it to finish before reading its question results.`)
  }
  return run
}

function slotKey(executionId: string, provider: string): string {
  return `${executionId}\u0000${normalizeText(provider)}`
}

function scopedManifest(
  manifest: ReturnType<typeof measurementRunExpectedSlots>,
  scope: MeasurementQuestionRunScope | undefined,
) {
  if (scope === undefined) return manifest
  const executionIds = new Set(scope.executionIds)
  const provider = scope.provider === undefined ? undefined : normalizeText(scope.provider)
  const location = scope.location === undefined ? undefined : normalizeMeasurementLocation(scope.location)
  return {
    ...manifest,
    expectedSlots: manifest.expectedSlots.filter(slot => (
      executionIds.has(slot.executionId)
      && (provider === undefined || normalizeText(slot.provider) === provider)
      && (location === undefined || normalizeMeasurementLocation(slot.context?.label ?? null) === location)
    )),
  }
}

function selectedQuestionSnapshots(
  db: DatabaseClient,
  runId: string,
  manifest: ReturnType<typeof measurementRunExpectedSlots>,
  scope: MeasurementQuestionRunScope | undefined,
): MeasurementQuestionSnapshot[] {
  const conditions = [eq(querySnapshots.runId, runId)]
  if (scope !== undefined) {
    const executionIds = [...new Set(manifest.expectedSlots.map(slot => slot.executionId))]
    if (executionIds.length === 0) return []
    conditions.push(inArray(querySnapshots.measurementExecutionId, executionIds))
  }
  if (scope?.provider !== undefined) {
    // Plan/provider identities are normalized, but preserve historical rows
    // whose provider casing predates that convention.
    conditions.push(sql`lower(trim(${querySnapshots.provider})) = ${normalizeText(scope.provider)}`)
  }
  return db.select(measurementQuestionSnapshotColumns)
    .from(querySnapshots)
    .where(and(...conditions))
    .all()
}

function rawResponsesForLegacyQuestionSnapshots(
  db: DatabaseClient,
  runId: string,
  snapshots: readonly MeasurementQuestionSnapshot[],
): ReadonlyMap<string, string | null> {
  const legacyIds = snapshots
    .filter(snapshot => snapshot.citedUrls === null)
    .map(snapshot => snapshot.id)
  if (legacyIds.length === 0) return new Map()
  return new Map(db.select({
    id: querySnapshots.id,
    rawResponse: querySnapshots.rawResponse,
  }).from(querySnapshots).where(and(
    eq(querySnapshots.runId, runId),
    inArray(querySnapshots.id, legacyIds),
  )).all().map(snapshot => [snapshot.id, snapshot.rawResponse]))
}

function withLegacyRawEvidence(
  db: DatabaseClient,
  runId: string,
  snapshots: readonly MeasurementQuestionSnapshot[],
): Array<typeof querySnapshots.$inferSelect> {
  const rawResponses = rawResponsesForLegacyQuestionSnapshots(db, runId, snapshots)
  return snapshots.map(snapshot => ({
    ...snapshot,
    rawResponse: rawResponses.get(snapshot.id) ?? null,
  }))
}

export function materializeMeasurementQuestionRun(
  db: DatabaseClient,
  active: ActiveMeasurementPlan,
  plan: MeasurementPlanV2,
  run: typeof runs.$inferSelect,
  scope?: MeasurementQuestionRunScope,
) {
  const manifest = scopedManifest(measurementRunExpectedSlots(run, plan), scope)
  const selectedSnapshots = selectedQuestionSnapshots(db, run.id, manifest, scope)
  const snapshots = withLegacyRawEvidence(db, run.id, selectedSnapshots)
  const { input, edgeQueryClass } = buildMeasurementPlanV2ReportInput(
    active.version.revision,
    plan,
    manifest,
    snapshots,
  )
  const evidence = buildMeasurementEvidence(input)

  const snapshotsById = new Map(snapshots.map(snapshot => [snapshot.id, snapshot]))
  const slotsByIdentity = new Map(input.expectedSlots.map(slot => [slotKey(slot.executionId, slot.provider), slot]))
  const unusableObservationIds = new Set([
    ...evidence.diagnostics.ambiguousObservationIds,
    ...evidence.diagnostics.unmatchedObservationIds,
  ])
  const observationsBySlot = new Map<string, typeof input.observations[number]>()
  for (const observation of input.observations) {
    if (observation.executionId === null || unusableObservationIds.has(observation.id)) continue
    const slot = slotsByIdentity.get(slotKey(observation.executionId, observation.provider))
    if (slot) observationsBySlot.set(slot.id, observation)
  }

  const manifestSlotsByIdentity = new Map(manifest.expectedSlots.map(slot => [slotKey(slot.executionId, slot.provider), slot]))
  return {
    manifest,
    snapshots,
    input,
    edgeQueryClass,
    evidence,
    snapshotsById,
    observationsBySlot,
    manifestSlotsByIdentity,
  }
}

function questionRows(
  plan: MeasurementPlanV2,
  target: MeasurementPlanV2['targets'][number],
  materialized: ReturnType<typeof materializeMeasurementQuestionRun>,
  filters: { queryClass?: 'all' | 'branded' | 'non-brand'; provider?: string; location?: string } = {},
) {
  const targetKey = target.stableKey
  const queryById = new Map(plan.querySnapshots.map(query => [query.queryId, query]))
  const assignmentsByExecution = new Map<string, MeasurementPlanV2['assignments'][number]>()
  for (const assignment of plan.assignments) {
    if (assignment.targetKey !== targetKey) continue
    if (filters.queryClass !== undefined && filters.queryClass !== 'all' && assignment.queryClass !== filters.queryClass) continue
    assignmentsByExecution.set(assignment.executionNodeKey, assignment)
  }
  const ownEdgesByExecution = new Map(materialized.input.usageEdges
    .filter(edge => edge.type === 'target' && edge.targetId === targetKey)
    .filter(edge => assignmentsByExecution.has(edge.executionId))
    .map(edge => [edge.executionId, edge]))
  const ownEdgeIds = new Set([...ownEdgesByExecution.values()].map(edge => edge.id))
  const answerBySlot = new Map(materialized.evidence.answers.filter(answer => ownEdgeIds.has(answer.usageEdgeId)).map(answer => [answer.expectedSlotId, answer]))
  const citedSlotIds = new Set(materialized.evidence.evidence
    .filter(row => ownEdgeIds.has(row.usageEdgeId) && row.classification === 'assigned')
    .map(row => row.expectedSlotId))
  const incompleteObservationIds = new Set(materialized.evidence.diagnostics.evidenceIncompleteObservationIds)
  const rows: Array<{
    resultId: string | null
    snapshotId: string | null
    queryId: string
    text: string
    class: 'branded' | 'non-brand'
    provider: string
    requestedModel: string | null
    servedModel: string | null
    location: string | null
    status: 'answered' | 'missing'
    mentioned: boolean | null
    cited: boolean | null
    recommendedInstead: string[]
    answerExcerpt: string | null
    edgeId: string
  }> = []

  for (const slot of materialized.input.expectedSlots) {
    const assignment = assignmentsByExecution.get(slot.executionId)
    if (!assignment) continue
    if (filters.provider !== undefined && normalizeText(slot.provider) !== normalizeText(filters.provider)) continue
    if (filters.location !== undefined && normalizeMeasurementLocation(slot.location) !== normalizeMeasurementLocation(filters.location)) continue

    const question = queryById.get(assignment.queryId)
    const manifestSlot = materialized.manifestSlotsByIdentity.get(slotKey(slot.executionId, slot.provider))
    const edge = ownEdgesByExecution.get(slot.executionId)
    const frozenClass = edge === undefined ? undefined : materialized.edgeQueryClass.get(edge.id)
    if (!question || !manifestSlot || edge === undefined) {
      throw new Error(`measurement question provenance is corrupt for execution ${slot.executionId}`)
    }
    if (!frozenClass) throw new Error(`measurement question class is corrupt for execution ${slot.executionId}`)
    const observation = materialized.observationsBySlot.get(slot.id)
    const snapshot = observation === undefined ? undefined : materialized.snapshotsById.get(observation.id)
    const answer = observation?.answerText ?? null
    const answered = snapshot !== undefined && answer !== null
    rows.push({
      resultId: answered ? snapshot.id : null,
      snapshotId: snapshot?.id ?? null,
      queryId: assignment.queryId,
      text: question.queryText,
      class: frozenClass,
      provider: slot.provider,
      requestedModel: manifestSlot.requestedModel ?? null,
      servedModel: snapshot?.servedModel ?? null,
      location: slot.location,
      status: answered ? 'answered' : 'missing',
      mentioned: answered && !target.mentionNotApplicable
        ? answerBySlot.get(slot.id)?.mentioned ?? null
        : null,
      cited: answered
        ? (citedSlotIds.has(slot.id) ? true : incompleteObservationIds.has(snapshot.id) ? null : false)
        : null,
      recommendedInstead: answered ? recommendedInstead(snapshot.recommendedCompetitors, target) : [],
      answerExcerpt: answered ? excerptOf(answer) : null,
      edgeId: edge.id,
    })
  }

  // A revision normally has one assignment per Target/execution. Retain only
  // one row if corrupt historical bytes say otherwise: the slot is one provider
  // request, never two Property question results.
  const deduped = new Map<string, typeof rows[number]>()
  for (const row of rows) {
    const key = `${row.queryId}\u0000${row.provider}\u0000${row.location ?? ''}`
    if (!deduped.has(key)) deduped.set(key, row)
  }
  return [...deduped.values()].sort((left, right) => (
    compareText(left.queryId, right.queryId)
    || compareText(left.provider, right.provider)
    || compareText(left.location ?? '', right.location ?? '')
    || compareText(left.text, right.text)
  ))
}

function recommendedInstead(
  candidates: readonly string[],
  target: MeasurementPlanV2['targets'][number],
): string[] {
  const ownNames = new Set([target.label, ...target.aliases]
    .map(brandKeyFromText)
    .filter(key => key.length > 0))
  return candidates.filter(candidate => {
    const key = brandKeyFromText(candidate)
    return key.length > 0 && !ownNames.has(key)
  })
}

function compactQuestion(row: ReturnType<typeof questionRows>[number]) {
  return {
    resultId: row.resultId,
    queryId: row.queryId,
    text: row.text,
    class: row.class,
    provider: row.provider,
    requestedModel: row.requestedModel,
    servedModel: row.servedModel,
    location: row.location,
    status: row.status,
    mentioned: row.mentioned,
    cited: row.cited,
    recommendedInstead: row.recommendedInstead,
    answerExcerpt: row.answerExcerpt,
  }
}

function propertyDto(target: MeasurementPlanV2['targets'][number]) {
  return { targetKey: target.stableKey, label: target.label }
}

function sourcesForResult(
  materialized: ReturnType<typeof materializeMeasurementQuestionRun>,
  row: ReturnType<typeof questionRows>[number],
) {
  if (row.snapshotId === null) return []
  return materialized.evidence.evidence
    .filter(evidence => evidence.observationId === row.snapshotId && evidence.usageEdgeId === row.edgeId)
    .map(evidence => ({
      url: evidence.sourceUrl,
      classification: evidence.classification,
      matchedTargetKeys: evidence.matchedTargetIds,
      assigned: evidence.classification === 'assigned',
      historical: evidence.historical,
      evidenceComplete: evidence.evidenceComplete,
    }))
}

export async function measurementQuestionReadRoutes(app: FastifyInstance) {
  app.get<{ Params: { name: string }; Querystring: Record<string, unknown> }>(
    '/projects/:name/measurement-property-questions',
    async request => {
      const project = resolveProject(app.db, request.params.name)
      const query = parsePropertyQuestionsQuery(request.query)
      const { active, plan } = activeV2Plan(app.db, project.id)
      const target = requireTarget(plan, query.targetKey)
      const run = selectMeasurementQuestionRun(app.db, project.id, active, query.runId)
      const queryClass = query.queryClass ?? 'all'
      if (run === undefined) {
        return measurementPropertyQuestionsResponseSchema.parse({
          property: propertyDto(target),
          measurement: measurementDto(active, undefined),
          queryClass,
          questions: [],
          total: 0,
          truncated: false,
        })
      }
      assertMeasurementQuestionTargetScope(plan, run, target.stableKey)

      const materialized = materializeMeasurementQuestionRun(app.db, active, plan, run, {
        executionIds: targetExecutionIds(plan, target.stableKey, queryClass),
        provider: query.provider,
        location: query.location,
      })
      const rows = questionRows(plan, target, materialized, {
        queryClass,
        provider: query.provider,
        location: query.location,
      })
      const limit = query.limit ?? DEFAULT_LIMIT
      const offset = query.offset ?? 0
      return measurementPropertyQuestionsResponseSchema.parse({
        property: propertyDto(target),
        measurement: measurementDto(active, run),
        queryClass,
        questions: rows.slice(offset, offset + limit).map(compactQuestion),
        total: rows.length,
        truncated: rows.length > offset + limit,
      })
    },
  )

  app.get<{ Params: { name: string }; Querystring: Record<string, unknown> }>(
    '/projects/:name/measurement-question-result',
    async request => {
      const project = resolveProject(app.db, request.params.name)
      const query = parseQuestionResultQuery(request.query)
      const { active, plan } = activeV2Plan(app.db, project.id)
      const target = requireTarget(plan, query.targetKey)

      const snapshot = app.db.select(measurementQuestionSnapshotColumns)
        .from(querySnapshots).where(eq(querySnapshots.id, query.resultId)).get()
      if (!snapshot) throw notFound('Measurement question result', query.resultId)
      const run = app.db.select().from(runs).where(and(
        eq(runs.id, snapshot.runId),
        eq(runs.projectId, project.id),
      )).get()
      if (!run) throw notFound('Measurement question result', query.resultId)
      // The shared selector owns the cross-revision and terminal-policy checks.
      const selected = selectMeasurementQuestionRun(app.db, project.id, active, run.id)
      if (!selected) throw notFound('Measurement question result', query.resultId)
      assertMeasurementQuestionTargetScope(plan, selected, target.stableKey)

      const materialized = materializeMeasurementQuestionRun(app.db, active, plan, selected, {
        executionIds: snapshot.measurementExecutionId === null ? [] : [snapshot.measurementExecutionId],
        provider: snapshot.provider,
      })
      const row = questionRows(plan, target, materialized)
        .find(candidate => candidate.resultId === query.resultId)
      if (!row) throw notFound('Measurement question result', query.resultId)
      const stored = materialized.snapshotsById.get(query.resultId)
      if (!stored) throw notFound('Measurement question result', query.resultId)

      return measurementQuestionResultResponseSchema.parse({
        property: propertyDto(target),
        measurement: measurementDto(active, selected),
        question: {
          resultId: query.resultId,
          queryId: row.queryId,
          text: row.text,
          class: row.class,
          provider: row.provider,
          requestedModel: row.requestedModel,
          servedModel: row.servedModel,
          location: row.location,
          status: row.status,
        },
        mentioned: row.mentioned,
        cited: row.cited,
        recommendedInstead: row.recommendedInstead,
        answer: stored.answerText,
        sources: sourcesForResult(materialized, row),
        captureStatus: stored.captureStatus,
        retrievalStatus: stored.retrievalStatus,
        retrievalContract: stored.retrievalContract,
      })
    },
  )
}
