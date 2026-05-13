import type { runs } from './schema.js'

/**
 * Group runs by `createdAt`. Assumes the input is pre-sorted by `createdAt`
 * DESC (the canonical ordering used by every caller). Returns an array of
 * groups where each group's runs share the same timestamp. A multi-location
 * `--all-locations` sweep produces a group of size N (one run per configured
 * location); a single-location sweep produces a group of size 1.
 *
 * This is the load-bearing helper for #480 — every read-path that picks
 * `runs[0]` as "latest" and `runs[1]` as "previous" is wrong under fan-out;
 * each consumer should walk groups instead. See:
 * - `packages/api-routes/src/composites.ts` — `/projects/:name/overview`
 * - `packages/api-routes/src/report.ts`     — `/projects/:name/report`
 * - `packages/api-routes/src/analytics.ts`  — gap analysis + source breakdown
 * - `packages/canonry/src/notifier.ts`      — citation-change webhooks
 * - `packages/canonry/src/intelligence-service.ts` — recurrence lookback
 */
export function groupRunsByCreatedAt<T extends Pick<typeof runs.$inferSelect, 'createdAt'>>(
  rows: readonly T[],
): T[][] {
  const groups: T[][] = []
  let current: T[] = []
  let currentCreatedAt: string | null = null
  for (const row of rows) {
    if (row.createdAt === currentCreatedAt) {
      current.push(row)
    } else {
      if (current.length > 0) groups.push(current)
      current = [row]
      currentCreatedAt = row.createdAt
    }
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/**
 * Given a fan-out group of same-timestamp runs, return the deterministic
 * "representative" (the lexicographically-greatest id). Matches the tiebreak
 * pattern used by `/runs/latest` since PR #479, so any single-row consumer
 * sees a stable result across DB restore / index rebuild.
 */
export function pickGroupRepresentative<T extends Pick<typeof runs.$inferSelect, 'id'>>(
  group: readonly T[],
): T | null {
  if (group.length === 0) return null
  let best = group[0]!
  for (let i = 1; i < group.length; i++) {
    const candidate = group[i]!
    if (candidate.id > best.id) best = candidate
  }
  return best
}
