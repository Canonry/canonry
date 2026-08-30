/**
 * Scoped Advanced aggregates over one run's evidence.
 *
 * Everything here reads the run-pinned revision: identities, aliases,
 * competitors and questions all come from the frozen plan the displayed run
 * measured, never from live project configuration. Metrics are computed before
 * `search` is applied, and a metric with no evidence is withheld with a reason
 * rather than serialized as zero.
 */

import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  AppError,
  MEASUREMENT_PAGE_DEFAULT_LIMIT,
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION,
  MEASUREMENT_OVERVIEW_DEFAULT_SORT,
  measurementOverviewQuerySchema,
  measurementOverviewResponseSchema,
  measurementOverviewSortSchema,
  measurementRunRevisionMismatch,
  notFound,
  parseStoredMeasurementPlanAnyVersion,
  RunStatuses,
  validationError,
  type MeasurementMetricUnavailableReason,
  type MeasurementOverviewQuery,
  type MeasurementOverviewResponse,
  type MeasurementOverviewSort,
  type MeasurementPlanV2,
  type MeasurementPropertyProviderRow,
  type MeasurementOutcomeCounts,
  type MeasurementPropertyRow,
  type MeasurementQueryClassFilter,
  type MeasurementState,
  type MetricValue,
  type NamedShareOfVoice,
  type RunStatus,
  type StoredMeasurementPlan,
} from '@ainyc/canonry-contracts'
import {
  measurementPlanDrafts,
  measurementPlans,
  measurementPlanVersions,
  querySnapshots,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { resolveProject } from './helpers.js'
import {
  buildMeasurementOverview,
  type MeasurementMetricReason,
  type MeasurementOverview,
  type MeasurementOverviewPropertyRow,
  type MeasurementRate,
  type MeasurementUsageEdgeInput,
} from './measurement-report.js'
import {
  buildMeasurementPlanV2ReportInput,
  latestMeasurementRun,
  measurementRunExpectedSlots,
  runVersionServesActiveVersion,
} from './measurement-report-adapter.js'
import { measurementRunCompleteness } from './measurement-run-completeness.js'

/** Every state a run can be in and still be the current one. Cancelled runs never are. */
const CURRENT_RUN_STATUSES: readonly RunStatus[] = [
  RunStatuses.queued,
  RunStatuses.running,
  RunStatuses.completed,
  RunStatuses.partial,
  RunStatuses.failed,
]

export interface ActiveMeasurementPlan {
  version: typeof measurementPlanVersions.$inferSelect
  plan: StoredMeasurementPlan
}

interface ScopeSelection {
  kind: MeasurementOverviewResponse['scope']['kind']
  key?: string
  label: string
  targetKeys: string[]
  /** Set only for a v2 group scope: the one place Named Share of Voice may exist. */
  group: MeasurementPlanV2['groups'][number] | null
}

interface NamedIdentity {
  key: string
  aliases: readonly string[]
  kind: 'project' | 'competitor'
  stableKey: string
  label: string
  domain: string
}

interface PropertyLabel {
  targetKey: string
  label: string
}

interface OverviewCursor {
  v: 1
  sort: MeasurementOverviewSort
  targetKey: string
  displayedRunId: string | null
  filterFingerprint: string
  planVersionId: string
  evidenceFingerprint: string
}

/**
 * The aggregate behind the Property list is independent of its cursor, limit,
 * and sort. Cache it per process so an infinite-list page does not rebuild a
 * stable run on every click. A request still reads and fingerprints snapshots
 * before lookup, so a running run cannot serve a stale aggregate.
 */
export interface MeasurementOverviewCacheKey {
  planVersionId: string
  revision: number
  runId: string
  aggregateFingerprint: string
  evidenceFingerprint: string
}

export interface MeasurementOverviewCache {
  getOrBuild(key: MeasurementOverviewCacheKey, build: () => MeasurementOverview): MeasurementOverview
}

export const MEASUREMENT_OVERVIEW_CACHE_MAX_ENTRIES = 32

function cacheKeyOf(key: MeasurementOverviewCacheKey): string {
  return JSON.stringify([
    key.planVersionId,
    key.revision,
    key.runId,
    key.aggregateFingerprint,
    key.evidenceFingerprint,
  ])
}

/** A tiny LRU keeps the process cache bounded across plans, runs, and filters. */
export function createMeasurementOverviewCache(
  maxEntries = MEASUREMENT_OVERVIEW_CACHE_MAX_ENTRIES,
): MeasurementOverviewCache {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError('Measurement overview cache maxEntries must be a positive safe integer.')
  }
  const entries = new Map<string, MeasurementOverview>()
  return {
    getOrBuild(key, build) {
      const cacheKey = cacheKeyOf(key)
      const hit = entries.get(cacheKey)
      if (hit !== undefined) {
        // Map insertion order is the LRU order. Refresh a hit before returning.
        entries.delete(cacheKey)
        entries.set(cacheKey, hit)
        return hit
      }

      const overview = build()
      entries.set(cacheKey, overview)
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next().value
        if (oldest !== undefined) entries.delete(oldest)
      }
      return overview
    },
  }
}

function parseOverviewQuery(raw: Record<string, unknown>): MeasurementOverviewQuery {
  const candidate = { ...raw, ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }) }
  const parsed = measurementOverviewQuerySchema.safeParse(candidate)
  if (!parsed.success) throw validationError('Invalid measurement overview query', { issues: parsed.error.issues })
  return parsed.data
}

export function activeMeasurementPlan(db: DatabaseClient, projectId: string): ActiveMeasurementPlan | null {
  const pointer = db.select().from(measurementPlans).where(eq(measurementPlans.projectId, projectId)).get()
  if (!pointer) return null
  const version = db.select().from(measurementPlanVersions).where(and(
    eq(measurementPlanVersions.projectId, projectId),
    eq(measurementPlanVersions.id, pointer.activeVersionId),
  )).get()
  if (!version) throw new Error(`Measurement plan ${projectId} points to missing version ${pointer.activeVersionId}`)
  return { version, plan: parseStoredMeasurementPlanAnyVersion(version.canonicalJson) }
}

function metricReason(reason: MeasurementMetricReason): MeasurementMetricUnavailableReason {
  switch (reason) {
    case 'no-population':
      return 'no_population'
    case 'incomplete':
    case 'evidence-incomplete':
      return 'evidence_incomplete'
    case 'aliasless':
    case 'no-competitors':
    case 'no-project-aliases':
      return 'not_applicable'
  }
}

function unavailable(reason: MeasurementMetricUnavailableReason): MetricValue {
  return { state: 'unavailable', reason }
}

/** A coverage metric reads out as its ratio; an unavailable one carries no `value` key at all. */
function coverageMetric(rate: MeasurementRate): MetricValue {
  if (rate.rate === null) return unavailable(metricReason(rate.reason))
  return { state: 'available', value: rate.rate, numerator: rate.numerator, denominator: rate.denominator }
}

/**
 * The kernel's per-engine split, in the wire vocabulary. An engine that
 * produced no slot for this Property never reaches here, so the array is short
 * rather than padded with zeroes.
 */
function providerRows(property: MeasurementOverviewPropertyRow): MeasurementPropertyProviderRow[] {
  return property.providers.map(row => ({
    provider: row.provider,
    mentionCoverage: coverageMetric(row.mentionCoverage),
    citationCoverage: coverageMetric(row.citationCoverage),
  }))
}

/** A count metric reads out as the numerator, with the eligible population beside it. */
function countMetric(rate: MeasurementRate): MetricValue {
  if (rate.numerator === null) return unavailable(metricReason(rate.reason))
  return {
    state: 'available',
    value: rate.numerator,
    numerator: rate.numerator,
    denominator: rate.denominator,
    ...(rate.rate === null ? {} : { rate: rate.rate }),
  }
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
}

function overviewFilterFingerprint(query: MeasurementOverviewQuery): string {
  const filters = {
    scope: query.scope,
    groupKey: query.groupKey ?? null,
    targetKey: query.targetKey ?? null,
    queryClass: query.queryClass ?? 'all',
    provider: query.provider === undefined ? null : normalizedText(query.provider),
    location: query.location === undefined ? null : normalizedText(query.location),
    from: query.from ?? null,
    to: query.to ?? null,
    search: query.search === undefined ? null : normalizedText(query.search),
  }
  return createHash('sha256').update(JSON.stringify(filters)).digest('base64url')
}

/**
 * Filters applied before aggregation. `search` is deliberately absent: it
 * narrows only the already-computed Property rows, while the cursor fingerprint
 * above must continue binding it to one result set.
 */
function overviewAggregateFingerprint(query: MeasurementOverviewQuery): string {
  const filters = {
    scope: query.scope,
    groupKey: query.groupKey ?? null,
    targetKey: query.targetKey ?? null,
    queryClass: query.queryClass ?? 'all',
    provider: query.provider === undefined ? null : normalizedText(query.provider),
    location: query.location === undefined ? null : normalizedText(query.location),
    from: query.from ?? null,
    to: query.to ?? null,
  }
  return createHash('sha256').update(JSON.stringify(filters)).digest('base64url')
}

function overviewEvidenceFingerprint(snapshots: readonly typeof querySnapshots.$inferSelect[]): string {
  const canonical = [...snapshots]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(snapshot => JSON.stringify(snapshot))
    .join('\n')
  return createHash('sha256').update(canonical).digest('base64url')
}

function compareLabels(left: PropertyLabel, right: PropertyLabel): number {
  const leftLabel = normalizedText(left.label)
  const rightLabel = normalizedText(right.label)
  if (leftLabel !== rightLabel) return leftLabel < rightLabel ? -1 : 1
  return left.targetKey < right.targetKey ? -1 : left.targetKey > right.targetKey ? 1 : 0
}

function compareLabelSort(left: PropertyLabel, right: PropertyLabel, descending: boolean): number {
  const leftLabel = normalizedText(left.label)
  const rightLabel = normalizedText(right.label)
  if (leftLabel !== rightLabel) {
    const compared = leftLabel < rightLabel ? -1 : 1
    return descending ? -compared : compared
  }
  return left.targetKey < right.targetKey ? -1 : left.targetKey > right.targetKey ? 1 : 0
}

function metricForSort(row: MeasurementPropertyRow, sort: MeasurementOverviewSort): MetricValue | null {
  switch (sort) {
    case 'citationCoverage-asc':
    case 'citationCoverage-desc':
      return row.citationCoverage
    case 'mentionCoverage-asc':
    case 'mentionCoverage-desc':
      return row.mentionCoverage
    case 'label-asc':
    case 'label-desc':
      return null
  }
}

function compareRows(left: MeasurementPropertyRow, right: MeasurementPropertyRow, sort: MeasurementOverviewSort): number {
  if (sort === 'label-asc' || sort === 'label-desc') {
    return compareLabelSort(left, right, sort === 'label-desc')
  }

  const leftMetric = metricForSort(left, sort)!
  const rightMetric = metricForSort(right, sort)!
  // Unknown is not zero. Keep this explicit bucket first for either numeric
  // direction so an agent asking for underperformance cannot miss unmeasured
  // Properties at the tail of a result set.
  if (leftMetric.state !== rightMetric.state) return leftMetric.state === 'unavailable' ? -1 : 1
  if (leftMetric.state === 'available' && rightMetric.state === 'available' && leftMetric.value !== rightMetric.value) {
    const compared = leftMetric.value < rightMetric.value ? -1 : 1
    return sort.endsWith('-desc') ? -compared : compared
  }
  // Metric ties deliberately use the stable label/key order, independent of
  // numeric direction, so page boundaries cannot drift between calls.
  return compareLabels(left, right)
}

function legacyCursorOf(row: PropertyLabel): string {
  return Buffer.from(`${normalizedText(row.label)}:${row.targetKey}`, 'utf8').toString('base64url')
}

function cursorOf(
  row: MeasurementPropertyRow,
  sort: MeasurementOverviewSort,
  displayedRunId: string | null,
  filterFingerprint: string,
  planVersionId: string,
  evidenceFingerprint: string,
): string {
  const cursor: OverviewCursor = {
    v: 1,
    sort,
    targetKey: row.targetKey,
    displayedRunId,
    filterFingerprint,
    planVersionId,
    evidenceFingerprint,
  }
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function parseCursor(value: string): OverviewCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const cursor = parsed as Record<string, unknown>
    if (
      cursor.v !== 1
      || typeof cursor.targetKey !== 'string'
      || !measurementOverviewSortSchema.safeParse(cursor.sort).success
    ) return null
    if (
      cursor.displayedRunId !== null
      && typeof cursor.displayedRunId !== 'string'
    ) return null
    if (typeof cursor.filterFingerprint !== 'string' || cursor.filterFingerprint.length === 0) return null
    if (typeof cursor.planVersionId !== 'string' || cursor.planVersionId.length === 0) return null
    if (typeof cursor.evidenceFingerprint !== 'string' || cursor.evidenceFingerprint.length === 0) return null
    return {
      v: 1,
      sort: cursor.sort as MeasurementOverviewSort,
      targetKey: cursor.targetKey,
      displayedRunId: cursor.displayedRunId as string | null,
      filterFingerprint: cursor.filterFingerprint,
      planVersionId: cursor.planVersionId,
      evidenceFingerprint: cursor.evidenceFingerprint,
    }
  } catch {
    return null
  }
}

function validatedCursor(query: MeasurementOverviewQuery, activePlanVersionId: string): OverviewCursor | null {
  if (query.cursor === undefined) return null
  const cursor = parseCursor(query.cursor)
  if (cursor === null) return null
  const sort = query.sort ?? MEASUREMENT_OVERVIEW_DEFAULT_SORT
  if (cursor.sort !== sort) {
    throw validationError('The measurement overview cursor sort does not match the request.')
  }
  if (
    cursor.filterFingerprint !== overviewFilterFingerprint(query)
  ) {
    throw validationError('The measurement overview cursor filters do not match the request.')
  }
  if (
    query.runId !== undefined
    && cursor.displayedRunId !== query.runId
  ) {
    throw validationError('The measurement overview cursor run does not match the request.')
  }
  if (cursor.planVersionId !== activePlanVersionId) {
    throw validationError('The measurement overview cursor revision does not match the active plan.')
  }
  return cursor
}

/**
 * Split a scope's Properties by which signals they got.
 *
 * Counted over EVERY row in scope, never the page — a bucket derived from the
 * loaded page would change as someone paged, which is not what a total means.
 *
 * A Property lands in one of the four measured buckets only when BOTH signals
 * were measured. Mentioned-with-citation-unmeasured is NOT "mentioned only":
 * that phrasing asserts the Property was not cited, and nothing measured that.
 * Half-measured therefore counts as `notMeasured`, which is the honest reading
 * and keeps the buckets disjoint.
 */
export function measurementOutcomeCounts(
  rows: readonly MeasurementPropertyRow[],
): MeasurementOutcomeCounts {
  const counts = {
    bothSignals: 0, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 0, total: rows.length,
  }
  for (const row of rows) {
    const mention = row.mentionCoverage
    const citation = row.citationCoverage
    if (mention.state !== 'available' || citation.state !== 'available') {
      counts.notMeasured += 1
      continue
    }
    // `numerator` is optional on an available metric; a metric that reports a
    // rate without one still says whether the signal occurred at all.
    const mentioned = (mention.numerator ?? mention.value) > 0
    const cited = (citation.numerator ?? citation.value) > 0
    if (mentioned && cited) counts.bothSignals += 1
    else if (mentioned) counts.mentionedOnly += 1
    else if (cited) counts.citedOnly += 1
    else counts.neither += 1
  }
  return counts
}

function pageOf(
  rows: readonly MeasurementPropertyRow[],
  query: MeasurementOverviewQuery,
  displayedRunId: string | null,
  activePlanVersionId: string,
  evidenceFingerprint: string,
  // Returned together on purpose: the counts are over the FULL row set this
  // function was handed, and the page is a slice of that same set. Computing
  // them apart is how a total ends up describing a different population than
  // the rows beneath it.
): { page: MeasurementOverviewResponse['properties']; outcomes: MeasurementOutcomeCounts } {
  const sort = query.sort ?? MEASUREMENT_OVERVIEW_DEFAULT_SORT
  const ordered = [...rows].sort((left, right) => compareRows(left, right, sort))
  const limit = query.limit ?? MEASUREMENT_PAGE_DEFAULT_LIMIT
  let offset = 0
  if (query.cursor !== undefined) {
    const cursor = validatedCursor(query, activePlanVersionId)
    if (cursor !== null && cursor.evidenceFingerprint !== evidenceFingerprint) {
      throw validationError('The measurement overview cursor evidence changed between pages.')
    }
    const index = cursor === null
      // The original endpoint shipped this label-only cursor. It is safe only
      // on the implicit default request; explicit sort requests must prove
      // their ordering through the new cursor envelope.
      ? query.sort === undefined
        ? ordered.findIndex(row => legacyCursorOf(row) === query.cursor)
        : -1
      : ordered.findIndex(row => row.targetKey === cursor.targetKey)
    if (index < 0) throw validationError('The measurement overview cursor does not belong to this result set.')
    offset = index + 1
  }
  const items = ordered.slice(offset, offset + limit)
  const last = items.at(-1)
  return {
    page: {
      items,
      nextCursor: last === undefined || ordered.at(offset + limit) === undefined
        ? null
        : cursorOf(
            last,
            sort,
            displayedRunId,
            overviewFilterFingerprint(query),
            activePlanVersionId,
            evidenceFingerprint,
          ),
      totalEstimate: ordered.length,
    },
    outcomes: measurementOutcomeCounts(ordered),
  }
}

/**
 * A run pinned to another revision answered a different set of questions, and a
 * run pinned to none answered questions this revision never asked. Neither may
 * be joined into these numbers, so naming one is refused rather than mixed in.
 */
export function runRevisionMismatch(runId: string, runRevision: number | null, activeRevision: number): AppError {
  if (runRevision === null) {
    return new AppError(
      'MEASUREMENT_RUN_REVISION_MISMATCH',
      `Run '${runId}' measured no published plan revision. Select a run pinned to the active revision.`,
      422,
      { runId, runRevision: null, activeRevision },
    )
  }
  return measurementRunRevisionMismatch(runId, runRevision, activeRevision)
}

export function displayedState(status: string): MeasurementState {
  switch (status) {
    case RunStatuses.completed:
      return 'complete'
    case RunStatuses.partial:
      return 'partial'
    case RunStatuses.running:
      return 'running'
    case RunStatuses.queued:
      return 'queued'
    // A cancelled run stopped short of what it promised, which is what a failed
    // one did as far as this revision's numbers are concerned.
    default:
      return 'failed'
  }
}

/** `from`/`to` are calendar days; a run stamped late on the end day is still inside the window. */
function windowBound(value: string | undefined, endOfDay: boolean): string | undefined {
  if (value === undefined) return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  return `${value}${endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z'}`
}

function selectDisplayedRun(
  db: DatabaseClient,
  projectId: string,
  active: ActiveMeasurementPlan,
  query: MeasurementOverviewQuery,
): typeof runs.$inferSelect | undefined {
  const cursor = validatedCursor(query, active.version.id)
  const selectedRunId = query.runId ?? cursor?.displayedRunId
  if (selectedRunId === null) return undefined
  if (selectedRunId === undefined) {
    // The default is the most recent completed run pinned to the active
    // revision, and never a spot check — see `latestMeasurementRun`. `from`/`to`
    // narrow which run that is; they never slice one run's evidence.
    return latestMeasurementRun(db, projectId, active.version.id, [RunStatuses.completed], {
      from: windowBound(query.from, false),
      to: windowBound(query.to, true),
    })
  }
  const run = db.select().from(runs).where(and(eq(runs.projectId, projectId), eq(runs.id, selectedRunId))).get()
  if (!run) throw notFound('Run', selectedRunId)
  // A run pinned to a comparable prior revision (a label-only republish chain)
  // measured exactly the questions the active revision asks, so naming it is
  // continuity, not cross-revision mixing.
  if (runVersionServesActiveVersion(db, projectId, active.version.id, run.measurementPlanVersionId)) return run

  const pinned = run.measurementPlanVersionId === null
    ? null
    : db.select({ revision: measurementPlanVersions.revision }).from(measurementPlanVersions)
        .where(eq(measurementPlanVersions.id, run.measurementPlanVersionId)).get()?.revision ?? null
  throw runRevisionMismatch(run.id, pinned, active.version.revision)
}

/** Only a v2 group carries the frozen competitors a named share needs. */
function v2GroupOf(plan: StoredMeasurementPlan, groupKey: string): MeasurementPlanV2['groups'][number] | null {
  if (plan.schemaVersion !== MEASUREMENT_PLAN_V2_SCHEMA_VERSION) return null
  return plan.groups.find(candidate => candidate.stableKey === groupKey) ?? null
}

function resolveScope(plan: StoredMeasurementPlan, query: MeasurementOverviewQuery): ScopeSelection {
  if (query.scope === 'group') {
    if (query.groupKey === undefined) throw validationError('"groupKey" is required when scope is "group".')
    const groupKey = query.groupKey
    const group = plan.groups.find(candidate => candidate.stableKey === groupKey)
    if (!group) throw validationError(`Measurement group "${groupKey}" is not in the active revision.`)
    return {
      kind: 'group',
      key: group.stableKey,
      label: group.label,
      targetKeys: [...group.targetKeys],
      group: v2GroupOf(plan, groupKey),
    }
  }
  if (query.scope === 'property') {
    if (query.targetKey === undefined) throw validationError('"targetKey" is required when scope is "property".')
    const target = plan.targets.find(candidate => candidate.stableKey === query.targetKey)
    if (!target) throw validationError(`Measurement Property "${query.targetKey}" is not in the active revision.`)
    return { kind: 'property', key: target.stableKey, label: target.label, targetKeys: [target.stableKey], group: null }
  }
  return { kind: 'all', label: 'All Properties', targetKeys: plan.targets.map(target => target.stableKey), group: null }
}

/**
 * Named Share of Voice exists only for a group's Non-brand basket with confirmed
 * competitors. Everywhere else it is absent rather than zeroed: All Properties
 * and a single Property have no comparable set to share a denominator with.
 */
function namedIdentitiesFor(
  plan: MeasurementPlanV2,
  scope: ScopeSelection,
  queryClass: MeasurementQueryClassFilter,
): NamedIdentity[] {
  if (scope.kind !== 'group' || queryClass !== 'non-brand' || scope.group === null) return []
  if (scope.group.competitors.length === 0) return []

  const brand = plan.identities.projectBrand
  return [
    {
      key: 'project',
      kind: 'project',
      stableKey: 'project',
      label: brand.names.at(0) ?? brand.canonicalHost,
      domain: brand.canonicalHost,
      aliases: brand.names,
    },
    ...scope.group.competitors.map(competitor => ({
      key: `competitor:${competitor.stableKey}`,
      kind: 'competitor' as const,
      stableKey: competitor.stableKey,
      label: competitor.label,
      domain: competitor.domain,
      // The frozen label is an identity name too, so a competitor published
      // without extra aliases is still matchable in an answer.
      aliases: [...new Set([competitor.label, ...competitor.aliases])],
    })),
  ]
}

function nextActionFor(
  db: DatabaseClient,
  projectId: string,
  displayed: typeof runs.$inferSelect | undefined,
  flags: number,
): MeasurementOverviewResponse['nextAction'] {
  // Same precedence the setup state uses: finish an open draft, then measure,
  // then review what the measurement surfaced.
  const draft = db.select({ id: measurementPlanDrafts.id }).from(measurementPlanDrafts)
    .where(eq(measurementPlanDrafts.projectId, projectId)).get()
  if (draft) return { kind: 'complete_setup' }
  if (!displayed) return { kind: 'run_measurement' }
  if (flags > 0) return { kind: 'review_flags', count: flags }
  return { kind: 'none' }
}

function planExpectedSlots(plan: StoredMeasurementPlan): number {
  return plan.executionNodes.reduce((total, node) => total + node.expectedSnapshots, 0)
}

function matchesSearch(row: PropertyLabel, search: string | undefined): boolean {
  if (search === undefined) return true
  const needle = normalizedText(search)
  if (needle === '') return true
  return normalizedText(row.label).includes(needle) || normalizedText(row.targetKey).includes(needle)
}

function propertyLabels(plan: StoredMeasurementPlan, scope: ScopeSelection): PropertyLabel[] {
  const labels = new Map(plan.targets.map(target => [target.stableKey, target.label]))
  return scope.targetKeys
    .map(targetKey => ({ targetKey, label: labels.get(targetKey) ?? targetKey }))
}

function scopeDto(scope: ScopeSelection): MeasurementOverviewResponse['scope'] {
  return { kind: scope.kind, ...(scope.key === undefined ? {} : { key: scope.key }), label: scope.label }
}

function runProgress(
  db: DatabaseClient,
  displayed: typeof runs.$inferSelect | undefined,
  plan: StoredMeasurementPlan,
): { completed: number; expected: number } {
  if (!displayed) return { completed: 0, expected: planExpectedSlots(plan) }
  const completeness = measurementRunCompleteness(db, displayed.id)
  return { completed: completeness.executed, expected: completeness.expected }
}

/**
 * An active v1 revision has no Branded/Non-brand assignments at all, so every
 * metric this surface reports is class-dependent and none of them can be
 * produced. Republishing is the action that changes that (§2).
 */
function planV1Overview(
  db: DatabaseClient,
  projectId: string,
  active: ActiveMeasurementPlan,
  query: MeasurementOverviewQuery,
  scope: ScopeSelection,
): MeasurementOverviewResponse {
  const displayed = selectDisplayedRun(db, projectId, active, query)
  const { page, outcomes } = pageOf(
    propertyLabels(active.plan, scope)
      .filter(row => matchesSearch(row, query.search))
      .map(row => ({
        ...row,
        mentionCoverage: unavailable('plan_v1'),
        citationCoverage: unavailable('plan_v1'),
        providers: [],
        flags: 0,
      })),
    query,
    displayed?.id ?? null,
    active.version.id,
    // V1 rows are always plan_v1-unavailable and label/key ordered. Evidence
    // cannot change this page, so avoid materializing a full run merely to hash it.
    overviewEvidenceFingerprint([]),
  )

  return {
    mode: 'active-v1',
    scope: scopeDto(scope),
    queryClass: query.queryClass ?? 'all',
    measurement: {
      state: displayed ? displayedState(displayed.status) : 'not_measured',
      ...(displayed ? { currentRunId: displayed.id, displayedRunId: displayed.id } : {}),
      ...runProgress(db, displayed, active.plan),
      ...(displayed?.finishedAt ? { completedAt: displayed.finishedAt } : {}),
    },
    nextAction: { kind: 'republish_setup' },
    metrics: {
      propertiesMentioned: unavailable('plan_v1'),
      mentionCoverage: unavailable('plan_v1'),
      citationCoverage: unavailable('plan_v1'),
      brandPresence: unavailable('plan_v1'),
      sov: unavailable('plan_v1'),
    },
    properties: page,
    outcomes,
    flags: { total: 0 },
  }
}

function planV2Overview(
  db: DatabaseClient,
  projectId: string,
  active: ActiveMeasurementPlan,
  plan: MeasurementPlanV2,
  query: MeasurementOverviewQuery,
  scope: ScopeSelection,
  cache: MeasurementOverviewCache,
): MeasurementOverviewResponse {
  const queryClass = query.queryClass ?? 'all'
  const displayed = selectDisplayedRun(db, projectId, active, query)
  const current = latestMeasurementRun(db, projectId, active.version.id, CURRENT_RUN_STATUSES)
  const currentDto = current ? { currentRunId: current.id } : {}

  if (!displayed) {
    const { page, outcomes } = pageOf(
      propertyLabels(plan, scope)
        .filter(row => matchesSearch(row, query.search))
        .map(row => ({
          ...row,
          mentionCoverage: unavailable('no_completed_run'),
          citationCoverage: unavailable('no_completed_run'),
          providers: [],
          flags: 0,
        })),
      query,
      null,
      active.version.id,
      overviewEvidenceFingerprint([]),
    )
    return {
      mode: 'active-v2',
      scope: scopeDto(scope),
      queryClass,
      measurement: {
        state: 'not_measured',
        ...currentDto,
        ...runProgress(db, displayed, plan),
        includesHistoricalData: false,
      },
      nextAction: nextActionFor(db, projectId, displayed, 0),
      metrics: {
        propertiesMentioned: unavailable('no_completed_run'),
        mentionCoverage: unavailable('no_completed_run'),
        citationCoverage: unavailable('no_completed_run'),
        brandPresence: unavailable('no_completed_run'),
        sov: unavailable('no_completed_run'),
      },
      properties: page,
      outcomes,
      flags: { total: 0 },
    }
  }

  const snapshots = db.select().from(querySnapshots).where(eq(querySnapshots.runId, displayed.id)).all()
  const evidenceFingerprint = overviewEvidenceFingerprint(snapshots)
  const identities = namedIdentitiesFor(plan, scope, queryClass)
  const overview = cache.getOrBuild({
    planVersionId: active.version.id,
    revision: active.version.revision,
    runId: displayed.id,
    aggregateFingerprint: overviewAggregateFingerprint(query),
    evidenceFingerprint,
  }, () => {
    const manifest = measurementRunExpectedSlots(displayed, plan)
    const { input, edgeQueryClass } = buildMeasurementPlanV2ReportInput(active.version.revision, plan, manifest, snapshots)

    // Provider, location and question class narrow the population every metric is
    // taken over, so they are applied before a single aggregate is computed.
    // `search` never is.
    const expectedSlots = input.expectedSlots.filter(slot => (
      (query.provider === undefined || slot.provider === normalizedText(query.provider))
      && (query.location === undefined || normalizedText(slot.location ?? '') === normalizedText(query.location))
    ))
    const usageEdges: readonly MeasurementUsageEdgeInput[] = queryClass === 'all'
      ? input.usageEdges
      : input.usageEdges.filter(edge => edgeQueryClass.get(edge.id) === queryClass)

    return buildMeasurementOverview({
      ...input,
      expectedSlots,
      usageEdges,
      scopeTargetIds: scope.targetKeys,
      namedIdentities: identities,
    })
  })

  const measured = new Map<string, MeasurementOverviewPropertyRow>(
    overview.properties.map(row => [row.targetId, row]),
  )
  const { page, outcomes } = pageOf(
    propertyLabels(plan, scope)
      .filter(row => matchesSearch(row, query.search))
      .map(row => {
        const property = measured.get(row.targetKey)
        return {
          ...row,
          mentionCoverage: property ? coverageMetric(property.mentionCoverage) : unavailable('no_population'),
          citationCoverage: property ? coverageMetric(property.citationCoverage) : unavailable('no_population'),
          providers: property ? providerRows(property) : [],
          flags: property?.flags ?? 0,
        }
      }),
    query,
    displayed.id,
    active.version.id,
    evidenceFingerprint,
  )

  const credited = new Map((overview.namedShareOfVoice?.entries ?? []).map(entry => [entry.key, entry]))
  const namedShareOfVoice: NamedShareOfVoice | undefined = overview.namedShareOfVoice === null || scope.key === undefined
    ? undefined
    : {
        groupKey: scope.key,
        queryClass: 'non-brand',
        denominator: overview.namedShareOfVoice.denominator,
        entries: identities.map(identity => ({
          kind: identity.kind,
          stableKey: identity.stableKey,
          label: identity.label,
          domain: identity.domain,
          credits: credited.get(identity.key)?.credits ?? 0,
          share: credited.get(identity.key)?.share ?? 0,
        })),
      }

  const brandPresence = coverageMetric(overview.brandPresence)
  return {
    mode: 'active-v2',
    scope: scopeDto(scope),
    queryClass,
    measurement: {
      state: displayedState(displayed.status),
      ...currentDto,
      displayedRunId: displayed.id,
      ...runProgress(db, displayed, plan),
      ...(displayed.finishedAt ? { completedAt: displayed.finishedAt } : {}),
      includesHistoricalData: overview.includesHistoricalData,
    },
    nextAction: nextActionFor(db, projectId, displayed, overview.flags),
    metrics: {
      propertiesMentioned: countMetric(overview.propertiesMentioned),
      mentionCoverage: coverageMetric(overview.mentionCoverage),
      citationCoverage: coverageMetric(overview.citationCoverage),
      brandPresence,
      // Deprecated alias of `brandPresence`, carrying the identical value until
      // the browser migrates off it (§0.2). The two must never diverge.
      sov: brandPresence,
    },
    properties: page,
    outcomes,
    flags: { total: overview.flags },
    ...(namedShareOfVoice === undefined ? {} : { namedShareOfVoice }),
  }
}

export interface MeasurementOverviewRoutesOptions {
  /** Supply one when the host owns a longer-lived server/cache lifecycle. */
  cache?: MeasurementOverviewCache
}

export async function measurementOverviewRoutes(app: FastifyInstance, options: MeasurementOverviewRoutesOptions = {}) {
  const cache = options.cache ?? createMeasurementOverviewCache()
  app.get<{ Params: { name: string }; Querystring: Record<string, unknown> }>(
    '/projects/:name/measurement-overview',
    async request => {
      const project = resolveProject(app.db, request.params.name)
      const query = parseOverviewQuery(request.query)
      const active = activeMeasurementPlan(app.db, project.id)
      // This surface describes an active plan. Without one there is nothing to
      // aggregate, and Simple has its own reads.
      if (!active) throw notFound('Active measurement plan', project.name)

      const scope = resolveScope(active.plan, query)
      const response = active.plan.schemaVersion === MEASUREMENT_PLAN_V2_SCHEMA_VERSION
        ? planV2Overview(app.db, project.id, active, active.plan, query, scope, cache)
        : planV1Overview(app.db, project.id, active, query, scope)
      return measurementOverviewResponseSchema.parse(response)
    },
  )
}
