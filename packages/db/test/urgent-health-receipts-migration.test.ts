import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, onTestFinished, test } from 'vitest'
import { createClient, doctorHealthState, migrate, MIGRATION_VERSIONS, siteLivenessState } from '../src/index.js'
import { insertLegacyProject, insertLegacyRow } from './legacy-rows.js'

// Fresh notifier fixtures cannot catch an upgrade that reassigns an anonymous
// legacy receipt or overwrites acknowledged recipient history on repeated boot.
test('health receipt upgrade preserves legacy state without assigning it to a recipient, and persists new histories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnry-urgent-upgrade-'))
  const db = createClient(path.join(dir, 'test.db'))
  onTestFinished(() => { db.$client.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version <= 182))
  const checkedAt = '2026-10-01T00:00:00.000Z'
  const projectId = 'urgent-upgrade'
  const signature = 'warn:ga.data.stale:ga.data.recent-data'
  insertLegacyProject(db, { id: projectId, createdAt: checkedAt })
  insertLegacyRow(db, 'doctor_health_state', {
    project_id: projectId, status: 'warn', code: 'ga.data.stale', summary: 'stale',
    checked_at: checkedAt, notified_at: checkedAt, urgent_notified: signature,
  })
  insertLegacyRow(db, 'site_liveness_state', {
    project_id: projectId, status: 'fail', code: 'site.reachability.down', summary: 'down',
    consecutive_failures: 2, checked_at: checkedAt, notified_at: checkedAt,
    urgent_notified_at: checkedAt,
  })

  migrate(db)
  expect(db.select().from(doctorHealthState).get()).toMatchObject({
    urgentNotified: signature, urgentReceipts: null, notifiedAt: checkedAt, code: 'ga.data.stale',
  })
  expect(db.select().from(siteLivenessState).get()).toMatchObject({
    urgentNotifiedAt: checkedAt, urgentReceipts: null, notifiedAt: checkedAt, consecutiveFailures: 2,
  })
  const doctorReceipts = { 'webhook-a': { url: 'https://hooks.example/a', notified: signature } }
  const siteReceipts = { 'webhook-a': { url: 'https://hooks.example/a', notified: checkedAt } }
  db.update(doctorHealthState).set({ urgentReceipts: doctorReceipts }).run()
  db.update(siteLivenessState).set({ urgentReceipts: siteReceipts }).run()
  migrate(db)
  expect(db.select().from(doctorHealthState).get()?.urgentReceipts).toEqual(doctorReceipts)
  expect(db.select().from(siteLivenessState).get()?.urgentReceipts).toEqual(siteReceipts)
})
