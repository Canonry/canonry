import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from 'vitest'
import { createClient, migrate, MIGRATION_VERSIONS } from '../src/index.js'

/**
 * Downgrade safety: platform tenants pin their engine image at provision and
 * roll BACK by reprovisioning an older image onto the SAME data volume. A
 * newer binary that migrated the volume must never strand an older binary.
 * Baseline v88: every migration after it must keep these invariants.
 */
const DOWNGRADE_BASELINE = 88

function tempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-downgrade-test-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  return { db, tmpDir }
}

const ADDITIVE = [
  /^CREATE TABLE IF NOT EXISTS/i,
  /^CREATE (UNIQUE )?INDEX IF NOT EXISTS/i,
  // v150's immutable-definition trigger only rejects UPDATE on a new sidecar
  // table. It does not alter or rewrite legacy rows, and older binaries never
  // write that table, so it is additive and safe across a binary rollback.
  /^CREATE TRIGGER IF NOT EXISTS simple_measurement_definitions_no_update/i,
  /^ALTER TABLE \S+ ADD COLUMN/i,
]

test(`every migration after v${DOWNGRADE_BASELINE} is additive-only (downgrade-safe)`, () => {
  const newer = MIGRATION_VERSIONS.filter((mv) => mv.version > DOWNGRADE_BASELINE)
  expect(newer.length).toBeGreaterThan(0)
  for (const mv of newer) {
    for (const statement of mv.statements) {
      const normalized = statement.trim().replace(/\s+/g, ' ')
      expect(
        ADDITIVE.some((re) => re.test(normalized)),
        `v${mv.version} (${mv.name}) has a non-additive statement: ${normalized.slice(0, 80)}`,
      ).toBe(true)
    }
  }
})

/**
 * `run` hooks execute arbitrary code the statement allowlist cannot see. A
 * post-baseline migration that needs one must be explicitly reviewed for
 * downgrade safety and listed here WITH a justification comment.
 */
const RUN_HOOK_ALLOWLIST: ReadonlySet<number> = new Set([
  // v95 only adds a defaulted column + index, but uses run() to skip partial
  // legacy schemas where ga_ai_referrals has not been bootstrapped yet.
  95,
  // v96 only rewrites `ga_ai_referrals.traffic_class` VALUES; it makes no schema
  // change. Downgrade-safe: the column is unknown to any binary older than v95,
  // so an older engine neither reads nor writes it. It needs run() because the
  // class comes from the shared TS classifier, which SQL cannot express (the
  // landing-page check requires URL parsing).
  96,
  // v98 only rewrites `query_snapshots.query_id` VALUES (relinks FK-orphaned
  // snapshots to the same-project query with matching normalized text); it
  // makes no schema change. Downgrade-safe: `query_id` has existed since the
  // initial schema and a populated FK is exactly what every binary expects —
  // an older engine reads the relinked rows the same way it reads rows that
  // were never orphaned. Idempotent via the `query_id IS NULL` guard.
  98,
  // v105 adds a nullable column in statements[] and uses run() only to POPULATE
  // it, recovering the served model from each row's already-stored
  // `raw_response.$.apiResponse.model`. Downgrade-safe: `served_model` is
  // unknown to any binary older than v105, so an older engine neither reads nor
  // writes it, and the column is nullable so an older writer's INSERT that
  // omits it still succeeds. The backfill only reads a JSON field that was
  // already persisted — it invents nothing and touches no other column.
  // Idempotent via the `served_model IS NULL` guard, which also stops it
  // overwriting a value the live insert path recorded.
  105,
  // v118 adds nullable snapshot execution/context columns and rebuilds `runs`
  // only to attach the same-project measurement-plan foreign key. It preserves
  // every existing column and row. An older binary ignores the new nullable
  // columns and continues to write valid runs; the hook is required because
  // SQLite cannot add a foreign key without a transactional table rebuild.
  118,
  // v130 adds a nullable column in statements[] and uses run() only to
  // POPULATE it with the derived Site Health state. Downgrade-safe:
  // `health_state` is unknown to any binary older than v130, so an older
  // engine neither reads nor writes it, and the column is nullable so an
  // older writer's INSERT that omits it still succeeds (the read surface
  // reports such a row as unfilterable rather than guessing). The hook is
  // required because the derivation folds fetch state, indexability, the
  // crawler's reasons, and canonical identity together, which SQL cannot
  // express without becoming a second implementation that drifts from the
  // contract; the backfill calls that same contract function directly. It
  // reads only columns already persisted on the row and invents nothing.
  // Idempotent via the `health_state IS NULL` guard, which also stops it
  // overwriting a value the live crawl path recorded.
  130,
  // v131 adds nullable/defaulted columns in statements[] and uses run() only
  // to POPULATE them: which stored links are nav, header, or footer chrome.
  // Downgrade-safe: `is_template`, `template_ratio`, and `template_detection`
  // are unknown to any binary older than v131, so an older engine neither
  // reads nor writes them; they are nullable, and the two counters it adds to
  // existing tables are NOT NULL with a default, so an older writer's INSERT
  // that omits every one of them still succeeds. The hook is required because
  // the derivation counts DISTINCT source pages per (target, normalized
  // anchor) pair, and the anchor normalizer is the contract's own function:
  // expressing it in SQL would be a second implementation that drifts. The
  // backfill reads only columns already persisted (anchors, node keys, the
  // attempt's fetched-page count) and invents nothing. Idempotent: each
  // attempt is reclassified from its own rows, so a retry writes the same
  // values. It deliberately does NOT rewrite published layout coordinates,
  // which are immutable per attempt; those rows keep
  // `template_links_excluded = 0` so the map can say so.
  131,
  // v132 deletes stored self-links and makes NO schema change. It uses run()
  // only because the statement allowlist is schema-shaped; the work is a
  // DELETE of rows the crawl engine already excluded from the page metrics
  // built in the same crawl, so the edge tables disagreed with their own page
  // rows and every self-linking page read one link higher in each direction.
  // Downgrade-safe: an older binary sees fewer edge rows, and the ones removed
  // are exactly the rows it was miscounting, so it is strictly better off.
  // Idempotent: a re-run deletes nothing once they are gone.
  132,
  // v133 makes NO schema change: it re-runs v131's backfill because the rule
  // v131 applied was wrong. v131 marked a link as chrome when its most
  // ubiquitous anchor was ubiquitous, but one row aggregates every anchor
  // between the same two pages, so an in-prose link sharing a row with a
  // footer link to the same target inherited the footer's ratio and was
  // hidden. The rule is now the least ubiquitous anchor. Downgrade-safe:
  // `is_template` and `template_ratio` are unknown to any binary older than
  // v131, and to a v131-or-newer binary these are the values its own
  // classifier would now produce from the same stored rows. It uses run() for
  // the same reason v131 does: the derivation counts DISTINCT source pages per
  // (target, normalized anchor) pair using the contract's own normalizer,
  // which SQL cannot express without becoming a second implementation.
  // Idempotent: the hook resets each attempt before writing, so a retry writes
  // the same values.
  133,
  // v140 adds a defaulted column in statements[] and uses run() to reclassify
  // stored dead-link findings: a finding whose `evidence.statusCode` is null
  // was never evidence of a broken link (the crawl got no response at all — a
  // timeout, a reset socket, throttling under our own concurrency), and those
  // rows were being served to clients as broken links. The hook rewrites the
  // three counts to absolute values derived from the surviving rows and
  // deletes the fabricated ones. Downgrade-safe on the same grounds as v132:
  // an older binary sees fewer dead-link rows, and the ones removed are
  // exactly the rows it was misreporting, so it is strictly better off;
  // `dead_links_unverified` is unknown to any binary older than v140 and is
  // NOT NULL with a default, so an older writer's INSERT that omits it still
  // succeeds. It uses run() because the statement allowlist is schema-shaped
  // and because `dead_links_checked` must lose exactly the DISTINCT targets
  // that were never reached, which is a per-attempt figure. Idempotent: the
  // HAVING clause selects only attempts still holding a fabricated row and
  // the delete removes exactly those, so a re-run selects nothing and
  // `dead_links_checked` cannot be reduced twice.
  140,
])

test(`migrations after v${DOWNGRADE_BASELINE} define no run() hook unless explicitly allowlisted`, () => {
  for (const mv of MIGRATION_VERSIONS.filter((m) => m.version > DOWNGRADE_BASELINE)) {
    if (mv.run !== undefined) {
      expect(
        RUN_HOOK_ALLOWLIST.has(mv.version),
        `v${mv.version} (${mv.name}) defines a run() hook: review it for downgrade safety and allowlist it with a justification`,
      ).toBe(true)
    }
  }
})

test(`columns added after v${DOWNGRADE_BASELINE} are nullable or defaulted (old writers omit them)`, () => {
  for (const mv of MIGRATION_VERSIONS.filter((m) => m.version > DOWNGRADE_BASELINE)) {
    for (const statement of mv.statements) {
      const normalized = statement.trim().replace(/\s+/g, ' ')
      if (!/ADD COLUMN/i.test(normalized)) continue
      if (/NOT NULL/i.test(normalized)) {
        expect(/DEFAULT/i.test(normalized), `v${mv.version}: NOT NULL ADD COLUMN without DEFAULT`).toBe(true)
      }
    }
  }
})

test('an older binary boots cleanly against a fully-migrated newer DB (no throw, no re-apply)', () => {
  const { db, tmpDir } = tempDb()
  try {
    migrate(db) // the "newer binary" migrates the volume fully
    const before = db.$client.prepare('SELECT version, name FROM _migrations ORDER BY version').all()
    // Simulate the older binary: its MIGRATION_VERSIONS list ends at the
    // baseline. Booting it against the newer volume must be a clean no-op.
    const olderList = MIGRATION_VERSIONS.filter((mv) => mv.version <= DOWNGRADE_BASELINE)
    expect(() => migrate(db, olderList)).not.toThrow()
    const after = db.$client.prepare('SELECT version, name FROM _migrations ORDER BY version').all()
    expect(after).toEqual(before)
  } finally {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('an older writer INSERT that omits post-baseline discovery columns still succeeds', () => {
  const { db, tmpDir } = tempDb()
  try {
    migrate(db)
    const now = new Date().toISOString()
    db.$client
      .prepare(`INSERT INTO projects (id, name, display_name, canonical_domain, country, language, created_at, updated_at)
                VALUES ('p1','old-writer','Old','example.com','US','en',?,?)`)
      .run(now, now)
    // The exact column set an older (pre-89) binary writes for a session.
    db.$client
      .prepare(`INSERT INTO discovery_sessions (id, project_id, status, icp_description, competitor_map, created_at)
                VALUES ('s1','p1','queued','icp','[]',?)`)
      .run(now)
    const row = db.$client
      .prepare(`SELECT seed_brand_filtered_count, buyer_description FROM discovery_sessions WHERE id='s1'`)
      .get() as Record<string, unknown>
    expect(row.seed_brand_filtered_count).toBeNull()
    expect(row.buyer_description).toBeNull()
  } finally {
    db.$client.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
