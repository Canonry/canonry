import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backlinkSummaries, ccReleaseSyncs, createClient, migrate, projects } from '@canonry/canonry-db'
import type { DatabaseClient } from '@canonry/canonry-db'
import type { CcReleaseSyncStatus } from '@canonry/canonry-contracts'
import { BACKLINKS_CHECKS } from '../src/doctor/checks/backlinks.js'
import type { DoctorContext, ProjectInfo } from '../src/doctor/types.js'

const check = BACKLINKS_CHECKS.find((c) => c.id === 'backlinks.source.connected')!

function seedProject(db: DatabaseClient, autoExtract: boolean, name = 'demo'): ProjectInfo {
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  db.insert(projects).values({
    id, name, displayName: 'Demo', canonicalDomain: 'example.com',
    country: 'US', language: 'en', autoExtractBacklinks: autoExtract,
    createdAt: now, updatedAt: now,
  }).run()
  return { id, name, canonicalDomain: 'example.com', displayName: 'Demo' }
}

/**
 * A release sync row. `completedBefore` is a row that reached `ready` once:
 * the executor stamps `queryFinishedAt` then, and neither a re-queue nor a
 * later failure clears it.
 */
function seedSync(db: DatabaseClient, status: CcReleaseSyncStatus, opts: { completedBefore?: boolean } = {}): void {
  const now = new Date().toISOString()
  db.insert(ccReleaseSyncs).values({
    id: crypto.randomUUID(), release: 'cc-main-2026-jan-feb-mar', status,
    queryFinishedAt: status === 'ready' || opts.completedBefore ? now : null,
    createdAt: now, updatedAt: now,
  }).run()
}

function seedReadySync(db: DatabaseClient): void {
  seedSync(db, 'ready')
}

function seedCcSummary(db: DatabaseClient, projectId: string, source: 'commoncrawl' | 'bing-webmaster' = 'commoncrawl'): void {
  const now = new Date().toISOString()
  db.insert(backlinkSummaries).values({
    id: crypto.randomUUID(), projectId, releaseSyncId: null, source,
    release: 'cc-main-2026-jan-feb-mar', targetDomain: 'example.com',
    totalLinkingDomains: 5, totalHosts: 9, top10HostsShare: '1.000000',
    queriedAt: now, createdAt: now,
  }).run()
}

describe('backlinks.source.connected', () => {
  let tmpDir: string
  let db: DatabaseClient

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-doctor-backlinks-'))
    db = createClient(path.join(tmpDir, 'test.db'))
    migrate(db)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function ctx(project: ProjectInfo | null): DoctorContext {
    return { db, project }
  }

  it('skips without project context', async () => {
    const result = await check.run({ db, project: null })
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('backlinks.source.no-project')
  })

  // The release sync is workspace-global and writes every project's rows, so
  // `autoExtractBacklinks` (which only queues a re-extract) says nothing about
  // whether data exists. Gating on it warned on projects with current data.
  it.each([false, true])('reports OK from a ready release plus stored project data, with autoExtractBacklinks=%s', async (autoExtract) => {
    const project = seedProject(db, autoExtract)
    seedReadySync(db)
    seedCcSummary(db, project.id)
    const result = await check.run(ctx(project))
    expect(result.status).toBe('ok')
    expect(result.code).toBe('backlinks.source.connected')
    expect(result.remediation).toBeNull()
    expect(result.details).toEqual({
      commoncrawl: true,
      commoncrawlReadyRelease: true,
      commoncrawlHasData: true,
      connected: ['commoncrawl'],
    })
  })

  it.each([false, true])('warns to sync when no release is ready, with autoExtractBacklinks=%s', async (autoExtract) => {
    const project = seedProject(db, autoExtract)
    const result = await check.run(ctx(project))
    expect(result.status).toBe('warn')
    expect(result.code).toBe('backlinks.source.none')
    expect(result.details).toEqual({ commoncrawl: false, commoncrawlReadyRelease: false, commoncrawlHasData: false })
    expect(result.remediation).toMatch(/canonry backlinks sync/)
    // The old text named a project setting that no command sets.
    expect(result.remediation).not.toMatch(/autoExtractBacklinks/)
  })

  // Re-running `canonry backlinks sync` on the newest release re-queues its
  // row, and the stored rows stay untouched until the sync's final write.
  // Reading only `ready` warned on every project for as long as the download
  // ran, or for good when it failed.
  it.each(['queued', 'downloading', 'querying', 'failed'] as const)('stays OK when a release that completed before is synced again and its row is %s', async (status) => {
    const project = seedProject(db, false)
    seedSync(db, status, { completedBefore: true })
    seedCcSummary(db, project.id)
    const result = await check.run(ctx(project))
    expect(result.status).toBe('ok')
    expect(result.code).toBe('backlinks.source.connected')
    expect(result.details).toMatchObject({ commoncrawl: true, commoncrawlReadyRelease: true, commoncrawlHasData: true })
  })

  it('warns to sync when the only release sync has never completed, even with older project data', async () => {
    const project = seedProject(db, true)
    seedSync(db, 'downloading')
    seedCcSummary(db, project.id)
    const result = await check.run(ctx(project))
    expect(result.status).toBe('warn')
    expect(result.code).toBe('backlinks.source.none')
    expect(result.details).toEqual({ commoncrawl: false, commoncrawlReadyRelease: false, commoncrawlHasData: true })
    expect(result.remediation).toMatch(/canonry backlinks sync/)
  })

  it('warns to extract when a release is ready but this project has no summary yet', async () => {
    // A project created after the last sync. Another project's summary and
    // this project's retired-source rows are not its Common Crawl data.
    const project = seedProject(db, true)
    const other = seedProject(db, true, 'other')
    seedReadySync(db)
    seedCcSummary(db, other.id)
    seedCcSummary(db, project.id, 'bing-webmaster')
    const result = await check.run(ctx(project))
    expect(result.status).toBe('warn')
    expect(result.code).toBe('backlinks.source.none')
    expect(result.details).toEqual({ commoncrawl: false, commoncrawlReadyRelease: true, commoncrawlHasData: false })
    expect(result.remediation).toMatch(/canonry backlinks extract demo/)
    expect(result.remediation).not.toMatch(/canonry backlinks sync/)
  })

  it('warns to sync when a completed release failed re-sync and the project has no summary', async () => {
    const project = seedProject(db, false)
    seedSync(db, 'failed', { completedBefore: true })

    const result = await check.run(ctx(project))

    expect(result.status).toBe('warn')
    expect(result.code).toBe('backlinks.source.none')
    expect(result.remediation).toMatch(/canonry backlinks sync/)
    expect(result.remediation).not.toMatch(/canonry backlinks extract/)
  })
})
