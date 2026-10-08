import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { GroundingSource, NormalizedQueryResult } from '@ainyc/canonry-contracts'
import {
  computeCompetitorOverlap,
  determineAnswerMentioned,
  extractRecommendedCompetitors,
  RunKinds,
} from '@ainyc/canonry-contracts'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { parseJsonColumn, querySnapshots, runs } from '@ainyc/canonry-db'
import { answerIdentityChanged, readAnswerIdentity, type AnswerIdentity } from './answer-identity.js'
import { createRunCompetitorResolver } from './plan-competitors.js'

/**
 * Rescoring stored answer-visibility snapshots from their stored evidence.
 * Shared by every host that writes competitor aliases: the local server and
 * Cloud refresh the stored competitor columns after an alias write, the local
 * job runner rescores a run that recorded answers under older names, and the
 * `canonry backfill answer-mentions` command recomputes mention fields after a
 * matcher change.
 */

/**
 * Snapshots recomputed (and written) per chunk; the chunked driver yields
 * between chunks. A stored answer costs a few milliseconds against 20-odd
 * competitors, so 50 keeps each stall near 200ms.
 */
const ANSWER_MENTIONS_CHUNK_SIZE = 50

export interface ProjectAnswerMentionsBackfillResult {
  examined: number
  updated: number
  wouldUpdate?: number
  mentioned: number
  /**
   * Times the pass started over because the project's identity changed while
   * it ran (`readAnswerIdentity`); absent when it never did.
   */
  restarts?: number
}

/**
 * Most times one pass starts over for an identity change. Past it the pass
 * still scores every remaining chunk with the newest identity; the change that
 * moved it asks for its own pass.
 */
const ANSWER_MENTIONS_MAX_RESTARTS = 3

export interface ProjectAnswerMentionsBackfillOptions {
  dryRun?: boolean
  competitorFieldsOnly?: boolean
  /** Only this run's snapshots; every answer-visibility run of the project when absent. */
  runId?: string
}

/**
 * Recomputes `answerMentioned`, `competitorOverlap`, and `recommendedCompetitors`
 * for every answer-visibility snapshot owned by `projectId` using the snapshot's
 * stored `answerText` + `citedDomains` and the `groundingSources` already cached
 * in the `rawResponse` envelope. Synchronous: better-sqlite3 has no async I/O.
 * `backfillProjectAnswerMentionsInChunks` runs the same pass with pauses
 * between chunks, for a server that must keep answering meanwhile.
 *
 * A snapshot with no stored answer text keeps its stored `answerMentioned`:
 * there is no evidence to recompute it from, and readers fall back to that
 * stored value.
 *
 * `competitorFieldsOnly` is the pass a competitor names change runs (curated,
 * auto-detected or blocked): it leaves `answerMentioned` alone and skips
 * snapshots with no stored answer text entirely, since competitor names only
 * change what the answer text matches and recomputing from an empty text
 * would discard the overlap and named competitors captured at run time.
 *
 * `runId` limits the pass to that one run's snapshots.
 *
 * Does not touch `citationState`, `citedDomains`, or `rawResponse` — those are
 * computed by domain-to-domain matching which aliases do not affect.
 */
export function backfillProjectAnswerMentions(
  db: DatabaseClient,
  projectId: string,
  opts?: ProjectAnswerMentionsBackfillOptions,
): ProjectAnswerMentionsBackfillResult {
  // One synchronous call: nothing else in this process runs between its
  // chunks, so every chunk is scored with the identity read at the start.
  const steps = projectAnswerMentionsSteps(db, projectId, opts, { recheckIdentity: false })
  let step = steps.next()
  while (!step.done) step = steps.next()
  return step.value
}

/**
 * `backfillProjectAnswerMentions`, awaiting `pause` after every chunk of
 * `ANSWER_MENTIONS_CHUNK_SIZE` snapshots (each chunk read, recomputed and
 * written in its own short transaction), so a server running it after an
 * unattended names change never holds its event loop for the whole project.
 *
 * Another write can change the project's identity during a pause (a project
 * alias edit and its own recompute, a competitor alias edit, a detection
 * pass). The identity is re-read before every chunk (`readAnswerIdentity`),
 * so no chunk is ever written from an identity a newer change replaced; when
 * it changed, the pass starts over under the new identity (at most
 * `ANSWER_MENTIONS_MAX_RESTARTS` times), so the chunks it wrote before the
 * change are recomputed too.
 */
export async function backfillProjectAnswerMentionsInChunks(
  db: DatabaseClient,
  projectId: string,
  opts: ProjectAnswerMentionsBackfillOptions & { pause?: () => Promise<void> } = {},
): Promise<ProjectAnswerMentionsBackfillResult> {
  const pause = opts.pause ?? (() => yieldToEventLoop())
  const steps = projectAnswerMentionsSteps(db, projectId, opts, { recheckIdentity: true })
  let step = steps.next()
  while (!step.done) {
    await pause()
    step = steps.next()
  }
  return step.value
}

/** What one identity reading scores answers with. */
function answerScoring(db: DatabaseClient, identity: AnswerIdentity) {
  return {
    fingerprint: identity.fingerprint,
    projectDomains: identity.projectDomains,
    projectBrandNames: identity.projectBrandNames,
    competitorsForRun: createRunCompetitorResolver(db, identity.competitors, identity.marketNames),
  }
}

function* projectAnswerMentionsSteps(
  db: DatabaseClient,
  projectId: string,
  opts: ProjectAnswerMentionsBackfillOptions | undefined,
  /** True when other writes can run between chunks (the chunked driver pauses there). */
  driver: { recheckIdentity: boolean },
): Generator<void, ProjectAnswerMentionsBackfillResult> {
  const isDryRun = opts?.dryRun === true
  const competitorFieldsOnly = opts?.competitorFieldsOnly === true
  const initial = readAnswerIdentity(db, projectId)
  if (!initial) return { examined: 0, updated: 0, mentioned: 0 }
  let scoring = answerScoring(db, initial)

  let examined = 0
  let updated = 0
  let wouldUpdate = 0
  let mentioned = 0
  let restarts = 0
  const result = (): ProjectAnswerMentionsBackfillResult => ({
    examined,
    updated,
    ...(isDryRun ? { wouldUpdate } : {}),
    mentioned,
    ...(restarts > 0 ? { restarts } : {}),
  })

  let chunks = 0
  pass: for (;;) {
    examined = 0
    wouldUpdate = 0
    mentioned = 0
    const runRows = db
      .select({ id: runs.id, planVersionId: runs.measurementPlanVersionId })
      .from(runs)
      .where(and(
        eq(runs.kind, RunKinds['answer-visibility']),
        eq(runs.projectId, projectId),
        opts?.runId === undefined ? undefined : eq(runs.id, opts.runId),
      ))
      .all()
    const planVersionByRun = new Map(runRows.map(run => [run.id, run.planVersionId]))

    for (const run of runRows) {
      // Ids first, then the rows (raw responses included) a chunk at a time,
      // so no run is ever held in memory whole.
      const snapshotIds = db.select({ id: querySnapshots.id })
        .from(querySnapshots)
        .where(eq(querySnapshots.runId, run.id))
        .orderBy(asc(querySnapshots.id))
        .all()
        .map(row => row.id)
      for (let offset = 0; offset < snapshotIds.length; offset += ANSWER_MENTIONS_CHUNK_SIZE) {
        if (chunks++ > 0 && driver.recheckIdentity) {
          yield
          // The pause may have changed the identity. Score this chunk, and
          // every chunk after it, with what is stored now.
          const current = readAnswerIdentity(db, projectId)
          if (!current) return result()
          if (answerIdentityChanged(scoring.fingerprint, current.fingerprint)) {
            scoring = answerScoring(db, current)
            if (restarts < ANSWER_MENTIONS_MAX_RESTARTS) {
              restarts++
              continue pass
            }
          }
        }
        const { projectDomains, projectBrandNames, competitorsForRun } = scoring
        const snapshotRows = db.select({
          id: querySnapshots.id,
          runId: querySnapshots.runId,
          executionId: querySnapshots.measurementExecutionId,
          provider: querySnapshots.provider,
          answerMentioned: querySnapshots.answerMentioned,
          answerText: querySnapshots.answerText,
          citedDomains: querySnapshots.citedDomains,
          competitorOverlap: querySnapshots.competitorOverlap,
          recommendedCompetitors: querySnapshots.recommendedCompetitors,
          rawResponse: querySnapshots.rawResponse,
        }).from(querySnapshots)
          .where(inArray(querySnapshots.id, snapshotIds.slice(offset, offset + ANSWER_MENTIONS_CHUNK_SIZE)))
          .all()
        const pendingUpdates: Array<{ id: string; patch: Record<string, unknown> }> = []

        for (const snapshot of snapshotRows) {
          if (competitorFieldsOnly && snapshot.answerText == null) continue
          examined++

          const answerText = snapshot.answerText ?? ''
          // No stored text, or a competitor-only pass: the stored value stands.
          const nextAnswerMentioned = competitorFieldsOnly || snapshot.answerText == null
            ? snapshot.answerMentioned
            : determineAnswerMentioned(answerText, projectBrandNames, projectDomains)
          if (nextAnswerMentioned) mentioned++

          const citedDomains = snapshot.citedDomains
          const groundingSources = readStoredGroundingSources(snapshot.rawResponse)

          const normalized: NormalizedQueryResult = {
            provider: snapshot.provider,
            answerText,
            citedDomains,
            groundingSources,
            // Only feeds the competitor helpers, which ignore it. This pass never
            // observes or writes retrieval.
            retrievalStatus: 'unknown',

            searchQueries: [],
          }

          const runCompetitors = competitorsForRun(planVersionByRun.get(snapshot.runId), snapshot.executionId)
          const nextCompetitorOverlap = computeCompetitorOverlap(normalized, runCompetitors.domains, runCompetitors.aliases)
          const nextRecommendedCompetitors = extractRecommendedCompetitors(
            answerText,
            projectDomains,
            citedDomains,
            runCompetitors.domains,
            projectBrandNames,
            runCompetitors.aliases,
          )

          const nextPatch: Record<string, unknown> = {}
          if (snapshot.answerMentioned !== nextAnswerMentioned) {
            nextPatch.answerMentioned = nextAnswerMentioned
          }
          if (JSON.stringify(snapshot.competitorOverlap) !== JSON.stringify(nextCompetitorOverlap)) {
            nextPatch.competitorOverlap = nextCompetitorOverlap
          }
          if (JSON.stringify(snapshot.recommendedCompetitors) !== JSON.stringify(nextRecommendedCompetitors)) {
            nextPatch.recommendedCompetitors = nextRecommendedCompetitors
          }

          if (Object.keys(nextPatch).length > 0) {
            pendingUpdates.push({ id: snapshot.id, patch: nextPatch })
          }
        }

        if (pendingUpdates.length > 0) {
          if (isDryRun) {
            wouldUpdate += pendingUpdates.length
          } else {
            db.transaction((tx) => {
              for (const update of pendingUpdates) {
                tx.update(querySnapshots)
                  .set(update.patch)
                  .where(eq(querySnapshots.id, update.id))
                  .run()
              }
            })
            updated += pendingUpdates.length
          }
        }
      }
    }
    return result()
  }
}

function readStoredGroundingSources(rawResponse: string | null): GroundingSource[] {
  const envelope = parseJsonColumn<Record<string, unknown>>(rawResponse, {})
  const sources = envelope.groundingSources
  if (!Array.isArray(sources)) return []
  const result: GroundingSource[] = []
  for (const source of sources) {
    if (source && typeof source === 'object') {
      const uri = (source as { uri?: unknown }).uri
      const title = (source as { title?: unknown }).title
      if (typeof uri === 'string') {
        result.push({ uri, title: typeof title === 'string' ? title : '' })
      }
    }
  }
  return result
}
