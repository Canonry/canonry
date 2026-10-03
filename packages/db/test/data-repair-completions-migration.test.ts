import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { expect, onTestFinished, test } from 'vitest'
import { createClient, dataRepairCompletions, migrate, MIGRATION_VERSIONS } from '../src/index.js'
import { insertLegacyProject, insertLegacyRow } from './legacy-rows.js'

const REPAIR_COMPLETIONS_VERSION = 168
const NOW = '2026-10-03T00:00:00.000Z'

function createTestClient() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-data-repair-completions-'))
  const db = createClient(path.join(dir, 'test.db'))
  onTestFinished(() => {
    db.$client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return db
}

test.each([false, true])('repair completion storage preserves source rows and receipts across replay (upgrade=%s)', upgrade => {
  const db = createTestClient()
  const throughRepairCompletions = MIGRATION_VERSIONS.filter(migration => migration.version <= REPAIR_COMPLETIONS_VERSION)
  migrate(db, upgrade
    ? throughRepairCompletions.filter(migration => migration.version < REPAIR_COMPLETIONS_VERSION)
    : throughRepairCompletions)
  if (upgrade) {
    expect(db.all(sql`SELECT name FROM sqlite_master WHERE name = 'data_repair_completions'`)).toEqual([])
  }
  insertLegacyProject(db, { id: 'project-a', createdAt: NOW })
  insertLegacyRow(db, 'ga_traffic_snapshots', {
    id: 'snapshot-a', project_id: 'project-a', date: '2026-10-03',
    landing_page: '/old/?utm_source=test', landing_page_normalized: null, synced_at: NOW,
  })
  const sourceRows = db.all(sql`SELECT * FROM ga_traffic_snapshots`)

  migrate(db, throughRepairCompletions)
  expect(db.select().from(dataRepairCompletions).all()).toEqual([])
  expect(db.all<{ name: string; type: string; notnull: number; pk: number }>(sql.raw("PRAGMA table_info('data_repair_completions')"))
    .map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual([
    { name: 'name', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'version', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'completed_at', type: 'TEXT', notnull: 1, pk: 0 },
  ])
  const receipts = [
    { name: 'ga-ai-referral-paths', version: 1, completedAt: NOW },
    { name: 'ga-traffic-paths', version: 2, completedAt: NOW },
  ]
  db.insert(dataRepairCompletions).values(receipts).run()
  db.run(sql`DELETE FROM _migrations WHERE version = ${REPAIR_COMPLETIONS_VERSION}`)
  migrate(db, throughRepairCompletions)
  migrate(db)

  expect(db.select().from(dataRepairCompletions).orderBy(dataRepairCompletions.name).all()).toEqual(receipts)
  expect(db.all(sql`SELECT * FROM ga_traffic_snapshots`)).toEqual(sourceRows)
  expect(db.all(sql`SELECT version, name FROM _migrations WHERE version = ${REPAIR_COMPLETIONS_VERSION}`))
    .toEqual([{ version: REPAIR_COMPLETIONS_VERSION, name: 'data-repair-completions' }])
})

test('repair completion records require a unique name, version, and completion timestamp', () => {
  const db = createTestClient()
  migrate(db)
  const receipt = { name: 'ga-traffic-paths', version: 2, completedAt: NOW }
  db.insert(dataRepairCompletions).values(receipt).run()

  expect(() => db.insert(dataRepairCompletions).values(receipt).run()).toThrow(/UNIQUE constraint failed/)
  expect(() => db.$client.prepare('INSERT INTO data_repair_completions (version, completed_at) VALUES (1, ?)').run(NOW))
    .toThrow(/NOT NULL constraint failed: data_repair_completions.name/)
  expect(() => db.$client.prepare("INSERT INTO data_repair_completions (name, completed_at) VALUES ('missing-version', ?)").run(NOW))
    .toThrow(/NOT NULL constraint failed: data_repair_completions.version/)
  expect(() => db.$client.prepare("INSERT INTO data_repair_completions (name, version) VALUES ('missing-timestamp', 1)").run())
    .toThrow(/NOT NULL constraint failed: data_repair_completions.completed_at/)
  expect(db.select().from(dataRepairCompletions).all()).toEqual([receipt])
})
