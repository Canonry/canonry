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
  alternativeNames,
  brandKeyFromText,
  compareText,
  compileQueryClassifier,
  effectiveBrandNames,
  hostOf,
  normalizeIdentityText,
  measurementV2UsageEdgeKey,
  parseStoredMeasurementPlanAnyVersion,
  queryTrackingResultsRequestSchema,
  queryTrackingResultsResponseSchema,
  registrableDomain,
  sortedUnique,
  validationError,
  type MeasurementPlanV2,
  type QueryTrackingAnswerRow,
  type QueryTrackingCitedSource,
  type QueryTrackingEngineResult,
  type QueryTrackingResultGroup,
  type QueryTrackingResultTotals,
  type QueryTrackingResultRow,
  type QueryTrackingResultsQuery,
  type QueryTrackingResultsResponse,
  type QueryTrackingResultsRun,
  type QueryTrackingWeakMarket,
  type QueryTrackingWeakMarkets,
  type SimpleMeasurementDefinition,
  type VisibilityReportPopulationClass,
  type VisibilityReportRate,
} from '@canonry/canonry-contracts'
import { measurementPlanVersions, projects, queries, runs, type DatabaseClient } from '@canonry/canonry-db'
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
  /** When set: each returned row's expected answers, so a subset of rows can be rated by the report's own rule. */
  candidates?: Map<QueryTrackingResultRow, Candidate[]>
  /** When set (a sweep read with its evidence): each returned row's saved answers, for the "who won" lists. */
  evidence?: Map<QueryTrackingResultRow, AnswerEvidence[]>
}

/** One saved answer of a row, as the "who won" lists read it. */
export interface AnswerEvidence {
  provider: string
  mention: boolean | null
  /** Null when not checked, including sources only partly saved. */
  citation: boolean | null
  names: readonly string[]
  sources: readonly string[]
  competitorMentionDomains: readonly string[]
  competitorCitationDomains: readonly string[]
}

/**
 * Set on a read of one query. Every engine entry then lists its answers, and
 * the fold builds no totals. `ownNameKeys` are the brand keys of every
 * location's names, which an answer row never lists as named instead.
 */
export interface FoldAnswerRows {
  ownNameKeys: ReadonlySet<string>
  /** The project's own sites, as registrable domains, for each cited source's `ours`. */
  ownDomains: ReadonlySet<string>
}

/** Each source of one answer, with whose site it is. A competitor is one whose domain this answer's own evidence cites. */
function citedSources(sources: readonly string[], ownDomains: ReadonlySet<string>, competitorDomains: readonly string[]): QueryTrackingCitedSource[] {
  const competitors = new Set(competitorDomains.map(domain => registrableDomain(domain)).filter(Boolean))
  return sources.flatMap(url => {
    const host = hostOf(url)
    if (!host) return []
    const domain = registrableDomain(host)
    return [{ url, host: host.replace(/^www\./, ''), ours: ownDomains.has(domain), competitor: competitors.has(domain) ? domain : null }]
  })
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
    const rowCandidates: Candidate[] = []
    const rowEvidence: AnswerEvidence[] = []
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
        rowCandidates.push(candidate)
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
        if (detail?.evidence && observation !== null) {
          rowEvidence.push({
            provider: slot.provider,
            mention: values.mention,
            citation: sourcesSaved ? values.citation : null,
            names: observation.observedCompetitorNames,
            sources: observation.sources,
            competitorMentionDomains: observation.competitorMentionDomains,
            competitorCitationDomains: observation.competitorCitationDomains,
          })
        }

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
          // A name is "instead" only when the answer did not mention the row; otherwise it was also named.
          const names = alternativeNames(observation?.observedCompetitorNames ?? [], answerRows.ownNameKeys)
          tally.answerRows.push({
            // The answer read needs saved text, so an answer saved without it has no id here.
            resultId: observation !== null && observation.answerText !== null ? observation.answerId : null,
            searchLocation: slot.location,
            targetKeys: own,
            mentioned: values.mention,
            cited: observation !== null && !observation.citationComplete ? null : values.citation,
            mentionedTargetKeys: mentionedKeys,
            citedTargetKeys: citedKeys,
            namedInstead: values.mention === false ? names : [],
            alsoNamed: values.mention === false ? [] : names,
            citedSources: observation === null ? [] : citedSources(observation.sources, answerRows.ownDomains, observation.competitorCitationDomains),
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
    detail?.candidates?.set(row, rowCandidates)
    detail?.evidence?.set(row, rowEvidence)
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


type ResultSignal = 'mentioned' | 'cited'
type FoldedSweep = { rows: QueryTrackingResultRow[]; detail: FoldDetail; targets: Map<string, VisibilityReportRunInput['definition']['targets'][number]> }

const rowKey = (row: Pick<QueryTrackingResultRow, 'queryId' | 'queryClass'>) => `${row.queryId}\u0000${row.queryClass}`

function targetIndex(sweep: VisibilityReportRunInput): FoldedSweep['targets'] {
  return new Map(sweep.definition.targets.map(target => [target.id, target]))
}

/** The project's own sites as registrable domains: a cited source on one is ours. */
function ownDomainsOf(project: Pick<ProjectRow, 'canonicalDomain' | 'ownedDomains'>): Set<string> {
  return new Set([project.canonicalDomain, ...(project.ownedDomains ?? [])].map(domain => registrableDomain(domain)).filter(Boolean))
}

/** A row's share of checked answers that show the signal, over its engines; null when none was checked. */
function rowShare(row: QueryTrackingResultRow, signal: ResultSignal): number | null {
  let shown = 0
  let checked = 0
  for (const engine of row.engines) {
    if (signal === 'mentioned') {
      shown += engine.mentionedAnswers
      checked += engine.answers - (engine.unattributedMentionAnswers ?? 0)
    } else {
      shown += engine.citedAnswers
      checked += engine.answers - engine.uncheckedSourceAnswers
    }
  }
  return checked > 0 ? shown / checked : null
}

/** Losing first is the lowest share first, winning first the highest. A share that could not be read goes last either way. */
function compareShares(left: number | null, right: number | null, sort: 'losing' | 'winning'): number {
  if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1
  return sort === 'losing' ? left - right : right - left
}

function sortRows(rows: readonly QueryTrackingResultRow[], signal: ResultSignal, sort: 'losing' | 'winning'): QueryTrackingResultRow[] {
  return [...rows].sort((left, right) => (
    compareShares(rowShare(left, signal), rowShare(right, signal), sort)
    || compareText(normalizeIdentityText(left.queryText), normalizeIdentityText(right.queryText))
    || compareText(left.queryClass, right.queryClass)
  ))
}

/**
 * Marks each engine's signal gained or lost since the previous sweep's row of
 * the same query and class. Only two checked results compare: a not-checked
 * answer on either side is no change.
 */
function markChanges(rows: readonly QueryTrackingResultRow[], previous: readonly QueryTrackingResultRow[]): void {
  const before = new Map(previous.map(row => [rowKey(row), row]))
  for (const row of rows) {
    const prior = before.get(rowKey(row))
    if (!prior) continue
    for (const engine of row.engines) {
      const old = prior.engines.find(candidate => candidate.provider === engine.provider)
      if (!old) continue
      if (engine.mentioned !== null && old.mentioned !== null && engine.mentioned !== old.mentioned) engine.mentionChange = engine.mentioned ? 'won' : 'lost'
      if (engine.cited !== null && old.cited !== null && engine.cited !== old.cited) engine.citationChange = engine.cited ? 'won' : 'lost'
    }
  }
}

/**
 * The filters narrow rows only, read on `engine`, or across the row's engines
 * without it, as the dashboard's Result filter reads them: mentioned (or
 * cited) when one engine shows it, not mentioned when one engine checked and
 * none shows it. Not checked is never a no. A change holds when one of those
 * engines won or lost the signal.
 */
function keepRow(row: QueryTrackingResultRow, query: QueryTrackingResultsQuery, signal: ResultSignal): boolean {
  if (query.engine === undefined && query.result === undefined && query.change === undefined) return true
  const engines = query.engine === undefined ? row.engines : row.engines.filter(engine => engine.provider === query.engine)
  let result = true
  if (query.result !== undefined) {
    const field = query.result === 'mentioned' || query.result === 'not-mentioned' ? 'mentioned' : 'cited'
    const yes = engines.some(engine => engine[field] === true)
    result = query.result.startsWith('not-') ? !yes && engines.some(engine => engine[field] === false) : yes
  }
  const changeField = signal === 'cited' ? 'citationChange' : 'mentionChange'
  return result && (query.change === undefined || engines.some(engine => engine[changeField] === query.change))
}

/** Totals over a set of rows, by the report's own rule, one type at a time. */
function totalsOver(rows: readonly QueryTrackingResultRow[], folded: FoldedSweep): QueryTrackingResultTotals[] {
  const byClass = new Map<VisibilityReportPopulationClass, QueryTrackingResultRow[]>()
  for (const row of rows) {
    const list = byClass.get(row.queryClass)
    if (list) list.push(row)
    else byClass.set(row.queryClass, [row])
  }
  return [...byClass].sort(([left], [right]) => compareText(left, right)).map(([queryClass, list]) => {
    const coverage = answerCoverage(list.flatMap(row => folded.detail.candidates?.get(row) ?? []), folded.targets)
    return { queryClass, queries: list.length, answers: coverage.answerCount, mentionCoverage: coverage.mentionCoverage, citationCoverage: coverage.citationCoverage }
  })
}

/** Each type's rates in both sweeps over the rows both measured, so a change compares the same queries. */
/** One rate minus the same rate of the previous sweep, or null when either is not a number. */
function rateDelta(current: VisibilityReportRate, previous: VisibilityReportRate): number | null {
  return current.rate === null || previous.rate === null ? null : current.rate - previous.rate
}

function withComparison(totals: readonly QueryTrackingResultTotals[], rows: readonly QueryTrackingResultRow[], now: FoldedSweep, previous: FoldedSweep): QueryTrackingResultTotals[] {
  const before = new Map(previous.rows.map(row => [rowKey(row), row]))
  return totals.map(total => {
    const matched = rows.filter(row => row.queryClass === total.queryClass && before.has(rowKey(row)))
    if (matched.length === 0) return total
    const current = answerCoverage(matched.flatMap(row => now.detail.candidates?.get(row) ?? []), now.targets)
    const prior = answerCoverage(matched.flatMap(row => previous.detail.candidates?.get(before.get(rowKey(row))!) ?? []), previous.targets)
    return {
      ...total,
      comparison: {
        queries: matched.length,
        mentionCoverage: current.mentionCoverage,
        citationCoverage: current.citationCoverage,
        previousMentionCoverage: prior.mentionCoverage,
        previousCitationCoverage: prior.citationCoverage,
        mentionDelta: rateDelta(current.mentionCoverage, prior.mentionCoverage),
        citationDelta: rateDelta(current.citationCoverage, prior.citationCoverage),
      },
    }
  })
}

const WINNER_LIST_LIMIT = 5

function topCounts<T>(counts: Map<string, { item: T; answers: number }>, label: (item: T) => string): Array<{ item: T; answers: number }> {
  return [...counts.values()].sort((left, right) => right.answers - left.answers || compareText(label(left.item), label(right.item))).slice(0, WINNER_LIST_LIMIT)
}

/**
 * One market's or group's roll-up over its rows. A market holds the queries
 * whose Subject is that market and its locations' own queries; a row counts
 * once however many of its locations sit there. The rates are the report's
 * own over the rows of each type. The "who won" lists read the non-brand
 * answers that missed each signal.
 */
function rollup(
  entry: Pick<QueryTrackingResultGroup, 'kind' | 'key' | 'label' | 'parentKey' | 'locations' | 'marketKeys'>,
  rows: readonly QueryTrackingResultRow[],
  folded: FoldedSweep,
  engineOrder: readonly string[],
  ownNameKeys: ReadonlySet<string>,
  ownDomains: ReadonlySet<string>,
  compared: boolean,
): QueryTrackingResultGroup {
  const unique = [...new Set(rows)]
  const byClass = new Map<VisibilityReportPopulationClass, QueryTrackingResultRow[]>()
  for (const row of unique) {
    const list = byClass.get(row.queryClass)
    if (list) list.push(row)
    else byClass.set(row.queryClass, [row])
  }
  const types = [...byClass].sort(([left], [right]) => compareText(left, right)).map(([queryClass, list]) => {
    const coverage = answerCoverage(list.flatMap(row => folded.detail.candidates?.get(row) ?? []), folded.targets)
    const engineEntries = list.flatMap(row => row.engines)
    const count = (test: (engine: QueryTrackingEngineResult) => boolean) => engineEntries.filter(test).length
    return {
      queryClass,
      queries: list.length,
      answers: coverage.answerCount,
      mentionCoverage: coverage.mentionCoverage,
      citationCoverage: coverage.citationCoverage,
      otherLocationMentionedAnswers: engineEntries.reduce((sum, engine) => sum + (engine.otherLocationMentionedAnswers ?? 0), 0),
      engines: engineOrder.map(provider => {
        const own = engineEntries.filter(engine => engine.provider === provider)
        return {
          provider,
          answers: own.reduce((sum, engine) => sum + engine.answers, 0),
          mentionedAnswers: own.reduce((sum, engine) => sum + engine.mentionedAnswers, 0),
          citedAnswers: own.reduce((sum, engine) => sum + engine.citedAnswers, 0),
        }
      }),
      ...(compared ? {
        change: {
          mentionsWon: count(engine => engine.mentionChange === 'won'),
          mentionsLost: count(engine => engine.mentionChange === 'lost'),
          citationsWon: count(engine => engine.citationChange === 'won'),
          citationsLost: count(engine => engine.citationChange === 'lost'),
        },
      } : {}),
    }
  })
  const named = new Map<string, { item: string; answers: number }>()
  const cited = new Map<string, { item: string; answers: number }>()
  const competitors = new Map<string, { mentionedAnswers: number; citedAnswers: number }>()
  for (const row of unique) {
    if (row.queryClass !== QUERY_TRACKING_WEAK_MARKET_CLASS) continue
    for (const answer of folded.detail.evidence?.get(row) ?? []) {
      if (answer.mention === false) {
        for (const name of alternativeNames(answer.names, ownNameKeys)) {
          const key = brandKeyFromText(name)
          const entry = named.get(key)
          if (entry) entry.answers++
          else named.set(key, { item: name, answers: 1 })
        }
      }
      if (answer.citation === false) {
        const hosts = new Set(answer.sources.flatMap(url => {
          const host = hostOf(url)
          return host && !ownDomains.has(registrableDomain(host)) ? [host.replace(/^www\./, '')] : []
        }))
        for (const host of hosts) {
          const entry = cited.get(host)
          if (entry) entry.answers++
          else cited.set(host, { item: host, answers: 1 })
        }
      }
      for (const domain of new Set(answer.competitorMentionDomains)) {
        const entry = competitors.get(domain) ?? { mentionedAnswers: 0, citedAnswers: 0 }
        entry.mentionedAnswers++
        competitors.set(domain, entry)
      }
      for (const domain of new Set(answer.competitorCitationDomains)) {
        const entry = competitors.get(domain) ?? { mentionedAnswers: 0, citedAnswers: 0 }
        entry.citedAnswers++
        competitors.set(domain, entry)
      }
    }
  }
  return {
    ...entry,
    types,
    namedInstead: topCounts(named, item => item).map(({ item, answers }) => ({ name: item, answers })),
    citedInstead: topCounts(cited, item => item).map(({ item, answers }) => ({ host: item, answers })),
    competitors: [...competitors].map(([domain, counts]) => ({ domain, ...counts }))
      .sort((left, right) => (right.mentionedAnswers + right.citedAnswers) - (left.mentionedAnswers + left.citedAnswers) || compareText(left.domain, right.domain)),
  }
}

/**
 * The grouped read: one entry per market, or per group of markets (the group a
 * market's own group sits in, else that group). Only markets with a returned
 * row are listed. Ordered by the signal's non-brand share when `sort` is set.
 */
function groupRollups(
  plan: MeasurementPlanV2,
  folded: FoldedSweep,
  query: QueryTrackingResultsQuery,
  engineOrder: readonly string[],
  ownDomains: ReadonlySet<string>,
  compared: boolean,
): QueryTrackingResultGroup[] {
  const focusOf = planQueryFocus(plan)
  const markets = plan.reportingScopes ?? []
  const groups = new Map(plan.groups.map(group => [group.stableKey, group]))
  const ownNameKeys = nameKeys(plan.targets.flatMap(target => [target.label, ...target.aliases, ...(target.identityAliases ?? [])]))
  const marketTargets = new Map(markets.map(market => [market.stableKey, new Set(market.usageEdges.map(edge => edge.targetKey))]))
  const rowsOf = new Map<string, QueryTrackingResultRow[]>()
  const add = (key: string, row: QueryTrackingResultRow) => {
    const list = rowsOf.get(key)
    if (list) list.push(row)
    else rowsOf.set(key, [row])
  }
  for (const row of folded.rows) {
    const focus = focusOf(row.queryId)
    if (focus.kind === 'market') add(focus.key, row)
    else if (focus.kind === 'property') for (const [key, targets] of marketTargets) if (targets.has(focus.key)) add(key, row)
  }
  const metroOf = (market: (typeof markets)[number]) => {
    const own = market.groupKey === undefined ? undefined : groups.get(market.groupKey)
    return own?.parentGroupKey ?? market.groupKey ?? null
  }
  // Under a group, a market is listed only when every one of its locations is in it,
  // never one outside that a shared location's own query reaches.
  const placeTargets = query.scope === 'group' ? new Set(groups.get(query.scopeKey!)?.targetKeys ?? []) : null
  const listed = markets.filter(market => rowsOf.has(market.stableKey)
    && (placeTargets === null || [...marketTargets.get(market.stableKey)!].every(target => placeTargets.has(target))))
  const signal = query.signal ?? 'mentioned'
  let entries: QueryTrackingResultGroup[]
  if (query.group === 'market') {
    entries = listed.map(market => rollup(
      { kind: 'market', key: market.stableKey, label: market.label, parentKey: metroOf(market), locations: marketTargets.get(market.stableKey)?.size ?? 0 },
      rowsOf.get(market.stableKey)!, folded, engineOrder, ownNameKeys, ownDomains, compared,
    ))
  } else {
    const byMetro = new Map<string, { rows: QueryTrackingResultRow[]; marketKeys: string[]; targets: Set<string> }>()
    for (const market of listed) {
      const metro = metroOf(market)
      const own = rowsOf.get(market.stableKey)
      if (metro === null || !own) continue
      const entry = byMetro.get(metro) ?? { rows: [], marketKeys: [], targets: new Set<string>() }
      entry.rows.push(...own)
      entry.marketKeys.push(market.stableKey)
      for (const target of marketTargets.get(market.stableKey) ?? []) entry.targets.add(target)
      byMetro.set(metro, entry)
    }
    entries = [...byMetro].map(([key, entry]) => rollup(
      { kind: 'group', key, label: groups.get(key)?.label ?? key, parentKey: groups.get(key)?.parentGroupKey ?? null, locations: entry.targets.size, marketKeys: sortedUnique(entry.marketKeys) },
      entry.rows, folded, engineOrder, ownNameKeys, ownDomains, compared,
    ))
  }
  const shareOf = (entry: QueryTrackingResultGroup) => {
    const nonBrand = entry.types.find(type => type.queryClass === QUERY_TRACKING_WEAK_MARKET_CLASS)
    return (signal === 'cited' ? nonBrand?.citationCoverage.rate : nonBrand?.mentionCoverage.rate) ?? null
  }
  return entries.sort((left, right) => (
    (query.sort ? compareShares(shareOf(left), shareOf(right), query.sort) : 0) || compareText(left.key, right.key)
  ))
}

/**
 * Narrows, rates and orders a folded read for its request: changes against the
 * previous sweep, the filters (totals then cover the rows returned), and the
 * sort. Rows are mutated only to carry their changes.
 */
function shapeRead(
  folded: FoldedSweep & { pendingRows: number; totals?: QueryTrackingResultTotals[] },
  previous: FoldedSweep | null,
  query: QueryTrackingResultsQuery,
): Pick<QueryTrackingResultsResponse, 'rows' | 'pendingRows' | 'totals'> {
  const signal = query.signal ?? 'mentioned'
  if (previous) markChanges(folded.rows, previous.rows)
  const kept = folded.rows.filter(row => keepRow(row, query, signal))
  const filtered = query.engine !== undefined || query.result !== undefined || query.change !== undefined
  let totals = filtered ? totalsOver(kept, folded) : folded.totals
  if (totals && previous) totals = withComparison(totals, kept, folded, previous)
  return {
    rows: query.sort ? sortRows(kept, signal, query.sort) : kept,
    pendingRows: folded.pendingRows,
    ...(totals ? { totals } : {}),
  }
}

function advancedResults(
  db: DatabaseClient,
  project: ProjectRow,
  active: { version: typeof measurementPlanVersions.$inferSelect; plan: MeasurementPlanV2 },
  query: QueryTrackingResultsQuery,
): Omit<QueryTrackingResultsResponse, 'mode' | 'scope'> {
  const projectId = project.id
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
  const v2Sweeps = (runId: string | undefined) => sweepCandidates(db, projectId, false, runId).flatMap(candidate => {
    const version = candidate.versionId === null ? undefined : versions.get(candidate.versionId)
    return version?.schemaVersion === MEASUREMENT_PLAN_V2_SCHEMA_VERSION ? [{ id: candidate.id, version }] : []
  })
  const candidates = v2Sweeps(query.runId)
  const chosen = query.runId === undefined
    ? defaultSweep(candidates, candidate => candidate.version.id, activeChain)
    : candidates.at(0)
  if (!chosen) {
    if (query.runId !== undefined) throw notASweep(query.runId)
    return {
      run: null,
      engines: [],
      ...foldQueryTrackingResults(null, advancedPairings(active.plan, assignments, null)),
      ...(query.compare ? { compareRun: null } : {}),
      ...(query.group ? { groups: [] } : {}),
    }
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
    const ownNameKeys = nameKeys(sweepPlan.targets.flatMap(target => [target.label, ...target.aliases, ...(target.identityAliases ?? [])]))
    return {
      run: runDto(run, chosen.version.revision, underActivePlan),
      engines: engines(sweep),
      ...foldQueryTrackingResults(sweep, pairings(sweep), undefined, { ownNameKeys, ownDomains: ownDomainsOf(project) }),
    }
  }
  // The grouped read lists who won each market, so it reads the answers' evidence too.
  const withEvidence = query.group !== undefined
  const sweep = materializeAdvancedSweep(db, source, presentation, versions, withEvidence)
  const detail: FoldDetail = { checked: new Map(), withheld: [], candidates: new Map(), ...(withEvidence ? { evidence: new Map() } : {}) }
  const folded = { ...foldQueryTrackingResults(sweep, pairings(sweep), detail), detail, targets: targetIndex(sweep) }
  // The sweep before the one read, on the same plan chain when the read is on the active one.
  let previous: (FoldedSweep & { run: QueryTrackingResultsRun }) | null = null
  if (query.compare === 'previous') {
    const all = query.runId === undefined ? candidates : v2Sweeps(undefined)
    const at = all.findIndex(candidate => candidate.id === chosen.id)
    const older = at < 0 ? [] : all.slice(at + 1)
    const prior = underActivePlan ? older.find(candidate => activeChain.has(candidate.version.id)) : older.at(0)
    if (prior) {
      const priorUnderActive = activeChain.has(prior.version.id)
      const priorPlan = priorUnderActive ? active.plan : storedPlan(db, projectId, prior.version.id)
      const priorRun = sweepRow(db, prior.id)
      const priorSweep = materializeAdvancedSweep(db, { run: priorRun, source: { row: prior.version, plan: priorPlan } }, presentation, versions, false)
      const priorDetail: FoldDetail = { checked: new Map(), withheld: [], candidates: new Map() }
      const priorRows = foldQueryTrackingResults(priorSweep, advancedPairings(active.plan, assignments, { sweep: priorSweep, plan: priorPlan, underActivePlan: priorUnderActive }), priorDetail).rows
      previous = { rows: priorRows, detail: priorDetail, targets: targetIndex(priorSweep), run: runDto(priorRun, prior.version.revision, priorUnderActive) }
    }
  }
  const shaped = shapeRead(folded, previous, query)
  const engineOrder = engines(sweep)
  return {
    run: runDto(run, chosen.version.revision, underActivePlan),
    engines: engineOrder,
    ...shaped,
    // A grouped read is the list of markets; a market's queries are a read of that market.
    ...(query.group ? { rows: [] } : {}),
    // Only the project read holds every market's pairings, so only it lists weak markets.
    ...(query.scope === 'project' ? { weakMarkets: weakMarkets(active.plan, folded.rows, detail) } : {}),
    ...(query.compare ? { compareRun: previous?.run ?? null } : {}),
    ...(query.group ? { groups: groupRollups(active.plan, folded, query, engineOrder, ownDomainsOf(project), previous !== null) } : {}),
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
  if (query.group !== undefined) throw validationError('group is read on an advanced portfolio: a simple project has no markets.')
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
    return {
      run: null,
      engines: [],
      ...foldQueryTrackingResults(null, read(simplePairings(tracked, classOf, null))),
      ...(query.compare && query.queryId === undefined ? { compareRun: null } : {}),
    }
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
  // Tracking matches when nothing the workspace compares changed, the sweep
  // measured every tracked query as it is tracked now, and it asked nothing
  // else. A sweep that cannot be compared never claims a match.
  const trackedPairs = new Set(pairings.map(pairing => `${pairing.queryId}\u0000${pairing.queryClass}`))
  // Every tracked query counts here, also on a read of one.
  const everyQueryMeasured = pairings.every(pairing => pairing.edge !== null)
  const matchesCurrentTracking = comparison?.sameTracking === true && everyQueryMeasured && sweep.definition.edges.every(edge => (
    edge.queryId !== null && trackedPairs.has(`${edge.queryId}\u0000${edge.queryClass}`)
  ))
  if (query.queryId !== undefined) {
    const folded = foldQueryTrackingResults(sweep, read(pairings), undefined, { ownNameKeys: nameKeys(effectiveBrandNames(project)), ownDomains: ownDomainsOf(project) })
    return { run: runDto(run, null, matchesCurrentTracking), engines: engines(sweep), ...folded }
  }
  const detail: FoldDetail = { checked: new Map(), withheld: [], candidates: new Map() }
  const folded = { ...foldQueryTrackingResults(sweep, read(pairings), detail), detail, targets: targetIndex(sweep) }
  // The sweep before the one read that sent the engines what the project sends now.
  let previous: (FoldedSweep & { run: QueryTrackingResultsRun }) | null = null
  if (query.compare === 'previous') {
    const all = sweepCandidates(db, project.id, true, undefined)
    const at = all.findIndex(candidate => candidate.id === chosen.id)
    const older = at < 0 ? [] : all.slice(at + 1)
    const definitions = older.length === 0 ? new Map<string, SimpleMeasurementDefinition>() : frozenSimpleDefinitions(db, project.id, older.map(candidate => candidate.id))
    const prior = older.find(candidate => {
      const frozen = definitions.get(candidate.id)
      return frozen !== undefined && compare(frozen).sameDispatch
    })
    if (prior) {
      const priorDefinition = definitions.get(prior.id)!
      const priorRun = sweepRow(db, prior.id)
      const priorSweep = simpleRunInput(db, project, priorRun, priorDefinition, false)
      const priorDetail: FoldDetail = { checked: new Map(), withheld: [], candidates: new Map() }
      const priorRows = foldQueryTrackingResults(priorSweep, read(simplePairings(tracked, classOf, priorSweep)), priorDetail).rows
      previous = { rows: priorRows, detail: priorDetail, targets: targetIndex(priorSweep), run: runDto(priorRun, null, compare(priorDefinition).sameTracking) }
    }
  }
  return {
    run: runDto(run, null, matchesCurrentTracking),
    engines: engines(sweep),
    ...shapeRead(folded, previous, query),
    ...(query.compare ? { compareRun: previous?.run ?? null } : {}),
  }
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
  return queryTrackingResultsResponseSchema.parse({ mode: 'advanced', scope, ...advancedResults(db, project, { version, plan }, query) })
}

export async function queryTrackingResultsRoutes(app: FastifyInstance, opts: QueryTrackingRoutesOptions) {
  app.get<{ Params: { name: string }; Querystring: Record<string, unknown> }>(
    '/projects/:name/query-tracking/results',
    async request => readQueryTrackingResults(app.db, resolveProject(app.db, request.params.name), request.query, opts),
  )
}
