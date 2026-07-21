import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, describe } from 'vitest'
import { createClient, migrate } from '../src/index.js'

function tempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-ga-daily-totals-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  db.$client
    .prepare(`INSERT INTO projects (id, name, display_name, canonical_domain, country, language, created_at, updated_at)
              VALUES ('p1','proj','Proj','example.com','US','en','2026-07-20T00:00:00Z','2026-07-20T00:00:00Z')`)
    .run()
  return { db, tmpDir }
}

function insert(db: ReturnType<typeof createClient>, id: string, date: string, users: number) {
  db.$client
    .prepare(`INSERT INTO ga_daily_totals (id, project_id, date, sessions, users, synced_at, created_at)
              VALUES (?, 'p1', ?, 100, ?, '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z')`)
    .run(id, date, users)
}

describe('ga_daily_totals migration', () => {
  test('creates the table with a working unique (project_id, date) index', () => {
    const { db, tmpDir } = tempDb()
    try {
      insert(db, 'r1', '2026-07-20', 158)
      // A second row for the same project+date must be rejected, so a re-sync
      // can never leave two competing totals for one day.
      expect(() => insert(db, 'r2', '2026-07-20', 999)).toThrow(/UNIQUE/i)

      // A different day is fine.
      insert(db, 'r3', '2026-07-19', 140)
      const rows = db.$client
        .prepare(`SELECT date, users FROM ga_daily_totals WHERE project_id='p1' ORDER BY date`)
        .all()
      expect(rows).toEqual([
        { date: '2026-07-19', users: 140 },
        { date: '2026-07-20', users: 158 },
      ])
    } finally {
      db.$client.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('declares both foreign keys the schema requires', () => {
    // A CREATE TABLE that omits a REFERENCES clause still accepts every INSERT
    // and only shows up as orphaned rows much later. SQLite cannot add a FK to
    // an existing column, so this drift is expensive once shipped — assert the
    // constraint list directly rather than inferring it from behavior alone.
    const { db, tmpDir } = tempDb()
    try {
      const fks = db.$client
        .prepare(`PRAGMA foreign_key_list(ga_daily_totals)`)
        .all() as Array<{ table: string; from: string; to: string; on_delete: string }>
      const byColumn = Object.fromEntries(fks.map((fk) => [fk.from, fk]))

      expect(byColumn.project_id).toMatchObject({ table: 'projects', to: 'id', on_delete: 'CASCADE' })
      expect(byColumn.sync_run_id).toMatchObject({ table: 'runs', to: 'id', on_delete: 'CASCADE' })
    } finally {
      db.$client.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('cascades away with the run that produced it', () => {
    const { db, tmpDir } = tempDb()
    try {
      db.$client
        .prepare(`INSERT INTO runs (id, project_id, kind, status, trigger, created_at)
                  VALUES ('run1','p1','ga-sync','completed','manual','2026-07-21T00:00:00Z')`)
        .run()
      db.$client
        .prepare(`INSERT INTO ga_daily_totals (id, project_id, date, sessions, users, synced_at, sync_run_id, created_at)
                  VALUES ('r1','p1','2026-07-20',100,158,'2026-07-21T00:00:00Z','run1','2026-07-21T00:00:00Z')`)
        .run()

      // Deleting the sync run must take its totals with it. Without the FK the
      // row survives, leaving a total whose provenance points at nothing.
      db.$client.prepare(`DELETE FROM runs WHERE id='run1'`).run()
      const remaining = db.$client
        .prepare(`SELECT COUNT(*) AS n FROM ga_daily_totals`)
        .get() as { n: number }
      expect(remaining.n).toBe(0)
    } finally {
      db.$client.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('cascades away with its project', () => {
    const { db, tmpDir } = tempDb()
    try {
      insert(db, 'r1', '2026-07-20', 158)
      db.$client.prepare(`DELETE FROM projects WHERE id='p1'`).run()
      const remaining = db.$client
        .prepare(`SELECT COUNT(*) AS n FROM ga_daily_totals`)
        .get() as { n: number }
      expect(remaining.n).toBe(0)
    } finally {
      db.$client.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
