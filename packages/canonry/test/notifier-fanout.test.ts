import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it, expect, afterEach, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { deliverWebhook, measurementRunCompleteness } from '@ainyc/canonry-api-routes'
import { CitationStates, RunKinds, RunStatuses, RunTriggers } from '@ainyc/canonry-contracts'
import type { CitationState, LocationContext, RunStatus, RunTrigger, WebhookPayload } from '@ainyc/canonry-contracts'
import {
  createClient,
  migrate,
  projects,
  queries,
  querySnapshots,
  runs,
  notifications,
  auditLog,
} from '@ainyc/canonry-db'
import { Notifier } from '../src/notifier.js'

vi.mock('@ainyc/canonry-api-routes', async importOriginal => {
  const actual = await importOriginal<typeof import('@ainyc/canonry-api-routes')>()
  return {
    ...actual,
    resolveWebhookTarget: vi.fn(async (url: string) => ({
      ok: true, target: { url: new URL(url), address: '203.0.113.1', family: 4 },
    })),
    deliverWebhook: vi.fn(),
  }
})

beforeEach(() => {
  vi.mocked(deliverWebhook).mockReset().mockResolvedValue({ status: 204, error: null })
})

// Regression suite for #480 fan-out behavior in the citation-change notifier.
// The pre-#480 logic compared `runs[0]` vs `runs[1]` for the run-completed
// webhook, which under --all-locations fan-out compared the sibling location's
// CURRENT run as if it were "previous" — firing spurious citation.lost /
// citation.gained events on every multi-location sweep.

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

function buildDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-notifier-fanout-'))
  cleanups.push(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  return db
}

const PREVIOUS_AT = '2026-10-01T00:00:00.000Z'
const CURRENT_AT = '2026-10-03T00:00:00.000Z'
const CURRENT_FINISHED_AT = '2026-10-03T00:00:02.000Z'
const LOCATION = { label: 'florida', city: 'Orlando', region: 'Florida', country: 'US' }
const MICHIGAN: LocationContext = { label: 'michigan', city: 'Detroit', region: 'Michigan', country: 'US' }
const MODES = ['Simple', 'Advanced'] as const

function notificationHarness(
  planned: boolean, locations: LocationContext[] = [LOCATION],
  events: WebhookPayload['event'][] = ['citation.gained', 'citation.lost'],
) {
  const db = buildDb()
  cleanups.unshift(() => db.$client.close())
  const projectId = 'probe-notifications'
  db.insert(projects).values({
    id: projectId, name: 'probe-notifications', displayName: 'Probe Notifications',
    canonicalDomain: 'coatings.example', country: 'US', language: 'en',
    locations, createdAt: PREVIOUS_AT, updatedAt: CURRENT_AT,
  }).run()
  db.insert(queries).values({
    id: 'roof-query', projectId, query: 'roof coating', createdAt: PREVIOUS_AT,
  }).run()
  db.insert(notifications).values({
    id: 'citation-hook', projectId, channel: 'webhook', enabled: true,
    config: { url: 'https://hooks.example/citations', events },
    createdAt: PREVIOUS_AT, updatedAt: PREVIOUS_AT,
  }).run()

  function snapshot(
    runId: string, createdAt: string, citationState: CitationState,
    context: LocationContext = LOCATION, provider = 'gemini',
    executionId: string | null = planned ? 'roof-execution' : null,
  ) {
    db.insert(querySnapshots).values({
      id: `${runId}${provider === 'gemini' ? '' : `-${provider}`}-snapshot`,
      runId, queryId: 'roof-query', queryText: 'roof coating', provider,
      location: context.label, citationState, answerMentioned: false,
      citedDomains: citationState === CitationStates.cited ? ['coatings.example'] : [],
      measurementExecutionId: executionId, requestedContext: context, createdAt,
    }).run()
  }

  function seed(
    id: string, createdAt: string, citationState: CitationState,
    trigger: RunTrigger = RunTriggers.manual, status: RunStatus = RunStatuses.completed,
    finishedAt: string | null = createdAt,
    slot: { context?: LocationContext; provider?: string } = {},
  ) {
    const context = slot.context ?? LOCATION
    const provider = slot.provider ?? 'gemini'
    db.insert(runs).values({
      id, projectId, kind: RunKinds['answer-visibility'], trigger, status,
      location: context.label, createdAt, finishedAt,
      measurementManifest: planned ? {
        schemaVersion: 1,
        expectedSlots: [{ executionId: 'roof-execution', queryText: 'roof coating', provider, context }],
      } : null,
    }).run()
    if (status === RunStatuses.completed) snapshot(id, createdAt, citationState, context, provider)
  }

  async function complete(runId = 'current', origin?: 'fill') {
    await new Notifier(db, 'https://canonry.test').onRunCompleted(runId, projectId, origin ? { origin } : undefined)
  }

  function assertDelivered(expected: WebhookPayload[]) {
    expect(vi.mocked(deliverWebhook).mock.calls.map(([, body]) => body)).toEqual(expected)
    expect(db.select().from(auditLog).all().map(row => ({
      projectId: row.projectId, actor: row.actor, action: row.action,
      entityType: row.entityType, entityId: row.entityId, diff: JSON.parse(row.diff!),
    }))).toEqual(expected.map(payload => ({
      projectId, actor: 'scheduler', action: 'notification.sent',
      entityType: 'notification', entityId: 'citation-hook', diff: { event: payload.event, error: null },
    })))
  }

  async function dispatch(expectedEvent: 'citation.gained' | 'citation.lost' | null) {
    await complete()
    assertDelivered(expectedEvent === null ? [] : [expectedPayload(expectedEvent,
      { id: 'current', status: 'completed', finishedAt: CURRENT_FINISHED_AT }, [{
        query: 'roof coating', provider: 'gemini', location: 'florida',
        from: expectedEvent === 'citation.gained' ? 'not-cited' : 'cited',
        to: expectedEvent === 'citation.gained' ? 'cited' : 'not-cited',
      }])])
  }
  return { db, projectId, seed, snapshot, complete, assertDelivered, dispatch }
}

function expectedPayload(
  event: WebhookPayload['event'], run: WebhookPayload['run'], transitions: WebhookPayload['transitions'],
): WebhookPayload {
  return {
    source: 'canonry', event,
    project: { name: 'probe-notifications', canonicalDomain: 'coatings.example' },
    run, transitions, dashboardUrl: 'https://canonry.test/projects/probe-notifications',
  }
}

const WINNER_CASES = [
  { policy: 'later finish beats larger ID', flFinish: '2026-10-03T00:00:03.000Z', miFinish: CURRENT_FINISHED_AT, winner: 'current-fl', loser: 'current-mi', winnerFinish: '2026-10-03T00:00:03.000Z' },
  { policy: 'larger ID breaks equal finish', flFinish: CURRENT_FINISHED_AT, miFinish: CURRENT_FINISHED_AT, winner: 'current-mi', loser: 'current-fl', winnerFinish: CURRENT_FINISHED_AT },
] as const
it.each(MODES.flatMap(mode => WINNER_CASES.flatMap(row => ['winner first', 'loser first'].map(order => ({ mode, order, ...row }))))) (
  '$mode delivers one combined fanout loss: $policy, $order', async ({ mode, order, flFinish, miFinish, winner, loser, winnerFinish }) => {
    const { db, projectId, seed, complete, assertDelivered } = notificationHarness(mode === 'Advanced', [LOCATION, MICHIGAN])
    seed('previous-fl', PREVIOUS_AT, CitationStates['not-cited'])
    seed('previous-mi', PREVIOUS_AT, CitationStates.cited, RunTriggers.manual, RunStatuses.completed, PREVIOUS_AT, { context: MICHIGAN })
    seed('current-fl', CURRENT_AT, CitationStates['not-cited'], RunTriggers.manual, RunStatuses.completed, flFinish)
    seed('current-mi', CURRENT_AT, CitationStates['not-cited'], RunTriggers.manual, RunStatuses.completed, miFinish, { context: MICHIGAN })
    db.insert(runs).values({
      id: 'queued-traffic', projectId, kind: RunKinds['traffic-sync'], status: RunStatuses.queued,
      trigger: RunTriggers.scheduled, createdAt: CURRENT_AT,
    }).run()
    const expected = expectedPayload('citation.lost', { id: winner, status: 'completed', finishedAt: winnerFinish }, [
      { query: 'roof coating', provider: 'gemini', location: 'michigan', from: 'cited', to: 'not-cited' },
    ])
    await complete(order === 'winner first' ? winner : loser)
    assertDelivered(order === 'winner first' ? [expected] : [])
    await complete(order === 'winner first' ? loser : winner)
    assertDelivered([expected])
  },
)

it.each(MODES.flatMap(mode => [RunStatuses.queued, RunStatuses.running].map(status => ({ mode, status }))))(
  '$mode waits for a $status fanout sibling before delivering its eligible loss', async ({ mode, status }) => {
    const { db, seed, snapshot, complete, assertDelivered } = notificationHarness(mode === 'Advanced', [LOCATION, MICHIGAN])
    seed('previous-fl', PREVIOUS_AT, CitationStates.cited)
    seed('previous-mi', PREVIOUS_AT, CitationStates.cited, RunTriggers.manual, RunStatuses.completed, PREVIOUS_AT, { context: MICHIGAN })
    seed('current-fl', CURRENT_AT, CitationStates['not-cited'], RunTriggers.manual, RunStatuses.completed, CURRENT_FINISHED_AT)
    seed('current-mi', CURRENT_AT, CitationStates.cited, RunTriggers.manual, status, null, { context: MICHIGAN })
    await complete('current-fl')
    assertDelivered([])
    db.update(runs).set({ status: RunStatuses.completed, finishedAt: '2026-10-03T00:00:03.000Z' }).where(eq(runs.id, 'current-mi')).run()
    snapshot('current-mi', CURRENT_AT, CitationStates.cited, MICHIGAN)
    await complete('current-mi')
    assertDelivered([expectedPayload('citation.lost', { id: 'current-mi', status: 'completed', finishedAt: '2026-10-03T00:00:03.000Z' }, [
      { query: 'roof coating', provider: 'gemini', location: 'florida', from: 'cited', to: 'not-cited' },
    ])])
  },
)

it.each(MODES)('%s emits no citation event without a prior group, then uses the stored prior group', async mode => {
  const { seed, complete, assertDelivered } = notificationHarness(mode === 'Advanced', [LOCATION, MICHIGAN])
  seed('current-fl', CURRENT_AT, CitationStates.cited, RunTriggers.manual, RunStatuses.completed, CURRENT_FINISHED_AT)
  seed('current-mi', CURRENT_AT, CitationStates.cited, RunTriggers.manual, RunStatuses.completed, CURRENT_FINISHED_AT, { context: MICHIGAN })
  await complete('current-mi')
  assertDelivered([])
  seed('previous-fl', PREVIOUS_AT, CitationStates['not-cited'])
  seed('previous-mi', PREVIOUS_AT, CitationStates['not-cited'], RunTriggers.manual, RunStatuses.completed, PREVIOUS_AT, { context: MICHIGAN })
  await complete('current-mi')
  assertDelivered([expectedPayload('citation.gained', { id: 'current-mi', status: 'completed', finishedAt: CURRENT_FINISHED_AT }, [
    { query: 'roof coating', provider: 'gemini', location: 'florida', from: 'not-cited', to: 'cited' },
    { query: 'roof coating', provider: 'gemini', location: 'michigan', from: 'not-cited', to: 'cited' },
  ])])
})

it('holds a correctly bound missing-slot loss until stored fill, without sending run.completed twice', async () => {
  const { db, seed, snapshot, complete, assertDelivered } = notificationHarness(true, [LOCATION], ['run.completed', 'citation.gained', 'citation.lost'])
  seed('previous', PREVIOUS_AT, CitationStates.cited, RunTriggers.manual, RunStatuses.completed, PREVIOUS_AT, { provider: 'openai' })
  seed('current', CURRENT_AT, CitationStates['not-cited'], RunTriggers.manual, RunStatuses.partial, CURRENT_FINISHED_AT, { provider: 'openai' })
  db.update(runs).set({ measurementManifest: { schemaVersion: 1, expectedSlots: [
    { executionId: 'e1', queryText: 'roof coating', provider: 'openai', context: LOCATION },
    { executionId: 'e2', queryText: 'roof coating', provider: 'gemini', context: LOCATION },
  ] } }).where(eq(runs.id, 'current')).run()
  snapshot('current', CURRENT_AT, CitationStates['not-cited'], LOCATION, 'openai', 'e1')
  expect(measurementRunCompleteness(db, 'current')).toEqual({ planned: true, executed: 1, expected: 2, complete: false })
  await complete()
  const partial = expectedPayload('run.completed', { id: 'current', status: 'partial', finishedAt: CURRENT_FINISHED_AT }, [])
  assertDelivered([partial])
  snapshot('current', CURRENT_AT, CitationStates['not-cited'], LOCATION, 'gemini', 'e2')
  db.update(runs).set({ status: RunStatuses.completed, error: null }).where(eq(runs.id, 'current')).run()
  expect(measurementRunCompleteness(db, 'current')).toEqual({ planned: true, executed: 2, expected: 2, complete: true })
  await complete('current', 'fill')
  assertDelivered([partial, expectedPayload('citation.lost', { id: 'current', status: 'completed', finishedAt: CURRENT_FINISHED_AT }, [
    { query: 'roof coating', provider: 'openai', location: 'florida', from: 'cited', to: 'not-cited' },
  ])])
})

const HISTORY_CASES = [
  { name: 'false gain', previous: CitationStates.cited, probe: CitationStates['not-cited'], current: CitationStates.cited, event: null, probes: 1 },
  { name: 'false loss', previous: CitationStates['not-cited'], probe: CitationStates.cited, current: CitationStates['not-cited'], event: null, probes: 1 },
  { name: 'real gain', previous: CitationStates['not-cited'], probe: CitationStates.cited, current: CitationStates.cited, event: 'citation.gained', probes: 1 },
  { name: 'real loss', previous: CitationStates.cited, probe: CitationStates['not-cited'], current: CitationStates['not-cited'], event: 'citation.lost', probes: 1 },
  { name: 'history beyond the eight-row window', previous: CitationStates['not-cited'], probe: CitationStates.cited, current: CitationStates.cited, event: 'citation.gained', probes: 9 },
  { name: 'ordinary gain', previous: CitationStates['not-cited'], probe: CitationStates.cited, current: CitationStates.cited, event: 'citation.gained', probes: 0 },
  { name: 'ordinary loss', previous: CitationStates.cited, probe: CitationStates['not-cited'], current: CitationStates['not-cited'], event: 'citation.lost', probes: 0 },
] as const

it.each(MODES.flatMap(mode => HISTORY_CASES.map(row => ({ mode, ...row }))))(
  '$mode ignores stored probes in citation history: $name', async ({ mode, previous, probe, current, event, probes }) => {
    const { seed, dispatch } = notificationHarness(mode === 'Advanced')
    seed('z-previous', PREVIOUS_AT, previous)
    for (let index = 0; index < probes; index++) {
      seed(`probe-${index}`, `2026-10-02T00:${String(index).padStart(2, '0')}:00.000Z`, probe, RunTriggers.probe)
    }
    seed('current', CURRENT_AT, current, RunTriggers.manual, RunStatuses.completed, CURRENT_FINISHED_AT)
    await dispatch(event)
  },
)

const GROUP_CASES = ['pending sibling', 'completed winner', 'previous population', 'current population'] as const
it.each(MODES.flatMap(mode => GROUP_CASES.map(poison => ({ mode, poison }))))(
  '$mode ignores stored probes in citation groups: $poison', async ({ mode, poison }) => {
    const { seed, dispatch } = notificationHarness(mode === 'Advanced')
    seed('z-previous', PREVIOUS_AT, CitationStates.cited)
    seed('current', CURRENT_AT, CitationStates['not-cited'], RunTriggers.manual, RunStatuses.completed, CURRENT_FINISHED_AT)
    seed(
      'zz-probe', poison === 'previous population' ? PREVIOUS_AT : CURRENT_AT,
      CitationStates['not-cited'], RunTriggers.probe,
      poison === 'pending sibling' ? RunStatuses.running : RunStatuses.completed,
      poison === 'pending sibling' ? null
        : poison === 'completed winner' ? '2026-10-03T00:00:03.000Z'
          : poison === 'previous population' ? '2026-10-01T00:00:01.000Z' : '2026-10-03T00:00:01.000Z',
    )
    await dispatch('citation.lost')
  },
)
