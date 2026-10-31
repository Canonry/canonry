import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, onTestFinished, test } from 'vitest'
import { createClient, migrate, MIGRATION_VERSIONS, rawEventSamples } from '../src/index.js'
import { insertLegacyProject, insertLegacyRow } from './legacy-rows.js'

test('upgrading stores backfilled user-fetch samples under the event type sample reads use', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cnry-sample-type-upgrade-'))
  onTestFinished(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const db = createClient(path.join(tmp, 'test.db'))
  migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version <= 199))

  const createdAt = '2026-10-01T00:00:00.000Z'
  const projectId = crypto.randomUUID()
  const sourceId = crypto.randomUUID()
  insertLegacyProject(db, { id: projectId, createdAt })
  insertLegacyRow(db, 'traffic_sources', {
    id: sourceId, project_id: projectId, source_type: 'cloud-run', display_name: 'source',
    status: 'connected', created_at: createdAt, updated_at: createdAt,
  })
  for (const [id, eventType] of [['backfilled', 'ai-user-fetch'], ['ingested', 'ai_user_fetch'], ['crawler', 'crawler'], ['unknown', 'unknown']]) {
    insertLegacyRow(db, 'raw_event_samples', {
      id, project_id: projectId, source_id: sourceId, ts: createdAt, event_type: eventType,
      path_normalized: '/', created_at: createdAt,
    })
  }

  migrate(db)

  const stored = db.select({ id: rawEventSamples.id, eventType: rawEventSamples.eventType }).from(rawEventSamples).all()
  expect(Object.fromEntries(stored.map(row => [row.id, row.eventType]))).toEqual({
    backfilled: 'ai_user_fetch',
    ingested: 'ai_user_fetch',
    crawler: 'crawler',
    unknown: 'unknown',
  })
})
