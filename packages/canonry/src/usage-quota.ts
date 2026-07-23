import crypto from 'node:crypto'
import { and, eq, lte, sql } from 'drizzle-orm'
import { usageCounters, type DatabaseClient } from '@ainyc/canonry-db'

export function getCurrentUsageDay(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Atomically reserve daily provider capacity. Both ordinary monitoring runs and
 * ad-hoc research runs use this so they cannot independently pass a stale
 * check and oversubscribe the same provider/day bucket.
 */
export function reserveDailyQueryQuota(
  db: DatabaseClient,
  input: { scope: string; period: string; count: number; limit: number },
): { reserved: boolean; used: number } {
  if (input.count <= 0) return { reserved: true, used: 0 }
  if (input.count > input.limit) return { reserved: false, used: 0 }
  return db.transaction((tx) => {
    const reserveExisting = () => tx.update(usageCounters)
      .set({ count: sql`${usageCounters.count} + ${input.count}`, updatedAt: new Date().toISOString() })
      .where(and(
        eq(usageCounters.scope, input.scope),
        eq(usageCounters.period, input.period),
        eq(usageCounters.metric, 'queries'),
        lte(usageCounters.count, input.limit - input.count),
      ))
      .run()

    if (reserveExisting().changes === 1) return { reserved: true, used: 0 }

    const inserted = tx.insert(usageCounters).values({
      id: crypto.randomUUID(), scope: input.scope, period: input.period,
      metric: 'queries', count: input.count, updatedAt: new Date().toISOString(),
    }).onConflictDoNothing().run()
    if (inserted.changes === 1) return { reserved: true, used: 0 }

    // Another writer created the counter after our first conditional update.
    if (reserveExisting().changes === 1) return { reserved: true, used: 0 }
    const row = tx.select({ count: usageCounters.count }).from(usageCounters)
      .where(and(eq(usageCounters.scope, input.scope), eq(usageCounters.period, input.period), eq(usageCounters.metric, 'queries')))
      .get()
    return { reserved: false, used: row?.count ?? 0 }
  })
}

/** Return unused capacity from an up-front reservation after a run exits. */
export function releaseDailyQueryQuota(db: DatabaseClient, input: { scope: string; period: string; count: number }): void {
  if (input.count <= 0) return
  db.update(usageCounters)
    .set({ count: sql`MAX(0, ${usageCounters.count} - ${input.count})`, updatedAt: new Date().toISOString() })
    .where(and(eq(usageCounters.scope, input.scope), eq(usageCounters.period, input.period), eq(usageCounters.metric, 'queries')))
    .run()
}
