import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { createClient, migrate, projects, trafficSources, rawEventSamples, aiReferralEventsHourly, apiKeys, measurementPlans, measurementPlanVersions } from '@ainyc/canonry-db'
import { canonicalMeasurementPlanV2Json } from '@ainyc/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { enforceGlobalRawEventSampleRetention } from '../src/raw-event-sample-retention.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const date = '2026-10-10T12:00:00.123Z'
const url = '/api/v1/projects/example/traffic/samples?since=2026-10-10T00:00:00Z&until=2026-10-11T00:00:00Z'
const referral = { operator: 'OpenAI', product: 'ChatGPT', sourceDomain: 'chatgpt.com', evidenceType: 'referer', trafficClass: 'organic' }

describe('stored traffic samples', () => {
  let db: ReturnType<typeof createClient>
  let app: ReturnType<typeof Fastify>
  function sample(id: string, overrides: Partial<typeof rawEventSamples.$inferInsert> = {}) {
    db.insert(rawEventSamples).values({ id, projectId: 'project', sourceId: 'source', ts: date, eventType: 'ai_referral', ipHash: 'private-hash', userAgent: 'Mozilla/5.0 (Synthetic Browser)', pathNormalized: '/blog/post', status: 200, refererHost: 'chatgpt.com', classifierDetailsJson: { crawler: null, aiUserFetch: null, aiReferral: referral }, createdAt: date, ...overrides }).run()
  }
  beforeEach(async () => {
    db = createClient(':memory:')
    migrate(db)
    for (const [id, name] of [['project', 'example'], ['other', 'other']]) {
      db.insert(projects).values({ id: id!, name: name!, displayName: name!, canonicalDomain: `${name}.example`, country: 'US', language: 'en', createdAt: date, updatedAt: date }).run()
      db.insert(trafficSources).values({ id: id === 'project' ? 'source' : 'foreign', projectId: id!, sourceType: 'cloudflare', displayName: 'Edge', status: 'connected', createdAt: date, updatedAt: date }).run()
    }
    app = Fastify()
    await app.register(apiRoutes, { db, skipAuth: true })
    await app.ready()
  })
  afterEach(async () => { await app.close(); db.$client.close() })

  it('returns classified samples in stable newest-first pages, with exact counts and no private fields', async () => {
    sample('a')
    sample('b', { eventType: 'crawler', classifierDetailsJson: { crawler: { botId: 'GPTBot', operator: 'OpenAI', product: 'ChatGPT', purpose: 'training', verificationStatus: 'claimed_unverified', verificationManifest: null, matchedUserAgent: 'GPTBot', ipHash: 'hidden' }, aiUserFetch: null, aiReferral: null, ip_hash: 'hidden' } })
    sample('c', { ts: '2026-10-10T13:00:00.456Z', eventType: 'ai_user_fetch', classifierDetailsJson: { crawler: null, aiUserFetch: { botId: 'ChatGPT-User', operator: 'OpenAI', product: 'ChatGPT', verificationStatus: 'claimed_unverified', verificationManifest: null, matchedUserAgent: 'ChatGPT-User' }, aiReferral: null } })
    sample('unknown', { eventType: 'unknown', classifierDetailsJson: { crawler: null, aiUserFetch: null, aiReferral: null } })
    sample('foreign', { projectId: 'other', sourceId: 'foreign' })
    const response = await app.inject({ method: 'GET', url: `${url}&limit=2` })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body).toMatchObject({ scope: { project: 'example', sourceId: null, attribution: 'project-source-only', unavailableDimensions: ['property', 'target', 'market'] }, windowStart: '2026-10-10T00:00:00.000Z', windowEnd: '2026-10-11T00:00:00.000Z', retentionDays: 30, sampling: { complete: false, perSync: 100, perBackfill: 500, perPushHour: 100 }, totalRows: 3, limit: 2, offset: 0 })
    expect(body.samples.map((row: { id: string }) => row.id)).toEqual(['c', 'b'])
    expect(response.body).not.toMatch(/ipHash|ip_hash|private-hash|hidden/)
    const next = (await app.inject({ method: 'GET', url: `${url}&limit=2&offset=2` })).json()
    expect(next.totalRows).toBe(3)
    expect(next.samples).toEqual([{ id: 'a', sourceId: 'source', ts: date, kind: 'ai-referral', pathNormalized: '/blog/post', status: 200, refererHost: 'chatgpt.com', userAgent: 'Mozilla/5.0 (Synthetic Browser)', classifier: { crawler: null, aiUserFetch: null, aiReferral: referral } }])
  })

  it('filters kind, project-owned source and literal path prefixes before counting', async () => {
    sample('literal', { pathNormalized: '/blog%_one' })
    sample('wildcard', { pathNormalized: '/blogXYone' })
    sample('unknown', { eventType: 'unknown' })
    sample('foreign', { projectId: 'other', sourceId: 'foreign' })
    const literal = (await app.inject({ method: 'GET', url: `${url}&path=${encodeURIComponent('/blog%_')}&sourceId=source&kind=ai-referral` })).json()
    expect(literal.totalRows).toBe(1)
    expect(literal.samples.map((row: { id: string }) => row.id)).toEqual(['literal'])
    const unknown = (await app.inject({ method: 'GET', url: `${url}&kind=unknown` })).json()
    expect(unknown.samples.map((row: { id: string }) => row.id)).toEqual(['unknown'])
    expect((await app.inject({ method: 'GET', url: `${url}&sourceId=foreign` })).json()).toMatchObject({ totalRows: 0, samples: [] })
  })

  it.each(['kind=visitor', 'limit=501', 'limit=0', 'offset=-1', 'unexpected=true', 'since=invalid', 'since=2026-10-12T00:00:00Z', 'until=2026-10-09T00:00:00Z'])('rejects invalid selection %s', async query => {
    const params = new URLSearchParams(url.split('?')[1])
    new URLSearchParams(query).forEach((value, key) => params.set(key, value))
    const response = await app.inject({ method: 'GET', url: `/api/v1/projects/example/traffic/samples?${params}` })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('VALIDATION_ERROR')
    expect(response.json().error.message).not.toMatch(/\n|^\[/)
  })

  it('accepts date-only bounds as UTC midnight', async () => {
    sample('date-only')
    const response = await app.inject('/api/v1/projects/example/traffic/samples?since=2026-10-10&until=2026-10-11')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ totalRows: 1, windowStart: '2026-10-10T00:00:00.000Z', windowEnd: '2026-10-11T00:00:00.000Z' })
  })

  it('normalizes offset bounds and tolerates a synthetic pre-upgrade classifier shape', async () => {
    sample('legacy', { eventType: 'crawler', classifierDetailsJson: { crawler: { botId: 'GPTBot', verificationStatus: null }, aiReferral: null } })
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/example/traffic/samples?since=2026-10-10T14:00:00%2B02:00&until=2026-10-10T14:00:01%2B02:00' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ totalRows: 1, windowStart: '2026-10-10T12:00:00.000Z', samples: [{ classifier: { crawler: { botId: 'GPTBot', verificationStatus: null }, aiUserFetch: null, aiReferral: null } }] })
  })

  it('defaults to the last 24 hours and leaves rollup totals unchanged after retention', async () => {
    const now = Date.now()
    sample('recent', { ts: new Date(now - 1_000).toISOString() })
    sample('old', { ts: new Date(now - 31 * 86_400_000).toISOString() })
    db.insert(aiReferralEventsHourly).values({ projectId: 'project', sourceId: 'source', tsHour: date, product: 'ChatGPT', operator: 'OpenAI', sourceDomain: 'chatgpt.com', evidenceType: 'referer', landingPathNormalized: '/blog/post', status: 200, sessionsOrHits: 17, paidSessionsOrHits: 2, organicSessionsOrHits: 15, createdAt: date, updatedAt: date }).run()
    const eventsUrl = url.replace('/samples?', '/events?')
    const before = (await app.inject({ method: 'GET', url: eventsUrl })).json()
    enforceGlobalRawEventSampleRetention(db, new Date(now).toISOString())
    const response = await app.inject({ method: 'GET', url: '/api/v1/projects/example/traffic/samples' })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.samples.map((row: { id: string }) => row.id)).toEqual(['recent'])
    expect(Date.parse(body.windowEnd) - Date.parse(body.windowStart)).toBe(86_400_000)
    expect(db.select().from(rawEventSamples).all().map(row => row.id)).toEqual(['recent'])
    const after = (await app.inject({ method: 'GET', url: eventsUrl })).json()
    expect(after.totals).toEqual(before.totals)
    expect(after.totals.aiReferralHits).toBe(17)
  })

  it('returns identical evidence for an Advanced portfolio without invented attribution', async () => {
    sample('advanced')
    const simple = (await app.inject({ method: 'GET', url })).json()
    const plan = measurementPlanV2Fixture()
    db.insert(measurementPlanVersions).values({ id: 'version', projectId: 'project', revision: 1, schemaVersion: 2, canonicalJson: canonicalMeasurementPlanV2Json(plan), checksum: 'a'.repeat(64), compiledChecksum: plan.compiledChecksum, createdAt: date }).run()
    db.insert(measurementPlans).values({ projectId: 'project', activeVersionId: 'version', createdAt: date, updatedAt: date }).run()
    expect((await app.inject({ method: 'GET', url })).json()).toEqual(simple)
    expect(simple.scope.unavailableDimensions).toEqual(['property', 'target', 'market'])
  })

  it('enforces viewer, scoped key and embed access through real authentication', async () => {
    sample('sample')
    for (const [name, scopes, projectId] of [['root', ['*'], null], ['read', ['read'], null], ['scoped', ['read'], 'other']] as const) {
      db.insert(apiKeys).values({ id: name, name, keyHash: hashApiKey(`cnry_samples_${name}`), keyPrefix: 'cnry_', scopes: [...scopes], projectId, createdAt: date }).run()
    }
    const secured = Fastify()
    await secured.register(apiRoutes, { db })
    await secured.ready()
    const embedded = Fastify()
    await embedded.register(apiRoutes, { db, embedProjectTabs: ['overview', 'traffic'] })
    await embedded.ready()
    try {
      const read = await secured.inject({ method: 'GET', url, headers: { authorization: 'Bearer cnry_samples_read' } })
      expect(read.statusCode).toBe(200)
      expect((await secured.inject({ method: 'GET', url, headers: { authorization: 'Bearer cnry_samples_scoped' } })).statusCode).toBe(403)
      expect((await embedded.inject({ method: 'GET', url, headers: { authorization: 'Bearer cnry_samples_root' } })).statusCode).toBe(403)
      expect((await secured.inject({ method: 'POST', url: '/api/v1/users', headers: { authorization: 'Bearer cnry_samples_root' }, payload: { name: 'owner', password: 'synthetic-owner-password', role: 'admin' } })).statusCode).toBe(201)
      const created = await secured.inject({ method: 'POST', url: '/api/v1/users', headers: { authorization: 'Bearer cnry_samples_root' }, payload: { name: 'watcher', password: 'synthetic-long-password', role: 'viewer' } })
      expect(created.statusCode).toBe(201)
      const login = await secured.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://localhost:4100', host: 'localhost:4100' }, payload: { name: 'watcher', password: 'synthetic-long-password' } })
      expect(login.statusCode).toBe(200)
      const rawCookie = login.headers['set-cookie']
      const cookie = (Array.isArray(rawCookie) ? rawCookie[0]! : String(rawCookie)).split(';')[0]!
      expect((await secured.inject({ method: 'GET', url, headers: { cookie, host: 'localhost:4100' } })).statusCode).toBe(403)
    } finally { await secured.close(); await embedded.close() }
  })
})
