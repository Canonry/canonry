import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, onTestFinished, test } from 'vitest'
import { createClient, doctorHealthState, migrate, MIGRATION_VERSIONS } from '../src/index.js'
import { insertLegacyProject, insertLegacyRow } from './legacy-rows.js'

test('upgrading preserves delivered and observed health state without inventing a pending alert', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cnry-health-upgrade-'))
  onTestFinished(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const db = createClient(path.join(tmp, 'test.db'))
  migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version <= 178))
  const projectId = crypto.randomUUID()
  const checkedAt = '2026-09-01T00:00:00.000Z'
  const signature = 'warn:ga.data.aging'
  const checks = `${signature}:ga.data.recent-data`
  insertLegacyProject(db, { id: projectId, createdAt: checkedAt })
  insertLegacyRow(db, 'doctor_health_state', {
    project_id: projectId, status: 'warn', code: 'ga.data.aging', summary: 'aging',
    checked_at: checkedAt, notified_at: checkedAt, failing_signature: signature,
    failing_checks: checks, notified_signature: checks,
  })

  migrate(db)
  expect(db.select().from(doctorHealthState).get()).toMatchObject({
    projectId, status: 'warn', code: 'ga.data.aging', checkedAt, notifiedAt: checkedAt,
    failingSignature: signature, failingChecks: checks, notifiedSignature: checks, pendingSignature: null,
  })
})
