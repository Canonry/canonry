import crypto from 'node:crypto'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { comparableMeasurementVersionIds } from './measurement-report-adapter.js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  AppError,
  MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_BYTES,
  alreadyExists,
  canonicalMeasurementPlanV2Json,
  effectiveBrandNames,
  MEASUREMENT_PAGE_DEFAULT_LIMIT,
  MEASUREMENT_PAGE_MAX_LIMIT,
  measurementCompiledChecksumConflict,
  measurementDraftCreateRequestSchema,
  measurementDraftApplyGroupMembershipRequestSchema,
  measurementDraftEtag,
  measurementDraftEtagStale,
  measurementDraftPublishRequestSchema,
  measurementDraftPreviewAssignmentsRequestSchema,
  measurementDraftPreviewGroupMembershipRequestSchema,
  measurementPlanDeactivateRequestSchema,
  measurementPlanRevisionConflict,
  measurementQuerySetUpsertRequestSchema,
  measurementQueryTemplateApplyRequestSchema,
  measurementQueryTemplateUpsertRequestSchema,
  notFound,
  parseStoredMeasurementPlanAnyVersion,
  RunStatuses,
  validationError,
  type ActorReference,
  type MeasurementDraftAssignment,
  type MeasurementDraftAuthoring,
  type MeasurementDraftGroup,
  type MeasurementDraftTarget,
  type MeasurementDraftWarning,
  type MeasurementPlanV2,
  type MeasurementV2UrlMatcher,
  type StoredMeasurementPlan,
} from '@ainyc/canonry-contracts'
import {
  measurementPlanDrafts,
  measurementPlans,
  measurementPlanVersions,
  measurementQuerySetItems,
  measurementQuerySets,
  measurementQueryTemplates,
  measurementSegments,
  projects,
  queries,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { requireScope } from './auth.js'
import { auditFromRequest, resolveProject, writeAuditLog } from './helpers.js'
import { MEASUREMENT_PLAN_WRITE_SCOPE } from './measurement-plan.js'
import {
  applyDraftAction,
  applyAssignmentsToAuthoring,
  assertMeasurementDraftAuthoringLimits,
  MEASUREMENT_DRAFT_ACTIONS,
  type DraftActionContext,
} from './measurement-draft-actions.js'
import {
  compileMeasurementDraft,
  compileMeasurementDraftAssignmentExecution,
  diffCompiledPlans,
  plansAreLabelOnlyVariants,
  proposeQueryClassForTarget,
  type MeasurementDraftCompileContext,
} from './measurement-draft-compile.js'
import {
  MeasurementGroupMembershipImportError,
  applyReviewedGroupMembership,
  previewGroupMembershipCsv,
} from './measurement-group-import.js'
import { resolveRunnableProviderSelection, resolveRunProviderSelection } from './run-queue.js'
import {
  actorFromRequest,
  activePlanVersionRow,
  assertDraftEtag,
  canonicalJson,
  draftCounts,
  draftDto,
  draftRow,
  parseStoredAuthoring,
  replayReceipt,
  requestChecksum,
  requireIdempotencyKey,
  requireIfMatch,
  serializeActor,
  sha256Hex,
  sweepExpiredMeasurementReceipts,
  writeReceipt,
  type PlanVersionRow,
  type ReceiptLookup,
} from './measurement-draft-repo.js'

type ProjectRow = typeof projects.$inferSelect
type TransactionClient = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0]

// JSON escaping can expand one source character to six bytes. The embedded
// CSV keeps its own strict 1 MiB UTF-8 ceiling after transport parsing.
const MEASUREMENT_GROUP_MEMBERSHIP_BODY_LIMIT = MEASUREMENT_GROUP_MEMBERSHIP_CSV_MAX_BYTES * 7 + 4_096

export interface MeasurementDraftRoutesOptions {
  /** Current provider registry membership, used when a project means "all configured". */
  getRunnableProviderNames?: () => readonly string[]
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Key-order-independent identity, so "did this action change anything" never turns on serialization order. */
function authoringIdentity(authoring: MeasurementDraftAuthoring): string {
  return canonicalJson(authoring)
}

function trackedQueriesFor(db: DatabaseClient, projectId: string): Array<{ id: string; query: string }> {
  return db.select({ id: queries.id, query: queries.query })
    .from(queries).where(eq(queries.projectId, projectId)).all()
}

function compileContextFor(db: DatabaseClient, project: ProjectRow): MeasurementDraftCompileContext {
  return {
    canonicalDomain: project.canonicalDomain,
    ownedDomains: project.ownedDomains,
    brandNames: effectiveBrandNames(project),
    locations: project.locations,
    trackedQueries: trackedQueriesFor(db, project.id),
  }
}

function actionContextFor(db: DatabaseClient, project: ProjectRow): DraftActionContext {
  return {
    brandNames: effectiveBrandNames(project),
    queriesById: new Map(trackedQueriesFor(db, project.id).map(query => [query.id, query.query])),
  }
}

function segmentDescriptorsFor(
  db: DatabaseClient | TransactionClient,
  projectId: string,
) {
  return db.select({
    stableKey: measurementSegments.stableKey,
    kind: measurementSegments.kind,
    retiredAt: measurementSegments.retiredAt,
  }).from(measurementSegments).where(eq(measurementSegments.projectId, projectId)).all()
}

function rethrowGroupMembershipError(error: unknown): never {
  if (error instanceof MeasurementGroupMembershipImportError) {
    throw new AppError('VALIDATION_ERROR', error.message, error.statusCode, {
      importCode: error.code,
      ...(error.details ?? {}),
    })
  }
  throw error
}

/**
 * Round-trips a compiled matcher back to the string an operator authored. The
 * grammar is the one `measurement-draft-compile.ts` parses, so seeding a draft
 * from a published revision and recompiling it reproduces the same matchers.
 */
function formatDraftMatcher(matcher: MeasurementV2UrlMatcher): string {
  switch (matcher.kind) {
    case 'exact': return matcher.url
    case 'prefix': return `https://${matcher.host}${matcher.pathPrefix === '/' ? '' : matcher.pathPrefix}/*`
    case 'host': return matcher.host
  }
}

function draftProviderNames(project: ProjectRow, opts: MeasurementDraftRoutesOptions): string[] {
  return resolveRunProviderSelection({
    projectProviders: project.providers,
    runnableProviders: opts.getRunnableProviderNames?.(),
  })
}

function draftModels(project: ProjectRow, providers: readonly string[]): Record<string, string> {
  const models: Record<string, string> = {}
  for (const [provider, model] of Object.entries(project.providerModels)) {
    const normalized = provider.trim().toLowerCase()
    if (providers.includes(normalized) && model) models[normalized] = model
  }
  return models
}

function emptyAuthoring(project: ProjectRow, opts: MeasurementDraftRoutesOptions): MeasurementDraftAuthoring {
  const providers = draftProviderNames(project, opts)
  const models = draftModels(project, providers)
  return {
    defaultContext: {
      providers,
      ...(Object.keys(models).length ? { models } : {}),
      locations: project.locations.map(location => location.label).sort(compareText),
    },
    targets: [],
    assignments: [],
    groups: [],
  }
}

/**
 * Seeds the draft from whatever is already active.
 *
 * A v2 revision was published with every class decided, so those classes come
 * across as operator decisions and no later rule proposal may overwrite them. A
 * v1 revision has no classes at all, so each seeded assignment gets the
 * deterministic proposal of §7.3 for the operator to review — which is what
 * makes republishing an active v1 a review step rather than a silent upgrade.
 */
function seedAuthoring(
  project: ProjectRow,
  active: StoredMeasurementPlan | null,
  context: DraftActionContext,
  opts: MeasurementDraftRoutesOptions,
): MeasurementDraftAuthoring {
  const base = emptyAuthoring(project, opts)
  if (!active) return base

  if (active.schemaVersion === 2) {
    const assignments = new Map<string, MeasurementDraftAssignment>()
    for (const assignment of active.assignments) {
      assignments.set(`${assignment.targetKey} ${assignment.queryId}`, {
        targetKey: assignment.targetKey,
        queryId: assignment.queryId,
        queryClass: assignment.queryClass,
        classificationSource: 'operator',
      })
    }
    return {
      ...base,
      targets: active.targets.map((target): MeasurementDraftTarget => ({
        stableKey: target.stableKey,
        label: target.label,
        status: 'included',
        aliases: [...target.aliases],
        urlMatchers: target.urlMatchers.map(formatDraftMatcher),
        source: target.discoveryIdentity ? 'sitemap' : 'manual',
        ...(target.discoveryIdentity ? { discoveryIdentity: target.discoveryIdentity } : {}),
      })),
      assignments: [...assignments.values()],
      groups: active.groups.map((group): MeasurementDraftGroup => ({
        stableKey: group.stableKey,
        label: group.label,
        targetKeys: [...group.targetKeys],
        competitors: group.competitors.map(competitor => ({ ...competitor })),
      })),
    }
  }

  const assignments: MeasurementDraftAssignment[] = []
  const targetsByKey = new Map(active.targets.map(target => [target.stableKey, { label: target.label, aliases: target.aliases }]))
  const seen = new Set<string>()
  for (const selection of active.targetQuerySelections) {
    for (const queryId of selection.queryIds) {
      const key = `${selection.targetKey} ${queryId}`
      if (seen.has(key)) continue
      seen.add(key)
      const queryText = context.queriesById.get(queryId)
      assignments.push({
        targetKey: selection.targetKey,
        queryId,
        // Same classifier as the assignment actions. Using the project brand alone
        // here made a question naming its own Property non-brand when the draft
        // was seeded from a v1 plan and branded when it was assigned directly.
        queryClass: queryText === undefined
          ? 'unclassified'
          : proposeQueryClassForTarget(queryText, context.brandNames, targetsByKey.get(selection.targetKey)),
        classificationSource: 'rule',
      })
    }
  }
  return {
    ...base,
    targets: active.targets.map((target): MeasurementDraftTarget => ({
      stableKey: target.stableKey,
      label: target.label,
      status: 'included',
      aliases: [...target.aliases],
      urlMatchers: target.urls.map(formatDraftMatcher),
      source: 'manual',
    })),
    assignments,
    // A v1 group carries competitor domains and no identities, so each one is
    // seeded with a key derived from its host for the operator to confirm.
    groups: active.groups.map((group): MeasurementDraftGroup => ({
      stableKey: group.stableKey,
      label: group.label,
      targetKeys: [...group.targetKeys],
      competitors: (group.competitors ?? []).map(domain => ({
        stableKey: domain.replace(/[^\w.~-]+/g, '-'),
        label: domain,
        domain,
        aliases: [],
      })),
    })),
  }
}

/**
 * Drafts created before runnable-provider defaults were frozen can carry an
 * empty default provider list. Resolve only that inherited default at compile
 * time: an assignment that explicitly overrides providers with `[]` must keep
 * failing, and the immutable plan still receives concrete provider arrays.
 */
function authoringForCompile(
  authoring: MeasurementDraftAuthoring,
  project: ProjectRow,
  opts: MeasurementDraftRoutesOptions,
): MeasurementDraftAuthoring {
  if (authoring.defaultContext.providers.length > 0) return authoring
  const providers = draftProviderNames(project, opts)
  if (providers.length === 0) return authoring
  const models = {
    ...draftModels(project, providers),
    ...authoring.defaultContext.models,
  }
  return {
    ...authoring,
    defaultContext: {
      ...authoring.defaultContext,
      providers,
      ...(Object.keys(models).length > 0 ? { models } : {}),
    },
  }
}

/** Provider work is the compiled execution graph, never the assignment row count. */
function assignmentExecutionImpact(before: MeasurementPlanV2, candidate: MeasurementPlanV2) {
  const beforeKeys = new Set(before.executionNodes.map(node => node.stableKey))
  const added = candidate.executionNodes.filter(node => !beforeKeys.has(node.stableKey))
  return {
    addedNodes: added.length,
    addedProviderCalls: added.reduce((total, node) => total + node.expectedSnapshots, 0),
    fullRunNodes: candidate.executionNodes.length,
    fullRunProviderCalls: candidate.executionNodes.reduce((total, node) => total + node.expectedSnapshots, 0),
  }
}

function parseV2Plan(row: PlanVersionRow): MeasurementPlanV2 {
  const plan = parseStoredMeasurementPlanAnyVersion(row.canonicalJson)
  if (plan.schemaVersion !== 2) {
    throw new Error(`Measurement plan revision ${row.revision} is schema v${plan.schemaVersion}, not v2`)
  }
  return plan
}

interface PageQuery {
  search?: string
  cursor?: string
  limit?: string | number
}

function pageLimit(value: string | number | undefined): number {
  if (value === undefined) return MEASUREMENT_PAGE_DEFAULT_LIMIT
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MEASUREMENT_PAGE_MAX_LIMIT) {
    throw validationError(`"limit" must be an integer between 1 and ${MEASUREMENT_PAGE_MAX_LIMIT}`)
  }
  return parsed
}

/**
 * One cursor rule for every draft collection: order by an opaque sort key and
 * page strictly past the last one returned. The cursor IS the ordering, so a
 * row inserted before it can never reappear on a later page.
 */
function paginate<T>(
  rows: readonly T[],
  query: PageQuery,
  sortKey: (row: T) => string,
  searchable: (row: T) => string,
) {
  const needle = query.search?.trim().toLowerCase()
  const filtered = (needle ? rows.filter(row => searchable(row).toLowerCase().includes(needle)) : [...rows])
    .sort((left, right) => compareText(sortKey(left), sortKey(right)))
  const after = query.cursor ? Buffer.from(query.cursor, 'base64url').toString('utf8') : null
  const remaining = after === null ? filtered : filtered.filter(row => sortKey(row) > after)
  const limit = pageLimit(query.limit)
  const items = remaining.slice(0, limit)
  const last = items.at(-1)
  return {
    items,
    nextCursor: remaining.length > items.length && last !== undefined
      ? Buffer.from(sortKey(last), 'utf8').toString('base64url')
      : null,
    totalEstimate: filtered.length,
  }
}

/** Normalized label then stable key, per §6, so two callers paging the same draft see the same order. */
function labelSortKey(label: string, stableKey: string): string {
  return `${label.trim().toLowerCase()} ${stableKey}`
}

interface MutationGate {
  project: ProjectRow
  lookup: ReceiptLookup
  actor: ActorReference
  replay: unknown | null
}

export async function measurementDraftRoutes(app: FastifyInstance, opts: MeasurementDraftRoutesOptions = {}) {
  // Nothing on the write path deletes a receipt, so the table is swept once at
  // boot and again before every receipt is written (see `finishMutation`).
  // Registration must not fail over a cleanup: an install whose schema is not
  // ready yet still has to be able to serve.
  try {
    sweepExpiredMeasurementReceipts(app.db, new Date())
  } catch (error) {
    app.log.warn({ err: error }, 'measurement receipt sweep skipped at boot')
  }

  function requireDraft(project: ProjectRow) {
    const row = draftRow(app.db, project.id)
    if (!row) throw notFound('Measurement plan draft', project.name)
    return row
  }

  /**
   * The shared front half of every mutating action: scope, project, the
   * idempotency key and the replay it may resolve to. `If-Match` is checked
   * afterwards on purpose — the retry of a request whose response was lost
   * carries the ETag the caller held when it first sent, and refusing that as
   * stale would make a dropped response unrecoverable.
   */
  function beginMutation(request: FastifyRequest, reply: FastifyReply, operation: string): MutationGate {
    requireScope(request, MEASUREMENT_PLAN_WRITE_SCOPE)
    const project = resolveProject(app.db, (request.params as { name: string }).name)
    const lookup: ReceiptLookup = {
      operation,
      key: requireIdempotencyKey(request, operation),
      checksum: requestChecksum(request.body),
    }
    return {
      project,
      lookup,
      actor: actorFromRequest(request),
      replay: replayReceipt(app.db, project.id, lookup, reply),
    }
  }

  function finishMutation(
    gate: MutationGate,
    response: unknown,
    write: (tx: TransactionClient, now: Date) => void,
  ): unknown {
    const now = new Date()
    app.db.transaction(tx => {
      write(tx, now)
      sweepExpiredMeasurementReceipts(tx, now)
      writeReceipt(tx, gate.project.id, gate.lookup, response, 200, now)
    })
    return response
  }

  function mutationResponse(
    etagVersion: number,
    changed: boolean,
    warnings: MeasurementDraftWarning[],
    authoring: MeasurementDraftAuthoring,
  ) {
    return { etag: measurementDraftEtag(etagVersion), changed, warnings, counts: draftCounts(authoring) }
  }

  app.get<{ Params: { name: string } }>('/projects/:name/measurement-setup', async request => {
    const project = resolveProject(app.db, request.params.name)
    const active = activePlanVersionRow(app.db, project.id)
    const draft = draftRow(app.db, project.id)
    const activeSchemaVersion: 1 | 2 | null = active ? (active.schemaVersion === 2 ? 2 : 1) : null
    const completedRun = active
      ? app.db.select({ id: runs.id }).from(runs).where(and(
          eq(runs.projectId, project.id),
          // The comparable chain, not the bare active id: a label-only
          // republish must not flip setup back to awaiting_first_run while
          // the overview keeps serving the prior run.
          inArray(runs.measurementPlanVersionId, comparableMeasurementVersionIds(app.db, project.id, active.id)),
          eq(runs.status, RunStatuses.completed),
        )).get()
      : undefined

    // Exactly one state, in the precedence of §0.5: a draft over an active v1
    // is `republish_required`, because republishing is the blocking action.
    const state = activeSchemaVersion === 1
      ? 'republish_required' as const
      : draft
        ? 'setup_in_progress' as const
        : active
          ? (completedRun ? 'operational' as const : 'awaiting_first_run' as const)
          : 'simple' as const
    const nextAction = ({
      republish_required: 'republish_setup',
      setup_in_progress: 'continue_setup',
      awaiting_first_run: 'run_measurement',
      operational: 'view_measurement',
      simple: 'start_setup',
    } as const)[state]

    return {
      state,
      nextAction,
      mode: activeSchemaVersion === 1
        ? 'active-v1' as const
        : activeSchemaVersion === 2
          ? 'active-v2' as const
          : draft ? 'draft-only' as const : 'simple' as const,
      // This project-readable response is also the dashboard's readiness
      // source. The boolean exposes no instance capability inventory and uses
      // the exact provider-selection decision enforced by run preflight.
      answerVisibilityProviderReady: resolveRunnableProviderSelection({
        projectProviders: project.providers,
        runnableProviders: opts.getRunnableProviderNames?.(),
      }).runnableProviders.length > 0,
      activeRevision: active?.revision ?? null,
      activeSchemaVersion,
      draft: draft ? { etag: measurementDraftEtag(draft.etagVersion), updatedAt: draft.updatedAt } : null,
    }
  })

  app.get<{ Params: { name: string } }>('/projects/:name/measurement-plan/draft', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const row = draftRow(app.db, project.id)
    if (!row) return { draft: null, etag: null }
    const etag = measurementDraftEtag(row.etagVersion)
    reply.header('etag', etag)
    return { draft: draftDto(row), etag }
  })

  app.get<{ Params: { name: string }; Querystring: PageQuery }>('/projects/:name/measurement-plan/draft/targets', async request => {
    const project = resolveProject(app.db, request.params.name)
    const authoring = parseStoredAuthoring(requireDraft(project).authoringJson)
    return paginate<MeasurementDraftTarget>(
      authoring.targets,
      request.query,
      target => labelSortKey(target.label, target.stableKey),
      target => `${target.label} ${target.stableKey}`,
    )
  })

  app.get<{ Params: { name: string }; Querystring: PageQuery }>('/projects/:name/measurement-plan/draft/assignments', async request => {
    const project = resolveProject(app.db, request.params.name)
    const authoring = parseStoredAuthoring(requireDraft(project).authoringJson)
    return paginate<MeasurementDraftAssignment>(
      authoring.assignments,
      request.query,
      assignment => `${assignment.targetKey} ${assignment.queryId}`,
      assignment => `${assignment.targetKey} ${assignment.queryId}`,
    )
  })

  app.get<{ Params: { name: string }; Querystring: PageQuery }>('/projects/:name/measurement-plan/draft/groups', async request => {
    const project = resolveProject(app.db, request.params.name)
    const authoring = parseStoredAuthoring(requireDraft(project).authoringJson)
    return paginate<MeasurementDraftGroup>(
      authoring.groups,
      request.query,
      group => labelSortKey(group.label, group.stableKey),
      group => `${group.label} ${group.stableKey}`,
    )
  })

  /**
   * `If-Match` is deliberately NOT required here: the draft this would name
   * does not exist yet, and `GET /measurement-plan/draft` answers `etag: null`
   * for a project without one, so there is nothing a caller could send. The
   * compare-and-swap that guards create is `expectedActiveRevision` in the
   * body, which pins the pointer the caller reviewed.
   */
  app.post<{ Params: { name: string } }>('/projects/:name/measurement-plan/draft/actions/create', async (request, reply) => {
    const gate = beginMutation(request, reply, 'create')
    if (gate.replay !== null) return gate.replay
    const parsed = measurementDraftCreateRequestSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('Invalid "create" payload', { issues: parsed.error.issues })

    // At most one draft per project, and a second create is a conflict rather
    // than a silent reset: the first one holds unreviewed operator work.
    if (draftRow(app.db, gate.project.id)) throw alreadyExists('Measurement plan draft', gate.project.name)

    const active = activePlanVersionRow(app.db, gate.project.id)
    if ((active?.revision ?? null) !== parsed.data.expectedActiveRevision) {
      throw measurementPlanRevisionConflict(parsed.data.expectedActiveRevision, active?.revision ?? null)
    }
    const authoring = seedAuthoring(
      gate.project,
      active ? parseStoredMeasurementPlanAnyVersion(active.canonicalJson) : null,
      actionContextFor(app.db, gate.project),
      opts,
    )
    const draftId = crypto.randomUUID()
    const response = mutationResponse(1, true, [], authoring)
    // Set only once the write has committed, so a failed mutation never comes
    // back carrying an ETag the caller could act on.
    const settled = finishMutation(gate, response, (tx, now) => {
      tx.insert(measurementPlanDrafts).values({
        id: draftId,
        projectId: gate.project.id,
        schemaVersion: 2,
        baseActiveVersionId: active?.id ?? null,
        baseActiveRevision: active?.revision ?? null,
        authoringJson: JSON.stringify(authoring),
        etagVersion: 1,
        createdBy: serializeActor(gate.actor),
        updatedBy: serializeActor(gate.actor),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }).run()
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: gate.project.id,
        actor: 'api',
        action: 'measurement-draft.created',
        entityType: 'measurement-draft',
        entityId: draftId,
        diff: { baseActiveRevision: active?.revision ?? null, etag: response.etag },
      }))
    })
    reply.header('etag', response.etag)
    return settled
  })

  for (const action of MEASUREMENT_DRAFT_ACTIONS) {
    app.post<{ Params: { name: string } }>(`/projects/:name/measurement-plan/draft/actions/${action}`, async (request, reply) => {
      const gate = beginMutation(request, reply, action)
      if (gate.replay !== null) return gate.replay
      const ifMatch = requireIfMatch(request)
      const row = requireDraft(gate.project)
      assertDraftEtag(row, ifMatch)

      const before = parseStoredAuthoring(row.authoringJson)
      const result = applyDraftAction(action, before, request.body, actionContextFor(app.db, gate.project))
      // A no-op leaves the counter alone: the ETag must change after every
      // successful MUTATION, and nothing was mutated.
      const changed = authoringIdentity(result.authoring) !== authoringIdentity(before)
      const etagVersion = changed ? row.etagVersion + 1 : row.etagVersion
      const response = mutationResponse(etagVersion, changed, result.warnings, result.authoring)
      const settled = finishMutation(gate, response, (tx, now) => {
        // The observed ETag was useful for early feedback, but the predicate
        // below is the real compare-and-swap. Two requests that both read mpd_2
        // cannot each write a successor; only the first one changes this row.
        const current = draftRow(tx, gate.project.id)
        if (!current) throw notFound('Measurement plan draft', gate.project.name)
        if (current.etagVersion !== row.etagVersion) {
          throw measurementDraftEtagStale(ifMatch, measurementDraftEtag(current.etagVersion))
        }
        if (!changed) return
        const updated = tx.update(measurementPlanDrafts).set({
          authoringJson: JSON.stringify(result.authoring),
          etagVersion,
          updatedBy: serializeActor(gate.actor),
          updatedAt: now.toISOString(),
        }).where(and(
          eq(measurementPlanDrafts.id, row.id),
          eq(measurementPlanDrafts.etagVersion, row.etagVersion),
        )).run()
        if (updated.changes !== 1) {
          const actual = draftRow(tx, gate.project.id)
          if (!actual) throw notFound('Measurement plan draft', gate.project.name)
          throw measurementDraftEtagStale(ifMatch, measurementDraftEtag(actual.etagVersion))
        }
        writeAuditLog(tx, auditFromRequest(request, {
          projectId: gate.project.id,
          actor: 'api',
          action: `measurement-draft.${action}`,
          entityType: 'measurement-draft',
          entityId: row.id,
          diff: { previousEtag: measurementDraftEtag(row.etagVersion), etag: response.etag },
        }))
      })
      reply.header('etag', response.etag)
      return settled
    })
  }

  /**
   * This is deliberately a POST read: the audience can be large, but preview
   * does not write a draft, audit, receipt, or usage row. The returned ETag is
   * the one the client must still hold when it applies this exact selection.
   */
  app.post<{ Params: { name: string } }>('/projects/:name/measurement-plan/draft/actions/preview-assignments', {
    config: {
      readSemantic: true,
      rateLimit: { max: 30, timeWindow: '1 minute' },
    },
  }, async (request, reply) => {
    requireScope(request, MEASUREMENT_PLAN_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    const parsed = measurementDraftPreviewAssignmentsRequestSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('Invalid "preview-assignments" payload', { issues: parsed.error.issues })
    const row = requireDraft(project)
    const before = parseStoredAuthoring(row.authoringJson)
    const result = applyAssignmentsToAuthoring(before, parsed.data, actionContextFor(app.db, project))
    assertMeasurementDraftAuthoringLimits(before, result.authoring)

    const context = compileContextFor(app.db, project)
    const current = compileMeasurementDraftAssignmentExecution(authoringForCompile(before, project, opts), context)
    const candidate = compileMeasurementDraftAssignmentExecution(authoringForCompile(result.authoring, project, opts), context)
    if (!current.ok || !candidate.ok) {
      throw validationError('The selected assignments have invalid question or provider settings. Review them and try again.', {
        displayToOperator: true,
        currentChecks: current.checks,
        candidateChecks: candidate.checks,
      })
    }

    const draftEtag = measurementDraftEtag(row.etagVersion)
    reply.header('etag', draftEtag)
    return {
      draftEtag,
      groups: result.audience.groups,
      resolvedTargetKeys: result.audience.targetKeys,
      overlapCount: result.audience.overlapCount,
      assignments: result.assignments,
      execution: assignmentExecutionImpact(current.plan, candidate.plan),
    }
  })

  app.post<{ Params: { name: string } }>('/projects/:name/measurement-plan/draft/actions/preview-group-membership', {
    bodyLimit: MEASUREMENT_GROUP_MEMBERSHIP_BODY_LIMIT,
    config: {
      readSemantic: true,
      rateLimit: { max: 30, timeWindow: '1 minute' },
    },
  }, async (request, reply) => {
    requireScope(request, MEASUREMENT_PLAN_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    const parsed = measurementDraftPreviewGroupMembershipRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('Invalid "preview-group-membership" payload', { issues: parsed.error.issues })
    }
    const row = requireDraft(project)
    try {
      const preview = previewGroupMembershipCsv({
        authoring: parseStoredAuthoring(row.authoringJson),
        draftEtag: measurementDraftEtag(row.etagVersion),
        segments: segmentDescriptorsFor(app.db, project.id),
        csv: parsed.data.csv,
      })
      reply.header('etag', preview.draftEtag)
      return preview
    } catch (error) {
      rethrowGroupMembershipError(error)
    }
  })

  app.post<{ Params: { name: string } }>('/projects/:name/measurement-plan/draft/actions/apply-group-membership', {
    bodyLimit: MEASUREMENT_GROUP_MEMBERSHIP_BODY_LIMIT,
  }, async (request, reply) => {
    const gate = beginMutation(request, reply, 'apply-group-membership')
    if (gate.replay !== null) return gate.replay
    const parsed = measurementDraftApplyGroupMembershipRequestSchema.safeParse(request.body)
    if (!parsed.success) {
      throw validationError('Invalid "apply-group-membership" payload', { issues: parsed.error.issues })
    }
    const ifMatch = requireIfMatch(request)
    const now = new Date()

    try {
      const settled = app.db.transaction(tx => {
        const row = draftRow(tx, gate.project.id)
        if (!row) throw notFound('Measurement plan draft', gate.project.name)
        assertDraftEtag(row, ifMatch)
        const before = parseStoredAuthoring(row.authoringJson)
        const preview = previewGroupMembershipCsv({
          authoring: before,
          draftEtag: measurementDraftEtag(row.etagVersion),
          segments: segmentDescriptorsFor(tx, gate.project.id),
          csv: parsed.data.csv,
        })
        const applied = applyReviewedGroupMembership(before, preview, parsed.data)
        assertMeasurementDraftAuthoringLimits(before, applied.authoring)

        const changed = authoringIdentity(applied.authoring) !== authoringIdentity(before)
        const etagVersion = changed ? row.etagVersion + 1 : row.etagVersion
        const response = {
          ...mutationResponse(etagVersion, changed, [], applied.authoring),
          appliedRows: applied.appliedRows,
          addedMemberships: applied.addedMemberships,
          unchangedMemberships: applied.unchangedMemberships,
        }
        if (changed) {
          const updated = tx.update(measurementPlanDrafts).set({
            authoringJson: JSON.stringify(applied.authoring),
            etagVersion,
            updatedBy: serializeActor(gate.actor),
            updatedAt: now.toISOString(),
          }).where(and(
            eq(measurementPlanDrafts.id, row.id),
            eq(measurementPlanDrafts.etagVersion, row.etagVersion),
          )).run()
          if (updated.changes !== 1) {
            const actual = draftRow(tx, gate.project.id)
            if (!actual) throw notFound('Measurement plan draft', gate.project.name)
            throw measurementDraftEtagStale(ifMatch, measurementDraftEtag(actual.etagVersion))
          }
          writeAuditLog(tx, auditFromRequest(request, {
            projectId: gate.project.id,
            actor: 'api',
            action: 'measurement-draft.apply-group-membership',
            entityType: 'measurement-draft',
            entityId: row.id,
            diff: {
              previousEtag: measurementDraftEtag(row.etagVersion),
              etag: response.etag,
              appliedRows: applied.appliedRows,
              addedMemberships: applied.addedMemberships,
            },
          }))
        }
        sweepExpiredMeasurementReceipts(tx, now)
        writeReceipt(tx, gate.project.id, gate.lookup, response, 200, now)
        return response
      })
      reply.header('etag', settled.etag)
      return settled
    } catch (error) {
      rethrowGroupMembershipError(error)
    }
  })

  // Both previews are POSTs only because the draft they compile is far too
  // large for a URL, and neither writes a row — see `readSemantic` in `auth.ts`.
  app.post<{ Params: { name: string } }>('/projects/:name/measurement-plan/draft/actions/compile-preview', {
    config: { readSemantic: true },
  }, async request => {
    requireScope(request, MEASUREMENT_PLAN_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    const authoring = authoringForCompile(parseStoredAuthoring(requireDraft(project).authoringJson), project, opts)
    const compiled = compileMeasurementDraft(authoring, compileContextFor(app.db, project))
    if (!compiled.ok) return { ok: false, compiledChecksum: null, checks: compiled.checks }
    return {
      ok: true,
      compiledChecksum: compiled.plan.compiledChecksum,
      checks: compiled.checks,
      counts: draftCounts(authoring),
      plan: compiled.plan,
    }
  })

  app.post<{ Params: { name: string } }>('/projects/:name/measurement-plan/draft/actions/diff-preview', {
    config: { readSemantic: true },
  }, async request => {
    requireScope(request, MEASUREMENT_PLAN_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    const authoring = authoringForCompile(parseStoredAuthoring(requireDraft(project).authoringJson), project, opts)
    const compiled = compileMeasurementDraft(authoring, compileContextFor(app.db, project))
    if (!compiled.ok) return { ok: false, compiledChecksum: null, checks: compiled.checks, diff: null }
    const active = activePlanVersionRow(app.db, project.id)
    // A v1 revision has no assignment model, so a diff against it would be
    // invented rather than computed. The candidate is reported whole and the
    // check says why.
    const comparable = active && active.schemaVersion === 2 ? parseV2Plan(active) : null
    const checks = active && !comparable
      ? [...compiled.checks, {
          ruleId: 'active-revision-schema-v1',
          severity: 'warn' as const,
          message: `Active revision ${active.revision} is schema v1, which has no assignment model. Everything below reads as added.`,
          path: [],
        }]
      : compiled.checks
    return {
      ok: true,
      compiledChecksum: compiled.plan.compiledChecksum,
      checks,
      counts: draftCounts(authoring),
      plan: compiled.plan,
      diff: diffCompiledPlans(comparable, compiled.plan, active?.revision ?? null),
    }
  })

  app.post<{ Params: { name: string } }>('/projects/:name/measurement-plan/draft/actions/publish', async (request, reply) => {
    const gate = beginMutation(request, reply, 'publish')
    if (gate.replay !== null) return gate.replay
    const parsed = measurementDraftPublishRequestSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('Invalid "publish" payload', { issues: parsed.error.issues })
    const ifMatch = requireIfMatch(request)
    const context = compileContextFor(app.db, gate.project)
    const now = new Date()

    // One transaction for the whole publish, receipt included. Every guard
    // throws, and a throw rolls the transaction back, so a refused publish
    // leaves the draft and the pointer exactly as they were — and never leaves
    // a replayable success behind for a publish that did not happen.
    return app.db.transaction(tx => {
      const settle = (published: boolean, version: PlanVersionRow, plan: MeasurementPlanV2) => {
        const response = {
          published,
          active: {
            revision: version.revision,
            checksum: version.checksum,
            compiledChecksum: version.compiledChecksum!,
            createdAt: version.createdAt,
            plan,
          },
        }
        sweepExpiredMeasurementReceipts(tx, now)
        writeReceipt(tx, gate.project.id, gate.lookup, response, 200, now)
        return response
      }

      const row = draftRow(tx, gate.project.id)
      if (!row) throw notFound('Measurement plan draft', gate.project.name)
      assertDraftEtag(row, ifMatch)

      const active = activePlanVersionRow(tx, gate.project.id)
      if ((active?.revision ?? null) !== parsed.data.expectedActiveRevision) {
        throw measurementPlanRevisionConflict(parsed.data.expectedActiveRevision, active?.revision ?? null)
      }

      // Recompiled here rather than trusted from the review: the project's
      // queries, locations or providers may have moved since it was compiled.
      const authoring = authoringForCompile(parseStoredAuthoring(row.authoringJson), gate.project, opts)
      const compiled = compileMeasurementDraft(authoring, context)
      if (!compiled.ok) {
        throw validationError('The measurement draft does not compile.', { checks: compiled.checks })
      }
      if (compiled.plan.compiledChecksum !== parsed.data.expectedCompiledChecksum) {
        throw measurementCompiledChecksumConflict(parsed.data.expectedCompiledChecksum, compiled.plan.compiledChecksum)
      }

      const clearDraft = () => {
        tx.delete(measurementPlanDrafts).where(eq(measurementPlanDrafts.id, row.id)).run()
      }

      // Identical to the ACTIVE revision is a no-op: the exact content is
      // already live, so a second row would claim a change nobody made.
      if (active && active.compiledChecksum === compiled.plan.compiledChecksum) {
        clearDraft()
        writeAuditLog(tx, auditFromRequest(request, {
          projectId: gate.project.id,
          actor: 'api',
          action: 'measurement-draft.published-noop',
          entityType: 'measurement-plan',
          entityId: String(active.revision),
          diff: { compiledChecksum: compiled.plan.compiledChecksum },
        }))
        return settle(false, active, parseV2Plan(active))
      }

      // Identical to an OLDER revision publishes as a NEW revision at max + 1:
      // revert is a first-class operation, and the compiled-checksum index is
      // non-unique precisely so this can happen (§0.1).
      const latest = tx.select({ revision: measurementPlanVersions.revision })
        .from(measurementPlanVersions)
        .where(eq(measurementPlanVersions.projectId, gate.project.id))
        .orderBy(desc(measurementPlanVersions.revision)).get()
      const revision = (latest?.revision ?? 0) + 1
      const canonicalJson = canonicalMeasurementPlanV2Json(compiled.plan)
      const versionId = crypto.randomUUID()

      const existingSegments = tx.select().from(measurementSegments)
        .where(eq(measurementSegments.projectId, gate.project.id)).all()
      const desired = new Map<string, 'target' | 'group'>([
        ...compiled.plan.targets.map(target => [target.stableKey, 'target'] as const),
        ...compiled.plan.groups.map(group => [group.stableKey, 'group'] as const),
      ])
      for (const segment of existingSegments) {
        const kind = desired.get(segment.stableKey)
        if (!kind) continue
        if (kind !== segment.kind) {
          throw validationError(`Measurement segment "${segment.stableKey}" cannot change kind from ${segment.kind} to ${kind}. Use a new stable key.`)
        }
        if (segment.retiredAt !== null) {
          throw validationError(`Measurement segment "${segment.stableKey}" is retired and cannot be reused. Use a new stable key.`)
        }
      }
      const existingKeys = new Set(existingSegments.map(segment => segment.stableKey))
      for (const [stableKey, kind] of desired) {
        if (existingKeys.has(stableKey)) continue
        tx.insert(measurementSegments).values({
          id: crypto.randomUUID(),
          projectId: gate.project.id,
          stableKey,
          kind,
          retiredAt: null,
          createdAt: now.toISOString(),
        }).run()
      }

      // Publish-time continuity: when this publish changes NOTHING about
      // execution — the superseded active revision froze the identical
      // execution surface — record the link so reads keep serving the previous
      // revision's runs instead of blanking until the next full sweep. An
      // execution-changing publish leaves the link null and keeps today's
      // refusal semantics exactly. A v1 active revision has no comparable
      // execution model, so it never links.
      const comparableToVersionId = active !== null
        && active.schemaVersion === 2
        && plansAreLabelOnlyVariants(parseV2Plan(active), compiled.plan)
        ? active.id
        : null

      tx.insert(measurementPlanVersions).values({
        id: versionId,
        projectId: gate.project.id,
        revision,
        canonicalJson,
        checksum: sha256Hex(canonicalJson),
        schemaVersion: 2,
        compiledChecksum: compiled.plan.compiledChecksum,
        comparableToVersionId,
        publishedBy: serializeActor(gate.actor),
        sourceDraftId: row.id,
        createdAt: now.toISOString(),
      }).run()
      if (active) {
        tx.update(measurementPlans)
          .set({ activeVersionId: versionId, updatedAt: now.toISOString() })
          .where(eq(measurementPlans.projectId, gate.project.id)).run()
      } else {
        tx.insert(measurementPlans).values({
          projectId: gate.project.id,
          activeVersionId: versionId,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        }).run()
      }
      clearDraft()
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: gate.project.id,
        actor: 'api',
        action: 'measurement-draft.published',
        entityType: 'measurement-plan',
        entityId: String(revision),
        diff: {
          previousRevision: active?.revision ?? null,
          compiledChecksum: compiled.plan.compiledChecksum,
          sourceDraftId: row.id,
        },
      }))
      const created = tx.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.id, versionId)).get()!
      return settle(true, created, compiled.plan)
    })
  })

  app.post<{ Params: { name: string } }>('/projects/:name/measurement-plan/draft/actions/discard', async (request, reply) => {
    const gate = beginMutation(request, reply, 'discard')
    if (gate.replay !== null) return gate.replay
    const ifMatch = requireIfMatch(request)
    const row = requireDraft(gate.project)
    assertDraftEtag(row, ifMatch)
    return finishMutation(gate, { discarded: true }, tx => {
      tx.delete(measurementPlanDrafts).where(eq(measurementPlanDrafts.id, row.id)).run()
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: gate.project.id,
        actor: 'api',
        action: 'measurement-draft.discarded',
        entityType: 'measurement-draft',
        entityId: row.id,
      }))
    })
  })

  app.post<{ Params: { name: string } }>('/projects/:name/measurement-plan/actions/deactivate', async (request, reply) => {
    const gate = beginMutation(request, reply, 'deactivate')
    if (gate.replay !== null) return gate.replay
    const parsed = measurementPlanDeactivateRequestSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('Invalid "deactivate" payload', { issues: parsed.error.issues })
    const active = activePlanVersionRow(app.db, gate.project.id)
    if (!active) throw notFound('Active measurement plan', gate.project.name)
    if (active.revision !== parsed.data.expectedActiveRevision) {
      throw measurementPlanRevisionConflict(parsed.data.expectedActiveRevision, active.revision)
    }
    return finishMutation(gate, { deactivated: true, previousRevision: active.revision }, tx => {
      // The pointer row and nothing else. Schedules, runs, queries, versions
      // and evidence are untouched, and every revision stays readable.
      tx.delete(measurementPlans).where(eq(measurementPlans.projectId, gate.project.id)).run()
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: gate.project.id,
        actor: 'api',
        action: 'measurement-plan.deactivated',
        entityType: 'measurement-plan',
        entityId: String(active.revision),
      }))
    })
  })

  function querySetDetail(projectId: string, setId: string) {
    const set = app.db.select().from(measurementQuerySets).where(and(
      eq(measurementQuerySets.projectId, projectId),
      eq(measurementQuerySets.id, setId),
    )).get()
    if (!set) throw notFound('Measurement query set', setId)
    const items = app.db.select({
      queryId: measurementQuerySetItems.queryId,
      queryText: queries.query,
      position: measurementQuerySetItems.position,
    }).from(measurementQuerySetItems)
      .innerJoin(queries, eq(queries.id, measurementQuerySetItems.queryId))
      .where(eq(measurementQuerySetItems.querySetId, setId))
      .orderBy(asc(measurementQuerySetItems.position)).all()
    return {
      id: set.id,
      projectId: set.projectId,
      name: set.name,
      description: set.description,
      itemCount: items.length,
      createdAt: set.createdAt,
      updatedAt: set.updatedAt,
      items,
    }
  }

  app.get<{ Params: { name: string } }>('/projects/:name/measurement-query-sets', async request => {
    const project = resolveProject(app.db, request.params.name)
    const sets = app.db.select().from(measurementQuerySets)
      .where(eq(measurementQuerySets.projectId, project.id))
      .orderBy(asc(measurementQuerySets.name)).all()
    const counts = new Map<string, number>()
    if (sets.length) {
      for (const item of app.db.select({ querySetId: measurementQuerySetItems.querySetId })
        .from(measurementQuerySetItems)
        .where(inArray(measurementQuerySetItems.querySetId, sets.map(set => set.id))).all()) {
        counts.set(item.querySetId, (counts.get(item.querySetId) ?? 0) + 1)
      }
    }
    return {
      querySets: sets.map(set => ({
        id: set.id,
        projectId: set.projectId,
        name: set.name,
        description: set.description,
        itemCount: counts.get(set.id) ?? 0,
        createdAt: set.createdAt,
        updatedAt: set.updatedAt,
      })),
    }
  })

  app.get<{ Params: { name: string; setId: string } }>('/projects/:name/measurement-query-sets/:setId', async request => {
    const project = resolveProject(app.db, request.params.name)
    return querySetDetail(project.id, request.params.setId)
  })

  app.put<{ Params: { name: string; setId: string } }>('/projects/:name/measurement-query-sets/:setId', async (request, reply) => {
    requireScope(request, MEASUREMENT_PLAN_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    const parsed = measurementQuerySetUpsertRequestSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('Invalid query set payload', { issues: parsed.error.issues })
    const setId = request.params.setId
    const known = new Set(trackedQueriesFor(app.db, project.id).map(query => query.id))
    for (const queryId of parsed.data.queryIds) {
      if (!known.has(queryId)) throw notFound('Query', queryId)
    }
    const existing = app.db.select().from(measurementQuerySets).where(and(
      eq(measurementQuerySets.projectId, project.id),
      eq(measurementQuerySets.id, setId),
    )).get()
    const now = new Date().toISOString()
    app.db.transaction(tx => {
      if (existing) {
        tx.update(measurementQuerySets)
          .set({ name: parsed.data.name, description: parsed.data.description ?? null, updatedAt: now })
          .where(eq(measurementQuerySets.id, setId)).run()
        // Membership is declarative: the rows go, the queries never do.
        tx.delete(measurementQuerySetItems).where(eq(measurementQuerySetItems.querySetId, setId)).run()
      } else {
        tx.insert(measurementQuerySets).values({
          id: setId,
          projectId: project.id,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          createdAt: now,
          updatedAt: now,
        }).run()
      }
      let position = 0
      for (const queryId of [...new Set(parsed.data.queryIds)]) {
        tx.insert(measurementQuerySetItems).values({
          id: crypto.randomUUID(),
          querySetId: setId,
          queryId,
          position: position++,
          createdAt: now,
        }).run()
      }
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id,
        actor: 'api',
        action: existing ? 'measurement-query-set.replaced' : 'measurement-query-set.created',
        entityType: 'measurement-query-set',
        entityId: setId,
      }))
    })
    return reply.status(existing ? 200 : 201).send(querySetDetail(project.id, setId))
  })

  app.delete<{ Params: { name: string; setId: string } }>('/projects/:name/measurement-query-sets/:setId', async (request, reply) => {
    requireScope(request, MEASUREMENT_PLAN_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    const existing = app.db.select().from(measurementQuerySets).where(and(
      eq(measurementQuerySets.projectId, project.id),
      eq(measurementQuerySets.id, request.params.setId),
    )).get()
    if (!existing) throw notFound('Measurement query set', request.params.setId)
    app.db.transaction(tx => {
      // The cascade drops the membership rows only. Neither the queries nor any
      // published snapshot of them is reachable from here.
      tx.delete(measurementQuerySets).where(eq(measurementQuerySets.id, existing.id)).run()
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id,
        actor: 'api',
        action: 'measurement-query-set.deleted',
        entityType: 'measurement-query-set',
        entityId: existing.id,
      }))
    })
    return reply.status(204).send()
  })

  function templateDto(row: typeof measurementQueryTemplates.$inferSelect) {
    return {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      description: row.description,
      pattern: row.pattern,
      variables: row.variables,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  app.get<{ Params: { name: string } }>('/projects/:name/measurement-query-templates', async request => {
    const project = resolveProject(app.db, request.params.name)
    const rows = app.db.select().from(measurementQueryTemplates)
      .where(eq(measurementQueryTemplates.projectId, project.id))
      .orderBy(asc(measurementQueryTemplates.name)).all()
    return { templates: rows.map(templateDto) }
  })

  app.put<{ Params: { name: string; templateId: string } }>('/projects/:name/measurement-query-templates/:templateId', async (request, reply) => {
    requireScope(request, MEASUREMENT_PLAN_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    const parsed = measurementQueryTemplateUpsertRequestSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('Invalid query template payload', { issues: parsed.error.issues })
    for (const variable of parsed.data.variables) {
      if (!parsed.data.pattern.includes(`{${variable}}`)) {
        throw validationError(`Template pattern does not use the variable "{${variable}}".`)
      }
    }
    const templateId = request.params.templateId
    const existing = app.db.select().from(measurementQueryTemplates).where(and(
      eq(measurementQueryTemplates.projectId, project.id),
      eq(measurementQueryTemplates.id, templateId),
    )).get()
    const now = new Date().toISOString()
    app.db.transaction(tx => {
      if (existing) {
        tx.update(measurementQueryTemplates).set({
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          pattern: parsed.data.pattern,
          variables: parsed.data.variables,
          updatedAt: now,
        }).where(eq(measurementQueryTemplates.id, templateId)).run()
      } else {
        tx.insert(measurementQueryTemplates).values({
          id: templateId,
          projectId: project.id,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          pattern: parsed.data.pattern,
          variables: parsed.data.variables,
          createdAt: now,
          updatedAt: now,
        }).run()
      }
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id,
        actor: 'api',
        action: existing ? 'measurement-query-template.replaced' : 'measurement-query-template.created',
        entityType: 'measurement-query-template',
        entityId: templateId,
      }))
    })
    const row = app.db.select().from(measurementQueryTemplates).where(eq(measurementQueryTemplates.id, templateId)).get()!
    return reply.status(existing ? 200 : 201).send(templateDto(row))
  })

  app.delete<{ Params: { name: string; templateId: string } }>('/projects/:name/measurement-query-templates/:templateId', async (request, reply) => {
    requireScope(request, MEASUREMENT_PLAN_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    const existing = app.db.select().from(measurementQueryTemplates).where(and(
      eq(measurementQueryTemplates.projectId, project.id),
      eq(measurementQueryTemplates.id, request.params.templateId),
    )).get()
    if (!existing) throw notFound('Measurement query template', request.params.templateId)
    app.db.transaction(tx => {
      // The template is an authoring asset. Queries it already expanded, and
      // every published snapshot of them, outlive it.
      tx.delete(measurementQueryTemplates).where(eq(measurementQueryTemplates.id, existing.id)).run()
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id,
        actor: 'api',
        action: 'measurement-query-template.deleted',
        entityType: 'measurement-query-template',
        entityId: existing.id,
      }))
    })
    return reply.status(204).send()
  })

  app.post<{ Params: { name: string; templateId: string } }>('/projects/:name/measurement-query-templates/:templateId/apply', async (request, reply) => {
    const gate = beginMutation(request, reply, `query-template.apply:${request.params.templateId}`)
    if (gate.replay !== null) return gate.replay
    const parsed = measurementQueryTemplateApplyRequestSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('Invalid template apply payload', { issues: parsed.error.issues })
    const template = app.db.select().from(measurementQueryTemplates).where(and(
      eq(measurementQueryTemplates.projectId, gate.project.id),
      eq(measurementQueryTemplates.id, request.params.templateId),
    )).get()
    if (!template) throw notFound('Measurement query template', request.params.templateId)

    const expansions: string[] = []
    parsed.data.bindings.forEach((binding, index) => {
      const missing = template.variables.filter(variable => !Object.hasOwn(binding, variable))
      if (missing.length) {
        throw validationError(`Binding ${index} does not supply ${missing.map(name => `"${name}"`).join(', ')}.`)
      }
      let text = template.pattern
      for (const variable of template.variables) text = text.split(`{${variable}}`).join(binding[variable])
      const trimmed = text.trim()
      if (!trimmed) throw validationError(`Binding ${index} expands to an empty question.`)
      if (!expansions.includes(trimmed)) expansions.push(trimmed)
    })

    const byText = new Map(trackedQueriesFor(app.db, gate.project.id).map(row => [row.query, row.id]))
    const created: Array<{ queryId: string; queryText: string }> = []
    const existing: Array<{ queryId: string; queryText: string }> = []
    // Expansion order, kept separately from the created/existing split: a set
    // holds ORDERED references, so appending the new ones first would reorder
    // the basket around an accident of which questions happened to exist.
    const ordered = expansions.map(queryText => {
      const found = byText.get(queryText)
      // Expansion is additive: an existing question is reported, never
      // duplicated, and a new id is minted here so the response and the row it
      // writes below agree.
      const entry = { queryId: found ?? crypto.randomUUID(), queryText }
      ;(found ? existing : created).push(entry)
      return entry
    })

    const querySet = parsed.data.querySetId
      ? app.db.select().from(measurementQuerySets).where(and(
          eq(measurementQuerySets.projectId, gate.project.id),
          eq(measurementQuerySets.id, parsed.data.querySetId),
        )).get()
      : undefined
    if (parsed.data.querySetId && !querySet) throw notFound('Measurement query set', parsed.data.querySetId)

    return finishMutation(gate, { created, existing }, (tx, now) => {
      for (const entry of created) {
        tx.insert(queries).values({
          id: entry.queryId,
          projectId: gate.project.id,
          query: entry.queryText,
          provenance: `measurement-template:${template.id}`,
          createdAt: now.toISOString(),
        }).run()
      }
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: gate.project.id,
        actor: 'api',
        action: 'measurement-query-template.applied',
        entityType: 'measurement-query-template',
        entityId: template.id,
        diff: { created: created.length, existing: existing.length },
      }))
      if (!querySet) return
      const highest = tx.select({ position: measurementQuerySetItems.position })
        .from(measurementQuerySetItems)
        .where(eq(measurementQuerySetItems.querySetId, querySet.id))
        .orderBy(desc(measurementQuerySetItems.position)).get()
      let position = (highest?.position ?? -1) + 1
      const present = new Set(tx.select({ queryId: measurementQuerySetItems.queryId })
        .from(measurementQuerySetItems)
        .where(eq(measurementQuerySetItems.querySetId, querySet.id)).all()
        .map(item => item.queryId))
      for (const entry of ordered) {
        if (present.has(entry.queryId)) continue
        present.add(entry.queryId)
        tx.insert(measurementQuerySetItems).values({
          id: crypto.randomUUID(),
          querySetId: querySet.id,
          queryId: entry.queryId,
          position: position++,
          createdAt: now.toISOString(),
        }).run()
      }
      tx.update(measurementQuerySets).set({ updatedAt: now.toISOString() })
        .where(eq(measurementQuerySets.id, querySet.id)).run()
    })
  })
}
