import type { NormalizedTrafficRequest } from '@ainyc/canonry-contracts'
import { classifyAiReferral, classifyCrawler } from './classifier.js'
import type {
  AiReferralEventHourlyBucket,
  BuildTrafficProbeReportOptions,
  CrawlerEventHourlyBucket,
  TrafficProbeReport,
} from './types.js'

const DEFAULT_SAMPLE_LIMIT = 25
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LONG_HEX_SEGMENT = /^[0-9a-f]{16,}$/i
const NUMERIC_SEGMENT = /^\d+$/

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

function sortCrawlerBuckets(a: CrawlerEventHourlyBucket, b: CrawlerEventHourlyBucket): number {
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
  const crawlerBuckets = new Map<string, CrawlerEventHourlyBucket>()
  const aiReferralBuckets = new Map<string, AiReferralEventHourlyBucket>()
  const topBots = new Map<string, { fields: { botId: string; operator: string }; hits: number }>()
  const topCrawlerPaths = new Map<string, { fields: { pathNormalized: string }; hits: number }>()
  const topAiReferrers = new Map<string, { fields: { sourceDomain: string; product: string }; hits: number }>()
  const topAiReferralLandingPaths = new Map<string, { fields: { landingPathNormalized: string }; hits: number }>()

  let crawlerHits = 0
  let aiReferralHits = 0
  let unknownHits = 0
  const samples: TrafficProbeReport['samples'] = []

  for (const event of events) {
    const tsHour = hourBucket(event.observedAt)
    const pathNormalized = normalizeTrafficPathPattern(event.path)
    const crawler = classifyCrawler(event)
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

    if (aiReferral) {
      aiReferralHits += 1
      const key = [
        tsHour,
        aiReferral.product,
        aiReferral.sourceDomain,
        aiReferral.evidenceType,
        pathNormalized,
        event.status ?? 'null',
      ].join('\t')
      const existing = aiReferralBuckets.get(key)
      if (existing) {
        existing.hits += 1
      } else {
        aiReferralBuckets.set(key, {
          tsHour,
          operator: aiReferral.operator,
          product: aiReferral.product,
          sourceDomain: aiReferral.sourceDomain,
          evidenceType: aiReferral.evidenceType,
          landingPathNormalized: pathNormalized,
          status: event.status,
          hits: 1,
        })
      }
      incrementBucket(topAiReferrers, aiReferral.sourceDomain, {
        sourceDomain: aiReferral.sourceDomain,
        product: aiReferral.product,
      })
      incrementBucket(topAiReferralLandingPaths, pathNormalized, { landingPathNormalized: pathNormalized })
    }

    if (!crawler && !aiReferral) unknownHits += 1

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
      aiReferral,
    })
    if (samples.length > sampleLimit) samples.shift()
  }

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    totals: {
      normalizedEvents: events.length,
      crawlerHits,
      aiReferralHits,
      unknownHits,
    },
    crawlerEventsHourly: [...crawlerBuckets.values()].sort(sortCrawlerBuckets),
    aiReferralEventsHourly: [...aiReferralBuckets.values()].sort(sortReferralBuckets),
    topBots: topEntries(topBots, 10),
    topCrawlerPaths: topEntries(topCrawlerPaths, 10),
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
