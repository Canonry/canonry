import crypto from 'node:crypto'
import { asc, eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  aiReferralEventsHourly,
  createClient,
  journeyEvents,
  journeyVisitors,
  journeyVisits,
  migrate,
  projects,
  trafficSources,
} from '@canonry/canonry-db'
import { recountAiReferralArrivalsFromJourneys, repairAiReferralArrivalsOnStartup } from '../src/ai-referral-recount.js'

/**
 * Hours counted under the older AI-referral rule read high and keep no
 * visitor. Where AI visitor journeys cover them, the recount rebuilds those
 * hours once per AI-entered visit and moves the older-count mark back to where
 * journeys began. Everything it cannot prove is left as stored.
 */

const JOURNEYS_APPLIED_AT = '2026-10-25 00:44:18'
const OLDER_COUNT_UNTIL = '2026-11-02T18:31:33.000Z'
const NOW = new Date('2026-11-06T22:00:00.000Z')

describe('AI-referral recount from journeys', () => {
  let db: ReturnType<typeof createClient>
  const projectId = 'project'

  beforeEach(() => {
    db = createClient(':memory:')
    migrate(db)
    db.run(sql`UPDATE _migrations SET applied_at = ${JOURNEYS_APPLIED_AT} WHERE version = 192`)
    db.insert(projects).values({ id: projectId, name: 'example', displayName: 'Example', canonicalDomain: 'example.com', country: 'US', language: 'en', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }).run()
  })
  afterEach(() => db.$client.close())

  function source(id: string, sourceType: string, olderCountUntil: string | null = OLDER_COUNT_UNTIL, createdAt = '2026-08-16T18:36:38.721Z') {
    db.insert(trafficSources).values({ id, projectId, sourceType, displayName: id, status: 'connected', createdAt, updatedAt: createdAt, aiReferralOlderCountUntil: olderCountUntil }).run()
  }

  function hourly(sourceId: string, tsHour: string, hits: number, extra: Partial<typeof aiReferralEventsHourly.$inferInsert> = {}) {
    db.insert(aiReferralEventsHourly).values({
      projectId, sourceId, tsHour, product: 'ChatGPT', operator: 'OpenAI', sourceDomain: 'chatgpt.com', evidenceType: 'utm',
      landingPathNormalized: '/', status: 200, sessionsOrHits: hits, paidSessionsOrHits: 0, organicSessionsOrHits: hits,
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...extra,
    }).run()
  }

  function visit(sourceId: string, opts: {
    startedAt: string
    entryClass?: string
    product?: string
    host?: string
    landingPath?: string
    paid?: boolean
    keyBasis?: string
    statuses?: number[]
  }) {
    const visitorKey = crypto.randomUUID()
    const visitId = crypto.randomUUID()
    const at = opts.startedAt
    db.insert(journeyVisitors).values({
      projectId, visitorKey, keyBasis: opts.keyBasis ?? 'ip-ua', userAgent: 'Mozilla/5.0', firstAiAt: at, firstAiEngine: opts.product ?? 'ChatGPT',
      lastAiAt: at, lastSeenAt: at, createdAt: at, updatedAt: at,
    }).run()
    db.insert(journeyVisits).values({
      id: visitId, projectId, visitorKey, sourceId, startedAt: at, endedAt: at, entryClass: opts.entryClass ?? 'ai',
      entryName: opts.product ?? 'ChatGPT', entryHost: opts.host ?? 'chatgpt.com', paid: opts.paid ?? false,
      landingPath: opts.landingPath ?? '/products/studio-tank?utm_source=chatgpt.com', requestCount: 1, pageCount: 1, createdAt: at, updatedAt: at,
    }).run()
    for (const [i, status] of (opts.statuses ?? [200]).entries()) {
      const ts = new Date(Date.parse(at) + i * 1000).toISOString()
      db.insert(journeyEvents).values({
        id: crypto.randomUUID(), projectId, visitId, sourceId, sourceEventId: crypto.randomUUID(), ts, method: 'GET',
        path: '/products/studio-tank', status, kind: 'page', aiTouch: i === 0, createdAt: ts,
      }).run()
    }
  }

  const rows = (sourceId: string) => db.select({
    tsHour: aiReferralEventsHourly.tsHour, product: aiReferralEventsHourly.product, operator: aiReferralEventsHourly.operator,
    sourceDomain: aiReferralEventsHourly.sourceDomain, evidenceType: aiReferralEventsHourly.evidenceType,
    landingPathNormalized: aiReferralEventsHourly.landingPathNormalized, status: aiReferralEventsHourly.status,
    hits: aiReferralEventsHourly.sessionsOrHits, paid: aiReferralEventsHourly.paidSessionsOrHits, organic: aiReferralEventsHourly.organicSessionsOrHits,
  }).from(aiReferralEventsHourly).where(eq(aiReferralEventsHourly.sourceId, sourceId))
    .orderBy(asc(aiReferralEventsHourly.tsHour), asc(aiReferralEventsHourly.product)).all()

  const stamp = (sourceId: string) => db.select({ until: trafficSources.aiReferralOlderCountUntil }).from(trafficSources)
    .where(eq(trafficSources.id, sourceId)).get()?.until

  it('rebuilds the covered older hours once per AI-entered visit and moves the mark back', () => {
    source('edge', 'cloudflare')
    hourly('edge', '2026-10-20T10:00:00.000Z', 90) // before journeys began: kept
    hourly('edge', '2026-10-28T10:00:00.000Z', 140) // older count: replaced
    hourly('edge', '2026-10-28T10:00:00.000Z', 30, { landingPathNormalized: '/collections/tops' })
    hourly('edge', '2026-11-02T18:00:00.000Z', 40) // the hour the rule changed in: replaced
    hourly('edge', '2026-11-03T09:00:00.000Z', 4) // current rule: kept

    visit('edge', { startedAt: '2026-10-24T10:00:00.000Z' }) // before journeys began on this install
    visit('edge', { startedAt: '2026-10-28T10:15:00.000Z', statuses: [301, 200] }) // a redirect hop is not the landing
    visit('edge', { startedAt: '2026-10-28T10:40:00.000Z', paid: true })
    visit('edge', { startedAt: '2026-10-28T10:50:00.000Z', entryClass: 'search', product: 'google' }) // not an AI entry
    visit('edge', { startedAt: '2026-11-02T18:50:00.000Z', product: 'Perplexity', host: 'perplexity.ai', landingPath: '/' })
    visit('edge', { startedAt: '2026-11-03T09:10:00.000Z' }) // after the span

    const results = recountAiReferralArrivalsFromJourneys(db, NOW)

    expect(results).toEqual([{
      sourceId: 'edge', from: '2026-10-25T01:00:00.000Z', through: '2026-11-02T18:00:00.000Z',
      rowsReplaced: 3, arrivals: 3, olderCountUntil: '2026-10-25T01:00:00.000Z',
    }])
    expect(rows('edge')).toEqual([
      { tsHour: '2026-10-20T10:00:00.000Z', product: 'ChatGPT', operator: 'OpenAI', sourceDomain: 'chatgpt.com', evidenceType: 'utm', landingPathNormalized: '/', status: 200, hits: 90, paid: 0, organic: 90 },
      { tsHour: '2026-10-28T10:00:00.000Z', product: 'ChatGPT', operator: 'OpenAI', sourceDomain: 'chatgpt.com', evidenceType: 'utm', landingPathNormalized: '/products/studio-tank', status: 200, hits: 2, paid: 1, organic: 1 },
      { tsHour: '2026-11-02T18:00:00.000Z', product: 'Perplexity', operator: 'Perplexity', sourceDomain: 'perplexity.ai', evidenceType: 'referer', landingPathNormalized: '/', status: 200, hits: 1, paid: 0, organic: 1 },
      { tsHour: '2026-11-03T09:00:00.000Z', product: 'ChatGPT', operator: 'OpenAI', sourceDomain: 'chatgpt.com', evidenceType: 'utm', landingPathNormalized: '/', status: 200, hits: 4, paid: 0, organic: 4 },
    ])
    expect(stamp('edge')).toBe('2026-10-25T01:00:00.000Z')

    // Repeating it over the rebuilt hours changes nothing.
    recountAiReferralArrivalsFromJourneys(db, NOW)
    expect(rows('edge').map(row => row.hits)).toEqual([90, 2, 1, 4])
    expect(stamp('edge')).toBe('2026-10-25T01:00:00.000Z')
  })

  it('clears the mark when no older hour is left before journeys began', () => {
    source('late', 'cloud-run', OLDER_COUNT_UNTIL, '2026-10-27T12:30:00.000Z')
    hourly('late', '2026-10-28T10:00:00.000Z', 60)
    visit('late', { startedAt: '2026-10-28T10:15:00.000Z' })

    expect(recountAiReferralArrivalsFromJourneys(db, NOW)).toEqual([{
      sourceId: 'late', from: '2026-10-27T13:00:00.000Z', through: '2026-11-02T18:00:00.000Z',
      rowsReplaced: 1, arrivals: 1, olderCountUntil: null,
    }])
    expect(rows('late').map(row => row.hits)).toEqual([1])
    expect(stamp('late')).toBeNull()
  })

  it('leaves alone what it cannot prove', () => {
    // A WordPress logger misses cached page views.
    source('wordpress', 'wordpress')
    hourly('wordpress', '2026-10-28T10:00:00.000Z', 7)
    visit('wordpress', { startedAt: '2026-10-28T10:15:00.000Z' })
    // A user-agent-only key can merge many people.
    source('mixed', 'cloudflare')
    hourly('mixed', '2026-10-28T10:00:00.000Z', 8)
    visit('mixed', { startedAt: '2026-10-28T10:15:00.000Z' })
    visit('mixed', { startedAt: '2026-10-28T11:15:00.000Z', keyBasis: 'ua' })
    // No AI-entered visit: an absence cannot prove zero arrivals.
    source('silent', 'cloudflare')
    hourly('silent', '2026-10-28T10:00:00.000Z', 9)
    // No older count at all.
    source('current', 'cloudflare', null)
    hourly('current', '2026-10-28T10:00:00.000Z', 3)
    visit('current', { startedAt: '2026-10-28T10:15:00.000Z' })

    expect(recountAiReferralArrivalsFromJourneys(db, NOW)).toEqual([])
    expect(['wordpress', 'mixed', 'silent', 'current'].map(id => rows(id).map(row => row.hits))).toEqual([[7], [8], [9], [3]])
    expect(['wordpress', 'mixed', 'silent', 'current'].map(stamp)).toEqual([OLDER_COUNT_UNTIL, OLDER_COUNT_UNTIL, OLDER_COUNT_UNTIL, null])
  })

  it('runs once per install at startup', () => {
    source('edge', 'cloudflare')
    hourly('edge', '2026-10-28T10:00:00.000Z', 140)
    visit('edge', { startedAt: '2026-10-28T10:15:00.000Z' })

    expect(repairAiReferralArrivalsOnStartup(db, NOW)?.map(result => result.arrivals)).toEqual([1])
    hourly('edge', '2026-10-29T10:00:00.000Z', 50)
    expect(repairAiReferralArrivalsOnStartup(db, NOW)).toBeNull()
    expect(rows('edge').map(row => row.hits)).toEqual([1, 50])
  })
})
