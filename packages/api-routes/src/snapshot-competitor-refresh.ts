import { and, eq, inArray } from 'drizzle-orm'
import type { GroundingSource, NormalizedQueryResult } from '@ainyc/canonry-contracts'
import {
  computeCompetitorOverlap,
  determineAnswerMentioned,
  effectiveBrandNames,
  effectiveDomains,
  extractRecommendedCompetitors,
  RunKinds,
} from '@ainyc/canonry-contracts'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { competitors, parseJsonColumn, projects, querySnapshots, runs } from '@ainyc/canonry-db'
import { createRunCompetitorResolver } from './plan-competitors.js'

/**
 * Rescoring stored answer-visibility snapshots from their stored evidence.
 * Shared by every host that writes competitor aliases: the local server and
 * Cloud refresh the stored competitor columns after an alias write, the local
 * job runner rescores a run that recorded answers under older names, and the
 * `canonry backfill answer-mentions` command recomputes mention fields after a
 * matcher change.
 */

const SNAPSHOT_BATCH_SIZE = 500

export interface ProjectAnswerMentionsBackfillResult {
  examined: number
  updated: number
  wouldUpdate?: number
  mentioned: number
}

/**
 * Recomputes `answerMentioned`, `competitorOverlap`, and `recommendedCompetitors`
 * for every answer-visibility snapshot owned by `projectId` using the snapshot's
 * stored `answerText` + `citedDomains` and the `groundingSources` already cached
 * in the `rawResponse` envelope. Synchronous — better-sqlite3 has no async I/O.
 *
 * A snapshot with no stored answer text keeps its stored `answerMentioned`:
 * there is no evidence to recompute it from, and readers fall back to that
 * stored value.
 *
 * `competitorFieldsOnly` is the pass a competitor alias change runs: it leaves
 * `answerMentioned` alone and skips snapshots with no stored answer text
 * entirely, since curated names only change what the answer text matches and
 * recomputing from an empty text would discard the overlap and named
 * competitors captured at run time.
 *
 * `runId` limits the pass to that one run's snapshots.
 *
 * Does not touch `citationState`, `citedDomains`, or `rawResponse` — those are
 * computed by domain-to-domain matching which aliases do not affect.
 */
export function backfillProjectAnswerMentions(
  db: DatabaseClient,
  projectId: string,
  opts?: { dryRun?: boolean; competitorFieldsOnly?: boolean; runId?: string },
): ProjectAnswerMentionsBackfillResult {
  const isDryRun = opts?.dryRun === true
  const competitorFieldsOnly = opts?.competitorFieldsOnly === true
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!project) return { examined: 0, updated: 0, mentioned: 0 }

  const projectCompetitors = db
    .select({ domain: competitors.domain, aliases: competitors.aliases })
    .from(competitors)
    .where(eq(competitors.projectId, projectId))
    .all()

  const runRows = db
    .select({ id: runs.id, planVersionId: runs.measurementPlanVersionId })
    .from(runs)
    .where(and(
      eq(runs.kind, RunKinds['answer-visibility']),
      eq(runs.projectId, projectId),
      opts?.runId === undefined ? undefined : eq(runs.id, opts.runId),
    ))
    .all()
  const runIds = runRows.map(r => r.id)
  const planVersionByRun = new Map(runRows.map(run => [run.id, run.planVersionId]))
  const competitorsForRun = createRunCompetitorResolver(db, projectCompetitors)

  let examined = 0
  let updated = 0
  let wouldUpdate = 0
  let mentioned = 0
  if (runIds.length === 0) {
    return isDryRun ? { examined, updated, wouldUpdate, mentioned } : { examined, updated, mentioned }
  }

  const projectDomains = effectiveDomains({
    canonicalDomain: project.canonicalDomain,
    ownedDomains: project.ownedDomains,
  })
  const projectBrandNames = effectiveBrandNames({
    displayName: project.displayName,
    aliases: project.aliases,
  })

  for (let offset = 0; offset < runIds.length; offset += SNAPSHOT_BATCH_SIZE) {
    const batchRunIds = runIds.slice(offset, offset + SNAPSHOT_BATCH_SIZE)
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
      .where(inArray(querySnapshots.runId, batchRunIds))
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

  return isDryRun ? { examined, updated, wouldUpdate, mentioned } : { examined, updated, mentioned }
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
