import { and, eq, inArray, lt } from 'drizzle-orm'
import type { NormalizedTrafficRequest } from '@canonry/canonry-contracts'
import { aiReferralVisitors, projects, type DatabaseClient } from '@canonry/canonry-db'
import { AI_REFERRAL_LOOKBACK_MS, findAiReferralFollowOns, type AiReferralArrival } from '@canonry/canonry-integration-traffic'
import { chunks, keyedIdentityHash } from './keyed-visitor-state.js'

type ArrivalDb = Pick<DatabaseClient, 'select' | 'insert' | 'delete'>
/**
 * Stored arrivals outlive the lookback by a Cloudflare Queue's longest
 * retention (14 days), so a batch that waited in a Queue is still covered.
 */
const RETENTION_MS = AI_REFERRAL_LOOKBACK_MS + 14 * 24 * 60 * 60_000
/** Arrivals kept per visitor and engine, newest last. */
export const MAX_STORED_AI_REFERRAL_ARRIVALS = 50
const KEY_NAMESPACE = 'ai-referral-visitor-v1'

export interface AiReferralArrivalInput {
  projectId: string
  sourceId: string
  events: readonly NormalizedTrafficRequest[]
  /** The install secret that keys journeys. Without it, follow-ons are found within the batch only. */
  secret: string | undefined
}

export interface AiReferralArrivalPlan {
  /** AI-referral requests in this batch that are steps of an arrival already counted. */
  followOnEventIds: ReadonlySet<string>
  /** The arrivals this batch counted, by keyed visitor and engine, to store. Empty without the secret. */
  arrivals: ReadonlyMap<string, readonly AiReferralArrival[]>
}

function loadArrivals(db: ArrivalDb, scope: { projectId: string, sourceId: string }, visitors: readonly string[]): Map<string, AiReferralArrival[]> {
  const known = new Map<string, AiReferralArrival[]>()
  for (const part of chunks(visitors)) {
    const rows = db.select({ visitorKey: aiReferralVisitors.visitorKey, arrivals: aiReferralVisitors.arrivals })
      .from(aiReferralVisitors)
      .where(and(
        eq(aiReferralVisitors.projectId, scope.projectId),
        eq(aiReferralVisitors.sourceId, scope.sourceId),
        inArray(aiReferralVisitors.visitorKey, part),
      ))
      .all()
    for (const row of rows) {
      known.set(row.visitorKey, row.arrivals
        .map(arrival => ({ at: Date.parse(arrival.at), standIn: arrival.standIn }))
        .filter(arrival => Number.isFinite(arrival.at)))
    }
  }
  return known
}

/**
 * AI-referral requests in this batch that are steps of an arrival, here or in
 * a stored earlier batch, so they count as hits and not as more arrivals. A
 * visitor is a keyed hash of its IP, user agent and the engine that sent it,
 * so no address is stored and one engine's arrival never covers another's.
 * Referers on the project's canonical and owned domains are steps.
 */
export function planAiReferralArrivals(db: ArrivalDb, input: AiReferralArrivalInput): AiReferralArrivalPlan {
  const { secret } = input
  const project = db.select({ canonicalDomain: projects.canonicalDomain, ownedDomains: projects.ownedDomains })
    .from(projects).where(eq(projects.id, input.projectId)).get()
  const visitorKey = (event: NormalizedTrafficRequest, product: string): string | null => {
    const remoteIp = event.remoteIp?.trim() ?? ''
    const userAgent = event.userAgent?.trim() ?? ''
    if (!remoteIp && !userAgent) return null
    const parts = [input.projectId, input.sourceId, remoteIp, userAgent, product]
    return secret ? keyedIdentityHash(secret, KEY_NAMESPACE, parts) : JSON.stringify([KEY_NAMESPACE, ...parts])
  }
  const followOns = findAiReferralFollowOns(input.events, {
    actorKey: visitorKey,
    siteDomains: project ? [project.canonicalDomain, ...project.ownedDomains] : [],
    known: secret ? visitors => loadArrivals(db, input, visitors) : undefined,
  })
  // Without the secret the keys hold raw addresses, which are never stored.
  return { followOnEventIds: followOns.eventIds, arrivals: secret ? followOns.arrivals : new Map() }
}

/**
 * A visitor's stored and new arrivals as one list: past the retention window
 * dropped, one entry per instant (a landing seen from outside outranks a
 * stand-in), oldest first, at most `MAX_STORED_AI_REFERRAL_ARRIVALS`.
 */
export function mergeAiReferralArrivals(
  stored: readonly AiReferralArrival[],
  added: readonly AiReferralArrival[],
  cutoffMs: number,
): AiReferralArrival[] {
  const byInstant = new Map<number, AiReferralArrival>()
  for (const arrival of [...stored, ...added]) {
    if (!Number.isFinite(arrival.at) || arrival.at < cutoffMs) continue
    const existing = byInstant.get(arrival.at)
    byInstant.set(arrival.at, { at: arrival.at, standIn: existing ? existing.standIn && arrival.standIn : arrival.standIn })
  }
  return [...byInstant.values()].sort((a, b) => a.at - b.at).slice(-MAX_STORED_AI_REFERRAL_ARRIVALS)
}

/**
 * Add the batch's arrivals to each visitor's stored list and drop expired
 * visitors, in the batch's write transaction. The stored lists are read again
 * here, so arrivals another batch stored after this one was planned (a live
 * sync during a backfill) are kept, and an older batch only adds its arrivals.
 */
export function saveAiReferralArrivals(db: ArrivalDb, input: {
  projectId: string
  sourceId: string
  arrivals: ReadonlyMap<string, readonly AiReferralArrival[]>
  now: string
}): void {
  const cutoffMs = Date.parse(input.now) - RETENTION_MS
  const stored = loadArrivals(db, input, [...input.arrivals.keys()])
  for (const [visitorKey, added] of input.arrivals) {
    const merged = mergeAiReferralArrivals(stored.get(visitorKey) ?? [], added, cutoffMs)
    const latest = merged.at(-1)
    if (!latest) continue
    const arrivals = merged.map(arrival => ({ at: new Date(arrival.at).toISOString(), standIn: arrival.standIn }))
    const lastArrivalAt = new Date(latest.at).toISOString()
    db.insert(aiReferralVisitors)
      .values({ projectId: input.projectId, sourceId: input.sourceId, visitorKey, arrivals, lastArrivalAt, updatedAt: input.now })
      .onConflictDoUpdate({
        target: [aiReferralVisitors.projectId, aiReferralVisitors.sourceId, aiReferralVisitors.visitorKey],
        set: { arrivals, lastArrivalAt, updatedAt: input.now },
      })
      .run()
  }
  db.delete(aiReferralVisitors)
    .where(and(eq(aiReferralVisitors.sourceId, input.sourceId), lt(aiReferralVisitors.lastArrivalAt, new Date(cutoffMs).toISOString())))
    .run()
}
