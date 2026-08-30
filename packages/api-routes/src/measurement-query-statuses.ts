import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION,
  QUERY_CLASSES,
  RunStatuses,
  measurementQueryStatusesResponseSchema,
  type MeasurementPlanV2,
  type MeasurementQueryAssignmentScope,
  type MeasurementQueryStatus,
  type MeasurementQueryStatusesResponse,
  type MeasurementRunManifestV1,
  type QueryClass,
  type StoredMeasurementPlan,
} from '@ainyc/canonry-contracts'
import {
  queries,
  querySnapshots,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { resolveProject } from './helpers.js'
import { activeMeasurementPlan } from './measurement-overview.js'
import {
  buildMeasurementPlanV2Manifest,
  latestMeasurementRun,
  measurementRunExpectedSlots,
  validateMeasurementExecutionSnapshot,
} from './measurement-report-adapter.js'
import { measurementRunCompleteness } from './measurement-run-completeness.js'

function slotKey(executionId: string, provider: string): string {
  return `${executionId}\u0000${provider.trim().toLocaleLowerCase('en')}`
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sameSlots(left: MeasurementRunManifestV1, right: MeasurementRunManifestV1): boolean {
  if (left.expectedSlots.length !== right.expectedSlots.length) return false
  const expected = new Map(right.expectedSlots.map(slot => [slotKey(slot.executionId, slot.provider), slot]))
  return left.expectedSlots.every((slot) => {
    const activeSlot = expected.get(slotKey(slot.executionId, slot.provider))
    // A declared v2 model is part of the published plan. A model resolved from
    // the host after a plan intentionally leaves it open is run provenance,
    // not an active-plan promise, so it cannot be compared here.
    return activeSlot !== undefined
      && (activeSlot.requestedModel === undefined || slot.requestedModel === activeSlot.requestedModel)
  })
}

function assignedQueryIds(plan: MeasurementPlanV2): Set<string> {
  return new Set(plan.assignments.map(assignment => assignment.queryId))
}

function expectedSlotsByQuery(
  plan: MeasurementPlanV2,
  manifest: MeasurementRunManifestV1,
): Map<string, Set<string>> {
  const queryIdByExecution = new Map(plan.executionNodes.map(node => [node.stableKey, node.queryId]))
  const assigned = assignedQueryIds(plan)
  const result = new Map<string, Set<string>>()
  for (const queryId of assigned) result.set(queryId, new Set())
  for (const slot of manifest.expectedSlots) {
    const queryId = queryIdByExecution.get(slot.executionId)
    if (!queryId || !assigned.has(queryId)) continue
    result.get(queryId)!.add(slotKey(slot.executionId, slot.provider))
  }
  return result
}

function completedSlots(
  db: DatabaseClient,
  runId: string,
  manifest: MeasurementRunManifestV1,
  queryIdByExecution: ReadonlyMap<string, string>,
): { completed: Set<string>; corrupt: Set<string>; incompatible: boolean } {
  const expected = new Map(manifest.expectedSlots.map(slot => [slotKey(slot.executionId, slot.provider), slot]))
  const completed = new Set<string>()
  const corrupt = new Set<string>()
  let incompatible = false
  const rows = db.select()
    .from(querySnapshots)
    .where(eq(querySnapshots.runId, runId))
    .all()
  for (const row of rows) {
    const executionId = row.measurementExecutionId?.trim()
    if (!executionId) {
      // A plan-pinned run cannot contain a row that belongs to no frozen slot.
      // Treat it as incompatible rather than silently excluding it from the
      // denominator after every expected row happened to arrive.
      incompatible = true
      continue
    }
    const key = slotKey(executionId, row.provider)
    const slot = expected.get(key)
    if (!slot) {
      // A full, version-pinned run cannot contain an execution row outside its
      // exhaustive manifest. Do not let an extra or mismatched row silently
      // coexist with an otherwise complete result.
      incompatible = true
      continue
    }
    try {
      if (row.queryId !== queryIdByExecution.get(slot.executionId)) {
        throw new Error(`measurement snapshot query is corrupt: ${row.id}`)
      }
      validateMeasurementExecutionSnapshot(row, slot)
      completed.add(key)
    } catch {
      corrupt.add(key)
    }
  }
  return { completed, corrupt, incompatible }
}

type ReadinessRow = Pick<MeasurementQueryStatusesResponse['queries'][number], 'queryId' | 'status'>
type TrackedQuery = { id: string; query: string }

function partialStatuses(queryIds: readonly string[], assigned: ReadonlySet<string>): ReadinessRow[] {
  return queryIds.map(queryId => ({ queryId, status: assigned.has(queryId) ? 'partial' as const : 'not_in_plan' as const }))
}

function awaitingStatuses(queryIds: readonly string[], assigned: ReadonlySet<string>): ReadinessRow[] {
  return queryIds.map(queryId => ({ queryId, status: assigned.has(queryId) ? 'awaiting_first_sweep' as const : 'not_in_plan' as const }))
}

function notInPlanStatuses(queryIds: readonly string[]): ReadinessRow[] {
  return queryIds.map(queryId => ({ queryId, status: 'not_in_plan' as const }))
}

function classCountsFor(classes: readonly QueryClass[]): Array<{ queryClass: QueryClass; assignedTargetCount: number }> {
  return QUERY_CLASSES.flatMap((queryClass) => {
    const assignedTargetCount = classes.filter(candidate => candidate === queryClass).length
    return assignedTargetCount > 0 ? [{ queryClass, assignedTargetCount }] : []
  })
}

function classStateFor(counts: readonly { queryClass: QueryClass }[]): 'branded' | 'non-brand' | 'mixed' {
  return counts.length === 2 ? 'mixed' : counts[0]!.queryClass
}

function frozenQueryText(plan: Pick<StoredMeasurementPlan, 'querySnapshots'>, queryId: string): string | null {
  return plan.querySnapshots.find(snapshot => snapshot.queryId === queryId)?.queryText ?? null
}

function simpleAssignmentScope(): MeasurementQueryAssignmentScope {
  return {
    mode: 'simple',
    activePlanQueryText: null,
    queryTextMatchesPlan: null,
    assignedTargetCount: null,
    classState: 'unavailable',
    queryClasses: [],
    classCounts: [],
    groupCoverage: [],
  }
}

function legacyAssignmentScope(
  plan: Exclude<StoredMeasurementPlan, MeasurementPlanV2>,
  queryId: string,
  currentQueryText: string | null,
): MeasurementQueryAssignmentScope {
  const activePlanQueryText = frozenQueryText(plan, queryId)
  return {
    mode: 'legacy',
    activePlanQueryText,
    queryTextMatchesPlan: activePlanQueryText === null || currentQueryText === null
      ? null
      : currentQueryText === activePlanQueryText,
    assignedTargetCount: null,
    classState: 'unavailable',
    queryClasses: [],
    classCounts: [],
    groupCoverage: [],
  }
}

function advancedAssignmentScope(
  plan: MeasurementPlanV2,
  queryId: string,
  currentQueryText: string | null,
): MeasurementQueryAssignmentScope {
  const assignments = plan.assignments.filter(assignment => assignment.queryId === queryId)
  if (assignments.length === 0) {
    return {
      mode: 'advanced_unassigned',
      activePlanQueryText: null,
      queryTextMatchesPlan: null,
      assignedTargetCount: 0,
      classState: 'none',
      queryClasses: [],
      classCounts: [],
      groupCoverage: [],
    }
  }

  const activePlanQueryText = frozenQueryText(plan, queryId)
  if (activePlanQueryText === null) {
    throw new Error(`Active v2 plan has assignments without frozen query text: ${queryId}`)
  }
  const assignmentByTarget = new Map(assignments.map(assignment => [assignment.targetKey, assignment.queryClass]))
  const classCounts = classCountsFor([...assignmentByTarget.values()])
  const groupCoverage = plan.groups
    .flatMap((group) => {
      const memberKeys = [...new Set(group.targetKeys)]
      const classes = memberKeys.flatMap((targetKey) => {
        const queryClass = assignmentByTarget.get(targetKey)
        return queryClass === undefined ? [] : [queryClass]
      })
      if (classes.length === 0) return []
      const assignedMemberCount = classes.length
      return [{
        groupKey: group.stableKey,
        label: group.label,
        memberCount: memberKeys.length,
        assignedMemberCount,
        coverage: assignedMemberCount === memberKeys.length ? 'complete' as const : 'partial' as const,
        classCounts: classCountsFor(classes),
      }]
    })
    .sort((left, right) => compareText(left.label, right.label) || compareText(left.groupKey, right.groupKey))

  return {
    mode: 'advanced_assigned',
    activePlanQueryText,
    queryTextMatchesPlan: currentQueryText === null ? null : currentQueryText === activePlanQueryText,
    assignedTargetCount: assignmentByTarget.size,
    classState: classStateFor(classCounts),
    queryClasses: classCounts.map(count => count.queryClass),
    classCounts,
    groupCoverage,
  }
}

function orphanQueryIds(plan: Pick<StoredMeasurementPlan, 'querySnapshots'>, trackedById: ReadonlyMap<string, TrackedQuery>): string[] {
  return plan.querySnapshots
    .filter(snapshot => !trackedById.has(snapshot.queryId))
    .sort((left, right) => compareText(left.queryText, right.queryText) || compareText(left.queryId, right.queryId))
    .map(snapshot => snapshot.queryId)
}

function decorateCurrentRows(
  readinessRows: readonly ReadinessRow[],
  trackedById: ReadonlyMap<string, TrackedQuery>,
  assignmentScopeFor: (queryId: string, currentQueryText: string) => MeasurementQueryAssignmentScope,
) {
  return readinessRows.map((row) => {
    const tracked = trackedById.get(row.queryId)
    if (!tracked) throw new Error(`Tracked query disappeared while deriving measurement status: ${row.queryId}`)
    return {
      ...row,
      catalogState: 'current' as const,
      currentQueryText: tracked.query,
      assignmentScope: assignmentScopeFor(row.queryId, tracked.query),
    }
  })
}

function decorateOrphanRows(
  orphanIds: readonly string[],
  readinessByQueryId: ReadonlyMap<string, ReadinessRow>,
  assignmentScopeFor: (queryId: string) => MeasurementQueryAssignmentScope,
) {
  return orphanIds.map((queryId) => {
    const readiness = readinessByQueryId.get(queryId)
    if (!readiness) throw new Error(`Missing readiness for active plan orphan: ${queryId}`)
    return {
      ...readiness,
      catalogState: 'missing' as const,
      currentQueryText: null,
      assignmentScope: assignmentScopeFor(queryId),
    }
  })
}

function readinessRowsForIds(
  queryIds: readonly string[],
  readinessByQueryId: ReadonlyMap<string, ReadinessRow>,
): ReadinessRow[] {
  return queryIds.map((queryId) => {
    const readiness = readinessByQueryId.get(queryId)
    if (!readiness) throw new Error(`Missing readiness for query: ${queryId}`)
    return readiness
  })
}

/**
 * A current tracked-query row may only cite the active v2 plan and its latest
 * eligible full official terminal run. This remains deliberately separate from
 * QueryDto so consumers cannot confuse static query identity with run-derived
 * measurement readiness.
 */
export function measurementQueryStatuses(
  db: DatabaseClient,
  projectId: string,
): MeasurementQueryStatusesResponse {
  const tracked = db.select({ id: queries.id, query: queries.query })
    .from(queries)
    .where(eq(queries.projectId, projectId))
    .all()
    .sort((left, right) => compareText(left.query, right.query) || compareText(left.id, right.id))
  const queryIds = tracked.map(row => row.id)
  const trackedById = new Map(tracked.map(row => [row.id, row]))
  const active = activeMeasurementPlan(db, projectId)

  if (!active) {
    const readiness = notInPlanStatuses(queryIds)
    return measurementQueryStatusesResponseSchema.parse({
      setupMode: 'simple',
      activeRevision: null,
      latestOfficialFullRun: null,
      queries: decorateCurrentRows(readiness, trackedById, () => simpleAssignmentScope()),
      activePlanOrphans: [],
    })
  }

  const activePlan = active.plan
  if (activePlan.schemaVersion !== MEASUREMENT_PLAN_V2_SCHEMA_VERSION) {
    const legacyPlan = activePlan
    const orphanIds = orphanQueryIds(legacyPlan, trackedById)
    const readiness = notInPlanStatuses([...queryIds, ...orphanIds])
    const readinessByQueryId = new Map(readiness.map(row => [row.queryId, row]))
    return measurementQueryStatusesResponseSchema.parse({
      setupMode: 'active-v1',
      activeRevision: active.version.revision,
      latestOfficialFullRun: null,
      queries: decorateCurrentRows(
        readinessRowsForIds(queryIds, readinessByQueryId),
        trackedById,
        (queryId, currentQueryText) => legacyAssignmentScope(legacyPlan, queryId, currentQueryText),
      ),
      activePlanOrphans: decorateOrphanRows(
        orphanIds,
        readinessByQueryId,
        queryId => legacyAssignmentScope(legacyPlan, queryId, null),
      ),
    })
  }

  const plan = activePlan
  const assigned = assignedQueryIds(plan)
  const orphanIds = orphanQueryIds(plan, trackedById)
  const statusQueryIds = [...queryIds, ...orphanIds]
  const v2Response = (
    latestOfficialFullRun: MeasurementQueryStatusesResponse['latestOfficialFullRun'],
    readiness: readonly ReadinessRow[],
  ): MeasurementQueryStatusesResponse => {
    const readinessByQueryId = new Map(readiness.map(row => [row.queryId, row]))
    return measurementQueryStatusesResponseSchema.parse({
      setupMode: 'active-v2',
      activeRevision: active.version.revision,
      latestOfficialFullRun,
      queries: decorateCurrentRows(
        readinessRowsForIds(queryIds, readinessByQueryId),
        trackedById,
        (queryId, currentQueryText) => advancedAssignmentScope(plan, queryId, currentQueryText),
      ),
      activePlanOrphans: decorateOrphanRows(
        orphanIds,
        readinessByQueryId,
        queryId => advancedAssignmentScope(plan, queryId, null),
      ),
    })
  }
  const run = latestMeasurementRun(db, projectId, active.version.id, [RunStatuses.completed, RunStatuses.partial])
  if (!run) {
    return v2Response(null, awaitingStatuses(statusQueryIds, assigned))
  }

  const provenance = {
    id: run.id,
    status: run.status === RunStatuses.completed ? RunStatuses.completed : RunStatuses.partial,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
  }

  // A terminal partial run is not a trustworthy published sweep even where a
  // few slots happened to land. Its partial state is itself authoritative.
  if (run.status !== RunStatuses.completed) {
    return v2Response(provenance, partialStatuses(statusQueryIds, assigned))
  }

  let manifest: MeasurementRunManifestV1
  try {
    // This validates the stored manifest against every frozen execution node.
    // The v2 provider roster is then compared exactly below, because equal slot
    // counts alone would let a different engine impersonate a planned slot.
    manifest = measurementRunExpectedSlots(run, plan)
    if (!sameSlots(manifest, buildMeasurementPlanV2Manifest(plan))) throw new Error('manifest provider roster differs from active plan')
  } catch {
    return v2Response(provenance, partialStatuses(statusQueryIds, assigned))
  }

  const wholeRun = measurementRunCompleteness(db, run.id)
  if (!wholeRun.planned) {
    return v2Response(provenance, partialStatuses(statusQueryIds, assigned))
  }

  const expectedByQuery = expectedSlotsByQuery(plan, manifest)
  const queryIdByExecution = new Map(plan.executionNodes.map(node => [node.stableKey, node.queryId]))
  const evidence = completedSlots(db, run.id, manifest, queryIdByExecution)
  if (evidence.incompatible) {
    return v2Response(provenance, partialStatuses(statusQueryIds, assigned))
  }
  const statusRows = statusQueryIds.map((queryId) => {
    if (!assigned.has(queryId)) return { queryId, status: 'not_in_plan' as const }
    const expected = expectedByQuery.get(queryId)
    const complete = expected !== undefined
      && expected.size > 0
      && [...expected].every(slot => evidence.completed.has(slot) && !evidence.corrupt.has(slot))
    const status: MeasurementQueryStatus = complete ? 'measured' : 'partial'
    return { queryId, status }
  })

  return v2Response(provenance, statusRows)
}

export async function measurementQueryStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { name: string } }>('/projects/:name/measurement-query-statuses', async request => {
    const project = resolveProject(app.db, request.params.name)
    return measurementQueryStatuses(app.db, project.id)
  })
}
