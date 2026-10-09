import crypto from 'node:crypto'
import { and, desc, eq, gt, inArray, or } from 'drizzle-orm'
import {
  batchDispatchRefusalMessage,
  buildMeasurementExecutionIdentity,
  buildMeasurementRunManifestV1,
  canonicalMeasurementExecutionIdentityJson,
  isProviderAccountFailure,
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION,
  MeasurementRunScopeError,
  measurementRunScopeIsEmpty,
  measurementRunScopeSchema,
  normalizeMeasurementExecutionQueryText,
  parseRunError,
  parseStoredMeasurementPlanAnyVersion,
  PROVIDER_ACCOUNT_FAILURE_STREAK,
  PROVIDER_ACCOUNT_RETRY_HOURS,
  ProviderDispatchModes,
  providersFailing,
  resolveRunDispatchModes,
  RunKinds,
  RunStatuses,
  RunTriggers,
  nextScheduleUpdatedAt,
  resolveMeasurementRunQueryScope,
  resolveMeasurementRunScope,
  resolveProviderModel,
  validationError,
  type LocationContext,
  type MeasurementExecutionIdentity,
  type MeasurementExecutionNode,
  type MeasurementExpectedSlotV1,
  type MeasurementPlan,
  type MeasurementPlanV2,
  type MeasurementRunManifestV1,
  type MeasurementRunScope,
  type MeasurementRunScopeRequest,
  type MeasurementV2ExecutionNode,
  type AppError,
  type ProviderAccountStreak,
  type ProviderDispatchMode,
  type ProviderErrorCode,
  type RunAdmissionDto,
  type RunDispatchResolution,
  compareText,
  sortedUnique,
} from '@ainyc/canonry-contracts'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { auditLog, measurementPlans, measurementPlanVersions, parseJsonColumn, projects, querySnapshots, runs, schedules } from '@ainyc/canonry-db'
import { writeAuditLog } from './helpers.js'
import { buildMeasurementRunManifest } from './measurement-report-adapter.js'
import { ensureCurrentQueryBasketRevision } from './query-basket.js'

export interface QueueRunParams {
  projectId: string
  kind?: string
  trigger?: string
  createdAt?: string
  location?: string | null
  /** Array of tracked query strings to scope the sweep to. Null = full sweep. */
  queries?: string[] | null
  /**
   * Providers this run was asked for. Empty or omitted falls back to the
   * project's own list, and an empty project list falls back to whatever the
   * instance can run — the same order the preflight check uses, so what is
   * stamped is what was validated.
   */
  providers?: readonly string[] | null
  /** Providers this instance can actually run, for the "all configured" fallback. */
  runnableProviders?: readonly string[] | null
  /**
   * Provider → the model this instance currently has it pointed at, used when
   * the project pins no override. Without it an inherited default could change
   * under a series with nothing recording the change.
   */
  providerModels?: Readonly<Record<string, string>> | null
  /** Groups/targets to spot-check, resolved against the plan revision pinned here. */
  measurementScope?: MeasurementRunScopeRequest | null
  /**
   * The dispatch mode the request asked for explicitly. `batch` batches every
   * eligible provider and is refused when none is; `sync` batches nothing;
   * omitted leaves the decision to the trigger (only a scheduled run reads the
   * project's `providerDispatchModes`).
   */
  dispatchMode?: ProviderDispatchMode | null
  /**
   * Providers this instance can batch: the adapter has a batch API and
   * `providers.<name>.batch.enabled` is true. Omitted means none can.
   */
  batchEligibleProviders?: readonly string[] | null
  /**
   * Call every provider, and queue even when every one this run would call
   * keeps failing on its account (see `providerAccountAdmission`). Only an
   * operator asks for this; the scheduler never does.
   */
  force?: boolean
  /**
   * Record a refusal in the audit log (`run.refused`), once per refusal. The
   * scheduler passes it; an API caller hears the refusal as a 422 instead.
   */
  auditRefusal?: { actor: string; entityType: string; entityId: string }
  /** Atomically advance one due calendar occurrence while queueing this run. */
  scheduleClaim?: {
    scheduleId: string
    dueAt: string
    expectedUpdatedAt: string
    nextRunAt: string
  }
}

interface MeasurementStamp {
  versionId: string
  manifest: MeasurementRunManifestV1
  scope: MeasurementRunScope | null
  identity: MeasurementExecutionIdentity
}

/** Whether this project's runs measure a published plan. */
export function hasActiveMeasurementPlan(db: DatabaseClient, projectId: string): boolean {
  return db.select({ projectId: measurementPlans.projectId }).from(measurementPlans)
    .where(eq(measurementPlans.projectId, projectId)).get() !== undefined
}

/**
 * The engines an Advanced project's runs measure: those its active v2 revision
 * froze on its execution nodes, whatever the project row lists (see
 * `measurementStampV2`). Empty for a project with no published plan or a v1
 * plan, whose runs measure the project's own provider list.
 */
export function activeRevisionProviders(db: Pick<DatabaseClient, 'select'>, projectId: string): string[] {
  const version = db.select({ canonicalJson: measurementPlanVersions.canonicalJson })
    .from(measurementPlans)
    .innerJoin(measurementPlanVersions, and(
      eq(measurementPlanVersions.projectId, measurementPlans.projectId),
      eq(measurementPlanVersions.id, measurementPlans.activeVersionId),
    ))
    .where(eq(measurementPlans.projectId, projectId))
    .get()
  if (!version) return []
  const stored = parseStoredMeasurementPlanAnyVersion(version.canonicalJson)
  if (stored.schemaVersion !== MEASUREMENT_PLAN_V2_SCHEMA_VERSION) return []
  return normalizeProviders(stored.executionNodes.flatMap(node => node.context.providers))
}

/** The checksum layer contracts deliberately leaves to whoever owns hashing. */
function executionIdentityChecksum(input: { providers: readonly string[]; models: Record<string, string> }): string {
  return crypto.createHash('sha256')
    .update(canonicalMeasurementExecutionIdentityJson(input))
    .digest('hex')
}

function normalizeProviders(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim().toLocaleLowerCase('en')).filter(Boolean))].sort()
}

/**
 * Which providers a run measures with: what was asked for, else the project's
 * own list, else everything the instance can run. An empty project list means
 * "all configured" everywhere else in canonry, and reading it as zero here
 * would freeze an expectation nothing could ever satisfy.
 */
export function resolveRunProviderSelection(input: {
  requestedProviders?: readonly string[] | null
  projectProviders?: readonly string[] | null
  runnableProviders?: readonly string[] | null
}): string[] {
  return resolveRunnableProviderSelection(input).selectedProviders
}

/**
 * Resolve both the requested roster and the subset this host can execute.
 * Run preflight and project-readable readiness surfaces share this exact decision so
 * the dashboard never claims a launch state the run route would reject.
 */
export function resolveRunnableProviderSelection(input: {
  requestedProviders?: readonly string[] | null
  projectProviders?: readonly string[] | null
  runnableProviders?: readonly string[] | null
}): {
  availableProviders: string[]
  selectedProviders: string[]
  runnableProviders: string[]
  selectionSource: 'request' | 'project' | 'instance'
} {
  const availableProviders = normalizeProviders(input.runnableProviders ?? [])
  const requested = normalizeProviders(input.requestedProviders ?? [])
  const project = normalizeProviders(input.projectProviders ?? [])
  const selectedProviders = requested.length > 0
    ? requested
    : project.length > 0
      ? project
      : availableProviders
  const available = new Set(availableProviders)
  return {
    availableProviders,
    selectedProviders,
    runnableProviders: selectedProviders.filter(provider => available.has(provider)),
    selectionSource: requested.length > 0
      ? 'request'
      : project.length > 0
        ? 'project'
        : 'instance',
  }
}

function providerRoster(tx: DatabaseClient, params: QueueRunParams): string[] {
  return resolveRunProviderSelection({
    requestedProviders: params.providers,
    projectProviders: tx.select({ providers: projects.providers }).from(projects)
      .where(eq(projects.id, params.projectId)).get()?.providers ?? [],
    runnableProviders: params.runnableProviders,
  })
}

/**
 * The model that will actually answer for each provider: the project's
 * override if it set one, otherwise whatever this instance has the provider
 * pointed at, otherwise the provider's own default.
 *
 * Resolved here rather than left to execution because an inherited default
 * that changes underneath a series has to produce a different execution
 * identity, not a silently different measurement.
 */
function effectiveModels(
  tx: DatabaseClient,
  params: QueueRunParams,
  providers: readonly string[],
): Record<string, string> {
  const overrides = tx.select({ models: projects.providerModels }).from(projects)
    .where(eq(projects.id, params.projectId)).get()?.models ?? {}
  const instance = params.providerModels ?? {}
  const resolved: Record<string, string> = {}
  for (const provider of providers) {
    const model = overrides[provider] ?? instance[provider]
    // An override stored before its id was retired names the engine that
    // answers now, so the frozen slot, the snapshot, and the identity agree.
    if (model) resolved[provider] = resolveProviderModel(provider, model)
  }
  return resolved
}

function expectedSlotsFor(
  nodes: readonly MeasurementExecutionNode[],
  providers: readonly string[],
  models: Record<string, string>,
): Array<{ executionId: string; queryText: string; provider: string; context: MeasurementExecutionNode['context']; requestedModel?: string }> {
  return nodes.flatMap(node => providers.map(provider => ({
    executionId: node.stableKey,
    queryText: node.queryText,
    provider,
    context: node.context,
    // Freeze the model too. A project that re-points a provider between queue
    // and execution would otherwise change what a stored row means without
    // anything recording that it moved.
    ...(models[provider] ? { requestedModel: models[provider] } : {}),
  })))
}

/**
 * A place, reduced to the identity two execution nodes are compared on. Label
 * casing and stray whitespace are authoring noise; the same city asked about
 * twice is one provider request, not two.
 */
function normalizedLocationIdentity(value: LocationContext | null): string | null {
  if (!value) return null
  return [value.country, value.region, value.city, value.label, value.timezone ?? '']
    .map(part => part.trim().toLocaleLowerCase('en'))
    .join('\u0000')
}

/** The engine configuration of one node, lower-cased and blank-stripped for lookup and comparison. */
function nodeProviderModels(node: MeasurementV2ExecutionNode): Map<string, string> {
  const declared = new Map<string, string>()
  for (const [key, value] of Object.entries(node.context.models)) {
    const provider = key.trim().toLocaleLowerCase('en')
    if (provider && value.trim()) declared.set(provider, value.trim())
  }
  return declared
}

/**
 * The dedup identity of §11: one provider request per unique question,
 * normalized place, and provider/model map.
 *
 * A compiled revision is already unique by it, and the runner re-derives it
 * anyway rather than trusting that. A duplicate node reaching the manifest
 * would buy a second provider call for a measurement already being made, and
 * add a slot to the denominator every rate in the revision is taken over.
 */
function executionSlotIdentity(
  node: MeasurementV2ExecutionNode,
  providers: readonly string[],
  models: ReadonlyMap<string, string>,
): string {
  return crypto.createHash('sha256').update(JSON.stringify([
    node.queryId,
    normalizedLocationIdentity(node.context.location),
    providers.map(provider => [provider, models.get(provider) ?? null]),
  ])).digest('hex')
}

interface V2Materialization {
  expectedSlots: MeasurementExpectedSlotV1[]
  providers: string[]
  models: Record<string, string>
}

/**
 * Turn frozen execution nodes into the provider work one run will do.
 *
 * The unit of work is the node, never the assignment: a node shared by every
 * Property in a portfolio is one request per engine, and the Targets that
 * reuse it are usage edges the report reads, not extra calls.
 *
 * `instanceModels` fills only what the revision left open. A revision that
 * pinned no model for an engine still has to record which model answered,
 * because an inherited default that moves underneath a series has to start a
 * new one rather than change what stored rows mean.
 */
function materializeV2ExecutionNodes(
  nodes: readonly MeasurementV2ExecutionNode[],
  instanceModels: Readonly<Record<string, string>>,
): V2Materialization {
  const expectedSlots: MeasurementExpectedSlotV1[] = []
  const providers = new Set<string>()
  // `null` marks an engine this revision runs on more than one model: the run
  // identity has one slot per engine, and guessing which model to put in it
  // would describe a measurement that never happened. The per-slot
  // `requestedModel` stays exact either way.
  const models = new Map<string, string | null>()
  // What actually answers per engine, and which engines froze a retired id
  // (Perplexity's `sonar`). A mixed-model engine is left out of the identity,
  // so without this a revision mixing `sonar` and `sonar-pro` would keep the
  // same checksum after the switch while every request ran a new engine.
  const answering = new Map<string, Set<string>>()
  const retired = new Set<string>()
  const claimed = new Set<string>()

  for (const node of [...nodes].sort((left, right) => compareText(left.stableKey, right.stableKey))) {
    const nodeProviders = normalizeProviders(node.context.providers)
    const declared = nodeProviderModels(node)
    const resolved = new Map<string, string>()
    for (const provider of nodeProviders) {
      const model = declared.get(provider) ?? instanceModels[provider]
      if (model) resolved.set(provider, model)
    }

    const identity = executionSlotIdentity(node, nodeProviders, resolved)
    if (claimed.has(identity)) continue
    claimed.add(identity)

    for (const provider of nodeProviders) {
      providers.add(provider)
      const model = resolved.get(provider) ?? null
      if (!models.has(provider)) models.set(provider, model)
      else if (models.get(provider) !== model) models.set(provider, null)
      if (model) {
        const current = resolveProviderModel(provider, model)
        if (current !== model) retired.add(provider)
        answering.set(provider, (answering.get(provider) ?? new Set<string>()).add(current))
      }
      expectedSlots.push({
        executionId: node.stableKey,
        queryText: node.queryText,
        provider,
        context: node.context.location,
        ...(model ? { requestedModel: model } : {}),
      })
    }
  }

  return {
    expectedSlots,
    providers: [...providers].sort(compareText),
    models: Object.fromEntries([...models].flatMap(([provider, model]) => {
      if (model) return [[provider, model] as const]
      // A mixed-model engine that froze a retired id records every model that
      // answers now, so the switch reads as a new series. Other mixed-model
      // engines stay out, exactly as before, so their series do not break.
      const current = answering.get(provider)
      return retired.has(provider) && current
        ? [[provider, [...current].sort(compareText).join(' + ')] as const]
        : []
    })),
  }
}

/**
 * The slice a v2 run measures, or null when it measures the whole revision.
 *
 * v1's resolvers cannot serve here: they read `usageEdges[].kind`, and a v2
 * revision has no baseline questions, so every edge belongs to a Target. The
 * failure vocabulary is deliberately identical, so an operator who names a key
 * the plan does not have reads the same sentence whichever schema they are on.
 */
function sliceForV2(plan: MeasurementPlanV2, params: QueueRunParams): {
  scope: MeasurementRunScope
  executionNodes: MeasurementV2ExecutionNode[]
} | null {
  if (!measurementRunScopeIsEmpty(params.measurementScope)) {
    return asScopeValidation(() => resolveV2RunScope(plan, params.measurementScope!))
  }
  if (params.queries?.length) {
    return asScopeValidation(() => resolveV2QueryScope(plan, params.queries!))
  }
  return null
}

function quotedList(values: readonly string[]): string {
  return values.map(value => `"${value}"`).join(', ')
}

function resolveV2RunScope(plan: MeasurementPlanV2, scope: MeasurementRunScopeRequest) {
  const requestedGroups = sortedUnique(scope.groups ?? [])
  const requestedTargets = sortedUnique(scope.targets ?? [])
  const groupsByKey = new Map(plan.groups.map(group => [group.stableKey, group]))
  const targetKeys = new Set(plan.targets.map(target => target.stableKey))

  const unknownGroups = requestedGroups.filter(key => !groupsByKey.has(key))
  const unknownTargets = requestedTargets.filter(key => !targetKeys.has(key))
  if (unknownGroups.length || unknownTargets.length) {
    const parts: string[] = []
    if (unknownGroups.length) parts.push(`no group named ${quotedList(unknownGroups)}`)
    if (unknownTargets.length) parts.push(`no target named ${quotedList(unknownTargets)}`)
    throw new MeasurementRunScopeError({
      message: `The published measurement plan has ${parts.join(', and ')}. Check the spelling against the plan, or publish a plan that includes it.`,
      unknownGroups,
      unknownTargets,
    })
  }

  const selected = new Set<string>(requestedTargets)
  for (const key of requestedGroups) {
    for (const targetKey of groupsByKey.get(key)!.targetKeys) selected.add(targetKey)
  }
  const resolvedTargets = [...selected].sort(compareText)

  const usedNodeKeys = new Set(plan.usageEdges.filter(edge => selected.has(edge.targetKey)).map(edge => edge.executionNodeKey))
  const executionNodes = plan.executionNodes.filter(node => usedNodeKeys.has(node.stableKey))
  if (executionNodes.length === 0) {
    throw new MeasurementRunScopeError({
      message: `Nothing to measure: ${quotedList(resolvedTargets)} has no queries selected in the published measurement plan.`,
      emptyTargets: resolvedTargets,
    })
  }

  return {
    scope: measurementRunScopeSchema.parse({ groups: requestedGroups, targets: requestedTargets, queries: [], resolvedTargets }),
    executionNodes,
  }
}

function resolveV2QueryScope(plan: MeasurementPlanV2, queryTexts: readonly string[]) {
  const requested = sortedUnique(queryTexts.map(normalizeMeasurementExecutionQueryText).filter(Boolean))
  const measured = new Set(plan.executionNodes.map(node => normalizeMeasurementExecutionQueryText(node.queryText)))
  const unknown = requested.filter(text => !measured.has(text))
  if (unknown.length) {
    throw new MeasurementRunScopeError({
      message: `The published measurement plan does not measure ${quotedList(unknown)}. `
        + 'Publish a revision that includes it, or run a question the plan already measures.',
      unknownQueries: unknown,
    })
  }

  return {
    scope: measurementRunScopeSchema.parse({ groups: [], targets: [], queries: requested, resolvedTargets: [] }),
    executionNodes: plan.executionNodes.filter(node => (
      requested.includes(normalizeMeasurementExecutionQueryText(node.queryText))
    )),
  }
}

/**
 * Materialize one run against a published v2 revision.
 *
 * Everything the run measures comes out of the frozen document — the questions,
 * the places, and the engines and models each node was published with. The
 * project row is deliberately not consulted for provider configuration: a v2
 * revision froze it, and reading today's live settings would let a project
 * setting change what an immutable revision means.
 */
function measurementStampV2(plan: MeasurementPlanV2, versionId: string, params: QueueRunParams): MeasurementStamp {
  const resolution = sliceForV2(plan, params)
  const nodes = resolution?.executionNodes ?? plan.executionNodes
  if (nodes.length === 0) {
    throw validationError(
      'The published measurement plan has no execution nodes, so this run would measure nothing. '
      + 'Publish a revision with at least one property assigned to a question.',
    )
  }

  const materialized = materializeV2ExecutionNodes(nodes, params.providerModels ?? {})
  const requested = normalizeProviders(params.providers ?? [])
  if (requested.length && requested.join('\u0000') !== materialized.providers.join('\u0000')) {
    throw validationError(
      `This measurement plan revision measures with ${materialized.providers.join(', ')}, and this run asked for `
      + `${requested.join(', ')}. A published revision freezes which engines answer each question, and how many `
      + 'answers each question expects is the denominator of every rate taken over it. '
      + 'Run it without a provider list, or publish a revision that names the engines you want.',
      { planProviders: materialized.providers, requestedProviders: requested },
    )
  }

  return {
    versionId,
    manifest: buildMeasurementRunManifestV1({ expectedSlots: materialized.expectedSlots }),
    scope: resolution?.scope ?? null,
    // Recorded, never refused: a v2 revision pins the models, so this repeats
    // the revision back rather than describing a choice the run made.
    identity: buildMeasurementExecutionIdentity(
      { providers: materialized.providers, models: materialized.models },
      executionIdentityChecksum({ providers: materialized.providers, models: materialized.models }),
    ),
  }
}

function measurementStamp(tx: DatabaseClient, params: QueueRunParams): MeasurementStamp | null {
  const active = tx.select().from(measurementPlans)
    .where(eq(measurementPlans.projectId, params.projectId)).get()
  if (!active) {
    if (!measurementRunScopeIsEmpty(params.measurementScope)) {
      throw validationError(
        'This project has no published measurement plan, so there is nothing for a group or target scope to point at. '
        + 'Publish a plan first, or run a full sweep.',
      )
    }
    return null
  }

  const version = tx.select().from(measurementPlanVersions).where(and(
    eq(measurementPlanVersions.projectId, params.projectId),
    eq(measurementPlanVersions.id, active.activeVersionId),
  )).get()
  if (!version) throw new Error(`Measurement plan ${params.projectId} points to missing version ${active.activeVersionId}`)

  // A v2 revision carries its own provider configuration, so it materializes
  // from the frozen document alone. v1 keeps the roster-and-project path below,
  // unchanged: those revisions never froze which engines answer.
  const stored = parseStoredMeasurementPlanAnyVersion(version.canonicalJson)
  if (stored.schemaVersion === MEASUREMENT_PLAN_V2_SCHEMA_VERSION) {
    return measurementStampV2(stored, version.id, params)
  }
  const plan: MeasurementPlan = stored
  const providers = providerRoster(tx, params)
  const models = effectiveModels(tx, params, providers)
  if (providers.length === 0) {
    throw validationError(
      'No provider is configured for this project and none is available on this instance, so a plan run has nothing to measure with. '
      + 'Add a provider key, or set the providers on the project.',
    )
  }
  // Engine and model identity is recorded, never refused. A different roster or
  // a re-pointed model is a new comparable series under the same revision.
  const identity = buildMeasurementExecutionIdentity({ providers, models }, executionIdentityChecksum({ providers, models }))

  // A slice, however it was chosen. Naming questions is the same kind of
  // subset as naming groups or targets, and gets the same treatment: probe,
  // recorded scope, no basket stamp.
  const resolution = sliceFor(plan, params)
  if (!resolution) {
    // A full sweep's manifest is the plan's own expectation, built by the same
    // function the report reads it back with.
    //
    // The one thing a run cannot change is HOW MANY snapshots each question
    // expects: that number is the denominator every rate in the revision is
    // taken over, and it is part of what the revision's checksum covers.
    // Swapping which engines answer is a new series (recorded above, never
    // refused) because the count is unchanged; running a different NUMBER of
    // engines describes a different measurement, and republishing is the
    // action that actually changes it.
    try {
      const base = buildMeasurementRunManifest(plan, providers)
      const manifest = buildMeasurementRunManifestV1({
        expectedSlots: base.expectedSlots.map(slot => ({
          ...slot,
          ...(models[slot.provider] ? { requestedModel: models[slot.provider]! } : {}),
        })),
      })
      return { versionId: version.id, manifest, scope: null, identity }
    } catch (error) {
      if (error instanceof MeasurementRunScopeError) throw error
      const expected = plan.executionNodes[0]?.expectedSnapshots ?? 0
      throw validationError(
        `The published measurement plan expects ${expected} answer(s) per question, but this run would produce ${providers.length}`
        + `${providers.length ? ` (${providers.join(', ')})` : ''}. `
        + 'That number is the denominator of every rate in this revision, so it cannot change inside one. '
        + `Run with ${expected} provider(s), or publish the plan again with the ${providers.length} you want — `
        + 'publishing records the new count and gives you a revision that describes it.',
      )
    }
  }

  // A spot check's expectation is its own slice, so the manifest is built
  // directly rather than from the plan: it deliberately does not satisfy every
  // frozen node, which is why a scoped run never displaces a sweep.
  return {
    versionId: version.id,
    manifest: buildMeasurementRunManifestV1({
      expectedSlots: expectedSlotsFor(resolution.executionNodes, providers, models),
    }),
    scope: resolution.scope,
    identity,
  }
}

/**
 * A slice that names something the pinned revision does not contain is a
 * caller mistake, not a server fault: answer with the key they typed.
 */
function asScopeValidation<T>(resolve: () => T): T {
  try {
    return resolve()
  } catch (error) {
    if (error instanceof MeasurementRunScopeError) {
      throw validationError(error.message, {
        unknownGroups: error.unknownGroups,
        unknownTargets: error.unknownTargets,
        unknownQueries: error.unknownQueries,
        emptyTargets: error.emptyTargets,
      })
    }
    throw error
  }
}

/** The slice this run measures, or null when it measures the whole plan. */
function sliceFor(plan: MeasurementPlan, params: QueueRunParams) {
  if (!measurementRunScopeIsEmpty(params.measurementScope)) {
    return asScopeValidation(() => resolveMeasurementRunScope(plan, params.measurementScope!))
  }
  if (params.queries?.length) {
    return asScopeValidation(() => resolveMeasurementRunQueryScope(plan, params.queries!))
  }
  return null
}

/**
 * Run the plan checks a queue would run, without queueing anything.
 *
 * The batch trigger needs to know whether every project can be measured before
 * it dispatches the first one — a 400 raised halfway through a batch would be
 * describing work that had already been sent to providers.
 */
export function assertMeasurementRunStampable(db: DatabaseClient, params: QueueRunParams): void {
  const stamp = measurementStamp(db, params)
  const dispatch = resolveQueueDispatch(db, params, stamp)
  if (params.dispatchMode === ProviderDispatchModes.batch) {
    const admission = queueProviderAdmission(db, params, stamp, params.createdAt ?? new Date().toISOString())
    dispatchAfterProviderAdmission(params, dispatch, admission)
  }
}

/**
 * Which of this run's providers go to a batch API, decided from what the run
 * will be stored as: its stamp (plan or planless, full sweep or slice) and the
 * trigger it is written with. A batch request no provider can honour is a
 * caller mistake, refused before anything is written.
 */
function resolveQueueDispatch(tx: DatabaseClient, params: QueueRunParams, stamp: MeasurementStamp | null): RunDispatchResolution {
  const trigger = stamp?.scope ? RunTriggers.probe : params.trigger ?? RunTriggers.manual
  const projectModes = params.dispatchMode == null && params.trigger === RunTriggers.scheduled
    ? tx.select({ modes: projects.providerDispatchModes }).from(projects)
      .where(eq(projects.id, params.projectId)).get()?.modes ?? {}
    : {}
  // Nobody asked: the common case reads nothing more.
  const asked = params.dispatchMode === ProviderDispatchModes.batch
    || Object.values(projectModes).includes(ProviderDispatchModes.batch)
  if (!asked) return { modes: {}, ineligible: {}, requested: [] }

  const expectedSlots = stamp?.manifest.expectedSlots ?? null
  const resolution = resolveRunDispatchModes({
    trigger,
    requestedMode: params.dispatchMode ?? null,
    projectModes,
    providers: expectedSlots ? expectedSlots.map(slot => slot.provider) : providerRoster(tx, params),
    expectedSlots,
    scoped: params.queries != null || stamp?.scope != null,
    batchEligibleProviders: params.batchEligibleProviders ?? null,
  })
  if (params.dispatchMode === ProviderDispatchModes.batch && Object.keys(resolution.modes).length === 0) {
    throw validationError(batchDispatchRefusalMessage(resolution.ineligible), { ineligible: resolution.ineligible })
  }
  return resolution
}

/** An explicit batch request still needs a called provider that can batch after account holds. */
function dispatchAfterProviderAdmission(
  params: QueueRunParams,
  dispatch: RunDispatchResolution,
  admission: ProviderAccountAdmission,
): RunDispatchResolution {
  // A completely held roster is refused with PROVIDERS_FAILING instead.
  if (admission.refused) return dispatch
  const skippedProviders = admission.skipped
  const modes = Object.fromEntries(Object.entries(dispatch.modes).filter(([provider]) => !(provider in skippedProviders)))
  if (params.dispatchMode === ProviderDispatchModes.batch && Object.keys(modes).length === 0) {
    throw validationError(
      `${batchDispatchRefusalMessage(dispatch.ineligible)} Held back after repeated account failures: ${Object.keys(skippedProviders).join(', ')}. `
        + 'Pass force to call those providers now.',
      { ineligible: dispatch.ineligible, skippedProviders },
    )
  }
  return { ...dispatch, modes }
}

/** The queue and its bulk pre-pass judge account holds against the same frozen roster. */
function queueProviderAdmission(
  db: DatabaseClient,
  params: QueueRunParams,
  stamp: MeasurementStamp | null,
  now: string,
): ProviderAccountAdmission {
  return (params.kind ?? RunKinds['answer-visibility']) === RunKinds['answer-visibility']
    ? providerAccountAdmission(db, {
        projectId: params.projectId,
        trigger: stamp?.scope ? RunTriggers.probe : params.trigger ?? RunTriggers.manual,
        force: params.force ?? false,
        now,
        providers: () => providersARunWouldCall(
          stamp?.identity.providers ?? providerRoster(db, params),
          params.runnableProviders,
        ),
      })
    : { skipped: {} }
}

/** Why a run was refused: the streaks it would have extended. */
export interface ProviderAccountFailures {
  /** How many runs in a row each provider failed this way (the threshold). */
  consecutiveRuns: number
  /** The newest run any of them failed in. */
  latestRunId: string
  /** When the oldest run of any of their streaks was created. */
  since: string
  /** When a run is next let through without `force`: the earliest provider's retry. */
  retryAfter: string
  /** Each provider this run would call, and how it failed in its newest failure. */
  providers: Record<string, ProviderErrorCode>
}

/**
 * The providers a run would actually call: its roster, less any this host
 * cannot run. The job runner drops those without recording an error, so they
 * never appear among a run's failures. Without a host roster, the whole list.
 */
export function providersARunWouldCall(
  roster: readonly string[],
  runnable: readonly string[] | null | undefined,
): string[] {
  const listed = normalizeProviders(roster)
  if (runnable == null) return listed
  const available = new Set(normalizeProviders(runnable))
  return listed.filter(provider => available.has(provider))
}

/** How many of a project's newest runs admission looks through for each provider's streak. */
const PROVIDER_ACCOUNT_LOOKBACK = PROVIDER_ACCOUNT_FAILURE_STREAK * 5

/**
 * Whether a settings save can have fixed an account failure: a new key
 * (`apiKeyRotated`), model or endpoint, or a provider configured for the
 * first time. A quota-only edit cannot, so it does not restart the count.
 */
function providerSettingsChangeCouldFix(action: string, diff: string | null): boolean {
  if (action === 'provider.created') return true
  try {
    const parsed = JSON.parse(diff ?? 'null') as {
      apiKeyRotated?: boolean
      before?: { configured?: boolean; model?: string | null; baseUrl?: string | null } | null
      after?: { configured?: boolean; model?: string | null; baseUrl?: string | null } | null
    } | null
    if (!parsed) return false
    if (parsed.apiKeyRotated) return true
    const before = parsed.before ?? {}
    const after = parsed.after ?? {}
    return before.configured !== after.configured || before.model !== after.model || before.baseUrl !== after.baseUrl
  } catch {
    return false
  }
}

/**
 * The providers among `providers()` that are held back because they keep
 * failing on their accounts (a rejected key, denied access, or no credit):
 * each failed that way in every one of its last
 * `PROVIDER_ACCOUNT_FAILURE_STREAK` runs that called it.
 *
 * Each provider's streak is its own. Walking the project's newest runs (probes
 * included), a run that lists the provider with an account code extends its
 * streak; one that lists it with any other code, or in which it answered, ends
 * it; any other run did not call it and is skipped. So a narrower run
 * (`--provider openai`, a probe) neither resets nor fakes another provider's
 * streak. A run that skipped the provider did not call it either, but it
 * vouches for the streak that held it back then (`skippedProviders`), so the
 * walk stops there instead of reading back through every run since.
 *
 * One install ran 7,000 runs over four months against dead keys. The hold
 * backs off rather than stopping for good: `PROVIDER_ACCOUNT_RETRY_HOURS`
 * after the provider's newest failure finished it is called again, so a fix
 * made anywhere (a top-up in the provider console, an edited config.yaml, an
 * env var) is picked up within a day, and a provider still broken costs one
 * failed call a day instead of one per schedule tick. Saving its settings with
 * a new key, model or endpoint releases it at once. A probe that succeeds ends
 * its streak.
 *
 * An error stored without a `code` (written before per-provider codes) ends
 * the streak, so old history never holds anything back.
 */
export function heldProviderAccounts(
  db: Pick<DatabaseClient, 'select'>,
  params: {
    projectId: string
    /** The time the hold is judged at: a new run's creation time, or now for a read. */
    now: string
    /** Resolved only once a streak is possible, so an ordinary queue reads one page of the runs index. */
    providers: () => readonly string[]
  },
): Map<string, ProviderAccountStreak> {
  const held = new Map<string, ProviderAccountStreak>()
  const recent = db.select({
    id: runs.id,
    status: runs.status,
    error: runs.error,
    createdAt: runs.createdAt,
    finishedAt: runs.finishedAt,
    skippedProviders: runs.skippedProviders,
  })
    .from(runs)
    .where(and(
      eq(runs.projectId, params.projectId),
      eq(runs.kind, RunKinds['answer-visibility']),
      inArray(runs.status, [RunStatuses.completed, RunStatuses.partial, RunStatuses.failed, RunStatuses.cancelled]),
    ))
    // `id` breaks the tie between an all-locations fan-out's siblings, which
    // share one creation time.
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(PROVIDER_ACCOUNT_LOOKBACK)
    .all()
    .map(run => ({ ...run, providers: parseRunError(run.error)?.providers ?? {} }))
  // No provider can be held without that many runs carrying an account
  // failure, or a run that skipped it vouching for its streak.
  const entries = recent.flatMap(run => Object.values(run.providers))
  const withAccountFailure = recent.filter(run =>
    Object.values(run.providers).some(entry => !entry.skipped && isProviderAccountFailure(entry.code)))
  if (withAccountFailure.length < PROVIDER_ACCOUNT_FAILURE_STREAK && !entries.some(entry => entry.skipped)) return held

  const calling = normalizeProviders(params.providers())
  if (calling.length === 0) return held

  type RecentRun = typeof recent[number]
  const answered = (runId: string, provider: string) => db.select({ id: querySnapshots.id }).from(querySnapshots)
    .where(and(eq(querySnapshots.runId, runId), eq(querySnapshots.provider, provider)))
    .limit(1)
    .get() !== undefined
  const finished = (run: RecentRun) => Date.parse(run.finishedAt ?? run.createdAt)
  const now = Date.parse(params.now)

  for (const provider of calling) {
    let count = 0
    let newest: RecentRun | null = null
    let oldest: RecentRun | null = null
    let code: ProviderErrorCode | null = null
    let vouched: ProviderAccountStreak | null = null
    let ended = false
    for (const run of recent) {
      const entry = run.providers[provider]
      if (!entry) {
        // A failed run lists every provider it called. A completed, partial or
        // cancelled one lists only failures (or nothing), so this provider
        // either answered, which ends its streak, or was not called.
        if (run.status !== RunStatuses.failed && answered(run.id, provider)) {
          ended = true
          break
        }
        continue
      }
      if (entry.skipped) {
        // Not called. The streak that held it back then is on the run; an
        // entry without one (never written so) is a run that did not call it.
        vouched = run.skippedProviders?.[provider] ?? null
        if (vouched) break
        continue
      }
      if (!isProviderAccountFailure(entry.code)) {
        ended = true
        break
      }
      newest ??= run
      code ??= entry.code!
      oldest = run
      count += 1
      if (count === PROVIDER_ACCOUNT_FAILURE_STREAK) break
    }
    if (ended) continue
    if (count < PROVIDER_ACCOUNT_FAILURE_STREAK && !vouched) continue

    // From its newest real failure; a provider skipped ever since keeps the
    // retry time of the streak that skipped it.
    const retryAfterMs = newest
      ? finished(newest) + PROVIDER_ACCOUNT_RETRY_HOURS * 3_600_000
      : Date.parse(vouched!.retryAfter)
    if (!(now < retryAfterMs)) continue
    held.set(provider, {
      code: code ?? vouched!.code,
      consecutiveRuns: PROVIDER_ACCOUNT_FAILURE_STREAK,
      // A vouched streak began before the runs read here.
      since: vouched ? vouched.since : oldest!.createdAt,
      latestRunId: newest?.id ?? vouched!.latestRunId,
      retryAfter: new Date(retryAfterMs).toISOString(),
    })
  }
  if (held.size === 0) return held

  const since = [...held.values()].map(streak => streak.since).sort()[0]!
  const settingsChanges = db.select({ entityId: auditLog.entityId, action: auditLog.action, diff: auditLog.diff, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'provider'), inArray(auditLog.entityId, [...held.keys()]), gt(auditLog.createdAt, since)))
    .all()
  for (const change of settingsChanges) {
    const streak = held.get(change.entityId ?? '')
    if (streak && change.createdAt > streak.since && providerSettingsChangeCouldFix(change.action, change.diff)) {
      held.delete(change.entityId!)
    }
  }
  return held
}

/** The refusal of a run whose providers are all held back. */
function providerAccountFailures(held: ReadonlyMap<string, ProviderAccountStreak>): ProviderAccountFailures {
  const streaks = [...held.values()]
  const newest = [...streaks].sort((a, b) => b.retryAfter.localeCompare(a.retryAfter))[0]!
  return {
    consecutiveRuns: PROVIDER_ACCOUNT_FAILURE_STREAK,
    latestRunId: newest.latestRunId,
    since: streaks.map(streak => streak.since).sort()[0]!,
    // The first provider called again lets a run through.
    retryAfter: streaks.map(streak => streak.retryAfter).sort()[0]!,
    providers: Object.fromEntries([...held].map(([provider, streak]) => [provider, streak.code])),
  }
}

/** What admission does about a new run's providers that keep failing on their accounts. */
export type ProviderAccountAdmission =
  | { refused: ProviderAccountFailures; skipped?: undefined }
  | { refused?: undefined; skipped: Record<string, ProviderAccountStreak> }

/**
 * Admission for a new answer-visibility run against its providers' account
 * failures (`heldProviderAccounts`). When every provider it would call is
 * held back, it is refused: it could only fail the way the project's runs
 * have been failing. Otherwise the held ones are skipped: the run calls the
 * rest, and stores each skip on the run and, once it finishes, in its error.
 *
 * A probe is never held back (it is how an operator checks a fix), and
 * neither is a `force` run.
 */
export function providerAccountAdmission(
  db: Pick<DatabaseClient, 'select'>,
  params: {
    projectId: string
    trigger: string
    force: boolean
    /** The new run's creation time, which the retry interval is measured to. */
    now: string
    providers: () => readonly string[]
  },
): ProviderAccountAdmission {
  if (params.force || params.trigger === RunTriggers.probe) return { skipped: {} }
  let calling: string[] | null = null
  const providers = () => (calling ??= normalizeProviders(params.providers()))
  const held = heldProviderAccounts(db, { projectId: params.projectId, now: params.now, providers })
  if (held.size === 0) return { skipped: {} }
  if (providers().every(provider => held.has(provider))) return { refused: providerAccountFailures(held) }
  return { skipped: Object.fromEntries(held) }
}

/**
 * The providers a full sweep of this project calls, as the scheduler starts
 * one: a v2 plan's frozen engines, else the schedule's providers when it names
 * some, else the project's own list, else everything this host can run, less
 * what this host cannot run.
 */
function sweepProviders(
  db: Pick<DatabaseClient, 'select'>,
  projectId: string,
  runnable: readonly string[] | null | undefined,
  selection: typeof RunTriggers.manual | typeof RunTriggers.scheduled,
): string[] {
  const planProviders = activeRevisionProviders(db, projectId)
  if (planProviders.length > 0) return providersARunWouldCall(planProviders, runnable)
  const schedule = db.select({ providers: schedules.providers, enabled: schedules.enabled }).from(schedules)
    .where(and(eq(schedules.projectId, projectId), eq(schedules.kind, RunKinds['answer-visibility'])))
    .get()
  const project = db.select({ providers: projects.providers }).from(projects).where(eq(projects.id, projectId)).get()
  return providersARunWouldCall(resolveRunProviderSelection({
    requestedProviders: selection === RunTriggers.scheduled && schedule?.enabled ? schedule.providers : null,
    projectProviders: project?.providers ?? [],
    runnableProviders: runnable,
  }), runnable)
}

/**
 * Whether the project's next full sweep would be admitted, and which of its
 * providers it would skip (`RunAdmissionDto`). The read side of
 * `providerAccountAdmission`, from the same streaks, so what a status read
 * says is what the next scheduled or manual sweep meets.
 */
export function runAdmissionState(
  db: Pick<DatabaseClient, 'select'>,
  params: {
    projectId: string
    now: string
    runnableProviders?: readonly string[] | null
    /** Scheduling remains the default; a manual preview uses the unfiltered manual launch's roster. */
    selection?: typeof RunTriggers.manual | typeof RunTriggers.scheduled
  },
): RunAdmissionDto {
  let calling: string[] | null = null
  const providers = () => (calling ??= sweepProviders(db, params.projectId, params.runnableProviders, params.selection ?? RunTriggers.scheduled))
  const held = heldProviderAccounts(db, { projectId: params.projectId, now: params.now, providers })
  const refused = held.size > 0 && providers().every(provider => held.has(provider))
  return {
    refused,
    retryAfter: refused ? providerAccountFailures(held).retryAfter : null,
    providers: Object.fromEntries(held),
  }
}

/** The refusal an operator sees, with what to fix and how to go ahead anyway. */
export function providersFailingError(projectName: string, failures: ProviderAccountFailures): AppError {
  const named = Object.entries(failures.providers).map(([provider, code]) => `${provider} (${code})`).join(', ')
  return providersFailing(
    `Not starting a run for '${projectName}': every provider it would call failed on its account (a rejected key, `
      + `denied access, or no credit left) in each of its last ${failures.consecutiveRuns} runs: ${named}. `
      + 'Fix it in the provider\'s console or settings. Saving a new key, model or endpoint for the provider '
      + '(canonry settings provider <name>) lets the next run through; otherwise one run is let through after '
      + `${failures.retryAfter}. Pass force (canonry run --force) to run now.`,
    { projectName, ...failures },
  )
}

/** Audit action of a scheduled sweep skipped because every provider keeps failing on its account. */
const RUN_REFUSED_AUDIT_ACTION = 'run.refused'

/**
 * Record a refused run in the audit log, once per refusal: the first refused
 * slot after the newest failure (`latestRunId`) writes it, and later slots
 * until a run is let through would repeat it word for word. Returns whether it
 * wrote one.
 */
function recordRunRefusal(
  db: DatabaseClient,
  projectId: string,
  failures: ProviderAccountFailures,
  audit: NonNullable<QueueRunParams['auditRefusal']>,
): boolean {
  const last = db.select({ diff: auditLog.diff }).from(auditLog)
    .where(and(eq(auditLog.projectId, projectId), eq(auditLog.action, RUN_REFUSED_AUDIT_ACTION)))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(1)
    .get()
  if (last && parseJsonColumn<{ latestRunId?: unknown }>(last.diff, {}).latestRunId === failures.latestRunId) return false
  writeAuditLog(db, {
    projectId,
    actor: audit.actor,
    action: RUN_REFUSED_AUDIT_ACTION,
    entityType: audit.entityType,
    entityId: audit.entityId,
    diff: { code: 'PROVIDERS_FAILING', ...failures },
  })
  return true
}

export type QueueRunResult =
  | { conflict: true; activeRunId: string; scheduleClaimed?: false }
  | {
      conflict: false
      refused: ProviderAccountFailures
      /** Whether this refusal wrote the `run.refused` audit row (`auditRefusal`); false when an earlier slot of it did. */
      refusalRecorded: boolean
    }
  | {
      conflict: false
      refused?: undefined
      runId: string
      /**
       * What was frozen onto the run, and which providers that asked to batch
       * run sync instead (a scheduled run logs these; nothing refuses them).
       */
      dispatch: RunDispatchResolution
      /** Providers the run does not call because each keeps failing on its account. */
      skippedProviders: Record<string, ProviderAccountStreak>
    }

/** Queue only when this project has no active run of the requested kind. */
export function queueRunIfProjectIdle(db: DatabaseClient, params: QueueRunParams): QueueRunResult {
  const createdAt = params.createdAt ?? new Date().toISOString()
  const kind = params.kind ?? 'answer-visibility'
  const trigger = params.trigger ?? 'manual'
  const runId = crypto.randomUUID()

  if (params.scheduleClaim && trigger !== RunTriggers.scheduled) {
    throw new Error('Schedule claims require a scheduled run trigger')
  }

  return db.transaction((tx) => {
    const activeRun = () => tx
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.projectId, params.projectId),
          eq(runs.kind, kind),
          or(eq(runs.status, 'queued'), eq(runs.status, 'running')),
        ),
      )
      .get()

    // Preserve ordinary manual/scheduled admission behavior: an active run
    // returns before any plan work. Calendar rows compile first so an invalid
    // plan cannot consume their persisted occurrence claim.
    if (!params.scheduleClaim) {
      const current = activeRun()
      if (current) return { conflict: true, activeRunId: current.id } as const
    }

    const stamp = measurementStamp(tx as unknown as DatabaseClient, params)
    // Frozen now, never re-read at execution: a queued run cannot change mode
    // because the project preference or the instance config moved.
    const dispatch = resolveQueueDispatch(tx as unknown as DatabaseClient, params, stamp)

    if (params.scheduleClaim) {
      const claim = tx.update(schedules).set({
        nextRunAt: params.scheduleClaim.nextRunAt,
        updatedAt: nextScheduleUpdatedAt(params.scheduleClaim.expectedUpdatedAt),
      }).where(and(
        eq(schedules.id, params.scheduleClaim.scheduleId),
        eq(schedules.projectId, params.projectId),
        eq(schedules.kind, kind),
        eq(schedules.enabled, true),
        eq(schedules.nextRunAt, params.scheduleClaim.dueAt),
        eq(schedules.updatedAt, params.scheduleClaim.expectedUpdatedAt),
      )).run()
      if (claim.changes !== 1) {
        return { conflict: true, activeRunId: params.scheduleClaim.scheduleId, scheduleClaimed: false } as const
      }
    }

    const current = activeRun()
    if (current) return { conflict: true, activeRunId: current.id } as const

    // After the schedule claim on purpose: a refused calendar slot is spent,
    // not retried every tick while the keys stay broken.
    const admission = queueProviderAdmission(tx as unknown as DatabaseClient, params, stamp, createdAt)
    if (admission.refused) {
      const refusalRecorded = params.auditRefusal
        ? recordRunRefusal(tx as unknown as DatabaseClient, params.projectId, admission.refused, params.auditRefusal)
        : false
      return { conflict: false, refused: admission.refused, refusalRecorded } as const
    }
    const skippedProviders = admission.skipped
    // A provider the run skips is not dispatched in any mode.
    const admittedDispatch = dispatchAfterProviderAdmission(params, dispatch, admission)
    const dispatchModes = admittedDispatch.modes

    // Stamp the query set this run is about to measure, so analytics can compare
    // like-for-like later without inferring membership from row timestamps.
    //
    // Only a FULL sweep is stamped. A scoped run (`queries` non-null, or a
    // measurement scope naming groups/targets) deliberately measures a subset,
    // and labelling it with the full basket would let a 3-query spot check land
    // in a bucket as though all 16 had been measured — the same denominator
    // error the basket exists to prevent, arriving by a different route. Scoped
    // runs keep a null revision and analytics treats them as unversioned.
    const scoped = params.queries != null || stamp?.scope != null
    const basket = scoped
      ? null
      : ensureCurrentQueryBasketRevision(tx as unknown as DatabaseClient, params.projectId, createdAt)

    tx.insert(runs).values({
      id: runId,
      projectId: params.projectId,
      kind,
      // A slice of a plan is exactly what a probe is for: it exercises part of
      // the measurement set to check something, and must never stand in for a
      // sweep. Every dashboard, analytics and report read already excludes
      // probes, so this is the one flag that keeps a spot check out of numbers
      // that claim to describe the whole plan.
      trigger: stamp?.scope ? RunTriggers.probe : trigger,
      status: 'queued',
      // A plan sets the location per question, so one label on the run would
      // describe only some of its rows. Nothing may read a single location off
      // a run whose measurements span several.
      location: stamp ? null : params.location ?? null,
      queries: params.queries ?? null,
      queryBasketRevision: basket?.revision ?? null,
      measurementPlanVersionId: stamp?.versionId ?? null,
      measurementManifest: stamp?.manifest ?? null,
      measurementScope: stamp?.scope ?? null,
      measurementExecutionIdentity: stamp?.identity ?? null,
      providerDispatchModes: Object.keys(dispatchModes).length > 0 ? dispatchModes : null,
      skippedProviders: Object.keys(skippedProviders).length > 0 ? skippedProviders : null,
      createdAt,
    }).run()

    return { conflict: false, runId, dispatch: admittedDispatch, skippedProviders } as const
  })
}
