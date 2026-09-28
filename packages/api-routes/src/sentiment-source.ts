/** Frozen source selection; this module never reads live project identity or calls a provider. */
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm'
import {
  effectiveBrandNames, measurementV2UsageEdgeKey, parseStoredMeasurementPlanAnyVersion,
  simpleMeasurementDefinitionSchema, validationError,
  type LocationContext, type MeasurementPlanV2, type MeasurementV2Assignment, type MeasurementV2ExecutionNode,
  type MeasurementV2Target, type MeasurementV2UsageEdge, type SimpleMeasurementDefinition,
} from '@ainyc/canonry-contracts'
import { measurementPlanVersions, querySnapshots, runs, simpleMeasurementDefinitions, sentimentCompletionReceipts, type DatabaseClient } from '@ainyc/canonry-db'
import { measurementRunSlotState } from './measurement-run-completeness.js'

export interface SentimentSourceFilter {
  runId?: string; runIds?: string[]; since?: string; until?: string; revision?: number; mode?: 'auto' | 'simple' | 'advanced'
  queryId?: string; queryClass?: 'branded' | 'non-brand'; scope?: string; scopeKey?: string
  marketKey?: string; provider?: string; sourceModel?: string; location?: string
  /** Exact frozen Advanced execution node; Simple edges carry none, so they never match one. */
  executionNodeKey?: string
}
export interface SentimentSourceEdge {
  queryKey: string; queryText: string; executionNodeKey: string | null; queryClass: 'branded' | 'non-brand'; propertyKey: string
  groupKeys: string[]; marketKeys: string[]; provider: string
  sourceModel: string | null; servedModel: string | null; context: LocationContext | null
}
export interface SentimentSourceAssessment {
  projectId: string; runId: string; snapshotId: string; sourceText: string
  language: string; queryText: string; revision: number | null
  subject: { key: string; name: string; aliases: string[]; identityAliases: string[]; urls: string[]; mentionNotApplicable: boolean }
  edges: SentimentSourceEdge[]
}
export interface SentimentSourceSelection {
  assessments: SentimentSourceAssessment[]
  runIds: string[]
  sourceCoverage: { expected: number; completed: number }
  skipped: Record<string, number>
  /** The same skips attributed to their run, so a preview names each run without selecting it again. */
  skippedByRun?: Record<string, Record<string, number>>
}

// Selection reads only what it uses: raw provider payloads and run manifests never load here.
const sourceRunColumns = {
  id: runs.id, projectId: runs.projectId, kind: runs.kind, status: runs.status, trigger: runs.trigger,
  measurementPlanVersionId: runs.measurementPlanVersionId, measurementScope: runs.measurementScope, measurementExecutionIdentity: runs.measurementExecutionIdentity,
}
const sourceSnapshotColumns = {
  id: querySnapshots.id, queryId: querySnapshots.queryId, queryText: querySnapshots.queryText, provider: querySnapshots.provider,
  model: querySnapshots.model, servedModel: querySnapshots.servedModel, answerText: querySnapshots.answerText, measurementExecutionId: querySnapshots.measurementExecutionId,
}
type SourceRun = Pick<typeof runs.$inferSelect, keyof typeof sourceRunColumns>
type SourceSnapshot = Pick<typeof querySnapshots.$inferSelect, keyof typeof sourceSnapshotColumns>

interface IndexedUsage { edge: MeasurementV2UsageEdge; assignment: MeasurementV2Assignment | undefined; queryText: string | undefined; marketKeys: string[] }
/** One frozen revision, parsed and keyed once per selection however many runs share it. */
interface IndexedPlan {
  revision: number; plan: MeasurementPlanV2; usages: IndexedUsage[]
  nodes: Map<string, MeasurementV2ExecutionNode>; targets: Map<string, MeasurementV2Target>
  usagesByNodeTarget: Map<string, IndexedUsage[]>; groupKeys: Map<string, string[]>
}
type PlanCache = Map<string, IndexedPlan | null>
const pairKey = (left: string, right: string) => `${left}\0${right}`
function keep<T>(map: Map<string, T>, key: string, value: T) { if (!map.has(key)) map.set(key, value) }
function append<T>(map: Map<string, T[]>, key: string, value: T) { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]) }

export function selectSentimentSources(db: DatabaseClient, projectId: string, filters: SentimentSourceFilter): SentimentSourceSelection {
  if (filters.scope && filters.scope !== 'project' && !filters.scopeKey) throw validationError('A scopeKey is required for property, group, and market sentiment selections.')
  const requestedIds = filters.runIds ?? (filters.runId ? [filters.runId] : undefined)
  if (requestedIds && (requestedIds.length === 0 || requestedIds.length > 100)) throw validationError('Select between 1 and 100 runs.')
  const conditions = [eq(runs.projectId, projectId)]
  if (requestedIds) conditions.push(inArray(runs.id, requestedIds))
  if (filters.since) conditions.push(gte(runs.createdAt, filters.since))
  if (filters.until) conditions.push(lte(runs.createdAt, filters.until))
  const selectedRuns = db.select(sourceRunColumns).from(runs).where(and(...conditions)).orderBy(desc(runs.createdAt)).limit(101).all()
  if (selectedRuns.length > 100) throw validationError('Selection exceeds 100 runs; narrow the date range.')
  if (requestedIds && new Set(selectedRuns.map(row => row.id)).size !== new Set(requestedIds).size) throw validationError('One or more selected runs are unavailable in this project.')
  const out: SentimentSourceSelection = { assessments: [], runIds: selectedRuns.map(row => row.id), sourceCoverage: { expected: 0, completed: 0 }, skipped: {}, skippedByRun: {} }
  let currentRunId = ''
  const skip = (reason: string, count = 1) => {
    out.skipped[reason] = (out.skipped[reason] ?? 0) + count
    const byRun = out.skippedByRun![currentRunId] ??= {}
    byRun[reason] = (byRun[reason] ?? 0) + count
  }
  // An answer left out only because of its query class is reported, so a one-class
  // backfill never reads as covering the other class's history.
  const otherClass = (filters.queryClass ?? 'branded') === 'branded' ? 'non-brand' : 'branded'
  const otherClassFilters: SentimentSourceFilter = { ...filters, queryClass: otherClass }
  const excluded = (edges: SentimentSourceEdge[]) => { if (edges.some(edge => matchesSentimentEdge(edge, otherClassFilters))) skip(`excluded-${otherClass}`) }
  const plans: PlanCache = new Map()
  for (const run of selectedRuns) {
    currentRunId = run.id
    if (run.trigger === 'probe') { skip('probe'); continue }
    if (run.kind !== 'answer-visibility') { skip('unsupported-run-kind'); continue }
    if (filters.mode === 'simple' && run.measurementPlanVersionId || filters.mode === 'advanced' && !run.measurementPlanVersionId) continue
    const completedSuperseded = run.status === 'superseded' && Boolean(db.select({ sequence: sentimentCompletionReceipts.sequence }).from(sentimentCompletionReceipts).where(and(eq(sentimentCompletionReceipts.projectId, projectId), eq(sentimentCompletionReceipts.runId, run.id))).get())
    if (run.status !== 'completed' && !completedSuperseded) {
      const coverage = selectedSlotCoverage(db, projectId, run, filters, plans)
      out.sourceCoverage.expected += coverage.expected
      out.sourceCoverage.completed += coverage.completed
      skip(run.status === 'failed' ? 'failed-run' : 'incomplete-run'); continue
    }
    const beforeAssessments = out.assessments.length
    const beforeCoverage = { ...out.sourceCoverage }
    if (run.measurementPlanVersionId) {
      const indexed = indexedPlan(db, projectId, run.measurementPlanVersionId, plans)
      if (!indexed) { skip('legacy-missing-provenance'); continue }
      if (filters.revision !== undefined && indexed.revision !== filters.revision) continue
      // Advanced language is stamped when a run executes. A run from before that stamp
      // has no provenance, and today's project language is never borrowed for it.
      const language = frozenRunLanguage(run)
      if (!language) { skip('legacy-missing-language'); continue }
      const slots = measurementRunSlotState(db, run.id)
      out.sourceCoverage.expected += slots.expected.length
      out.sourceCoverage.completed += slots.executed
      if (!slots.planned || !slots.readable || slots.missing.length > 0 || slots.hasUnboundSnapshot) {
        const coverage = selectedSlotCoverage(db, projectId, run, filters, plans)
        out.sourceCoverage.expected = beforeCoverage.expected + coverage.expected; out.sourceCoverage.completed = beforeCoverage.completed + coverage.completed
        skip('incomplete-run'); continue
      }
      const { plan } = indexed
      const scopedTargets = run.measurementScope?.resolvedTargets.length ? new Set(run.measurementScope.resolvedTargets) : null
      const scopedQueries = run.measurementScope?.queries.length ? new Set(run.measurementScope.queries) : null
      for (const snapshot of runSnapshots(db, run.id)) {
        const node = snapshot.measurementExecutionId === null ? undefined : indexed.nodes.get(snapshot.measurementExecutionId)
        if (!node) continue
        for (const target of plan.targets) {
          if (scopedTargets && !scopedTargets.has(target.stableKey)) continue
          const edges: SentimentSourceEdge[] = []
          for (const { edge, assignment, queryText, marketKeys } of indexed.usagesByNodeTarget.get(pairKey(node.stableKey, target.stableKey)) ?? []) {
            if (scopedQueries && !scopedQueries.has(edge.queryId)) continue
            if (!assignment) { skip('legacy-missing-provenance'); continue }
            const candidate: SentimentSourceEdge = {
              queryKey: edge.queryId, queryText: queryText ?? node.queryText, executionNodeKey: edge.executionNodeKey, queryClass: assignment.queryClass, propertyKey: target.stableKey,
              groupKeys: [...(indexed.groupKeys.get(target.stableKey) ?? [])], marketKeys: [...marketKeys],
              provider: snapshot.provider, sourceModel: snapshot.model, servedModel: snapshot.servedModel, context: node.context.location,
            }
            edges.push(candidate)
          }
          if (!edges.some(edge => matchesSentimentEdge(edge, filters))) { excluded(edges); continue }
          edges.sort((left, right) => left.queryClass.localeCompare(right.queryClass) || left.queryKey.localeCompare(right.queryKey))
          out.assessments.push({ projectId, runId: run.id, snapshotId: snapshot.id, sourceText: snapshot.answerText ?? '', language, queryText: node.queryText, revision: indexed.revision,
            subject: { key: target.stableKey, name: target.label, aliases: target.aliases, identityAliases: target.identityAliases ?? [], urls: target.urlMatchers.map(item => item.kind === 'exact' ? item.url : `https://${item.host}${item.kind === 'prefix' ? item.pathPrefix : '/'}`), mentionNotApplicable: target.mentionNotApplicable }, edges })
        }
      }
    } else {
      if (filters.revision !== undefined || (filters.scope && !['project', 'portfolio', 'all'].includes(filters.scope)) || filters.marketKey) continue
      const stored = db.select({ definition: simpleMeasurementDefinitions.definition }).from(simpleMeasurementDefinitions).where(and(eq(simpleMeasurementDefinitions.runId, run.id), eq(simpleMeasurementDefinitions.projectId, projectId))).get()
      const parsed = simpleMeasurementDefinitionSchema.safeParse(stored?.definition)
      if (!parsed.success) { skip('legacy-missing-provenance'); continue }
      const definition = parsed.data
      const sourceQuery = simpleSourceQueries(definition)
      const snapshots = runSnapshots(db, run.id).map(snapshot => ({ snapshot, query: sourceQuery(snapshot) }))
      const expected = definition.queries.flatMap(query => definition.engines.map(engine => simpleSlotKey(query.queryId, engine.provider)))
      const expectedSlots = new Set(expected)
      const recorded = new Set(snapshots.map(({ snapshot, query }) => simpleSlotKey(query?.queryId, snapshot.provider)))
      out.sourceCoverage.expected += expected.length
      out.sourceCoverage.completed += expected.filter(key => recorded.has(key)).length
      if (!expected.length || expected.some(key => !recorded.has(key)) || snapshots.length !== expected.length || snapshots.some(({ snapshot, query }) => !expectedSlots.has(simpleSlotKey(query?.queryId, snapshot.provider)))) {
        const coverage = selectedSlotCoverage(db, projectId, run, filters, plans)
        out.sourceCoverage.expected = beforeCoverage.expected + coverage.expected; out.sourceCoverage.completed = beforeCoverage.completed + coverage.completed
        skip('incomplete-run'); continue
      }
      // The subject matches the same frozen brand names the mention metric uses. Stored
      // aliases never repeat the display name, so aliases alone would miss answers that
      // name the brand only by its display name.
      const identity = definition.identity
      const names = effectiveBrandNames(identity)
      const urls = [identity.canonicalDomain, ...identity.ownedDomains]
      const mentionNotApplicable = !names.length && !urls.some(url => url.trim())
      for (const { snapshot, query } of snapshots) {
        if (!query?.queryClass) { skip('legacy-missing-provenance'); continue }
        const edge: SentimentSourceEdge = { queryKey: query.queryId, queryText: query.queryText, executionNodeKey: null, queryClass: query.queryClass, propertyKey: projectId, groupKeys: [], marketKeys: [], provider: snapshot.provider, sourceModel: snapshot.model, servedModel: snapshot.servedModel, context: definition.location }
        if (!matchesSentimentEdge(edge, filters)) { excluded([edge]); continue }
        out.assessments.push({ projectId, runId: run.id, snapshotId: snapshot.id, sourceText: snapshot.answerText ?? '', language: definition.language, queryText: query.queryText, revision: null,
          subject: { key: projectId, name: identity.displayName, aliases: [...names], identityAliases: [], urls: [...urls], mentionNotApplicable }, edges: [edge] })
      }
    }
    // Complete source admission already proved every frozen slot. Coverage of this
    // selected class/scope counts each answer-provider slot once across subjects.
    const selectedSlots = new Set(out.assessments.slice(beforeAssessments).map(item => item.snapshotId)).size
    out.sourceCoverage.expected = beforeCoverage.expected + selectedSlots
    out.sourceCoverage.completed = beforeCoverage.completed + selectedSlots

  }
  return out
}

function runSnapshots(db: DatabaseClient, runId: string): SourceSnapshot[] {
  return db.select(sourceSnapshotColumns).from(querySnapshots).where(eq(querySnapshots.runId, runId)).all()
}

/** Only an execution-time stamp is language provenance; a blank or absent value is legacy. */
function frozenRunLanguage(run: SourceRun): string | null {
  const language: unknown = (run.measurementExecutionIdentity as { language?: unknown } | null)?.language
  return typeof language === 'string' && language.trim() ? language : null
}

/** Null means the revision is missing, unreadable, or not v2: legacy provenance either way. */
function indexedPlan(db: DatabaseClient, projectId: string, versionId: string, cache: PlanCache): IndexedPlan | null {
  const cached = cache.get(versionId)
  if (cached !== undefined) return cached
  const row = db.select({ revision: measurementPlanVersions.revision, canonicalJson: measurementPlanVersions.canonicalJson }).from(measurementPlanVersions).where(and(eq(measurementPlanVersions.id, versionId), eq(measurementPlanVersions.projectId, projectId))).get()
  let plan
  try { plan = row ? parseStoredMeasurementPlanAnyVersion(JSON.parse(row.canonicalJson)) : null } catch { plan = null }
  if (!row || plan?.schemaVersion !== 2) { cache.set(versionId, null); return null }
  const nodes = new Map<string, MeasurementV2ExecutionNode>(), targets = new Map<string, MeasurementV2Target>()
  for (const node of plan.executionNodes) keep(nodes, node.stableKey, node)
  for (const target of plan.targets) keep(targets, target.stableKey, target)
  const assignments = new Map<string, MeasurementV2Assignment>(), queryTexts = new Map<string, string>()
  for (const assignment of plan.assignments) keep(assignments, measurementV2UsageEdgeKey(assignment), assignment)
  for (const query of plan.querySnapshots) keep(queryTexts, query.queryId, query.queryText)
  const groupKeys = new Map<string, string[]>(), marketKeys = new Map<string, string[]>()
  for (const group of plan.groups) for (const targetKey of new Set(group.targetKeys)) append(groupKeys, targetKey, group.stableKey)
  for (const scope of plan.reportingScopes ?? []) for (const edgeKey of new Set(scope.usageEdges.map(measurementV2UsageEdgeKey))) append(marketKeys, edgeKey, scope.stableKey)
  const usages: IndexedUsage[] = [], usagesByNodeTarget = new Map<string, IndexedUsage[]>()
  for (const edge of plan.usageEdges) {
    const edgeKey = measurementV2UsageEdgeKey(edge)
    const usage = { edge, assignment: assignments.get(edgeKey), queryText: queryTexts.get(edge.queryId), marketKeys: marketKeys.get(edgeKey) ?? [] }
    usages.push(usage); append(usagesByNodeTarget, pairKey(edge.executionNodeKey, edge.targetKey), usage)
  }
  const indexed: IndexedPlan = { revision: row.revision, plan, usages, nodes, targets, usagesByNodeTarget, groupKeys }
  cache.set(versionId, indexed)
  return indexed
}

/** Missing slots still belong to the selected frozen class/scope, never to every project query. */
function selectedSlotCoverage(db: DatabaseClient, projectId: string, run: SourceRun, filters: SentimentSourceFilter, plans: PlanCache) {
  const expected = new Set<string>(), completed = new Set<string>()
  if (run.status === 'failed') return { expected: 0, completed: 0 }
  const snapshots = db.select({ queryId: querySnapshots.queryId, queryText: querySnapshots.queryText, provider: querySnapshots.provider, servedModel: querySnapshots.servedModel, measurementExecutionId: querySnapshots.measurementExecutionId }).from(querySnapshots).where(eq(querySnapshots.runId, run.id)).all()
  const count = (key: string, edge: SentimentSourceEdge, recorded: boolean) => {
    if (!matchesSentimentEdge(edge, filters)) return
    expected.add(key); if (recorded) completed.add(key)
  }
  if (run.measurementPlanVersionId) {
    const indexed = indexedPlan(db, projectId, run.measurementPlanVersionId, plans)
    if (!indexed || filters.revision !== undefined && indexed.revision !== filters.revision) return { expected: 0, completed: 0 }
    const bySlot = new Map<string, (typeof snapshots)[number]>()
    for (const snapshot of snapshots) if (snapshot.measurementExecutionId !== null) keep(bySlot, pairKey(snapshot.measurementExecutionId, snapshot.provider), snapshot)
    const scopedTargets = run.measurementScope?.resolvedTargets.length ? new Set(run.measurementScope.resolvedTargets) : null
    const scopedQueries = run.measurementScope?.queries.length ? new Set(run.measurementScope.queries) : null
    for (const { edge: usage, assignment, marketKeys } of indexed.usages) {
      if (scopedQueries && !scopedQueries.has(usage.queryId)) continue
      const node = indexed.nodes.get(usage.executionNodeKey)
      const target = indexed.targets.get(usage.targetKey)
      if (!node || !target || !assignment) continue
      if (scopedTargets && !scopedTargets.has(target.stableKey)) continue
      for (const provider of node.context.providers) {
        const snapshot = bySlot.get(pairKey(node.stableKey, provider))
        count(`${node.stableKey}:${provider}`, { queryKey: usage.queryId, queryText: node.queryText, executionNodeKey: node.stableKey, queryClass: assignment.queryClass, propertyKey: target.stableKey, groupKeys: [...(indexed.groupKeys.get(target.stableKey) ?? [])], marketKeys: [...marketKeys], provider, sourceModel: node.context.models[provider] ?? null, servedModel: snapshot?.servedModel ?? null, context: node.context.location }, Boolean(snapshot))
      }
    }
  } else {
    if (filters.revision !== undefined || filters.scope && filters.scope !== 'project' || filters.marketKey) return { expected: 0, completed: 0 }
    const row = db.select({ definition: simpleMeasurementDefinitions.definition }).from(simpleMeasurementDefinitions).where(eq(simpleMeasurementDefinitions.runId, run.id)).get()
    const stored = simpleMeasurementDefinitionSchema.safeParse(row?.definition)
    if (!stored.success) return { expected: 0, completed: 0 }
    const sourceQuery = simpleSourceQueries(stored.data)
    const bySlot = new Map<string, (typeof snapshots)[number]>()
    for (const snapshot of snapshots) { const query = sourceQuery(snapshot); if (query) keep(bySlot, simpleSlotKey(query.queryId, snapshot.provider), snapshot) }
    for (const query of stored.data.queries) for (const engine of stored.data.engines) {
      if (!query.queryClass) continue
      const snapshot = bySlot.get(simpleSlotKey(query.queryId, engine.provider))
      count(`${query.queryId}:${engine.provider}`, { queryKey: query.queryId, queryText: query.queryText, executionNodeKey: null, queryClass: query.queryClass, propertyKey: run.projectId, groupKeys: [], marketKeys: [], provider: engine.provider, sourceModel: engine.requestedModel, servedModel: snapshot?.servedModel ?? null, context: stored.data.location }, Boolean(snapshot))
    }
  }
  return { expected: expected.size, completed: completed.size }
}

export function matchesSentimentEdge(edge: SentimentSourceEdge, filters: SentimentSourceFilter): boolean {
  if (edge.queryClass !== (filters.queryClass ?? 'branded')) return false
  if (filters.queryId && edge.queryKey !== filters.queryId) return false
  if (filters.executionNodeKey && edge.executionNodeKey !== filters.executionNodeKey) return false
  if (filters.provider && edge.provider !== filters.provider) return false
  if (filters.sourceModel && edge.servedModel !== filters.sourceModel) return false
  if (filters.location && (filters.location === 'none' ? edge.context !== null : edge.context?.label !== filters.location)) return false
  if (filters.marketKey && !edge.marketKeys.includes(filters.marketKey)) return false
  if (filters.scopeKey) {
    if (filters.scope === 'property' && edge.propertyKey !== filters.scopeKey) return false
    if (filters.scope === 'group' && !edge.groupKeys.includes(filters.scopeKey)) return false
    if (filters.scope === 'market' && !edge.marketKeys.includes(filters.scopeKey)) return false
  }
  return true
}

const simpleSlotKey = (queryId: string | undefined, provider: string) => `${queryId}\0${provider}`

/** Deleted live queries retain snapshot-time text; only an unambiguous frozen match is usable. */
function simpleSourceQueries(definition: SimpleMeasurementDefinition) {
  type Query = SimpleMeasurementDefinition['queries'][number]
  const byId = new Map<string, Query>(), byText = new Map<string, Query[]>()
  for (const query of definition.queries) { keep(byId, query.queryId, query); append(byText, query.queryText, query) }
  return (snapshot: { queryId: string | null; queryText: string | null }): Query | undefined => {
    const identified = snapshot.queryId ? byId.get(snapshot.queryId) : undefined
    if (identified) return identified
    const matches = snapshot.queryText === null ? [] : byText.get(snapshot.queryText) ?? []
    return matches.length === 1 ? matches[0] : undefined
  }
}
