import crypto from 'node:crypto'
import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import type { NormalizedTrafficRequest } from '@canonry/canonry-contracts'
import { aiReferralVisitors, projects, type DatabaseClient } from '@canonry/canonry-db'
import { AI_REFERRAL_LOOKBACK_MS, findAiReferralFollowOns } from '@canonry/canonry-integration-traffic'

type ArrivalDb = Pick<DatabaseClient, 'select' | 'insert' | 'delete'>
/**
 * Stored arrivals outlive the lookback by a Cloudflare Queue's longest
 * retention (14 days), so a batch that waited in a Queue is still covered.
 */
const RETENTION_MS = AI_REFERRAL_LOOKBACK_MS + 14 * 24 * 60 * 60_000
const KEY_CHUNK = 500

export interface AiReferralArrivalInput {
  projectId: string
  sourceId: string
  events: readonly NormalizedTrafficRequest[]
  /** The install secret that keys journeys. Without it, follow-ons are found within the batch only. */
  secret: string | undefined
}

export interface AiReferralArrivalPlan {
  /** AI-referral requests in this batch that are later steps of a visitor who already arrived. */
  followOnEventIds: ReadonlySet<string>
  /** Each keyed visitor's latest arrival in this batch (epoch ms), to store. Empty without the secret. */
  arrivals: ReadonlyMap<string, number>
}

function loadArrivals(db: ArrivalDb, input: AiReferralArrivalInput, visitors: readonly string[]): Map<string, number> {
  const known = new Map<string, number>()
  for (let i = 0; i < visitors.length; i += KEY_CHUNK) {
    const rows = db.select({ visitorKey: aiReferralVisitors.visitorKey, lastArrivalAt: aiReferralVisitors.lastArrivalAt })
      .from(aiReferralVisitors)
      .where(and(
        eq(aiReferralVisitors.projectId, input.projectId),
        eq(aiReferralVisitors.sourceId, input.sourceId),
        inArray(aiReferralVisitors.visitorKey, visitors.slice(i, i + KEY_CHUNK)),
      ))
      .all()
    for (const row of rows) known.set(row.visitorKey, Date.parse(row.lastArrivalAt))
  }
  return known
}

/**
 * AI-referral requests in this batch that are steps of an arrival, here or in
 * a stored earlier batch, so they count as hits and not as more arrivals. A
 * visitor is a keyed hash of its IP and user agent, so no address is stored.
 * Referers on the project's canonical and owned domains are steps.
 */
export function planAiReferralArrivals(db: ArrivalDb, input: AiReferralArrivalInput): AiReferralArrivalPlan {
  const { secret } = input
  const project = db.select({ canonicalDomain: projects.canonicalDomain, ownedDomains: projects.ownedDomains })
    .from(projects).where(eq(projects.id, input.projectId)).get()
  const visitorKey = (event: NormalizedTrafficRequest): string | null => {
    const remoteIp = event.remoteIp?.trim() ?? ''
    const userAgent = event.userAgent?.trim() ?? ''
    if (!remoteIp && !userAgent) return null
    const identity = JSON.stringify(['ai-referral-visitor-v1', input.projectId, input.sourceId, remoteIp, userAgent])
    return secret ? crypto.createHmac('sha256', secret).update(identity).digest('hex') : identity
  }
  const followOns = findAiReferralFollowOns(input.events, {
    actorKey: visitorKey,
    siteDomains: project ? [project.canonicalDomain, ...project.ownedDomains] : [],
    known: secret ? visitors => loadArrivals(db, input, visitors) : undefined,
  })
  // Without the secret the keys hold raw addresses, which are never stored.
  return { followOnEventIds: followOns.eventIds, arrivals: secret ? followOns.arrivals : new Map() }
}

/** Store each visitor's latest arrival and drop expired ones, in the batch's transaction. */
export function saveAiReferralArrivals(db: ArrivalDb, input: { projectId: string, sourceId: string, arrivals: ReadonlyMap<string, number>, now: string }): void {
  for (const [visitorKey, arrivedAt] of input.arrivals) {
    const lastArrivalAt = new Date(arrivedAt).toISOString()
    db.insert(aiReferralVisitors)
      .values({ projectId: input.projectId, sourceId: input.sourceId, visitorKey, lastArrivalAt, updatedAt: input.now })
      .onConflictDoUpdate({
        target: [aiReferralVisitors.projectId, aiReferralVisitors.sourceId, aiReferralVisitors.visitorKey],
        set: { lastArrivalAt, updatedAt: input.now },
        // Keep the latest arrival: an older batch (a backfill) never moves it back.
        setWhere: sql`${lastArrivalAt} > ${aiReferralVisitors.lastArrivalAt}`,
      })
      .run()
  }
  const cutoff = new Date(Date.parse(input.now) - RETENTION_MS).toISOString()
  db.delete(aiReferralVisitors)
    .where(and(eq(aiReferralVisitors.sourceId, input.sourceId), lt(aiReferralVisitors.lastArrivalAt, cutoff)))
    .run()
}
