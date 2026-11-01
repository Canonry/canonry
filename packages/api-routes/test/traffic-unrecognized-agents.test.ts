import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import {
  TrafficEventConfidences,
  TrafficEvidenceKinds,
  TrafficSourceTypes,
  type NormalizedTrafficRequest,
} from '@canonry/canonry-contracts'
import { createClient, crawlerEventsHourly, migrate, projects, trafficSources, unrecognizedAgentEventsHourly } from '@canonry/canonry-db'
import { apiRoutes } from '../src/index.js'
import { writeTrafficEventBatch } from '../src/traffic-event-ingest.js'

const date = '2026-10-10T12:00:00.000Z'
const url = '/api/v1/projects/example/traffic/unrecognized-agents'

function event(id: string, userAgent: string, observedAt: string, path = '/rooms'): NormalizedTrafficRequest {
  return {
    sourceType: TrafficSourceTypes.cloudflare,
    evidenceKind: TrafficEvidenceKinds['raw-request'],
    confidence: TrafficEventConfidences.observed,
    eventId: id,
    observedAt,
    method: 'GET',
    requestUrl: `https://example.example${path}`,
    host: 'example.example',
    path,
    queryString: null,
    status: 200,
    userAgent,
    remoteIp: '203.0.113.10',
    referer: null,
    latencyMs: null,
    requestSizeBytes: null,
    responseSizeBytes: null,
    providerResource: { type: 'cloudflare_worker', labels: {} },
    providerLabels: {},
  }
}

describe('unrecognized bots and agents', () => {
  let db: ReturnType<typeof createClient>
  let app: ReturnType<typeof Fastify>

  function row(overrides: Partial<typeof unrecognizedAgentEventsHourly.$inferInsert>) {
    db.insert(unrecognizedAgentEventsHourly).values({
      projectId: 'project', sourceId: 'source', tsHour: date, agentName: 'exampleagent', hits: 1,
      sampledUserAgent: 'ExampleAgent/2.0', sampledPath: '/', createdAt: date, updatedAt: date, ...overrides,
    }).run()
  }

  function ingest(events: NormalizedTrafficRequest[], receivedAt = '2026-10-10T14:00:00.000Z') {
    return writeTrafficEventBatch({
      db, projectId: 'project', sourceId: 'source', events, receivedAt, receiptTtlMs: 10 * 60_000, sampleLimit: 100,
      validateSource: () => {}, sourceUpdate: { lastSyncedAt: receivedAt, updatedAt: receivedAt },
    })
  }

  beforeEach(async () => {
    db = createClient(':memory:')
    migrate(db)
    for (const [id, name, sourceId] of [['project', 'example', 'source'], ['other', 'other', 'foreign']]) {
      db.insert(projects).values({ id: id!, name: name!, displayName: name!, canonicalDomain: `${name}.example`, country: 'US', language: 'en', createdAt: date, updatedAt: date }).run()
      db.insert(trafficSources).values({ id: sourceId!, projectId: id!, sourceType: 'cloudflare', displayName: 'Edge', status: 'connected', createdAt: date, updatedAt: date }).run()
    }
    db.insert(trafficSources).values({ id: 'second', projectId: 'project', sourceType: 'vercel', displayName: 'Vercel', status: 'connected', createdAt: date, updatedAt: date }).run()
    app = Fastify()
    await app.register(apiRoutes, { db, skipAuth: true })
    await app.ready()
  })
  afterEach(async () => { await app.close(); db.$client.close() })

  it('stores agents no rule recognizes by hour and name, summing later batches', () => {
    ingest([
      event('a', 'ExampleAgent/2.0', '2026-10-10T12:05:00.000Z'),
      event('b', 'ExampleAgent/2.0', '2026-10-10T12:45:00.000Z', '/rooms/42'),
      event('c', 'Mozilla/5.0 GPTBot/1.2', '2026-10-10T12:10:00.000Z'),
      event('d', 'curl/8.7.1', '2026-10-10T12:15:00.000Z'),
      event('e', 'ExampleAgent/2.0', '2026-10-10T12:20:00.000Z', '/logo.png'),
    ])
    ingest([event('f', 'ExampleAgent/2.1', '2026-10-10T12:50:00.000Z')], '2026-10-10T14:05:00.000Z')
    // A redelivered event is not counted twice.
    ingest([event('f', 'ExampleAgent/2.1', '2026-10-10T12:50:00.000Z')], '2026-10-10T14:06:00.000Z')

    expect(db.select().from(unrecognizedAgentEventsHourly).all()).toEqual([expect.objectContaining({
      projectId: 'project', sourceId: 'source', tsHour: '2026-10-10T12:00:00.000Z', agentName: 'exampleagent',
      hits: 3, sampledUserAgent: 'ExampleAgent/2.1', sampledPath: '/rooms',
    })])
    expect(db.select().from(crawlerEventsHourly).all()).toHaveLength(1)
  })

  it('sums names across sources and hours, busiest first, with the latest sample', async () => {
    row({ tsHour: '2026-10-08T09:00:00.000Z', hits: 2, sampledUserAgent: 'ExampleAgent/1.0', sampledPath: '/old' })
    row({ tsHour: '2026-10-10T12:00:00.000Z', hits: 3, sampledUserAgent: 'ExampleAgent/2.0', sampledPath: '/new' })
    row({ sourceId: 'second', tsHour: '2026-10-10T11:00:00.000Z', hits: 4 })
    row({ agentName: 'otherbot', hits: 1, sampledUserAgent: 'OtherBot/1.0', sampledPath: '/a' })
    row({ projectId: 'other', sourceId: 'foreign', agentName: 'foreignbot', hits: 50 })

    const response = await app.inject({ method: 'GET', url: `${url}?since=2026-10-10&until=2026-10-11T00:00:00Z` })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      scope: { project: 'example', sourceId: null },
      windowStart: '2026-10-10T00:00:00.000Z',
      windowEnd: '2026-10-11T00:00:00.000Z',
      totalAgents: 2,
      totalHits: 8,
      agents: [
        // First seen reaches before the window; the sample is the latest hour's.
        { name: 'exampleagent', hits: 7, firstSeenAt: '2026-10-08T09:00:00.000Z', lastSeenAt: '2026-10-10T12:00:00.000Z', sampleUserAgent: 'ExampleAgent/2.0', samplePath: '/new', sourceIds: ['second', 'source'] },
        { name: 'otherbot', hits: 1, firstSeenAt: date, lastSeenAt: date, sampleUserAgent: 'OtherBot/1.0', samplePath: '/a', sourceIds: ['source'] },
      ],
    })
  })

  it('filters by source, honors the limit and rejects an inverted window', async () => {
    row({ hits: 3 })
    row({ sourceId: 'second', hits: 4 })
    row({ agentName: 'otherbot', hits: 1 })

    const bySource = (await app.inject({ method: 'GET', url: `${url}?sourceId=second&since=2026-10-10&until=2026-10-11` })).json()
    expect(bySource.scope).toEqual({ project: 'example', sourceId: 'second' })
    expect(bySource.agents.map((agent: { name: string, hits: number }) => [agent.name, agent.hits])).toEqual([['exampleagent', 4]])

    const limited = (await app.inject({ method: 'GET', url: `${url}?limit=1&since=2026-10-10&until=2026-10-11` })).json()
    expect(limited.totalAgents).toBe(2)
    expect(limited.agents.map((agent: { name: string }) => agent.name)).toEqual(['exampleagent'])

    const inverted = await app.inject({ method: 'GET', url: `${url}?since=2026-10-11&until=2026-10-10` })
    expect(inverted.statusCode).toBe(400)
  })

  it('defaults to the last 30 days', async () => {
    const recent = new Date(Date.now() - 2 * 86_400_000)
    recent.setUTCMinutes(0, 0, 0)
    row({ tsHour: recent.toISOString(), hits: 2 })
    row({ agentName: 'stalebot', tsHour: new Date(Date.now() - 40 * 86_400_000).toISOString(), hits: 9 })
    const body = (await app.inject({ method: 'GET', url })).json()
    expect(body.agents.map((agent: { name: string }) => agent.name)).toEqual(['exampleagent'])
  })
})
