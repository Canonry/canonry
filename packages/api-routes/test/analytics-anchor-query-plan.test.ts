import { describe, it, beforeAll, afterAll, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import Fastify from 'fastify'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'

/**
 * The model-evidence anchor lookup used to select snapshots by `provider`,
 * which made SQLite scan the whole `idx_snapshots_provider_model` partition —
 * every project, all history — once per in-window provider. On the synchronous
 * better-sqlite3 driver that blocks the event loop for hundreds of ms.
 *
 * These tests pin the SHAPE rather than a wall-clock number: a timing assertion
 * would be flaky on shared CI, but the plan is deterministic. Every statement
 * the route actually prepares is captured (no hand-copied SQL that can drift
 * from `analytics.ts`) and re-run under EXPLAIN QUERY PLAN.
 */

const DECOY_PROJECTS = 4
// Sweeps every 10 days back to day 400, the newest landing today so a 7d
// window has in-window data and the sweep 10 days back is the anchor.
const RUNS_PER_PROJECT = 41
const SNAPSHOTS_PER_RUN = 60
const PROVIDERS = ['openai', 'gemini']

interface CapturedStatement {
  sql: string
  params: unknown[]
}

function buildApp() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-plan-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true })

  return { app, db, tmpDir }
}

/**
 * Wraps `prepare` so every statement the route executes is recorded with the
 * parameters it was bound to. Statement-returning helpers (`raw`, `pluck`, …)
 * hand back the proxy so a chained call is still observed.
 */
function captureStatements(sqlite: import('better-sqlite3').Database): {
  captured: CapturedStatement[]
  stop: () => void
} {
  const captured: CapturedStatement[] = []
  const originalPrepare = sqlite.prepare.bind(sqlite)

  sqlite.prepare = ((source: string) => {
    const statement = originalPrepare(source)
    const proxy: unknown = new Proxy(statement, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          if (property === 'all' || property === 'get' || property === 'iterate') {
            captured.push({ sql: source, params: args })
          }
          const result = (value as (...a: unknown[]) => unknown).apply(target, args)
          return result === target ? proxy : result
        }
      },
    })
    return proxy
  }) as typeof sqlite.prepare

  // Only the route's own statements may be captured — the assertions below
  // prepare statements of their own.
  return { captured, stop: () => { sqlite.prepare = originalPrepare as typeof sqlite.prepare } }
}

function seed(sqlite: import('better-sqlite3').Database, projectName: string, projectId: string, dayOffsets: number[]) {
  const now = Date.now()
  const insertProject = sqlite.prepare(`
    INSERT INTO projects (id, name, display_name, canonical_domain, owned_domains, country, language,
      tags, labels, providers, locations, default_location, config_source, config_revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, '[]', 'US', 'en', '[]', '{}', '["openai","gemini"]', '[]', NULL, 'api', 1, ?, ?)
  `)
  const insertQuery = sqlite.prepare(`INSERT INTO queries (id, project_id, query, created_at) VALUES (?, ?, ?, ?)`)
  const insertRun = sqlite.prepare(`
    INSERT INTO runs (id, project_id, kind, status, trigger, location, started_at, finished_at, error, created_at)
    VALUES (?, ?, 'answer-visibility', 'completed', 'manual', NULL, ?, ?, NULL, ?)
  `)
  const insertSnapshot = sqlite.prepare(`
    INSERT INTO query_snapshots (id, run_id, query_id, provider, model, citation_state, answer_text,
      cited_domains, competitor_overlap, recommended_competitors, location, raw_response, created_at)
    VALUES (?, ?, ?, ?, ?, 'not-cited', '', '[]', '[]', '[]', NULL, '{}', ?)
  `)

  const iso = (offsetDays: number) => new Date(now - offsetDays * 86_400_000).toISOString()
  insertProject.run(projectId, projectName, projectName, `${projectName}.example`, iso(400), iso(0))
  const queryId = crypto.randomUUID()
  insertQuery.run(queryId, projectId, `${projectName} query`, iso(400))

  for (const offset of dayOffsets) {
    const createdAt = iso(offset)
    const runId = crypto.randomUUID()
    insertRun.run(runId, projectId, createdAt, createdAt, createdAt)
    for (let i = 0; i < SNAPSHOTS_PER_RUN; i++) {
      const provider = PROVIDERS[i % PROVIDERS.length]!
      // Model flips at the 90-day mark so an anchor genuinely exists to find.
      const model = offset > 90 ? `${provider}-v1` : `${provider}-v2`
      insertSnapshot.run(crypto.randomUUID(), runId, queryId, provider, model, createdAt)
    }
  }
}

describe('model-evidence anchor query plan', () => {
  let app: ReturnType<typeof Fastify>
  let db: ReturnType<typeof createClient>
  let sqlite: import('better-sqlite3').Database
  let tmpDir: string
  let captured: CapturedStatement[]
  const targetProjectId = crypto.randomUUID()

  beforeAll(async () => {
    const ctx = buildApp()
    app = ctx.app
    db = ctx.db
    tmpDir = ctx.tmpDir
    sqlite = db.$client
    await app.ready()

    // Meaningful scale: the target project's history is a small slice of a
    // table dominated by other projects, which is exactly the case where a
    // provider-partition scan is catastrophic and a run-id lookup is not.
    const seedAll = sqlite.transaction(() => {
      const offsets = Array.from({ length: RUNS_PER_PROJECT }, (_, i) => 400 - i * 10)
      for (let p = 0; p < DECOY_PROJECTS; p++) {
        seed(sqlite, `decoy-${p}`, crypto.randomUUID(), offsets)
      }
      seed(sqlite, 'plan-target', targetProjectId, offsets)
    })
    seedAll()

    const capture = captureStatements(sqlite)
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/plan-target/analytics/metrics?window=7d',
    })
    capture.stop()
    captured = capture.captured
    expect(res.statusCode).toBe(200)
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('has no ANALYZE statistics, so the plan must not depend on them', () => {
    // The production finding was measured on a database without `sqlite_stat1`.
    // If this ever becomes non-empty the plan assertions below stop proving
    // what they claim to prove.
    const stats = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'`)
      .all()
    expect(stats).toEqual([])
  })

  it('seeds enough rows for the plan choice to matter', () => {
    const { total } = sqlite.prepare(`SELECT COUNT(*) AS total FROM query_snapshots`).get() as { total: number }
    expect(total).toBe((DECOY_PROJECTS + 1) * RUNS_PER_PROJECT * SNAPSHOTS_PER_RUN)
  })

  it('never reads query_snapshots by provider or by full scan', () => {
    const snapshotReads = captured.filter(statement => /\bfrom "?query_snapshots"?/i.test(statement.sql))
    expect(snapshotReads.length).toBeGreaterThan(0)

    for (const statement of snapshotReads) {
      const plan = sqlite
        .prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
        .all(...statement.params) as Array<{ detail: string }>
      const details = plan.map(row => row.detail).join('\n')

      // A full scan of the table, or of the provider/model partition, is the
      // regression: both are unbounded in other projects' history.
      expect(details, `plan for: ${statement.sql}`).not.toMatch(/SCAN query_snapshots/)
      expect(details, `plan for: ${statement.sql}`).not.toMatch(/idx_snapshots_provider_model/)
      // The intended shape: run ids first, snapshots looked up by run id.
      expect(details, `plan for: ${statement.sql}`).toMatch(/SEARCH query_snapshots USING INDEX idx_snapshots_run/)
    }
  })

  it('narrows the anchor runs to this project through idx_runs_project', () => {
    const anchorRunReads = captured.filter(statement =>
      /\bfrom "?runs"?/i.test(statement.sql) && /project_id/i.test(statement.sql))
    expect(anchorRunReads.length).toBeGreaterThan(0)

    for (const statement of anchorRunReads) {
      const plan = sqlite
        .prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
        .all(...statement.params) as Array<{ detail: string }>
      const details = plan.map(row => row.detail).join('\n')
      expect(details, `plan for: ${statement.sql}`).toMatch(/SEARCH runs USING INDEX idx_runs_project/)
      expect(details, `plan for: ${statement.sql}`).not.toMatch(/SCAN runs/)
    }
  })

  it('would regress if the anchor were selected by provider (the original shape)', () => {
    // Proves the assertions above discriminate: this is the pre-fix query, and
    // on the same database it produces exactly the plan they reject.
    const plan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT runs.created_at FROM query_snapshots
      INNER JOIN runs ON query_snapshots.run_id = runs.id
      WHERE runs.project_id = ? AND runs.kind = 'answer-visibility'
        AND runs.status IN ('completed', 'partial')
        AND runs.created_at < ? AND query_snapshots.provider = ?
        AND query_snapshots.query_id IS NOT NULL
      ORDER BY runs.created_at DESC LIMIT 1
    `).all(targetProjectId, new Date().toISOString(), 'openai') as Array<{ detail: string }>
    const details = plan.map(row => row.detail).join('\n')

    expect(details).toMatch(/idx_snapshots_provider_model/)
    expect(details).toMatch(/TEMP B-TREE/)
  })

  it('reads only the newest pre-window sweep once every provider is anchored', () => {
    // Read amplification guard: the anchor search stops at the first sweep that
    // observes each in-window provider. Both seeded providers appear in every
    // sweep, so exactly one pre-window sweep may be read regardless of how much
    // pre-window history exists.
    const anchorSnapshotReads = captured.filter(statement =>
      /\bfrom "?query_snapshots"?/i.test(statement.sql) && /"?run_id"? in/i.test(statement.sql))
    // One read for the in-window snapshots, one for the single anchor sweep.
    expect(anchorSnapshotReads).toHaveLength(2)
  })
})
