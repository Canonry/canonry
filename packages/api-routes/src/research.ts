import crypto from 'node:crypto'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  measurementPlanVersions,
  measurementPlans,
  projects,
  queries,
  researchRunQueries,
  researchRuns,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import {
  alreadyExists,
  canonicalMeasurementPlanV2Json,
  describeError,
  isBrowserProvider,
  measurementDraftEtag,
  measurementPlanV2ChecksumJson,
  measurementPlanV2Schema,
  missingDependency,
  normalizeQueryText,
  notFound,
  parseStoredMeasurementPlanAnyVersion,
  ResearchQueryStatuses,
  ResearchRunStatuses,
  researchPromotionPreviewRequestSchema,
  researchPromotionPreviewConflict,
  researchPromotionPreviewResponseSchema,
  researchPromotionCommitRequestSchema,
  researchPromotionCommitResultSchema,
  researchRunCreateSchema,
  RunStatuses,
  validationError,
  type LocationContext,
  type MeasurementDraftAuthoring,
  type MeasurementDraftAssignment,
  type MeasurementDraftCompileCheck,
  type MeasurementPlanV2,
  type ResearchPromotionPreviewResponse,
  type ResearchPromotionCommitResult,
  type ResearchPromotionRefusalReason,
  type ResearchRunDetailDto,
  type ResearchRunListDto,
  type ResearchRunQueryDto,
  type ResearchRunSummaryDto,
} from '@ainyc/canonry-contracts'
import { requireScope } from './auth.js'
import { auditFromRequest, resolveProject, writeAuditLog } from './helpers.js'
import {
  actionContextFor,
  assignmentExecutionImpact,
  authoringForCompile,
  compileContextFor,
  seedAuthoring,
} from './measurement-draft.js'
import { applyAssignmentsToAuthoring, applyDraftAction } from './measurement-draft-actions.js'
import { compileMeasurementDraft, diffCompiledPlans } from './measurement-draft-compile.js'
import {
  activePlanVersionRow,
  actorFromRequest,
  canonicalJson,
  draftRow,
  replayReceipt,
  requestChecksum,
  requireIdempotencyKey,
  serializeActor,
  sha256Hex,
  sweepExpiredMeasurementReceipts,
  writeReceipt,
  type ReceiptLookup,
} from './measurement-draft-repo.js'
import { MEASUREMENT_PLAN_WRITE_SCOPE } from './measurement-plan.js'
import { comparableMeasurementVersionIds } from './measurement-report-adapter.js'
import type { ProviderAdapterInfo } from './settings.js'

export interface ResearchRoutesOptions {
  providerAdapters?: ProviderAdapterInfo[]
  configuredProviderNames?: readonly string[]
  onResearchRunRequested?: (runId: string, projectId: string) => void
  getRunnableProviderNames?: () => readonly string[]
}

type ResearchPromotionReadDb = Pick<DatabaseClient, 'select'>
type ResearchPromotionProject = typeof projects.$inferSelect

const sameLocation = (a: LocationContext, b: LocationContext) =>
  a.label === b.label && a.city === b.city && a.region === b.region && a.country === b.country && a.timezone === b.timezone

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function assignmentPairKey(targetKey: string, queryId: string): string {
  return `${targetKey}\u0000${queryId}`
}

function frozenResearchProvenance(provenance: string | null | undefined) {
  const prefix = 'research:'
  if (!provenance?.startsWith(prefix)) return undefined
  const sourceId = provenance.slice(prefix.length)
  return sourceId ? { source: 'research' as const, sourceId } : undefined
}

function appendMissing<T>(
  active: readonly T[],
  additions: readonly T[],
  key: (value: T) => string,
): T[] {
  const known = new Set(active.map(key))
  return [...active, ...additions.filter(value => {
    const valueKey = key(value)
    if (known.has(valueKey)) return false
    known.add(valueKey)
    return true
  })]
}

/**
 * A promotion is additive. Do not reconstruct the active document through an
 * authoring shape: compiled v2 assignments may carry per-assignment contexts
 * that authoring cannot round-trip. Preserve the active rows verbatim and
 * append only compiler-produced rows for the selected question.
 */
function mergePromotionAddition(active: MeasurementPlanV2, addition: MeasurementPlanV2): MeasurementPlanV2 {
  const withPlaceholderChecksum: MeasurementPlanV2 = {
    ...active,
    querySnapshots: appendMissing(active.querySnapshots, addition.querySnapshots, snapshot => snapshot.queryId),
    assignments: appendMissing(active.assignments, addition.assignments, assignment => (
      `${assignment.targetKey}\u0000${assignment.queryId}\u0000${assignment.executionNodeKey}`
    )),
    executionNodes: appendMissing(active.executionNodes, addition.executionNodes, node => node.stableKey),
    usageEdges: appendMissing(active.usageEdges, addition.usageEdges, edge => (
      `${edge.executionNodeKey}\u0000${edge.targetKey}\u0000${edge.queryId}`
    )),
    compiledChecksum: '0'.repeat(64),
  }
  return measurementPlanV2Schema.parse({
    ...withPlaceholderChecksum,
    compiledChecksum: sha256Hex(measurementPlanV2ChecksumJson(withPlaceholderChecksum)),
  })
}

function readPromotionSetup(
  db: ResearchPromotionReadDb,
  project: ResearchPromotionProject,
) {
  const active = activePlanVersionRow(db, project.id)
  const draft = draftRow(db, project.id)
  const activeSchemaVersion: 1 | 2 | null = active ? (active.schemaVersion === 2 ? 2 : 1) : null
  const completedRun = active
    ? db.select({ id: runs.id }).from(runs).where(and(
        eq(runs.projectId, project.id),
        // Setup uses the same continuity chain as active measurement reads:
        // a label-only republish must not look unswept here while the
        // dashboard correctly serves the predecessor's completed run.
        inArray(runs.measurementPlanVersionId, comparableMeasurementVersionIds(db, project.id, active.id)),
        eq(runs.status, RunStatuses.completed),
      )).get()
    : undefined
  const state = activeSchemaVersion === 1
    ? 'republish_required' as const
    : draft
      ? 'setup_in_progress' as const
      : active
        ? (completedRun ? 'operational' as const : 'awaiting_first_run' as const)
        : 'simple' as const
  const mode = activeSchemaVersion === 1
    ? 'active-v1' as const
    : activeSchemaVersion === 2
      ? 'active-v2' as const
      : draft ? 'draft-only' as const : 'simple' as const
  return {
    active,
    draft,
    setup: {
      state,
      mode,
      activeRevision: active?.revision ?? null,
      activeCompiledChecksum: active?.compiledChecksum ?? null,
      draftEtag: draft ? measurementDraftEtag(draft.etagVersion) : null,
    },
  }
}

function researchPromotionProposedId(
  projectId: string,
  runId: string,
  queryId: string,
  normalizedQuery: string,
): string {
  return `research-promotion-${sha256Hex(canonicalJson({ projectId, runId, queryId, normalizedQuery }))}`
}

function finalizePromotionPreview(
  core: Record<string, unknown>,
  request: unknown,
  proposedId: string,
): ResearchPromotionPreviewResponse {
  const source = core.source as { runId: string; queryId: string }
  const setup = core.setup as {
    activeRevision: number | null
    activeCompiledChecksum: string | null
    draftEtag: string | null
  }
  const previewChecksum = sha256Hex(canonicalJson({
    version: 'research-promotion-preview/v1',
    sourceIds: { runId: source.runId, queryId: source.queryId },
    request,
    proposedId,
    active: {
      revision: setup.activeRevision,
      compiledChecksum: setup.activeCompiledChecksum,
    },
    draft: { etag: setup.draftEtag },
    projected: core,
  }))
  return researchPromotionPreviewResponseSchema.parse({ ...core, previewChecksum })
}

function refusedPromotionPreview(
  base: Record<string, unknown>,
  request: unknown,
  proposedId: string,
  reason: ResearchPromotionRefusalReason,
  message: string,
  checks?: unknown[],
): ResearchPromotionPreviewResponse {
  return finalizePromotionPreview({
    ...base,
    mode: 'refused',
    refusal: { reason, message, ...(checks ? { checks } : {}) },
  }, request, proposedId)
}

/**
 * Deterministically materializes a promotion from the persisted state only.
 * Both the read-semantic preview and the commit transaction use this function,
 * so a commit cannot drift from the projection the operator reviewed.
 */
export function buildResearchPromotionPreview(
  db: ResearchPromotionReadDb,
  project: ResearchPromotionProject,
  runId: string,
  queryId: string,
  input: import('@ainyc/canonry-contracts').ResearchPromotionPreviewRequest,
  opts: Pick<ResearchRoutesOptions, 'getRunnableProviderNames'>,
): ResearchPromotionPreviewResponse {
  const researchRun = db.select().from(researchRuns).where(and(
    eq(researchRuns.id, runId),
    eq(researchRuns.projectId, project.id),
  )).get()
  if (!researchRun) throw notFound('Research run', runId)
  const researchQuery = db.select().from(researchRunQueries).where(and(
    eq(researchRunQueries.id, queryId),
    eq(researchRunQueries.researchRunId, researchRun.id),
  )).get()
  if (!researchQuery) throw notFound('Research query', queryId)

  const normalizedQuery = normalizeQueryText(researchQuery.queryText)
  const proposedId = researchPromotionProposedId(project.id, researchRun.id, researchQuery.id, normalizedQuery)
  // A historic raw-text unique index permits casing/trim variants. Select the
  // oldest row, then its id, so all callers deterministically reuse one.
  const existing = db.select().from(queries).where(eq(queries.projectId, project.id)).all()
    .filter(candidate => normalizeQueryText(candidate.query) === normalizedQuery)
    .sort((left, right) => compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id))
    .at(0)
  const trackedQuery = existing
    ? {
        state: 'existing' as const,
        id: existing.id,
        proposedId,
        query: existing.query,
        normalizedQuery,
      }
    : {
        state: 'new' as const,
        id: proposedId,
        proposedId,
        query: researchQuery.queryText,
        normalizedQuery,
      }
  const source = {
    runId: researchRun.id,
    queryId: researchQuery.id,
    query: researchQuery.queryText,
    normalizedQuery,
    status: researchQuery.status,
    completedAt: researchQuery.finishedAt,
  }
  const current = readPromotionSetup(db, project)
  const base = { source, trackedQuery, setup: current.setup }

  if (researchQuery.status !== ResearchQueryStatuses.completed) {
    return refusedPromotionPreview(
      base,
      input,
      proposedId,
      'source-not-completed',
      'This saved research query has not completed and cannot be promoted.',
    )
  }
  if (current.active && current.active.schemaVersion !== 2) {
    return refusedPromotionPreview(
      base,
      input,
      proposedId,
      'active-v1',
      'Publish a v2 measurement plan before assigning this query.',
    )
  }
  if (!current.active && current.draft) {
    return refusedPromotionPreview(
      base,
      input,
      proposedId,
      'draft-only',
      'Finish or discard the current measurement draft before promoting this query.',
    )
  }
  if (current.active && current.draft) {
    return refusedPromotionPreview(
      base,
      input,
      proposedId,
      'draft-exists',
      'Finish or discard the current measurement draft before promoting this query.',
    )
  }
  if (!current.active) {
    return finalizePromotionPreview({ ...base, mode: 'simple' }, input, proposedId)
  }
  if (!current.active.compiledChecksum) {
    return refusedPromotionPreview(
      base,
      input,
      proposedId,
      'candidate-invalid',
      'The active v2 measurement plan is missing its compiled checksum.',
    )
  }
  if ((input.targetKeys?.length ?? 0) === 0 && (input.groupKeys?.length ?? 0) === 0) {
    return refusedPromotionPreview(
      base,
      input,
      proposedId,
      'audience-required',
      'Choose at least one Target or group before assigning this query to the active measurement plan.',
    )
  }

  let activePlan
  try {
    activePlan = parseStoredMeasurementPlanAnyVersion(current.active.canonicalJson)
  } catch (error) {
    return refusedPromotionPreview(base, input, proposedId, 'candidate-invalid', describeError(error))
  }
  if (activePlan.schemaVersion !== 2) {
    return refusedPromotionPreview(
      base,
      input,
      proposedId,
      'active-v1',
      'Publish a v2 measurement plan before assigning this query.',
    )
  }

  const additionalTrackedQueries = trackedQuery.state === 'new'
    ? [{ id: trackedQuery.id, query: trackedQuery.query }]
    : []
  const queryProvenance = trackedQuery.state === 'new'
    ? { source: 'research' as const, sourceId: `${researchRun.id}:${researchQuery.id}` }
    : frozenResearchProvenance(existing?.provenance)
  const queryProvenanceById = queryProvenance
    ? new Map([[trackedQuery.id, queryProvenance]])
    : undefined
  const actionContext = actionContextFor(db, project, additionalTrackedQueries)
  let authoring: MeasurementDraftAuthoring
  let applied
  try {
    authoring = authoringForCompile(
      seedAuthoring(project, activePlan, actionContext, { getRunnableProviderNames: opts.getRunnableProviderNames }),
      project,
      { getRunnableProviderNames: opts.getRunnableProviderNames },
    )
    applied = applyAssignmentsToAuthoring(authoring, {
      queryIds: [trackedQuery.id],
      ...(input.targetKeys ? { targetKeys: input.targetKeys } : {}),
      ...(input.groupKeys ? { groupKeys: input.groupKeys } : {}),
    }, actionContext)
    authoring = applied.authoring
    if (input.queryClass) {
      authoring = applyDraftAction('classify-assignments', authoring, {
        queryClass: input.queryClass,
        assignments: applied.audience.targetKeys.map(targetKey => ({ targetKey, queryId: trackedQuery.id })),
      }, actionContext).authoring
    }
  } catch (error) {
    return refusedPromotionPreview(base, input, proposedId, 'audience-invalid', describeError(error))
  }

  const activeAssignmentsByPair = new Map(activePlan.assignments.map(assignment => [
    assignmentPairKey(assignment.targetKey, assignment.queryId),
    assignment,
  ]))
  const selectedAssignmentsByPair = new Map(authoring.assignments
    .filter(assignment => assignment.queryId === trackedQuery.id && applied.audience.targetKeys.includes(assignment.targetKey))
    .map(assignment => [assignmentPairKey(assignment.targetKey, assignment.queryId), assignment]))
  const additions: MeasurementDraftAssignment[] = []
  for (const targetKey of applied.audience.targetKeys) {
    const key = assignmentPairKey(targetKey, trackedQuery.id)
    if (activeAssignmentsByPair.has(key)) continue
    const selected = selectedAssignmentsByPair.get(key)
    if (!selected) {
      return refusedPromotionPreview(
        base,
        input,
        proposedId,
        'candidate-invalid',
        'The projected advanced measurement plan is missing a selected assignment.',
      )
    }
    additions.push(selected)
  }

  let candidatePlan = activePlan
  let checks: MeasurementDraftCompileCheck[] = []
  if (additions.length > 0) {
    const selectedTargetKeys = new Set(applied.audience.targetKeys)
    const compiled = compileMeasurementDraft({
      defaultContext: authoring.defaultContext,
      targets: authoring.targets.filter(target => selectedTargetKeys.has(target.stableKey)),
      assignments: additions,
      groups: [],
    }, compileContextFor(db, project, additionalTrackedQueries, queryProvenanceById))
    if (!compiled.ok) {
      return refusedPromotionPreview(
        base,
        input,
        proposedId,
        'candidate-invalid',
        'The projected advanced measurement plan does not compile.',
        compiled.checks,
      )
    }
    // The review must expose the exact immutable document the commit stores.
    // Canonical storage orders nodes and edges deterministically, so normalize
    // the additive merge before its checksum, diff, or receipt can be used.
    candidatePlan = measurementPlanV2Schema.parse(JSON.parse(
      canonicalMeasurementPlanV2Json(mergePromotionAddition(activePlan, compiled.plan)),
    ))
    checks = compiled.checks
  }

  const classifications: Array<{ targetKey: string; queryId: string; queryClass: 'branded' | 'non-brand' }> = []
  for (const targetKey of applied.audience.targetKeys) {
    const key = assignmentPairKey(targetKey, trackedQuery.id)
    const assignment = activeAssignmentsByPair.get(key) ?? selectedAssignmentsByPair.get(key)
    if (!assignment) {
      return refusedPromotionPreview(
        base,
        input,
        proposedId,
        'candidate-invalid',
        'The projected advanced measurement plan is missing a selected classification.',
      )
    }
    if (assignment.queryClass === 'unclassified') {
      return refusedPromotionPreview(
        base,
        input,
        proposedId,
        'candidate-invalid',
        'The projected advanced measurement plan has an unclassified selected assignment.',
      )
    }
    classifications.push({
      targetKey,
      queryId: trackedQuery.id,
      queryClass: assignment.queryClass,
    })
  }
  classifications.sort((left, right) => compareText(left.targetKey, right.targetKey))
  return finalizePromotionPreview({
    ...base,
    mode: 'advanced',
    selection: input,
    audience: {
      targetKeys: applied.audience.targetKeys,
      groups: applied.audience.groups,
      overlapCount: applied.audience.overlapCount,
    },
    assignments: { ...applied.assignments, classifications },
    execution: assignmentExecutionImpact(activePlan, candidatePlan),
    candidate: {
      compiledChecksum: candidatePlan.compiledChecksum,
      checks,
      plan: candidatePlan,
      diff: diffCompiledPlans(activePlan, candidatePlan, current.active.revision),
    },
  }, input, proposedId)
}

export async function researchRoutes(app: FastifyInstance, opts: ResearchRoutesOptions) {
  app.post<{ Params: { name: string }; Body: unknown }>('/projects/:name/research/runs', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    if (!opts.onResearchRunRequested) throw missingDependency('Research execution is not available on this deployment.', { reason: 'no-research-handler' })
    const parsed = researchRunCreateSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw validationError('Invalid research run request', { issues: parsed.error.issues })
    const input = parsed.data
    const adapters = opts.providerAdapters ?? []
    const configured = new Set(opts.configuredProviderNames ?? [])
    const providerName = input.provider ?? project.providers.find(name => configured.has(name) && adapters.some(adapter => adapter.name === name && adapter.mode === 'api')) ?? adapters.find(adapter => adapter.mode === 'api' && configured.has(adapter.name))?.name
    const adapter = adapters.find(candidate => candidate.name === providerName)
    if (!providerName || !adapter || adapter.mode !== 'api' || isBrowserProvider(providerName) || !configured.has(providerName)) throw validationError('Research requires a configured API provider.', { provider: input.provider, validProviders: adapters.filter(a => a.mode === 'api' && configured.has(a.name)).map(a => a.name) })
    if (input.model) { adapter.modelValidationPattern.lastIndex = 0; if (!adapter.modelConfigurable || !adapter.modelValidationPattern.test(input.model)) throw validationError(`Invalid model "${input.model}" for provider "${providerName}".`, { provider: providerName, model: input.model, hint: adapter.modelValidationHint }) }
    const location = input.location === undefined ? (project.defaultLocation ? project.locations.find(item => item.label === project.defaultLocation) ?? null : null) : input.location
    if (location && !project.locations.some(item => sameLocation(item, location))) throw validationError('Research location must exactly match a configured project location.', { location })
    const requestedModel = input.model ?? null
    const resolvedModel = requestedModel ?? (project.providerModels[providerName] || adapter.defaultModel)
    adapter.modelValidationPattern.lastIndex = 0
    if (!adapter.modelValidationPattern.test(resolvedModel)) throw validationError(`Invalid resolved model "${resolvedModel}" for provider "${providerName}".`, { provider: providerName, model: resolvedModel, hint: adapter.modelValidationHint })
    if (new Set(input.queries.map(query => query.toLocaleLowerCase())).size !== input.queries.length) throw validationError('Research queries must be unique within a batch.')
    const normalized = { queries: input.queries, provider: providerName, model: requestedModel, location: location ?? null }
    const requestHash = crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
    const now = new Date().toISOString()
    const decision = app.db.transaction((tx) => {
      if (input.idempotencyKey) {
        const existing = tx.select().from(researchRuns).where(and(eq(researchRuns.projectId, project.id), eq(researchRuns.idempotencyKey, input.idempotencyKey))).get()
        if (existing) {
          if (existing.requestHash !== requestHash) throw alreadyExists('Research idempotency key', input.idempotencyKey)
          return { reused: true as const, id: existing.id, shouldDispatch: existing.status === ResearchRunStatuses.queued }
        }
      }
      const id = crypto.randomUUID()
      tx.insert(researchRuns).values({ id, projectId: project.id, status: ResearchRunStatuses.queued, provider: providerName, requestedModel, resolvedModel, location: location ?? null, totalQueries: input.queries.length, idempotencyKey: input.idempotencyKey ?? null, requestHash: input.idempotencyKey ? requestHash : null, createdAt: now }).run()
      for (const [position, query] of input.queries.entries()) tx.insert(researchRunQueries).values({ id: crypto.randomUUID(), researchRunId: id, position, queryText: query, status: ResearchQueryStatuses.queued, requestedModel, resolvedModel, groundingSources: [], citedDomains: [], searchQueries: [], createdAt: now }).run()
      writeAuditLog(tx, { projectId: project.id, actor: 'api', action: 'research.created', entityType: 'research_run', entityId: id })
      return { reused: false as const, id, shouldDispatch: true }
    })
    const result = getDetail(app, project.id, decision.id)
    if (decision.shouldDispatch) opts.onResearchRunRequested(decision.id, project.id)
    if (decision.reused) return reply.status(200).send(result)
    return reply.status(202).send(result)
  })

  // This stays a POST because advanced selections can be sizeable, but it is
  // deliberately read-semantic: no tracked query, draft, audit, receipt, or
  // provider call is made here. The PR2 commit route owns every durable write.
  app.post<{ Params: { name: string; runId: string; queryId: string }; Body: unknown }>('/projects/:name/research/runs/:runId/queries/:queryId/promotion-preview', {
    config: { readSemantic: true },
  }, async request => {
    const parsed = researchPromotionPreviewRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw validationError('Invalid research promotion preview request', { issues: parsed.error.issues })
    const project = resolveProject(app.db, request.params.name)
    return buildResearchPromotionPreview(
      app.db,
      project,
      request.params.runId,
      request.params.queryId,
      parsed.data,
      opts,
    )
  })

  app.post<{ Params: { name: string; runId: string; queryId: string }; Body: unknown }>('/projects/:name/research/runs/:runId/queries/:queryId/promotion', async (request, reply) => {
    requireScope(request, MEASUREMENT_PLAN_WRITE_SCOPE)
    const parsed = researchPromotionCommitRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw validationError('Invalid research promotion commit request', { issues: parsed.error.issues })
    const body = parsed.data
    const project = resolveProject(app.db, request.params.name)
    const lookup: ReceiptLookup = {
      operation: 'research-promotion.commit',
      key: requireIdempotencyKey(request, 'research-promotion.commit'),
      // A receipt binds the exact saved source as well as the selection. The
      // same key must never replay a promotion for a different research row.
      checksum: requestChecksum({
        runId: request.params.runId,
        queryId: request.params.queryId,
        commit: body,
      }),
    }
    const replay = replayReceipt(app.db, project.id, lookup, reply)
    if (replay !== null) return replay

    // Claim the SQLite write reservation before projecting state. A concurrent
    // promotion therefore observes the committed receipt/pointer after this
    // transaction, rather than both readers allocating the same revision from
    // an old snapshot.
    return app.db.transaction(tx => {
      // A second receipt check closes the window between the first read and a
      // concurrent transaction claiming this idempotency key.
      const transactionReplay = replayReceipt(tx, project.id, lookup, reply)
      if (transactionReplay !== null) return transactionReplay

      const currentProject = tx.select().from(projects).where(eq(projects.id, project.id)).get()
      if (!currentProject) throw notFound('Project', request.params.name)
      const preview = buildResearchPromotionPreview(
        tx,
        currentProject,
        request.params.runId,
        request.params.queryId,
        body.request,
        opts,
      )
      if (preview.mode === 'refused') {
        if (preview.refusal.reason === 'draft-only' || preview.refusal.reason === 'draft-exists') {
          throw alreadyExists('Measurement plan draft', currentProject.name)
        }
        throw validationError('Research promotion cannot be committed.', {
          refusal: preview.refusal,
        })
      }
      if (preview.previewChecksum !== body.previewChecksum) {
        throw researchPromotionPreviewConflict(body.previewChecksum, preview.previewChecksum)
      }

      const now = new Date()
      let result: ResearchPromotionCommitResult
      if (preview.mode === 'simple') {
        if (preview.trackedQuery.state === 'existing') {
          result = researchPromotionCommitResultSchema.parse({
            status: 'already-tracked',
            mode: 'simple',
            source: preview.source,
            trackedQuery: preview.trackedQuery,
            publishedRevision: null,
            compiledChecksum: null,
          })
        } else {
          tx.insert(queries).values({
            id: preview.trackedQuery.id,
            projectId: currentProject.id,
            query: preview.trackedQuery.query,
            provenance: `research:${preview.source.runId}:${preview.source.queryId}`,
            createdAt: now.toISOString(),
          }).run()
          result = researchPromotionCommitResultSchema.parse({
            status: 'tracked-awaiting-first-sweep',
            mode: 'simple',
            source: preview.source,
            trackedQuery: preview.trackedQuery,
            publishedRevision: null,
            compiledChecksum: null,
          })
        }
      } else {
        const active = activePlanVersionRow(tx, currentProject.id)
        // The planner's active-v2 branch guarantees this; retaining the guard
        // makes a malformed pointer fail closed before any version is written.
        if (!active || active.schemaVersion !== 2) {
          throw validationError('The active measurement plan changed before this promotion could be committed.')
        }
        // The promotion does not carry cosmetic plan edits. If it would leave
        // the frozen execution graph unchanged, preserve the active version
        // and return an explicit idempotent no-op instead of making reads lose
        // their existing version pin.
        if (active.compiledChecksum === preview.candidate.plan.compiledChecksum) {
          result = researchPromotionCommitResultSchema.parse({
            status: 'already-tracked',
            mode: 'advanced',
            source: preview.source,
            trackedQuery: preview.trackedQuery,
            publishedRevision: null,
            compiledChecksum: null,
          })
        } else {
          if (preview.trackedQuery.state === 'new') {
            tx.insert(queries).values({
              id: preview.trackedQuery.id,
              projectId: currentProject.id,
              query: preview.trackedQuery.query,
              provenance: `research:${preview.source.runId}:${preview.source.queryId}`,
              createdAt: now.toISOString(),
            }).run()
          }
          const latest = tx.select({ revision: measurementPlanVersions.revision })
            .from(measurementPlanVersions)
            .where(eq(measurementPlanVersions.projectId, currentProject.id))
            .orderBy(desc(measurementPlanVersions.revision)).get()
          const revision = (latest?.revision ?? 0) + 1
          const canonicalJson = canonicalMeasurementPlanV2Json(preview.candidate.plan)
          const versionId = crypto.randomUUID()
          tx.insert(measurementPlanVersions).values({
            id: versionId,
            projectId: currentProject.id,
            revision,
            canonicalJson,
            checksum: sha256Hex(canonicalJson),
            schemaVersion: 2,
            compiledChecksum: preview.candidate.plan.compiledChecksum,
            // This promotion changes execution. Only a label-only publish may
            // link continuity to a predecessor.
            comparableToVersionId: null,
            publishedBy: serializeActor(actorFromRequest(request)),
            sourceDraftId: null,
            createdAt: now.toISOString(),
          }).run()
          const pointer = tx.update(measurementPlans)
            .set({ activeVersionId: versionId, updatedAt: now.toISOString() })
            .where(and(
              eq(measurementPlans.projectId, currentProject.id),
              eq(measurementPlans.activeVersionId, active.id),
            )).run()
          if (Number(pointer.changes) !== 1) {
            // The transaction rolls the inserted query/version back. The next
            // preview is authoritative for the competing active pointer.
            throw researchPromotionPreviewConflict(body.previewChecksum, preview.previewChecksum)
          }
          result = researchPromotionCommitResultSchema.parse({
            status: 'tracked-awaiting-first-sweep',
            mode: 'advanced',
            source: preview.source,
            trackedQuery: preview.trackedQuery,
            publishedRevision: revision,
            compiledChecksum: preview.candidate.plan.compiledChecksum,
          })
        }
      }

      writeAuditLog(tx, auditFromRequest(request, {
        projectId: currentProject.id,
        actor: 'api',
        action: result.status === 'already-tracked' ? 'research.promotion-noop' : 'research.promotion-committed',
        entityType: 'research-query-promotion',
        entityId: `${preview.source.runId}:${preview.source.queryId}`,
        diff: {
          status: result.status,
          mode: result.mode,
          queryId: result.trackedQuery.id,
          publishedRevision: result.publishedRevision,
          compiledChecksum: result.compiledChecksum,
        },
      }))
      sweepExpiredMeasurementReceipts(tx, now)
      writeReceipt(tx, currentProject.id, lookup, result, 200, now)
      return result
    }, { behavior: 'immediate' })
  })

  app.get<{ Params: { name: string }; Querystring: { limit?: string } }>('/projects/:name/research/runs', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const requested = Number.parseInt(request.query.limit ?? '', 10)
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 100) : 20
    const runs = app.db.select().from(researchRuns).where(eq(researchRuns.projectId, project.id)).orderBy(desc(researchRuns.createdAt)).limit(limit).all().map(serializeRun)
    return { runs } satisfies ResearchRunListDto
  })

  app.get<{ Params: { name: string; runId: string } }>('/projects/:name/research/runs/:runId', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    return getDetail(app, project.id, request.params.runId)
  })
}

function getDetail(app: FastifyInstance, projectId: string, id: string): ResearchRunDetailDto {
  const row = app.db.select().from(researchRuns).where(and(eq(researchRuns.id, id), eq(researchRuns.projectId, projectId))).get()
  if (!row) throw notFound('Research run', id)
  const queries = app.db.select().from(researchRunQueries).where(eq(researchRunQueries.researchRunId, id)).orderBy(researchRunQueries.position).all().map(serializeQuery)
  return { ...serializeRun(row), queries }
}
function serializeRun(row: typeof researchRuns.$inferSelect): ResearchRunSummaryDto {
  return { id: row.id, projectId: row.projectId, status: row.status as ResearchRunSummaryDto['status'], provider: row.provider, requestedModel: row.requestedModel, resolvedModel: row.resolvedModel, location: row.location ?? null, totalQueries: row.totalQueries, completedQueries: row.completedQueries, failedQueries: row.failedQueries, error: row.error, startedAt: row.startedAt, finishedAt: row.finishedAt, createdAt: row.createdAt }
}
function serializeQuery(row: typeof researchRunQueries.$inferSelect): ResearchRunQueryDto {
  return { id: row.id, position: row.position, query: row.queryText, status: row.status as ResearchRunQueryDto['status'], requestedModel: row.requestedModel, resolvedModel: row.resolvedModel, servedModel: row.servedModel, answerText: row.answerText, groundingSources: row.groundingSources, citedDomains: row.citedDomains, searchQueries: row.searchQueries, namedCompetitors: row.namedCompetitors, citedCompetitorDomains: row.citedCompetitorDomains, answerMentioned: row.answerMentioned, citationState: row.citationState as ResearchRunQueryDto['citationState'], error: row.error, startedAt: row.startedAt, finishedAt: row.finishedAt, createdAt: row.createdAt }
}
