import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { asc, eq } from 'drizzle-orm'
import { createClient, journeyEvents, journeyVisitorAliases, journeyVisitors, journeyVisits, migrate, projects, trafficSources } from '@canonry/canonry-db'
import { TrafficSourceTypes } from '@canonry/canonry-contracts'
import { mergeSplitJourneyVisitors } from '../src/journey-corrections.js'

const NOW = '2026-11-01T05:00:00.000Z'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
const TAGGED = '/collections/best-deals?utm_source=chatgpt.com'
const AI_ENTRY = { entryClass: 'ai', entryName: 'ChatGPT', entryHost: 'chatgpt.com', paid: false }

type Step = [ts: string, path: string, kind: 'page' | 'data', aiTouch: boolean]

describe('mergeSplitJourneyVisitors', () => {
  let db: ReturnType<typeof createClient>
  let n = 0

  function visitor(visitorKey: string, userAgent: string, visits: Array<[id: string, steps: Step[]]>, keyBasis = 'ip-ua'): void {
    const all = visits.flatMap(([, steps]) => steps)
    const touches = all.filter(step => step[3]).map(step => step[0]).sort()
    db.insert(journeyVisitors).values({
      projectId: 'project', visitorKey, keyBasis, userAgent, firstAiAt: touches[0]!, firstAiEngine: 'ChatGPT', lastAiAt: touches.at(-1)!,
      lastSeenAt: all.map(step => step[0]).sort().at(-1)!, cappedDays: [], createdAt: NOW, updatedAt: NOW,
    }).run()
    for (const [id, steps] of visits) {
      db.insert(journeyVisits).values({
        id, projectId: 'project', visitorKey, sourceId: 'source', startedAt: steps[0]![0], endedAt: steps.at(-1)![0], ...AI_ENTRY,
        landingPath: steps[0]![1], requestCount: steps.length, pageCount: steps.filter(step => step[2] === 'page').length, createdAt: NOW, updatedAt: NOW,
      }).run()
      for (const [ts, path, kind, aiTouch] of steps) {
        db.insert(journeyEvents).values({ id: `e${++n}`, projectId: 'project', visitId: id, sourceId: 'source', sourceEventId: `s${n}`, ts, method: 'GET', path, status: 200, kind, aiTouch, createdAt: NOW }).run()
      }
    }
  }
  const visitsOf = (visitorKey: string) => db.select({ id: journeyVisits.id, startedAt: journeyVisits.startedAt, endedAt: journeyVisits.endedAt, requestCount: journeyVisits.requestCount, pageCount: journeyVisits.pageCount })
    .from(journeyVisits).where(eq(journeyVisits.visitorKey, visitorKey)).orderBy(asc(journeyVisits.startedAt)).all()
  const visitorKeys = () => db.select({ visitorKey: journeyVisitors.visitorKey }).from(journeyVisitors).all().map(row => row.visitorKey).sort()

  beforeEach(() => {
    db = createClient(':memory:')
    migrate(db)
    db.insert(projects).values({ id: 'project', name: 'example', displayName: 'Example', canonicalDomain: 'https://example.com', country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW }).run()
    db.insert(trafficSources).values({ id: 'source', projectId: 'project', sourceType: TrafficSourceTypes.cloudflare, displayName: 'source', status: 'connected', createdAt: NOW, updatedAt: NOW }).run()

    // One phone: it arrived at 09:51 and again at 09:55, and iCloud Private Relay
    // sent the reload 3 seconds later from a new address.
    visitor('a', IPHONE, [
      ['a-1', [['2026-10-29T09:51:54.000Z', TAGGED, 'page', true]]],
      ['a-2', [['2026-10-29T09:55:20.467Z', TAGGED, 'page', true], ['2026-10-29T09:55:21.733Z', '/api/shopify', 'data', false]]],
    ])
    visitor('b', IPHONE, [
      ['b-1', [['2026-10-29T09:55:23.476Z', TAGGED, 'page', true], ['2026-10-29T09:56:54.000Z', '/api/shopify', 'data', false]]],
    ])
    // Kept apart: another browser; the same browser 9 seconds after the reload;
    // an address with its own earlier visit; a browser-only key.
    visitor('c', MAC, [['c-1', [['2026-10-29T09:55:22.000Z', TAGGED, 'page', true]]]])
    visitor('d', IPHONE, [['d-1', [['2026-10-29T09:55:32.500Z', TAGGED, 'page', true]]]])
    visitor('e', IPHONE, [
      ['e-1', [['2026-10-28T09:00:00.000Z', '/?utm_source=chatgpt.com', 'page', true]]],
      ['e-2', [['2026-10-29T09:55:21.000Z', TAGGED, 'page', false]]],
    ])
    visitor('f', IPHONE, [['f-1', [['2026-10-29T09:55:22.500Z', TAGGED, 'page', true]]]], 'ua')
  })
  afterEach(() => db.$client.close())

  it('previews, then joins a visitor seen from a second IP to the first, its visit to the visit it continued', () => {
    const before = JSON.stringify(db.select().from(journeyEvents).all())
    expect(mergeSplitJourneyVisitors(db, { dryRun: true, now: NOW })).toEqual({ visitorsMerged: 1, visitsJoined: 0 })
    expect(JSON.stringify(db.select().from(journeyEvents).all())).toBe(before)

    expect(mergeSplitJourneyVisitors(db, { dryRun: false, now: NOW })).toEqual({ visitorsMerged: 1, visitsJoined: 1 })
    expect(visitorKeys()).toEqual(['a', 'c', 'd', 'e', 'f'])
    expect(visitsOf('a')).toEqual([
      { id: 'a-1', startedAt: '2026-10-29T09:51:54.000Z', endedAt: '2026-10-29T09:51:54.000Z', requestCount: 1, pageCount: 1 },
      { id: 'a-2', startedAt: '2026-10-29T09:55:20.467Z', endedAt: '2026-10-29T09:56:54.000Z', requestCount: 4, pageCount: 2 },
    ])
    expect(db.select().from(journeyVisitors).where(eq(journeyVisitors.visitorKey, 'a')).get())
      .toMatchObject({ firstAiAt: '2026-10-29T09:51:54.000Z', lastAiAt: '2026-10-29T09:55:23.476Z', lastSeenAt: '2026-10-29T09:56:54.000Z', updatedAt: NOW })
    expect(db.select({ aliasKey: journeyVisitorAliases.aliasKey, visitorKey: journeyVisitorAliases.visitorKey }).from(journeyVisitorAliases).all()).toEqual([{ aliasKey: 'b', visitorKey: 'a' }])

    // Nothing is left to join.
    expect(mergeSplitJourneyVisitors(db, { dryRun: false, now: NOW })).toEqual({ visitorsMerged: 0, visitsJoined: 0 })
  })

  it('limits the merge to the given projects', () => {
    expect(mergeSplitJourneyVisitors(db, { projectIds: ['other'], dryRun: false, now: NOW })).toEqual({ visitorsMerged: 0, visitsJoined: 0 })
    expect(visitorKeys()).toContain('b')
  })
})
