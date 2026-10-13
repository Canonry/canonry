import { test, expect, onTestFinished, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { createClient, migrate, doctorHealthState, notifications, projects, siteLivenessState } from '@ainyc/canonry-db'
import { Notifier, receivesHealthEvent } from '../src/notifier.js'

// Health alerts reach every webhook on a project, routine warnings included,
// so a channel people watch for emergencies filled up with advisories and
// stopped being read. `health.urgent` and `health.urgent-resolved` carry only
// the problems a person has to act on now, and a webhook that lists them is
// sent nothing else about health.
//
// These pin both halves: what counts as news on the urgent channel, and that
// the general channel behaves exactly as it did.

const GENERAL = 'https://hooks.example/general'
const URGENT = 'https://hooks.example/urgent'

function harness(opts: { urgentEvents?: string[] | null; accept?: (url: string) => boolean } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cnry-urgent-'))
  onTestFinished(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const db = createClient(path.join(tmp, 'test.db'))
  migrate(db)
  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId, name: 'urgentproj', displayName: 'Urgent', canonicalDomain: 'client.example',
    country: 'US', language: 'en', providers: [], createdAt: now, updatedAt: now,
  }).run()
  const addWebhook = (url: string, events: string[]) => db.insert(notifications).values({
    id: crypto.randomUUID(), projectId, channel: 'webhook', config: { url, events },
    enabled: true, createdAt: now, updatedAt: now,
  } as never).run()
  // Deliberately not subscribed to health events: they must still arrive.
  addWebhook(GENERAL, ['run.failed'])
  const urgentEvents = opts.urgentEvents === undefined ? ['health.urgent', 'health.urgent-resolved'] : opts.urgentEvents
  if (urgentEvents) addWebhook(URGENT, urgentEvents)

  const notifier = new Notifier(db, 'https://canonry.test')
  type Sent = { url: string; event: string; health: { status: string; code: string; summary: string; previousStatus: string | null; failing: Array<{ id: string; code: string }>; added?: string[]; cleared?: string[] } }
  const sent: Sent[] = []
  let accept = opts.accept ?? (() => true)
  vi.spyOn(notifier as never, 'sendWebhook').mockImplementation(async (...args: unknown[]) => {
    const url = args[0] as string
    sent.push({ url, ...(args[1] as Omit<Sent, 'url'>) })
    return accept(url)
  })
  const to = (url: string) => sent.filter(s => s.url === url).map(s => s.event)
  const stored = () => db.select().from(doctorHealthState).where(eq(doctorHealthState.projectId, projectId)).get()
  const liveness = () => db.select().from(siteLivenessState).where(eq(siteLivenessState.projectId, projectId)).get()
  const removeWebhook = (url: string) => {
    for (const row of db.select().from(notifications).where(eq(notifications.projectId, projectId)).all()) {
      if ((row.config as { url?: string }).url === url) db.delete(notifications).where(eq(notifications.id, row.id)).run()
    }
  }
  return { db, projectId, notifier, sent, to, stored, liveness, addWebhook, removeWebhook, setAccept: (fn: (url: string) => boolean) => { accept = fn } }
}

let clock = Date.parse('2026-10-01T00:00:00.000Z')
const pass = (...checks: object[]) => ({ checks: checks as never[], checkedAt: new Date(clock += 6 * 3_600_000).toISOString() })

const gaFresh = { id: 'ga.data.recent-data', status: 'ok', code: 'ga.data.fresh', summary: 'GA4 data is current through 2026-10-12.' }
const gaAging = { id: 'ga.data.recent-data', status: 'warn', code: 'ga.data.aging', summary: 'GA4 syncs have stored nothing newer than 2026-10-09 (3 days).' }
const gaStale = { id: 'ga.data.recent-data', status: 'warn', code: 'ga.data.stale', summary: 'GA4 syncs have stored nothing newer than 2026-10-07 (5 days).', remediation: 'Check the tag.', urgent: true }
const gaSkipped = { id: 'ga.data.recent-data', status: 'skipped', code: 'ga.data.no-connection', summary: 'Not connected.' }
const gscFailing = { id: 'gsc.sync.recent-failures', status: 'fail', code: 'gsc.sync.repeated-failures', summary: 'The last 3 Search Console syncs failed.', urgent: true }
const gscOk = { id: 'gsc.sync.recent-failures', status: 'ok', code: 'gsc.sync.ok', summary: 'Search Console syncs are succeeding.' }
const advisory = { id: 'gbp.reviews', status: 'warn', code: 'gbp.reviews.unanswered', summary: '3 reviews have no reply.' }

test('the routing rule: a webhook that lists an urgent event gets only the health events it lists', () => {
  // Every ordinary webhook keeps receiving the general events, listed or not.
  expect(receivesHealthEvent(['run.failed'], 'health.degraded')).toBe(true)
  expect(receivesHealthEvent(undefined, 'health.recovered')).toBe(true)
  expect(receivesHealthEvent(['run.failed'], 'health.urgent')).toBe(false)
  // A scoped webhook receives what it lists and nothing else about health.
  expect(receivesHealthEvent(['health.urgent'], 'health.urgent')).toBe(true)
  expect(receivesHealthEvent(['health.urgent'], 'health.urgent-resolved')).toBe(false)
  expect(receivesHealthEvent(['health.urgent'], 'health.degraded')).toBe(false)
  expect(receivesHealthEvent(['health.urgent', 'health.degraded'], 'health.degraded')).toBe(true)
  expect(receivesHealthEvent(['health.urgent', 'health.degraded'], 'health.recovered')).toBe(false)
})

test('an urgent problem reaches the urgent webhook as urgent and the general webhook as degraded', async () => {
  const { notifier, projectId, sent, to } = harness()
  expect(await notifier.onHealthChecked(projectId, pass(gaStale, gscOk))).toBe('health.degraded')

  expect(to(GENERAL)).toEqual(['health.degraded'])
  expect(to(URGENT)).toEqual(['health.urgent'])
  const urgent = sent.find(s => s.url === URGENT)!
  expect(urgent.health).toMatchObject({ status: 'warn', code: 'ga.data.stale', previousStatus: 'ok', added: ['ga.data.stale'] })
  expect(urgent.health.failing.map(f => f.id)).toEqual(['ga.data.recent-data'])
})

test('a routine warning never reaches the urgent webhook', async () => {
  const { notifier, projectId, to, stored } = harness()
  expect(await notifier.onHealthChecked(projectId, pass(advisory, gaAging, gscOk))).toBe('health.degraded')
  expect(to(GENERAL)).toEqual(['health.degraded'])
  expect(to(URGENT)).toEqual([])
  expect(stored()!.urgentNotified).toBeNull()
})

test('the urgent alert lists only urgent checks, not the warnings standing beside them', async () => {
  const { notifier, projectId, sent } = harness()
  await notifier.onHealthChecked(projectId, pass(advisory, gscFailing, gaStale))
  const urgent = sent.find(s => s.url === URGENT)!
  // Worst first: the failing sync leads, the stale data follows.
  expect(urgent.health.code).toBe('gsc.sync.repeated-failures')
  expect(urgent.health.failing.map(f => f.code)).toEqual(['gsc.sync.repeated-failures', 'ga.data.stale'])
  expect(urgent.health.added).toEqual(['gsc.sync.repeated-failures', 'ga.data.stale'])
})

test('the same urgent problem is said once', async () => {
  const { notifier, projectId, to } = harness()
  await notifier.onHealthChecked(projectId, pass(gaStale))
  await notifier.onHealthChecked(projectId, pass(gaStale))
  await notifier.onHealthChecked(projectId, pass(gaStale))
  expect(to(URGENT)).toEqual(['health.urgent'])
})

test('a warning that becomes urgent is news on the urgent webhook', async () => {
  const { notifier, projectId, to } = harness()
  await notifier.onHealthChecked(projectId, pass(gaAging))
  expect(to(URGENT)).toEqual([])
  await notifier.onHealthChecked(projectId, pass(gaStale))
  expect(to(URGENT)).toEqual(['health.urgent'])
})

test('resolved is sent when no urgent problem remains, and says what the check reads now', async () => {
  const { notifier, projectId, sent, to, stored } = harness()
  await notifier.onHealthChecked(projectId, pass(gaStale, advisory))
  // The advisory is still open, so the project has NOT recovered. The urgent
  // webhook is told its problem is over all the same.
  expect(await notifier.onHealthChecked(projectId, pass(gaFresh, advisory))).toBeNull()

  expect(to(URGENT)).toEqual(['health.urgent', 'health.urgent-resolved'])
  expect(to(GENERAL)).toEqual(['health.degraded'])
  const resolved = sent.filter(s => s.url === URGENT)[1]!
  expect(resolved.health).toMatchObject({
    status: 'ok', code: 'health.urgent.resolved', previousStatus: 'warn',
    summary: 'GA4 data is current through 2026-10-12.', failing: [], cleared: ['ga.data.stale'],
  })
  expect(stored()!.urgentNotified).toBeNull()
})

test('urgent easing back to a plain warning counts as resolved', async () => {
  const { notifier, projectId, to } = harness()
  await notifier.onHealthChecked(projectId, pass(gaStale))
  await notifier.onHealthChecked(projectId, pass(gaAging))
  expect(to(URGENT)).toEqual(['health.urgent', 'health.urgent-resolved'])
})

test('a check that could not run is not a fix', async () => {
  const { notifier, projectId, to, stored } = harness()
  await notifier.onHealthChecked(projectId, pass(gaStale, gscOk))
  // The connection broke, so the freshness check was skipped. That says
  // nothing about the data, and "resolved" here would be false comfort.
  await notifier.onHealthChecked(projectId, pass(gaSkipped, gscOk))
  expect(to(URGENT)).toEqual(['health.urgent'])
  expect(stored()!.urgentNotified).toBe('warn:ga.data.stale:ga.data.recent-data')
  // When it can be graded again and is fine, the problem is over.
  await notifier.onHealthChecked(projectId, pass(gaFresh, gscOk))
  expect(to(URGENT)).toEqual(['health.urgent', 'health.urgent-resolved'])
})

test('one of two clearing is quiet, and its return is news again', async () => {
  const { notifier, projectId, sent, to } = harness()
  await notifier.onHealthChecked(projectId, pass(gaStale, gscFailing))
  await notifier.onHealthChecked(projectId, pass(gaFresh, gscFailing))
  expect(to(URGENT)).toEqual(['health.urgent'])

  await notifier.onHealthChecked(projectId, pass(gaStale, gscFailing))
  expect(to(URGENT)).toEqual(['health.urgent', 'health.urgent'])
  const second = sent.filter(s => s.url === URGENT)[1]!
  expect(second.health.added).toEqual(['ga.data.stale'])
  // The sync problem was already reported: it is listed, and it is not new.
  expect(second.health.failing.map(f => f.code)).toEqual(['gsc.sync.repeated-failures', 'ga.data.stale'])
  expect(second.health.previousStatus).toBe('fail')

  await notifier.onHealthChecked(projectId, pass(gaFresh, gscOk))
  expect(to(URGENT).at(-1)).toBe('health.urgent-resolved')
  expect(sent.filter(s => s.url === URGENT).at(-1)!.health.summary).toBe('2 urgent problems are resolved.')
})

test('an urgent alert no webhook accepted is owed again, whatever the general webhook did', async () => {
  const { notifier, projectId, to, stored, setAccept } = harness({ accept: url => url !== URGENT })
  await notifier.onHealthChecked(projectId, pass(gaStale))
  expect(to(GENERAL)).toEqual(['health.degraded'])
  expect(stored()!.urgentNotified).toBeNull()

  // The general alert was delivered, so the general channel stays quiet. The
  // urgent one is still owed and goes out again.
  setAccept(() => true)
  expect(await notifier.onHealthChecked(projectId, pass(gaStale))).toBeNull()
  expect(to(GENERAL)).toEqual(['health.degraded'])
  expect(to(URGENT)).toEqual(['health.urgent', 'health.urgent'])
  expect(stored()!.urgentNotified).toBe('warn:ga.data.stale:ga.data.recent-data')
})

test('a refused resolved message is sent again on the next pass', async () => {
  const { notifier, projectId, to, stored, setAccept } = harness()
  await notifier.onHealthChecked(projectId, pass(gaStale))
  setAccept(url => url !== URGENT)
  await notifier.onHealthChecked(projectId, pass(gaFresh))
  expect(stored()!.urgentNotified).toBe('warn:ga.data.stale:ga.data.recent-data')
  setAccept(() => true)
  await notifier.onHealthChecked(projectId, pass(gaFresh))
  expect(to(URGENT)).toEqual(['health.urgent', 'health.urgent-resolved', 'health.urgent-resolved'])
  expect(stored()!.urgentNotified).toBeNull()
})

test('with no urgent webhook nothing is recorded, so one added later hears about an open problem', async () => {
  const { notifier, projectId, to, stored, addWebhook } = harness({ urgentEvents: null })
  await notifier.onHealthChecked(projectId, pass(gaStale))
  await notifier.onHealthChecked(projectId, pass(gaStale))
  expect(to(GENERAL)).toEqual(['health.degraded'])
  expect(stored()!.urgentNotified).toBeNull()

  addWebhook(URGENT, ['health.urgent', 'health.urgent-resolved'])
  await notifier.onHealthChecked(projectId, pass(gaStale))
  expect(to(URGENT)).toEqual(['health.urgent'])
  // The general webhook was told on the first pass and is not told again.
  expect(to(GENERAL)).toEqual(['health.degraded'])
})

test('a webhook that lists only health.urgent is not sent the resolved message', async () => {
  const { notifier, projectId, to } = harness({ urgentEvents: ['health.urgent'] })
  await notifier.onHealthChecked(projectId, pass(gaStale))
  await notifier.onHealthChecked(projectId, pass(gaFresh))
  expect(to(URGENT)).toEqual(['health.urgent'])
})

test('a pass that graded nothing resolves nothing', async () => {
  const { notifier, projectId, to } = harness()
  await notifier.onHealthChecked(projectId, pass(gaStale))
  await notifier.onHealthChecked(projectId, pass(gaSkipped))
  expect(to(URGENT)).toEqual(['health.urgent'])
})

// --- the website liveness loop: a confirmed outage is urgent by definition ---

const down = { id: 'site.reachability', status: 'fail', code: 'site.reachability.down', summary: 'https://client.example/ is not responding: HTTP 503.', remediation: 'Check with the host.' }
const up = { id: 'site.reachability', status: 'ok', code: 'site.reachability.up', summary: 'https://client.example/ answered HTTP 200 in 90 ms.' }
const START = Date.parse('2026-09-16T12:00:00.000Z')
const probe = (check: typeof down | typeof up, minutes: number) => ({ check, checkedAt: new Date(START + minutes * 60_000).toISOString() })

test('a confirmed outage reaches the urgent webhook as urgent, once per webhook', async () => {
  const { notifier, projectId, sent, to } = harness()
  await notifier.onSiteLivenessChecked(projectId, probe(down, 0))
  expect(sent).toHaveLength(0)
  expect(await notifier.onSiteLivenessChecked(projectId, probe(down, 10))).toBe('health.degraded')
  expect(to(GENERAL)).toEqual(['health.degraded'])
  expect(to(URGENT)).toEqual(['health.urgent'])
  expect(sent.find(s => s.url === URGENT)!.health).toMatchObject({ status: 'fail', code: 'site.reachability.down', previousStatus: 'ok' })

  expect(await notifier.onSiteLivenessChecked(projectId, probe(up, 20))).toBe('health.recovered')
  expect(to(GENERAL)).toEqual(['health.degraded', 'health.recovered'])
  expect(to(URGENT)).toEqual(['health.urgent', 'health.urgent-resolved'])
})

test('the urgent webhook has its own record of an outage, so its recovery does not depend on the others', async () => {
  // Only the urgent webhook accepts. The general page is refused and is never
  // "paged", so no general recovery is owed; the urgent one still is.
  const { notifier, projectId, to, liveness } = harness({ accept: url => url === URGENT })
  await notifier.onSiteLivenessChecked(projectId, probe(down, 0))
  await notifier.onSiteLivenessChecked(projectId, probe(down, 10))
  expect(liveness()).toMatchObject({ notifiedAt: null, urgentNotifiedAt: probe(down, 10).checkedAt })
  expect(await notifier.onSiteLivenessChecked(projectId, probe(up, 20))).toBeNull()
  expect(to(URGENT)).toEqual(['health.urgent', 'health.urgent-resolved'])
  expect(liveness()!.urgentNotifiedAt).toBeNull()
})

test('an urgent webhook that refused the outage is tried again although another webhook accepted it', async () => {
  const { notifier, projectId, to, setAccept } = harness({ accept: url => url !== URGENT })
  await notifier.onSiteLivenessChecked(projectId, probe(down, 0))
  await notifier.onSiteLivenessChecked(projectId, probe(down, 10))
  expect(to(GENERAL)).toEqual(['health.degraded'])
  expect(to(URGENT)).toEqual(['health.urgent'])

  setAccept(() => true)
  // The general webhook was told and stays quiet. The urgent one is still owed.
  expect(await notifier.onSiteLivenessChecked(projectId, probe(down, 20))).toBeNull()
  expect(to(GENERAL)).toEqual(['health.degraded'])
  expect(to(URGENT)).toEqual(['health.urgent', 'health.urgent'])
  await notifier.onSiteLivenessChecked(projectId, probe(down, 30))
  expect(to(URGENT)).toEqual(['health.urgent', 'health.urgent'])
})

test('a refused "back up" is sent again on the next pass', async () => {
  const { notifier, projectId, to, setAccept } = harness()
  await notifier.onSiteLivenessChecked(projectId, probe(down, 0))
  await notifier.onSiteLivenessChecked(projectId, probe(down, 10))
  setAccept(url => url !== URGENT)
  await notifier.onSiteLivenessChecked(projectId, probe(up, 20))
  setAccept(() => true)
  await notifier.onSiteLivenessChecked(projectId, probe(up, 30))
  await notifier.onSiteLivenessChecked(projectId, probe(up, 40))
  expect(to(URGENT)).toEqual(['health.urgent', 'health.urgent-resolved', 'health.urgent-resolved'])
  // The general recovery was accepted the first time and is not repeated.
  expect(to(GENERAL)).toEqual(['health.degraded', 'health.recovered'])
})

test('a webhook that lists both an urgent and the general event gets an outage once, under the general name', async () => {
  const { notifier, projectId, to } = harness({ urgentEvents: ['health.urgent', 'health.urgent-resolved', 'health.degraded', 'health.recovered'] })
  await notifier.onSiteLivenessChecked(projectId, probe(down, 0))
  await notifier.onSiteLivenessChecked(projectId, probe(down, 10))
  await notifier.onSiteLivenessChecked(projectId, probe(up, 20))
  expect(to(URGENT)).toEqual(['health.degraded', 'health.recovered'])
})

test('an urgent webhook added during an outage is told about it', async () => {
  const { notifier, projectId, to, addWebhook } = harness({ urgentEvents: null })
  await notifier.onSiteLivenessChecked(projectId, probe(down, 0))
  await notifier.onSiteLivenessChecked(projectId, probe(down, 10))
  addWebhook(URGENT, ['health.urgent', 'health.urgent-resolved'])
  await notifier.onSiteLivenessChecked(projectId, probe(down, 20))
  expect(to(URGENT)).toEqual(['health.urgent'])
})

// --- cases an independent review found in the first version ---

test('a webhook that lists only health.urgent hears about a problem that comes back', async () => {
  // With nobody subscribed to the resolved message it is owed to no one, so
  // the cleared problem must leave the record or its return is never sent.
  const { notifier, projectId, to, stored } = harness({ urgentEvents: ['health.urgent'] })
  await notifier.onHealthChecked(projectId, pass(gaStale))
  await notifier.onHealthChecked(projectId, pass(gaFresh))
  expect(stored()!.urgentNotified).toBeNull()
  await notifier.onHealthChecked(projectId, pass(gaFresh))
  await notifier.onHealthChecked(projectId, pass(gaStale))
  expect(to(URGENT)).toEqual(['health.urgent', 'health.urgent'])
  expect(stored()!.urgentNotified).toBe('warn:ga.data.stale:ga.data.recent-data')
})

test('the record does not outlive the webhook it was kept for', async () => {
  const { notifier, projectId, to, stored, addWebhook, removeWebhook } = harness()
  await notifier.onHealthChecked(projectId, pass(gaStale))
  removeWebhook(URGENT)
  await notifier.onHealthChecked(projectId, pass(gaStale))
  expect(stored()!.urgentNotified).toBeNull()

  // A replacement is told about the problem that is still open...
  addWebhook(URGENT, ['health.urgent', 'health.urgent-resolved'])
  await notifier.onHealthChecked(projectId, pass(gaStale))
  expect(to(URGENT)).toEqual(['health.urgent', 'health.urgent'])
})

test('a replacement webhook is not sent a resolution for a problem it never heard about', async () => {
  const { notifier, projectId, sent, addWebhook, removeWebhook } = harness()
  await notifier.onHealthChecked(projectId, pass(gaStale))
  removeWebhook(URGENT)
  await notifier.onHealthChecked(projectId, pass(gaFresh))
  const before = sent.length
  addWebhook(URGENT, ['health.urgent', 'health.urgent-resolved'])
  await notifier.onHealthChecked(projectId, pass(gaFresh))
  expect(sent.slice(before).filter(s => s.url === URGENT)).toEqual([])
})

test('a refused urgent alert does not erase a problem that cleared on the same pass', async () => {
  const { notifier, projectId, to, setAccept } = harness()
  await notifier.onHealthChecked(projectId, pass(gaStale, gscOk))
  // GA clears and Search Console starts failing, and the webhook refuses.
  setAccept(url => url !== URGENT)
  await notifier.onHealthChecked(projectId, pass(gaFresh, gscFailing))
  setAccept(() => true)
  await notifier.onHealthChecked(projectId, pass(gaFresh, gscFailing))
  expect(to(URGENT)).toEqual(['health.urgent', 'health.urgent', 'health.urgent'])
  // Both are over. The subscriber was told about both, so it hears both end.
  await notifier.onHealthChecked(projectId, pass(gaFresh, gscOk))
  expect(to(URGENT).at(-1)).toBe('health.urgent-resolved')
})

test('a check that threw is not a fix', async () => {
  const gaThrew = { id: 'ga.data.recent-data', status: 'fail', code: 'ga.data.recent-data.runtime-error', summary: 'Check threw an unexpected error: SQLITE_BUSY: database is locked' }
  const { notifier, projectId, to, stored } = harness()
  await notifier.onHealthChecked(projectId, pass(gaStale, gscOk))
  await notifier.onHealthChecked(projectId, pass(gaThrew, gscOk))
  expect(to(URGENT)).toEqual(['health.urgent'])
  expect(stored()!.urgentNotified).toBe('warn:ga.data.stale:ga.data.recent-data')
})

test('a disconnected integration does not hold "resolved" back for every later problem', async () => {
  const { notifier, projectId, to, stored } = harness()
  await notifier.onHealthChecked(projectId, pass(gaStale, gscOk))
  // GA is disconnected: its check is skipped from here on and never clears.
  await notifier.onHealthChecked(projectId, pass(gaSkipped, gscFailing))
  expect(to(URGENT)).toEqual(['health.urgent', 'health.urgent'])
  await notifier.onHealthChecked(projectId, pass(gaSkipped, gscOk))
  expect(to(URGENT)).toEqual(['health.urgent', 'health.urgent', 'health.urgent-resolved'])
  expect(stored()!.urgentNotified).toBeNull()
})

test('a sync that fails because its authorization failed is urgent, and explained by the cause', async () => {
  // The runner sets the sync aside under the auth check that names its cause.
  // That is the usual way a sync stops (a revoked grant), so it cannot be the
  // one case the urgent channel misses.
  const authFailed = { id: 'google.auth.connection', status: 'fail', code: 'google.auth.token-refresh-failed', summary: 'Google authorization was revoked.', remediation: 'Reconnect Google.', category: 'auth' }
  const syncSuperseded = {
    id: 'gsc.sync.recent-failures', status: 'skipped', code: 'gsc.sync.recent-failures.superseded', urgent: true,
    summary: 'Superseded by failing google.auth.connection, which names the cause. The last 3 Search Console syncs failed.',
    details: { supersededBy: ['google.auth.connection'], supersededStatus: 'fail', supersededCode: 'gsc.sync.repeated-failures' },
  }
  const { notifier, projectId, sent, to } = harness()
  await notifier.onHealthChecked(projectId, pass(authFailed, syncSuperseded))
  expect(to(URGENT)).toEqual(['health.urgent'])
  expect(sent.find(s => s.url === URGENT)!.health).toMatchObject({
    status: 'fail', code: 'gsc.sync.repeated-failures', summary: 'Google authorization was revoked.',
  })
  // Still set aside on the next pass: still open, and not said twice.
  await notifier.onHealthChecked(projectId, pass(authFailed, syncSuperseded))
  expect(to(URGENT)).toEqual(['health.urgent'])
  await notifier.onHealthChecked(projectId, pass({ ...authFailed, status: 'ok', code: 'google.auth.ok' }, gscOk))
  expect(to(URGENT)).toEqual(['health.urgent', 'health.urgent-resolved'])
})

test('a new urgent problem says what was already open, not "was ok"', async () => {
  const { notifier, projectId, sent } = harness()
  await notifier.onHealthChecked(projectId, pass(gaStale, gscOk))
  await notifier.onHealthChecked(projectId, pass(gaFresh, gscFailing))
  const second = sent.filter(s => s.url === URGENT)[1]!
  expect(second.health.previousStatus).toBe('warn')
  expect(second.health.cleared).toEqual(['ga.data.stale'])
})

test('a problem that changes its diagnosis is not repeated, and is cleared under its current code', async () => {
  const gaNotSyncing = { id: 'ga.data.recent-data', status: 'warn', code: 'ga.data.not-syncing', summary: 'No GA4 sync has completed in 9 days.', urgent: true }
  const { notifier, projectId, sent, to, stored } = harness()
  await notifier.onHealthChecked(projectId, pass(gaStale))
  await notifier.onHealthChecked(projectId, pass(gaNotSyncing))
  expect(to(URGENT)).toEqual(['health.urgent'])
  expect(stored()!.urgentNotified).toBe('warn:ga.data.not-syncing:ga.data.recent-data')
  await notifier.onHealthChecked(projectId, pass(gaFresh))
  expect(sent.filter(s => s.url === URGENT).at(-1)!.health.cleared).toEqual(['ga.data.not-syncing'])
})

test('easing back to a warning is announced as no longer urgent, not as fixed', async () => {
  const { notifier, projectId, sent } = harness()
  await notifier.onHealthChecked(projectId, pass(gaStale))
  await notifier.onHealthChecked(projectId, pass(gaAging))
  expect(sent.filter(s => s.url === URGENT).at(-1)!.health.summary).toBe(`No longer urgent. ${gaAging.summary}`)
})
