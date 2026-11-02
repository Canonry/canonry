import type { AiReferralTrafficClass, NormalizedTrafficRequest } from '@canonry/canonry-contracts'
import { AiReferralTrafficClasses, hostOf, isLocationRedirectStatus, JOURNEY_LOOKBACK_DAYS } from '@canonry/canonry-contracts'
import { AgentTrustLevels } from '@canonry/canonry-contracts'
import { withScannerBurst } from './agent-trust.js'
import { classifyAiReferral, classifyAiUserFetch, classifyCrawler, isSelfTraffic } from './classifier.js'
import { isStepReferer, siteDomainHosts } from './journey.js'
import { findScannerBurstsInBatch } from './scanner-bursts.js'
import type {
  AiReferralEventHourlyBucket,
  AiReferralEvidenceType,
  AiUserFetchEventHourlyBucket,
  AiUserFetchLikelyFakeHourlyBucket,
  BuildTrafficProbeReportOptions,
  ClassifiedAiReferral,
  CrawlerEventHourlyBucket,
  TrafficProbeReport,
  UnrecognizedAgentEventHourlyBucket,
} from './types.js'
import { unrecognizedAgentName } from './unlisted-agents.js'

const DEFAULT_SAMPLE_LIMIT = 25
// Bounds what a burst of random user agents can write per batch; the busiest
// names are kept.
const MAX_UNRECOGNIZED_AGENT_NAMES = 200
const DEFAULT_AI_REFERRAL_SESSION_WINDOW_MS = 60_000
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LONG_HEX_SEGMENT = /^[0-9a-f]{16,}$/i
const NUMERIC_SEGMENT = /^\d+$/
const ASSET_EXTENSION_PATTERN = /\.(?:avif|bmp|css|gif|ico|jpe?g|js|json|map|mjs|mp4|otf|png|svg|webm|webmanifest|woff2?|xml)$/i
const ASSET_PATH_PREFIXES = [
  '/_next/static/',
  '/assets/',
  '/build/',
  '/dist/',
  '/fonts/',
  '/images/',
  '/img/',
  '/static/',
]

interface AiReferralSession {
  tsHour: string
  operator: string
  product: string
  sourceDomain: string
  evidenceType: AiReferralEvidenceType
  landingPathNormalized: string
  status: number | null
  trafficClass: AiReferralTrafficClass
}

export function normalizeTrafficPathPattern(path: string): string {
  const cleanPath = path.trim() || '/'
  const pathOnly = cleanPath.split('?')[0] || '/'
  const segments = pathOnly.split('/').map((segment) => {
    if (!segment) return segment
    if (UUID_SEGMENT.test(segment) || LONG_HEX_SEGMENT.test(segment) || NUMERIC_SEGMENT.test(segment)) {
      return ':id'
    }
    return segment
  })
  const normalized = segments.join('/')
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

function hourBucket(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  date.setUTCMinutes(0, 0, 0)
  return date.toISOString()
}

function sessionWindowBucket(value: string, windowMs: number): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Date(Math.floor(date.getTime() / windowMs) * windowMs).toISOString()
}

function sameHost(a: string | null, b: string | null): boolean {
  const normalizedA = hostOf(a)
  const normalizedB = hostOf(b)
  return !!normalizedA && !!normalizedB && normalizedA === normalizedB
}

function pathFromSameOriginReferer(event: NormalizedTrafficRequest): string | null {
  if (!event.referer) return null
  try {
    const refererUrl = new URL(event.referer)
    if (!sameHost(refererUrl.hostname, event.host)) return null
    return refererUrl.pathname || '/'
  } catch {
    return null
  }
}

function resolveAiReferralLandingPath(
  event: NormalizedTrafficRequest,
  evidenceType: AiReferralEvidenceType,
): string {
  if (evidenceType === 'referer-utm') {
    const refererPath = pathFromSameOriginReferer(event)
    if (refererPath) return normalizeTrafficPathPattern(refererPath)
  }
  return normalizeTrafficPathPattern(event.path)
}

function isLikelySubresourcePath(path: string): boolean {
  const cleanPath = path.split('?')[0] || '/'
  return ASSET_PATH_PREFIXES.some(prefix => cleanPath.startsWith(prefix)) ||
    ASSET_EXTENSION_PATTERN.test(cleanPath)
}

/** One visitor's IP and user agent, or null when the request reports neither. Never stored. */
function batchActorKey(event: NormalizedTrafficRequest): string | null {
  const remoteIp = event.remoteIp?.trim()
  const userAgent = event.userAgent?.trim()
  return remoteIp || userAgent ? `${remoteIp ?? 'unknown-ip'}\t${userAgent ?? 'unknown-ua'}` : null
}

function actorKey(event: NormalizedTrafficRequest): string {
  return batchActorKey(event) ?? `event:${event.eventId}`
}

/**
 * How long an AI arrival covers its visitor's later same-site requests that
 * still carry the engine's utm: the journeys' lookback. Within it such a
 * request is a step of that arrival, not another arrival.
 */
export const AI_REFERRAL_LOOKBACK_MS = JOURNEY_LOOKBACK_DAYS * 24 * 60 * 60_000

export interface FindAiReferralFollowOnsOptions {
  /** The visitor behind a request (its IP and user agent), or null to leave its request alone. */
  actorKey: (event: NormalizedTrafficRequest) => string | null
  /** The latest arrival (epoch ms) stored for each visitor this batch names, from earlier batches. */
  known?: (actors: readonly string[]) => ReadonlyMap<string, number>
  /** The project's own domains. A referer on them, or on the request's own host, is a step. */
  siteDomains?: readonly string[]
  lookbackMs?: number
}

export interface AiReferralFollowOns {
  /** AI-referral requests that are steps of an earlier arrival, never counted as arrivals. */
  eventIds: Set<string>
  /** Each visitor's latest arrival in this batch (epoch ms). */
  arrivals: Map<string, number>
}

/**
 * Which AI-referral requests are arrivals, by the journeys' rule. A request
 * whose referer is outside the site (the AI engine's page, or none) is an
 * arrival. A request with a same-site referer (`isStepReferer`) that still
 * carries the engine's utm, on its own URL or its referer's, is a later page,
 * asset or API call of a visitor already on the site: the landing page's tags
 * ride every request the visit makes. It is a step of the visitor's arrival
 * when one came within `lookbackMs` before it, in this batch or a stored
 * earlier one (`known`), and the arrival itself otherwise: a site whose pages
 * a cache serves before the logs see them shows only these requests, and one
 * of them stands for the landing. Only requests that open a session count
 * (static files are never a landing), and a Location redirect is a hop, never
 * the arrival: it covers nothing, and a same-site one is always a step. At the
 * same instant an arrival from outside comes before a step. A stored arrival
 * later than a request (an older batch, such as a backfill) does not cover it.
 */
export function findAiReferralFollowOns(
  events: readonly NormalizedTrafficRequest[],
  options: FindAiReferralFollowOnsOptions,
): AiReferralFollowOns {
  const lookbackMs = options.lookbackMs ?? AI_REFERRAL_LOOKBACK_MS
  const siteHosts = siteDomainHosts(options.siteDomains)
  const candidates: Array<{ eventId: string, actor: string, at: number, step: boolean, hop: boolean }> = []
  for (const event of events) {
    if (isSelfTraffic(event)) continue
    const referral = classifyAiReferral(event)
    if (!referral || isLikelySubresourcePath(resolveAiReferralLandingPath(event, referral.evidenceType))) continue
    const at = Date.parse(event.observedAt)
    const actor = options.actorKey(event)
    if (!Number.isFinite(at) || actor === null) continue
    const hop = event.status !== null && isLocationRedirectStatus(event.status)
    candidates.push({ eventId: event.eventId, actor, at, step: isStepReferer(event, siteHosts), hop })
  }
  candidates.sort((a, b) => a.at - b.at || Number(a.step) - Number(b.step))

  const stepActors = [...new Set(candidates.filter(candidate => candidate.step).map(candidate => candidate.actor))]
  const known = stepActors.length > 0 && options.known ? options.known(stepActors) : new Map<string, number>()
  const eventIds = new Set<string>()
  const arrivals = new Map<string, number>()
  for (const candidate of candidates) {
    if (candidate.step) {
      // In time order, so an arrival from this batch is never later than the request.
      const previous = arrivals.get(candidate.actor)
      const stored = known.get(candidate.actor)
      const covered = (previous !== undefined && candidate.at - previous <= lookbackMs)
        || (stored !== undefined && stored <= candidate.at && candidate.at - stored <= lookbackMs)
      if (covered || candidate.hop) {
        eventIds.add(candidate.eventId)
        continue
      }
    }
    if (!candidate.hop) arrivals.set(candidate.actor, candidate.at)
  }
  return { eventIds, arrivals }
}

/** Follow-ons within one batch, keyed by raw IP and user agent and never stored. */
export function findAiReferralFollowOnsInBatch(events: readonly NormalizedTrafficRequest[]): Set<string> {
  return findAiReferralFollowOns(events, { actorKey: batchActorKey }).eventIds
}

function aiReferralSessionKey(
  event: NormalizedTrafficRequest,
  aiReferral: ClassifiedAiReferral,
  landingPathNormalized: string,
  windowMs: number,
): string {
  return [
    hourBucket(event.observedAt),
    sessionWindowBucket(event.observedAt, windowMs),
    actorKey(event),
    aiReferral.sourceDomain,
    landingPathNormalized,
  ].join('\t')
}

function evidenceRank(evidenceType: AiReferralEvidenceType): number {
  switch (evidenceType) {
    case 'referer': return 3
    case 'utm': return 2
    case 'referer-utm': return 1
  }
}

function mergeReferralSession(
  current: AiReferralSession,
  next: AiReferralSession,
): AiReferralSession {
  const winner = evidenceRank(next.evidenceType) > evidenceRank(current.evidenceType) ? next : current
  // Paid evidence anywhere in the session settles the class. A session's hits
  // are one actor's burst: the landing request carries the ad's UTM tags, the
  // sub-resource requests that follow carry none. Absence of the tags on a
  // later hit is not evidence the click was organic.
  const paid = current.trafficClass === AiReferralTrafficClasses.paid ||
    next.trafficClass === AiReferralTrafficClasses.paid
  return { ...winner, trafficClass: paid ? AiReferralTrafficClasses.paid : winner.trafficClass }
}

function sortCrawlerBuckets(a: CrawlerEventHourlyBucket, b: CrawlerEventHourlyBucket): number {
  return a.tsHour.localeCompare(b.tsHour) ||
    a.botId.localeCompare(b.botId) ||
    a.verificationStatus.localeCompare(b.verificationStatus) ||
    (a.verificationManifest?.id ?? '').localeCompare(b.verificationManifest?.id ?? '') ||
    a.pathNormalized.localeCompare(b.pathNormalized) ||
    String(a.status).localeCompare(String(b.status))
}

function sortAiUserFetchBuckets(a: AiUserFetchEventHourlyBucket, b: AiUserFetchEventHourlyBucket): number {
  return a.tsHour.localeCompare(b.tsHour) ||
    a.botId.localeCompare(b.botId) ||
    a.verificationStatus.localeCompare(b.verificationStatus) ||
    (a.verificationManifest?.id ?? '').localeCompare(b.verificationManifest?.id ?? '') ||
    a.pathNormalized.localeCompare(b.pathNormalized) ||
    String(a.status).localeCompare(String(b.status))
}

function sortLikelyFakeBuckets(a: AiUserFetchLikelyFakeHourlyBucket, b: AiUserFetchLikelyFakeHourlyBucket): number {
  return a.tsHour.localeCompare(b.tsHour) || a.botId.localeCompare(b.botId) || a.reason.localeCompare(b.reason)
}

function sortReferralBuckets(a: AiReferralEventHourlyBucket, b: AiReferralEventHourlyBucket): number {
  return a.tsHour.localeCompare(b.tsHour) ||
    a.product.localeCompare(b.product) ||
    a.sourceDomain.localeCompare(b.sourceDomain) ||
    a.landingPathNormalized.localeCompare(b.landingPathNormalized) ||
    String(a.status).localeCompare(String(b.status))
}

function topEntries<T extends Record<string, string>>(
  map: Map<string, { fields: T; hits: number }>,
  limit: number,
): Array<T & { hits: number }> {
  return [...map.values()]
    .sort((a, b) => b.hits - a.hits || JSON.stringify(a.fields).localeCompare(JSON.stringify(b.fields)))
    .slice(0, limit)
    .map((entry) => ({ ...entry.fields, hits: entry.hits }))
}

export function buildTrafficProbeReport(
  events: NormalizedTrafficRequest[],
  options: BuildTrafficProbeReportOptions = {},
): TrafficProbeReport {
  const sampleLimit = options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT
  const configuredSessionWindowMs = options.aiReferralSessionWindowMs ?? DEFAULT_AI_REFERRAL_SESSION_WINDOW_MS
  const aiReferralSessionWindowMs = configuredSessionWindowMs > 0
    ? configuredSessionWindowMs
    : DEFAULT_AI_REFERRAL_SESSION_WINDOW_MS
  const crawlerBuckets = new Map<string, CrawlerEventHourlyBucket>()
  const aiUserFetchBuckets = new Map<string, AiUserFetchEventHourlyBucket>()
  const likelyFakeBuckets = new Map<string, AiUserFetchLikelyFakeHourlyBucket>()
  const aiReferralBuckets = new Map<string, AiReferralEventHourlyBucket>()
  const unrecognizedAgentBuckets = new Map<string, UnrecognizedAgentEventHourlyBucket>()
  const aiReferralSessions = new Map<string, AiReferralSession>()
  const topBots = new Map<string, { fields: { botId: string; operator: string }; hits: number }>()
  const topCrawlerPaths = new Map<string, { fields: { pathNormalized: string }; hits: number }>()
  const topAiUserFetchBots = new Map<string, { fields: { botId: string; operator: string }; hits: number }>()
  const topAiUserFetchPaths = new Map<string, { fields: { pathNormalized: string }; hits: number }>()
  const topAiReferrers = new Map<string, { fields: { sourceDomain: string; product: string }; hits: number }>()
  const topAiReferralLandingPaths = new Map<string, { fields: { landingPathNormalized: string }; hits: number }>()

  // Drop Canonry's own tooling (e.g. the AEO auditor) before rollup so our
  // measurement traffic never inflates a client's crawler / unknown / total
  // counts. The dropped count is surfaced in `totals.selfTrafficExcluded`.
  const includedEvents = events.filter((event) => !isSelfTraffic(event))
  const selfTrafficExcluded = events.length - includedEvents.length
  const scannerBursts = options.scannerBurstEventIds ?? findScannerBurstsInBatch(includedEvents)
  const aiReferralFollowOns = options.aiReferralFollowOnEventIds ?? findAiReferralFollowOnsInBatch(includedEvents)

  let crawlerHits = 0
  let aiUserFetchHits = 0
  let aiUserFetchLikelyFakeHits = 0
  let aiReferralHits = 0
  let aiReferralPaidSessions = 0
  let aiReferralOrganicSessions = 0
  let unknownHits = 0
  const samples: TrafficProbeReport['samples'] = []

  for (const event of includedEvents) {
    const tsHour = hourBucket(event.observedAt)
    const pathNormalized = normalizeTrafficPathPattern(event.path)
    const crawler = classifyCrawler(event)
    const classifiedFetch = classifyAiUserFetch(event)
    const aiUserFetch = classifiedFetch && scannerBursts.has(event.eventId) ? withScannerBurst(classifiedFetch) : classifiedFetch
    const aiReferral = classifyAiReferral(event)

    if (crawler) {
      crawlerHits += 1
      const key = [
        tsHour,
        crawler.botId,
        crawler.verificationStatus,
        crawler.verificationManifest?.id ?? 'no-manifest',
        pathNormalized,
        event.status ?? 'null',
      ].join('\t')
      const existing = crawlerBuckets.get(key)
      if (existing) {
        existing.hits += 1
      } else {
        crawlerBuckets.set(key, {
          tsHour,
          botId: crawler.botId,
          operator: crawler.operator,
          product: crawler.product,
          verificationStatus: crawler.verificationStatus,
          verificationManifest: crawler.verificationManifest,
          pathNormalized,
          status: event.status,
          hits: 1,
          sampledUserAgent: event.userAgent,
        })
      }
      const botKey = `${crawler.botId}\t${crawler.operator}`
      const botEntry = topBots.get(botKey)
      if (botEntry) botEntry.hits += 1
      else topBots.set(botKey, { fields: { botId: crawler.botId, operator: crawler.operator }, hits: 1 })
      incrementBucket(topCrawlerPaths, pathNormalized, { pathNormalized })
    }

    if (aiUserFetch?.trust === AgentTrustLevels.likely_fake) {
      // Not an AI agent visit: counted on its own, never as an AI user fetch.
      aiUserFetchLikelyFakeHits += 1
      const reason = aiUserFetch.trustReasons[0]!
      const key = [tsHour, aiUserFetch.botId, reason].join('\t')
      const existing = likelyFakeBuckets.get(key)
      if (existing) existing.hits += 1
      else likelyFakeBuckets.set(key, { tsHour, botId: aiUserFetch.botId, operator: aiUserFetch.operator, reason, hits: 1 })
    } else if (aiUserFetch) {
      aiUserFetchHits += 1
      const key = [
        tsHour,
        aiUserFetch.botId,
        aiUserFetch.verificationStatus,
        aiUserFetch.verificationManifest?.id ?? 'no-manifest',
        pathNormalized,
        event.status ?? 'null',
      ].join('\t')
      const existing = aiUserFetchBuckets.get(key)
      if (existing) {
        existing.hits += 1
      } else {
        aiUserFetchBuckets.set(key, {
          tsHour,
          botId: aiUserFetch.botId,
          operator: aiUserFetch.operator,
          product: aiUserFetch.product,
          verificationStatus: aiUserFetch.verificationStatus,
          verificationManifest: aiUserFetch.verificationManifest,
          pathNormalized,
          status: event.status,
          hits: 1,
          sampledUserAgent: event.userAgent,
        })
      }
      const botKey = `${aiUserFetch.botId}\t${aiUserFetch.operator}`
      const botEntry = topAiUserFetchBots.get(botKey)
      if (botEntry) botEntry.hits += 1
      else topAiUserFetchBots.set(botKey, { fields: { botId: aiUserFetch.botId, operator: aiUserFetch.operator }, hits: 1 })
      incrementBucket(topAiUserFetchPaths, pathNormalized, { pathNormalized })
    }

    if (aiReferral) {
      aiReferralHits += 1
      const landingPathNormalized = resolveAiReferralLandingPath(event, aiReferral.evidenceType)
      // A later request of a visitor who already arrived is a hit, not another arrival.
      if (!aiReferralFollowOns.has(event.eventId) && !isLikelySubresourcePath(landingPathNormalized)) {
        const session: AiReferralSession = {
          tsHour,
          operator: aiReferral.operator,
          product: aiReferral.product,
          sourceDomain: aiReferral.sourceDomain,
          evidenceType: aiReferral.evidenceType,
          landingPathNormalized,
          status: event.status,
          trafficClass: aiReferral.trafficClass,
        }
        const key = aiReferralSessionKey(event, aiReferral, landingPathNormalized, aiReferralSessionWindowMs)
        const existing = aiReferralSessions.get(key)
        aiReferralSessions.set(key, existing ? mergeReferralSession(existing, session) : session)
      }
    }

    if (!crawler && !aiUserFetch && !aiReferral) {
      unknownHits += 1
      const agentName = unrecognizedAgentName(event)
      if (agentName) {
        const key = `${tsHour}\t${agentName}`
        const existing = unrecognizedAgentBuckets.get(key)
        if (existing) {
          existing.hits += 1
          existing.sampledUserAgent = event.userAgent ?? existing.sampledUserAgent
          existing.sampledPath = pathNormalized
        } else {
          unrecognizedAgentBuckets.set(key, { tsHour, agentName, hits: 1, sampledUserAgent: event.userAgent ?? '', sampledPath: pathNormalized })
        }
      }
    }

    // Keep the most-recent `sampleLimit` events by iteration order, not the
    // first ones we see. Pulls run timestamp-asc, so a FIFO retention would
    // surface only the oldest slice of the window — the least useful for
    // classifier debugging.
    samples.push({
      eventId: event.eventId,
      observedAt: event.observedAt,
      sourceType: event.sourceType,
      path: event.path,
      pathNormalized,
      status: event.status,
      userAgent: event.userAgent,
      referer: event.referer,
      crawler,
      aiUserFetch,
      aiReferral,
    })
    if (samples.length > sampleLimit) samples.shift()
  }

  for (const session of aiReferralSessions.values()) {
    const key = [
      session.tsHour,
      session.product,
      session.sourceDomain,
      session.evidenceType,
      session.landingPathNormalized,
      session.status ?? 'null',
    ].join('\t')
    const { trafficClass, ...bucketFields } = session
    const paid = trafficClass === AiReferralTrafficClasses.paid
    if (paid) aiReferralPaidSessions += 1
    else aiReferralOrganicSessions += 1
    const existing = aiReferralBuckets.get(key)
    if (existing) {
      existing.hits += 1
      if (paid) existing.paidHits += 1
      else existing.organicHits += 1
    } else {
      aiReferralBuckets.set(key, {
        ...bucketFields,
        hits: 1,
        paidHits: paid ? 1 : 0,
        organicHits: paid ? 0 : 1,
      })
    }
    incrementBucket(topAiReferrers, session.sourceDomain, {
      sourceDomain: session.sourceDomain,
      product: session.product,
    })
    incrementBucket(topAiReferralLandingPaths, session.landingPathNormalized, {
      landingPathNormalized: session.landingPathNormalized,
    })
  }

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    totals: {
      normalizedEvents: includedEvents.length,
      selfTrafficExcluded,
      crawlerHits,
      aiUserFetchHits,
      aiUserFetchLikelyFakeHits,
      aiReferralSessions: aiReferralSessions.size,
      aiReferralPaidSessions,
      aiReferralOrganicSessions,
      aiReferralHits,
      unknownHits,
    },
    crawlerEventsHourly: [...crawlerBuckets.values()].sort(sortCrawlerBuckets),
    aiUserFetchEventsHourly: [...aiUserFetchBuckets.values()].sort(sortAiUserFetchBuckets),
    aiUserFetchLikelyFakeHourly: [...likelyFakeBuckets.values()].sort(sortLikelyFakeBuckets),
    aiReferralEventsHourly: [...aiReferralBuckets.values()].sort(sortReferralBuckets),
    unrecognizedAgentEventsHourly: busiestUnrecognizedAgents(unrecognizedAgentBuckets),
    topBots: topEntries(topBots, 10),
    topCrawlerPaths: topEntries(topCrawlerPaths, 10),
    topAiUserFetchBots: topEntries(topAiUserFetchBots, 10),
    topAiUserFetchPaths: topEntries(topAiUserFetchPaths, 10),
    topAiReferrers: topEntries(topAiReferrers, 10),
    topAiReferralLandingPaths: topEntries(topAiReferralLandingPaths, 10),
    samples,
  }
}

function busiestUnrecognizedAgents(buckets: Map<string, UnrecognizedAgentEventHourlyBucket>): UnrecognizedAgentEventHourlyBucket[] {
  const hitsByName = new Map<string, number>()
  for (const bucket of buckets.values()) hitsByName.set(bucket.agentName, (hitsByName.get(bucket.agentName) ?? 0) + bucket.hits)
  const kept = new Set(
    [...hitsByName.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_UNRECOGNIZED_AGENT_NAMES)
      .map(([name]) => name),
  )
  return [...buckets.values()]
    .filter((bucket) => kept.has(bucket.agentName))
    .sort((a, b) => a.tsHour.localeCompare(b.tsHour) || a.agentName.localeCompare(b.agentName))
}

function incrementBucket<T extends Record<string, string>>(
  map: Map<string, { fields: T; hits: number }>,
  key: string,
  fields: T,
): void {
  const existing = map.get(key)
  if (existing) existing.hits += 1
  else map.set(key, { fields, hits: 1 })
}
