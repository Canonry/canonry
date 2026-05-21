import crypto from 'node:crypto'
import { Agent as UndiciAgent } from 'undici'
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  trafficSources,
  crawlerEventsHourly,
  aiUserFetchEventsHourly,
  aiReferralEventsHourly,
  rawEventSamples,
  runs,
} from '@ainyc/canonry-db'
import {
  notFound,
  providerError,
  validationError,
  RunKinds,
  RunStatuses,
  RunTriggers,
  TrafficSourceStatuses,
  TrafficSourceTypes,
  TrafficSourceAuthModes,
  TrafficEventKinds,
  trafficConnectWordpressRequestSchema,
  trafficConnectVercelRequestSchema,
} from '@ainyc/canonry-contracts'
import type {
  NormalizedTrafficRequest,
  RunStatus,
  TrafficSourceDto,
  TrafficSourceDetailDto,
  TrafficSourceListResponse,
  TrafficStatusResponse,
  TrafficSyncResponse,
  TrafficBackfillResponse,
  TrafficSourceStatus,
  TrafficSourceAuthMode,
  TrafficEventEntry,
  TrafficEventKind,
  TrafficEventsResponse,
} from '@ainyc/canonry-contracts'
import {
  listCloudRunTrafficEvents,
  getCloudLoggingAccessToken,
} from '@ainyc/canonry-integration-cloud-run'
import type {
  CloudRunTrafficEventsPage,
  ListCloudRunTrafficEventsOptions,
} from '@ainyc/canonry-integration-cloud-run'
import { buildTrafficProbeReport } from '@ainyc/canonry-integration-traffic'
import {
  listWordpressTrafficEvents,
  WordpressTrafficApiError,
} from '@ainyc/canonry-integration-wordpress-traffic'
import type {
  ListWordpressTrafficEventsOptions,
  WordpressTrafficEventsPage,
} from '@ainyc/canonry-integration-wordpress-traffic'
import {
  listVercelTrafficEvents,
  VercelLogsApiError,
} from '@ainyc/canonry-integration-vercel'
import type {
  ListVercelTrafficEventsOptions,
  VercelTrafficEventsPage,
} from '@ainyc/canonry-integration-vercel'
import { resolveProject, writeAuditLog } from './helpers.js'
import { resolveWebhookTarget } from './webhooks.js'

export interface CloudRunCredentialRecord {
  projectName: string
  gcpProjectId: string
  serviceName?: string
  location?: string
  authMode: TrafficSourceAuthMode
  clientEmail?: string
  privateKey?: string
  refreshToken?: string
  tokenExpiresAt?: string
  scopes?: string[]
  createdAt: string
  updatedAt: string
}

export interface CloudRunCredentialStore {
  getConnection: (projectName: string) => CloudRunCredentialRecord | undefined
  upsertConnection: (record: CloudRunCredentialRecord) => CloudRunCredentialRecord
  deleteConnection: (projectName: string) => boolean
}

export interface WordpressTrafficCredentialRecord {
  projectName: string
  baseUrl: string
  username: string
  applicationPassword: string
  createdAt: string
  updatedAt: string
}

export interface WordpressTrafficCredentialStore {
  getConnection: (projectName: string) => WordpressTrafficCredentialRecord | undefined
  upsertConnection: (record: WordpressTrafficCredentialRecord) => WordpressTrafficCredentialRecord
  deleteConnection: (projectName: string) => boolean
}

export interface VercelTrafficCredentialRecord {
  projectName: string
  /** Vercel project id (`prj_...`). */
  projectId: string
  /** Vercel team / owner id (`team_...`). */
  teamId: string
  /** Vercel API token (personal access token). The only secret in this record. */
  token: string
  /** Deployment environment whose request logs are pulled. */
  environment: 'production' | 'preview'
  createdAt: string
  updatedAt: string
}

export interface VercelTrafficCredentialStore {
  getConnection: (projectName: string) => VercelTrafficCredentialRecord | undefined
  upsertConnection: (record: VercelTrafficCredentialRecord) => VercelTrafficCredentialRecord
  deleteConnection: (projectName: string) => boolean
}

export interface TrafficSyncedEvent {
  /** 'completed' = transactional rollup write succeeded. 'failed' = pull or auth failed before any rollup writes. */
  status: 'completed' | 'failed'
  /** Stable enum value (e.g. 'cloud-run', 'wp-plugin'). Mirrors `traffic_sources.source_type`. */
  sourceType: string
  /** Source row UUID — opaque, no PII. */
  sourceId: string
  /** Number of normalized events processed (post-dedupe). 0 for failed syncs. */
  pulledEvents: number
  /** Crawler hourly bucket inserts/updates. 0 for failed syncs. */
  crawlerHits: number
  /** AI user-fetch hourly bucket inserts/updates (ChatGPT-User, Perplexity-User, …). 0 for failed syncs. */
  aiUserFetchHits: number
  /** AI-referral hourly bucket inserts/updates. 0 for failed syncs. */
  aiReferralHits: number
  /** End-to-end duration including pull, classification, rollup write. */
  durationMs: number
  /** Stable error code on failure. Present only when status === 'failed'. */
  errorCode?: 'NO_CREDENTIAL' | 'PROVIDER_AUTH' | 'PROVIDER_PULL' | 'INTERNAL'
}

export interface TrafficRoutesOptions {
  cloudRunCredentialStore?: CloudRunCredentialStore
  /** Override the Cloud Run pull function (for tests). Defaults to `listCloudRunTrafficEvents`. */
  pullCloudRunEvents?: (
    accessToken: string,
    options: ListCloudRunTrafficEventsOptions,
  ) => Promise<CloudRunTrafficEventsPage>
  /** Override the access-token resolver (for tests). Defaults to service-account JWT exchange. */
  resolveCloudRunAccessToken?: (record: CloudRunCredentialRecord) => Promise<string>
  /**
   * Store for WordPress traffic-logger Application Password credentials. When
   * absent, the WordPress connect / sync routes return a configuration error.
   */
  wordpressTrafficCredentialStore?: WordpressTrafficCredentialStore
  /** Override the WordPress traffic pull function (for tests). Defaults to `listWordpressTrafficEvents`. */
  pullWordpressTrafficEvents?: (
    options: ListWordpressTrafficEventsOptions,
  ) => Promise<WordpressTrafficEventsPage>
  /**
   * Store for Vercel traffic API-token credentials. When absent, the Vercel
   * connect / sync routes return a configuration error.
   */
  vercelTrafficCredentialStore?: VercelTrafficCredentialStore
  /** Override the Vercel traffic pull function (for tests). Defaults to `listVercelTrafficEvents`. */
  pullVercelTrafficEvents?: (
    options: ListVercelTrafficEventsOptions,
  ) => Promise<VercelTrafficEventsPage>
  /**
   * Max `request-logs` pages to walk per Vercel sync. Vercel paginates by page
   * number within a fixed time window with no resumable cursor, so a sync must
   * drain the whole window in one pass — if the budget is exhausted with
   * `hasMore` still true, the sync fails rather than advancing the cursor past
   * un-pulled rows.
   */
  defaultVercelMaxPages?: number
  /** Default lookback window in minutes when a sync is triggered without an explicit `since`. */
  defaultSyncWindowMinutes?: number
  /** Default page size for entries.list pulls. */
  defaultPageSize?: number
  /** Default max pages for entries.list pulls. */
  defaultMaxPages?: number
  /**
   * Default page size for the WordPress traffic puller. WP uses opaque-cursor
   * pagination, so this is a per-page cap rather than a window size.
   */
  defaultWordpressPageSize?: number
  /**
   * Default max pages per WordPress sync invocation. Bounds the fan-out of a
   * single sync so a misconfigured cursor or runaway plugin can't exhaust the
   * route — the next sync resumes from the persisted cursor.
   */
  defaultWordpressMaxPages?: number
  /** Cap on the number of raw_event_samples written per sync. */
  defaultSampleLimit?: number
  /** Fire-and-forget hook called after every sync completes (success OR failure). Used by canonry to emit telemetry. */
  onTrafficSynced?: (event: TrafficSyncedEvent) => void
  /**
   * Allow WordPress `baseUrl` to resolve to a loopback address. Mirrors
   * `allowLoopbackWebhooks` on the parent `ApiRoutesOptions` — only enabled by
   * the local `canonry serve` so dev users can point at `http://localhost`.
   * Cloud deployments leave this off so an API-key holder cannot coerce the
   * server into fetching its own metadata service or sidecar admin endpoints
   * with the attached Basic-auth credentials.
   */
  allowLoopbackWebhooks?: boolean
}

const DEFAULT_SYNC_WINDOW_MINUTES = 43_200
const DEFAULT_PAGE_SIZE = 1000
const DEFAULT_MAX_PAGES = 5
const DEFAULT_SAMPLE_LIMIT = 100
// WordPress traffic pulls page through the plugin via opaque cursors rather
// than a time window. Caps below match Cloud Run's per-sync budget shape:
// a moderate page size with a bounded fan-out so a misconfigured cursor or
// runaway plugin can't exhaust the route. Adjust via TrafficRoutesOptions.
const DEFAULT_WP_PAGE_SIZE = 500
const DEFAULT_WP_MAX_PAGES = 20
// Vercel's `request-logs` endpoint paginates by page number within a fixed
// `[startDate, endDate]` window and exposes no resumable page cursor — so a
// sync must drain the entire window in one pass. This budget is generous
// enough that an incremental sync (window clamped forward to `lastSyncedAt`)
// never hits it; if it does, the sync fails loudly rather than advancing
// `lastSyncedAt` past the un-pulled pages. Backfill uses BACKFILL_MAX_PAGES.
const DEFAULT_VERCEL_MAX_PAGES = 50
// Bounded ring buffer of the most-recent normalized event IDs from the last
// sync. Used to dedupe events that fall in the small overlap window between
// `lastSyncedAt` and the new sync's `windowStart`. Sized for the practical
// boundary case (a few seconds of overlap × peak QPS) — well above what a
// realistic Cloud Logging burst produces in that window.
const MAX_TRACKED_EVENT_IDS = 1_000
// Backfill knobs. The 30-day cap matches Cloud Logging `_Default` retention —
// requesting more produces empty results from GCP, so we clamp rather than
// silently waste round-trips. Page budget is generous because backfill is a
// one-shot operation; a busy site with ~30K events/30d still completes in well
// under a minute.
const DEFAULT_BACKFILL_DAYS = 30
const MAX_BACKFILL_DAYS = 90
const BACKFILL_MAX_PAGES = 1_000
const BACKFILL_SAMPLE_LIMIT = 500

function parseSourceConfig(row: typeof trafficSources.$inferSelect): Record<string, unknown> {
  return row.configJson
}

function rowToDto(row: typeof trafficSources.$inferSelect): TrafficSourceDto {
  return {
    id: row.id,
    projectId: row.projectId,
    sourceType: row.sourceType as TrafficSourceDto['sourceType'],
    displayName: row.displayName,
    status: row.status as TrafficSourceStatus,
    lastSyncedAt: row.lastSyncedAt ?? null,
    lastCursor: row.lastCursor ?? null,
    lastError: row.lastError ?? null,
    archivedAt: row.archivedAt ?? null,
    config: parseSourceConfig(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function defaultResolveAccessToken(record: CloudRunCredentialRecord): Promise<string> {
  if (record.authMode === TrafficSourceAuthModes['service-account']) {
    if (!record.clientEmail || !record.privateKey) {
      throw validationError('Service-account credentials missing client_email or private_key')
    }
    return getCloudLoggingAccessToken(record.clientEmail, record.privateKey)
  }
  throw validationError(
    'OAuth-mode Cloud Run sync is not yet supported in v1. Provide a service-account key file.',
  )
}

/**
 * Per-source-type pull function for a backfill window. Receives the
 * `[windowStart, windowEnd)` bounds and returns a flat list of
 * `NormalizedTrafficRequest` for the entire window. Each adapter handles
 * its own pagination internally (Cloud Run via nextPageToken, WordPress
 * via opaque cursor against `since`/`until` on the plugin endpoint).
 *
 * Returning the events directly keeps the shared rollup-write path source-
 * agnostic and bounds error attribution: anything thrown here surfaces as
 * a "pull failed" run failure with the adapter-specific prefix from the
 * route's closure.
 */
type BackfillPullFn = () => Promise<NormalizedTrafficRequest[]>

interface RunBackfillTaskOptions {
  app: FastifyInstance
  runId: string
  project: { id: string; name: string }
  sourceRow: typeof trafficSources.$inferSelect
  windowStart: Date
  windowEnd: Date
  /**
   * Adapter-supplied window pull. Closure encloses the per-source-type
   * credentials, page-size budget, and pagination. See `BackfillPullFn`.
   */
  pullForBackfill: BackfillPullFn
  /**
   * Prefix for the user-visible failure message when `pullForBackfill`
   * throws. Cloud Run uses "Cloud Run pull failed", WordPress uses
   * "WordPress pull failed" — keeps the run-failure surface attributable
   * without coupling the task itself to a source type.
   */
  pullErrorPrefix: string
}

async function runBackfillTask(options: RunBackfillTaskOptions): Promise<void> {
  const {
    app,
    runId,
    project,
    sourceRow,
    windowStart,
    windowEnd,
    pullForBackfill,
    pullErrorPrefix,
  } = options

  const markFailed = (msg: string) => {
    const failedAt = new Date().toISOString()
    try {
      app.db.transaction((tx) => {
        tx
          .update(runs)
          .set({ status: RunStatuses.failed, error: msg, finishedAt: failedAt })
          .where(eq(runs.id, runId))
          .run()
        tx
          .update(trafficSources)
          .set({ status: TrafficSourceStatuses.error, lastError: msg, updatedAt: failedAt })
          .where(eq(trafficSources.id, sourceRow.id))
          .run()
      })
    } catch {
      // Last-ditch — if even the failure-recording transaction throws, we
      // can't surface it anywhere without crashing the process. The run row
      // will stay 'running' until the next sync overwrites it.
    }
  }

  let allEvents: NormalizedTrafficRequest[]
  try {
    allEvents = await pullForBackfill()
  } catch (e) {
    markFailed(`${pullErrorPrefix}: ${e instanceof Error ? e.message : String(e)}`)
    return
  }

  // Empty pull — could be a misconfigured serviceName / WP plugin not
  // serving the window, transient upstream glitch, or a genuinely quiet
  // site. Treat as a no-op: skip the destructive replace below so existing
  // rollup data isn't silently wiped, and just close out the run row.
  if (allEvents.length === 0) {
    const finishedAt = new Date().toISOString()
    try {
      app.db
        .update(runs)
        .set({ status: RunStatuses.completed, finishedAt })
        .where(eq(runs.id, runId))
        .run()
    } catch {
      // swallow — same last-ditch behavior as markFailed
    }
    return
  }

  const report = buildTrafficProbeReport(allEvents, { sampleLimit: BACKFILL_SAMPLE_LIMIT })
  const finishedAt = new Date().toISOString()
  const windowStartIso = windowStart.toISOString()
  const windowEndIso = windowEnd.toISOString()

  // Reseed the cross-sync dedup ring with the most-recent IDs from the
  // backfill so subsequent incremental syncs continue to dedupe at the
  // boundary. lastSyncedAt advances to max(current, backfillEnd) — never
  // backwards, so a backfill never undoes incremental progress that ran
  // ahead of it.
  const newSorted = allEvents
    .slice()
    .sort((a, b) => (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : 0))
    .map((e) => e.eventId)
  const newRingBuffer = newSorted.slice(0, MAX_TRACKED_EVENT_IDS)
  const currentLastSyncedMs = sourceRow.lastSyncedAt
    ? new Date(sourceRow.lastSyncedAt).getTime()
    : Number.NEGATIVE_INFINITY
  // Advance to windowEnd (the pull's upper bound), not finishedAt — see the
  // sync-route comment for why. Backfill never moves the cursor backwards.
  const nextLastSyncedAt = Math.max(currentLastSyncedMs, windowEnd.getTime()) === windowEnd.getTime()
    ? windowEndIso
    : sourceRow.lastSyncedAt!

  try {
    app.db.transaction((tx) => {
      // Replace mode: clear the rollup window first, then ingest fresh.
      // Boundaries are inclusive on both ends; windowStart is hour-floored
      // upstream so the boundary hour gets cleanly deleted and reinserted.
      tx
        .delete(crawlerEventsHourly)
        .where(
          and(
            eq(crawlerEventsHourly.sourceId, sourceRow.id),
            gte(crawlerEventsHourly.tsHour, windowStartIso),
            lte(crawlerEventsHourly.tsHour, windowEndIso),
          ),
        )
        .run()
      tx
        .delete(aiUserFetchEventsHourly)
        .where(
          and(
            eq(aiUserFetchEventsHourly.sourceId, sourceRow.id),
            gte(aiUserFetchEventsHourly.tsHour, windowStartIso),
            lte(aiUserFetchEventsHourly.tsHour, windowEndIso),
          ),
        )
        .run()
      tx
        .delete(aiReferralEventsHourly)
        .where(
          and(
            eq(aiReferralEventsHourly.sourceId, sourceRow.id),
            gte(aiReferralEventsHourly.tsHour, windowStartIso),
            lte(aiReferralEventsHourly.tsHour, windowEndIso),
          ),
        )
        .run()
      tx
        .delete(rawEventSamples)
        .where(
          and(
            eq(rawEventSamples.sourceId, sourceRow.id),
            gte(rawEventSamples.ts, windowStartIso),
            lte(rawEventSamples.ts, windowEndIso),
          ),
        )
        .run()

      for (const bucket of report.crawlerEventsHourly) {
        tx
          .insert(crawlerEventsHourly)
          .values({
            projectId: project.id,
            sourceId: sourceRow.id,
            tsHour: bucket.tsHour,
            botId: bucket.botId,
            operator: bucket.operator,
            verificationStatus: bucket.verificationStatus,
            pathNormalized: bucket.pathNormalized,
            status: bucket.status ?? 0,
            hits: bucket.hits,
            sampledUserAgent: bucket.sampledUserAgent,
            createdAt: finishedAt,
            updatedAt: finishedAt,
          })
          .run()
      }

      for (const bucket of report.aiUserFetchEventsHourly) {
        tx
          .insert(aiUserFetchEventsHourly)
          .values({
            projectId: project.id,
            sourceId: sourceRow.id,
            tsHour: bucket.tsHour,
            botId: bucket.botId,
            operator: bucket.operator,
            verificationStatus: bucket.verificationStatus,
            pathNormalized: bucket.pathNormalized,
            status: bucket.status ?? 0,
            hits: bucket.hits,
            sampledUserAgent: bucket.sampledUserAgent,
            createdAt: finishedAt,
            updatedAt: finishedAt,
          })
          .run()
      }

      for (const bucket of report.aiReferralEventsHourly) {
        tx
          .insert(aiReferralEventsHourly)
          .values({
            projectId: project.id,
            sourceId: sourceRow.id,
            tsHour: bucket.tsHour,
            product: bucket.product,
            operator: bucket.operator,
            sourceDomain: bucket.sourceDomain,
            evidenceType: bucket.evidenceType,
            landingPathNormalized: bucket.landingPathNormalized,
            status: bucket.status ?? 0,
            sessionsOrHits: bucket.hits,
            usersEstimated: null,
            createdAt: finishedAt,
            updatedAt: finishedAt,
          })
          .run()
      }

      for (const sample of report.samples) {
        const eventType = sample.crawler
          ? 'crawler'
          : sample.aiUserFetch
            ? 'ai_user_fetch'
            : sample.aiReferral
              ? 'ai_referral'
              : 'unknown'
        const refererHost = (() => {
          if (!sample.referer) return null
          try {
            return new URL(sample.referer).hostname
          } catch {
            return null
          }
        })()
        tx
          .insert(rawEventSamples)
          .values({
            id: crypto.randomUUID(),
            projectId: project.id,
            sourceId: sourceRow.id,
            ts: sample.observedAt,
            eventType,
            ipHash: null,
            userAgent: sample.userAgent,
            pathNormalized: sample.pathNormalized,
            status: sample.status,
            refererHost,
            classifierDetailsJson: {
              crawler: sample.crawler,
              aiUserFetch: sample.aiUserFetch,
              aiReferral: sample.aiReferral,
            },
            createdAt: finishedAt,
          })
          .run()
      }

      tx
        .update(trafficSources)
        .set({
          status: TrafficSourceStatuses.connected,
          lastSyncedAt: nextLastSyncedAt,
          lastError: null,
          lastEventIds: newRingBuffer,
          updatedAt: finishedAt,
        })
        .where(eq(trafficSources.id, sourceRow.id))
        .run()

      tx
        .update(runs)
        .set({ status: RunStatuses.completed, finishedAt })
        .where(eq(runs.id, runId))
        .run()
    })
  } catch (e) {
    markFailed(`Backfill rollup write failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export async function trafficRoutes(app: FastifyInstance, opts: TrafficRoutesOptions) {
  const pullEvents = opts.pullCloudRunEvents ?? listCloudRunTrafficEvents
  const resolveAccessToken = opts.resolveCloudRunAccessToken ?? defaultResolveAccessToken
  const pullWordpressEvents = opts.pullWordpressTrafficEvents ?? listWordpressTrafficEvents
  const pullVercelEvents = opts.pullVercelTrafficEvents ?? listVercelTrafficEvents
  const allowLoopback = opts.allowLoopbackWebhooks === true

  /**
   * SSRF guard for the operator-supplied WordPress `baseUrl`. Every pull-side
   * call into `pullWordpressEvents` attaches Basic-auth credentials, so we
   * resolve the host before each fetch and refuse private / link-local /
   * metadata addresses. Loopback is opt-in via `allowLoopbackWebhooks` to
   * preserve the local dev experience without ever shipping that capability
   * to cloud.
   *
   * Returns an undici `Dispatcher` whose `connect.lookup` is pinned to the
   * IP we just validated, so the subsequent `fetch` cannot be coerced into
   * a different address via DNS rebinding between validation and request.
   * The dispatcher is passed straight to `listWordpressTrafficEvents`, which
   * forwards it to `fetch(url, { dispatcher })`. Re-validating on every
   * sync (not just at connect time) closes the DNS-flip window where a
   * public-IP domain becomes a private-IP one between syncs.
   */
  async function assertWordpressTargetAllowed(baseUrl: string): Promise<UndiciAgent> {
    const check = await resolveWebhookTarget(baseUrl, { allowLoopback })
    if (!check.ok) {
      throw validationError(`WordPress baseUrl rejected: ${check.message}`)
    }
    const { address, family } = check.target
    return new UndiciAgent({
      connect: {
        lookup: (_hostname, _options, cb) => {
          // Always resolve to the pre-validated public IP, regardless of
          // what the OS resolver would return now. Closes the rebinding
          // TOCTOU between `resolveWebhookTarget` above and the fetch
          // performed inside the WordPress integration package.
          cb(null, address, family === 6 ? 6 : 4)
        },
      },
    })
  }
  // Keep the live pinned dispatchers around so they can be `close()`d after
  // the request finishes — undici pools sockets internally, so dropping the
  // reference without closing leaks the agent.
  async function withPinnedWordpressDispatcher<T>(
    baseUrl: string,
    fn: (dispatcher: UndiciAgent) => Promise<T>,
  ): Promise<T> {
    const dispatcher = await assertWordpressTargetAllowed(baseUrl)
    try {
      return await fn(dispatcher)
    } finally {
      await dispatcher.close().catch(() => {})
    }
  }
  const vercelMaxPages = opts.defaultVercelMaxPages ?? DEFAULT_VERCEL_MAX_PAGES
  const syncWindowMinutes = opts.defaultSyncWindowMinutes ?? DEFAULT_SYNC_WINDOW_MINUTES
  const pageSize = opts.defaultPageSize ?? DEFAULT_PAGE_SIZE
  const maxPages = opts.defaultMaxPages ?? DEFAULT_MAX_PAGES
  const sampleLimit = opts.defaultSampleLimit ?? DEFAULT_SAMPLE_LIMIT

  // POST /projects/:name/traffic/connect/cloud-run
  app.post<{
    Params: { name: string }
    Body: {
      gcpProjectId?: string
      serviceName?: string
      location?: string
      displayName?: string
      keyJson?: string
    }
  }>('/projects/:name/traffic/connect/cloud-run', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const body = request.body ?? {}
    const { gcpProjectId, serviceName, location, displayName, keyJson } = body

    if (!gcpProjectId || typeof gcpProjectId !== 'string') {
      throw validationError('gcpProjectId is required')
    }
    if (!keyJson) {
      throw validationError(
        'keyJson is required for v1 (service-account JSON content). OAuth-mode Cloud Run is not yet supported.',
      )
    }
    if (!opts.cloudRunCredentialStore) {
      throw validationError('Cloud Run credential storage is not configured for this deployment')
    }

    let parsed: { client_email?: string; private_key?: string }
    try {
      parsed = JSON.parse(keyJson) as { client_email?: string; private_key?: string }
    } catch {
      throw validationError('Invalid JSON in keyJson')
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw validationError('Service-account JSON must contain client_email and private_key')
    }

    const now = new Date().toISOString()
    const existing = opts.cloudRunCredentialStore.getConnection(project.name)
    opts.cloudRunCredentialStore.upsertConnection({
      projectName: project.name,
      gcpProjectId,
      serviceName: serviceName ?? undefined,
      location: location ?? undefined,
      authMode: TrafficSourceAuthModes['service-account'],
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })

    // Find an existing non-archived source for this (project, sourceType).
    // v1 supports a single active Cloud Run source per project; reconnect updates it.
    const activeSource = app.db
      .select()
      .from(trafficSources)
      .where(eq(trafficSources.projectId, project.id))
      .all()
      .find((row) => row.sourceType === TrafficSourceTypes['cloud-run'] && row.status !== TrafficSourceStatuses.archived)

    const config: Record<string, unknown> = {
      gcpProjectId,
      serviceName: serviceName ?? null,
      location: location ?? null,
      authMode: TrafficSourceAuthModes['service-account'],
    }
    const fallbackName = displayName ?? `Cloud Run · ${gcpProjectId}${serviceName ? ` / ${serviceName}` : ''}`

    let sourceRow: typeof trafficSources.$inferSelect
    if (activeSource) {
      app.db
        .update(trafficSources)
        .set({
          displayName: fallbackName,
          status: TrafficSourceStatuses.connected,
          lastError: null,
          configJson: config,
          updatedAt: now,
        })
        .where(eq(trafficSources.id, activeSource.id))
        .run()
      sourceRow = app.db
        .select()
        .from(trafficSources)
        .where(eq(trafficSources.id, activeSource.id))
        .get()!
    } else {
      const newId = crypto.randomUUID()
      app.db
        .insert(trafficSources)
        .values({
          id: newId,
          projectId: project.id,
          sourceType: TrafficSourceTypes['cloud-run'],
          displayName: fallbackName,
          status: TrafficSourceStatuses.connected,
          lastSyncedAt: null,
          lastCursor: null,
          lastError: null,
          archivedAt: null,
          configJson: config,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      sourceRow = app.db
        .select()
        .from(trafficSources)
        .where(eq(trafficSources.id, newId))
        .get()!
    }

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'traffic.cloud-run.connected',
      entityType: 'traffic_source',
      entityId: sourceRow.id,
    })

    return rowToDto(sourceRow)
  })

  // POST /projects/:name/traffic/connect/wordpress
  //
  // Probes the WordPress traffic-logger plugin endpoint with the supplied
  // Application Password (single-page, limit=1) before persisting — a probe
  // failure surfaces as `providerError()` so the caller sees a meaningful
  // diagnostic up front instead of discovering it at the first sync.
  app.post<{
    Params: { name: string }
    Body: {
      baseUrl?: string
      username?: string
      applicationPassword?: string
      displayName?: string
    }
  }>('/projects/:name/traffic/connect/wordpress', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    if (!opts.wordpressTrafficCredentialStore) {
      throw validationError('WordPress traffic credential storage is not configured for this deployment')
    }
    const credentialStore = opts.wordpressTrafficCredentialStore

    const parsed = trafficConnectWordpressRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw validationError(parsed.error.issues.map((i) => i.message).join('; '))
    }
    const { baseUrl, username, applicationPassword, displayName } = parsed.data

    // SSRF guard: the probe attaches Basic-auth creds, so refuse any baseUrl
    // that resolves to a private / loopback / link-local address before the
    // fetch goes out. Without this check an API-key holder can target the
    // host's metadata service (169.254.169.254, metadata.google.internal),
    // RFC1918 ranges, or sidecar admin endpoints — and the error body
    // bubbles back through providerError below.
    //
    // The returned dispatcher pins DNS to the validated IP, so the probe's
    // fetch can't be steered to a different address by DNS rebinding in the
    // window between validation and request.
    await withPinnedWordpressDispatcher(baseUrl, async (dispatcher) => {
      // Probe the plugin endpoint up-front so the caller learns about a bad
      // URL / wrong credential before we touch any persistent state.
      try {
        await pullWordpressEvents({
          baseUrl,
          username,
          applicationPassword,
          pageSize: 1,
          maxPages: 1,
          dispatcher,
        })
      } catch (e) {
        if (e instanceof WordpressTrafficApiError) {
          throw providerError(
            `WordPress traffic probe failed (HTTP ${e.status}): ${e.message}${e.body ? ` — ${e.body}` : ''}`,
          )
        }
        const msg = e instanceof Error ? e.message : String(e)
        throw providerError(`WordPress traffic probe failed: ${msg}`)
      }
    })

    const now = new Date().toISOString()
    const existing = credentialStore.getConnection(project.name)
    credentialStore.upsertConnection({
      projectName: project.name,
      baseUrl,
      username,
      applicationPassword,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })

    // Single active WordPress source per project; reconnect updates it.
    const activeSource = app.db
      .select()
      .from(trafficSources)
      .where(eq(trafficSources.projectId, project.id))
      .all()
      .find((row) => row.sourceType === TrafficSourceTypes.wordpress && row.status !== TrafficSourceStatuses.archived)

    // Only non-secret config goes on the row — the Application Password lives
    // in ~/.canonry/config.yaml via the credential store.
    const config: Record<string, unknown> = { baseUrl, username }
    const fallbackName = displayName ?? `WordPress · ${new URL(baseUrl).host}`

    let sourceRow: typeof trafficSources.$inferSelect
    if (activeSource) {
      app.db
        .update(trafficSources)
        .set({
          displayName: fallbackName,
          status: TrafficSourceStatuses.connected,
          lastError: null,
          configJson: config,
          updatedAt: now,
        })
        .where(eq(trafficSources.id, activeSource.id))
        .run()
      sourceRow = app.db
        .select()
        .from(trafficSources)
        .where(eq(trafficSources.id, activeSource.id))
        .get()!
    } else {
      const newId = crypto.randomUUID()
      app.db
        .insert(trafficSources)
        .values({
          id: newId,
          projectId: project.id,
          sourceType: TrafficSourceTypes.wordpress,
          displayName: fallbackName,
          status: TrafficSourceStatuses.connected,
          lastSyncedAt: null,
          lastCursor: null,
          lastError: null,
          archivedAt: null,
          configJson: config,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      sourceRow = app.db
        .select()
        .from(trafficSources)
        .where(eq(trafficSources.id, newId))
        .get()!
    }

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'traffic.wordpress.connected',
      entityType: 'traffic_source',
      entityId: sourceRow.id,
    })

    return rowToDto(sourceRow)
  })

  // POST /projects/:name/traffic/connect/vercel
  //
  // Probes Vercel's internal `request-logs` endpoint with the supplied API
  // token (single page, tiny recent window) before persisting — a probe
  // failure surfaces as `providerError()` so the caller sees a bad token /
  // wrong project or team id up front instead of at the first sync.
  app.post<{
    Params: { name: string }
    Body: {
      projectId?: string
      teamId?: string
      token?: string
      environment?: string
      displayName?: string
    }
  }>('/projects/:name/traffic/connect/vercel', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    if (!opts.vercelTrafficCredentialStore) {
      throw validationError('Vercel traffic credential storage is not configured for this deployment')
    }
    const credentialStore = opts.vercelTrafficCredentialStore

    const parsed = trafficConnectVercelRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw validationError(parsed.error.issues.map((i) => i.message).join('; '))
    }
    const { projectId, teamId, token, displayName } = parsed.data
    const environment = parsed.data.environment ?? 'production'

    // Probe the request-logs endpoint up-front so the caller learns about a
    // bad token / wrong project or team id before we touch persistent state.
    // A 60-minute window keeps the probe cheap; we only need an HTTP 2xx.
    const probeEnd = Date.now()
    try {
      await pullVercelEvents({
        token,
        projectId,
        teamId,
        environment,
        startDate: probeEnd - 60 * 60_000,
        endDate: probeEnd,
        maxPages: 1,
      })
    } catch (e) {
      if (e instanceof VercelLogsApiError) {
        throw providerError(
          `Vercel traffic probe failed (HTTP ${e.status}): ${e.message}${e.body ? ` — ${e.body}` : ''}`,
        )
      }
      const msg = e instanceof Error ? e.message : String(e)
      throw providerError(`Vercel traffic probe failed: ${msg}`)
    }

    const now = new Date().toISOString()
    const existing = credentialStore.getConnection(project.name)
    credentialStore.upsertConnection({
      projectName: project.name,
      projectId,
      teamId,
      token,
      environment,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })

    // Single active Vercel source per project; reconnect updates it.
    const activeSource = app.db
      .select()
      .from(trafficSources)
      .where(eq(trafficSources.projectId, project.id))
      .all()
      .find((row) => row.sourceType === TrafficSourceTypes.vercel && row.status !== TrafficSourceStatuses.archived)

    // Only non-secret config goes on the row — the API token lives in
    // ~/.canonry/config.yaml via the credential store.
    const config: Record<string, unknown> = { projectId, teamId, environment }
    const fallbackName = displayName ?? `Vercel · ${projectId}`

    let sourceRow: typeof trafficSources.$inferSelect
    if (activeSource) {
      app.db
        .update(trafficSources)
        .set({
          displayName: fallbackName,
          status: TrafficSourceStatuses.connected,
          lastError: null,
          configJson: config,
          updatedAt: now,
        })
        .where(eq(trafficSources.id, activeSource.id))
        .run()
      sourceRow = app.db
        .select()
        .from(trafficSources)
        .where(eq(trafficSources.id, activeSource.id))
        .get()!
    } else {
      const newId = crypto.randomUUID()
      app.db
        .insert(trafficSources)
        .values({
          id: newId,
          projectId: project.id,
          sourceType: TrafficSourceTypes.vercel,
          displayName: fallbackName,
          status: TrafficSourceStatuses.connected,
          lastSyncedAt: null,
          lastCursor: null,
          lastError: null,
          archivedAt: null,
          configJson: config,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      sourceRow = app.db
        .select()
        .from(trafficSources)
        .where(eq(trafficSources.id, newId))
        .get()!
    }

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'traffic.vercel.connected',
      entityType: 'traffic_source',
      entityId: sourceRow.id,
    })

    return rowToDto(sourceRow)
  })

  // POST /projects/:name/traffic/sources/:id/sync
  //
  // Source-type-agnostic shell. The handler resolves the source row, sets up
  // the run row and shared error path, then dispatches to one of two
  // per-source adapters that each return `{ events, nextCursor? }`. Cloud Run
  // uses a clamped time window; WordPress pages through an opaque cursor.
  // Everything from dedupe through rollup transaction to telemetry/audit log
  // is shared.
  app.post<{
    Params: { name: string; id: string }
    Body: { sinceMinutes?: number }
  }>('/projects/:name/traffic/sources/:id/sync', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const sourceRow = app.db
      .select()
      .from(trafficSources)
      .where(eq(trafficSources.id, request.params.id))
      .get()
    if (!sourceRow || sourceRow.projectId !== project.id) {
      throw notFound('Traffic source', request.params.id)
    }
    if (
      sourceRow.sourceType !== TrafficSourceTypes['cloud-run']
      && sourceRow.sourceType !== TrafficSourceTypes.wordpress
      && sourceRow.sourceType !== TrafficSourceTypes.vercel
    ) {
      throw validationError(
        `Sync for source type "${sourceRow.sourceType}" is not implemented yet — only cloud-run, wordpress, and vercel are supported in v1.`,
      )
    }

    // windowEnd is "sync started at" — used as the upper bound of the Cloud
    // Run time window and as the value we advance `lastSyncedAt` to on
    // success. WP doesn't use it for the actual pull (cursor pagination
    // ignores time), but persisting it keeps both adapters uniform.
    const windowEnd = new Date()
    const startedAt = windowEnd.toISOString()
    const syncStartedAtMs = windowEnd.getTime()
    const runId = crypto.randomUUID()
    app.db
      .insert(runs)
      .values({
        id: runId,
        projectId: project.id,
        kind: RunKinds['traffic-sync'],
        status: RunStatuses.running,
        trigger: RunTriggers.manual,
        sourceId: sourceRow.id,
        startedAt,
        createdAt: startedAt,
      })
      .run()

    const markFailed = (msg: string, errorCode: TrafficSyncedEvent['errorCode']) => {
      const failedAt = new Date().toISOString()
      app.db.transaction((tx) => {
        tx
          .update(runs)
          .set({ status: RunStatuses.failed, error: msg, finishedAt: failedAt })
          .where(eq(runs.id, runId))
          .run()
        tx
          .update(trafficSources)
          .set({ status: TrafficSourceStatuses.error, lastError: msg, updatedAt: failedAt })
          .where(eq(trafficSources.id, sourceRow.id))
          .run()
      })
      // Fire-and-forget: never let a telemetry hook take down the sync.
      try {
        opts.onTrafficSynced?.({
          status: 'failed',
          sourceType: sourceRow.sourceType,
          sourceId: sourceRow.id,
          pulledEvents: 0,
          crawlerHits: 0,
          aiUserFetchHits: 0,
          aiReferralHits: 0,
          durationMs: Date.now() - syncStartedAtMs,
          errorCode,
        })
      } catch {
        // swallow — never block on telemetry
      }
    }

    // Per-source dispatch: each branch validates its own credential store and
    // pulls events. windowStart is meaningful for Cloud Run (time-window
    // pull) and informational for WP (cursor pull — set to lastSyncedAt or
    // sync start). nextCursor is only set by WP.
    let windowStart: Date
    let allEvents: NormalizedTrafficRequest[]
    let nextCursor: string | undefined
    let auditAction: string

    if (sourceRow.sourceType === TrafficSourceTypes['cloud-run']) {
      auditAction = 'traffic.cloud-run.synced'
      const credentialStore = opts.cloudRunCredentialStore
      if (!credentialStore) {
        throw validationError('Cloud Run credential storage is not configured for this deployment')
      }
      const credential = credentialStore.getConnection(project.name)
      if (!credential) {
        throw validationError(
          `No Cloud Run credential found for project "${project.name}". Run "canonry traffic connect cloud-run" first.`,
        )
      }

      const config = parseSourceConfig(sourceRow)
      const gcpProjectId = (config.gcpProjectId as string | undefined) ?? credential.gcpProjectId
      const serviceName = (config.serviceName as string | null | undefined) ?? credential.serviceName ?? undefined
      const location = (config.location as string | null | undefined) ?? credential.location ?? undefined

      const requestedMinutes = request.body?.sinceMinutes
      const windowMinutes = Number.isFinite(requestedMinutes) && requestedMinutes && requestedMinutes > 0
        ? Math.floor(requestedMinutes)
        : syncWindowMinutes

      // Clamp windowStart forward to lastSyncedAt so back-to-back syncs don't
      // re-pull the previous window and double-count via the `hits + ?` upsert.
      const requestedStartMs = windowEnd.getTime() - windowMinutes * 60_000
      const lastSyncedMs = sourceRow.lastSyncedAt
        ? new Date(sourceRow.lastSyncedAt).getTime()
        : Number.NEGATIVE_INFINITY
      windowStart = new Date(
        Math.min(windowEnd.getTime(), Math.max(requestedStartMs, lastSyncedMs)),
      )

      let accessToken: string
      try {
        accessToken = await resolveAccessToken(credential)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        markFailed(msg, 'PROVIDER_AUTH')
        throw providerError(`Failed to resolve Cloud Run access token: ${msg}`)
      }

      // Tell the Cloud Run client this is a first-time backfill if no prior
      // cursor exists, so its bounded page budget targets the most-recent
      // entries instead of exhausting on the oldest. Adapter-specific pull
      // strategy lives in @ainyc/canonry-integration-cloud-run, not here.
      const isFirstSync = !sourceRow.lastSyncedAt
      try {
        const page = await pullEvents(accessToken, {
          gcpProjectId,
          serviceName,
          location,
          startTime: windowStart.toISOString(),
          endTime: windowEnd.toISOString(),
          pageSize,
          maxPages,
          firstSync: isFirstSync,
          requestUrlSubstrings: [project.canonicalDomain],
        })
        allEvents = page.events
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        markFailed(msg, 'PROVIDER_PULL')
        throw providerError(`Cloud Run pull failed: ${msg}`)
      }
    } else if (sourceRow.sourceType === TrafficSourceTypes.wordpress) {
      // WordPress traffic-logger adapter. Pages through `next_cursor` until
      // exhausted, then persists the final cursor + advances `lastSyncedAt`
      // to windowEnd. The `lastCursor` column drives resume semantics; the
      // time-window clamp does not apply.
      auditAction = 'traffic.wordpress.synced'
      const credentialStore = opts.wordpressTrafficCredentialStore
      if (!credentialStore) {
        throw validationError('WordPress traffic credential storage is not configured for this deployment')
      }
      const credential = credentialStore.getConnection(project.name)
      if (!credential) {
        // Audit log + markFailed would over-rotate the source row; this is a
        // user-config error before any pull happens, so the global handler's
        // validationError envelope is the right surface.
        app.db
          .delete(runs)
          .where(eq(runs.id, runId))
          .run()
        throw validationError(
          `No WordPress credential found for project "${project.name}". Run "canonry traffic connect wordpress" first.`,
        )
      }

      // For WP, windowStart is purely informational on the response — there
      // is no time-window pull. Use lastSyncedAt if present so the response
      // matches "events since previous sync"; otherwise use windowEnd (which
      // yields `windowStart == windowEnd` for the first sync, signalling a
      // cursor-driven adapter to consumers).
      windowStart = sourceRow.lastSyncedAt ? new Date(sourceRow.lastSyncedAt) : windowEnd

      const wpPageSize = opts.defaultWordpressPageSize ?? DEFAULT_WP_PAGE_SIZE
      const wpMaxPages = opts.defaultWordpressMaxPages ?? DEFAULT_WP_MAX_PAGES

      // Re-validate the persisted baseUrl on every sync AND pin the resolved
      // IP for the duration of this sync's fetches. The pinned dispatcher
      // closes the DNS-flip window two ways: (a) `assertWordpressTargetAllowed`
      // refuses to issue a dispatcher if the host now resolves to a private
      // address, and (b) every subsequent fetch through the dispatcher uses
      // the validated IP, so DNS rebinding between validation and any of the
      // per-page fetches below can't redirect Basic-auth creds to a metadata
      // or RFC1918 host.
      let pinnedDispatcher: UndiciAgent
      try {
        pinnedDispatcher = await assertWordpressTargetAllowed(credential.baseUrl)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        markFailed(msg, 'PROVIDER_PULL')
        throw e
      }

      const collected: NormalizedTrafficRequest[] = []
      let cursor: string | undefined = sourceRow.lastCursor ?? undefined
      try {
        for (let page = 0; page < wpMaxPages; page += 1) {
          const pageResult = await pullWordpressEvents({
            baseUrl: credential.baseUrl,
            username: credential.username,
            applicationPassword: credential.applicationPassword,
            cursor,
            pageSize: wpPageSize,
            maxPages: 1,
            dispatcher: pinnedDispatcher,
          })
          collected.push(...pageResult.events)
          const previousCursor = cursor
          cursor = pageResult.nextCursor
          // The plugin emits a fresh `next_cursor` on every response (even
          // the last page) so it doubles as the resume token for the next
          // sync. `has_more` is the only authoritative "fetch another page
          // in this sync" signal. Also guard against cursor stagnation in
          // case a plugin bug echoes the same token forever.
          if (!pageResult.hasMore) break
          if (!cursor || cursor === previousCursor) break
        }
        allEvents = collected
        nextCursor = cursor
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        markFailed(msg, 'PROVIDER_PULL')
        throw providerError(`WordPress pull failed: ${msg}`)
      } finally {
        await pinnedDispatcher.close().catch(() => {})
      }
    } else {
      // Vercel `request-logs` adapter. Pulls a clamped `[windowStart,
      // windowEnd]` time window — like Cloud Run — but Vercel paginates by
      // page number with no resumable cursor, so the whole window must be
      // drained in one pass. We walk every page up to `vercelMaxPages`; if
      // the adapter still reports `hasMore`, the window overflowed the
      // budget and we fail rather than advance `lastSyncedAt` past the
      // un-pulled pages (which would silently drop them).
      auditAction = 'traffic.vercel.synced'
      const credentialStore = opts.vercelTrafficCredentialStore
      if (!credentialStore) {
        app.db.delete(runs).where(eq(runs.id, runId)).run()
        throw validationError('Vercel traffic credential storage is not configured for this deployment')
      }
      const credential = credentialStore.getConnection(project.name)
      if (!credential) {
        // User-config error before any pull happens — the global handler's
        // validationError envelope is the right surface. Drop the run row so
        // it doesn't linger as 'running'.
        app.db.delete(runs).where(eq(runs.id, runId)).run()
        throw validationError(
          `No Vercel credential found for project "${project.name}". Run "canonry traffic connect vercel" first.`,
        )
      }

      const config = parseSourceConfig(sourceRow)
      const vercelProjectId = (config.projectId as string | undefined) ?? credential.projectId
      const vercelTeamId = (config.teamId as string | undefined) ?? credential.teamId
      const vercelEnvironment = (config.environment as 'production' | 'preview' | undefined)
        ?? credential.environment

      const requestedMinutes = request.body?.sinceMinutes
      const windowMinutes = Number.isFinite(requestedMinutes) && requestedMinutes && requestedMinutes > 0
        ? Math.floor(requestedMinutes)
        : syncWindowMinutes

      // Clamp windowStart forward to lastSyncedAt so back-to-back syncs don't
      // re-pull the previous window and double-count via the `hits + ?` upsert.
      const requestedStartMs = windowEnd.getTime() - windowMinutes * 60_000
      const lastSyncedMs = sourceRow.lastSyncedAt
        ? new Date(sourceRow.lastSyncedAt).getTime()
        : Number.NEGATIVE_INFINITY
      windowStart = new Date(
        Math.min(windowEnd.getTime(), Math.max(requestedStartMs, lastSyncedMs)),
      )

      let page: VercelTrafficEventsPage
      try {
        page = await pullVercelEvents({
          token: credential.token,
          projectId: vercelProjectId,
          teamId: vercelTeamId,
          environment: vercelEnvironment,
          startDate: windowStart.getTime(),
          endDate: windowEnd.getTime(),
          maxPages: vercelMaxPages,
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        markFailed(msg, 'PROVIDER_PULL')
        throw providerError(`Vercel pull failed: ${msg}`)
      }
      if (page.hasMore) {
        // Budget exhausted with the window not fully drained. Advancing
        // `lastSyncedAt` here would skip the un-pulled pages, so fail
        // instead — the next sync (or a narrower `--since-minutes`, or a
        // backfill) can cover the window without losing rows.
        const msg = `Vercel sync window exceeded the ${vercelMaxPages}-page budget — narrow the window with --since-minutes or run a backfill`
        markFailed(msg, 'PROVIDER_PULL')
        throw providerError(`Vercel pull failed: ${msg}`)
      }
      allEvents = page.events
    }

    let crawlerBucketRows = 0
    let aiUserFetchBucketRows = 0
    let aiReferralBucketRows = 0
    let sampleRows = 0
    // These get assigned inside the transaction (after we re-read the row to
    // beat the read-then-write race on concurrent syncs) and read after the
    // transaction commits for the response + telemetry payload.
    let finishedAt = new Date().toISOString()
    let pulledEventsCount = 0
    let crawlerHitsCount = 0
    let aiUserFetchHitsCount = 0
    let aiReferralHitsCount = 0
    let unknownHitsCount = 0

    app.db.transaction((tx) => {
      // Re-read sourceRow inside the txn so a concurrent sync that committed
      // first is visible — otherwise both syncs would dedupe against the same
      // stale lastEventIds and the second commit would clobber the first
      // sync's ring buffer.
      const latestRow = tx
        .select()
        .from(trafficSources)
        .where(eq(trafficSources.id, sourceRow.id))
        .get()!

      // Cross-sync dedupe: drop events whose normalized eventId was already
      // observed in the previous successful sync. The lastSyncedAt clamp
      // narrows the fetch window, but events with timestamp == lastSyncedAt
      // (boundary second) can still appear in two consecutive pulls.
      const previousIds = latestRow.lastEventIds ?? []
      const seenEventIds = new Set(previousIds)
      const dedupedEvents = seenEventIds.size === 0
        ? allEvents
        : allEvents.filter(e => !seenEventIds.has(e.eventId))

      // Build the next sync's seen-set: new event IDs (newest-first) PREPENDED
      // to the previous seen IDs, deduplicated, capped at MAX_TRACKED_EVENT_IDS.
      // We must retain the previous IDs because Cloud Logging can re-return
      // the same boundary event on more than one subsequent sync; replacing
      // would let it re-enter on the third sync.
      const newSorted = dedupedEvents
        .slice()
        .sort((a, b) => (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : 0))
        .map(e => e.eventId)
      const merged: string[] = []
      const mergedSet = new Set<string>()
      for (const id of [...newSorted, ...previousIds]) {
        if (mergedSet.has(id)) continue
        mergedSet.add(id)
        merged.push(id)
        if (merged.length >= MAX_TRACKED_EVENT_IDS) break
      }
      const nextEventIds = merged

      const report = buildTrafficProbeReport(dedupedEvents, { sampleLimit })
      finishedAt = new Date().toISOString()
      pulledEventsCount = report.totals.normalizedEvents
      crawlerHitsCount = report.totals.crawlerHits
      aiUserFetchHitsCount = report.totals.aiUserFetchHits
      aiReferralHitsCount = report.totals.aiReferralHits
      unknownHitsCount = report.totals.unknownHits

      // Upsert crawler hourly buckets — composite PK lets us accumulate `hits`.
      for (const bucket of report.crawlerEventsHourly) {
        const status = bucket.status ?? 0
        tx
          .insert(crawlerEventsHourly)
          .values({
            projectId: project.id,
            sourceId: sourceRow.id,
            tsHour: bucket.tsHour,
            botId: bucket.botId,
            operator: bucket.operator,
            verificationStatus: bucket.verificationStatus,
            pathNormalized: bucket.pathNormalized,
            status,
            hits: bucket.hits,
            sampledUserAgent: bucket.sampledUserAgent,
            createdAt: finishedAt,
            updatedAt: finishedAt,
          })
          .onConflictDoUpdate({
            target: [
              crawlerEventsHourly.projectId,
              crawlerEventsHourly.sourceId,
              crawlerEventsHourly.tsHour,
              crawlerEventsHourly.botId,
              crawlerEventsHourly.verificationStatus,
              crawlerEventsHourly.pathNormalized,
              crawlerEventsHourly.status,
            ],
            set: {
              hits: sql`${crawlerEventsHourly.hits} + ${bucket.hits}`,
              sampledUserAgent: bucket.sampledUserAgent,
              updatedAt: finishedAt,
            },
          })
          .run()
        crawlerBucketRows += 1
      }

      for (const bucket of report.aiUserFetchEventsHourly) {
        const status = bucket.status ?? 0
        tx
          .insert(aiUserFetchEventsHourly)
          .values({
            projectId: project.id,
            sourceId: sourceRow.id,
            tsHour: bucket.tsHour,
            botId: bucket.botId,
            operator: bucket.operator,
            verificationStatus: bucket.verificationStatus,
            pathNormalized: bucket.pathNormalized,
            status,
            hits: bucket.hits,
            sampledUserAgent: bucket.sampledUserAgent,
            createdAt: finishedAt,
            updatedAt: finishedAt,
          })
          .onConflictDoUpdate({
            target: [
              aiUserFetchEventsHourly.projectId,
              aiUserFetchEventsHourly.sourceId,
              aiUserFetchEventsHourly.tsHour,
              aiUserFetchEventsHourly.botId,
              aiUserFetchEventsHourly.verificationStatus,
              aiUserFetchEventsHourly.pathNormalized,
              aiUserFetchEventsHourly.status,
            ],
            set: {
              hits: sql`${aiUserFetchEventsHourly.hits} + ${bucket.hits}`,
              sampledUserAgent: bucket.sampledUserAgent,
              updatedAt: finishedAt,
            },
          })
          .run()
        aiUserFetchBucketRows += 1
      }

      for (const bucket of report.aiReferralEventsHourly) {
        const status = bucket.status ?? 0
        tx
          .insert(aiReferralEventsHourly)
          .values({
            projectId: project.id,
            sourceId: sourceRow.id,
            tsHour: bucket.tsHour,
            product: bucket.product,
            operator: bucket.operator,
            sourceDomain: bucket.sourceDomain,
            evidenceType: bucket.evidenceType,
            landingPathNormalized: bucket.landingPathNormalized,
            status,
            sessionsOrHits: bucket.hits,
            usersEstimated: null,
            createdAt: finishedAt,
            updatedAt: finishedAt,
          })
          .onConflictDoUpdate({
            target: [
              aiReferralEventsHourly.projectId,
              aiReferralEventsHourly.sourceId,
              aiReferralEventsHourly.tsHour,
              aiReferralEventsHourly.product,
              aiReferralEventsHourly.sourceDomain,
              aiReferralEventsHourly.evidenceType,
              aiReferralEventsHourly.landingPathNormalized,
              aiReferralEventsHourly.status,
            ],
            set: {
              sessionsOrHits: sql`${aiReferralEventsHourly.sessionsOrHits} + ${bucket.hits}`,
              updatedAt: finishedAt,
            },
          })
          .run()
        aiReferralBucketRows += 1
      }

      for (const sample of report.samples) {
        const eventType = sample.crawler
          ? 'crawler'
          : sample.aiUserFetch
            ? 'ai_user_fetch'
            : sample.aiReferral
              ? 'ai_referral'
              : 'unknown'
        const refererHost = (() => {
          if (!sample.referer) return null
          try {
            return new URL(sample.referer).hostname
          } catch {
            return null
          }
        })()
        tx
          .insert(rawEventSamples)
          .values({
            id: crypto.randomUUID(),
            projectId: project.id,
            sourceId: sourceRow.id,
            ts: sample.observedAt,
            eventType,
            ipHash: null,
            userAgent: sample.userAgent,
            pathNormalized: sample.pathNormalized,
            status: sample.status,
            refererHost,
            classifierDetailsJson: {
              crawler: sample.crawler,
              aiUserFetch: sample.aiUserFetch,
              aiReferral: sample.aiReferral,
            },
            createdAt: finishedAt,
          })
          .run()
        sampleRows += 1
      }

      // For WP we persist the final cursor inside the same transaction so a
      // mid-sync crash either rolls back the rollup and the cursor together,
      // or commits both. Cloud Run does not use `lastCursor`; leave it
      // untouched (drizzle omits undefined fields from the SET clause).
      const sourceUpdate: Partial<typeof trafficSources.$inferInsert> = {
        status: TrafficSourceStatuses.connected,
        // Advance to windowEnd, not finishedAt — events arriving at the
        // source between windowEnd and finishedAt aren't in this pull's
        // range. If we stored finishedAt, the next sync's clamp would skip
        // past them and they'd be lost.
        lastSyncedAt: windowEnd.toISOString(),
        lastError: null,
        lastEventIds: nextEventIds,
        updatedAt: finishedAt,
      }
      if (sourceRow.sourceType === TrafficSourceTypes.wordpress) {
        sourceUpdate.lastCursor = nextCursor ?? null
      }
      tx
        .update(trafficSources)
        .set(sourceUpdate)
        .where(eq(trafficSources.id, sourceRow.id))
        .run()

      tx
        .update(runs)
        .set({ status: RunStatuses.completed, finishedAt })
        .where(eq(runs.id, runId))
        .run()
    })

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: auditAction,
      entityType: 'traffic_source',
      entityId: sourceRow.id,
    })

    // Fire-and-forget telemetry. Never let a hook block the response.
    try {
      opts.onTrafficSynced?.({
        status: 'completed',
        sourceType: sourceRow.sourceType,
        sourceId: sourceRow.id,
        pulledEvents: pulledEventsCount,
        crawlerHits: crawlerHitsCount,
        aiUserFetchHits: aiUserFetchHitsCount,
        aiReferralHits: aiReferralHitsCount,
        durationMs: Date.now() - syncStartedAtMs,
      })
    } catch {
      // swallow — never block on telemetry
    }

    const response: TrafficSyncResponse = {
      sourceId: sourceRow.id,
      runId,
      syncedAt: finishedAt,
      pulledEvents: pulledEventsCount,
      crawlerHits: crawlerHitsCount,
      aiUserFetchHits: aiUserFetchHitsCount,
      aiReferralHits: aiReferralHitsCount,
      unknownHits: unknownHitsCount,
      crawlerBucketRows,
      aiUserFetchBucketRows,
      aiReferralBucketRows,
      sampleRows,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
    }
    return response
  })

  // POST /projects/:name/traffic/sources/:id/backfill
  //
  // One-shot reclassification of historical Cloud Run logs. Returns
  // immediately with `runId`; the caller polls `GET /runs/:id` for status.
  // On success: rebuilds the hourly rollup buckets for the requested window
  // by deleting then re-inserting them inside one transaction (replace
  // semantics — additive would double-count, since the cross-sync ring
  // buffer can only hold MAX_TRACKED_EVENT_IDS IDs). Sample buffer for the
  // window is also replaced so it stays consistent with the rollups.
  app.post<{
    Params: { name: string; id: string }
    Body: { days?: number }
  }>('/projects/:name/traffic/sources/:id/backfill', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const sourceRow = app.db
      .select()
      .from(trafficSources)
      .where(eq(trafficSources.id, request.params.id))
      .get()
    if (!sourceRow || sourceRow.projectId !== project.id) {
      throw notFound('Traffic source', request.params.id)
    }
    if (
      sourceRow.sourceType !== TrafficSourceTypes['cloud-run']
      && sourceRow.sourceType !== TrafficSourceTypes.wordpress
      && sourceRow.sourceType !== TrafficSourceTypes.vercel
    ) {
      throw validationError(
        `Backfill for source type "${sourceRow.sourceType}" is not implemented yet — only cloud-run, wordpress, and vercel are supported in v1.`,
      )
    }

    const requestedDays = request.body?.days ?? DEFAULT_BACKFILL_DAYS
    if (!Number.isInteger(requestedDays) || requestedDays <= 0) {
      throw validationError('"days" must be a positive integer')
    }
    const appliedDays = Math.min(requestedDays, MAX_BACKFILL_DAYS)

    const windowEnd = new Date()
    const windowStart = new Date(windowEnd.getTime() - appliedDays * 86_400_000)
    // Floor windowStart to the hour boundary so the boundary hour is fully
    // replaced. Rollup `tsHour` is hour-truncated, so a raw mid-hour
    // windowStart would leave an existing bucket at floor(windowStart, hour)
    // outside the delete range while the new pull re-emits a bucket at the
    // same tsHour, tripping the composite primary key on (projectId,
    // sourceId, tsHour, botId, verificationStatus, pathNormalized, status).
    windowStart.setUTCMinutes(0, 0, 0)

    // Build the per-source-type window pull closure. Credential and config
    // validation happens up-front (synchronously throws validationError on
    // miss) so the run row never gets created for an obviously-misconfigured
    // request. The closure itself does all I/O lazily — invoked by
    // runBackfillTask after the run row is in place.
    let pullForBackfill: BackfillPullFn
    let pullErrorPrefix: string

    if (sourceRow.sourceType === TrafficSourceTypes['cloud-run']) {
      const credentialStore = opts.cloudRunCredentialStore
      if (!credentialStore) {
        throw validationError('Cloud Run credential storage is not configured for this deployment')
      }
      const credential = credentialStore.getConnection(project.name)
      if (!credential) {
        throw validationError(
          `No Cloud Run credential found for project "${project.name}". Run "canonry traffic connect cloud-run" first.`,
        )
      }

      const config = parseSourceConfig(sourceRow)
      const gcpProjectId = (config.gcpProjectId as string | undefined) ?? credential.gcpProjectId
      const serviceName = (config.serviceName as string | null | undefined) ?? credential.serviceName ?? undefined
      const location = (config.location as string | null | undefined) ?? credential.location ?? undefined

      pullErrorPrefix = 'Cloud Run pull failed'
      pullForBackfill = async () => {
        const accessToken = await resolveAccessToken(credential)
        const page = await pullEvents(accessToken, {
          gcpProjectId,
          serviceName,
          location,
          startTime: windowStart.toISOString(),
          endTime: windowEnd.toISOString(),
          pageSize: DEFAULT_PAGE_SIZE,
          maxPages: BACKFILL_MAX_PAGES,
          // Backfill is intentionally `firstSync: false`. We don't want desc
          // ordering — the in-memory rollup builder handles any order, and the
          // ring-buffer reseed at the end takes the most-recent IDs from the
          // dedupedEvents anyway.
          firstSync: false,
          orderBy: 'timestamp asc',
          requestUrlSubstrings: [project.canonicalDomain],
        })
        return page.events
      }
    } else if (sourceRow.sourceType === TrafficSourceTypes.wordpress) {
      const credentialStore = opts.wordpressTrafficCredentialStore
      if (!credentialStore) {
        throw validationError('WordPress traffic credential storage is not configured for this deployment')
      }
      const credential = credentialStore.getConnection(project.name)
      if (!credential) {
        throw validationError(
          `No WordPress credential found for project "${project.name}". Run "canonry traffic connect wordpress" first.`,
        )
      }

      // Synchronous fail-fast: if the baseUrl can't pass the SSRF guard right
      // now, return 400 before enqueuing the background task. The closure
      // below re-validates AND pins DNS for the actual fetches, because the
      // background task runs after the HTTP response is sent.
      await (await assertWordpressTargetAllowed(credential.baseUrl)).close().catch(() => {})

      const wpPageSize = opts.defaultWordpressPageSize ?? DEFAULT_WP_PAGE_SIZE
      pullErrorPrefix = 'WordPress pull failed'
      pullForBackfill = async () => {
        // Re-validate at task-execution time and pin DNS for the entire
        // window pull. Backfill is fire-and-forget — the synchronous check
        // above protects request-time, this protects task-time.
        const pinnedDispatcher = await assertWordpressTargetAllowed(credential.baseUrl)
        try {
          // Page through the plugin's `[since, until)` window via opaque
          // cursors. The window is fixed for the entire backfill — only the
          // cursor advances — so each page sees the same bounds. Stops on
          // `hasMore=false` OR an exhausted cursor (defensive guard against a
          // misbehaving plugin emitting the same cursor forever).
          const collected: NormalizedTrafficRequest[] = []
          const windowStartIso = windowStart.toISOString()
          const windowEndIso = windowEnd.toISOString()
          let cursor: string | undefined = undefined
          for (let page = 0; page < BACKFILL_MAX_PAGES; page += 1) {
            const pageResult = await pullWordpressEvents({
              baseUrl: credential.baseUrl,
              username: credential.username,
              applicationPassword: credential.applicationPassword,
              cursor,
              pageSize: wpPageSize,
              // Each call fetches a single page; the for-loop drives
              // continuation. Matches the WP sync path's pattern.
              maxPages: 1,
              since: windowStartIso,
              until: windowEndIso,
              dispatcher: pinnedDispatcher,
            })
            collected.push(...pageResult.events)
            const previousCursor: string | undefined = cursor
            cursor = pageResult.nextCursor
            if (!pageResult.hasMore) break
            if (!cursor || cursor === previousCursor) break
          }
          return collected
        } finally {
          await pinnedDispatcher.close().catch(() => {})
        }
      }
    } else {
      // Vercel `request-logs` window backfill. Pulls the fixed
      // `[windowStart, windowEnd]` window with a large page budget. Backfill
      // is replace mode — runBackfillTask deletes the window's rollup buckets
      // before re-ingesting — so a truncated pull would wipe existing data
      // and leave only a partial set. If the budget is exhausted with
      // `hasMore` still true, fail loudly (mirrors the sync path) so the
      // operator re-runs with a narrower `--days` instead of losing rows.
      const credentialStore = opts.vercelTrafficCredentialStore
      if (!credentialStore) {
        throw validationError('Vercel traffic credential storage is not configured for this deployment')
      }
      const credential = credentialStore.getConnection(project.name)
      if (!credential) {
        throw validationError(
          `No Vercel credential found for project "${project.name}". Run "canonry traffic connect vercel" first.`,
        )
      }

      const config = parseSourceConfig(sourceRow)
      const vercelProjectId = (config.projectId as string | undefined) ?? credential.projectId
      const vercelTeamId = (config.teamId as string | undefined) ?? credential.teamId
      const vercelEnvironment = (config.environment as 'production' | 'preview' | undefined)
        ?? credential.environment

      pullErrorPrefix = 'Vercel pull failed'
      pullForBackfill = async () => {
        const page = await pullVercelEvents({
          token: credential.token,
          projectId: vercelProjectId,
          teamId: vercelTeamId,
          environment: vercelEnvironment,
          startDate: windowStart.getTime(),
          endDate: windowEnd.getTime(),
          maxPages: BACKFILL_MAX_PAGES,
        })
        if (page.hasMore) {
          throw new Error(
            `backfill window exceeded the ${BACKFILL_MAX_PAGES}-page budget — narrow the window with --days`,
          )
        }
        return page.events
      }
    }

    const startedAt = windowEnd.toISOString()
    const runId = crypto.randomUUID()
    app.db
      .insert(runs)
      .values({
        id: runId,
        projectId: project.id,
        kind: RunKinds['traffic-sync'],
        status: RunStatuses.running,
        trigger: RunTriggers.backfill,
        sourceId: sourceRow.id,
        startedAt,
        createdAt: startedAt,
      })
      .run()

    // Fire-and-forget. The route returns immediately; the run row carries
    // status until the background task finishes. Errors inside the task are
    // recorded on the run row + traffic_sources.last_error — never thrown
    // back to this scope (the response has already been sent).
    void runBackfillTask({
      app,
      runId,
      project,
      sourceRow,
      windowStart,
      windowEnd,
      pullForBackfill,
      pullErrorPrefix,
    }).catch(() => {
      // runBackfillTask handles its own error recording. The catch here
      // exists only so an unhandled rejection cannot crash the process if
      // an internal bug bypasses the task's own try/catch.
    })

    const response: TrafficBackfillResponse = {
      sourceId: sourceRow.id,
      runId,
      status: RunStatuses.running,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      daysRequested: requestedDays,
      daysApplied: appliedDays,
    }
    return response
  })

  function buildSourceDetail(
    projectId: string,
    row: typeof trafficSources.$inferSelect,
    since: string,
  ): TrafficSourceDetailDto {
    const crawlerTotals = app.db
      .select({ total: sql<number>`COALESCE(SUM(${crawlerEventsHourly.hits}), 0)` })
      .from(crawlerEventsHourly)
      .where(
        and(
          eq(crawlerEventsHourly.sourceId, row.id),
          gte(crawlerEventsHourly.tsHour, since),
        ),
      )
      .get()

    const aiUserFetchTotals = app.db
      .select({ total: sql<number>`COALESCE(SUM(${aiUserFetchEventsHourly.hits}), 0)` })
      .from(aiUserFetchEventsHourly)
      .where(
        and(
          eq(aiUserFetchEventsHourly.sourceId, row.id),
          gte(aiUserFetchEventsHourly.tsHour, since),
        ),
      )
      .get()

    const aiTotals = app.db
      .select({ total: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.sessionsOrHits}), 0)` })
      .from(aiReferralEventsHourly)
      .where(
        and(
          eq(aiReferralEventsHourly.sourceId, row.id),
          gte(aiReferralEventsHourly.tsHour, since),
        ),
      )
      .get()

    const sampleTotals = app.db
      .select({ total: sql<number>`COUNT(*)` })
      .from(rawEventSamples)
      .where(
        and(
          eq(rawEventSamples.sourceId, row.id),
          gte(rawEventSamples.ts, since),
        ),
      )
      .get()

    const latestRun = app.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.projectId, projectId),
          eq(runs.kind, RunKinds['traffic-sync']),
          eq(runs.sourceId, row.id),
        ),
      )
      .orderBy(desc(runs.startedAt))
      .limit(1)
      .get()

    return {
      ...rowToDto(row),
      totals24h: {
        crawlerHits: Number(crawlerTotals?.total ?? 0),
        aiUserFetchHits: Number(aiUserFetchTotals?.total ?? 0),
        aiReferralHits: Number(aiTotals?.total ?? 0),
        sampleCount: Number(sampleTotals?.total ?? 0),
      },
      latestRun: latestRun
        ? {
            runId: latestRun.id,
            status: latestRun.status as RunStatus,
            startedAt: latestRun.startedAt,
            finishedAt: latestRun.finishedAt ?? null,
            error: latestRun.error ?? null,
          }
        : null,
    }
  }

  // GET /projects/:name/traffic/sources
  app.get<{ Params: { name: string } }>('/projects/:name/traffic/sources', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const rows = app.db
      .select()
      .from(trafficSources)
      .where(eq(trafficSources.projectId, project.id))
      .orderBy(desc(trafficSources.createdAt))
      .all()
    const sources: TrafficSourceDto[] = rows
      .filter((row) => row.status !== TrafficSourceStatuses.archived)
      .map(rowToDto)
    const response: TrafficSourceListResponse = { sources }
    return response
  })

  // GET /projects/:name/traffic/status
  app.get<{ Params: { name: string } }>('/projects/:name/traffic/status', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const rows = app.db
      .select()
      .from(trafficSources)
      .where(eq(trafficSources.projectId, project.id))
      .orderBy(desc(trafficSources.createdAt))
      .all()
    const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString()
    const sources: TrafficSourceDetailDto[] = rows
      .filter((row) => row.status !== TrafficSourceStatuses.archived)
      .map((row) => buildSourceDetail(project.id, row, since))
    const response: TrafficStatusResponse = { sources }
    return response
  })

  // GET /projects/:name/traffic/sources/:id
  app.get<{ Params: { name: string; id: string } }>(
    '/projects/:name/traffic/sources/:id',
    async (request) => {
      const project = resolveProject(app.db, request.params.name)
      const row = app.db
        .select()
        .from(trafficSources)
        .where(eq(trafficSources.id, request.params.id))
        .get()
      if (!row || row.projectId !== project.id) {
        throw notFound('Traffic source', request.params.id)
      }

      const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString()
      return buildSourceDetail(project.id, row, since)
    },
  )

  // GET /projects/:name/traffic/events
  app.get<{
    Params: { name: string }
    Querystring: { since?: string; until?: string; kind?: string; limit?: string; sourceId?: string }
  }>('/projects/:name/traffic/events', async (request) => {
    const project = resolveProject(app.db, request.params.name)

    const now = new Date()
    const defaultSince = new Date(now.getTime() - 24 * 60 * 60_000)

    const sinceParam = request.query?.since
    const untilParam = request.query?.until
    const since = sinceParam ? new Date(sinceParam) : defaultSince
    const until = untilParam ? new Date(untilParam) : now
    if (Number.isNaN(since.getTime())) {
      throw validationError('"since" must be an ISO-8601 timestamp')
    }
    if (Number.isNaN(until.getTime())) {
      throw validationError('"until" must be an ISO-8601 timestamp')
    }
    if (since.getTime() > until.getTime()) {
      throw validationError('"since" must be ≤ "until"')
    }

    const kindParam = request.query?.kind
    let kind: TrafficEventKind | 'all' = 'all'
    if (kindParam !== undefined) {
      if (
        kindParam === 'all'
        || kindParam === TrafficEventKinds.crawler
        || kindParam === TrafficEventKinds['ai-user-fetch']
        || kindParam === TrafficEventKinds['ai-referral']
      ) {
        kind = kindParam
      } else {
        throw validationError(
          `"kind" must be one of: all, ${TrafficEventKinds.crawler}, ${TrafficEventKinds['ai-user-fetch']}, ${TrafficEventKinds['ai-referral']}`,
        )
      }
    }

    const limitParam = request.query?.limit
    const requestedLimit = limitParam ? parseInt(limitParam, 10) : 500
    if (!Number.isFinite(requestedLimit) || requestedLimit <= 0) {
      throw validationError('"limit" must be a positive integer')
    }
    const limit = Math.min(requestedLimit, 5000)

    const sourceIdParam = request.query?.sourceId
    const sinceIso = since.toISOString()
    const untilIso = until.toISOString()

    const events: TrafficEventEntry[] = []
    let crawlerTotal = 0
    let aiUserFetchTotal = 0
    let aiReferralTotal = 0

    if (kind === 'all' || kind === TrafficEventKinds.crawler) {
      const crawlerFilters = [
        eq(crawlerEventsHourly.projectId, project.id),
        gte(crawlerEventsHourly.tsHour, sinceIso),
        lte(crawlerEventsHourly.tsHour, untilIso),
      ]
      if (sourceIdParam) crawlerFilters.push(eq(crawlerEventsHourly.sourceId, sourceIdParam))
      const crawlerWhere = and(...crawlerFilters)

      const total = app.db
        .select({ total: sql<number>`COALESCE(SUM(${crawlerEventsHourly.hits}), 0)` })
        .from(crawlerEventsHourly)
        .where(crawlerWhere)
        .get()
      crawlerTotal = Number(total?.total ?? 0)

      const rows = app.db
        .select()
        .from(crawlerEventsHourly)
        .where(crawlerWhere)
        .orderBy(desc(crawlerEventsHourly.tsHour))
        .limit(limit)
        .all()
      for (const r of rows) {
        events.push({
          kind: TrafficEventKinds.crawler,
          sourceId: r.sourceId,
          tsHour: r.tsHour,
          botId: r.botId,
          operator: r.operator,
          verificationStatus: r.verificationStatus,
          pathNormalized: r.pathNormalized,
          status: r.status,
          hits: r.hits,
        })
      }
    }

    if (kind === 'all' || kind === TrafficEventKinds['ai-user-fetch']) {
      const userFetchFilters = [
        eq(aiUserFetchEventsHourly.projectId, project.id),
        gte(aiUserFetchEventsHourly.tsHour, sinceIso),
        lte(aiUserFetchEventsHourly.tsHour, untilIso),
      ]
      if (sourceIdParam) userFetchFilters.push(eq(aiUserFetchEventsHourly.sourceId, sourceIdParam))
      const userFetchWhere = and(...userFetchFilters)

      const total = app.db
        .select({ total: sql<number>`COALESCE(SUM(${aiUserFetchEventsHourly.hits}), 0)` })
        .from(aiUserFetchEventsHourly)
        .where(userFetchWhere)
        .get()
      aiUserFetchTotal = Number(total?.total ?? 0)

      const rows = app.db
        .select()
        .from(aiUserFetchEventsHourly)
        .where(userFetchWhere)
        .orderBy(desc(aiUserFetchEventsHourly.tsHour))
        .limit(limit)
        .all()
      for (const r of rows) {
        events.push({
          kind: TrafficEventKinds['ai-user-fetch'],
          sourceId: r.sourceId,
          tsHour: r.tsHour,
          botId: r.botId,
          operator: r.operator,
          verificationStatus: r.verificationStatus,
          pathNormalized: r.pathNormalized,
          status: r.status,
          hits: r.hits,
        })
      }
    }

    if (kind === 'all' || kind === TrafficEventKinds['ai-referral']) {
      const aiFilters = [
        eq(aiReferralEventsHourly.projectId, project.id),
        gte(aiReferralEventsHourly.tsHour, sinceIso),
        lte(aiReferralEventsHourly.tsHour, untilIso),
      ]
      if (sourceIdParam) aiFilters.push(eq(aiReferralEventsHourly.sourceId, sourceIdParam))
      const aiWhere = and(...aiFilters)

      const total = app.db
        .select({ total: sql<number>`COALESCE(SUM(${aiReferralEventsHourly.sessionsOrHits}), 0)` })
        .from(aiReferralEventsHourly)
        .where(aiWhere)
        .get()
      aiReferralTotal = Number(total?.total ?? 0)

      const rows = app.db
        .select()
        .from(aiReferralEventsHourly)
        .where(aiWhere)
        .orderBy(desc(aiReferralEventsHourly.tsHour))
        .limit(limit)
        .all()
      for (const r of rows) {
        events.push({
          kind: TrafficEventKinds['ai-referral'],
          sourceId: r.sourceId,
          tsHour: r.tsHour,
          product: r.product,
          operator: r.operator,
          sourceDomain: r.sourceDomain,
          evidenceType: r.evidenceType,
          landingPathNormalized: r.landingPathNormalized,
          status: r.status,
          hits: r.sessionsOrHits,
        })
      }
    }

    events.sort((a, b) => (a.tsHour < b.tsHour ? 1 : a.tsHour > b.tsHour ? -1 : 0))
    const trimmed = events.slice(0, limit)

    const response: TrafficEventsResponse = {
      windowStart: sinceIso,
      windowEnd: untilIso,
      totals: {
        crawlerHits: crawlerTotal,
        aiUserFetchHits: aiUserFetchTotal,
        aiReferralHits: aiReferralTotal,
      },
      events: trimmed,
    }
    return response
  })
}
