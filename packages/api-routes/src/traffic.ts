import crypto from 'node:crypto'
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  trafficSources,
  crawlerEventsHourly,
  aiReferralEventsHourly,
  rawEventSamples,
  runs,
  parseJsonColumn,
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
} from '@ainyc/canonry-contracts'
import type {
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
import { resolveProject, writeAuditLog } from './helpers.js'

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
  /** Default lookback window in minutes when a sync is triggered without an explicit `since`. */
  defaultSyncWindowMinutes?: number
  /** Default page size for entries.list pulls. */
  defaultPageSize?: number
  /** Default max pages for entries.list pulls. */
  defaultMaxPages?: number
  /** Cap on the number of raw_event_samples written per sync. */
  defaultSampleLimit?: number
  /** Fire-and-forget hook called after every sync completes (success OR failure). Used by canonry to emit telemetry. */
  onTrafficSynced?: (event: TrafficSyncedEvent) => void
}

const DEFAULT_SYNC_WINDOW_MINUTES = 43_200
const DEFAULT_PAGE_SIZE = 1000
const DEFAULT_MAX_PAGES = 5
const DEFAULT_SAMPLE_LIMIT = 100
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
const MAX_BACKFILL_DAYS = 30
const BACKFILL_MAX_PAGES = 1_000
const BACKFILL_SAMPLE_LIMIT = 500

function parseSourceConfig(row: typeof trafficSources.$inferSelect): Record<string, unknown> {
  return parseJsonColumn<Record<string, unknown>>(row.configJson, {})
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

interface RunBackfillTaskOptions {
  app: FastifyInstance
  runId: string
  project: { id: string; name: string }
  sourceRow: typeof trafficSources.$inferSelect
  gcpProjectId: string
  serviceName: string | undefined
  location: string | undefined
  credential: CloudRunCredentialRecord
  windowStart: Date
  windowEnd: Date
  appliedDays: number
  pullEvents: (
    accessToken: string,
    options: ListCloudRunTrafficEventsOptions,
  ) => Promise<CloudRunTrafficEventsPage>
  resolveAccessToken: (record: CloudRunCredentialRecord) => Promise<string>
}

async function runBackfillTask(options: RunBackfillTaskOptions): Promise<void> {
  const {
    app,
    runId,
    project,
    sourceRow,
    gcpProjectId,
    serviceName,
    location,
    credential,
    windowStart,
    windowEnd,
    pullEvents,
    resolveAccessToken,
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

  let accessToken: string
  try {
    accessToken = await resolveAccessToken(credential)
  } catch (e) {
    markFailed(`Failed to resolve Cloud Run access token: ${e instanceof Error ? e.message : String(e)}`)
    return
  }

  const allEvents: CloudRunTrafficEventsPage['events'] = []
  try {
    // Single call with a generous page budget. The integration internally
    // paginates via nextPageToken until exhausted or the cap is hit.
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
    })
    allEvents.push(...page.events)
  } catch (e) {
    markFailed(`Cloud Run pull failed: ${e instanceof Error ? e.message : String(e)}`)
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
  const nextLastSyncedAt = Math.max(currentLastSyncedMs, windowEnd.getTime()) === windowEnd.getTime()
    ? finishedAt
    : sourceRow.lastSyncedAt!

  try {
    app.db.transaction((tx) => {
      // Replace mode: clear the rollup window first, then ingest fresh.
      // Boundaries are inclusive on `windowStart` (>=) and exclusive on
      // `windowEnd` (<) so two contiguous backfill windows can't overlap.
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
        const eventType = sample.crawler ? 'crawler' : sample.aiReferral ? 'ai_referral' : 'unknown'
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
            classifierDetailsJson: JSON.stringify({
              crawler: sample.crawler,
              aiReferral: sample.aiReferral,
            }),
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
          lastEventIds: JSON.stringify(newRingBuffer),
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
          configJson: JSON.stringify(config),
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
          configJson: JSON.stringify(config),
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

  // POST /projects/:name/traffic/sources/:id/sync
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
    if (sourceRow.sourceType !== TrafficSourceTypes['cloud-run']) {
      throw validationError(
        `Sync for source type "${sourceRow.sourceType}" is not implemented yet — only cloud-run is supported in v1.`,
      )
    }

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

    const windowEnd = new Date()
    // Clamp windowStart forward to lastSyncedAt so back-to-back syncs don't
    // re-pull the previous window and double-count via the `hits + ?` upsert.
    const requestedStartMs = windowEnd.getTime() - windowMinutes * 60_000
    const lastSyncedMs = sourceRow.lastSyncedAt
      ? new Date(sourceRow.lastSyncedAt).getTime()
      : Number.NEGATIVE_INFINITY
    const windowStart = new Date(
      Math.min(windowEnd.getTime(), Math.max(requestedStartMs, lastSyncedMs)),
    )

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
          aiReferralHits: 0,
          durationMs: Date.now() - syncStartedAtMs,
          errorCode,
        })
      } catch {
        // swallow — never block on telemetry
      }
    }

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
    let allEvents: CloudRunTrafficEventsPage['events'] = []
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
      })
      allEvents = page.events
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      markFailed(msg, 'PROVIDER_PULL')
      throw providerError(`Cloud Run pull failed: ${msg}`)
    }

    // Cross-sync dedupe: drop events whose normalized eventId was already
    // observed in the previous successful sync. The lastSyncedAt clamp
    // narrows the fetch window, but events with timestamp == lastSyncedAt
    // (boundary second) can still appear in two consecutive pulls.
    const seenEventIds = new Set(parseJsonColumn<string[]>(sourceRow.lastEventIds, []))
    const dedupedEvents = seenEventIds.size === 0
      ? allEvents
      : allEvents.filter(e => !seenEventIds.has(e.eventId))

    // Build the next sync's seen-set: new event IDs (newest-first) PREPENDED
    // to the previous seen IDs, deduplicated, capped at MAX_TRACKED_EVENT_IDS.
    // We must retain the previous IDs because Cloud Logging can re-return the
    // same boundary event on more than one subsequent sync; replacing would
    // let it re-enter on the third sync.
    const newSorted = dedupedEvents
      .slice()
      .sort((a, b) => (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : 0))
      .map(e => e.eventId)
    const previousIds = parseJsonColumn<string[]>(sourceRow.lastEventIds, [])
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
    const finishedAt = new Date().toISOString()

    let crawlerBucketRows = 0
    let aiReferralBucketRows = 0
    let sampleRows = 0

    app.db.transaction((tx) => {
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
        const eventType = sample.crawler ? 'crawler' : sample.aiReferral ? 'ai_referral' : 'unknown'
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
            classifierDetailsJson: JSON.stringify({
              crawler: sample.crawler,
              aiReferral: sample.aiReferral,
            }),
            createdAt: finishedAt,
          })
          .run()
        sampleRows += 1
      }

      tx
        .update(trafficSources)
        .set({
          status: TrafficSourceStatuses.connected,
          lastSyncedAt: finishedAt,
          lastError: null,
          lastEventIds: JSON.stringify(nextEventIds),
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

    writeAuditLog(app.db, {
      projectId: project.id,
      actor: 'api',
      action: 'traffic.cloud-run.synced',
      entityType: 'traffic_source',
      entityId: sourceRow.id,
    })

    // Fire-and-forget telemetry. Never let a hook block the response.
    try {
      opts.onTrafficSynced?.({
        status: 'completed',
        sourceType: sourceRow.sourceType,
        sourceId: sourceRow.id,
        pulledEvents: report.totals.normalizedEvents,
        crawlerHits: report.totals.crawlerHits,
        aiReferralHits: report.totals.aiReferralHits,
        durationMs: Date.now() - syncStartedAtMs,
      })
    } catch {
      // swallow — never block on telemetry
    }

    const response: TrafficSyncResponse = {
      sourceId: sourceRow.id,
      runId,
      syncedAt: finishedAt,
      pulledEvents: report.totals.normalizedEvents,
      crawlerHits: report.totals.crawlerHits,
      aiReferralHits: report.totals.aiReferralHits,
      unknownHits: report.totals.unknownHits,
      crawlerBucketRows,
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
    if (sourceRow.sourceType !== TrafficSourceTypes['cloud-run']) {
      throw validationError(
        `Backfill for source type "${sourceRow.sourceType}" is not implemented yet — only cloud-run is supported in v1.`,
      )
    }

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

    const requestedDays = request.body?.days ?? DEFAULT_BACKFILL_DAYS
    if (!Number.isInteger(requestedDays) || requestedDays <= 0) {
      throw validationError('"days" must be a positive integer')
    }
    const appliedDays = Math.min(requestedDays, MAX_BACKFILL_DAYS)

    const config = parseSourceConfig(sourceRow)
    const gcpProjectId = (config.gcpProjectId as string | undefined) ?? credential.gcpProjectId
    const serviceName = (config.serviceName as string | null | undefined) ?? credential.serviceName ?? undefined
    const location = (config.location as string | null | undefined) ?? credential.location ?? undefined

    const windowEnd = new Date()
    const windowStart = new Date(windowEnd.getTime() - appliedDays * 86_400_000)
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
      gcpProjectId,
      serviceName,
      location,
      credential,
      windowStart,
      windowEnd,
      appliedDays,
      pullEvents,
      resolveAccessToken,
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
      if (kindParam === 'all' || kindParam === TrafficEventKinds.crawler || kindParam === TrafficEventKinds['ai-referral']) {
        kind = kindParam
      } else {
        throw validationError(`"kind" must be one of: all, ${TrafficEventKinds.crawler}, ${TrafficEventKinds['ai-referral']}`)
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
        aiReferralHits: aiReferralTotal,
      },
      events: trimmed,
    }
    return response
  })
}
