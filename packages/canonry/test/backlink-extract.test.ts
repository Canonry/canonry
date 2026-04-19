import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  backlinkDomains,
  backlinkSummaries,
  ccReleaseSyncs,
  createClient,
  migrate,
  projects,
  runs,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { executeBacklinkExtract, type BacklinkExtractDeps } from '../src/backlink-extract.js'

let tmpDir: string
let db: DatabaseClient

function makeDeps(overrides: Partial<BacklinkExtractDeps> = {}): BacklinkExtractDeps {
  let t = 1_700_000_000_000
  const now = overrides.now ?? (() => new Date(t++ * 1))
  return {
    queryBacklinks: overrides.queryBacklinks ?? (async () => []),
    loadDuckdb: overrides.loadDuckdb ?? (() => ({ DuckDBInstance: {} })),
    now,
  }
}

function insertProject(id: string, name: string, domain: string): void {
  const now = new Date().toISOString()
  db.insert(projects).values({
    id, name, displayName: name, canonicalDomain: domain,
    country: 'US', language: 'en', providers: '[]',
    createdAt: now, updatedAt: now,
  }).run()
}

function insertRun(id: string, projectId: string, kind = 'backlink-extract'): void {
  const now = new Date().toISOString()
  db.insert(runs).values({
    id, projectId, kind, status: 'queued', trigger: 'manual', createdAt: now,
  }).run()
}

async function insertReadyReleaseSync(id: string, release: string, { createFiles = true } = {}): Promise<void> {
  const now = new Date().toISOString()
  const vertexPath = path.join(tmpDir, `${id}-v.txt.gz`)
  const edgesPath = path.join(tmpDir, `${id}-e.txt.gz`)
  if (createFiles) {
    await fs.writeFile(vertexPath, 'stub')
    await fs.writeFile(edgesPath, 'stub')
  }
  db.insert(ccReleaseSyncs).values({
    id, release, status: 'ready',
    vertexPath, edgesPath,
    vertexBytes: 100, edgesBytes: 200,
    createdAt: now, updatedAt: now,
  }).run()
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-extract-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('executeBacklinkExtract', () => {
  it('fails the run when no ready release sync exists', async () => {
    insertProject('p1', 'roots', 'roots.io')
    const runId = crypto.randomUUID()
    insertRun(runId, 'p1')

    await expect(
      executeBacklinkExtract(db, runId, 'p1', { deps: makeDeps() }),
    ).rejects.toThrow(/no ready release/i)

    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe('failed')
    expect(run?.error).toMatch(/no ready release/i)
  })

  it('fails when the requested release is not yet ready', async () => {
    insertProject('p1', 'roots', 'roots.io')
    const runId = crypto.randomUUID()
    insertRun(runId, 'p1')
    // Insert a failed sync — should not be picked up.
    const now = new Date().toISOString()
    db.insert(ccReleaseSyncs).values({
      id: crypto.randomUUID(), release: 'cc-main-2026-jan-feb-mar',
      status: 'failed', error: 'boom',
      createdAt: now, updatedAt: now,
    }).run()

    await expect(
      executeBacklinkExtract(db, runId, 'p1', {
        release: 'cc-main-2026-jan-feb-mar',
        deps: makeDeps(),
      }),
    ).rejects.toThrow(/not ready/i)

    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe('failed')
  })

  it('runs single-target query against the latest ready release and persists rows', async () => {
    insertProject('p1', 'roots', 'roots.io')
    insertProject('p2', 'other', 'other.com')
    const runId = crypto.randomUUID()
    insertRun(runId, 'p1')
    await insertReadyReleaseSync('sync-1', 'cc-main-2026-jan-feb-mar')

    let capturedTargets: string[] = []
    await executeBacklinkExtract(db, runId, 'p1', {
      deps: makeDeps({
        queryBacklinks: async ({ targets }) => {
          capturedTargets = targets
          return [
            { targetDomain: 'roots.io', linkingDomain: 'github.com', numHosts: 50 },
            { targetDomain: 'roots.io', linkingDomain: 'reddit.com', numHosts: 20 },
          ]
        },
      }),
    })

    expect(capturedTargets).toEqual(['roots.io'])

    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe('completed')
    expect(run?.startedAt).toBeTruthy()
    expect(run?.finishedAt).toBeTruthy()

    const rows = db.select().from(backlinkDomains).where(eq(backlinkDomains.projectId, 'p1')).all()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.release === 'cc-main-2026-jan-feb-mar')).toBe(true)
    expect(rows.every((r) => r.releaseSyncId === 'sync-1')).toBe(true)

    // Other project untouched.
    const otherRows = db.select().from(backlinkDomains).where(eq(backlinkDomains.projectId, 'p2')).all()
    expect(otherRows).toHaveLength(0)

    const summary = db.select().from(backlinkSummaries).where(eq(backlinkSummaries.projectId, 'p1')).get()
    expect(summary?.totalLinkingDomains).toBe(2)
    expect(summary?.totalHosts).toBe(70)
    expect(summary?.release).toBe('cc-main-2026-jan-feb-mar')
  })

  it('is idempotent under re-run: deletes prior (project_id, release) rows before inserting', async () => {
    insertProject('p1', 'roots', 'roots.io')
    await insertReadyReleaseSync('sync-1', 'cc-main-2026-jan-feb-mar')

    const run1 = crypto.randomUUID()
    insertRun(run1, 'p1')
    await executeBacklinkExtract(db, run1, 'p1', {
      deps: makeDeps({
        queryBacklinks: async () => [
          { targetDomain: 'roots.io', linkingDomain: 'first.com', numHosts: 1 },
        ],
      }),
    })
    expect(db.select().from(backlinkDomains).where(eq(backlinkDomains.projectId, 'p1')).all()).toHaveLength(1)

    const run2 = crypto.randomUUID()
    insertRun(run2, 'p1')
    await executeBacklinkExtract(db, run2, 'p1', {
      deps: makeDeps({
        queryBacklinks: async () => [
          { targetDomain: 'roots.io', linkingDomain: 'second.com', numHosts: 2 },
          { targetDomain: 'roots.io', linkingDomain: 'third.com', numHosts: 3 },
        ],
      }),
    })
    const rows = db.select().from(backlinkDomains).where(eq(backlinkDomains.projectId, 'p1')).all()
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.linkingDomain).sort()).toEqual(['second.com', 'third.com'])

    const summary = db.select().from(backlinkSummaries).where(eq(backlinkSummaries.projectId, 'p1')).all()
    expect(summary).toHaveLength(1)
    expect(summary[0]!.totalLinkingDomains).toBe(2)
  })

  it('picks the latest ready release when --release is not specified', async () => {
    insertProject('p1', 'roots', 'roots.io')
    // Two ready releases with different createdAt.
    const oldV = path.join(tmpDir, 'old-v.gz')
    const oldE = path.join(tmpDir, 'old-e.gz')
    const newV = path.join(tmpDir, 'new-v.gz')
    const newE = path.join(tmpDir, 'new-e.gz')
    await Promise.all([oldV, oldE, newV, newE].map((p) => fs.writeFile(p, 'stub')))
    db.insert(ccReleaseSyncs).values({
      id: 'old', release: 'cc-main-2025-oct-nov-dec', status: 'ready',
      vertexPath: oldV, edgesPath: oldE,
      createdAt: '2025-12-01T00:00:00.000Z', updatedAt: '2025-12-01T00:00:00.000Z',
    }).run()
    db.insert(ccReleaseSyncs).values({
      id: 'new', release: 'cc-main-2026-jan-feb-mar', status: 'ready',
      vertexPath: newV, edgesPath: newE,
      createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z',
    }).run()

    const runId = crypto.randomUUID()
    insertRun(runId, 'p1')
    await executeBacklinkExtract(db, runId, 'p1', {
      deps: makeDeps({
        queryBacklinks: async () => [
          { targetDomain: 'roots.io', linkingDomain: 'g.com', numHosts: 9 },
        ],
      }),
    })

    const rows = db.select().from(backlinkDomains).where(eq(backlinkDomains.projectId, 'p1')).all()
    expect(rows[0]?.release).toBe('cc-main-2026-jan-feb-mar')
    expect(rows[0]?.releaseSyncId).toBe('new')
  })

  it('marks the run failed and rethrows when the query throws', async () => {
    insertProject('p1', 'roots', 'roots.io')
    await insertReadyReleaseSync('sync-1', 'cc-main-2026-jan-feb-mar')
    const runId = crypto.randomUUID()
    insertRun(runId, 'p1')

    await expect(
      executeBacklinkExtract(db, runId, 'p1', {
        deps: makeDeps({
          queryBacklinks: async () => { throw new Error('duckdb exploded') },
        }),
      }),
    ).rejects.toThrow(/duckdb exploded/)

    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe('failed')
    expect(run?.error).toMatch(/duckdb exploded/)
  })

  it('fails with a clear message when the release is "ready" but the cached files are missing', async () => {
    insertProject('p1', 'roots', 'roots.io')
    await insertReadyReleaseSync('sync-1', 'cc-main-2026-jan-feb-mar', { createFiles: false })
    const runId = crypto.randomUUID()
    insertRun(runId, 'p1')

    let duckdbCalled = false
    await expect(
      executeBacklinkExtract(db, runId, 'p1', {
        deps: makeDeps({
          queryBacklinks: async () => { duckdbCalled = true; return [] },
        }),
      }),
    ).rejects.toThrow(/cache for release .+ is missing from disk/i)

    expect(duckdbCalled).toBe(false)
    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe('failed')
    expect(run?.error).toMatch(/re-sync this release/i)
  })

  it('fails when the project does not exist', async () => {
    await insertReadyReleaseSync('sync-1', 'cc-main-2026-jan-feb-mar')
    const runId = crypto.randomUUID()
    // runs.project_id has FK ON DELETE CASCADE, so we need a project first to insert a run.
    insertProject('p1', 'roots', 'roots.io')
    insertRun(runId, 'p1')

    await expect(
      executeBacklinkExtract(db, runId, 'nonexistent', { deps: makeDeps() }),
    ).rejects.toThrow(/project/i)

    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.status).toBe('failed')
  })
})
