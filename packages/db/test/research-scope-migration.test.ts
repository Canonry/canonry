import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'

import { createClient, MIGRATION_VERSIONS, migrate, projects, researchRuns } from '../src/index.js'

const V153 = 153
const cleanups: string[] = []

afterEach(() => cleanups.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })))

test('v153 preserves a pre-scope research batch and round-trips frozen scope context', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-research-scope-migration-'))
  cleanups.push(dir)
  const db = createClient(path.join(dir, 'test.db'))
  const now = '2026-09-09T12:00:00.000Z'

  migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version < V153))
  db.insert(projects).values({
    id: 'project', name: 'project', displayName: 'Project', canonicalDomain: 'project.example',
    country: 'US', language: 'en', createdAt: now, updatedAt: now,
  }).run()
  db.$client.prepare(`INSERT INTO research_runs (
    id, project_id, status, provider, resolved_model, total_queries, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('historical', 'project', 'completed', 'openai', 'gpt-5-mini', 1, now)

  migrate(db)
  migrate(db)

  expect(db.select().from(researchRuns).where(eq(researchRuns.id, 'historical')).get()?.scope).toBeNull()
  const scope = { kind: 'group' as const, key: 'downtown', label: 'Downtown', planRevision: 7 }
  db.insert(researchRuns).values({
    id: 'scoped', projectId: 'project', status: 'queued', provider: 'openai', resolvedModel: 'gpt-5-mini',
    totalQueries: 1, scope, createdAt: now,
  }).run()
  expect(db.select().from(researchRuns).where(eq(researchRuns.id, 'scoped')).get()?.scope).toEqual(scope)
})
