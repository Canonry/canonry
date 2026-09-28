/** Frozen source selection; this module never reads live project identity or calls a provider. */
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm'
import {
  measurementV2UsageEdgeKey, parseStoredMeasurementPlanAnyVersion,
  simpleMeasurementDefinitionSchema, validationError,
  type LocationContext,
} from '@ainyc/canonry-contracts'
import { measurementPlanVersions, querySnapshots, runs, simpleMeasurementDefinitions, sentimentCompletionReceipts, type DatabaseClient } from '@ainyc/canonry-db'
import { measurementRunSlotState } from './measurement-run-completeness.js'

export interface SentimentSourceFilter {
  runId?: string; runIds?: string[]; since?: string; until?: string; revision?: number; mode?: 'auto' | 'simple' | 'advanced'
  queryClass?: 'branded' | 'non-brand' | 'all'; scope?: string; scopeKey?: string
  marketKey?: string; provider?: string; sourceModel?: string; location?: string
}
export interface SentimentSourceEdge {
  queryKey: string; queryClass: 'branded' | 'non-brand'; propertyKey: string
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
}

export function selectSentimentSources(db: DatabaseClient, projectId: string, filters: SentimentSourceFilter): SentimentSourceSelection {
  if (filters.scope && filters.scope !== 'project' && !filters.scopeKey) throw validationError('A scopeKey is required for property, group, and market sentiment selections.')
  const requestedIds = filters.runIds ?? (filters.runId ? [filters.runId] : undefined)
  if (requestedIds && (requestedIds.length === 0 || requestedIds.length > 100)) throw validationError('Select between 1 and 100 runs.')
  const conditions = [eq(runs.projectId, projectId)]
  if (requestedIds) conditions.push(inArray(runs.id, requestedIds))
  if (filters.since) conditions.push(gte(runs.createdAt, filters.since))
  if (filters.until) conditions.push(lte(runs.createdAt, filters.until))
  const selectedRuns = db.select().from(runs).where(and(...conditions)).orderBy(desc(runs.createdAt)).limit(101).all()
  if (selectedRuns.length > 100) throw validationError('Selection exceeds 100 runs; narrow the date range.')
  if (requestedIds && new Set(selectedRuns.map(row => row.id)).size !== new Set(requestedIds).size) throw validationError('One or more selected runs are unavailable in this project.')
  const out: SentimentSourceSelection = { assessments: [], runIds: selectedRuns.map(row => row.id), sourceCoverage: { expected: 0, completed: 0 }, skipped: {} }
  const skip = (reason: string, count = 1) => { out.skipped[reason] = (out.skipped[reason] ?? 0) + count }
  for (const run of selectedRuns) {
    if (run.trigger === 'probe') { skip('probe'); continue }
    if (run.kind !== 'answer-visibility') { skip('unsupported-run-kind'); continue }
    if (filters.mode === 'simple' && run.measurementPlanVersionId || filters.mode === 'advanced' && !run.measurementPlanVersionId) continue
    const completedSuperseded = run.status === 'superseded' && Boolean(db.select().from(sentimentCompletionReceipts).where(and(eq(sentimentCompletionReceipts.projectId, projectId), eq(sentimentCompletionReceipts.runId, run.id))).get())
    if (run.status !== 'completed' && !completedSuperseded) {
      if (run.status !== 'failed') {
        if (run.measurementPlanVersionId) {
          const progress = measurementRunSlotState(db, run.id)
          out.sourceCoverage.expected += progress.expected.length
          out.sourceCoverage.completed += progress.executed
        } else {
          const stored = db.select().from(simpleMeasurementDefinitions).where(eq(simpleMeasurementDefinitions.runId, run.id)).get()
          const definition = simpleMeasurementDefinitionSchema.safeParse(stored?.definition)
          if (definition.success) {
            const expected = definition.data.queries.flatMap(query => definition.data.engines.map(engine => `${query.queryId}\0${engine.provider}`))
            const recorded = new Set(db.select().from(querySnapshots).where(eq(querySnapshots.runId, run.id)).all().map(snapshot => `${snapshot.queryId}\0${snapshot.provider}`))
            out.sourceCoverage.expected += expected.length
            out.sourceCoverage.completed += expected.filter(key => recorded.has(key)).length
          }
        }
      }
      skip(run.status === 'failed' ? 'failed-run' : 'incomplete-run'); continue
    }
    const snapshots = db.select().from(querySnapshots).where(eq(querySnapshots.runId, run.id)).all()
    if (run.measurementPlanVersionId) {
      const row = db.select().from(measurementPlanVersions).where(and(eq(measurementPlanVersions.id, run.measurementPlanVersionId), eq(measurementPlanVersions.projectId, projectId))).get()
      if (!row) { skip('legacy-missing-provenance'); continue }
      let plan
      try { plan = parseStoredMeasurementPlanAnyVersion(JSON.parse(row.canonicalJson)) } catch { skip('legacy-missing-provenance'); continue }
      if (plan.schemaVersion !== 2) { skip('legacy-missing-provenance'); continue }
      if (filters.revision !== undefined && row.revision !== filters.revision) continue
      const slots = measurementRunSlotState(db, run.id)
      out.sourceCoverage.expected += slots.expected.length
      out.sourceCoverage.completed += slots.executed
      if (!slots.planned || !slots.readable || slots.missing.length > 0 || slots.hasUnboundSnapshot) { skip('incomplete-run'); continue }
      for (const snapshot of snapshots) {
        const node = plan.executionNodes.find(item => item.stableKey === snapshot.measurementExecutionId)
        if (!node) continue
        for (const target of plan.targets) {
          const edges: SentimentSourceEdge[] = []
          for (const edge of plan.usageEdges.filter(item => item.executionNodeKey === node.stableKey && item.targetKey === target.stableKey)) {
            const assignment = plan.assignments.find(item => item.executionNodeKey === edge.executionNodeKey && item.targetKey === edge.targetKey && item.queryId === edge.queryId)
            if (!assignment) { skip('legacy-missing-provenance'); continue }
            const candidate: SentimentSourceEdge = {
              queryKey: edge.queryId, queryClass: assignment.queryClass, propertyKey: target.stableKey,
              groupKeys: plan.groups.filter(item => item.targetKeys.includes(target.stableKey)).map(item => item.stableKey),
              marketKeys: (plan.reportingScopes ?? []).filter(item => item.usageEdges.some(member => measurementV2UsageEdgeKey(member) === measurementV2UsageEdgeKey(edge))).map(item => item.stableKey),
              provider: snapshot.provider, sourceModel: snapshot.model, servedModel: snapshot.servedModel, context: node.context.location,
            }
            if (matchesSentimentEdge(candidate, filters)) edges.push(candidate)
          }
          if (!edges.length) continue
          out.assessments.push({ projectId, runId: run.id, snapshotId: snapshot.id, sourceText: snapshot.answerText ?? '', language: (run.measurementExecutionIdentity as { language?: string } | null)?.language ?? 'unknown', queryText: node.queryText, revision: row.revision,
            subject: { key: target.stableKey, name: target.label, aliases: target.aliases, identityAliases: target.identityAliases ?? [], urls: target.urlMatchers.map(item => item.kind === 'exact' ? item.url : `https://${item.host}${item.kind === 'prefix' ? item.pathPrefix : '/'}`), mentionNotApplicable: target.mentionNotApplicable }, edges })
        }
      }
    } else {
      if (filters.revision !== undefined || (filters.scope && !['project', 'portfolio', 'all'].includes(filters.scope)) || filters.marketKey) continue
      const stored = db.select().from(simpleMeasurementDefinitions).where(and(eq(simpleMeasurementDefinitions.runId, run.id), eq(simpleMeasurementDefinitions.projectId, projectId))).get()
      const parsed = simpleMeasurementDefinitionSchema.safeParse(stored?.definition)
      if (!parsed.success) { skip('legacy-missing-provenance'); continue }
      const definition = parsed.data
      const expected = definition.queries.flatMap(query => definition.engines.map(engine => `${query.queryId}\0${engine.provider}`))
      const recorded = new Set(snapshots.map(snapshot => `${snapshot.queryId}\0${snapshot.provider}`))
      out.sourceCoverage.expected += expected.length
      out.sourceCoverage.completed += expected.filter(key => recorded.has(key)).length
      if (!expected.length || expected.some(key => !recorded.has(key)) || snapshots.some(snapshot => !expected.includes(`${snapshot.queryId}\0${snapshot.provider}`))) { skip('incomplete-run'); continue }
      for (const snapshot of snapshots) {
        const query = definition.queries.find(item => item.queryId === snapshot.queryId)
        if (!query?.queryClass) { skip('legacy-missing-provenance'); continue }
        const edge: SentimentSourceEdge = { queryKey: query.queryId, queryClass: query.queryClass, propertyKey: projectId, groupKeys: [], marketKeys: [], provider: snapshot.provider, sourceModel: snapshot.model, servedModel: snapshot.servedModel, context: definition.location }
        if (!matchesSentimentEdge(edge, filters)) continue
        out.assessments.push({ projectId, runId: run.id, snapshotId: snapshot.id, sourceText: snapshot.answerText ?? '', language: definition.language, queryText: query.queryText, revision: null,
          subject: { key: projectId, name: definition.identity.displayName, aliases: definition.identity.aliases, identityAliases: [], urls: [definition.identity.canonicalDomain, ...definition.identity.ownedDomains], mentionNotApplicable: !definition.identity.displayName.trim() && !definition.identity.aliases.some(alias => alias.trim()) }, edges: [edge] })
      }
    }
  }
  return out
}

export function matchesSentimentEdge(edge: SentimentSourceEdge, filters: SentimentSourceFilter): boolean {
  if (edge.queryClass !== (filters.queryClass ?? 'branded')) return false
  if (edge.queryClass !== 'branded') return false
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
