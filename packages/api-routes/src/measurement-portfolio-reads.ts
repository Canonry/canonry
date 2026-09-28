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
  AI_PROVIDER_INFRA_DOMAINS,
  MEASUREMENT_CHANGES_DEFAULT_SORT,
  MEASUREMENT_CHANGES_NOISE_ANSWERS,
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION,
  MEASUREMENT_PORTFOLIO_ANSWER_SOURCES_LIMIT,
  MEASUREMENT_PORTFOLIO_DEFAULT_LIMIT,
  MEASUREMENT_PORTFOLIO_ROW_EVIDENCE_LIMIT,
  MEASUREMENT_PORTFOLIO_TIE_NAMED_INSTEAD_LIMIT,
  MEASUREMENT_PORTFOLIO_TIE_NOTE,
  MEASUREMENT_PROPERTY_CITED_DOMAINS_LIMIT,
  RunKinds,
  RunStatuses,
  RunTriggers,
  brandKeyFromText,
  hostMatchesAnyDomain,
  hostOf,
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
  type MeasurementPortfolioAnswerSources,
  type MeasurementPortfolioMarket,
  type MeasurementPortfolioMentionRanking,
  type MeasurementPortfolioMetro,
  type MeasurementPortfolioSummaryQuery,
  type MeasurementPortfolioWeakestTie,
  type MeasurementPortfolioSummaryResponse,
  type MeasurementPropertyCompetitorsQuery,
  type MeasurementPropertyCompetitorsResponse,
  type MeasurementQueryClassFilter,
  type MetricValue,
} from '@ainyc/canonry-contracts'
import { querySnapshots, runFills, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { resolveProject } from './helpers.js'
import {
  activeMeasurementPlan,
  displayedState,
  propertyLocations,
  type ActiveMeasurementPlan,
  type PropertyLocation,
} from './measurement-overview.js'
import {
  createMeasurementOverviewEvaluator,
  normalizeMeasurementLocation,
  type MeasurementOverview,
  type MeasurementOverviewEvaluator,
  type MeasurementRate,
} from './measurement-report.js'
import {
  assertMeasurementQuestionTargetScope,
  materializeMeasurementQuestionRun,
  selectMeasurementQuestionRun,
} from './measurement-question-reads.js'
import { comparableMeasurementVersionIds, measurementRunExpectedSlots } from './measurement-report-adapter.js'
import { measurementRunCompleteness } from './measurement-run-completeness.js'
import { formatRunFill } from './run-fill.js'

/**
 * Compact demo lists intentionally stop at ten unless the caller asks for more.
 * The portfolio summary stops at `MEASUREMENT_PORTFOLIO_DEFAULT_LIMIT` instead.
 */
const DEFAULT_LIMIT = 10

type RunRow = typeof runs.$inferSelect
type MaterializedRun = ReturnType<typeof materializeMeasurementQuestionRun>

interface MeasurementFilters {
  queryClass: MeasurementQueryClassFilter
  provider?: string
  location?: string
}

/** One measured answer, whether or not its text was captured. */
interface SourceAnswer {
  slotId: string
  snapshot: typeof querySnapshots.$inferSelect
  /** The source URLs citation coverage read for this answer: captured, or recovered from its stored raw response. */
  citedUrls: readonly string[]
}

interface TargetAnswer extends SourceAnswer {
  provider: string
  question: string
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
    case 'identity-ambiguous': return 'identity_ambiguous'
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
  return {
    state: 'available', value: rate.rate, numerator: rate.numerator, denominator: rate.denominator,
    // Answers the mention rate left out because their identity was unresolved.
    ...(rate.unattributed === undefined ? {} : { unattributed: rate.unattributed }),
  }
}

function countMetric(rate: MeasurementRate): MetricValue {
  if (rate.numerator === null) return unavailable(metricReason(rate.reason))
  return { state: 'available', value: rate.numerator, numerator: rate.numerator, denominator: rate.denominator }
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

/** One materialized run, narrowed to the filters every metric is taken over. */
function filteredEvaluator(
  materialized: MaterializedRun,
  filters: MeasurementFilters,
  targetKeys: readonly string[],
): MeasurementOverviewEvaluator {
  const provider = filters.provider === undefined ? undefined : normalizeText(filters.provider)
  const location = filters.location === undefined ? undefined : normalizeMeasurementLocation(filters.location)
  const expectedSlots = materialized.input.expectedSlots.filter(slot => (
    (provider === undefined || normalizeText(slot.provider) === provider)
    && (location === undefined || normalizeMeasurementLocation(slot.location) === location)
  ))
  const usageEdges = materialized.input.usageEdges.filter(edge => (
    filters.queryClass === 'all' || materialized.edgeQueryClass.get(edge.id) === filters.queryClass
  ))
  return createMeasurementOverviewEvaluator({
    ...materialized.input,
    expectedSlots,
    usageEdges,
    scopeTargetIds: [...targetKeys],
  })
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
  /** Reuses the prepared filtered run for the overall scope and every market. */
  evaluator: MeasurementOverviewEvaluator
} {
  const materialized = materializeWithDb(db, active, plan, run)
  const evaluator = filteredEvaluator(materialized, filters, targetKeys)
  return {
    materialized,
    evaluator,
    overview: evaluator.evaluate(targetKeys),
  }
}

interface TargetPopulation {
  /** Filtered expected slots for this Property, answered or not. */
  expected: number
  /** Distinct queries behind those slots. */
  queries: number
  /** Engines behind those slots. */
  providers: Set<string>
  /** Measured answers with text: the population every mention-based field reads. */
  answers: TargetAnswer[]
  /**
   * Every measured answer, with or without text: the population the source
   * lists read. Source capture is independent of answer-text capture, and
   * citation coverage already counts an answer whose text did not land.
   */
  sourceAnswers: SourceAnswer[]
}

type TargetAnswerReader = (target: MeasurementPlanV2['targets'][number]) => TargetPopulation

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key)
  if (existing) existing.push(value)
  else map.set(key, [value])
}

function innerMap<V>(outer: Map<string, Map<string, V>>, key: string): Map<string, V> {
  let inner = outer.get(key)
  if (!inner) {
    inner = new Map<string, V>()
    outer.set(key, inner)
  }
  return inner
}

/**
 * Index the filtered run once, then read any number of Properties from it.
 *
 * A portfolio read needs answers for its displayed rows and for every
 * Property tied with the weakest, which can be most of a large portfolio.
 * Filtering the whole run once per Property was quadratic in its size.
 */
function createTargetAnswerReader(
  plan: MeasurementPlanV2,
  materialized: MaterializedRun,
  filters: MeasurementFilters,
): TargetAnswerReader {
  const assignmentsByTarget = new Map<string, Map<string, MeasurementPlanV2['assignments'][number]>>()
  for (const assignment of plan.assignments) {
    if (filters.queryClass !== 'all' && assignment.queryClass !== filters.queryClass) continue
    innerMap(assignmentsByTarget, assignment.targetKey).set(assignment.executionNodeKey, assignment)
  }
  const edgesByTarget = new Map<string, Map<string, MaterializedRun['input']['usageEdges'][number]>>()
  for (const edge of materialized.input.usageEdges) {
    if (edge.type !== 'target') continue
    innerMap(edgesByTarget, edge.targetId).set(edge.executionId, edge)
  }
  const answersByEdge = new Map<string, Map<string, MaterializedRun['evidence']['answers'][number]>>()
  for (const answer of materialized.evidence.answers) {
    innerMap(answersByEdge, answer.usageEdgeId).set(answer.expectedSlotId, answer)
  }
  const citedSlotsByEdge = new Map<string, Set<string>>()
  for (const row of materialized.evidence.evidence) {
    if (row.classification !== 'assigned') continue
    const slots = citedSlotsByEdge.get(row.usageEdgeId)
    if (slots) slots.add(row.expectedSlotId)
    else citedSlotsByEdge.set(row.usageEdgeId, new Set([row.expectedSlotId]))
  }
  const incompleteObservationIds = new Set(materialized.evidence.diagnostics.evidenceIncompleteObservationIds)
  const questionsById = new Map(plan.querySnapshots.map(question => [question.queryId, question.queryText]))
  const provider = filters.provider === undefined ? undefined : normalizeText(filters.provider)
  const location = filters.location === undefined ? undefined : normalizeMeasurementLocation(filters.location)
  // Run order, so every reader sees a Property's answers in the same sequence.
  const slotsByExecution = new Map<string, Array<MaterializedRun['input']['expectedSlots'][number]>>()
  const slotOrder = new Map<string, number>()
  materialized.input.expectedSlots.forEach((slot, index) => {
    if (provider !== undefined && normalizeText(slot.provider) !== provider) return
    if (location !== undefined && normalizeMeasurementLocation(slot.location) !== location) return
    pushTo(slotsByExecution, slot.executionId, slot)
    slotOrder.set(slot.id, index)
  })

  return target => {
    const assignments = assignmentsByTarget.get(target.stableKey)
    const edges = edgesByTarget.get(target.stableKey)
    const answers: TargetAnswer[] = []
    const sourceAnswers: SourceAnswer[] = []
    const queries = new Set<string>()
    const providers = new Set<string>()
    let expected = 0
    if (!assignments || !edges) return { expected, queries: 0, providers, answers, sourceAnswers }
    for (const [executionId, assignment] of assignments) {
      const edge = edges.get(executionId)
      const slots = slotsByExecution.get(executionId)
      if (!edge || !slots) continue
      queries.add(assignment.queryId)
      const answerBySlot = answersByEdge.get(edge.id)
      const citedSlotIds = citedSlotsByEdge.get(edge.id)
      for (const slot of slots) {
        expected++
        providers.add(slot.provider)
        const observation = materialized.observationsBySlot.get(slot.id)
        const snapshot = observation === undefined ? undefined : materialized.snapshotsById.get(observation.id)
        if (!observation || !snapshot) continue
        const sourced: SourceAnswer = {
          slotId: slot.id,
          snapshot,
          citedUrls: observation.citedUrls ?? observation.historicalCitedUrls ?? [],
        }
        sourceAnswers.push(sourced)
        if (snapshot.answerText === null) continue
        answers.push({
          ...sourced,
          provider: slot.provider,
          question: questionsById.get(assignment.queryId) ?? slot.queryText,
          mentioned: target.mentionNotApplicable
            ? null
            : answerBySlot?.get(slot.id)?.mentioned ?? null,
          cited: citedSlotIds?.has(slot.id) ? true : incompleteObservationIds.has(snapshot.id) ? null : false,
        })
      }
    }
    const inRunOrder = (left: SourceAnswer, right: SourceAnswer) => slotOrder.get(left.slotId)! - slotOrder.get(right.slotId)!
    answers.sort(inRunOrder)
    sourceAnswers.sort(inRunOrder)
    return { expected, queries: queries.size, providers, answers, sourceAnswers }
  }
}

function targetAnswers(
  plan: MeasurementPlanV2,
  target: MeasurementPlanV2['targets'][number],
  materialized: MaterializedRun,
  filters: MeasurementFilters,
): TargetPopulation {
  return createTargetAnswerReader(plan, materialized, filters)(target)
}

/** Distinct queries the plan assigns a Property in one class; the basis before any run completes. */
function plannedQueryCount(plan: MeasurementPlanV2, targetKey: string, queryClass: MeasurementQueryClassFilter): number {
  return new Set(plan.assignments
    .filter(assignment => assignment.targetKey === targetKey)
    .filter(assignment => queryClass === 'all' || assignment.queryClass === queryClass)
    .map(assignment => assignment.queryId)).size
}

/**
 * Hosts an answer cited, once each, without provider plumbing such as
 * grounding redirects: its stored domains plus the hosts of the URLs citation
 * coverage read. Gemini can store no domain for a redirect it could not
 * decode while URL capture resolved the source, so the stored domains alone
 * report a cited answer as citing nothing.
 */
function answerDomains(answer: Pick<SourceAnswer, 'snapshot' | 'citedUrls'>): Set<string> {
  const domains = new Set<string>()
  for (const raw of [...answer.snapshot.citedDomains, ...answer.citedUrls]) {
    const host = hostOf(raw)
    if (!host || hostMatchesAnyDomain(host, AI_PROVIDER_INFRA_DOMAINS)) continue
    domains.add(host)
  }
  return domains
}

/** Domains ranked by how many of these answers cite them, most first. */
function domainRows(
  answers: readonly Pick<SourceAnswer, 'snapshot' | 'citedUrls'>[],
  limit: number,
): { rows: Array<{ domain: string; answers: number }>; total: number } {
  const counts = new Map<string, number>()
  for (const answer of answers) {
    for (const domain of answerDomains(answer)) counts.set(domain, (counts.get(domain) ?? 0) + 1)
  }
  const rows = [...counts]
    .map(([domain, count]) => ({ domain, answers: count }))
    .sort((left, right) => right.answers - left.answers || compareText(left.domain, right.domain))
  return { rows: rows.slice(0, limit), total: rows.length }
}

function targetAliasKeys(target: MeasurementPlanV2['targets'][number]): Set<string> {
  return new Set([target.label, ...target.aliases]
    .map(brandKeyFromText)
    .filter(Boolean))
}

/**
 * Every name an answer wrote instead of this Property, keyed by brand, in the
 * answers that neither named nor cited it. `firstInAnswer` is false for a
 * second spelling of a brand the same answer already wrote.
 */
function forEachNameWrittenInstead(
  target: MeasurementPlanV2['targets'][number],
  answers: readonly TargetAnswer[],
  visit: (key: string, name: string, answer: TargetAnswer, firstInAnswer: boolean) => void,
): void {
  const aliases = targetAliasKeys(target)
  for (const answer of answers) {
    // An incomplete source capture makes target citation unknown. Treating that
    // as a miss would manufacture a competitor from evidence that did not land.
    if (answer.mentioned !== false || answer.cited !== false) continue
    // One answer counts once per brand, so a count of names is a count of
    // answers even when the stored list spells one brand two ways.
    const seenInAnswer = new Set<string>()
    for (const rawName of answer.snapshot.recommendedCompetitors) {
      const name = rawName.normalize('NFKC').trim().replace(/\s+/g, ' ')
      const key = brandKeyFromText(name)
      if (!key || aliases.has(key)) continue
      visit(key, name, answer, !seenInAnswer.has(key))
      seenInAnswer.add(key)
    }
  }
}

function recommendationRows(
  target: MeasurementPlanV2['targets'][number],
  population: ReturnType<typeof targetAnswers>,
): RecommendationRow[] {
  const grouped = new Map<string, { name: string; occurrences: number; providers: Set<string>; questions: Set<string> }>()
  forEachNameWrittenInstead(target, population.answers, (key, name, answer, firstInAnswer) => {
    const existing = grouped.get(key)
    if (existing) {
      // Every spelling competes for the displayed name; only the first in an answer counts it.
      if (compareText(name, existing.name) < 0) existing.name = name
      if (!firstInAnswer) return
      existing.occurrences++
      existing.providers.add(answer.provider)
      existing.questions.add(answer.question)
    } else {
      grouped.set(key, {
        name,
        occurrences: 1,
        providers: new Set([answer.provider]),
        questions: new Set([answer.question]),
      })
    }
  })
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

/**
 * A weakest row's names written instead, under the current field and the
 * deprecated one existing consumers still read. Both carry the same names in
 * the same order; `occurrences` is the same per-answer count as `answers`.
 */
function namedInsteadFields(names: readonly RecommendationRow[]) {
  const returned = names.slice(0, MEASUREMENT_PORTFOLIO_ROW_EVIDENCE_LIMIT)
  return {
    namedInsteadInAnswerText: returned.map(({ name, occurrences }) => ({ name, answers: occurrences })),
    namedInsteadInAnswerTextTotal: names.length,
    recommendedInstead: returned.map(({ name, occurrences }) => ({ name, occurrences })),
    recommendedInsteadTotal: names.length,
    recommendedInsteadTruncated: names.length > returned.length,
  }
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
 * By default the roll-up is one level: every top-level market, or every
 * direct child of the selected group, worst-first. A large portfolio nests
 * every submarket under a metro, and listing them all by default pushed the
 * Property rows an agent asked for past its result cap. The level is never
 * capped by the row limit: a metro comparison that stops at four metros sends
 * the reader looking for the rest one market at a time. The selected group
 * itself is never listed: repeating its own numbers under a "compare markets"
 * heading says nothing. `includeNestedMarkets` returns every market in scope
 * at every level.
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
  measured: { run: RunRow; evaluator: MeasurementOverviewEvaluator } | undefined,
  scope: MeasurementPlanV2['groups'][number] | undefined,
  includeNested: boolean,
): { markets: MeasurementPortfolioMarket[]; totalMarkets: number; marketsTruncated: boolean } {
  const childCounts = new Map<string, number>()
  for (const group of plan.groups) {
    if (group.parentGroupKey !== undefined) childCounts.set(group.parentGroupKey, (childCounts.get(group.parentGroupKey) ?? 0) + 1)
  }
  const groupKeys = new Set(plan.groups.map(group => group.stableKey))
  const isTopLevel = (group: MeasurementPlanV2['groups'][number]) =>
    group.parentGroupKey === undefined || !groupKeys.has(group.parentGroupKey)
  let candidates: MeasurementPlanV2['groups']
  if (scope === undefined) {
    candidates = includeNested ? plan.groups : plan.groups.filter(isTopLevel)
  } else if (!includeNested) {
    candidates = plan.groups.filter(group => group.parentGroupKey === scope.stableKey)
  } else {
    const descendants = new Set<string>([scope.stableKey])
    let grew = true
    while (grew) {
      grew = false
      for (const group of plan.groups) {
        if (group.parentGroupKey !== undefined && descendants.has(group.parentGroupKey) && !descendants.has(group.stableKey)) {
          descendants.add(group.stableKey)
          grew = true
        }
      }
    }
    candidates = plan.groups.filter(group => group.stableKey !== scope.stableKey && descendants.has(group.stableKey))
  }

  const markets = candidates.map((group): MeasurementPortfolioMarket => {
    const identity = {
      groupKey: group.stableKey,
      label: group.label,
      parentGroupKey: isTopLevel(group) ? null : group.parentGroupKey!,
      childMarketCount: childCounts.get(group.stableKey) ?? 0,
    }
    if (measured === undefined) {
      return {
        ...identity,
        propertyCount: group.targetKeys.length,
        propertiesMentioned: unavailable('no_completed_run'),
        mentionCoverage: unavailable('no_completed_run'),
        citationCoverage: unavailable('no_completed_run'),
      }
    }
    // A market with no member inside the displayed run still goes through the
    // kernel with an empty scope rather than short-circuiting to a hand-picked
    // reason. The kernel is what decides why a metric is unavailable, and the
    // group-scoped read of the same market reaches it the same way — inventing
    // a reason here is how the two surfaces start disagreeing again.
    const targetKeys = targetKeysForRun(plan, measured.run, group.targetKeys, false)
    const overview = measured.evaluator.evaluate(targetKeys)
    return {
      ...identity,
      propertyCount: targetKeys.length,
      propertiesMentioned: countMetric(overview.propertiesMentioned),
      mentionCoverage: coverageMetric(overview.mentionCoverage),
      citationCoverage: coverageMetric(overview.citationCoverage),
    }
  }).sort(compareWeakestMarket)
  return { markets, totalMarkets: markets.length, marketsTruncated: false }
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

type PropertyContext = PropertyLocation & { queries: number }

function mentionRanking(
  rows: readonly ({ targetKey: string; label: string; mentionCoverage: MetricValue; citationCoverage: MetricValue } & PropertyContext)[],
  limit: number,
): MeasurementPortfolioMentionRanking {
  const eligible: MeasurementPortfolioMentionRanking['strongest'] = []
  const excluded: MeasurementPortfolioMentionRanking['excluded'] = []
  for (const { targetKey, label, mentionCoverage, citationCoverage, metro, otherMetros, submarkets, queries } of rows) {
    if (mentionCoverage.state === 'unavailable') {
      excluded.push({ targetKey, label, reason: mentionCoverage.reason })
    } else {
      eligible.push({
        targetKey, label, metro, ...(otherMetros === undefined ? {} : { otherMetros }), submarkets, queries,
        mentionCoverage, citationCoverage,
      })
    }
  }
  const byLabel = (a: { label: string; targetKey: string }, b: { label: string; targetKey: string }) =>
    compareText(a.label, b.label) || compareText(a.targetKey, b.targetKey)
  const byRate = (direction: number) => (a: typeof eligible[number], b: typeof eligible[number]) =>
    direction * (a.mentionCoverage.value - b.mentionCoverage.value) || byLabel(a, b)
  // Rank the entire scoped population before applying limit. Citation evidence
  // cannot disqualify a known mention rate or break a mention-rate tie.
  return {
    eligiblePropertyCount: eligible.length,
    strongest: [...eligible].sort(byRate(-1)).slice(0, limit),
    weakest: eligible.sort(byRate(1)).slice(0, limit),
    excluded: excluded.sort(byLabel),
    truncated: eligible.length > limit,
  }
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

  const limit = query.limit ?? MEASUREMENT_PORTFOLIO_DEFAULT_LIMIT
  const includeNestedMarkets = query.includeNestedMarkets ?? false
  const locate = propertyLocations(plan)

  if (!run) {
    const rows = targets.map(target => ({
      ...propertyDto(target),
      ...locate(target.stableKey),
      queries: plannedQueryCount(plan, target.stableKey, query.queryClass),
      mentionCoverage: unavailable('no_completed_run'),
      citationCoverage: unavailable('no_completed_run'),
      flags: 0,
      ...namedInsteadFields([]),
      citedDomains: [],
      citedDomainsTotal: 0,
    })).sort(compareWeakest)
    return measurementPortfolioSummaryResponseSchema.parse({
      portfolio: { groupKey: group?.stableKey ?? null, label: group?.label ?? null, measurementScope: null },
      measurement,
      queryClass: query.queryClass,
      engines: [],
      metrics: {
        propertiesMentioned: unavailable('no_completed_run'),
        mentionCoverage: unavailable('no_completed_run'),
        citationCoverage: unavailable('no_completed_run'),
      },
      weakestProperties: rows.slice(0, limit),
      tiedAtWeakest: null,
      weakestAnswerSources: null,
      mentionRanking: mentionRanking(rows, limit),
      // Sorted through the same comparator as the measured branch. Plan order
      // is `stableKey`, so emitting it raw put markets in an order the schema
      // documents as worst-first and that changes the moment a run lands.
      ...marketRollup(plan, undefined, group, includeNestedMarkets),
      totalProperties: rows.length,
      truncated: rows.length > limit,
    })
  }

  const { materialized, overview, evaluator } = filteredOverviewWithDb(db, active, plan, run, filters, targetKeys)
  const readTarget = createTargetAnswerReader(plan, materialized, filters)
  const populations = new Map(targets.map(target => [target.stableKey, readTarget(target)]))
  const measured = new Map(overview.properties.map(row => [row.targetId, row]))
  const ranked = targets.map(target => {
    const row = measured.get(target.stableKey)
    const population = populations.get(target.stableKey)!
    return {
      target,
      population,
      ...propertyDto(target),
      ...locate(target.stableKey),
      queries: population.queries,
      mentionCoverage: row ? coverageMetric(row.mentionCoverage) : unavailable('no_population'),
      citationCoverage: row ? coverageMetric(row.citationCoverage) : unavailable('no_population'),
      flags: row?.flags ?? 0,
    }
  }).sort(compareWeakest)
  const displayed = ranked.slice(0, limit)
  const rows = displayed.map(({ target, population, ...row }) => {
    const domains = domainRows(population.sourceAnswers, MEASUREMENT_PORTFOLIO_ROW_EVIDENCE_LIMIT)
    return {
      ...row,
      ...namedInsteadFields(recommendationRows(target, population)),
      citedDomains: domains.rows,
      citedDomainsTotal: domains.total,
    }
  })
  const tie = weakestTie(ranked)
  const engines = new Set<string>()
  for (const population of populations.values()) for (const provider of population.providers) engines.add(provider)
  return measurementPortfolioSummaryResponseSchema.parse({
    portfolio: {
      groupKey: group?.stableKey ?? null,
      label: group?.label ?? null,
      measurementScope: run.measurementScope === null ? 'full' : 'spot_check',
    },
    measurement,
    queryClass: query.queryClass,
    engines: [...engines].sort(compareText),
    metrics: {
      propertiesMentioned: countMetric(overview.propertiesMentioned),
      mentionCoverage: coverageMetric(overview.mentionCoverage),
      citationCoverage: coverageMetric(overview.citationCoverage),
    },
    weakestProperties: rows,
    tiedAtWeakest: tie.summary,
    weakestAnswerSources: weakestAnswerSources([...displayed, ...tie.rows]),
    mentionRanking: mentionRanking(ranked, limit),
    ...marketRollup(plan, { run, evaluator }, group, includeNestedMarkets),
    totalProperties: ranked.length,
    truncated: ranked.length > limit,
  })
}

interface TiedRow extends PropertyLocation {
  target: MeasurementPlanV2['targets'][number]
  population: TargetPopulation
  mentionCoverage: MetricValue
  citationCoverage: MetricValue
}

/**
 * Properties sharing the weakest row's exact rates. Among them the order is
 * only the label tie-break, so "first" is alphabetical, not worst. The
 * summary describes EVERY tied Property, so a tie larger than the returned
 * rows can be placed and characterized without reading it row by row.
 */
function weakestTie<Row extends TiedRow>(
  ranked: readonly Row[],
): { summary: MeasurementPortfolioWeakestTie | null; rows: Row[] } {
  if (ranked.length === 0) return { summary: null, rows: [] }
  const first = ranked[0]!
  if (first.mentionCoverage.state !== 'available' || first.citationCoverage.state !== 'available') {
    return { summary: null, rows: [] }
  }
  const mentionRate = first.mentionCoverage.value
  const citationRate = first.citationCoverage.value
  const rows = ranked.filter(row => (
    row.mentionCoverage.state === 'available' && row.mentionCoverage.value === mentionRate
    && row.citationCoverage.state === 'available' && row.citationCoverage.value === citationRate
  ))
  if (rows.length < 2) return { summary: null, rows: [] }
  const namedInstead = tieNamedInstead(rows)
  return {
    summary: {
      count: rows.length,
      mentionRate,
      citationRate,
      note: MEASUREMENT_PORTFOLIO_TIE_NOTE,
      byMetro: tieByMetro(rows),
      namedInstead: namedInstead.rows,
      namedInsteadTotal: namedInstead.total,
    },
    rows,
  }
}

/**
 * Tied Properties per top-level market, placed by the groups that hold them,
 * never by label. A Property in two metros counts in both, which is the
 * honest answer to "how many of this metro's Properties are tied at the
 * bottom". Only the label is returned: the `markets` rows map it to its key.
 */
function tieByMetro(rows: readonly PropertyLocation[]): Array<{ metro: string | null; count: number }> {
  const counts = new Map<string | null, { metro: MeasurementPortfolioMetro | null; count: number }>()
  const add = (metro: MeasurementPortfolioMetro | null) => {
    const key = metro?.groupKey ?? null
    const existing = counts.get(key)
    if (existing) existing.count++
    else counts.set(key, { metro, count: 1 })
  }
  for (const row of rows) {
    add(row.metro)
    for (const other of row.otherMetros ?? []) add(other)
  }
  // Most first; the Properties in no metro sort after every named metro at the same count.
  return [...counts.values()].sort((left, right) => (
    right.count - left.count
    || (left.metro === null ? 1 : 0) - (right.metro === null ? 1 : 0)
    || compareText(left.metro?.label ?? '', right.metro?.label ?? '')
    || compareText(left.metro?.groupKey ?? '', right.metro?.groupKey ?? '')
  )).map(({ metro, count }) => ({ metro: metro?.label ?? null, count }))
}

/**
 * Names written instead across every tied Property's answers. `answers`
 * counts distinct stored answers: one answer serving two tied Properties is
 * one answer, however many of them it missed.
 */
function tieNamedInstead(
  rows: readonly Pick<TiedRow, 'target' | 'population'>[],
): { rows: Array<{ name: string; answers: number }>; total: number } {
  const grouped = new Map<string, { name: string; answers: Set<string> }>()
  for (const { target, population } of rows) {
    forEachNameWrittenInstead(target, population.answers, (key, name, answer) => {
      const existing = grouped.get(key)
      if (existing) {
        if (compareText(name, existing.name) < 0) existing.name = name
        existing.answers.add(answer.snapshot.id)
      } else {
        grouped.set(key, { name, answers: new Set([answer.snapshot.id]) })
      }
    })
  }
  const counted = [...grouped.values()]
    .map(row => ({ name: row.name, answers: row.answers.size }))
    .sort((left, right) => right.answers - left.answers || compareText(left.name, right.name))
  return { rows: counted.slice(0, MEASUREMENT_PORTFOLIO_TIE_NAMED_INSTEAD_LIMIT), total: counted.length }
}

/**
 * Cited domains over the weakest Properties' measured answers, each stored
 * answer counted once, whether or not its text was captured.
 */
function weakestAnswerSources(
  rows: readonly { targetKey: string; population: TargetPopulation }[],
): MeasurementPortfolioAnswerSources {
  const properties = new Set<string>()
  const answers = new Map<string, SourceAnswer>()
  for (const row of rows) {
    properties.add(row.targetKey)
    for (const answer of row.population.sourceAnswers) answers.set(answer.snapshot.id, answer)
  }
  const domains = domainRows([...answers.values()], MEASUREMENT_PORTFOLIO_ANSWER_SOURCES_LIMIT)
  return { properties: properties.size, answers: answers.size, domains: domains.rows, domainTotal: domains.total }
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
      ...ownCitedDomains(population),
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
    ...ownCitedDomains(population),
  })
}

/**
 * The domains this Property's own measured answers cited. Source capture does
 * not depend on answer text, so an answer whose text did not land still counts,
 * exactly as it does for citation coverage. Omitted when nothing was measured:
 * an empty list would read as a measured absence of sources.
 */
function ownCitedDomains(population: TargetPopulation) {
  if (population.sourceAnswers.length === 0) return {}
  const domains = domainRows(population.sourceAnswers, MEASUREMENT_PROPERTY_CITED_DOMAINS_LIMIT)
  return {
    citedDomains: domains.rows,
    citedDomainsTotal: domains.total,
    citedDomainsAnswers: population.sourceAnswers.length,
  }
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

/** Answers that named or cited a Property; absent on an unavailable metric. */
function answerCount(metric: MetricValue): number | null {
  return metric.state === 'available' ? metric.numerator ?? null : null
}

/** Answers a Property's rate was taken over; absent on an unavailable metric or an empty one. */
function answerBase(metric: MetricValue): number | null {
  return metric.state === 'available' && metric.denominator !== undefined && metric.denominator > 0
    ? metric.denominator
    : null
}

type MoveBucket = 'improved' | 'declined' | 'mixed' | 'withinNoise' | 'unchanged' | 'notComparable'

export interface PropertyMove {
  /** Current minus previous answer count; null unless both runs measured the signal. */
  mentionAnswersDelta: number | null
  citationAnswersDelta: number | null
  /** A signal measured in both runs was taken over a different number of answers. */
  denominatorChanged: boolean
  /** Every measured move is at most `MEASUREMENT_CHANGES_NOISE_ANSWERS` answers. */
  withinNoise: boolean
  /** A direction counts only signals that moved beyond noise. */
  bucket: MoveBucket
  /** Absolute sizes for the magnitude order; -1 when the signal cannot be sized. */
  mentionSize: number
  citationSize: number
}

/**
 * How one Property moved between two runs, sized in answers rather than rates:
 * one answer is a large rate move on a small denominator and a tiny one on a
 * large denominator, and the noise rule is about answers. A move is the rate
 * change times the larger of the two denominators. That is the raw count
 * change when the denominators match; it keeps a falling rate on a grown
 * denominator from reading as a gain (1 of 1 to 4 of 8 is four answers down,
 * not three up), and a collapse on a shrunken one from reading as noise (10
 * of 12 to 0 of 2 is ten down, not under two). A signal unmeasured in both
 * runs did not move; one measured in only one run, or over no answers, cannot
 * be sized.
 *
 * Exported for its own unit test: the bucket rules need metric pairs the
 * seeded run fixtures cannot all produce.
 */
export function classifyPropertyMove(
  mention: { previous: MetricValue; current: MetricValue },
  citation: { previous: MetricValue; current: MetricValue },
): PropertyMove {
  const size = (pair: { previous: MetricValue; current: MetricValue }): number | null => {
    if (pair.previous.state === 'unavailable' && pair.current.state === 'unavailable') return 0
    const previous = answerCount(pair.previous)
    const current = answerCount(pair.current)
    const previousBase = answerBase(pair.previous)
    const currentBase = answerBase(pair.current)
    if (previous === null || current === null || previousBase === null || currentBase === null) return null
    // (current / currentBase - previous / previousBase) * base, divided once so
    // equal denominators give the exact integer count change.
    const base = Math.max(previousBase, currentBase)
    return (current * previousBase - previous * currentBase) * base / (previousBase * currentBase)
  }
  const bothMeasured = (pair: { previous: MetricValue; current: MetricValue }) =>
    pair.previous.state === 'available' && pair.current.state === 'available'
  const answersDelta = (pair: { previous: MetricValue; current: MetricValue }): number | null => {
    const previous = answerCount(pair.previous)
    const current = answerCount(pair.current)
    return bothMeasured(pair) && previous !== null && current !== null ? current - previous : null
  }
  const baseChanged = (pair: { previous: MetricValue; current: MetricValue }) =>
    pair.previous.state === 'available' && pair.current.state === 'available'
    && pair.previous.denominator !== pair.current.denominator
  const mentionMove = size(mention)
  const citationMove = size(citation)
  const changed = deltaChanged(mention.previous, mention.current) || deltaChanged(citation.previous, citation.current)
  const comparable = mentionMove !== null && citationMove !== null
  const withinNoise = comparable
    && Math.abs(mentionMove) <= MEASUREMENT_CHANGES_NOISE_ANSWERS
    && Math.abs(citationMove) <= MEASUREMENT_CHANGES_NOISE_ANSWERS
  let bucket: MoveBucket
  if (!changed) bucket = 'unchanged'
  else if (!comparable) bucket = 'notComparable'
  else if (withinNoise) bucket = 'withinNoise'
  else {
    // Only a signal that moved beyond noise sets the direction: three more
    // named with one fewer cited is a gain, not a mixed move. At least one
    // signal is beyond noise here, so the move has a direction.
    const directions = [mentionMove, citationMove]
      .filter(move => Math.abs(move) > MEASUREMENT_CHANGES_NOISE_ANSWERS)
    const up = directions.some(move => move > 0)
    const down = directions.some(move => move < 0)
    bucket = up && down ? 'mixed' : up ? 'improved' : 'declined'
  }
  return {
    mentionAnswersDelta: answersDelta(mention),
    citationAnswersDelta: answersDelta(citation),
    denominatorChanged: baseChanged(mention) || baseChanged(citation),
    withinNoise: changed && withinNoise,
    bucket,
    mentionSize: mentionMove === null ? -1 : Math.abs(mentionMove),
    citationSize: citationMove === null ? -1 : Math.abs(citationMove),
  }
}

interface ChangeOrderRow {
  row: { label: string; targetKey: string }
  move: Pick<PropertyMove, 'withinNoise' | 'mentionSize' | 'citationSize'>
}

function compareChangeLabel(left: ChangeOrderRow, right: ChangeOrderRow): number {
  return compareText(left.row.label, right.row.label) || compareText(left.row.targetKey, right.row.targetKey)
}

/**
 * The `magnitude` order. Every row beyond noise leads every row within it, so
 * wobbles of one or two answers never push a real gain or loss off the page.
 * Within each tier the larger of the two signal sizes leads, whichever signal
 * it is, then the other size, then label: a citation-only move is as large as
 * a mention-only move of the same size. A row whose signal changed
 * availability is not within noise, and ranks by the signal that has a size.
 *
 * Exported for its own unit test: the seeded run fixtures cannot produce a
 * signal measured in one run only beside rows within noise.
 */
export function compareChangeMagnitude(left: ChangeOrderRow, right: ChangeOrderRow): number {
  const larger = (move: ChangeOrderRow['move']) => Math.max(move.mentionSize, move.citationSize)
  const smaller = (move: ChangeOrderRow['move']) => Math.min(move.mentionSize, move.citationSize)
  return Number(left.move.withinNoise) - Number(right.move.withinNoise)
    || larger(right.move) - larger(left.move)
    || smaller(right.move) - smaller(left.move)
    || compareChangeLabel(left, right)
}

function changesMetrics(previous: MeasurementOverview, current: MeasurementOverview) {
  return {
    propertiesMentioned: metricDelta(countMetric(previous.propertiesMentioned), countMetric(current.propertiesMentioned)),
    mentionCoverage: metricDelta(coverageMetric(previous.mentionCoverage), coverageMetric(current.mentionCoverage)),
    citationCoverage: metricDelta(coverageMetric(previous.citationCoverage), coverageMetric(current.citationCoverage)),
  }
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
  const queryClass = query.queryClass
  if (!current) {
    return measurementChangesResponseSchema.parse({
      current: currentDto,
      queryClass,
      comparison: { state: 'unavailable', reason: 'no_previous_run' },
    })
  }
  const previousResult = previousComparableRun(db, active, current)
  if (previousResult.state === 'unavailable') {
    return measurementChangesResponseSchema.parse({ current: currentDto, queryClass, comparison: previousResult })
  }

  const filters: MeasurementFilters = {
    queryClass,
    provider: query.provider,
    location: query.location,
  }
  // Each run is materialized once; every class below re-filters it in memory.
  const currentRun = materializeWithDb(db, active, plan, current)
  const previousRun = materializeWithDb(db, active, plan, previousResult.run)
  const aggregates = (classFilters: MeasurementFilters) => ({
    current: filteredEvaluator(currentRun, classFilters, targetKeys).evaluate(targetKeys),
    previous: filteredEvaluator(previousRun, classFilters, targetKeys).evaluate(targetKeys),
  })
  const { current: currentAggregate, previous: previousAggregate } = aggregates(filters)
  const currentProperties = new Map(currentAggregate.properties.map(row => [row.targetId, row]))
  const previousProperties = new Map(previousAggregate.properties.map(row => [row.targetId, row]))
  const distribution = {
    improved: 0, declined: 0, mixed: 0, withinNoise: 0, unchanged: 0, notComparable: 0,
    total: targetKeys.length,
    noiseAnswers: MEASUREMENT_CHANGES_NOISE_ANSWERS,
  }
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
    const move = classifyPropertyMove(
      { previous: previousMentionCoverage, current: currentMentionCoverage },
      { previous: previousCitationCoverage, current: currentCitationCoverage },
    )
    // Counted over every Property in scope, before the page is cut.
    distribution[move.bucket]++
    if (move.bucket === 'unchanged') return []
    return [{
      row: {
        ...propertyDto(target),
        mentionCoverage: metricDelta(previousMentionCoverage, currentMentionCoverage),
        citationCoverage: metricDelta(previousCitationCoverage, currentCitationCoverage),
        flags: currentProperty?.flags ?? 0,
        mentionAnswersDelta: move.mentionAnswersDelta,
        citationAnswersDelta: move.citationAnswersDelta,
        denominatorChanged: move.denominatorChanged,
        withinNoise: move.withinNoise,
      },
      move,
    }]
  })
  const sort = query.sort ?? MEASUREMENT_CHANGES_DEFAULT_SORT
  changedProperties.sort(sort === 'label' ? compareChangeLabel : compareChangeMagnitude)
  // A pooled move can hide an opposite move in one class, so an `all` read
  // carries each class beside the pooled block.
  const classMetrics = (classFilter: 'branded' | 'non-brand') => {
    const { previous, current: latest } = aggregates({ ...filters, queryClass: classFilter })
    return changesMetrics(previous, latest)
  }
  const metricsByClass = queryClass === 'all'
    ? { branded: classMetrics('branded'), nonBrand: classMetrics('non-brand') }
    : undefined
  const limit = query.limit ?? DEFAULT_LIMIT
  return measurementChangesResponseSchema.parse({
    current: currentDto,
    queryClass,
    comparison: {
      state: 'available',
      previous: {
        displayedRunId: previousResult.run.id,
        planRevision: active.version.revision,
        completedAt: previousResult.run.finishedAt ?? null,
        executionIdentity: runIdentity(previousResult.run)!,
        measurementScope: previousResult.run.measurementScope === null ? 'full' as const : 'spot_check' as const,
      },
      metrics: changesMetrics(previousAggregate, currentAggregate),
      ...(metricsByClass === undefined ? {} : { metricsByClass }),
      sort,
      distribution,
      changedProperties: changedProperties.slice(0, limit).map(({ row }) => row),
      totalProperties: changedProperties.length,
      truncated: changedProperties.length > limit,
    },
  })
}

function unavailableQuality(reason: 'no_completed_run' | 'incomplete' | 'evidence_incomplete' | 'no_population' | 'not_applicable') {
  return { state: 'unavailable' as const, reason }
}

/**
 * Answers each class's mention rates leave out because their identity could
 * not be resolved, read through the same kernel as those rates so the two
 * never disagree. Every class is read on its own: a pooled count once hid a
 * branded class's unattributed answers behind a non-brand read of zero.
 */
function unattributedByClass(plan: MeasurementPlanV2, run: RunRow, materialized: MaterializedRun) {
  const targetKeys = targetKeysForRun(plan, run, plan.targets.map(target => target.stableKey), false)
  const read = (queryClass: 'branded' | 'non-brand') => {
    const overview = filteredEvaluator(materialized, { queryClass }, targetKeys).evaluate(targetKeys)
    const rate = overview.mentionCoverage
    if (rate.rate !== null) {
      return { state: 'available' as const, answered: overview.answeredSlots, unattributed: rate.unattributed ?? 0 }
    }
    switch (rate.reason) {
      // Nothing was left to measure: every answer in the class was unattributed.
      case 'identity-ambiguous':
        return { state: 'available' as const, answered: overview.answeredSlots, unattributed: overview.answeredSlots }
      case 'no-population': return unavailableQuality('no_population')
      case 'aliasless':
      case 'no-competitors':
      case 'no-project-aliases': return unavailableQuality('not_applicable')
      default: return unavailableQuality('evidence_incomplete')
    }
  }
  return { branded: read('branded'), nonBrand: read('non-brand') }
}

/**
 * The newest attempt to complete this run in place. Its answers already count
 * in the completeness figures; this says the run was topped up, and by how much.
 */
function latestRunFill(db: DatabaseClient, runId: string) {
  const fill = db.select().from(runFills).where(eq(runFills.runId, runId))
    .orderBy(desc(runFills.createdAt), desc(runFills.id)).get()
  if (!fill) return null
  const { status, providers, expected, filled, createdAt, finishedAt } = formatRunFill(fill)
  return { status, providers, expected, filled, createdAt, finishedAt }
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
      unattributedByClass: { branded: unavailableQuality('no_completed_run'), nonBrand: unavailableQuality('no_completed_run') },
      latestFill: null,
    })
  }

  const comparison = previousComparableRun(db, active, run)
  const comparisonDto = comparison.state === 'available'
    ? { state: 'available' as const, previousDisplayedRunId: comparison.run.id }
    : comparison
  // A fill is tracked apart from the answers, so it stays readable when they are not.
  const latestFill = latestRunFill(db, run.id)
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
      unattributedByClass: unattributedByClass(plan, run, materialized),
      latestFill,
    })
  } catch {
    return measurementDataQualityResponseSchema.parse({
      run: runDto,
      completeness: unavailableQuality('evidence_incomplete'),
      capture: unavailableQuality('evidence_incomplete'),
      retrieval: unavailableQuality('evidence_incomplete'),
      population: unavailableQuality('evidence_incomplete'),
      comparison: comparisonDto,
      unattributedByClass: { branded: unavailableQuality('evidence_incomplete'), nonBrand: unavailableQuality('evidence_incomplete') },
      latestFill,
    })
  }
}

export async function measurementPortfolioReadRoutes(app: FastifyInstance) {
  app.get<{ Params: { name: string }; Querystring: Record<string, unknown> }>(
    '/projects/:name/measurement-portfolio-summary',
    async request => {
      const project = resolveProject(app.db, request.params.name)
      const nested = request.query.includeNestedMarkets
      // A query string carries the flag as text; anything but true/false is left to fail validation.
      const raw = nested === 'true' || nested === 'false'
        ? { ...request.query, includeNestedMarkets: nested === 'true' }
        : request.query
      const query = parseLimitQuery(raw, measurementPortfolioSummaryQuerySchema, 'Invalid measurement portfolio summary query')
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
