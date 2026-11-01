import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import {
  classifyJourneyEntry,
  JOURNEY_LOOKBACK_DAYS,
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  type JourneyEntry,
  type NormalizedTrafficRequest,
} from '@canonry/canonry-contracts'
import { journeyEvents, journeyVisitors, journeyVisits, type DatabaseClient } from '@canonry/canonry-db'
import { classifyAiReferral } from '@canonry/canonry-integration-traffic'
import { recomputeVisitTotals } from './journeys.js'

const LOOKBACK_MS = JOURNEY_LOOKBACK_DAYS * 86_400_000
/** Visitors per write transaction, so ingest is never held up for long. */
const VISITOR_BATCH = 50
const DIRECT_ENTRY: JourneyEntry = { entryClass: 'direct', entryName: null, entryHost: null, paid: false }

export interface BackgroundCallJourneyCorrection {
  /** Visitors whose stored journeys changed. */
  visitors: number
  /** Visitors left with no AI arrival: a background call was their only AI evidence. */
  visitorsRemoved: number
  /** Visits of background calls only, or outside every AI journey that remains. */
  visitsRemoved: number
  /** Visits that now begin at a page an AI arrival keeps, which also says where the visit came from. */
  visitsRelanded: number
}

type CorrectionDb = Pick<DatabaseClient, 'select' | 'insert' | 'update' | 'delete'>

interface StoredEvent {
  id: string
  visitId: string
  ts: string
  path: string
  kind: string
  aiTouch: boolean
}

const isPage = (event: Pick<StoredEvent, 'kind'>) => event.kind !== 'data'

/** Time order, with a page before its background calls at the same instant, as the journey builder orders requests. */
const byTime = (a: StoredEvent, b: StoredEvent) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : Number(!isPage(a)) - Number(!isPage(b)))

/** Where a visit came from when a stored page path carries a utm tag naming an AI engine; null otherwise. */
function aiEntryOfPath(path: string): JourneyEntry | null {
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
  const ai = classifyAiReferral(request)
  if (!ai) return null
  return classifyJourneyEntry({
    aiProduct: ai.product,
    aiDomain: ai.sourceDomain,
    aiPaid: ai.trafficClass === 'paid',
    refererHost: null,
    utmSource: null,
    utmMedium: null,
    adClickId: false,
    clickNetwork: null,
  })
}

const sameEntry = (a: JourneyEntry, b: { entryClass: string, entryName: string | null, entryHost: string | null, paid: boolean }) => a.entryClass === b.entryClass && a.entryName === b.entryName && a.entryHost === b.entryHost && a.paid === b.paid

function correctVisitor(tx: CorrectionDb, input: { projectId: string, visitorKey: string, dryRun: boolean, now: string }, result: BackgroundCallJourneyCorrection): void {
  const { projectId, visitorKey, dryRun } = input
  const visits = tx.select().from(journeyVisits)
    .where(and(eq(journeyVisits.projectId, projectId), eq(journeyVisits.visitorKey, visitorKey)))
    .orderBy(asc(journeyVisits.startedAt))
    .all()
  if (visits.length === 0) return
  const events: StoredEvent[] = tx.select({ id: journeyEvents.id, visitId: journeyEvents.visitId, ts: journeyEvents.ts, path: journeyEvents.path, kind: journeyEvents.kind, aiTouch: journeyEvents.aiTouch })
    .from(journeyEvents)
    .where(inArray(journeyEvents.visitId, visits.map(visit => visit.id)))
    .orderBy(asc(journeyEvents.ts))
    .all()
    .sort(byTime)

  // AI arrivals under today's rule, in time order: stored page arrivals, and a
  // page tagged with an AI engine's utm that a background call's arrival hid
  // (it came within that call's lookback). As in the journey builder, such a
  // page is an arrival when no arrival came within the lookback before it.
  const touches: string[] = []
  const promoted = new Map<string, JourneyEntry>()
  for (const event of events) {
    if (!isPage(event)) continue
    if (event.aiTouch) {
      touches.push(event.ts)
      continue
    }
    const last = touches.at(-1)
    if (last !== undefined && Date.parse(event.ts) - Date.parse(last) <= LOOKBACK_MS) continue
    const entry = aiEntryOfPath(event.path)
    if (entry) {
      touches.push(event.ts)
      promoted.set(event.id, entry)
    }
  }

  const visitIds = visits.map(visit => visit.id)
  if (touches.length === 0) {
    result.visitors++
    result.visitorsRemoved++
    result.visitsRemoved += visits.length
    if (dryRun) return
    tx.delete(journeyVisits).where(inArray(journeyVisits.id, visitIds)).run()
    tx.delete(journeyVisitors).where(and(eq(journeyVisitors.projectId, projectId), eq(journeyVisitors.visitorKey, visitorKey))).run()
    return
  }

  /** An arrival came at or before `ts`, within the lookback. */
  const withinLookback = (ts: string) => {
    const last = touches.filter(t => t <= ts).at(-1)
    return last !== undefined && Date.parse(ts) - Date.parse(last) <= LOOKBACK_MS
  }
  const removed: string[] = []
  const restarted: Array<{ id: string, drop: string[], landingPath: string, entry: JourneyEntry | null }> = []
  for (const visit of visits) {
    const own = events.filter(event => event.visitId === visit.id)
    // A visit now begins at its first page that is an AI arrival or comes
    // within the lookback of one; no request before it would have been kept.
    const start = own.findIndex(event => isPage(event) && withinLookback(event.ts))
    if (start === -1) {
      removed.push(visit.id)
      continue
    }
    const head = own[start]!
    const storedHead = head.ts === visit.startedAt && head.path === visit.landingPath
    // Where the visit came from is its first page's: the engine of an arrival
    // newly found from its utm tag; for a page that newly opens the visit and
    // is no arrival, nowhere outside (it only continued the call's visit).
    const entry = promoted.get(head.id) ?? (storedHead || head.aiTouch ? null : DIRECT_ENTRY)
    const changedEntry = entry && !sameEntry(entry, visit) ? entry : null
    if (start > 0 || !storedHead || changedEntry) restarted.push({ id: visit.id, drop: own.slice(0, start).map(event => event.id), landingPath: head.path, entry: changedEntry })
  }
  const callTouches = events.some(event => !isPage(event) && event.aiTouch)
  // A call logged at the same instant as its page leaves nothing to change.
  if (!callTouches && promoted.size === 0 && removed.length === 0 && restarted.length === 0) return
  result.visitors++
  result.visitsRemoved += removed.length
  result.visitsRelanded += restarted.length
  if (dryRun) return

  tx.update(journeyEvents).set({ aiTouch: false })
    .where(and(inArray(journeyEvents.visitId, visitIds), eq(journeyEvents.kind, 'data'), eq(journeyEvents.aiTouch, true)))
    .run()
  if (promoted.size > 0) tx.update(journeyEvents).set({ aiTouch: true }).where(inArray(journeyEvents.id, [...promoted.keys()])).run()
  if (removed.length > 0) tx.delete(journeyVisits).where(inArray(journeyVisits.id, removed)).run()
  for (const visit of restarted) {
    // Requests before the new first page came before the arrival.
    if (visit.drop.length > 0) tx.delete(journeyEvents).where(inArray(journeyEvents.id, visit.drop)).run()
    tx.update(journeyVisits).set({
      landingPath: visit.landingPath,
      ...(visit.entry ? { entryClass: visit.entry.entryClass, entryName: visit.entry.entryName, entryHost: visit.entry.entryHost, paid: visit.entry.paid } : {}),
    }).where(eq(journeyVisits.id, visit.id)).run()
  }
  recomputeVisitTotals(tx, restarted.map(visit => visit.id))

  const keptIds = new Set(visits.filter(visit => !removed.includes(visit.id)).map(visit => visit.id))
  const dropped = new Set(restarted.flatMap(visit => visit.drop))
  const firstAiAt = touches[0]!
  const lastAiAt = touches.at(-1)!
  const lastSeenAt = events.filter(event => keptIds.has(event.visitId) && !dropped.has(event.id)).at(-1)?.ts ?? lastAiAt
  const firstTouch = events.find(event => isPage(event) && event.ts === firstAiAt && (event.aiTouch || promoted.has(event.id)))
  const firstVisit = visits.find(visit => visit.id === firstTouch?.visitId)
  const firstEntry = (firstTouch && promoted.get(firstTouch.id)) || restarted.find(visit => visit.id === firstVisit?.id)?.entry || firstVisit
  tx.update(journeyVisitors).set({
    firstAiAt,
    lastAiAt,
    lastSeenAt,
    ...(firstEntry?.entryClass === 'ai' && firstEntry.entryName ? { firstAiEngine: firstEntry.entryName } : {}),
    updatedAt: input.now,
  }).where(and(eq(journeyVisitors.projectId, projectId), eq(journeyVisitors.visitorKey, visitorKey))).run()
}

/**
 * Correct stored journeys for the rule that a background call (an API or
 * JSON request) never opens a visit or counts as arriving from an AI engine.
 * Its AI evidence came from the page that made it, so a page tagged with the
 * engine's utm becomes an arrival when no arrival came within the lookback
 * before it, as the journey builder decides today. A visitor with no AI
 * arrival left is removed, as are visits with no page at or within the
 * lookback of a remaining arrival. A kept visit begins at its first such page,
 * which also says where it came from. Stored requests keep no referer, so a
 * page whose AI tag was only on its referer cannot become an arrival. Only
 * visitors with a background call marked as an arrival or opening a visit are
 * read, which today's rules never store, so a later run changes nothing.
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
      // A call marked as an arrival, or the call a visit opened with.
      sql`(${journeyEvents.aiTouch} = 1 OR (${journeyEvents.ts} = ${journeyVisits.startedAt} AND ${journeyEvents.path} = ${journeyVisits.landingPath}))`,
      opts.projectIds ? inArray(journeyVisits.projectId, [...opts.projectIds]) : undefined,
    ))
    .all()
  for (let i = 0; i < affected.length; i += VISITOR_BATCH) {
    db.transaction((tx) => {
      for (const visitor of affected.slice(i, i + VISITOR_BATCH)) correctVisitor(tx, { ...visitor, dryRun: opts.dryRun, now: opts.now }, result)
    }, { behavior: 'immediate' })
  }
  return result
}
