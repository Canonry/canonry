import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { deliverWebhook } from '@canonry/canonry-api-routes'
import { createClient, migrate, notifications, projects, trafficSources, unrecognizedAgentEventsHourly, unrecognizedAgentNotifyState } from '@canonry/canonry-db'
import type { UnrecognizedAgentWebhookPayload } from '@canonry/canonry-contracts'
import { Notifier } from '../src/notifier.js'

// Keep the dispatcher, payload assembly and SQLite state real; replace only
// destination lookup and the external HTTP delivery boundary.
vi.mock('@canonry/canonry-api-routes', async importOriginal => {
  const actual = await importOriginal<typeof import('@canonry/canonry-api-routes')>()
  return {
    ...actual,
    resolveWebhookTarget: vi.fn(async (url: string) => ({
      ok: true,
      target: { url: new URL(url), address: '203.0.113.1', family: 4 },
    })),
    deliverWebhook: vi.fn(),
  }
})

beforeEach(() => {
  vi.mocked(deliverWebhook).mockReset().mockResolvedValue({ status: 204, error: null })
})
afterEach(() => vi.useRealTimers())

const NOW = Date.parse('2026-10-31T12:00:00.000Z')
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString()

function harness(events: string[] = ['traffic.agent.discovered'], { recordedSince = 8 * 24 }: { recordedSince?: number | null } = {}) {
  const db = createClient(':memory:')
  migrate(db)
  onTestFinished(() => db.$client.close())
  const created = new Date(NOW).toISOString()
  db.insert(projects).values({
    id: 'project', name: 'harborline', displayName: 'Harborline', canonicalDomain: 'harborline.example',
    country: 'US', language: 'en', providers: [], createdAt: created, updatedAt: created,
  }).run()
  db.insert(trafficSources).values({ id: 'source', projectId: 'project', sourceType: 'cloudflare', displayName: 'Edge', status: 'connected', createdAt: created, updatedAt: created }).run()
  db.insert(notifications).values({
    id: 'webhook', projectId: 'project', channel: 'webhook',
    config: { url: 'https://hooks.example/bots', events }, enabled: true, createdAt: created, updatedAt: created,
  }).run()
  const hits = (agentName: string, tsHour: string, count: number, sampledUserAgent = `${agentName}/1.0`) => {
    db.insert(unrecognizedAgentEventsHourly).values({
      projectId: 'project', sourceId: 'source', tsHour, agentName, hits: count, sampledUserAgent, sampledPath: '/rooms', createdAt: created, updatedAt: created,
    }).run()
  }
  // Recording started long enough ago that the first-week baseline has passed.
  if (recordedSince !== null) hits('anchorbot', hoursAgo(recordedSince), 1)
  return {
    db,
    hits(agentName: string, tsHour: string, count: number, sampledUserAgent = `${agentName}/1.0`) {
      hits(agentName, tsHour, count, sampledUserAgent)
    },
    // A fresh dispatcher each pass proves the decisions survive restarts.
    dispatch: (at = NOW) => new Notifier(db, 'https://canonry.test').dispatchUnrecognizedAgentAlerts(at),
    sent: () => vi.mocked(deliverWebhook).mock.calls.map(([, payload]) => payload as UnrecognizedAgentWebhookPayload),
    states: () => Object.fromEntries(db.select().from(unrecognizedAgentNotifyState).all().map(row => [row.agentName, row.state])),
  }
}

it('sends new busy names once, in one message per project, and quieter ones when they reach 3 hits', async () => {
  const h = harness()
  h.hits('exampleagent', hoursAgo(5), 2, 'ExampleAgent/1.0')
  h.hits('exampleagent', hoursAgo(2), 3, 'ExampleAgent/2.0')
  h.hits('quietbot', hoursAgo(1), 1)

  expect(await h.dispatch()).toBe(1)
  expect(h.sent()).toEqual([{
    source: 'canonry',
    event: 'traffic.agent.discovered',
    project: { name: 'harborline', canonicalDomain: 'harborline.example' },
    agents: [{ name: 'exampleagent', hits: 5, firstSeenAt: hoursAgo(5), lastSeenAt: hoursAgo(2), sampleUserAgent: 'ExampleAgent/2.0', samplePath: '/rooms' }],
    dashboardUrl: 'https://canonry.test/projects/harborline',
  }])

  // Nothing new: no second message.
  h.hits('exampleagent', hoursAgo(1), 40)
  expect(await h.dispatch()).toBe(0)
  expect(h.sent()).toHaveLength(1)

  h.hits('quietbot', hoursAgo(0), 2)
  expect(await h.dispatch()).toBe(1)
  expect(h.sent().at(-1)!.agents.map(agent => agent.name)).toEqual(['quietbot'])
  expect(h.states()).toEqual({ anchorbot: 'stale', exampleagent: 'sent', quietbot: 'sent' })
})

it('never alerts a name first seen before the 7-day window', async () => {
  const h = harness()
  h.hits('oldbot', hoursAgo(8 * 24), 50)
  h.hits('oldbot', hoursAgo(1), 5)
  expect(await h.dispatch()).toBe(0)
  expect(h.sent()).toEqual([])
  expect(h.states()).toEqual({ anchorbot: 'stale', oldbot: 'stale' })
})

it('skips names when nothing subscribes, so subscribing later starts from new names', async () => {
  const h = harness(['run.failed'])
  h.hits('exampleagent', hoursAgo(2), 5)
  expect(await h.dispatch()).toBe(0)
  expect(h.sent()).toEqual([])
  expect(h.states()).toEqual({ anchorbot: 'stale', exampleagent: 'skipped' })

  h.db.update(notifications).set({ config: { url: 'https://hooks.example/bots', events: ['traffic.agent.discovered'] } }).run()
  h.hits('newbot', hoursAgo(1), 3)
  await h.dispatch()
  expect(h.sent().map(payload => payload.agents.map(agent => agent.name))).toEqual([['newbot']])
})

it('retries names when every delivery fails, until one is accepted', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  const h = harness()
  h.hits('exampleagent', hoursAgo(2), 5)
  vi.mocked(deliverWebhook).mockResolvedValue({ status: 500, error: null })
  const failed = h.dispatch()
  await vi.runAllTimersAsync()
  expect(await failed).toBe(0)
  expect(h.states()).toEqual({ anchorbot: 'stale' })

  vi.mocked(deliverWebhook).mockResolvedValue({ status: 204, error: null })
  expect(await h.dispatch()).toBe(1)
  expect(h.states()).toEqual({ anchorbot: 'stale', exampleagent: 'sent' })
})

it('treats bots from the first week of recorded traffic as a baseline, then alerts new ones', async () => {
  const h = harness(['traffic.agent.discovered'], { recordedSince: null })
  h.hits('exampleagent', hoursAgo(5), 10)
  expect(await h.dispatch()).toBe(0)
  expect(h.sent()).toEqual([])
  expect(h.states()).toEqual({ exampleagent: 'baseline' })

  const eightDaysLater = NOW + 8 * 86_400_000
  h.hits('laterbot', new Date(eightDaysLater - 3_600_000).toISOString(), 5)
  expect(await h.dispatch(eightDaysLater)).toBe(1)
  expect(h.sent().map(payload => payload.agents.map(agent => agent.name))).toEqual([['laterbot']])
})
