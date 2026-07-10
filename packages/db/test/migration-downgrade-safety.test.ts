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
