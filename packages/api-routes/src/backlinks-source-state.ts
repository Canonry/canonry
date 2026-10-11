import { and, eq, isNotNull, or } from 'drizzle-orm'
import { BacklinkSources, CcReleaseSyncStatuses } from '@ainyc/canonry-contracts'
import { backlinkSummaries, ccReleaseSyncs, type DatabaseClient } from '@ainyc/canonry-db'

export interface CommonCrawlSourceState {
  /**
   * At least one workspace release sync has completed: it is `ready`, or it
   * reached `ready` before and is being synced again.
   */
  hasReadyRelease: boolean
  /** The project has a stored Common Crawl summary, from any release. */
  hasProjectData: boolean
  /** Both of the above: the source is set up and this project has data from it. */
  connected: boolean
}

/**
 * Whether Common Crawl is set up for a project, graded from what is stored.
 *
 * The release sync is workspace-global and writes backlink rows and a summary
 * for every project, so a project needs no setting of its own to have current
 * data. `autoExtractBacklinks` only queues a re-extract after a sync; reading
 * it as the connection made projects with current data look disconnected. A
 * project created after the last sync has no summary yet, and is not
 * connected until `canonry backlinks extract` or the next sync writes one.
 *
 * A release counts once it has completed, not only while its row says
 * `ready`. Syncing a release again re-queues the same row, and the stored
 * rows stay as they were until the sync's final write, or for good when it
 * fails. Reading the status alone reported every project as disconnected for
 * as long as the download ran. `queryFinishedAt` is stamped when a sync
 * reaches `ready` and nothing clears it, so it marks a release that completed
 * at least once.
 *
 * The sources route and the `backlinks.source.connected` doctor check both
 * read this, so the API and the check cannot disagree.
 */
export function readCommonCrawlSourceState(db: DatabaseClient, projectId: string): CommonCrawlSourceState {
  const hasReadyRelease = db
    .select({ id: ccReleaseSyncs.id })
    .from(ccReleaseSyncs)
    .where(or(
      eq(ccReleaseSyncs.status, CcReleaseSyncStatuses.ready),
      isNotNull(ccReleaseSyncs.queryFinishedAt),
    ))
    .limit(1)
    .get() !== undefined
  const hasProjectData = db
    .select({ id: backlinkSummaries.id })
    .from(backlinkSummaries)
    .where(and(
      eq(backlinkSummaries.projectId, projectId),
      eq(backlinkSummaries.source, BacklinkSources.commoncrawl),
    ))
    .limit(1)
    .get() !== undefined
  return { hasReadyRelease, hasProjectData, connected: hasReadyRelease && hasProjectData }
}
