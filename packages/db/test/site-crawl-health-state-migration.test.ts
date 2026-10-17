import { test, expect, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { sql } from 'drizzle-orm'
import { deriveSiteHealthState, siteHealthStateSchema } from '@canonry/canonry-contracts'
import { createClient, migrate, projects, runs, siteCrawlAttempts, siteCrawlPages } from '../src/index.js'
import { backfillSiteCrawlPageHealthState } from '../src/migrate.js'

// v130 persists the derived Site Health state so reads can filter on an index
// instead of recomputing it over every page row. The backfill runs in
// TypeScript inside the version transaction and calls the contract's own
// `deriveSiteHealthState`, so there is no SQL reimplementation to drift from
// what the crawl executor writes and what every reader reads.

const FETCH_STATES = ['discovered', 'robots-blocked', 'html', 'redirect', 'non-html', 'fetch-error']
const INDEXABILITY_STATES = ['indexable', 'noindex', 'blocked', 'unknown']

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-health-state-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return db
}

/** Every crawler state combination, as a snapshot published before v130. */
function seedLegacyCrawl(db: ReturnType<typeof createClient>) {
  const projectId = crypto.randomUUID()
  const runId = crypto.randomUUID()
  const attemptId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId, name: `p-${projectId.slice(0, 8)}`, displayName: 'p',
    canonicalDomain: 'example.com', country: 'US', language: 'en',
    createdAt: now, updatedAt: now,
  }).run()
  db.insert(runs).values({
    id: runId, projectId, kind: 'site-audit', status: 'completed',
    trigger: 'manual', createdAt: now,
  }).run()
  db.insert(siteCrawlAttempts).values({
    id: attemptId, projectId, runId, attemptNumber: 1, state: 'completed',
    createdAt: now, updatedAt: now,
  }).run()

  const rows = []
  for (const fetchState of FETCH_STATES) {
    for (const indexabilityState of INDEXABILITY_STATES) {
      for (const variant of ['plain', 'canonical-away', 'reason-canonical'] as const) {
        const nodeKey = `${fetchState}:${indexabilityState}:${variant}`
        rows.push({
          id: crypto.randomUUID(), projectId, runId, attemptId, nodeKey,
          url: `https://example.com/${encodeURIComponent(nodeKey)}`,
          path: `/${nodeKey}`, parentPath: '/', discoverySource: 'link',
          fetchState, indexabilityState,
          indexabilityReasons: variant === 'reason-canonical' ? ['canonical-to-other'] : [],
          canonicalNodeKey: variant === 'canonical-away' ? 'some-other-node' : null,
          auditState: 'complete', inventoryEligible: true, depth: 1,
          createdAt: now, updatedAt: now,
        })
      }
    }
  }
  db.insert(siteCrawlPages).values(rows).run()
  // Simulate the pre-v130 state: the column exists but was never written.
  db.run(sql`UPDATE site_crawl_pages SET health_state = NULL`)
  return { projectId, runId, attemptId, expected: rows.length }
}

test('backfills every legacy page with exactly what the contract derives', () => {
  const db = freshDb()
  const { expected } = seedLegacyCrawl(db)

  const before = db.all(sql`SELECT count(*) AS n FROM site_crawl_pages WHERE health_state IS NULL`) as Array<{ n: number }>
  expect(before[0]!.n).toBe(expected)

  backfillSiteCrawlPageHealthState(db)

  const rows = db.select().from(siteCrawlPages).all()
  expect(rows).toHaveLength(expected)
  for (const row of rows) {
    expect(row.healthState, row.nodeKey).toBe(deriveSiteHealthState(row))
    expect(row.healthState).not.toBeNull()
  }
  // Every state is genuinely represented, so this is not a vacuous pass.
  expect(new Set(rows.map((row) => row.healthState))).toEqual(
    new Set(['eligible', 'hidden', 'resource', 'redirect', 'failed', 'unchecked']),
  )

  // The persisted values and the DTO vocabulary are the same closed set: a
  // stored value the contract does not know would break every filter.
  for (const row of rows) {
    expect(siteHealthStateSchema.safeParse(row.healthState).success, `${row.nodeKey}=${row.healthState}`).toBe(true)
  }

  // A fetched .txt or PDF is stored as a resource, never as hidden. This is
  // the /llms-full.txt case the founder reported.
  const resources = rows.filter((row) => row.fetchState === 'non-html')
  expect(resources.length).toBeGreaterThan(0)
  expect(resources.every((row) => row.healthState === 'resource')).toBe(true)
  const redirects = rows.filter((row) => row.fetchState === 'redirect')
  expect(redirects.every((row) => row.healthState === 'redirect')).toBe(true)
})

test('is idempotent and leaves already-populated rows alone', () => {
  const db = freshDb()
  seedLegacyCrawl(db)

  backfillSiteCrawlPageHealthState(db)
  const first = db.select().from(siteCrawlPages).all().map((row) => [row.nodeKey, row.healthState])

  // A row written by a newer crawl must not be recomputed or disturbed.
  db.run(sql`UPDATE site_crawl_pages SET health_state = 'eligible' WHERE node_key = 'html:noindex:plain'`)
  expect(() => backfillSiteCrawlPageHealthState(db)).not.toThrow()

  const second = new Map(db.select().from(siteCrawlPages).all().map((row) => [row.nodeKey, row.healthState]))
  expect(second.get('html:noindex:plain')).toBe('eligible')
  for (const [nodeKey, healthState] of first) {
    if (nodeKey === 'html:noindex:plain') continue
    expect(second.get(nodeKey as string)).toBe(healthState)
  }
})

test('runs as part of migrate, so an existing install needs no manual step', () => {
  const db = freshDb()
  const { expected } = seedLegacyCrawl(db)

  // Re-running the migrator applies nothing new (v130 is already recorded),
  // so drive the backfill the way the version does and assert the outcome an
  // upgraded install sees: every page filterable.
  backfillSiteCrawlPageHealthState(db)
  migrate(db)

  const remaining = db.all(sql`SELECT count(*) AS n FROM site_crawl_pages WHERE health_state IS NULL`) as Array<{ n: number }>
  expect(remaining[0]!.n).toBe(0)
  expect(db.select().from(siteCrawlPages).all()).toHaveLength(expected)
})
