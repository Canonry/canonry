import type { NormalizedTrafficRequest } from '@ainyc/canonry-contracts'
import { classifyAiReferral, classifyAiUserFetch, classifyCrawler } from './classifier.js'
import type {
  AiReferralEventHourlyBucket,
  AiReferralEvidenceType,
  AiUserFetchEventHourlyBucket,
  BuildTrafficProbeReportOptions,
  ClassifiedAiReferral,
  CrawlerEventHourlyBucket,
  TrafficProbeReport,
} from './types.js'

const DEFAULT_SAMPLE_LIMIT = 25
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

function normalizeHost(host: string | null): string | null {
  if (!host) return null
  return host.trim().toLowerCase().replace(/^www\./, '') || null
}

function sameHost(a: string | null, b: string | null): boolean {
  const normalizedA = normalizeHost(a)
  const normalizedB = normalizeHost(b)
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

function actorKey(event: NormalizedTrafficRequest): string {
  const remoteIp = event.remoteIp?.trim()
  const userAgent = event.userAgent?.trim()
  if (remoteIp || userAgent) return `${remoteIp ?? 'unknown-ip'}\t${userAgent ?? 'unknown-ua'}`
  return `event:${event.eventId}`
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

function strongerReferralEvidence(
  current: AiReferralSession,
  next: AiReferralSession,
): AiReferralSession {
  return evidenceRank(next.evidenceType) > evidenceRank(current.evidenceType) ? next : current
}

function sortCrawlerBuckets(a: CrawlerEventHourlyBucket, b: CrawlerEventHourlyBucket): number {
  return a.tsHour.localeCompare(b.tsHour) ||
    a.botId.localeCompare(b.botId) ||
    a.pathNormalized.localeCompare(b.pathNormalized) ||
    String(a.status).localeCompare(String(b.status))
}

function sortAiUserFetchBuckets(a: AiUserFetchEventHourlyBucket, b: AiUserFetchEventHourlyBucket): number {
  return a.tsHour.localeCompare(b.tsHour) ||
    a.botId.localeCompare(b.botId) ||
    a.pathNormalized.localeCompare(b.pathNormalized) ||
    String(a.status).localeCompare(String(b.status))
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
  const aiReferralBuckets = new Map<string, AiReferralEventHourlyBucket>()
  const aiReferralSessions = new Map<string, AiReferralSession>()
  const topBots = new Map<string, { fields: { botId: string; operator: string }; hits: number }>()
  const topCrawlerPaths = new Map<string, { fields: { pathNormalized: string }; hits: number }>()
  const topAiUserFetchBots = new Map<string, { fields: { botId: string; operator: string }; hits: number }>()
  const topAiUserFetchPaths = new Map<string, { fields: { pathNormalized: string }; hits: number }>()
  const topAiReferrers = new Map<string, { fields: { sourceDomain: string; product: string }; hits: number }>()
  const topAiReferralLandingPaths = new Map<string, { fields: { landingPathNormalized: string }; hits: number }>()

  let crawlerHits = 0
  let aiUserFetchHits = 0
  let aiReferralHits = 0
  let unknownHits = 0
  const samples: TrafficProbeReport['samples'] = []

  for (const event of events) {
    const tsHour = hourBucket(event.observedAt)
    const pathNormalized = normalizeTrafficPathPattern(event.path)
    const crawler = classifyCrawler(event)
    const aiUserFetch = classifyAiUserFetch(event)
    const aiReferral = classifyAiReferral(event)

    if (crawler) {
      crawlerHits += 1
      const key = [
        tsHour,
        crawler.botId,
        crawler.verificationStatus,
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

    if (aiUserFetch) {
      aiUserFetchHits += 1
      const key = [
        tsHour,
        aiUserFetch.botId,
        aiUserFetch.verificationStatus,
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
      if (!isLikelySubresourcePath(landingPathNormalized)) {
        const session: AiReferralSession = {
          tsHour,
          operator: aiReferral.operator,
          product: aiReferral.product,
          sourceDomain: aiReferral.sourceDomain,
          evidenceType: aiReferral.evidenceType,
          landingPathNormalized,
          status: event.status,
        }
        const key = aiReferralSessionKey(event, aiReferral, landingPathNormalized, aiReferralSessionWindowMs)
        const existing = aiReferralSessions.get(key)
        aiReferralSessions.set(key, existing ? strongerReferralEvidence(existing, session) : session)
      }
    }

    if (!crawler && !aiUserFetch && !aiReferral) unknownHits += 1

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
    const existing = aiReferralBuckets.get(key)
    if (existing) {
      existing.hits += 1
    } else {
      aiReferralBuckets.set(key, {
        ...session,
        hits: 1,
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
      normalizedEvents: events.length,
      crawlerHits,
      aiUserFetchHits,
      aiReferralSessions: aiReferralSessions.size,
      aiReferralHits,
      unknownHits,
    },
    crawlerEventsHourly: [...crawlerBuckets.values()].sort(sortCrawlerBuckets),
    aiUserFetchEventsHourly: [...aiUserFetchBuckets.values()].sort(sortAiUserFetchBuckets),
    aiReferralEventsHourly: [...aiReferralBuckets.values()].sort(sortReferralBuckets),
    topBots: topEntries(topBots, 10),
    topCrawlerPaths: topEntries(topCrawlerPaths, 10),
    topAiUserFetchBots: topEntries(topAiUserFetchBots, 10),
    topAiUserFetchPaths: topEntries(topAiUserFetchPaths, 10),
    topAiReferrers: topEntries(topAiReferrers, 10),
    topAiReferralLandingPaths: topEntries(topAiReferralLandingPaths, 10),
    samples,
  }
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
