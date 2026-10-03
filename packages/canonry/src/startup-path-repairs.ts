import { eq, lt } from 'drizzle-orm'
import { URL_PATH_NORMALIZATION_VERSION } from '@ainyc/canonry-contracts'
import { dataRepairCompletions, type DatabaseClient } from '@ainyc/canonry-db'
import {
  backfillAiReferralPaths,
  backfillNormalizedPaths,
  type NormalizedPathsBackfillResult,
} from './commands/backfill.js'

export function repairNormalizedPathsOnStartup(db: DatabaseClient): Promise<NormalizedPathsBackfillResult | null> {
  return repairPathsOnce(db, 'ga-traffic-paths', onConflict => backfillNormalizedPaths(db, { onConflict }))
}

export function repairAiReferralPathsOnStartup(db: DatabaseClient): Promise<NormalizedPathsBackfillResult | null> {
  return repairPathsOnce(db, 'ga-ai-referral-paths', onConflict => backfillAiReferralPaths(db, { onConflict }))
}

async function repairPathsOnce(
  db: DatabaseClient,
  name: 'ga-traffic-paths' | 'ga-ai-referral-paths',
  repair: (onConflict: () => void) => NormalizedPathsBackfillResult | Promise<NormalizedPathsBackfillResult>,
): Promise<NormalizedPathsBackfillResult | null> {
  const completed = db.select({ version: dataRepairCompletions.version }).from(dataRepairCompletions)
    .where(eq(dataRepairCompletions.name, name)).get()
  if (completed && completed.version >= URL_PATH_NORMALIZATION_VERSION) return null

  // Pages commit separately. A crash or failed completion write leaves this
  // version pending, so the next startup can safely repeat the idempotent pass.
  let conflicted = false
  const result = await repair(() => { conflicted = true })
  if (!conflicted) {
    const completion = { version: URL_PATH_NORMALIZATION_VERSION, completedAt: new Date().toISOString() }
    db.insert(dataRepairCompletions).values({ name, ...completion }).onConflictDoUpdate({
      target: dataRepairCompletions.name,
      set: completion,
      setWhere: lt(dataRepairCompletions.version, URL_PATH_NORMALIZATION_VERSION),
    }).run()
  }
  return result
}
