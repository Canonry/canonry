import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { createClient, migrate, MIGRATION_VERSIONS, projects, researchRunQueries } from '../src/index.js'

const cleanups: string[] = []
afterEach(() => cleanups.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })))

test('v110 adds empty named/cited competitor signals without changing existing research answers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-research-competitor-migration-'))
  cleanups.push(dir)
  const db = createClient(path.join(dir, 'test.db'))
  const now = new Date().toISOString()

  migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version <= 109))
  db.insert(projects).values({ id: 'project', name: 'project', displayName: 'Project', canonicalDomain: 'project.example', country: 'US', language: 'en', createdAt: now, updatedAt: now }).run()
  // Use the historical physical shape because current Drizzle also knows
  // about fields added after v109 (including v151 principal attribution).
  db.$client.prepare(`INSERT INTO research_runs (
    id, project_id, status, provider, resolved_model,
    total_queries, completed_queries, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('run', 'project', 'completed', 'openai', 'gpt-5-mini', 1, 1, now)
  // Use the pre-v110 physical shape rather than Drizzle's current schema,
  // which correctly includes the columns that this migration will add.
  db.$client.prepare(`INSERT INTO research_run_queries (
    id, research_run_id, position, query_text, status, resolved_model,
    answer_text, grounding_sources, cited_domains, search_queries,
    answer_mentioned, citation_state, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('query', 'run', 0, 'best example', 'completed', 'gpt-5-mini', 'Existing answer', '[]', '["source.example"]', '[]', 0, 'not-cited', now)

  migrate(db)

  expect(db.select().from(researchRunQueries).get()).toMatchObject({
    answerText: 'Existing answer', citedDomains: ['source.example'], namedCompetitors: [], citedCompetitorDomains: [],
  })
})
