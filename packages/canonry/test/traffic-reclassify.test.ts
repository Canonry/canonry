import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
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
  crawlerVerificationManifestsHourly,
  journeyEvents,
  journeyVisitors,
  journeyVisits,
  migrate,
  migrationsTable,
  projects,
  rawEventSamples,
  trafficReclassificationState,
  trafficSources,
  unrecognizedAgentEventsHourly,
} from '@canonry/canonry-db'
import { BROWSER_AGENT_BOT_IDS, BROWSER_AGENT_REQUEST_RULES_VERSION } from '@canonry/canonry-integration-traffic'
import { addLogListener, type LogEntry } from '../src/logger.js'
import { reclassifyStoredTraffic, reclassifyStoredTrafficIfRulesChanged, startTrafficReclassification } from '../src/traffic-reclassify.js'

const CREATED = '2026-10-31T12:00:00.000Z'
const NOW = '2026-11-01T06:00:00.000Z'
const HOUR = '2026-11-01T02:00:00.000Z'
const SCAN_HOUR = '2026-11-01T03:00:00.000Z'
const WEBINDEXER = 'meta-webindexer/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)'
const FETCHER = 'meta-externalfetcher/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)'
const EXA = 'Mozilla/5.0 (compatible; ExaSearchBot/1.0; +https://crawler.exa.ai/)'
const IMESSAGE = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0'
const LIVENESS = 'Canonry site-liveness (+https://canonry.ai)'
const PINTEREST = 'Mozilla/5.0 (compatible; Pinterestbot/1.0; +http://www.pinterest.com/bot.html)'
const CLAUDEBOT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)'
const SEARCHBOT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)'
const INDEXBOT = 'Mozilla/5.0 (compatible; Claude-IndexBot/2.0)'
const CLAUDE_USER = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +claude-user@anthropic.com)'
const CLAUDE_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-Agent/1.0) Chrome/154.0.0.0 Safari/537.36'
const CANONRY_AUDIT = 'AINYC-AEO-Audit/1.0 (compatible; Claude-SearchBot/1.0; +https://canonry.ai)'
const OAI_SEARCHBOT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot'
const AMZN_SEARCHBOT = 'Mozilla/5.0 (compatible; Amzn-SearchBot/0.1; +https://developer.amazon.com/amazonbot)'
const ANTHROPIC_LIST = { id: 'anthropic#v1', source: 'https://claude.com/crawling/bots.json', version: 'v1' }
const AMAZONBOT_LIST = { id: 'amazonbot#v1', source: 'https://developer.amazon.com/amazonbot/ip-addresses/', version: 'v1' }

type Db = ReturnType<typeof createClient>
type Owner = { projectId?: string, sourceId?: string }

function harness(file = ':memory:'): Db {
  const db = createClient(file)
  migrate(db)
  onTestFinished(() => {
    db.$client.close()
  })
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

function addSource(db: Db, id: string, projectId = 'project') {
  db.insert(trafficSources).values({ id, projectId, sourceType: 'cloudflare', displayName: id, status: 'connected', createdAt: CREATED, updatedAt: CREATED }).run()
}

function unrecognized(db: Db, row: Owner & { agentName: string, hits: number, sampledUserAgent: string, tsHour?: string, sampledPath?: string }) {
  db.insert(unrecognizedAgentEventsHourly).values({
    projectId: 'project', sourceId: 'source', tsHour: HOUR, sampledPath: '/', createdAt: CREATED, updatedAt: CREATED, ...row,
  }).run()
}

function sample(db: Db, id: string, ts: string, userAgent: string, pathNormalized = '/', owner: Owner = {}) {
  db.insert(rawEventSamples).values({
    id, projectId: 'project', sourceId: 'source', ts, eventType: 'unknown', ipHash: null, userAgent, pathNormalized,
    status: 200, refererHost: null, classifierDetailsJson: { crawler: null, aiUserFetch: null, aiReferral: null }, createdAt: ts, ...owner,
  }).run()
}

/** A stored crawler hour, with a provenance row when `manifest` is given. */
function crawlerHour(db: Db, row: Owner & {
  botId: string, operator?: string, verificationStatus: string, pathNormalized: string, hits: number,
  sampledUserAgent: string | null, manifest?: typeof ANTHROPIC_LIST, status?: number, tsHour?: string,
}) {
  const { manifest, ...hour } = row
  const key = { projectId: 'project', sourceId: 'source', tsHour: HOUR, status: 200, ...hour }
  db.insert(crawlerEventsHourly).values({ operator: 'Anthropic', createdAt: CREATED, updatedAt: CREATED, ...key }).run()
  if (!manifest) return
  db.insert(crawlerVerificationManifestsHourly).values({
    projectId: key.projectId, sourceId: key.sourceId, tsHour: key.tsHour, botId: row.botId, verificationStatus: row.verificationStatus,
    pathNormalized: row.pathNormalized, status: key.status, manifestId: manifest.id, manifestJson: manifest, hits: row.hits, createdAt: CREATED, updatedAt: CREATED,
  }).run()
}

/** A stored crawler sample as ingest labels it; `details` adds to its classifier record. */
function crawlerSample(db: Db, id: string, userAgent: string, crawler: Record<string, unknown>, details: Record<string, unknown> = {}) {
  db.insert(rawEventSamples).values({
    id, projectId: 'project', sourceId: 'source', ts: '2026-11-01T02:30:00.000Z', eventType: 'crawler', ipHash: null, userAgent,
    pathNormalized: '/docs', status: 200, refererHost: null, classifierDetailsJson: { crawler, aiUserFetch: null, aiReferral: null, ...details },
    createdAt: '2026-11-01T02:30:00.000Z',
  }).run()
}

const provenanceRows = (db: Db) => db.select().from(crawlerVerificationManifestsHourly).all()
  .map(r => `${r.botId} ${r.verificationStatus} ${r.pathNormalized} ${r.manifestId} ${r.hits}`).sort()
const sampleDetails = (db: Db, id: string) => db.select({ details: rawEventSamples.classifierDetailsJson })
  .from(rawEventSamples).where(eq(rawEventSamples.id, id)).get()?.details
const sampleCrawler = (db: Db, id: string) => sampleDetails(db, id)?.crawler
const sampleTypes = (db: Db) => Object.fromEntries(db.select({ id: rawEventSamples.id, eventType: rawEventSamples.eventType }).from(rawEventSamples).all()
  .map(row => [row.id, row.eventType]))

const unrecognizedRows = (db: Db) => db.select({ agentName: unrecognizedAgentEventsHourly.agentName, hits: unrecognizedAgentEventsHourly.hits })
  .from(unrecognizedAgentEventsHourly).all().sort((a, b) => a.agentName.localeCompare(b.agentName))
const crawlerRows = (db: Db) => db.select({
  tsHour: crawlerEventsHourly.tsHour, botId: crawlerEventsHourly.botId, verificationStatus: crawlerEventsHourly.verificationStatus,
  pathNormalized: crawlerEventsHourly.pathNormalized, status: crawlerEventsHourly.status, hits: crawlerEventsHourly.hits,
}).from(crawlerEventsHourly).all().sort((a, b) => `${a.botId}${a.tsHour}${a.pathNormalized}`.localeCompare(`${b.botId}${b.tsHour}${b.pathNormalized}`))
const userFetchRows = (db: Db) => db.select({ tsHour: aiUserFetchEventsHourly.tsHour, botId: aiUserFetchEventsHourly.botId, pathNormalized: aiUserFetchEventsHourly.pathNormalized, hits: aiUserFetchEventsHourly.hits })
  .from(aiUserFetchEventsHourly).all().sort((a, b) => `${a.botId}${a.tsHour}${a.pathNormalized}`.localeCompare(`${b.botId}${b.tsHour}${b.pathNormalized}`))

/** The crawler re-key's report when it changes nothing. */
const NO_CRAWLER_CHANGES = {
  examined: 0,
  moved: 0,
  movedHits: 0,
  toUserFetch: 0,
  toUserFetchHits: 0,
  toUnrecognized: 0,
  toUnrecognizedHits: 0,
  removed: 0,
  removedHits: 0,
  unverifiedHits: 0,
  heldVerified: 0,
  heldVerifiedHits: 0,
  unknownBot: 0,
  samplesRelabeled: 0,
  samplesNowUnknown: 0,
  samplesRemoved: 0,
  byBot: {},
}

function agentHit(db: Db, row: Owner & { botId?: string, operator?: string, verificationStatus?: string, pathNormalized: string, status?: number, hits: number, tsHour?: string }) {
  db.insert(aiUserFetchEventsHourly).values({
    projectId: 'project', sourceId: 'source', tsHour: SCAN_HOUR, botId: 'claude-user', operator: 'Anthropic', verificationStatus: 'claimed_unverified',
    status: 200, sampledUserAgent: CLAUDE_USER, createdAt: CREATED, updatedAt: CREATED, ...row,
  }).run()
}

function agentRequest(db: Db, id: string, row: { correlationKey: string, ts: string, path: string, status?: number, agentId?: string, method?: string | null }) {
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
const agentRequestIds = (db: Db) => db.select({ id: agentJourneyEvents.id }).from(agentJourneyEvents).all().map(row => row.id).sort()
const olderCountUntil = (db: Db) => db.select({ until: trafficSources.aiUserFetchOlderCountUntil }).from(trafficSources)
  .where(eq(trafficSources.id, 'source')).get()?.until

describe('reclassifyStoredTraffic', () => {
  it('moves the hours of a bot a rule now recognizes into that bot, claimed and without a page', async () => {
    const db = harness()
    unrecognized(db, { agentName: 'meta-webindexer', hits: 5, sampledUserAgent: WEBINDEXER, sampledPath: '/blog/a' })
    unrecognized(db, { agentName: 'exasearchbot', hits: 3, sampledUserAgent: EXA })
    unrecognized(db, { agentName: 'meta-externalfetcher', hits: 2, sampledUserAgent: FETCHER })
    unrecognized(db, { agentName: 'pinterestbot', hits: 4, sampledUserAgent: PINTEREST })

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
    unrecognized(db, { agentName: 'pinterestbot', hits: 3, sampledUserAgent: PINTEREST })

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
    expect(sampleTypes(db)).toEqual({ before: 'crawler', named: 'crawler', person: 'unknown', static: 'crawler' })
  })

  it('replays a Claude-Agent sample as ingest counts it: a page load, never a file its page loaded, and a probe as likely fake', async () => {
    const db = harness()
    // Stored as unknown before Claude-Agent had a rule, and before named agents were counted by name.
    sample(db, 'page', '2026-10-20T10:05:00.000Z', CLAUDE_AGENT, '/pricing')
    sample(db, 'script', '2026-10-20T10:06:00.000Z', CLAUDE_AGENT, '/_next/static/chunks/app.js')
    sample(db, 'probe', '2026-10-20T10:07:00.000Z', CLAUDE_AGENT, '/api/.env')

    const result = await reclassifyStoredTraffic(db, { now: NOW })

    expect(result.samples).toEqual({ examined: 3, reclassified: 3, counted: 2, removed: 0, byBot: { 'claude-agent': 3 } })
    expect(userFetchRows(db)).toEqual([{ tsHour: '2026-10-20T10:00:00.000Z', botId: 'claude-agent', pathNormalized: '/pricing', hits: 1 }])
    expect(fakeRows(db)).toEqual([{ botId: 'claude-agent', reason: 'scanner-path', hits: 1 }])
    expect(sampleTypes(db)).toEqual({ page: 'ai_user_fetch', probe: 'ai_user_fetch', script: 'ai_user_fetch' })
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

  it('reports on a dry run exactly what a write run then does, and writes nothing', async () => {
    const db = harness()
    unrecognized(db, { agentName: 'meta-webindexer', hits: 5, sampledUserAgent: WEBINDEXER })
    // Moves into the AI user fetch hours a later step reads.
    unrecognized(db, { agentName: 'meta-externalfetcher', hits: 2, sampledUserAgent: FETCHER })
    unrecognized(db, { agentName: 'canonry', hits: 9, sampledUserAgent: LIVENESS })
    sample(db, 'before', '2026-10-20T10:15:00.000Z', EXA)
    crawlerHour(db, { botId: 'anthropic-claudebot', verificationStatus: 'verified', pathNormalized: '/docs', hits: 4, sampledUserAgent: SEARCHBOT, manifest: ANTHROPIC_LIST })
    const claudeBotLabel = { botId: 'anthropic-claudebot', operator: 'Anthropic', product: 'ClaudeBot', purpose: 'training', verificationStatus: 'verified' }
    crawlerSample(db, 'searchbot', SEARCHBOT, claudeBotLabel)
    // A browser agent's client probed: the burst removes its page load and
    // the file its page loaded, which the file step must not count again.
    const agent = { correlationKey: 'agent', agentId: 'claude-agent' }
    agentRequest(db, 'page', { ...agent, ts: '2026-11-01T03:30:00.000Z', path: '/pricing' })
    agentRequest(db, 'script', { ...agent, ts: '2026-11-01T03:33:00.000Z', path: '/_next/static/chunks/app.js' })
    agentRequest(db, 'probe', { ...agent, ts: '2026-11-01T03:35:00.000Z', path: '/.git/config' })

    const preview = await reclassifyStoredTraffic(db, { now: NOW, dryRun: true })

    expect(preview).toMatchObject({
      dryRun: true,
      samples: { reclassified: 1, counted: 1 },
      unrecognized: { moved: 2, movedHits: 7, removed: 1 },
      crawlers: { examined: 1, moved: 1, movedHits: 4, samplesRelabeled: 1 },
      agentHits: { examined: 0 },
      agentRequests: { examined: 3, probes: 1, removed: 3, pageResources: 0 },
    })
    expect(crawlerRows(db)).toEqual([
      { tsHour: HOUR, botId: 'anthropic-claudebot', verificationStatus: 'verified', pathNormalized: '/docs', status: 200, hits: 4 },
    ])
    expect(provenanceRows(db)).toEqual(['anthropic-claudebot verified /docs anthropic#v1 4'])
    expect(unrecognizedRows(db)).toHaveLength(3)
    expect(sampleTypes(db)).toEqual({ before: 'unknown', searchbot: 'crawler' })
    expect(sampleCrawler(db, 'searchbot')).toEqual(claudeBotLabel)
    expect(agentRequestIds(db)).toEqual(['page', 'probe', 'script'])

    expect(await reclassifyStoredTraffic(db, { now: NOW })).toEqual({ ...preview, dryRun: false })
  })

  it('takes no write lock on a dry run', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-reclassify-lock-'))
    onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }))
    const file = path.join(directory, 'canonry.db')
    const db = harness(file)
    // Work for every step.
    sample(db, 'before', '2026-10-20T10:15:00.000Z', EXA)
    unrecognized(db, { agentName: 'pinterestbot', hits: 4, sampledUserAgent: PINTEREST })
    crawlerHour(db, { botId: 'anthropic-claudebot', verificationStatus: 'claimed_unverified', pathNormalized: '/docs', hits: 4, sampledUserAgent: SEARCHBOT })
    crawlerSample(db, 'searchbot', SEARCHBOT, { botId: 'anthropic-claudebot', operator: 'Anthropic', product: 'ClaudeBot', purpose: 'training', verificationStatus: 'claimed_unverified' })
    agentHit(db, { pathNormalized: '/gcp-service.json', hits: 3 })
    agentRequest(db, 'probe', { correlationKey: 'scanner', ts: '2026-11-01T03:57:53.194Z', path: '/firebase-credentials.json' })
    agentRequest(db, 'script', { correlationKey: 'agent', agentId: 'claude-agent', ts: '2026-11-01T03:10:00.000Z', path: '/_next/static/chunks/app.js' })
    const at = '2026-10-20T10:00:00.000Z'
    db.insert(journeyVisitors).values({ projectId: 'project', visitorKey: 'calls-only', keyBasis: 'ip-ua', userAgent: 'Browser', firstAiAt: at, firstAiEngine: 'ChatGPT', lastAiAt: at, lastSeenAt: at, createdAt: CREATED, updatedAt: CREATED }).run()
    db.insert(journeyVisits).values({ id: 'visit', projectId: 'project', visitorKey: 'calls-only', sourceId: 'source', startedAt: at, endedAt: at, entryClass: 'ai', entryName: 'ChatGPT', entryHost: 'chatgpt.com', paid: false, landingPath: '/api/cart', requestCount: 1, pageCount: 0, createdAt: CREATED, updatedAt: CREATED }).run()
    db.insert(journeyEvents).values({ id: 'call', projectId: 'project', visitId: 'visit', sourceId: 'source', sourceEventId: 'call', ts: at, method: 'POST', path: '/api/cart', status: 200, kind: 'data', aiTouch: true, createdAt: CREATED }).run()
    // Another writer holds the lock, as a large backfill's commit does.
    const writer = createClient(file)
    onTestFinished(() => {
      writer.$client.close()
    })
    writer.$client.exec('BEGIN IMMEDIATE')
    onTestFinished(() => {
      if (writer.$client.inTransaction) writer.$client.exec('ROLLBACK')
    })
    db.$client.pragma('busy_timeout = 100')

    expect(await reclassifyStoredTraffic(db, { now: NOW, dryRun: true })).toMatchObject({
      samples: { reclassified: 1 },
      unrecognized: { examined: 1 },
      crawlers: { moved: 1, samplesRelabeled: 1 },
      agentHits: { moved: 1 },
      agentRequests: { removed: 1, pageResources: 1 },
      journeys: { visitors: 1 },
    })
  })

  it('finds nothing left to do on a second run', async () => {
    const db = harness()
    unrecognized(db, { agentName: 'meta-webindexer', hits: 5, sampledUserAgent: WEBINDEXER })
    unrecognized(db, { agentName: 'twitterbot', hits: 7, sampledUserAgent: IMESSAGE })
    sample(db, 'before', '2026-10-20T10:15:00.000Z', EXA)
    crawlerHour(db, { botId: 'anthropic-claudebot', verificationStatus: 'verified', pathNormalized: '/docs', hits: 4, sampledUserAgent: SEARCHBOT, manifest: ANTHROPIC_LIST })
    await reclassifyStoredTraffic(db, { now: NOW })
    const crawlerAfterFirst = crawlerRows(db)
    const provenanceAfterFirst = provenanceRows(db)

    const second = await reclassifyStoredTraffic(db, { now: NOW })

    expect(second.samples).toMatchObject({ examined: 0, reclassified: 0 })
    expect(second.unrecognized).toMatchObject({ examined: 1, moved: 0, renamed: 0, removed: 0 })
    // Meta's moved hour, Exa's counted sample, and Claude-SearchBot's re-keyed hour.
    expect(second.crawlers).toEqual({ ...NO_CRAWLER_CHANGES, examined: 3 })
    expect(crawlerRows(db)).toEqual(crawlerAfterFirst)
    expect(provenanceRows(db)).toEqual(provenanceAfterFirst)
  })

  it('skips and counts rows whose project is gone, and moves the rest', async () => {
    const db = harness()
    db.insert(projects).values({
      id: 'gone', name: 'old-site', displayName: 'Old', canonicalDomain: 'old.example',
      country: 'US', language: 'en', providers: [], createdAt: CREATED, updatedAt: CREATED,
    }).run()
    addSource(db, 'gone-source', 'gone')
    const gone = { projectId: 'gone', sourceId: 'gone-source' }
    // Rows each step would change, then the project deleted with foreign keys
    // off (the sqlite3 shell's default), so nothing cascades.
    sample(db, 'gone-sample', '2026-10-20T10:15:00.000Z', EXA, '/', gone)
    unrecognized(db, { ...gone, agentName: 'meta-webindexer', hits: 2, sampledUserAgent: WEBINDEXER })
    crawlerHour(db, { ...gone, botId: 'anthropic-claudebot', verificationStatus: 'claimed_unverified', pathNormalized: '/docs', hits: 3, sampledUserAgent: SEARCHBOT })
    agentHit(db, { ...gone, pathNormalized: '/.env', hits: 1 })
    crawlerHour(db, { botId: 'anthropic-claudebot', verificationStatus: 'claimed_unverified', pathNormalized: '/live', hits: 4, sampledUserAgent: SEARCHBOT })
    db.$client.pragma('foreign_keys = OFF')
    db.delete(projects).where(eq(projects.id, 'gone')).run()
    db.$client.pragma('foreign_keys = ON')

    const outcome = await reclassifyStoredTrafficIfRulesChanged(db, { now: () => NOW })

    expect(outcome).toMatchObject({ ran: true, result: { orphans: 4, crawlers: { moved: 1, movedHits: 4 } } })
    expect(crawlerRows(db)).toEqual([
      { tsHour: HOUR, botId: 'anthropic-claudebot', verificationStatus: 'claimed_unverified', pathNormalized: '/docs', status: 200, hits: 3 },
      { tsHour: HOUR, botId: 'claude-searchbot', verificationStatus: 'claimed_unverified', pathNormalized: '/live', status: 200, hits: 4 },
    ])
    expect(unrecognizedRows(db)).toEqual([{ agentName: 'meta-webindexer', hits: 2 }])
    expect(sampleTypes(db)).toEqual({ 'gone-sample': 'unknown' })
    expect(fakeRows(db)).toEqual([])
    expect(db.select({ completedAt: trafficReclassificationState.completedAt }).from(trafficReclassificationState).get()).toEqual({ completedAt: NOW })
  })
})

describe('reclassifyStoredTraffic, crawler hours ingest files elsewhere today', () => {
  it('moves hours an older version filed under ClaudeBot to Claude-SearchBot, keeping verification on the shared list', async () => {
    // Migration v221 moved these once. After a rollback, an older version
    // files Claude-SearchBot hits under ClaudeBot again; the pass re-splits
    // them when the newer rules start. Both rules check Anthropic's one list.
    const db = harness()
    crawlerHour(db, { botId: 'anthropic-claudebot', verificationStatus: 'verified', pathNormalized: '/docs', hits: 7, sampledUserAgent: SEARCHBOT, manifest: ANTHROPIC_LIST })
    // An hour the newer version already counted under the right rule takes the moved hits.
    crawlerHour(db, { botId: 'claude-searchbot', verificationStatus: 'verified', pathNormalized: '/docs', hits: 2, sampledUserAgent: SEARCHBOT, manifest: ANTHROPIC_LIST })
    crawlerHour(db, { botId: 'anthropic-claudebot', verificationStatus: 'claimed_unverified', pathNormalized: '/guide', hits: 3, sampledUserAgent: SEARCHBOT })
    // These stay: ClaudeBot's own hour, and an hour with no sample.
    crawlerHour(db, { botId: 'anthropic-claudebot', verificationStatus: 'verified', pathNormalized: '/pricing', hits: 5, sampledUserAgent: CLAUDEBOT, manifest: ANTHROPIC_LIST })
    crawlerHour(db, { botId: 'anthropic-claudebot', verificationStatus: 'verified', pathNormalized: '/about', hits: 2, sampledUserAgent: null })
    const claudeBotLabel = {
      botId: 'anthropic-claudebot', operator: 'Anthropic', product: 'ClaudeBot', purpose: 'training',
      verificationStatus: 'verified', verificationManifest: ANTHROPIC_LIST, matchedUserAgent: SEARCHBOT,
    }
    crawlerSample(db, 'searchbot', SEARCHBOT, claudeBotLabel)
    crawlerSample(db, 'claudebot', CLAUDEBOT, { ...claudeBotLabel, matchedUserAgent: CLAUDEBOT })

    const result = await reclassifyStoredTraffic(db, { now: NOW })

    expect(result.crawlers).toEqual({ ...NO_CRAWLER_CHANGES, examined: 4, moved: 2, movedHits: 10, samplesRelabeled: 1, byBot: { 'claude-searchbot': 10 } })
    expect(crawlerRows(db)).toEqual([
      { tsHour: HOUR, botId: 'anthropic-claudebot', verificationStatus: 'verified', pathNormalized: '/about', status: 200, hits: 2 },
      { tsHour: HOUR, botId: 'anthropic-claudebot', verificationStatus: 'verified', pathNormalized: '/pricing', status: 200, hits: 5 },
      { tsHour: HOUR, botId: 'claude-searchbot', verificationStatus: 'verified', pathNormalized: '/docs', status: 200, hits: 9 },
      { tsHour: HOUR, botId: 'claude-searchbot', verificationStatus: 'claimed_unverified', pathNormalized: '/guide', status: 200, hits: 3 },
    ])
    expect(provenanceRows(db)).toEqual([
      'anthropic-claudebot verified /pricing anthropic#v1 5',
      'claude-searchbot verified /docs anthropic#v1 9',
    ])
    expect(sampleCrawler(db, 'searchbot')).toEqual({ ...claudeBotLabel, botId: 'claude-searchbot', product: 'Claude-SearchBot', purpose: 'search' })
    expect(sampleCrawler(db, 'claudebot')).toEqual({ ...claudeBotLabel, matchedUserAgent: CLAUDEBOT })
  })

  it('files each hour where ingest files its user agent today, and leaves a newer release\'s bot ids alone', async () => {
    const db = harness()
    // A Claude bot no rule names, filed under ClaudeBot by an older version:
    // its pass moved the bot's unrecognized hours in, and its ingest counted
    // a page and a static file.
    crawlerHour(db, { botId: 'anthropic-claudebot', verificationStatus: 'claimed_unverified', pathNormalized: UNRECORDED_TRAFFIC_PATH, status: 0, hits: 12, sampledUserAgent: INDEXBOT })
    crawlerHour(db, { botId: 'anthropic-claudebot', verificationStatus: 'claimed_unverified', pathNormalized: '/feed', hits: 3, sampledUserAgent: INDEXBOT })
    crawlerHour(db, { botId: 'anthropic-claudebot', verificationStatus: 'claimed_unverified', pathNormalized: '/logo.png', hits: 2, sampledUserAgent: INDEXBOT })
    // Claude-User's link fetches and a probe with its user agent.
    crawlerHour(db, { botId: 'anthropic-claudebot', verificationStatus: 'claimed_unverified', pathNormalized: '/docs', hits: 4, sampledUserAgent: CLAUDE_USER })
    crawlerHour(db, { botId: 'anthropic-claudebot', verificationStatus: 'claimed_unverified', pathNormalized: '/.env', hits: 1, sampledUserAgent: CLAUDE_USER })
    // Canonry's own audit, which names a crawler.
    crawlerHour(db, { botId: 'claude-searchbot', verificationStatus: 'claimed_unverified', pathNormalized: '/audit', hits: 2, sampledUserAgent: CANONRY_AUDIT })
    // An id a newer release defines: this version files the agent under openai-searchbot.
    crawlerHour(db, { botId: 'oai-searchbot', operator: 'OpenAI', verificationStatus: 'verified', pathNormalized: '/docs', hits: 5, sampledUserAgent: OAI_SEARCHBOT })
    const claudeBotLabel = { botId: 'anthropic-claudebot', operator: 'Anthropic', product: 'ClaudeBot', purpose: 'training', verificationStatus: 'claimed_unverified', verificationManifest: null }
    const newerLabel = { botId: 'oai-searchbot', operator: 'OpenAI', product: 'OAI-SearchBot', purpose: 'search', verificationStatus: 'verified', verificationManifest: null }
    crawlerSample(db, 'indexbot', INDEXBOT, claudeBotLabel)
    crawlerSample(db, 'claude-user', CLAUDE_USER, claudeBotLabel)
    crawlerSample(db, 'audit', CANONRY_AUDIT, { ...claudeBotLabel, botId: 'claude-searchbot', product: 'Claude-SearchBot', purpose: 'search' })
    crawlerSample(db, 'newer', OAI_SEARCHBOT, newerLabel)

    const result = await reclassifyStoredTraffic(db, { now: NOW })

    expect(result.crawlers).toEqual({
      ...NO_CRAWLER_CHANGES,
      examined: 7,
      toUserFetch: 2,
      toUserFetchHits: 5,
      toUnrecognized: 2,
      toUnrecognizedHits: 15,
      removed: 1,
      removedHits: 2,
      unknownBot: 1,
      samplesRelabeled: 2,
      samplesNowUnknown: 1,
      samplesRemoved: 1,
      byBot: { 'claude-user': 5 },
    })
    expect(crawlerRows(db)).toEqual([
      { tsHour: HOUR, botId: 'anthropic-claudebot', verificationStatus: 'claimed_unverified', pathNormalized: '/logo.png', status: 200, hits: 2 },
      { tsHour: HOUR, botId: 'oai-searchbot', verificationStatus: 'verified', pathNormalized: '/docs', status: 200, hits: 5 },
    ])
    expect(unrecognizedRows(db)).toEqual([{ agentName: 'claude-indexbot', hits: 15 }])
    expect(userFetchRows(db)).toEqual([{ tsHour: HOUR, botId: 'claude-user', pathNormalized: '/docs', hits: 4 }])
    expect(fakeRows(db)).toEqual([{ botId: 'claude-user', reason: 'scanner-path', hits: 1 }])
    expect(sampleTypes(db)).toEqual({ 'claude-user': 'ai_user_fetch', indexbot: 'unknown', newer: 'crawler' })
    expect(sampleDetails(db, 'indexbot')).toEqual({ crawler: null, aiUserFetch: null, aiReferral: null })
    expect(sampleDetails(db, 'claude-user')).toMatchObject({
      crawler: null,
      aiUserFetch: { botId: 'claude-user', verificationStatus: 'claimed_unverified', verificationManifest: null },
      aiReferral: null,
    })
    expect(sampleCrawler(db, 'newer')).toEqual(newerLabel)

    const second = await reclassifyStoredTraffic(db, { now: NOW })
    expect(second.crawlers).toEqual({ ...NO_CRAWLER_CHANGES, examined: 2, unknownBot: 1 })
  })

  it('leaves a change that would make verified hits claimed to a caller that allows it', async () => {
    // Amazon publishes one list per bot. Stored traffic keeps no IP to check
    // against the new rule's list, so verification and provenance drop.
    const db = harness()
    crawlerHour(db, { botId: 'amazonbot', operator: 'Amazon', verificationStatus: 'verified', pathNormalized: '/docs', hits: 6, sampledUserAgent: AMZN_SEARCHBOT, manifest: AMAZONBOT_LIST })
    const amazonbotLabel = {
      botId: 'amazonbot', operator: 'Amazon', product: 'Amazonbot', purpose: 'training',
      verificationStatus: 'verified', verificationManifest: AMAZONBOT_LIST, matchedUserAgent: AMZN_SEARCHBOT,
    }
    crawlerSample(db, 'amzn', AMZN_SEARCHBOT, amazonbotLabel)

    const held = await reclassifyStoredTraffic(db, { now: NOW })

    expect(held.crawlers).toEqual({ ...NO_CRAWLER_CHANGES, examined: 1, heldVerified: 1, heldVerifiedHits: 6 })
    expect(crawlerRows(db)).toEqual([
      { tsHour: HOUR, botId: 'amazonbot', verificationStatus: 'verified', pathNormalized: '/docs', status: 200, hits: 6 },
    ])
    expect(provenanceRows(db)).toEqual(['amazonbot verified /docs amazonbot#v1 6'])
    expect(sampleCrawler(db, 'amzn')).toEqual(amazonbotLabel)

    const preview = await reclassifyStoredTraffic(db, { now: NOW, dryRun: true, allowVerificationLoss: true })
    const result = await reclassifyStoredTraffic(db, { now: NOW, allowVerificationLoss: true })

    expect(result.crawlers).toEqual({ ...NO_CRAWLER_CHANGES, examined: 1, moved: 1, movedHits: 6, unverifiedHits: 6, samplesRelabeled: 1, byBot: { 'amzn-searchbot': 6 } })
    expect(result).toEqual({ ...preview, dryRun: false })
    expect(crawlerRows(db)).toEqual([
      { tsHour: HOUR, botId: 'amzn-searchbot', verificationStatus: 'claimed_unverified', pathNormalized: '/docs', status: 200, hits: 6 },
    ])
    expect(provenanceRows(db)).toEqual([])
    expect(sampleCrawler(db, 'amzn')).toEqual({
      ...amazonbotLabel, botId: 'amzn-searchbot', product: 'Amzn-SearchBot', purpose: 'search',
      verificationStatus: 'claimed_unverified', verificationManifest: null,
    })
  })

  it('relabels a sample on its stored label alone, keeping what this version does not read', async () => {
    const db = harness()
    crawlerHour(db, { botId: 'anthropic-claudebot', verificationStatus: 'verified', pathNormalized: '/docs', hits: 6, sampledUserAgent: SEARCHBOT, manifest: ANTHROPIC_LIST })
    const label = {
      botId: 'anthropic-claudebot', operator: 'Anthropic', product: 'ClaudeBot', purpose: 'training', verificationStatus: 'verified',
      verificationMethod: 'ip-range', verificationManifest: { ...ANTHROPIC_LIST, creationTime: '2026-10-01T00:00:00Z' }, matchedUserAgent: SEARCHBOT,
    }
    // Values a newer release could write, which today's sample reads reject.
    crawlerSample(db, 'referral', SEARCHBOT, label, { aiReferral: { evidenceType: 'referrer' } })
    crawlerSample(db, 'fetch', SEARCHBOT, label, { aiUserFetch: { verificationStatus: 'verified_rdns' } })

    const result = await reclassifyStoredTraffic(db, { now: NOW })

    expect(result.crawlers).toMatchObject({ moved: 1, samplesRelabeled: 2 })
    const relabeled = { ...label, botId: 'claude-searchbot', product: 'Claude-SearchBot', purpose: 'search' }
    expect(sampleDetails(db, 'referral')).toEqual({ crawler: relabeled, aiUserFetch: null, aiReferral: { evidenceType: 'referrer' } })
    expect(sampleDetails(db, 'fetch')).toEqual({ crawler: relabeled, aiUserFetch: { verificationStatus: 'verified_rdns' }, aiReferral: null })
  })

  it('reads every span of rowids for misfiled hours and samples', async () => {
    const db = harness()
    const hour = db.$client.prepare(`INSERT INTO crawler_events_hourly (rowid, project_id, source_id, ts_hour, bot_id, operator, verification_status, path_normalized, status, hits, sampled_user_agent, created_at, updated_at)
      VALUES (?, 'project', 'source', ?, 'anthropic-claudebot', 'Anthropic', 'claimed_unverified', ?, 200, ?, ?, ?, ?)`)
    // The first row, and one past two whole spans of the grouped read.
    hour.run(1, HOUR, '/a', 2, SEARCHBOT, CREATED, CREATED)
    hour.run(120_000, HOUR, '/b', 3, SEARCHBOT, CREATED, CREATED)
    const label = JSON.stringify({ crawler: { botId: 'anthropic-claudebot', operator: 'Anthropic', product: 'ClaudeBot', purpose: 'training', verificationStatus: 'claimed_unverified' }, aiUserFetch: null, aiReferral: null })
    db.$client.prepare(`INSERT INTO raw_event_samples (rowid, id, project_id, source_id, ts, event_type, user_agent, path_normalized, status, classifier_details_json, created_at)
      VALUES (120000, 'far', 'project', 'source', ?, 'crawler', ?, '/b', 200, ?, ?)`).run(HOUR, SEARCHBOT, label, CREATED)

    const result = await reclassifyStoredTraffic(db, { now: NOW })

    expect(result.crawlers).toEqual({ ...NO_CRAWLER_CHANGES, examined: 2, moved: 2, movedHits: 5, samplesRelabeled: 1, byBot: { 'claude-searchbot': 5 } })
    expect(crawlerRows(db).map(row => `${row.botId} ${row.pathNormalized} ${row.hits}`)).toEqual(['claude-searchbot /a 2', 'claude-searchbot /b 3'])
    expect(sampleCrawler(db, 'far')).toMatchObject({ botId: 'claude-searchbot' })
  })
})

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
    expect(preview.agentRequests).toEqual({ examined: 5, probes: 1, removed: 3, pageResources: 0 })
    expect(db.select().from(agentJourneyEvents).all()).toHaveLength(5)

    const result = await reclassifyStoredTraffic(db, { now: NOW })
    expect(result.agentRequests).toEqual({ examined: 5, probes: 1, removed: 3, pageResources: 0 })
    expect(agentRequestIds(db)).toEqual(['much-later', 'other-client'])
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
    expect(second.agentRequests).toEqual({ examined: 2, probes: 0, removed: 0, pageResources: 0 })
    expect(second.agentHits).toMatchObject({ moved: 0 })
  })

  it.each([
    { counted: 'only its page loads', olderCountUntil: null, contactHits: 1, after: { contactHits: 1, burstHits: 0 } },
    { counted: 'every request before its older count ended', olderCountUntil: '2026-11-01T04:00:00.000Z', contactHits: 2, after: { contactHits: 1, burstHits: 1 } },
  ])('moves a burst hit for a browser agent\'s form post only where the post was counted: $counted', async ({ olderCountUntil, contactHits, after }) => {
    const db = harness()
    db.update(trafficSources).set({ aiUserFetchOlderCountUntil: olderCountUntil }).where(eq(trafficSources.id, 'source')).run()
    const agent = { correlationKey: 'agent', agentId: 'claude-agent' }
    agentRequest(db, 'page', { ...agent, ts: '2026-11-01T03:05:00.000Z', path: '/contact' })
    agentRequest(db, 'form-post', { ...agent, ts: '2026-11-01T03:30:00.000Z', path: '/contact', method: 'POST' })
    // A request older trust rules stored, which today's call a probe.
    agentRequest(db, 'probe', { ...agent, ts: '2026-11-01T03:35:00.000Z', path: '/.git/config' })
    agentHit(db, { botId: 'claude-agent', pathNormalized: '/contact', hits: contactHits })

    const result = await reclassifyStoredTraffic(db, { now: NOW })

    expect(result.agentRequests).toEqual({ examined: 3, probes: 1, removed: 2, pageResources: 0 })
    expect(agentRequestIds(db)).toEqual(['page'])
    expect(agentRows(db)).toEqual([{ tsHour: SCAN_HOUR, verificationStatus: 'claimed_unverified', pathNormalized: '/contact', hits: after.contactHits }])
    expect(fakeRows(db)).toEqual(after.burstHits > 0 ? [{ botId: 'claude-agent', reason: 'scanner-burst', hits: after.burstHits }] : [])
  })
})

describe('reclassifyStoredTraffic, browser agents', () => {
  it('marks the older count of a source up to the end of the Claude-Agent hours it moves', async () => {
    const db = harness()
    unrecognized(db, { agentName: 'claude-agent', hits: 6, sampledUserAgent: CLAUDE_AGENT })
    unrecognized(db, { agentName: 'claude-agent', hits: 1, sampledUserAgent: CLAUDE_AGENT, tsHour: '2026-11-01T01:00:00.000Z' })

    const preview = await reclassifyStoredTraffic(db, { now: NOW, dryRun: true })
    expect(preview.unrecognized).toMatchObject({ moved: 2, movedHits: 7, byBot: { 'claude-agent': 7 } })
    expect(olderCountUntil(db)).toBeNull()

    await reclassifyStoredTraffic(db, { now: NOW })
    expect(userFetchRows(db)).toEqual([
      { tsHour: '2026-11-01T01:00:00.000Z', botId: 'claude-agent', pathNormalized: UNRECORDED_TRAFFIC_PATH, hits: 1 },
      { tsHour: HOUR, botId: 'claude-agent', pathNormalized: UNRECORDED_TRAFFIC_PATH, hits: 6 },
    ])
    // The end of the latest hour it moved.
    expect(olderCountUntil(db)).toBe('2026-11-01T03:00:00.000Z')

    // A later hour moves the mark on, up to the pass's start while that hour runs.
    unrecognized(db, { agentName: 'claude-agent', hits: 2, sampledUserAgent: CLAUDE_AGENT, tsHour: '2026-11-01T05:00:00.000Z' })
    await reclassifyStoredTraffic(db, { now: '2026-11-01T05:30:00.000Z' })
    expect(olderCountUntil(db)).toBe('2026-11-01T05:30:00.000Z')

    // An earlier hour leaves a later mark as it is.
    unrecognized(db, { agentName: 'claude-agent', hits: 3, sampledUserAgent: CLAUDE_AGENT, tsHour: '2026-10-31T20:00:00.000Z' })
    await reclassifyStoredTraffic(db, { now: NOW })
    expect(olderCountUntil(db)).toBe('2026-11-01T05:30:00.000Z')
  })

  it('leaves the source unmarked when it moves a link fetcher\'s hours', async () => {
    const db = harness()
    unrecognized(db, { agentName: 'meta-externalfetcher', hits: 2, sampledUserAgent: FETCHER })
    await reclassifyStoredTraffic(db, { now: NOW })
    expect(olderCountUntil(db)).toBeNull()
  })

  it('removes the stored requests capture leaves out of a browser agent\'s journey, keeping its page loads, form posts and failures', async () => {
    const db = harness()
    const stored = (id: string, row: { agentId?: string, method?: string | null, path: string, status?: number }) => agentRequest(db, id, {
      correlationKey: 'agent', ts: '2026-11-01T03:10:00.000Z', ...row,
    })
    const browser = { agentId: 'claude-agent' }
    stored('page', { ...browser, path: '/pricing' })
    stored('form-post', { ...browser, method: 'POST', path: '/contact' })
    stored('image-optimizer', { ...browser, path: '/_next/image' })
    stored('manifest', { ...browser, path: '/site.webmanifest' })
    stored('beacon', { ...browser, method: 'POST', path: '/_vercel/insights/view' })
    stored('data', { ...browser, path: '/api/plans' })
    stored('head', { ...browser, method: 'HEAD', path: '/pricing' })
    // A blocked file and a failed data call stay visible with their error.
    stored('blocked-script', { ...browser, path: '/_next/static/chunks/app.js', status: 403 })
    stored('failed-data', { ...browser, path: '/api/quote', status: 500 })
    stored('google-page', { agentId: 'google-agent', path: '/menu' })
    stored('google-script', { agentId: 'google-agent', path: '/wp-content/themes/site/app.js' })
    // A link fetcher's data call is its own read.
    stored('link-fetcher-data', { path: '/api/plans' })
    db.insert(agentJourneyCaptureDays).values({ projectId: 'project', sourceId: 'source', day: '2026-11-01', storedEvents: 12 }).run()

    const preview = await reclassifyStoredTraffic(db, { now: NOW, dryRun: true })
    expect(preview.agentRequests.pageResources).toBe(6)
    expect(agentRequestIds(db)).toHaveLength(12)

    const result = await reclassifyStoredTraffic(db, { now: NOW })
    expect(result.agentRequests.pageResources).toBe(6)
    expect(agentRequestIds(db)).toEqual(['blocked-script', 'failed-data', 'form-post', 'google-page', 'link-fetcher-data', 'page'])
    expect(db.select({ storedEvents: agentJourneyCaptureDays.storedEvents }).from(agentJourneyCaptureDays).get()).toEqual({ storedEvents: 6 })
    expect((await reclassifyStoredTraffic(db, { now: NOW })).agentRequests.pageResources).toBe(0)
  })

  it('keeps a browser agent\'s hours for the app files its pages load out of likely fake', async () => {
    const db = harness()
    agentHit(db, { botId: 'claude-agent', pathNormalized: '/appsettings.json', hits: 3 })
    agentHit(db, { botId: 'google-agent', operator: 'Google', pathNormalized: '/.auth/me', hits: 2 })
    // The same files are probes from a link fetcher, and /wp-login.php from anyone.
    agentHit(db, { pathNormalized: '/appsettings.json', hits: 4 })
    agentHit(db, { botId: 'claude-agent', pathNormalized: '/wp-login.php', hits: 1 })

    const result = await reclassifyStoredTraffic(db, { now: NOW })

    expect(result.agentHits).toEqual({ examined: 4, moved: 2, movedHits: 5 })
    expect(db.select({ botId: aiUserFetchEventsHourly.botId, pathNormalized: aiUserFetchEventsHourly.pathNormalized }).from(aiUserFetchEventsHourly).all()
      .sort((a, b) => a.botId.localeCompare(b.botId))).toEqual([
      { botId: 'claude-agent', pathNormalized: '/appsettings.json' },
      { botId: 'google-agent', pathNormalized: '/.auth/me' },
    ])
    expect(fakeRows(db).sort((a, b) => a.botId.localeCompare(b.botId))).toEqual([
      { botId: 'claude-agent', reason: 'scanner-path', hits: 1 },
      { botId: 'claude-user', reason: 'scanner-path', hits: 4 },
    ])
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

  it('marks every source holding browser-agent hours when the browser-agent request rules changed since the last pass', async () => {
    const db = harness()
    for (const id of ['edge-2', 'links', 'sdk']) addSource(db, id)
    // Counted hours, the latest still running when the pass starts.
    agentHit(db, { botId: 'claude-agent', pathNormalized: '/pricing', hits: 3, tsHour: '2026-11-01T03:00:00.000Z' })
    agentHit(db, { botId: 'claude-agent', pathNormalized: '/menu', hits: 1, tsHour: '2026-11-01T06:00:00.000Z' })
    // Trust rules before v3 sent whole browser-agent sessions to likely fake.
    db.insert(aiUserFetchLikelyFakeHourly).values({
      projectId: 'project', sourceId: 'edge-2', tsHour: '2026-10-30T10:00:00.000Z', botId: 'google-agent', operator: 'Google',
      reason: 'scanner-burst', hits: 4, createdAt: CREATED, updatedAt: CREATED,
    }).run()
    // A link fetcher's hours, and a tool named like Claude-Agent that no rule names, mark nothing.
    agentHit(db, { sourceId: 'links', pathNormalized: '/pricing', hits: 2 })
    unrecognized(db, { sourceId: 'sdk', agentName: 'claude-agent-sdk', hits: 5, sampledUserAgent: 'claude-agent-sdk/0.1' })
    const marks = () => Object.fromEntries(db.select({ id: trafficSources.id, until: trafficSources.aiUserFetchOlderCountUntil }).from(trafficSources).all()
      .map(row => [row.id, row.until]))
    const rerunAfter = (resultJson: Record<string, unknown>) => db.update(trafficReclassificationState)
      .set({ fingerprint: 'older-rules', resultJson }).where(eq(trafficReclassificationState.id, 'default')).run()
    const recorded = { version: BROWSER_AGENT_REQUEST_RULES_VERSION, botIds: [...BROWSER_AGENT_BOT_IDS].sort() }

    // An older version ran the last pass, so its state records no request rules.
    db.insert(trafficReclassificationState).values({ id: 'default', fingerprint: 'older-rules', completedAt: CREATED, resultJson: {} }).run()
    expect(await reclassifyStoredTrafficIfRulesChanged(db, { now: () => NOW })).toMatchObject({ ran: true, olderCountsMarked: 2 })
    expect(marks()).toEqual({ source: NOW, 'edge-2': '2026-10-30T11:00:00.000Z', links: null, sdk: null })
    expect(db.select().from(trafficReclassificationState).get()?.resultJson).toMatchObject({ browserAgentRequestRules: recorded })

    // The same request rules: another rules change marks nothing.
    db.update(trafficSources).set({ aiUserFetchOlderCountUntil: '2026-11-01T01:00:00.000Z' }).where(eq(trafficSources.id, 'source')).run()
    rerunAfter({ browserAgentRequestRules: recorded })
    expect(await reclassifyStoredTrafficIfRulesChanged(db, { now: () => NOW })).toMatchObject({ ran: true, olderCountsMarked: 0 })
    expect(marks().source).toBe('2026-11-01T01:00:00.000Z')

    // Another set of browser agents marks again, keeping a mark already later.
    db.update(trafficSources).set({ aiUserFetchOlderCountUntil: '2026-11-01T00:00:00.000Z' }).where(eq(trafficSources.id, 'edge-2')).run()
    rerunAfter({ browserAgentRequestRules: { ...recorded, botIds: ['google-agent'] } })
    expect(await reclassifyStoredTrafficIfRulesChanged(db, { now: () => NOW })).toMatchObject({ ran: true, olderCountsMarked: 1 })
    expect(marks()).toEqual({ source: NOW, 'edge-2': '2026-11-01T00:00:00.000Z', links: null, sdk: null })
  })
})

describe('startTrafficReclassification', () => {
  it('leaves the moves that would make verified hits claimed, and logs them', async () => {
    const db = harness()
    crawlerHour(db, { botId: 'amazonbot', operator: 'Amazon', verificationStatus: 'verified', pathNormalized: '/docs', hits: 6, sampledUserAgent: AMZN_SEARCHBOT, manifest: AMAZONBOT_LIST })
    const entries: LogEntry[] = []
    const removeListener = addLogListener((entry) => {
      if (entry.module === 'TrafficReclassify') entries.push(entry)
    })
    onTestFinished(() => {
      removeListener()
    })
    onTestFinished(startTrafficReclassification({ db, delayMs: 0 }))

    await vi.waitFor(() => expect(entries.map(entry => entry.action)).toContain('traffic-reclassify.completed'))

    expect(entries.find(entry => entry.action === 'traffic-reclassify.verified-moves-held')).toMatchObject({ level: 'warn', rows: 1, hits: 6 })
    expect(crawlerRows(db)).toEqual([
      { tsHour: HOUR, botId: 'amazonbot', verificationStatus: 'verified', pathNormalized: '/docs', status: 200, hits: 6 },
    ])
  })
})
