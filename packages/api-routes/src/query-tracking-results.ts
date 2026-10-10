/**
 * Mentioned and Cited per tracked query and engine, in one stored-evidence read.
 *
 * The visibility report pages its query rows and rebuilds the trend on every
 * page. This read rebuilds one sweep: it lists sweeps without their manifests,
 * parses the active plan and at most the chosen sweep's own revision, and
 * reads that sweep's snapshots once. It never calls a provider and never writes.
 */

import { and, desc, eq, isNull } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  MEASUREMENT_PLAN_V2_SCHEMA_VERSION,
  VisibilityReportScopeErrorReasons,
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
  type QueryTrackingEngineResult,
  type QueryTrackingResultRow,
  type QueryTrackingResultsQuery,
  type QueryTrackingResultsResponse,
  type QueryTrackingResultsRun,
  type VisibilityReportPopulationClass,
} from '@ainyc/canonry-contracts'
import { measurementPlanVersions, projects, queries, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { resolveProject } from './helpers.js'
import { activeMeasurementPlan } from './measurement-overview.js'
import {
  targetValues,
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
 * this fold.
 */
export function foldQueryTrackingResults(
  sweep: VisibilityReportRunInput | null,
  pairings: readonly TrackedPairing[],
): Pick<QueryTrackingResultsResponse, 'rows' | 'pendingRows'> {
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
  let pendingRows = 0
  for (const pair of pairs.values()) {
    if (pair.edges === null) {
      pendingRows++
      continue
    }
    const tallies = new Map<string, EngineTally>()
    for (const [executionId, edges] of pair.edges) {
      const expected = slots.get(executionId)
      if (!expected || expected.length === 0) throw new Error(`Frozen usage edge ${edges[0]!.id} has no execution slot`)
      for (const slot of expected) {
        let tally = tallies.get(slot.provider)
        if (!tally) {
          tally = { expectedAnswers: 0, answers: 0, mentionedAnswers: 0, citedAnswers: 0, uncheckedSourceAnswers: 0, mentionUnknown: false, citationUnknown: false }
          tallies.set(slot.provider, tally)
        }
        const observation = observations.get(slot.id) ?? null
        const values = targetValues({ run: sweep, slot, edges, observation }, targets)
        tally.expectedAnswers++
        if (observation !== null) tally.answers++
        if (values.mention === true) tally.mentionedAnswers++
        else if (values.mention === null) tally.mentionUnknown = true
        // An answer whose sources were only partly saved is not checked, even
        // when a saved link cites the location: the report leaves it out of
        // both sides of its citation rate, and so does this count.
        if (observation !== null && !observation.citationComplete) {
          tally.uncheckedSourceAnswers++
          tally.citationUnknown = true
        } else if (values.citation === true) tally.citedAnswers++
        else if (values.citation === null) tally.citationUnknown = true
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
      }))
    rows.push({ queryId: pair.queryId, queryText: pair.queryText, queryClass: pair.queryClass, engines })
  }
  rows.sort((left, right) => compareText(left.queryId, right.queryId) || compareText(left.queryClass, right.queryClass))
  return { rows, pendingRows }
}

const PLACE_WORDS = { group: 'Group', market: 'Market', property: 'Location' } as const

function placeNotTracked(scope: 'group' | 'market' | 'property', key: string) {
  return validationError(`${PLACE_WORDS[scope]} "${key}" is not in the active tracking plan.`, {
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
 * An older sweep that stored no query text has only the id to go by.
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

/** Whole-project sweeps, newest first, without their stored slot lists. */
function sweepCandidates(db: DatabaseClient, projectId: string, planless: boolean, runId: string | undefined) {
  return db.select({ id: runs.id, versionId: runs.measurementPlanVersionId }).from(runs).where(and(
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

function advancedResults(
  db: DatabaseClient,
  projectId: string,
  active: { version: typeof measurementPlanVersions.$inferSelect; plan: MeasurementPlanV2 },
  query: QueryTrackingResultsQuery,
): Omit<QueryTrackingResultsResponse, 'mode' | 'scope'> {
  // Refuse an unknown place before any sweep is read.
  const assignments = placeAssignments(active.plan, query)
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
  const sweep = materializeAdvancedSweep(
    db,
    { run, source: { row: chosen.version, plan: sweepPlan } },
    { version: active.version, plan: active.plan, comparableIds: activeChain },
    versions,
    false,
  )
  return {
    run: runDto(run, chosen.version.revision, underActivePlan),
    engines: engines(sweep),
    ...foldQueryTrackingResults(sweep, advancedPairings(active.plan, assignments, { sweep, plan: sweepPlan, underActivePlan })),
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
): Omit<QueryTrackingResultsResponse, 'mode' | 'scope'> {
  if (query.scope !== 'project') {
    throw validationError(`${PLACE_WORDS[query.scope]} "${query.scopeKey}" does not exist: a simple project is read as a whole.`)
  }
  const tracked = db.select({ id: queries.id, query: queries.query }).from(queries).where(eq(queries.projectId, project.id)).all()
  // The workspace row's class: no usable brand name leaves it unset, never non-brand.
  const classifier = compileQueryClassifier(effectiveBrandNames(project))
  const classOf = (queryText: string): VisibilityReportPopulationClass => classifier?.classify(queryText) ?? 'unknown'
  const chosen = sweepCandidates(db, project.id, true, query.runId).at(0)
  if (!chosen) {
    if (query.runId !== undefined) throw notASweep(query.runId)
    return { run: null, engines: [], ...foldQueryTrackingResults(null, simplePairings(tracked, classOf, null)) }
  }
  const run = sweepRow(db, chosen.id)
  const sweep = simpleRunInput(db, project, run, frozenSimpleDefinitions(db, project.id, [run.id]).get(run.id), false)
  const pairings = simplePairings(tracked, classOf, sweep)
  const folded = foldQueryTrackingResults(sweep, pairings)
  // A simple basket has no revision. Tracking matches when the sweep measured
  // every tracked query as it is tracked now, and asked nothing else.
  const trackedPairs = new Set(pairings.map(pairing => `${pairing.queryId}\u0000${pairing.queryClass}`))
  const matchesCurrentTracking = folded.pendingRows === 0 && sweep.definition.edges.every(edge => (
    edge.queryId !== null && trackedPairs.has(`${edge.queryId}\u0000${edge.queryClass}`)
  ))
  return { run: runDto(run, null, matchesCurrentTracking), engines: engines(sweep), ...folded }
}

/** Shared stored-evidence reader. Callers enforce authorization before resolving the project. */
export function readQueryTrackingResults(
  db: DatabaseClient,
  project: ProjectRow,
  rawQuery: Record<string, unknown>,
): QueryTrackingResultsResponse {
  const query = parseQuery(rawQuery)
  const scope = { kind: query.scope, key: query.scopeKey ?? null }
  const active = activeMeasurementPlan(db, project.id)
  if (active === null) {
    return queryTrackingResultsResponseSchema.parse({ mode: 'simple', scope, ...simpleResults(db, project, query) })
  }
  const { version, plan } = active
  if (plan.schemaVersion !== MEASUREMENT_PLAN_V2_SCHEMA_VERSION) {
    throw validationError('Query tracking requires a schema-v2 measurement plan. Republish setup before reading query results.')
  }
  return queryTrackingResultsResponseSchema.parse({ mode: 'advanced', scope, ...advancedResults(db, project.id, { version, plan }, query) })
}

export async function queryTrackingResultsRoutes(app: FastifyInstance) {
  app.get<{ Params: { name: string }; Querystring: Record<string, unknown> }>(
    '/projects/:name/query-tracking/results',
    async request => readQueryTrackingResults(app.db, resolveProject(app.db, request.params.name), request.query),
  )
}
