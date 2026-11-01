import { createHash } from 'node:crypto'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { and, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm'
import { addLikelyFakeAgentHits, correctBackgroundCallJourneys, writeUnrecognizedAgentBuckets, type BackgroundCallJourneyCorrection } from '@canonry/canonry-api-routes'
import {
  AgentTrustLevels,
  AgentTrustReasons,
  describeError,
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  UNRECORDED_TRAFFIC_PATH,
  VerificationStatuses,
  type NormalizedTrafficRequest,
} from '@canonry/canonry-contracts'
import type { DatabaseClient } from '@canonry/canonry-db'
import {
  agentJourneyCaptureDays,
  agentJourneyEvents,
  aiUserFetchEventsHourly,
  aiUserFetchVerificationManifestsHourly,
  crawlerEventsHourly,
  migrationsTable,
  RawEventSampleEventTypes,
  rawEventSamples,
  trafficReclassificationState,
  unrecognizedAgentEventsHourly,
} from '@canonry/canonry-db'
import {
  AGENT_TRUST_RULES_VERSION,
  BROWSER_SHAPED_AGENT_MARKERS,
  classifyAiUserFetch,
  classifyCrawler,
  DEFAULT_AI_CRAWLER_RULES,
  GENERIC_HTTP_CLIENTS,
  isScannerPath,
  isSelfTraffic,
  JOURNEY_RULES_VERSION,
  normalizeTrafficPathPattern,
  SCANNER_BURST_WINDOW_MS,
  SELF_TRAFFIC_USER_AGENT_PATTERNS,
  UNLISTED_AGENT_SKIPPED_EXTENSIONS,
  UNRECOGNIZED_AGENT_NAMING_VERSION,
  unrecognizedAgentName,
  type ClassifiedAiUserFetch,
  type ClassifiedCrawler,
} from '@canonry/canonry-integration-traffic'
import { createLogger } from './logger.js'

const log = createLogger('TrafficReclassify')

const STATE_ID = 'default'
/** Rows per write transaction, so ingest is never held up for long. */
const BATCH_SIZE = 200
/** The migration that created `unrecognized_agent_events_hourly`. */
const UNRECOGNIZED_TABLE_MIGRATION = 201
/** How long a server waits after startup before checking the rules. */
export const TRAFFIC_RECLASSIFY_START_DELAY_MS = 30_000

export interface StoredTrafficReclassification {
  dryRun: boolean
  /** Raw samples no rule recognized when they were stored. */
  samples: {
    examined: number
    reclassified: number
    /** Reclassified samples added to hourly counts (see `countSample`). */
    counted: number
    /** Samples of Canonry's own tools, deleted. */
    removed: number
    byBot: Record<string, number>
  }
  /** Hourly rows of bots no rule recognized when they were stored. */
  unrecognized: {
    examined: number
    /** Rows a rule now recognizes, moved into that bot's hourly counts. */
    moved: number
    movedHits: number
    /** Rows the current naming gives a different name, merged under it. */
    renamed: number
    /** Rows of Canonry's own tools, or that the current naming names nobody. */
    removed: number
    byBot: Record<string, number>
  }
  /** Unverified AI agent hourly rows for a page scanners ask for. */
  agentHits: {
    examined: number
    /** Rows moved to the likely fake counts. */
    moved: number
    movedHits: number
  }
  /** Stored agent requests (Journeys > Agents) under today's trust rules. */
  agentRequests: {
    examined: number
    /** Requests for a page scanners ask for. */
    probes: number
    /** Probes and the other requests their client sent within the burst window, removed. */
    removed: number
  }
  /** AI visitor journeys that a background call opened or marked as from an AI engine. */
  journeys: BackgroundCallJourneyCorrection
}

type Tx = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0]

type Verdict =
  | { kind: 'self' }
  | { kind: 'user-fetch', fetch: ClassifiedAiUserFetch }
  | { kind: 'crawler', crawler: ClassifiedCrawler }
  | { kind: 'unknown' }

/** Everything that decides how stored unknown traffic is classified or named. */
export function trafficClassificationFingerprint(): string {
  const pattern = (value: RegExp) => `/${value.source}/${value.flags}`
  return createHash('sha256').update(JSON.stringify({
    rules: DEFAULT_AI_CRAWLER_RULES.map(rule => ({
      id: rule.id,
      operator: rule.operator,
      product: rule.product,
      purpose: rule.purpose,
      patterns: rule.userAgentPatterns.map(pattern),
    })),
    self: SELF_TRAFFIC_USER_AGENT_PATTERNS.map(pattern),
    naming: UNRECOGNIZED_AGENT_NAMING_VERSION,
    trust: AGENT_TRUST_RULES_VERSION,
    journeys: JOURNEY_RULES_VERSION,
    genericClients: GENERIC_HTTP_CLIENTS,
    browserMarkers: BROWSER_SHAPED_AGENT_MARKERS,
    skippedExtensions: UNLISTED_AGENT_SKIPPED_EXTENSIONS,
  })).digest('hex')
}

function probeRequest(userAgent: string, path: string, observedAt: string): NormalizedTrafficRequest {
  return {
    sourceType: TrafficSourceTypes['cloud-run'],
    evidenceKind: TrafficEvidenceKinds['raw-request'],
    confidence: TrafficEventConfidences.observed,
    eventId: 'reclassify',
    observedAt,
    method: 'GET',
    requestUrl: `https://placeholder${path.startsWith('/') ? path : '/'}`,
    host: 'placeholder',
    path,
    queryString: null,
    status: 200,
    userAgent,
    // Stored traffic keeps no client address, so no replay can verify an IP.
    remoteIp: null,
    referer: null,
    latencyMs: null,
    requestSizeBytes: null,
    responseSizeBytes: null,
    providerResource: { type: 'cloud_run_revision', labels: {} },
    providerLabels: {},
  }
}

function classifyStored(userAgent: string, path: string, observedAt: string): Verdict {
  const request = probeRequest(userAgent, path, observedAt)
  if (isSelfTraffic(request)) return { kind: 'self' }
  // User-fetch rules first: classifyCrawler skips them by purpose.
  const fetch = classifyAiUserFetch(request)
  if (fetch) return { kind: 'user-fetch', fetch }
  const crawler = classifyCrawler(request)
  if (crawler) return { kind: 'crawler', crawler }
  return { kind: 'unknown' }
}

/** SQLite's CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS") is UTC with no zone mark. */
function sqliteUtcToIso(value: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value
}

function hourOf(iso: string): string {
  const hour = new Date(iso)
  hour.setUTCMinutes(0, 0, 0)
  return hour.toISOString()
}

/**
 * The first hour whose named unrecognized agents were counted by name. From
 * then on, a reclassified sample of a named agent is already inside the hits
 * the unrecognized pass moves, so counting the sample too would add it twice.
 */
function unrecognizedCountingStart(db: DatabaseClient): string | null {
  const row = db.select({ appliedAt: migrationsTable.appliedAt })
    .from(migrationsTable)
    .where(eq(migrationsTable.version, UNRECOGNIZED_TABLE_MIGRATION))
    .get()
  return row ? hourOf(sqliteUtcToIso(row.appliedAt)) : null
}

function addHourlyHits(tx: Tx, opts: {
  projectId: string
  sourceId: string
  tsHour: string
  verdict: Extract<Verdict, { kind: 'user-fetch' | 'crawler' }>
  pathNormalized: string
  status: number
  hits: number
  sampledUserAgent: string
  now: string
}): void {
  const { projectId, sourceId, tsHour, verdict, pathNormalized, status, hits, sampledUserAgent, now } = opts
  // Likely fake agent requests never join AI user fetch hits, as at ingest.
  if (verdict.kind === 'user-fetch' && verdict.fetch.trust === AgentTrustLevels.likely_fake) {
    addLikelyFakeAgentHits(tx, {
      projectId,
      sourceId,
      buckets: [{ tsHour, botId: verdict.fetch.botId, operator: verdict.fetch.operator, reason: verdict.fetch.trustReasons[0]!, hits }],
      now,
    })
    return
  }
  const table = verdict.kind === 'user-fetch' ? aiUserFetchEventsHourly : crawlerEventsHourly
  const classified = verdict.kind === 'user-fetch' ? verdict.fetch : verdict.crawler
  tx.insert(table).values({
    projectId,
    sourceId,
    tsHour,
    botId: classified.botId,
    operator: classified.operator,
    verificationStatus: classified.verificationStatus,
    pathNormalized,
    status,
    hits,
    sampledUserAgent,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [table.projectId, table.sourceId, table.tsHour, table.botId, table.verificationStatus, table.pathNormalized, table.status],
    set: { hits: sql`${table.hits} + ${hits}`, updatedAt: now },
  }).run()
}

function botIdOf(verdict: Extract<Verdict, { kind: 'user-fetch' | 'crawler' }>): string {
  return verdict.kind === 'user-fetch' ? verdict.fetch.botId : verdict.crawler.botId
}

async function reclassifyUnrecognizedRows(db: DatabaseClient, opts: {
  projectIds?: readonly string[]
  dryRun: boolean
  now: string
  shouldStop: () => boolean
}): Promise<StoredTrafficReclassification['unrecognized']> {
  const result: StoredTrafficReclassification['unrecognized'] = { examined: 0, moved: 0, movedHits: 0, renamed: 0, removed: 0, byBot: {} }
  const table = unrecognizedAgentEventsHourly
  const verdicts = new Map<string, Verdict>()
  // Page by rowid so memory stays flat however many rows there are. Rows added
  // after the pass starts (ingest, or a rename's new row) already follow
  // today's rules, so the pass stops at the last rowid it started with.
  const lastStartingRowid = Number(db.select({ max: sql<number | null>`max(rowid)` }).from(table).get()?.max ?? 0)
  let lastRowid = 0
  for (;;) {
    if (opts.shouldStop()) break
    const keys = db.select({ rowid: sql<number>`rowid`, projectId: table.projectId, sourceId: table.sourceId, tsHour: table.tsHour, agentName: table.agentName })
      .from(table)
      .where(and(
        sql`rowid > ${lastRowid}`,
        sql`rowid <= ${lastStartingRowid}`,
        opts.projectIds ? inArray(table.projectId, [...opts.projectIds]) : undefined,
      ))
      .orderBy(sql`rowid`)
      .limit(BATCH_SIZE)
      .all()
    if (keys.length === 0) break
    lastRowid = keys[keys.length - 1]!.rowid
    result.examined += keys.length
    db.transaction((tx) => {
      for (const key of keys) {
        // Re-read inside the transaction: ingest may have added hits since.
        const match = and(
          eq(table.projectId, key.projectId),
          eq(table.sourceId, key.sourceId),
          eq(table.tsHour, key.tsHour),
          eq(table.agentName, key.agentName),
        )
        const row = tx.select().from(table).where(match).get()
        if (!row?.sampledUserAgent) continue
        const userAgent = row.sampledUserAgent
        // A neutral path: one sampled page must not mark every hit in the hour
        // as a scanner. The rule match itself reads only the user agent.
        let verdict = verdicts.get(userAgent)
        if (!verdict) {
          verdict = classifyStored(userAgent, '/', row.tsHour)
          verdicts.set(userAgent, verdict)
        }

        if (verdict.kind === 'self') {
          result.removed++
          if (!opts.dryRun) tx.delete(table).where(match).run()
          continue
        }
        if (verdict.kind === 'user-fetch' || verdict.kind === 'crawler') {
          result.moved++
          result.movedHits += row.hits
          const botId = botIdOf(verdict)
          result.byBot[botId] = (result.byBot[botId] ?? 0) + row.hits
          if (opts.dryRun) continue
          // The hour kept one count per name, not per page or status.
          addHourlyHits(tx, {
            projectId: row.projectId,
            sourceId: row.sourceId,
            tsHour: row.tsHour,
            verdict,
            pathNormalized: UNRECORDED_TRAFFIC_PATH,
            status: 0,
            hits: row.hits,
            sampledUserAgent: userAgent,
            now: opts.now,
          })
          tx.delete(table).where(match).run()
          continue
        }

        const name = unrecognizedAgentName({ method: 'GET', path: row.sampledPath, userAgent })
        if (name === row.agentName) continue
        if (name === null) {
          result.removed++
          if (!opts.dryRun) tx.delete(table).where(match).run()
          continue
        }
        result.renamed++
        if (opts.dryRun) continue
        tx.delete(table).where(match).run()
        writeUnrecognizedAgentBuckets(tx, {
          projectId: row.projectId,
          sourceId: row.sourceId,
          buckets: [{ tsHour: row.tsHour, agentName: name, hits: row.hits, sampledUserAgent: userAgent, sampledPath: row.sampledPath ?? '' }],
          now: opts.now,
        })
      }
    }, { behavior: 'immediate' })
    await yieldToEventLoop()
  }
  return result
}

async function reclassifyUnknownSamples(db: DatabaseClient, opts: {
  projectIds?: readonly string[]
  dryRun: boolean
  now: string
  shouldStop: () => boolean
}): Promise<StoredTrafficReclassification['samples']> {
  const result: StoredTrafficReclassification['samples'] = { examined: 0, reclassified: 0, counted: 0, removed: 0, byBot: {} }
  const countingStart = unrecognizedCountingStart(db)
  // Page by rowid: a server may hold a month of unknown samples. Samples
  // stored after the pass starts were classified under today's rules.
  const lastStartingRowid = Number(db.select({ max: sql<number | null>`max(rowid)` }).from(rawEventSamples).get()?.max ?? 0)
  let lastRowid = 0
  for (;;) {
    if (opts.shouldStop()) break
    const samples = db.select({
      rowid: sql<number>`rowid`,
      id: rawEventSamples.id,
      projectId: rawEventSamples.projectId,
      sourceId: rawEventSamples.sourceId,
      ts: rawEventSamples.ts,
      userAgent: rawEventSamples.userAgent,
      pathNormalized: rawEventSamples.pathNormalized,
      status: rawEventSamples.status,
    })
      .from(rawEventSamples)
      .where(and(
        eq(rawEventSamples.eventType, RawEventSampleEventTypes.unknown),
        sql`rowid > ${lastRowid}`,
        sql`rowid <= ${lastStartingRowid}`,
        opts.projectIds ? inArray(rawEventSamples.projectId, [...opts.projectIds]) : undefined,
      ))
      .orderBy(sql`rowid`)
      .limit(BATCH_SIZE)
      .all()
    if (samples.length === 0) break
    lastRowid = samples[samples.length - 1]!.rowid
    result.examined += samples.length
    db.transaction((tx) => {
      for (const sample of samples) {
        if (!sample.userAgent) continue
        // A sample is one real request, so its own path feeds the trust check.
        const verdict = classifyStored(sample.userAgent, sample.pathNormalized, sample.ts)
        if (verdict.kind === 'self') {
          result.removed++
          if (!opts.dryRun) tx.delete(rawEventSamples).where(eq(rawEventSamples.id, sample.id)).run()
          continue
        }
        if (verdict.kind === 'unknown') continue
        result.reclassified++
        const botId = botIdOf(verdict)
        result.byBot[botId] = (result.byBot[botId] ?? 0) + 1
        const tsHour = hourOf(sample.ts)
        // Count the sample only where nothing else counted it: before named
        // agents were counted by name, or a request no name was recorded for.
        const countSample = countingStart === null
          || tsHour < countingStart
          || unrecognizedAgentName({ method: 'GET', path: sample.pathNormalized, userAgent: sample.userAgent }) === null
        if (countSample) result.counted++
        if (opts.dryRun) continue

        // Raw samples keep no address, so nothing here can verify an IP: the
        // added hit has no provenance sidecar and reads back as unattributed.
        tx.update(rawEventSamples).set({
          eventType: verdict.kind === 'user-fetch' ? RawEventSampleEventTypes.aiUserFetch : RawEventSampleEventTypes.crawler,
          classifierDetailsJson: {
            crawler: verdict.kind === 'crawler' ? { ...verdict.crawler, verificationManifest: null } : null,
            aiUserFetch: verdict.kind === 'user-fetch' ? { ...verdict.fetch, verificationManifest: null } : null,
            aiReferral: null,
          },
        }).where(eq(rawEventSamples.id, sample.id)).run()
        if (!countSample) continue
        addHourlyHits(tx, {
          projectId: sample.projectId,
          sourceId: sample.sourceId,
          tsHour,
          verdict,
          pathNormalized: sample.pathNormalized,
          status: sample.status ?? 200,
          hits: 1,
          sampledUserAgent: sample.userAgent,
          now: opts.now,
        })
      }
    }, { behavior: 'immediate' })
    await yieldToEventLoop()
  }
  return result
}

type HourlyAgentKey = {
  projectId: string
  sourceId: string
  tsHour: string
  botId: string
  verificationStatus: string
  pathNormalized: string
  status: number
}

function hourlyAgentRow(key: HourlyAgentKey) {
  const table = aiUserFetchEventsHourly
  return and(
    eq(table.projectId, key.projectId),
    eq(table.sourceId, key.sourceId),
    eq(table.tsHour, key.tsHour),
    eq(table.botId, key.botId),
    eq(table.verificationStatus, key.verificationStatus),
    eq(table.pathNormalized, key.pathNormalized),
    eq(table.status, key.status),
  )
}

/**
 * Move unverified AI agent hourly rows for a page scanners ask for into the
 * likely fake counts, as ingest does today. Each row is one page, so the
 * check is exact. Hourly rows keep no client, so the burst rule cannot apply.
 */
async function reassessAgentHits(db: DatabaseClient, opts: {
  projectIds?: readonly string[]
  dryRun: boolean
  now: string
  shouldStop: () => boolean
}): Promise<StoredTrafficReclassification['agentHits']> {
  const result: StoredTrafficReclassification['agentHits'] = { examined: 0, moved: 0, movedHits: 0 }
  const table = aiUserFetchEventsHourly
  const lastStartingRowid = Number(db.select({ max: sql<number | null>`max(rowid)` }).from(table).get()?.max ?? 0)
  let lastRowid = 0
  for (;;) {
    if (opts.shouldStop()) break
    const rows = db.select({
      rowid: sql<number>`rowid`,
      projectId: table.projectId,
      sourceId: table.sourceId,
      tsHour: table.tsHour,
      botId: table.botId,
      operator: table.operator,
      verificationStatus: table.verificationStatus,
      pathNormalized: table.pathNormalized,
      status: table.status,
    })
      .from(table)
      .where(and(
        sql`rowid > ${lastRowid}`,
        sql`rowid <= ${lastStartingRowid}`,
        ne(table.verificationStatus, VerificationStatuses.verified),
        opts.projectIds ? inArray(table.projectId, [...opts.projectIds]) : undefined,
      ))
      .orderBy(sql`rowid`)
      .limit(BATCH_SIZE)
      .all()
    if (rows.length === 0) break
    lastRowid = rows[rows.length - 1]!.rowid
    result.examined += rows.length
    const probes = rows.filter(row => isScannerPath(row.pathNormalized))
    if (probes.length > 0) {
      db.transaction((tx) => {
        for (const row of probes) {
          // Re-read inside the transaction: ingest may have added hits since.
          const current = tx.select({ hits: table.hits }).from(table).where(hourlyAgentRow(row)).get()
          if (!current) continue
          result.moved++
          result.movedHits += current.hits
          if (opts.dryRun) continue
          addLikelyFakeAgentHits(tx, {
            projectId: row.projectId,
            sourceId: row.sourceId,
            buckets: [{ tsHour: row.tsHour, botId: row.botId, operator: row.operator, reason: AgentTrustReasons['scanner-path'], hits: current.hits }],
            now: opts.now,
          })
          // Its verification provenance rows go with it.
          tx.delete(table).where(hourlyAgentRow(row)).run()
        }
      }, { behavior: 'immediate' })
    }
    await yieldToEventLoop()
  }
  return result
}

/** Move one AI agent hit of a stored request into the burst's likely fake count. */
function moveAgentHitToBurst(tx: Tx, row: typeof agentJourneyEvents.$inferSelect, now: string): void {
  const key: HourlyAgentKey = {
    projectId: row.projectId,
    sourceId: row.sourceId,
    tsHour: hourOf(row.ts),
    botId: row.agentId,
    verificationStatus: row.verificationStatus,
    pathNormalized: normalizeTrafficPathPattern(row.path),
    status: row.status ?? 0,
  }
  const table = aiUserFetchEventsHourly
  // A path shortened for storage may not name its hourly row; then nothing moves.
  const taken = tx.update(table).set({ hits: sql`${table.hits} - 1`, updatedAt: now })
    .where(and(hourlyAgentRow(key), sql`${table.hits} > 0`))
    .run()
  if (taken.changes === 0) return
  const manifests = aiUserFetchVerificationManifestsHourly
  if (row.verificationManifest) {
    const manifestRow = and(
      eq(manifests.projectId, key.projectId),
      eq(manifests.sourceId, key.sourceId),
      eq(manifests.tsHour, key.tsHour),
      eq(manifests.botId, key.botId),
      eq(manifests.verificationStatus, key.verificationStatus),
      eq(manifests.pathNormalized, key.pathNormalized),
      eq(manifests.status, key.status),
      eq(manifests.manifestId, row.verificationManifest.id),
    )
    tx.update(manifests).set({ hits: sql`${manifests.hits} - 1`, updatedAt: now }).where(and(manifestRow, sql`${manifests.hits} > 0`)).run()
    tx.delete(manifests).where(and(manifestRow, sql`${manifests.hits} <= 0`)).run()
  }
  tx.delete(table).where(and(hourlyAgentRow(key), sql`${table.hits} <= 0`)).run()
  addLikelyFakeAgentHits(tx, {
    projectId: row.projectId,
    sourceId: row.sourceId,
    buckets: [{ tsHour: key.tsHour, botId: row.agentId, operator: row.operator, reason: AgentTrustReasons['scanner-burst'], hits: 1 }],
    now,
  })
}

/**
 * Stored agent requests (Journeys > Agents) under today's trust rules. A
 * request for a page scanners ask for is removed, with every unverified
 * request its client sent within the burst window. A stored client is the
 * correlation the row keeps (IP and user agent), not the IP alone. A probe's
 * hourly row moves in `reassessAgentHits`; each other request moves one hit.
 */
async function reassessAgentRequests(db: DatabaseClient, opts: {
  projectIds?: readonly string[]
  dryRun: boolean
  now: string
  shouldStop: () => boolean
}): Promise<StoredTrafficReclassification['agentRequests']> {
  const result: StoredTrafficReclassification['agentRequests'] = { examined: 0, probes: 0, removed: 0 }
  const table = agentJourneyEvents
  const clients = new Map<string, { projectId: string, sourceId: string, correlationKey: string, probes: number[] }>()
  const lastStartingRowid = Number(db.select({ max: sql<number | null>`max(rowid)` }).from(table).get()?.max ?? 0)
  let lastRowid = 0
  for (;;) {
    if (opts.shouldStop()) return result
    const rows = db.select({ rowid: sql<number>`rowid`, projectId: table.projectId, sourceId: table.sourceId, correlationKey: table.correlationKey, ts: table.ts, path: table.path })
      .from(table)
      .where(and(
        sql`rowid > ${lastRowid}`,
        sql`rowid <= ${lastStartingRowid}`,
        ne(table.trust, AgentTrustLevels.verified),
        opts.projectIds ? inArray(table.projectId, [...opts.projectIds]) : undefined,
      ))
      .orderBy(sql`rowid`)
      .limit(BATCH_SIZE)
      .all()
    if (rows.length === 0) break
    lastRowid = rows[rows.length - 1]!.rowid
    result.examined += rows.length
    for (const row of rows) {
      if (!isScannerPath(row.path)) continue
      result.probes++
      const id = JSON.stringify([row.projectId, row.sourceId, row.correlationKey])
      const client = clients.get(id) ?? { projectId: row.projectId, sourceId: row.sourceId, correlationKey: row.correlationKey, probes: [] }
      client.probes.push(Date.parse(row.ts))
      clients.set(id, client)
    }
    await yieldToEventLoop()
  }

  for (const client of clients.values()) {
    if (opts.shouldStop()) break
    const probes = client.probes.sort((a, b) => a - b)
    const from = new Date(probes[0]! - SCANNER_BURST_WINDOW_MS).toISOString()
    const to = new Date(probes.at(-1)! + SCANNER_BURST_WINDOW_MS).toISOString()
    db.transaction((tx) => {
      const rows = tx.select().from(table).where(and(
        eq(table.projectId, client.projectId),
        eq(table.sourceId, client.sourceId),
        eq(table.correlationKey, client.correlationKey),
        gte(table.ts, from),
        lte(table.ts, to),
        ne(table.trust, AgentTrustLevels.verified),
      )).all()
      for (const row of rows) {
        const probe = isScannerPath(row.path)
        const at = Date.parse(row.ts)
        if (!probe && !probes.some(t => Math.abs(at - t) <= SCANNER_BURST_WINDOW_MS)) continue
        result.removed++
        if (opts.dryRun) continue
        tx.delete(table).where(eq(table.id, row.id)).run()
        // The row no longer counts toward its day's capture limit.
        tx.update(agentJourneyCaptureDays)
          .set({ storedEvents: sql`max(${agentJourneyCaptureDays.storedEvents} - 1, 0)` })
          .where(and(
            eq(agentJourneyCaptureDays.projectId, row.projectId),
            eq(agentJourneyCaptureDays.sourceId, row.sourceId),
            eq(agentJourneyCaptureDays.day, row.ts.slice(0, 10)),
          ))
          .run()
        if (!probe) moveAgentHitToBurst(tx, row, opts.now)
      }
    }, { behavior: 'immediate' })
    await yieldToEventLoop()
  }
  return result
}

/**
 * Reclassify stored traffic under today's rules. Unknown raw samples and the
 * hourly rows of unrecognized agents: a row a rule now recognizes moves into
 * that bot's hourly counts (claimed, since stored traffic keeps no IP; the
 * page is unrecorded), rows of Canonry's own tools are deleted, and the rest
 * are renamed or dropped to match today's naming. AI agent traffic: hourly
 * rows and stored requests that today's trust rules call likely fake move to
 * the likely fake counts. Journeys: background calls stop opening visits or
 * counting as AI arrivals (`correctBackgroundCallJourneys`). Safe to run any
 * number of times.
 */
export async function reclassifyStoredTraffic(db: DatabaseClient, opts: {
  projectIds?: readonly string[]
  dryRun?: boolean
  now?: string
  shouldStop?: () => boolean
} = {}): Promise<StoredTrafficReclassification> {
  const shared = {
    projectIds: opts.projectIds,
    dryRun: opts.dryRun === true,
    now: opts.now ?? new Date().toISOString(),
    shouldStop: opts.shouldStop ?? (() => false),
  }
  const samples = await reclassifyUnknownSamples(db, shared)
  const unrecognized = shared.shouldStop()
    ? { examined: 0, moved: 0, movedHits: 0, renamed: 0, removed: 0, byBot: {} }
    : await reclassifyUnrecognizedRows(db, shared)
  // Hourly rows first: a probe's own row moves there, its client's other requests here.
  const agentHits = shared.shouldStop() ? { examined: 0, moved: 0, movedHits: 0 } : await reassessAgentHits(db, shared)
  const agentRequests = shared.shouldStop() ? { examined: 0, probes: 0, removed: 0 } : await reassessAgentRequests(db, shared)
  const journeys = shared.shouldStop()
    ? { visitors: 0, visitorsRemoved: 0, visitsRemoved: 0, visitsRelanded: 0 }
    : correctBackgroundCallJourneys(db, shared)
  return { dryRun: shared.dryRun, samples, unrecognized, agentHits, agentRequests, journeys }
}

/**
 * Reclassify stored traffic once per change of the classification rules. The
 * fingerprint is recorded only after a full pass, so a pass cut short by
 * shutdown runs again on the next start.
 */
export async function reclassifyStoredTrafficIfRulesChanged(db: DatabaseClient, opts: {
  now?: () => string
  shouldStop?: () => boolean
} = {}): Promise<{ ran: boolean, result?: StoredTrafficReclassification }> {
  const fingerprint = trafficClassificationFingerprint()
  const state = db.select().from(trafficReclassificationState).where(eq(trafficReclassificationState.id, STATE_ID)).get()
  if (state?.fingerprint === fingerprint) return { ran: false }
  const now = opts.now ?? (() => new Date().toISOString())
  const shouldStop = opts.shouldStop ?? (() => false)
  const result = await reclassifyStoredTraffic(db, { now: now(), shouldStop })
  if (shouldStop()) return { ran: false }
  const completedAt = now()
  db.insert(trafficReclassificationState)
    .values({ id: STATE_ID, fingerprint, completedAt, resultJson: { ...result } })
    .onConflictDoUpdate({
      target: trafficReclassificationState.id,
      set: { fingerprint, completedAt, resultJson: { ...result } },
    })
    .run()
  return { ran: true, result }
}

/** Check the rules shortly after startup, off the boot path. Returns a stop. */
export function startTrafficReclassification(opts: { db: DatabaseClient, delayMs?: number }): () => void {
  let stopped = false
  const timer = setTimeout(() => {
    reclassifyStoredTrafficIfRulesChanged(opts.db, { shouldStop: () => stopped })
      .then((outcome) => {
        if (!outcome.ran || !outcome.result) return
        const { samples, unrecognized, agentHits, agentRequests, journeys } = outcome.result
        log.info('traffic-reclassify.completed', {
          samplesReclassified: samples.reclassified,
          samplesCounted: samples.counted,
          samplesRemoved: samples.removed,
          unrecognizedMoved: unrecognized.moved,
          unrecognizedMovedHits: unrecognized.movedHits,
          unrecognizedRenamed: unrecognized.renamed,
          unrecognizedRemoved: unrecognized.removed,
          agentHitsMoved: agentHits.movedHits,
          agentRequestsRemoved: agentRequests.removed,
          journeyVisitorsRemoved: journeys.visitorsRemoved,
          journeyVisitsRemoved: journeys.visitsRemoved,
          journeyVisitsRelanded: journeys.visitsRelanded,
        })
      })
      .catch((err: unknown) => {
        if (!stopped) log.error('traffic-reclassify.failed', { error: describeError(err) })
      })
  }, opts.delayMs ?? TRAFFIC_RECLASSIFY_START_DELAY_MS)
  timer.unref()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
