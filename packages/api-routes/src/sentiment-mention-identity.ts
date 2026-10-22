import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  countsAsMention,
  determineAnswerMentioned,
  effectiveBrandNames,
  effectiveDomains,
  mentionIdentityFromSentiment,
  sentimentOutcomeSchema,
  type MentionIdentity,
  type SentimentIdentityResult,
} from '@canonry/canonry-contracts'
import {
  projects,
  querySnapshots,
  runs,
  sentimentResults,
  sentimentWorkItems,
  type DatabaseClient,
} from '@canonry/canonry-db'
import { sentimentHash } from './sentiment-input.js'

/**
 * SENTIMENT'S IDENTITY VERDICTS, AS THEY BEAR ON MENTIONS.
 *
 * Mention detection matches names; it cannot tell a brand from a namesake or a
 * common word that shares its name. The sentiment evaluator's first question
 * is exactly that, so when sentiment judged an answer `wrong-subject`, the
 * answer's name match stops counting as a mention:
 *
 * - Simple run: the verdict about the project is stored on the snapshot
 *   (`mention_identity`) and `answer_mentioned` becomes
 *   `countsAsMention(name match, verdict)`. Every recompute of the stored
 *   field (`backfillProjectAnswerMentions`) and every read-time recomputation
 *   (`resolveSnapshotMentionState`, mention share, visibility compare) applies
 *   the same rule, so none of them can resurrect the mention.
 * - Advanced run: verdicts are per Property, so the snapshot keeps the stable
 *   keys of the Properties judged wrong-subject (`wrong_subject_target_keys`)
 *   and the report kernel drops those Properties' mentions of that answer.
 *   The project-level `answer_mentioned` (the portfolio brand) is untouched:
 *   no Advanced verdict judges the brand itself.
 *
 * The latest completed result that judged identity decides
 * (`mentionIdentityFromSentiment`), counting only results that judged the
 * answer's CURRENT text: a verdict is keyed to the text it read
 * (`source_text_hash`), so once a backfill rewrites the answer an older
 * verdict no longer applies. Runs when a result is stored (inside the same
 * transaction), when a backfill rewrites answer text, and once over stored
 * history on startup.
 */

type Db = Pick<DatabaseClient, 'select' | 'update'>

/** Bounds every `IN (...)` list. */
const SNAPSHOT_CHUNK_SIZE = 500

export interface SnapshotMentionIdentityRefresh {
  examined: number
  updated: number
}

/** The subject a stored work item judged: the project for Simple, a Property's stable key for Advanced. */
function judgedSubjectKey(edges: unknown): string | null {
  if (!Array.isArray(edges)) return null
  const first: unknown = edges[0]
  if (typeof first !== 'object' || first === null) return null
  const key = (first as { propertyKey?: unknown }).propertyKey
  return typeof key === 'string' && key.length > 0 ? key : null
}

function sameKeys(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (left === null || right === null) return left === right
  return left.length === right.length && left.every((key, index) => key === right[index])
}

/**
 * Re-derives the stored mention identity of these snapshots from their
 * completed sentiment results, and a Simple snapshot's `answer_mentioned` from
 * its stored answer and the project's current names. Idempotent.
 */
export function refreshSnapshotMentionIdentity(db: Db, snapshotIds: readonly string[]): SnapshotMentionIdentityRefresh {
  let examined = 0
  let updated = 0
  const ids = [...new Set(snapshotIds)]
  const projectNames = new Map<string, { brandNames: string[]; domains: string[] } | null>()
  const namesFor = (projectId: string) => {
    if (!projectNames.has(projectId)) {
      const project = db.select({
        displayName: projects.displayName,
        aliases: projects.aliases,
        canonicalDomain: projects.canonicalDomain,
        ownedDomains: projects.ownedDomains,
      }).from(projects).where(eq(projects.id, projectId)).get()
      projectNames.set(projectId, project
        ? {
            brandNames: effectiveBrandNames({ displayName: project.displayName, aliases: project.aliases }),
            domains: effectiveDomains({ canonicalDomain: project.canonicalDomain, ownedDomains: project.ownedDomains }),
          }
        : null)
    }
    return projectNames.get(projectId) ?? null
  }

  for (let offset = 0; offset < ids.length; offset += SNAPSHOT_CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + SNAPSHOT_CHUNK_SIZE)
    const snapshots = db.select({
      id: querySnapshots.id,
      runId: querySnapshots.runId,
      answerText: querySnapshots.answerText,
      answerMentioned: querySnapshots.answerMentioned,
      mentionIdentity: querySnapshots.mentionIdentity,
      wrongSubjectTargetKeys: querySnapshots.wrongSubjectTargetKeys,
      projectId: runs.projectId,
      planVersionId: runs.measurementPlanVersionId,
    }).from(querySnapshots)
      .innerJoin(runs, eq(runs.id, querySnapshots.runId))
      .where(inArray(querySnapshots.id, chunk))
      .all()
    if (snapshots.length === 0) continue
    // The run ids let SQLite read work items through `idx_sentiment_work_source`.
    const results = db.select({
      snapshotId: sentimentWorkItems.snapshotId,
      workItemId: sentimentWorkItems.id,
      sourceTextHash: sentimentWorkItems.sourceTextHash,
      edges: sentimentWorkItems.edges,
      outcome: sentimentResults.outcome,
      completedAt: sentimentResults.completedAt,
    }).from(sentimentWorkItems)
      .innerJoin(sentimentResults, eq(sentimentResults.workItemId, sentimentWorkItems.id))
      .where(and(
        inArray(sentimentWorkItems.runId, [...new Set(snapshots.map(snapshot => snapshot.runId))]),
        inArray(sentimentWorkItems.snapshotId, chunk),
        eq(sentimentWorkItems.status, 'completed'),
      ))
      .all()

    // The hash sentiment keys its work to (`sentimentSourceHashes`): the stored answer text.
    const currentTextHash = new Map(snapshots.map(snapshot => [snapshot.id, sentimentHash(snapshot.answerText ?? '')]))
    const resultsBySubject = new Map<string, Map<string, SentimentIdentityResult[]>>()
    for (const row of results) {
      if (row.sourceTextHash !== currentTextHash.get(row.snapshotId)) continue
      const subjectKey = judgedSubjectKey(row.edges)
      const outcome = sentimentOutcomeSchema.safeParse(row.outcome)
      if (subjectKey === null || !outcome.success) continue
      const bySubject = resultsBySubject.get(row.snapshotId) ?? new Map<string, SentimentIdentityResult[]>()
      const list = bySubject.get(subjectKey) ?? []
      list.push({ outcome: outcome.data, completedAt: row.completedAt, workItemId: row.workItemId })
      bySubject.set(subjectKey, list)
      resultsBySubject.set(row.snapshotId, bySubject)
    }

    for (const snapshot of snapshots) {
      examined++
      const bySubject = resultsBySubject.get(snapshot.id) ?? new Map<string, SentimentIdentityResult[]>()
      const simple = snapshot.planVersionId === null
      let nextIdentity: MentionIdentity | null = null
      const wrongTargets: string[] = []
      for (const [subjectKey, subjectResults] of bySubject) {
        const identity = mentionIdentityFromSentiment(subjectResults)
        if (subjectKey === snapshot.projectId) {
          if (simple) nextIdentity = identity
        } else if (!simple && identity !== null) {
          wrongTargets.push(subjectKey)
        }
      }
      wrongTargets.sort()
      const nextTargets = wrongTargets.length > 0 ? wrongTargets : null

      const patch: Partial<typeof querySnapshots.$inferInsert> = {}
      if (snapshot.mentionIdentity !== nextIdentity) patch.mentionIdentity = nextIdentity
      if (!sameKeys(snapshot.wrongSubjectTargetKeys ?? null, nextTargets)) patch.wrongSubjectTargetKeys = nextTargets
      if (simple && snapshot.answerText !== null) {
        const names = namesFor(snapshot.projectId)
        if (names) {
          const nameMatched = determineAnswerMentioned(snapshot.answerText, names.brandNames, names.domains)
          const nextMentioned = countsAsMention(nameMatched, nextIdentity)
          if (snapshot.answerMentioned !== nextMentioned) patch.answerMentioned = nextMentioned
        }
      }
      if (Object.keys(patch).length === 0) continue
      db.update(querySnapshots).set(patch).where(eq(querySnapshots.id, snapshot.id)).run()
      updated++
    }
  }
  return { examined, updated }
}

/**
 * Every snapshot with a completed sentiment result, in a stable order: the
 * population the one-time startup pass refreshes.
 */
export function snapshotsWithSentimentResults(db: Pick<DatabaseClient, 'selectDistinct'>): string[] {
  return db.selectDistinct({ snapshotId: sentimentWorkItems.snapshotId })
    .from(sentimentWorkItems)
    .innerJoin(sentimentResults, eq(sentimentResults.workItemId, sentimentWorkItems.id))
    .where(eq(sentimentWorkItems.status, 'completed'))
    .orderBy(asc(sentimentWorkItems.snapshotId))
    .all()
    .map(row => row.snapshotId)
}
