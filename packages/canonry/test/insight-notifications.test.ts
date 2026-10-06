import crypto from 'node:crypto'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { deliverWebhook } from '@ainyc/canonry-api-routes'
import { auditLog, createClient, insightNotifyState, migrate, notifications, projects, runs } from '@ainyc/canonry-db'
import type { AnalysisResult, Insight } from '@ainyc/canonry-intelligence'
import type { InsightWebhookPayload } from '@ainyc/canonry-contracts'
import { Notifier } from '../src/notifier.js'

// Keep the dispatcher, retry loop, payload assembly and SQLite receipts real;
// replace only destination lookup and the external HTTP delivery boundary.
vi.mock('@ainyc/canonry-api-routes', async importOriginal => {
  const actual = await importOriginal<typeof import('@ainyc/canonry-api-routes')>()
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

const NOW = '2026-09-28T00:00:00.000Z'
const TITLE = 'A Hotel: "santa monica hotels" impressions down 79% month-over-month (2026-06→2026-07)'
function finding(title = TITLE, overrides: Partial<Insight> = {}): Insight {
  return {
    id: crypto.randomUUID(), type: 'gbp-keyword-drop', severity: 'high', title,
    query: 'locations/harborline', provider: 'google', createdAt: NOW, ...overrides,
  }
}

function harness() {
  const db = createClient(':memory:')
  migrate(db)
  onTestFinished(() => db.$client.close())
  const projectId = 'insight-project'
  db.insert(projects).values({
    id: projectId, name: 'harborline', displayName: 'Harborline', canonicalDomain: 'harborline.example',
    country: 'US', language: 'en', providers: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(notifications).values({
    id: 'insight-webhook', projectId, channel: 'webhook',
    config: { url: 'https://hooks.example/insights', events: ['insight.high', 'insight.critical'] },
    enabled: true, createdAt: NOW, updatedAt: NOW,
  }).run()
  async function dispatch(insights: Insight[]) {
    const runId = crypto.randomUUID()
    db.insert(runs).values({ id: runId, projectId, status: 'completed', createdAt: NOW, finishedAt: NOW }).run()
    const result: AnalysisResult = {
      insights, regressions: [], gains: [], firstCitations: [], providerPickups: [],
      persistentGaps: [], competitorGains: [], competitorLosses: [],
      health: { overallCitedRate: 0, overallMentionRate: 0, totalPairs: 0, citedPairs: 0, mentionedPairs: 0, providerBreakdown: {} },
    }
    // A fresh dispatcher proves deduplication survives later runs and instances.
    await new Notifier(db, 'https://canonry.test').dispatchInsightWebhooks(runId, projectId, result)
  }
  return {
    db, dispatch,
    sent: () => vi.mocked(deliverWebhook).mock.calls.map(([, payload]) => payload as InsightWebhookPayload),
    receipts: () => db.select().from(insightNotifyState).all(),
  }
}

it('delivers the same finding once across runs despite a drifting percentage', async () => {
  const { dispatch, sent, receipts } = harness()
  const first = finding()
  await dispatch([first])
  await dispatch([finding(TITLE.replace('79%', '80%'))])

  expect(sent()).toHaveLength(1)
  expect(sent()[0]).toMatchObject({ event: 'insight.high', insights: [{ id: first.id, title: TITLE }] })
  expect(receipts()).toHaveLength(1)
})

it('delivers an advanced comparison window as new news while retaining dates in the identity', async () => {
  const { dispatch, sent, receipts } = harness()
  const nextTitle = TITLE.replace('2026-06→2026-07', '2026-07→2026-08')
  await dispatch([finding()])
  await dispatch([finding(nextTitle)])

  expect(sent().map(payload => payload.insights.map(insight => insight.title))).toEqual([[TITLE], [nextTitle]])
  expect(receipts()).toHaveLength(2)
})

it('re-notifies only when magnitude deepens by more than twenty points', async () => {
  const { dispatch, sent, receipts } = harness()
  await dispatch([finding(TITLE.replace('79%', '30%'))])
  await dispatch([finding(TITLE.replace('79%', '50%'))])
  await dispatch([finding(TITLE.replace('79%', '51%'))])

  expect(sent().map(payload => payload.insights[0]!.title)).toEqual([
    TITLE.replace('79%', '30%'), TITLE.replace('79%', '51%'),
  ])
  expect(receipts()).toMatchObject([{ magnitude: 51 }])
})

it('deduplicates a finding without a percentage and stores its absent magnitude', async () => {
  const { dispatch, sent, receipts } = harness()
  await dispatch([finding('A Hotel is missing a description', { type: 'gbp-description-missing' })])
  await dispatch([finding('A Hotel is missing a description', { type: 'gbp-description-missing' })])

  expect(sent()).toHaveLength(1)
  expect(receipts()).toMatchObject([{ magnitude: null }])
})

it('delivers two different keywords for the same location and insight type', async () => {
  const { dispatch, sent, receipts } = harness()
  const otherTitle = TITLE.replace('santa monica hotels', 'bayport hotels')
  await dispatch([finding()])
  await dispatch([finding(otherTitle)])

  expect(sent().map(payload => payload.insights[0]!.title)).toEqual([TITLE, otherTitle])
  expect(receipts()).toHaveLength(2)
})

it('delivers severity escalation again and then suppresses the same critical finding', async () => {
  const { dispatch, sent, receipts } = harness()
  await dispatch([finding()])
  await dispatch([finding(TITLE, { severity: 'critical' })])
  await dispatch([finding(TITLE, { severity: 'critical' })])

  expect(sent().map(payload => payload.event)).toEqual(['insight.high', 'insight.critical'])
  expect(receipts()).toMatchObject([{ severity: 'critical' }])
})

it('keeps a failed delivery eligible until a later run is accepted', async () => {
  vi.useFakeTimers()
  vi.mocked(deliverWebhook).mockResolvedValue({ status: 503, error: 'fixture unavailable' })
  const { db, dispatch, receipts } = harness()
  const failed = dispatch([finding()])
  await vi.runAllTimersAsync()
  await failed

  expect(deliverWebhook).toHaveBeenCalledTimes(3)
  expect(db.select().from(auditLog).all()).toMatchObject([{ action: 'notification.failed', entityId: 'insight-webhook' }])
  expect(receipts()).toEqual([])

  vi.mocked(deliverWebhook).mockResolvedValue({ status: 204, error: null })
  await dispatch([finding()])
  expect(deliverWebhook).toHaveBeenCalledTimes(4)
  expect(receipts()).toHaveLength(1)
  expect(db.select().from(auditLog).all().map(entry => entry.action)).toEqual(['notification.failed', 'notification.sent'])
})

it.each(['/insights', '/backup'])('attempts every subscribed hook and remembers an acceptance from %s', async acceptedPath => {
  vi.useFakeTimers()
  vi.mocked(deliverWebhook).mockImplementation(async target => ({
    status: target.url.pathname === acceptedPath ? 204 : 503, error: null,
  }))
  const { db, dispatch, receipts } = harness()
  db.insert(notifications).values({
    id: 'backup-webhook', projectId: 'insight-project', channel: 'webhook',
    config: { url: 'https://hooks.example/backup', events: ['insight.high'] },
    enabled: true, createdAt: NOW, updatedAt: NOW,
  }).run()
  const dispatched = dispatch([finding()])
  await vi.runAllTimersAsync()
  await dispatched

  const attempted = vi.mocked(deliverWebhook).mock.calls.map(([target]) => target.url.pathname)
  expect(attempted.filter(path => path === acceptedPath)).toHaveLength(1)
  expect(attempted.filter(path => path !== acceptedPath)).toHaveLength(3)
  expect(receipts()).toHaveLength(1)
  expect(db.select().from(auditLog).all().map(entry => entry.action).sort()).toEqual(['notification.failed', 'notification.sent'])

  await dispatch([finding()])
  expect(deliverWebhook).toHaveBeenCalledTimes(4)
})
