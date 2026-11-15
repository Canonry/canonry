import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { deliverWebhook } from '@canonry/canonry-api-routes'
import { createClient, migrate, notifications, projects, runs, sentimentAlertRuns, sentimentDefinitions, sentimentJobs } from '@canonry/canonry-db'
import type { SentimentUnfavorableAnswer, SentimentWebhookPayload } from '@canonry/canonry-contracts'
import { Notifier } from '../src/notifier.js'

/** What `SentimentService.newlyUnfavorable` answers per sweep, and the sweeps it was asked about. */
const verdicts = vi.hoisted(() => ({ scripted: new Map<string, unknown[]>(), reads: [] as string[] }))

// Keep the dispatcher, the settled-sweep read and the SQLite decisions real.
// Replace destination lookup and HTTP delivery, and script the verdict
// comparison, which api-routes' sentiment-service suite owns.
vi.mock('@canonry/canonry-api-routes', async importOriginal => {
  const actual = await importOriginal<typeof import('@canonry/canonry-api-routes')>()
  return {
    ...actual,
    resolveWebhookTarget: vi.fn(async (url: string) => ({
      ok: true,
      target: { url: new URL(url), address: '203.0.113.1', family: 4 },
    })),
    deliverWebhook: vi.fn(),
    SentimentService: class {
      newlyUnfavorable(_projectId: string, runId: string) {
        verdicts.reads.push(runId)
        return verdicts.scripted.get(runId) ?? []
      }
    },
  }
})

beforeEach(() => {
  vi.mocked(deliverWebhook).mockReset().mockResolvedValue({ status: 204, error: null })
  verdicts.scripted.clear()
  verdicts.reads.length = 0
})
afterEach(() => vi.useRealTimers())

const NOW = Date.parse('2026-11-10T12:00:00.000Z')
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString()

const TURNED: SentimentUnfavorableAnswer = {
  query: 'harborline reviews', queryId: 'q-brand', queryClass: 'branded', provider: 'openai', location: null,
  previousRunId: 'r1', previousOutcome: 'favorable', conclusion: ['Harborline is overpriced for what it offers.'], complaint: ['overpriced'],
}

function harness(events: string[] = ['sentiment.unfavorable']) {
  const db = createClient(':memory:')
  migrate(db)
  onTestFinished(() => db.$client.close())
  const created = daysAgo(30)
  db.insert(projects).values({
    id: 'project', name: 'harborline', displayName: 'Harborline', canonicalDomain: 'harborline.example',
    country: 'US', language: 'en', providers: [], createdAt: created, updatedAt: created,
  }).run()
  db.insert(notifications).values({
    id: 'webhook', projectId: 'project', channel: 'webhook',
    config: { url: 'https://hooks.example/sentiment', events }, enabled: true, createdAt: created, updatedAt: created,
  }).run()
  db.insert(sentimentDefinitions).values({ id: 'definition', contentHash: 'definition', requestedModel: 'jev-1.13.0', definition: {}, createdAt: created }).run()

  /**
   * A completed sweep `daysOld` days ago with its sentiment jobs admitted a
   * minute later, one per class. `open` leaves that many assessments pending.
   */
  function sweep(runId: string, daysOld: number, options: { trigger?: 'manual' | 'probe'; action?: 'automatic' | 'backfill'; open?: number } = {}) {
    const at = daysAgo(daysOld)
    db.insert(runs).values({ id: runId, projectId: 'project', kind: 'answer-visibility', status: 'completed', trigger: options.trigger ?? 'manual', createdAt: at, finishedAt: at }).run()
    const admittedAt = new Date(Date.parse(at) + 60_000).toISOString()
    for (const queryClass of ['branded', 'non-brand']) {
      const id = `${runId}-${queryClass}`
      const open = queryClass === 'non-brand' ? options.open ?? 0 : 0
      db.insert(sentimentJobs).values({
        id, projectId: 'project', action: options.action ?? 'automatic', origin: options.action ?? 'automatic', enablementEpoch: 1,
        evaluationDefinitionId: 'definition', idempotencyKey: id, payloadHash: id, selection: { runId, queryClass }, actor: 'system',
        state: open > 0 ? 'pending' : 'completed', pendingItems: open, completedItems: 1, createdAt: admittedAt, updatedAt: admittedAt,
      }).run()
    }
  }
  return {
    db,
    sweep,
    settle: (runId: string) => db.update(sentimentJobs).set({ pendingItems: 0, state: 'completed' }).where(eq(sentimentJobs.id, `${runId}-non-brand`)).run(),
    // A fresh dispatcher each pass proves the decisions survive restarts.
    dispatch: () => new Notifier(db, 'https://canonry.test', {
      sentimentInstall: () => ({ enabled: true, ready: true, reason: null, model: 'jev-1.13.0' }),
    }).dispatchSentimentAlerts(NOW),
    sent: () => vi.mocked(deliverWebhook).mock.calls.map(([, payload]) => payload as SentimentWebhookPayload),
    decisions: () => Object.fromEntries(db.select().from(sentimentAlertRuns).all().map(row => [row.runId, row.state])),
  }
}

it('records what settled before the first pass as a baseline, then sends a sweep once, after its sentiment settles', async () => {
  const { sweep, settle, dispatch, sent, decisions } = harness()
  sweep('r1', 2)
  sweep('r2', 1, { open: 1 })
  verdicts.scripted.set('r1', [TURNED])
  verdicts.scripted.set('r2', [TURNED])

  expect(await dispatch()).toBe(0)
  expect(decisions()).toEqual({ r1: 'baseline' })
  expect(verdicts.reads).toEqual([])

  settle('r2')
  expect(await dispatch()).toBe(1)
  expect(sent()).toEqual([{
    source: 'canonry', event: 'sentiment.unfavorable',
    project: { name: 'harborline', canonicalDomain: 'harborline.example' },
    run: { id: 'r2', status: 'completed', finishedAt: daysAgo(1) },
    answers: [TURNED], dashboardUrl: 'https://canonry.test/projects/harborline',
  }])
  expect(decisions()).toEqual({ r1: 'baseline', r2: 'sent' })

  expect(await dispatch()).toBe(0)
  expect(sent()).toHaveLength(1)
})

it('decides a sweep nothing subscribed to as skipped, so subscribing later starts from new sweeps, and one where nothing turned as quiet', async () => {
  const { db, sweep, dispatch, sent, decisions } = harness(['run.completed'])
  sweep('r1', 3)
  await dispatch()
  sweep('r2', 2)
  verdicts.scripted.set('r2', [TURNED])
  await dispatch()
  expect(decisions()).toEqual({ r1: 'baseline', r2: 'skipped' })

  db.update(notifications).set({ config: { url: 'https://hooks.example/sentiment', events: ['sentiment.unfavorable'] } }).where(eq(notifications.id, 'webhook')).run()
  sweep('r3', 1)
  await dispatch()
  expect(decisions()).toEqual({ r1: 'baseline', r2: 'skipped', r3: 'quiet' })
  expect(verdicts.reads).toEqual(['r3'])
  expect(sent()).toEqual([])
})

it('retries a sweep no webhook accepted on the next pass', async () => {
  const { sweep, dispatch, sent, decisions } = harness()
  sweep('r1', 2)
  await dispatch()
  sweep('r2', 1)
  verdicts.scripted.set('r2', [TURNED])

  vi.useFakeTimers({ toFake: ['setTimeout'] })
  vi.mocked(deliverWebhook).mockResolvedValue({ status: 500, error: null })
  const refused = dispatch()
  await vi.runAllTimersAsync()
  expect(await refused).toBe(0)
  expect(decisions()).toEqual({ r1: 'baseline' })

  vi.mocked(deliverWebhook).mockResolvedValue({ status: 204, error: null })
  expect(await dispatch()).toBe(1)
  expect(decisions()).toEqual({ r1: 'baseline', r2: 'sent' })
  expect(sent().map(payload => payload.run.id)).toEqual(['r2', 'r2', 'r2', 'r2'])
})

it('never alerts on a backfill, a probe, or a sweep whose sentiment was admitted before the window', async () => {
  const { sweep, dispatch, sent, decisions } = harness()
  sweep('r1', 3)
  await dispatch()
  sweep('backfilled', 2, { action: 'backfill' })
  sweep('probe', 1, { trigger: 'probe' })
  sweep('old', 8)
  for (const runId of ['backfilled', 'probe', 'old']) verdicts.scripted.set(runId, [TURNED])

  expect(await dispatch()).toBe(0)
  expect(decisions()).toEqual({ r1: 'baseline' })
  expect(verdicts.reads).toEqual([])
  expect(sent()).toEqual([])
})
