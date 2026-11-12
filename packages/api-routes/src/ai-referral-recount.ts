import { and, asc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm'
import { TrafficSourceTypes } from '@canonry/canonry-contracts'
import {
  aiReferralEventsHourly,
  dataRepairCompletions,
  journeyEvents,
  journeyVisitors,
  journeyVisits,
  trafficSources,
  type DatabaseClient,
} from '@canonry/canonry-db'
import { DEFAULT_AI_REFERRER_RULES, normalizeTrafficPathPattern } from '@canonry/canonry-integration-traffic'
import { chunks } from './keyed-visitor-state.js'

/**
 * Hours a source counted under the older AI-referral rule (before v207) read
 * high and their rows keep no visitor. AI visitor journeys (v192) did keep one
 * row per visit, so where journeys cover those hours the arrivals can be
 * counted again, once per AI-entered visit, the way the current rule counts.
 *
 * Only sources whose logs see every AI-referred request with its IP qualify:
 * a WordPress logger misses page views a cache serves, and Vercel logs carry
 * no IP, so one journey key there can merge many people. Hours before journeys
 * began on this install, or before the source existed, stay as they are.
 */
export const AI_REFERRAL_JOURNEY_RECOUNT_VERSION = 1
const REPAIR_NAME = 'ai-referral-journey-recount'
const JOURNEYS_MIGRATION_VERSION = 192
const RECOUNT_SOURCE_TYPES: readonly string[] = [TrafficSourceTypes.cloudflare, TrafficSourceTypes['cloud-run']]
const HOUR_MS = 3_600_000

export interface AiReferralSourceRecount {
  sourceId: string
  /** First hour rebuilt from journeys (inclusive). */
  from: string
  /** Last hour rebuilt from journeys (inclusive). */
  through: string
  rowsReplaced: number
  arrivals: number
  /** The source's new `ai_referral_older_count_until`. */
  olderCountUntil: string | null
}

const floorHour = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS
const ceilHour = (ms: number) => Math.ceil(ms / HOUR_MS) * HOUR_MS
const iso = (ms: number) => new Date(ms).toISOString()
const isRedirect = (status: number | null) => status !== null && status >= 300 && status < 400

/** When journey capture began on this install, from v192's applied time. */
function journeysSince(db: DatabaseClient): number | null {
  const [row] = db.all(sql`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', applied_at) AS at FROM _migrations WHERE version = ${JOURNEYS_MIGRATION_VERSION}`) as Array<{ at: string | null }>
  const ms = row?.at ? Date.parse(row.at) : Number.NaN
  return Number.isFinite(ms) ? ms : null
}

function operatorFor(product: string): string {
  return DEFAULT_AI_REFERRER_RULES.find(rule => rule.product === product)?.operator ?? product
}

/**
 * Rebuild each qualifying source's AI-referral hours between the start of
 * journey coverage and the end of its older count from AI-entered journey
 * visits, then move the source's older-count mark back to where coverage
 * began. A source with no AI-entered visit in that span is left alone: an
 * absence there cannot prove zero arrivals.
 */
export function recountAiReferralArrivalsFromJourneys(db: DatabaseClient, now = new Date()): AiReferralSourceRecount[] {
  const since = journeysSince(db)
  if (since === null) return []
  const sources = db.select({
    id: trafficSources.id,
    projectId: trafficSources.projectId,
    sourceType: trafficSources.sourceType,
    createdAt: trafficSources.createdAt,
    olderCountUntil: trafficSources.aiReferralOlderCountUntil,
  }).from(trafficSources).where(inArray(trafficSources.sourceType, [...RECOUNT_SOURCE_TYPES])).all()

  const results: AiReferralSourceRecount[] = []
  for (const source of sources) {
    if (!source.olderCountUntil) continue
    const createdMs = Date.parse(source.createdAt)
    const fromMs = ceilHour(Math.max(since, Number.isFinite(createdMs) ? createdMs : since))
    const throughMs = floorHour(Date.parse(source.olderCountUntil))
    if (!Number.isFinite(throughMs) || fromMs > throughMs) continue
    const from = iso(fromMs)
    const through = iso(throughMs)

    const visits = db.select({
      id: journeyVisits.id,
      startedAt: journeyVisits.startedAt,
      product: journeyVisits.entryName,
      sourceDomain: journeyVisits.entryHost,
      paid: journeyVisits.paid,
      landingPath: journeyVisits.landingPath,
      keyBasis: journeyVisitors.keyBasis,
    }).from(journeyVisits)
      .innerJoin(journeyVisitors, and(
        eq(journeyVisitors.projectId, journeyVisits.projectId),
        eq(journeyVisitors.visitorKey, journeyVisits.visitorKey),
      ))
      .where(and(
        eq(journeyVisits.sourceId, source.id),
        eq(journeyVisits.entryClass, 'ai'),
        gte(journeyVisits.startedAt, from),
        lt(journeyVisits.startedAt, iso(throughMs + HOUR_MS)),
      ))
      .all()
    // Nothing to count from, or keys that can merge people: keep the stored hours.
    if (visits.length === 0 || visits.some(visit => visit.keyBasis !== 'ip-ua')) continue

    // A visit's arrival status is its first page that was not a redirect: an
    // http-to-https hop is not the landing, as in the current rule.
    const statusByVisit = new Map<string, number | null>()
    for (const part of chunks(visits.map(visit => visit.id))) {
      const events = db.select({ visitId: journeyEvents.visitId, status: journeyEvents.status })
        .from(journeyEvents).where(inArray(journeyEvents.visitId, part))
        .orderBy(asc(journeyEvents.visitId), asc(journeyEvents.ts)).all()
      for (const event of events) {
        const current = statusByVisit.get(event.visitId)
        if (current === undefined || (isRedirect(current) && !isRedirect(event.status))) statusByVisit.set(event.visitId, event.status)
      }
    }

    // A visit with no stored request cannot say how it landed: keep the stored hours.
    if (visits.some(visit => !statusByVisit.has(visit.id))) continue

    const buckets = new Map<string, typeof aiReferralEventsHourly.$inferInsert>()
    const stamp = now.toISOString()
    for (const visit of visits) {
      const product = visit.product ?? 'Unknown'
      const sourceDomain = visit.sourceDomain ?? product.toLowerCase()
      const landingPathNormalized = normalizeTrafficPathPattern(visit.landingPath)
      const evidenceType = /[?&]utm_source=/.test(visit.landingPath) ? 'utm' : 'referer'
      // A missing status is stored as 0, as ingest does.
      const status = statusByVisit.get(visit.id) ?? 0
      const tsHour = iso(floorHour(Date.parse(visit.startedAt)))
      const key = [tsHour, product, sourceDomain, evidenceType, landingPathNormalized, status].join('\t')
      const bucket = buckets.get(key) ?? {
        projectId: source.projectId, sourceId: source.id, tsHour, product, operator: operatorFor(product),
        sourceDomain, evidenceType, landingPathNormalized, status,
        sessionsOrHits: 0, paidSessionsOrHits: 0, organicSessionsOrHits: 0, usersEstimated: null,
        createdAt: stamp, updatedAt: stamp,
      }
      bucket.sessionsOrHits! += 1
      if (visit.paid) bucket.paidSessionsOrHits! += 1
      else bucket.organicSessionsOrHits! += 1
      buckets.set(key, bucket)
    }

    const recount = db.transaction(tx => {
      const span = and(
        eq(aiReferralEventsHourly.sourceId, source.id),
        gte(aiReferralEventsHourly.tsHour, from),
        lte(aiReferralEventsHourly.tsHour, through),
      )
      const replaced = tx.select({ rows: sql<number>`COUNT(*)` }).from(aiReferralEventsHourly).where(span).get()?.rows ?? 0
      tx.delete(aiReferralEventsHourly).where(span).run()
      for (const part of chunks([...buckets.values()])) tx.insert(aiReferralEventsHourly).values(part).run()
      // Hours before `from` keep the older count; with none left, nothing does.
      const older = tx.select({ rows: sql<number>`COUNT(*)` }).from(aiReferralEventsHourly)
        .where(and(eq(aiReferralEventsHourly.sourceId, source.id), lt(aiReferralEventsHourly.tsHour, from))).get()?.rows ?? 0
      const olderCountUntil = older > 0 ? from : null
      tx.update(trafficSources).set({ aiReferralOlderCountUntil: olderCountUntil }).where(eq(trafficSources.id, source.id)).run()
      return { rowsReplaced: Number(replaced), olderCountUntil }
    })
    results.push({ sourceId: source.id, from, through, arrivals: visits.length, ...recount })
  }
  return results
}

/**
 * Run the recount once per install, before the server listens. A failure
 * leaves the version pending, so the next startup repeats it; a repeat over
 * already rebuilt hours rebuilds them to the same rows.
 */
export function repairAiReferralArrivalsOnStartup(db: DatabaseClient, now = new Date()): AiReferralSourceRecount[] | null {
  const completed = db.select({ version: dataRepairCompletions.version }).from(dataRepairCompletions)
    .where(eq(dataRepairCompletions.name, REPAIR_NAME)).get()
  if (completed && completed.version >= AI_REFERRAL_JOURNEY_RECOUNT_VERSION) return null
  const results = recountAiReferralArrivalsFromJourneys(db, now)
  const completion = { version: AI_REFERRAL_JOURNEY_RECOUNT_VERSION, completedAt: now.toISOString() }
  db.insert(dataRepairCompletions).values({ name: REPAIR_NAME, ...completion }).onConflictDoUpdate({
    target: dataRepairCompletions.name,
    set: completion,
    setWhere: lt(dataRepairCompletions.version, AI_REFERRAL_JOURNEY_RECOUNT_VERSION),
  }).run()
  return results
}
