import { test, expect, onTestFinished, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createClient, migrate, doctorHealthState, notifications, projects } from '@ainyc/canonry-db'
import { Notifier } from '../src/notifier.js'

// Canonry alarmed when the measurement reported bad news and never when the
// measurement itself was broken. Every notifiable event described a finding
// (citation.lost, run.failed, insight.*), so a Vercel source that silently
// discarded traffic for 24h kept emitting `run.completed` — a success signal —
// the whole time, and a provider that quietly stopped retrieving looked
// identical to a brand that genuinely was not mentioned.
//
// These tests pin the health channel that closes that gap, and specifically pin
// that it stays quiet when nothing changed: an operator who gets the same
// warning every day stops reading the channel, which recreates the original
// failure with extra steps.

function harness() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cnry-health-'))
  onTestFinished(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const db = createClient(path.join(tmp, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: 'healthproj', displayName: 'Health', canonicalDomain: 'example.com',
    country: 'US', language: 'en', providers: [], createdAt: now, updatedAt: now,
  }).run()
  db.insert(notifications).values({
    id: crypto.randomUUID(), projectId, channel: 'webhook',
    config: { url: 'https://hooks.example/health', events: ['health.degraded', 'health.recovered'] },
    enabled: true, createdAt: now, updatedAt: now,
  } as never).run()
  return { db, projectId, notifier: new Notifier(db, 'https://canonry.test') }
}

const check = (id: string, status: string, code: string, summary = 'x', category?: string) => ({ id, status, code, summary, category })
const at = (iso: string) => ({ checkedAt: iso })

test('a first pass that is already degraded notifies once', async () => {
  const { notifier, projectId, db } = harness()
  const sent: unknown[] = []
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...args: unknown[]) => { sent.push(args[1]) })

  const event = await notifier.onHealthChecked(projectId, {
    checks: [check('traffic.source.sync-lag', 'fail', 'traffic.sync-lag.discarding', 'discarding now')],
    ...at('2026-07-31T05:00:00.000Z'),
  })

  expect(event).toBe('health.degraded')
  expect(sent).toHaveLength(1)
  const payload = sent[0] as { event: string; health: { status: string; previousStatus: null; code: string } }
  expect(payload.event).toBe('health.degraded')
  expect(payload.health.status).toBe('fail')
  expect(payload.health.previousStatus).toBeNull()
  expect(payload.health.code).toBe('traffic.sync-lag.discarding')
  // The payload deliberately carries no `run` — this is not a finding.
  expect(payload).not.toHaveProperty('run')

  const stored = db.select().from(doctorHealthState).where(eq(doctorHealthState.projectId, projectId)).get()!
  expect(stored.status).toBe('fail')
})

test('a repeat of the same problem stays silent so the channel keeps meaning something', async () => {
  const { notifier, projectId } = harness()
  const sent: unknown[] = []
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...args: unknown[]) => { sent.push(args[1]) })

  const checks = [check('traffic.source.sync-lag', 'warn', 'traffic.sync-lag.behind')]
  const first = await notifier.onHealthChecked(projectId, { checks, ...at('2026-07-31T05:00:00.000Z') })
  const second = await notifier.onHealthChecked(projectId, { checks, ...at('2026-08-01T05:00:00.000Z') })
  const third = await notifier.onHealthChecked(projectId, { checks, ...at('2026-08-02T05:00:00.000Z') })

  expect(first).toBe('health.degraded')
  expect(second).toBeNull()
  expect(third).toBeNull()
  expect(sent).toHaveLength(1)
})

test('a different cause at the same severity does notify, because it is different news', async () => {
  const { notifier, projectId } = harness()
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async () => {})

  const first = await notifier.onHealthChecked(projectId, {
    checks: [check('traffic.source.sync-lag', 'warn', 'traffic.sync-lag.behind')],
    ...at('2026-07-31T05:00:00.000Z'),
  })
  const second = await notifier.onHealthChecked(projectId, {
    checks: [check('traffic.source.connected', 'warn', 'traffic.source.partially-errored')],
    ...at('2026-08-01T05:00:00.000Z'),
  })

  expect(first).toBe('health.degraded')
  expect(second).toBe('health.degraded')
})

test('recovery closes the loop', async () => {
  const { notifier, projectId } = harness()
  const sent: { event: string; health: { previousStatus: string | null } }[] = []
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...args: unknown[]) => {
    sent.push(args[1] as never)
  })

  await notifier.onHealthChecked(projectId, {
    checks: [check('traffic.source.sync-lag', 'fail', 'traffic.sync-lag.discarding')],
    ...at('2026-07-31T05:00:00.000Z'),
  })
  const recovered = await notifier.onHealthChecked(projectId, {
    checks: [check('traffic.source.sync-lag', 'ok', 'traffic.sync-lag.current')],
    ...at('2026-08-01T05:00:00.000Z'),
  })

  expect(recovered).toBe('health.recovered')
  expect(sent.at(-1)!.event).toBe('health.recovered')
  expect(sent.at(-1)!.health.previousStatus).toBe('fail')
})

test('a healthy first pass says nothing, so enabling this does not announce working projects', async () => {
  const { notifier, projectId } = harness()
  const sent: unknown[] = []
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...a: unknown[]) => { sent.push(a) })

  const event = await notifier.onHealthChecked(projectId, {
    checks: [check('traffic.source.sync-lag', 'ok', 'traffic.sync-lag.current')],
    ...at('2026-07-31T05:00:00.000Z'),
  })

  expect(event).toBeNull()
  expect(sent).toHaveLength(0)
})

test('a skipped check does not mask a failing one', async () => {
  const { notifier, projectId, db } = harness()
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async () => {})

  await notifier.onHealthChecked(projectId, {
    checks: [
      check('traffic.source.sync-lag', 'skipped', 'traffic.sync-lag.no-source'),
      check('traffic.source.credentials', 'fail', 'traffic.credentials.failed'),
    ],
    ...at('2026-07-31T05:00:00.000Z'),
  })

  const stored = db.select().from(doctorHealthState).where(eq(doctorHealthState.projectId, projectId)).get()!
  expect(stored.status).toBe('fail')
  expect(stored.code).toBe('traffic.credentials.failed')
})

test('a pass where every check skipped is unknown, never healthy', async () => {
  // The whole point of this channel is that a green signal must mean something
  // was measured. If every check skips there is no signal at all, and calling
  // that `ok` reproduces green-while-blind — an instrument reporting health
  // having measured nothing. It must warn, and it must say why.
  const { notifier, projectId, db } = harness()
  const sent: { event: string; health: { code: string } }[] = []
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...a: unknown[]) => {
    sent.push(a[1] as never)
  })

  const event = await notifier.onHealthChecked(projectId, {
    checks: [
      check('traffic.source.sync-lag', 'skipped', 'traffic.sync-lag.no-source'),
      check('traffic.source.credentials', 'skipped', 'traffic.credentials.no-source'),
    ],
    ...at('2026-07-31T05:00:00.000Z'),
  })

  expect(event).toBe('health.degraded')
  const stored = db.select().from(doctorHealthState).where(eq(doctorHealthState.projectId, projectId)).get()!
  expect(stored.status).toBe('warn')
  expect(stored.code).toBe('health.no-signal')
  expect(stored.summary).toMatch(/unknown, not confirmed/)
  expect(sent.at(-1)!.health.code).toBe('health.no-signal')
})

test('worst status wins when several checks are unhappy', async () => {
  const { notifier, projectId, db } = harness()
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async () => {})

  await notifier.onHealthChecked(projectId, {
    checks: [
      check('a.warn', 'warn', 'a.warn.code'),
      check('b.fail', 'fail', 'b.fail.code'),
      check('c.ok', 'ok', 'c.ok.code'),
    ],
    ...at('2026-07-31T05:00:00.000Z'),
  })

  const stored = db.select().from(doctorHealthState).where(eq(doctorHealthState.projectId, projectId)).get()!
  expect(stored.status).toBe('fail')
  expect(stored.code).toBe('b.fail.code')
})

test('the headline leads with the broken instrument, not the alphabetically first check', async () => {
  // Sorting equally-severe checks by id put `content.*` ahead of `traffic.*`,
  // so a source silently discarding traffic was headlined as a content-coverage
  // note. Severity is equal here; only meaning separates them.
  const { notifier, projectId, db } = harness()
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async () => {})

  await notifier.onHealthChecked(projectId, {
    checks: [
      check('content.winnability', 'warn', 'content.winnability.low-coverage', 'advice', 'content'),
      check('traffic.source.sync-lag', 'warn', 'traffic.sync-lag.behind', 'ingestion is behind', 'integrations'),
    ],
    ...at('2026-07-31T05:00:00.000Z'),
  })

  const stored = db.select().from(doctorHealthState).where(eq(doctorHealthState.projectId, projectId)).get()!
  expect(stored.code).toBe('traffic.sync-lag.behind')
})

test('health reaches a webhook that never subscribed to health events', async () => {
  // Requiring opt-in guaranteed the one alarm that matters is the one nobody
  // subscribed to. It shipped, no subscription named it, and every degradation
  // was computed then dropped at delivery.
  const { db, notifier, projectId } = harness()
  db.update(notifications)
    .set({ config: { url: 'https://hooks.example/runs', events: ['run.completed', 'run.failed'] } } as never)
    .where(eq(notifications.projectId, projectId)).run()
  const sent: unknown[] = []
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...a: unknown[]) => { sent.push(a[1]) })

  const event = await notifier.onHealthChecked(projectId, {
    checks: [check('traffic.source.sync-lag', 'fail', 'traffic.sync-lag.discarding')],
    ...at('2026-07-31T05:00:00.000Z'),
  })

  expect(event).toBe('health.degraded')
  expect(sent).toHaveLength(1)
})

test('notifiedAt records delivery, not intent', async () => {
  const { db, notifier, projectId } = harness()
  // No enabled webhook at all: the observation must still be stored, but
  // nothing was delivered, so notifiedAt stays null.
  db.update(notifications).set({ enabled: false } as never)
    .where(eq(notifications.projectId, projectId)).run()

  const event = await notifier.onHealthChecked(projectId, {
    checks: [check('traffic.source.sync-lag', 'fail', 'traffic.sync-lag.discarding')],
    ...at('2026-07-31T05:00:00.000Z'),
  })

  expect(event).toBe('health.degraded')
  const stored = db.select().from(doctorHealthState).where(eq(doctorHealthState.projectId, projectId)).get()!
  expect(stored.status).toBe('fail')
  expect(stored.notifiedAt).toBeNull()
})

test('a breach opening under an existing one still notifies', async () => {
  // The trigger keyed on the worst check's code, and equally severe checks are
  // ranked by id, so a second failure sorting later left the headline
  // untouched. That outage was graded, listed in `failing`, and then dropped at
  // the trigger: the ranking decided who leads, and silently also decided
  // whether anyone was told at all.
  const { notifier, projectId } = harness()
  const sent: { health: { failing: { code: string }[] } }[] = []
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...a: unknown[]) => { sent.push(a[1] as never) })

  await notifier.onHealthChecked(projectId, {
    checks: [check('a.first', 'warn', 'a.first.code')],
    ...at('2026-07-31T05:00:00.000Z'),
  })
  const event = await notifier.onHealthChecked(projectId, {
    checks: [
      check('a.first', 'warn', 'a.first.code'),
      check('b.second', 'warn', 'b.second.code'),
    ],
    ...at('2026-07-31T11:00:00.000Z'),
  })

  expect(event).toBe('health.degraded')
  expect(sent).toHaveLength(2)
  expect(sent.at(-1)!.health.failing.map((c) => c.code)).toEqual(['a.first.code', 'b.second.code'])
})

test('an unchanged breach set stays silent', async () => {
  // Re-firing on the SET must not decay into re-firing on every pass. An
  // operator who gets the same warning every six hours stops reading the
  // channel, which recreates the original failure with extra steps.
  const { notifier, projectId } = harness()
  const sent: unknown[] = []
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...a: unknown[]) => { sent.push(a[1]) })

  const twoBreaches = [check('a.first', 'warn', 'a.first.code'), check('b.second', 'warn', 'b.second.code')]
  await notifier.onHealthChecked(projectId, { checks: twoBreaches, ...at('2026-07-31T05:00:00.000Z') })
  const event = await notifier.onHealthChecked(projectId, { checks: twoBreaches, ...at('2026-07-31T11:00:00.000Z') })

  expect(event).toBeNull()
  expect(sent).toHaveLength(1)
})

test('a row written before the signature column does not page on the first pass', async () => {
  // Every already-degraded project carries a NULL signature the moment this
  // ships. Reading unknown as "changed" would turn one deploy into an alert
  // storm across the whole instance, so the first pass falls back to the code
  // rule and only records what it saw.
  const { db, notifier, projectId } = harness()
  const sent: unknown[] = []
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...a: unknown[]) => { sent.push(a[1]) })

  await notifier.onHealthChecked(projectId, {
    checks: [check('a.first', 'warn', 'a.first.code')],
    ...at('2026-07-31T05:00:00.000Z'),
  })
  db.update(doctorHealthState).set({ failingSignature: null } as never)
    .where(eq(doctorHealthState.projectId, projectId)).run()

  const event = await notifier.onHealthChecked(projectId, {
    checks: [
      check('a.first', 'warn', 'a.first.code'),
      check('b.second', 'warn', 'b.second.code'),
    ],
    ...at('2026-07-31T11:00:00.000Z'),
  })

  expect(event).toBeNull()
  expect(sent).toHaveLength(1)
  const stored = db.select().from(doctorHealthState).where(eq(doctorHealthState.projectId, projectId)).get()!
  expect(stored.failingSignature).toBe('warn:a.first.code,warn:b.second.code')
})
