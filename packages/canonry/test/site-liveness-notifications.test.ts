import { test, expect, onTestFinished, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createClient, migrate, doctorHealthState, notifications, projects, siteLivenessState } from '@ainyc/canonry-db'
import { Notifier, SITE_LIVENESS_FAILURES_TO_PAGE, SITE_LIVENESS_MIN_PASS_GAP_MS, SITE_LIVENESS_MAX_PASS_GAP_MS } from '../src/notifier.js'

// A site-down page has to mean the site is down for real, and a recovery has to
// answer a page someone actually received. These pin the debounce, the spacing
// that makes two passes mean two moments, delivery accounting, and that liveness
// never touches the 6h doctor state it runs beside.

function harness(delivery: { delivered?: boolean } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cnry-liveness-'))
  onTestFinished(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const db = createClient(path.join(tmp, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: 'liveproj', displayName: 'Live', canonicalDomain: 'client.example',
    country: 'US', language: 'en', providers: [], createdAt: now, updatedAt: now,
  }).run()
  db.insert(notifications).values({
    id: crypto.randomUUID(), projectId, channel: 'webhook',
    // Deliberately not subscribed to health events: they must still arrive.
    config: { url: 'https://hooks.example/alerts', events: ['run.failed'] },
    enabled: true, createdAt: now, updatedAt: now,
  } as never).run()
  const notifier = new Notifier(db, 'https://canonry.test')
  const sent: Array<{ event: string; health: { status: string; code: string; previousStatus: string | null; failing: Array<{ id: string }> } }> = []
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...args: unknown[]) => {
    sent.push(args[1] as never)
    return delivery.delivered ?? true
  })
  const state = () => db.select().from(siteLivenessState).where(eq(siteLivenessState.projectId, projectId)).get()
  return { db, projectId, notifier, sent, state }
}

const down = { id: 'site.reachability', status: 'fail', code: 'site.reachability.down', summary: 'https://client.example/ is not responding: HTTP 503.', remediation: 'Open the site.' }
const up = { id: 'site.reachability', status: 'ok', code: 'site.reachability.up', summary: 'https://client.example/ answered HTTP 200 in 90 ms.' }
const skipped = { id: 'site.reachability', status: 'skipped', code: 'site.reachability.probe-unavailable', summary: 'Could not probe.' }
const START = Date.parse('2026-09-16T12:00:00.000Z')
const pass = (check: typeof down | typeof up | typeof skipped, minutesFromStart: number) =>
  ({ check, checkedAt: new Date(START + minutesFromStart * 60_000).toISOString() })

test('pages after exactly two failed passes, spaced like real passes', () => {
  expect(SITE_LIVENESS_FAILURES_TO_PAGE).toBe(2)
  expect(SITE_LIVENESS_MIN_PASS_GAP_MS).toBeLessThan(SITE_LIVENESS_MAX_PASS_GAP_MS)
})

test('one failed pass stays silent, because a blip is not an outage', async () => {
  const { notifier, projectId, sent, state } = harness()
  expect(await notifier.onSiteLivenessChecked(projectId, pass(down, 0))).toBeNull()
  expect(sent).toHaveLength(0)
  expect(state()).toMatchObject({ status: 'fail', consecutiveFailures: 1, notifiedAt: null })
})

test('the second failed pass pages once, as a website outage with a real transition', async () => {
  const { notifier, projectId, sent, state } = harness()
  await notifier.onSiteLivenessChecked(projectId, pass(down, 0))
  expect(await notifier.onSiteLivenessChecked(projectId, pass(down, 10))).toBe('health.degraded')
  expect(sent).toHaveLength(1)
  // previousStatus is 'ok', not the row this outage already overwrote: the
  // counter resets on every ok, so a page always follows a site that answered.
  expect(sent[0]).toMatchObject({ event: 'health.degraded', health: { status: 'fail', code: 'site.reachability.down', previousStatus: 'ok' } })
  expect(sent[0]!.health.failing.map(f => f.id)).toEqual(['site.reachability'])
  expect(state()!.notifiedAt).not.toBeNull()
})

test('a boot catch-up pass seconds after another does not count as a second pass', async () => {
  const { notifier, projectId, sent, state } = harness()
  await notifier.onSiteLivenessChecked(projectId, pass(down, 0))
  expect(await notifier.onSiteLivenessChecked(projectId, pass(down, 0.5))).toBeNull()
  expect(sent).toHaveLength(0)
  expect(state()).toMatchObject({ consecutiveFailures: 1 })
})

test('a failure stored before a long outage of our own does not count toward a page', async () => {
  const { notifier, projectId, sent, state } = harness()
  await notifier.onSiteLivenessChecked(projectId, pass(down, 0))
  const staleGapMinutes = SITE_LIVENESS_MAX_PASS_GAP_MS / 60_000 + 60
  expect(await notifier.onSiteLivenessChecked(projectId, pass(down, staleGapMinutes))).toBeNull()
  expect(state()).toMatchObject({ consecutiveFailures: 1 })
  expect(sent).toHaveLength(0)
})

test('a continuing outage does not repeat the page', async () => {
  const { notifier, projectId, sent } = harness()
  for (const minute of [0, 10, 20, 30]) await notifier.onSiteLivenessChecked(projectId, pass(down, minute))
  expect(sent).toHaveLength(1)
})

test('recovery after a delivered page sends health.recovered and resets the counter', async () => {
  const { notifier, projectId, sent, state } = harness()
  await notifier.onSiteLivenessChecked(projectId, pass(down, 0))
  await notifier.onSiteLivenessChecked(projectId, pass(down, 10))
  expect(await notifier.onSiteLivenessChecked(projectId, pass(up, 20))).toBe('health.recovered')
  expect(sent.map(s => s.event)).toEqual(['health.degraded', 'health.recovered'])
  expect(sent[1]).toMatchObject({ health: { status: 'ok', code: 'site.reachability.up', previousStatus: 'fail', failing: [] } })
  expect(state()).toMatchObject({ status: 'ok', consecutiveFailures: 0, notifiedAt: null })
})

test('a page nobody received is retried, and never answered by a recovery', async () => {
  // sendWebhook returns normally after its retries are exhausted, so counting
  // attempts as deliveries would silence the rest of the outage and then send a
  // recovery for a page that never arrived.
  const { notifier, projectId, sent, state } = harness({ delivered: false })
  await notifier.onSiteLivenessChecked(projectId, pass(down, 0))
  expect(await notifier.onSiteLivenessChecked(projectId, pass(down, 10))).toBe('health.degraded')
  expect(state()!.notifiedAt).toBeNull()
  expect(await notifier.onSiteLivenessChecked(projectId, pass(down, 20))).toBe('health.degraded')
  expect(await notifier.onSiteLivenessChecked(projectId, pass(up, 30))).toBeNull()
  expect(sent.map(s => s.event)).toEqual(['health.degraded', 'health.degraded'])
})

test('a blip that never paged stays silent in both directions', async () => {
  const { notifier, projectId, sent } = harness()
  expect(await notifier.onSiteLivenessChecked(projectId, pass(down, 0))).toBeNull()
  expect(await notifier.onSiteLivenessChecked(projectId, pass(up, 10))).toBeNull()
  expect(sent).toHaveLength(0)
})

test('a skipped probe is not a signal and leaves the counter alone', async () => {
  const { notifier, projectId, sent, state } = harness()
  await notifier.onSiteLivenessChecked(projectId, pass(down, 0))
  expect(await notifier.onSiteLivenessChecked(projectId, pass(skipped, 10))).toBeNull()
  expect(state()).toMatchObject({ consecutiveFailures: 1, checkedAt: pass(down, 0).checkedAt })
  expect(await notifier.onSiteLivenessChecked(projectId, pass(down, 20))).toBe('health.degraded')
  expect(sent).toHaveLength(1)
})

test('liveness never writes the doctor health state it runs beside', async () => {
  const { notifier, projectId, db } = harness()
  await notifier.onSiteLivenessChecked(projectId, pass(down, 0))
  await notifier.onSiteLivenessChecked(projectId, pass(down, 10))
  expect(db.select().from(doctorHealthState).where(eq(doctorHealthState.projectId, projectId)).get()).toBeUndefined()
})
