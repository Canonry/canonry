import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentJourneyEvents, agentScannerClients, aiUserFetchEventsHourly, aiUserFetchLikelyFakeHourly, createClient, migrate, projects, trafficSources } from '@canonry/canonry-db'
import { TrafficEventConfidences, TrafficEvidenceKinds, TrafficSourceTypes, type NormalizedTrafficRequest } from '@canonry/canonry-contracts'
import { saveScannerBursts } from '../src/agent-scanner-bursts.js'
import { writeTrafficEventBatch } from '../src/traffic-event-ingest.js'

const NOW = '2026-11-01T03:57:53.000Z'
const SECRET = 'scanner-burst-secret-used-only-in-tests'
const CLAUDE_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +claude-user@anthropic.com)'
const PERPLEXITY_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)'
// RFC 5737 documentation space: no publisher can list it.
const SCANNER_IP = '203.0.113.9'
const OTHER_IP = '198.51.100.7'
const at = (seconds: number) => new Date(Date.parse(NOW) + seconds * 1000).toISOString()

function event(id: string, seconds: number, overrides: Partial<NormalizedTrafficRequest> = {}): NormalizedTrafficRequest {
  return {
    sourceType: TrafficSourceTypes.cloudflare, evidenceKind: TrafficEvidenceKinds['raw-request'], confidence: TrafficEventConfidences.observed,
    eventId: id, observedAt: at(seconds), method: 'GET', requestUrl: null, host: 'example.com', path: '/',
    queryString: null, status: 200, userAgent: CLAUDE_UA, remoteIp: SCANNER_IP, referer: null,
    latencyMs: null, requestSizeBytes: null, responseSizeBytes: null, providerResource: { type: 'cloudflare_worker', labels: {} }, providerLabels: {}, ...overrides,
  }
}

describe('scanner bursts at ingest', () => {
  let db: ReturnType<typeof createClient>
  const push = (events: NormalizedTrafficRequest[], options: { withSecret?: boolean } = {}) => writeTrafficEventBatch({
    db, projectId: 'project', sourceId: 'source', events, receivedAt: events[0]!.observedAt,
    receiptTtlMs: 600_000, sampleLimit: 100, sourceUpdate: { lastSyncedAt: events[0]!.observedAt },
    journeyKeySecret: options.withSecret === false ? undefined : SECRET,
    validateSource: () => {},
  })
  const fakeCounts = () => db.select({ botId: aiUserFetchLikelyFakeHourly.botId, reason: aiUserFetchLikelyFakeHourly.reason, hits: aiUserFetchLikelyFakeHourly.hits })
    .from(aiUserFetchLikelyFakeHourly).orderBy(aiUserFetchLikelyFakeHourly.botId, aiUserFetchLikelyFakeHourly.reason).all()

  beforeEach(() => {
    db = createClient(':memory:')
    migrate(db)
    db.insert(projects).values({ id: 'project', name: 'example', displayName: 'Example', canonicalDomain: 'https://example.com', country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW }).run()
    db.insert(trafficSources).values({ id: 'source', projectId: 'project', sourceType: TrafficSourceTypes.cloudflare, displayName: 'source', status: 'connected', createdAt: NOW, updatedAt: NOW }).run()
  })
  afterEach(() => db.$client.close())

  it('counts the same IP\'s later agent requests as likely fake, one push at a time', () => {
    expect(push([event('probe', 0, { path: '/firebase-credentials.json', status: 302 })])).toMatchObject({ aiUserFetchHits: 0, aiUserFetchLikelyFakeHits: 1 })
    expect(push([event('redirect', 0.4, { path: '/404' })])).toMatchObject({ aiUserFetchHits: 0, aiUserFetchLikelyFakeHits: 1 })
    expect(push([event('as-perplexity', 1, { path: '/userfiles/x', userAgent: PERPLEXITY_UA })])).toMatchObject({ aiUserFetchHits: 0, aiUserFetchLikelyFakeHits: 1 })
    // Another client, and the scanner's IP once the window has passed, count as before.
    expect(push([event('other-ip', 2, { remoteIp: OTHER_IP, path: '/pricing' })])).toMatchObject({ aiUserFetchHits: 1, aiUserFetchLikelyFakeHits: 0 })
    expect(push([event('much-later', 11 * 60, { path: '/pricing' })])).toMatchObject({ aiUserFetchHits: 1, aiUserFetchLikelyFakeHits: 0 })

    expect(fakeCounts()).toEqual([
      { botId: 'claude-user', reason: 'scanner-burst', hits: 1 },
      { botId: 'claude-user', reason: 'scanner-path', hits: 1 },
      { botId: 'perplexity-user', reason: 'scanner-path', hits: 1 },
    ])
    expect(db.select({ path: agentJourneyEvents.path }).from(agentJourneyEvents).orderBy(agentJourneyEvents.ts).all()).toEqual([{ path: '/pricing' }, { path: '/pricing' }])
    expect(db.select({ tsHour: aiUserFetchEventsHourly.tsHour, hits: aiUserFetchEventsHourly.hits }).from(aiUserFetchEventsHourly).orderBy(aiUserFetchEventsHourly.tsHour).all())
      .toEqual([{ tsHour: '2026-11-01T03:00:00.000Z', hits: 1 }, { tsHour: '2026-11-01T04:00:00.000Z', hits: 1 }])
    // The client is a keyed hash: the address itself is never stored.
    const clients = db.select().from(agentScannerClients).all()
    expect(clients).toEqual([expect.objectContaining({ firstProbeAt: at(0), lastProbeAt: at(1) })])
    expect(clients[0]!.clientKey).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(clients)).not.toContain(SCANNER_IP)
  })

  it('finds bursts within a batch without the install secret, and stores nothing', () => {
    expect(push([event('probe', 0, { path: '/.env' }), event('sibling', 1)], { withSecret: false })).toMatchObject({ aiUserFetchHits: 0, aiUserFetchLikelyFakeHits: 2 })
    expect(db.select().from(agentScannerClients).all()).toEqual([])
    // Nothing carries over to the next push.
    expect(push([event('next', 2)], { withSecret: false })).toMatchObject({ aiUserFetchHits: 1, aiUserFetchLikelyFakeHits: 0 })
  })

  it('keeps each client\'s newest window and drops windows two days old', () => {
    const save = (firstProbeAt: string, lastProbeAt: string, now = NOW) => saveScannerBursts(db, {
      projectId: 'project', sourceId: 'source', now,
      windows: new Map([['client', { firstProbeAt: Date.parse(firstProbeAt), lastProbeAt: Date.parse(lastProbeAt) }]]),
    })
    const stored = () => db.select({ firstProbeAt: agentScannerClients.firstProbeAt, lastProbeAt: agentScannerClients.lastProbeAt }).from(agentScannerClients).all()
    save(at(0), at(60))
    // An older window, as a backfill finds, never replaces it.
    save(at(-3600), at(-3500))
    expect(stored()).toEqual([{ firstProbeAt: at(0), lastProbeAt: at(60) }])
    save(at(0), at(120))
    expect(stored()).toEqual([{ firstProbeAt: at(0), lastProbeAt: at(120) }])
    saveScannerBursts(db, { projectId: 'project', sourceId: 'source', windows: new Map(), now: at(3 * 86_400) })
    expect(stored()).toEqual([])
  })
})
