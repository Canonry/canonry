import { eq } from 'drizzle-orm'
import type { DatabaseClient } from '@canonry/canonry-db'
import { queries, querySnapshots } from '@canonry/canonry-db'
import {
  readCitationState,
  summarizeObservedQueryCounts,
  summarizeObservedQueryCountsByClass,
  type CitationState,
  type ObservedQueryCounts,
  type RunQueryCountsByClass,
} from '@canonry/canonry-contracts'
import { resolveSnapshotAnswerMentioned, type SnapshotVisibilityProject } from './helpers.js'
import { readQueryClasses } from './query-class-read.js'

/** One stored answer of a run, read the way the run detail reads it. */
export interface RunAnswerSignal {
  queryId: string | null
  /** The tracked query's text, from the query row; null once that row is gone. */
  query: string | null
  provider: string
  /** Through `readCitationState`, never the stored column. */
  citationState: CitationState
  /** Through `resolveSnapshotAnswerMentioned`, with sentiment's identity verdict applied. */
  answerMentioned: boolean
}

export interface RunQueryCounts {
  queryCounts: ObservedQueryCounts | null
  queryCountsByClass: RunQueryCountsByClass | null
}

/**
 * A run's stored answers as signals only, for a reader that needs the run
 * detail's counts without the answers themselves.
 */
export function readRunAnswerSignals(
  db: Pick<DatabaseClient, 'select'>,
  runId: string,
  project: SnapshotVisibilityProject | null,
): RunAnswerSignal[] {
  return db.select({
    queryId: querySnapshots.queryId,
    query: queries.query,
    provider: querySnapshots.provider,
    citationState: querySnapshots.citationState,
    retrievalStatus: querySnapshots.retrievalStatus,
    answerMentioned: querySnapshots.answerMentioned,
    answerText: querySnapshots.answerText,
    mentionIdentity: querySnapshots.mentionIdentity,
  })
    .from(querySnapshots)
    .leftJoin(queries, eq(querySnapshots.queryId, queries.id))
    .where(eq(querySnapshots.runId, runId))
    .all()
    .map(row => ({
      queryId: row.queryId,
      query: row.query,
      provider: row.provider,
      citationState: readCitationState(row),
      answerMentioned: project ? resolveSnapshotAnswerMentioned(row, project) : (row.answerMentioned ?? false),
    }))
}

/**
 * The observed query counts of one run, pooled and split by the class each
 * query is listed with (text-classified, or stored by an active Advanced
 * plan). Both are null when an answer lacks query identity, and the split is
 * null without a project or when no observed query has a class. The run detail
 * and the setup read both report these.
 */
export function summarizeRunQueryCounts(
  db: Pick<DatabaseClient, 'select'>,
  project: Parameters<typeof readQueryClasses>[1] | null,
  answers: readonly Pick<RunAnswerSignal, 'queryId' | 'query' | 'citationState' | 'answerMentioned'>[],
): RunQueryCounts {
  const identified = answers.flatMap(answer =>
    typeof answer.queryId === 'string' && answer.queryId.length > 0
      ? [{ queryId: answer.queryId, citationState: answer.citationState, answerMentioned: answer.answerMentioned }]
      : [],
  )
  if (identified.length !== answers.length) return { queryCounts: null, queryCountsByClass: null }
  const queryTexts = new Map<string, string>()
  for (const answer of answers) {
    if (answer.queryId && answer.query) queryTexts.set(answer.queryId, answer.query)
  }
  const classes = project
    ? readQueryClasses(db, project, [...queryTexts].map(([id, query]) => ({ id, query })))
    : null
  return {
    queryCounts: summarizeObservedQueryCounts(identified),
    queryCountsByClass: classes
      ? summarizeObservedQueryCountsByClass(identified, queryId => classes.get(queryId) ?? null)
      : null,
  }
}
