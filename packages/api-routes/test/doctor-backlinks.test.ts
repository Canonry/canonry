import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backlinkSummaries, ccReleaseSyncs, createClient, migrate, projects } from '@ainyc/canonry-db'
import type { DatabaseClient } from '@ainyc/canonry-db'
import { BACKLINKS_CHECKS } from '../src/doctor/checks/backlinks.js'
import type { BingConnectionStore } from '../src/bing.js'
import type { DoctorContext, ProjectInfo } from '../src/doctor/types.js'

const check = BACKLINKS_CHECKS.find((c) => c.id === 'backlinks.source.connected')!

function seedProject(db: DatabaseClient, autoExtract: boolean): ProjectInfo {
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  db.insert(projects).values({
    id, name: 'roots', displayName: 'Roots', canonicalDomain: 'roots.io',
    country: 'US', language: 'en', autoExtractBacklinks: autoExtract,
    createdAt: now, updatedAt: now,
  }).run()
  return { id, name: 'roots', canonicalDomain: 'roots.io', displayName: 'Roots' }
}

function seedReadySync(db: DatabaseClient): void {
  const now = new Date().toISOString()
  db.insert(ccReleaseSyncs).values({
    id: crypto.randomUUID(), release: 'cc-main-2026-jan-feb-mar', status: 'ready',
    createdAt: now, updatedAt: now,
  }).run()
}

function seedCcSummary(db: DatabaseClient, projectId: string): void {
  const now = new Date().toISOString()
  db.insert(backlinkSummaries).values({
    id: crypto.randomUUID(), projectId, releaseSyncId: null, source: 'commoncrawl',
    release: 'cc-main-2026-jan-feb-mar', targetDomain: 'roots.io',
    totalLinkingDomains: 5, totalHosts: 9, top10HostsShare: '1.000000',
    queriedAt: now, createdAt: now,
  }).run()
}

function bingStore(connectedDomains: string[]): BingConnectionStore {
  return {
    getConnection: (domain) =>
      connectedDomains.includes(domain)
        ? { domain, apiKey: 'k', siteUrl: `https://${domain}/`, createdAt: 'x', updatedAt: 'x' }
        : undefined,
    upsertConnection: (c) => c,
    updateConnection: () => undefined,
    deleteConnection: () => false,
  }
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

  function ctx(project: ProjectInfo | null, store?: BingConnectionStore): DoctorContext {
    return { db, project, bingConnectionStore: store }
  }

  it('skips without project context', async () => {
    const result = await check.run({ db, project: null })
    expect(result.status).toBe('skipped')
    expect(result.code).toBe('backlinks.source.no-project')
  })

  it('warns when neither source is set up', async () => {
    const project = seedProject(db, false)
    const result = await check.run(ctx(project))
    expect(result.status).toBe('warn')
    expect(result.code).toBe('backlinks.source.none')
    expect(result.details).toMatchObject({ commoncrawl: false, bingWebmaster: false })
    expect(result.remediation).toMatch(/canonry bing connect/)
  })

  it('reports OK when Common Crawl is fully set up (autoExtract + ready sync)', async () => {
    const project = seedProject(db, true)
    seedReadySync(db)
    const result = await check.run(ctx(project))
    expect(result.status).toBe('ok')
    expect(result.code).toBe('backlinks.source.connected')
    expect(result.details).toMatchObject({ commoncrawl: true, bingWebmaster: false })
    expect(result.details!.connected).toEqual(['commoncrawl'])
  })

  it('nudges to extract when Common Crawl is ready but the project has no data', async () => {
    const project = seedProject(db, true)
    seedReadySync(db)
    // Workspace sync is ready, but no per-project extract has run.
    const result = await check.run(ctx(project))
    expect(result.status).toBe('ok')
    expect(result.remediation).toMatch(/canonry backlinks extract roots/)
    expect(result.details).toMatchObject({ commoncrawlHasData: false })
  })

  it('drops the extract nudge once the project has Common Crawl data', async () => {
    const project = seedProject(db, true)
    seedReadySync(db)
    seedCcSummary(db, project.id)
    const result = await check.run(ctx(project))
    expect(result.status).toBe('ok')
    expect(result.remediation).toBeNull()
    expect(result.details).toMatchObject({ commoncrawlHasData: true })
  })

  it('stays a warning when autoExtract is on but no ready sync exists', async () => {
    const project = seedProject(db, true)
    // No ready cc_release_sync seeded.
    const result = await check.run(ctx(project))
    expect(result.status).toBe('warn')
    expect(result.code).toBe('backlinks.source.none')
  })

  it('reports OK when Bing Webmaster is connected for the domain', async () => {
    const project = seedProject(db, false)
    const result = await check.run(ctx(project, bingStore(['roots.io'])))
    expect(result.status).toBe('ok')
    expect(result.details).toMatchObject({ commoncrawl: false, bingWebmaster: true })
    expect(result.details!.connected).toEqual(['bing-webmaster'])
  })

  it('lists both sources when both are set up', async () => {
    const project = seedProject(db, true)
    seedReadySync(db)
    const result = await check.run(ctx(project, bingStore(['roots.io'])))
    expect(result.status).toBe('ok')
    expect(result.details!.connected).toEqual(['commoncrawl', 'bing-webmaster'])
  })
})
