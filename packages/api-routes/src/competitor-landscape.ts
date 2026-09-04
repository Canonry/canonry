import { and, eq, gte, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  competitors,
  domainClassifications,
  measurementPlanVersions,
  querySnapshots,
  queries,
  runs,
} from '@ainyc/canonry-db'
import {
  brandLabelFromDomain,
  competitorLandscapeQuerySchema,
  hostOf,
  parseStoredMeasurementPlanAnyVersion,
  parseWindow,
  registrableDomain,
  RunKinds,
  RunStatuses,
  measurementDraftEtag,
  normalizeMeasurementExecutionQueryText,
  surfaceClassFromCompetitorType,
  validationError,
  windowCutoff,
  type CompetitorLandscapeQueryClass,
  type CompetitorLandscapeResponse,
} from '@ainyc/canonry-contracts'
import { buildCompetitorLandscapeHistory, type CompetitorLandscapeSurfaceClass } from '@ainyc/canonry-intelligence'
import { resolveProject, resolveSnapshotAnswerMentioned } from './helpers.js'
import { projectQueryClassifier } from './mention-share-inputs.js'
import { activeMeasurementPlan } from './measurement-overview.js'
import { draftRow, parseStoredAuthoring } from './measurement-draft-repo.js'

type RawQuery = {
  window?: string
  groupKey?: string
  scope?: string
  provider?: string
  queryClass?: string
  location?: string
  runId?: string
}

interface FrozenPlanScope {
  executionNodeKeys: Set<string>
  queryClasses: Map<string, Set<'branded' | 'non-brand'>>
  queryClassesByText: Map<string, Set<'branded' | 'non-brand'>>
  competitors: Array<{ domain: string; label: string; aliases: string[] }>
}

interface AdvancedScope {
  kind: 'group' | 'all-markets'
  groupKey?: string
  activePinned: Array<{ domain: string; label: string; aliases: string[] }>
  pendingPins: Array<{ domain: string; label: string; aliases: string[] }>
  activeRevision: number
  draft: { etag: string; pendingCompetitorDomains: string[] } | null
  runScopes: Map<string, FrozenPlanScope>
}

/** Pins are always complete; ranked historical discovery/source lists are bounded. */
export const COMPETITOR_LANDSCAPE_RANKED_ROW_LIMIT = 100

/**
 * Read-time competitor landscape over persisted snapshots only. This route does
 * no discovery, classification, provider request, or write — pinning changes
 * which stored evidence is presented, not what was measured.
 */
export async function competitorLandscapeRoutes(app: FastifyInstance) {
  app.get<{
    Params: { name: string }
    Querystring: RawQuery
  }>('/projects/:name/analytics/competitors', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)
    const parsed = competitorLandscapeQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      throw validationError('Invalid competitor landscape query', { issues: parsed.error.issues })
    }
    const filters = parsed.data
    const window = parseWindow(filters.window)
    const cutoff = windowCutoff(window)

    // Pull the selected run population before deciding which observations count.
    // The explicit excluded counts below make probe and non-terminal omission
    // auditable without letting either kind pollute competitive metrics.
    const candidateRuns = app.db.select().from(runs).where(and(
      eq(runs.projectId, project.id),
      eq(runs.kind, RunKinds['answer-visibility']),
      filters.runId ? eq(runs.id, filters.runId) : undefined,
      cutoff ? gte(runs.createdAt, cutoff) : undefined,
    )).all()
    const advanced = filters.groupKey || filters.scope === 'all-markets'
      ? resolveAdvancedScope(app, project.id, filters.groupKey ? 'group' : 'all-markets', filters.groupKey, candidateRuns)
      : null

    const queryTextById = new Map(app.db.select({ id: queries.id, query: queries.query })
      .from(queries)
      .where(eq(queries.projectId, project.id))
      .all()
      .map(row => [row.id, row.query]))
    const queryClassifier = projectQueryClassifier(project)

    const allSnapshots = candidateRuns.length === 0
      ? []
      : app.db.select({
        id: querySnapshots.id,
        runId: querySnapshots.runId,
        queryId: querySnapshots.queryId,
        queryText: querySnapshots.queryText,
        provider: querySnapshots.provider,
        answerMentioned: querySnapshots.answerMentioned,
        answerText: querySnapshots.answerText,
        citedDomains: querySnapshots.citedDomains,
        citedUrls: querySnapshots.citedUrls,
        captureStatus: querySnapshots.captureStatus,
        location: querySnapshots.location,
        measurementExecutionId: querySnapshots.measurementExecutionId,
        createdAt: querySnapshots.createdAt,
      }).from(querySnapshots).where(inArray(querySnapshots.runId, candidateRuns.map(run => run.id))).all()

    const runById = new Map(candidateRuns.map(run => [run.id, run]))
    const inScope = allSnapshots.filter(snapshot => snapshotMatchesFilters({
      snapshot,
      filters,
      advanced,
      queryTextById,
      queryClassifier,
    }))
    const eligibleRuns = new Set(candidateRuns
      .filter(run => run.trigger !== 'probe' && (run.status === RunStatuses.completed || run.status === RunStatuses.partial))
      .map(run => run.id))
    const excludedProbeResults = inScope.filter(snapshot => runById.get(snapshot.runId)?.trigger === 'probe').length
    const excludedNonCompletedResults = inScope.filter(snapshot => {
      const run = runById.get(snapshot.runId)
      return run !== undefined && run.trigger !== 'probe'
        && run.status !== RunStatuses.completed && run.status !== RunStatuses.partial
    }).length
    const snapshots = inScope.filter(snapshot => eligibleRuns.has(snapshot.runId))

    const classificationRows = app.db.select({
      domain: domainClassifications.domain,
      competitorType: domainClassifications.competitorType,
    }).from(domainClassifications).where(eq(domainClassifications.projectId, project.id)).all()
    const classifications = new Map<string, CompetitorLandscapeSurfaceClass>()
    for (const row of classificationRows) {
      const domain = normalizedDomain(row.domain)
      if (!domain) continue
      const storedClass = surfaceClassFromCompetitorType(row.competitorType)
      const surfaceClass: CompetitorLandscapeSurfaceClass = storedClass === 'direct-competitor'
        || storedClass === 'ota-aggregator'
        || storedClass === 'editorial-media'
        || storedClass === 'other'
        ? storedClass
        : 'unknown'
      classifications.set(domain, surfaceClass)
    }

    const projectPins = app.db.select({ domain: competitors.domain })
      .from(competitors)
      .where(eq(competitors.projectId, project.id))
      .all()
      .map(row => ({
        domain: row.domain,
        label: brandLabelFromDomain(row.domain) || row.domain,
        aliases: [],
      }))
    const pinned = mergePins(advanced?.pendingPins ?? [], advanced?.activePinned ?? [], projectPins)
    const historicalDirect = advanced
      ? mergePins(...snapshots.flatMap(snapshot => {
        const frozen = advanced.runScopes.get(snapshot.runId)
        return frozen ? [frozen.competitors] : []
      }))
      : []
    const history = buildCompetitorLandscapeHistory({
      project: {
        domain: project.canonicalDomain,
        label: project.displayName,
        domains: [project.canonicalDomain, ...(project.ownedDomains ?? [])],
      },
      pinned,
      historicalDirect,
      classifications,
      snapshots: snapshots.map(snapshot => ({
        id: snapshot.id,
        createdAt: snapshot.createdAt,
        answerText: snapshot.answerText,
        projectMentioned: resolveSnapshotAnswerMentioned(snapshot, project),
        citedDomains: snapshot.citedDomains,
        citedUrls: snapshot.citedUrls,
      })),
    })
    const incompleteSourceResults = snapshots.filter(snapshot => (
      (snapshot.citedDomains.length > 0 || (snapshot.citedUrls?.length ?? 0) > 0)
      && snapshot.captureStatus !== 'complete'
    )).length
    const observed = history.observed.slice(0, COMPETITOR_LANDSCAPE_RANKED_ROW_LIMIT)
    const otherSources = history.otherSources.slice(0, COMPETITOR_LANDSCAPE_RANKED_ROW_LIMIT)
    const truncated = observed.length !== history.observed.length || otherSources.length !== history.otherSources.length

    const response: CompetitorLandscapeResponse = {
      window,
      scope: advanced?.kind === 'group'
        ? { kind: 'group', groupKey: advanced.groupKey! }
        : advanced?.kind === 'all-markets'
          ? { kind: 'all-markets' }
          : { kind: 'project' },
      ...history,
      observed,
      otherSources,
      evidence: {
        ...history.evidence,
        incompleteSourceResults,
        excludedProbeResults,
        excludedNonCompletedResults,
      },
      marketState: advanced
        ? { activeRevision: advanced.activeRevision, draft: advanced.draft }
        : null,
      filters: {
        scope: advanced?.kind === 'all-markets' ? 'all-markets' : 'project',
        groupKey: advanced?.kind === 'group' ? advanced.groupKey! : null,
        provider: filters.provider ?? null,
        queryClass: filters.queryClass ?? 'all',
        location: filters.location ?? null,
        runId: filters.runId ?? null,
      },
      truncated,
    }
    return reply.send(response)
  })
}

function resolveAdvancedScope(
  app: FastifyInstance,
  projectId: string,
  kind: AdvancedScope['kind'],
  groupKey: string | undefined,
  candidateRuns: readonly typeof runs.$inferSelect[],
): AdvancedScope {
  const active = activeMeasurementPlan(app.db, projectId)
  if (!active || active.plan.schemaVersion !== 2) {
    throw validationError('Advanced competitor landscapes require an active v2 measurement plan.')
  }
  if (kind === 'group' && (!groupKey || !active.plan.groups.some(group => group.stableKey === groupKey))) {
    throw validationError(`Unknown Advanced Measurement group "${groupKey ?? ''}".`)
  }
  const planVersionIds = [...new Set(candidateRuns
    .map(run => run.measurementPlanVersionId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0))]
  const historicalVersions = planVersionIds.length === 0
    ? []
    : app.db.select().from(measurementPlanVersions).where(and(
      eq(measurementPlanVersions.projectId, projectId),
      inArray(measurementPlanVersions.id, planVersionIds),
    )).all()
  const frozenByVersionId = new Map(historicalVersions.map(version => [
    version.id,
    scopeForFrozenPlan(parseStoredMeasurementPlanAnyVersion(version.canonicalJson), kind, groupKey),
  ]))
  const runScopes = new Map<string, FrozenPlanScope>()
  for (const run of candidateRuns) {
    if (!run.measurementPlanVersionId) continue
    const frozen = frozenByVersionId.get(run.measurementPlanVersionId)
    if (frozen) runScopes.set(run.id, frozen)
  }
  const activeScope = scopeForFrozenPlan(active.plan, kind, groupKey)
  if (!activeScope) throw validationError('The active Advanced Measurement plan cannot resolve this market scope.')
  const draft = draftRow(app.db, projectId)
  const pendingPins = draft
    ? pendingDraftPins(parseStoredAuthoring(draft.authoringJson), active.plan, kind, groupKey)
    : []
  return {
    kind,
    ...(kind === 'group' ? { groupKey: groupKey! } : {}),
    activePinned: activeScope.competitors,
    pendingPins,
    activeRevision: active.version.revision,
    draft: draft ? {
      etag: measurementDraftEtag(draft.etagVersion),
      pendingCompetitorDomains: pendingPins.map(competitor => competitor.domain),
    } : null,
    runScopes,
  }
}

function scopeForFrozenPlan(
  plan: ReturnType<typeof parseStoredMeasurementPlanAnyVersion>,
  kind: AdvancedScope['kind'],
  groupKey: string | undefined,
): FrozenPlanScope | null {
  if (plan.schemaVersion !== 2) return null
  const groups = kind === 'group'
    ? plan.groups.filter(group => group.stableKey === groupKey)
    : plan.groups
  if (groups.length === 0) return null
  const targetKeys = new Set(groups.flatMap(group => group.targetKeys))
  const executionNodeKeys = new Set(plan.usageEdges
    .filter(edge => targetKeys.has(edge.targetKey))
    .map(edge => edge.executionNodeKey))
  const queryClasses = new Map<string, Set<'branded' | 'non-brand'>>()
  for (const assignment of plan.assignments) {
    if (!targetKeys.has(assignment.targetKey)) continue
    const classes = queryClasses.get(assignment.queryId) ?? new Set<'branded' | 'non-brand'>()
    classes.add(assignment.queryClass)
    queryClasses.set(assignment.queryId, classes)
  }
  const queryClassesByText = new Map<string, Set<'branded' | 'non-brand'>>()
  for (const snapshot of plan.querySnapshots) {
    const classes = queryClasses.get(snapshot.queryId)
    if (!classes) continue
    const normalizedText = normalizeMeasurementExecutionQueryText(snapshot.queryText)
    const classesForText = queryClassesByText.get(normalizedText) ?? new Set<'branded' | 'non-brand'>()
    for (const queryClass of classes) classesForText.add(queryClass)
    queryClassesByText.set(normalizedText, classesForText)
  }
  return {
    executionNodeKeys,
    queryClasses,
    queryClassesByText,
    competitors: groups.flatMap(group => group.competitors.map(competitor => ({
      domain: competitor.domain,
      label: competitor.label,
      aliases: competitor.aliases,
    }))),
  }
}

function pendingDraftPins(
  authoring: ReturnType<typeof parseStoredAuthoring>,
  activePlan: Extract<ReturnType<typeof parseStoredMeasurementPlanAnyVersion>, { schemaVersion: 2 }>,
  kind: AdvancedScope['kind'],
  groupKey: string | undefined,
): Array<{ domain: string; label: string; aliases: string[] }> {
  const groups = kind === 'group'
    ? authoring.groups.filter(group => group.stableKey === groupKey)
    : authoring.groups
  const activeGroups = new Map(activePlan.groups.map(group => [group.stableKey, group]))
  return mergePins(...groups.map(group => {
    const activeDomains = new Set((activeGroups.get(group.stableKey)?.competitors ?? [])
      .map(competitor => normalizedDomain(competitor.domain))
      .filter((domain): domain is string => domain !== null))
    return group.competitors.flatMap(competitor => {
      const domain = normalizedDomain(competitor.domain)
      if (!domain || activeDomains.has(domain)) return []
      return [{
        domain: competitor.domain,
        label: competitor.label,
        aliases: competitor.aliases,
      }]
    })
  }))
}

function snapshotMatchesFilters(input: {
  snapshot: {
    queryId: string | null
    queryText: string | null
    provider: string
    location: string | null
    measurementExecutionId: string | null
  }
  filters: { provider?: string; location?: string; queryClass?: CompetitorLandscapeQueryClass }
  advanced: AdvancedScope | null
  queryTextById: ReadonlyMap<string, string>
  queryClassifier: ((queryText: string | null | undefined) => 'branded' | 'non-brand') | null
}): boolean {
  const { snapshot, filters, advanced, queryTextById, queryClassifier } = input
  if (filters.provider && snapshot.provider !== filters.provider) return false
  if (filters.location && snapshot.location !== filters.location) return false
  if (advanced) {
    const frozen = advanced.runScopes.get((snapshot as { runId?: string }).runId ?? '')
    if (!frozen || !snapshot.measurementExecutionId || !frozen.executionNodeKeys.has(snapshot.measurementExecutionId)) return false
    if (filters.queryClass && filters.queryClass !== 'all') {
      const queryClasses = snapshot.queryId
        ? frozen.queryClasses.get(snapshot.queryId)
        : snapshot.queryText
          ? frozen.queryClassesByText.get(normalizeMeasurementExecutionQueryText(snapshot.queryText))
          : undefined
      if (!queryClasses?.has(filters.queryClass)) return false
    }
    return true
  }
  if (filters.queryClass && filters.queryClass !== 'all') {
    if (!queryClassifier) return false
    const queryText = (snapshot.queryId ? queryTextById.get(snapshot.queryId) : undefined) ?? snapshot.queryText
    if (queryClassifier(queryText) !== filters.queryClass) return false
  }
  return true
}

function normalizedDomain(value: string): string | null {
  return registrableDomain(value) || hostOf(value)
}

function mergePins(
  ...collections: ReadonlyArray<ReadonlyArray<{ domain: string; label: string; aliases: string[] }>>
): Array<{ domain: string; label: string; aliases: string[] }> {
  const result: Array<{ domain: string; label: string; aliases: string[] }> = []
  const seen = new Set<string>()
  for (const candidate of collections.flat()) {
    const domain = normalizedDomain(candidate.domain)
    if (!domain || seen.has(domain)) continue
    seen.add(domain)
    result.push(candidate)
  }
  return result
}
