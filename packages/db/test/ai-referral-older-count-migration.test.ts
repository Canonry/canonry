import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { expect, onTestFinished, test } from 'vitest'
import {
  aiReferralEventsHourly,
  createClient,
  MIGRATION_VERSIONS,
  migrate,
  trafficSources,
} from '../src/index.js'
import { insertLegacyProject } from './legacy-rows.js'

/**
 * v207 began counting each AI-referral arrival once per visit. Hours a source
 * wrote before it also counted the visitor's later requests and cannot be
 * recounted, so v211 stamps when that older count ended on each source that
 * holds such rows, and on no other source.
 */

type Db = ReturnType<typeof createClient>

const RULE_APPLIED_AT = '2026-11-02 18:31:33'
const RULE_SINCE = '2026-11-02T18:31:33.000Z'

function tempDb(): Db {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-older-count-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return createClient(path.join(tmpDir, 'test.db'))
}

// Physical columns only: the database is still at v210, and Drizzle's insert
// names every column the current schema declares.
function seedProject(db: Db): string {
  const id = crypto.randomUUID()
  insertLegacyProject(db, { id, name: 'older-count', displayName: 'Older count', canonicalDomain: 'example.com', createdAt: '2026-08-01T00:00:00.000Z' })
  return id
}

function seedSource(db: Db, projectId: string): string {
  const id = crypto.randomUUID()
  db.run(sql`INSERT INTO traffic_sources (id, project_id, source_type, display_name, status, config_json, created_at, updated_at)
    VALUES (${id}, ${projectId}, 'cloudflare', 'Source', 'connected', '{}', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`)
  return id
}

function seedReferral(db: Db, projectId: string, sourceId: string, tsHour: string, createdAt: string): void {
  db.insert(aiReferralEventsHourly).values({
    projectId, sourceId, tsHour, product: 'ChatGPT', operator: 'OpenAI', sourceDomain: 'chatgpt.com',
    evidenceType: 'utm', landingPathNormalized: '/', status: 200,
    sessionsOrHits: 3, paidSessionsOrHits: 0, organicSessionsOrHits: 3,
    createdAt, updatedAt: createdAt,
  }).run()
}

function olderCountUntil(db: Db, sourceId: string): string | null | undefined {
  return db.select({ until: trafficSources.aiReferralOlderCountUntil }).from(trafficSources)
    .where(eq(trafficSources.id, sourceId)).get()?.until
}

test('v211 stamps only sources holding referral rows written before v207', () => {
  const db = tempDb()
  migrate(db, MIGRATION_VERSIONS.filter(version => version.version <= 210))
  db.run(sql`UPDATE _migrations SET applied_at = ${RULE_APPLIED_AT} WHERE version = 207`)
  const projectId = seedProject(db)

  // Written before the rule changed: an older count, whatever hour it is for.
  const older = seedSource(db, projectId)
  seedReferral(db, projectId, older, '2026-10-20T14:00:00.000Z', '2026-10-20T14:05:00.000Z')
  seedReferral(db, projectId, older, '2026-11-04T09:00:00.000Z', '2026-11-04T09:05:00.000Z')
  // Written after it, even for hours before it (a backfill): counted by the new rule.
  const backfilled = seedSource(db, projectId)
  seedReferral(db, projectId, backfilled, '2026-10-01T10:00:00.000Z', '2026-11-03T08:00:00.000Z')
  // No referral rows at all.
  const quiet = seedSource(db, projectId)

  migrate(db)

  expect(olderCountUntil(db, older)).toBe(RULE_SINCE)
  expect(olderCountUntil(db, backfilled)).toBeNull()
  expect(olderCountUntil(db, quiet)).toBeNull()
})

test('a fresh install stamps nothing', () => {
  const db = tempDb()
  migrate(db)
  const projectId = seedProject(db)
  const source = seedSource(db, projectId)
  seedReferral(db, projectId, source, '2026-10-20T14:00:00.000Z', '2026-10-20T14:05:00.000Z')
  expect(olderCountUntil(db, source)).toBeNull()
})
