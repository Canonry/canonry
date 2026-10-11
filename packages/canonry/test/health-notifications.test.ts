import { test, expect, onTestFinished, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createClient, migrate, doctorHealthState, notifications, projects } from '@ainyc/canonry-db'
import type { HealthWebhookPayload } from '@ainyc/canonry-contracts'
import { addLogListener, type LogEntry } from '../src/logger.js'
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
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...args: unknown[]) => { sent.push(args[1]); return true })

  const event = await notifier.onHealthChecked(projectId, {
    checks: [check('traffic.source.sync-lag', 'fail', 'traffic.sync-lag.discarding', 'discarding now')],
    ...at('2026-07-31T05:00:00.000Z'),
  })

  expect(event).toBe('health.degraded')
  expect(sent).toHaveLength(1)
  const payload = sent[0] as { event: string; health: { status: string; previousStatus: null; code: string; added?: string[]; cleared?: string[] } }
  expect(payload.event).toBe('health.degraded')
  expect(payload.health.status).toBe('fail')
  expect(payload.health.previousStatus).toBeNull()
  expect(payload.health.code).toBe('traffic.sync-lag.discarding')
  // With nothing on record, everything failing is new and nothing has cleared.
  expect(payload.health.added).toEqual(['traffic.sync-lag.discarding'])
  expect(payload.health.cleared).toEqual([])
  // The payload deliberately carries no `run` — this is not a finding.
  expect(payload).not.toHaveProperty('run')

  const stored = db.select().from(doctorHealthState).where(eq(doctorHealthState.projectId, projectId)).get()!
  expect(stored.status).toBe('fail')
})

test('a repeat of the same problem stays silent so the channel keeps meaning something', async () => {
  const { notifier, projectId } = harness()
  const sent: unknown[] = []
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...args: unknown[]) => { sent.push(args[1]); return true })

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
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async () => true)

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
    return true
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
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...a: unknown[]) => { sent.push(a); return true })

  const event = await notifier.onHealthChecked(projectId, {
    checks: [check('traffic.source.sync-lag', 'ok', 'traffic.sync-lag.current')],
    ...at('2026-07-31T05:00:00.000Z'),
  })

  expect(event).toBeNull()
  expect(sent).toHaveLength(0)
})

test('a skipped check does not mask a failing one', async () => {
  const { notifier, projectId, db } = harness()
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async () => true)

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
    return true
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
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async () => true)

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
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async () => true)

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
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...a: unknown[]) => { sent.push(a[1]); return true })

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
  const sent: { health: { code: string; failing: { code: string }[]; added?: string[]; cleared?: string[] } }[] = []
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...a: unknown[]) => { sent.push(a[1] as never); return true })

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
  // The headline did not move; the alert names the check beneath it as the news.
  expect(sent.at(-1)!.health.code).toBe('a.first.code')
  expect(sent.at(-1)!.health.added).toEqual(['b.second.code'])
  expect(sent.at(-1)!.health.cleared).toEqual([])
})

test('an unchanged breach set stays silent', async () => {
  // Re-firing on the SET must not decay into re-firing on every pass. An
  // operator who gets the same warning every six hours stops reading the
  // channel, which recreates the original failure with extra steps.
  const { notifier, projectId } = harness()
  const sent: unknown[] = []
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...a: unknown[]) => { sent.push(a[1]); return true })

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
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...a: unknown[]) => { sent.push(a[1]); return true })

  await notifier.onHealthChecked(projectId, {
    checks: [check('a.first', 'warn', 'a.first.code')],
    ...at('2026-07-31T05:00:00.000Z'),
  })
  db.update(doctorHealthState).set({ failingSignature: null, failingChecks: null } as never)
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

test('report advisories never page, change health signatures, or mask real recovery', async () => {
  const { notifier, projectId, db } = harness()
  const send = vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async () => true)
  const advisory = { ...check('report.sweeps', 'warn', 'report.sweeps.missing'), notificationPolicy: 'silent' as const }
  const healthy = check('ga.auth', 'ok', 'ga.auth.connected')
  expect(await notifier.onHealthChecked(projectId, { checks: [healthy, advisory], ...at('2026-09-30T12:00:00Z') })).toBeNull()
  expect(await notifier.onHealthChecked(projectId, { checks: [healthy, { ...advisory, code: 'report.sweeps.ready', status: 'ok' }], ...at('2026-10-01T12:00:00Z') })).toBeNull()
  const failing = check('ga.auth', 'fail', 'ga.auth.failed')
  expect(await notifier.onHealthChecked(projectId, { checks: [failing, advisory], ...at('2026-10-02T12:00:00Z') })).toBe('health.degraded')
  expect(await notifier.onHealthChecked(projectId, { checks: [advisory], ...at('2026-10-02T13:00:00Z') })).toBeNull()
  expect(db.select().from(doctorHealthState).where(eq(doctorHealthState.projectId, projectId)).get()?.status).toBe('fail')
  expect(await notifier.onHealthChecked(projectId, { checks: [healthy, advisory], ...at('2026-10-03T12:00:00Z') })).toBe('health.recovered')
  expect(send).toHaveBeenCalledTimes(2)
})

// Alert only on new or worse, and say what changed.
//
// The trigger used to fire whenever the failing set CHANGED, clearing
// included. One transient blip therefore produced two alerts: one when it
// opened, and a second "degraded" alert when it cleared, each re-listing every
// standing item with nothing saying what had changed. On a production install
// that was most of the channel, and none of it was a recovery.

type HealthPayload = { event: string; health: HealthWebhookPayload['health'] }

/** Capture alerts instead of delivering them, reporting each as accepted by its webhook. */
function capture(notifier: Notifier, opts: { accepted?: () => boolean } = {}): HealthPayload[] {
  const sent: HealthPayload[] = []
  const delivery = notifier as unknown as { sendWebhook: (url: string, payload: unknown) => Promise<boolean> }
  vi.spyOn(delivery, 'sendWebhook').mockImplementation(async (_url, payload) => {
    sent.push(payload as HealthPayload)
    return opts.accepted?.() ?? true
  })
  return sent
}

const storedState = (db: ReturnType<typeof harness>['db'], projectId: string) =>
  db.select().from(doctorHealthState).where(eq(doctorHealthState.projectId, projectId)).get()!

/** Notifier log lines for the health channel, as an operator would grep them. */
function healthLogs(): LogEntry[] {
  const entries: LogEntry[] = []
  onTestFinished(addLogListener(entry => { if (entry.module === 'Notifier' && entry.action.startsWith('health.')) entries.push(entry) }))
  return entries
}

const standing = check('ga.data.recent-data', 'warn', 'ga.data.aging', 'GA4 data is aging', 'integrations')
const blip = check('gsc.sync.recent-failures', 'fail', 'gsc.sync.repeated-failures', 'Search Console syncs are failing', 'integrations')
const healthy = check('google.auth.connection', 'ok', 'google.auth.connected')
// A check's code changes with its severity, so these pairs are one check each.
const syncBehind = check('traffic.source.sync-lag', 'warn', 'traffic.sync-lag.behind', 'x', 'integrations')
const syncDiscarding = check('traffic.source.sync-lag', 'fail', 'traffic.sync-lag.discarding', 'x', 'integrations')

test('a healthy project that starts failing notifies, with the failing check as new', async () => {
  const { notifier, projectId } = harness()
  const sent = capture(notifier)

  expect(await notifier.onHealthChecked(projectId, { checks: [healthy], ...at('2026-09-01T00:00:00.000Z') })).toBeNull()
  expect(await notifier.onHealthChecked(projectId, { checks: [healthy, blip], ...at('2026-09-01T06:00:00.000Z') })).toBe('health.degraded')

  expect(sent).toHaveLength(1)
  expect(sent[0]!.health).toMatchObject({ status: 'fail', previousStatus: 'ok', added: ['gsc.sync.repeated-failures'], cleared: [] })
})

test('a check that worsens from warn to fail notifies, and counts as new', async () => {
  const { notifier, projectId } = harness()
  const sent = capture(notifier)

  await notifier.onHealthChecked(projectId, { checks: [syncBehind], ...at('2026-09-01T00:00:00.000Z') })
  expect(await notifier.onHealthChecked(projectId, { checks: [syncDiscarding], ...at('2026-09-01T06:00:00.000Z') })).toBe('health.degraded')

  expect(sent).toHaveLength(2)
  // The warning's code is gone, but its check is still failing: nothing cleared.
  expect(sent[1]!.health).toMatchObject({ status: 'fail', previousStatus: 'warn', added: ['traffic.sync-lag.discarding'], cleared: [] })
})

test('a secondary check clearing sends nothing, is stored, and reads as new if it returns', async () => {
  const { notifier, projectId, db } = harness()
  const sent = capture(notifier)
  const logs = healthLogs()

  await notifier.onHealthChecked(projectId, { checks: [blip, standing], ...at('2026-09-01T00:00:00.000Z') })
  expect(storedState(db, projectId).failingSignature).toBe('fail:gsc.sync.repeated-failures,warn:ga.data.aging')

  // The set only shrank: still degraded, nothing new to say.
  expect(await notifier.onHealthChecked(projectId, { checks: [blip], ...at('2026-09-01T06:00:00.000Z') })).toBeNull()
  expect(sent).toHaveLength(1)
  expect(storedState(db, projectId)).toMatchObject({
    status: 'fail', code: 'gsc.sync.repeated-failures', failingSignature: 'fail:gsc.sync.repeated-failures', checkedAt: '2026-09-01T06:00:00.000Z',
  })
  expect(logs.at(-1)).toMatchObject({ action: 'health.improved', code: 'gsc.sync.repeated-failures', cleared: ['ga.data.aging'], eased: [] })

  // It compares against the pass that cleared it, so the return is a gain.
  expect(await notifier.onHealthChecked(projectId, { checks: [blip, standing], ...at('2026-09-01T12:00:00.000Z') })).toBe('health.degraded')
  expect(sent).toHaveLength(2)
  expect(sent[1]!.health.added).toEqual(['ga.data.aging'])
  expect(sent[1]!.health.cleared).toEqual([])
})

test('a blip clearing back to the standing headline sends no second alert', async () => {
  // The production pattern: a standing warning, a transient failure on top of
  // it, and the failure clearing six hours later. The clearing pass changes
  // both the headline and the status, and is still not news.
  const { notifier, projectId, db } = harness()
  const sent = capture(notifier)
  const logs = healthLogs()

  await notifier.onHealthChecked(projectId, { checks: [standing], ...at('2026-09-01T00:00:00.000Z') })
  await notifier.onHealthChecked(projectId, { checks: [standing, blip], ...at('2026-09-01T06:00:00.000Z') })
  expect(sent).toHaveLength(2)
  expect(sent[1]!.health).toMatchObject({ code: 'gsc.sync.repeated-failures', previousStatus: 'warn', added: ['gsc.sync.repeated-failures'], cleared: [] })

  expect(await notifier.onHealthChecked(projectId, { checks: [standing], ...at('2026-09-01T12:00:00.000Z') })).toBeNull()
  expect(sent).toHaveLength(2)
  expect(storedState(db, projectId)).toMatchObject({ status: 'warn', code: 'ga.data.aging', failingSignature: 'warn:ga.data.aging' })
  expect(logs.at(-1)).toMatchObject({ action: 'health.improved', status: 'warn', code: 'ga.data.aging', cleared: ['gsc.sync.repeated-failures'] })

  // The standing warning repeating is still the same news.
  expect(await notifier.onHealthChecked(projectId, { checks: [standing], ...at('2026-09-01T18:00:00.000Z') })).toBeNull()
  expect(logs.at(-1)).toMatchObject({ action: 'health.unchanged', status: 'warn', code: 'ga.data.aging' })
  expect(sent).toHaveLength(2)
})

test('a check easing to a lower severity sends nothing, although its code changes', async () => {
  // Compared by code, an easing check reads as one entry cleared and another
  // gained, which sent a second "degraded" alert for one blip.
  const { notifier, projectId, db } = harness()
  const sent = capture(notifier)
  const logs = healthLogs()
  const allErrored = check('traffic.source.connected', 'fail', 'traffic.source.all-errored', 'x', 'integrations')
  const partiallyErrored = check('traffic.source.connected', 'warn', 'traffic.source.partially-errored', 'x', 'integrations')

  await notifier.onHealthChecked(projectId, { checks: [allErrored], ...at('2026-09-01T00:00:00.000Z') })
  expect(await notifier.onHealthChecked(projectId, { checks: [partiallyErrored], ...at('2026-09-01T06:00:00.000Z') })).toBeNull()

  expect(sent).toHaveLength(1)
  expect(storedState(db, projectId)).toMatchObject({ status: 'warn', failingSignature: 'warn:traffic.source.partially-errored' })
  expect(logs.at(-1)).toMatchObject({ action: 'health.improved', cleared: [], eased: ['traffic.source.partially-errored'] })

  // Getting worse again is news.
  expect(await notifier.onHealthChecked(projectId, { checks: [allErrored], ...at('2026-09-01T12:00:00.000Z') })).toBe('health.degraded')
  expect(sent[1]!.health).toMatchObject({ added: ['traffic.source.all-errored'], cleared: [] })
})

test('a standing warning that fails for one pass and returns sends one alert for the failure', async () => {
  const { notifier, projectId } = harness()
  const sent = capture(notifier)
  const logs = healthLogs()
  const quotaPending = check('gbp.account.access', 'warn', 'gbp.account.quota-pending', 'x', 'auth')
  const unreachable = check('gbp.account.access', 'fail', 'gbp.account.list-unreachable', 'x', 'auth')

  await notifier.onHealthChecked(projectId, { checks: [quotaPending], ...at('2026-09-01T00:00:00.000Z') })
  expect(await notifier.onHealthChecked(projectId, { checks: [unreachable], ...at('2026-09-01T06:00:00.000Z') })).toBe('health.degraded')
  expect(sent[1]!.health).toMatchObject({ added: ['gbp.account.list-unreachable'], cleared: [] })

  // Back to the warning the operator already knows about.
  expect(await notifier.onHealthChecked(projectId, { checks: [quotaPending], ...at('2026-09-01T12:00:00.000Z') })).toBeNull()
  expect(logs.at(-1)).toMatchObject({ action: 'health.improved', cleared: [], eased: ['gbp.account.quota-pending'] })
  expect(await notifier.onHealthChecked(projectId, { checks: [quotaPending], ...at('2026-09-01T18:00:00.000Z') })).toBeNull()
  expect(sent).toHaveLength(2)
})

test('a check reporting a different problem at the same severity is news, and nothing cleared', async () => {
  const { notifier, projectId } = harness()
  const sent = capture(notifier)
  const stale = check('ga.data.recent-data', 'warn', 'ga.data.stale', 'GA4 data is stale', 'integrations')

  await notifier.onHealthChecked(projectId, { checks: [standing], ...at('2026-09-01T00:00:00.000Z') })
  expect(await notifier.onHealthChecked(projectId, { checks: [stale], ...at('2026-09-01T06:00:00.000Z') })).toBe('health.degraded')

  expect(sent[1]!.health).toMatchObject({ status: 'warn', previousStatus: 'warn', added: ['ga.data.stale'], cleared: [] })
})

test('the next alert lists what cleared since the last one delivered, not only since the last pass', async () => {
  const { notifier, projectId, db } = harness()
  const sent = capture(notifier)

  await notifier.onHealthChecked(projectId, { checks: [blip, standing], ...at('2026-09-01T00:00:00.000Z') })
  const delivered = 'fail:gsc.sync.repeated-failures:gsc.sync.recent-failures,warn:ga.data.aging:ga.data.recent-data'
  expect(storedState(db, projectId)).toMatchObject({ failingChecks: delivered, notifiedSignature: delivered })
  // Quiet pass: the warning clears and nobody is told.
  await notifier.onHealthChecked(projectId, { checks: [blip], ...at('2026-09-01T06:00:00.000Z') })
  expect(storedState(db, projectId)).toMatchObject({ failingChecks: 'fail:gsc.sync.repeated-failures:gsc.sync.recent-failures', notifiedSignature: delivered })

  expect(await notifier.onHealthChecked(projectId, { checks: [blip, syncBehind], ...at('2026-09-01T12:00:00.000Z') })).toBe('health.degraded')
  expect(sent).toHaveLength(2)
  expect(sent[1]!.health.added).toEqual(['traffic.sync-lag.behind'])
  expect(sent[1]!.health.cleared).toEqual(['ga.data.aging'])
  expect(storedState(db, projectId).notifiedSignature).toBe('fail:gsc.sync.repeated-failures:gsc.sync.recent-failures,warn:traffic.sync-lag.behind:traffic.source.sync-lag')
})

test('an alert no webhook accepted is sent again on the next pass, until one is delivered', async () => {
  // The pass is stored before the send, so comparing only against the pass
  // before made an undelivered failure old news one pass later. Now that a
  // clearing pass is quiet, nothing else would ever have surfaced it.
  const { notifier, projectId } = harness()
  let accepted = true
  const sent = capture(notifier, { accepted: () => accepted })
  const credentials = check('traffic.source.credentials', 'fail', 'traffic.credentials.failed', 'x', 'auth')

  await notifier.onHealthChecked(projectId, { checks: [standing], ...at('2026-09-01T00:00:00.000Z') })
  accepted = false
  expect(await notifier.onHealthChecked(projectId, { checks: [credentials, standing], ...at('2026-09-01T06:00:00.000Z') })).toBe('health.degraded')
  expect(await notifier.onHealthChecked(projectId, { checks: [credentials, standing], ...at('2026-09-01T12:00:00.000Z') })).toBe('health.degraded')
  accepted = true
  expect(await notifier.onHealthChecked(projectId, { checks: [credentials, standing], ...at('2026-09-01T18:00:00.000Z') })).toBe('health.degraded')
  // Still new to the operator, three passes after it started.
  expect(sent.at(-1)!.health).toMatchObject({ previousStatus: 'fail', added: ['traffic.credentials.failed'], cleared: [] })

  // Delivered, so the same set is no longer news.
  expect(await notifier.onHealthChecked(projectId, { checks: [credentials, standing], ...at('2026-09-02T00:00:00.000Z') })).toBeNull()
  expect(sent).toHaveLength(4)
})

test('a first alert no webhook accepted is sent again too', async () => {
  const { notifier, projectId } = harness()
  let accepted = false
  const sent = capture(notifier, { accepted: () => accepted })

  expect(await notifier.onHealthChecked(projectId, { checks: [blip], ...at('2026-09-01T00:00:00.000Z') })).toBe('health.degraded')
  accepted = true
  expect(await notifier.onHealthChecked(projectId, { checks: [blip], ...at('2026-09-01T06:00:00.000Z') })).toBe('health.degraded')
  expect(sent.at(-1)!.health).toMatchObject({ added: ['gsc.sync.repeated-failures'], cleared: [] })
  expect(await notifier.onHealthChecked(projectId, { checks: [blip], ...at('2026-09-01T12:00:00.000Z') })).toBeNull()
  expect(sent).toHaveLength(2)
})

test('a recurring breach whose alert failed is retried after a restart without losing earlier clearances', async () => {
  const { db, notifier, projectId } = harness()
  let accepted = true
  const sent = capture(notifier, { accepted: () => accepted })

  await notifier.onHealthChecked(projectId, { checks: [blip, standing, syncBehind], ...at('2026-09-01T00:00:00.000Z') })
  expect(await notifier.onHealthChecked(projectId, { checks: [blip], ...at('2026-09-01T06:00:00.000Z') })).toBeNull()
  accepted = false
  expect(await notifier.onHealthChecked(projectId, { checks: [blip, standing], ...at('2026-09-01T12:00:00.000Z') })).toBe('health.degraded')
  expect(sent.at(-1)!.health).toMatchObject({ added: ['ga.data.aging'], cleared: ['traffic.sync-lag.behind'] })

  const restarted = new Notifier(db, 'https://canonry.test')
  const retried = capture(restarted)
  expect(await restarted.onHealthChecked(projectId, { checks: [blip, standing], ...at('2026-09-01T18:00:00.000Z') })).toBe('health.degraded')
  expect(retried).toHaveLength(1)
  expect(retried[0]!.health).toMatchObject({ added: ['ga.data.aging'], cleared: ['traffic.sync-lag.behind'] })
  expect(await restarted.onHealthChecked(projectId, { checks: [blip, standing], ...at('2026-09-02T00:00:00.000Z') })).toBeNull()
  expect(retried).toHaveLength(1)
})

test.each([
  { when: 'after upgrading', stale: false },
  { when: 'after a rollback and return', stale: true },
])('a refused alert on the first pass $when is retried after a restart', async ({ stale }) => {
  const { db, notifier, projectId } = harness()
  let accepted = true
  capture(notifier, { accepted: () => accepted })
  await notifier.onHealthChecked(projectId, { checks: [blip], ...at('2026-09-01T00:00:00.000Z') })
  db.update(doctorHealthState).set({
    checkedAt: '2026-09-01T06:00:00.000Z',
    failingSignature: 'fail:gsc.sync.repeated-failures,warn:ga.data.aging',
    ...(stale ? {} : { failingChecks: null, notifiedSignature: null }),
  } as never).where(eq(doctorHealthState.projectId, projectId)).run()

  const checks = [blip, standing, syncBehind]
  accepted = false
  expect(await notifier.onHealthChecked(projectId, { checks, ...at('2026-09-01T12:00:00.000Z') })).toBe('health.degraded')
  const restarted = new Notifier(db, 'https://canonry.test')
  const retried = capture(restarted)
  expect(await restarted.onHealthChecked(projectId, { checks, ...at('2026-09-01T18:00:00.000Z') })).toBe('health.degraded')
  expect(retried).toHaveLength(1)
  expect(retried[0]!.health).toMatchObject({ added: ['traffic.sync-lag.behind'], cleared: [] })
  expect(await restarted.onHealthChecked(projectId, { checks, ...at('2026-09-02T00:00:00.000Z') })).toBeNull()
  expect(retried).toHaveLength(1)
})

test('with no webhook to send to, an alert is not retried on every pass', async () => {
  const { db, notifier, projectId } = harness()
  db.update(notifications).set({ enabled: false } as never)
    .where(eq(notifications.projectId, projectId)).run()
  const logs = healthLogs()

  expect(await notifier.onHealthChecked(projectId, { checks: [blip], ...at('2026-09-01T00:00:00.000Z') })).toBe('health.degraded')
  expect(await notifier.onHealthChecked(projectId, { checks: [blip], ...at('2026-09-01T06:00:00.000Z') })).toBeNull()
  expect(logs.map(entry => entry.action)).toEqual(['health.notified', 'health.unchanged'])
})

test.each([
  { outcome: 'cleared', after: check('traffic.source.sync-lag', 'ok', 'traffic.sync-lag.current') },
  { outcome: 'eased', after: syncBehind },
])('a refused breach that $outcome no longer owes a retry', async ({ after }) => {
  const { notifier, projectId } = harness()
  let accepted = true
  const sent = capture(notifier, { accepted: () => accepted })
  await notifier.onHealthChecked(projectId, { checks: [standing], ...at('2026-09-01T00:00:00.000Z') })
  accepted = false
  await notifier.onHealthChecked(projectId, { checks: [standing, syncDiscarding], ...at('2026-09-01T06:00:00.000Z') })

  expect(await notifier.onHealthChecked(projectId, { checks: [standing, after], ...at('2026-09-01T12:00:00.000Z') })).toBeNull()
  expect(await notifier.onHealthChecked(projectId, { checks: [standing, after], ...at('2026-09-01T18:00:00.000Z') })).toBeNull()
  expect(sent).toHaveLength(2)
})

test('disabling the last webhook cancels delivery debt without retrying every pass', async () => {
  const { db, notifier, projectId } = harness()
  let accepted = true
  const sent = capture(notifier, { accepted: () => accepted })
  await notifier.onHealthChecked(projectId, { checks: [blip], ...at('2026-09-01T00:00:00.000Z') })
  accepted = false
  await notifier.onHealthChecked(projectId, { checks: [blip, standing], ...at('2026-09-01T06:00:00.000Z') })
  db.update(notifications).set({ enabled: false } as never).where(eq(notifications.projectId, projectId)).run()

  await notifier.onHealthChecked(projectId, { checks: [blip, standing], ...at('2026-09-01T12:00:00.000Z') })
  expect(await notifier.onHealthChecked(projectId, { checks: [blip, standing], ...at('2026-09-01T18:00:00.000Z') })).toBeNull()
  expect(sent).toHaveLength(2)
})

test('a refused legacy headline that clears does not owe unrelated standing checks', async () => {
  const { db, notifier, projectId } = harness()
  let accepted = true
  const sent = capture(notifier, { accepted: () => accepted })
  await notifier.onHealthChecked(projectId, { checks: [standing], ...at('2026-09-01T00:00:00.000Z') })
  db.update(doctorHealthState).set({ failingSignature: null, failingChecks: null, notifiedSignature: null } as never)
    .where(eq(doctorHealthState.projectId, projectId)).run()
  accepted = false
  expect(await notifier.onHealthChecked(projectId, { checks: [standing, blip], ...at('2026-09-01T06:00:00.000Z') })).toBe('health.degraded')

  expect(await notifier.onHealthChecked(projectId, { checks: [standing], ...at('2026-09-01T12:00:00.000Z') })).toBeNull()
  expect(sent).toHaveLength(2)
})

test('a superseded pending symptom does not join retries of its failing cause', async () => {
  const { notifier, projectId } = harness()
  let accepted = true
  const sent = capture(notifier, { accepted: () => accepted })
  await notifier.onHealthChecked(projectId, { checks: [standing], ...at('2026-09-01T00:00:00.000Z') })
  accepted = false
  await notifier.onHealthChecked(projectId, { checks: [standing, blip], ...at('2026-09-01T06:00:00.000Z') })
  const cause = check('google.auth.connection', 'fail', 'google.auth.refresh-failed', 'x', 'auth')
  const setAside = {
    ...check(blip.id, 'skipped', `${blip.id}.superseded`, 'x', 'integrations'),
    details: { supersededBy: [cause.id], supersededStatus: 'fail', supersededCode: blip.code },
  }
  await notifier.onHealthChecked(projectId, { checks: [standing, cause, setAside], ...at('2026-09-01T12:00:00.000Z') })
  expect(await notifier.onHealthChecked(projectId, { checks: [standing, cause, setAside], ...at('2026-09-01T18:00:00.000Z') })).toBe('health.degraded')
  expect(sent.at(-1)!.health).toMatchObject({ added: ['google.auth.refresh-failed'], cleared: [] })
})

test('a pass recorded by an older writer invalidates stale pending retries', async () => {
  const { db, notifier, projectId } = harness()
  let accepted = true
  const sent = capture(notifier, { accepted: () => accepted })
  await notifier.onHealthChecked(projectId, { checks: [blip], ...at('2026-09-01T00:00:00.000Z') })
  accepted = false
  await notifier.onHealthChecked(projectId, { checks: [blip, syncBehind], ...at('2026-09-01T06:00:00.000Z') })
  // A rolled-back binary delivered the lag plus a new warning, leaving the ids behind.
  db.update(doctorHealthState).set({
    checkedAt: '2026-09-01T12:00:00.000Z',
    failingSignature: 'fail:gsc.sync.repeated-failures,warn:ga.data.aging,warn:traffic.sync-lag.behind',
  } as never).where(eq(doctorHealthState.projectId, projectId)).run()

  expect(await notifier.onHealthChecked(projectId, { checks: [blip, standing, syncBehind], ...at('2026-09-01T18:00:00.000Z') })).toBeNull()
  expect(await notifier.onHealthChecked(projectId, { checks: [blip, standing, syncBehind], ...at('2026-09-02T00:00:00.000Z') })).toBeNull()
  expect(sent).toHaveLength(2)
})

test('an alert no webhook accepted does not move what the next one measures cleared from', async () => {
  const { notifier, projectId, db } = harness()
  let accepted = true
  const sent = capture(notifier, { accepted: () => accepted })

  await notifier.onHealthChecked(projectId, { checks: [blip, standing], ...at('2026-09-01T00:00:00.000Z') })
  const delivered = storedState(db, projectId).notifiedSignature
  await notifier.onHealthChecked(projectId, { checks: [blip], ...at('2026-09-01T06:00:00.000Z') })
  accepted = false
  await notifier.onHealthChecked(projectId, { checks: [blip, syncDiscarding], ...at('2026-09-01T12:00:00.000Z') })
  expect(storedState(db, projectId).notifiedSignature).toBe(delivered)
  accepted = true

  const another = check('gbp.data.recent-sync', 'warn', 'gbp.data.aging', 'x', 'integrations')
  await notifier.onHealthChecked(projectId, { checks: [blip, syncDiscarding, another], ...at('2026-09-01T18:00:00.000Z') })
  // The sync lag is a pass old but its alert never arrived, so it is still new.
  // The GA4 warning cleared before that undelivered alert.
  expect(sent.at(-1)!.health).toMatchObject({ added: ['traffic.sync-lag.discarding', 'gbp.data.aging'], cleared: ['ga.data.aging'] })
})

test('recovery lists everything that cleared, including checks that cleared on a quiet pass', async () => {
  const { notifier, projectId, db } = harness()
  const sent = capture(notifier)
  const logs = healthLogs()

  await notifier.onHealthChecked(projectId, { checks: [blip, standing], ...at('2026-09-01T00:00:00.000Z') })
  await notifier.onHealthChecked(projectId, { checks: [blip], ...at('2026-09-01T06:00:00.000Z') })
  expect(await notifier.onHealthChecked(projectId, { checks: [healthy], ...at('2026-09-01T12:00:00.000Z') })).toBe('health.recovered')

  expect(sent).toHaveLength(2)
  expect(sent[1]!).toMatchObject({ event: 'health.recovered', health: { status: 'ok', previousStatus: 'fail', failing: [], added: [] } })
  expect(sent[1]!.health.cleared).toEqual(['gsc.sync.repeated-failures', 'ga.data.aging'])
  expect(storedState(db, projectId).notifiedSignature).toBe('')
  expect(logs.at(-1)).toMatchObject({
    action: 'health.notified', event: 'health.recovered', code: 'health.ok',
    added: [], cleared: ['gsc.sync.repeated-failures', 'ga.data.aging'], delivered: 1,
  })
})

test('the notified log line names the headline and what was new and cleared', async () => {
  const { notifier, projectId } = harness()
  capture(notifier)
  const logs = healthLogs()
  const fresh = check('traffic.source.sync-lag', 'fail', 'traffic.sync-lag.discarding', 'x', 'integrations')

  await notifier.onHealthChecked(projectId, { checks: [blip, standing], ...at('2026-09-01T00:00:00.000Z') })
  await notifier.onHealthChecked(projectId, { checks: [blip, fresh], ...at('2026-09-01T06:00:00.000Z') })

  expect(logs.map(entry => entry.action)).toEqual(['health.notified', 'health.notified'])
  expect(logs[0]).toMatchObject({ code: 'gsc.sync.repeated-failures', added: ['gsc.sync.repeated-failures', 'ga.data.aging'], cleared: [] })
  // The headline is standing; only the log's `added` says which check paged.
  expect(logs[1]).toMatchObject({ event: 'health.degraded', status: 'fail', code: 'gsc.sync.repeated-failures', added: ['traffic.sync-lag.discarding'], cleared: ['ga.data.aging'], subscribers: 1, delivered: 1 })
})

test('a pass that can no longer grade anything is new, not an improvement', async () => {
  // Every failing check dropping out because nothing ran is the set "only
  // losing entries" by name. It is the opposite of getting better.
  const { notifier, projectId } = harness()
  const sent = capture(notifier)

  await notifier.onHealthChecked(projectId, { checks: [standing], ...at('2026-09-01T00:00:00.000Z') })
  const unknown = await notifier.onHealthChecked(projectId, {
    checks: [check('ga.data.recent-data', 'skipped', 'ga.data.not-connected')],
    ...at('2026-09-01T06:00:00.000Z'),
  })

  expect(unknown).toBe('health.degraded')
  expect(sent[1]!.health).toMatchObject({ status: 'warn', code: 'health.no-signal', added: ['health.no-signal'] })
  // The GA4 check was not graded on this pass. Not graded is not cleared.
  expect(sent[1]!.health).not.toHaveProperty('cleared')

  // Still unknown on the next pass: the same news, and then real results
  // returning with nothing failing is a recovery from it.
  expect(await notifier.onHealthChecked(projectId, {
    checks: [check('ga.data.recent-data', 'skipped', 'ga.data.not-connected')],
    ...at('2026-09-01T12:00:00.000Z'),
  })).toBeNull()
  expect(await notifier.onHealthChecked(projectId, { checks: [healthy], ...at('2026-09-01T18:00:00.000Z') })).toBe('health.recovered')
  expect(sent.at(-1)!.health.cleared).toEqual(['health.no-signal'])
})

test('a row from before the signature column does not claim to know what is new, for that one pass', async () => {
  // Its earlier set is unknown, so a worse status still notifies but the alert
  // leaves `added` and `cleared` out instead of listing everything as new.
  const { db, notifier, projectId } = harness()
  const sent = capture(notifier)
  const another = check('traffic.source.sync-lag', 'warn', 'traffic.sync-lag.behind', 'x', 'integrations')

  await notifier.onHealthChecked(projectId, { checks: [standing], ...at('2026-09-01T00:00:00.000Z') })
  db.update(doctorHealthState).set({ failingSignature: null, failingChecks: null, notifiedSignature: null } as never)
    .where(eq(doctorHealthState.projectId, projectId)).run()

  expect(await notifier.onHealthChecked(projectId, { checks: [standing, blip], ...at('2026-09-01T06:00:00.000Z') })).toBe('health.degraded')
  expect(sent[1]!.health).toMatchObject({ status: 'fail', previousStatus: 'warn' })
  expect(sent[1]!.health).not.toHaveProperty('added')
  expect(sent[1]!.health).not.toHaveProperty('cleared')

  // That pass stored the set, so the next one knows exactly what joined it.
  expect(await notifier.onHealthChecked(projectId, { checks: [standing, blip, another], ...at('2026-09-01T12:00:00.000Z') })).toBe('health.degraded')
  expect(sent[2]!.health).toMatchObject({ added: ['traffic.sync-lag.behind'], cleared: [] })
})

// A symptom the runner sets aside while its cause fails (`<id>.superseded`) is
// hidden, not fixed. Both rows: one that stores check ids, and one written by
// the release before they were stored, which is compared by code for a pass.
test.each([
  { row: 'a current row', beforeCheckIds: false },
  { row: 'a row from before check ids were stored', beforeCheckIds: true },
])('a failing check set aside under its cause is not reported as cleared, on $row', async ({ beforeCheckIds }) => {
  const { db, notifier, projectId } = harness()
  const sent = capture(notifier)
  const cause = check('google.auth.connection', 'fail', 'google.auth.refresh-failed', 'x', 'auth')
  const setAside = {
    ...check('gsc.sync.recent-failures', 'skipped', 'gsc.sync.recent-failures.superseded', 'x', 'integrations'),
    details: { supersededBy: ['google.auth.connection'], supersededStatus: 'fail', supersededCode: 'gsc.sync.repeated-failures' },
  }

  await notifier.onHealthChecked(projectId, { checks: [healthy, blip], ...at('2026-09-01T00:00:00.000Z') })
  if (beforeCheckIds) {
    db.update(doctorHealthState).set({ failingChecks: null, notifiedSignature: null } as never)
      .where(eq(doctorHealthState.projectId, projectId)).run()
  }

  expect(await notifier.onHealthChecked(projectId, { checks: [cause, setAside], ...at('2026-09-01T06:00:00.000Z') })).toBe('health.degraded')
  expect(sent[1]!.health).toMatchObject({ code: 'google.auth.refresh-failed', added: ['google.auth.refresh-failed'], cleared: [] })

  // The grant is fixed and the syncs still fail: the symptom is news again.
  expect(await notifier.onHealthChecked(projectId, { checks: [healthy, blip], ...at('2026-09-01T12:00:00.000Z') })).toBe('health.degraded')
  expect(sent[2]!.health).toMatchObject({ added: ['gsc.sync.repeated-failures'], cleared: ['google.auth.refresh-failed'] })
})

// A rollback runs an older release against the same database. It keeps
// `failing_signature` current and sends its own alerts, but knows neither the
// column that carries check ids nor the delivered set, so both go stale. The
// same row shape, with both columns empty, is what every project has on the
// first pass after upgrading.
test.each([
  { when: 'on the first pass after upgrading', stale: false },
  { when: 'after a rollback and return', stale: true },
])('a row last written by an older release is compared by code and re-sends nothing, $when', async ({ stale }) => {
  const { db, notifier, projectId } = harness()
  const sent = capture(notifier)

  await notifier.onHealthChecked(projectId, { checks: [blip], ...at('2026-09-01T00:00:00.000Z') })
  // The older release saw the GA4 warning open under the same headline,
  // alerted, and stored its pass.
  db.update(doctorHealthState).set({
    checkedAt: '2026-09-01T06:00:00.000Z',
    failingSignature: 'fail:gsc.sync.repeated-failures,warn:ga.data.aging',
    ...(stale ? {} : { failingChecks: null, notifiedSignature: null }),
  } as never).where(eq(doctorHealthState.projectId, projectId)).run()

  expect(await notifier.onHealthChecked(projectId, { checks: [blip, standing], ...at('2026-09-01T12:00:00.000Z') })).toBeNull()
  expect(await notifier.onHealthChecked(projectId, { checks: [blip, standing], ...at('2026-09-01T18:00:00.000Z') })).toBeNull()
  expect(sent).toHaveLength(1)

  // The quiet passes stored check ids: a gain still alerts, and an easing check is quiet.
  expect(await notifier.onHealthChecked(projectId, { checks: [blip, standing, syncDiscarding], ...at('2026-09-02T00:00:00.000Z') })).toBe('health.degraded')
  expect(sent[1]!.health).toMatchObject({ added: ['traffic.sync-lag.discarding'], cleared: [] })
  expect(await notifier.onHealthChecked(projectId, { checks: [blip, standing, syncBehind], ...at('2026-09-02T06:00:00.000Z') })).toBeNull()
  expect(sent).toHaveLength(2)
})

test('a pass an older release graded as unknown is not announced again', async () => {
  // The stored ids still spell the (empty) signature, so only the headline
  // shows that the row has moved on since they were written.
  const { db, notifier, projectId } = harness()
  const sent = capture(notifier)
  const ungraded = check('ga.data.recent-data', 'skipped', 'ga.data.not-connected')

  expect(await notifier.onHealthChecked(projectId, { checks: [healthy], ...at('2026-09-01T00:00:00.000Z') })).toBeNull()
  db.update(doctorHealthState).set({ status: 'warn', code: 'health.no-signal', checkedAt: '2026-09-01T06:00:00.000Z', failingSignature: '' } as never)
    .where(eq(doctorHealthState.projectId, projectId)).run()

  expect(await notifier.onHealthChecked(projectId, { checks: [ungraded], ...at('2026-09-01T12:00:00.000Z') })).toBeNull()
  expect(sent).toHaveLength(0)
})
