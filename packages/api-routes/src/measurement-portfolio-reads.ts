/**
 * Compact, revision-pinned Advanced Measurement reads.
 *
 * These are deliberately derived from the active v2 plan plus one stored run.
 * They never inspect mutable project queries or make a provider call: a read
 * must describe precisely what that immutable run measured.
 */

import { and, desc, eq, inArray, lt, or } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION,
  RunKinds,
  RunStatuses,
  RunTriggers,
  brandKeyFromText,
  measurementChangesQuerySchema,
  measurementChangesResponseSchema,
  measurementDataQualityQuerySchema,
  measurementDataQualityResponseSchema,
  measurementPortfolioSummaryQuerySchema,
  measurementPortfolioSummaryResponseSchema,
  measurementPropertyCompetitorsQuerySchema,
  measurementPropertyCompetitorsResponseSchema,
  notFound,
  validationError,
  type MeasurementChangesQuery,
  type MeasurementChangesResponse,
  type MeasurementDataQualityQuery,
  type MeasurementDataQualityResponse,
  type MeasurementMetricUnavailableReason,
  type MeasurementPlanV2,
  type MeasurementPortfolioMarket,
  type MeasurementPortfolioSummaryQuery,
  type MeasurementPortfolioSummaryResponse,
  type MeasurementPropertyCompetitorsQuery,
  type MeasurementPropertyCompetitorsResponse,
  type MeasurementQueryClassFilter,
  type MetricValue,
} from '@ainyc/canonry-contracts'
import { querySnapshots, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { resolveProject } from './helpers.js'
import {
  activeMeasurementPlan,
  displayedState,
  type ActiveMeasurementPlan,
} from './measurement-overview.js'
import {
  buildMeasurementOverview,
  normalizeMeasurementLocation,
  targetMentionedInAnswer,
  type MeasurementOverview,
  type MeasurementRate,
} from './measurement-report.js'
import {
  assertMeasurementQuestionTargetScope,
  materializeMeasurementQuestionRun,
  selectMeasurementQuestionRun,
} from './measurement-question-reads.js'
import { comparableMeasurementVersionIds, measurementRunExpectedSlots } from './measurement-report-adapter.js'
import { measurementRunCompleteness } from './measurement-run-completeness.js'

/** Compact demo lists intentionally stop at ten unless the caller asks for more. */
const DEFAULT_LIMIT = 10

type RunRow = typeof runs.$inferSelect
type MaterializedRun = ReturnType<typeof materializeMeasurementQuestionRun>

interface MeasurementFilters {
  queryClass: MeasurementQueryClassFilter
  provider?: string
  location?: string
}

interface TargetAnswer {
  slotId: string
  provider: string
  question: string
  snapshot: typeof querySnapshots.$inferSelect
  mentioned: boolean | null
  cited: boolean | null
}

interface RecommendationRow {
  name: string
  occurrences: number
  providers: string[]
  questions: string[]
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
}

function parseLimitQuery<T>(
  raw: Record<string, unknown>,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { issues: unknown } } },
  message: string,
): T {
  const candidate = { ...raw, ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }) }
  const parsed = schema.safeParse(candidate)
  if (!parsed.success) throw validationError(message, { issues: parsed.error.issues })
  return parsed.data
}

function activeV2Plan(
  db: DatabaseClient,
  projectId: string,
  surface: string,
): { active: ActiveMeasurementPlan; plan: MeasurementPlanV2 } {
  const active = activeMeasurementPlan(db, projectId)
  if (!active) throw notFound('Active measurement plan', projectId)
  if (active.plan.schemaVersion !== MEASUREMENT_PLAN_V2_SCHEMA_VERSION) {
    throw validationError(`${surface} is not available for a schema v1 revision. Republish setup first.`)
  }
  return { active, plan: active.plan }
}

function measurementDto(active: ActiveMeasurementPlan, run: RunRow | undefined) {
  return {
    state: run === undefined ? 'not_measured' as const : displayedState(run.status),
    displayedRunId: run?.id ?? null,
    planRevision: active.version.revision,
    completedAt: run?.finishedAt ?? null,
  }
}

function runIdentity(run: Pick<RunRow, 'measurementExecutionIdentity'>): string | null {
  return run.measurementExecutionIdentity?.checksum ?? null
}

function metricReason(reason: MeasurementRate['reason']): MeasurementMetricUnavailableReason {
  switch (reason) {
    case 'no-population': return 'no_population'
    case 'incomplete':
    case 'evidence-incomplete': return 'evidence_incomplete'
    case 'aliasless':
    case 'no-competitors':
    case 'no-project-aliases': return 'not_applicable'
    default: return 'evidence_incomplete'
  }
}

function unavailable(reason: MeasurementMetricUnavailableReason): MetricValue {
  return { state: 'unavailable', reason }
}

function coverageMetric(rate: MeasurementRate): MetricValue {
  if (rate.rate === null) return unavailable(metricReason(rate.reason))
  return { state: 'available', value: rate.rate, numerator: rate.numerator, denominator: rate.denominator }
}

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

/** The materializer reads through its explicit DB argument; the report kernel never does. */
function materializeWithDb(
  db: DatabaseClient,
  active: ActiveMeasurementPlan,
  plan: MeasurementPlanV2,
  run: RunRow,
): MaterializedRun {
  return materializeMeasurementQuestionRun(db, active, plan, run)
}

function filteredOverviewWithDb(
  db: DatabaseClient,
  active: ActiveMeasurementPlan,
  plan: MeasurementPlanV2,
  run: RunRow,
  filters: MeasurementFilters,
  targetKeys: readonly string[],
): {
  materialized: MaterializedRun
  overview: MeasurementOverview
  /** The filtered inputs, exposed so a caller can re-scope them without re-reading the database. */
  expectedSlots: MaterializedRun['input']['expectedSlots']
  usageEdges: MaterializedRun['input']['usageEdges']
} {
  const materialized = materializeWithDb(db, active, plan, run)
  const provider = filters.provider === undefined ? undefined : normalizeText(filters.provider)
  const location = filters.location === undefined ? undefined : normalizeMeasurementLocation(filters.location)
  const expectedSlots = materialized.input.expectedSlots.filter(slot => (
    (provider === undefined || normalizeText(slot.provider) === provider)
    && (location === undefined || normalizeMeasurementLocation(slot.location) === location)
  ))
  const usageEdges = materialized.input.usageEdges.filter(edge => (
    filters.queryClass === 'all' || materialized.edgeQueryClass.get(edge.id) === filters.queryClass
  ))
  return {
    materialized,
    expectedSlots,
    usageEdges,
    overview: buildMeasurementOverview({
      ...materialized.input,
      expectedSlots,
      usageEdges,
      scopeTargetIds: [...targetKeys],
    }),
  }
}

function targetAnswers(
  plan: MeasurementPlanV2,
  target: MeasurementPlanV2['targets'][number],
  materialized: MaterializedRun,
  filters: MeasurementFilters,
): { expected: number; answers: TargetAnswer[] } {
  const assignmentsByExecution = new Map(plan.assignments
    .filter(assignment => assignment.targetKey === target.stableKey)
    .filter(assignment => filters.queryClass === 'all' || assignment.queryClass === filters.queryClass)
    .map(assignment => [assignment.executionNodeKey, assignment]))
  const edgesByExecution = new Map(materialized.input.usageEdges
    .filter(edge => edge.type === 'target' && edge.targetId === target.stableKey)
    .filter(edge => assignmentsByExecution.has(edge.executionId))
    .map(edge => [edge.executionId, edge]))
  const ownEdgeIds = new Set([...edgesByExecution.values()].map(edge => edge.id))
  const citedSlotIds = new Set(materialized.evidence.evidence
    .filter(row => ownEdgeIds.has(row.usageEdgeId) && row.classification === 'assigned')
    .map(row => row.expectedSlotId))
  const incompleteObservationIds = new Set(materialized.evidence.diagnostics.evidenceIncompleteObservationIds)
  const questionsById = new Map(plan.querySnapshots.map(question => [question.queryId, question.queryText]))
  const provider = filters.provider === undefined ? undefined : normalizeText(filters.provider)
  const location = filters.location === undefined ? undefined : normalizeMeasurementLocation(filters.location)

  const slots = materialized.input.expectedSlots.filter(slot => (
    assignmentsByExecution.has(slot.executionId)
    && edgesByExecution.has(slot.executionId)
    && (provider === undefined || normalizeText(slot.provider) === provider)
    && (location === undefined || normalizeMeasurementLocation(slot.location) === location)
  ))
  const answers: TargetAnswer[] = []
  for (const slot of slots) {
    const observation = materialized.observationsBySlot.get(slot.id)
    const snapshot = observation === undefined ? undefined : materialized.snapshotsById.get(observation.id)
    if (!snapshot || snapshot.answerText === null) continue
    const assignment = assignmentsByExecution.get(slot.executionId)
    if (!assignment) throw new Error(`measurement assignment provenance is corrupt for execution ${slot.executionId}`)
    answers.push({
      slotId: slot.id,
      provider: slot.provider,
      question: questionsById.get(assignment.queryId) ?? slot.queryText,
      snapshot,
      mentioned: target.mentionNotApplicable
        ? null
        : targetMentionedInAnswer(snapshot.answerText, target.stableKey, materialized.input.targets),
      cited: incompleteObservationIds.has(snapshot.id) ? null : citedSlotIds.has(slot.id),
    })
  }
  return { expected: slots.length, answers }
}

function targetAliasKeys(target: MeasurementPlanV2['targets'][number]): Set<string> {
  return new Set([target.label, ...target.aliases]
    .map(brandKeyFromText)
    .filter(Boolean))
}

function recommendationRows(
  target: MeasurementPlanV2['targets'][number],
  population: ReturnType<typeof targetAnswers>,
): RecommendationRow[] {
  const aliases = targetAliasKeys(target)
  const grouped = new Map<string, { name: string; occurrences: number; providers: Set<string>; questions: Set<string> }>()
  for (const answer of population.answers) {
    // An incomplete source capture makes target citation unknown. Treating that
    // as a miss would manufacture a competitor from evidence that did not land.
    if (answer.mentioned !== false || answer.cited !== false) continue
    for (const rawName of answer.snapshot.recommendedCompetitors) {
      const name = rawName.normalize('NFKC').trim().replace(/\s+/g, ' ')
      const key = brandKeyFromText(name)
      if (!key || aliases.has(key)) continue
      const existing = grouped.get(key)
      if (existing) {
        existing.occurrences++
        existing.providers.add(answer.provider)
        existing.questions.add(answer.question)
        if (compareText(name, existing.name) < 0) existing.name = name
      } else {
        grouped.set(key, {
          name,
          occurrences: 1,
          providers: new Set([answer.provider]),
          questions: new Set([answer.question]),
        })
      }
    }
  }
  return [...grouped.values()]
    .map(row => {
      const providers = [...row.providers].sort(compareText)
      const questions = [...row.questions].sort(compareText)
      return {
        name: row.name,
        occurrences: row.occurrences,
        providers: providers.slice(0, 5),
        providerTotal: providers.length,
        providersTruncated: providers.length > 5,
        questions: questions.slice(0, 5),
        questionTotal: questions.length,
        questionsTruncated: questions.length > 5,
      }
    })
    .sort((left, right) => right.occurrences - left.occurrences || compareText(left.name, right.name))
}

function propertyDto(target: MeasurementPlanV2['targets'][number]) {
  return { targetKey: target.stableKey, label: target.label }
}

function compareWeakest(
  left: { targetKey: string; label: string; mentionCoverage: MetricValue; citationCoverage: MetricValue },
  right: { targetKey: string; label: string; mentionCoverage: MetricValue; citationCoverage: MetricValue },
): number {
  const leftUnavailable = left.mentionCoverage.state === 'unavailable' || left.citationCoverage.state === 'unavailable'
  const rightUnavailable = right.mentionCoverage.state === 'unavailable' || right.citationCoverage.state === 'unavailable'
  if (leftUnavailable !== rightUnavailable) return leftUnavailable ? 1 : -1
  if (leftUnavailable || rightUnavailable) {
    return compareText(left.label, right.label) || compareText(left.targetKey, right.targetKey)
  }
  // Both rows are fully measured after the guard above.
  if (left.mentionCoverage.state === 'available' && right.mentionCoverage.state === 'available'
    && left.mentionCoverage.value !== right.mentionCoverage.value) {
    return left.mentionCoverage.value - right.mentionCoverage.value
  }
  if (left.citationCoverage.state === 'available' && right.citationCoverage.state === 'available'
    && left.citationCoverage.value !== right.citationCoverage.value) {
    return left.citationCoverage.value - right.citationCoverage.value
  }
  return compareText(left.label, right.label) || compareText(left.targetKey, right.targetKey)
}

function requireGroup(plan: MeasurementPlanV2, groupKey: string) {
  const group = plan.groups.find(candidate => candidate.stableKey === groupKey)
  if (!group) throw validationError(`Measurement group "${groupKey}" is not in the active revision.`)
  return group
}

function requireTarget(plan: MeasurementPlanV2, targetKey: string) {
  const target = plan.targets.find(candidate => candidate.stableKey === targetKey)
  if (!target) throw validationError(`Measurement Property "${targetKey}" is not in the active revision.`)
  return target
}

function scopedTargetKeys(plan: MeasurementPlanV2, run: RunRow): Set<string> | null {
  if (run.measurementScope === null) return null
  if (run.measurementScope.resolvedTargets.length > 0) {
    return new Set(run.measurementScope.resolvedTargets)
  }

  // A query-only slice records no requested Target keys. Resolve its actual
  // reporting population from the frozen executions it ran, never from the
  // mutable query library.
  const executionIds = new Set(measurementRunExpectedSlots(run, plan).expectedSlots.map(slot => slot.executionId))
  return new Set(plan.usageEdges
    .filter(edge => executionIds.has(edge.executionNodeKey))
    .map(edge => edge.targetKey))
}

function targetKeysForRun(
  plan: MeasurementPlanV2,
  run: RunRow | undefined,
  requested: readonly string[],
  requireEntireScope: boolean,
): string[] {
  if (!run) return [...requested]
  const covered = scopedTargetKeys(plan, run)
  if (covered === null) return [...requested]
  const selected = requested.filter(targetKey => covered.has(targetKey))
  if (requireEntireScope && selected.length !== requested.length) {
    throw validationError('The requested reporting scope is outside the selected spot check.')
  }
  return selected
}

/**
 * Roll every named market up from the run that is already materialized.
 *
 * `buildMeasurementOverview` is pure over the materialized input, so each market
 * is a re-scope of data already in memory rather than another database read.
 * Doing this server-side is what keeps the dashboard to one request and gives
 * the CLI and MCP the same table for free.
 *
 * Returns [] when the caller already narrowed to one group: repeating that
 * group's own numbers under a "compare markets" heading says nothing.
 *
 * Every market is scoped through `targetKeysForRun`, the same narrowing the
 * group-scoped read applies. Scoping on raw `group.targetKeys` instead made one
 * response contradict itself on a spot check: the roll-up credited Properties
 * the run never measured, so `markets[x]` and `?groupKey=x` reported different
 * rates and different populations for the same market in the same revision. A
 * market with no member inside the spot check reported a rate at all, which is
 * the measured-zero failure this surface exists to prevent.
 */
function marketRollup(
  plan: MeasurementPlanV2,
  run: RunRow,
  materialized: MaterializedRun,
  expectedSlots: MaterializedRun['input']['expectedSlots'],
  usageEdges: MaterializedRun['input']['usageEdges'],
  scopedToOneGroup: boolean,
): MeasurementPortfolioMarket[] {
  if (scopedToOneGroup) return []
  return plan.groups.map(group => {
    // A market with no member inside the displayed run still goes through the
    // kernel with an empty scope rather than short-circuiting to a hand-picked
    // reason. The kernel is what decides why a metric is unavailable, and the
    // group-scoped read of the same market reaches it the same way — inventing
    // a reason here is how the two surfaces start disagreeing again.
    const targetKeys = targetKeysForRun(plan, run, group.targetKeys, false)
    const overview = buildMeasurementOverview({
      ...materialized.input,
      expectedSlots,
      usageEdges,
      scopeTargetIds: targetKeys,
    })
    return {
      groupKey: group.stableKey,
      label: group.label,
      propertyCount: targetKeys.length,
      propertiesMentioned: countMetric(overview.propertiesMentioned),
      mentionCoverage: coverageMetric(overview.mentionCoverage),
      citationCoverage: coverageMetric(overview.citationCoverage),
    }
  }).sort(compareWeakestMarket)
}

/**
 * Worst-first, so the market that needs attention is the first one read. An
 * unavailable rate sorts last: it is not a bad result, it is the absence of one.
 *
 * Ranking on mention alone sorted a market whose mention rate was withheld but
 * whose citation rate was a measured worst-in-portfolio 0% dead last. This
 * mirrors `compareWeakest`, which the Property rows already use: a row is
 * demoted when EITHER metric is missing, and citation breaks a mention tie.
 *
 * Exported for its own unit test. Several of its branches need a market whose
 * two metrics disagree about availability, which no arrangement of the seeded
 * fixture can produce: the markets there share executions, so their capture
 * state is shared too.
 */
export function compareWeakestMarket(a: MeasurementPortfolioMarket, b: MeasurementPortfolioMarket): number {
  const aUnavailable = a.mentionCoverage.state === 'unavailable' || a.citationCoverage.state === 'unavailable'
  const bUnavailable = b.mentionCoverage.state === 'unavailable' || b.citationCoverage.state === 'unavailable'
  if (aUnavailable !== bUnavailable) return aUnavailable ? 1 : -1
  if (aUnavailable || bUnavailable) return compareText(a.label, b.label) || compareText(a.groupKey, b.groupKey)
  // Both rows are fully measured after the guard above.
  if (a.mentionCoverage.state === 'available' && b.mentionCoverage.state === 'available'
    && a.mentionCoverage.value !== b.mentionCoverage.value) {
    return a.mentionCoverage.value - b.mentionCoverage.value
  }
  if (a.citationCoverage.state === 'available' && b.citationCoverage.state === 'available'
    && a.citationCoverage.value !== b.citationCoverage.value) {
    return a.citationCoverage.value - b.citationCoverage.value
  }
  return compareText(a.label, b.label) || compareText(a.groupKey, b.groupKey)
}

function portfolioResponse(
  db: DatabaseClient,
  active: ActiveMeasurementPlan,
  plan: MeasurementPlanV2,
  query: MeasurementPortfolioSummaryQuery,
): MeasurementPortfolioSummaryResponse {
  const group = query.groupKey === undefined ? undefined : requireGroup(plan, query.groupKey)
  const run = selectMeasurementQuestionRun(db, active.version.projectId, active, query.runId)
  const requestedTargetKeys = group?.targetKeys ?? plan.targets.map(target => target.stableKey)
  const targetKeys = targetKeysForRun(plan, run, requestedTargetKeys, false)
  const targets = targetKeys.map(targetKey => requireTarget(plan, targetKey))
  const measurement = measurementDto(active, run)
  const filters: MeasurementFilters = {
    queryClass: query.queryClass,
    provider: query.provider,
    location: query.location,
  }

  if (!run) {
    const rows = targets.map(target => ({
      ...propertyDto(target),
      mentionCoverage: unavailable('no_completed_run'),
      citationCoverage: unavailable('no_completed_run'),
      flags: 0,
      recommendedInstead: [],
      recommendedInsteadTotal: 0,
      recommendedInsteadTruncated: false,
    })).sort(compareWeakest)
    const limit = query.limit ?? DEFAULT_LIMIT
    return measurementPortfolioSummaryResponseSchema.parse({
      portfolio: { groupKey: group?.stableKey ?? null, label: group?.label ?? null, measurementScope: null },
      measurement,
      queryClass: query.queryClass,
      metrics: {
        propertiesMentioned: unavailable('no_completed_run'),
        mentionCoverage: unavailable('no_completed_run'),
        citationCoverage: unavailable('no_completed_run'),
      },
      weakestProperties: rows.slice(0, limit),
      // Sorted through the same comparator as the measured branch. Plan order
      // is `stableKey`, so emitting it raw put markets in an order the schema
      // documents as worst-first and that changes the moment a run lands.
      markets: group !== undefined ? [] : plan.groups.map(g => ({
        groupKey: g.stableKey,
        label: g.label,
        propertyCount: g.targetKeys.length,
        propertiesMentioned: unavailable('no_completed_run'),
        mentionCoverage: unavailable('no_completed_run'),
        citationCoverage: unavailable('no_completed_run'),
      })).sort(compareWeakestMarket),
      totalProperties: rows.length,
      truncated: rows.length > limit,
    })
  }

  const { materialized, overview, expectedSlots: filteredSlots, usageEdges: filteredEdges } = filteredOverviewWithDb(db, active, plan, run, filters, targetKeys)
  const measured = new Map(overview.properties.map(row => [row.targetId, row]))
  const rows = targets.map(target => {
    const row = measured.get(target.stableKey)
    const recommendations = recommendationRows(target, targetAnswers(plan, target, materialized, filters))
    return {
      ...propertyDto(target),
      mentionCoverage: row ? coverageMetric(row.mentionCoverage) : unavailable('no_population'),
      citationCoverage: row ? coverageMetric(row.citationCoverage) : unavailable('no_population'),
      flags: row?.flags ?? 0,
      recommendedInstead: recommendations.slice(0, 5).map(({ name, occurrences }) => ({ name, occurrences })),
      recommendedInsteadTotal: recommendations.length,
      recommendedInsteadTruncated: recommendations.length > 5,
    }
  }).sort(compareWeakest)
  const limit = query.limit ?? DEFAULT_LIMIT
  return measurementPortfolioSummaryResponseSchema.parse({
    portfolio: {
      groupKey: group?.stableKey ?? null,
      label: group?.label ?? null,
      measurementScope: run.measurementScope === null ? 'full' : 'spot_check',
    },
    measurement,
    queryClass: query.queryClass,
    metrics: {
      propertiesMentioned: countMetric(overview.propertiesMentioned),
      mentionCoverage: coverageMetric(overview.mentionCoverage),
      citationCoverage: coverageMetric(overview.citationCoverage),
    },
    weakestProperties: rows.slice(0, limit),
    markets: marketRollup(plan, run, materialized, filteredSlots, filteredEdges, group !== undefined),
    totalProperties: rows.length,
    truncated: rows.length > limit,
  })
}

function propertyCompetitorsResponse(
  db: DatabaseClient,
  active: ActiveMeasurementPlan,
  plan: MeasurementPlanV2,
  query: MeasurementPropertyCompetitorsQuery,
): MeasurementPropertyCompetitorsResponse {
  const target = requireTarget(plan, query.targetKey)
  const run = selectMeasurementQuestionRun(db, active.version.projectId, active, query.runId)
  const queryClass = query.queryClass ?? 'all'
  const measurement = measurementDto(active, run)
  if (!run) {
    return measurementPropertyCompetitorsResponseSchema.parse({
      property: propertyDto(target),
      measurement,
      queryClass,
      basis: { state: 'unavailable', reason: 'no_completed_run' },
      competitors: [],
      total: 0,
      truncated: false,
    })
  }
  assertMeasurementQuestionTargetScope(plan, run, target.stableKey)

  const executionIds = [...new Set(plan.assignments
    .filter(assignment => assignment.targetKey === target.stableKey)
    .filter(assignment => queryClass === 'all' || assignment.queryClass === queryClass)
    .map(assignment => assignment.executionNodeKey))]
  const materialized = materializeMeasurementQuestionRun(db, active, plan, run, {
    executionIds,
    provider: query.provider,
    location: query.location,
  })
  const population = targetAnswers(plan, target, materialized, {
    queryClass,
    provider: query.provider,
    location: query.location,
  })
  if (population.expected === 0) {
    return measurementPropertyCompetitorsResponseSchema.parse({
      property: propertyDto(target),
      measurement,
      queryClass,
      basis: { state: 'unavailable', reason: 'no_population' },
      competitors: [],
      total: 0,
      truncated: false,
    })
  }
  if (population.answers.length === 0) {
    return measurementPropertyCompetitorsResponseSchema.parse({
      property: propertyDto(target),
      measurement,
      queryClass,
      basis: { state: 'unavailable', reason: 'evidence_incomplete' },
      competitors: [],
      total: 0,
      truncated: false,
    })
  }

  const competitors = recommendationRows(target, population)
  const targetMissResults = population.answers.filter(answer => answer.mentioned === false && answer.cited === false)
  const recommendationOccurrences = competitors.reduce((total, row) => total + row.occurrences, 0)
  const limit = query.limit ?? DEFAULT_LIMIT
  return measurementPropertyCompetitorsResponseSchema.parse({
    property: propertyDto(target),
    measurement,
    queryClass,
    basis: {
      state: 'available',
      answeredResults: population.answers.length,
      targetMissResults: targetMissResults.length,
      recommendationOccurrences,
    },
    competitors: competitors.slice(0, limit),
    total: competitors.length,
    truncated: competitors.length > limit,
  })
}

function changeTargetKeys(plan: MeasurementPlanV2, query: MeasurementChangesQuery): string[] {
  if (query.scope === 'all') return plan.targets.map(target => target.stableKey)
  if (query.scope === 'group') return [...requireGroup(plan, query.groupKey!).targetKeys]
  return [requireTarget(plan, query.targetKey!).stableKey]
}

function scopeKey(run: Pick<RunRow, 'measurementScope'>): string {
  if (run.measurementScope === null) return 'full'
  const scope = run.measurementScope
  return JSON.stringify({
    groups: [...scope.groups].sort(compareText),
    targets: [...scope.targets].sort(compareText),
    queries: [...scope.queries].sort(compareText),
    resolvedTargets: [...scope.resolvedTargets].sort(compareText),
  })
}

type PreviousResult =
  | { state: 'available'; run: RunRow }
  | { state: 'unavailable'; reason: 'no_previous_run' | 'execution_identity_changed' | 'incomplete' | 'not_comparable' }

function previousComparableRun(
  db: DatabaseClient,
  active: ActiveMeasurementPlan,
  current: RunRow,
): PreviousResult {
  if (current.status !== RunStatuses.completed) {
    return { state: 'unavailable', reason: 'incomplete' }
  }
  const candidates = db.select({
    id: runs.id,
    createdAt: runs.createdAt,
    status: runs.status,
    trigger: runs.trigger,
    measurementScope: runs.measurementScope,
    measurementExecutionIdentity: runs.measurementExecutionIdentity,
  }).from(runs).where(and(
    eq(runs.projectId, current.projectId),
    // The comparable chain keeps period-over-period alive across a label-only
    // republish: a run pinned to a comparable prior revision measured exactly
    // the questions the active revision asks. The execution-identity and scope
    // checks below still gate what actually compares.
    inArray(runs.measurementPlanVersionId, comparableMeasurementVersionIds(db, current.projectId, active.version.id)),
    eq(runs.kind, RunKinds['answer-visibility']),
    inArray(runs.status, [RunStatuses.completed, RunStatuses.partial]),
    or(
      lt(runs.createdAt, current.createdAt),
      and(eq(runs.createdAt, current.createdAt), lt(runs.id, current.id)),
    ),
  )).orderBy(desc(runs.createdAt), desc(runs.id)).all()
    .filter(candidate => (
      // Full reporting never admits probes. A plan slice is itself stored as a
      // probe, so an explicitly selected slice compares only with other slices;
      // the exact frozen scope check below then keeps the population identical.
      current.measurementScope === null
        ? candidate.trigger !== RunTriggers.probe
        : candidate.measurementScope !== null
    ))
  if (candidates.length === 0) return { state: 'unavailable', reason: 'no_previous_run' }
  const identity = runIdentity(current)
  if (identity === null) {
    return { state: 'unavailable', reason: 'not_comparable' }
  }
  const sameIdentity = candidates.filter(candidate => runIdentity(candidate) === identity)
  if (sameIdentity.length === 0) {
    return { state: 'unavailable', reason: 'execution_identity_changed' }
  }
  const sameScope = sameIdentity.filter(candidate => scopeKey(candidate) === scopeKey(current))
  if (sameScope.length === 0) return { state: 'unavailable', reason: 'not_comparable' }
  const previousCandidate = sameScope.find(candidate => candidate.status === RunStatuses.completed)
  if (!previousCandidate) {
    return { state: 'unavailable', reason: 'incomplete' }
  }
  const previous = db.select().from(runs).where(and(
    eq(runs.id, previousCandidate.id),
    eq(runs.projectId, current.projectId),
  )).get()
  if (!previous) return { state: 'unavailable', reason: 'not_comparable' }
  try {
    if (!measurementRunCompleteness(db, current.id).complete || !measurementRunCompleteness(db, previous.id).complete) {
      return { state: 'unavailable', reason: 'incomplete' }
    }
  } catch {
    return { state: 'unavailable', reason: 'incomplete' }
  }
  return { state: 'available', run: previous }
}

function metricDelta(previous: MetricValue, current: MetricValue) {
  if (previous.state === 'available' && current.state === 'available') {
    return { state: 'available' as const, previous, current, delta: current.value - previous.value }
  }
  if (current.state === 'unavailable') return { state: 'unavailable' as const, reason: current.reason }
  if (previous.state === 'unavailable') return { state: 'unavailable' as const, reason: previous.reason }
  return { state: 'unavailable' as const, reason: 'evidence_incomplete' }
}

function deltaChanged(previous: MetricValue, current: MetricValue): boolean {
  if (previous.state === 'available' && current.state === 'available') {
    return previous.value !== current.value
  }
  if (previous.state === 'unavailable' && current.state === 'unavailable') {
    return false
  }
  return true
}

function changesResponse(
  db: DatabaseClient,
  active: ActiveMeasurementPlan,
  plan: MeasurementPlanV2,
  query: MeasurementChangesQuery,
): MeasurementChangesResponse {
  const current = selectMeasurementQuestionRun(db, active.version.projectId, active, query.runId)
  const requestedTargetKeys = changeTargetKeys(plan, query)
  const targetKeys = targetKeysForRun(plan, current, requestedTargetKeys, query.scope !== 'all')
  const currentDto = {
    ...measurementDto(active, current),
    executionIdentity: current ? runIdentity(current) : null,
    measurementScope: current === undefined ? null : current.measurementScope === null ? 'full' as const : 'spot_check' as const,
  }
  if (!current) {
    return measurementChangesResponseSchema.parse({
      current: currentDto,
      comparison: { state: 'unavailable', reason: 'no_previous_run' },
    })
  }
  const previousResult = previousComparableRun(db, active, current)
  if (previousResult.state === 'unavailable') {
    return measurementChangesResponseSchema.parse({ current: currentDto, comparison: previousResult })
  }

  const filters: MeasurementFilters = {
    queryClass: query.queryClass,
    provider: query.provider,
    location: query.location,
  }
  const currentAggregate = filteredOverviewWithDb(db, active, plan, current, filters, targetKeys).overview
  const previousAggregate = filteredOverviewWithDb(db, active, plan, previousResult.run, filters, targetKeys).overview
  const currentProperties = new Map(currentAggregate.properties.map(row => [row.targetId, row]))
  const previousProperties = new Map(previousAggregate.properties.map(row => [row.targetId, row]))
  const changedProperties = targetKeys.flatMap(targetKey => {
    const target = requireTarget(plan, targetKey)
    const currentProperty = currentProperties.get(targetKey)
    const previousProperty = previousProperties.get(targetKey)
    const previousMentionCoverage = previousProperty
      ? coverageMetric(previousProperty.mentionCoverage)
      : unavailable('no_population')
    const currentMentionCoverage = currentProperty
      ? coverageMetric(currentProperty.mentionCoverage)
      : unavailable('no_population')
    const previousCitationCoverage = previousProperty
      ? coverageMetric(previousProperty.citationCoverage)
      : unavailable('no_population')
    const currentCitationCoverage = currentProperty
      ? coverageMetric(currentProperty.citationCoverage)
      : unavailable('no_population')
    const mentionCoverage = metricDelta(previousMentionCoverage, currentMentionCoverage)
    const citationCoverage = metricDelta(previousCitationCoverage, currentCitationCoverage)
    if (
      !deltaChanged(previousMentionCoverage, currentMentionCoverage)
      && !deltaChanged(previousCitationCoverage, currentCitationCoverage)
    ) return []
    return [{
      ...propertyDto(target),
      mentionCoverage,
      citationCoverage,
      flags: currentProperty?.flags ?? 0,
    }]
  }).sort((left, right) => compareText(left.label, right.label) || compareText(left.targetKey, right.targetKey))
  const limit = query.limit ?? DEFAULT_LIMIT
  return measurementChangesResponseSchema.parse({
    current: currentDto,
    comparison: {
      state: 'available',
      previous: {
        displayedRunId: previousResult.run.id,
        planRevision: active.version.revision,
        completedAt: previousResult.run.finishedAt ?? null,
        executionIdentity: runIdentity(previousResult.run)!,
        measurementScope: previousResult.run.measurementScope === null ? 'full' as const : 'spot_check' as const,
      },
      metrics: {
        propertiesMentioned: metricDelta(countMetric(previousAggregate.propertiesMentioned), countMetric(currentAggregate.propertiesMentioned)),
        mentionCoverage: metricDelta(coverageMetric(previousAggregate.mentionCoverage), coverageMetric(currentAggregate.mentionCoverage)),
        citationCoverage: metricDelta(coverageMetric(previousAggregate.citationCoverage), coverageMetric(currentAggregate.citationCoverage)),
      },
      changedProperties: changedProperties.slice(0, limit),
      totalProperties: changedProperties.length,
      truncated: changedProperties.length > limit,
    },
  })
}

function unavailableQuality(reason: 'no_completed_run' | 'incomplete' | 'evidence_incomplete' | 'no_population' | 'not_applicable') {
  return { state: 'unavailable' as const, reason }
}

function qualityResponse(
  db: DatabaseClient,
  active: ActiveMeasurementPlan,
  plan: MeasurementPlanV2,
  query: MeasurementDataQualityQuery,
): MeasurementDataQualityResponse {
  const run = selectMeasurementQuestionRun(db, active.version.projectId, active, query.runId)
  const runDto = {
    ...measurementDto(active, run),
    executionIdentity: run ? runIdentity(run) : null,
    measurementScope: run === undefined ? null : run.measurementScope === null ? 'full' as const : 'spot_check' as const,
  }
  if (!run) {
    return measurementDataQualityResponseSchema.parse({
      run: runDto,
      completeness: unavailableQuality('no_completed_run'),
      capture: unavailableQuality('no_completed_run'),
      retrieval: unavailableQuality('no_completed_run'),
      population: unavailableQuality('no_completed_run'),
      comparison: { state: 'unavailable', reason: 'no_previous_run' },
    })
  }

  const comparison = previousComparableRun(db, active, run)
  const comparisonDto = comparison.state === 'available'
    ? { state: 'available' as const, previousDisplayedRunId: comparison.run.id }
    : comparison
  try {
    const materialized = materializeWithDb(db, active, plan, run)
    const expected = materialized.manifest.expectedSlots.length
    const snapshots = materialized.snapshots
    // SQLite's physical uniqueness is case-sensitive, while provider identity
    // is not. Rebuild the frozen slot identity before counting so two casing
    // variants cannot hide a different missing provider slot.
    const expectedSlotKeys = new Set(materialized.manifest.expectedSlots
      .map(slot => `${slot.executionId}\u0000${normalizeText(slot.provider)}`))
    const observedSlotKeys = new Set<string>()
    for (const snapshot of snapshots) {
      if (snapshot.measurementExecutionId === null) throw new Error('stored result has no frozen execution identity')
      const key = `${snapshot.measurementExecutionId}\u0000${normalizeText(snapshot.provider)}`
      if (!expectedSlotKeys.has(key) || observedSlotKeys.has(key)) {
        throw new Error('stored results do not map one-to-one to the frozen manifest')
      }
      observedSlotKeys.add(key)
    }
    const executed = observedSlotKeys.size
    // A provider call can persist an answer while failing to honour the
    // revision's requested context. It was executed, but it is not a usable
    // answer for this measurement population.
    const answered = materialized.input.observations.filter(observation => observation.answerText !== null).length
    const capture = { complete: 0, partial: 0, failed: 0, unsupported: 0, notRecorded: 0 }
    const retrieval = { used: 0, notUsed: 0, unknown: 0, notApplicable: 0, notRecorded: 0 }
    for (const snapshot of snapshots) {
      switch (snapshot.captureStatus) {
        case 'complete': capture.complete++; break
        case 'partial': capture.partial++; break
        case 'failed': capture.failed++; break
        case 'unsupported': capture.unsupported++; break
        default: capture.notRecorded++
      }
      switch (snapshot.retrievalStatus) {
        case 'used': retrieval.used++; break
        case 'not-used': retrieval.notUsed++; break
        case 'unknown': retrieval.unknown++; break
        case 'not-applicable': retrieval.notApplicable++; break
        default: retrieval.notRecorded++
      }
    }
    const expectedExecutions = new Set(materialized.manifest.expectedSlots.map(slot => slot.executionId))
    const answeredExecutions = new Set(materialized.input.observations
      .filter(observation => observation.answerText !== null && observation.executionId !== null)
      .map(observation => observation.executionId!)
      .filter(executionId => expectedExecutions.has(executionId)))
    return measurementDataQualityResponseSchema.parse({
      run: runDto,
      completeness: { state: 'available', expected, executed, answered, missing: expected - executed },
      capture: { state: 'available', ...capture },
      retrieval: { state: 'available', ...retrieval },
      population: {
        state: 'available',
        expectedQuestions: expectedExecutions.size,
        answeredQuestions: answeredExecutions.size,
        missingQuestions: expectedExecutions.size - answeredExecutions.size,
      },
      comparison: comparisonDto,
    })
  } catch {
    return measurementDataQualityResponseSchema.parse({
      run: runDto,
      completeness: unavailableQuality('evidence_incomplete'),
      capture: unavailableQuality('evidence_incomplete'),
      retrieval: unavailableQuality('evidence_incomplete'),
      population: unavailableQuality('evidence_incomplete'),
      comparison: comparisonDto,
    })
  }
}

export async function measurementPortfolioReadRoutes(app: FastifyInstance) {
  app.get<{ Params: { name: string }; Querystring: Record<string, unknown> }>(
    '/projects/:name/measurement-portfolio-summary',
    async request => {
      const project = resolveProject(app.db, request.params.name)
      const query = parseLimitQuery(request.query, measurementPortfolioSummaryQuerySchema, 'Invalid measurement portfolio summary query')
      const { active, plan } = activeV2Plan(app.db, project.id, 'Portfolio summary')
      return portfolioResponse(app.db, active, plan, query)
    },
  )

  app.get<{ Params: { name: string }; Querystring: Record<string, unknown> }>(
    '/projects/:name/measurement-property-competitors',
    async request => {
      const project = resolveProject(app.db, request.params.name)
      const query = parseLimitQuery(request.query, measurementPropertyCompetitorsQuerySchema, 'Invalid measurement property competitors query')
      const { active, plan } = activeV2Plan(app.db, project.id, 'Property competitors')
      return propertyCompetitorsResponse(app.db, active, plan, query)
    },
  )

  app.get<{ Params: { name: string }; Querystring: Record<string, unknown> }>(
    '/projects/:name/measurement-changes',
    async request => {
      const project = resolveProject(app.db, request.params.name)
      const query = parseLimitQuery(request.query, measurementChangesQuerySchema, 'Invalid measurement changes query')
      const { active, plan } = activeV2Plan(app.db, project.id, 'Measurement changes')
      return changesResponse(app.db, active, plan, query)
    },
  )

  app.get<{ Params: { name: string }; Querystring: Record<string, unknown> }>(
    '/projects/:name/measurement-data-quality',
    async request => {
      const project = resolveProject(app.db, request.params.name)
      const query = parseLimitQuery(request.query, measurementDataQualityQuerySchema, 'Invalid measurement data quality query')
      const { active, plan } = activeV2Plan(app.db, project.id, 'Measurement data quality')
      return qualityResponse(app.db, active, plan, query)
    },
  )
}
