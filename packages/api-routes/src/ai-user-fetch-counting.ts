import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import { aiUserFetchEventsHourly, aiUserFetchLikelyFakeHourly, trafficSources, type DatabaseClient } from '@canonry/canonry-db'
import { BROWSER_AGENT_BOT_IDS } from '@canonry/canonry-integration-traffic'

/**
 * The end of the last hour, over the selected sources, whose AI user fetches
 * of hosted browser agents were counted under older rules
 * (`traffic_sources.ai_user_fetch_older_count_until`), or null when none holds
 * such an hour. Earlier hours were counted differently: some counted every
 * file, data call and beacon those agents' pages made and read high, some had
 * whole visits judged likely fake and read low. They were not recounted
 * (hourly rows keep no method or query). Archived sources count: their rows
 * stay in the series.
 */
export function aiUserFetchOlderCountUntil(
  db: Pick<DatabaseClient, 'select'>,
  scope: { projectId: string, sourceId?: string | null },
): string | null {
  const row = db.select({ until: sql<string | null>`MAX(${trafficSources.aiUserFetchOlderCountUntil})` })
    .from(trafficSources)
    .where(scope.sourceId
      ? and(eq(trafficSources.projectId, scope.projectId), eq(trafficSources.id, scope.sourceId))
      : eq(trafficSources.projectId, scope.projectId))
    .get()
  return row?.until ?? null
}

/** The end of an hourly row's hour, in the hour key's own ISO form. */
const hourEnd = (tsHour: SQLiteColumn) => sql<string | null>`strftime('%Y-%m-%dT%H:%M:%fZ', ${tsHour}, '+1 hour')`

/**
 * A source's older-count marker after a replace-mode backfill rewrote its
 * hours from `windowStartIso` on, page loads only. Hours before the window
 * keep the count they were made under, so the marker moves back to the end of
 * the source's last hosted browser agent hour before the window (counted or
 * likely fake) when that is earlier, and clears once none remains. A source
 * without a marker counted every hour the current way and keeps none. Matched
 * on project and source, the leading columns of both hourly keys.
 */
export function aiUserFetchOlderCountAfterBackfill(
  db: Pick<DatabaseClient, 'select'>,
  scope: { projectId: string, sourceId: string },
  olderCountUntil: string | null,
  windowStartIso: string,
): string | null {
  if (olderCountUntil === null) return null
  const botIds = [...BROWSER_AGENT_BOT_IDS]
  const counted = db.select({ until: hourEnd(aiUserFetchEventsHourly.tsHour) })
    .from(aiUserFetchEventsHourly)
    .where(and(
      eq(aiUserFetchEventsHourly.projectId, scope.projectId),
      eq(aiUserFetchEventsHourly.sourceId, scope.sourceId),
      lt(aiUserFetchEventsHourly.tsHour, windowStartIso),
      inArray(aiUserFetchEventsHourly.botId, botIds),
    ))
    .orderBy(desc(aiUserFetchEventsHourly.tsHour))
    .limit(1)
    .get()?.until ?? null
  const likelyFake = db.select({ until: hourEnd(aiUserFetchLikelyFakeHourly.tsHour) })
    .from(aiUserFetchLikelyFakeHourly)
    .where(and(
      eq(aiUserFetchLikelyFakeHourly.projectId, scope.projectId),
      eq(aiUserFetchLikelyFakeHourly.sourceId, scope.sourceId),
      lt(aiUserFetchLikelyFakeHourly.tsHour, windowStartIso),
      inArray(aiUserFetchLikelyFakeHourly.botId, botIds),
    ))
    .orderBy(desc(aiUserFetchLikelyFakeHourly.tsHour))
    .limit(1)
    .get()?.until ?? null
  const lastHourEnd = counted !== null && likelyFake !== null
    ? (counted > likelyFake ? counted : likelyFake)
    : counted ?? likelyFake
  if (lastHourEnd === null) return null
  return Date.parse(lastHourEnd) < Date.parse(olderCountUntil) ? lastHourEnd : olderCountUntil
}
