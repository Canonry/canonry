/**
 * Overview's "What changed": the latest check's lost mentions and lost
 * citations, one per query, and the AI Visibility runs in progress. It rides
 * on `GET /projects/:name/overview` as `whatChanged`, so the dashboard, the
 * CLI and MCP read the same rows.
 *
 * Each portfolio path has its own rule for what an answer is compared with:
 *
 * - Simple compares each answer of the latest sweep with the previous check
 *   of the same tracked query, engine and location: the most recent earlier
 *   answer for that slot, from any non-probe sweep, whatever its status. A
 *   mention is resolved as the project page's evidence rows resolve it
 *   (`resolveSnapshotAnswerMentioned`), so a query counted here is one whose
 *   evidence row reads "Lost since the previous check".
 * - Advanced compares each Property's answer in the sweep the coverage
 *   headline reads with the same slot of the eligible sweep before it, under
 *   the visibility report's continuity rule (same plan definition chain, same
 *   engines and models, neither sweep partial). A Property's mention and
 *   citation come from the frozen report kernel, never the project-level
 *   snapshot columns.
 *
 * Either way a query counts once per signal however many answers lost it, and
 * mentions and citations are counted apart: neither is read from the other.
 * The caller passes runs that already leave probes out.
 */

import { asc, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  CitationStates,
  compareText,
  isWhatChangedActiveRun,
  normalizeQueryText,
  OVERVIEW_WHAT_CHANGED_QUERY_LIMIT,
  RunKinds,
  whatChangedProjectItems,
  type OverviewWhatChangedComparisonDto,
  type OverviewWhatChangedSignalDto,
  type ProjectOverviewWhatChangedDto,
  type QueryClass,
  type VisibilityReportLocationSelection,
} from '@canonry/canonry-contracts'
import { queries, querySnapshots, runs, type DatabaseClient, type projects } from '@canonry/canonry-db'
import { resolveSnapshotAnswerMentioned } from './helpers.js'
import { readQueryClasses } from './query-class-read.js'
import { locationMatches, pairContinuity, type VisibilityReportPreviousRunInput, type VisibilityReportRunInput } from './visibility-report-reader.js'
import type { OverviewAdvancedSweeps } from './visibility-report.js'

type RunRow = typeof runs.$inferSelect
type ProjectRow = typeof projects.$inferSelect
type UnavailableReason = Extract<OverviewWhatChangedComparisonDto, { state: 'unavailable' }>['reason']

/** How many earlier AI Visibility runs a previous check is looked for in, as the project page's timeline reads. */
const PREVIOUS_CHECK_MAX_RUNS = 100
/** Snapshot ids per `IN (...)` list. */
const SNAPSHOT_ID_CHUNK = 500

export interface OverviewWhatChangedInput {
  project: ProjectRow
  /** The overview's runs: no probes, narrowed by its location and since filters, newest first. */
  runs: readonly RunRow[]
  /** Every run of the latest completed or partial AI Visibility sweep; empty before the first. */
  latestSweep: readonly RunRow[]
  /** The Advanced sweeps the coverage read selected; null on a Simple project. */
  advanced: OverviewAdvancedSweeps | null
  /** The coverage read's location selection, which narrows the Advanced answers. */
  location: VisibilityReportLocationSelection
  /** The overview's `since`: an earlier sweep before it is outside the window. */
  since: string | null
}

export function buildOverviewWhatChanged(db: DatabaseClient, input: OverviewWhatChangedInput): ProjectOverviewWhatChangedDto {
  const lost = input.advanced === null
    ? simpleLostSignals(db, input.project, input.latestSweep, input.runs)
    : advancedLostSignals(input.advanced, input.latestSweep, input.location, input.since)
  const activeRuns = input.runs.filter(isWhatChangedActiveRun)
  const lostMentions = signalDto(lost.mentions)
  const lostCitations = signalDto(lost.citations)
  return {
    mode: input.advanced === null ? 'simple' : 'advanced',
    latestCheck: lost.latestCheck,
    comparison: lost.comparison,
    lostMentions,
    lostCitations,
    activeRuns: { count: activeRuns.length, runIds: activeRuns.map(run => run.id) },
    items: whatChangedProjectItems(input.project, {
      lostMentionQueries: lostMentions.queryCount,
      lostCitationQueries: lostCitations.queryCount,
      activeRuns: activeRuns.length,
    }),
  }
}

interface LostSignals {
  latestCheck: ProjectOverviewWhatChangedDto['latestCheck']
  comparison: OverviewWhatChangedComparisonDto
  mentions: Map<string, LostQuery>
  citations: Map<string, LostQuery>
}

/** Every answer of one query that lost a signal, gathered so the query counts once. */
interface LostQuery {
  queryId: string | null
  query: string
  classes: Set<QueryClass | null>
  providers: Set<string>
  locations: Set<string | null>
  properties: Map<string, string>
  markets: Map<string, string>
}

interface LostAnswer {
  /** What makes two answers the same query. */
  queryKey: string
  queryId: string | null
  query: string
  queryClass: QueryClass | null
  provider: string
  location: string | null
  property?: { key: string; label: string }
  markets?: ReadonlyArray<{ key: string; label: string }>
}

function record(lost: Map<string, LostQuery>, answer: LostAnswer): void {
  let entry = lost.get(answer.queryKey)
  if (!entry) {
    entry = {
      queryId: answer.queryId,
      query: answer.query,
      classes: new Set(),
      providers: new Set(),
      locations: new Set(),
      properties: new Map(),
      markets: new Map(),
    }
    lost.set(answer.queryKey, entry)
  }
  entry.classes.add(answer.queryClass)
  entry.providers.add(answer.provider)
  entry.locations.add(answer.location)
  if (answer.property) entry.properties.set(answer.property.key, answer.property.label)
  for (const market of answer.markets ?? []) entry.markets.set(market.key, market.label)
}

function unavailable(reason: UnavailableReason): OverviewWhatChangedComparisonDto {
  return { state: 'unavailable', reason }
}

function nothingLost(latestCheck: LostSignals['latestCheck'], comparison: OverviewWhatChangedComparisonDto): LostSignals {
  return { latestCheck, comparison, mentions: new Map(), citations: new Map() }
}

function sweepCheck(sweep: readonly RunRow[]): LostSignals['latestCheck'] {
  const first = sweep.at(0)
  return first === undefined ? null : { runIds: sweep.map(run => run.id), createdAt: first.createdAt }
}

const SNAPSHOT_SIGNAL_COLUMNS = {
  id: querySnapshots.id,
  runId: querySnapshots.runId,
  queryId: querySnapshots.queryId,
  queryText: querySnapshots.queryText,
  provider: querySnapshots.provider,
  location: querySnapshots.location,
  citationState: querySnapshots.citationState,
  answerMentioned: querySnapshots.answerMentioned,
  answerText: querySnapshots.answerText,
  mentionIdentity: querySnapshots.mentionIdentity,
}

function slotKey(queryId: string, provider: string, location: string | null): string {
  return `${queryId}\u0000${provider}\u0000${location ?? ''}`
}

/** An earlier answer, with what picks the newest one per slot. */
interface EarlierAnswer {
  id: string
  runId: string
  queryId: string | null
  queryText: string | null
  provider: string
  location: string | null
  createdAt: string
}

/**
 * The newest answer in these runs for each stored slot identity: the query
 * id (its text when the id is gone), the engine and the location. One query
 * however many runs or slots there are, ranked as `compareRecency` ranks.
 */
function newestEarlierAnswers(db: DatabaseClient, runIds: readonly string[]): EarlierAnswer[] {
  if (runIds.length === 0) return []
  return db.all<EarlierAnswer>(sql`
    SELECT "id", "runId", "queryId", "queryText", "provider", "location", "createdAt" FROM (
      SELECT ${querySnapshots.id} AS "id", ${querySnapshots.runId} AS "runId", ${querySnapshots.queryId} AS "queryId",
        ${querySnapshots.queryText} AS "queryText", ${querySnapshots.provider} AS "provider",
        ${querySnapshots.location} AS "location", ${querySnapshots.createdAt} AS "createdAt",
        ROW_NUMBER() OVER (
          PARTITION BY
            CASE WHEN ${querySnapshots.queryId} IS NULL THEN 'text:' || COALESCE(${querySnapshots.queryText}, '') ELSE 'id:' || ${querySnapshots.queryId} END,
            ${querySnapshots.provider},
            COALESCE(${querySnapshots.location}, '')
          ORDER BY ${runs.createdAt} DESC, ${runs.id} DESC, ${querySnapshots.createdAt} DESC, ${querySnapshots.id} ASC
        ) AS "slotRank"
      FROM ${querySnapshots}
      INNER JOIN ${runs} ON ${runs.id} = ${querySnapshots.runId}
      WHERE ${inArray(querySnapshots.runId, [...runIds])}
    )
    WHERE "slotRank" = 1`)
}

/** Negative when `left` is the more recent answer: the newer run, then the newer answer, then the lower id. */
function compareRecency(left: EarlierAnswer, right: EarlierAnswer, runOrder: ReadonlyMap<string, number>): number {
  return (runOrder.get(left.runId) ?? 0) - (runOrder.get(right.runId) ?? 0)
    || compareText(right.createdAt, left.createdAt)
    || compareText(left.id, right.id)
}

function simpleLostSignals(
  db: DatabaseClient,
  project: ProjectRow,
  latestSweep: readonly RunRow[],
  overviewRuns: readonly RunRow[],
): LostSignals {
  const latestCheck = sweepCheck(latestSweep)
  if (latestCheck === null) return nothingLost(null, unavailable('not-measured'))

  const tracked = db.select({ id: queries.id, query: queries.query })
    .from(queries)
    .where(eq(queries.projectId, project.id))
    .all()
  const trackedById = new Map(tracked.map(query => [query.id, query]))
  const trackedByText = new Map(tracked.map(query => [normalizeQueryText(query.query), query]))
  // A deleted query's answers keep its text, and a query re-added under a new
  // id still owns them. An answer of a query no longer tracked has no
  // evidence row to lose anything in.
  const trackedQuery = (snapshot: { queryId: string | null; queryText: string | null }) => {
    const byId = snapshot.queryId === null ? undefined : trackedById.get(snapshot.queryId)
    return byId ?? (snapshot.queryText ? trackedByText.get(normalizeQueryText(snapshot.queryText)) : undefined)
  }

  // A slot answered twice in one sweep (a retried request) is its newest
  // answer, as on the previous side, so which one counts never depends on
  // the order rows come back in.
  const current = new Map<string, { query: typeof tracked[number]; snapshot: SignalRow }>()
  for (const snapshot of db.select(SNAPSHOT_SIGNAL_COLUMNS).from(querySnapshots)
    .where(inArray(querySnapshots.runId, latestCheck.runIds))
    .orderBy(desc(querySnapshots.createdAt), asc(querySnapshots.id))
    .all()) {
    const query = trackedQuery(snapshot)
    if (query === undefined) continue
    const key = slotKey(query.id, snapshot.provider, snapshot.location)
    if (!current.has(key)) current.set(key, { query, snapshot })
  }

  // Each answer's previous check is the newest earlier answer for its slot,
  // whatever the run's status, read in one query over a bounded window. A
  // slot with no earlier answer (a new query, engine or location) is new,
  // not a change, and costs no further read.
  const earlier = overviewRuns
    .filter(run => run.kind === RunKinds['answer-visibility'] && run.createdAt < latestCheck.createdAt)
    .slice(0, PREVIOUS_CHECK_MAX_RUNS)
  const runOrder = new Map(earlier.map((run, index) => [run.id, index]))
  const previousIdBySlot = new Map<string, EarlierAnswer>()
  for (const answer of newestEarlierAnswers(db, earlier.map(run => run.id))) {
    const query = trackedQuery(answer)
    if (query === undefined) continue
    const key = slotKey(query.id, answer.provider, answer.location)
    if (!current.has(key)) continue
    // A query's answers can be stored under its id and, from before a
    // re-add, under its text alone: the newer of the two is its previous check.
    const chosen = previousIdBySlot.get(key)
    if (chosen === undefined || compareRecency(answer, chosen, runOrder) < 0) previousIdBySlot.set(key, answer)
  }

  const previousById = new Map<string, SignalRow>()
  const previousIds = [...previousIdBySlot.values()].map(previous => previous.id)
  for (let start = 0; start < previousIds.length; start += SNAPSHOT_ID_CHUNK) {
    for (const row of db.select(SNAPSHOT_SIGNAL_COLUMNS).from(querySnapshots)
      .where(inArray(querySnapshots.id, previousIds.slice(start, start + SNAPSHOT_ID_CHUNK))).all()) {
      previousById.set(row.id, row)
    }
  }

  const classes = readQueryClasses(db, project, tracked)
  const mentioned = (snapshot: SignalRow) => resolveSnapshotAnswerMentioned(snapshot, project)
  const mentions = new Map<string, LostQuery>()
  const citations = new Map<string, LostQuery>()
  for (const [key, { query, snapshot }] of current) {
    const chosen = previousIdBySlot.get(key)
    const previous = chosen === undefined ? undefined : previousById.get(chosen.id)
    if (previous === undefined) continue
    const answer: LostAnswer = {
      queryKey: query.id,
      queryId: query.id,
      query: query.query,
      queryClass: classes.get(query.id) ?? null,
      provider: snapshot.provider,
      location: snapshot.location,
    }
    if (mentioned(previous) && !mentioned(snapshot)) record(mentions, answer)
    if (previous.citationState === CitationStates.cited && snapshot.citationState !== CitationStates.cited) record(citations, answer)
  }

  const previousRunIds = [...new Set([...previousIdBySlot.values()].map(previous => previous.runId))]
    .sort((left, right) => (runOrder.get(left) ?? 0) - (runOrder.get(right) ?? 0))
  const comparison: OverviewWhatChangedComparisonDto = previousRunIds.length === 0
    ? unavailable('no-previous-check')
    : { state: 'available', previousRunIds }
  return { latestCheck, comparison, mentions, citations }
}

type SignalRow = {
  [K in keyof typeof SNAPSHOT_SIGNAL_COLUMNS]: typeof querySnapshots.$inferSelect[K]
}

type AdvancedBasis =
  | { state: 'available'; previous: VisibilityReportRunInput }
  | { state: 'unavailable'; reason: UnavailableReason }

/** The visibility report's run-level comparison rules, in its order, plus the overview's window. */
function advancedBasis(
  current: VisibilityReportRunInput,
  previous: VisibilityReportPreviousRunInput | null,
  since: string | null,
): AdvancedBasis {
  if (previous === null) return { state: 'unavailable', reason: 'no-previous-check' }
  if ('unreadable' in previous) return { state: 'unavailable', reason: 'unreadable' }
  // A schema v1 predecessor has no frozen v2 definition to compare with.
  if ('incomparable' in previous) return { state: 'unavailable', reason: 'definition-changed' }
  if (since !== null && previous.run.createdAt < since) return { state: 'unavailable', reason: 'no-previous-check' }
  switch (pairContinuity(previous.run, current)) {
    case 'comparable':
      break
    case 'model-changed':
      return { state: 'unavailable', reason: 'model-changed' }
    case 'definition-changed':
    case 'legacy-unknown':
      return { state: 'unavailable', reason: 'definition-changed' }
  }
  if (current.state === 'partial' || previous.run.state === 'partial') return { state: 'unavailable', reason: 'partial-run' }
  return { state: 'available', previous: previous.run }
}

function advancedLostSignals(
  advanced: OverviewAdvancedSweeps,
  latestSweep: readonly RunRow[],
  location: VisibilityReportLocationSelection,
  since: string | null,
): LostSignals {
  if (advanced.plan === 'legacy') {
    const latestCheck = sweepCheck(latestSweep)
    return nothingLost(latestCheck, unavailable(latestCheck === null ? 'not-measured' : 'legacy-plan'))
  }
  const { current } = advanced
  if (current === null) return nothingLost(null, unavailable('not-measured'))
  const latestCheck = { runIds: [current.id], createdAt: current.createdAt }
  const basis = advancedBasis(current, advanced.previous, since)
  if (basis.state === 'unavailable') return nothingLost(latestCheck, unavailable(basis.reason))

  const { definition } = current
  const targets = new Map(definition.targets.map(target => [target.id, target]))
  const marketLabels = new Map(definition.scopeOptions
    .filter(option => option.kind === 'market')
    .map(option => [option.id, option.label]))
  const edgesByExecution = new Map<string, Array<typeof definition.edges[number]>>()
  for (const edge of definition.edges) {
    const edges = edgesByExecution.get(edge.executionId)
    if (edges) edges.push(edge)
    else edgesByExecution.set(edge.executionId, [edge])
  }
  const currentBySlot = new Map(current.observations.map(observation => [observation.slotId, observation]))
  const previousBySlot = new Map(basis.previous.observations.map(observation => [observation.slotId, observation]))

  const mentions = new Map<string, LostQuery>()
  const citations = new Map<string, LostQuery>()
  for (const slot of definition.slots) {
    if (!locationMatches(slot.location, location)) continue
    const now = currentBySlot.get(slot.id)
    const before = previousBySlot.get(slot.id)
    // A slot either sweep did not answer has nothing to compare.
    if (now === undefined || before === undefined) continue
    for (const edge of edgesByExecution.get(slot.executionId) ?? []) {
      const target = targets.get(edge.targetKey)
      if (target === undefined) continue
      const answer: LostAnswer = {
        queryKey: slot.queryId ?? `text:${slot.query}`,
        queryId: slot.queryId,
        query: slot.query,
        queryClass: edge.queryClass === 'unknown' ? null : edge.queryClass,
        provider: slot.provider,
        location: slot.location,
        property: { key: target.id, label: target.label },
        markets: edge.marketKeys.map(key => ({ key, label: marketLabels.get(key) ?? key })),
      }
      // An unknown mention (no answer text, or the Property's identity
      // unresolved) is not a lost one, and an aliasless Property has none.
      if (target.mentionEligible
        && before.mentionedTargetKeys.includes(target.id)
        && now.mentionComplete !== false
        && !now.mentionedTargetKeys.includes(target.id)
        && !(now.unknownMentionTargetKeys ?? []).includes(target.id)) {
        record(mentions, answer)
      }
      // A citation read from an incomplete source capture is unknown either way.
      if (before.citationComplete && before.citedTargetKeys.includes(target.id)
        && now.citationComplete && !now.citedTargetKeys.includes(target.id)) {
        record(citations, answer)
      }
    }
  }
  return { latestCheck, comparison: { state: 'available', previousRunIds: [basis.previous.id] }, mentions, citations }
}

function compareNullableText(left: string | null, right: string | null): number {
  if (left === right) return 0
  if (left === null) return -1
  if (right === null) return 1
  return compareText(left, right)
}

function keyedLabels(values: ReadonlyMap<string, string>): Array<{ key: string; label: string }> {
  return [...values]
    .map(([key, label]) => ({ key, label }))
    .sort((left, right) => compareText(left.label, right.label) || compareText(left.key, right.key))
}

function signalDto(lost: ReadonlyMap<string, LostQuery>): OverviewWhatChangedSignalDto {
  const rows = [...lost.values()]
    .sort((left, right) => compareText(left.query, right.query) || compareNullableText(left.queryId, right.queryId))
  return {
    queryCount: rows.length,
    queries: rows.slice(0, OVERVIEW_WHAT_CHANGED_QUERY_LIMIT).map(row => ({
      queryId: row.queryId,
      query: row.query,
      // Answers assigned under both classes leave the query with no single class.
      queryClass: row.classes.size === 1 ? ([...row.classes][0] ?? null) : null,
      providers: [...row.providers].sort(compareText),
      locations: [...row.locations].sort(compareNullableText),
      properties: keyedLabels(row.properties),
      markets: keyedLabels(row.markets),
    })),
    truncated: rows.length > OVERVIEW_WHAT_CHANGED_QUERY_LIMIT,
  }
}
