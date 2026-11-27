import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createClient, migrate, MIGRATION_VERSIONS, projects, siteCrawlPages, siteCrawlSnapshots, type DatabaseClient } from '../src/index.js'
import { insertLegacyProject, insertLegacyRow } from './legacy-rows.js'

// v219 lets an Agent Readiness scan cover more than one owned site: a saved
// list on the project, a site on each page row and the sites on each scan.
// Every value written before reads as a scan of the main domain only.

const VERSION = 219
const NOW = '2026-11-11T00:00:00.000Z'

function tempDb(versions = MIGRATION_VERSIONS): DatabaseClient {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-site-audit-owned-sites-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  onTestFinished(() => {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
  migrate(db, versions)
  return db
}

function columns(db: DatabaseClient, table: string) {
  return db.all(sql.raw(`PRAGMA table_info('${table}')`)) as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>
}

function seedScan(db: DatabaseClient, runId: string): void {
  insertLegacyRow(db, 'runs', { id: runId, project_id: 'project-1', kind: 'site-audit', status: 'completed', trigger: 'manual', created_at: NOW })
  insertLegacyRow(db, 'site_crawl_attempts', { id: `attempt-${runId}`, project_id: 'project-1', run_id: runId, attempt_number: 1, created_at: NOW, updated_at: NOW })
  insertLegacyRow(db, 'site_crawl_snapshots', {
    id: `snapshot-${runId}`, project_id: 'project-1', run_id: runId, attempt_id: `attempt-${runId}`, root_url: 'https://example.com/', created_at: NOW, updated_at: NOW,
  })
  insertLegacyRow(db, 'site_crawl_pages', {
    id: `page-${runId}`, project_id: 'project-1', run_id: runId, attempt_id: `attempt-${runId}`, node_key: 'home',
    url: 'https://example.com/', path: '/', parent_path: '/', created_at: NOW, updated_at: NOW,
  })
}

describe('site audit owned sites (v219)', () => {
  it('is registered under its name', () => {
    expect(MIGRATION_VERSIONS.find(mv => mv.version === VERSION)?.name).toBe('site-audit-owned-sites')
  })

  it('upgrades a v218 database so every project, page and scan reads as the main domain only', () => {
    const db = tempDb(MIGRATION_VERSIONS.filter(mv => mv.version < VERSION))
    expect(columns(db, 'projects').some(column => column.name === 'site_audit_domains')).toBe(false)
    insertLegacyProject(db, { id: 'project-1', createdAt: NOW })
    seedScan(db, 'run-before')

    migrate(db)

    expect(columns(db, 'projects').find(column => column.name === 'site_audit_domains')).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "'[]'" })
    expect(columns(db, 'site_crawl_pages').find(column => column.name === 'site')).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
    expect(columns(db, 'site_crawl_snapshots').find(column => column.name === 'sites')).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
    expect(db.select({ siteAuditDomains: projects.siteAuditDomains }).from(projects).where(eq(projects.id, 'project-1')).get()).toEqual({ siteAuditDomains: [] })
    expect(db.select({ site: siteCrawlPages.site }).from(siteCrawlPages).where(eq(siteCrawlPages.runId, 'run-before')).get()).toEqual({ site: null })
    expect(db.select({ sites: siteCrawlSnapshots.sites }).from(siteCrawlSnapshots).where(eq(siteCrawlSnapshots.runId, 'run-before')).get()).toEqual({ sites: null })
    const indexes = db.all(sql.raw(`PRAGMA index_list('site_crawl_pages')`)) as Array<{ name: string }>
    expect(indexes.map(index => index.name)).toContain('idx_site_crawl_pages_site')

    // An older writer that never names the columns still inserts, as the main domain only.
    insertLegacyProject(db, { id: 'older-writer', createdAt: NOW })
    expect(db.select({ siteAuditDomains: projects.siteAuditDomains }).from(projects).where(eq(projects.id, 'older-writer')).get()?.siteAuditDomains).toEqual([])
    seedScan(db, 'run-older-writer')
    expect(db.select({ site: siteCrawlPages.site }).from(siteCrawlPages).where(eq(siteCrawlPages.runId, 'run-older-writer')).get()?.site).toBeNull()
  })

  it('is idempotent when the statements run again', () => {
    const db = tempDb(MIGRATION_VERSIONS.filter(mv => mv.version <= VERSION))
    insertLegacyProject(db, { id: 'project-1', createdAt: NOW })
    db.update(projects).set({ siteAuditDomains: ['apartments.example.com'] }).where(eq(projects.id, 'project-1')).run()
    db.$client.prepare('DELETE FROM _migrations WHERE version = ?').run(VERSION)
    expect(() => migrate(db, MIGRATION_VERSIONS.filter(mv => mv.version === VERSION))).not.toThrow()
    expect(() => migrate(db)).not.toThrow()
    expect(db.select({ siteAuditDomains: projects.siteAuditDomains }).from(projects).where(eq(projects.id, 'project-1')).get()?.siteAuditDomains)
      .toEqual(['apartments.example.com'])
    expect(db.$client.prepare('SELECT COUNT(*) AS count FROM _migrations WHERE version = ?').get(VERSION)).toEqual({ count: 1 })
  })
})
