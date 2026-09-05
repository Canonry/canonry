/**
 * One reviewed control surface for simple query baskets and v2 portfolios.
 *
 * It deliberately never queues a run. A commit changes only durable authoring
 * state (queries and, for a portfolio, a new immutable plan revision); the
 * next project-wide sweep is the sole caller allowed to spend provider work.
 */

import crypto from 'node:crypto'
import { and, desc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  canonicalMeasurementPlanV2Json,
  compileQueryClassifier,
  effectiveBrandNames,
  measurementPlanV2ChecksumJson,
  measurementPlanV2Schema,
  measurementV2UsageEdgeKey,
  parseStoredMeasurementPlanAnyVersion,
  queryTrackingCommitRequestSchema,
  queryTrackingCommitResponseSchema,
  queryTrackingPreviewRequestSchema,
  queryTrackingPreviewResponseSchema,
  queryTrackingPreviewStale,
  queryTrackingProvenanceSchema,
  queryTrackingWorkspaceResponseSchema,
  RunKinds,
  RunStatuses,
  RunTriggers,
  simpleMeasurementDefinitionSchema,
  validationError,
  notFound,
  type LocationContext,
  type MeasurementPlanV2,
  type MeasurementV2ExecutionContext,
  type MeasurementV2UsageEdge,
  type QueryClass,
  type QueryTrackingAddition,
  type QueryTrackingAudience,
  type QueryTrackingChangeRow,
  type QueryTrackingDiff,
  type QueryTrackingMode,
  type QueryTrackingMutation,
  type QueryTrackingProvenance,
  type QueryTrackingTrackedRow,
  type QueryTrackingWorkload,
  type QueryTrackingWorkspaceResponse,
  type SimpleMeasurementDefinition,
} from '@ainyc/canonry-contracts'
import {
  discoveryProbes,
  discoverySessions,
  measurementPlanVersions,
  measurementPlans,
  measurementQueryTemplates,
  projects,
  queries,
  querySnapshots,
  researchRunQueries,
  researchRuns,
  runs,
  simpleMeasurementDefinitions,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { requireScope } from './auth.js'
import {
  compileMeasurementDraftAssignmentExecution,
  plansAreLabelOnlyVariants,
  proposeQueryClassForTarget,
} from './measurement-draft-compile.js'
import { activePlanVersionRow, actorFromRequest, canonicalJson, serializeActor, sha256Hex } from './measurement-draft-repo.js'
import {
  buildMeasurementPlanV2ReportInput,
  measurementRunExpectedSlots,
} from './measurement-report-adapter.js'
import { MEASUREMENT_PLAN_WRITE_SCOPE } from './measurement-plan.js'
import { preserveSnapshotQueryText, replaceProjectQueries } from './query-replace.js'
import { resolveRunProviderSelection } from './run-queue.js'
import type { ProviderSummaryEntry } from './settings.js'
import { auditFromRequest, resolveProject, writeAuditLog } from './helpers.js'

const SOURCE_LIMIT = 100
const MAX_REVIEW_AGE_MS = 15 * 60 * 1_000
const MAX_REVIEW_FUTURE_SKEW_MS = 60 * 1_000

type ProjectRow = typeof projects.$inferSelect
type QueryRow = typeof queries.$inferSelect
type DbLike = Pick<DatabaseClient, 'select' | 'insert' | 'update' | 'delete'>
/** The readiness check needs frozen slot provenance, never raw provider payloads. */
type ReadinessSnapshot = Pick<typeof querySnapshots.$inferSelect,
  | 'id'
  | 'runId'
  | 'queryId'
  | 'queryText'
  | 'provider'
  | 'model'
  | 'answerText'
  | 'citedUrls'
  | 'captureStatus'
  | 'location'
  | 'measurementExecutionId'
  | 'requestedContext'
  | 'supportedContext'
>

export interface QueryTrackingRoutesOptions {
  getRunnableProviderNames?: () => readonly string[]
  /** Raw registered model configuration, matching planless JobRunner dispatch. */
  providerSummary?: readonly ProviderSummaryEntry[]
}

interface ActivePortfolio {
  version: typeof measurementPlanVersions.$inferSelect
  plan: MeasurementPlanV2
}

interface WorkspaceState {
  project: ProjectRow
  mode: QueryTrackingMode
  active: ActivePortfolio | null
  queryRows: QueryRow[]
  workspaceVersion: string
}

interface ResolvedAudience {
  targetKeys: string[]
  groupKeys: string[]
  marketKeys: string[]
}

interface Candidate {
  state: WorkspaceState
  plan: MeasurementPlanV2 | null
  queryRows: Map<string, { id: string; query: string; provenance: string | null }>
  planChanged: boolean
  createdQueryIds: Set<string>
  removedQueryIds: Set<string>
  /** Assignment/scope removal while the query remains in the basket. */
  scopedRemovalQueryIds: Set<string>
  reusedQueryIds: Set<string>
  mutatedQueryIds: Set<string>
  diff: QueryTrackingDiff
  workload: QueryTrackingWorkload
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizeText(value: string): string {
  // Query-control identity matches the measurement readers: compatible
  // Unicode, collapsed internal whitespace, and a stable case fold.
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

function stableNewQueryId(projectId: string, normalizedText: string): string {
  return `qtc_${sha256Hex(`${projectId}\u0000${normalizedText}`).slice(0, 32)}`
}

function providerNames(project: ProjectRow, opts: QueryTrackingRoutesOptions): string[] {
  return resolveRunProviderSelection({
    projectProviders: project.providers,
    runnableProviders: opts.getRunnableProviderNames?.(),
  })
}

function modelMap(project: ProjectRow, providers: readonly string[]): Record<string, string> {
  const models: Record<string, string> = {}
  for (const provider of providers) {
    const model = project.providerModels[provider] ?? ''
    if (model.trim()) models[provider] = model
  }
  return models
}

/**
 * Planless dispatch uses the registered provider configuration directly: a
 * project override wins, while an unset registration remains null rather than
 * borrowing an adapter's effective/default model. Keep this separate from the
 * plan queue's effective-model identity.
 */
function simpleDispatchEngines(
  project: ProjectRow,
  opts: QueryTrackingRoutesOptions,
): Array<{ provider: string; requestedModel: string | null }> {
  const runnable = opts.getRunnableProviderNames?.()
  const selected = resolveRunProviderSelection({
    projectProviders: project.providers,
    runnableProviders: runnable,
  })
  const available = runnable === undefined
    ? null
    : new Set(runnable.map(provider => provider.trim().toLocaleLowerCase('en')).filter(Boolean))
  const summaries = new Map((opts.providerSummary ?? []).map(summary => [
    summary.name.trim().toLocaleLowerCase('en'),
    summary,
  ]))
  const overrides: Partial<Record<string, string>> = project.providerModels
  return selected
    .filter(provider => available === null || available.has(provider))
    .map(provider => ({
      provider,
      // `undefined` is materially different from an intentionally blank model
      // override/configuration, just as it is in JobRunner.
      requestedModel: overrides[provider] ?? summaries.get(provider)?.model ?? null,
    }))
    .sort((left, right) => compareText(left.provider, right.provider))
}

function simpleDefaultLocation(project: ProjectRow): LocationContext | null {
  if (!project.defaultLocation) return null
  return project.locations.find(location => location.label === project.defaultLocation) ?? null
}

function contextKey(context: MeasurementV2ExecutionContext): string {
  const location = context.location
    ? [context.location.label, context.location.city, context.location.region, context.location.country, context.location.timezone ?? ''].join('\u0000')
    : ''
  return canonicalJson({ providers: [...context.providers].sort(compareText), models: context.models, location })
}

function uniqueContexts(contexts: readonly MeasurementV2ExecutionContext[]): MeasurementV2ExecutionContext[] {
  const byKey = new Map<string, MeasurementV2ExecutionContext>()
  for (const context of contexts) byKey.set(contextKey(context), context)
  return [...byKey.values()].sort((left, right) => compareText(contextKey(left), contextKey(right)))
}

function defaultContexts(project: ProjectRow, opts: QueryTrackingRoutesOptions, mode: QueryTrackingMode): MeasurementV2ExecutionContext[] {
  const providers = providerNames(project, opts)
  if (providers.length === 0) return []
  const models = modelMap(project, providers)
  const locations = mode === 'advanced'
    ? (project.locations.length > 0 ? project.locations : [null])
    : [project.defaultLocation ? project.locations.find(location => location.label === project.defaultLocation) ?? null : null]
  return uniqueContexts(locations.map(location => ({ providers, models, location })))
}

function activePortfolio(db: DbLike, projectId: string): ActivePortfolio | null {
  const version = activePlanVersionRow(db, projectId)
  if (!version) return null
  const parsed = parseStoredMeasurementPlanAnyVersion(version.canonicalJson)
  if (parsed.schemaVersion !== 2) {
    throw validationError('Query tracking requires a schema-v2 measurement plan. Republish setup before editing portfolio queries.')
  }
  return { version, plan: parsed }
}

function workspaceFingerprint(project: ProjectRow, active: ActivePortfolio | null, queryRows: readonly QueryRow[]): string {
  return `qtw_${sha256Hex(canonicalJson({
    project: {
      canonicalDomain: project.canonicalDomain,
      ownedDomains: project.ownedDomains,
      displayName: project.displayName,
      aliases: project.aliases,
      providers: project.providers,
      providerModels: project.providerModels,
      locations: project.locations,
      defaultLocation: project.defaultLocation,
    },
    active: active ? { id: active.version.id, revision: active.version.revision, compiledChecksum: active.version.compiledChecksum } : null,
    queries: queryRows.map(row => ({ id: row.id, query: row.query, provenance: row.provenance })).sort((left, right) => compareText(left.id, right.id)),
  }))}`
}

function readWorkspace(db: DbLike, project: ProjectRow): WorkspaceState {
  const active = activePortfolio(db, project.id)
  const queryRows = db.select().from(queries).where(eq(queries.projectId, project.id)).all()
  return {
    project,
    mode: active ? 'advanced' : 'simple',
    active,
    queryRows,
    workspaceVersion: workspaceFingerprint(project, active, queryRows),
  }
}

function activeDto(active: ActivePortfolio | null) {
  return active ? { revision: active.version.revision, compiledChecksum: active.version.compiledChecksum! } : null
}

function provenanceFromPlan(value: MeasurementPlanV2['querySnapshots'][number]['provenance'] | undefined): QueryTrackingProvenance | null {
  const parsed = queryTrackingProvenanceSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function serializeQueryProvenance(value: QueryTrackingProvenance): string {
  return `query-tracking/v1:${canonicalJson(value)}`
}

function parseQueryProvenance(value: string | null): QueryTrackingProvenance | null {
  if (!value?.startsWith('query-tracking/v1:')) return null
  try {
    const parsed = queryTrackingProvenanceSchema.safeParse(JSON.parse(value.slice('query-tracking/v1:'.length)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function simpleExecutionSignature(input: {
  identity: {
    displayName: string
    aliases: readonly string[]
    canonicalDomain: string
    ownedDomains: readonly string[]
  }
  country: string
  language: string
  location: LocationContext | null
  engines: readonly { provider: string; requestedModel: string | null }[]
}): string {
  return canonicalJson({
    identity: {
      displayName: input.identity.displayName,
      aliases: [...input.identity.aliases].sort(compareText),
      canonicalDomain: input.identity.canonicalDomain,
      ownedDomains: [...input.identity.ownedDomains].sort(compareText),
    },
    country: input.country,
    language: input.language,
    location: input.location,
    engines: input.engines.map(engine => ({
      provider: engine.provider.trim().toLocaleLowerCase('en'),
      requestedModel: engine.requestedModel,
    })).sort((left, right) => compareText(left.provider, right.provider)),
  })
}

function currentSimpleExecutionSignature(project: ProjectRow, opts: QueryTrackingRoutesOptions): string {
  return simpleExecutionSignature({
    identity: {
      displayName: project.displayName,
      aliases: project.aliases,
      canonicalDomain: project.canonicalDomain,
      ownedDomains: project.ownedDomains,
    },
    country: project.country,
    language: project.language,
    location: simpleDefaultLocation(project),
    engines: simpleDispatchEngines(project, opts),
  })
}

function frozenSimpleExecutionSignature(definition: SimpleMeasurementDefinition): string {
  return simpleExecutionSignature(definition)
}

function simpleDefinitionMatchesCurrentQuery(
  frozen: SimpleMeasurementDefinition['queries'][number],
  row: QueryRow,
  frozenClassifier: ReturnType<typeof compileQueryClassifier>,
  currentClassifier: ReturnType<typeof compileQueryClassifier>,
): boolean {
  if (frozen.queryText !== row.query) return false
  if (frozen.queryClass !== (frozenClassifier?.classify(frozen.queryText) ?? null)) return false
  return frozen.queryClass === (currentClassifier?.classify(row.query) ?? null)
}

type SimpleReadinessSnapshot = Pick<typeof querySnapshots.$inferSelect,
  | 'runId'
  | 'queryId'
  | 'queryText'
  | 'provider'
>

/**
 * A simple run has no manifest slot IDs. Its frozen definition is therefore
 * the only execution authority: one exact answer for every frozen provider
 * proves the selected query was swept. Snapshot model/context fields are
 * response data in this lane, not requested-input evidence.
 */
function simpleRunCoversQuery(
  definition: SimpleMeasurementDefinition,
  frozenQuery: SimpleMeasurementDefinition['queries'][number],
  snapshots: readonly SimpleReadinessSnapshot[],
): boolean {
  const expected = new Set(definition.engines.map(engine => engine.provider.trim().toLocaleLowerCase('en')))
  const covered = new Map<string, number>()
  for (const snapshot of snapshots) {
    if (snapshot.queryId !== frozenQuery.queryId || snapshot.queryText !== frozenQuery.queryText) continue
    const provider = snapshot.provider.trim().toLocaleLowerCase('en')
    if (!expected.has(provider)) continue
    covered.set(provider, (covered.get(provider) ?? 0) + 1)
  }
  return [...expected].every(provider => covered.get(provider) === 1)
}

function simpleMeasuredAtByQuery(
  db: DbLike,
  project: ProjectRow,
  queryRows: readonly QueryRow[],
  opts: QueryTrackingRoutesOptions,
): Map<string, string> {
  const eligibleRuns = db.select({
    id: runs.id,
    finishedAt: runs.finishedAt,
    createdAt: runs.createdAt,
  }).from(runs).where(and(
    eq(runs.projectId, project.id),
    eq(runs.kind, RunKinds['answer-visibility']),
    inArray(runs.status, [RunStatuses.completed, RunStatuses.partial]),
    ne(runs.trigger, RunTriggers.probe),
    isNull(runs.measurementScope),
    isNull(runs.measurementPlanVersionId),
  )).orderBy(desc(runs.createdAt), desc(runs.id)).limit(SOURCE_LIMIT).all()
  if (eligibleRuns.length === 0) return new Map()

  // Missing (legacy) or malformed sidecars are deliberately unknown, never
  // inferred from a mutable query id or current project configuration.
  const frozenByRun = new Map<string, SimpleMeasurementDefinition>()
  for (const row of db.select({
    runId: simpleMeasurementDefinitions.runId,
    definition: simpleMeasurementDefinitions.definition,
  }).from(simpleMeasurementDefinitions).where(and(
    eq(simpleMeasurementDefinitions.projectId, project.id),
    inArray(simpleMeasurementDefinitions.runId, eligibleRuns.map(run => run.id)),
  )).all()) {
    const parsed = simpleMeasurementDefinitionSchema.safeParse(row.definition)
    if (parsed.success) frozenByRun.set(row.runId, parsed.data)
  }
  if (frozenByRun.size === 0) return new Map()

  const snapshotsByRunQuery = new Map<string, Map<string, SimpleReadinessSnapshot[]>>()
  for (const snapshot of db.select({
    runId: querySnapshots.runId,
    queryId: querySnapshots.queryId,
    queryText: querySnapshots.queryText,
    provider: querySnapshots.provider,
  }).from(querySnapshots).where(inArray(querySnapshots.runId, [...frozenByRun.keys()])).all()) {
    if (!snapshot.queryId) continue
    const byQuery = snapshotsByRunQuery.get(snapshot.runId) ?? new Map<string, SimpleReadinessSnapshot[]>()
    const rows = byQuery.get(snapshot.queryId) ?? []
    rows.push(snapshot)
    byQuery.set(snapshot.queryId, rows)
    snapshotsByRunQuery.set(snapshot.runId, byQuery)
  }

  const currentById = new Map(queryRows.map(row => [row.id, row]))
  const currentExecution = currentSimpleExecutionSignature(project, opts)
  const currentClassifier = compileQueryClassifier(effectiveBrandNames(project))
  const measured = new Map<string, string>()
  for (const run of eligibleRuns) {
    const definition = frozenByRun.get(run.id)
    if (!definition) continue
    if (frozenSimpleExecutionSignature(definition) !== currentExecution) continue
    const stamp = run.finishedAt ?? run.createdAt
    const snapshotsByQuery = snapshotsByRunQuery.get(run.id)
    const frozenClassifier = compileQueryClassifier(effectiveBrandNames(definition.identity))
    for (const frozenQuery of definition.queries) {
      const current = currentById.get(frozenQuery.queryId)
      if (!current) continue
      if (!simpleDefinitionMatchesCurrentQuery(frozenQuery, current, frozenClassifier, currentClassifier)) continue
      if (!simpleRunCoversQuery(definition, frozenQuery, snapshotsByQuery?.get(frozenQuery.queryId) ?? [])) continue
      if ((measured.get(current.id) ?? '') < stamp) measured.set(current.id, stamp)
    }
  }
  return measured
}

function frozenAssignmentSignature(
  plan: MeasurementPlanV2,
  assignment: MeasurementPlanV2['assignments'][number],
): string {
  const node = plan.executionNodes.find(candidate => candidate.stableKey === assignment.executionNodeKey)
  const target = plan.targets.find(candidate => candidate.stableKey === assignment.targetKey)
  if (!node || !target) throw validationError('A frozen measurement assignment is missing its execution or target identity.')
  // This is comparison only: no current aliases/classes/contexts are applied to
  // an old snapshot. A material target, query, class, or context edit yields a
  // different signature and therefore awaits a fresh sweep.
  return canonicalJson({
    target: {
      stableKey: target.stableKey,
      aliases: target.aliases,
      urlMatchers: target.urlMatchers,
      mentionNotApplicable: target.mentionNotApplicable,
      discoveryIdentity: target.discoveryIdentity,
    },
    queryId: assignment.queryId,
    queryText: node.queryText,
    queryClass: assignment.queryClass,
    classificationSource: assignment.classificationSource,
    context: node.context,
  })
}

function assignmentSignaturesByQuery(plan: MeasurementPlanV2): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  for (const assignment of plan.assignments) {
    const signatures = result.get(assignment.queryId) ?? new Set<string>()
    signatures.add(frozenAssignmentSignature(plan, assignment))
    result.set(assignment.queryId, signatures)
  }
  return result
}

function assignmentSignaturesByExecution(plan: MeasurementPlanV2): Map<string, Array<{ queryId: string; signature: string }>> {
  const result = new Map<string, Array<{ queryId: string; signature: string }>>()
  for (const assignment of plan.assignments) {
    const entries = result.get(assignment.executionNodeKey) ?? []
    entries.push({ queryId: assignment.queryId, signature: frozenAssignmentSignature(plan, assignment) })
    result.set(assignment.executionNodeKey, entries)
  }
  return result
}

/**
 * The report adapter validates a persisted manifest against the frozen nodes,
 * then validates each snapshot against that manifest.  A v2 node additionally
 * froze its provider/model roster, so reject a syntactically valid manifest
 * that substitutes another engine or model before it can make an assignment
 * look swept.
 */
function manifestMatchesFrozenV2Execution(plan: MeasurementPlanV2, manifest: ReturnType<typeof measurementRunExpectedSlots>): boolean {
  const slotsByExecution = new Map<string, typeof manifest.expectedSlots>()
  for (const slot of manifest.expectedSlots) {
    const slots = slotsByExecution.get(slot.executionId) ?? []
    slots.push(slot)
    slotsByExecution.set(slot.executionId, slots)
  }
  for (const node of plan.executionNodes) {
    const slots = slotsByExecution.get(node.stableKey) ?? []
    const expectedProviders = node.context.providers.map(provider => provider.trim().toLocaleLowerCase('en'))
    if (slots.length !== expectedProviders.length || new Set(expectedProviders).size !== expectedProviders.length) return false
    for (const provider of expectedProviders) {
      const slot = slots.find(candidate => candidate.provider === provider)
      if (!slot) return false
      const model = node.context.models[provider]
      if (model !== slot.requestedModel) return false
    }
  }
  return slotsByExecution.size === plan.executionNodes.length
}

/** The report adapter only consults the selected fields below; disable its historical raw fallback for readiness. */
function readinessAdapterSnapshots(snapshots: readonly ReadinessSnapshot[]): readonly (typeof querySnapshots.$inferSelect)[] {
  return snapshots.map(snapshot => ({ ...snapshot, rawResponse: null }) as unknown as typeof querySnapshots.$inferSelect)
}

function measuredAtByQuery(db: DbLike, state: WorkspaceState, opts: QueryTrackingRoutesOptions): Map<string, string> {
  const { project, active } = state
  if (active === null) return simpleMeasuredAtByQuery(db, project, state.queryRows, opts)

  const activeSignatures = assignmentSignaturesByQuery(active.plan)
  if (activeSignatures.size === 0) return new Map()
  const eligibleRuns = db.select().from(runs).where(and(
    eq(runs.projectId, project.id),
    eq(runs.kind, RunKinds['answer-visibility']),
    inArray(runs.status, [RunStatuses.completed, RunStatuses.partial]),
    ne(runs.trigger, RunTriggers.probe),
    isNull(runs.measurementScope),
    isNotNull(runs.measurementPlanVersionId),
  )).orderBy(desc(runs.createdAt), desc(runs.id)).limit(SOURCE_LIMIT).all()
  if (eligibleRuns.length === 0) return new Map()

  const versionIds = unique(eligibleRuns.flatMap(run => run.measurementPlanVersionId ? [run.measurementPlanVersionId] : []))
  const versionPlans = new Map(db.select({
    id: measurementPlanVersions.id,
    revision: measurementPlanVersions.revision,
    canonicalJson: measurementPlanVersions.canonicalJson,
  }).from(measurementPlanVersions).where(and(
    eq(measurementPlanVersions.projectId, project.id),
    inArray(measurementPlanVersions.id, versionIds),
  )).all().flatMap(row => {
    const parsed = parseStoredMeasurementPlanAnyVersion(row.canonicalJson)
    return parsed.schemaVersion === 2 ? [[row.id, { revision: row.revision, plan: parsed }] as const] : []
  }))
  const signaturesByVersionExecution = new Map<string, Map<string, Array<{ queryId: string; signature: string }>>>()
  for (const [versionId, version] of versionPlans) {
    signaturesByVersionExecution.set(versionId, assignmentSignaturesByExecution(version.plan))
  }
  const measurements = new Map<string, Map<string, string>>()
  const mark = (queryId: string, signature: string, stamp: string) => {
    const signatures = activeSignatures.get(queryId)
    if (!signatures?.has(signature)) return
    const measured = measurements.get(queryId) ?? new Map<string, string>()
    if ((measured.get(signature) ?? '') < stamp) measured.set(signature, stamp)
    measurements.set(queryId, measured)
  }
  const snapshotsByRun = new Map<string, ReadinessSnapshot[]>()
  const snapshotRows = db.select({
    id: querySnapshots.id,
    runId: querySnapshots.runId,
    queryId: querySnapshots.queryId,
    queryText: querySnapshots.queryText,
    provider: querySnapshots.provider,
    model: querySnapshots.model,
    answerText: querySnapshots.answerText,
    citedUrls: querySnapshots.citedUrls,
    captureStatus: querySnapshots.captureStatus,
    location: querySnapshots.location,
    measurementExecutionId: querySnapshots.measurementExecutionId,
    requestedContext: querySnapshots.requestedContext,
    supportedContext: querySnapshots.supportedContext,
  }).from(querySnapshots).where(inArray(querySnapshots.runId, eligibleRuns.map(run => run.id))).all()
  for (const snapshot of snapshotRows) {
    const snapshots = snapshotsByRun.get(snapshot.runId) ?? []
    snapshots.push(snapshot)
    snapshotsByRun.set(snapshot.runId, snapshots)
  }
  for (const run of eligibleRuns) {
    const versionId = run.measurementPlanVersionId
    const version = versionId ? versionPlans.get(versionId) : undefined
    if (!version) continue
    let manifest: ReturnType<typeof measurementRunExpectedSlots>
    try {
      manifest = measurementRunExpectedSlots(run, version.plan)
    } catch {
      continue
    }
    if (!manifestMatchesFrozenV2Execution(version.plan, manifest)) continue

    // Use the exact same canonical reconstruction as reporting. It rejects a
    // stale execution id, query text, requested model, or location; ignored
    // contexts do not count as observations. A corrupt run simply supplies no
    // readiness evidence rather than widening an active assignment.
    let input: ReturnType<typeof buildMeasurementPlanV2ReportInput>['input']
    try {
      input = buildMeasurementPlanV2ReportInput(
        version.revision,
        version.plan,
        manifest,
        readinessAdapterSnapshots(snapshotsByRun.get(run.id) ?? []),
      ).input
    } catch {
      continue
    }
    const observedBySlot = new Map<string, number>()
    for (const observation of input.observations) {
      if (observation.executionId === null) continue
      const key = `slot:${observation.executionId}:${observation.provider}`
      observedBySlot.set(key, (observedBySlot.get(key) ?? 0) + 1)
    }
    const slotsByExecution = new Map<string, Array<(typeof input.expectedSlots)[number]>>()
    for (const slot of input.expectedSlots) {
      const slots = slotsByExecution.get(slot.executionId) ?? []
      slots.push(slot)
      slotsByExecution.set(slot.executionId, slots)
    }
    const stamp = run.finishedAt ?? run.createdAt
    if (!versionId) continue
    for (const [executionId, entries] of signaturesByVersionExecution.get(versionId) ?? []) {
      const slots = slotsByExecution.get(executionId) ?? []
      if (slots.length === 0 || slots.some(slot => observedBySlot.get(slot.id) !== 1)) continue
      for (const entry of entries) mark(entry.queryId, entry.signature, stamp)
    }
  }
  const result = new Map<string, string>()
  for (const [queryId, signatures] of activeSignatures) {
    const measured = measurements.get(queryId)
    if (!measured || [...signatures].some(signature => !measured.has(signature))) continue
    const latest = [...measured.values()].sort(compareText).at(-1)
    if (latest) result.set(queryId, latest)
  }
  return result
}

function marketKeysByEdge(plan: MeasurementPlanV2): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const scope of plan.reportingScopes ?? []) {
    for (const edge of scope.usageEdges) {
      const key = measurementV2UsageEdgeKey(edge)
      const keys = result.get(key)
      if (keys) keys.push(scope.stableKey)
      else result.set(key, [scope.stableKey])
    }
  }
  for (const keys of result.values()) keys.sort(compareText)
  return result
}

function trackedRows(
  db: DbLike,
  state: WorkspaceState,
  queryRows: ReadonlyMap<string, { id: string; query: string; provenance: string | null }>,
  plan: MeasurementPlanV2 | null,
  opts: QueryTrackingRoutesOptions,
): QueryTrackingTrackedRow[] {
  const measured = measuredAtByQuery(db, state, opts)
  if (!plan) {
    return [...queryRows.values()]
      .map(row => ({
        queryId: row.id,
        queryText: row.query,
        normalizedText: normalizeText(row.query),
        provenance: parseQueryProvenance(row.provenance),
        state: measured.has(row.id) ? 'tracked' as const : 'awaiting-sweep' as const,
        lastMeasuredAt: measured.get(row.id) ?? null,
        assignments: [],
      }))
      .sort((left, right) => compareText(left.normalizedText, right.normalizedText) || compareText(left.queryId, right.queryId))
  }

  const snapshots = new Map(plan.querySnapshots.map(snapshot => [snapshot.queryId, snapshot]))
  const allIds = unique([...queryRows.keys(), ...snapshots.keys()])
  const nodes = new Map(plan.executionNodes.map(node => [node.stableKey, node]))
  const groupsByTarget = new Map<string, string[]>()
  for (const group of plan.groups) {
    for (const targetKey of group.targetKeys) {
      const groups = groupsByTarget.get(targetKey)
      if (groups) groups.push(group.stableKey)
      else groupsByTarget.set(targetKey, [group.stableKey])
    }
  }
  const marketsByEdge = marketKeysByEdge(plan)
  return allIds.map(queryId => {
    const snapshot = snapshots.get(queryId)
    const row = queryRows.get(queryId)
    const queryText = snapshot?.queryText ?? row?.query
    if (queryText === undefined || !queryText.trim()) {
      throw validationError(`Tracked query "${queryId}" has no usable text.`)
    }
    const assignments = new Map<string, {
      targetKey: string
      groupKeys: string[]
      marketKeys: string[]
      queryClass: QueryClass | null
      classificationSource: 'frozen' | 'server' | 'operator'
      contexts: MeasurementV2ExecutionContext[]
    }>()
    for (const assignment of plan.assignments.filter(candidate => candidate.queryId === queryId)) {
      const node = nodes.get(assignment.executionNodeKey)
      if (!node) continue
      const existing = assignments.get(assignment.targetKey)
      const edgeKey = measurementV2UsageEdgeKey({
        executionNodeKey: assignment.executionNodeKey,
        targetKey: assignment.targetKey,
        queryId,
      })
      const source = assignment.classificationSource ?? 'frozen'
      if (existing) {
        existing.contexts.push(node.context)
        existing.marketKeys.push(...(marketsByEdge.get(edgeKey) ?? []))
      } else {
        assignments.set(assignment.targetKey, {
          targetKey: assignment.targetKey,
          groupKeys: [...(groupsByTarget.get(assignment.targetKey) ?? [])].sort(compareText),
          marketKeys: [...(marketsByEdge.get(edgeKey) ?? [])],
          queryClass: assignment.queryClass,
          classificationSource: source,
          contexts: [node.context],
        })
      }
    }
    return {
      queryId,
      queryText,
      normalizedText: normalizeText(queryText),
      provenance: snapshot ? provenanceFromPlan(snapshot.provenance) : parseQueryProvenance(row?.provenance ?? null),
      state: measured.has(queryId) ? 'tracked' as const : 'awaiting-sweep' as const,
      lastMeasuredAt: measured.get(queryId) ?? null,
      assignments: [...assignments.values()]
        .map(assignment => ({
          ...assignment,
          marketKeys: unique(assignment.marketKeys).sort(compareText),
          contexts: uniqueContexts(assignment.contexts),
        }))
        .sort((left, right) => compareText(left.targetKey, right.targetKey)),
    }
  }).sort((left, right) => compareText(left.normalizedText, right.normalizedText) || compareText(left.queryId, right.queryId))
}

function savedSources(db: DbLike, projectId: string) {
  const research = db.select({
    researchRunId: researchRuns.id,
    researchRunQueryId: researchRunQueries.id,
    queryText: researchRunQueries.queryText,
    createdAt: researchRunQueries.createdAt,
  }).from(researchRunQueries)
    .innerJoin(researchRuns, eq(researchRunQueries.researchRunId, researchRuns.id))
    .where(eq(researchRuns.projectId, projectId))
    .orderBy(desc(researchRunQueries.createdAt))
    .limit(SOURCE_LIMIT).all()
    .filter(row => row.queryText.trim().length > 0)
  const discovery = db.select({
    discoverySessionId: discoverySessions.id,
    discoveryProbeId: discoveryProbes.id,
    queryText: discoveryProbes.query,
    createdAt: discoveryProbes.createdAt,
  }).from(discoveryProbes)
    .innerJoin(discoverySessions, eq(discoveryProbes.sessionId, discoverySessions.id))
    .where(eq(discoverySessions.projectId, projectId))
    .orderBy(desc(discoveryProbes.createdAt))
    .limit(SOURCE_LIMIT).all()
    .filter(row => row.queryText.trim().length > 0)
  return { research, discovery }
}

function workspaceDto(db: DbLike, state: WorkspaceState, opts: QueryTrackingRoutesOptions): QueryTrackingWorkspaceResponse {
  const plan = state.active?.plan ?? null
  const rows = new Map(state.queryRows.map(row => [row.id, row]))
  return queryTrackingWorkspaceResponseSchema.parse({
    mode: state.mode,
    workspaceVersion: state.workspaceVersion,
    active: activeDto(state.active),
    defaultContexts: defaultContexts(state.project, opts, state.mode),
    targets: plan?.targets.map(target => ({ stableKey: target.stableKey, label: target.label })) ?? [],
    groups: plan?.groups.map(group => ({ stableKey: group.stableKey, label: group.label, targetKeys: group.targetKeys })) ?? [],
    markets: plan?.reportingScopes?.map(scope => ({ stableKey: scope.stableKey, label: scope.label, usageEdges: scope.usageEdges })) ?? [],
    tracked: trackedRows(db, state, rows, plan, opts),
    savedSources: savedSources(db, state.project.id),
  })
}

function requireAdvanced(state: WorkspaceState): ActivePortfolio {
  if (!state.active) throw validationError('This operation requires an active advanced measurement plan.')
  return state.active
}

function resolveAudience(plan: MeasurementPlanV2, input: QueryTrackingAudience | undefined): ResolvedAudience {
  const targetByKey = new Map(plan.targets.map(target => [target.stableKey, target]))
  const groupByKey = new Map(plan.groups.map(group => [group.stableKey, group]))
  const marketByKey = new Map((plan.reportingScopes ?? []).map(scope => [scope.stableKey, scope]))
  const targetKeys = new Set<string>()
  const groupKeys = unique(input?.groupKeys ?? [])
  const marketKeys = unique(input?.marketKeys ?? [])
  for (const targetKey of unique(input?.targetKeys ?? [])) {
    if (!targetByKey.has(targetKey)) throw validationError(`Selected Property "${targetKey}" is not in the active plan.`)
    targetKeys.add(targetKey)
  }
  for (const groupKey of groupKeys) {
    const group = groupByKey.get(groupKey)
    if (!group) throw validationError(`Selected group "${groupKey}" is not in the active plan.`)
    for (const targetKey of group.targetKeys) targetKeys.add(targetKey)
  }
  for (const marketKey of marketKeys) {
    const scope = marketByKey.get(marketKey)
    if (!scope) throw validationError(`Selected market "${marketKey}" is not in the active plan.`)
    for (const edge of scope.usageEdges) targetKeys.add(edge.targetKey)
  }
  if (targetKeys.size === 0) {
    throw validationError('Select at least one Property, group, or market for a portfolio query.')
  }
  return {
    targetKeys: [...targetKeys].sort(compareText),
    groupKeys: groupKeys.sort(compareText),
    marketKeys: marketKeys.sort(compareText),
  }
}

function contextsFromInput(
  project: ProjectRow,
  contexts: QueryTrackingAddition['contexts'],
): MeasurementV2ExecutionContext[] | undefined {
  if (contexts === undefined) return undefined
  const locations = new Map(project.locations.map(location => [location.label, location]))
  return uniqueContexts(contexts.map(context => {
    const location = context.location === null ? null : locations.get(context.location)
    if (context.location !== null && !location) {
      throw validationError(`Execution context names a location the project does not configure: ${context.location}`)
    }
    const providers = unique(context.providers.map(provider => provider.trim().toLocaleLowerCase('en')).filter(Boolean)).sort(compareText)
    for (const provider of Object.keys(context.models)) {
      if (!providers.includes(provider.trim().toLocaleLowerCase('en'))) {
        throw validationError(`Model "${provider}" is not selected by this execution context.`)
      }
    }
    const models = Object.fromEntries(Object.entries(context.models)
      .map(([provider, model]) => [provider.trim().toLocaleLowerCase('en'), model]))
    return { providers, models, location: location ?? null }
  }))
}

function contextsFromMarket(
  plan: MeasurementPlanV2,
  marketKeys: readonly string[],
  targetKey: string,
): MeasurementV2ExecutionContext[] {
  const nodes = new Map(plan.executionNodes.map(node => [node.stableKey, node]))
  const scopes = new Map((plan.reportingScopes ?? []).map(scope => [scope.stableKey, scope]))
  const contexts: MeasurementV2ExecutionContext[] = []
  for (const marketKey of marketKeys) {
    const scope = scopes.get(marketKey)
    if (!scope) continue
    for (const edge of scope.usageEdges) {
      if (edge.targetKey !== targetKey) continue
      const node = nodes.get(edge.executionNodeKey)
      if (node) contexts.push(node.context)
    }
  }
  return uniqueContexts(contexts)
}

function sourceRecord(
  db: DbLike,
  projectId: string,
  addition: QueryTrackingAddition,
  manualCapturedAt: string,
): Array<{ queryText: string; provenance: QueryTrackingProvenance; audience?: ResolvedAudience }> {
  switch (addition.input.source) {
    case 'manual':
      return [{
        queryText: addition.input.text,
        // Preview and commit agree on the server-minted moment the operator
        // reviewed this manual input. It must not inherit an old plan/project
        // timestamp and pretend the text was captured historically.
        provenance: { source: 'manual', sourceId: null, capturedAt: manualCapturedAt },
      }]
    case 'research': {
      const row = db.select({
        id: researchRunQueries.id,
        queryText: researchRunQueries.queryText,
        createdAt: researchRunQueries.createdAt,
      }).from(researchRunQueries)
        .innerJoin(researchRuns, eq(researchRunQueries.researchRunId, researchRuns.id))
        .where(and(eq(researchRuns.projectId, projectId), eq(researchRunQueries.id, addition.input.researchRunQueryId))).get()
      if (!row) throw notFound('Saved research query', addition.input.researchRunQueryId)
      if (!row.queryText.trim()) throw validationError('Saved research query has no usable text.')
      return [{ queryText: row.queryText, provenance: { source: 'research', sourceId: row.id, capturedAt: row.createdAt } }]
    }
    case 'discovery': {
      const row = db.select({
        id: discoveryProbes.id,
        queryText: discoveryProbes.query,
        createdAt: discoveryProbes.createdAt,
      }).from(discoveryProbes)
        .innerJoin(discoverySessions, eq(discoveryProbes.sessionId, discoverySessions.id))
        .where(and(eq(discoverySessions.projectId, projectId), eq(discoveryProbes.id, addition.input.discoveryProbeId))).get()
      if (!row) throw notFound('Saved discovery probe', addition.input.discoveryProbeId)
      if (!row.queryText.trim()) throw validationError('Saved discovery probe has no usable text.')
      return [{ queryText: row.queryText, provenance: { source: 'discovery', sourceId: row.id, capturedAt: row.createdAt } }]
    }
    case 'template':
      return []
  }
}

function templateRecords(
  db: DbLike,
  state: WorkspaceState,
  addition: QueryTrackingAddition,
  audience: ResolvedAudience,
): Array<{ queryText: string; provenance: QueryTrackingProvenance; audience: ResolvedAudience }> {
  if (addition.input.source !== 'template') return []
  const template = db.select().from(measurementQueryTemplates).where(and(
    eq(measurementQueryTemplates.projectId, state.project.id),
    eq(measurementQueryTemplates.id, addition.input.templateId),
  )).get()
  if (!template) throw notFound('Measurement query template', addition.input.templateId)
  if (template.updatedAt !== addition.input.templateVersion || template.pattern !== addition.input.template) {
    throw validationError('The selected query template changed. Reload the template and preview again.')
  }
  const unsupported = template.variables.filter(variable => variable !== 'market' && variable !== 'property')
  if (unsupported.length) {
    throw validationError(`Query tracking templates support only {market} and {property}; found ${unsupported.map(variable => `{${variable}}`).join(', ')}.`)
  }
  const needsMarket = template.variables.includes('market')
  const needsProperty = template.variables.includes('property')
  const expand = (bindings: Record<string, string>, scopedAudience: ResolvedAudience) => {
    let queryText = template.pattern
    for (const variable of template.variables) queryText = queryText.split(`{${variable}}`).join(bindings[variable] ?? '')
    queryText = queryText.trim()
    if (!queryText) throw validationError('Template expansion produced an empty query.')
    return {
      queryText,
      audience: scopedAudience,
      provenance: {
        source: 'template' as const,
        sourceId: `${template.id}@${template.updatedAt}`,
        capturedAt: template.updatedAt,
        template: {
          templateId: template.id,
          templateVersion: template.updatedAt,
          template: template.pattern,
          bindings,
          output: queryText,
        },
      },
    }
  }

  // A variable-free template is useful to a simple basket too. Templates that
  // name a portfolio identity are deliberately unavailable until there is a
  // frozen v2 plan to bind it against.
  if (!needsMarket && !needsProperty) return [expand({}, audience)]

  const plan = requireAdvanced(state).plan
  const scopes = new Map((plan.reportingScopes ?? []).map(scope => [scope.stableKey, scope]))
  const targets = new Map(plan.targets.map(target => [target.stableKey, target]))
  if (needsMarket && audience.marketKeys.length === 0) {
    throw validationError('A template containing {market} needs a selected market.')
  }
  if (needsProperty && audience.targetKeys.length === 0) {
    throw validationError('A template containing {property} needs a selected Property or group.')
  }

  if (needsMarket && needsProperty) {
    return audience.marketKeys.flatMap(marketKey => {
      const scope = scopes.get(marketKey)!
      const marketTargets = unique(scope.usageEdges.map(edge => edge.targetKey))
      const selected = audience.targetKeys.filter(targetKey => marketTargets.includes(targetKey))
      if (selected.length === 0) throw validationError(`Market "${marketKey}" has no selected Property.`)
      return selected.map(targetKey => expand(
        { market: scope.label, property: targets.get(targetKey)?.label ?? targetKey },
        { targetKeys: [targetKey], groupKeys: audience.groupKeys, marketKeys: [marketKey] },
      ))
    })
  }
  if (needsProperty) {
    return audience.targetKeys.map(targetKey => expand(
      { property: targets.get(targetKey)?.label ?? targetKey },
      { targetKeys: [targetKey], groupKeys: audience.groupKeys, marketKeys: audience.marketKeys },
    ))
  }
  return audience.marketKeys.map(marketKey => {
    const scope = scopes.get(marketKey)!
    const targetKeys = audience.targetKeys.filter(targetKey => scope.usageEdges.some(edge => edge.targetKey === targetKey))
    if (targetKeys.length === 0) throw validationError(`Market "${marketKey}" has no selected Property.`)
    return expand({ market: scope.label }, { targetKeys, groupKeys: audience.groupKeys, marketKeys: [marketKey] })
  })
}

function draftMatcher(matcher: MeasurementPlanV2['targets'][number]['urlMatchers'][number]): string {
  switch (matcher.kind) {
    case 'exact': return matcher.url
    case 'prefix': return `https://${matcher.host}${matcher.pathPrefix === '/' ? '' : matcher.pathPrefix}/*`
    case 'host': return matcher.host
  }
}

function compilerLocations(project: ProjectRow, plan: MeasurementPlanV2): LocationContext[] {
  const byLabel = new Map(project.locations.map(location => [location.label, location]))
  for (const node of plan.executionNodes) {
    if (node.context.location) byLabel.set(node.context.location.label, node.context.location)
  }
  return [...byLabel.values()]
}

function compileExecution(
  state: WorkspaceState,
  target: MeasurementPlanV2['targets'][number],
  queryId: string,
  queryText: string,
  queryClass: QueryClass,
  classificationSource: 'server' | 'operator',
  context: MeasurementV2ExecutionContext,
): { node: MeasurementPlanV2['executionNodes'][number]; edge: MeasurementV2UsageEdge } {
  const plan = requireAdvanced(state).plan
  const result = compileMeasurementDraftAssignmentExecution({
    defaultContext: {
      providers: [...context.providers],
      models: { ...context.models },
      locations: context.location ? [context.location.label] : [],
    },
    targets: [{
      stableKey: target.stableKey,
      label: target.label,
      status: 'included',
      aliases: [...target.aliases],
      urlMatchers: target.urlMatchers.map(draftMatcher),
      source: target.discoveryIdentity ? 'sitemap' : 'manual',
      ...(target.discoveryIdentity ? { discoveryIdentity: target.discoveryIdentity } : {}),
    }],
    assignments: [{
      targetKey: target.stableKey,
      queryId,
      queryClass,
      classificationSource: classificationSource === 'server' ? 'rule' : 'operator',
    }],
    groups: [],
  }, {
    canonicalDomain: state.project.canonicalDomain,
    ownedDomains: state.project.ownedDomains,
    brandNames: effectiveBrandNames(state.project),
    locations: compilerLocations(state.project, plan),
    trackedQueries: [{ id: queryId, query: queryText }],
  })
  if (!result.ok) throw validationError('The requested query assignment does not compile.', { checks: result.checks })
  const node = result.plan.executionNodes[0]!
  const edge = result.plan.usageEdges[0]!
  return { node, edge }
}

function fullPlanWithChecksum(plan: Omit<MeasurementPlanV2, 'compiledChecksum'> | MeasurementPlanV2): MeasurementPlanV2 {
  const provisional = measurementPlanV2Schema.parse({ ...plan, compiledChecksum: '0'.repeat(64) })
  const compiledChecksum = sha256Hex(measurementPlanV2ChecksumJson(provisional))
  return measurementPlanV2Schema.parse({ ...provisional, compiledChecksum })
}

function planClone(plan: MeasurementPlanV2): MeasurementPlanV2 {
  return measurementPlanV2Schema.parse(JSON.parse(canonicalMeasurementPlanV2Json(plan)))
}

function pruneReportingScopes(plan: MeasurementPlanV2): MeasurementPlanV2 {
  if (plan.reportingScopes === undefined) return plan
  const edgeKeys = new Set(plan.usageEdges.map(measurementV2UsageEdgeKey))
  return {
    ...plan,
    reportingScopes: plan.reportingScopes.map(scope => ({
      ...scope,
      usageEdges: scope.usageEdges.filter(edge => edgeKeys.has(measurementV2UsageEdgeKey(edge))),
    })),
  }
}

function addMarketEdge(plan: MeasurementPlanV2, marketKey: string, edge: MeasurementV2UsageEdge): MeasurementPlanV2 {
  const scopes = plan.reportingScopes ?? []
  const index = scopes.findIndex(scope => scope.stableKey === marketKey)
  if (index === -1) throw validationError(`Selected market "${marketKey}" is not in the active plan.`)
  const existing = scopes[index]!
  const edgeKey = measurementV2UsageEdgeKey(edge)
  if (existing.usageEdges.some(candidate => measurementV2UsageEdgeKey(candidate) === edgeKey)) return plan
  // Query-control already works on a parsed clone. Mutating that clone keeps a
  // caller that holds this plan reference in sync with the exact frozen edge
  // membership it just selected.
  scopes[index] = { ...existing, usageEdges: [...existing.usageEdges, edge] }
  plan.reportingScopes = scopes
  return plan
}

function assignmentKey(targetKey: string, queryId: string, executionNodeKey: string): string {
  return `${targetKey}\u0000${queryId}\u0000${executionNodeKey}`
}

function edgeKey(edge: MeasurementV2UsageEdge): string {
  return measurementV2UsageEdgeKey(edge)
}

function queryIdsByNormalized(state: WorkspaceState): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const row of state.queryRows) {
    const key = normalizeText(row.query)
    const ids = result.get(key)
    if (ids) ids.push(row.id)
    else result.set(key, [row.id])
  }
  for (const snapshot of state.active?.plan.querySnapshots ?? []) {
    const key = normalizeText(snapshot.queryText)
    const ids = result.get(key)
    if (ids) ids.push(snapshot.queryId)
    else result.set(key, [snapshot.queryId])
  }
  for (const ids of result.values()) ids.sort(compareText)
  return result
}

function preferredQueryId(state: WorkspaceState, normalizedText: string): string | null {
  const candidates = queryIdsByNormalized(state).get(normalizedText) ?? []
  const bound = new Set((state.active?.plan.querySnapshots ?? [])
    .filter(snapshot => normalizeText(snapshot.queryText) === normalizedText)
    .map(snapshot => snapshot.queryId))
  return candidates.find(candidate => bound.has(candidate)) ?? candidates.at(0) ?? null
}

function rowsEqual(
  before: ReadonlyMap<string, { id: string; query: string; provenance: string | null }>,
  after: ReadonlyMap<string, { id: string; query: string; provenance: string | null }>,
): boolean {
  if (before.size !== after.size) return false
  for (const [id, left] of before) {
    const right = after.get(id)
    if (!right || left.query !== right.query || left.provenance !== right.provenance) return false
  }
  return true
}

function changeRows(
  ids: readonly string[],
  rows: ReadonlyMap<string, { id: string; query: string }>,
  plan: MeasurementPlanV2 | null,
  fallbackPlan: MeasurementPlanV2 | null = null,
): QueryTrackingChangeRow[] {
  return unique(ids).flatMap(queryId => {
    const snapshot = plan?.querySnapshots.find(candidate => candidate.queryId === queryId)
      ?? fallbackPlan?.querySnapshots.find(candidate => candidate.queryId === queryId)
    const row = rows.get(queryId)
    const queryText = row?.query ?? snapshot?.queryText
    if (!queryText) return []
    return [{
      queryId,
      queryText,
      assignmentCount: (plan ?? fallbackPlan)?.assignments.filter(assignment => assignment.queryId === queryId).length ?? 0,
    }]
  }).sort((left, right) => compareText(left.queryText, right.queryText) || compareText(left.queryId, right.queryId))
}

type CandidateQueryRow = { id: string; query: string; provenance: string | null }

function planSnapshot(plan: MeasurementPlanV2 | null, queryId: string) {
  return plan?.querySnapshots.find(snapshot => snapshot.queryId === queryId) ?? null
}

function displayIds(
  rows: ReadonlyMap<string, CandidateQueryRow>,
  plan: MeasurementPlanV2 | null,
): Set<string> {
  return new Set([...rows.keys(), ...(plan?.querySnapshots.map(snapshot => snapshot.queryId) ?? [])])
}

function candidateIdsForText(
  state: WorkspaceState,
  plan: MeasurementPlanV2 | null,
  rows: ReadonlyMap<string, CandidateQueryRow>,
  normalizedText: string,
): string[] {
  const ids = new Set<string>()
  for (const row of rows.values()) {
    if (normalizeText(row.query) === normalizedText) ids.add(row.id)
  }
  for (const snapshot of plan?.querySnapshots ?? []) {
    if (normalizeText(snapshot.queryText) === normalizedText) ids.add(snapshot.queryId)
  }
  // The active revision is the execution identity. It wins over a stale or
  // duplicate row that merely happens to normalize to the same question.
  const activeId = preferredQueryId(state, normalizedText)
  return [...ids].sort((left, right) => {
    if (left === activeId) return -1
    if (right === activeId) return 1
    return compareText(left, right)
  })
}

function resolveMutationQueryId(
  state: WorkspaceState,
  plan: MeasurementPlanV2 | null,
  rows: ReadonlyMap<string, CandidateQueryRow>,
  removal: QueryTrackingMutation['removals'][number],
): string | null {
  if (removal.queryId !== undefined) {
    return rows.has(removal.queryId) || planSnapshot(plan, removal.queryId) !== null
      ? removal.queryId
      : null
  }
  const ids = candidateIdsForText(state, plan, rows, normalizeText(removal.queryText!))
  return ids[0] ?? null
}

function queryTextForId(
  state: WorkspaceState,
  plan: MeasurementPlanV2 | null,
  rows: ReadonlyMap<string, CandidateQueryRow>,
  queryId: string,
  fallback: string,
): string {
  return planSnapshot(plan, queryId)?.queryText
    ?? rows.get(queryId)?.query
    ?? planSnapshot(state.active?.plan ?? null, queryId)?.queryText
    ?? state.queryRows.find(row => row.id === queryId)?.query
    ?? fallback
}

function provenanceForId(
  state: WorkspaceState,
  plan: MeasurementPlanV2 | null,
  rows: ReadonlyMap<string, CandidateQueryRow>,
  queryId: string,
  fallback: QueryTrackingProvenance,
): QueryTrackingProvenance {
  return provenanceFromPlan(planSnapshot(plan, queryId)?.provenance)
    ?? provenanceFromPlan(planSnapshot(state.active?.plan ?? null, queryId)?.provenance)
    ?? parseQueryProvenance(rows.get(queryId)?.provenance ?? null)
    ?? parseQueryProvenance(state.queryRows.find(row => row.id === queryId)?.provenance ?? null)
    ?? fallback
}

/** Removes only the exact Target/question usage edges selected by a query action. */
function removeAdvancedAssignments(
  plan: MeasurementPlanV2,
  queryId: string,
  targetKeys: ReadonlySet<string>,
): MeasurementPlanV2 {
  const removedNodeKeys = new Set(plan.usageEdges
    .filter(edge => edge.queryId === queryId && targetKeys.has(edge.targetKey))
    .map(edge => edge.executionNodeKey))
  if (removedNodeKeys.size === 0) return plan

  const usageEdges = plan.usageEdges.filter(edge => !(edge.queryId === queryId && targetKeys.has(edge.targetKey)))
  const assignments = plan.assignments.filter(assignment => !(
    assignment.queryId === queryId
    && targetKeys.has(assignment.targetKey)
    && removedNodeKeys.has(assignment.executionNodeKey)
  ))
  const usedNodes = new Set(usageEdges.map(edge => edge.executionNodeKey))
  const executionNodes = plan.executionNodes.filter(node => !removedNodeKeys.has(node.stableKey) || usedNodes.has(node.stableKey))
  const queryStillUsed = usageEdges.some(edge => edge.queryId === queryId)
    || assignments.some(assignment => assignment.queryId === queryId)
  const querySnapshots = queryStillUsed
    ? plan.querySnapshots
    : plan.querySnapshots.filter(snapshot => snapshot.queryId !== queryId)
  return pruneReportingScopes({ ...plan, usageEdges, assignments, executionNodes, querySnapshots })
}

/**
 * Remove only selected, exact market edges from future execution. A market is
 * not a Target-wide view: an Alpha removal must never take Beta's edge merely
 * because they share a Property. An exact edge still named by another market
 * stays executable for that other frozen market.
 */
function removeMarketMembership(
  plan: MeasurementPlanV2,
  queryId: string,
  targetKeys: ReadonlySet<string>,
  marketKeys: ReadonlySet<string>,
): MeasurementPlanV2 {
  if (marketKeys.size === 0 || plan.reportingScopes === undefined) return plan
  const selectedEdgeKeys = new Set(plan.reportingScopes
    .filter(scope => marketKeys.has(scope.stableKey))
    .flatMap(scope => scope.usageEdges)
    .filter(edge => edge.queryId === queryId && targetKeys.has(edge.targetKey))
    .map(edgeKey))
  if (selectedEdgeKeys.size === 0) return plan
  const retainedByAnotherMarket = new Set(plan.reportingScopes
    .filter(scope => !marketKeys.has(scope.stableKey))
    .flatMap(scope => scope.usageEdges)
    .map(edgeKey))
  const removableEdgeKeys = new Set([...selectedEdgeKeys].filter(key => !retainedByAnotherMarket.has(key)))
  const reportingScopes = plan.reportingScopes.map(scope => !marketKeys.has(scope.stableKey)
    ? scope
    : {
        ...scope,
        usageEdges: scope.usageEdges.filter(edge => !selectedEdgeKeys.has(edgeKey(edge))),
      })
  if (removableEdgeKeys.size === 0) {
    return { ...plan, reportingScopes }
  }
  const usageEdges = plan.usageEdges.filter(edge => !removableEdgeKeys.has(edgeKey(edge)))
  const assignments = plan.assignments.filter(assignment => !removableEdgeKeys.has(edgeKey({
    executionNodeKey: assignment.executionNodeKey,
    targetKey: assignment.targetKey,
    queryId: assignment.queryId,
  })))
  const usedNodeKeys = new Set(usageEdges.map(edge => edge.executionNodeKey))
  const executionNodes = plan.executionNodes.filter(node => usedNodeKeys.has(node.stableKey))
  const queryStillUsed = usageEdges.some(edge => edge.queryId === queryId)
    || assignments.some(assignment => assignment.queryId === queryId)
  const querySnapshots = queryStillUsed
    ? plan.querySnapshots
    : plan.querySnapshots.filter(snapshot => snapshot.queryId !== queryId)
  return pruneReportingScopes({
    ...plan,
    reportingScopes,
    usageEdges,
    assignments,
    executionNodes,
    querySnapshots,
  })
}

function ensureAdvancedEdge(
  plan: MeasurementPlanV2,
  state: WorkspaceState,
  target: MeasurementPlanV2['targets'][number],
  queryId: string,
  queryText: string,
  queryClass: QueryClass,
  classificationSource: 'server' | 'operator',
  context: MeasurementV2ExecutionContext,
): MeasurementV2UsageEdge {
  const compiled = compileExecution(state, target, queryId, queryText, queryClass, classificationSource, context)
  if (!plan.executionNodes.some(node => node.stableKey === compiled.node.stableKey)) {
    plan.executionNodes.push(compiled.node)
  }
  const key = assignmentKey(target.stableKey, queryId, compiled.edge.executionNodeKey)
  if (!plan.assignments.some(assignment => assignmentKey(assignment.targetKey, assignment.queryId, assignment.executionNodeKey) === key)) {
    plan.assignments.push({
      targetKey: target.stableKey,
      queryId,
      queryClass,
      classificationSource,
      executionNodeKey: compiled.edge.executionNodeKey,
    })
  }
  if (!plan.usageEdges.some(edge => edgeKey(edge) === edgeKey(compiled.edge))) {
    plan.usageEdges.push(compiled.edge)
  }
  return compiled.edge
}

function applyOperatorClass(
  plan: MeasurementPlanV2,
  queryId: string,
  targetKey: string,
  queryClass: QueryClass,
): boolean {
  let changed = false
  for (const assignment of plan.assignments) {
    if (assignment.queryId !== queryId || assignment.targetKey !== targetKey) continue
    if (assignment.queryClass !== queryClass || assignment.classificationSource !== 'operator') {
      assignment.queryClass = queryClass
      assignment.classificationSource = 'operator'
      changed = true
    }
  }
  return changed
}

function advancedWorkload(plan: MeasurementPlanV2 | null): Map<string, number> {
  return new Map((plan?.executionNodes ?? []).map(node => [node.stableKey, node.expectedSnapshots]))
}

function simpleWorkload(
  project: ProjectRow,
  rows: ReadonlyMap<string, CandidateQueryRow>,
  opts: QueryTrackingRoutesOptions,
): Map<string, number> {
  const result = new Map<string, number>()
  for (const context of defaultContexts(project, opts, 'simple')) {
    for (const row of rows.values()) {
      result.set(`${normalizeText(row.query)}\u0000${contextKey(context)}`, context.providers.length)
    }
  }
  return result
}

function workloadDiff(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): QueryTrackingWorkload {
  const sum = (values: Iterable<number>) => [...values].reduce((total, value) => total + value, 0)
  const added = [...after.entries()].filter(([key]) => !before.has(key))
  const removed = [...before.entries()].filter(([key]) => !after.has(key))
  return {
    existingNodes: before.size,
    existingProviderCalls: sum(before.values()),
    nextSweepNodes: after.size,
    nextSweepProviderCalls: sum(after.values()),
    addedNodes: added.length,
    addedProviderCalls: sum(added.map(([, count]) => count)),
    removedNodes: removed.length,
    removedProviderCalls: sum(removed.map(([, count]) => count)),
  }
}

function candidateDiff(
  state: WorkspaceState,
  nextRows: ReadonlyMap<string, CandidateQueryRow>,
  plan: MeasurementPlanV2 | null,
  reusedQueryIds: ReadonlySet<string>,
  mutatedQueryIds: ReadonlySet<string>,
  scopedRemovalQueryIds: ReadonlySet<string>,
): QueryTrackingDiff {
  const beforeRows = new Map(state.queryRows.map(row => [row.id, row]))
  const beforeIds = displayIds(beforeRows, state.active?.plan ?? null)
  const afterIds = displayIds(nextRows, plan)
  const addedIds = [...afterIds].filter(id => !beforeIds.has(id))
  const removedIds = new Set([...beforeIds].filter(id => !afterIds.has(id)))
  for (const queryId of scopedRemovalQueryIds) {
    if (beforeIds.has(queryId) && afterIds.has(queryId)) removedIds.add(queryId)
  }
  const attentionIds = new Set([...reusedQueryIds, ...mutatedQueryIds])
  const reusedIds = [...attentionIds].filter(id => beforeIds.has(id) && afterIds.has(id) && !addedIds.includes(id) && !removedIds.has(id))
  const unchangedIds = [...afterIds].filter(id => !addedIds.includes(id) && !reusedIds.includes(id) && !removedIds.has(id))
  return {
    added: changeRows(addedIds, nextRows, plan),
    removed: changeRows([...removedIds], beforeRows, null, state.active?.plan ?? null),
    reused: changeRows(reusedIds, nextRows, plan, state.active?.plan ?? null),
    unchanged: changeRows(unchangedIds, nextRows, plan, state.active?.plan ?? null),
    noOp: false,
  }
}

function mutationPreviewToken(
  candidate: Candidate,
  mutation: QueryTrackingMutation,
  reviewedAt: string,
): string {
  const document = candidate.plan === null ? null : canonicalMeasurementPlanV2Json(candidate.plan)
  return `qtp_${sha256Hex(canonicalJson({
    workspaceVersion: candidate.state.workspaceVersion,
    // A commit carries its review token while a preview does not. Bind the
    // review to the semantic mutation only, or every honest commit would hash
    // a different body than the preview that minted its token.
    mutation: { additions: mutation.additions, removals: mutation.removals },
    reviewedAt,
    plan: document,
    queries: [...candidate.queryRows.values()]
      .map(row => ({ id: row.id, query: row.query, provenance: row.provenance }))
      .sort((left, right) => compareText(left.id, right.id)),
  }))}`
}

function assertReviewedAt(reviewedAt: string): string {
  const milliseconds = Date.parse(reviewedAt)
  const now = Date.now()
  if (!Number.isFinite(milliseconds)
    || milliseconds > now + MAX_REVIEW_FUTURE_SKEW_MS
    || milliseconds < now - MAX_REVIEW_AGE_MS) {
    throw validationError('The reviewed preview has expired or has an invalid review time. Preview the changes again.')
  }
  return reviewedAt
}

function assertSimpleAddition(addition: QueryTrackingAddition): void {
  if (addition.audience !== undefined || addition.contexts !== undefined || addition.queryClass !== undefined) {
    // Do not persist an operator override that the simple-run capture would
    // ignore. A future simple-definition schema can add this as an explicit
    // frozen input, rather than inventing a side channel here.
    throw validationError('Target selection, execution contexts, and query-class overrides require an active advanced measurement plan.')
  }
}

function addSimpleSource(
  state: WorkspaceState,
  rows: Map<string, CandidateQueryRow>,
  source: { queryText: string; provenance: QueryTrackingProvenance },
  reusedQueryIds: Set<string>,
): void {
  const normalized = normalizeText(source.queryText)
  const existingId = candidateIdsForText(state, null, rows, normalized).at(0)
    ?? preferredQueryId(state, normalized)
    ?? stableNewQueryId(state.project.id, normalized)
  const existing = rows.get(existingId)
  if (existing) {
    reusedQueryIds.add(existingId)
    return
  }
  const prior = state.queryRows.find(row => row.id === existingId)
  if (prior) {
    rows.set(prior.id, { id: prior.id, query: prior.query, provenance: prior.provenance })
    reusedQueryIds.add(prior.id)
    return
  }
  rows.set(existingId, {
    id: existingId,
    query: source.queryText.trim(),
    provenance: serializeQueryProvenance(source.provenance),
  })
}

function buildSimpleCandidate(
  db: DbLike,
  state: WorkspaceState,
  mutation: QueryTrackingMutation,
  opts: QueryTrackingRoutesOptions,
  manualCapturedAt: string,
): Candidate {
  const rows = new Map(state.queryRows.map(row => [row.id, { id: row.id, query: row.query, provenance: row.provenance }]))
  const reusedQueryIds = new Set<string>()
  const mutatedQueryIds = new Set<string>()
  const scopedRemovalQueryIds = new Set<string>()
  for (const removal of mutation.removals) {
    if (removal.audience !== undefined) {
      throw validationError('Audience selection requires an active advanced measurement plan.')
    }
    const queryId = resolveMutationQueryId(state, null, rows, removal)
    if (!queryId) continue
    rows.delete(queryId)
    mutatedQueryIds.add(queryId)
  }
  for (const addition of mutation.additions) {
    assertSimpleAddition(addition)
    const audience: ResolvedAudience = { targetKeys: [], groupKeys: [], marketKeys: [] }
    const records = addition.input.source === 'template'
      ? templateRecords(db, state, addition, audience)
      : sourceRecord(db, state.project.id, addition, manualCapturedAt)
    for (const record of records) addSimpleSource(state, rows, record, reusedQueryIds)
  }
  const planChanged = false
  const rowChanged = !rowsEqual(new Map(state.queryRows.map(row => [row.id, row])), rows)
  const diff = candidateDiff(state, rows, null, reusedQueryIds, mutatedQueryIds, scopedRemovalQueryIds)
  diff.noOp = !rowChanged
  const beforeWork = simpleWorkload(state.project, new Map(state.queryRows.map(row => [row.id, row])), opts)
  const nextWork = simpleWorkload(state.project, rows, opts)
  return {
    state,
    plan: null,
    planChanged,
    queryRows: rows,
    createdQueryIds: new Set([...rows.keys()].filter(id => !state.queryRows.some(row => row.id === id))),
    removedQueryIds: new Set(state.queryRows.filter(row => !rows.has(row.id)).map(row => row.id)),
    scopedRemovalQueryIds,
    reusedQueryIds,
    mutatedQueryIds,
    diff,
    workload: workloadDiff(beforeWork, nextWork),
  }
}

function addAdvancedSource(
  state: WorkspaceState,
  plan: MeasurementPlanV2,
  rows: Map<string, CandidateQueryRow>,
  addition: QueryTrackingAddition,
  source: { queryText: string; provenance: QueryTrackingProvenance; audience: ResolvedAudience },
  reusedQueryIds: Set<string>,
  mutatedQueryIds: Set<string>,
): void {
  const normalized = normalizeText(source.queryText)
  const queryId = candidateIdsForText(state, plan, rows, normalized).at(0)
    ?? preferredQueryId(state, normalized)
    ?? stableNewQueryId(state.project.id, normalized)
  const knownBefore = state.queryRows.some(row => row.id === queryId)
    || planSnapshot(state.active?.plan ?? null, queryId) !== null
  const queryText = queryTextForId(state, plan, rows, queryId, source.queryText.trim())
  const provenance = provenanceForId(state, plan, rows, queryId, source.provenance)
  if (!rows.has(queryId)) {
    rows.set(queryId, { id: queryId, query: queryText, provenance: serializeQueryProvenance(provenance) })
  }
  if (!planSnapshot(plan, queryId)) {
    plan.querySnapshots.push({ queryId, queryText, provenance })
  }
  if (knownBefore) reusedQueryIds.add(queryId)

  const requestedContexts = contextsFromInput(state.project, addition.contexts)
  const targets = new Map(plan.targets.map(target => [target.stableKey, target]))
  for (const targetKey of source.audience.targetKeys) {
    const target = targets.get(targetKey)
    if (!target) throw validationError(`Selected Property "${targetKey}" is not in the active plan.`)
    const existing = plan.assignments.filter(assignment => assignment.queryId === queryId && assignment.targetKey === targetKey)
    const existingClass = existing.at(0)?.queryClass
    const existingSource = existing.at(0)?.classificationSource
    const proposed = proposeQueryClassForTarget(queryText, effectiveBrandNames(state.project), target)
    if (proposed === 'unclassified') throw validationError('The server could not classify this portfolio query.')
    const queryClass: QueryClass = addition.queryClass ?? existingClass ?? proposed
    const classificationSource: 'server' | 'operator' = addition.queryClass !== undefined
      ? 'operator'
      : existing.length > 0
        ? (existingSource ?? 'operator')
        : 'server'
    if (addition.queryClass !== undefined && applyOperatorClass(plan, queryId, targetKey, addition.queryClass)) {
      mutatedQueryIds.add(queryId)
    }

    let contexts = requestedContexts
    if (contexts === undefined && source.audience.marketKeys.length > 0) {
      contexts = contextsFromMarket(plan, source.audience.marketKeys, targetKey)
      if (contexts.length === 0) {
        throw validationError(`Market selection has no frozen execution context for Property "${targetKey}". Supply a full execution context explicitly.`)
      }
    }
    if (contexts === undefined && existing.length === 0) {
      throw validationError(
        'Select an execution context for a new portfolio assignment. New assignments do not automatically expand across project locations.',
      )
    }
    const edges: MeasurementV2UsageEdge[] = []
    for (const context of contexts ?? []) {
      edges.push(ensureAdvancedEdge(plan, state, target, queryId, queryText, queryClass, classificationSource, context))
    }
    for (const marketKey of source.audience.marketKeys) {
      // Omitted contexts on an already-assigned question use the exact existing
      // edge set. This is a scope operation, never a Target-wide inference.
      const scopeEdges = edges.length > 0
        ? edges
        : plan.usageEdges.filter(edge => edge.queryId === queryId && edge.targetKey === targetKey)
      for (const edge of scopeEdges) {
        const before = plan.reportingScopes?.find(scope => scope.stableKey === marketKey)
        const present = before?.usageEdges.some(member => edgeKey(member) === edgeKey(edge)) ?? false
        plan = addMarketEdge(plan, marketKey, edge)
        if (!present) mutatedQueryIds.add(queryId)
      }
    }
    if (edges.length > 0) mutatedQueryIds.add(queryId)
  }
}

function buildAdvancedCandidate(
  db: DbLike,
  state: WorkspaceState,
  mutation: QueryTrackingMutation,
  manualCapturedAt: string,
): Candidate {
  const active = requireAdvanced(state)
  let plan = planClone(active.plan)
  const rows = new Map(state.queryRows.map(row => [row.id, { id: row.id, query: row.query, provenance: row.provenance }]))
  const reusedQueryIds = new Set<string>()
  const mutatedQueryIds = new Set<string>()
  const scopedRemovalQueryIds = new Set<string>()
  const fullRemovals = new Set<string>()

  for (const removal of mutation.removals) {
    const queryId = resolveMutationQueryId(state, plan, rows, removal)
    if (!queryId) continue
    const before = canonicalMeasurementPlanV2Json(plan)
    if (removal.audience?.marketKeys?.length) {
      const audience = resolveAudience(plan, removal.audience)
      plan = removeMarketMembership(plan, queryId, new Set(audience.targetKeys), new Set(audience.marketKeys))
    } else {
      const targetKeys = removal.audience === undefined
        ? new Set(plan.assignments.filter(assignment => assignment.queryId === queryId).map(assignment => assignment.targetKey))
        : new Set(resolveAudience(plan, removal.audience).targetKeys)
      if (targetKeys.size > 0) plan = removeAdvancedAssignments(plan, queryId, targetKeys)
      // An unassigned query may still be a visible row. A full basket removal
      // deletes that row too; a scoped Target removal leaves it for its other
      // assignments, if any.
      if (removal.audience === undefined) fullRemovals.add(queryId)
    }
    if (canonicalMeasurementPlanV2Json(plan) !== before) {
      mutatedQueryIds.add(queryId)
      if (removal.audience !== undefined) scopedRemovalQueryIds.add(queryId)
    }
  }

  for (const addition of mutation.additions) {
    const audience = resolveAudience(plan, addition.audience)
    const records = addition.input.source === 'template'
      ? templateRecords(db, state, addition, audience)
      : sourceRecord(db, state.project.id, addition, manualCapturedAt).map(record => ({ ...record, audience }))
    for (const record of records) {
      addAdvancedSource(state, plan, rows, addition, record, reusedQueryIds, mutatedQueryIds)
    }
  }

  // Delete a physical query only after additions have had a chance to reuse
  // its active-plan id. The snapshot is the durable identity guard here.
  for (const queryId of fullRemovals) {
    if (!planSnapshot(plan, queryId)) rows.delete(queryId)
  }

  plan = fullPlanWithChecksum(pruneReportingScopes(plan))
  const planChanged = canonicalMeasurementPlanV2Json(plan) !== canonicalMeasurementPlanV2Json(active.plan)
  const rowChanged = !rowsEqual(new Map(state.queryRows.map(row => [row.id, row])), rows)
  const diff = candidateDiff(state, rows, plan, reusedQueryIds, mutatedQueryIds, scopedRemovalQueryIds)
  diff.noOp = !planChanged && !rowChanged
  return {
    state,
    plan,
    planChanged,
    queryRows: rows,
    createdQueryIds: new Set([...rows.keys()].filter(id => !state.queryRows.some(row => row.id === id))),
    removedQueryIds: new Set(state.queryRows.filter(row => !rows.has(row.id)).map(row => row.id)),
    scopedRemovalQueryIds,
    reusedQueryIds,
    mutatedQueryIds,
    diff,
    workload: workloadDiff(advancedWorkload(active.plan), advancedWorkload(plan)),
  }
}

function buildCandidate(
  db: DbLike,
  state: WorkspaceState,
  mutation: QueryTrackingMutation,
  opts: QueryTrackingRoutesOptions,
  manualCapturedAt: string,
): Candidate {
  return state.mode === 'simple'
    ? buildSimpleCandidate(db, state, mutation, opts, manualCapturedAt)
    : buildAdvancedCandidate(db, state, mutation, manualCapturedAt)
}

function writeSimpleCandidate(
  tx: DbLike,
  candidate: Candidate,
  now: string,
): void {
  replaceProjectQueries(tx, candidate.state.project.id, [...candidate.queryRows.values()].map(row => row.query), now)
  let persisted = tx.select().from(queries).where(eq(queries.projectId, candidate.state.project.id)).all()
  for (const queryId of candidate.createdQueryIds) {
    const planned = candidate.queryRows.get(queryId)
    if (!planned) continue
    const row = persisted.find(candidateRow => normalizeText(candidateRow.query) === normalizeText(planned.query))
    if (!row) continue
    // The preview names the concrete query id that an eventual v2 plan would
    // bind. Keep that identity in the simple basket too, after the canonical
    // replacement helper has safely reconciled rows and snapshot attribution.
    if (row.id !== planned.id) tx.update(queries).set({ id: planned.id }).where(eq(queries.id, row.id)).run()
    if (planned.provenance) tx.update(queries).set({ provenance: planned.provenance }).where(eq(queries.id, planned.id)).run()
    persisted = persisted.map(current => current.id === row.id ? { ...current, id: planned.id, provenance: planned.provenance } : current)
  }
}

function writeAdvancedCandidate(
  tx: DbLike,
  candidate: Candidate,
  request: FastifyRequest,
  now: string,
): ActivePortfolio {
  const active = requireAdvanced(candidate.state)
  const current = tx.select().from(queries).where(eq(queries.projectId, candidate.state.project.id)).all()
  const currentById = new Map(current.map(row => [row.id, row]))
  const removed = current.filter(row => !candidate.queryRows.has(row.id))
  if (removed.length > 0) {
    preserveSnapshotQueryText(tx, candidate.state.project.id, removed.map(row => row.id))
    tx.delete(queries).where(inArray(queries.id, removed.map(row => row.id))).run()
  }
  for (const row of candidate.queryRows.values()) {
    const previous = currentById.get(row.id)
    if (!previous) {
      tx.insert(queries).values({
        id: row.id,
        projectId: candidate.state.project.id,
        query: row.query,
        provenance: row.provenance,
        createdAt: now,
      }).run()
    } else if (previous.query !== row.query || previous.provenance !== row.provenance) {
      tx.update(queries).set({ query: row.query, provenance: row.provenance }).where(eq(queries.id, row.id)).run()
    }
  }
  if (!candidate.planChanged) return active

  const plan = candidate.plan!
  const canonicalJson = canonicalMeasurementPlanV2Json(plan)
  const latest = tx.select().from(measurementPlanVersions)
    .where(eq(measurementPlanVersions.projectId, candidate.state.project.id))
    .orderBy(desc(measurementPlanVersions.revision)).get()
  const revision = (latest?.revision ?? 0) + 1
  const versionId = crypto.randomUUID()
  tx.insert(measurementPlanVersions).values({
    id: versionId,
    projectId: candidate.state.project.id,
    revision,
    canonicalJson,
    checksum: sha256Hex(canonicalJson),
    schemaVersion: 2,
    compiledChecksum: plan.compiledChecksum,
    comparableToVersionId: plansAreLabelOnlyVariants(active.plan, plan) ? active.version.id : null,
    publishedBy: serializeActor(actorFromRequest(request)),
    sourceDraftId: null,
    createdAt: now,
  }).run()
  tx.update(measurementPlans)
    .set({ activeVersionId: versionId, updatedAt: now })
    .where(eq(measurementPlans.projectId, candidate.state.project.id)).run()
  writeAuditLog(tx, auditFromRequest(request, {
    projectId: candidate.state.project.id,
    actor: 'api',
    action: 'query-tracking.published',
    entityType: 'measurement-plan',
    entityId: String(revision),
    diff: {
      previousRevision: active.version.revision,
      compiledChecksum: plan.compiledChecksum,
      added: candidate.diff.added.length,
      removed: candidate.diff.removed.length,
      reused: candidate.diff.reused.length,
    },
  }))
  const version = tx.select().from(measurementPlanVersions).where(eq(measurementPlanVersions.id, versionId)).get()
  if (!version) throw new Error(`Published measurement plan version ${versionId} is missing`)
  return { version, plan }
}

export async function queryTrackingRoutes(app: FastifyInstance, opts: QueryTrackingRoutesOptions = {}) {
  app.get<{ Params: { name: string } }>('/projects/:name/query-tracking', async request => {
    const project = resolveProject(app.db, request.params.name)
    return workspaceDto(app.db, readWorkspace(app.db, project), opts)
  })

  app.post<{ Params: { name: string } }>('/projects/:name/query-tracking/preview', async request => {
    requireScope(request, MEASUREMENT_PLAN_WRITE_SCOPE)
    const parsed = queryTrackingPreviewRequestSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('Invalid query tracking preview payload', { issues: parsed.error.issues })
    const project = resolveProject(app.db, request.params.name)
    const state = readWorkspace(app.db, project)
    if (parsed.data.expectedWorkspaceVersion !== state.workspaceVersion) {
      throw queryTrackingPreviewStale(parsed.data.expectedWorkspaceVersion, state.workspaceVersion)
    }
    const reviewedAt = new Date().toISOString()
    const candidate = buildCandidate(app.db, state, parsed.data, opts, reviewedAt)
    return queryTrackingPreviewResponseSchema.parse({
      mode: state.mode,
      workspaceVersion: state.workspaceVersion,
      previewToken: mutationPreviewToken(candidate, parsed.data, reviewedAt),
      reviewedAt,
      active: activeDto(state.active),
      tracked: trackedRows(app.db, state, candidate.queryRows, candidate.plan, opts),
      diff: candidate.diff,
      workload: candidate.workload,
    })
  })

  app.post<{ Params: { name: string } }>('/projects/:name/query-tracking/commit', async request => {
    requireScope(request, MEASUREMENT_PLAN_WRITE_SCOPE)
    const parsed = queryTrackingCommitRequestSchema.safeParse(request.body)
    if (!parsed.success) throw validationError('Invalid query tracking commit payload', { issues: parsed.error.issues })
    const reviewedAt = assertReviewedAt(parsed.data.reviewedAt)
    const project = resolveProject(app.db, request.params.name)
    const result = app.db.transaction(tx => {
      const currentProject = tx.select().from(projects).where(eq(projects.id, project.id)).get()
      if (!currentProject) throw notFound('Project', project.name)
      const state = readWorkspace(tx, currentProject)
      if (parsed.data.expectedWorkspaceVersion !== state.workspaceVersion) {
        throw queryTrackingPreviewStale(parsed.data.expectedWorkspaceVersion, state.workspaceVersion)
      }
      const candidate = buildCandidate(tx, state, parsed.data, opts, reviewedAt)
      if (parsed.data.previewToken !== mutationPreviewToken(candidate, parsed.data, reviewedAt)) {
        throw queryTrackingPreviewStale(parsed.data.expectedWorkspaceVersion, state.workspaceVersion)
      }
      if (candidate.diff.noOp) return { candidate, active: state.active, committed: false }
      const now = new Date().toISOString()
      if (candidate.state.mode === 'simple') {
        writeSimpleCandidate(tx, candidate, now)
        writeAuditLog(tx, auditFromRequest(request, {
          projectId: candidate.state.project.id,
          actor: 'api',
          action: 'query-tracking.updated',
          entityType: 'query',
          diff: { added: candidate.diff.added.length, removed: candidate.diff.removed.length, reused: candidate.diff.reused.length },
        }))
        return { candidate, active: null, committed: true }
      }
      return { candidate, active: writeAdvancedCandidate(tx, candidate, request, now), committed: true }
    })
    const current = readWorkspace(app.db, resolveProject(app.db, project.name))
    return queryTrackingCommitResponseSchema.parse({
      committed: result.committed,
      mode: result.candidate.state.mode,
      workspaceVersion: current.workspaceVersion,
      reviewedAt,
      active: activeDto(result.active),
      diff: result.candidate.diff,
      workload: result.candidate.workload,
    })
  })
}
