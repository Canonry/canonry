import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { agentJourneyCaptureDays, agentJourneyEvents, aiUserFetchEventsHourly, aiUserFetchLikelyFakeHourly, createClient, migrate, MIGRATION_VERSIONS, projects, rawEventSamples, trafficSources } from '@canonry/canonry-db'
import { AGENT_JOURNEY_DAILY_EVENT_LIMIT, TrafficEventConfidences, TrafficEvidenceKinds, TrafficSourceTypes, type NormalizedTrafficRequest } from '@canonry/canonry-contracts'
import { normalizeCloudRunLogEntry } from '@canonry/canonry-integration-cloud-run'
import { enforceAgentJourneyRetention, recordAgentJourneyBatch } from '../src/agent-journey-capture.js'
import { writeTrafficEventBatch } from '../src/traffic-event-ingest.js'
import chatgptUserRanges from '../../integration-traffic/src/ip-ranges/chatgpt-user.json' with { type: 'json' }
import { firstPublishedIp } from '../../integration-traffic/test/fixtures/vendored-ranges.js'

const NOW = '2026-10-27T12:00:00.000Z'
const SECRET = 'agent-capture-secret-used-only-in-tests'
const CHATGPT_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot'
// An address inside OpenAI's bundled list, so a range refresh cannot turn these requests into likely fakes.
const VERIFIED_IP = firstPublishedIp(chatgptUserRanges, 4)
function event(id: string, overrides: Partial<NormalizedTrafficRequest> = {}): NormalizedTrafficRequest {
  return {
    sourceType: TrafficSourceTypes['cloud-run'], evidenceKind: TrafficEvidenceKinds['raw-request'], confidence: TrafficEventConfidences.observed,
    eventId: id, observedAt: NOW, method: 'GET', requestUrl: 'https://example.com/', host: 'example.com', path: '/',
    queryString: null, status: 200, userAgent: CHATGPT_UA, remoteIp: VERIFIED_IP, referer: null,
    latencyMs: 17, requestSizeBytes: null, responseSizeBytes: null, providerResource: { type: null, labels: {} }, providerLabels: {}, ...overrides,
  }
}

describe('durable agent request capture', () => {
  let db: ReturnType<typeof createClient>
  const capture = (events: NormalizedTrafficRequest[], overrides: { secret?: string; sourceId?: string; now?: string } = {}) => db.transaction(tx => recordAgentJourneyBatch(tx, {
    projectId: 'project', sourceId: 'source', events, secret: SECRET, now: NOW, ...overrides,
  }, { onError: error => { throw error }, outerActive: () => db.$client.inTransaction }))

  beforeEach(() => {
    db = createClient(':memory:')
    // Exercise an installed database upgrade, not only a fresh table bootstrap.
    migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version < 200))
    db.insert(projects).values({ id: 'project', name: 'example', displayName: 'Example', canonicalDomain: 'https://Example.com', country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW }).run()
    for (const sourceId of ['source', 'second']) db.insert(trafficSources).values({ id: sourceId, projectId: 'project', sourceType: TrafficSourceTypes['cloud-run'], displayName: sourceId, status: 'connected', createdAt: NOW, updatedAt: NOW }).run()
    migrate(db)
  })
  afterEach(() => db.$client.close())

  it('deduplicates replayed and overlapping events while retaining exact observation and verification evidence', () => {
    const first = event('a', { path: '/rooms?email=secret', status: 404 })
    expect(capture([first, first])).toEqual({ eventsStored: 1 })
    expect(capture([first, event('b')])).toEqual({ eventsStored: 1 })
    const rows = db.select().from(agentJourneyEvents).all()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ path: '/rooms', status: 404, latencyMs: 17, agentId: 'openai-chatgpt-user', correlationBasis: 'ip-ua', verificationStatus: 'verified', trust: 'verified', trustReasons: ['ip-in-published-list', 'documented-user-agent'] })
    expect(rows[0]?.verificationManifest).toMatchObject({ source: expect.any(String), version: expect.any(String), id: expect.any(String) })
    expect(rows[0]?.correlationKey).toBe(rows[1]?.correlationKey)
    expect(JSON.stringify(rows)).not.toContain(VERIFIED_IP)
    expect(JSON.stringify(rows)).not.toContain(CHATGPT_UA)
    expect(db.select().from(agentJourneyCaptureDays).all()).toMatchObject([{ day: '2026-10-27', storedEvents: 2, capped: false }])
  })

  it('keeps URL-bearing provider ids private while preserving distinct requests, replay deduplication and source isolation', () => {
    const pathToken = '0123456789abcdef0123456789abcdef'
    const querySecrets = ['review-secret-one', 'review-secret-two']
    const requestUrls = querySecrets.map(secret => `https://example.com/reset/${pathToken}?token=${secret}`)
    const requests = requestUrls.map(requestUrl => {
      const normalized = normalizeCloudRunLogEntry({
        timestamp: NOW,
        httpRequest: {
          requestUrl, requestMethod: 'GET', status: 200,
          userAgent: CHATGPT_UA, remoteIp: VERIFIED_IP,
        },
      })
      if (!normalized) throw new Error('Synthetic Cloud Run request did not normalize')
      return normalized
    })

    expect(capture(requests)).toEqual({ eventsStored: 2 })
    const initialRows = db.select().from(agentJourneyEvents).all()
    expect(initialRows).toHaveLength(2)
    expect(initialRows.map(row => row.path)).toEqual(['/reset/:token', '/reset/:token'])
    const initialIds = initialRows.map(row => row.sourceEventId).sort()
    expect(new Set(initialIds).size).toBe(2)
    expect(capture([...requests, requests[0]!])).toEqual({ eventsStored: 0 })
    expect(db.select().from(agentJourneyEvents).all().map(row => row.sourceEventId).sort()).toEqual(initialIds)
    expect(db.select().from(agentJourneyCaptureDays).all()).toMatchObject([
      { sourceId: 'source', storedEvents: 2, capped: false },
    ])

    expect(capture([requests[0]!], { sourceId: 'second' })).toEqual({ eventsStored: 1 })
    expect(capture([requests[0]!], { sourceId: 'second' })).toEqual({ eventsStored: 0 })
    const rows = db.select().from(agentJourneyEvents).all()
    expect(rows).toHaveLength(3)
    const serializedRows = JSON.stringify(rows)
    for (const sensitive of [...requestUrls, ...querySecrets, pathToken, ...requests.map(request => request.eventId)]) {
      expect(serializedRows).not.toContain(sensitive)
    }
    expect(new Set(rows.map(row => row.sourceEventId)).size).toBe(3)
    expect(db.select({ sourceId: agentJourneyCaptureDays.sourceId, storedEvents: agentJourneyCaptureDays.storedEvents, capped: agentJourneyCaptureDays.capped })
      .from(agentJourneyCaptureDays).orderBy(agentJourneyCaptureDays.sourceId).all()).toEqual([
      { sourceId: 'second', storedEvents: 1, capped: false },
      { sourceId: 'source', storedEvents: 2, capped: false },
    ])
  })

  it('keeps missing or unusable IP requests unlinked and correlation isolated by source', () => {
    capture([
      event('a', { remoteIp: null }), event('b', { remoteIp: null }),
      event('invalid-a', { remoteIp: 'unknown' }), event('invalid-b', { remoteIp: 'unknown' }),
      event('invalid-other', { remoteIp: '-' }), event('c'),
    ])
    capture([event('c')], { sourceId: 'second' })
    const rows = db.select().from(agentJourneyEvents).all()
    expect(rows.filter(row => row.correlationBasis === 'unlinked')).toHaveLength(5)
    expect(new Set(rows.map(row => row.correlationKey)).size).toBe(7)
  })

  it('never stores likely fake requests or lets them use the daily cap, and counts them beside AI user fetches', () => {
    const fakes = [
      event('probe', { remoteIp: null, path: '/.env', status: 404 }),
      event('odd', { remoteIp: null, userAgent: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ChatGPT-User/1.0; +https://openai.com/bot)' }),
    ]
    expect(capture([...fakes, event('real', { remoteIp: null })])).toEqual({ eventsStored: 1 })
    expect(db.select({ trust: agentJourneyEvents.trust, trustReasons: agentJourneyEvents.trustReasons }).from(agentJourneyEvents).all())
      .toEqual([{ trust: 'likely_real', trustReasons: ['no-ip', 'documented-user-agent'] }])
    expect(db.select().from(agentJourneyCaptureDays).get()).toMatchObject({ storedEvents: 1, capped: false })

    const result = writeTrafficEventBatch({
      db, projectId: 'project', sourceId: 'source', events: [...fakes.map(fake => ({ ...fake, eventId: `push-${fake.eventId}` })), event('push-verified')], receivedAt: NOW,
      receiptTtlMs: 600_000, sampleLimit: 100, sourceUpdate: { lastSyncedAt: NOW }, journeyKeySecret: SECRET,
      validateSource: () => {},
    })
    expect(result).toMatchObject({ acceptedEvents: 3, aiUserFetchHits: 1, aiUserFetchLikelyFakeHits: 2, unknownHits: 0 })
    expect(db.select({ hits: aiUserFetchEventsHourly.hits }).from(aiUserFetchEventsHourly).all()).toEqual([{ hits: 1 }])
    expect(db.select({ reason: aiUserFetchLikelyFakeHourly.reason, hits: aiUserFetchLikelyFakeHourly.hits, botId: aiUserFetchLikelyFakeHourly.botId })
      .from(aiUserFetchLikelyFakeHourly).orderBy(aiUserFetchLikelyFakeHourly.reason).all()).toEqual([
      { reason: 'scanner-path', hits: 1, botId: 'openai-chatgpt-user' },
      { reason: 'unusual-user-agent', hits: 1, botId: 'openai-chatgpt-user' },
    ])
    // Samples keep the trust verdict so a likely fake can still be reviewed.
    const probeSample = db.select().from(rawEventSamples).all().find(sample => sample.pathNormalized === '/.env')
    expect(probeSample?.classifierDetailsJson).toMatchObject({ aiUserFetch: { trust: 'likely_fake', trustReasons: ['scanner-path', 'no-ip', 'documented-user-agent'] } })
    // A redelivery adds nothing.
    writeTrafficEventBatch({
      db, projectId: 'project', sourceId: 'source', events: [{ ...fakes[0]!, eventId: 'push-probe' }], receivedAt: NOW,
      receiptTtlMs: 600_000, sampleLimit: 100, sourceUpdate: { lastSyncedAt: NOW }, journeyKeySecret: SECRET, validateSource: () => {},
    })
    expect(db.select({ hits: aiUserFetchLikelyFakeHourly.hits }).from(aiUserFetchLikelyFakeHourly).all().reduce((sum, row) => sum + row.hits, 0)).toBe(2)
  })

  it('stores no events or daily identifiers without the configured secret', () => {
    expect(capture([event('a')], { secret: undefined })).toEqual({ eventsStored: 0 })
    expect(db.select().from(agentJourneyEvents).all()).toEqual([])
    expect(db.select().from(agentJourneyCaptureDays).all()).toEqual([])
  })

  it('captures a delivered traffic event exactly once through the receipt boundary', () => {
    const deliver = () => writeTrafficEventBatch({
      db, projectId: 'project', sourceId: 'source', events: [event('delivery')], receivedAt: NOW,
      receiptTtlMs: 600_000, sampleLimit: 100, sourceUpdate: { lastSyncedAt: NOW }, journeyKeySecret: SECRET,
      validateSource: source => { if (source?.projectId !== 'project') throw new Error('Wrong source') },
    })
    expect(deliver()).toMatchObject({ acceptedEvents: 1, duplicateEvents: 0, aiUserFetchHits: 1 })
    const initialRows = db.select().from(agentJourneyEvents).all()
    expect(initialRows).toHaveLength(1)
    expect(initialRows[0]?.sourceEventId).not.toBe('delivery')
    expect(deliver()).toMatchObject({ acceptedEvents: 0, duplicateEvents: 1, aiUserFetchHits: 0 })
    expect(db.select().from(agentJourneyEvents).all()).toEqual(initialRows)
  })

  it('caps each source UTC day without letting replayed ids consume capacity or falsely mark truncation', () => {
    const batch = Array.from({ length: AGENT_JOURNEY_DAILY_EVENT_LIMIT }, (_, i) => event(`event-${i}`))
    expect(capture(batch)).toEqual({ eventsStored: 10_000 })
    expect(capture([batch[0]!])).toEqual({ eventsStored: 0 })
    expect(db.select().from(agentJourneyCaptureDays).get()).toMatchObject({ storedEvents: 10_000, capped: false })
    expect(capture([event('overflow')])).toEqual({ eventsStored: 0 })
    expect(db.select().from(agentJourneyCaptureDays).get()).toMatchObject({ storedEvents: 10_000, capped: true })
    expect(capture([event('next-day', { observedAt: '2026-10-28T00:00:00Z' })], { now: '2026-10-28T00:00:00Z' })).toEqual({ eventsStored: 1 })
    expect(capture([event('other-source')], { sourceId: 'second' })).toEqual({ eventsStored: 1 })
  }, 20_000)

  it('enforces the 30-day boundary and source deletion cascades for observations and daily capture state', () => {
    capture([event('expired', { observedAt: '2026-09-26T12:00:00Z' }), event('boundary', { observedAt: '2026-09-27T12:00:00Z' })], { now: '2026-09-27T12:00:00Z' })
    enforceAgentJourneyRetention(db, NOW)
    expect(db.select({ ts: agentJourneyEvents.ts }).from(agentJourneyEvents).all()).toEqual([{ ts: '2026-09-27T12:00:00.000Z' }])
    expect(db.select({ day: agentJourneyCaptureDays.day }).from(agentJourneyCaptureDays).all()).toEqual([{ day: '2026-09-27' }])
    expect(capture([event('too-old', { observedAt: '2026-09-27T11:59:59Z' })])).toEqual({ eventsStored: 0 })
    db.delete(trafficSources).where(eq(trafficSources.id, 'source')).run()
    expect(db.select().from(agentJourneyEvents).all()).toEqual([])
    expect(db.select().from(agentJourneyCaptureDays).all()).toEqual([])
  })

  it('rolls back a failed capture and its counters without discarding the surrounding traffic transaction', () => {
    db.run(sql`CREATE TRIGGER reject_agent_event BEFORE INSERT ON agent_journey_events WHEN NEW.path = '/fail' BEGIN SELECT RAISE(ABORT, 'capture failed'); END`)
    const errors: unknown[] = []
    db.transaction(tx => {
      tx.update(projects).set({ displayName: 'Traffic committed' }).where(eq(projects.id, 'project')).run()
      expect(recordAgentJourneyBatch(tx, { projectId: 'project', sourceId: 'source', events: [event('good'), event('fail', { path: '/fail' })], secret: SECRET, now: NOW }, {
        onError: error => { errors.push(error) }, outerActive: () => db.$client.inTransaction,
      })).toEqual({ eventsStored: 0 })
    })
    expect(errors).toHaveLength(1)
    expect(db.select().from(agentJourneyEvents).all()).toEqual([])
    expect(db.select().from(agentJourneyCaptureDays).all()).toEqual([])
    expect(db.select({ name: projects.displayName }).from(projects).get()).toEqual({ name: 'Traffic committed' })
  })
})
