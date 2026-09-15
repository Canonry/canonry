import { test, expect, onTestFinished, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createClient, migrate, doctorHealthState, notifications, projects, siteLivenessState } from '@ainyc/canonry-db'
import { Notifier, SITE_LIVENESS_FAILURES_TO_PAGE } from '../src/notifier.js'

// A site-down page has to mean the site is down for real, and the recovery has to
// answer a page someone actually received. These pin the debounce, the pairing,
// and that liveness never touches the 6h doctor state it runs beside.

function harness() {
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
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...args: unknown[]) => { sent.push(args[1] as never) })
  const state = () => db.select().from(siteLivenessState).where(eq(siteLivenessState.projectId, projectId)).get()
  return { db, projectId, notifier, sent, state }
}

const down = { id: 'site.reachability', status: 'fail', code: 'site.reachability.down', summary: 'https://client.example/ is not responding: HTTP 503.', remediation: 'Open the site.' }
const up = { id: 'site.reachability', status: 'ok', code: 'site.reachability.up', summary: 'https://client.example/ answered HTTP 200 in 90 ms.' }
const skipped = { id: 'site.reachability', status: 'skipped', code: 'site.reachability.blocked-address', summary: 'Not probing.' }
const pass = (check: typeof down | typeof up | typeof skipped, minute: number) => ({ check, checkedAt: `2026-09-15T18:${String(minute).padStart(2, '0')}:00.000Z` })

test('pages after exactly two failed passes', () => {
  expect(SITE_LIVENESS_FAILURES_TO_PAGE).toBe(2)
})

test('one failed pass stays silent, because a blip is not an outage', async () => {
  const { notifier, projectId, sent, state } = harness()
  expect(await notifier.onSiteLivenessChecked(projectId, pass(down, 0))).toBeNull()
  expect(sent).toHaveLength(0)
  expect(state()).toMatchObject({ status: 'fail', consecutiveFailures: 1, notifiedAt: null })
})

test('the second failed pass pages once, headlined by the website, even without a health subscription', async () => {
  const { notifier, projectId, sent, state } = harness()
  await notifier.onSiteLivenessChecked(projectId, pass(down, 0))
  expect(await notifier.onSiteLivenessChecked(projectId, pass(down, 10))).toBe('health.degraded')
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ event: 'health.degraded', health: { status: 'fail', code: 'site.reachability.down', previousStatus: 'fail' } })
  expect(sent[0]!.health.failing.map(f => f.id)).toEqual(['site.reachability'])
  expect(state()!.notifiedAt).toBe('2026-09-15T18:10:00.000Z')
})

test('a continuing outage does not repeat the page', async () => {
  const { notifier, projectId, sent } = harness()
  for (const minute of [0, 10, 20, 30]) await notifier.onSiteLivenessChecked(projectId, pass(down, minute))
  expect(sent).toHaveLength(1)
})

test('recovery after a paged outage sends health.recovered and resets the counter', async () => {
  const { notifier, projectId, sent, state } = harness()
  await notifier.onSiteLivenessChecked(projectId, pass(down, 0))
  await notifier.onSiteLivenessChecked(projectId, pass(down, 10))
  expect(await notifier.onSiteLivenessChecked(projectId, pass(up, 20))).toBe('health.recovered')
  expect(sent.map(s => s.event)).toEqual(['health.degraded', 'health.recovered'])
  expect(sent[1]).toMatchObject({ health: { status: 'ok', code: 'site.reachability.up', previousStatus: 'fail', failing: [] } })
  expect(state()).toMatchObject({ status: 'ok', consecutiveFailures: 0, notifiedAt: null })
  // And a later outage pages again from scratch.
  await notifier.onSiteLivenessChecked(projectId, pass(down, 30))
  expect(await notifier.onSiteLivenessChecked(projectId, pass(down, 40))).toBe('health.degraded')
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
  expect(state()).toMatchObject({ consecutiveFailures: 1, checkedAt: '2026-09-15T18:00:00.000Z' })
  expect(await notifier.onSiteLivenessChecked(projectId, pass(down, 20))).toBe('health.degraded')
  expect(sent).toHaveLength(1)
})

test('liveness never writes the doctor health state it runs beside', async () => {
  const { notifier, projectId, db } = harness()
  await notifier.onSiteLivenessChecked(projectId, pass(down, 0))
  await notifier.onSiteLivenessChecked(projectId, pass(down, 10))
  expect(db.select().from(doctorHealthState).where(eq(doctorHealthState.projectId, projectId)).get()).toBeUndefined()
})
