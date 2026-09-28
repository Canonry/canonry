import { eq } from 'drizzle-orm'
import type { DatabaseClient } from './client.js'
import { gbpReviewSettings } from './schema.js'

/** A project's own negative-review threshold, or null when it uses the default. */
export function readNegativeReviewMaxStars(db: Pick<DatabaseClient, 'select'>, projectId: string): number | null {
  return db.select({ value: gbpReviewSettings.negativeReviewMaxStars }).from(gbpReviewSettings)
    .where(eq(gbpReviewSettings.projectId, projectId))
    .get()?.value ?? null
}

/** Every project's own threshold, keyed by project id, for list reads. */
export function readAllNegativeReviewMaxStars(db: Pick<DatabaseClient, 'select'>): Map<string, number> {
  return new Map(
    db.select().from(gbpReviewSettings).all().map((row) => [row.projectId, row.negativeReviewMaxStars]),
  )
}

/** Store a project's threshold; null removes it so the project uses the default. */
export function writeNegativeReviewMaxStars(
  db: Pick<DatabaseClient, 'insert' | 'delete'>,
  projectId: string,
  value: number | null,
  now: string,
): void {
  if (value === null) {
    db.delete(gbpReviewSettings).where(eq(gbpReviewSettings.projectId, projectId)).run()
    return
  }
  db.insert(gbpReviewSettings)
    .values({ projectId, negativeReviewMaxStars: value, updatedAt: now })
    .onConflictDoUpdate({ target: gbpReviewSettings.projectId, set: { negativeReviewMaxStars: value, updatedAt: now } })
    .run()
}
