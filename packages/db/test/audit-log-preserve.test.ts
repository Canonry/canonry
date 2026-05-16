import { test, expect, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import {
  auditLog,
  createClient,
  migrate,
  projects,
} from '../src/index.js'

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-audit-preserve-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return db
}

function seedProject(db: ReturnType<typeof createClient>) {
  const now = new Date().toISOString()
  const projectId = crypto.randomUUID()
  db.insert(projects).values({
    id: projectId,
    name: 'test-project',
    displayName: 'Test',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  return { projectId, now }
}

test('deleting a project keeps its audit log rows (project_id=NULL)', () => {
  const db = freshDb()
  const { projectId, now } = seedProject(db)

  const auditId = crypto.randomUUID()
  db.insert(auditLog).values({
    id: auditId,
    projectId,
    actor: 'api',
    action: 'project.created',
    entityType: 'project',
    entityId: projectId,
    createdAt: now,
  }).run()

  db.delete(projects).where(eq(projects.id, projectId)).run()

  const after = db.select().from(auditLog).where(eq(auditLog.id, auditId)).all()
  expect(after).toHaveLength(1)
  expect(after[0]!.projectId).toBeNull()
  expect(after[0]!.action).toBe('project.created')
  expect(after[0]!.entityId).toBe(projectId)
})

test('project.deleted audit row survives the project DELETE that triggered it', () => {
  // The bug fixed by this change: the DELETE /projects/:name handler writes
  // an audit row with action="project.deleted" and entityId=<projectId>,
  // then deletes the project. Pre-fix, the FK cascade wipes that audit row
  // before any reader can observe it — the deletion erases the only record
  // that the deletion happened.
  const db = freshDb()
  const { projectId, now } = seedProject(db)

  const auditId = crypto.randomUUID()
  db.transaction((tx) => {
    tx.insert(auditLog).values({
      id: auditId,
      projectId,
      actor: 'api',
      action: 'project.deleted',
      entityType: 'project',
      entityId: projectId,
      createdAt: now,
    }).run()
    tx.delete(projects).where(eq(projects.id, projectId)).run()
  })

  const after = db.select().from(auditLog).where(eq(auditLog.id, auditId)).all()
  expect(after).toHaveLength(1)
  expect(after[0]!.action).toBe('project.deleted')
  expect(after[0]!.entityId).toBe(projectId)
  expect(after[0]!.projectId).toBeNull()
})

test('schema declares audit_log.project_id with ON DELETE SET NULL', () => {
  // Guard: a future migration that re-creates the table can't silently
  // re-introduce the cascade without failing the suite.
  const db = freshDb()
  const fks = db.all<{ table: string; from: string; to: string; on_delete: string }>(
    sql`PRAGMA foreign_key_list(audit_log)`,
  )
  const projectFk = fks.find(fk => fk.from === 'project_id')
  expect(projectFk).toBeDefined()
  expect(projectFk!.table).toBe('projects')
  expect(projectFk!.on_delete).toBe('SET NULL')

  const cols = db.all<{ name: string; notnull: number }>(
    sql`PRAGMA table_info(audit_log)`,
  )
  const projectIdCol = cols.find(c => c.name === 'project_id')
  expect(projectIdCol).toBeDefined()
  expect(projectIdCol!.notnull).toBe(0) // nullable
})

test('migration is idempotent — re-running v60 leaves data untouched', () => {
  // Same belt-and-suspenders pattern as the v58 dangling-ref test: force a
  // re-run by clearing the tracker row, and confirm an existing detached
  // (project_id=NULL) audit row survives the rebuild intact.
  const db = freshDb()
  const { projectId, now } = seedProject(db)

  const auditId = crypto.randomUUID()
  db.insert(auditLog).values({
    id: auditId,
    projectId,
    actor: 'api',
    action: 'project.created',
    entityType: 'project',
    entityId: projectId,
    createdAt: now,
  }).run()
  db.delete(projects).where(eq(projects.id, projectId)).run()

  db.run(sql`DELETE FROM _migrations WHERE version >= 60`)
  expect(() => migrate(db)).not.toThrow()

  const rows = db.select().from(auditLog).all()
  expect(rows).toHaveLength(1)
  expect(rows[0]!.id).toBe(auditId)
  expect(rows[0]!.projectId).toBeNull()
})
