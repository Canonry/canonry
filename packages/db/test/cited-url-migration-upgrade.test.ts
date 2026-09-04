import { expect, onTestFinished, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createClient, migrate, MIGRATION_VERSIONS } from '../src/index.js'

const V111 = 111

test('v111 adds nullable cited-URL capture columns without backfilling historical snapshots', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-cited-url-upgrade-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db, MIGRATION_VERSIONS.filter((mv) => mv.version < V111))

  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const snapshotId = crypto.randomUUID()
  const now = new Date().toISOString()
  // Current Drizzle models name post-v111 columns (including v150's
  // `research_provider`), so each historical fixture names only columns an
  // older binary could have written.
  db.run(sql`INSERT INTO projects (id, name, display_name, canonical_domain, country, language, created_at, updated_at)
    VALUES (${projectId}, 'legacy-capture', 'Legacy capture', 'example.com', 'US', 'en', ${now}, ${now})`)
  db.run(sql`INSERT INTO runs (id, project_id, status, created_at)
    VALUES (${runId}, ${projectId}, 'completed', ${now})`)
  db.run(sql`INSERT INTO query_snapshots (id, run_id, provider, citation_state, created_at)
    VALUES (${snapshotId}, ${runId}, 'gemini', 'not-cited', ${now})`)

  migrate(db)

  const columns = (db.all(sql`PRAGMA table_info(query_snapshots)`) as Array<{ name: string }>).map((row) => row.name)
  expect(columns).toEqual(expect.arrayContaining(['cited_urls', 'capture_status', 'source_count', 'resolved_count', 'capture_version']))
  expect(db.get(sql`SELECT cited_urls, capture_status, source_count, resolved_count, capture_version
    FROM query_snapshots WHERE id = ${snapshotId}`)).toEqual({ cited_urls: null, capture_status: null, source_count: null, resolved_count: null, capture_version: null })
})
