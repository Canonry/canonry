import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aiReferralEventsHourly, aiReferralVisitors, createClient, migrate, projects, trafficSources } from '@canonry/canonry-db'
import { TrafficEventConfidences, TrafficEvidenceKinds, TrafficSourceTypes, type NormalizedTrafficRequest } from '@canonry/canonry-contracts'
import { saveAiReferralArrivals } from '../src/ai-referral-arrivals.js'
import { writeTrafficEventBatch } from '../src/traffic-event-ingest.js'

const NOW = '2026-10-28T14:00:00.000Z'
const SECRET = 'ai-referral-arrival-secret-used-only-in-tests'
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1'
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'
// RFC 5737 documentation space.
const PHONE_IP = '198.51.100.23'
const LAPTOP_IP = '203.0.113.41'
const LANDING = 'https://www.example.com/products/linen-shirt?utm_source=chatgpt.com'
const CACHED_LANDING = 'https://www.example.com/?utm_source=chatgpt.com'
const at = (seconds: number) => new Date(Date.parse(NOW) + seconds * 1000).toISOString()

function event(id: string, seconds: number, overrides: Partial<NormalizedTrafficRequest> = {}): NormalizedTrafficRequest {
  return {
    sourceType: TrafficSourceTypes.cloudflare, evidenceKind: TrafficEvidenceKinds['raw-request'], confidence: TrafficEventConfidences.observed,
    eventId: id, observedAt: at(seconds), method: 'GET', requestUrl: null, host: 'www.example.com', path: '/',
    queryString: null, status: 200, userAgent: IPHONE_SAFARI, remoteIp: PHONE_IP, referer: null,
    latencyMs: null, requestSizeBytes: null, responseSizeBytes: null, providerResource: { type: 'cloudflare_worker', labels: {} }, providerLabels: {}, ...overrides,
  }
}

describe('AI referral arrivals at ingest', () => {
  let db: ReturnType<typeof createClient>
  // One push per request, as a Cloudflare Worker delivers them.
  const push = (events: NormalizedTrafficRequest[], options: { withSecret?: boolean } = {}) => writeTrafficEventBatch({
    db, projectId: 'project', sourceId: 'source', events, receivedAt: events[0]!.observedAt,
    receiptTtlMs: 600_000, sampleLimit: 100, sourceUpdate: { lastSyncedAt: events[0]!.observedAt },
    journeyKeySecret: options.withSecret === false ? undefined : SECRET,
    validateSource: () => {},
  })
  const arrivals = () => db.select({
    evidenceType: aiReferralEventsHourly.evidenceType,
    landingPathNormalized: aiReferralEventsHourly.landingPathNormalized,
    sessionsOrHits: aiReferralEventsHourly.sessionsOrHits,
  }).from(aiReferralEventsHourly).orderBy(aiReferralEventsHourly.landingPathNormalized, aiReferralEventsHourly.evidenceType).all()

  beforeEach(() => {
    db = createClient(':memory:')
    migrate(db)
    db.insert(projects).values({ id: 'project', name: 'example', displayName: 'Example', canonicalDomain: 'https://example.com', country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW }).run()
    db.insert(trafficSources).values({ id: 'source', projectId: 'project', sourceType: TrafficSourceTypes.cloudflare, displayName: 'source', status: 'connected', createdAt: NOW, updatedAt: NOW }).run()
  })
  afterEach(() => db.$client.close())

  it('counts a visit once when its later requests arrive in later pushes', () => {
    push([event('landing', 0, { path: '/products/linen-shirt', queryString: 'utm_source=chatgpt.com' })])
    push([event('api', 75, { method: 'POST', path: '/api/storefront', referer: LANDING })])
    push([event('next-page', 420, { path: '/collections/sale', referer: LANDING })])
    // A page cache served this visitor's landing page: its first request that reached the logs stands for it.
    push([event('cached-script', 30, { userAgent: MAC_CHROME, remoteIp: LAPTOP_IP, path: '/_next/static/chunks/app.js', referer: CACHED_LANDING })])
    expect(push([event('cached-api', 150, { userAgent: MAC_CHROME, remoteIp: LAPTOP_IP, path: '/api/cart', referer: CACHED_LANDING })]))
      .toMatchObject({ aiReferralHits: 1, aiReferralBucketRows: 0 })

    expect(arrivals()).toEqual([
      { evidenceType: 'referer-utm', landingPathNormalized: '/', sessionsOrHits: 1 },
      { evidenceType: 'utm', landingPathNormalized: '/products/linen-shirt', sessionsOrHits: 1 },
    ])
    // Visitors are keyed hashes: no address or user agent is stored.
    const visitors = db.select().from(aiReferralVisitors).orderBy(aiReferralVisitors.lastArrivalAt).all()
    expect(visitors.map(visitor => visitor.lastArrivalAt)).toEqual([at(0), at(30)])
    expect(visitors.every(visitor => /^[0-9a-f]{64}$/.test(visitor.visitorKey))).toBe(true)
    expect(JSON.stringify(visitors)).not.toMatch(/198\.51\.100\.23|203\.0\.113\.41|Mozilla/)
  })

  it('finds later requests within a batch without the install secret, and stores nothing', () => {
    push([
      event('landing', 0, { path: '/products/linen-shirt', queryString: 'utm_source=chatgpt.com' }),
      event('api', 75, { path: '/api/storefront', referer: LANDING }),
    ], { withSecret: false })
    expect(db.select().from(aiReferralVisitors).all()).toEqual([])
    // Nothing carries over to the next push.
    push([event('next-page', 420, { path: '/collections/sale', referer: LANDING })], { withSecret: false })
    expect(arrivals()).toEqual([
      { evidenceType: 'referer-utm', landingPathNormalized: '/products/linen-shirt', sessionsOrHits: 1 },
      { evidenceType: 'utm', landingPathNormalized: '/products/linen-shirt', sessionsOrHits: 1 },
    ])
  })

  it('keeps each visitor\'s latest arrival and drops arrivals past the lookback and Queue retention', () => {
    const save = (arrivedAt: string, now = NOW) => saveAiReferralArrivals(db, {
      projectId: 'project', sourceId: 'source', now, arrivals: new Map([['visitor', Date.parse(arrivedAt)]]),
    })
    const stored = () => db.select({ lastArrivalAt: aiReferralVisitors.lastArrivalAt }).from(aiReferralVisitors).all()
    save(at(0))
    // An older arrival, as a backfill finds, never replaces it.
    save(at(-3600))
    expect(stored()).toEqual([{ lastArrivalAt: at(0) }])
    save(at(60))
    expect(stored()).toEqual([{ lastArrivalAt: at(60) }])
    saveAiReferralArrivals(db, { projectId: 'project', sourceId: 'source', arrivals: new Map(), now: at(60 + 43 * 86_400) })
    expect(stored()).toEqual([{ lastArrivalAt: at(60) }])
    saveAiReferralArrivals(db, { projectId: 'project', sourceId: 'source', arrivals: new Map(), now: at(61 + 44 * 86_400) })
    expect(stored()).toEqual([])
  })
})
