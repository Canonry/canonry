import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'

import { createClient, MIGRATION_VERSIONS, migrate, projects, researchRunQueries, researchRuns } from '../src/index.js'

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
  db.$client.prepare(`INSERT INTO research_run_queries (
    id, research_run_id, position, query_text, status, resolved_model, grounding_sources, cited_domains, search_queries, named_competitors, cited_competitor_domains, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('historical-query', 'historical', 0, 'existing research question', 'completed', 'gpt-5-mini', '[]', '[]', '[]', '[]', '[]', now)

  migrate(db)
  migrate(db)

  const historical = db.select().from(researchRuns).where(eq(researchRuns.id, 'historical')).get()
  expect(historical?.scope).toBeNull()
  expect(historical?.template).toBeNull()
  expect(db.select().from(researchRunQueries).where(eq(researchRunQueries.id, 'historical-query')).get()).toMatchObject({
    queryText: 'existing research question', queryClass: null,
  })
  const scope = { kind: 'property' as const, key: 'downtown', label: 'Downtown', planRevision: 7 }
  const template = {
    templateId: 'research-property-v1', templateVersion: '1', template: 'Is {property} a good place to live?',
    bindings: { property: 'Downtown' }, output: 'Is Downtown a good place to live?',
  }
  db.insert(researchRuns).values({
    id: 'scoped', projectId: 'project', status: 'queued', provider: 'openai', resolvedModel: 'gpt-5-mini',
    totalQueries: 1, scope, template, createdAt: now,
  }).run()
  expect(db.select().from(researchRuns).where(eq(researchRuns.id, 'scoped')).get()).toMatchObject({ scope, template })
  db.insert(researchRunQueries).values({
    id: 'scoped-query', researchRunId: 'scoped', position: 0, queryText: 'Is Downtown a good place to live?',
    queryClass: 'branded', status: 'queued', resolvedModel: 'gpt-5-mini', createdAt: now,
  }).run()
  expect(db.select().from(researchRunQueries).where(eq(researchRunQueries.id, 'scoped-query')).get()?.queryClass).toBe('branded')
})
