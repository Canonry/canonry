import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { expect, onTestFinished, test } from 'vitest'
import { createClient, migrate, MIGRATION_VERSIONS } from '../src/index.js'
import { insertLegacyProject, insertLegacyRow } from './legacy-rows.js'

const BACKFILL_INDEX_VERSION = 167

test.each([false, true])('GA backfill pages and upper bounds use indexes without sorting (upgrade=%s)', upgrade => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-ga-backfill-index-'))
  const db = createClient(path.join(dir, 'test.db'))
  onTestFinished(() => {
    db.$client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  migrate(db, upgrade ? MIGRATION_VERSIONS.filter(migration => migration.version < BACKFILL_INDEX_VERSION) : MIGRATION_VERSIONS)
  const now = '2026-10-03T00:00:00.000Z'
  insertLegacyProject(db, { id: 'project-a', createdAt: now })
  insertLegacyProject(db, { id: 'project-b', createdAt: now })
  db.transaction(() => {
    for (let index = 0; index < 300; index++) {
      insertLegacyRow(db, 'ga_traffic_snapshots', {
        id: `snapshot-${String(index).padStart(4, '0')}`,
        project_id: index % 2 === 0 ? 'project-a' : 'project-b', date: '2026-10-03',
        landing_page: '/unchanged/', landing_page_normalized: '/unchanged', synced_at: now,
      })
    }
  })
  const before = db.all(sql`SELECT * FROM ga_traffic_snapshots ORDER BY id`)
  if (upgrade) {
    expect(db.all<{ name: string }>(sql.raw("PRAGMA index_list('ga_traffic_snapshots')")).map(row => row.name))
      .not.toContain('idx_ga_traffic_project_id')
  }
  migrate(db)
  // Replaying the additive migration must preserve existing records and indexes.
  db.run(sql`DELETE FROM _migrations WHERE version = ${BACKFILL_INDEX_VERSION}`)
  migrate(db)
  expect(db.all(sql`SELECT * FROM ga_traffic_snapshots ORDER BY id`)).toEqual(before)
  expect(db.all<{ name: string }>(sql.raw("PRAGMA index_info('idx_ga_traffic_project_id')")).map(row => row.name))
    .toEqual(['project_id', 'id'])
  expect(db.all(sql`SELECT version FROM _migrations WHERE version = ${BACKFILL_INDEX_VERSION}`))
    .toEqual([{ version: BACKFILL_INDEX_VERSION }])

  for (const project of [undefined, 'project-a']) {
    const scope = project === undefined ? sql`1 = 1` : sql`project_id = ${project}`
    const page = sql`SELECT id, project_id, landing_page, landing_page_normalized FROM ga_traffic_snapshots
      WHERE ${scope} AND id > ${'snapshot-0010'} AND id <= ${'snapshot-0299'} ORDER BY id ASC LIMIT 128`
    const upperBound = sql`SELECT id FROM ga_traffic_snapshots WHERE ${scope} ORDER BY id DESC LIMIT 1`
    for (const query of [page, upperBound]) {
      const detail = db.all<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${query}`).map(row => row.detail).join(' | ')
      expect(detail).not.toContain('TEMP B-TREE')
      expect(detail).toContain(project ? 'idx_ga_traffic_project_id' : 'sqlite_autoindex_ga_traffic_snapshots_1')
    }
    const rows = db.all<{ id: string; project_id: string }>(page)
    expect(rows).toHaveLength(128)
    expect(rows[0]?.id).toBe(project ? 'snapshot-0012' : 'snapshot-0011')
    expect(rows.at(-1)?.id).toBe(project ? 'snapshot-0266' : 'snapshot-0138')
    if (project) expect(new Set(rows.map(row => row.project_id))).toEqual(new Set([project]))
    expect(db.all(upperBound)).toEqual([{ id: project ? 'snapshot-0298' : 'snapshot-0299' }])
  }
})
