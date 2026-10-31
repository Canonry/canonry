import { and, eq, gte, lte, sql } from 'drizzle-orm'
import { aiUserFetchLikelyFakeHourly, type DatabaseClient } from '@canonry/canonry-db'
import type { AgentTrustReason } from '@canonry/canonry-contracts'

type RollupDb = Pick<DatabaseClient, 'insert' | 'delete'>

export interface LikelyFakeAgentBucket {
  tsHour: string
  botId: string
  operator: string
  reason: AgentTrustReason
  hits: number
}

/**
 * Add likely fake agent requests to their hourly totals. Every traffic writer
 * calls this with the rollup's `aiUserFetchLikelyFakeHourly`, in the same
 * transaction as its AI user fetch buckets.
 */
export function addLikelyFakeAgentHits(
  db: RollupDb,
  input: { projectId: string; sourceId: string; buckets: readonly LikelyFakeAgentBucket[]; now: string },
): number {
  for (const bucket of input.buckets) {
    db.insert(aiUserFetchLikelyFakeHourly)
      .values({
        projectId: input.projectId,
        sourceId: input.sourceId,
        tsHour: bucket.tsHour,
        botId: bucket.botId,
        operator: bucket.operator,
        reason: bucket.reason,
        hits: bucket.hits,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [
          aiUserFetchLikelyFakeHourly.projectId,
          aiUserFetchLikelyFakeHourly.sourceId,
          aiUserFetchLikelyFakeHourly.tsHour,
          aiUserFetchLikelyFakeHourly.botId,
          aiUserFetchLikelyFakeHourly.reason,
        ],
        set: {
          hits: sql`${aiUserFetchLikelyFakeHourly.hits} + ${bucket.hits}`,
          operator: bucket.operator,
          updatedAt: input.now,
        },
      })
      .run()
  }
  return input.buckets.length
}

/** Replace-mode backfill clears this window with the other hourly rollups. */
export function clearLikelyFakeAgentHits(db: RollupDb, input: { sourceId: string; windowStart: string; windowEnd: string }): void {
  db.delete(aiUserFetchLikelyFakeHourly)
    .where(and(
      eq(aiUserFetchLikelyFakeHourly.sourceId, input.sourceId),
      gte(aiUserFetchLikelyFakeHourly.tsHour, input.windowStart),
      lte(aiUserFetchLikelyFakeHourly.tsHour, input.windowEnd),
    ))
    .run()
}
