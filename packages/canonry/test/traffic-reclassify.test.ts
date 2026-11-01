import { describe, expect, it, onTestFinished } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { UNRECORDED_TRAFFIC_PATH } from '@canonry/canonry-contracts'
import {
  agentJourneyCaptureDays,
  agentJourneyEvents,
  aiUserFetchEventsHourly,
  aiUserFetchLikelyFakeHourly,
  aiUserFetchVerificationManifestsHourly,
  createClient,
  crawlerEventsHourly,
  migrate,
  migrationsTable,
  projects,
  rawEventSamples,
  trafficReclassificationState,
  trafficSources,
  unrecognizedAgentEventsHourly,
} from '@canonry/canonry-db'
import { reclassifyStoredTraffic, reclassifyStoredTrafficIfRulesChanged } from '../src/traffic-reclassify.js'

const CREATED = '2026-10-31T12:00:00.000Z'
const NOW = '2026-11-01T06:00:00.000Z'
const HOUR = '2026-11-01T02:00:00.000Z'
const WEBINDEXER = 'meta-webindexer/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)'
const FETCHER = 'meta-externalfetcher/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)'
const EXA = 'Mozilla/5.0 (compatible; ExaSearchBot/1.0; +https://crawler.exa.ai/)'
const IMESSAGE = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0'
const LIVENESS = 'Canonry site-liveness (+https://canonry.ai)'

type Db = ReturnType<typeof createClient>

function harness(): Db {
  const db = createClient(':memory:')
  migrate(db)
  onTestFinished(() => db.$client.close())
  db.insert(projects).values({
    id: 'project', name: 'harborline', displayName: 'Harborline', canonicalDomain: 'harborline.example',
    country: 'US', language: 'en', providers: [], createdAt: CREATED, updatedAt: CREATED,
  }).run()
  db.insert(trafficSources).values({ id: 'source', projectId: 'project', sourceType: 'cloudflare', displayName: 'Edge', status: 'connected', createdAt: CREATED, updatedAt: CREATED }).run()
  // Named unrecognized agents were counted by name from this hour on. Stored
  // as SQLite's CURRENT_TIMESTAMP writes it: UTC without a zone mark.
  db.update(migrationsTable).set({ appliedAt: '2026-11-01 01:09:00' }).where(eq(migrationsTable.version, 201)).run()
  return db
}

function unrecognized(db: Db, row: { agentName: string, hits: number, sampledUserAgent: string, tsHour?: string, sampledPath?: string }) {
  db.insert(unrecognizedAgentEventsHourly).values({
    projectId: 'project', sourceId: 'source', tsHour: HOUR, sampledPath: '/', createdAt: CREATED, updatedAt: CREATED, ...row,
  }).run()
}

function sample(db: Db, id: string, ts: string, userAgent: string, pathNormalized = '/') {
  db.insert(rawEventSamples).values({
    id, projectId: 'project', sourceId: 'source', ts, eventType: 'unknown', ipHash: null, userAgent, pathNormalized,
    status: 200, refererHost: null, classifierDetailsJson: { crawler: null, aiUserFetch: null, aiReferral: null }, createdAt: ts,
  }).run()
}

const unrecognizedRows = (db: Db) => db.select({ agentName: unrecognizedAgentEventsHourly.agentName, hits: unrecognizedAgentEventsHourly.hits })
  .from(unrecognizedAgentEventsHourly).all().sort((a, b) => a.agentName.localeCompare(b.agentName))
const crawlerRows = (db: Db) => db.select({
  tsHour: crawlerEventsHourly.tsHour, botId: crawlerEventsHourly.botId, verificationStatus: crawlerEventsHourly.verificationStatus,
  pathNormalized: crawlerEventsHourly.pathNormalized, status: crawlerEventsHourly.status, hits: crawlerEventsHourly.hits,
}).from(crawlerEventsHourly).all().sort((a, b) => `${a.botId}${a.tsHour}${a.pathNormalized}`.localeCompare(`${b.botId}${b.tsHour}${b.pathNormalized}`))

describe('reclassifyStoredTraffic', () => {
  it('moves the hours of a bot a rule now recognizes into that bot, claimed and without a page', async () => {
    const db = harness()
    unrecognized(db, { agentName: 'meta-webindexer', hits: 5, sampledUserAgent: WEBINDEXER, sampledPath: '/blog/a' })
    unrecognized(db, { agentName: 'exasearchbot', hits: 3, sampledUserAgent: EXA })
    unrecognized(db, { agentName: 'meta-externalfetcher', hits: 2, sampledUserAgent: FETCHER })
    unrecognized(db, { agentName: 'pinterestbot', hits: 4, sampledUserAgent: 'Mozilla/5.0 (compatible; Pinterestbot/1.0; +http://www.pinterest.com/bot.html)' })

    const result = await reclassifyStoredTraffic(db, { now: NOW })

    expect(result.unrecognized).toMatchObject({ examined: 4, moved: 3, movedHits: 10, renamed: 0, removed: 0 })
    expect(crawlerRows(db)).toEqual([
      { tsHour: HOUR, botId: 'exa-searchbot', verificationStatus: 'claimed_unverified', pathNormalized: UNRECORDED_TRAFFIC_PATH, status: 0, hits: 3 },
      { tsHour: HOUR, botId: 'meta-webindexer', verificationStatus: 'claimed_unverified', pathNormalized: UNRECORDED_TRAFFIC_PATH, status: 0, hits: 5 },
    ])
    expect(db.select({ botId: aiUserFetchEventsHourly.botId, pathNormalized: aiUserFetchEventsHourly.pathNormalized, hits: aiUserFetchEventsHourly.hits })
      .from(aiUserFetchEventsHourly).all()).toEqual([{ botId: 'meta-externalfetcher', pathNormalized: UNRECORDED_TRAFFIC_PATH, hits: 2 }])
    expect(unrecognizedRows(db)).toEqual([{ agentName: 'pinterestbot', hits: 4 }])
  })

  it('renames, merges and drops rows the current naming reads differently, and deletes Canonry tools', async () => {
    const db = harness()
    unrecognized(db, { agentName: 'twitterbot', hits: 7, sampledUserAgent: IMESSAGE })
    unrecognized(db, { agentName: 'imessage-link-preview', hits: 1, sampledUserAgent: IMESSAGE })
    unrecognized(db, { agentName: 'chrome', hits: 2, sampledUserAgent: 'Chrome Privacy Preserving Prefetch Proxy', sampledPath: '/.well-known/traffic-advice' })
    unrecognized(db, { agentName: 'http:', hits: 4, sampledUserAgent: 'http://example.com/wp-admin/install.php?step=1' })
    unrecognized(db, { agentName: 'http.rb', hits: 4, sampledUserAgent: 'http.rb/5.2.0' })
    unrecognized(db, { agentName: 'canonry', hits: 9, sampledUserAgent: LIVENESS })
    unrecognized(db, { agentName: 'pinterestbot', hits: 3, sampledUserAgent: 'Mozilla/5.0 (compatible; Pinterestbot/1.0; +http://www.pinterest.com/bot.html)' })

    const result = await reclassifyStoredTraffic(db, { now: NOW })

    expect(result.unrecognized).toMatchObject({ examined: 7, moved: 0, renamed: 2, removed: 3 })
    expect(unrecognizedRows(db)).toEqual([
      { agentName: 'chrome-privacy-preserving-prefetch-proxy', hits: 2 },
      { agentName: 'imessage-link-preview', hits: 8 },
      { agentName: 'pinterestbot', hits: 3 },
    ])
  })

  it('counts a reclassified sample only where nothing else counted it', async () => {
    const db = harness()
    // Before named agents were counted by name: the sample is the only record.
    sample(db, 'before', '2026-10-20T10:15:00.000Z', EXA, '/products/1')
    // Since then, a named agent's hits sit in the unrecognized rows instead.
    sample(db, 'named', '2026-11-01T05:10:00.000Z', EXA, '/products/2')
    // A static file was never named, so only the sample records it.
    sample(db, 'static', '2026-11-01T05:20:00.000Z', EXA, '/logo.png')
    sample(db, 'self', '2026-11-01T05:30:00.000Z', LIVENESS)
    sample(db, 'person', '2026-11-01T05:40:00.000Z', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36')

    const result = await reclassifyStoredTraffic(db, { now: NOW })

    expect(result.samples).toMatchObject({ examined: 5, reclassified: 3, counted: 2, removed: 1, byBot: { 'exa-searchbot': 3 } })
    expect(crawlerRows(db)).toEqual([
      { tsHour: '2026-10-20T10:00:00.000Z', botId: 'exa-searchbot', verificationStatus: 'claimed_unverified', pathNormalized: '/products/1', status: 200, hits: 1 },
      { tsHour: '2026-11-01T05:00:00.000Z', botId: 'exa-searchbot', verificationStatus: 'claimed_unverified', pathNormalized: '/logo.png', status: 200, hits: 1 },
    ])
    const stored = db.select({ id: rawEventSamples.id, eventType: rawEventSamples.eventType }).from(rawEventSamples).all()
      .sort((a, b) => a.id.localeCompare(b.id))
    expect(stored).toEqual([
      { id: 'before', eventType: 'crawler' },
      { id: 'named', eventType: 'crawler' },
      { id: 'person', eventType: 'unknown' },
      { id: 'static', eventType: 'crawler' },
    ])
  })

  it('reads the migration time as UTC whatever the process time zone', async () => {
    const zone = process.env.TZ
    process.env.TZ = 'America/New_York'
    onTestFinished(() => {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    })
    const db = harness()
    // A named agent at 03:30 UTC is counted by name, not by its sample.
    sample(db, 'named', '2026-11-01T03:30:00.000Z', EXA, '/products/2')

    const result = await reclassifyStoredTraffic(db, { now: NOW })

    expect(result.samples).toMatchObject({ reclassified: 1, counted: 0 })
    expect(crawlerRows(db)).toEqual([])
  })

  it('pages through more rows than one batch', async () => {
    const db = harness()
    for (let i = 0; i < 450; i++) sample(db, `s${i}`, '2026-10-20T10:15:00.000Z', EXA, `/p/${i}`)
    for (let i = 0; i < 450; i++) unrecognized(db, { agentName: 'exasearchbot', hits: 1, sampledUserAgent: EXA, tsHour: new Date(Date.parse('2026-11-01T02:00:00.000Z') + i * 3_600_000).toISOString() })

    const result = await reclassifyStoredTraffic(db, { now: NOW })

    expect(result.samples).toMatchObject({ examined: 450, reclassified: 450, counted: 450 })
    expect(result.unrecognized).toMatchObject({ examined: 450, moved: 450, movedHits: 450 })
    expect(unrecognizedRows(db)).toEqual([])
    expect(db.select({ eventType: rawEventSamples.eventType }).from(rawEventSamples).where(eq(rawEventSamples.eventType, 'unknown')).all()).toEqual([])
  })

  it('reports the same work on a dry run and writes nothing', async () => {
    const db = harness()
    unrecognized(db, { agentName: 'meta-webindexer', hits: 5, sampledUserAgent: WEBINDEXER })
    unrecognized(db, { agentName: 'canonry', hits: 9, sampledUserAgent: LIVENESS })
    sample(db, 'before', '2026-10-20T10:15:00.000Z', EXA)

    const result = await reclassifyStoredTraffic(db, { now: NOW, dryRun: true })

    expect(result).toMatchObject({ dryRun: true, samples: { reclassified: 1, counted: 1 }, unrecognized: { moved: 1, movedHits: 5, removed: 1 } })
    expect(crawlerRows(db)).toEqual([])
    expect(unrecognizedRows(db)).toHaveLength(2)
    expect(db.select({ eventType: rawEventSamples.eventType }).from(rawEventSamples).all()).toEqual([{ eventType: 'unknown' }])
  })

  it('finds nothing left to do on a second run', async () => {
    const db = harness()
    unrecognized(db, { agentName: 'meta-webindexer', hits: 5, sampledUserAgent: WEBINDEXER })
    unrecognized(db, { agentName: 'twitterbot', hits: 7, sampledUserAgent: IMESSAGE })
    sample(db, 'before', '2026-10-20T10:15:00.000Z', EXA)
    await reclassifyStoredTraffic(db, { now: NOW })
    const crawlerAfterFirst = crawlerRows(db)

    const second = await reclassifyStoredTraffic(db, { now: NOW })

    expect(second.samples).toMatchObject({ examined: 0, reclassified: 0 })
    expect(second.unrecognized).toMatchObject({ examined: 1, moved: 0, renamed: 0, removed: 0 })
    expect(crawlerRows(db)).toEqual(crawlerAfterFirst)
  })
})

const CLAUDE_USER = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +claude-user@anthropic.com)'
const SCAN_HOUR = '2026-11-01T03:00:00.000Z'

function agentHit(db: Db, row: { botId?: string, operator?: string, verificationStatus?: string, pathNormalized: string, status?: number, hits: number, tsHour?: string }) {
  db.insert(aiUserFetchEventsHourly).values({
    projectId: 'project', sourceId: 'source', tsHour: SCAN_HOUR, botId: 'claude-user', operator: 'Anthropic', verificationStatus: 'claimed_unverified',
    status: 200, sampledUserAgent: CLAUDE_USER, createdAt: CREATED, updatedAt: CREATED, ...row,
  }).run()
}

function agentRequest(db: Db, id: string, row: { correlationKey: string, ts: string, path: string, status?: number }) {
  db.insert(agentJourneyEvents).values({
    id, projectId: 'project', sourceId: 'source', sourceEventId: `source-${id}`, correlationBasis: 'ip-ua',
    agentId: 'claude-user', operator: 'Anthropic', product: 'Claude', verificationStatus: 'claimed_unverified', verificationManifest: null,
    trust: 'unknown', trustReasons: ['ip-outside-published-list'], host: 'harborline.example', method: 'GET', status: 200, latencyMs: null, createdAt: CREATED, ...row,
  }).run()
}

const agentRows = (db: Db) => db.select({ tsHour: aiUserFetchEventsHourly.tsHour, verificationStatus: aiUserFetchEventsHourly.verificationStatus, pathNormalized: aiUserFetchEventsHourly.pathNormalized, hits: aiUserFetchEventsHourly.hits })
  .from(aiUserFetchEventsHourly).all().sort((a, b) => `${a.tsHour}${a.pathNormalized}`.localeCompare(`${b.tsHour}${b.pathNormalized}`))
const fakeRows = (db: Db) => db.select({ botId: aiUserFetchLikelyFakeHourly.botId, reason: aiUserFetchLikelyFakeHourly.reason, hits: aiUserFetchLikelyFakeHourly.hits })
  .from(aiUserFetchLikelyFakeHourly).all().sort((a, b) => a.reason.localeCompare(b.reason))

describe('reclassifyStoredTraffic, AI agent traffic', () => {
  it('moves unverified hourly rows for a page scanners ask for into likely fake, with their provenance', async () => {
    const db = harness()
    agentHit(db, { pathNormalized: '/gcp-service.json', status: 302, hits: 3 })
    db.insert(aiUserFetchVerificationManifestsHourly).values({
      projectId: 'project', sourceId: 'source', tsHour: SCAN_HOUR, botId: 'claude-user', verificationStatus: 'claimed_unverified',
      pathNormalized: '/gcp-service.json', status: 302, manifestId: 'manifest', manifestJson: { id: 'manifest', source: 'list', version: '1' }, hits: 3, createdAt: CREATED, updatedAt: CREATED,
    }).run()
    // A verified request came through the operator's own IP: a person asked for it.
    agentHit(db, { botId: 'openai-chatgpt-user', operator: 'OpenAI', verificationStatus: 'verified', pathNormalized: '/.env', status: 404, hits: 1 })
    agentHit(db, { pathNormalized: '/pricing', hits: 4 })

    const preview = await reclassifyStoredTraffic(db, { now: NOW, dryRun: true })
    expect(preview.agentHits).toEqual({ examined: 2, moved: 1, movedHits: 3 })
    expect(agentRows(db)).toHaveLength(3)

    const result = await reclassifyStoredTraffic(db, { now: NOW })
    expect(result.agentHits).toEqual({ examined: 2, moved: 1, movedHits: 3 })
    expect(agentRows(db)).toEqual([
      { tsHour: SCAN_HOUR, verificationStatus: 'verified', pathNormalized: '/.env', hits: 1 },
      { tsHour: SCAN_HOUR, verificationStatus: 'claimed_unverified', pathNormalized: '/pricing', hits: 4 },
    ])
    expect(fakeRows(db)).toEqual([{ botId: 'claude-user', reason: 'scanner-path', hits: 3 }])
    expect(db.select().from(aiUserFetchVerificationManifestsHourly).all()).toEqual([])
  })

  it('removes a probing client\'s stored requests within the burst window and moves one hit each', async () => {
    const db = harness()
    // One scanner client (stored as IP and user agent) in the Journeys > Agents table.
    agentRequest(db, 'probe', { correlationKey: 'scanner', ts: '2026-11-01T03:57:53.194Z', path: '/firebase-credentials.json', status: 302 })
    agentRequest(db, 'redirect', { correlationKey: 'scanner', ts: '2026-11-01T03:57:53.630Z', path: '/404' })
    agentRequest(db, 'account', { correlationKey: 'scanner', ts: '2026-11-01T03:58:01.385Z', path: '/account' })
    agentRequest(db, 'much-later', { correlationKey: 'scanner', ts: '2026-11-01T04:20:00.000Z', path: '/pricing' })
    agentRequest(db, 'other-client', { correlationKey: 'person', ts: '2026-11-01T03:57:55.000Z', path: '/404' })
    agentHit(db, { pathNormalized: '/firebase-credentials.json', status: 302, hits: 1 })
    agentHit(db, { pathNormalized: '/:id', hits: 2 })
    agentHit(db, { pathNormalized: '/account', hits: 1 })
    agentHit(db, { pathNormalized: '/pricing', hits: 1, tsHour: '2026-11-01T04:00:00.000Z' })
    db.insert(agentJourneyCaptureDays).values({ projectId: 'project', sourceId: 'source', day: '2026-11-01', storedEvents: 5 }).run()

    const preview = await reclassifyStoredTraffic(db, { now: NOW, dryRun: true })
    expect(preview.agentRequests).toEqual({ examined: 5, probes: 1, removed: 3 })
    expect(db.select().from(agentJourneyEvents).all()).toHaveLength(5)

    const result = await reclassifyStoredTraffic(db, { now: NOW })
    expect(result.agentRequests).toEqual({ examined: 5, probes: 1, removed: 3 })
    expect(db.select({ id: agentJourneyEvents.id }).from(agentJourneyEvents).all().map(row => row.id).sort()).toEqual(['much-later', 'other-client'])
    expect(agentRows(db)).toEqual([
      { tsHour: SCAN_HOUR, verificationStatus: 'claimed_unverified', pathNormalized: '/:id', hits: 1 },
      { tsHour: '2026-11-01T04:00:00.000Z', verificationStatus: 'claimed_unverified', pathNormalized: '/pricing', hits: 1 },
    ])
    expect(fakeRows(db)).toEqual([
      { botId: 'claude-user', reason: 'scanner-burst', hits: 2 },
      { botId: 'claude-user', reason: 'scanner-path', hits: 1 },
    ])
    expect(db.select({ storedEvents: agentJourneyCaptureDays.storedEvents }).from(agentJourneyCaptureDays).get()).toEqual({ storedEvents: 2 })

    const second = await reclassifyStoredTraffic(db, { now: NOW })
    expect(second.agentRequests).toEqual({ examined: 2, probes: 0, removed: 0 })
    expect(second.agentHits).toMatchObject({ moved: 0 })
  })
})

describe('reclassifyStoredTrafficIfRulesChanged', () => {
  it('runs once per rules fingerprint and records each completed pass', async () => {
    const db = harness()
    unrecognized(db, { agentName: 'meta-webindexer', hits: 5, sampledUserAgent: WEBINDEXER })

    expect((await reclassifyStoredTrafficIfRulesChanged(db, { now: () => NOW })).ran).toBe(true)
    expect(unrecognizedRows(db)).toEqual([])
    const state = db.select().from(trafficReclassificationState).get()
    expect(state).toMatchObject({ id: 'default', completedAt: NOW })

    // Same rules: a newer row waits for the next change.
    unrecognized(db, { agentName: 'meta-webindexer', hits: 2, sampledUserAgent: WEBINDEXER, tsHour: '2026-11-01T03:00:00.000Z' })
    expect((await reclassifyStoredTrafficIfRulesChanged(db, { now: () => NOW })).ran).toBe(false)
    expect(unrecognizedRows(db)).toEqual([{ agentName: 'meta-webindexer', hits: 2 }])

    // Changed rules: the pass runs again.
    db.update(trafficReclassificationState).set({ fingerprint: 'older-rules' }).where(eq(trafficReclassificationState.id, 'default')).run()
    expect((await reclassifyStoredTrafficIfRulesChanged(db, { now: () => NOW })).ran).toBe(true)
    expect(unrecognizedRows(db)).toEqual([])
    expect(db.select({ hits: crawlerEventsHourly.hits }).from(crawlerEventsHourly)
      .where(and(eq(crawlerEventsHourly.botId, 'meta-webindexer'), eq(crawlerEventsHourly.tsHour, '2026-11-01T03:00:00.000Z'))).get()).toEqual({ hits: 2 })
  })

  it('records nothing when stopped, so the next start runs again', async () => {
    const db = harness()
    unrecognized(db, { agentName: 'meta-webindexer', hits: 5, sampledUserAgent: WEBINDEXER })

    expect((await reclassifyStoredTrafficIfRulesChanged(db, { now: () => NOW, shouldStop: () => true })).ran).toBe(false)
    expect(db.select().from(trafficReclassificationState).all()).toEqual([])
    expect(unrecognizedRows(db)).toEqual([{ agentName: 'meta-webindexer', hits: 5 }])
  })
})
