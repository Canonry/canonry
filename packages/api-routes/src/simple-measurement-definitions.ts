import crypto from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import {
  canonicalSimpleMeasurementDefinitionJson,
  compileQueryClassifier,
  effectiveBrandNames,
  notFound,
  RunKinds,
  RunStatuses,
  RunTriggers,
  simpleMeasurementDefinitionSchema,
  validationError,
  type SimpleMeasurementDefinition,
} from '@ainyc/canonry-contracts'
import { competitors, queries, querySnapshots, runs, simpleMeasurementDefinitions, type DatabaseClient } from '@ainyc/canonry-db'

/**
 * Record actual dispatch inputs, not the configuration at queue time.
 * The runner supplies its resolved basket; this helper does not select queries.
 * Existing plan manifests remain authoritative for advanced runs.
 */
export function captureSimpleMeasurementDefinition(db: DatabaseClient, input: {
  projectId: string
  runId: string
  definition: SimpleMeasurementDefinition
}): SimpleMeasurementDefinition | null {
  return db.transaction((tx) => {
    const run = tx.select({
      kind: runs.kind,
      trigger: runs.trigger,
      status: runs.status,
      measurementPlanVersionId: runs.measurementPlanVersionId,
    }).from(runs).where(and(eq(runs.projectId, input.projectId), eq(runs.id, input.runId))).get()
    if (!run) throw notFound('Run', input.runId)
    if (run.kind !== RunKinds['answer-visibility'] || run.trigger === RunTriggers.probe || run.measurementPlanVersionId !== null) {
      return null
    }

    const definition = simpleMeasurementDefinitionSchema.parse(input.definition)
    const classifier = compileQueryClassifier(effectiveBrandNames(definition.identity))
    if (definition.queries.some(query => query.queryClass !== (classifier?.classify(query.queryText) ?? null))) {
      throw validationError('Query classes must match the captured identity and text.')
    }
    const existing = tx.select().from(simpleMeasurementDefinitions)
      .where(and(eq(simpleMeasurementDefinitions.projectId, input.projectId), eq(simpleMeasurementDefinitions.runId, input.runId))).get()
    if (existing) {
      const frozen = simpleMeasurementDefinitionSchema.parse(existing.definition)
      // A later invocation must keep the original timestamp, but cannot change
      // any execution input or reinterpret its captured classification.
      const replayDefinition = {
        ...definition, capturedAt: frozen.capturedAt,
      }
      const replayChecksum = crypto.createHash('sha256').update(canonicalSimpleMeasurementDefinitionJson(replayDefinition)).digest('hex')
      if (existing.checksum !== replayChecksum) {
        // The competitor capture field was introduced after early sidecars
        // existed. A retry of such a run now supplies the current empty/live
        // competitor list, but must retain the old sidecar exactly as-is: an
        // omitted list means unavailable historical competitor identities, not
        // an inferred empty frozen set. Only this additive-field delta is safe.
        if (frozen.competitors === undefined) {
          const { competitors: _currentCompetitors, ...legacyReplayDefinition } = replayDefinition
          const legacyReplayChecksum = crypto.createHash('sha256')
            .update(canonicalSimpleMeasurementDefinitionJson(legacyReplayDefinition)).digest('hex')
          if (existing.checksum === legacyReplayChecksum) return frozen
        }
        throw validationError('This run already has a captured measurement definition. Start a new run for changed inputs.')
      }
      return frozen
    }
    if (run.status !== RunStatuses.running) {
      throw validationError('Only a running run can capture a new measurement definition.')
    }
    if (tx.select({ id: querySnapshots.id }).from(querySnapshots)
      .where(eq(querySnapshots.runId, input.runId)).limit(1).get()) {
      throw validationError('This run already has stored answers. Its measurement definition cannot be inferred afterward.')
    }

    const projectQueryIds = new Set(tx.select({ id: queries.id }).from(queries)
      .where(eq(queries.projectId, input.projectId)).all().map(query => query.id))
    if (definition.queries.some(query => !projectQueryIds.has(query.queryId))) {
      throw validationError('Every captured query must belong to the run project.')
    }
    if (definition.competitors !== undefined) {
      const liveCompetitorDomains = new Set(tx.select({ domain: competitors.domain }).from(competitors)
        .where(eq(competitors.projectId, input.projectId)).all()
        .map(competitor => competitor.domain.trim().toLocaleLowerCase('en')))
      const capturedDomains = new Set(definition.competitors.map(competitor => competitor.domain.trim().toLocaleLowerCase('en')))
      if (liveCompetitorDomains.size !== capturedDomains.size
        || [...liveCompetitorDomains].some(domain => !capturedDomains.has(domain))) {
        throw validationError('Captured competitors must exactly match the project competitors dispatched for this run.')
      }
    }

    const checksum = crypto.createHash('sha256')
      .update(canonicalSimpleMeasurementDefinitionJson(definition)).digest('hex')
    tx.insert(simpleMeasurementDefinitions).values({
      projectId: input.projectId,
      runId: input.runId,
      definition,
      checksum,
      capturedAt: definition.capturedAt,
    }).run()
    return definition
  })
}
