import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aiReferralEventsHourly, aiReferralVisitors, createClient, migrate, projects, trafficSources } from '@canonry/canonry-db'
import { TrafficEventConfidences, TrafficEvidenceKinds, TrafficSourceTypes, type NormalizedTrafficRequest } from '@canonry/canonry-contracts'
import { MAX_STORED_AI_REFERRAL_ARRIVALS, mergeAiReferralArrivals, saveAiReferralArrivals } from '../src/ai-referral-arrivals.js'
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

  it('counts a visit once when a later request reaches ingest before its landing', () => {
    // Concurrent one-event pushes can commit out of order: the page's script lands first and stands in for it.
    expect(push([event('script-first', 0.4, { path: '/assets/app.js', referer: LANDING })])).toMatchObject({ aiReferralBucketRows: 1 })
    expect(push([event('landing-later', 0, { path: '/products/linen-shirt', queryString: 'utm_source=chatgpt.com' })]))
      .toMatchObject({ aiReferralHits: 1, aiReferralBucketRows: 0 })
    push([event('api', 75, { method: 'POST', path: '/api/storefront', referer: LANDING })])

    expect(arrivals()).toEqual([
      { evidenceType: 'referer-utm', landingPathNormalized: '/products/linen-shirt', sessionsOrHits: 1 },
    ])
  })

  it('covers a delayed request with an older stored arrival, after a newer arrival was stored', () => {
    const day = 86_400
    push([event('first-click', 0, { path: '/products/linen-shirt', queryString: 'utm_source=chatgpt.com' })])
    push([event('second-click', 2 * day, { path: '/collections/sale', referer: 'https://chatgpt.com/' })])
    // A request from the first visit that waited in a Queue, or a backfill reading that day.
    expect(push([event('delayed-step', 3600, { path: '/collections/denim', referer: LANDING })]))
      .toMatchObject({ aiReferralHits: 1, aiReferralBucketRows: 0 })

    expect(arrivals()).toEqual([
      { evidenceType: 'referer', landingPathNormalized: '/collections/sale', sessionsOrHits: 1 },
      { evidenceType: 'utm', landingPathNormalized: '/products/linen-shirt', sessionsOrHits: 1 },
    ])
    const [visitor] = db.select().from(aiReferralVisitors).all()
    expect(visitor?.arrivals).toEqual([{ at: at(0), standIn: false }, { at: at(2 * day), standIn: false }])
  })

  it('adds a batch\'s arrivals to the stored list and drops visitors past the lookback and Queue retention', () => {
    const save = (arrivals: Array<{ at: number, standIn: boolean }>, now = NOW) => saveAiReferralArrivals(db, {
      projectId: 'project', sourceId: 'source', now, arrivals: new Map([['visitor', arrivals]]),
    })
    const stored = () => db.select({ arrivals: aiReferralVisitors.arrivals, lastArrivalAt: aiReferralVisitors.lastArrivalAt }).from(aiReferralVisitors).all()
    save([{ at: Date.parse(at(0)), standIn: true }])
    // An older batch (a backfill) adds its arrival without moving the latest one back.
    save([{ at: Date.parse(at(-3600)), standIn: false }])
    // The same instant seen again from outside outranks the stand-in.
    save([{ at: Date.parse(at(0)), standIn: false }])
    expect(stored()).toEqual([{ arrivals: [{ at: at(-3600), standIn: false }, { at: at(0), standIn: false }], lastArrivalAt: at(0) }])
    save([{ at: Date.parse(at(60)), standIn: false }])
    expect(stored()[0]?.lastArrivalAt).toBe(at(60))
    saveAiReferralArrivals(db, { projectId: 'project', sourceId: 'source', arrivals: new Map(), now: at(60 + 43 * 86_400) })
    expect(stored()).toHaveLength(1)
    saveAiReferralArrivals(db, { projectId: 'project', sourceId: 'source', arrivals: new Map(), now: at(61 + 44 * 86_400) })
    expect(stored()).toEqual([])
  })

  it('keeps at most the newest arrivals per visitor and drops expired ones when merging', () => {
    const minute = 60_000
    const many = Array.from({ length: MAX_STORED_AI_REFERRAL_ARRIVALS + 5 }, (_, i) => ({ at: i * minute, standIn: false }))
    const merged = mergeAiReferralArrivals(many.slice(0, 30), many.slice(30), 2 * minute)
    expect(merged).toHaveLength(MAX_STORED_AI_REFERRAL_ARRIVALS)
    expect(merged[0]).toEqual({ at: 5 * minute, standIn: false })
    expect(merged.at(-1)).toEqual({ at: (MAX_STORED_AI_REFERRAL_ARRIVALS + 4) * minute, standIn: false })
    expect(mergeAiReferralArrivals([{ at: minute, standIn: true }], [], 2 * minute)).toEqual([])
  })
})
