import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { eq } from 'drizzle-orm'
import { createClient, migrate, projects, runs, type DatabaseClient } from '@ainyc/canonry-db'
import { RunKinds, RunStatuses, RunTriggers } from '@ainyc/canonry-contracts'
import type { CanonryConfig } from '../src/config.js'
import {
  maybeRefreshGscCoverage,
  COVERAGE_REFRESH_MIN_INTERVAL_MS,
  type CoverageRefreshDeps,
} from '../src/coverage-refresh.js'

const PROJECT_ID = 'proj-1'
const DOMAIN = 'example.com'

let tmpDir: string
let db: DatabaseClient

function seedProject(): void {
  const now = new Date().toISOString()
  db.insert(projects)
    .values({
      id: PROJECT_ID,
      name: 'testproj',
      displayName: 'Test Project',
      canonicalDomain: DOMAIN,
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    })
    .run()
}

function connectedConfig(): CanonryConfig {
  const now = new Date().toISOString()
  return {
    apiUrl: 'http://localhost:4100',
    database: ':memory:',
    apiKey: 'cnry_test',
    google: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      connections: [
        {
          domain: DOMAIN,
          connectionType: 'gsc',
          refreshToken: 'refresh-token',
          accessToken: 'access-token',
          tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          propertyId: 'sc-domain:example.com',
          scopes: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
  } as CanonryConfig
}

/** A `deps.executeInspectSitemap` that records calls without touching the network. */
function spyExecutor(): CoverageRefreshDeps & { calls: Array<{ runId: string; projectId: string }> } {
  const calls: Array<{ runId: string; projectId: string }> = []
  return {
    calls,
    executeInspectSitemap: async (_db, runId, projectId) => {
      calls.push({ runId, projectId })
    },
  }
}

function insertInspectRun(opts: { status: string; createdAt: string; kind?: string }): string {
  const id = `run-${Math.random().toString(36).slice(2)}`
  db.insert(runs)
    .values({
      id,
      projectId: PROJECT_ID,
      kind: opts.kind ?? RunKinds['inspect-sitemap'],
      status: opts.status,
      trigger: RunTriggers.scheduled,
      createdAt: opts.createdAt,
    })
    .run()
  return id
}

function inspectRuns(): Array<typeof runs.$inferSelect> {
  return db
    .select()
    .from(runs)
    .where(eq(runs.kind, RunKinds['inspect-sitemap']))
    .all()
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-refresh-test-'))
  db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  seedProject()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('maybeRefreshGscCoverage', () => {
  it('creates a queued inspect-sitemap run (trigger=scheduled) and invokes the executor when GSC is connected', async () => {
    const deps = spyExecutor()
    const now = Date.now()

    const runId = await maybeRefreshGscCoverage(db, connectedConfig(), PROJECT_ID, deps, now)

    expect(runId).toBeTruthy()
    expect(deps.calls).toEqual([{ runId, projectId: PROJECT_ID }])

    const created = inspectRuns()
    expect(created).toHaveLength(1)
    expect(created[0]!.id).toBe(runId)
    expect(created[0]!.kind).toBe(RunKinds['inspect-sitemap'])
    expect(created[0]!.trigger).toBe(RunTriggers.scheduled)
    expect(created[0]!.projectId).toBe(PROJECT_ID)
    // Stamped from the injected clock so the spacing guard is deterministic.
    expect(created[0]!.createdAt).toBe(new Date(now).toISOString())
  })

  it('returns null and creates no run when the project does not exist', async () => {
    const deps = spyExecutor()
    const runId = await maybeRefreshGscCoverage(db, connectedConfig(), 'missing-project', deps)
    expect(runId).toBeNull()
    expect(deps.calls).toHaveLength(0)
    expect(inspectRuns()).toHaveLength(0)
  })

  it('skips silently (no run, no executor) when GSC has no connection for the domain — the Bing-only case', async () => {
    const deps = spyExecutor()
    const config = connectedConfig()
    config.google!.connections = []

    const runId = await maybeRefreshGscCoverage(db, config, PROJECT_ID, deps)

    expect(runId).toBeNull()
    expect(deps.calls).toHaveLength(0)
    expect(inspectRuns()).toHaveLength(0)
  })

  it('skips when the GSC connection has no propertyId', async () => {
    const deps = spyExecutor()
    const config = connectedConfig()
    config.google!.connections![0]!.propertyId = null

    const runId = await maybeRefreshGscCoverage(db, config, PROJECT_ID, deps)

    expect(runId).toBeNull()
    expect(deps.calls).toHaveLength(0)
    expect(inspectRuns()).toHaveLength(0)
  })

  it('skips when the GSC connection has no refreshToken', async () => {
    const deps = spyExecutor()
    const config = connectedConfig()
    config.google!.connections![0]!.refreshToken = null

    const runId = await maybeRefreshGscCoverage(db, config, PROJECT_ID, deps)

    expect(runId).toBeNull()
    expect(deps.calls).toHaveLength(0)
    expect(inspectRuns()).toHaveLength(0)
  })

  it('skips when OAuth client credentials are missing from config', async () => {
    const deps = spyExecutor()
    const config = connectedConfig()
    delete config.google!.clientId
    delete config.google!.clientSecret

    const runId = await maybeRefreshGscCoverage(db, config, PROJECT_ID, deps)

    expect(runId).toBeNull()
    expect(deps.calls).toHaveLength(0)
    expect(inspectRuns()).toHaveLength(0)
  })

  it('skips when an inspect-sitemap run completed within the spacing window', async () => {
    const deps = spyExecutor()
    const now = Date.now()
    const recentAt = new Date(now - (COVERAGE_REFRESH_MIN_INTERVAL_MS - 60_000)).toISOString()
    insertInspectRun({ status: RunStatuses.completed, createdAt: recentAt })

    const runId = await maybeRefreshGscCoverage(db, connectedConfig(), PROJECT_ID, deps, now)

    expect(runId).toBeNull()
    expect(deps.calls).toHaveLength(0)
    expect(inspectRuns()).toHaveLength(1) // only the pre-existing one
  })

  it('skips when an inspect-sitemap run is still queued within the window (covers the Refresh-all double-fire)', async () => {
    const deps = spyExecutor()
    const now = Date.now()
    insertInspectRun({ status: RunStatuses.queued, createdAt: new Date(now - 1_000).toISOString() })

    const runId = await maybeRefreshGscCoverage(db, connectedConfig(), PROJECT_ID, deps, now)

    expect(runId).toBeNull()
    expect(deps.calls).toHaveLength(0)
  })

  it('proceeds when the most recent inspect-sitemap run within the window FAILED (retry allowed)', async () => {
    const deps = spyExecutor()
    const now = Date.now()
    insertInspectRun({ status: RunStatuses.failed, createdAt: new Date(now - 60_000).toISOString() })

    const runId = await maybeRefreshGscCoverage(db, connectedConfig(), PROJECT_ID, deps, now)

    expect(runId).toBeTruthy()
    expect(deps.calls).toHaveLength(1)
    expect(inspectRuns()).toHaveLength(2) // the failed one + the new retry
  })

  it('proceeds when the last inspect-sitemap run is older than the spacing window', async () => {
    const deps = spyExecutor()
    const now = Date.now()
    const staleAt = new Date(now - (COVERAGE_REFRESH_MIN_INTERVAL_MS + 60_000)).toISOString()
    insertInspectRun({ status: RunStatuses.completed, createdAt: staleAt })

    const runId = await maybeRefreshGscCoverage(db, connectedConfig(), PROJECT_ID, deps, now)

    expect(runId).toBeTruthy()
    expect(deps.calls).toHaveLength(1)
  })

  it('does not let a recent run of a DIFFERENT kind block the refresh', async () => {
    const deps = spyExecutor()
    const now = Date.now()
    // A gsc-sync (not inspect-sitemap) ran a minute ago — must not gate coverage.
    insertInspectRun({ status: RunStatuses.completed, createdAt: new Date(now - 60_000).toISOString(), kind: RunKinds['gsc-sync'] })

    const runId = await maybeRefreshGscCoverage(db, connectedConfig(), PROJECT_ID, deps, now)

    expect(runId).toBeTruthy()
    expect(deps.calls).toHaveLength(1)
  })

  it('dedupes two near-simultaneous callers to a single inspect-sitemap run', async () => {
    const deps = spyExecutor()
    const now = Date.now()
    const config = connectedConfig()

    // Both invoked before either awaits — the second sees the first's synchronously
    // inserted queued row and bails. Exactly one run + one executor call.
    const [a, b] = await Promise.all([
      maybeRefreshGscCoverage(db, config, PROJECT_ID, deps, now),
      maybeRefreshGscCoverage(db, config, PROJECT_ID, deps, now),
    ])

    const created = inspectRuns()
    expect(created).toHaveLength(1)
    expect(deps.calls).toHaveLength(1)
    expect([a, b].filter(Boolean)).toHaveLength(1)
  })

  it('still returns the run id when the executor throws (failure is logged, not propagated)', async () => {
    const now = Date.now()
    const failing: CoverageRefreshDeps = {
      executeInspectSitemap: async () => {
        throw new Error('quota exceeded')
      },
    }

    const runId = await maybeRefreshGscCoverage(db, connectedConfig(), PROJECT_ID, failing, now)

    expect(runId).toBeTruthy()
    // The run row was still created (the executor owns marking it failed).
    expect(inspectRuns()).toHaveLength(1)
  })
})
