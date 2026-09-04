import crypto from 'node:crypto'
import { and, eq, or } from 'drizzle-orm'
import {
  buildMeasurementExecutionIdentity,
  buildMeasurementRunManifestV1,
  canonicalMeasurementExecutionIdentityJson,
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION,
  MeasurementRunScopeError,
  measurementRunScopeIsEmpty,
  measurementRunScopeSchema,
  normalizeMeasurementExecutionQueryText,
  parseStoredMeasurementPlanAnyVersion,
  RunTriggers,
  resolveMeasurementRunQueryScope,
  resolveMeasurementRunScope,
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
} from '@ainyc/canonry-contracts'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { measurementPlans, measurementPlanVersions, projects, runs } from '@ainyc/canonry-db'
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
    if (model) resolved[provider] = model
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
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
    models: Object.fromEntries([...models].flatMap(([provider, model]) => model ? [[provider, model] as const] : [])),
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

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText)
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
  measurementStamp(db, params)
}

export type QueueRunResult =
  | { conflict: true; activeRunId: string }
  | { conflict: false; runId: string }

export function queueRunIfProjectIdle(db: DatabaseClient, params: QueueRunParams): QueueRunResult {
  const createdAt = params.createdAt ?? new Date().toISOString()
  const kind = params.kind ?? 'answer-visibility'
  const trigger = params.trigger ?? 'manual'
  const runId = crypto.randomUUID()

  return db.transaction((tx) => {
    const activeRun = tx
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.projectId, params.projectId),
          or(eq(runs.status, 'queued'), eq(runs.status, 'running')),
        ),
      )
      .get()

    if (activeRun) {
      return { conflict: true, activeRunId: activeRun.id } as const
    }

    const stamp = measurementStamp(tx as unknown as DatabaseClient, params)

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
      createdAt,
    }).run()

    return { conflict: false, runId } as const
  })
}
