import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { apiKeys, createClient, journeyEvents, journeyVisitors, journeyVisits, migrate, projects, trafficSources } from '@canonry/canonry-db'
import type { NormalizedTrafficRequest } from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { enforceJourneyRetention, journeyVisitorKey, persistJourneyBatch } from '../src/journeys.js'

const SECRET = 'journey-test-secret-at-least-32-characters'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1'
const NOW = '2026-10-24T12:00:00.000Z'
const created = '2026-10-01T00:00:00.000Z'

function event(id: string, at: string, overrides: Partial<NormalizedTrafficRequest> = {}): NormalizedTrafficRequest {
  return {
    sourceType: 'vercel',
    evidenceKind: 'raw-request',
    confidence: 'observed',
    eventId: id,
    observedAt: at,
    method: 'GET',
    requestUrl: `https://example.com${overrides.path ?? '/'}`,
    host: 'example.com',
    path: '/',
    queryString: null,
    status: 200,
    userAgent: MAC,
    remoteIp: null,
    referer: null,
    latencyMs: null,
    requestSizeBytes: null,
    responseSizeBytes: null,
    providerResource: null,
    providerLabels: {},
    ...overrides,
  }
}

const chatgpt = { referer: 'https://chatgpt.com/', queryString: 'utm_source=chatgpt.com' }
const perplexity = { referer: 'https://www.perplexity.ai/' }

describe('AI visitor journeys', () => {
  let db: ReturnType<typeof createClient>
  let app: ReturnType<typeof Fastify>
  const persist = (events: NormalizedTrafficRequest[], opts: { projectId?: string; sourceId?: string; secret?: string; now?: string } = {}) =>
    persistJourneyBatch(db, {
      projectId: opts.projectId ?? 'project',
      sourceId: opts.sourceId ?? 'source',
      events,
      secret: 'secret' in opts ? opts.secret : SECRET,
      now: opts.now ?? NOW,
    })

  beforeEach(async () => {
    db = createClient(':memory:')
    migrate(db)
    for (const [id, name, sourceId] of [['project', 'example', 'source'], ['other', 'other', 'foreign']] as const) {
      db.insert(projects).values({ id, name, displayName: name, canonicalDomain: `${name}.com`, country: 'US', language: 'en', createdAt: created, updatedAt: created }).run()
      db.insert(trafficSources).values({ id: sourceId, projectId: id, sourceType: 'vercel', displayName: 'Logs', status: 'connected', createdAt: created, updatedAt: created }).run()
    }
    app = Fastify()
    await app.register(apiRoutes, { db, skipAuth: true })
    await app.ready()
  })
  afterEach(async () => { await app.close(); db.$client.close() })

  describe('visitor keys', () => {
    it('are keyed per project and say what they are based on', () => {
      const a = journeyVisitorKey(SECRET, 'project', '198.51.100.7', MAC)
      expect(a).toMatchObject({ keyBasis: 'ip-ua' })
      expect(a.visitorKey).toMatch(/^[0-9a-f]{32}$/)
      expect(journeyVisitorKey(SECRET, 'project', '198.51.100.7', MAC)).toEqual(a)
      expect(journeyVisitorKey(SECRET, 'other', '198.51.100.7', MAC).visitorKey).not.toBe(a.visitorKey)
      expect(journeyVisitorKey('another-secret-that-is-32-characters!', 'project', '198.51.100.7', MAC).visitorKey).not.toBe(a.visitorKey)
      expect(journeyVisitorKey(SECRET, 'project', null, MAC)).toMatchObject({ keyBasis: 'ua' })
    })
  })

  describe('persistJourneyBatch', () => {
    it('writes nothing without a secret', () => {
      expect(persist([event('a', '2026-10-20T10:00:00Z', chatgpt)], { secret: undefined })).toEqual({ visitsWritten: 0, eventsStored: 0 })
      expect(db.select().from(journeyVisitors).all()).toEqual([])
    })

    it('is idempotent across repeated and overlapping batches', () => {
      const batch = [
        event('a', '2026-10-20T10:00:00Z', chatgpt),
        event('b', '2026-10-20T10:01:00Z', { path: '/rooms', referer: 'https://example.com/' }),
      ]
      expect(persist(batch)).toEqual({ visitsWritten: 1, eventsStored: 2 })
      expect(persist(batch)).toEqual({ visitsWritten: 0, eventsStored: 0 })
      expect(persist([...batch, event('c', '2026-10-20T10:03:00Z', { path: '/book', referer: 'https://example.com/rooms' })])).toEqual({ visitsWritten: 1, eventsStored: 1 })
      expect(db.select().from(journeyEvents).all()).toHaveLength(3)
      expect(db.select().from(journeyVisits).all()).toMatchObject([{ entryClass: 'ai', entryName: 'ChatGPT', requestCount: 3, pageCount: 3, landingPath: '/?utm_source=chatgpt.com', endedAt: '2026-10-20T10:03:00.000Z' }])
      expect(db.select().from(journeyVisitors).all()).toMatchObject([{ keyBasis: 'ua', firstAiAt: '2026-10-20T10:00:00.000Z', lastSeenAt: '2026-10-20T10:03:00.000Z' }])
    })

    it('widens visitor bounds when a backfill finds an earlier AI visit', () => {
      persist([event('late', '2026-10-20T10:00:00Z', chatgpt)])
      persist([event('early', '2026-10-05T10:00:00Z', perplexity)])
      expect(db.select().from(journeyVisitors).get()).toMatchObject({ firstAiAt: '2026-10-05T10:00:00.000Z', firstAiEngine: 'Perplexity', lastAiAt: '2026-10-20T10:00:00.000Z', lastSeenAt: '2026-10-20T10:00:00.000Z' })
    })

    it('skips requests past retention and retention deletes old rows', () => {
      expect(persist([event('old', '2026-03-01T10:00:00Z', chatgpt)])).toEqual({ visitsWritten: 0, eventsStored: 0 })
      persist([event('a', '2026-04-01T10:00:00Z', chatgpt)], { now: '2026-04-02T00:00:00Z' })
      persist([event('b', '2026-10-20T10:00:00Z', { ...chatgpt, userAgent: IPHONE })])
      enforceJourneyRetention(db, NOW)
      expect(db.select().from(journeyEvents).all().map(e => e.sourceEventId)).toEqual(['b'])
      expect(db.select().from(journeyVisits).all()).toHaveLength(1)
      expect(db.select().from(journeyVisitors).all().map(v => v.userAgent)).toEqual([IPHONE])
    })

    it('retention also removes visitors whose visits went with a deleted source', async () => {
      persist([event('a', '2026-10-20T10:00:00Z', chatgpt)])
      db.delete(trafficSources).where(eq(trafficSources.id, 'source')).run()
      expect(db.select().from(journeyVisits).all()).toEqual([])
      expect((await app.inject({ method: 'GET', url: '/api/v1/projects/example/journeys/summary' })).json()).toMatchObject({ aiVisitors: 0 })
      expect((await app.inject({ method: 'GET', url: '/api/v1/projects/example/journeys' })).json()).toMatchObject({ totalVisitors: 0 })
      enforceJourneyRetention(db, NOW)
      expect(db.select().from(journeyVisitors).all()).toEqual([])
    })
  })

  describe('routes', () => {
    function seed() {
      // Mac: ChatGPT, came back from Google two days later.
      persist([
        event('m1', '2026-10-18T10:00:00Z', chatgpt),
        event('m2', '2026-10-18T10:02:00Z', { path: '/rooms', referer: 'https://example.com/' }),
        event('m3', '2026-10-18T10:03:00Z', { path: '/api/availability', method: 'POST', referer: 'https://example.com/rooms' }),
        event('m4', '2026-10-20T09:00:00Z', { path: '/book', referer: 'https://www.google.com/' }),
      ])
      // iPhone: Perplexity, never came back.
      persist([event('i1', '2026-10-21T08:00:00Z', { ...perplexity, userAgent: IPHONE })])
      // Another project's visitor stays out.
      persist([event('o1', '2026-10-21T08:00:00Z', chatgpt)], { projectId: 'other', sourceId: 'foreign' })
    }

    it('summarizes AI visitors and how they came back', async () => {
      seed()
      const res = await app.inject({ method: 'GET', url: `/api/v1/projects/example/journeys/summary?until=${NOW}` })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        project: 'example',
        windowStart: '2026-09-24T12:00:00.000Z',
        windowEnd: NOW,
        lookbackDays: 30,
        aiVisitors: 2,
        aiVisits: 2,
        returningVisitors: 1,
        returnRate: 0.5,
        returnedVia: { ai: 0, search: 1, social: 0, paid: 0, referral: 0, direct: 0 },
        medianDaysToReturn: 2,
        byEngine: [{ engine: 'ChatGPT', visitors: 1, returningVisitors: 1 }, { engine: 'Perplexity', visitors: 1, returningVisitors: 0 }],
        keyBasis: { ipUa: 0, ua: 2 },
      })
    })

    it('lists visitors newest first with filters and paging', async () => {
      seed()
      const list = (query: string) => app.inject({ method: 'GET', url: `/api/v1/projects/example/journeys?until=${NOW}&${query}` }).then(r => r.json())
      const all = await list('')
      expect(all).toMatchObject({ totalVisitors: 2, limit: 50, offset: 0, retentionDays: 180 })
      expect(all.visitors.map((v: { device: string }) => v.device)).toEqual(['iPhone · iOS 18.7 · Safari', 'Mac · Chrome 155'])
      const mac = all.visitors[1]
      expect(mac).toMatchObject({ firstAiEngine: 'ChatGPT', visitCount: 2, aiVisitCount: 1, returned: true, returnChannels: ['search'], userAgent: MAC })
      expect(mac.visits.map((v: { entryClass: string; requestCount: number; pageCount: number }) => [v.entryClass, v.requestCount, v.pageCount])).toEqual([['ai', 3, 2], ['search', 1, 1]])
      expect((await list('engine=chatgpt')).visitors).toHaveLength(1)
      expect((await list('returned=false')).visitors.map((v: { firstAiEngine: string }) => v.firstAiEngine)).toEqual(['Perplexity'])
      const page = await list('limit=1&offset=1')
      expect(page).toMatchObject({ totalVisitors: 2, limit: 1, offset: 1 })
      expect(page.visitors.map((v: { firstAiEngine: string }) => v.firstAiEngine)).toEqual(['ChatGPT'])
      expect((await app.inject({ method: 'GET', url: '/api/v1/projects/example/journeys?limit=500' })).statusCode).toBe(400)
      expect((await app.inject({ method: 'GET', url: '/api/v1/projects/example/journeys?since=2026-10-24&until=2026-10-01' })).statusCode).toBe(400)
    })

    it('returns every visit and request for one visitor, and 404 for another project\'s key', async () => {
      seed()
      const key = journeyVisitorKey(SECRET, 'project', null, MAC).visitorKey
      const res = await app.inject({ method: 'GET', url: `/api/v1/projects/example/journeys/${key}` })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.visitor).toMatchObject({ visitorKey: key, keyBasis: 'ua', device: 'Mac · Chrome 155' })
      expect(body.visits[0].events).toEqual([
        { ts: '2026-10-18T10:00:00.000Z', method: 'GET', path: '/?utm_source=chatgpt.com', status: 200, kind: 'page' },
        { ts: '2026-10-18T10:02:00.000Z', method: 'GET', path: '/rooms', status: 200, kind: 'page' },
        { ts: '2026-10-18T10:03:00.000Z', method: 'POST', path: '/api/availability', status: 200, kind: 'data' },
      ])
      const otherKey = journeyVisitorKey(SECRET, 'other', null, MAC).visitorKey
      expect((await app.inject({ method: 'GET', url: `/api/v1/projects/example/journeys/${otherKey}` })).statusCode).toBe(404)
    })

    it('denies viewers and keys scoped to another project', async () => {
      seed()
      for (const [name, projectId] of [['read', null], ['scoped', 'other']] as const) {
        db.insert(apiKeys).values({ id: name, name, keyHash: hashApiKey(`cnry_journeys_${name}`), keyPrefix: 'cnry_', scopes: ['read'], projectId, createdAt: created }).run()
      }
      const secured = Fastify()
      await secured.register(apiRoutes, { db })
      await secured.ready()
      try {
        const url = '/api/v1/projects/example/journeys'
        expect((await secured.inject({ method: 'GET', url, headers: { authorization: 'Bearer cnry_journeys_read' } })).statusCode).toBe(200)
        expect((await secured.inject({ method: 'GET', url, headers: { authorization: 'Bearer cnry_journeys_scoped' } })).statusCode).toBe(403)
        expect((await secured.inject({ method: 'GET', url })).statusCode).toBe(401)
      } finally {
        await secured.close()
      }
    })
  })
})
