import crypto from 'node:crypto'
import { and, asc, count, desc, eq, gt, gte, inArray, lt, lte, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { DatabaseClient } from '@canonry/canonry-db'
import { journeyEvents, journeyVisitors, journeyVisits, projects, trafficSources } from '@canonry/canonry-db'
import {
  formatValidationIssues,
  JOURNEY_LIST_VISITS_PER_VISITOR,
  JOURNEY_LOOKBACK_DAYS,
  JOURNEY_MAX_REQUESTS_PER_VISITOR_DAY,
  JOURNEY_PAGE_VIEWS_PENDING_REASON,
  JOURNEY_PARTIAL_SOURCE_TYPES,
  TrafficSourceStatuses,
  TrafficSourceTypes,
  cloudflareTrafficSourceConfigSchema,
  type JourneyPartialSources,
  journeyDetailQuerySchema,
  JOURNEY_RETENTION_DAYS,
  JOURNEY_VISIT_IDLE_MINUTES,
  journeyDeviceLabel,
  journeyEntryClassSchema,
  JourneyKeyBases,
  journeySummaryQuerySchema,
  journeysQuerySchema,
  notFound,
  RatioUnits,
  roundRatio,
  validationError,
  type JourneyDetailResponse,
  type JourneyEntryClass,
  type JourneyKeyBasis,
  type JourneySummaryResponse,
  type JourneysResponse,
  type JourneyVisitDto,
  type JourneyVisitorDto,
  type NormalizedTrafficRequest,
} from '@canonry/canonry-contracts'
import {
  extractJourneyRequests,
  sessionizeJourneyRequests,
  type JourneyVisitorState,
  type KeyedJourneyRequest,
  type StoredJourneyVisit,
} from '@canonry/canonry-integration-traffic'
import { requireAdminSession } from './auth.js'
import { cloudflareWorkerVersionFor } from './cloudflare-worker-version.js'
import { resolveProject } from './helpers.js'

const DAY_MS = 24 * 60 * 60_000
const IDLE_MS = JOURNEY_VISIT_IDLE_MINUTES * 60_000
const LOOKBACK_MS = JOURNEY_LOOKBACK_DAYS * DAY_MS
export const JOURNEY_RETENTION_MS = JOURNEY_RETENTION_DAYS * DAY_MS
// SQLite caps bound parameters per statement; IN lists are chunked below this.
const IN_CHUNK = 400

type JourneyDb = Pick<DatabaseClient, 'select' | 'insert' | 'update' | 'delete'>

/**
 * A visitor key: HMAC-SHA256 under the install's journey secret over the
 * project, the key basis and what the provider reported. Keys differ per
 * project, so one person is never linked across clients, and the input cannot
 * be recovered without the secret, which lives in the config file, apart from
 * the database.
 */
export function journeyVisitorKey(
  secret: string,
  projectId: string,
  remoteIp: string | null,
  userAgent: string,
): { visitorKey: string; keyBasis: JourneyKeyBasis } {
  const keyBasis = remoteIp ? JourneyKeyBases['ip-ua'] : JourneyKeyBases.ua
  const visitorKey = crypto
    .createHmac('sha256', secret)
    .update([projectId, keyBasis, remoteIp ?? '', userAgent].join('\n'))
    .digest('hex')
    .slice(0, 32)
  return { visitorKey, keyBasis }
}

function chunks<T>(items: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export interface PersistJourneyBatchResult {
  visitsWritten: number
  eventsStored: number
}

/**
 * Write one batch's AI journey requests in the caller's transaction. Runs
 * beside the hourly rollup for every pull, backfill and push, so every traffic
 * provider feeds journeys the same way. Idempotent: an event already stored
 * for this source (overlapping pulls, re-run backfills) is skipped before it
 * can count twice. Without a secret nothing is written.
 */
export function persistJourneyBatch(
  tx: JourneyDb,
  input: {
    projectId: string
    sourceId: string
    events: readonly NormalizedTrafficRequest[]
    secret: string | undefined
    now: string
  },
): PersistJourneyBatchResult {
  if (!input.secret || input.events.length === 0) return { visitsWritten: 0, eventsStored: 0 }
  const retentionCutoff = Date.parse(input.now) - JOURNEY_RETENTION_MS
  // The project's own domains: referers on them are steps, not arrivals, even
  // when the provider reports no host or another subdomain.
  const project = tx.select({ canonicalDomain: projects.canonicalDomain, ownedDomains: projects.ownedDomains }).from(projects)
    .where(eq(projects.id, input.projectId)).get()
  const siteDomains = project ? [project.canonicalDomain, ...project.ownedDomains] : []
  const extracted = extractJourneyRequests(input.events, { siteDomains }).filter(r => Date.parse(r.observedAt) >= retentionCutoff)
  if (extracted.length === 0) return { visitsWritten: 0, eventsStored: 0 }

  const stored = new Set<string>()
  for (const ids of chunks([...new Set(extracted.map(r => r.eventId))])) {
    const rows = tx.select({ id: journeyEvents.sourceEventId }).from(journeyEvents)
      .where(and(eq(journeyEvents.projectId, input.projectId), eq(journeyEvents.sourceId, input.sourceId), inArray(journeyEvents.sourceEventId, ids)))
      .all()
    for (const row of rows) stored.add(row.id)
  }
  const basisByKey = new Map<string, JourneyKeyBasis>()
  const keyed: KeyedJourneyRequest[] = []
  const seenInBatch = new Set<string>()
  for (const request of extracted) {
    if (stored.has(request.eventId) || seenInBatch.has(request.eventId)) continue
    seenInBatch.add(request.eventId)
    const { visitorKey, keyBasis } = journeyVisitorKey(input.secret, input.projectId, request.remoteIp, request.userAgent)
    basisByKey.set(visitorKey, keyBasis)
    keyed.push({ ...request, visitorKey })
  }
  if (keyed.length === 0) return { visitsWritten: 0, eventsStored: 0 }

  // State for the visitors in this batch: their journey bounds and the stored
  // visits a request could continue.
  // A loop, not Math.min(...): a backfill batch can exceed the argument limit.
  let earliest = Infinity
  let latest = -Infinity
  for (const request of keyed) {
    const t = Date.parse(request.observedAt)
    if (t < earliest) earliest = t
    if (t > latest) latest = t
  }
  const windowStart = new Date(earliest - IDLE_MS).toISOString()
  const windowEnd = new Date(latest + IDLE_MS).toISOString()
  const lookbackStart = new Date(earliest - LOOKBACK_MS).toISOString()
  const latestIso = new Date(latest).toISOString()
  const firstDay = new Date(earliest).toISOString().slice(0, 10)
  const dayAfterLast = new Date(Date.parse(`${new Date(latest).toISOString().slice(0, 10)}T00:00:00.000Z`) + DAY_MS).toISOString()
  const state = new Map<string, JourneyVisitorState & { aiTimes: string[]; requestsByDay: Record<string, number> }>()
  const stateFor = (visitorKey: string) => {
    let visitor = state.get(visitorKey)
    if (!visitor) {
      visitor = { firstAiAt: null, firstAiEngine: null, lastAiAt: null, aiTimes: [], visits: [], requestsByDay: {} }
      state.set(visitorKey, visitor)
    }
    return visitor
  }
  const storedCappedDays = new Map<string, string[]>()
  for (const keys of chunks([...basisByKey.keys()])) {
    for (const row of tx.select().from(journeyVisitors)
      .where(and(eq(journeyVisitors.projectId, input.projectId), inArray(journeyVisitors.visitorKey, keys))).all()) {
      Object.assign(stateFor(row.visitorKey), { firstAiAt: row.firstAiAt, firstAiEngine: row.firstAiEngine, lastAiAt: row.lastAiAt })
      storedCappedDays.set(row.visitorKey, row.cappedDays)
    }
    // Every stored AI touch that can cover a batch request, including touches
    // inside a visit, so the lookback is measured from the touch before each
    // request whatever order the requests arrive in.
    for (const row of tx.select({ visitorKey: journeyVisits.visitorKey, ts: journeyEvents.ts }).from(journeyEvents)
      .innerJoin(journeyVisits, eq(journeyVisits.id, journeyEvents.visitId))
      .where(and(
        eq(journeyVisits.projectId, input.projectId),
        inArray(journeyVisits.visitorKey, keys),
        eq(journeyEvents.aiTouch, true),
        gte(journeyEvents.ts, lookbackStart),
        lte(journeyEvents.ts, latestIso),
      )).all()) {
      stateFor(row.visitorKey).aiTimes.push(row.ts)
    }
    // Requests already stored per visitor and UTC day, for the daily cap.
    const day = sql<string>`substr(${journeyEvents.ts}, 1, 10)`
    for (const row of tx.select({ visitorKey: journeyVisits.visitorKey, day, total: count() }).from(journeyEvents)
      .innerJoin(journeyVisits, eq(journeyVisits.id, journeyEvents.visitId))
      .where(and(
        eq(journeyVisits.projectId, input.projectId),
        inArray(journeyVisits.visitorKey, keys),
        gte(journeyEvents.ts, `${firstDay}T00:00:00.000Z`),
        lt(journeyEvents.ts, dayAfterLast),
      ))
      .groupBy(journeyVisits.visitorKey, day).all()) {
      stateFor(row.visitorKey).requestsByDay[row.day] = row.total
    }
    for (const row of tx.select().from(journeyVisits)
      .where(and(
        eq(journeyVisits.projectId, input.projectId),
        inArray(journeyVisits.visitorKey, keys),
        lte(journeyVisits.startedAt, windowEnd),
        gte(journeyVisits.endedAt, windowStart),
      )).all()) {
      const visit: StoredJourneyVisit = {
        id: row.id,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        entry: { entryClass: journeyEntryClassSchema.parse(row.entryClass), entryName: row.entryName, entryHost: row.entryHost, paid: row.paid },
        requestCount: row.requestCount,
        pageCount: row.pageCount,
      }
      stateFor(row.visitorKey).visits.push(visit)
    }
  }

  const result = sessionizeJourneyRequests(keyed, state, {
    idleMs: IDLE_MS,
    lookbackMs: LOOKBACK_MS,
    maxRequestsPerDay: JOURNEY_MAX_REQUESTS_PER_VISITOR_DAY,
    newId: () => crypto.randomUUID(),
  })

  const cappedCutoff = new Date(Date.parse(input.now) - JOURNEY_RETENTION_MS).toISOString().slice(0, 10)
  for (const visitor of result.visitors) {
    // A set of days, so replaying the same requests never counts twice.
    const cappedDays = [...new Set([...(storedCappedDays.get(visitor.visitorKey) ?? []), ...visitor.cappedDays])]
      .filter(day => day >= cappedCutoff)
      .sort()
    tx.insert(journeyVisitors).values({
      projectId: input.projectId,
      visitorKey: visitor.visitorKey,
      keyBasis: basisByKey.get(visitor.visitorKey) ?? JourneyKeyBases.ua,
      userAgent: visitor.userAgent,
      firstAiAt: visitor.firstAiAt,
      firstAiEngine: visitor.firstAiEngine,
      lastAiAt: visitor.lastAiAt,
      lastSeenAt: visitor.lastSeenAt,
      cappedDays,
      createdAt: input.now,
      updatedAt: input.now,
    }).onConflictDoUpdate({
      target: [journeyVisitors.projectId, journeyVisitors.visitorKey],
      set: {
        // Bounds only widen: a backfill can move the first AI visit earlier,
        // a later pull moves the latest AI visit and last-seen time forward.
        firstAiAt: sql`min(${journeyVisitors.firstAiAt}, ${visitor.firstAiAt})`,
        firstAiEngine: sql`CASE WHEN ${visitor.firstAiAt} < ${journeyVisitors.firstAiAt} THEN ${visitor.firstAiEngine} ELSE ${journeyVisitors.firstAiEngine} END`,
        lastAiAt: sql`max(${journeyVisitors.lastAiAt}, ${visitor.lastAiAt})`,
        lastSeenAt: sql`max(${journeyVisitors.lastSeenAt}, ${visitor.lastSeenAt})`,
        cappedDays,
        userAgent: visitor.userAgent,
        updatedAt: input.now,
      },
    }).run()
  }
  for (const visit of result.visits) {
    const values = {
      startedAt: visit.startedAt,
      endedAt: visit.endedAt,
      requestCount: visit.requestCount,
      pageCount: visit.pageCount,
      updatedAt: input.now,
    }
    if (visit.isNew) {
      tx.insert(journeyVisits).values({
        id: visit.id,
        projectId: input.projectId,
        visitorKey: visit.visitorKey,
        sourceId: input.sourceId,
        entryClass: visit.entry.entryClass,
        entryName: visit.entry.entryName,
        entryHost: visit.entry.entryHost,
        paid: visit.entry.paid,
        landingPath: visit.landingPath,
        createdAt: input.now,
        ...values,
      }).run()
    } else if (visit.headChanged) {
      // A late request became the visit's first: it sets the landing page and,
      // when it arrived from outside, where the visit came from.
      tx.update(journeyVisits).set({
        ...values,
        landingPath: visit.landingPath,
        entryClass: visit.entry.entryClass,
        entryName: visit.entry.entryName,
        entryHost: visit.entry.entryHost,
        paid: visit.entry.paid,
      }).where(eq(journeyVisits.id, visit.id)).run()
    } else {
      tx.update(journeyVisits).set(values).where(eq(journeyVisits.id, visit.id)).run()
    }
  }
  // Late arrivals inside a stored visit take that visit's later requests, in
  // the order the splits were made (a split can move requests on again).
  for (const visit of result.visits) {
    if (!visit.splitFrom) continue
    tx.update(journeyEvents).set({ visitId: visit.id })
      .where(and(eq(journeyEvents.visitId, visit.splitFrom.visitId), gt(journeyEvents.ts, visit.splitFrom.after)))
      .run()
  }
  let eventsStored = 0
  for (const event of result.events) {
    const outcome = tx.insert(journeyEvents).values({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      visitId: event.visitId,
      sourceId: input.sourceId,
      sourceEventId: event.request.eventId,
      ts: event.request.observedAt,
      method: event.request.method,
      path: event.request.path,
      status: event.request.status,
      kind: event.request.kind,
      aiTouch: event.aiTouch,
      createdAt: input.now,
    }).onConflictDoNothing().run()
    eventsStored += outcome.changes
  }
  // Visit times and counts come from the requests each visit now holds, so
  // splits, late heads and replays all leave them exact.
  for (const ids of chunks(result.visits.map(v => v.id))) recomputeVisitTotals(tx, ids)
  return { visitsWritten: result.visits.length, eventsStored }
}

function recomputeVisitTotals(tx: JourneyDb, visitIds: readonly string[]): void {
  if (visitIds.length === 0) return
  const of = (expression: ReturnType<typeof sql>) => sql`(SELECT ${expression} FROM ${journeyEvents} WHERE ${journeyEvents.visitId} = ${journeyVisits.id})`
  tx.update(journeyVisits).set({
    startedAt: sql`coalesce(${of(sql`min(${journeyEvents.ts})`)}, ${journeyVisits.startedAt})`,
    endedAt: sql`coalesce(${of(sql`max(${journeyEvents.ts})`)}, ${journeyVisits.endedAt})`,
    requestCount: of(sql`count(*)`),
    pageCount: of(sql`count(*) FILTER (WHERE ${journeyEvents.kind} = 'page')`),
  }).where(inArray(journeyVisits.id, [...visitIds])).run()
}

type JourneyTx = { transaction: <T>(run: (tx: JourneyDb) => T) => T }

/**
 * `persistJourneyBatch` inside a savepoint of the caller's traffic write. A
 * journey failure rolls back only the journey rows and is reported through
 * `onError`; the rollups, samples and receipts in the same transaction still
 * commit, so journeys can never stop traffic ingestion.
 */
export function recordJourneyBatch(
  tx: JourneyTx,
  input: Parameters<typeof persistJourneyBatch>[1],
  handlers: {
    onError: (error: unknown) => void
    /** Whether the caller's transaction is still open (`db.$client.inTransaction`). */
    outerActive: () => boolean
  },
): PersistJourneyBatchResult {
  if (!input.secret || input.events.length === 0) return { visitsWritten: 0, eventsStored: 0 }
  try {
    return tx.transaction(inner => persistJourneyBatch(inner, input))
  } catch (error) {
    // Some SQLite errors roll back the whole transaction, not just the
    // savepoint. Then the traffic write must fail as one unit too.
    if (!handlers.outerActive()) throw error
    handlers.onError(error)
    return { visitsWritten: 0, eventsStored: 0 }
  }
}

/** Delete journey rows older than the retention window, across every project. */
export function enforceJourneyRetention(db: Pick<DatabaseClient, 'delete'>, referenceAt: string): void {
  const cutoff = new Date(Date.parse(referenceAt) - JOURNEY_RETENTION_MS).toISOString()
  db.delete(journeyEvents).where(lt(journeyEvents.ts, cutoff)).run()
  db.delete(journeyVisits).where(lt(journeyVisits.endedAt, cutoff)).run()
  db.delete(journeyVisitors).where(lt(journeyVisitors.lastSeenAt, cutoff)).run()
  // Visitors whose visits went with a deleted traffic source.
  db.delete(journeyVisitors).where(sql`NOT EXISTS (SELECT 1 FROM ${journeyVisits} WHERE ${journeyVisits.projectId} = ${journeyVisitors.projectId} AND ${journeyVisits.visitorKey} = ${journeyVisitors.visitorKey})`).run()
}

function window(since: string | undefined, until: string | undefined): { windowStart: string; windowEnd: string } {
  const windowEnd = new Date(until ? Date.parse(until.length === 10 ? `${until}T23:59:59.999Z` : until) : Date.now()).toISOString()
  const windowStart = new Date(since ? Date.parse(since) : Date.parse(windowEnd) - LOOKBACK_MS).toISOString()
  if (windowStart > windowEnd) throw validationError('since must not be after until', { reason: 'invalid-window' })
  return { windowStart, windowEnd }
}

function parseQuery<S extends z.ZodType>(schema: S, raw: Record<string, unknown>): z.infer<S> {
  const input = { ...raw }
  for (const key of ['limit', 'offset']) if (input[key] !== undefined) input[key] = Number(input[key])
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw validationError(formatValidationIssues(parsed.error.issues), { issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) })
  }
  return parsed.data
}

type VisitRow = typeof journeyVisits.$inferSelect
type VisitorRow = typeof journeyVisitors.$inferSelect

function visitDto(row: VisitRow): JourneyVisitDto {
  return {
    id: row.id,
    sourceId: row.sourceId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    entryClass: journeyEntryClassSchema.parse(row.entryClass),
    entryName: row.entryName,
    entryHost: row.entryHost,
    paid: row.paid,
    landingPath: row.landingPath,
    requestCount: row.requestCount,
    pageCount: row.pageCount,
  }
}

/** Visits after the visitor's first AI visit ended are "later visits". */
function laterVisits(visitor: VisitorRow, visits: readonly VisitRow[]): VisitRow[] {
  const firstAi = visits.find(v => v.entryClass === 'ai' && v.startedAt <= visitor.firstAiAt && v.endedAt >= visitor.firstAiAt)
    ?? visits.find(v => v.entryClass === 'ai')
  const after = firstAi?.endedAt ?? visitor.firstAiAt
  return visits.filter(v => v.startedAt > after)
}

function visitorDto(visitor: VisitorRow, visits: readonly VisitRow[]): JourneyVisitorDto {
  const later = laterVisits(visitor, visits)
  return {
    visitorKey: visitor.visitorKey,
    keyBasis: visitor.keyBasis === JourneyKeyBases['ip-ua'] ? JourneyKeyBases['ip-ua'] : JourneyKeyBases.ua,
    device: journeyDeviceLabel(visitor.userAgent),
    userAgent: visitor.userAgent,
    firstAiAt: visitor.firstAiAt,
    firstAiEngine: visitor.firstAiEngine,
    lastAiAt: visitor.lastAiAt,
    lastSeenAt: visitor.lastSeenAt,
    visitCount: visits.length,
    aiVisitCount: visits.filter(v => v.entryClass === 'ai').length,
    returned: later.length > 0,
    returnChannels: later.map(v => journeyEntryClassSchema.parse(v.entryClass)),
    cappedDays: visitor.cappedDays.length,
  }
}

function visitsByVisitor(db: DatabaseClient, projectId: string, keys: readonly string[]): Map<string, VisitRow[]> {
  const out = new Map<string, VisitRow[]>()
  for (const part of chunks(keys)) {
    for (const row of db.select().from(journeyVisits)
      .where(and(eq(journeyVisits.projectId, projectId), inArray(journeyVisits.visitorKey, part)))
      .orderBy(asc(journeyVisits.startedAt)).all()) {
      const list = out.get(row.visitorKey)
      if (list) list.push(row)
      else out.set(row.visitorKey, [row])
    }
  }
  return out
}

/**
 * Project sources whose logs hold only part of a visitor's requests (see
 * JOURNEY_PARTIAL_SOURCE_TYPES). A Cloudflare source set to forward page views
 * is complete once its deployed Worker reports the matching version.
 */
function partialSources(db: DatabaseClient, projectId: string): JourneyPartialSources {
  const types = Object.keys(JOURNEY_PARTIAL_SOURCE_TYPES)
  const rows = db.select({
    id: trafficSources.id,
    sourceType: trafficSources.sourceType,
    status: trafficSources.status,
    configJson: trafficSources.configJson,
    lastWorkerVersion: trafficSources.lastWorkerVersion,
  }).from(trafficSources)
    .where(and(eq(trafficSources.projectId, projectId), inArray(trafficSources.sourceType, types)))
    .orderBy(asc(trafficSources.id)).all()
  const out: JourneyPartialSources = []
  for (const row of rows) {
    if (row.status === TrafficSourceStatuses.archived) continue
    let reason = JOURNEY_PARTIAL_SOURCE_TYPES[row.sourceType]!
    if (row.sourceType === TrafficSourceTypes.cloudflare) {
      const config = cloudflareTrafficSourceConfigSchema.safeParse(row.configJson)
      if (config.success && config.data.forwardPageViews) {
        if (row.lastWorkerVersion === cloudflareWorkerVersionFor({ forwardPageViews: true })) continue
        reason = JOURNEY_PAGE_VIEWS_PENDING_REASON
      }
    }
    out.push({ sourceId: row.id, sourceType: row.sourceType, reason })
  }
  return out
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Stored AI visitor journeys. Reads only; no provider call or write. */
export async function journeyRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { name: string }; Querystring: Record<string, unknown> }>('/projects/:name/journeys/summary', async request => {
    requireAdminSession(request)
    const project = resolveProject(app.db, request.params.name)
    const query = parseQuery(journeySummaryQuerySchema, request.query)
    const { windowStart, windowEnd } = window(query.since, query.until)
    const candidates = app.db.select().from(journeyVisitors)
      .where(and(eq(journeyVisitors.projectId, project.id), gte(journeyVisitors.firstAiAt, windowStart), lte(journeyVisitors.firstAiAt, windowEnd)))
      .all()
    const visits = visitsByVisitor(app.db, project.id, candidates.map(v => v.visitorKey))
    const visitors = candidates.filter(v => visits.has(v.visitorKey))
    const returnedVia = Object.fromEntries(journeyEntryClassSchema.options.map(c => [c, 0])) as Record<JourneyEntryClass, number>
    const daysToReturn: number[] = []
    const engines = new Map<string, { visitors: number; returningVisitors: number }>()
    let returning = 0
    for (const visitor of visitors) {
      const later = laterVisits(visitor, visits.get(visitor.visitorKey) ?? [])
      const engine = engines.get(visitor.firstAiEngine) ?? { visitors: 0, returningVisitors: 0 }
      engine.visitors += 1
      if (later.length > 0) {
        returning += 1
        engine.returningVisitors += 1
        daysToReturn.push((Date.parse(later[0]!.startedAt) - Date.parse(visitor.firstAiAt)) / DAY_MS)
        for (const v of later) returnedVia[journeyEntryClassSchema.parse(v.entryClass)] += 1
      }
      engines.set(visitor.firstAiEngine, engine)
    }
    const aiVisits = app.db.select({ total: count() }).from(journeyVisits)
      .where(and(eq(journeyVisits.projectId, project.id), eq(journeyVisits.entryClass, 'ai'), gte(journeyVisits.startedAt, windowStart), lte(journeyVisits.startedAt, windowEnd)))
      .get()!.total
    const days = median(daysToReturn)
    const response: JourneySummaryResponse = {
      project: project.name,
      windowStart,
      windowEnd,
      lookbackDays: JOURNEY_LOOKBACK_DAYS,
      aiVisitors: visitors.length,
      aiVisits,
      returningVisitors: returning,
      returnRate: visitors.length ? roundRatio(returning / visitors.length, RatioUnits.fraction) : null,
      returnedVia,
      medianDaysToReturn: days === null ? null : Math.round(days * 10) / 10,
      byEngine: [...engines].map(([engine, v]) => ({ engine, ...v })).sort((a, b) => b.visitors - a.visitors || a.engine.localeCompare(b.engine)),
      keyBasis: {
        ipUa: visitors.filter(v => v.keyBasis === JourneyKeyBases['ip-ua']).length,
        ua: visitors.filter(v => v.keyBasis !== JourneyKeyBases['ip-ua']).length,
      },
      partialSources: partialSources(app.db, project.id),
    }
    return response
  })

  app.get<{ Params: { name: string }; Querystring: Record<string, unknown> }>('/projects/:name/journeys', async request => {
    requireAdminSession(request)
    const project = resolveProject(app.db, request.params.name)
    const query = parseQuery(journeysQuerySchema, request.query)
    const { windowStart, windowEnd } = window(query.since, query.until)
    const filters = [eq(journeyVisitors.projectId, project.id), gte(journeyVisitors.firstAiAt, windowStart), lte(journeyVisitors.firstAiAt, windowEnd)]
    if (query.engine) filters.push(sql`lower(${journeyVisitors.firstAiEngine}) = ${query.engine.toLowerCase()}`)
    const all = app.db.select().from(journeyVisitors).where(and(...filters)).orderBy(desc(journeyVisitors.firstAiAt), desc(journeyVisitors.visitorKey)).all()
    const visits = visitsByVisitor(app.db, project.id, all.map(v => v.visitorKey))
    const matching = all
      .filter(visitor => visits.has(visitor.visitorKey))
      .map(visitor => ({ visitor, dto: visitorDto(visitor, visits.get(visitor.visitorKey) ?? []) }))
      .filter(({ dto }) => query.returned === undefined || dto.returned === (query.returned === 'true'))
    const limit = query.limit ?? 50
    const offset = query.offset ?? 0
    const response: JourneysResponse = {
      project: project.name,
      windowStart,
      windowEnd,
      lookbackDays: JOURNEY_LOOKBACK_DAYS,
      retentionDays: JOURNEY_RETENTION_DAYS,
      totalVisitors: matching.length,
      limit,
      offset,
      partialSources: partialSources(app.db, project.id),
      visitors: matching.slice(offset, offset + limit).map(({ visitor, dto }) => ({
        ...dto,
        visits: (visits.get(visitor.visitorKey) ?? []).slice(0, JOURNEY_LIST_VISITS_PER_VISITOR).map(visitDto),
      })),
    }
    return response
  })

  app.get<{ Params: { name: string; visitorKey: string }; Querystring: Record<string, unknown> }>('/projects/:name/journeys/:visitorKey', async request => {
    requireAdminSession(request)
    const project = resolveProject(app.db, request.params.name)
    const query = parseQuery(journeyDetailQuerySchema, request.query)
    const limit = query.limit ?? 100
    const offset = query.offset ?? 0
    const visitor = app.db.select().from(journeyVisitors)
      .where(and(eq(journeyVisitors.projectId, project.id), eq(journeyVisitors.visitorKey, request.params.visitorKey)))
      .get()
    if (!visitor) throw notFound('Journey', request.params.visitorKey)
    const visits = visitsByVisitor(app.db, project.id, [visitor.visitorKey]).get(visitor.visitorKey) ?? []
    const page = visits.slice(offset, offset + limit)
    const events = new Map<string, Array<typeof journeyEvents.$inferSelect>>()
    for (const part of chunks(page.map(v => v.id))) {
      for (const row of app.db.select().from(journeyEvents).where(inArray(journeyEvents.visitId, part)).orderBy(asc(journeyEvents.ts)).all()) {
        const list = events.get(row.visitId)
        if (list) list.push(row)
        else events.set(row.visitId, [row])
      }
    }
    const response: JourneyDetailResponse = {
      project: project.name,
      visitor: visitorDto(visitor, visits),
      totalVisits: visits.length,
      limit,
      offset,
      visits: page.map(v => ({
        ...visitDto(v),
        events: (events.get(v.id) ?? []).map(e => ({ ts: e.ts, method: e.method, path: e.path, status: e.status, kind: e.kind === 'data' ? 'data' as const : 'page' as const, aiTouch: e.aiTouch })),
      })),
    }
    return response
  })
}
