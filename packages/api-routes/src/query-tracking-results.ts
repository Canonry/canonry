/**
 * Mentioned and Cited per tracked query and engine, in one stored-evidence read.
 *
 * The visibility report pages its query rows and rebuilds the trend on every
 * page. This read rebuilds one sweep: it lists sweeps without their manifests,
 * parses the active plan and at most the chosen sweep's own revision, and
 * reads that sweep's snapshots once. Named one query, it reads only that
 * query's answers and lists them. It never calls a provider and never writes.
 */

import { and, desc, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION,
  QUERY_TRACKING_WEAK_MARKET_CLASS,
  QUERY_TRACKING_WEAK_MARKET_RULE,
  VisibilityReportScopeErrorReasons,
  brandKeyFromText,
  compareText,
  compileQueryClassifier,
  effectiveBrandNames,
  measurementV2UsageEdgeKey,
  parseStoredMeasurementPlanAnyVersion,
  queryTrackingResultsRequestSchema,
  queryTrackingResultsResponseSchema,
  sortedUnique,
  validationError,
  type MeasurementPlanV2,
  type QueryTrackingAnswerRow,
  type QueryTrackingEngineResult,
  type QueryTrackingResultRow,
  type QueryTrackingResultsQuery,
  type QueryTrackingResultsResponse,
  type QueryTrackingResultsRun,
  type QueryTrackingWeakMarket,
  type QueryTrackingWeakMarkets,
  type SimpleMeasurementDefinition,
  type VisibilityReportPopulationClass,
} from '@ainyc/canonry-contracts'
import { measurementPlanVersions, projects, queries, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { resolveProject } from './helpers.js'
import { activeMeasurementPlan } from './measurement-overview.js'
import { planQueryFocus } from './query-focus.js'
import {
  currentSimpleExecutionSignature,
  frozenSimpleExecutionSignature,
  type QueryTrackingRoutesOptions,
} from './query-tracking.js'
import {
  answerCoverage,
  targetValues,
  type Candidate,
  type VisibilityReportEdgeInput,
  type VisibilityReportObservationInput,
  type VisibilityReportRunInput,
  type VisibilityReportSlotInput,
} from './visibility-report-reader.js'
import {
  VISIBILITY_REPORT_MAX_RUNS,
  assignmentSigner,
  comparableVersionIds,
  defaultSweep,
  frozenSimpleDefinitions,
  materializeAdvancedSweep,
  simpleRunInput,
  storedSweepFilter,
} from './visibility-report.js'

type ProjectRow = typeof projects.$inferSelect
type RunRow = typeof runs.$inferSelect
type Assignment = MeasurementPlanV2['assignments'][number]

/**
 * One pairing asked now: a query and class at one location (the whole project
 * on a simple site), with the sweep edge that measured exactly that, or null.
 */
export interface TrackedPairing {
  queryId: string
  queryText: string
  queryClass: VisibilityReportPopulationClass
  edge: VisibilityReportEdgeInput | null
}

interface EngineTally {
  expectedAnswers: number
  answers: number
  mentionedAnswers: number
  citedAnswers: number
  uncheckedSourceAnswers: number
  mentionUnknown: boolean
  citationUnknown: boolean
  unattributedMentionAnswers: number
  mentionedTargetKeys: Set<string>
  citedTargetKeys: Set<string>
  otherLocationMentionedAnswers: number
  otherLocationMentionedTargetKeys: Set<string>
  otherLocationCitedAnswers: number
  otherLocationCitedTargetKeys: Set<string>
  answerRows: QueryTrackingAnswerRow[]
}

/** What the weak-market rule needs from a folded sweep and the wire rows do not carry. */
export interface FoldDetail {
  /** For each returned row, how many of its answers had their text read, and how many had fully saved sources. */
  checked: Map<QueryTrackingResultRow, { mention: number; citation: number }>
  /** The query and class pairs counted in `pendingRows`. */
  withheld: Array<Pick<QueryTrackingResultRow, 'queryId' | 'queryClass'>>
}

/**
 * Set on a read of one query. Every engine entry then lists its answers, and
 * the fold builds no totals. `ownNameKeys` are the brand keys of every
 * location's names, which an answer row never lists as named instead.
 */
export interface FoldAnswerRows {
  ownNameKeys: ReadonlySet<string>
}

function nameKeys(names: readonly string[]): Set<string> {
  return new Set(names.map(brandKeyFromText).filter(key => key.length > 0))
}

function parseQuery(raw: Record<string, unknown>): QueryTrackingResultsQuery {
  const parsed = queryTrackingResultsRequestSchema.safeParse(raw)
  if (!parsed.success) throw validationError('Invalid query tracking results query', { issues: parsed.error.issues })
  return parsed.data
}

function slotsByExecution(sweep: VisibilityReportRunInput): Map<string, VisibilityReportSlotInput[]> {
  const index = new Map<string, VisibilityReportSlotInput[]>()
  for (const slot of sweep.definition.slots) {
    const slots = index.get(slot.executionId)
    if (slots) slots.push(slot)
    else index.set(slot.executionId, [slot])
  }
  return index
}

/** Yes when any answer says so, no only when every expected answer was checked, else not checked. */
function signal(positives: number, unknown: boolean): boolean | null {
  if (positives > 0) return true
  return unknown ? null : false
}

/**
 * Folds one sweep into a row per query and class. A row needs every one of its
 * pairings measured; one unmeasured pairing withholds the row and counts it as
 * pending instead, so a lit chip is always a result for pairings still asked.
 * Each engine reads only the answers of the row's own executions, through the
 * report's per-answer rule (`targetValues`). Advanced and simple sweeps share
 * this fold. `detail`, when passed, takes what a folded sweep knows beyond the
 * wire rows.
 *
 * The totals are the report's own coverage (`answerCoverage`) over the answers
 * of the returned rows, one type at a time. Beyond the row's own signals, an
 * answer also says which covered locations it names or cites, and whether a
 * miss names or cites another location of the plan. None of that changes a
 * signal or a count.
 */
export function foldQueryTrackingResults(
  sweep: VisibilityReportRunInput | null,
  pairings: readonly TrackedPairing[],
  detail?: FoldDetail,
  answerRows?: FoldAnswerRows,
): Pick<QueryTrackingResultsResponse, 'rows' | 'pendingRows' | 'totals'> {
  const pairs = new Map<string, {
    queryId: string
    queryText: string
    queryClass: VisibilityReportPopulationClass
    /** The row's measured edges by execution; null once any pairing is unmeasured. */
    edges: Map<string, VisibilityReportEdgeInput[]> | null
  }>()
  for (const pairing of pairings) {
    const key = `${pairing.queryId}\u0000${pairing.queryClass}`
    let pair = pairs.get(key)
    if (!pair) {
      pair = { queryId: pairing.queryId, queryText: pairing.queryText, queryClass: pairing.queryClass, edges: new Map() }
      pairs.set(key, pair)
    }
    if (pairing.edge === null) pair.edges = null
    else if (pair.edges !== null) {
      const edges = pair.edges.get(pairing.edge.executionId)
      if (edges) edges.push(pairing.edge)
      else pair.edges.set(pairing.edge.executionId, [pairing.edge])
    }
  }
  if (sweep === null) return { rows: [], pendingRows: pairs.size }

  const slots = slotsByExecution(sweep)
  const observations = new Map<string, VisibilityReportObservationInput>()
  for (const observation of sweep.observations) {
    if (observations.has(observation.slotId)) throw new Error(`Duplicate visibility observation for slot ${observation.slotId}`)
    observations.set(observation.slotId, observation)
  }
  const targets = new Map(sweep.definition.targets.map(target => [target.id, target]))

  const rows: QueryTrackingResultRow[] = []
  /** The returned rows' expected answers by type, for the totals. */
  const byClass = new Map<VisibilityReportPopulationClass, { queries: number; candidates: Candidate[] }>()
  let pendingRows = 0
  for (const pair of pairs.values()) {
    if (pair.edges === null) {
      pendingRows++
      detail?.withheld.push({ queryId: pair.queryId, queryClass: pair.queryClass })
      continue
    }
    let total = byClass.get(pair.queryClass)
    if (!total) {
      total = { queries: 0, candidates: [] }
      byClass.set(pair.queryClass, total)
    }
    total.queries++
    // Every location the row covers in the place, on any of its executions.
    const covered = new Set<string>()
    for (const edges of pair.edges.values()) for (const edge of edges) covered.add(edge.targetKey)
    const tallies = new Map<string, EngineTally>()
    const checked = { mention: 0, citation: 0 }
    for (const [executionId, edges] of pair.edges) {
      const expected = slots.get(executionId)
      if (!expected || expected.length === 0) throw new Error(`Frozen usage edge ${edges[0]!.id} has no execution slot`)
      const own = sortedUnique(edges.map(edge => edge.targetKey))
      for (const slot of expected) {
        let tally = tallies.get(slot.provider)
        if (!tally) {
          tally = {
            expectedAnswers: 0, answers: 0, mentionedAnswers: 0, citedAnswers: 0, uncheckedSourceAnswers: 0, mentionUnknown: false, citationUnknown: false,
            unattributedMentionAnswers: 0, mentionedTargetKeys: new Set(), citedTargetKeys: new Set(),
            otherLocationMentionedAnswers: 0, otherLocationMentionedTargetKeys: new Set(),
            otherLocationCitedAnswers: 0, otherLocationCitedTargetKeys: new Set(), answerRows: [],
          }
          tallies.set(slot.provider, tally)
        }
        const observation = observations.get(slot.id) ?? null
        const candidate: Candidate = { run: sweep, slot, edges, observation }
        total.candidates.push(candidate)
        const values = targetValues(candidate, targets)
        tally.expectedAnswers++
        if (observation !== null) tally.answers++
        if (values.mention === true) tally.mentionedAnswers++
        else if (values.mention === null) tally.mentionUnknown = true
        if (values.mention !== null) checked.mention++
        if (values.mentionUnavailableReason === 'identity-ambiguous') tally.unattributedMentionAnswers++
        // An answer whose sources were only partly saved is not checked, even
        // when a saved link cites the location: the report leaves it out of
        // both sides of its citation rate, and so does this count.
        const sourcesSaved = observation !== null && observation.citationComplete
        if (observation !== null && !observation.citationComplete) {
          tally.uncheckedSourceAnswers++
          tally.citationUnknown = true
        } else if (values.citation === true) tally.citedAnswers++
        else if (values.citation === null) tally.citationUnknown = true
        if (sourcesSaved && values.citation !== null) checked.citation++

        // Which covered locations made the answer a yes. Only a yes lists any,
        // so these lists never say more than the signals beside them.
        const mentionedKeys = values.mention === true
          ? own.filter(key => observation!.mentionedTargetKeys.includes(key) && targets.get(key)?.mentionEligible === true)
          : []
        const citedKeys = sourcesSaved && values.citation === true
          ? own.filter(key => observation.citedTargetKeys.includes(key))
          : []
        for (const key of mentionedKeys) tally.mentionedTargetKeys.add(key)
        for (const key of citedKeys) tally.citedTargetKeys.add(key)
        // A checked no that names or cites a location the row does not cover
        // here. A name the reader could not tie to one location is never listed.
        if (values.mention === false) {
          const others = observation!.mentionedTargetKeys.filter(key => !covered.has(key))
          if (others.length > 0) tally.otherLocationMentionedAnswers++
          for (const key of others) tally.otherLocationMentionedTargetKeys.add(key)
        }
        if (sourcesSaved && values.citation === false) {
          const others = observation.citedTargetKeys.filter(key => !covered.has(key))
          if (others.length > 0) tally.otherLocationCitedAnswers++
          for (const key of others) tally.otherLocationCitedTargetKeys.add(key)
        }
        if (answerRows) {
          tally.answerRows.push({
            // The answer read needs saved text, so an answer saved without it has no id here.
            resultId: observation !== null && observation.answerText !== null ? observation.answerId : null,
            searchLocation: slot.location,
            targetKeys: own,
            mentioned: values.mention,
            cited: observation !== null && !observation.citationComplete ? null : values.citation,
            mentionedTargetKeys: mentionedKeys,
            citedTargetKeys: citedKeys,
            namedInstead: (observation?.observedCompetitorNames ?? []).filter(name => {
              const key = brandKeyFromText(name)
              return key.length > 0 && !answerRows.ownNameKeys.has(key)
            }),
          })
        }
      }
    }
    const engines: QueryTrackingEngineResult[] = [...tallies]
      .sort(([left], [right]) => compareText(left, right))
      .map(([provider, tally]) => ({
        provider,
        expectedAnswers: tally.expectedAnswers,
        answers: tally.answers,
        mentionedAnswers: tally.mentionedAnswers,
        citedAnswers: tally.citedAnswers,
        uncheckedSourceAnswers: tally.uncheckedSourceAnswers,
        mentioned: signal(tally.mentionedAnswers, tally.mentionUnknown),
        cited: signal(tally.citedAnswers, tally.citationUnknown),
        // Each optional field is left out when it has nothing to report, so
        // such an entry is the eight fields above and nothing else.
        ...(tally.unattributedMentionAnswers > 0 ? { unattributedMentionAnswers: tally.unattributedMentionAnswers } : {}),
        // A row of one location says which with its own signals.
        ...(covered.size > 1 && tally.mentionedTargetKeys.size > 0 ? { mentionedTargetKeys: sortedUnique([...tally.mentionedTargetKeys]) } : {}),
        ...(covered.size > 1 && tally.citedTargetKeys.size > 0 ? { citedTargetKeys: sortedUnique([...tally.citedTargetKeys]) } : {}),
        ...(tally.otherLocationMentionedAnswers > 0 ? {
          otherLocationMentionedAnswers: tally.otherLocationMentionedAnswers,
          otherLocationMentionedTargetKeys: sortedUnique([...tally.otherLocationMentionedTargetKeys]),
        } : {}),
        ...(tally.otherLocationCitedAnswers > 0 ? {
          otherLocationCitedAnswers: tally.otherLocationCitedAnswers,
          otherLocationCitedTargetKeys: sortedUnique([...tally.otherLocationCitedTargetKeys]),
        } : {}),
        ...(answerRows ? {
          answerRows: tally.answerRows.sort((left, right) => (
            compareText(left.searchLocation ?? '', right.searchLocation ?? '') || compareText(left.targetKeys.join('\u0000'), right.targetKeys.join('\u0000'))
          )),
        } : {}),
      }))
    const row = { queryId: pair.queryId, queryText: pair.queryText, queryClass: pair.queryClass, engines }
    rows.push(row)
    detail?.checked.set(row, checked)
  }
  rows.sort((left, right) => compareText(left.queryId, right.queryId) || compareText(left.queryClass, right.queryClass))
  if (answerRows) return { rows, pendingRows }
  const totals = [...byClass]
    .sort(([left], [right]) => compareText(left, right))
    .map(([queryClass, total]) => {
      const coverage = answerCoverage(total.candidates, targets)
      return {
        queryClass,
        queries: total.queries,
        answers: coverage.answerCount,
        mentionCoverage: coverage.mentionCoverage,
        citationCoverage: coverage.citationCoverage,
      }
    })
  return { rows, pendingRows, totals }
}

const PLACE_WORDS = { group: 'Group', market: 'Market', property: 'Location' } as const

function placeNotTracked(scope: 'group' | 'market' | 'property', key: string) {
  return validationError(`${PLACE_WORDS[scope]} "${key}" is not in the active plan.`, {
    reason: VisibilityReportScopeErrorReasons['retired-scope'],
    kind: scope,
    key,
  })
}

/** The active plan's assignments inside the place. A key the active plan does not hold is refused. */
function placeAssignments(plan: MeasurementPlanV2, query: QueryTrackingResultsQuery): readonly Assignment[] {
  if (query.scope === 'project') return plan.assignments
  const key = query.scopeKey!
  if (query.scope === 'property') {
    if (!plan.targets.some(target => target.stableKey === key)) throw placeNotTracked('property', key)
    return plan.assignments.filter(assignment => assignment.targetKey === key)
  }
  if (query.scope === 'group') {
    const group = plan.groups.find(candidate => candidate.stableKey === key)
    if (!group) throw placeNotTracked('group', key)
    const targetKeys = new Set(group.targetKeys)
    return plan.assignments.filter(assignment => targetKeys.has(assignment.targetKey))
  }
  // A market holds exact usage edges, never every pairing of its locations.
  const market = (plan.reportingScopes ?? []).find(candidate => candidate.stableKey === key)
  if (!market) throw placeNotTracked('market', key)
  const edges = new Set(market.usageEdges.map(measurementV2UsageEdgeKey))
  return plan.assignments.filter(assignment => edges.has(measurementV2UsageEdgeKey(assignment)))
}

function edgeKey(executionId: string, targetKey: string, queryId: string | null): string {
  return `${executionId}\u0000${targetKey}\u0000${queryId ?? ''}`
}

/**
 * Pairs each active assignment in the place with the sweep edge that measured
 * it. A sweep read under the active plan measured every assignment as it
 * stands. A sweep of an older plan measured one only when that plan signs it
 * identically, so a query moved, re-typed or reworded since has no edge.
 */
function advancedPairings(
  activePlan: MeasurementPlanV2,
  assignments: readonly Assignment[],
  measured: { sweep: VisibilityReportRunInput; plan: MeasurementPlanV2; underActivePlan: boolean } | null,
): TrackedPairing[] {
  const nodes = new Map(activePlan.executionNodes.map(node => [node.stableKey, node]))
  let edgeFor: (assignment: Assignment) => VisibilityReportEdgeInput | null = () => null
  if (measured !== null) {
    const edges = new Map(measured.sweep.definition.edges.map(edge => [edgeKey(edge.executionId, edge.targetKey, edge.queryId), edge]))
    const ownEdge = (assignment: Assignment) => edges.get(edgeKey(assignment.executionNodeKey, assignment.targetKey, assignment.queryId)) ?? null
    if (measured.underActivePlan) {
      edgeFor = ownEdge
    } else {
      const asked = new Set(assignments.map(assignment => assignment.queryId))
      const signMeasured = assignmentSigner(measured.plan)
      const bySignature = new Map<string, VisibilityReportEdgeInput>()
      for (const assignment of measured.plan.assignments) {
        if (!asked.has(assignment.queryId)) continue
        const edge = ownEdge(assignment)
        if (edge !== null) bySignature.set(signMeasured(assignment), edge)
      }
      const signActive = assignmentSigner(activePlan)
      edgeFor = assignment => bySignature.get(signActive(assignment)) ?? null
    }
  }
  return assignments.flatMap(assignment => {
    const node = nodes.get(assignment.executionNodeKey)
    // Same population as the tracked row: an assignment without its execution node is skipped.
    if (!node) return []
    return [{ queryId: assignment.queryId, queryText: node.queryText, queryClass: assignment.queryClass, edge: edgeFor(assignment) }]
  })
}

/**
 * A simple basket's pairings: each tracked query under the class the project
 * classifier gives it now (`unknown` with no usable brand name), measured only
 * by a sweep that asked that query id with the same text under the same class.
 * An older sweep that stored no query text has only the id to go by. Pass no
 * sweep when it sent the engines something the project no longer sends: then
 * no query was measured as it is asked now.
 */
function simplePairings(
  tracked: ReadonlyArray<{ id: string; query: string }>,
  classOf: (queryText: string) => VisibilityReportPopulationClass,
  sweep: VisibilityReportRunInput | null,
): TrackedPairing[] {
  const edgesByQuery = new Map<string, VisibilityReportEdgeInput[]>()
  const slots = sweep === null ? new Map<string, VisibilityReportSlotInput[]>() : slotsByExecution(sweep)
  for (const edge of sweep?.definition.edges ?? []) {
    if (edge.queryId === null) continue
    const edges = edgesByQuery.get(edge.queryId)
    if (edges) edges.push(edge)
    else edgesByQuery.set(edge.queryId, [edge])
  }
  return tracked.flatMap((row): TrackedPairing[] => {
    const queryClass = classOf(row.query)
    const pairing = { queryId: row.id, queryText: row.query, queryClass }
    const measured = (edgesByQuery.get(row.id) ?? []).filter(edge => (
      edge.queryClass === queryClass
      && slots.get(edge.executionId)?.every(slot => slot.query === row.query || slot.query === '') === true
    ))
    return measured.length === 0 ? [{ ...pairing, edge: null }] : measured.map(edge => ({ ...pairing, edge }))
  })
}

/**
 * A simple basket has no revision, so a planless sweep's frozen definition is
 * compared with what the project dispatches now, through the workspace's own
 * signature. `sameDispatch`: the engines were sent the same thing (engines,
 * models, search location, country and language), which is what an advanced
 * pairing's signature covers. `sameTracking` adds the project's names and
 * sites, which decide how an answer is read: the workspace's full rule.
 */
function simpleSweepComparer(
  project: ProjectRow,
  opts: QueryTrackingRoutesOptions,
): (definition: SimpleMeasurementDefinition) => { sameDispatch: boolean; sameTracking: boolean } {
  const current = currentSimpleExecutionSignature(project, opts)
  return definition => {
    const namedAsNow: SimpleMeasurementDefinition = {
      ...definition,
      identity: {
        ...definition.identity,
        displayName: project.displayName,
        aliases: project.aliases,
        canonicalDomain: project.canonicalDomain,
        ownedDomains: project.ownedDomains,
      },
    }
    return {
      sameDispatch: frozenSimpleExecutionSignature(namedAsNow) === current,
      sameTracking: frozenSimpleExecutionSignature(definition) === current,
    }
  }
}

/**
 * The planless sweep a read shows, with its frozen definition. Named by id,
 * `candidates` holds that sweep alone. Otherwise the choice is `defaultSweep`'s
 * for a plan: the newest sweep that sent the engines what the project sends
 * now, else the newest. A run of one engine, at another search location or
 * without one froze another dispatch, as every member but one of an
 * all-locations run did, so it never hides the full sweep before it.
 *
 * A run of only some queries (`runs.queries` set) is the engine's own idea of
 * a scoped run, so among the sweeps sent as the project sends now, one of the
 * whole list is preferred over a newer run of part of it. It is a preference,
 * not a filter: some stores stamp the list on every sweep.
 *
 * The newest sweep's definition is read alone, because on most reads it is
 * the answer. Only when it is not are the older candidates' definitions read,
 * all in one read. `candidates` is the look-back: the newest
 * `VISIBILITY_REPORT_MAX_RUNS` sweeps, the ones the workspace compares too.
 */
function simpleSweepChoice(
  db: DatabaseClient,
  projectId: string,
  candidates: ReadonlyArray<{ id: string; queries?: string[] | null }>,
  sameDispatch: (definition: SimpleMeasurementDefinition) => boolean,
): { id: string; definition: SimpleMeasurementDefinition | undefined } | undefined {
  const newest = candidates.at(0)
  if (!newest) return undefined
  const older = candidates.slice(1)
  const wholeList = (candidate: { queries?: string[] | null }) => candidate.queries == null
  const definition = frozenSimpleDefinitions(db, projectId, [newest.id]).get(newest.id)
  const newestMatches = definition !== undefined && sameDispatch(definition)
  if (older.length === 0 || (newestMatches && wholeList(newest))) return { id: newest.id, definition }
  const definitions = frozenSimpleDefinitions(db, projectId, older.map(candidate => candidate.id))
  const matching = [
    ...(newestMatches ? [{ candidate: newest, frozen: definition }] : []),
    ...older.flatMap(candidate => {
      const frozen = definitions.get(candidate.id)
      return frozen !== undefined && sameDispatch(frozen) ? [{ candidate, frozen }] : []
    }),
  ]
  const chosen = matching.find(match => wholeList(match.candidate)) ?? matching.at(0)
  return chosen ? { id: chosen.candidate.id, definition: chosen.frozen } : { id: newest.id, definition }
}

/** Whole-project sweeps, newest first, without their stored slot lists. */
function sweepCandidates(db: DatabaseClient, projectId: string, planless: boolean, runId: string | undefined) {
  return db.select({ id: runs.id, versionId: runs.measurementPlanVersionId, queries: runs.queries }).from(runs).where(and(
    storedSweepFilter(projectId, planless),
    // A scoped spot check measured a slice, so it is never read here, even by id.
    isNull(runs.measurementScope),
    runId === undefined ? undefined : eq(runs.id, runId),
  )).orderBy(desc(runs.createdAt), desc(runs.id)).limit(VISIBILITY_REPORT_MAX_RUNS).all()
}

function notASweep(runId: string) {
  return validationError(`Run "${runId}" is not a completed whole-project sweep of this project.`)
}

function sweepRow(db: DatabaseClient, runId: string): RunRow {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get()
  if (!run) throw new Error(`Sweep ${runId} disappeared during the read`)
  return run
}

function runDto(run: RunRow, revision: number | null, matchesCurrentTracking: boolean): QueryTrackingResultsRun {
  return {
    id: run.id,
    createdAt: run.createdAt,
    completedAt: run.finishedAt,
    status: run.status as QueryTrackingResultsRun['status'],
    revision,
    matchesCurrentTracking,
  }
}

function engines(sweep: VisibilityReportRunInput | null): string[] {
  return sweep === null ? [] : sortedUnique(sweep.definition.slots.map(slot => slot.provider))
}

/**
 * The weak-market rule over the rows a project read returns. Only a non-brand
 * row whose query has a market as its Subject is read, so a market's branded
 * rows, its locations' own queries and hand-picked queries never count. A
 * market is weak when one of its answers had its text read and none named a
 * location the row covers. With no answer read it is left out, and so it is
 * with such a row withheld: the sweep may hold a mention for the query as it
 * was asked then. `markets` ranks the listed markets, weakest first: a cited
 * answer or one naming another location is a signal the others lack.
 */
function weakMarkets(
  plan: MeasurementPlanV2,
  rows: readonly QueryTrackingResultRow[],
  detail: FoldDetail,
): QueryTrackingWeakMarkets {
  const focusOf = planQueryFocus(plan)
  const marketOf = (pair: Pick<QueryTrackingResultRow, 'queryId' | 'queryClass'>): string | null => {
    if (pair.queryClass !== QUERY_TRACKING_WEAK_MARKET_CLASS) return null
    const focus = focusOf(pair.queryId)
    return focus.kind === 'market' ? focus.key : null
  }
  const markets = new Map<string, QueryTrackingWeakMarket>()
  for (const row of rows) {
    const marketKey = marketOf(row)
    if (marketKey === null) continue
    let market = markets.get(marketKey)
    if (!market) {
      market = { marketKey, queries: 0, mentionCheckedAnswers: 0, mentionedAnswers: 0, otherLocationMentionedAnswers: 0, citationCheckedAnswers: 0, citedAnswers: 0 }
      markets.set(marketKey, market)
    }
    const checked = detail.checked.get(row)
    market.queries++
    market.mentionCheckedAnswers += checked?.mention ?? 0
    market.citationCheckedAnswers += checked?.citation ?? 0
    for (const engine of row.engines) {
      market.mentionedAnswers += engine.mentionedAnswers
      market.otherLocationMentionedAnswers += engine.otherLocationMentionedAnswers ?? 0
      market.citedAnswers += engine.citedAnswers
    }
  }
  const withheld = new Set(detail.withheld.map(marketOf))
  const listed = [...markets.values()]
    .filter(market => market.mentionCheckedAnswers > 0 && market.mentionedAnswers === 0 && !withheld.has(market.marketKey))
    .sort((left, right) => compareText(left.marketKey, right.marketKey))
  return {
    rule: QUERY_TRACKING_WEAK_MARKET_RULE,
    queryClass: QUERY_TRACKING_WEAK_MARKET_CLASS,
    count: listed.length,
    marketKeys: listed.map(market => market.marketKey),
    markets: [...listed].sort((left, right) => (
      left.citedAnswers - right.citedAnswers
      || left.otherLocationMentionedAnswers - right.otherLocationMentionedAnswers
      || right.mentionCheckedAnswers - left.mentionCheckedAnswers
      || compareText(left.marketKey, right.marketKey)
    )),
  }
}

function advancedResults(
  db: DatabaseClient,
  projectId: string,
  active: { version: typeof measurementPlanVersions.$inferSelect; plan: MeasurementPlanV2 },
  query: QueryTrackingResultsQuery,
): Omit<QueryTrackingResultsResponse, 'mode' | 'scope'> {
  // Refuse an unknown place before any sweep is read.
  const inPlace = placeAssignments(active.plan, query)
  const assignments = query.queryId === undefined ? inPlace : inPlace.filter(assignment => assignment.queryId === query.queryId)
  // Revision rows without their documents: choosing a sweep parses no plan.
  const versions = new Map(db.select({
    id: measurementPlanVersions.id,
    revision: measurementPlanVersions.revision,
    schemaVersion: measurementPlanVersions.schemaVersion,
    comparableToVersionId: measurementPlanVersions.comparableToVersionId,
  }).from(measurementPlanVersions).where(eq(measurementPlanVersions.projectId, projectId)).all().map(row => [row.id, row]))
  const activeChain = new Set(comparableVersionIds(versions, active.version.id))
  const candidates = sweepCandidates(db, projectId, false, query.runId).flatMap(candidate => {
    const version = candidate.versionId === null ? undefined : versions.get(candidate.versionId)
    return version?.schemaVersion === MEASUREMENT_PLAN_V2_SCHEMA_VERSION ? [{ id: candidate.id, version }] : []
  })
  const chosen = query.runId === undefined
    ? defaultSweep(candidates, candidate => candidate.version.id, activeChain)
    : candidates.at(0)
  if (!chosen) {
    if (query.runId !== undefined) throw notASweep(query.runId)
    return { run: null, engines: [], ...foldQueryTrackingResults(null, advancedPairings(active.plan, assignments, null)) }
  }

  const underActivePlan = activeChain.has(chosen.version.id)
  // A sweep of the active chain reads under the active plan, already parsed.
  // Any other sweep reads under the plan it ran with: the one extra parse.
  const sweepPlan = underActivePlan ? active.plan : storedPlan(db, projectId, chosen.version.id)
  const run = sweepRow(db, chosen.id)
  const source = { run, source: { row: chosen.version, plan: sweepPlan } }
  const presentation = { version: active.version, plan: active.plan, comparableIds: activeChain }
  const pairings = (sweep: VisibilityReportRunInput) => advancedPairings(active.plan, assignments, { sweep, plan: sweepPlan, underActivePlan })
  if (query.queryId !== undefined) {
    // One query: only the answers of its executions in the plan the sweep is
    // read under are loaded, with their evidence, and nothing is totalled.
    const executionIds = sortedUnique(sweepPlan.assignments
      .filter(assignment => assignment.queryId === query.queryId)
      .map(assignment => assignment.executionNodeKey))
    const sweep = materializeAdvancedSweep(db, source, presentation, versions, true, executionIds)
    const ownNameKeys = nameKeys(sweepPlan.targets.flatMap(target => [target.label, ...target.aliases]))
    return {
      run: runDto(run, chosen.version.revision, underActivePlan),
      engines: engines(sweep),
      ...foldQueryTrackingResults(sweep, pairings(sweep), undefined, { ownNameKeys }),
    }
  }
  const sweep = materializeAdvancedSweep(db, source, presentation, versions, false)
  const detail: FoldDetail = { checked: new Map(), withheld: [] }
  const folded = foldQueryTrackingResults(sweep, pairings(sweep), detail)
  return {
    run: runDto(run, chosen.version.revision, underActivePlan),
    engines: engines(sweep),
    ...folded,
    // Only the project read holds every market's pairings, so only it lists weak markets.
    ...(query.scope === 'project' ? { weakMarkets: weakMarkets(active.plan, folded.rows, detail) } : {}),
  }
}

function storedPlan(db: DatabaseClient, projectId: string, versionId: string): MeasurementPlanV2 {
  const row = db.select({ canonicalJson: measurementPlanVersions.canonicalJson }).from(measurementPlanVersions).where(and(
    eq(measurementPlanVersions.projectId, projectId),
    eq(measurementPlanVersions.id, versionId),
  )).get()
  const plan = row === undefined ? undefined : parseStoredMeasurementPlanAnyVersion(row.canonicalJson)
  if (plan?.schemaVersion !== MEASUREMENT_PLAN_V2_SCHEMA_VERSION) throw new Error(`Measurement plan version ${versionId} is not a readable schema-v2 plan`)
  return plan
}

function simpleResults(
  db: DatabaseClient,
  project: ProjectRow,
  query: QueryTrackingResultsQuery,
  opts: QueryTrackingRoutesOptions,
): Omit<QueryTrackingResultsResponse, 'mode' | 'scope'> {
  if (query.scope !== 'project') {
    throw validationError(`${PLACE_WORDS[query.scope]} "${query.scopeKey}" does not exist: a simple project is read as a whole.`)
  }
  const tracked = db.select({ id: queries.id, query: queries.query }).from(queries).where(eq(queries.projectId, project.id)).all()
  /** The pairings a read returns: every tracked query, or the one named. */
  const read = (pairings: TrackedPairing[]) => (
    query.queryId === undefined ? pairings : pairings.filter(pairing => pairing.queryId === query.queryId)
  )
  // The workspace row's class: no usable brand name leaves it unset, never non-brand.
  const classifier = compileQueryClassifier(effectiveBrandNames(project))
  const classOf = (queryText: string): VisibilityReportPopulationClass => classifier?.classify(queryText) ?? 'unknown'
  const compare = simpleSweepComparer(project, opts)
  const chosen = simpleSweepChoice(db, project.id, sweepCandidates(db, project.id, true, query.runId), definition => compare(definition).sameDispatch)
  if (!chosen) {
    if (query.runId !== undefined) throw notASweep(query.runId)
    return { run: null, engines: [], ...foldQueryTrackingResults(null, read(simplePairings(tracked, classOf, null))) }
  }
  const { definition } = chosen
  const run = sweepRow(db, chosen.id)
  // One query: only its answers are loaded, with their evidence.
  const sweep = simpleRunInput(db, project, run, definition, query.queryId !== undefined, query.queryId)
  // An older sweep with no frozen definition recorded nothing to compare.
  const comparison = definition === undefined ? null : compare(definition)
  // As an advanced row whose engines, models or search location changed: a
  // sweep that sent the engines something else leaves every query pending.
  const pairings = simplePairings(tracked, classOf, comparison?.sameDispatch === false ? null : sweep)
  const folded = foldQueryTrackingResults(
    sweep,
    read(pairings),
    undefined,
    query.queryId === undefined ? undefined : { ownNameKeys: nameKeys(effectiveBrandNames(project)) },
  )
  // Tracking matches when nothing the workspace compares changed, the sweep
  // measured every tracked query as it is tracked now, and it asked nothing
  // else. A sweep that cannot be compared never claims a match.
  const trackedPairs = new Set(pairings.map(pairing => `${pairing.queryId}\u0000${pairing.queryClass}`))
  // Every tracked query counts here, also on a read of one.
  const everyQueryMeasured = pairings.every(pairing => pairing.edge !== null)
  const matchesCurrentTracking = comparison?.sameTracking === true && everyQueryMeasured && sweep.definition.edges.every(edge => (
    edge.queryId !== null && trackedPairs.has(`${edge.queryId}\u0000${edge.queryClass}`)
  ))
  return { run: runDto(run, null, matchesCurrentTracking), engines: engines(sweep), ...folded }
}

/**
 * Shared stored-evidence reader. Callers enforce authorization before resolving
 * the project. `opts` is the host's provider configuration, read only to tell
 * what a simple project dispatches now.
 */
export function readQueryTrackingResults(
  db: DatabaseClient,
  project: ProjectRow,
  rawQuery: Record<string, unknown>,
  opts: QueryTrackingRoutesOptions,
): QueryTrackingResultsResponse {
  const query = parseQuery(rawQuery)
  const scope = { kind: query.scope, key: query.scopeKey ?? null }
  const active = activeMeasurementPlan(db, project.id)
  if (active === null) {
    return queryTrackingResultsResponseSchema.parse({ mode: 'simple', scope, ...simpleResults(db, project, query, opts) })
  }
  const { version, plan } = active
  if (plan.schemaVersion !== MEASUREMENT_PLAN_V2_SCHEMA_VERSION) {
    throw validationError('Query tracking requires a schema-v2 measurement plan. Republish setup before reading query results.')
  }
  return queryTrackingResultsResponseSchema.parse({ mode: 'advanced', scope, ...advancedResults(db, project.id, { version, plan }, query) })
}

export async function queryTrackingResultsRoutes(app: FastifyInstance, opts: QueryTrackingRoutesOptions) {
  app.get<{ Params: { name: string }; Querystring: Record<string, unknown> }>(
    '/projects/:name/query-tracking/results',
    async request => readQueryTrackingResults(app.db, resolveProject(app.db, request.params.name), request.query, opts),
  )
}
