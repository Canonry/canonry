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
  runWasUserInitiated,
  COVERAGE_REFRESH_MIN_INTERVAL_MS,
  COVERAGE_REFRESH_MANUAL_MIN_INTERVAL_MS,
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

function insertInspectRun(opts: { status: string; createdAt: string; kind?: string; trigger?: string }): string {
  const id = `run-${Math.random().toString(36).slice(2)}`
  db.insert(runs)
    .values({
      id,
      projectId: PROJECT_ID,
      kind: opts.kind ?? RunKinds['inspect-sitemap'],
      status: opts.status,
      trigger: opts.trigger ?? RunTriggers.scheduled,
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

/**
 * The bug a user actually hit on 2026-08-06.
 *
 * They pressed "Refresh search data" at 13:16 UTC, 46 minutes after the daily 12:30
 * scheduled refresh. The chained `inspect-sitemap` was inside the 60-minute
 * spacing window, so it was skipped — and because `gsc-sync` inspects no URLs
 * at all, that skip meant NOTHING could update the index-coverage dashboard.
 * The sync reported success, the numbers did not move, and nothing said why.
 *
 * The window was written when `gsc-sync` still inspected the top 50 pages
 * inline, so skipping the sweep genuinely only meant "slightly less thorough".
 * Once inline inspection was removed the same constant started meaning
 * "measure nothing", and no test noticed because the guard still behaved
 * exactly as designed.
 */
describe('maybeRefreshGscCoverage — user-initiated refresh', () => {
  it('runs a sweep 46 minutes after a scheduled one when a PERSON asked', async () => {
    const deps = spyExecutor()
    const now = Date.now()
    insertInspectRun({
      status: RunStatuses.completed,
      createdAt: new Date(now - 46 * 60_000).toISOString(),
    })

    const runId = await maybeRefreshGscCoverage(db, connectedConfig(), PROJECT_ID, deps, now, {
      userInitiated: true,
    })

    expect(runId).toBeTruthy()
    expect(deps.calls).toHaveLength(1)
  })

  it('still skips the SCHEDULED chain at the same 46-minute mark', async () => {
    // The quota protection is unchanged for automation — only an explicit
    // human request is allowed through early.
    const deps = spyExecutor()
    const now = Date.now()
    insertInspectRun({
      status: RunStatuses.completed,
      createdAt: new Date(now - 46 * 60_000).toISOString(),
    })

    const runId = await maybeRefreshGscCoverage(db, connectedConfig(), PROJECT_ID, deps, now, {
      userInitiated: false,
    })

    expect(runId).toBeNull()
    expect(deps.calls).toHaveLength(0)
  })

  it('still collapses the two arms of "Refresh search data" into one sweep', async () => {
    // Both arms are user-initiated, so neither is stopped by the spacing
    // window — the IN-FLIGHT check is what dedupes them. Losing that would
    // double every manual refresh's quota spend.
    const deps = spyExecutor()
    const now = Date.now()
    insertInspectRun({ status: RunStatuses.running, createdAt: new Date(now - 1_000).toISOString() })

    const runId = await maybeRefreshGscCoverage(db, connectedConfig(), PROJECT_ID, deps, now, {
      userInitiated: true,
    })

    expect(runId).toBeNull()
    expect(deps.calls).toHaveLength(0)
  })

  it('rate-limits a user who hammers the button', async () => {
    const deps = spyExecutor()
    const now = Date.now()
    insertInspectRun({
      status: RunStatuses.completed,
      createdAt: new Date(now - (COVERAGE_REFRESH_MANUAL_MIN_INTERVAL_MS - 5_000)).toISOString(),
    })

    const runId = await maybeRefreshGscCoverage(db, connectedConfig(), PROJECT_ID, deps, now, {
      userInitiated: true,
    })

    expect(runId).toBeNull()
  })

  it('defaults to the scheduled window when no caller opinion is given', async () => {
    const deps = spyExecutor()
    const now = Date.now()
    insertInspectRun({
      status: RunStatuses.completed,
      createdAt: new Date(now - 46 * 60_000).toISOString(),
    })

    const runId = await maybeRefreshGscCoverage(db, connectedConfig(), PROJECT_ID, deps, now)

    expect(runId).toBeNull()
  })

  it('uses the stored scheduled gsc-sync trigger for the one-hour coverage window', async () => {
    const deps = spyExecutor()
    const now = Date.now()
    insertInspectRun({
      status: RunStatuses.completed,
      createdAt: new Date(now - 30 * 60_000).toISOString(),
    })
    const gscRun = insertInspectRun({
      status: RunStatuses.completed,
      kind: RunKinds['gsc-sync'],
      trigger: RunTriggers.scheduled,
      createdAt: new Date(now - 1_000).toISOString(),
    })

    expect(runWasUserInitiated(db, gscRun)).toBe(false)
    const runId = await maybeRefreshGscCoverage(db, connectedConfig(), PROJECT_ID, deps, now, {
      userInitiated: runWasUserInitiated(db, gscRun),
    })

    expect(runId).toBeNull()
    expect(deps.calls).toHaveLength(0)
  })

  it('uses the stored manual gsc-sync trigger for the two-minute coverage window', async () => {
    const deps = spyExecutor()
    const now = Date.now()
    insertInspectRun({
      status: RunStatuses.completed,
      createdAt: new Date(now - 30 * 60_000).toISOString(),
    })
    const gscRun = insertInspectRun({
      status: RunStatuses.completed,
      kind: RunKinds['gsc-sync'],
      trigger: RunTriggers.manual,
      createdAt: new Date(now - 1_000).toISOString(),
    })

    expect(runWasUserInitiated(db, gscRun)).toBe(true)
    const runId = await maybeRefreshGscCoverage(db, connectedConfig(), PROJECT_ID, deps, now, {
      userInitiated: runWasUserInitiated(db, gscRun),
    })

    expect(runId).toBeTruthy()
    expect(deps.calls).toHaveLength(1)
  })
})

describe('runWasUserInitiated', () => {
  it('reads the trigger off the run that started the chain', () => {
    const manual = insertInspectRun({
      status: RunStatuses.completed,
      createdAt: new Date().toISOString(),
      kind: RunKinds['gsc-sync'],
      trigger: RunTriggers.manual,
    })
    const scheduled = insertInspectRun({
      status: RunStatuses.completed,
      createdAt: new Date().toISOString(),
      kind: RunKinds['gsc-sync'],
      trigger: RunTriggers.scheduled,
    })

    expect(runWasUserInitiated(db, manual)).toBe(true)
    expect(runWasUserInitiated(db, scheduled)).toBe(false)
  })

  it('is false for a run id that does not exist', () => {
    expect(runWasUserInitiated(db, 'no-such-run')).toBe(false)
  })
})
