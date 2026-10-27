import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { eq } from 'drizzle-orm'
import { agentJourneyCaptureDays, agentJourneyEvents, apiKeys, createClient, measurementPlans, measurementPlanVersions, migrate, projects, trafficSources } from '@canonry/canonry-db'
import { agentJourneyDetailResponseSchema, agentJourneysResponseSchema, canonicalMeasurementPlanJson, canonicalMeasurementPlanV2Json, compileMeasurementPlan, type AgentJourneysResponse } from '@canonry/canonry-contracts'
import { apiRoutes } from '../src/index.js'
import { hashApiKey } from '../src/auth.js'
import { measurementPlanV2Fixture } from './measurement-plan-v2-fixture.js'

const NOW = '2026-10-27T12:00:00.000Z'
const BASE = '/api/v1/projects/example/traffic/agent-journeys'
const WINDOW = 'since=2026-10-27&until=2026-10-27'

// API owns grouping, counts, scoped attribution and disclosure; capture has its
// own ingest-boundary tests. Stored fixtures make these read invariants independent.
describe('observed agent journeys', () => {
  let db: ReturnType<typeof createClient>
  let app: ReturnType<typeof Fastify>
  function event(id: string, time: string, overrides: Partial<typeof agentJourneyEvents.$inferInsert> = {}) {
    db.insert(agentJourneyEvents).values({ id, projectId: 'project', sourceId: 'source', sourceEventId: id,
      ts: `2026-10-27T${time}.000Z`, correlationKey: 'private-correlation-key', correlationBasis: 'ip-ua',
      agentId: 'openai-chatgpt-user', operator: 'OpenAI', product: 'ChatGPT', verificationStatus: 'claimed_unverified',
      host: 'northstar.example', path: '/', method: 'GET', status: 200, latencyMs: 42, createdAt: NOW, ...overrides }).run()
  }
  async function list(selection = ''): Promise<AgentJourneysResponse> {
    const response = await app.inject(`${BASE}?${WINDOW}${selection ? `&${selection}` : ''}`)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.body).not.toMatch(/private-correlation-key|sourceEventId|correlationKey|remoteIp|secret/)
    return agentJourneysResponseSchema.parse(response.json())
  }
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW))
    db = createClient(':memory:'); migrate(db)
    for (const [id, name, source] of [['project', 'example', 'source'], ['other', 'other', 'foreign']] as const) {
      db.insert(projects).values({ id, name, displayName: name, canonicalDomain: 'https://Northstar.EXAMPLE', country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW }).run()
      db.insert(trafficSources).values({ id: source, projectId: id, sourceType: 'cloud-run', displayName: source, status: 'connected', createdAt: NOW, updatedAt: NOW }).run()
    }
    db.insert(trafficSources).values({ id: 'second', projectId: 'project', sourceType: 'vercel', displayName: 'Second source', status: 'connected', createdAt: NOW, updatedAt: NOW }).run()
    app = Fastify(); await app.register(apiRoutes, { db, skipAuth: true, journeyKeySecret: 'fixture-secret' }); await app.ready()
  })
  afterEach(async () => { await app.close(); db.$client.close(); vi.useRealTimers() })

  it('orders requests, splits at the idle boundary, and counts HTTP errors without inventing outcomes', async () => {
    event('c', '10:02:00', { method: 'POST', path: '/booking', status: 409 })
    event('a', '10:00:00', { path: '/rooms' })
    event('b', '10:01:00', { path: '/api/availability', status: 302 })
    event('d', '10:32:00', { status: null, latencyMs: null })
    event('foreign', '10:01:00', { projectId: 'other', sourceId: 'foreign' })
    const first = await list('limit=1')
    expect(first).toMatchObject({ observedRequests: 4, totalJourneys: 2, offset: 0, journeys: [{ id: 'd', requestCount: 1, errorCount: 0, correlation: 'inferred' }] })
    const next = await list('limit=1&offset=1')
    expect(next.journeys).toMatchObject([{ id: 'a', firstPath: '/rooms', lastPath: '/booking', requestCount: 3, errorCount: 1, startedAt: '2026-10-27T10:00:00.000Z', endedAt: '2026-10-27T10:02:00.000Z', verificationStatuses: ['claimed_unverified'] }])
    const response = await app.inject(`${BASE}/a?${WINDOW}&limit=2&offset=1`)
    expect(response.statusCode).toBe(200)
    const detail = agentJourneyDetailResponseSchema.parse(response.json())
    expect(detail.totalEvents).toBe(3)
    expect(detail.events.map(e => [e.id, e.method, e.status])).toEqual([['b', 'GET', 302], ['c', 'POST', 409]])
    expect(detail.events[0]?.attribution).toBe('not-configured')
    expect(detail.events[0]?.latencyMs).toBe(42)
    // The old anchor still resolves when an earlier request arrives later.
    event('late', '09:59:00', { path: '/entry' })
    const late = agentJourneyDetailResponseSchema.parse((await app.inject(`${BASE}/a?${WINDOW}`)).json())
    expect(late.events.map(e => e.id)).toEqual(['late', 'a', 'b', 'c'])
    expect(late.journey.id).toBe('late')
  })

  it('keeps no-IP events, source boundaries and operator verification separate from session inference', async () => {
    event('a', '10:00:00', { verificationStatus: 'verified' })
    event('b', '10:01:00', { verificationStatus: 'verified' })
    event('c', '10:01:00', { sourceId: 'second' })
    event('u1', '10:02:00', { correlationBasis: 'unlinked' })
    event('u2', '10:03:00', { correlationBasis: 'unlinked' })
    const body = await list()
    expect(body).toMatchObject({ observedRequests: 5, totalJourneys: 4 })
    expect(body.journeys.map(row => [row.id, row.correlation, row.requestCount])).toEqual([['u2', 'unlinked', 1], ['u1', 'unlinked', 1], ['c', 'inferred', 1], ['a', 'inferred', 2]])
    const verified = await list('verificationStatus=verified')
    expect(verified).toMatchObject({ observedRequests: 2, totalJourneys: 1, journeys: [{ correlation: 'inferred', requestCount: 2 }] })
    expect((await app.inject(`${BASE}/a?${WINDOW}&sourceId=second`)).statusCode).toBe(404)
    expect((await app.inject(`${BASE}?${WINDOW}&sourceId=foreign`)).statusCode).toBe(404)
  })

  it.each([1, 2])('attributes URL-backed Properties under plan v%s without manufacturing market/query scope', async version => {
    const plan = measurementPlanV2Fixture()
    const legacy = compileMeasurementPlan({ schemaVersion: 1, targets: plan.targets.map(target => ({ stableKey: target.stableKey, label: target.label, aliases: target.aliases, urls: target.urlMatchers })), groups: [], targetQuerySelections: [] }, {
      canonicalDomain: 'northstar.example', ownedDomains: [], brandNames: ['Northstar'], trackedQueries: [], locations: [], defaultContext: null, expectedSnapshots: 1,
    })
    db.insert(measurementPlanVersions).values({ id: 'plan', projectId: 'project', revision: 3, schemaVersion: version, canonicalJson: version === 2 ? canonicalMeasurementPlanV2Json(plan) : canonicalMeasurementPlanJson(legacy), checksum: 'a'.repeat(64), compiledChecksum: version === 2 ? plan.compiledChecksum : null, createdAt: NOW }).run()
    db.insert(measurementPlans).values({ projectId: 'project', activeVersionId: 'plan', createdAt: NOW, updatedAt: NOW }).run()
    event('a', '10:00:00', { path: '/LOCATIONS/harbor/rooms' })
    event('b', '10:01:00', { path: '/locations/bayside' })
    event('unknown-host', '10:02:00', { host: null })
    event('redacted', '10:03:00', { path: '/locations/harbor/:token' })
    event('unmatched', '10:04:00', { path: '/elsewhere' })
    const body = await list('targetKey=harbor')
    expect(body).toMatchObject({ scope: { mode: 'advanced', planRevision: 3, attribution: 'current-plan-url', targetKey: 'harbor', unavailableDimensions: ['market', 'query', 'query-class', 'model', 'task'] }, observedRequests: 1, totalJourneys: 1, journeys: [{ requestCount: 1, targetKeys: ['harbor'] }] })
    expect(body.properties.map(p => p.key).sort()).toEqual(['bayside', 'harbor'])
    const full = agentJourneyDetailResponseSchema.parse((await app.inject(`${BASE}/a?${WINDOW}`)).json())
    expect(full.events.map(e => [e.id, e.targetKey, e.attribution])).toEqual([['a', 'harbor', 'matched'], ['b', 'bayside', 'matched'], ['unknown-host', null, 'unknown-host'], ['redacted', null, 'redacted'], ['unmatched', null, 'unmatched']])
  })

  it('exposes empty capture, configured source gaps and source-wide cap days without changing stored evidence', async () => {
    db.update(trafficSources).set({ lastSyncedAt: NOW, skippedThroughAt: '2026-10-27T09:00:00.000Z', queueBacklogCount: 12, queueBacklogObservedAt: NOW }).where(eq(trafficSources.id, 'source')).run()
    db.insert(agentJourneyCaptureDays).values({ projectId: 'project', sourceId: 'source', day: '2026-10-27', storedEvents: 10000, capped: true }).run()
    const body = await list()
    expect(body).toMatchObject({ observedRequests: 0, totalJourneys: 0, journeys: [], coverage: { recordingEnabled: true, retentionDays: 30, dailyEventLimit: 10000, idleMinutes: 30, windowBounded: true, cappedSourceDays: [{ sourceId: 'source', day: '2026-10-27' }] } })
    expect(body.coverage.sources.find(s => s.sourceId === 'second')?.limitations.join(' ')).toContain('no client IP')
    const sourceLimits = body.coverage.sources.find(s => s.sourceId === 'source')!.limitations
    expect(sourceLimits).toContain(`Last recorded sync: ${NOW}.`)
    expect(sourceLimits).toContain('Logs were skipped through 2026-10-27T09:00:00.000Z; the skipped interval may be absent.')
    expect(sourceLimits).toContain(`Queue reported 12 pending messages at ${NOW}; newer requests may still be waiting.`)
    expect((await list('sourceId=second')).coverage.cappedSourceDays).toEqual([])
    expect(db.select().from(agentJourneyCaptureDays).all()).toHaveLength(1)
  })

  it('refuses an oversized selection rather than exposing an incomplete timeline or an incorrect total', async () => {
    db.transaction(() => {
      for (let i = 0; i < 20_001; i++) event(`bulk-${i}`, '10:00:00', { sourceId: i < 10_000 ? 'source' : 'second', ts: `2026-10-${i < 20_000 ? '27' : '26'}T10:00:00.000Z` })
    })
    const response = await app.inject(`${BASE}?since=2026-10-26&until=2026-10-27`)
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', details: { reason: 'agent-journey-read-limit', limit: 20_000 } } })
    const narrower = await list('sourceId=source&limit=1')
    expect(narrower).toMatchObject({ observedRequests: 10000, totalJourneys: 1, journeys: [{ requestCount: 10000 }] })
  })

  it.each(['limit=0', 'offset=-1', 'until=2026-10-01', 'since=2026-08-01', 'since=invalid', 'marketKey=harbor', 'queryClass=non-brand', 'targetKey=absent'])('rejects unsupported or invalid scope: %s', async selection => {
    const params = new URLSearchParams(WINDOW)
    new URLSearchParams(selection).forEach((value, key) => params.set(key, value))
    const response = await app.inject(`${BASE}?${params}`)
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('VALIDATION_ERROR')
  })

  it('enforces real read-key project scope, viewer authority and embed restrictions on both operations', async () => {
    event('a', '10:00:00')
    for (const [name, scopes, projectId] of [['root', ['*'], null], ['read', ['read'], 'project'], ['foreign', ['read'], 'other']] as const) {
      db.insert(apiKeys).values({ id: name, name, keyHash: hashApiKey(`cnry_agent_journeys_${name}`), keyPrefix: 'cnry_', scopes: [...scopes], projectId, createdAt: NOW }).run()
    }
    const secured = Fastify(); await secured.register(apiRoutes, { db }); await secured.ready()
    const embed = Fastify(); await embed.register(apiRoutes, { db, embedProjectTabs: ['overview', 'traffic'] }); await embed.ready()
    const rootHeaders = { authorization: 'Bearer cnry_agent_journeys_root' }
    try {
      for (const [name, role] of [['owner', 'admin'], ['watcher', 'viewer']]) {
        const created = await secured.inject({ method: 'POST', url: '/api/v1/users', headers: rootHeaders, payload: { name, password: 'synthetic-long-password', role } })
        expect(created.statusCode, created.body).toBe(201)
      }
      const login = await secured.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://localhost:4100', host: 'localhost:4100' }, payload: { name: 'watcher', password: 'synthetic-long-password' } })
      expect(login.statusCode).toBe(200)
      const cookie = login.cookies[0]!
      for (const path of [BASE, `${BASE}/a`]) {
        const url = `${path}?${WINDOW}`
        expect((await secured.inject({ url, headers: { authorization: 'Bearer cnry_agent_journeys_read' } })).statusCode).toBe(200)
        expect((await secured.inject({ url, headers: { authorization: 'Bearer cnry_agent_journeys_foreign' } })).statusCode).toBe(403)
        expect((await secured.inject({ url, cookies: { [cookie.name]: cookie.value }, headers: { host: 'localhost:4100' } })).statusCode).toBe(403)
        expect((await embed.inject({ url, headers: rootHeaders })).statusCode).toBe(403)
      }
    } finally { await secured.close(); await embed.close() }
  })
})
