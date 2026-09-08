import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'

import { createClient, migrate, MIGRATION_VERSIONS, projects, researchRuns } from '../src/index.js'

const V151 = 151
const cleanups: string[] = []

afterEach(() => cleanups.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })))

test('v151 preserves historical research runs and round-trips new principal attribution', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-research-principal-migration-'))
  cleanups.push(dir)
  const db = createClient(path.join(dir, 'test.db'))
  const now = '2026-09-08T12:00:00.000Z'

  migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version < V151))
  db.insert(projects).values({ id: 'project', name: 'project', displayName: 'Project', canonicalDomain: 'project.example', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  db.$client.prepare(`INSERT INTO research_runs (
    id, project_id, status, provider, resolved_model, total_queries, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('historical', 'project', 'completed', 'openai', 'gpt-5-mini', 1, now)

  migrate(db)
  migrate(db)

  expect(db.select().from(researchRuns).where(eq(researchRuns.id, 'historical')).get()?.initiatedBy).toBeNull()
  db.insert(researchRuns).values({
    id: 'attributed', projectId: 'project', status: 'queued', provider: 'openai', resolvedModel: 'gpt-5-mini',
    totalQueries: 1, initiatedBy: { kind: 'user', id: 'viewer-1', name: 'viewer', role: 'viewer' }, createdAt: now,
  }).run()
  expect(db.select().from(researchRuns).where(eq(researchRuns.id, 'attributed')).get()?.initiatedBy)
    .toEqual({ kind: 'user', id: 'viewer-1', name: 'viewer', role: 'viewer' })
})
