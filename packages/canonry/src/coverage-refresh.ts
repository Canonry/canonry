import crypto from 'node:crypto'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { projects, runs } from '@ainyc/canonry-db'
import { RunKinds, RunStatuses, RunTriggers } from '@ainyc/canonry-contracts'
import type { CanonryConfig } from './config.js'
import { getGoogleAuthConfig, getGoogleConnection } from './google-config.js'
import { executeInspectSitemap } from './gsc-inspect-sitemap.js'
import { createLogger } from './logger.js'

const log = createLogger('CoverageRefresh')

/**
 * Minimum spacing between automatic GSC sitemap-coverage refreshes for one
 * project.
 *
 * A successful `gsc-sync` (search performance) and `bing-inspect-sitemap`
 * (Bing's coverage sync) both chain into a full GSC `inspect-sitemap` so the
 * index-coverage dashboard (`gscUrlInspections`) doesn't go stale — `gsc-sync`
 * only inspects the top 50 pages by clicks, so newly-added / zero-click URLs
 * are never re-inspected and coverage silently drifts. But the URL Inspection
 * API is quota-limited (2000 requests/property/day, ~1 request/sec), so we
 * skip a refresh when one already ran within this window. This also keeps the
 * dashboard "Refresh all" button — which fires a GSC sync and a Bing sync
 * near-simultaneously — from inspecting the whole sitemap twice.
 */
export const COVERAGE_REFRESH_MIN_INTERVAL_MS = 60 * 60 * 1000

/**
 * Run states that mean "a coverage refresh already happened, or is about to"
 * for the spacing guard. A `failed`/`cancelled` prior run does NOT block a
 * retry — coverage never actually refreshed in those cases.
 */
const ACTIVE_OR_DONE_STATUSES = [
  RunStatuses.queued,
  RunStatuses.running,
  RunStatuses.completed,
  RunStatuses.partial,
]

export interface CoverageRefreshDeps {
  executeInspectSitemap: typeof executeInspectSitemap
}

const defaultDeps: CoverageRefreshDeps = { executeInspectSitemap }

/**
 * Queue and run a full GSC `inspect-sitemap` to refresh the index-coverage
 * dashboard, unless GSC isn't connected for the project or a coverage refresh
 * already ran within {@link COVERAGE_REFRESH_MIN_INTERVAL_MS}.
 *
 * Called fire-and-forget after a successful `gsc-sync` or `bing-inspect-sitemap`
 * completes (see the callback wiring in `server.ts`). Returns the new
 * `inspect-sitemap` run id, or `null` when the refresh was skipped.
 *
 * The project lookup, spacing guard, and run-row insert run synchronously with
 * no `await` between them, so two near-simultaneous callers (the GSC + Bing
 * arms of "Refresh all") cannot both pass the guard — the second observes the
 * first's freshly-inserted `queued` row and bails.
 */
export async function maybeRefreshGscCoverage(
  db: DatabaseClient,
  config: CanonryConfig,
  projectId: string,
  deps: CoverageRefreshDeps = defaultDeps,
  nowMs: number = Date.now(),
): Promise<string | null> {
  const project = db
    .select({ canonicalDomain: projects.canonicalDomain })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get()
  if (!project) return null

  // GSC must be fully connected — otherwise the inspect-sitemap run would just
  // fail. Critically, this lets the Bing → GSC chain no-op silently on
  // Bing-only (or unconnected) projects instead of logging a failed GSC run
  // after every Bing sync.
  const { clientId, clientSecret } = getGoogleAuthConfig(config)
  if (!clientId || !clientSecret) return null
  const conn = getGoogleConnection(config, project.canonicalDomain, 'gsc')
  if (!conn?.refreshToken || !conn.propertyId) return null

  // Spacing guard — skip if a coverage refresh already ran (or is running)
  // within the window.
  const recent = db
    .select({ createdAt: runs.createdAt })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, projectId),
        eq(runs.kind, RunKinds['inspect-sitemap']),
        inArray(runs.status, ACTIVE_OR_DONE_STATUSES),
      ),
    )
    .orderBy(desc(runs.createdAt))
    .limit(1)
    .get()
  if (recent) {
    const ageMs = nowMs - Date.parse(recent.createdAt)
    if (Number.isFinite(ageMs) && ageMs < COVERAGE_REFRESH_MIN_INTERVAL_MS) {
      log.info('skip.recent', { projectId, ageMs })
      return null
    }
  }

  // Synchronous insert closes the guard race: a concurrent caller's SELECT
  // above now observes this `queued` row and skips.
  const runId = crypto.randomUUID()
  db.insert(runs)
    .values({
      id: runId,
      projectId,
      kind: RunKinds['inspect-sitemap'],
      status: RunStatuses.queued,
      trigger: RunTriggers.scheduled,
      createdAt: new Date(nowMs).toISOString(),
    })
    .run()

  log.info('refresh.start', { projectId, runId })
  try {
    await deps.executeInspectSitemap(db, runId, projectId, { config })
  } catch (err) {
    // The executor records its own `failed` status on the run row; a
    // coverage-refresh failure must never bubble into the triggering sync's
    // result.
    log.error('refresh.failed', {
      projectId,
      runId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return runId
}
