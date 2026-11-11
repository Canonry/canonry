import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { aiUserFetchEventsHourly, trafficSources, type DatabaseClient } from '@canonry/canonry-db'
import { BROWSER_AGENT_BOT_IDS } from '@canonry/canonry-integration-traffic'

/**
 * When the selected sources' AI user fetch hours began counting only the page
 * loads of hosted browser agents (`traffic_sources.ai_user_fetch_older_count_until`),
 * or null when none holds hours counted before. Earlier hours also counted
 * every file, data call and beacon those agents' pages made, so they read
 * high, and hourly rows keep no method or query, so they cannot be recounted.
 * Archived sources count: their rows stay in the series.
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

/**
 * Whether a source holds a hosted browser agent's AI user fetch hours before
 * `beforeIso`. A backfill rewrites its window under today's count, so once it
 * reaches back past every such hour the source holds no older count.
 */
export function holdsBrowserAgentHoursBefore(
  db: Pick<DatabaseClient, 'select'>,
  sourceId: string,
  beforeIso: string,
): boolean {
  return db.select({ sourceId: aiUserFetchEventsHourly.sourceId })
    .from(aiUserFetchEventsHourly)
    .where(and(
      eq(aiUserFetchEventsHourly.sourceId, sourceId),
      inArray(aiUserFetchEventsHourly.botId, [...BROWSER_AGENT_BOT_IDS]),
      lt(aiUserFetchEventsHourly.tsHour, beforeIso),
    ))
    .limit(1)
    .get() !== undefined
}
