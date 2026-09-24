import { and, eq, gte, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  competitors,
  domainClassifications,
  measurementPlanVersions,
  querySnapshots,
  queries,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import {
  brandLabelFromDomain,
  competitorLandscapeQuerySchema,
  COMPETITOR_LANDSCAPE_MODEL_GROUP_LIMIT,
  COMPETITOR_LANDSCAPE_OBSERVED_NAME_LIMIT,
  hostOf,
  parseStoredMeasurementPlanAnyVersion,
  parseWindow,
  registrableDomain,
  RunKinds,
  RunStatuses,
  measurementDraftEtag,
  surfaceClassFromCompetitorType,
  validationError,
  windowCutoff,
  type CompetitorLandscapeQueryClass,
  type CompetitorLandscapeModelComparison,
  type CompetitorLandscapeResponse,
} from '@ainyc/canonry-contracts'
import { buildCompetitorLandscapeHistory, type CompetitorLandscapeIdentity, type CompetitorLandscapeSurfaceClass } from '@ainyc/canonry-intelligence'
import { resolveProject } from './helpers.js'
import { buildMentionShareInputs, observedCompetitorNames, projectQueryClassifier } from './mention-share-inputs.js'
import { activeMeasurementPlan } from './measurement-overview.js'
import { draftRow, parseStoredAuthoring } from './measurement-draft-repo.js'
import { classifyModelEvidence } from './model-evidence.js'

type RawQuery = {
  window?: string
  groupKey?: string
  scope?: string
  provider?: string
  model?: string
  groupBy?: string
  queryClass?: string
  location?: string
  runId?: string
}

interface LandscapePin extends CompetitorLandscapeIdentity {
  aliases: string[]
}

interface FrozenPlanScope {
  executionNodeKeys: Set<string>
  queryClassesByExecution: Map<string, Set<'branded' | 'non-brand'>>
  competitors: LandscapePin[]
}

interface AdvancedScope {
  kind: 'group' | 'all-markets'
  groupKey?: string
  activePinned: LandscapePin[]
  pendingPins: LandscapePin[]
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
  }>('/projects/:name/analytics/competitors', async (request) => {
    return readCompetitorLandscape(app, request.params.name, request.query)
  })
}

/** Internal readers may pin a run/answer population without changing scope rules. */
export function readCompetitorLandscape(
  app: Pick<FastifyInstance, 'db'>,
  projectName: string,
  query: RawQuery,
  selection?: { runIds: readonly string[]; snapshotIds?: readonly string[]; autoAdvanced?: boolean },
): CompetitorLandscapeResponse {
    const project = resolveProject(app.db, projectName)
    const parsed = competitorLandscapeQuerySchema.safeParse(query)
    if (!parsed.success) {
      throw validationError('Invalid competitor landscape query', { issues: parsed.error.issues })
    }
    const filters = parsed.data
    // A class split on a v2 project must use the plan's frozen assignment
    // classes. The text classifier disagrees with them (a plan can mark a query
    // branded that names no brand alias, and the reverse), so a project-scope
    // read would report a different non-brand base than every plan surface.
    // An explicit `scope` or `groupKey` still wins.
    const classSplitByDefault = filters.scope === undefined && filters.groupKey === undefined
      && filters.queryClass !== undefined && filters.queryClass !== 'all'
    if ((selection?.autoAdvanced || classSplitByDefault)
      && activeMeasurementPlan(app.db, project.id)?.plan.schemaVersion === 2) filters.scope = 'all-markets'
    const window = parseWindow(filters.window)
    const cutoff = windowCutoff(window)

    // Pull the selected run population before deciding which observations count.
    // The explicit excluded counts below make probe and non-terminal omission
    // auditable without letting either kind pollute competitive metrics.
    const candidateRuns = app.db.select().from(runs).where(and(
      eq(runs.projectId, project.id),
      eq(runs.kind, RunKinds['answer-visibility']),
      selection ? inArray(runs.id, [...selection.runIds]) : undefined,
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
    // Simple projects split classes from the query text. Without a usable brand
    // alias there is no split, and every result would silently fail the class
    // filter and read as an empty landscape rather than as an unanswerable one.
    if (!advanced && filters.queryClass && filters.queryClass !== 'all' && !queryClassifier) {
      throw validationError(
        `Query class "${filters.queryClass}" needs a brand name or alias on this project. Add one, or omit queryClass for a pooled landscape.`,
      )
    }

    const allSnapshots = candidateRuns.length === 0
      ? []
      : app.db.select({
        id: querySnapshots.id,
        runId: querySnapshots.runId,
        queryId: querySnapshots.queryId,
        queryText: querySnapshots.queryText,
        provider: querySnapshots.provider,
        model: querySnapshots.model,
        servedModel: querySnapshots.servedModel,
        answerMentioned: querySnapshots.answerMentioned,
        answerText: querySnapshots.answerText,
        recommendedCompetitors: querySnapshots.recommendedCompetitors,
        citedDomains: querySnapshots.citedDomains,
        citedUrls: querySnapshots.citedUrls,
        captureStatus: querySnapshots.captureStatus,
        location: querySnapshots.location,
        measurementExecutionId: querySnapshots.measurementExecutionId,
        createdAt: querySnapshots.createdAt,
      }).from(querySnapshots).where(inArray(querySnapshots.runId, candidateRuns.map(run => run.id))).all()

    const runById = new Map(candidateRuns.map(run => [run.id, run]))
    const selectedIds = selection?.snapshotIds ? new Set(selection.snapshotIds) : null
    const inScope = allSnapshots.filter(snapshot => (!selectedIds || selectedIds.has(snapshot.id)) && snapshotMatchesFilters({
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
      // Classifications are persisted per exact cited host. Keep that identity
      // here; the history engine resolves deterministic eTLD+1 conflicts.
      const domain = hostOf(row.domain)
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
        labelSource: 'domain' as const,
        aliases: [],
      }))
    const pinned = mergePins(advanced?.pendingPins ?? [], advanced?.activePinned ?? [], projectPins)
    const buildHistory = (selectedSnapshots: typeof snapshots) => {
      const inputs = buildMentionShareInputs({ project, competitorDomains: [], snapshots: selectedSnapshots, queryTextById })
      // Sorted by answer count, so the cap keeps the most-named. On a large
      // portfolio the full list runs to thousands of names.
      const allObservedNames = observedCompetitorNames(selectedSnapshots)
      return {
        observedNames: allObservedNames.slice(0, COMPETITOR_LANDSCAPE_OBSERVED_NAME_LIMIT),
        observedNamesTotal: allObservedNames.length,
        ...buildCompetitorLandscapeHistory({
          project: {
            domain: project.canonicalDomain,
            label: project.displayName,
            domains: [project.canonicalDomain, ...(project.ownedDomains ?? [])],
          },
          pinned,
          classifications,
          // Share of voice needs one query class behind it. `all` pools branded
          // and non-brand, so withhold the ratio and publish the counts instead.
          shareOfVoiceEligible: filters.queryClass !== undefined && filters.queryClass !== 'all',
          snapshots: selectedSnapshots.map((snapshot, i) => ({
            id: snapshot.id,
            createdAt: snapshot.createdAt,
            answerText: snapshot.answerText,
            projectMentioned: inputs.snapshots[i]!.projectMentioned,
            citedDomains: snapshot.citedDomains,
            citedUrls: snapshot.citedUrls,
            ...(advanced ? { frozenCompetitors: advanced.runScopes.get(snapshot.runId)?.competitors ?? [] } : {}),
          })),
        }),
      }
    }
    const history = buildHistory(snapshots)
    const countIncompleteSources = (selectedSnapshots: typeof snapshots) => selectedSnapshots.filter(snapshot => (
      (snapshot.citedDomains.length > 0 || (snapshot.citedUrls?.length ?? 0) > 0)
      && snapshot.captureStatus !== 'complete'
    )).length
    const incompleteSourceResults = countIncompleteSources(snapshots)
    const observed = history.observed.slice(0, COMPETITOR_LANDSCAPE_RANKED_ROW_LIMIT)
    const otherSources = history.otherSources.slice(0, COMPETITOR_LANDSCAPE_RANKED_ROW_LIMIT)
    const truncated = observed.length !== history.observed.length || otherSources.length !== history.otherSources.length

    let modelComparison: CompetitorLandscapeModelComparison | undefined
    if (filters.groupBy === 'model') {
      // Only observed, eligible models form groups. A configured model or an
      // excluded-only result is not a measured zero. JSON tuple keys prevent
      // equal model IDs under different providers from collapsing together.
      const modelGroups = new Map<string, {
        provider: string
        model: string | null
        snapshots: typeof snapshots
      }>()
      for (const snapshot of snapshots) {
        const model = requestedModel(snapshot.model)
        const key = JSON.stringify([snapshot.provider, model])
        const group = modelGroups.get(key)
        if (group) group.snapshots.push(snapshot)
        else modelGroups.set(key, { provider: snapshot.provider, model, snapshots: [snapshot] })
      }
      const excludedByModel = new Map<string, { probes: number; nonCompleted: number }>()
      for (const snapshot of inScope) {
        if (eligibleRuns.has(snapshot.runId)) continue
        const key = JSON.stringify([snapshot.provider, requestedModel(snapshot.model)])
        const excluded = excludedByModel.get(key) ?? { probes: 0, nonCompleted: 0 }
        if (runById.get(snapshot.runId)?.trigger === 'probe') excluded.probes++
        else excluded.nonCompleted++
        excludedByModel.set(key, excluded)
      }
      const sortedGroups = [...modelGroups.values()].sort((left, right) => (
        compareStoredIds(left.provider, right.provider)
        || (left.model === null ? (right.model === null ? 0 : -1)
          : right.model === null ? 1 : compareStoredIds(left.model, right.model))
      ))
      const groups = sortedGroups.slice(0, COMPETITOR_LANDSCAPE_MODEL_GROUP_LIMIT).map(group => {
        const groupHistory = buildHistory(group.snapshots)
        const groupObserved = groupHistory.observed.slice(0, COMPETITOR_LANDSCAPE_RANKED_ROW_LIMIT)
        const groupOtherSources = groupHistory.otherSources.slice(0, COMPETITOR_LANDSCAPE_RANKED_ROW_LIMIT)
        const excluded = excludedByModel.get(JSON.stringify([group.provider, group.model]))
        return {
          provider: group.provider,
          model: group.model,
          // Requested identity is never substituted for missing served evidence.
          servedModels: classifyModelEvidence(group.snapshots.map(snapshot => snapshot.servedModel)),
          snapshotCount: group.snapshots.length,
          ...groupHistory,
          observed: groupObserved,
          otherSources: groupOtherSources,
          evidence: {
            ...groupHistory.evidence,
            incompleteSourceResults: countIncompleteSources(group.snapshots),
            excludedProbeResults: excluded?.probes ?? 0,
            excludedNonCompletedResults: excluded?.nonCompleted ?? 0,
          },
          truncated: groupObserved.length !== groupHistory.observed.length
            || groupOtherSources.length !== groupHistory.otherSources.length,
        }
      })
      modelComparison = {
        basis: 'requested-model',
        groups,
        totalGroups: sortedGroups.length,
        truncated: groups.length !== sortedGroups.length,
      }
    }

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
        ...(filters.model !== undefined ? { model: filters.model } : {}),
        ...(filters.groupBy !== undefined ? { groupBy: filters.groupBy } : {}),
        queryClass: filters.queryClass ?? 'all',
        location: filters.location ?? null,
        runId: filters.runId ?? null,
      },
      truncated,
      ...(modelComparison ? { modelComparison } : {}),
    }
    return response
}

function resolveAdvancedScope(
  app: Pick<FastifyInstance, 'db'>,
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
  const runScopes = frozenRunScopes(app.db, projectId, kind, groupKey, candidateRuns)
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

/**
 * Each run's market scope under the v2 plan version it ran against. Runs with
 * no frozen plan, or a frozen v1 plan, are absent: their answers have no
 * assignment class or market membership to read.
 */
function frozenRunScopes(
  db: DatabaseClient,
  projectId: string,
  kind: AdvancedScope['kind'],
  groupKey: string | undefined,
  candidateRuns: readonly Pick<typeof runs.$inferSelect, 'id' | 'measurementPlanVersionId'>[],
): Map<string, FrozenPlanScope> {
  const planVersionIds = [...new Set(candidateRuns
    .map(run => run.measurementPlanVersionId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0))]
  const historicalVersions = planVersionIds.length === 0
    ? []
    : db.select().from(measurementPlanVersions).where(and(
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
  return runScopes
}

/**
 * Plan query classes for every answer a v2 run measured, keyed by run id and
 * then by the answer's `measurementExecutionId`. Uses the same all-markets
 * scope as the landscape (every frozen assignment, whatever its group
 * membership), so a class-filtered read of any surface counts the same
 * answers. One execution can carry both classes when two Target usages
 * assign it differently.
 */
export function planQueryClassesByRun(
  db: DatabaseClient,
  projectId: string,
  candidateRuns: readonly Pick<typeof runs.$inferSelect, 'id' | 'measurementPlanVersionId'>[],
): Map<string, ReadonlyMap<string, ReadonlySet<'branded' | 'non-brand'>>> {
  const byRun = new Map<string, ReadonlyMap<string, ReadonlySet<'branded' | 'non-brand'>>>()
  for (const [runId, scope] of frozenRunScopes(db, projectId, 'all-markets', undefined, candidateRuns)) {
    byRun.set(runId, scope.queryClassesByExecution)
  }
  return byRun
}

/**
 * A market reads the usages of the Properties its group holds. All markets
 * reads the whole frozen plan: groups are reporting-only membership, so a
 * Property in no group, or a plan that defines no groups at all, still
 * measured answers under frozen assignment classes. Deriving the plan-wide
 * scope from group membership dropped those answers from every class-filtered
 * read, and rejected a zero-group plan outright.
 */
function scopeForFrozenPlan(
  plan: ReturnType<typeof parseStoredMeasurementPlanAnyVersion>,
  kind: AdvancedScope['kind'],
  groupKey: string | undefined,
): FrozenPlanScope | null {
  if (plan.schemaVersion !== 2) return null
  let groups = plan.groups
  let scopedUsageEdges = plan.usageEdges
  let scopedAssignments = plan.assignments
  if (kind === 'group') {
    groups = plan.groups.filter(group => group.stableKey === groupKey)
    if (groups.length === 0) return null
    const targetKeys = new Set(groups.flatMap(group => group.targetKeys))
    scopedUsageEdges = plan.usageEdges.filter(edge => targetKeys.has(edge.targetKey))
    const scopedUsages = new Set(scopedUsageEdges.map(edge => JSON.stringify([
      edge.executionNodeKey, edge.targetKey, edge.queryId,
    ])))
    scopedAssignments = plan.assignments.filter(assignment => scopedUsages.has(JSON.stringify([
      assignment.executionNodeKey, assignment.targetKey, assignment.queryId,
    ])))
  }
  const executionNodeKeys = new Set([
    ...scopedUsageEdges.map(edge => edge.executionNodeKey),
    ...scopedAssignments.map(assignment => assignment.executionNodeKey),
  ])
  const queryClassesByExecution = new Map<string, Set<'branded' | 'non-brand'>>()
  for (const assignment of scopedAssignments) {
    const classes = queryClassesByExecution.get(assignment.executionNodeKey) ?? new Set<'branded' | 'non-brand'>()
    classes.add(assignment.queryClass)
    queryClassesByExecution.set(assignment.executionNodeKey, classes)
  }
  return {
    executionNodeKeys,
    queryClassesByExecution,
    competitors: mergePins(groups.flatMap(group => group.competitors.map(competitor => ({
      domain: competitor.domain,
      label: competitor.label,
      aliases: competitor.aliases,
    })))),
  }
}

function pendingDraftPins(
  authoring: ReturnType<typeof parseStoredAuthoring>,
  activePlan: Extract<ReturnType<typeof parseStoredMeasurementPlanAnyVersion>, { schemaVersion: 2 }>,
  kind: AdvancedScope['kind'],
  groupKey: string | undefined,
): LandscapePin[] {
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
    model: string | null
    location: string | null
    measurementExecutionId: string | null
  }
  filters: { provider?: string; model?: string; location?: string; queryClass?: CompetitorLandscapeQueryClass }
  advanced: AdvancedScope | null
  queryTextById: ReadonlyMap<string, string>
  queryClassifier: ((queryText: string | null | undefined) => 'branded' | 'non-brand') | null
}): boolean {
  const { snapshot, filters, advanced, queryTextById, queryClassifier } = input
  if (filters.provider && snapshot.provider !== filters.provider) return false
  if (filters.model !== undefined && requestedModel(snapshot.model) !== filters.model) return false
  if (filters.location && snapshot.location !== filters.location) return false
  if (advanced) {
    const frozen = advanced.runScopes.get((snapshot as { runId?: string }).runId ?? '')
    if (!frozen || !snapshot.measurementExecutionId || !frozen.executionNodeKeys.has(snapshot.measurementExecutionId)) return false
    if (filters.queryClass && filters.queryClass !== 'all') {
      // One question can have different classes on different Target/context
      // usages. Its frozen execution identity survives query deletion and must
      // not inherit a sibling usage's class through query ID or text fallback.
      const queryClasses = frozen.queryClassesByExecution.get(snapshot.measurementExecutionId)
      if (!queryClasses?.has(filters.queryClass)) return false
    }
    return true
  }
  if (filters.queryClass && filters.queryClass !== 'all') {
    if (!queryClassifier) return false
    const queryText = (snapshot.queryId ? queryTextById.get(snapshot.queryId) : undefined) ?? snapshot.queryText
    // A missing legacy question proves neither query class. Keep its evidence
    // in All, but do not turn an unavailable question into a non-brand result.
    if (!queryText?.trim()) return false
    if (queryClassifier(queryText) !== filters.queryClass) return false
  }
  return true
}

function requestedModel(model: string | null): string | null {
  return model?.trim() || null
}

function compareStoredIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizedDomain(value: string): string | null {
  return registrableDomain(value) || hostOf(value)
}

function mergePins(
  ...collections: ReadonlyArray<ReadonlyArray<LandscapePin>>
): LandscapePin[] {
  const result: LandscapePin[] = []
  const indexByDomain = new Map<string, number>()
  for (const candidate of collections.flat()) {
    const domain = normalizedDomain(candidate.domain)
    if (!domain) continue
    const existingIndex = indexByDomain.get(domain)
    if (existingIndex === undefined) {
      indexByDomain.set(domain, result.length)
      result.push({ ...candidate, aliases: [...candidate.aliases] })
      continue
    }
    const existing = result[existingIndex]!
    result[existingIndex] = {
      ...existing,
      // Keep the first identity as the display identity, but preserve every
      // market's names for answer-text matching after eTLD+1 deduplication.
      aliases: [...new Set([
        ...existing.aliases,
        ...(candidate.labelSource === 'domain' ? [] : [candidate.label]),
        ...candidate.aliases,
      ])],
    }
  }
  return result
}
