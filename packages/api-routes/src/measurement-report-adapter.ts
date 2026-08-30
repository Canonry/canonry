/**
 * Immutable-plan report reconstruction.
 *
 * This is deliberately an adapter rather than a route: it reads exactly one
 * persisted plan version and one persisted run. It does not use current
 * project identity, call providers, or repair missing evidence.
 */

import { and, desc, eq, gte, inArray, isNull, lt, lte, ne } from 'drizzle-orm'
import {
  brandLabelFromDomain,
  brandKeyFromText,
  buildMeasurementRunManifestV1,
  deriveCitedUrlCandidates,
  filterCapturedCitedUrls,
  isVertexGroundingRedirect,
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION,
  parseMeasurementRunManifestV1,
  parseStoredMeasurementPlanAnyVersion,
  RunKinds,
  RunStatuses,
  RunTriggers,
  type LocationContext,
  type MeasurementPlan,
  type MeasurementPlanV2,
  type MeasurementQueryClass,
  type MeasurementReportResponse,
  type MeasurementRunManifestV1,
  type MeasurementTargetUrlMatcher,
  type MeasurementV2UrlMatcher,
  type RunStatus,
  type StoredMeasurementPlan,
} from '@ainyc/canonry-contracts'
import {
  measurementPlanVersions,
  querySnapshots,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import {
  buildMeasurementReport,
  normalizeMeasurementLocation,
  type MeasurementExpectedSlotInput,
  type MeasurementReportInput,
  type MeasurementTargetUrlInput,
  type MeasurementUsageEdgeInput,
} from './measurement-report.js'

export type StoredMeasurementReport =
  | { kind: 'no-plan'; revision: number }
  | { kind: 'no-population'; reason: 'no-run'; report: MeasurementReportResponse }
  | { kind: 'report'; report: MeasurementReportResponse }

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizedProviders(values: readonly string[]): string[] {
  const providers = values.map(value => value.trim().toLocaleLowerCase('en'))
  if (providers.some(value => !value)) throw new Error('measurement manifest provider must be non-empty')
  if (new Set(providers).size !== providers.length) throw new Error('measurement manifest providers must be unique')
  return providers.sort(compareText)
}

function canonicalContext(value: LocationContext | null): string {
  if (value === null) return 'null'
  return JSON.stringify({
    city: value.city,
    country: value.country,
    label: value.label,
    region: value.region,
    ...(value.timezone ? { timezone: value.timezone } : {}),
  })
}

function manifestExecutionId(nodeKey: string): string {
  return nodeKey
}

/**
 * The execution graph both schema versions share. v1 hangs the location context
 * straight off the node; v2 nests it inside the frozen execution context beside
 * the provider set. Everything downstream reads slots, not plan versions.
 */
interface FrozenExecutionNode {
  stableKey: string
  queryText: string
  context: LocationContext | null
  expectedSnapshots: number
  providers: readonly string[]
  models: Readonly<Record<string, string>>
}

function frozenExecutionNodes(plan: StoredMeasurementPlan): FrozenExecutionNode[] {
  if (plan.schemaVersion === MEASUREMENT_PLAN_V2_SCHEMA_VERSION) {
    return plan.executionNodes.map(node => ({
      stableKey: node.stableKey,
      queryText: node.queryText,
      context: node.context.location,
      expectedSnapshots: node.expectedSnapshots,
      providers: node.context.providers,
      models: node.context.models,
    }))
  }
  return plan.executionNodes.map(node => ({
    stableKey: node.stableKey,
    queryText: node.queryText,
    context: node.context,
    expectedSnapshots: node.expectedSnapshots,
    providers: [],
    models: {},
  }))
}

function requestedModelFor(node: FrozenExecutionNode, provider: string): string | undefined {
  const normalizedProvider = provider.trim().toLocaleLowerCase('en')
  for (const [configuredProvider, model] of Object.entries(node.models)) {
    if (configuredProvider.trim().toLocaleLowerCase('en') === normalizedProvider && model.trim()) return model.trim()
  }
  return undefined
}

function manifestFromNodes(
  nodes: readonly FrozenExecutionNode[],
  providersFor: (node: FrozenExecutionNode) => readonly string[],
): MeasurementRunManifestV1 {
  const expectedSlots: MeasurementRunManifestV1['expectedSlots'] = []
  for (const node of [...nodes].sort((left, right) => compareText(left.stableKey, right.stableKey))) {
    const providers = providersFor(node)
    if (node.expectedSnapshots !== providers.length) {
      throw new Error(`measurement manifest provider roster does not satisfy execution ${node.stableKey}`)
    }
    for (const provider of providers) {
      expectedSlots.push({
        executionId: manifestExecutionId(node.stableKey),
        queryText: node.queryText,
        provider,
        context: node.context,
      })
    }
  }
  return buildMeasurementRunManifestV1({ expectedSlots })
}

/** Materializes the provider-expanded, deterministic snapshot slots for one frozen plan. */
export function buildMeasurementRunManifest(
  plan: MeasurementPlan,
  providerRoster: readonly string[],
): MeasurementRunManifestV1 {
  const providers = normalizedProviders(providerRoster)
  return manifestFromNodes(frozenExecutionNodes(plan), () => providers)
}

/**
 * v2 froze the provider set on every execution node, so its expected work needs
 * no external roster: the revision already says how many answers each question
 * expects and from whom.
 */
export function buildMeasurementPlanV2Manifest(plan: MeasurementPlanV2): MeasurementRunManifestV1 {
  const nodes = frozenExecutionNodes(plan)
  const expectedSlots: MeasurementRunManifestV1['expectedSlots'] = []
  for (const node of [...nodes].sort((left, right) => compareText(left.stableKey, right.stableKey))) {
    const providers = normalizedProviders(node.providers)
    if (node.expectedSnapshots !== providers.length) {
      throw new Error(`measurement manifest provider roster does not satisfy execution ${node.stableKey}`)
    }
    for (const provider of providers) {
      const requestedModel = requestedModelFor(node, provider)
      expectedSlots.push({
        executionId: manifestExecutionId(node.stableKey),
        queryText: node.queryText,
        provider,
        context: node.context,
        ...(requestedModel ? { requestedModel } : {}),
      })
    }
  }
  return buildMeasurementRunManifestV1({ expectedSlots })
}

function manifestFailure(message: string): never {
  throw new Error(`measurement manifest is corrupt: ${message}`)
}

/**
 * `exhaustive` is what separates a full sweep from a spot check. A full sweep
 * promised every frozen execution node, so a missing one is corruption. A spot
 * check measured the slice the operator named, so its manifest is a subset by
 * construction and only the slots it does carry are checked against the plan.
 */
function parseManifest(
  value: unknown,
  executionNodes: readonly FrozenExecutionNode[],
  exhaustive = true,
): MeasurementRunManifestV1 {
  let manifest: MeasurementRunManifestV1
  try {
    manifest = parseMeasurementRunManifestV1(value)
  } catch {
    manifestFailure('unsupported shape')
  }
  const nodes = new Map(executionNodes.map(node => [manifestExecutionId(node.stableKey), node]))
  const seenNodeProviders = new Set<string>()
  const counts = new Map<string, number>()
  for (const slot of manifest.expectedSlots) {
    const node = nodes.get(slot.executionId)
    if (!node) manifestFailure(`unknown execution ${slot.executionId}`)
    if (slot.queryText !== node.queryText) manifestFailure(`query text mismatch for ${node.stableKey}`)
    if (canonicalContext(slot.context) !== canonicalContext(node.context)) manifestFailure(`context mismatch for ${node.stableKey}`)
    const requestedModel = requestedModelFor(node, slot.provider)
    if (requestedModel !== undefined && slot.requestedModel !== requestedModel) {
      manifestFailure(`requested model mismatch for ${node.stableKey}`)
    }
    const nodeProvider = `${node.stableKey}\u0000${slot.provider}`
    if (seenNodeProviders.has(nodeProvider)) manifestFailure('duplicate node provider')
    seenNodeProviders.add(nodeProvider)
    counts.set(node.stableKey, (counts.get(node.stableKey) ?? 0) + 1)
  }
  for (const node of executionNodes) {
    const measured = counts.get(node.stableKey) ?? 0
    if (exhaustive ? measured !== node.expectedSnapshots : measured > node.expectedSnapshots) {
      manifestFailure(`expected slot count mismatch for ${node.stableKey}`)
    }
  }
  return manifest
}

function matcherInput(targetKey: string, matcher: MeasurementTargetUrlMatcher | MeasurementV2UrlMatcher, index: number): MeasurementTargetUrlInput {
  if (matcher.kind === 'host') return { id: `${targetKey}:url:${index}`, mode: 'host', host: matcher.host }
  if (matcher.kind === 'prefix') {
    return { id: `${targetKey}:url:${index}`, mode: 'prefix', host: matcher.host, path: matcher.pathPrefix, pathCase: matcher.pathCase }
  }
  const parsed = new URL(matcher.url)
  return { id: `${targetKey}:url:${index}`, mode: 'exact', host: parsed.hostname, path: parsed.pathname, pathCase: matcher.pathCase }
}

function historicalEvidence(rawResponse: string | null): { urls: string[]; complete: boolean } {
  if (!rawResponse) return { urls: [], complete: false }
  try {
    const parsed = JSON.parse(rawResponse) as { groundingSources?: unknown }
    if (!Array.isArray(parsed.groundingSources)) return { urls: [], complete: false }
    const sources = parsed.groundingSources.map(source => {
      if (!source || typeof source !== 'object' || typeof (source as { uri?: unknown }).uri !== 'string') return null
      const uri = (source as { uri: string }).uri
      try {
        const protocol = new URL(uri).protocol
        return protocol === 'http:' || protocol === 'https:' ? { uri } : null
      } catch {
        return null
      }
    })
    const candidates = deriveCitedUrlCandidates(sources.filter((source): source is { uri: string } => source !== null))
    const unresolvedRedirect = candidates.some(candidate => isVertexGroundingRedirect(new URL(candidate)))
    return {
      urls: filterCapturedCitedUrls(candidates),
      complete: sources.every(source => source !== null) && !unresolvedRedirect,
    }
  } catch {
    return { urls: [], complete: false }
  }
}

function slotLocation(slot: MeasurementRunManifestV1['expectedSlots'][number]): string | null {
  return slot.context?.label ?? null
}

/**
 * Verify that one persisted execution row still belongs to the frozen slot it
 * claims. Consumers that summarize per-slot completion reuse this rather than
 * trusting the execution-id/provider pair alone.
 */
export function validateMeasurementExecutionSnapshot(
  snapshot: typeof querySnapshots.$inferSelect,
  slot: MeasurementRunManifestV1['expectedSlots'][number],
): void {
  if (snapshot.queryText !== slot.queryText || snapshot.provider.trim().toLocaleLowerCase('en') !== slot.provider) {
    throw new Error(`measurement snapshot provenance is corrupt: ${snapshot.id}`)
  }
  if (canonicalContext(snapshot.requestedContext) !== canonicalContext(slot.context)) {
    throw new Error(`measurement snapshot context is corrupt: ${snapshot.id}`)
  }
  if (slot.requestedModel !== undefined && snapshot.model !== slot.requestedModel) {
    throw new Error(`measurement snapshot requested model is corrupt: ${snapshot.id}`)
  }
}

function validateSupportedLocation(
  snapshot: typeof querySnapshots.$inferSelect,
  slot: MeasurementRunManifestV1['expectedSlots'][number],
): void {
  if (normalizeMeasurementLocation(snapshot.location) !== normalizeMeasurementLocation(slotLocation(slot))) {
    throw new Error(`measurement snapshot location is corrupt: ${snapshot.id}`)
  }
}

function supportsRequestedContext(
  snapshot: typeof querySnapshots.$inferSelect,
  slot: MeasurementRunManifestV1['expectedSlots'][number],
): boolean {
  if (slot.context === null) return true
  const support = snapshot.supportedContext
  if (support === null || support.status === 'ignored' || support.status === 'unknown') return false
  if (support.resolved !== undefined && support.resolved !== null
    && canonicalContext(support.resolved) !== canonicalContext(slot.context)) {
    throw new Error(`measurement snapshot resolved context is corrupt: ${snapshot.id}`)
  }
  return true
}

function expectedSlotInputs(manifest: MeasurementRunManifestV1): MeasurementExpectedSlotInput[] {
  return manifest.expectedSlots.map(slot => ({
    id: `slot:${slot.executionId}:${slot.provider}`,
    executionId: slot.executionId,
    queryText: slot.queryText,
    provider: slot.provider,
    location: slotLocation(slot),
  }))
}

function observationInputs(
  manifest: MeasurementRunManifestV1,
  snapshots: readonly (typeof querySnapshots.$inferSelect)[],
  legacy: boolean,
): MeasurementReportInput['observations'] {
  const slotsByExecution = new Map(manifest.expectedSlots.map(slot => [`${slot.executionId}\u0000${slot.provider}`, slot]))
  return snapshots.flatMap(snapshot => {
    if (legacy ? snapshot.measurementExecutionId !== null : snapshot.measurementExecutionId === null) return []
    if (snapshot.measurementExecutionId !== null) {
      const slot = slotsByExecution.get(`${snapshot.measurementExecutionId}\u0000${snapshot.provider.trim().toLocaleLowerCase('en')}`)
      if (!slot) throw new Error(`measurement snapshot provenance is corrupt: ${snapshot.id}`)
      validateMeasurementExecutionSnapshot(snapshot, slot)
      if (!supportsRequestedContext(snapshot, slot)) return []
      validateSupportedLocation(snapshot, slot)
    }
    const directCitations = snapshot.citedUrls
    return [{
      id: snapshot.id,
      executionId: snapshot.measurementExecutionId,
      queryText: snapshot.queryText ?? '',
      provider: snapshot.provider.trim().toLocaleLowerCase('en'),
      location: snapshot.location,
      answerText: snapshot.answerText,
      citedUrls: directCitations,
      citedUrlsComplete: directCitations !== null && snapshot.captureStatus === 'complete',
      ...(directCitations === null ? (() => {
        const historical = historicalEvidence(snapshot.rawResponse)
        return { historicalCitedUrls: historical.urls, historicalCitedUrlsComplete: historical.complete }
      })() : {}),
    }]
  })
}

function reportInput(
  revision: number,
  plan: MeasurementPlan,
  manifest: MeasurementRunManifestV1,
  snapshots: readonly (typeof querySnapshots.$inferSelect)[],
  legacy: boolean,
): MeasurementReportInput {
  const slots = expectedSlotInputs(manifest)
  const usageEdges: MeasurementUsageEdgeInput[] = plan.usageEdges.map(edge => edge.kind === 'baseline'
    ? { id: `baseline:${edge.queryId}:${edge.executionNodeKey}`, type: 'baseline' as const, executionId: manifestExecutionId(edge.executionNodeKey) }
    : { id: `target:${edge.targetKey}:${edge.queryId}:${edge.executionNodeKey}`, type: 'target' as const, executionId: manifestExecutionId(edge.executionNodeKey), targetId: edge.targetKey })

  return {
    revision,
    ownedHosts: plan.effectiveOwnedHosts,
    projectBrandNames: plan.projectBrandNames,
    projectDomain: plan.projectCanonicalHost,
    targets: plan.targets.map(target => ({
      id: target.stableKey,
      label: target.label,
      aliases: target.aliases,
      urls: target.urls.map((matcher, index) => matcherInput(target.stableKey, matcher, index)),
    })),
    groups: plan.groups.map(group => ({
      id: group.stableKey,
      label: group.label,
      targetIds: group.targetKeys,
      competitors: (group.competitors ?? []).map(domain => {
        const alias = brandLabelFromDomain(domain)
        return { domain, aliases: brandKeyFromText(alias).length >= 4 ? [alias] : [] }
      }),
    })),
    expectedSlots: slots,
    usageEdges,
    observations: observationInputs(manifest, snapshots, legacy),
  }
}

function v2UsageEdgeId(edge: MeasurementPlanV2['usageEdges'][number]): string {
  return `target:${edge.targetKey}:${edge.queryId}:${edge.executionNodeKey}`
}

export interface MeasurementPlanV2ReportInput {
  input: MeasurementReportInput
  /**
   * The frozen class of the assignment behind each usage edge. Classification
   * belongs to the Target-owned assignment, so one question can be Branded for
   * one Property and Non-brand for another; a class filter therefore selects
   * edges, never questions.
   */
  edgeQueryClass: ReadonlyMap<string, MeasurementQueryClass>
}

/**
 * Turns one frozen v2 revision and one run's snapshots into report-kernel input.
 * Every identity, alias, competitor and question comes from the revision, never
 * from live project configuration.
 */
export function buildMeasurementPlanV2ReportInput(
  revision: number,
  plan: MeasurementPlanV2,
  manifest: MeasurementRunManifestV1,
  snapshots: readonly (typeof querySnapshots.$inferSelect)[],
): MeasurementPlanV2ReportInput {
  const classByAssignment = new Map(plan.assignments.map(assignment => [
    `${assignment.targetKey}:${assignment.queryId}`,
    assignment.queryClass,
  ]))
  const edgeQueryClass = new Map<string, MeasurementQueryClass>()
  for (const edge of plan.usageEdges) {
    const queryClass = classByAssignment.get(`${edge.targetKey}:${edge.queryId}`)
    if (queryClass) edgeQueryClass.set(v2UsageEdgeId(edge), queryClass)
  }

  return {
    edgeQueryClass,
    input: {
      revision,
      ownedHosts: plan.identities.projectBrand.ownedHosts,
      projectBrandNames: plan.identities.projectBrand.names,
      projectDomain: plan.identities.projectBrand.canonicalHost,
      targets: plan.targets.map(target => ({
        id: target.stableKey,
        label: target.label,
        // The revision already decided this Property cannot be mentioned. Feeding
        // its aliases in anyway would turn "not applicable" into a 0% reading.
        aliases: target.mentionNotApplicable ? [] : target.aliases,
        urls: target.urlMatchers.map((matcher, index) => matcherInput(target.stableKey, matcher, index)),
      })),
      groups: plan.groups.map(group => ({
        id: group.stableKey,
        label: group.label,
        targetIds: group.targetKeys,
        // The frozen label is an identity name too, so a competitor published
        // without extra aliases is still matchable in an answer.
        competitors: group.competitors.map(competitor => ({
          domain: competitor.domain,
          aliases: [...new Set([competitor.label, ...competitor.aliases])],
        })),
      })),
      expectedSlots: expectedSlotInputs(manifest),
      // A v2 run is always plan-pinned, so there is no pre-plan bridge here.
      usageEdges: plan.usageEdges.map(edge => ({
        id: v2UsageEdgeId(edge),
        type: 'target' as const,
        executionId: manifestExecutionId(edge.executionNodeKey),
        targetId: edge.targetKey,
        // Stamped on the edge as well as returned in `edgeQueryClass`: the map
        // SELECTS edges for the class filter, the field REPORTS the class on the
        // row. One question can be Branded for one Property and Non-brand for
        // another, so the class belongs to the assignment, not to the question.
        queryClass: classByAssignment.get(`${edge.targetKey}:${edge.queryId}`) ?? null,
      })),
      observations: observationInputs(manifest, snapshots, false),
    },
  }
}

/**
 * Selects the latest eligible pinned answer-visibility run for a project and
 * reconstructs its report from the exact immutable plan revision it used.
 */
function responseFromReport(
  revision: number,
  report: ReturnType<typeof buildMeasurementReport>,
  run: MeasurementReportResponse['run'],
): MeasurementReportResponse {
  return {
    revision,
    run,
    groups: report.groups,
    targets: report.targets,
    evidence: report.evidence,
    diagnostics: report.diagnostics,
  }
}

/**
 * A cosmetic publish chain cannot realistically be deep, but the walk is still
 * bounded so a corrupt or cyclic link column can never hang a read.
 */
export const MEASUREMENT_COMPARABLE_VERSION_WALK_LIMIT = 32

/**
 * The plan version ids whose runs may honestly serve a read pinned to
 * `versionId`: the version itself, plus every predecessor reachable through
 * the `comparable_to_version_id` continuity chain that publish records for an
 * execution-identical (label-only) republish. Runs pinned to any of these
 * versions answered exactly the questions `versionId` asks, so serving one is
 * continuity rather than cross-revision mixing. The walk is backward-only,
 * bounded, and cycle-safe.
 */
export function comparableMeasurementVersionIds(
  db: Pick<DatabaseClient, 'select'>,
  projectId: string,
  versionId: string,
): string[] {
  const ids = [versionId]
  const seen = new Set(ids)
  let cursor = versionId
  for (let step = 0; step < MEASUREMENT_COMPARABLE_VERSION_WALK_LIMIT; step++) {
    const row = db.select({ comparableToVersionId: measurementPlanVersions.comparableToVersionId })
      .from(measurementPlanVersions)
      .where(and(
        eq(measurementPlanVersions.projectId, projectId),
        eq(measurementPlanVersions.id, cursor),
      )).get()
    const next = row?.comparableToVersionId ?? null
    if (next === null || seen.has(next)) break
    ids.push(next)
    seen.add(next)
    cursor = next
  }
  return ids
}

/**
 * Whether a run's pinned version may serve a read of `activeVersionId`. Exact
 * match, or membership in the comparable chain. A pre-plan run (null pin) never
 * qualifies: it answered questions no revision froze.
 */
export function runVersionServesActiveVersion(
  db: DatabaseClient,
  projectId: string,
  activeVersionId: string,
  runVersionId: string | null,
): boolean {
  if (runVersionId === null) return false
  if (runVersionId === activeVersionId) return true
  return comparableMeasurementVersionIds(db, projectId, activeVersionId).includes(runVersionId)
}

/**
 * The default displayed run for one revision.
 *
 * A scoped spot check is excluded on purpose: it measured a slice the operator
 * named, so displaying it as the revision's result would report a subset as the
 * whole. It stays selectable by naming its id (§0.3).
 *
 * Selection accepts a run pinned to the named version OR to any prior version
 * in its comparable chain, so a label-only republish keeps displaying the run
 * it already had instead of blanking until the next sweep.
 */
export function latestMeasurementRun(
  db: Pick<DatabaseClient, 'select'>,
  projectId: string,
  versionId: string,
  statuses: readonly RunStatus[],
  window: { from?: string; to?: string } = {},
  opts: { exactVersion?: boolean } = {},
): typeof runs.$inferSelect | undefined {
  const conditions = [
    eq(runs.projectId, projectId),
    // The revision-addressed report surface promises the revision AS-WAS and
    // must never borrow a predecessor's run through the comparable chain; the
    // active-dashboard surfaces want the chain so a label-only republish does
    // not blank them. exactVersion selects the contract.
    opts.exactVersion
      ? eq(runs.measurementPlanVersionId, versionId)
      : inArray(runs.measurementPlanVersionId, comparableMeasurementVersionIds(db, projectId, versionId)),
    eq(runs.kind, RunKinds['answer-visibility']),
    inArray(runs.status, [...statuses]),
    ne(runs.trigger, RunTriggers.probe),
    isNull(runs.measurementScope),
  ]
  if (window.from !== undefined) conditions.push(gte(runs.createdAt, window.from))
  if (window.to !== undefined) conditions.push(lte(runs.createdAt, window.to))
  return db.select().from(runs).where(and(...conditions))
    .orderBy(desc(runs.createdAt), desc(runs.id)).get()
}

function pinnedMeasurementRun(
  db: DatabaseClient,
  projectId: string,
  versionId: string,
  runId: string,
  opts: { exactVersion?: boolean } = {},
): typeof runs.$inferSelect | undefined {
  return db.select().from(runs).where(and(
    eq(runs.id, runId),
    eq(runs.projectId, projectId),
    opts.exactVersion
      ? eq(runs.measurementPlanVersionId, versionId)
      : inArray(runs.measurementPlanVersionId, comparableMeasurementVersionIds(db, projectId, versionId)),
    eq(runs.kind, RunKinds['answer-visibility']),
    inArray(runs.status, [RunStatuses.completed, RunStatuses.partial]),
    ne(runs.trigger, RunTriggers.probe),
    isNull(runs.measurementScope),
  )).get()
}

/**
 * The expected work one stored run actually promised, checked against the
 * revision it was pinned to. A run with no manifest measured nothing this
 * revision can be held to, so it fails loudly rather than being reported over
 * an invented denominator.
 */
export function measurementRunExpectedSlots(
  run: typeof runs.$inferSelect,
  plan: StoredMeasurementPlan,
): MeasurementRunManifestV1 {
  if (run.measurementManifest === null) manifestFailure(`missing for run ${run.id}`)
  return parseManifest(run.measurementManifest, frozenExecutionNodes(plan), run.measurementScope === null)
}

function storedMeasurementPlanV2Report(
  db: DatabaseClient,
  projectId: string,
  version: typeof measurementPlanVersions.$inferSelect,
  plan: MeasurementPlanV2,
  runId?: string,
): StoredMeasurementReport {
  const run = runId
    ? pinnedMeasurementRun(db, projectId, version.id, runId, { exactVersion: true })
    : latestMeasurementRun(db, projectId, version.id, [RunStatuses.completed, RunStatuses.partial], {}, { exactVersion: true })
  if (!run) {
    const empty = buildMeasurementPlanV2ReportInput(version.revision, plan, { schemaVersion: 1, expectedSlots: [] }, [])
    return {
      kind: 'no-population',
      reason: 'no-run',
      report: responseFromReport(version.revision, buildMeasurementReport(empty.input), null),
    }
  }
  const manifest = measurementRunExpectedSlots(run, plan)
  const snapshots = db.select().from(querySnapshots).where(eq(querySnapshots.runId, run.id)).all()
  const { input } = buildMeasurementPlanV2ReportInput(version.revision, plan, manifest, snapshots)
  return {
    kind: 'report',
    report: responseFromReport(version.revision, buildMeasurementReport(input), {
      id: run.id,
      status: run.status === RunStatuses.completed ? RunStatuses.completed : RunStatuses.partial,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    }),
  }
}

export function buildStoredMeasurementReport(
  db: DatabaseClient,
  projectId: string,
  revision: number,
  runId?: string,
): StoredMeasurementReport {
  const version = db.select().from(measurementPlanVersions).where(and(
    eq(measurementPlanVersions.projectId, projectId),
    eq(measurementPlanVersions.revision, revision),
  )).get()
  if (!version) return { kind: 'no-plan', revision }

  const stored = parseStoredMeasurementPlanAnyVersion(version.canonicalJson)
  if (stored.schemaVersion === MEASUREMENT_PLAN_V2_SCHEMA_VERSION) {
    return storedMeasurementPlanV2Report(db, projectId, version, stored, runId)
  }
  const plan = stored

  const run = runId
    ? pinnedMeasurementRun(db, projectId, version.id, runId, { exactVersion: true })
    : db.select().from(runs).where(and(
        eq(runs.projectId, projectId),
        eq(runs.measurementPlanVersionId, version.id),
        eq(runs.kind, RunKinds['answer-visibility']),
        inArray(runs.status, [RunStatuses.completed, RunStatuses.partial]),
        ne(runs.trigger, RunTriggers.probe),
      )).orderBy(desc(runs.createdAt), desc(runs.id)).get()
  let selectedRun = run
  let manifest: MeasurementRunManifestV1
  let legacy = false
  if (selectedRun) {
    if (selectedRun.measurementManifest === null) manifestFailure(`missing for run ${selectedRun.id}`)
    manifest = parseManifest(selectedRun.measurementManifest, frozenExecutionNodes(plan))
  } else if (runId === undefined) {
    // A revision with no plan-aware measurement may display the latest completed
    // pre-plan run. Its provider roster is safe to infer only from a completed
    // run, and must satisfy every frozen execution node's expected slot count.
    selectedRun = db.select().from(runs).where(and(
      eq(runs.projectId, projectId),
      isNull(runs.measurementPlanVersionId),
      eq(runs.kind, RunKinds['answer-visibility']),
      eq(runs.status, RunStatuses.completed),
      ne(runs.trigger, RunTriggers.probe),
      lt(runs.createdAt, version.createdAt),
    )).orderBy(desc(runs.createdAt), desc(runs.id)).get()
    if (!selectedRun) {
      const report = buildMeasurementReport(reportInput(version.revision, plan, { schemaVersion: 1, expectedSlots: [] }, [], false))
      return { kind: 'no-population', reason: 'no-run', report: responseFromReport(version.revision, report, null) }
    }
    const legacySnapshots = db.select().from(querySnapshots).where(eq(querySnapshots.runId, selectedRun.id)).all()
    const providers = [...new Set(legacySnapshots.map(snapshot => snapshot.provider.trim().toLocaleLowerCase('en')).filter(Boolean))]
    try {
      manifest = buildMeasurementRunManifest(plan, providers)
    } catch {
      const report = buildMeasurementReport(reportInput(version.revision, plan, { schemaVersion: 1, expectedSlots: [] }, [], false))
      return { kind: 'no-population', reason: 'no-run', report: responseFromReport(version.revision, report, null) }
    }
    legacy = true
  } else {
    const report = buildMeasurementReport(reportInput(version.revision, plan, { schemaVersion: 1, expectedSlots: [] }, [], false))
    return { kind: 'no-population', reason: 'no-run', report: responseFromReport(version.revision, report, null) }
  }
  const snapshots = db.select().from(querySnapshots).where(eq(querySnapshots.runId, selectedRun.id)).all()
  const report = buildMeasurementReport(reportInput(version.revision, plan, manifest, snapshots, legacy))
  return {
    kind: 'report',
    report: responseFromReport(version.revision, report, {
      id: selectedRun.id,
      status: selectedRun.status === RunStatuses.completed ? RunStatuses.completed : RunStatuses.partial,
      createdAt: selectedRun.createdAt,
      startedAt: selectedRun.startedAt,
      finishedAt: selectedRun.finishedAt,
    }),
  }
}
