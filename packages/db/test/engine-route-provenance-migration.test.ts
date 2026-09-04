import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { expect, onTestFinished, test } from 'vitest'
import { createClient, migrate, MIGRATION_VERSIONS } from '../src/index.js'

const V150 = 150

function columnNames(db: ReturnType<typeof createClient>, table: string): string[] {
  return (db.all(sql.raw(`PRAGMA table_info(${table})`)) as Array<{ name: string }>)
    .map(column => column.name)
}

test('v150 adds nullable route/provider provenance without inventing it for historic rows', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-engine-route-provenance-'))
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }))
  const db = createClient(path.join(directory, 'test.db'))

  // Simulate the exact production upgrade boundary: an install at v149 has
  // durable projects and snapshots, but neither new provenance column.
  migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version < V150))
  expect(columnNames(db, 'projects')).not.toContain('research_provider')
  expect(columnNames(db, 'query_snapshots')).not.toContain('served_provider')

  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const snapshotId = crypto.randomUUID()
  const now = '2026-09-01T00:00:00.000Z'
  db.run(sql`
    INSERT INTO projects (id, name, display_name, canonical_domain, country, language, created_at, updated_at)
    VALUES (${projectId}, 'historic', 'Historic', 'historic.example', 'US', 'en', ${now}, ${now})
  `)
  db.run(sql`
    INSERT INTO runs (id, project_id, kind, status, trigger, created_at)
    VALUES (${runId}, ${projectId}, 'answer-visibility', 'completed', 'manual', ${now})
  `)
  db.run(sql`
    INSERT INTO query_snapshots (id, run_id, query_text, provider, citation_state, created_at)
    VALUES (${snapshotId}, ${runId}, 'best historic widget', 'openai', 'not-cited', ${now})
  `)

  migrate(db)

  expect(MIGRATION_VERSIONS.find(migration => migration.version === V150)).toMatchObject({
    name: 'engine-route-research-and-served-provider-provenance',
  })
  expect(columnNames(db, 'projects')).toContain('research_provider')
  expect(columnNames(db, 'query_snapshots')).toContain('served_provider')
  expect(db.all(sql`
    SELECT research_provider AS researchProvider FROM projects WHERE id = ${projectId}
  `)).toEqual([{ researchProvider: null }])
  expect(db.all(sql`
    SELECT served_provider AS servedProvider FROM query_snapshots WHERE id = ${snapshotId}
  `)).toEqual([{ servedProvider: null }])
  expect(db.all(sql`SELECT version FROM _migrations WHERE version = ${V150}`)).toHaveLength(1)
})
