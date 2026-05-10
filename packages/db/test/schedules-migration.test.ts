import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, schedules } from '../src/index.js'

/**
 * Regression tests for the schedules table after v53 (kind dimension)
 * and v54 (cleanup of resurrected legacy index).
 *
 * The bug being guarded against: `MIGRATION_SQL` runs on every server boot
 * before versioned migrations. It used to create the standalone
 * `idx_schedules_project` (UNIQUE single-column on project_id), which
 * conflicted with v53's `(project_id, kind)` semantics. On the second boot
 * after v53, the legacy index was re-created and any insert of a second
 * schedule kind for the same project failed with
 * `UNIQUE constraint failed: schedules.project_id`.
 */

function buildDbPath(): { tmpDir: string; dbPath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-schedules-'))
  return { tmpDir, dbPath: path.join(tmpDir, 'data.db') }
}

function listSchedulesIndexes(dbPath: string): string[] {
  const out = execSync(
    `sqlite3 "${dbPath}" "SELECT name FROM sqlite_master WHERE tbl_name='schedules' AND type='index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name"`,
    { encoding: 'utf8' },
  )
  return out.split('\n').map(s => s.trim()).filter(Boolean)
}

function seedProject(db: ReturnType<typeof createClient>): string {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id,
    name: 'demo',
    displayName: 'Demo',
    canonicalDomain: 'example.com',
    ownedDomains: '[]',
    country: 'US',
    language: 'en',
    tags: '[]',
    labels: '{}',
    providers: '[]',
    locations: '[]',
    defaultLocation: null,
    autoExtractBacklinks: 0,
    configSource: 'api',
    configRevision: 1,
    createdAt: now,
    updatedAt: now,
  }).run()
  return id
}

describe('schedules table after v53/v54', () => {
  test('after a single migrate(), only the (project_id, kind) unique index exists', () => {
    const { tmpDir, dbPath } = buildDbPath()
    try {
      migrate(createClient(dbPath))
      const indexes = listSchedulesIndexes(dbPath)
      expect(indexes).toContain('idx_schedules_project_kind')
      expect(indexes).not.toContain('idx_schedules_project')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('after a SECOND migrate() (simulating server reboot), the legacy single-column index does not resurrect', () => {
    const { tmpDir, dbPath } = buildDbPath()
    try {
      migrate(createClient(dbPath))
      // Simulate reboot: reopen and migrate again.
      migrate(createClient(dbPath))
      const indexes = listSchedulesIndexes(dbPath)
      expect(indexes).toContain('idx_schedules_project_kind')
      expect(indexes).not.toContain('idx_schedules_project')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('a project can hold both an answer-visibility AND a traffic-sync schedule after reboot', () => {
    const { tmpDir, dbPath } = buildDbPath()
    try {
      migrate(createClient(dbPath))
      // Reboot.
      const db2 = createClient(dbPath)
      migrate(db2)

      const projectId = seedProject(db2)
      const now = new Date().toISOString()

      db2.insert(schedules).values({
        id: crypto.randomUUID(),
        projectId,
        kind: 'answer-visibility',
        cronExpr: '0 6 * * *',
        preset: 'daily',
        timezone: 'UTC',
        enabled: 1,
        providers: '[]',
        sourceId: null,
        lastRunAt: null,
        nextRunAt: null,
        createdAt: now,
        updatedAt: now,
      }).run()

      // This insert used to fail with `UNIQUE constraint failed: schedules.project_id`
      // on any DB that booted past v53 a second time.
      db2.insert(schedules).values({
        id: crypto.randomUUID(),
        projectId,
        kind: 'traffic-sync',
        cronExpr: '*/15 * * * *',
        preset: null,
        timezone: 'UTC',
        enabled: 1,
        providers: '[]',
        sourceId: 'src-test',
        lastRunAt: null,
        nextRunAt: null,
        createdAt: now,
        updatedAt: now,
      }).run()

      const rows = db2
        .select()
        .from(schedules)
        .where(eq(schedules.projectId, projectId))
        .all()
      expect(rows).toHaveLength(2)
      const kinds = rows.map(r => r.kind).sort()
      expect(kinds).toEqual(['answer-visibility', 'traffic-sync'])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
