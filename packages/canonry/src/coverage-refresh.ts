import crypto from 'node:crypto'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { DatabaseClient } from '@canonry/canonry-db'
import { projects, runs } from '@canonry/canonry-db'
import { RunKinds, RunStatuses, RunTriggers, describeError } from '@canonry/canonry-contracts'
import type { CanonryConfig } from './config.js'
import { getGoogleAuthConfig, getGoogleConnection } from './google-config.js'
import { executeInspectSitemap } from './gsc-inspect-sitemap.js'
import { createLogger } from './logger.js'

const log = createLogger('CoverageRefresh')

/**
 * Minimum spacing between AUTOMATIC GSC sitemap-coverage refreshes for one
 * project.
 *
 * A successful `gsc-sync` (search performance) and `bing-inspect-sitemap`
 * (Bing's coverage sync) both chain into a full GSC `inspect-sitemap` so the
 * index-coverage dashboard (`gscUrlInspections`) doesn't go stale. The URL
 * Inspection API is quota-limited (2000 requests/property/day, ~1 request/sec),
 * so a scheduled chain skips when one already ran within this window.
 *
 * The original justification for applying this to EVERY caller was that
 * "`gsc-sync` only inspects the top 50 pages by clicks", so the full sweep was
 * a periodic top-up. That stopped being true when inline inspection was removed
 * from `gsc-sync` — it now inspects nothing at all. Skipping the sweep no
 * longer means "refresh a bit less thoroughly", it means NO URL is inspected
 * and index coverage cannot change.
 *
 * That is what a user hit: they pressed "Refresh search data" 46 minutes after the
 * daily scheduled refresh, the chain was silently skipped, and the dashboard's
 * coverage numbers were structurally incapable of moving. Nothing failed and
 * nothing said so.
 */
export const COVERAGE_REFRESH_MIN_INTERVAL_MS = 60 * 60 * 1000

/**
 * Minimum spacing when a PERSON asked for the refresh.
 *
 * Short enough that pressing the button does what it says, long enough to
 * collapse the two arms of "Refresh search data" (the GSC sync and the Bing sync both
 * chain into a coverage refresh, milliseconds apart) into one sweep. The
 * in-flight check below is what actually dedupes those two; this window covers
 * the case where the first sweep has already finished.
 *
 * Quota is not the binding constraint at this spacing: a sweep is capped at
 * `INSPECT_SWEEP_MAX_URLS`, real sites here are tens of pages, and the daily
 * allowance is 2000 per property.
 */
export const COVERAGE_REFRESH_MANUAL_MIN_INTERVAL_MS = 2 * 60 * 1000

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

/**
 * States that mean a sweep is happening RIGHT NOW. Always blocking, at any
 * spacing — this is what collapses the GSC and Bing arms of "Refresh search data" into
 * a single sweep, and it is a correctness guard rather than a quota one.
 */
const IN_FLIGHT_STATUSES = [RunStatuses.queued, RunStatuses.running]

export interface CoverageRefreshDeps {
  executeInspectSitemap: typeof executeInspectSitemap
}

/**
 * Did a person ask for this work, or did a schedule?
 *
 * Read from the TRIGGERING run rather than passed down, so the two chain sites
 * in `server.ts` cannot disagree about it, and so the CLI and the dashboard —
 * which hit the same endpoints — are classified identically.
 */
export function runWasUserInitiated(db: DatabaseClient, runId: string): boolean {
  const row = db.select({ trigger: runs.trigger }).from(runs).where(eq(runs.id, runId)).get()
  return row?.trigger === RunTriggers.manual
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
 * arms of "Refresh search data") cannot both pass the guard — the second observes the
 * first's freshly-inserted `queued` row and bails.
 */
export async function maybeRefreshGscCoverage(
  db: DatabaseClient,
  config: CanonryConfig,
  projectId: string,
  deps: CoverageRefreshDeps = defaultDeps,
  nowMs: number = Date.now(),
  opts: { userInitiated?: boolean } = {},
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

  // In-flight guard — never start a second sweep alongside a running one, at
  // any spacing. This is what makes the GSC and Bing arms of "Refresh search data"
  // collapse into one sweep, and it holds even when the caller is a person.
  const inFlight = db
    .select({ createdAt: runs.createdAt })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, projectId),
        eq(runs.kind, RunKinds['inspect-sitemap']),
        inArray(runs.status, IN_FLIGHT_STATUSES),
      ),
    )
    .orderBy(desc(runs.createdAt))
    .limit(1)
    .get()
  if (inFlight) {
    log.info('skip.in-flight', { projectId })
    return null
  }

  // Spacing guard — skip if a coverage refresh already COMPLETED within the
  // window. A person pressing the button gets a much shorter window than the
  // scheduled chain: the quota exists to stop automation looping, not to make
  // an explicit request do nothing.
  const windowMs = opts.userInitiated
    ? COVERAGE_REFRESH_MANUAL_MIN_INTERVAL_MS
    : COVERAGE_REFRESH_MIN_INTERVAL_MS
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
    if (Number.isFinite(ageMs) && ageMs < windowMs) {
      log.info('skip.recent', { projectId, ageMs, windowMs, userInitiated: opts.userInitiated === true })
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
      error: describeError(err),
    })
  }
  return runId
}
