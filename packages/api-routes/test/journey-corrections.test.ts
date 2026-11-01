import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { asc, eq } from 'drizzle-orm'
import { createClient, journeyEvents, journeyVisitors, journeyVisits, migrate, projects, trafficSources } from '@canonry/canonry-db'
import { TrafficSourceTypes } from '@canonry/canonry-contracts'
import { correctBackgroundCallJourneys } from '../src/journey-corrections.js'

const NOW = '2026-11-01T05:00:00.000Z'
const DAY = 86_400_000
const T0 = Date.parse('2026-10-20T10:00:00.000Z')
const at = (ms: number) => new Date(T0 + ms).toISOString()
const AI_ENTRY = { entryClass: 'ai', entryName: 'ChatGPT', entryHost: 'chatgpt.com', paid: false }
const DIRECT_ENTRY = { entryClass: 'direct', entryName: null, entryHost: null, paid: false }

type Step = [ms: number, path: string, kind: 'page' | 'data', aiTouch: boolean]

describe('correctBackgroundCallJourneys', () => {
  let db: ReturnType<typeof createClient>
  let n = 0

  function visit(visitorKey: string, id: string, entry: typeof AI_ENTRY | typeof DIRECT_ENTRY, steps: Step[]): void {
    db.insert(journeyVisits).values({
      id, projectId: 'project', visitorKey, sourceId: 'source', startedAt: at(steps[0]![0]), endedAt: at(steps.at(-1)![0]),
      ...entry, landingPath: steps[0]![1], requestCount: steps.length, pageCount: steps.filter(step => step[2] === 'page').length,
      createdAt: NOW, updatedAt: NOW,
    }).run()
    for (const [ms, path, kind, aiTouch] of steps) {
      db.insert(journeyEvents).values({ id: `e${++n}`, projectId: 'project', visitId: id, sourceId: 'source', sourceEventId: `s${n}`, ts: at(ms), method: kind === 'data' ? 'POST' : 'GET', path, status: 200, kind, aiTouch, createdAt: NOW }).run()
    }
  }
  function visitor(visitorKey: string, firstAiMs: number, lastAiMs = firstAiMs): void {
    db.insert(journeyVisitors).values({ projectId: 'project', visitorKey, keyBasis: 'ip-ua', userAgent: 'Browser', firstAiAt: at(firstAiMs), firstAiEngine: 'ChatGPT', lastAiAt: at(lastAiMs), lastSeenAt: at(lastAiMs), createdAt: NOW, updatedAt: NOW }).run()
  }
  const visitsOf = (visitorKey: string) => db.select({ id: journeyVisits.id, landingPath: journeyVisits.landingPath, startedAt: journeyVisits.startedAt, requestCount: journeyVisits.requestCount, pageCount: journeyVisits.pageCount })
    .from(journeyVisits).where(eq(journeyVisits.visitorKey, visitorKey)).orderBy(asc(journeyVisits.startedAt)).all()
  const eventsOf = (visitId: string) => db.select({ path: journeyEvents.path, aiTouch: journeyEvents.aiTouch }).from(journeyEvents).where(eq(journeyEvents.visitId, visitId)).orderBy(asc(journeyEvents.ts)).all()
  const visitorOf = (visitorKey: string) => db.select().from(journeyVisitors).where(eq(journeyVisitors.visitorKey, visitorKey)).get()

  beforeEach(() => {
    db = createClient(':memory:')
    migrate(db)
    db.insert(projects).values({ id: 'project', name: 'example', displayName: 'Example', canonicalDomain: 'https://example.com', country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW }).run()
    db.insert(trafficSources).values({ id: 'source', projectId: 'project', sourceType: TrafficSourceTypes.cloudflare, displayName: 'source', status: 'connected', createdAt: NOW, updatedAt: NOW }).run()

    // Only background calls: the page was logged under another key.
    visitor('calls-only', 0)
    visit('calls-only', 'calls-only-1', AI_ENTRY, [[0, '/api/shopify', 'data', true], [40, '/api/shopify', 'data', false]])
    // The call was logged just before the page that carried the utm tag.
    visitor('tagged-page', 0)
    visit('tagged-page', 'tagged-page-1', AI_ENTRY, [[0, '/api/shopify', 'data', true], [37, '/terms?utm_source=chatgpt.com', 'page', false], [900, '/api/shopify', 'data', false]])
    // The page after the call had no AI evidence of its own.
    visitor('untagged-page', 0)
    visit('untagged-page', 'untagged-page-1', AI_ENTRY, [[0, '/api/shopify', 'data', true], [19_000, '/products/tee', 'page', false]])
    // The page was an AI arrival too, and a later visit returns within the lookback.
    visitor('page-touch', 0, 5)
    visit('page-touch', 'page-touch-1', AI_ENTRY, [[0, '/api/shopify', 'data', true], [5, '/404', 'page', true]])
    visit('page-touch', 'page-touch-2', DIRECT_ENTRY, [[5 * DAY, '/', 'page', false]])
    // A call on day 0 kept a direct visit on day 5; the real AI arrival is on day 10.
    visitor('later-arrival', 0, 10 * DAY)
    visit('later-arrival', 'later-arrival-1', AI_ENTRY, [[0, '/api/cart', 'data', true]])
    visit('later-arrival', 'later-arrival-2', DIRECT_ENTRY, [[5 * DAY, '/', 'page', false]])
    visit('later-arrival', 'later-arrival-3', AI_ENTRY, [[10 * DAY, '/menu?utm_source=chatgpt.com', 'page', true]])
    // Untouched: a page arrival with a call inside the visit.
    visitor('normal', 0)
    visit('normal', 'normal-1', AI_ENTRY, [[0, '/?utm_source=chatgpt.com', 'page', true], [500, '/api/cart', 'data', false]])
  })
  afterEach(() => db.$client.close())

  it('previews without writing, then corrects every stored journey a call opened', () => {
    const before = JSON.stringify(db.select().from(journeyEvents).all())
    const expected = { visitors: 5, visitorsRemoved: 2, visitsRemoved: 4, visitsRelanded: 2 }
    expect(correctBackgroundCallJourneys(db, { dryRun: true, now: NOW })).toEqual(expected)
    expect(JSON.stringify(db.select().from(journeyEvents).all())).toBe(before)
    expect(correctBackgroundCallJourneys(db, { dryRun: false, now: NOW })).toEqual(expected)

    expect(visitorOf('calls-only')).toBeUndefined()
    expect(visitsOf('calls-only')).toEqual([])
    expect(visitorOf('untagged-page')).toBeUndefined()
    expect(db.select().from(journeyEvents).where(eq(journeyEvents.visitId, 'calls-only-1')).all()).toEqual([])

    expect(visitsOf('tagged-page')).toEqual([{ id: 'tagged-page-1', landingPath: '/terms?utm_source=chatgpt.com', startedAt: at(37), requestCount: 2, pageCount: 1 }])
    expect(eventsOf('tagged-page-1')).toEqual([{ path: '/terms?utm_source=chatgpt.com', aiTouch: true }, { path: '/api/shopify', aiTouch: false }])
    expect(visitorOf('tagged-page')).toMatchObject({ firstAiAt: at(37), lastAiAt: at(37), lastSeenAt: at(900), firstAiEngine: 'ChatGPT', updatedAt: NOW })

    expect(visitsOf('page-touch').map(v => [v.id, v.landingPath])).toEqual([['page-touch-1', '/404'], ['page-touch-2', '/']])
    expect(visitorOf('page-touch')).toMatchObject({ firstAiAt: at(5), lastSeenAt: at(5 * DAY) })

    expect(visitsOf('later-arrival').map(v => v.id)).toEqual(['later-arrival-3'])
    expect(visitorOf('later-arrival')).toMatchObject({ firstAiAt: at(10 * DAY), lastAiAt: at(10 * DAY), lastSeenAt: at(10 * DAY) })

    expect(visitsOf('normal')).toEqual([{ id: 'normal-1', landingPath: '/?utm_source=chatgpt.com', startedAt: at(0), requestCount: 2, pageCount: 1 }])
    expect(visitorOf('normal')).toMatchObject({ updatedAt: NOW, firstAiAt: at(0) })

    // Nothing is left to correct.
    expect(correctBackgroundCallJourneys(db, { dryRun: false, now: NOW })).toEqual({ visitors: 0, visitorsRemoved: 0, visitsRemoved: 0, visitsRelanded: 0 })
  })

  it('finds a hidden arrival even when the visitor has a later one, and settles a call logged with its page', () => {
    // A call took the arrival; the tagged page a moment later is the real one. A new arrival comes on day 40.
    visitor('hidden-arrival', 0, 40 * DAY)
    visit('hidden-arrival', 'hidden-arrival-1', AI_ENTRY, [[0, '/api/cart', 'data', true], [10, '/?utm_source=chatgpt.com', 'page', false]])
    visit('hidden-arrival', 'hidden-arrival-2', AI_ENTRY, [[40 * DAY, '/menu?utm_source=chatgpt.com', 'page', true]])
    // A call opened a visit two days after an arrival: its tagged page is a step, not a new arrival.
    visitor('step', 0, 2 * DAY)
    visit('step', 'step-1', AI_ENTRY, [[0, '/?utm_source=chatgpt.com', 'page', true]])
    visit('step', 'step-2', AI_ENTRY, [[2 * DAY, '/api/cart', 'data', true], [2 * DAY + 10, '/menu?utm_source=chatgpt.com', 'page', false]])
    // A call logged at the same instant as its page, and stored as the visit's first request.
    visitor('same-instant', 0)
    visit('same-instant', 'same-instant-1', AI_ENTRY, [[0, '/api/cart', 'data', true], [0, '/?utm_source=chatgpt.com', 'page', false]])

    expect(correctBackgroundCallJourneys(db, { dryRun: false, now: NOW })).toEqual({ visitors: 8, visitorsRemoved: 2, visitsRemoved: 4, visitsRelanded: 5 })

    expect(visitsOf('hidden-arrival')).toEqual([
      { id: 'hidden-arrival-1', landingPath: '/?utm_source=chatgpt.com', startedAt: at(10), requestCount: 1, pageCount: 1 },
      { id: 'hidden-arrival-2', landingPath: '/menu?utm_source=chatgpt.com', startedAt: at(40 * DAY), requestCount: 1, pageCount: 1 },
    ])
    expect(eventsOf('hidden-arrival-1')).toEqual([{ path: '/?utm_source=chatgpt.com', aiTouch: true }])
    expect(visitorOf('hidden-arrival')).toMatchObject({ firstAiAt: at(10), lastAiAt: at(40 * DAY), firstAiEngine: 'ChatGPT' })

    const stepVisit = db.select().from(journeyVisits).where(eq(journeyVisits.id, 'step-2')).get()
    expect(stepVisit).toMatchObject({ entryClass: 'direct', entryName: null, landingPath: '/menu?utm_source=chatgpt.com', startedAt: at(2 * DAY + 10), requestCount: 1 })
    expect(eventsOf('step-2')).toEqual([{ path: '/menu?utm_source=chatgpt.com', aiTouch: false }])
    expect(visitorOf('step')).toMatchObject({ firstAiAt: at(0), lastAiAt: at(0), lastSeenAt: at(2 * DAY + 10) })

    expect(visitsOf('same-instant')).toEqual([{ id: 'same-instant-1', landingPath: '/?utm_source=chatgpt.com', startedAt: at(0), requestCount: 2, pageCount: 1 }])
    expect(db.select({ path: journeyEvents.path, aiTouch: journeyEvents.aiTouch }).from(journeyEvents).where(eq(journeyEvents.visitId, 'same-instant-1')).orderBy(asc(journeyEvents.path)).all())
      .toEqual([{ path: '/?utm_source=chatgpt.com', aiTouch: true }, { path: '/api/cart', aiTouch: false }])

    // A call kept at the same instant as its page is not read again.
    expect(correctBackgroundCallJourneys(db, { dryRun: false, now: NOW })).toEqual({ visitors: 0, visitorsRemoved: 0, visitsRemoved: 0, visitsRelanded: 0 })
  })

  it('limits the correction to the given projects', () => {
    expect(correctBackgroundCallJourneys(db, { projectIds: ['other'], dryRun: false, now: NOW })).toEqual({ visitors: 0, visitorsRemoved: 0, visitsRemoved: 0, visitsRelanded: 0 })
    expect(visitorOf('calls-only')).toBeDefined()
  })
})
