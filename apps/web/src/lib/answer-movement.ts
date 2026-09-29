import { normalizeQueryText, type QueryClass } from '@ainyc/canonry-contracts'
import type {
  CitationInsightVm,
  MetricTone,
  MovementComparisonVm,
  MovementSummaryVm,
  RunHistoryPoint,
} from '../view-models.js'

/**
 * The Visibility card's numbers, computed from data the page already loads.
 *
 * Two levels, never mixed:
 *  - QUERY level (the grid and its status word): a query counts once if any
 *    engine mentions or cites you. Movement comes from the server's
 *    `mentionMovement` / `citationMovement` query lists, split by class here.
 *  - ANSWER level (Details): one engine's answer to one query, read from each
 *    evidence row's `runHistory` at the latest and previous sweeps.
 *
 * Branded and non-brand never share a row or an answer count. A project whose
 * brand identity cannot classify queries gets one `unclassified` row instead.
 * Tested in `apps/web/test/answer-movement.test.ts`.
 */

export type VisibilityRowKey = QueryClass | 'unclassified'

export const VISIBILITY_ROW_ORDER: readonly VisibilityRowKey[] = ['non-brand', 'branded', 'unclassified']

export const VISIBILITY_ROW_LABEL: Record<VisibilityRowKey, string> = {
  'non-brand': 'Non-brand',
  branded: 'Branded',
  unclassified: 'Unclassified',
}

/** Resolves a query's class; `null` when the project cannot classify it. */
export type QueryClassLookup = (queryText: string) => QueryClass | null

/** Query-level gains and losses for one signal. `null` when they cannot be placed in a row. */
export interface SignalMove {
  gained: number
  lost: number
}

export type VisibilityRowStatus =
  | { kind: 'first-sweep' }
  | { kind: 'not-compared' }
  | { kind: 'no-change' }
  | { kind: 'up'; count: number }
  | { kind: 'down'; count: number }
  | { kind: 'changed' }

export interface VisibilityRow {
  key: VisibilityRowKey
  /** Queries answered in the latest sweep. */
  total: number
  mentioned: number
  cited: number
  /** Latest-sweep queries that were not in the previous sweep. */
  added: number
  /** Latest-sweep queries that were also in the previous sweep. */
  comparable: number
  mention: SignalMove | null
  citation: SignalMove | null
  status: VisibilityRowStatus
}

export interface VisibilityRowsInput {
  evidence: readonly CitationInsightVm[]
  mentionMovement: MovementSummaryVm
  citationMovement: MovementSummaryVm
  comparison: MovementComparisonVm
  classify: QueryClassLookup
}

/**
 * A row only exists for a class with queries in the latest sweep. Evidence rows
 * without `sourceRunId` are history-only (the engine's latest call errored) and
 * say nothing about the latest sweep.
 */
export function buildVisibilityRows(input: VisibilityRowsInput): VisibilityRow[] {
  const { evidence, comparison, classify } = input
  const queries = new Map<string, { text: string; key: VisibilityRowKey; mentioned: boolean; cited: boolean }>()
  for (const row of evidence) {
    if (!row.sourceRunId) continue
    const id = normalizeQueryText(row.query)
    const entry = queries.get(id) ?? { text: row.query, key: rowKey(classify(row.query)), mentioned: false, cited: false }
    if (row.answerMentioned === true) entry.mentioned = true
    if (row.citationState === 'cited' || row.citationState === 'emerging') entry.cited = true
    queries.set(id, entry)
  }

  const added = new Set(comparison.addedQueries.map(normalizeQueryText))
  const removedByKey = countByKey(comparison.removedQueries, classify)
  const keys = VISIBILITY_ROW_ORDER.filter(key => [...queries.values()].some(entry => entry.key === key))
  const mentionByKey = splitMovement(input.mentionMovement, classify, keys)
  const citationByKey = splitMovement(input.citationMovement, classify, keys)

  return keys.map(key => {
    const entries = [...queries.entries()].filter(([, entry]) => entry.key === key)
    const addedCount = entries.filter(([id]) => added.has(id)).length
    const comparable = entries.length - addedCount
    const mention = mentionByKey?.get(key) ?? null
    const citation = citationByKey?.get(key) ?? null
    const hadQueries = comparable + (removedByKey.get(key) ?? 0) > 0
    return {
      key,
      total: entries.length,
      mentioned: entries.filter(([, entry]) => entry.mentioned).length,
      cited: entries.filter(([, entry]) => entry.cited).length,
      added: addedCount,
      comparable,
      mention,
      citation,
      status: !comparison.hasPreviousRun || !hadQueries
        ? { kind: 'first-sweep' }
        : comparable === 0
          ? { kind: 'not-compared' }
          : rowStatus(mention, citation),
    }
  })
}

/**
 * Splits the server's query-level movement by row. When a gained or lost query
 * has no text (an unresolvable historical query), the split is unknown and
 * every row reads `null`, unless there is only one row to put it in.
 */
function splitMovement(
  summary: MovementSummaryVm,
  classify: QueryClassLookup,
  keys: readonly VisibilityRowKey[],
): Map<VisibilityRowKey, SignalMove> | null {
  const gainedQueries = summary.gainedQueries ?? []
  const lostQueries = summary.lostQueries ?? []
  if (gainedQueries.length !== summary.gained || lostQueries.length !== summary.lost) {
    return keys.length === 1 ? new Map([[keys[0]!, { gained: summary.gained, lost: summary.lost }]]) : null
  }
  const gained = countByKey(gainedQueries, classify)
  const lost = countByKey(lostQueries, classify)
  return new Map(keys.map(key => [key, { gained: gained.get(key) ?? 0, lost: lost.get(key) ?? 0 }]))
}

type SignalDirection = { dir: 'none' } | { dir: 'up' | 'down'; count: number } | { dir: 'mixed' }

function direction(move: SignalMove): SignalDirection {
  if (move.gained > 0 && move.lost > 0) return { dir: 'mixed' }
  if (move.gained > 0) return { dir: 'up', count: move.gained }
  if (move.lost > 0) return { dir: 'down', count: move.lost }
  return { dir: 'none' }
}

/**
 * `up n` / `down n` when both signals moved n the same way, or one moved n and
 * the other held. Anything else is `changed`, split in Details.
 */
export function rowStatus(mention: SignalMove | null, citation: SignalMove | null): VisibilityRowStatus {
  if (!mention || !citation) return { kind: 'changed' }
  const m = direction(mention)
  const c = direction(citation)
  if (m.dir === 'mixed' || c.dir === 'mixed') return { kind: 'changed' }
  if (m.dir === 'none') return c.dir === 'none' ? { kind: 'no-change' } : { kind: c.dir, count: c.count }
  if (c.dir === 'none') return { kind: m.dir, count: m.count }
  if (m.dir === c.dir && m.count === c.count) return { kind: m.dir, count: m.count }
  return { kind: 'changed' }
}

/** The row's status word, with "· n added" when a compared row also gained queries. */
export function visibilityStatusLabel(row: Pick<VisibilityRow, 'status' | 'added'>): { word: string; suffix: string | null } {
  const word = (() => {
    switch (row.status.kind) {
      case 'first-sweep': return 'first AI sweep'
      case 'not-compared': return 'not compared'
      case 'no-change': return 'no change'
      case 'up': return `up ${row.status.count}`
      case 'down': return `down ${row.status.count}`
      case 'changed': return 'changed'
    }
  })()
  const suffix = row.status.kind !== 'first-sweep' && row.added > 0 ? `· ${row.added} added` : null
  return { word, suffix }
}

/** One signal's query movement in words, for the `changed` split in Details. */
export function signalMovePhrase(move: SignalMove): string {
  if (move.gained > 0 && move.lost > 0) return `up ${move.gained} and down ${move.lost}`
  if (move.gained > 0) return `up ${move.gained}`
  if (move.lost > 0) return `down ${move.lost}`
  return 'no change'
}

/**
 * Tone for a non-brand count: 70% and up positive, the server's top coverage
 * band (`scoreTone`, packages/intelligence/src/score-tones.ts), anything less
 * caution. Never negative, as the approved Visibility and By engine cards draw
 * it: a count says how many queries, and red stays for a loss.
 */
export function coverageTone(count: number, total: number): MetricTone {
  if (total <= 0) return 'neutral'
  return (count / total) * 100 >= 70 ? 'positive' : 'caution'
}

export interface AnswerCounts {
  /** Answers observed in both sweeps with a mention result in each. */
  total: number
  mentionedNow: number
  mentionedBefore: number
  citedNow: number
  citedBefore: number
}

export type AnswerSignalChange = 'gained' | 'lost' | null

export interface AnswerChange {
  provider: string
  location: string | null
  query: string
  mention: AnswerSignalChange
  citation: AnswerSignalChange
}

export interface AnswerMovement {
  byRow: Map<VisibilityRowKey, AnswerCounts>
  changes: AnswerChange[]
}

export interface AnswerMovementInput {
  evidence: readonly CitationInsightVm[]
  previousRunAt: string | null
  addedQueries: readonly string[]
  classify: QueryClassLookup
}

/**
 * Answer-level movement between the previous sweep and the latest one, over
 * queries in both sweeps.
 *
 * An answer counts only when the engine answered in BOTH sweeps and both
 * answers carry a mention result. A call that errored leaves no row (or a
 * history-only row with no latest point), and no row is not a "no": counting
 * it would turn a failed call into a gain or a loss (the observation rule in
 * packages/intelligence/src/provider-pickups.ts). Such an answer is left out of
 * the before and after counts alike.
 */
export function buildAnswerMovement(input: AnswerMovementInput): AnswerMovement {
  const byRow = new Map<VisibilityRowKey, AnswerCounts>()
  const changes: AnswerChange[] = []
  if (!input.previousRunAt) return { byRow, changes }
  const added = new Set(input.addedQueries.map(normalizeQueryText))

  for (const row of input.evidence) {
    // A query-scoped history pools every engine; it cannot speak for one answer.
    if (!row.sourceRunId || row.historyScope === 'query' || added.has(normalizeQueryText(row.query))) continue
    const current = onlyPoint(row.runHistory, point => point.runId === row.sourceRunId)
    const previous = onlyPoint(row.runHistory, point => sameInstant(point.createdAt, input.previousRunAt!))
    if (!current || !previous) continue
    if (typeof current.answerMentioned !== 'boolean' || typeof previous.answerMentioned !== 'boolean') continue

    const key = rowKey(input.classify(row.query))
    const counts = byRow.get(key) ?? { total: 0, mentionedNow: 0, mentionedBefore: 0, citedNow: 0, citedBefore: 0 }
    const citedNow = current.citationState === 'cited'
    const citedBefore = previous.citationState === 'cited'
    counts.total += 1
    if (current.answerMentioned) counts.mentionedNow += 1
    if (previous.answerMentioned) counts.mentionedBefore += 1
    if (citedNow) counts.citedNow += 1
    if (citedBefore) counts.citedBefore += 1
    byRow.set(key, counts)

    const mention = signalChange(previous.answerMentioned, current.answerMentioned)
    const citation = signalChange(citedBefore, citedNow)
    if (mention || citation) {
      changes.push({ provider: row.provider, location: row.location, query: row.query, mention, citation })
    }
  }
  return { byRow, changes }
}

/** What one engine now does differently for a query, in words ("now mentions and cites you"). */
export function answerChangePhrase(change: Pick<AnswerChange, 'mention' | 'citation'>): string {
  const { mention, citation } = change
  if (mention === 'gained' && citation === 'gained') return 'now mentions and cites you'
  if (mention === 'lost' && citation === 'lost') return 'no longer mentions or cites you'
  if (mention === 'gained' && citation === 'lost') return 'now mentions but no longer cites you'
  if (mention === 'lost' && citation === 'gained') return 'now cites but no longer mentions you'
  if (mention === 'gained') return 'now mentions you'
  if (mention === 'lost') return 'no longer mentions you'
  if (citation === 'gained') return 'now cites you'
  return 'no longer cites you'
}

export interface AnswerChangeGroup {
  provider: string
  location: string | null
  phrase: string
  queries: string[]
}

/**
 * One line per engine and kind of change, naming its queries. A location is
 * kept only when the changes span more than one, so a single-location project
 * reads "Perplexity: ..." rather than "Perplexity (nyc): ...".
 */
export function groupAnswerChanges(changes: readonly AnswerChange[]): AnswerChangeGroup[] {
  const showLocation = new Set(changes.map(change => change.location ?? '')).size > 1
  const groups = new Map<string, AnswerChangeGroup>()
  for (const change of changes) {
    const location = showLocation ? change.location : null
    const phrase = answerChangePhrase(change)
    const id = JSON.stringify([change.provider, location, phrase])
    const group = groups.get(id) ?? { provider: change.provider, location, phrase, queries: [] }
    if (!group.queries.includes(change.query)) group.queries.push(change.query)
    groups.set(id, group)
  }
  return [...groups.values()]
    .map(group => ({ ...group, queries: [...group.queries].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.provider.localeCompare(b.provider)
      || (a.location ?? '').localeCompare(b.location ?? '')
      || a.phrase.localeCompare(b.phrase))
}

function signalChange(before: boolean, now: boolean): AnswerSignalChange {
  if (before === now) return null
  return now ? 'gained' : 'lost'
}

/** The one point matching `predicate`; two matches are ambiguous, so neither counts. */
function onlyPoint(points: readonly RunHistoryPoint[], predicate: (point: RunHistoryPoint) => boolean): RunHistoryPoint | null {
  const matches = points.filter(predicate)
  return matches.length === 1 ? matches[0]! : null
}

function sameInstant(a: string, b: string): boolean {
  const left = Date.parse(a)
  return Number.isFinite(left) && left === Date.parse(b)
}

function rowKey(queryClass: QueryClass | null): VisibilityRowKey {
  return queryClass ?? 'unclassified'
}

function countByKey(texts: readonly string[], classify: QueryClassLookup): Map<VisibilityRowKey, number> {
  const counts = new Map<VisibilityRowKey, number>()
  for (const text of texts) {
    const key = rowKey(classify(text))
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}
