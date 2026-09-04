import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { createClient, migrate, MIGRATION_VERSIONS, researchRunQueries, researchRuns } from '../src/index.js'

const cleanups: string[] = []
afterEach(() => cleanups.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })))

test('v110 adds empty named/cited competitor signals without changing existing research answers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-research-competitor-migration-'))
  cleanups.push(dir)
  const db = createClient(path.join(dir, 'test.db'))
  const now = new Date().toISOString()

  migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version <= 109))
  // Drizzle's current `projects` table declares post-v109 columns (including
  // v150's `research_provider`); this migration fixture must retain the
  // physical shape an older binary wrote.
  db.$client.prepare(`INSERT INTO projects (
    id, name, display_name, canonical_domain, country, language, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'project', 'project', 'Project', 'project.example', 'US', 'en', now, now,
  )
  db.insert(researchRuns).values({ id: 'run', projectId: 'project', status: 'completed', provider: 'openai', resolvedModel: 'gpt-5-mini', totalQueries: 1, completedQueries: 1, createdAt: now }).run()
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
