import crypto from 'node:crypto'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { deliverWebhook } from '@ainyc/canonry-api-routes'
import { auditLog, createClient, migrate, notifications, projects, runs } from '@ainyc/canonry-db'
import type { AnalysisResult } from '@ainyc/canonry-intelligence'
import { Notifier } from '../src/notifier.js'

// Scheduled delivery must apply the same loopback rule as creating and testing
// the webhook, so a localhost hook that `canonry serve` accepted is not refused
// later when an event fires. The real egress gate runs; only the HTTP send is
// replaced.
vi.mock('@ainyc/canonry-api-routes', async importOriginal => {
  const actual = await importOriginal<typeof import('@ainyc/canonry-api-routes')>()
  return { ...actual, deliverWebhook: vi.fn() }
})

beforeEach(() => {
  vi.mocked(deliverWebhook).mockReset().mockResolvedValue({ status: 204, error: null })
})

const NOW = '2026-10-08T00:00:00.000Z'

function harness(url: string) {
  const db = createClient(':memory:')
  migrate(db)
  onTestFinished(() => db.$client.close())
  const projectId = 'loopback-project'
  db.insert(projects).values({
    id: projectId, name: 'loopback', displayName: 'Loopback', canonicalDomain: 'loopback.example',
    country: 'US', language: 'en', providers: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(notifications).values({
    id: 'local-hook', projectId, channel: 'webhook',
    config: { url, events: ['insight.high'] }, enabled: true, createdAt: NOW, updatedAt: NOW,
  }).run()
  const runId = crypto.randomUUID()
  db.insert(runs).values({ id: runId, projectId, status: 'completed', createdAt: NOW, finishedAt: NOW }).run()
  const result: AnalysisResult = {
    insights: [{
      id: crypto.randomUUID(), type: 'gbp-keyword-drop', severity: 'high', title: 'Impressions down 40%',
      query: 'locations/loopback', provider: 'google', createdAt: NOW,
    }],
    regressions: [], gains: [], firstCitations: [], providerPickups: [],
    persistentGaps: [], competitorGains: [], competitorLosses: [],
    health: { overallCitedRate: 0, overallMentionRate: 0, totalPairs: 0, citedPairs: 0, mentionedPairs: 0, providerBreakdown: {} },
  }
  return {
    dispatch: (notifier: Notifier) => notifier.dispatchInsightWebhooks(runId, projectId, result),
    notifier: (opts?: { allowLoopbackWebhooks?: boolean }) => new Notifier(db, 'http://localhost:4100', opts),
    receipts: () => db.select().from(auditLog).all().map(row => ({ action: row.action, diff: JSON.parse(row.diff!) as { error: string | null } })),
  }
}

it('refuses a loopback webhook by default and records why', async () => {
  const { dispatch, notifier, receipts } = harness('http://127.0.0.1:4555/hook')
  await dispatch(notifier())

  expect(deliverWebhook).not.toHaveBeenCalled()
  expect(receipts()).toEqual([{
    action: 'notification.failed',
    diff: { event: 'insight.high', error: 'SSRF: "url" must not resolve to a private or loopback address' },
  }])
})

it('delivers to a loopback webhook when the server allows loopback webhooks', async () => {
  const { dispatch, notifier, receipts } = harness('http://127.0.0.1:4555/hook')
  await dispatch(notifier({ allowLoopbackWebhooks: true }))

  expect(deliverWebhook).toHaveBeenCalledOnce()
  expect(vi.mocked(deliverWebhook).mock.calls[0]![0]).toMatchObject({ address: '127.0.0.1', family: 4 })
  expect(receipts()).toEqual([{ action: 'notification.sent', diff: { event: 'insight.high', error: null } }])
})

it('still refuses the metadata address when loopback webhooks are allowed', async () => {
  const { dispatch, notifier, receipts } = harness('http://169.254.169.254/latest/meta-data')
  await dispatch(notifier({ allowLoopbackWebhooks: true }))

  expect(deliverWebhook).not.toHaveBeenCalled()
  expect(receipts().map(row => row.action)).toEqual(['notification.failed'])
})
