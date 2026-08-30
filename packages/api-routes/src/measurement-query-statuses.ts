import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION,
  RunStatuses,
  measurementQueryStatusesResponseSchema,
  type MeasurementPlanV2,
  type MeasurementQueryStatus,
  type MeasurementQueryStatusesResponse,
  type MeasurementRunManifestV1,
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

function partialStatuses(queryIds: readonly string[], assigned: ReadonlySet<string>): MeasurementQueryStatusesResponse['queries'] {
  return queryIds.map(queryId => ({ queryId, status: assigned.has(queryId) ? 'partial' as const : 'not_in_plan' as const }))
}

function awaitingStatuses(queryIds: readonly string[], assigned: ReadonlySet<string>): MeasurementQueryStatusesResponse['queries'] {
  return queryIds.map(queryId => ({ queryId, status: assigned.has(queryId) ? 'awaiting_first_sweep' as const : 'not_in_plan' as const }))
}

function notInPlanStatuses(queryIds: readonly string[]): MeasurementQueryStatusesResponse['queries'] {
  return queryIds.map(queryId => ({ queryId, status: 'not_in_plan' as const }))
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
  const active = activeMeasurementPlan(db, projectId)

  if (!active) {
    return measurementQueryStatusesResponseSchema.parse({
      setupMode: 'simple',
      activeRevision: null,
      latestOfficialFullRun: null,
      queries: notInPlanStatuses(queryIds),
    })
  }

  if (active.plan.schemaVersion !== MEASUREMENT_PLAN_V2_SCHEMA_VERSION) {
    return measurementQueryStatusesResponseSchema.parse({
      setupMode: 'active-v1',
      activeRevision: active.version.revision,
      latestOfficialFullRun: null,
      queries: notInPlanStatuses(queryIds),
    })
  }

  const plan = active.plan
  const assigned = assignedQueryIds(plan)
  const run = latestMeasurementRun(db, projectId, active.version.id, [RunStatuses.completed, RunStatuses.partial])
  if (!run) {
    return measurementQueryStatusesResponseSchema.parse({
      setupMode: 'active-v2',
      activeRevision: active.version.revision,
      latestOfficialFullRun: null,
      queries: awaitingStatuses(queryIds, assigned),
    })
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
    return measurementQueryStatusesResponseSchema.parse({
      setupMode: 'active-v2',
      activeRevision: active.version.revision,
      latestOfficialFullRun: provenance,
      queries: partialStatuses(queryIds, assigned),
    })
  }

  let manifest: MeasurementRunManifestV1
  try {
    // This validates the stored manifest against every frozen execution node.
    // The v2 provider roster is then compared exactly below, because equal slot
    // counts alone would let a different engine impersonate a planned slot.
    manifest = measurementRunExpectedSlots(run, plan)
    if (!sameSlots(manifest, buildMeasurementPlanV2Manifest(plan))) throw new Error('manifest provider roster differs from active plan')
  } catch {
    return measurementQueryStatusesResponseSchema.parse({
      setupMode: 'active-v2',
      activeRevision: active.version.revision,
      latestOfficialFullRun: provenance,
      queries: partialStatuses(queryIds, assigned),
    })
  }

  const wholeRun = measurementRunCompleteness(db, run.id)
  if (!wholeRun.planned) {
    return measurementQueryStatusesResponseSchema.parse({
      setupMode: 'active-v2',
      activeRevision: active.version.revision,
      latestOfficialFullRun: provenance,
      queries: partialStatuses(queryIds, assigned),
    })
  }

  const expectedByQuery = expectedSlotsByQuery(plan, manifest)
  const queryIdByExecution = new Map(plan.executionNodes.map(node => [node.stableKey, node.queryId]))
  const evidence = completedSlots(db, run.id, manifest, queryIdByExecution)
  if (evidence.incompatible) {
    return measurementQueryStatusesResponseSchema.parse({
      setupMode: 'active-v2',
      activeRevision: active.version.revision,
      latestOfficialFullRun: provenance,
      queries: partialStatuses(queryIds, assigned),
    })
  }
  const statusRows = queryIds.map((queryId) => {
    if (!assigned.has(queryId)) return { queryId, status: 'not_in_plan' as const }
    const expected = expectedByQuery.get(queryId)
    const complete = expected !== undefined
      && expected.size > 0
      && [...expected].every(slot => evidence.completed.has(slot) && !evidence.corrupt.has(slot))
    const status: MeasurementQueryStatus = complete ? 'measured' : 'partial'
    return { queryId, status }
  })

  return measurementQueryStatusesResponseSchema.parse({
    setupMode: 'active-v2',
    activeRevision: active.version.revision,
    latestOfficialFullRun: provenance,
    queries: statusRows,
  })
}

export async function measurementQueryStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { name: string } }>('/projects/:name/measurement-query-statuses', async request => {
    const project = resolveProject(app.db, request.params.name)
    return measurementQueryStatuses(app.db, project.id)
  })
}
