import { readCompetitorLandscape } from './competitor-landscape.js'
import { activeMeasurementPlan } from './measurement-overview.js'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { competitors, queries, querySnapshots, runs, type DatabaseClient } from '@ainyc/canonry-db'
import {
  calendarMonthBounds,
  CitationStates,
  effectiveBrandNames,
  parseInclusiveEndMs,
  RatioUnits,
  roundRatio,
  RunKinds,
  RunStatuses,
  validationError,
  isVisibilityCompareClassMetric,
  visibilityCompareSelectionSchema,
  type VisibilityCompareSelection,
  type VisibilityCompareDto,
  type QueryClass,
  type VisibilityStatsCounts,
  type VisibilityStatsDto,
  type VisibilityStatsGroupBy,
  type VisibilityStatsProviderEntry,
  type VisibilityStatsQueryEntry,
  type VisibilityStatsShareOfVoice,
} from '@ainyc/canonry-contracts'
import { notProbeRun, resolveProject } from './helpers.js'
import { projectQueryClassifier, shareOfVoiceFromLandscape, mentionShareCompetitors } from './mention-share-inputs.js'
import { computeVisibilityCompare, type VisibilityCompareSnapshotInput } from './visibility-compare.js'
import { readVisibilityComparisonRuns } from './visibility-report.js'
import { normalizeText, visibilityComparisonPopulation, VisibilityReportScopeError, type VisibilityReportReaderSelection } from './visibility-report-reader.js'

/** Snapshot fields the aggregation reads. Tri-state `answerMentioned` is read RAW. */
export interface VisibilityStatsSnapshotInput {
  queryId: string | null
  queryText: string | null
  provider: string
  citationState: string
  answerMentioned: boolean | null
  createdAt: string
}

export interface ComputeVisibilityStatsInput {
  /** Currently tracked queries — snapshots are attributed to these. */
  queries: Array<{ id: string; query: string }>
  snapshots: VisibilityStatsSnapshotInput[]
  /** `'provider'` to emit per-provider breakdowns, else `null`. */
  groupBy: VisibilityStatsGroupBy | null
}

export interface ComputeVisibilityStatsResult {
  totals: VisibilityStatsCounts
  /** Present only when `groupBy === 'provider'`. */
  byProvider?: VisibilityStatsProviderEntry[]
  queries: VisibilityStatsQueryEntry[]
}

interface Agg {
  total: number
  checked: number
  mentioned: number
  cited: number
  first: string | null
  last: string | null
}

function emptyAgg(): Agg {
  return { total: 0, checked: 0, mentioned: 0, cited: 0, first: null, last: null }
}

function addSnapshot(agg: Agg, snap: VisibilityStatsSnapshotInput): void {
  agg.total++
  // Tri-state: `null`/`undefined` ("not checked") is EXCLUDED from `checked`
  // and never coerced to not-mentioned. Only an explicit boolean counts as
  // checked; only `true` counts as mentioned. This intentionally reads the
  // RAW `answerMentioned` column rather than `resolveSnapshotAnswerMentioned`
  // (helpers.ts), which sibling "latest coverage" endpoints use but which
  // coerces null → false — that coercion would corrupt the `checked` sample
  // size this proportion depends on.
  if (snap.answerMentioned === true || snap.answerMentioned === false) agg.checked++
  if (snap.answerMentioned === true) agg.mentioned++
  // Citation is independent of mention and is always populated.
  if (snap.citationState === CitationStates.cited) agg.cited++
  if (agg.first === null || snap.createdAt < agg.first) agg.first = snap.createdAt
  if (agg.last === null || snap.createdAt > agg.last) agg.last = snap.createdAt
}

function counts(agg: Agg): VisibilityStatsCounts {
  return {
    total: agg.total,
    checked: agg.checked,
    mentioned: agg.mentioned,
    cited: agg.cited,
    // mention proportion is over the CHECKED sample; citation proportion is
    // over the full total (every snapshot is checked for citation).
    mentionRate: agg.checked > 0 ? roundRatio(agg.mentioned / agg.checked, RatioUnits.fraction) : null,
    citedRate: agg.total > 0 ? roundRatio(agg.cited / agg.total, RatioUnits.fraction) : null,
  }
}

function providerEntries(byProvider: Map<string, Agg>): VisibilityStatsProviderEntry[] {
  return [...byProvider.entries()]
    .map(([provider, agg]) => ({
      provider,
      ...counts(agg),
      // first/last are non-null once at least one snapshot landed in the agg,
      // which is guaranteed for any provider that made it into the map.
      firstObserved: agg.first ?? '',
      lastObserved: agg.last ?? '',
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider))
}

type QueryAttributionSnapshot = Pick<VisibilityStatsSnapshotInput, 'queryId' | 'queryText'>
type CurrentQuery = { id: string; query: string }

export function buildQueryAttribution(projectQueries: CurrentQuery[]): {
  byId: Map<string, CurrentQuery>
  byText: Map<string, CurrentQuery>
} {
  const byId = new Map<string, CurrentQuery>()
  const byText = new Map<string, CurrentQuery>()
  for (const q of projectQueries) {
    byId.set(q.id, q)
    byText.set(q.query, q)
  }
  return { byId, byText }
}

export function resolveCurrentQuery(
  attribution: ReturnType<typeof buildQueryAttribution>,
  snap: QueryAttributionSnapshot,
): CurrentQuery | undefined {
  if (snap.queryId && attribution.byId.has(snap.queryId)) return attribution.byId.get(snap.queryId)
  if (snap.queryText && attribution.byText.has(snap.queryText)) return attribution.byText.get(snap.queryText)
  return undefined
}

/**
 * Pure aggregation: attribute snapshots to currently-tracked queries (by
 * `queryId`, falling back to denormalized `queryText` — see `history.ts`),
 * then roll up tri-state mention + citation counts per query, per provider,
 * and pooled. Snapshots that can't be attributed to a current query are
 * dropped (matches the timeline endpoint's behavior).
 */
export function computeVisibilityStats(input: ComputeVisibilityStatsInput): ComputeVisibilityStatsResult {
  const { groupBy } = input
  const wantProviders = groupBy === 'provider'

  // Attribution maps. `queryId` is the primary link; `queryText` recovers a
  // snapshot whose query row was replaced (queryId SET NULL) but whose text
  // still matches a current query.
  const attribution = buildQueryAttribution(input.queries)

  interface QueryBucket {
    id: string
    query: string
    agg: Agg
    byProvider: Map<string, Agg>
  }
  const byQuery = new Map<string, QueryBucket>()
  const totals = emptyAgg()
  const totalsByProvider = new Map<string, Agg>()

  for (const snap of input.snapshots) {
    const resolved = resolveCurrentQuery(attribution, snap)
    if (!resolved) continue

    let bucket = byQuery.get(resolved.id)
    if (!bucket) {
      bucket = { id: resolved.id, query: resolved.query, agg: emptyAgg(), byProvider: new Map() }
      byQuery.set(resolved.id, bucket)
    }
    addSnapshot(bucket.agg, snap)
    addSnapshot(totals, snap)

    if (wantProviders) {
      const qpAgg = bucket.byProvider.get(snap.provider) ?? emptyAgg()
      addSnapshot(qpAgg, snap)
      bucket.byProvider.set(snap.provider, qpAgg)

      const tpAgg = totalsByProvider.get(snap.provider) ?? emptyAgg()
      addSnapshot(tpAgg, snap)
      totalsByProvider.set(snap.provider, tpAgg)
    }
  }

  const queryEntries: VisibilityStatsQueryEntry[] = [...byQuery.values()]
    .map((bucket) => ({
      queryId: bucket.id,
      query: bucket.query,
      ...counts(bucket.agg),
      firstObserved: bucket.agg.first ?? '',
      lastObserved: bucket.agg.last ?? '',
      ...(wantProviders ? { providers: providerEntries(bucket.byProvider) } : {}),
    }))
    .sort((a, b) => a.query.localeCompare(b.query))

  return {
    totals: counts(totals),
    ...(wantProviders ? { byProvider: providerEntries(totalsByProvider) } : {}),
    queries: queryEntries,
  }
}

export async function visibilityStatsRoutes(app: FastifyInstance) {
  // GET /projects/:name/visibility-stats
  // Per-query mention/citation counts with a sample size, pooled across many
  // answer-visibility runs, with an optional per-provider breakdown. Lets a
  // consumer compute confidence-aware (Wilson) proportions without N+1 fetches.
  app.get<{
    Params: { name: string }
    Querystring: {
      since?: string
      until?: string
      lastRuns?: string
      groupBy?: string
      month?: string
      shareOfVoice?: string
      queryClass?: string
    }
  }>('/projects/:name/visibility-stats', async (request, reply) => {
    const project = resolveProject(app.db, request.params.name)

    const {
      since: sinceRaw,
      until: untilRaw,
      lastRuns: lastRunsRaw,
      groupBy: groupByRaw,
      month: monthRaw,
      shareOfVoice: shareOfVoiceRaw,
      queryClass: queryClassRaw,
    } = request.query

    let groupBy: VisibilityStatsGroupBy | null = null
    if (groupByRaw !== undefined && groupByRaw !== '') {
      if (groupByRaw !== 'provider') throw validationError('"groupBy" must be "provider"')
      groupBy = 'provider'
    }

    const hasSince = sinceRaw !== undefined && sinceRaw !== ''
    const hasUntil = untilRaw !== undefined && untilRaw !== ''
    const hasLastRuns = lastRunsRaw !== undefined && lastRunsRaw !== ''
    const hasMonth = monthRaw !== undefined && monthRaw !== ''
    const wantShareOfVoice = shareOfVoiceRaw === '1' || shareOfVoiceRaw === 'true'
    // Non-brand by default. Branded is available but must be asked for, because
    // a caller who did not think about the split is a caller who would read a
    // branded-inflated figure as a competitive one.
    const requestedQueryClass: QueryClass = queryClassRaw === undefined || queryClassRaw === ''
      ? 'non-brand'
      : queryClassRaw === 'branded' || queryClassRaw === 'non-brand'
        ? queryClassRaw
        : (() => { throw validationError('"queryClass" must be "branded" or "non-brand"') })()
    if (hasLastRuns && (hasSince || hasUntil)) {
      throw validationError('"lastRuns" cannot be combined with "since"/"until" — use one or the other')
    }
    if (hasMonth && (hasSince || hasUntil || hasLastRuns)) {
      throw validationError('"month" cannot be combined with "since"/"until"/"lastRuns" — use one or the other')
    }

    let sinceMs: number | null = null
    let untilMs: number | null = null
    let resolvedMonthWindow: { since: string; until: string } | null = null
    // A date-only `since` already parses to the day's start (00:00), so it is
    // a correct inclusive lower bound as-is. A date-only `until` must be
    // widened to end-of-day (23:59:59.999) via `parseInclusiveEndMs` — parsed
    // as a bare midnight instant it would exclude every run created later that
    // same day, silently truncating the advertised date window.
    if (hasSince) {
      const ms = Date.parse(sinceRaw as string)
      if (Number.isNaN(ms)) throw validationError('"since" must be an ISO 8601 date/time')
      sinceMs = ms
    }
    if (hasUntil) {
      const ms = parseInclusiveEndMs(untilRaw as string)
      if (ms === null) throw validationError('"until" must be an ISO 8601 date/time')
      untilMs = ms
    }
    if (hasMonth) {
      let bounds: { since: string; until: string }
      try {
        bounds = calendarMonthBounds(monthRaw as string)
      } catch (err) {
        throw validationError(err instanceof RangeError ? err.message : '"month" must be in YYYY-MM format')
      }
      sinceMs = Date.parse(bounds.since)
      untilMs = Date.parse(bounds.until)
      resolvedMonthWindow = bounds
    }
    if (sinceMs !== null && untilMs !== null && untilMs < sinceMs) {
      throw validationError('"until" must be on or after "since"')
    }

    let lastRuns: number | null = null
    if (hasLastRuns) {
      const n = Number(lastRunsRaw)
      if (!Number.isInteger(n) || n <= 0) throw validationError('"lastRuns" must be a positive integer')
      lastRuns = n
    }

    const projectQueries = app.db
      .select({ id: queries.id, query: queries.query })
      .from(queries)
      .where(eq(queries.projectId, project.id))
      .all()

    // Answer-visibility runs only (the only kind that writes query_snapshots),
    // probe runs excluded, terminal-with-data statuses only. Newest first so
    // `lastRuns` can slice the head.
    let projectRuns = app.db
      .select({ id: runs.id, createdAt: runs.createdAt, status: runs.status })
      .from(runs)
      .where(and(eq(runs.projectId, project.id), eq(runs.kind, RunKinds['answer-visibility']), notProbeRun()))
      .orderBy(desc(runs.createdAt))
      .all()
      .filter((r) => r.status === RunStatuses.completed || r.status === RunStatuses.partial)

    if (sinceMs !== null) projectRuns = projectRuns.filter((r) => Date.parse(r.createdAt) >= sinceMs!)
    if (untilMs !== null) projectRuns = projectRuns.filter((r) => Date.parse(r.createdAt) <= untilMs!)
    if (lastRuns !== null) projectRuns = projectRuns.slice(0, lastRuns)

    const runCount = projectRuns.length
    const runIds = projectRuns.map((r) => r.id)

    const snapshots: VisibilityStatsSnapshotInput[] =
      runIds.length > 0 && projectQueries.length > 0
        ? app.db
            .select({
              queryId: querySnapshots.queryId,
              queryText: querySnapshots.queryText,
              provider: querySnapshots.provider,
              citationState: querySnapshots.citationState,
              answerMentioned: querySnapshots.answerMentioned,
              createdAt: querySnapshots.createdAt,
            })
            .from(querySnapshots)
            .where(inArray(querySnapshots.runId, runIds))
            .all()
        : []

    const stats = computeVisibilityStats({ queries: projectQueries, snapshots, groupBy })
    const queryAttribution = buildQueryAttribution(projectQueries)

    // Share of voice (opt-in) — how often the project's brand is named in answer
    // text vs the selected competitor set, across the SAME window of runs,
    // through the shared landscape reader. Scoped to one query class (non-brand unless the
    // caller asks otherwise); branded and non-brand never share a denominator.
    // Loads answerText only on this path so the default endpoint stays lean.
    let shareOfVoice: VisibilityStatsShareOfVoice | undefined
    if (wantShareOfVoice) {
      const sovSnapshots =
        runIds.length > 0
          ? app.db
              .select({
                id: querySnapshots.id,
                queryId: querySnapshots.queryId,
                queryText: querySnapshots.queryText,
                answerMentioned: querySnapshots.answerMentioned,
                answerText: querySnapshots.answerText,
              })
              .from(querySnapshots)
              .where(inArray(querySnapshots.runId, runIds))
              .all()
          : []
      const attributedSovSnapshots = sovSnapshots.filter((s) => resolveCurrentQuery(queryAttribution, s) !== undefined)
      const advanced = activeMeasurementPlan(app.db, project.id)?.plan.schemaVersion === 2
      const queryClass = advanced || projectQueryClassifier(project) ? requestedQueryClass : 'all'
      const landscape = readCompetitorLandscape(app, project.name, { window: 'all', queryClass }, {
        runIds,
        // Advanced assignment edges own attribution; Simple keeps the stats basket.
        ...(advanced ? {} : { snapshotIds: attributedSovSnapshots.map(snapshot => snapshot.id) }),
        autoAdvanced: true,
      })
      shareOfVoice = shareOfVoiceFromLandscape(landscape, queryClass === 'all' ? 'pooled' : queryClass)
    }

    const response: VisibilityStatsDto = {
      project: project.name,
      window: {
        // A `month` request echoes the resolved inclusive bounds it expanded to,
        // so the window is self-documenting regardless of which input was used.
        since: resolvedMonthWindow ? resolvedMonthWindow.since : hasSince ? (sinceRaw as string) : null,
        until: resolvedMonthWindow ? resolvedMonthWindow.until : hasUntil ? (untilRaw as string) : null,
        lastRuns,
        runCount,
      },
      totals: stats.totals,
      queries: stats.queries,
      // `groupBy` + `byProvider` appear together only when a breakdown was
      // requested; both are OMITTED otherwise (absent = no breakdown) so the
      // SDK types `groupBy` as `groupBy?: 'provider'` rather than a misleading
      // always-present literal.
      ...(groupBy === 'provider' ? { groupBy, byProvider: stats.byProvider ?? [] } : {}),
      ...(shareOfVoice ? { shareOfVoice } : {}),
    }
    return reply.send(response)
  })

  // GET /projects/:name/visibility-compare?from=YYYY-MM&to=YYYY-MM
  // Statistically honest month-over-month AEO comparison (share-of-voice-led,
  // basket-restricted, Wilson intervals, CI-overlap verdict, drift-aware). One
  // call serves a whole m/m report; the caller renders, never recomputes.
  app.get<{
    Params: { name: string }
    Querystring: VisibilityCompareSelection & { from?: string; to?: string }
  }>('/projects/:name/visibility-compare', async (request, reply) => {
    const dto = readVisibilityCompare(app.db, request.params.name, request.query)
    return reply.send(dto)
  })
}

/** The stored-evidence monthly comparison behind the REST route, CLI and MCP tool. */
export function readVisibilityCompare(db: DatabaseClient, projectName: string, query: VisibilityCompareSelection & { from?: string; to?: string }) {
  const project = resolveProject(db, projectName)
  const selection = visibilityCompareSelectionSchema.safeParse(query)
  if (!selection.success) throw validationError('Invalid comparison selection', { issues: selection.error.issues })
  const filters = selection.data
  const scope = filters.scope ?? 'project'
  if (scope !== 'project' && filters.scopeKey === undefined) throw validationError('A non-project comparison scope requires scopeKey.')
  if (scope === 'project' && filters.scopeKey !== undefined) throw validationError('scopeKey is not valid for project scope.')
  if (scope === 'market' && filters.marketKey !== undefined) throw validationError('marketKey is not valid for market scope.')
  const { fromRaw, toRaw, fromBounds, toBounds } = compareMonths(query.from, query.to)

  // Provider and location match the way the frozen Advanced reader matches
  // them, so a selection means the same thing for Simple and Advanced frames.
  const providerKey = filters.provider === undefined ? undefined : normalizeText(filters.provider)
  const locationKey = filters.location === undefined ? undefined : normalizeText(filters.location)
  const scoped = scope !== 'project' || filters.marketKey !== undefined

  let advancedComparison: VisibilityCompareDto | undefined
  if (activeMeasurementPlan(db, project.id) !== null) {
    const readerSelection: VisibilityReportReaderSelection = {
      ...filters, scope, queryClass: 'all',
      location: locationKey === undefined ? { kind: 'all' } : locationKey === 'none' ? { kind: 'none' } : { kind: 'exact', value: filters.location! },
      limit: 100,
    }
    const { missingScope: fromMissingScope, ...fromMonth } = loadAdvancedCompareMonth(db, project.id, fromBounds, readerSelection)
    const { missingScope: toMissingScope, ...toMonth } = loadAdvancedCompareMonth(db, project.id, toBounds, readerSelection)
    // The request fails for a missing scope only when no run in either month measured it.
    const missingScope = fromMissingScope ?? toMissingScope
    if (missingScope !== undefined && fromMonth.runCount + toMonth.runCount === 0) throw validationError(missingScope.message, missingScope.details)
    const queries = [...new Map([...fromMonth.snapshots, ...toMonth.snapshots].map(snapshot => [snapshot.queryId!, { id: snapshot.queryId!, query: snapshot.queryText! }])).values()]
    advancedComparison = { ...computeVisibilityCompare({
      project: project.name, queries,
      competitors: [...new Set([...fromMonth.snapshots, ...toMonth.snapshots].flatMap(snapshot => snapshot.competitorDomains ?? []))].map(domain => ({ domain, brandTokens: [] })),
      frozenClassification: fromMonth.classificationAvailable && toMonth.classificationAvailable,
      from: { ...fromMonth, month: fromRaw, ...fromBounds },
      to: { ...toMonth, month: toRaw, ...toBounds },
    }), selection: filters }
    // Property, group and market exist only in the frozen frame, so a scoped
    // request answers from it alone. It must not silently drop history that
    // frame cannot read, which would report fewer sweeps than were measured.
    if (scoped) {
      const unreadable = [fromMonth.classificationAvailable ? null : fromRaw, toMonth.classificationAvailable ? null : toRaw]
        .filter((month): month is string => month !== null)
      if (unreadable.length > 0) {
        throw validationError(`Property, group and market comparisons need frozen schema-v2 plan history; ${unreadable.join(' and ')} include runs whose plan cannot be reconstructed.`, { months: unreadable })
      }
      return advancedComparison
    }
  }
  if (advancedComparison === undefined && scoped) throw validationError('Property, group and market comparison scopes require an Advanced portfolio.')
  const projectQueries = db
    .select({ id: queries.id, query: queries.query })
    .from(queries)
    .where(eq(queries.projectId, project.id))
    .all()

  const competitorRows = db
    .select({ domain: competitors.domain, aliases: competitors.aliases })
    .from(competitors)
    .where(eq(competitors.projectId, project.id))
    .all()
  const competitorInputs = mentionShareCompetitors(competitorRows)

  const loadMonth = (bounds: MonthBounds) => {
    const runIds = legacyCompareRunIds(db, project.id, bounds)
    const snapshots =
      runIds.length > 0 && projectQueries.length > 0
        ? db
            .select({
              queryId: querySnapshots.queryId,
              queryText: querySnapshots.queryText,
              provider: querySnapshots.provider,
              model: querySnapshots.model,
              citationState: querySnapshots.citationState,
              answerMentioned: querySnapshots.answerMentioned,
              answerText: querySnapshots.answerText,
              citedDomains: querySnapshots.citedDomains,
              location: querySnapshots.location,
            })
            .from(querySnapshots)
            .where(inArray(querySnapshots.runId, runIds))
            .all()
        : []
    return {
      runCount: runIds.length,
      snapshots: snapshots.filter(snapshot =>
        (providerKey === undefined || normalizeText(snapshot.provider) === providerKey)
        && (locationKey === undefined || (locationKey === 'none'
          ? snapshot.location === null
          : snapshot.location !== null && normalizeText(snapshot.location) === locationKey))),
    }
  }

  const fromMonth = loadMonth(fromBounds)
  const toMonth = loadMonth(toBounds)

  const dto = computeVisibilityCompare({
    project: project.name,
    queries: projectQueries,
    competitors: competitorInputs,
    brandNames: effectiveBrandNames(project),
    from: { month: fromRaw, since: fromBounds.since, until: fromBounds.until, runCount: fromMonth.runCount, snapshots: fromMonth.snapshots },
    to: { month: toRaw, since: toBounds.since, until: toBounds.until, runCount: toMonth.runCount, snapshots: toMonth.snapshots },
  })
  if (advancedComparison !== undefined) {
    const { from, to, basket, continuity, modelChanges } = advancedComparison
    return {
      ...dto,
      selection: filters,
      metrics: [
        ...dto.metrics.filter(metric => !isVisibilityCompareClassMetric(metric.key)),
        ...advancedComparison.metrics.filter(metric => isVisibilityCompareClassMetric(metric.key)),
      ],
      classComparison: { from, to, basket, continuity, modelChanges },
    }
  }
  return { ...dto, selection: filters }
}

type MonthBounds = { since: string; until: string }

/** Validated calendar months for a comparison; `from` must be strictly before `to`. */
function compareMonths(fromRaw: string | undefined, toRaw: string | undefined): { fromRaw: string; toRaw: string; fromBounds: MonthBounds; toBounds: MonthBounds } {
  if (fromRaw === undefined || fromRaw === '') throw validationError('"from" (YYYY-MM) is required')
  if (toRaw === undefined || toRaw === '') throw validationError('"to" (YYYY-MM) is required')

  let fromBounds: MonthBounds
  let toBounds: MonthBounds
  try {
    fromBounds = calendarMonthBounds(fromRaw)
  } catch (err) {
    throw validationError(err instanceof RangeError ? `"from": ${err.message}` : '"from" must be in YYYY-MM format')
  }
  try {
    toBounds = calendarMonthBounds(toRaw)
  } catch (err) {
    throw validationError(err instanceof RangeError ? `"to": ${err.message}` : '"to" must be in YYYY-MM format')
  }
  if (Date.parse(fromBounds.since) >= Date.parse(toBounds.since)) {
    throw validationError('"from" must be a month strictly before "to"')
  }
  return { fromRaw, toRaw, fromBounds, toBounds }
}

/** Completed/partial, non-probe answer-visibility runs created in the month: the project frame's sweeps. */
function legacyCompareRunIds(db: DatabaseClient, projectId: string, bounds: MonthBounds): string[] {
  const sinceMs = Date.parse(bounds.since)
  const untilMs = Date.parse(bounds.until)
  return db
    .select({ id: runs.id, createdAt: runs.createdAt, status: runs.status })
    .from(runs)
    .where(and(eq(runs.projectId, projectId), eq(runs.kind, RunKinds['answer-visibility']), notProbeRun()))
    .all()
    .filter(
      (r) =>
        (r.status === RunStatuses.completed || r.status === RunStatuses.partial) &&
        Date.parse(r.createdAt) >= sinceMs &&
        Date.parse(r.createdAt) <= untilMs,
    )
    .map((r) => r.id)
}

/**
 * One month of the frozen Advanced frame for a selection. A run whose frozen
 * definition lacks the selected scope never measured it (a Property added or
 * retired by a material revision): it leaves the month, as it leaves the
 * report's trend, and `runCount` counts only the runs that measured it. The
 * first such scope error is returned for the caller to raise when neither
 * month measured the scope at all.
 */
function loadAdvancedCompareMonth(db: DatabaseClient, projectId: string, bounds: MonthBounds, selection: VisibilityReportReaderSelection, includeEvidence = true) {
  const selected = readVisibilityComparisonRuns(db, projectId, bounds.since, bounds.until, includeEvidence)
  const snapshots: VisibilityCompareSnapshotInput[] = []
  const classSnapshots: VisibilityCompareSnapshotInput[] = []
  let runCount = 0
  let missingScope: VisibilityReportScopeError | undefined
  for (const run of selected.runs) {
    let population: ReturnType<typeof visibilityComparisonPopulation>
    try {
      population = visibilityComparisonPopulation(run, selection)
    } catch (error) {
      if (error instanceof VisibilityReportScopeError && error.details !== undefined) {
        missingScope ??= error
        continue
      }
      if (error instanceof VisibilityReportScopeError) throw validationError(error.message, error.details)
      throw error
    }
    runCount += 1
    const adapt = (snapshot: typeof population.snapshots[number]): VisibilityCompareSnapshotInput => ({
      ...snapshot,
      citationState: snapshot.citation === true ? CitationStates.cited : CitationStates['not-cited'],
      citationChecked: snapshot.citation !== null,
      citedDomains: [],
    })
    snapshots.push(...population.snapshots.map(adapt))
    classSnapshots.push(...population.classSnapshots.map(adapt))
  }
  return { runCount, snapshots, classSnapshots, classificationAvailable: !selected.unavailable, missingScope }
}

/** One continuity frame a monthly comparison gates metrics on. */
export interface VisibilityContinuityFrame {
  /** `project` gates the four project metrics; `class` gates the frozen class rates. */
  frame: 'class' | 'project'
  continuity: VisibilityCompareDto['continuity']
}

/**
 * The model-continuity gates a monthly comparison applies, without computing
 * its metrics, exactly as `readVisibilityCompare` applies them: the project
 * frame always gates the four project metrics, and on an Advanced project
 * whose two months are frozen schema-v2 history, the frozen class frame gates
 * the class rates as well. Continuity reads query, provider, model and frozen
 * cohort only; no answer text is matched.
 */
export function readVisibilityContinuity(db: DatabaseClient, projectName: string, months: { from: string; to: string }): VisibilityContinuityFrame[] {
  const project = resolveProject(db, projectName)
  const { fromRaw, toRaw, fromBounds, toBounds } = compareMonths(months.from, months.to)
  const bare = (snapshot: Pick<VisibilityCompareSnapshotInput, 'queryId' | 'queryText' | 'provider' | 'model' | 'cohortKey'>): VisibilityCompareSnapshotInput => ({
    queryId: snapshot.queryId,
    queryText: snapshot.queryText,
    provider: snapshot.provider,
    model: snapshot.model,
    ...(snapshot.cohortKey === undefined ? {} : { cohortKey: snapshot.cohortKey }),
    citationState: CitationStates['not-cited'],
    answerMentioned: null,
    answerText: null,
    citedDomains: [],
  })
  const gate = (trackedQueries: Array<{ id: string; query: string }>, fromMonth: { runCount: number; snapshots: VisibilityCompareSnapshotInput[] }, toMonth: { runCount: number; snapshots: VisibilityCompareSnapshotInput[] }) => computeVisibilityCompare({
    project: project.name,
    queries: trackedQueries,
    competitors: [],
    from: { month: fromRaw, ...fromBounds, ...fromMonth },
    to: { month: toRaw, ...toBounds, ...toMonth },
  }).continuity

  const trackedQueries = db.select({ id: queries.id, query: queries.query }).from(queries).where(eq(queries.projectId, project.id)).all()
  const loadProjectMonth = (bounds: MonthBounds) => {
    const runIds = legacyCompareRunIds(db, project.id, bounds)
    const rows = runIds.length > 0 && trackedQueries.length > 0
      ? db.select({ queryId: querySnapshots.queryId, queryText: querySnapshots.queryText, provider: querySnapshots.provider, model: querySnapshots.model })
        .from(querySnapshots).where(inArray(querySnapshots.runId, runIds)).all()
      : []
    return { runCount: runIds.length, snapshots: rows.map(bare) }
  }
  const frames: VisibilityContinuityFrame[] = [{ frame: 'project', continuity: gate(trackedQueries, loadProjectMonth(fromBounds), loadProjectMonth(toBounds)) }]

  if (activeMeasurementPlan(db, project.id) !== null) {
    const selection: VisibilityReportReaderSelection = { scope: 'project', queryClass: 'all', location: { kind: 'all' }, limit: 100 }
    const fromMonth = loadAdvancedCompareMonth(db, project.id, fromBounds, selection, false)
    const toMonth = loadAdvancedCompareMonth(db, project.id, toBounds, selection, false)
    // A month with runs the frozen frame cannot read (schema v1) has no class
    // rates to gate: the comparison reports them classification-unavailable.
    if (fromMonth.classificationAvailable && toMonth.classificationAvailable) {
      const bareFrom = { runCount: fromMonth.runCount, snapshots: fromMonth.snapshots.map(bare) }
      const bareTo = { runCount: toMonth.runCount, snapshots: toMonth.snapshots.map(bare) }
      const frozenQueries = [...new Map([...bareFrom.snapshots, ...bareTo.snapshots].map(snapshot => [snapshot.queryId!, { id: snapshot.queryId!, query: snapshot.queryText! }])).values()]
      frames.push({ frame: 'class', continuity: gate(frozenQueries, bareFrom, bareTo) })
    }
  }
  return frames
}
