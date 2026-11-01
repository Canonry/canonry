import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm'
import {
  JOURNEY_LOOKBACK_DAYS,
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  type NormalizedTrafficRequest,
} from '@canonry/canonry-contracts'
import { journeyEvents, journeyVisitors, journeyVisits, type DatabaseClient } from '@canonry/canonry-db'
import { classifyAiReferral } from '@canonry/canonry-integration-traffic'
import { recomputeVisitTotals } from './journeys.js'

const LOOKBACK_MS = JOURNEY_LOOKBACK_DAYS * 86_400_000
/** Visitors per write transaction, so ingest is never held up for long. */
const VISITOR_BATCH = 50

export interface BackgroundCallJourneyCorrection {
  /** Visitors with a background call marked as from an AI engine or opening a visit. */
  visitors: number
  /** Visitors left with no AI arrival: a background call was their only AI evidence. */
  visitorsRemoved: number
  /** Visits of background calls only, or outside every AI journey that remains. */
  visitsRemoved: number
  /** Visits that now begin at their first page. */
  visitsRelanded: number
}

type CorrectionDb = Pick<DatabaseClient, 'select' | 'insert' | 'update' | 'delete'>

/** Whether a stored page path carries a utm tag naming an AI engine. */
function pathNamesAiEngine(path: string): boolean {
  const [pathOnly = '/', queryString = null] = path.split('?', 2)
  const request: NormalizedTrafficRequest = {
    sourceType: TrafficSourceTypes.cloudflare,
    evidenceKind: TrafficEvidenceKinds['raw-request'],
    confidence: TrafficEventConfidences.observed,
    eventId: 'journey-correction',
    observedAt: new Date(0).toISOString(),
    method: 'GET',
    requestUrl: null,
    host: null,
    path: pathOnly,
    queryString,
    status: 200,
    userAgent: null,
    remoteIp: null,
    referer: null,
    latencyMs: null,
    requestSizeBytes: null,
    responseSizeBytes: null,
    providerResource: { type: 'journey_correction', labels: {} },
    providerLabels: {},
  }
  return classifyAiReferral(request) !== null
}

function correctVisitor(tx: CorrectionDb, input: { projectId: string, visitorKey: string, dryRun: boolean, now: string }, result: BackgroundCallJourneyCorrection): void {
  const { projectId, visitorKey, dryRun } = input
  const visits = tx.select().from(journeyVisits)
    .where(and(eq(journeyVisits.projectId, projectId), eq(journeyVisits.visitorKey, visitorKey)))
    .orderBy(asc(journeyVisits.startedAt))
    .all()
  if (visits.length === 0) return
  const events = tx.select({ id: journeyEvents.id, visitId: journeyEvents.visitId, ts: journeyEvents.ts, path: journeyEvents.path, kind: journeyEvents.kind, aiTouch: journeyEvents.aiTouch })
    .from(journeyEvents)
    .where(inArray(journeyEvents.visitId, visits.map(visit => visit.id)))
    .orderBy(asc(journeyEvents.ts))
    .all()
  const isPage = (event: { kind: string }) => event.kind !== 'data'
  const aiTouches = events.filter(event => isPage(event) && event.aiTouch).map(event => event.ts)
  // A page that carried the AI engine's utm tag itself was the arrival the
  // background call claimed.
  let newTouch: string | null = null
  if (aiTouches.length === 0) {
    const tagged = events.find(event => isPage(event) && pathNamesAiEngine(event.path))
    if (tagged) {
      newTouch = tagged.id
      aiTouches.push(tagged.ts)
    }
  }
  const visitIds = visits.map(visit => visit.id)
  if (aiTouches.length === 0) {
    result.visitorsRemoved++
    result.visitsRemoved += visits.length
    if (dryRun) return
    tx.delete(journeyVisits).where(inArray(journeyVisits.id, visitIds)).run()
    tx.delete(journeyVisitors).where(and(eq(journeyVisitors.projectId, projectId), eq(journeyVisitors.visitorKey, visitorKey))).run()
    return
  }

  const removed: string[] = []
  const relanded: Array<{ id: string, landingTs: string, landingPath: string }> = []
  for (const visit of visits) {
    const own = events.filter(event => event.visitId === visit.id)
    const landing = own.find(isPage)
    if (!landing) {
      removed.push(visit.id)
      continue
    }
    const end = own.at(-1)!.ts
    const touchInside = aiTouches.some(t => t >= landing.ts && t <= end)
    const touchBefore = aiTouches.filter(t => t < landing.ts).at(-1)
    if (!touchInside && !(touchBefore !== undefined && Date.parse(landing.ts) - Date.parse(touchBefore) <= LOOKBACK_MS)) {
      removed.push(visit.id)
      continue
    }
    if (own[0]!.id !== landing.id) relanded.push({ id: visit.id, landingTs: landing.ts, landingPath: landing.path })
  }
  result.visitsRemoved += removed.length
  result.visitsRelanded += relanded.length
  if (dryRun) return

  tx.update(journeyEvents).set({ aiTouch: false })
    .where(and(inArray(journeyEvents.visitId, visitIds), eq(journeyEvents.kind, 'data'), eq(journeyEvents.aiTouch, true)))
    .run()
  if (newTouch) tx.update(journeyEvents).set({ aiTouch: true }).where(eq(journeyEvents.id, newTouch)).run()
  if (removed.length > 0) tx.delete(journeyVisits).where(inArray(journeyVisits.id, removed)).run()
  for (const visit of relanded) {
    // Background calls before the landing page preceded the arrival.
    tx.delete(journeyEvents).where(and(eq(journeyEvents.visitId, visit.id), lt(journeyEvents.ts, visit.landingTs))).run()
    tx.update(journeyVisits).set({ landingPath: visit.landingPath }).where(eq(journeyVisits.id, visit.id)).run()
  }
  recomputeVisitTotals(tx, relanded.map(visit => visit.id))

  const kept = visits.filter(visit => !removed.includes(visit.id))
  const keptIds = new Set(kept.map(visit => visit.id))
  const touches = [...aiTouches].sort()
  const firstAiAt = touches[0]!
  const lastAiAt = touches.at(-1)!
  const lastSeenAt = events.filter(event => keptIds.has(event.visitId)).at(-1)?.ts ?? lastAiAt
  const firstAiVisit = kept.find(visit => visit.entryClass === 'ai' && visit.entryName && visit.startedAt <= firstAiAt && visit.endedAt >= firstAiAt)
  tx.update(journeyVisitors).set({
    firstAiAt,
    lastAiAt,
    lastSeenAt,
    ...(firstAiVisit?.entryName ? { firstAiEngine: firstAiVisit.entryName } : {}),
    updatedAt: input.now,
  }).where(and(eq(journeyVisitors.projectId, projectId), eq(journeyVisitors.visitorKey, visitorKey))).run()
}

/**
 * Correct stored journeys for the rule that a background call (an API or
 * JSON request) never opens a visit or counts as arriving from an AI engine.
 * Its AI evidence came from the page that made it, so that page becomes the
 * arrival when it carried the engine's utm tag. A visitor with no AI arrival
 * left is removed, as are visits of background calls only and visits outside
 * the lookback of every remaining AI arrival. A visit that opened with
 * background calls now begins at its first page. Safe to run any number of
 * times.
 */
export function correctBackgroundCallJourneys(db: DatabaseClient, opts: {
  projectIds?: readonly string[]
  dryRun: boolean
  now: string
}): BackgroundCallJourneyCorrection {
  const result: BackgroundCallJourneyCorrection = { visitors: 0, visitorsRemoved: 0, visitsRemoved: 0, visitsRelanded: 0 }
  const affected = db.selectDistinct({ projectId: journeyVisits.projectId, visitorKey: journeyVisits.visitorKey })
    .from(journeyEvents)
    .innerJoin(journeyVisits, eq(journeyVisits.id, journeyEvents.visitId))
    .where(and(
      eq(journeyEvents.kind, 'data'),
      sql`(${journeyEvents.aiTouch} = 1 OR ${journeyEvents.ts} = ${journeyVisits.startedAt})`,
      opts.projectIds ? inArray(journeyVisits.projectId, [...opts.projectIds]) : undefined,
    ))
    .all()
  result.visitors = affected.length
  for (let i = 0; i < affected.length; i += VISITOR_BATCH) {
    db.transaction((tx) => {
      for (const visitor of affected.slice(i, i + VISITOR_BATCH)) correctVisitor(tx, { ...visitor, dryRun: opts.dryRun, now: opts.now }, result)
    }, { behavior: 'immediate' })
  }
  return result
}
