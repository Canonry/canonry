import { and, desc, eq, gte, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import {
  CloudflareQueueDrainStopReasons,
  CloudflareTrafficDeliveryModes,
  CheckCategories,
  CheckNotificationPolicies,
  CheckScopes,
  CheckStatuses,
  RunKinds,
  RunStatuses,
  TrafficSourceStatuses,
  TrafficSourceTypes,
  describeError,
  type CloudflareQueueDrainStopReason,
} from '@canonry/canonry-contracts'
import {
  aiReferralEventsHourly,
  aiUserFetchEventsHourly,
  crawlerEventsHourly,
  runs,
  trafficSources,
} from '@canonry/canonry-db'
import {
  CLOUDFLARE_QUEUE_RESIDUAL_WARN_COUNT,
  TRAFFIC_SOURCE_MAX_CATCHUP_MS,
} from '../../traffic-limits.js'
import { cloudflareWorkerVersionFor } from '../../cloudflare-worker-version.js'
import { SYNC_FAILURE_WINDOW, readSyncRunState } from './integration-sync.js'
import type { CheckDefinition, CheckOutput, DoctorContext, TrafficSourceProbe } from '../types.js'

/**
 * Generic doctor checks for the server-side traffic ingestion pipeline. They
 * stay adapter-agnostic — the `traffic_sources` table is the only thing they
 * reach into directly; per-adapter credential / scope validation flows
 * through `DoctorContext.trafficSourceValidators[sourceType]`.
 *
 * Today the only adapter is Cloud Run; tomorrow's WordPress / SaaS adapters
 * register under their own `sourceType` keys and inherit every check below
 * with no doctor-side changes.
 */

const RECENT_DATA_WARN_DAYS = 7
const RECENT_DATA_FAIL_DAYS = 30

/**
 * Only the current direct-push Cloudflare transport has no Canonry-side pull
 * watermark. Missing mode is the legacy direct-push shape. Reserved/future
 * modes must flow through normal pull checks instead of inheriting behavior
 * from `sourceType = cloudflare`.
 */
function isCloudflareDirectPush(source: TrafficSourceProbe): boolean {
  if (source.sourceType !== TrafficSourceTypes.cloudflare) return false
  const deliveryMode = source.configJson.deliveryMode
  return deliveryMode === undefined
    || deliveryMode === CloudflareTrafficDeliveryModes['direct-push']
}

function isCloudflareQueuePull(source: TrafficSourceProbe): boolean {
  return source.sourceType === TrafficSourceTypes.cloudflare
    && source.configJson.deliveryMode === CloudflareTrafficDeliveryModes['queue-pull']
}

function isCloudflareWorkerSource(source: TrafficSourceProbe): boolean {
  return isCloudflareDirectPush(source) || isCloudflareQueuePull(source)
}

function isActiveSource(source: TrafficSourceProbe): boolean {
  return source.status !== TrafficSourceStatuses.paused
}

function recentDataRemediation(sources: TrafficSourceProbe[], lastSyncedAt: string | null): string {
  const hasCloudflare = sources.some(isCloudflareDirectPush)
  const hasPullSource = sources.some(source => !isCloudflareDirectPush(source))

  if (hasCloudflare && !hasPullSource) {
    return 'Confirm the Cloudflare Worker is deployed on the zone route and forwarding to canonry; reconnect Cloudflare to regenerate the Worker if needed.'
  }
  if (hasCloudflare && hasPullSource) {
    return 'Run `canonry traffic sync <project>` for pull-based sources, and confirm the Cloudflare Worker is deployed on the zone route and forwarding to canonry.'
  }
  return lastSyncedAt
    ? `Last sync: ${lastSyncedAt}. Run \`canonry traffic sync <project>\` to refresh, or check the source connection.`
    : 'Run `canonry traffic sync <project>` to pull recent events.'
}

function skippedNoProject(): CheckOutput {
  return {
    status: CheckStatuses.skipped,
    code: 'traffic.no-project',
    summary: 'Project context required for traffic source checks.',
    remediation: 'Run `canonry doctor --project <name>` to scope this check to a project.',
  }
}

function loadProbes(ctx: DoctorContext): TrafficSourceProbe[] {
  if (!ctx.project) return []
  const rows = ctx.db
    .select()
    .from(trafficSources)
    .where(
      and(
        eq(trafficSources.projectId, ctx.project.id),
        ne(trafficSources.status, TrafficSourceStatuses.archived),
      ),
    )
    .all()
  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    projectName: ctx.project!.name,
    sourceType: r.sourceType,
    displayName: r.displayName,
    status: r.status,
    lastSyncedAt: r.lastSyncedAt,
    lastWorkerVersion: r.lastWorkerVersion,
    ingestTokenHash: r.ingestTokenHash,
    skippedThroughAt: r.skippedThroughAt,
    queueBacklogCount: r.queueBacklogCount,
    queueBacklogObservedAt: r.queueBacklogObservedAt,
    lastError: r.lastError,
    configJson: r.configJson,
  }))
}

const sourceConnectedCheck: CheckDefinition = {
  id: 'traffic.source.connected',
  category: CheckCategories.integrations,
  scope: CheckScopes.project,
  title: 'Traffic source connected',
  run: (ctx) => {
    if (!ctx.project) return skippedNoProject()
    const sources = loadProbes(ctx)
    if (sources.length === 0) {
      return {
        status: CheckStatuses.skipped,
        code: 'traffic.source.none',
        summary: 'No server-side traffic source connected — server-log AI visibility data unavailable for this project.',
        remediation: 'Connect a traffic source via `canonry traffic connect <type> <project>` to surface crawler hits and AI-referral sessions from your server logs.',
        details: { sourceCount: 0 },
      }
    }
    const activeSources = sources.filter(isActiveSource)
    if (activeSources.length === 0) {
      return {
        status: CheckStatuses.skipped,
        code: 'traffic.source.paused',
        summary: `${sources.length} traffic source(s) are paused or staged; none are actively ingesting.`,
        remediation: 'Activate the intended traffic source after its deployment smoke test succeeds.',
        details: { sourceCount: sources.length, pausedIds: sources.map((s) => s.id) },
      }
    }
    const errored = activeSources.filter((s) => s.status === 'error')
    if (errored.length > 0 && errored.length === activeSources.length) {
      // One failed sync flags a source `error` until its next success, so a
      // passing blip (a DNS miss, a host restart) is not an outage. Fail once a
      // source has failed SYNC_FAILURE_WINDOW syncs in a row, or when its error
      // did not come from a sync at all.
      const streaks = errored.map((s) => readSyncRunState(ctx.db, ctx.project!.id, RunKinds['traffic-sync'], { sourceId: s.id }))
      const recovering = streaks.every((state) => state.latestStatus === RunStatuses.failed && !state.repeatedFailure)
      const lastDataAt = errored.map((s) => s.lastSyncedAt).filter((at): at is string => !!at).sort().at(-1) ?? null
      const failuresInARow = Math.min(...streaks.map((state) => state.consecutiveFailures))
      const sinceText = lastDataAt ? `No new data since ${lastDataAt}.` : 'No data has arrived yet.'
      return {
        status: recovering ? CheckStatuses.warn : CheckStatuses.fail,
        code: recovering ? 'traffic.source.all-errored-recently' : 'traffic.source.all-errored',
        summary: recovering
          ? `The latest sync failed for all ${activeSources.length} active traffic source(s) (${failuresInARow} in a row; this fails at ${SYNC_FAILURE_WINDOW}). ${sinceText}`
          : `All ${activeSources.length} active traffic source(s) are in error state. ${sinceText}`,
        remediation: errored[0]!.lastError
          ? `Latest error: "${errored[0]!.lastError}". Re-connect the source or run \`canonry traffic sync <project> --source <id>\` to retry.`
          : 'Run `canonry traffic sources <project>` to inspect the failing source(s) and re-connect.',
        details: {
          sourceCount: activeSources.length, pausedCount: sources.length - activeSources.length, erroredIds: errored.map((s) => s.id),
          failuresInARow, lastSyncedAt: lastDataAt,
        },
      }
    }
    if (errored.length > 0) {
      return {
        status: CheckStatuses.warn,
        code: 'traffic.source.partially-errored',
        summary: `${errored.length} of ${activeSources.length} active traffic source(s) are in error state.`,
        remediation: 'Run `canonry traffic sources <project>` to inspect the failing sources individually.',
        details: { sourceCount: activeSources.length, pausedCount: sources.length - activeSources.length, erroredIds: errored.map((s) => s.id) },
      }
    }
    return {
      status: CheckStatuses.ok,
      code: 'traffic.source.connected',
      summary: `${activeSources.length} traffic source(s) connected: ${activeSources.map((s) => s.displayName).join(', ')}.`,
      details: { sourceCount: activeSources.length, pausedCount: sources.length - activeSources.length, sourceTypes: [...new Set(activeSources.map((s) => s.sourceType))] },
    }
  },
}

const recentDataCheck: CheckDefinition = {
  id: 'traffic.source.recent-data',
  category: CheckCategories.integrations,
  scope: CheckScopes.project,
  title: 'Traffic source recent data',
  run: (ctx) => {
    if (!ctx.project) return skippedNoProject()
    const sources = loadProbes(ctx)
    if (sources.length === 0) {
      return {
        status: CheckStatuses.skipped,
        code: 'traffic.recent-data.no-source',
        summary: 'No traffic source connected — recent-data check skipped.',
      }
    }
    const activeSources = sources.filter(isActiveSource)
    if (activeSources.length === 0) {
      return {
        status: CheckStatuses.skipped,
        code: 'traffic.recent-data.no-active-source',
        summary: 'Only paused or staged traffic sources are configured — recent-data check skipped.',
        remediation: 'Activate the intended source after its deployment smoke test succeeds.',
        details: { sourceCount: sources.length, pausedIds: sources.map((source) => source.id) },
      }
    }
    const activeSourceIds = activeSources.map((source) => source.id)

    const now = new Date()
    const warnCutoff = new Date(now.getTime() - RECENT_DATA_WARN_DAYS * 24 * 60 * 60_000).toISOString()
    const failCutoff = new Date(now.getTime() - RECENT_DATA_FAIL_DAYS * 24 * 60 * 60_000).toISOString()

    const recentCrawlers = Number(
      ctx.db
        .select({ total: sql<number>`COALESCE(SUM(${crawlerEventsHourly.hits}), 0)` })
        .from(crawlerEventsHourly)
        .where(
          and(
            eq(crawlerEventsHourly.projectId, ctx.project.id),
            inArray(crawlerEventsHourly.sourceId, activeSourceIds),
            gte(crawlerEventsHourly.tsHour, warnCutoff),
          ),
        )
        .get()?.total ?? 0,
    )
    const recentReferrals = Number(
      ctx.db
        .select({ total: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.sessionsOrHits}), 0)` })
        .from(aiReferralEventsHourly)
        .where(
          and(
            eq(aiReferralEventsHourly.projectId, ctx.project.id),
            inArray(aiReferralEventsHourly.sourceId, activeSourceIds),
            gte(aiReferralEventsHourly.tsHour, warnCutoff),
          ),
        )
        .get()?.total ?? 0,
    )
    const recentUserFetches = Number(
      ctx.db
        .select({ total: sql<number>`COALESCE(SUM(${aiUserFetchEventsHourly.hits}), 0)` })
        .from(aiUserFetchEventsHourly)
        .where(
          and(
            eq(aiUserFetchEventsHourly.projectId, ctx.project.id),
            inArray(aiUserFetchEventsHourly.sourceId, activeSourceIds),
            gte(aiUserFetchEventsHourly.tsHour, warnCutoff),
          ),
        )
        .get()?.total ?? 0,
    )
    if (recentCrawlers > 0 || recentUserFetches > 0 || recentReferrals > 0) {
      return {
        status: CheckStatuses.ok,
        code: 'traffic.recent-data.fresh',
        summary: `${recentCrawlers} crawler hit(s), ${recentUserFetches} AI user-fetch hit(s), and ${recentReferrals} AI-referral hit(s) in the last ${RECENT_DATA_WARN_DAYS} days.`,
        details: {
          crawlerHits: recentCrawlers,
          aiUserFetchHits: recentUserFetches,
          // Full hit count on purpose: for freshness, a redirect hop is still
          // proof the pipeline works. Named hits, not arrivals — the report's
          // referralArrivals is redirect-excluded and must not share a name
          // with a figure that is not.
          referralHits: recentReferrals,
          windowDays: RECENT_DATA_WARN_DAYS,
        },
      }
    }

    // No data inside the warn window — escalate to fail if also empty inside the failure window.
    const olderCrawlers = Number(
      ctx.db
        .select({ total: sql<number>`COALESCE(SUM(${crawlerEventsHourly.hits}), 0)` })
        .from(crawlerEventsHourly)
        .where(
          and(
            eq(crawlerEventsHourly.projectId, ctx.project.id),
            inArray(crawlerEventsHourly.sourceId, activeSourceIds),
            gte(crawlerEventsHourly.tsHour, failCutoff),
          ),
        )
        .get()?.total ?? 0,
    )
    const olderReferrals = Number(
      ctx.db
        .select({ total: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.sessionsOrHits}), 0)` })
        .from(aiReferralEventsHourly)
        .where(
          and(
            eq(aiReferralEventsHourly.projectId, ctx.project.id),
            inArray(aiReferralEventsHourly.sourceId, activeSourceIds),
            gte(aiReferralEventsHourly.tsHour, failCutoff),
          ),
        )
        .get()?.total ?? 0,
    )
    const olderUserFetches = Number(
      ctx.db
        .select({ total: sql<number>`COALESCE(SUM(${aiUserFetchEventsHourly.hits}), 0)` })
        .from(aiUserFetchEventsHourly)
        .where(
          and(
            eq(aiUserFetchEventsHourly.projectId, ctx.project.id),
            inArray(aiUserFetchEventsHourly.sourceId, activeSourceIds),
            gte(aiUserFetchEventsHourly.tsHour, failCutoff),
          ),
        )
        .get()?.total ?? 0,
    )
    const lastSyncedAt = activeSources.map((s) => s.lastSyncedAt).filter(Boolean).sort().at(-1) ?? null
    const hasOlderData = olderCrawlers > 0 || olderUserFetches > 0 || olderReferrals > 0
    if (hasOlderData || lastSyncedAt) {
      return {
        status: CheckStatuses.warn,
        code: 'traffic.recent-data.stale',
        summary: hasOlderData
          ? `No crawler, AI user-fetch, or AI-referral hits in the last ${RECENT_DATA_WARN_DAYS} days, though older data exists.`
          : `No crawler, AI user-fetch, or AI-referral hits in the last ${RECENT_DATA_WARN_DAYS} days.`,
        remediation: recentDataRemediation(activeSources, lastSyncedAt),
        details: { lastSyncedAt, sourceCount: activeSources.length, pausedCount: sources.length - activeSources.length },
      }
    }
    return {
      status: CheckStatuses.fail,
      code: 'traffic.recent-data.empty',
      summary: `No traffic data in the last ${RECENT_DATA_FAIL_DAYS} days. The source is connected but isn't ingesting.`,
      remediation: 'Verify the source\'s configuration with `canonry traffic sources <project>` and run a manual sync to confirm credentials + scopes are still valid.',
      details: { sourceCount: activeSources.length, pausedCount: sources.length - activeSources.length },
    }
  },
}

async function runValidator(
  source: TrafficSourceProbe,
  validator: ((s: TrafficSourceProbe) => Promise<CheckOutput | null> | CheckOutput | null) | undefined,
  fallbackId: string,
  fallbackLabel: string,
): Promise<{ source: TrafficSourceProbe; output: CheckOutput }> {
  if (!validator) {
    return {
      source,
      output: {
        status: CheckStatuses.skipped,
        code: `traffic.${fallbackId}.no-validator`,
        summary: `No ${fallbackLabel} validator registered for source type "${source.sourceType}".`,
      },
    }
  }
  try {
    const result = await validator(source)
    if (!result) {
      return {
        source,
        output: {
          status: CheckStatuses.skipped,
          code: `traffic.${fallbackId}.unsupported`,
          summary: `Validator for "${source.sourceType}" does not implement ${fallbackLabel} validation.`,
        },
      }
    }
    return { source, output: result }
  } catch (e) {
    const msg = describeError(e)
    return {
      source,
      output: {
        status: CheckStatuses.fail,
        code: `traffic.${fallbackId}.validator-error`,
        summary: `${fallbackLabel} validator threw: ${msg}.`,
        remediation: 'Check the source configuration and credentials, then re-run the doctor.',
      },
    }
  }
}

function summarizePerSourceResults(
  fallbackId: string,
  fallbackLabel: string,
  results: Array<{ source: TrafficSourceProbe; output: CheckOutput }>,
): CheckOutput {
  const failed = results.filter((r) => r.output.status === CheckStatuses.fail)
  const warned = results.filter((r) => r.output.status === CheckStatuses.warn)
  const skipped = results.filter((r) => r.output.status === CheckStatuses.skipped)
  const ok = results.filter((r) => r.output.status === CheckStatuses.ok)

  const detail = {
    sources: results.map((r) => ({
      id: r.source.id,
      sourceType: r.source.sourceType,
      displayName: r.source.displayName,
      status: r.output.status,
      code: r.output.code,
      summary: r.output.summary,
    })),
  }
  if (failed.length > 0) {
    return {
      status: CheckStatuses.fail,
      code: `traffic.${fallbackId}.failed`,
      summary: `${failed.length} of ${results.length} source(s) failed ${fallbackLabel} validation: ${failed.map((r) => `${r.source.displayName} (${r.output.summary})`).join('; ')}.`,
      remediation: failed[0]!.output.remediation ?? `Inspect the failing source(s) — see details.sources for per-source codes.`,
      details: detail,
    }
  }
  if (warned.length > 0) {
    return {
      status: CheckStatuses.warn,
      code: `traffic.${fallbackId}.warned`,
      summary: `${warned.length} of ${results.length} source(s) raised warnings during ${fallbackLabel} validation.`,
      remediation: warned[0]!.output.remediation ?? `Review the warning(s) — see details.sources.`,
      details: detail,
    }
  }
  if (ok.length > 0) {
    return {
      status: CheckStatuses.ok,
      code: `traffic.${fallbackId}.ok`,
      summary: `${ok.length} source(s) passed ${fallbackLabel} validation${skipped.length > 0 ? ` (${skipped.length} skipped)` : ''}.`,
      details: detail,
    }
  }
  // All skipped.
  return {
    status: CheckStatuses.skipped,
    code: `traffic.${fallbackId}.all-skipped`,
    summary: `No source-type validator was available for any of the ${results.length} connected source(s).`,
    remediation: skipped.find((result) => result.output.remediation)?.output.remediation,
    details: detail,
  }
}

const credentialsCheck: CheckDefinition = {
  id: 'traffic.source.credentials',
  category: CheckCategories.auth,
  scope: CheckScopes.project,
  title: 'Traffic source credentials',
  run: async (ctx) => {
    if (!ctx.project) return skippedNoProject()
    const sources = loadProbes(ctx)
    if (sources.length === 0) {
      return {
        status: CheckStatuses.skipped,
        code: 'traffic.credentials.no-source',
        summary: 'No traffic source connected — credentials check skipped.',
      }
    }
    const validators = ctx.trafficSourceValidators ?? {}
    const results = await Promise.all(
      sources.map((s) =>
        runValidator(
          s,
          validators[s.sourceType]?.validateCredentials?.bind(validators[s.sourceType]),
          'credentials',
          'credentials',
        ),
      ),
    )
    return summarizePerSourceResults('credentials', 'credentials', results)
  },
}

const scopesCheck: CheckDefinition = {
  id: 'traffic.source.scopes',
  category: CheckCategories.auth,
  scope: CheckScopes.project,
  title: 'Traffic source scopes',
  run: async (ctx) => {
    if (!ctx.project) return skippedNoProject()
    const sources = loadProbes(ctx)
    if (sources.length === 0) {
      return {
        status: CheckStatuses.skipped,
        code: 'traffic.scopes.no-source',
        summary: 'No traffic source connected — scopes check skipped.',
      }
    }
    const validators = ctx.trafficSourceValidators ?? {}
    const results = await Promise.all(
      sources.map((s) =>
        runValidator(
          s,
          validators[s.sourceType]?.validateScopes?.bind(validators[s.sourceType]),
          'scopes',
          'scopes',
        ),
      ),
    )
    return summarizePerSourceResults('scopes', 'scopes', results)
  },
}

/**
 * The WordPress adapter captures via the Canonry Traffic Logger plugin, which
 * only logs requests that reach PHP. A full-page cache (LiteSpeed, WP Rocket,
 * W3TC, WP Super Cache) or CDN serves cached pages before PHP runs, so
 * cache-served page views (including live AI user-fetches like Claude-User
 * and ChatGPT-User) are invisible to the plugin, while bot crawls of uncached
 * endpoints (sitemap, assets, cache misses) still come through. This is
 * inherent to hook-based capture, not a config error, so it warns whenever a
 * WordPress source is present; log/edge adapters (cloud-run, vercel) are
 * unaffected and skip.
 *
 * Silent: the warning can never clear while the source exists, so as a health
 * check it kept the project permanently degraded and no recovery could ever
 * be sent. It stays in `canonry doctor` as a standing note.
 */
const cacheBlindSpotCheck: CheckDefinition = {
  id: 'traffic.source.cache-blindspot',
  category: CheckCategories.integrations,
  scope: CheckScopes.project,
  title: 'WordPress traffic cache blind spot',
  notificationPolicy: CheckNotificationPolicies.silent,
  run: (ctx) => {
    if (!ctx.project) return skippedNoProject()
    const wpSources = loadProbes(ctx).filter(
      (s) => s.sourceType === TrafficSourceTypes.wordpress,
    )
    if (wpSources.length === 0) {
      return {
        status: CheckStatuses.skipped,
        code: 'traffic.cache-blindspot.no-wordpress-source',
        summary:
          'No WordPress traffic source connected, so the plugin cache blind spot does not apply (log and edge adapters see cache-served requests).',
      }
    }
    return {
      status: CheckStatuses.warn,
      code: 'traffic.cache-blindspot.wordpress-plugin',
      summary:
        `${wpSources.length} WordPress traffic source(s) capture via the Canonry Traffic Logger plugin, which only logs requests that execute PHP. ` +
        'A full-page cache (LiteSpeed, WP Rocket, W3 Total Cache, WP Super Cache) or CDN serves cached pages before PHP runs, so cache-served page views, including live AI user-fetches such as Claude-User and ChatGPT-User, are not captured. Bot crawls of uncached endpoints (sitemap, feeds, assets, cache misses) still appear, which can make capture look healthy while real page views go uncounted.',
      remediation:
        'Exclude AI user-agents from the page cache so their requests reach PHP: LiteSpeed Cache has "Do Not Cache User Agents" under Cache > Excludes; WP Rocket uses the `rocket_cache_reject_ua` filter; W3 Total Cache and WP Super Cache have a "Rejected User Agents" box. Mirror the rule at any CDN in front. For cache-independent capture, ingest from server or edge access logs (a `cloud-run` or `vercel` source, or an edge worker) instead of the WordPress plugin.',
      details: {
        wordpressSourceCount: wpSources.length,
        wordpressSourceIds: wpSources.map((s) => s.id),
      },
    }
  },
}

/**
 * How far a watermark may fall behind before the source is judged not to be
 * keeping up. Traffic syncs run on schedules measured in minutes, so a source
 * hours behind is losing ground every cycle even while it reports success.
 */
export const SYNC_LAG_WARN_MS = 3 * 60 * 60_000

function formatLag(ms: number): string {
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.round((ms % 3_600_000) / 60_000)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

/**
 * Watermark lag, which `traffic.source.recent-data` structurally cannot see.
 *
 * That check asks whether any events landed in the last 7 days. A source that
 * is 24h behind still has a full week of older data, so it reports `ok` while
 * ingestion is falling further behind every cycle. Worse, a source whose
 * adaptive drain advances less wall-clock per sync than the gap between syncs
 * keeps completing successfully with `status: connected` and an empty
 * `lastError` — nothing about the run surfaces the drift.
 *
 * For adapters with a bounded catch-up window (see TRAFFIC_SOURCE_MAX_CATCHUP_MS)
 * that drift is not merely stale data: once the watermark falls past the window,
 * every subsequent sync clamps its start forward and the skipped span is lost
 * until backfilled. This check fails at that boundary and warns well before it,
 * so the condition is caught while the data is still recoverable.
 */
const syncLagCheck: CheckDefinition = {
  id: 'traffic.source.sync-lag',
  category: CheckCategories.integrations,
  scope: CheckScopes.project,
  title: 'Traffic source sync lag',
  run: (ctx) => {
    if (!ctx.project) return skippedNoProject()
    const allSources = loadProbes(ctx)
    const activeSources = allSources.filter(isActiveSource)
    if (allSources.length > 0 && activeSources.length === 0) {
      return {
        status: CheckStatuses.skipped,
        code: 'traffic.sync-lag.no-active-source',
        summary: 'Only paused or staged traffic sources are configured — pull sync lag does not apply.',
      }
    }
    const sources = activeSources.filter(source => !isCloudflareDirectPush(source))
    if (activeSources.length > 0 && sources.length === 0) {
      return {
        status: CheckStatuses.skipped,
        code: 'traffic.sync-lag.push-only',
        summary: 'Only push traffic sources are connected — pull sync lag does not apply.',
      }
    }
    if (sources.length === 0) {
      return {
        status: CheckStatuses.skipped,
        code: 'traffic.sync-lag.no-source',
        summary: 'No traffic source connected — sync lag check skipped.',
      }
    }

    const now = Date.now()
    const measured = sources.map((source) => {
      const syncedMs = source.lastSyncedAt ? Date.parse(source.lastSyncedAt) : Number.NaN
      const lagMs = Number.isFinite(syncedMs) ? now - syncedMs : null
      const catchUpMs = TRAFFIC_SOURCE_MAX_CATCHUP_MS[source.sourceType as keyof typeof TRAFFIC_SOURCE_MAX_CATCHUP_MS]
      return {
        id: source.id,
        sourceType: source.sourceType,
        displayName: source.displayName,
        lastSyncedAt: source.lastSyncedAt,
        lagMs,
        // Discarding NOW: lag has passed what one sync can reach.
        discarding: catchUpMs !== undefined && lagMs !== null && lagMs >= catchUpMs,
        // Discarded EARLIER and not yet recovered. Kept separate from current
        // lag because a skip is not self-healing: the sync that skipped also
        // advanced the watermark, so lag looks fine on the very next pass while
        // the hole remains. Only a backfill covering the span clears this.
        skippedThroughAt: source.skippedThroughAt ?? null,
        catchUpMs: catchUpMs ?? null,
      }
    })

    const details = {
      sources: measured.map((m) => ({
        id: m.id,
        sourceType: m.sourceType,
        displayName: m.displayName,
        lastSyncedAt: m.lastSyncedAt,
        lagMs: m.lagMs,
        maxCatchUpMs: m.catchUpMs,
        discardingOlderTraffic: m.discarding,
        skippedThroughAt: m.skippedThroughAt,
      })),
    }

    // An unrecovered skip fails regardless of current lag. Checking lag alone
    // let the loss state clear itself: the clamping sync advanced the watermark,
    // so the next pass saw normal lag and reported `ok` on a source with a
    // permanent gap.
    const unrecovered = measured.filter((m) => m.skippedThroughAt !== null)
    if (unrecovered.length > 0) {
      const unrecoveredWordpress = unrecovered.filter((m) => m.sourceType === 'wordpress')
      const unrecoveredOtherSources = unrecovered.filter((m) => m.sourceType !== 'wordpress')
      const remediation = [
        unrecoveredWordpress.length > 0
          ? 'For WordPress, do not run generic replace-mode backfill: the plugin feed cannot prove it still retains every bucket in the gap. Keep existing rollups intact and use a retention-aware repair that explicitly declares the unrecoverable span.'
          : null,
        unrecoveredOtherSources.length > 0
          ? 'Recover each non-WordPress gap with `canonry traffic backfill <project> --source <id> --days N --wait`, choosing N so the window reaches back past the skipped instant and stays inside the provider\'s log retention. This clears only when a backfill actually covers the span.'
          : null,
      ].filter((part): part is string => part !== null).join(' ')
      return {
        status: CheckStatuses.fail,
        code: 'traffic.sync-lag.unrecovered-skip',
        summary:
          `${unrecovered.length} traffic source(s) previously skipped traffic that has not been backfilled: `
          + `${unrecovered.map((m) => `${m.displayName} (skipped through ${m.skippedThroughAt})`).join(', ')}. `
          + 'Current lag may look healthy; the gap does not close on its own.',
        remediation,
        details,
      }
    }

    const discarding = measured.filter((m) => m.discarding)
    if (discarding.length > 0) {
      return {
        status: CheckStatuses.fail,
        code: 'traffic.sync-lag.discarding',
        summary:
          `${discarding.length} traffic source(s) are further behind than a single sync can reach, so each sync now skips the oldest traffic instead of ingesting it: `
          + `${discarding.map((m) => `${m.displayName} (${formatLag(m.lagMs!)} behind)`).join(', ')}.`,
        remediation:
          'Data is being lost now. Raise the per-sync drain budget (CANONRY_VERCEL_SYNC_DEADLINE_MS) and/or shorten the sync schedule so the source advances faster than wall-clock. '
          + 'Then recover the skipped span with `canonry traffic backfill <project> --source <id> --days N --wait`, choosing N to cover the gap without exceeding the provider\'s log retention — a bare backfill defaults to 30 days, which is past typical Vercel request-log retention and is rejected rather than silently truncated.',
        details,
      }
    }

    const lagging = measured.filter((m) => m.lagMs !== null && m.lagMs >= SYNC_LAG_WARN_MS)
    if (lagging.length > 0) {
      return {
        status: CheckStatuses.warn,
        code: 'traffic.sync-lag.behind',
        summary:
          `${lagging.length} traffic source(s) are more than ${formatLag(SYNC_LAG_WARN_MS)} behind: `
          + `${lagging.map((m) => `${m.displayName} (${formatLag(m.lagMs!)} behind)`).join(', ')}. `
          + 'Syncs are completing, but the watermark is not keeping up with wall-clock.',
        remediation:
          'Shorten the sync schedule (`canonry schedule set <project> --kind traffic-sync --source <id> --cron "*/10 * * * *"` — `--source` is required for traffic-sync and the call is rejected without it) '
          + 'or raise the per-sync drain budget (CANONRY_VERCEL_SYNC_DEADLINE_MS), so each cycle advances further than the gap between cycles.',
        details,
      }
    }

    // Any never-synced source is reported, even alongside healthy siblings.
    // Requiring ALL of them to be null let one current source mask a sibling
    // that had never ingested anything — the check would return `ok` for a
    // project that was only half-instrumented.
    const neverSynced = measured.filter((m) => m.lagMs === null)
    if (neverSynced.length > 0) {
      return {
        status: CheckStatuses.warn,
        code: 'traffic.sync-lag.never-synced',
        summary: `${neverSynced.length} of ${measured.length} traffic source(s) have never recorded a successful sync: `
          + `${neverSynced.map((m) => m.displayName).join(', ')}.`,
        remediation: 'Run `canonry traffic sync <project> --source <id>` and confirm the source has a schedule.',
        details,
      }
    }

    const worst = measured.reduce((a, b) => ((b.lagMs ?? -1) > (a.lagMs ?? -1) ? b : a))
    return {
      status: CheckStatuses.ok,
      code: 'traffic.sync-lag.current',
      summary: `Traffic sources are current — furthest behind is ${worst.displayName} at ${worst.lagMs === null ? 'never synced' : formatLag(worst.lagMs)}.`,
      details,
    }
  },
}

/** Why the source's most recent recorded Queue sync stopped, or null when none recorded one. */
function lastQueueStopReason(ctx: DoctorContext, sourceId: string): CloudflareQueueDrainStopReason | null {
  const row = ctx.db.select({ syncSummary: runs.syncSummary }).from(runs)
    .where(and(
      eq(runs.projectId, ctx.project!.id),
      eq(runs.kind, RunKinds['traffic-sync']),
      eq(runs.sourceId, sourceId),
      isNotNull(runs.syncSummary),
    ))
    .orderBy(desc(runs.createdAt))
    .limit(1)
    .get()
  return row?.syncSummary?.type === 'cloudflare-queue' ? row.syncSummary.stopReason : null
}

const QUEUE_LIMIT_STOPS: readonly CloudflareQueueDrainStopReason[] = [
  CloudflareQueueDrainStopReasons.deadline,
  CloudflareQueueDrainStopReasons['batch-cap'],
]
const QUEUE_NOT_VISIBLE_STOPS: readonly CloudflareQueueDrainStopReason[] = [
  CloudflareQueueDrainStopReasons['empty-pulls'],
  CloudflareQueueDrainStopReasons['unleased-only'],
]

/** The cause and fix for a residual above the warn count, from why the last syncs stopped. */
function queueResidualCause(stopReasons: readonly (CloudflareQueueDrainStopReason | null)[]): { cause: string; remediation: string } {
  const readRuns = 'Read why each sync stopped with `canonry runs <project> --kind traffic-sync --format json` (`syncSummary.stopReason`).'
  if (stopReasons.every(reason => reason !== null && QUEUE_LIMIT_STOPS.includes(reason))) {
    return {
      cause: 'The drain stopped at its time limit or pull cap before the Queue was empty.',
      remediation: 'If the backlog keeps growing, messages will pass the Queue\'s retention and be dropped. Shorten the traffic-sync schedule interval, or raise `CANONRY_CLOUDFLARE_QUEUE_SYNC_DEADLINE_MS` (default 4 minutes per sync).',
    }
  }
  if (stopReasons.every(reason => reason !== null && QUEUE_NOT_VISIBLE_STOPS.includes(reason))) {
    return {
      cause: 'Cloudflare returned no more messages to pull while still counting them, so they were leased or not yet visible. The drain stopped before its time limit, so raising the limit does not help.',
      remediation: 'Later syncs pull them as they become visible. If the count does not fall across syncs, check the Queue in the Cloudflare dashboard for in-flight or delayed messages before they pass the Queue\'s retention.',
    }
  }
  if (stopReasons.every(reason => reason === CloudflareQueueDrainStopReasons.error)) {
    return {
      cause: 'The last sync failed before the Queue was empty.',
      remediation: `Fix the sync error, then run \`canonry traffic sync <project> --source <id>\`. ${readRuns}`,
    }
  }
  return {
    cause: 'The last sync stopped before the Queue was empty.',
    remediation: `${readRuns} If it hit its time limit, shorten the traffic-sync schedule interval or raise \`CANONRY_CLOUDFLARE_QUEUE_SYNC_DEADLINE_MS\` (default 4 minutes per sync).`,
  }
}

/**
 * A Queue pull sync is intentionally bounded. A successful run can therefore
 * commit useful events while work remains upstream. Persisting and checking
 * Cloudflare's residual depth keeps that state visible between syncs.
 */
const queueBacklogCheck: CheckDefinition = {
  id: 'traffic.source.queue-backlog',
  category: CheckCategories.integrations,
  scope: CheckScopes.project,
  title: 'Cloudflare Queue backlog',
  run: (ctx) => {
    if (!ctx.project) return skippedNoProject()

    const sources = loadProbes(ctx).filter(
      source => isActiveSource(source) && isCloudflareQueuePull(source),
    )
    if (sources.length === 0) {
      return {
        status: CheckStatuses.skipped,
        code: 'traffic.queue-backlog.not-applicable',
        summary: 'No active Cloudflare Queue pull source is connected.',
      }
    }

    const measured = sources.filter(source => source.queueBacklogCount !== null && source.queueBacklogCount !== undefined)
    const stopReasons = new Map(sources.map(source => [source.id, lastQueueStopReason(ctx, source.id)]))
    const details = {
      sources: sources.map(source => ({
        id: source.id,
        displayName: source.displayName,
        queueBacklogCount: source.queueBacklogCount ?? null,
        queueBacklogObservedAt: source.queueBacklogObservedAt ?? null,
        lastStopReason: stopReasons.get(source.id) ?? null,
      })),
    }
    if (measured.length === 0) {
      return {
        status: CheckStatuses.skipped,
        code: 'traffic.queue-backlog.not-observed',
        summary: 'Cloudflare Queue backlog has not been observed yet.',
        remediation: 'Run `canonry traffic sync <project> --source <id>` to pull the Queue and record its residual depth.',
        details,
      }
    }

    const remaining = measured.filter(source => (source.queueBacklogCount ?? 0) > 0)
    const total = remaining.reduce((sum, source) => sum + source.queueBacklogCount!, 0)
    if (total > CLOUDFLARE_QUEUE_RESIDUAL_WARN_COUNT) {
      const { cause, remediation } = queueResidualCause(remaining.map(source => stopReasons.get(source.id) ?? null))
      return {
        status: CheckStatuses.warn,
        code: 'traffic.queue-backlog.remaining',
        summary: `${total.toLocaleString('en-US')} message(s) remained across ${remaining.length} Cloudflare Queue source(s) after the last sync, more than the ${CLOUDFLARE_QUEUE_RESIDUAL_WARN_COUNT.toLocaleString('en-US')} that can arrive while a drain runs. ${cause}`,
        remediation,
        details,
      }
    }

    if (total > 0) {
      return {
        status: CheckStatuses.ok,
        code: 'traffic.queue-backlog.within-drain-budget',
        summary: `${total.toLocaleString('en-US')} message(s) remained after the last sync, within the ${CLOUDFLARE_QUEUE_RESIDUAL_WARN_COUNT.toLocaleString('en-US')} that can arrive while a drain runs.`,
        remediation: 'The next scheduled sync drains these. Run `canonry traffic sync <project> --source <id>` to drain them sooner.',
        details,
      }
    }

    return {
      status: CheckStatuses.ok,
      code: 'traffic.queue-backlog.empty',
      summary: 'The last observed Cloudflare Queue backlog was empty.',
      details,
    }
  },
}

const workerVersionCheck: CheckDefinition = {
  id: 'traffic.source.worker-version',
  category: CheckCategories.integrations,
  scope: CheckScopes.project,
  title: 'Cloudflare Worker version',
  run: (ctx) => {
    if (!ctx.project) return skippedNoProject()

    const sources = loadProbes(ctx).filter(source => isActiveSource(source) && isCloudflareWorkerSource(source))
    if (sources.length === 0) {
      return {
        status: CheckStatuses.skipped,
        code: 'traffic.worker-version.not-applicable',
        summary: 'No active Cloudflare Worker source is connected.',
      }
    }

    const measured = sources.map((source) => {
      // A Worker set to forward page views reports a suffixed version, so a
      // source switched on but not redeployed reads as stale.
      const expectedVersion = cloudflareWorkerVersionFor({ forwardPageViews: source.configJson.forwardPageViews === true })
      const observedVersion = source.lastWorkerVersion
      const state = observedVersion === null
        ? 'waiting-for-first-event'
        : observedVersion === expectedVersion
          ? 'current'
          : 'stale'
      return {
        sourceId: source.id,
        displayName: source.displayName,
        deliveryMode: isCloudflareQueuePull(source)
          ? CloudflareTrafficDeliveryModes['queue-pull']
          : CloudflareTrafficDeliveryModes['direct-push'],
        expectedVersion,
        observedVersion,
        state,
      }
    })
    const details = { sources: measured }
    const stale = measured.filter(source => source.state === 'stale')
    if (stale.length > 0) {
      return {
        status: CheckStatuses.warn,
        code: 'traffic.worker-version.stale',
        summary: `${stale.length} Cloudflare Worker source(s) most recently reported a version that differs from the generated version.`,
        remediation: 'Regenerate and redeploy each source\'s Cloudflare Worker from the credential-owning host with `canonry traffic connect cloudflare <project>` and the source\'s existing delivery-mode options; then verify its route or Queue binding.',
        details,
      }
    }

    const waiting = measured.filter(source => source.state === 'waiting-for-first-event')
    if (waiting.length > 0) {
      return {
        status: CheckStatuses.warn,
        code: 'traffic.worker-version.waiting-for-first-event',
        summary: `${waiting.length} Cloudflare Worker source(s) have not reported a version yet.`,
        remediation: 'Send a smoke-test request through the Worker. For Queue sources, run `canonry traffic sync <project> --source <id>` to consume it. Then run `canonry doctor --project <project>` again.',
        details,
      }
    }

    return {
      status: CheckStatuses.ok,
      code: 'traffic.worker-version.current',
      summary: 'Every Cloudflare Worker source most recently reported the generated version.',
      details,
    }
  },
}

export const TRAFFIC_SOURCE_CHECKS: readonly CheckDefinition[] = [
  sourceConnectedCheck,
  recentDataCheck,
  syncLagCheck,
  queueBacklogCheck,
  workerVersionCheck,
  credentialsCheck,
  scopesCheck,
  cacheBlindSpotCheck,
]
