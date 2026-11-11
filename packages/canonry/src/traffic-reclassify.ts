import { createHash } from 'node:crypto'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql, type Column, type SQL } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { addLikelyFakeAgentHits, correctBackgroundCallJourneys, mergeSplitJourneyVisitors, repairAiReferralArrivalsOnStartup, writeUnrecognizedAgentBuckets, type BackgroundCallJourneyCorrection, type SplitVisitorMerge } from '@canonry/canonry-api-routes'
import {
  AgentTrustLevels,
  AgentTrustReasons,
  asRecord,
  describeError,
  sortedUnique,
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  UNRECORDED_TRAFFIC_PATH,
  VerificationStatuses,
  type NormalizedTrafficRequest,
} from '@canonry/canonry-contracts'
import type { DatabaseClient, RawEventSampleEventType } from '@canonry/canonry-db'
import {
  agentJourneyCaptureDays,
  agentJourneyEvents,
  aiUserFetchEventsHourly,
  aiUserFetchLikelyFakeHourly,
  aiUserFetchVerificationManifestsHourly,
  crawlerEventsHourly,
  crawlerVerificationManifestsHourly,
  migrationsTable,
  projects,
  RawEventSampleEventTypes,
  rawEventSamples,
  trafficReclassificationState,
  trafficSources,
  unrecognizedAgentEventsHourly,
} from '@canonry/canonry-db'
import {
  AGENT_TRUST_RULES_VERSION,
  BROWSER_AGENT_BOT_IDS,
  BROWSER_AGENT_REQUEST_RULES_VERSION,
  BROWSER_SHAPED_AGENT_MARKERS,
  browserAgentRequestKind,
  classifyAiUserFetch,
  classifyCrawler,
  countsAsAiUserFetchHit,
  DEFAULT_AI_CRAWLER_RULES,
  GENERIC_HTTP_CLIENTS,
  isBrowserAgentId,
  isScannerPath,
  isSelfTraffic,
  JOURNEY_RULES_VERSION,
  keepsBrowserAgentJourneyRequest,
  normalizeTrafficPathPattern,
  rulesShareVerificationList,
  SCANNER_BURST_WINDOW_MS,
  SELF_TRAFFIC_USER_AGENT_PATTERNS,
  UNLISTED_AGENT_SKIPPED_EXTENSIONS,
  UNRECOGNIZED_AGENT_NAMING_VERSION,
  unrecognizedAgentName,
  type ClassifiedAiUserFetch,
  type ClassifiedCrawler,
  type SampledAiUserFetch,
} from '@canonry/canonry-integration-traffic'
import { createLogger } from './logger.js'

const log = createLogger('TrafficReclassify')

const STATE_ID = 'default'
/** Rows per write transaction, so ingest is never held up for long. */
const BATCH_SIZE = 200
/**
 * Rowids per grouped read of crawler hours and crawler samples. Each read
 * counts a span's rows by stored bot and user agent, so the rows themselves
 * are read only for a pair today's rules file elsewhere.
 */
const SCAN_SPAN = 50_000
/** The migration that created `unrecognized_agent_events_hourly`. */
const UNRECOGNIZED_TABLE_MIGRATION = 201
/** How long a server waits after startup before checking the rules. */
export const TRAFFIC_RECLASSIFY_START_DELAY_MS = 30_000
const HOUR_MS = 3_600_000
/** Every rule id this version defines. */
const RULE_IDS: ReadonlySet<string> = new Set(DEFAULT_AI_CRAWLER_RULES.map(rule => rule.id))
/**
 * The browser-agent request rules stored AI user fetch counts follow
 * (`countsAsAiUserFetchHit`). Each completed pass records them in its state,
 * and the fingerprint covers them, so a change runs the pass again, which
 * marks the hours counted the older way.
 */
const BROWSER_AGENT_REQUEST_RULES = {
  version: BROWSER_AGENT_REQUEST_RULES_VERSION,
  botIds: sortedUnique(BROWSER_AGENT_BOT_IDS),
}
const BROWSER_AGENT_REQUEST_RULES_KEY = 'browserAgentRequestRules'

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
  /** Crawler hours whose sampled user agent today's rules file elsewhere (`rekeyCrawlerHours`). */
  crawlers: {
    /** Crawler hours with a sampled user agent, read. */
    examined: number
    /** Hours moved to the crawler rule their sampled user agent names today. */
    moved: number
    movedHits: number
    /** Hours whose agent only an AI user fetch rule names today, moved to those counts (likely fakes to theirs). */
    toUserFetch: number
    toUserFetchHits: number
    /** Hours whose agent no rule names today, moved back to the unrecognized agents under the name ingest gives it. */
    toUnrecognized: number
    toUnrecognizedHits: number
    /** Hours of Canonry's own tools, deleted. */
    removed: number
    removedHits: number
    /**
     * Verified hits these changes left claimed: the new rule checks a
     * different published list, or the hits left the crawler counts. Stored
     * traffic keeps no IP to check again.
     */
    unverifiedHits: number
    /**
     * Hours whose change would leave verified hits claimed, left as they are
     * because the caller did not allow that: the automatic pass after startup
     * leaves them (and logs them) for `canonry backfill traffic-classification`,
     * which makes the change. Their samples stay as they are too.
     */
    heldVerified: number
    heldVerifiedHits: number
    /** Hours under a bot id this version defines no rule for, left as they are: a newer release wrote them. */
    unknownBot: number
    /** Crawler samples relabeled the same way. */
    samplesRelabeled: number
    /** Of those, samples no rule names today, now stored as unknown traffic. */
    samplesNowUnknown: number
    /** Crawler samples of Canonry's own tools, deleted. */
    samplesRemoved: number
    /** Moved hits, by the bot that received them. */
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
    /**
     * Browser-agent requests its pages made by themselves (files, data calls,
     * framework paths), removed unless they failed. Their hourly hits stay:
     * those hours keep the older count (`traffic_sources.ai_user_fetch_older_count_until`).
     */
    pageResources: number
  }
  /** AI visitor journeys that a background call opened or marked as from an AI engine. */
  journeys: BackgroundCallJourneyCorrection
  /** AI visitors that were another visitor seen from a new IP, joined to it. */
  journeyMerges: SplitVisitorMerge
  /**
   * Rows left as they are because their project or traffic source no longer
   * exists (deleted with foreign keys off): writing what they move would fail.
   */
  orphans: number
}

type Tx = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0]

type Verdict =
  | { kind: 'self' }
  | { kind: 'user-fetch', fetch: ClassifiedAiUserFetch }
  | { kind: 'crawler', crawler: ClassifiedCrawler }
  | { kind: 'unknown' }

/** Each paged table's last rowid when the pass started. */
interface PassBounds {
  samples: number
  unrecognized: number
  crawlers: number
  userFetch: number
  agentRequests: number
}

/** What every step of one pass shares. */
interface PassContext {
  projectIds?: readonly string[]
  dryRun: boolean
  now: string
  shouldStop: () => boolean
  /** Make the crawler re-key's changes that leave verified hits claimed. */
  allowVerificationLoss: boolean
  /**
   * Taken before any step writes, so a dry run reads the rows a write run
   * reads, and rows written after the pass starts (ingest, or a step's own
   * moves) already follow today's rules.
   */
  bounds: PassBounds
  /** Projects and sources that existed when the pass started. */
  liveProjectIds: ReadonlySet<string>
  liveSourceIds: ReadonlySet<string>
  orphans: number
}

/** Everything that decides how the pass reclassifies stored traffic. */
export function trafficClassificationFingerprint(): string {
  const pattern = (value: RegExp) => `/${value.source}/${value.flags}`
  return createHash('sha256').update(JSON.stringify({
    rules: DEFAULT_AI_CRAWLER_RULES.map(rule => ({
      id: rule.id,
      operator: rule.operator,
      product: rule.product,
      purpose: rule.purpose,
      patterns: rule.userAgentPatterns.map(pattern),
      browser: rule.browser === true,
    })),
    self: SELF_TRAFFIC_USER_AGENT_PATTERNS.map(pattern),
    naming: UNRECOGNIZED_AGENT_NAMING_VERSION,
    trust: AGENT_TRUST_RULES_VERSION,
    journeys: JOURNEY_RULES_VERSION,
    browserAgentRequests: BROWSER_AGENT_REQUEST_RULES,
    genericClients: GENERIC_HTTP_CLIENTS,
    browserMarkers: BROWSER_SHAPED_AGENT_MARKERS,
    skippedExtensions: UNLISTED_AGENT_SKIPPED_EXTENSIONS,
  })).digest('hex')
}

// Classification reads a request's user agent, path and address, never its
// time. Stored traffic keeps no address, so no replay can verify an IP.
const STORED_REQUEST_TIME = new Date(0).toISOString()

function probeRequest(userAgent: string, path: string): NormalizedTrafficRequest {
  return {
    sourceType: TrafficSourceTypes['cloud-run'],
    evidenceKind: TrafficEvidenceKinds['raw-request'],
    confidence: TrafficEventConfidences.observed,
    eventId: 'reclassify',
    observedAt: STORED_REQUEST_TIME,
    method: 'GET',
    requestUrl: `https://placeholder${path.startsWith('/') ? path : '/'}`,
    host: 'placeholder',
    path,
    queryString: null,
    status: 200,
    userAgent,
    remoteIp: null,
    referer: null,
    latencyMs: null,
    requestSizeBytes: null,
    responseSizeBytes: null,
    providerResource: { type: 'cloud_run_revision', labels: {} },
    providerLabels: {},
  }
}

/** One stored request under today's rules, in ingest's order: Canonry's own tools, user fetch, crawler. */
function classifyStored(userAgent: string, path: string): Verdict {
  const request = probeRequest(userAgent, path)
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

/** The end of a stored hour (exclusive), in the stored form: ISO with milliseconds. */
function hourEnd(tsHour: string): string {
  return new Date(Date.parse(tsHour) + HOUR_MS).toISOString()
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

function lastRowid(db: DatabaseClient, table: SQLiteTable): number {
  return Number(db.select({ max: sql<number | null>`max(rowid)` }).from(table).get()?.max ?? 0)
}

/** Rows after `after`, up to `bound`. */
function rowidRange(after: number, bound: number): SQL {
  return sql`rowid > ${after} and rowid <= ${bound}`
}

/**
 * Limits a read to the selected projects. Unary `+` keeps SQLite on the rowid
 * range: on a plain filter it picks a project index and sorts that project's
 * rows again for every page (`test/traffic-reclassify-query-plan.test.ts`).
 */
function projectScope(column: Column, projectIds: readonly string[] | undefined): SQL | undefined {
  return projectIds ? inArray(sql`+${column}`, [...projectIds]) : undefined
}

/**
 * Read a table a page at a time in rowid order, after `after` and up to
 * `bound`, so memory stays flat however many rows there are. Yields to the
 * event loop between pages and stops when asked. `read` gets the page's rowid
 * range and returns at most BATCH_SIZE rows in rowid order.
 */
async function* rowidPages<T extends { rowid: number }>(
  ctx: Pick<PassContext, 'shouldStop'>,
  span: { after?: number, bound: number },
  read: (range: SQL) => T[],
): AsyncGenerator<T[], void, undefined> {
  let after = span.after ?? 0
  for (;;) {
    if (ctx.shouldStop()) return
    const rows = read(rowidRange(after, span.bound))
    if (rows.length === 0) return
    after = rows[rows.length - 1]!.rowid
    yield rows
    await yieldToEventLoop()
  }
}

/** A write transaction, or in a dry run a deferred one, which only reads and takes no write lock. */
function inBatch<T>(db: DatabaseClient, ctx: Pick<PassContext, 'dryRun'>, work: (tx: Tx) => T): T {
  return db.transaction(work, { behavior: ctx.dryRun ? 'deferred' : 'immediate' })
}

/**
 * True when the project or source of rows the pass would change no longer
 * exists, so nothing they move could be written; counts the rows.
 */
function isOrphan(ctx: PassContext, owner: { projectId: string, sourceId: string }, rows = 1): boolean {
  if (ctx.liveProjectIds.has(owner.projectId) && ctx.liveSourceIds.has(owner.sourceId)) return false
  ctx.orphans += rows
  return true
}

function addTo(counts: Record<string, number>, key: string, value: number): void {
  counts[key] = (counts[key] ?? 0) + value
}

type HourlyTable =
  | typeof crawlerEventsHourly
  | typeof crawlerVerificationManifestsHourly
  | typeof aiUserFetchEventsHourly
  | typeof aiUserFetchVerificationManifestsHourly

type HourlyKey = Pick<typeof crawlerEventsHourly.$inferSelect, 'projectId' | 'sourceId' | 'tsHour' | 'botId' | 'verificationStatus' | 'pathNormalized' | 'status'>

/** The seven key columns of the crawler and AI user fetch hourly tables and their provenance rows. */
function hourlyKeyColumns(table: HourlyTable) {
  return [table.projectId, table.sourceId, table.tsHour, table.botId, table.verificationStatus, table.pathNormalized, table.status]
}

/** One hourly row by its key, or its provenance rows. */
function hourlyRow(table: HourlyTable, key: HourlyKey): SQL | undefined {
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
    target: hourlyKeyColumns(table),
    set: { hits: sql`${table.hits} + ${hits}`, updatedAt: now },
  }).run()
}

/** Remember the end of a browser-agent hour counted under older rules, the latest per source. */
function noteOlderCount(ends: Map<string, string>, sourceId: string, tsHour: string): void {
  const end = hourEnd(tsHour)
  const known = ends.get(sourceId)
  if (known === undefined || Date.parse(known) < Date.parse(end)) ends.set(sourceId, end)
}

/**
 * Mark that sources hold hosted browser agent hours counted under older rules
 * rather than by page loads: `traffic_sources.ai_user_fetch_older_count_until`
 * becomes the later of its value and the end of the source's latest such
 * hour, or `now` when that hour has not ended. A later mark stays: it already
 * covers those hours. Returns how many sources' marks moved.
 */
function markUserFetchOlderCounts(tx: Tx, ends: ReadonlyMap<string, string>, now: string): number {
  const nowMs = Date.parse(now)
  const column = trafficSources.aiUserFetchOlderCountUntil
  let marked = 0
  for (const [sourceId, end] of ends) {
    const until = Date.parse(end) < nowMs ? end : new Date(nowMs).toISOString()
    marked += tx.update(trafficSources)
      .set({ aiUserFetchOlderCountUntil: until })
      .where(and(eq(trafficSources.id, sourceId), or(isNull(column), lt(column, until))))
      .run().changes
  }
  return marked
}

/** Each source's end of its latest hosted browser agent hour, AI user fetch and likely fake rows alike. */
function lastBrowserAgentHourEnds(db: DatabaseClient): Map<string, string> {
  const ends = new Map<string, string>()
  if (BROWSER_AGENT_BOT_IDS.length === 0) return ends
  const ids = [...BROWSER_AGENT_BOT_IDS]
  const counted = db.select({ sourceId: aiUserFetchEventsHourly.sourceId, lastHour: sql<string>`max(${aiUserFetchEventsHourly.tsHour})` })
    .from(aiUserFetchEventsHourly)
    .where(inArray(aiUserFetchEventsHourly.botId, ids))
    .groupBy(aiUserFetchEventsHourly.sourceId)
    .all()
  // Trust rules before v3 sent whole browser-agent sessions to likely fake.
  const likelyFake = db.select({ sourceId: aiUserFetchLikelyFakeHourly.sourceId, lastHour: sql<string>`max(${aiUserFetchLikelyFakeHourly.tsHour})` })
    .from(aiUserFetchLikelyFakeHourly)
    .where(inArray(aiUserFetchLikelyFakeHourly.botId, ids))
    .groupBy(aiUserFetchLikelyFakeHourly.sourceId)
    .all()
  for (const row of [...counted, ...likelyFake]) noteOlderCount(ends, row.sourceId, row.lastHour)
  return ends
}

/** Whether a stored state records the browser-agent request rules this version counts by. */
function countsBrowserAgentsAsRecorded(resultJson: Record<string, unknown> | null | undefined): boolean {
  const recorded = asRecord(resultJson?.[BROWSER_AGENT_REQUEST_RULES_KEY])
  if (!recorded || recorded.version !== BROWSER_AGENT_REQUEST_RULES.version || !Array.isArray(recorded.botIds)) return false
  const botIds = sortedUnique(recorded.botIds.filter((id): id is string => typeof id === 'string'))
  return botIds.length === BROWSER_AGENT_REQUEST_RULES.botIds.length
    && botIds.every((id, index) => id === BROWSER_AGENT_REQUEST_RULES.botIds[index])
}

function botIdOf(verdict: Extract<Verdict, { kind: 'user-fetch' | 'crawler' }>): string {
  return verdict.kind === 'user-fetch' ? verdict.fetch.botId : verdict.crawler.botId
}

async function reclassifyUnrecognizedRows(db: DatabaseClient, ctx: PassContext): Promise<StoredTrafficReclassification['unrecognized']> {
  const result: StoredTrafficReclassification['unrecognized'] = { examined: 0, moved: 0, movedHits: 0, renamed: 0, removed: 0, byBot: {} }
  const table = unrecognizedAgentEventsHourly
  const verdicts = new Map<string, Verdict>()
  const pages = rowidPages(ctx, { bound: ctx.bounds.unrecognized }, range => db
    .select({ rowid: sql<number>`rowid`, projectId: table.projectId, sourceId: table.sourceId, tsHour: table.tsHour, agentName: table.agentName })
    .from(table)
    .where(and(range, projectScope(table.projectId, ctx.projectIds)))
    .orderBy(sql`rowid`)
    .limit(BATCH_SIZE)
    .all())
  for await (const keys of pages) {
    result.examined += keys.length
    inBatch(db, ctx, (tx) => {
      const olderCounts = new Map<string, string>()
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
          verdict = classifyStored(userAgent, '/')
          verdicts.set(userAgent, verdict)
        }

        if (verdict.kind === 'self') {
          result.removed++
          if (!ctx.dryRun) tx.delete(table).where(match).run()
          continue
        }
        if (verdict.kind === 'user-fetch' || verdict.kind === 'crawler') {
          if (isOrphan(ctx, row)) continue
          result.moved++
          result.movedHits += row.hits
          addTo(result.byBot, botIdOf(verdict), row.hits)
          if (ctx.dryRun) continue
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
            now: ctx.now,
          })
          tx.delete(table).where(match).run()
          // Its GET and HEAD requests for anything but a static file were
          // counted, not only page loads: the source holds an older count.
          if (verdict.kind === 'user-fetch' && verdict.fetch.browser) noteOlderCount(olderCounts, row.sourceId, row.tsHour)
          continue
        }

        const name = unrecognizedAgentName({ method: 'GET', path: row.sampledPath, userAgent })
        if (name === row.agentName) continue
        if (name === null) {
          result.removed++
          if (!ctx.dryRun) tx.delete(table).where(match).run()
          continue
        }
        if (isOrphan(ctx, row)) continue
        result.renamed++
        if (ctx.dryRun) continue
        tx.delete(table).where(match).run()
        writeUnrecognizedAgentBuckets(tx, {
          projectId: row.projectId,
          sourceId: row.sourceId,
          buckets: [{ tsHour: row.tsHour, agentName: name, hits: row.hits, sampledUserAgent: userAgent, sampledPath: row.sampledPath ?? '' }],
          now: ctx.now,
        })
      }
      if (!ctx.dryRun) markUserFetchOlderCounts(tx, olderCounts, ctx.now)
    })
  }
  return result
}

async function reclassifyUnknownSamples(db: DatabaseClient, ctx: PassContext): Promise<StoredTrafficReclassification['samples']> {
  const result: StoredTrafficReclassification['samples'] = { examined: 0, reclassified: 0, counted: 0, removed: 0, byBot: {} }
  const countingStart = unrecognizedCountingStart(db)
  const table = rawEventSamples
  // A server may hold a month of unknown samples.
  const pages = rowidPages(ctx, { bound: ctx.bounds.samples }, range => db
    .select({
      rowid: sql<number>`rowid`,
      id: table.id,
      projectId: table.projectId,
      sourceId: table.sourceId,
      ts: table.ts,
      userAgent: table.userAgent,
      pathNormalized: table.pathNormalized,
      status: table.status,
    })
    .from(table)
    .where(and(eq(table.eventType, RawEventSampleEventTypes.unknown), range, projectScope(table.projectId, ctx.projectIds)))
    .orderBy(sql`rowid`)
    .limit(BATCH_SIZE)
    .all())
  for await (const samples of pages) {
    result.examined += samples.length
    inBatch(db, ctx, (tx) => {
      for (const sample of samples) {
        if (!sample.userAgent) continue
        // A sample is one real request, so its own path feeds the trust check.
        const verdict = classifyStored(sample.userAgent, sample.pathNormalized)
        if (verdict.kind === 'unknown') continue
        if (verdict.kind === 'self') {
          result.removed++
          if (!ctx.dryRun) tx.delete(table).where(eq(table.id, sample.id)).run()
          continue
        }
        if (isOrphan(ctx, sample)) continue
        result.reclassified++
        addTo(result.byBot, botIdOf(verdict), 1)
        const tsHour = hourOf(sample.ts)
        // Count the sample only where nothing else counted it: before named
        // agents were counted by name, or a request no name was recorded for.
        // As at ingest, a likely fake goes to its own counts first, and then a
        // browser agent's request counts only as a page load.
        const countSample = (countingStart === null
          || tsHour < countingStart
          || unrecognizedAgentName({ method: 'GET', path: sample.pathNormalized, userAgent: sample.userAgent }) === null)
          && (verdict.kind === 'crawler'
            || verdict.fetch.trust === AgentTrustLevels.likely_fake
            || countsAsAiUserFetchHit(verdict.fetch, { method: null, path: sample.pathNormalized, queryString: null }))
        if (countSample) result.counted++
        if (ctx.dryRun) continue

        // Raw samples keep no address, so nothing here can verify an IP: the
        // added hit has no provenance sidecar and reads back as unattributed.
        tx.update(table).set({
          eventType: verdict.kind === 'user-fetch' ? RawEventSampleEventTypes.aiUserFetch : RawEventSampleEventTypes.crawler,
          classifierDetailsJson: {
            crawler: verdict.kind === 'crawler' ? { ...verdict.crawler, verificationManifest: null } : null,
            aiUserFetch: verdict.kind === 'user-fetch' ? sampledUserFetch(verdict.fetch, sample.pathNormalized) : null,
            aiReferral: null,
          },
        }).where(eq(table.id, sample.id)).run()
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
          now: ctx.now,
        })
      }
    })
  }
  return result
}

type CrawlerHour = typeof crawlerEventsHourly.$inferSelect

/** Where today's rules file a crawler hour or sample stored under a bot id with one user agent. */
type CrawlerRekey =
  /** Under the rule ingest picks today. */
  | { kind: 'keep' }
  /** Under an id this version defines no rule for: a newer release wrote it, so it stays. */
  | { kind: 'unknown-bot' }
  | { kind: 'self' }
  | { kind: 'crawler', to: ClassifiedCrawler }
  | { kind: 'user-fetch' }
  | { kind: 'unknown' }

/**
 * Where ingest files a crawler request today: Canonry's own tools are dropped,
 * then `classifyStored`'s order, except that a user agent naming a crawler rule
 * and a user fetch rule stays a crawler, as ingest counts it in both.
 */
function crawlerRekeyOf(botId: string, userAgent: string, verdicts: Map<string, Verdict>): CrawlerRekey {
  if (!RULE_IDS.has(botId)) return { kind: 'unknown-bot' }
  let verdict = verdicts.get(userAgent)
  if (!verdict) {
    // The kind reads only the user agent, never the path.
    verdict = classifyStored(userAgent, '/')
    if (verdict.kind === 'user-fetch') {
      const crawler = classifyCrawler(probeRequest(userAgent, '/'))
      if (crawler) verdict = { kind: 'crawler', crawler }
    }
    verdicts.set(userAgent, verdict)
  }
  switch (verdict.kind) {
    case 'self': return { kind: 'self' }
    case 'crawler': return verdict.crawler.botId === botId ? { kind: 'keep' } : { kind: 'crawler', to: verdict.crawler }
    case 'user-fetch': return { kind: 'user-fetch' }
    case 'unknown': return { kind: 'unknown' }
  }
}

type CrawlerMove = Exclude<CrawlerRekey, { kind: 'keep' | 'unknown-bot' }>

/**
 * Move one crawler hour to another crawler rule. Its verification and
 * provenance stay when both rules check the same published list; otherwise its
 * hits read claimed with no provenance, since stored traffic keeps no IP to check.
 */
function moveCrawlerHour(tx: Tx, row: CrawlerHour, to: ClassifiedCrawler, keepVerification: boolean): void {
  const table = crawlerEventsHourly
  const manifests = crawlerVerificationManifestsHourly
  tx.insert(table).values({
    ...row,
    botId: to.botId,
    operator: to.operator,
    verificationStatus: keepVerification ? row.verificationStatus : VerificationStatuses.claimed_unverified,
  }).onConflictDoUpdate({
    target: hourlyKeyColumns(table),
    set: { hits: sql`${table.hits} + ${row.hits}`, updatedAt: sql`max(${table.updatedAt}, excluded.updated_at)` },
  }).run()
  if (keepVerification) {
    for (const entry of tx.select().from(manifests).where(hourlyRow(manifests, row)).all()) {
      tx.insert(manifests).values({ ...entry, botId: to.botId }).onConflictDoUpdate({
        target: [...hourlyKeyColumns(manifests), manifests.manifestId],
        set: { hits: sql`${manifests.hits} + ${entry.hits}`, updatedAt: sql`max(${manifests.updatedAt}, excluded.updated_at)` },
      }).run()
    }
  }
  // The foreign key's cascade deletes the old row's provenance with it.
  tx.delete(table).where(hourlyRow(table, row)).run()
}

/** Re-key one crawler hour of a pair today's rules file elsewhere. */
function rekeyCrawlerHour(tx: Tx, key: HourlyKey, userAgent: string, rekey: CrawlerMove, ctx: PassContext, result: StoredTrafficReclassification['crawlers'], olderCounts: Map<string, string>): void {
  const table = crawlerEventsHourly
  // Re-read inside the transaction: ingest may have added hits, or replaced
  // the sampled user agent with today's, since.
  const row = tx.select().from(table).where(hourlyRow(table, key)).get()
  if (!row || row.sampledUserAgent !== userAgent) return
  let move: { kind: 'self' }
    | { kind: 'crawler', to: ClassifiedCrawler, keepVerification: boolean }
    | { kind: 'user-fetch', verdict: Extract<Verdict, { kind: 'user-fetch' }> }
    | { kind: 'unknown', agentName: string }
  switch (rekey.kind) {
    case 'self':
      move = rekey
      break
    case 'crawler':
      move = { kind: 'crawler', to: rekey.to, keepVerification: rulesShareVerificationList(row.botId, rekey.to.botId) }
      break
    case 'user-fetch': {
      // Each row is one page, so its own path feeds the trust check.
      const verdict = classifyStored(userAgent, row.pathNormalized)
      if (verdict.kind !== 'user-fetch') return
      move = { kind: 'user-fetch', verdict }
      break
    }
    case 'unknown': {
      // Ingest names no agent for a static file or a write: such an hour stays.
      const agentName = unrecognizedAgentName({ method: 'GET', path: row.pathNormalized, userAgent })
      if (agentName === null) return
      move = { kind: 'unknown', agentName }
      break
    }
  }
  if (isOrphan(ctx, row)) return
  const keepsVerification = move.kind === 'crawler' && move.keepVerification
  if (row.verificationStatus === VerificationStatuses.verified && !keepsVerification) {
    if (!ctx.allowVerificationLoss) {
      result.heldVerified++
      result.heldVerifiedHits += row.hits
      return
    }
    result.unverifiedHits += row.hits
  }
  const remove = () => tx.delete(table).where(hourlyRow(table, row)).run()
  switch (move.kind) {
    case 'self':
      result.removed++
      result.removedHits += row.hits
      if (!ctx.dryRun) remove()
      return
    case 'crawler':
      result.moved++
      result.movedHits += row.hits
      addTo(result.byBot, move.to.botId, row.hits)
      if (!ctx.dryRun) moveCrawlerHour(tx, row, move.to, move.keepVerification)
      return
    case 'user-fetch':
      result.toUserFetch++
      result.toUserFetchHits += row.hits
      addTo(result.byBot, move.verdict.fetch.botId, row.hits)
      if (ctx.dryRun) return
      addHourlyHits(tx, {
        projectId: row.projectId,
        sourceId: row.sourceId,
        tsHour: row.tsHour,
        verdict: move.verdict,
        pathNormalized: row.pathNormalized,
        status: row.status,
        hits: row.hits,
        sampledUserAgent: userAgent,
        now: ctx.now,
      })
      remove()
      // A crawler hour counted every request, not only page loads.
      if (move.verdict.fetch.browser) noteOlderCount(olderCounts, row.sourceId, row.tsHour)
      return
    case 'unknown':
      result.toUnrecognized++
      result.toUnrecognizedHits += row.hits
      if (ctx.dryRun) return
      writeUnrecognizedAgentBuckets(tx, {
        projectId: row.projectId,
        sourceId: row.sourceId,
        buckets: [{ tsHour: row.tsHour, agentName: move.agentName, hits: row.hits, sampledUserAgent: userAgent, sampledPath: row.pathNormalized }],
        now: ctx.now,
      })
      remove()
      return
  }
}

/**
 * Crawler hours whose sampled user agent today's rules file elsewhere, decided
 * as ingest decides a request (`crawlerRekeyOf`). Hours of Canonry's own tools
 * are deleted. A crawler rule takes its hours, as migration v221 moved
 * Claude-SearchBot off ClaudeBot. An agent only an AI user fetch rule names
 * moves to those counts, likely fakes to theirs. An agent no rule names goes
 * back to the unrecognized agents under the name ingest gives it, or stays
 * where it is when ingest names nothing (a static file). A row moves whole, by
 * its one sampled user agent, and stays verified only on a move between two
 * rules that check the same published list. Crawler samples are relabeled the
 * same way.
 *
 * Hours stay as they are when they keep no sampled user agent, or sit under a
 * bot id this version defines no rule for: a newer release wrote them, and
 * moving them would undo what it knew. A change that would leave verified hits
 * claimed is made only when the caller allows it (`allowVerificationLoss`, as
 * `canonry backfill traffic-classification` does); the automatic pass after
 * startup counts and logs it instead, so a rule that is later reverted cannot
 * downgrade stored history on its own.
 *
 * A migration runs once, so this is how hours an older version files after a
 * rollback are re-split, and it runs only when the pass does: when the stored
 * fingerprint differs from today's. That leaves two gaps. An older version
 * that stopped before its own pass completed (the pass starts 30 s after
 * startup) left the newer fingerprint in place, so the newer version does not
 * run the pass again: the hours the older one misfiled stay until the next
 * rules change, or until `canonry backfill traffic-classification` moves them.
 * And ingest during the newer version's 30 s start delay can replace an hour's
 * sampled user agent with today's, which hides the older hits in that hour
 * from every pass; only a traffic backfill that rewrites the hour from the
 * source's logs (`canonry traffic backfill`, where the source supports one)
 * recounts them.
 *
 * Crawler hours and samples are first counted by bot and user agent, a span of
 * rowids at a time, and only the rows of a pair filed elsewhere are read.
 */
async function rekeyCrawlerHours(db: DatabaseClient, ctx: PassContext): Promise<StoredTrafficReclassification['crawlers']> {
  const result: StoredTrafficReclassification['crawlers'] = {
    examined: 0,
    moved: 0,
    movedHits: 0,
    toUserFetch: 0,
    toUserFetchHits: 0,
    toUnrecognized: 0,
    toUnrecognizedHits: 0,
    removed: 0,
    removedHits: 0,
    unverifiedHits: 0,
    heldVerified: 0,
    heldVerifiedHits: 0,
    unknownBot: 0,
    samplesRelabeled: 0,
    samplesNowUnknown: 0,
    samplesRemoved: 0,
    byBot: {},
  }
  const table = crawlerEventsHourly
  const verdicts = new Map<string, Verdict>()
  for (let from = 0; from < ctx.bounds.crawlers; from += SCAN_SPAN) {
    if (ctx.shouldStop()) return result
    const to = Math.min(from + SCAN_SPAN, ctx.bounds.crawlers)
    const pairs = db.select({ botId: table.botId, userAgent: table.sampledUserAgent, rows: sql<number>`count(*)` })
      .from(table)
      .where(and(rowidRange(from, to), isNotNull(table.sampledUserAgent), projectScope(table.projectId, ctx.projectIds)))
      .groupBy(table.botId, table.sampledUserAgent)
      .all()
    for (const pair of pairs) {
      const userAgent = pair.userAgent!
      result.examined += pair.rows
      const rekey = crawlerRekeyOf(pair.botId, userAgent, verdicts)
      if (rekey.kind === 'keep') continue
      if (rekey.kind === 'unknown-bot') {
        result.unknownBot += pair.rows
        continue
      }
      const pages = rowidPages(ctx, { after: from, bound: to }, range => db
        .select({
          rowid: sql<number>`rowid`,
          projectId: table.projectId,
          sourceId: table.sourceId,
          tsHour: table.tsHour,
          botId: table.botId,
          verificationStatus: table.verificationStatus,
          pathNormalized: table.pathNormalized,
          status: table.status,
        })
        .from(table)
        .where(and(range, eq(table.botId, pair.botId), eq(table.sampledUserAgent, userAgent), projectScope(table.projectId, ctx.projectIds)))
        .orderBy(sql`rowid`)
        .limit(BATCH_SIZE)
        .all())
      for await (const keys of pages) {
        inBatch(db, ctx, (tx) => {
          const olderCounts = new Map<string, string>()
          for (const key of keys) rekeyCrawlerHour(tx, key, userAgent, rekey, ctx, result, olderCounts)
          if (!ctx.dryRun) markUserFetchOlderCounts(tx, olderCounts, ctx.now)
        })
      }
    }
    await yieldToEventLoop()
  }
  await relabelCrawlerSamples(db, ctx, verdicts, result)
  return result
}

type SampleRelabel =
  | { kind: 'remove' }
  | { kind: 'relabel', eventType: RawEventSampleEventType, details: Record<string, unknown> }

/**
 * A crawler sample's new label, or null when it stays. Only the classifier
 * fields change, on the stored object, so fields this version does not read
 * survive the edit.
 */
function crawlerSampleRelabel(details: Record<string, unknown>, sample: { userAgent: string, pathNormalized: string }, rekey: CrawlerMove, ctx: PassContext): SampleRelabel | null {
  const label = asRecord(details.crawler)
  if (!label) return null
  const keepsVerification = rekey.kind === 'crawler' && rulesShareVerificationList(String(label.botId), rekey.to.botId)
  if (label.verificationStatus === VerificationStatuses.verified && !keepsVerification && !ctx.allowVerificationLoss) return null
  switch (rekey.kind) {
    case 'self':
      return { kind: 'remove' }
    case 'crawler':
      return {
        kind: 'relabel',
        eventType: RawEventSampleEventTypes.crawler,
        details: {
          ...details,
          crawler: {
            ...label,
            botId: rekey.to.botId,
            operator: rekey.to.operator,
            product: rekey.to.product,
            purpose: rekey.to.purpose,
            ...(keepsVerification ? {} : { verificationStatus: VerificationStatuses.claimed_unverified, verificationManifest: null }),
          },
        },
      }
    case 'user-fetch': {
      const verdict = classifyStored(sample.userAgent, sample.pathNormalized)
      if (verdict.kind !== 'user-fetch') return null
      return {
        kind: 'relabel',
        eventType: RawEventSampleEventTypes.aiUserFetch,
        details: { ...details, crawler: null, aiUserFetch: sampledUserFetch(verdict.fetch, sample.pathNormalized) },
      }
    }
    case 'unknown':
      // As at ingest, the first kind a request still has names its sample.
      return {
        kind: 'relabel',
        eventType: details.aiReferral ? RawEventSampleEventTypes.aiReferral : RawEventSampleEventTypes.unknown,
        details: { ...details, crawler: null, aiUserFetch: null },
      }
  }
}

/**
 * A replayed sample's AI user fetch label, as ingest stores it: a browser
 * agent's carries its request kind. Samples keep no method or query, so the
 * kind is read from the path alone (a stored `?_rsc=` prefetch reads as a page).
 */
function sampledUserFetch(fetch: ClassifiedAiUserFetch, pathNormalized: string): SampledAiUserFetch {
  const label = { ...fetch, verificationManifest: null }
  return fetch.browser
    ? { ...label, requestKind: browserAgentRequestKind({ method: null, path: pathNormalized, queryString: null }) }
    : label
}

/** Relabel crawler samples whose user agent today's rules file elsewhere, as `rekeyCrawlerHours` moves their hours. */
async function relabelCrawlerSamples(db: DatabaseClient, ctx: PassContext, verdicts: Map<string, Verdict>, result: StoredTrafficReclassification['crawlers']): Promise<void> {
  const table = rawEventSamples
  // The stored label's bot, read without parsing the rest of the label.
  const labelBotId = sql<unknown>`CASE WHEN json_valid(${table.classifierDetailsJson}) THEN json_extract(${table.classifierDetailsJson}, '$.crawler.botId') END`
  const crawlerSamples = eq(table.eventType, RawEventSampleEventTypes.crawler)
  for (let from = 0; from < ctx.bounds.samples; from += SCAN_SPAN) {
    if (ctx.shouldStop()) return
    const to = Math.min(from + SCAN_SPAN, ctx.bounds.samples)
    const pairs = db.select({ userAgent: table.userAgent, botId: labelBotId })
      .from(table)
      .where(and(crawlerSamples, rowidRange(from, to), isNotNull(table.userAgent), projectScope(table.projectId, ctx.projectIds)))
      .groupBy(table.userAgent, labelBotId)
      .all()
    for (const pair of pairs) {
      const userAgent = pair.userAgent!
      if (typeof pair.botId !== 'string') continue
      const rekey = crawlerRekeyOf(pair.botId, userAgent, verdicts)
      if (rekey.kind === 'keep' || rekey.kind === 'unknown-bot') continue
      const pages = rowidPages(ctx, { after: from, bound: to }, range => db
        .select({ rowid: sql<number>`rowid`, id: table.id, pathNormalized: table.pathNormalized, details: table.classifierDetailsJson })
        .from(table)
        .where(and(crawlerSamples, range, eq(table.userAgent, userAgent), sql`${labelBotId} = ${pair.botId}`, projectScope(table.projectId, ctx.projectIds)))
        .orderBy(sql`rowid`)
        .limit(BATCH_SIZE)
        .all())
      for await (const samples of pages) {
        const changes = samples.flatMap((sample) => {
          const change = crawlerSampleRelabel(sample.details, { userAgent, pathNormalized: sample.pathNormalized }, rekey, ctx)
          return change ? [{ id: sample.id, change }] : []
        })
        for (const { change } of changes) {
          if (change.kind === 'remove') {
            result.samplesRemoved++
            continue
          }
          result.samplesRelabeled++
          if (change.eventType === RawEventSampleEventTypes.unknown) result.samplesNowUnknown++
        }
        if (changes.length === 0 || ctx.dryRun) continue
        inBatch(db, ctx, (tx) => {
          for (const { id, change } of changes) {
            if (change.kind === 'remove') tx.delete(table).where(eq(table.id, id)).run()
            else tx.update(table).set({ eventType: change.eventType, classifierDetailsJson: change.details }).where(eq(table.id, id)).run()
          }
        })
      }
    }
    await yieldToEventLoop()
  }
}

/**
 * Move unverified AI agent hourly rows for a page scanners ask for into the
 * likely fake counts, as ingest does today. Each row is one page, so the
 * check is exact. Hourly rows keep no client, so the burst rule cannot apply.
 */
async function reassessAgentHits(db: DatabaseClient, ctx: PassContext): Promise<StoredTrafficReclassification['agentHits']> {
  const result: StoredTrafficReclassification['agentHits'] = { examined: 0, moved: 0, movedHits: 0 }
  const table = aiUserFetchEventsHourly
  const pages = rowidPages(ctx, { bound: ctx.bounds.userFetch }, range => db
    .select({
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
    .where(and(range, ne(table.verificationStatus, VerificationStatuses.verified), projectScope(table.projectId, ctx.projectIds)))
    .orderBy(sql`rowid`)
    .limit(BATCH_SIZE)
    .all())
  for await (const rows of pages) {
    result.examined += rows.length
    const probes = rows.filter(row => isScannerPath(row.pathNormalized, { browser: isBrowserAgentId(row.botId) }))
    if (probes.length === 0) continue
    inBatch(db, ctx, (tx) => {
      for (const row of probes) {
        // Re-read inside the transaction: ingest may have added hits since.
        const current = tx.select({ hits: table.hits }).from(table).where(hourlyRow(table, row)).get()
        if (!current || isOrphan(ctx, row)) continue
        result.moved++
        result.movedHits += current.hits
        if (ctx.dryRun) continue
        addLikelyFakeAgentHits(tx, {
          projectId: row.projectId,
          sourceId: row.sourceId,
          buckets: [{ tsHour: row.tsHour, botId: row.botId, operator: row.operator, reason: AgentTrustReasons['scanner-path'], hits: current.hits }],
          now: ctx.now,
        })
        // Its verification provenance rows go with it.
        tx.delete(table).where(hourlyRow(table, row)).run()
      }
    })
  }
  return result
}

type StoredAgentRequest = typeof agentJourneyEvents.$inferSelect

/** Delete a stored agent request and free its place under its day's capture limit. False when it was already gone. */
function removeStoredAgentRequest(tx: Tx, row: Pick<StoredAgentRequest, 'id' | 'projectId' | 'sourceId' | 'ts'>): boolean {
  if (tx.delete(agentJourneyEvents).where(eq(agentJourneyEvents.id, row.id)).run().changes === 0) return false
  tx.update(agentJourneyCaptureDays)
    .set({ storedEvents: sql`max(${agentJourneyCaptureDays.storedEvents} - 1, 0)` })
    .where(and(
      eq(agentJourneyCaptureDays.projectId, row.projectId),
      eq(agentJourneyCaptureDays.sourceId, row.sourceId),
      eq(agentJourneyCaptureDays.day, row.ts.slice(0, 10)),
    ))
    .run()
  return true
}

/**
 * Whether a stored agent request was counted as an AI user fetch hit: every
 * request of a link fetcher, and a browser agent's page loads, or any request
 * of one stored before its source's older count ended, when every request counted.
 */
function wasCountedAsHit(row: StoredAgentRequest, olderCountUntil: string | null): boolean {
  if (!isBrowserAgentId(row.agentId)) return true
  if (olderCountUntil !== null && Date.parse(row.ts) < Date.parse(olderCountUntil)) return true
  return countsAsAiUserFetchHit({ browser: true }, { method: row.method, path: row.path, queryString: null })
}

/** Move one AI agent hit of a stored request into the burst's likely fake count. */
function moveAgentHitToBurst(tx: Tx, row: StoredAgentRequest, now: string): void {
  const key: HourlyKey = {
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
    .where(and(hourlyRow(table, key), sql`${table.hits} > 0`))
    .run()
  if (taken.changes === 0) return
  const manifests = aiUserFetchVerificationManifestsHourly
  if (row.verificationManifest) {
    const manifestRow = and(hourlyRow(manifests, key), eq(manifests.manifestId, row.verificationManifest.id))
    tx.update(manifests).set({ hits: sql`${manifests.hits} - 1`, updatedAt: now }).where(and(manifestRow, sql`${manifests.hits} > 0`)).run()
    tx.delete(manifests).where(and(manifestRow, sql`${manifests.hits} <= 0`)).run()
  }
  tx.delete(table).where(and(hourlyRow(table, key), sql`${table.hits} <= 0`)).run()
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
 * hourly row moves in `reassessAgentHits`; each other request that was
 * counted moves one hit. Also returns, in a dry run, the requests it would
 * remove, so the page-resource step does not count them again.
 */
async function reassessAgentRequests(db: DatabaseClient, ctx: PassContext): Promise<{
  result: Omit<StoredTrafficReclassification['agentRequests'], 'pageResources'>
  previewed: ReadonlySet<string>
}> {
  const result: Omit<StoredTrafficReclassification['agentRequests'], 'pageResources'> = { examined: 0, probes: 0, removed: 0 }
  const previewed = new Set<string>()
  const table = agentJourneyEvents
  const clients = new Map<string, { projectId: string, sourceId: string, correlationKey: string, probes: number[] }>()
  const pages = rowidPages(ctx, { bound: ctx.bounds.agentRequests }, range => db
    .select({ rowid: sql<number>`rowid`, projectId: table.projectId, sourceId: table.sourceId, correlationKey: table.correlationKey, agentId: table.agentId, ts: table.ts, path: table.path })
    .from(table)
    .where(and(range, ne(table.trust, AgentTrustLevels.verified), projectScope(table.projectId, ctx.projectIds)))
    .orderBy(sql`rowid`)
    .limit(BATCH_SIZE)
    .all())
  for await (const rows of pages) {
    result.examined += rows.length
    for (const row of rows) {
      if (!isScannerPath(row.path, { browser: isBrowserAgentId(row.agentId) })) continue
      result.probes++
      const id = JSON.stringify([row.projectId, row.sourceId, row.correlationKey])
      const client = clients.get(id) ?? { projectId: row.projectId, sourceId: row.sourceId, correlationKey: row.correlationKey, probes: [] }
      client.probes.push(Date.parse(row.ts))
      clients.set(id, client)
    }
  }

  for (const client of clients.values()) {
    if (ctx.shouldStop()) break
    if (isOrphan(ctx, client, client.probes.length)) continue
    const probes = client.probes.sort((a, b) => a - b)
    const from = new Date(probes[0]! - SCANNER_BURST_WINDOW_MS).toISOString()
    const to = new Date(probes.at(-1)! + SCANNER_BURST_WINDOW_MS).toISOString()
    inBatch(db, ctx, (tx) => {
      const olderCountUntil = tx.select({ until: trafficSources.aiUserFetchOlderCountUntil })
        .from(trafficSources).where(eq(trafficSources.id, client.sourceId)).get()?.until ?? null
      const rows = tx.select().from(table).where(and(
        eq(table.projectId, client.projectId),
        eq(table.sourceId, client.sourceId),
        eq(table.correlationKey, client.correlationKey),
        gte(table.ts, from),
        lte(table.ts, to),
        ne(table.trust, AgentTrustLevels.verified),
      )).all()
      for (const row of rows) {
        const probe = isScannerPath(row.path, { browser: isBrowserAgentId(row.agentId) })
        const at = Date.parse(row.ts)
        if (!probe && !probes.some(t => Math.abs(at - t) <= SCANNER_BURST_WINDOW_MS)) continue
        if (ctx.dryRun) {
          result.removed++
          previewed.add(row.id)
          continue
        }
        if (!removeStoredAgentRequest(tx, row)) continue
        result.removed++
        // A browser agent's resources and actions were not counted, so they
        // have no hit to move.
        if (!probe && wasCountedAsHit(row, olderCountUntil)) moveAgentHitToBurst(tx, row, ctx.now)
      }
    })
    await yieldToEventLoop()
  }
  return { result, previewed }
}

/**
 * Stored browser-agent requests (Journeys > Agents) that capture leaves out
 * today (`keepsBrowserAgentJourneyRequest`): what its pages fetched by
 * themselves, such as files, data and API calls, framework paths, HEAD and
 * OPTIONS, unless the request failed. Stored rows keep no query string, so a
 * prefetch caught only by its query (`?_rsc=`) stays. `previewed` holds the
 * requests a dry run of the burst step already counted. Returns how many were
 * removed, or would be.
 */
async function removeBrowserAgentPageResources(db: DatabaseClient, ctx: PassContext, previewed: ReadonlySet<string>): Promise<number> {
  if (BROWSER_AGENT_BOT_IDS.length === 0) return 0
  const table = agentJourneyEvents
  let removed = 0
  const pages = rowidPages(ctx, { bound: ctx.bounds.agentRequests }, range => db
    .select({ rowid: sql<number>`rowid`, id: table.id, projectId: table.projectId, sourceId: table.sourceId, ts: table.ts, method: table.method, path: table.path, status: table.status })
    .from(table)
    .where(and(range, inArray(table.agentId, [...BROWSER_AGENT_BOT_IDS]), projectScope(table.projectId, ctx.projectIds)))
    .orderBy(sql`rowid`)
    .limit(BATCH_SIZE)
    .all())
  for await (const rows of pages) {
    const leftOut = rows.filter(row => !previewed.has(row.id)
      && !keepsBrowserAgentJourneyRequest({ method: row.method, path: row.path, queryString: null, status: row.status }))
    if (ctx.dryRun) {
      removed += leftOut.length
      continue
    }
    if (leftOut.length === 0) continue
    inBatch(db, ctx, (tx) => {
      for (const row of leftOut) {
        if (removeStoredAgentRequest(tx, row)) removed++
      }
    })
  }
  return removed
}

/**
 * Reclassify stored traffic under today's rules. Unknown raw samples and the
 * hourly rows of unrecognized agents: a row a rule now recognizes moves into
 * that bot's hourly counts (claimed, since stored traffic keeps no IP; the
 * page is unrecorded), rows of Canonry's own tools are deleted, and the rest
 * are renamed or dropped to match today's naming. Crawler hours and samples
 * whose sampled user agent today's rules file elsewhere move there
 * (`rekeyCrawlerHours`). AI agent traffic: hourly rows and stored requests
 * that today's trust rules call likely fake move to the likely fake counts,
 * and stored requests capture leaves out of a browser agent's journey are
 * removed. A browser agent's hours moved into the AI user fetch counts mark
 * their source's older count. Journeys: background calls stop opening visits
 * or counting as AI arrivals (`correctBackgroundCallJourneys`), and a visitor
 * seen from a second IP joins its first one (`mergeSplitJourneyVisitors`).
 * Rows whose project or source no longer exists are skipped and counted. A dry
 * run takes no write lock and reports what a write run would do. Safe to run
 * any number of times.
 */
export async function reclassifyStoredTraffic(db: DatabaseClient, opts: {
  projectIds?: readonly string[]
  dryRun?: boolean
  now?: string
  shouldStop?: () => boolean
  /**
   * Also make the crawler re-key's changes that leave verified hits claimed
   * (`crawlers.heldVerified` counts them otherwise).
   */
  allowVerificationLoss?: boolean
} = {}): Promise<StoredTrafficReclassification> {
  const ctx: PassContext = {
    projectIds: opts.projectIds,
    dryRun: opts.dryRun === true,
    now: opts.now ?? new Date().toISOString(),
    shouldStop: opts.shouldStop ?? (() => false),
    allowVerificationLoss: opts.allowVerificationLoss === true,
    bounds: {
      samples: lastRowid(db, rawEventSamples),
      unrecognized: lastRowid(db, unrecognizedAgentEventsHourly),
      crawlers: lastRowid(db, crawlerEventsHourly),
      userFetch: lastRowid(db, aiUserFetchEventsHourly),
      agentRequests: lastRowid(db, agentJourneyEvents),
    },
    liveProjectIds: new Set(db.select({ id: projects.id }).from(projects).all().map(row => row.id)),
    liveSourceIds: new Set(db.select({ id: trafficSources.id }).from(trafficSources).all().map(row => row.id)),
    orphans: 0,
  }
  const samples = await reclassifyUnknownSamples(db, ctx)
  const unrecognized = await reclassifyUnrecognizedRows(db, ctx)
  const crawlers = await rekeyCrawlerHours(db, ctx)
  // Hourly rows first: a probe's own row moves there, its client's other requests here.
  const agentHits = await reassessAgentHits(db, ctx)
  const assessed = await reassessAgentRequests(db, ctx)
  const pageResources = await removeBrowserAgentPageResources(db, ctx, assessed.previewed)
  const agentRequests = { ...assessed.result, pageResources }
  const journeys = ctx.shouldStop()
    ? { visitors: 0, visitorsRemoved: 0, visitsRemoved: 0, visitsRelanded: 0 }
    // Its batches open write transactions; inside a deferred one they are
    // savepoints, so a dry run takes no write lock.
    : ctx.dryRun ? db.transaction(() => correctBackgroundCallJourneys(db, ctx), { behavior: 'deferred' }) : correctBackgroundCallJourneys(db, ctx)
  const journeyMerges = ctx.shouldStop() ? { visitorsMerged: 0, visitsJoined: 0 } : mergeSplitJourneyVisitors(db, ctx)
  return { dryRun: ctx.dryRun, samples, unrecognized, crawlers, agentHits, agentRequests, journeys, journeyMerges, orphans: ctx.orphans }
}

/**
 * Reclassify stored traffic once per change of the classification rules. The
 * fingerprint is recorded only after a full pass, so a pass cut short by
 * shutdown runs again on the next start. The pass leaves crawler changes that
 * would make verified hits claimed (`crawlers.heldVerified`) to an explicit
 * backfill. When the browser-agent request rules a pass recorded differ from
 * this version's, or none were recorded (an older version ran the last pass,
 * as after a rollback, or none ran since migration v222), every source holding
 * browser-agent hours is marked as holding the older count up to its latest
 * such hour, or the pass's start when that hour had not ended.
 */
export async function reclassifyStoredTrafficIfRulesChanged(db: DatabaseClient, opts: {
  now?: () => string
  shouldStop?: () => boolean
} = {}): Promise<{ ran: boolean, result?: StoredTrafficReclassification, olderCountsMarked?: number }> {
  const fingerprint = trafficClassificationFingerprint()
  const state = db.select().from(trafficReclassificationState).where(eq(trafficReclassificationState.id, STATE_ID)).get()
  if (state?.fingerprint === fingerprint) return { ran: false }
  const now = opts.now ?? (() => new Date().toISOString())
  const shouldStop = opts.shouldStop ?? (() => false)
  const startedAt = now()
  const result = await reclassifyStoredTraffic(db, { now: startedAt, shouldStop })
  if (shouldStop()) return { ran: false }
  const olderCountEnds = countsBrowserAgentsAsRecorded(state?.resultJson) ? new Map<string, string>() : lastBrowserAgentHourEnds(db)
  const completedAt = now()
  const resultJson = { ...result, [BROWSER_AGENT_REQUEST_RULES_KEY]: BROWSER_AGENT_REQUEST_RULES }
  const olderCountsMarked = db.transaction((tx) => {
    const marked = markUserFetchOlderCounts(tx, olderCountEnds, startedAt)
    tx.insert(trafficReclassificationState)
      .values({ id: STATE_ID, fingerprint, completedAt, resultJson })
      .onConflictDoUpdate({
        target: trafficReclassificationState.id,
        set: { fingerprint, completedAt, resultJson },
      })
      .run()
    return marked
  }, { behavior: 'immediate' })
  return { ran: true, result, olderCountsMarked }
}

/** Check the rules shortly after startup, off the boot path. Returns a stop. */
export function startTrafficReclassification(opts: { db: DatabaseClient, delayMs?: number }): () => void {
  let stopped = false
  const timer = setTimeout(() => {
    reclassifyStoredTrafficIfRulesChanged(opts.db, { shouldStop: () => stopped })
      .then((outcome) => {
        if (!outcome.ran || !outcome.result) return
        logReclassification(outcome.result, outcome.olderCountsMarked ?? 0)
      })
      .then(() => {
        if (stopped) return
        // Journeys are corrected by now, so the older AI-referral hours they
        // cover can be counted again. Once per install; a failure retries next start.
        try {
          for (const recount of repairAiReferralArrivalsOnStartup(opts.db) ?? []) {
            log.info('traffic-reclassify.ai-referral-recount', { ...recount })
          }
        } catch (err) {
          log.error('traffic-reclassify.ai-referral-recount-failed', { error: describeError(err) })
        }
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

function logReclassification(result: StoredTrafficReclassification, olderCountsMarked: number): void {
  const { samples, unrecognized, crawlers, agentHits, agentRequests, journeys, journeyMerges } = result
  log.info('traffic-reclassify.completed', {
    samplesReclassified: samples.reclassified,
    samplesCounted: samples.counted,
    samplesRemoved: samples.removed,
    unrecognizedMoved: unrecognized.moved,
    unrecognizedMovedHits: unrecognized.movedHits,
    unrecognizedRenamed: unrecognized.renamed,
    unrecognizedRemoved: unrecognized.removed,
    crawlerRowsMoved: crawlers.moved,
    crawlerHitsMoved: crawlers.movedHits,
    crawlerRowsToUserFetch: crawlers.toUserFetch,
    crawlerRowsToUnrecognized: crawlers.toUnrecognized,
    crawlerRowsRemoved: crawlers.removed,
    crawlerHitsUnverified: crawlers.unverifiedHits,
    crawlerRowsUnknownBot: crawlers.unknownBot,
    crawlerSamplesRelabeled: crawlers.samplesRelabeled,
    agentHitsMoved: agentHits.movedHits,
    agentRequestsRemoved: agentRequests.removed,
    agentPageResourcesRemoved: agentRequests.pageResources,
    journeyVisitorsRemoved: journeys.visitorsRemoved,
    journeyVisitsRemoved: journeys.visitsRemoved,
    journeyVisitsRelanded: journeys.visitsRelanded,
    journeyVisitorsMerged: journeyMerges.visitorsMerged,
    journeyVisitsJoined: journeyMerges.visitsJoined,
    olderCountsMarked,
    orphans: result.orphans,
  })
  if (crawlers.heldVerified > 0) {
    // Left for an explicit run: the pass never downgrades verified history on its own.
    log.warn('traffic-reclassify.verified-moves-held', {
      rows: crawlers.heldVerified,
      hits: crawlers.heldVerifiedHits,
      preview: 'canonry backfill traffic-classification --dry-run',
    })
  }
}
