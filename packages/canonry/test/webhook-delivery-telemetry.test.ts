import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deliverWebhook, resolveWebhookTarget } from '@ainyc/canonry-api-routes'
import type { WebhookPayload } from '@ainyc/canonry-contracts'
import { createClient, migrate, projects } from '@ainyc/canonry-db'

const trackEvent = vi.hoisted(() => vi.fn())
vi.mock('../src/telemetry.js', () => ({ trackEvent }))
vi.mock('@ainyc/canonry-api-routes', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ainyc/canonry-api-routes')>(),
  resolveWebhookTarget: vi.fn(),
  deliverWebhook: vi.fn(),
}))

const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXX'
const PAYLOAD: WebhookPayload = {
  source: 'canonry',
  event: 'run.completed',
  project: { name: 'acme', canonicalDomain: 'acme.example' },
  run: { id: 'run-1', status: 'completed', finishedAt: '2026-10-09T00:00:00.000Z' },
  transitions: [],
  dashboardUrl: 'https://canonry.example/projects/acme',
}

async function notifierHarness() {
  const { Notifier } = await import('../src/notifier.js')
  const db = createClient(':memory:')
  migrate(db)
  db.insert(projects).values({
    id: 'proj-1', name: 'acme', displayName: 'Acme', canonicalDomain: 'acme.example', country: 'US', language: 'en',
    createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z',
  }).run()
  const notifier = new Notifier(db, 'https://canonry.example')
  const send = (url = SLACK) => (notifier as unknown as {
    sendWebhook: (url: string, payload: unknown, notificationId: string, projectId: string, secret: string | null) => Promise<boolean>
  }).sendWebhook(url, PAYLOAD, 'hook-1', 'proj-1', null)
  return { db, send }
}

/** Run a send while fake time walks through its retry delays. */
async function settle(sending: Promise<boolean>): Promise<boolean> {
  await vi.runAllTimersAsync()
  return sending
}

const deliveries = () => trackEvent.mock.calls.filter(([event]) => event === 'feature.completed')

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-09T00:00:00.000Z') })
  trackEvent.mockReset()
  vi.mocked(resolveWebhookTarget).mockReset().mockImplementation(async url => ({
    ok: true, target: { url: new URL(url), address: '203.0.113.1', family: 4 },
  }))
  vi.mocked(deliverWebhook).mockReset()
})
afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
})

describe('webhook delivery outcomes', () => {
  it('reports a delivery once, after its last attempt, with the destination kind and attempts', async () => {
    const h = await notifierHarness()
    vi.mocked(deliverWebhook).mockResolvedValueOnce({ status: 204, error: null })
    expect(await settle(h.send())).toBe(true)
    vi.mocked(deliverWebhook)
      .mockResolvedValueOnce({ status: 503, error: null })
      .mockResolvedValueOnce({ status: 0, error: 'socket hang up' })
      .mockResolvedValueOnce({ status: 200, error: null })
    expect(await settle(h.send())).toBe(true)

    const delivered = { feature: 'webhooks', operation: 'deliver', status: 'succeeded', surface: 'system', target: 'slack', eventType: 'run.completed', statusClass: '2xx' }
    expect(deliveries()).toEqual([
      ['feature.completed', { ...delivered, counts: { attempts: 1 }, durationBucket: 'under_1s' }, undefined],
      // Two retries wait 1s and 4s.
      ['feature.completed', { ...delivered, counts: { attempts: 3 }, durationBucket: '1s_to_10s' }, undefined],
    ])
  })

  it('reports an exhausted delivery by its last answer', async () => {
    const h = await notifierHarness()
    const answers = [
      { status: 404, error: null },
      { status: 503, error: null },
      { status: 0, error: 'connect ECONNREFUSED' },
      { status: 0, error: 'Request timed out after 10000ms', timedOut: true as const },
      { status: 301, error: null },
    ]
    for (const answer of answers) {
      vi.mocked(deliverWebhook).mockResolvedValue(answer)
      expect(await settle(h.send('https://hooks.example.com/canonry'))).toBe(false)
    }

    const failed = (reasonCode: string, statusClass: string) => ['feature.completed', {
      feature: 'webhooks', operation: 'deliver', status: 'failed', surface: 'system', target: 'first_party', eventType: 'run.completed',
      statusClass, counts: { attempts: 3 }, durationBucket: '1s_to_10s', reasonCode,
    }, { errorCode: reasonCode }]
    expect(deliveries()).toEqual([
      failed('HTTP_4XX', '4xx'),
      failed('HTTP_5XX', '5xx'),
      failed('NETWORK', 'network'),
      failed('TIMEOUT', 'timeout'),
      failed('UNSUPPORTED', '3xx'),
    ])
  })

  it('reports a destination refused before sending, and a sender that throws, without their messages', async () => {
    const h = await notifierHarness()
    vi.mocked(resolveWebhookTarget)
      .mockResolvedValueOnce({ ok: false, message: '"url" must not resolve to a private or loopback address', blocked: true })
      .mockResolvedValueOnce({ ok: false, message: '"url" hostname could not be resolved', unresolved: true })
    expect(await settle(h.send())).toBe(false)
    expect(await settle(h.send())).toBe(false)
    vi.mocked(deliverWebhook).mockRejectedValue(new TypeError('cannot read properties of undefined'))
    expect(await settle(h.send())).toBe(false)

    const base = { feature: 'webhooks', operation: 'deliver', status: 'failed', surface: 'system', target: 'slack', eventType: 'run.completed' }
    expect(deliveries()).toEqual([
      ['feature.completed', { ...base, statusClass: 'blocked', counts: { attempts: 0 }, durationBucket: 'under_1s', reasonCode: 'BLOCKED_UNSAFE_URL' }, { errorCode: 'BLOCKED_UNSAFE_URL' }],
      ['feature.completed', { ...base, statusClass: 'network', counts: { attempts: 0 }, durationBucket: 'under_1s', reasonCode: 'NETWORK' }, { errorCode: 'NETWORK' }],
      ['feature.completed', { ...base, statusClass: 'network', counts: { attempts: 3 }, durationBucket: '1s_to_10s', reasonCode: 'UNKNOWN', errorName: 'TypeError' }, { errorCode: 'UNKNOWN' }],
    ])
  })

  it('samples deliveries with failures on their own key, and reports what it dropped', async () => {
    const h = await notifierHarness()
    vi.mocked(deliverWebhook).mockResolvedValue({ status: 204, error: null })
    for (let i = 0; i < 22; i += 1) await settle(h.send())
    expect(deliveries()).toHaveLength(20)

    vi.mocked(resolveWebhookTarget).mockResolvedValueOnce({ ok: false, message: 'refused', blocked: true })
    await settle(h.send())
    expect(deliveries().at(-1)?.[1]).toMatchObject({ status: 'failed', reasonCode: 'BLOCKED_UNSAFE_URL' })

    vi.advanceTimersByTime(60_000)
    await settle(h.send())
    expect(deliveries().at(-1)?.[1]).toMatchObject({ status: 'succeeded', droppedBefore: 2 })
  })
})
