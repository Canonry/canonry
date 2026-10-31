import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { expect, onTestFinished, test } from 'vitest'
import { createClient, migrate, MIGRATION_VERSIONS, siteCrawlSnapshots } from '../src/index.js'
import { insertLegacyProject, insertLegacyRow } from './legacy-rows.js'

test('v180 preserves unknown historical issue evidence and round-trips a measured empty result', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-site-crawl-issue-evidence-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  onTestFinished(() => {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  const beforeIssueEvidence = MIGRATION_VERSIONS.filter((migration) => migration.version < 180)
  migrate(db, beforeIssueEvidence)
  const now = '2026-10-12T00:00:00.000Z'
  insertLegacyProject(db, { id: 'project-a', createdAt: now })
  for (const runId of ['legacy', 'empty']) {
    insertLegacyRow(db, 'runs', { id: runId, project_id: 'project-a', kind: 'site-audit', status: 'completed', trigger: 'manual', created_at: now })
    insertLegacyRow(db, 'site_crawl_snapshots', {
      id: `snapshot-${runId}`, project_id: 'project-a', run_id: runId, root_url: 'https://example.test/',
      complete: true, termination: 'complete', created_at: now, updated_at: now,
    })
  }

  migrate(db)
  expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, 'legacy')).get()?.issueEvidence).toBeNull()
  const emptyEvidence = { schemaVersion: '1.0' as const, groupIdentityVersion: 'duplicate-metadata-v1' as const, siteIssues: [] }
  db.update(siteCrawlSnapshots).set({ issueEvidence: emptyEvidence }).where(eq(siteCrawlSnapshots.runId, 'empty')).run()
  migrate(db)
  migrate(db, beforeIssueEvidence)

  expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, 'empty')).get()?.issueEvidence).toEqual(emptyEvidence)
  expect(db.select().from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, 'legacy')).get()?.issueEvidence).toBeNull()
  expect(db.all(sql`SELECT version FROM _migrations WHERE version = 180`)).toEqual([{ version: 180 }])
})
