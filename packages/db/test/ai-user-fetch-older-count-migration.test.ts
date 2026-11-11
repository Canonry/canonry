import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { createClient, MIGRATION_VERSIONS, migrate, trafficSources } from '../src/index.js'
import { insertLegacyProject, insertLegacyRow } from './legacy-rows.js'

/**
 * Hosted browser agents (Google-Agent, Claude-Agent) now count only their page
 * loads as AI user fetches. Hours a source wrote before were counted under
 * older rules: every file, data call and beacon their pages made counted, or
 * the older trust rules judged whole visits likely fake. They cannot be
 * recounted, so v222 marks where that older count ended on each source holding
 * such hours: the end of its last one, or the upgrade time if that is earlier.
 */

type Db = ReturnType<typeof createClient>

const UPGRADED_AT = '2026-11-11T18:31:33.000Z'
const CLAUDE_AGENT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-Agent/1.0) Chrome/154.0.0.0 Safari/537.36'

afterEach(() => {
  vi.useRealTimers()
})

function tempDb(): Db {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-user-fetch-older-count-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return createClient(path.join(tmpDir, 'test.db'))
}

/** A database at v221, the version before the marker, upgraded at `UPGRADED_AT`. */
function databaseAtV221(): Db {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(UPGRADED_AT))
  const db = tempDb()
  migrate(db, MIGRATION_VERSIONS.filter(version => version.version <= 221))
  return db
}

// Physical columns only: the database is still at v221, and Drizzle's insert
// names every column the current schema declares.
function seedProject(db: Db): string {
  const id = crypto.randomUUID()
  insertLegacyProject(db, { id, name: 'older-count', displayName: 'Older count', canonicalDomain: 'example.com', createdAt: '2026-08-01T00:00:00.000Z' })
  return id
}

function seedSource(db: Db, projectId: string, status = 'connected'): string {
  const id = crypto.randomUUID()
  insertLegacyRow(db, 'traffic_sources', {
    id, project_id: projectId, source_type: 'vercel', display_name: 'Source', status,
    config_json: {}, archived_at: status === 'archived' ? '2026-09-01T00:00:00.000Z' : null,
    created_at: '2026-06-01T00:00:00.000Z', updated_at: '2026-06-01T00:00:00.000Z',
  })
  return id
}

function seedUserFetch(db: Db, projectId: string, sourceId: string, botId: string, tsHour: string, pathNormalized = '/_next/static/chunks/main.js'): void {
  insertLegacyRow(db, 'ai_user_fetch_events_hourly', {
    project_id: projectId, source_id: sourceId, ts_hour: tsHour, bot_id: botId, operator: 'Operator',
    verification_status: 'claimed_unverified', path_normalized: pathNormalized, status: 200, hits: 20,
    sampled_user_agent: null, created_at: tsHour, updated_at: tsHour,
  })
}

function seedLikelyFake(db: Db, projectId: string, sourceId: string, botId: string, tsHour: string, reason: string): void {
  insertLegacyRow(db, 'ai_user_fetch_likely_fake_hourly', {
    project_id: projectId, source_id: sourceId, ts_hour: tsHour, bot_id: botId, operator: 'Operator',
    reason, hits: 4, created_at: tsHour, updated_at: tsHour,
  })
}

function seedUnrecognized(db: Db, projectId: string, sourceId: string, agentName: string, sampledUserAgent: string): void {
  const tsHour = '2026-11-10T14:00:00.000Z'
  insertLegacyRow(db, 'unrecognized_agent_events_hourly', {
    project_id: projectId, source_id: sourceId, ts_hour: tsHour, agent_name: agentName, hits: 6,
    sampled_user_agent: sampledUserAgent, sampled_path: '/pricing', created_at: tsHour, updated_at: tsHour,
  })
}

function olderCountUntil(db: Db, sourceId: string): string | null | undefined {
  return db.select({ until: trafficSources.aiUserFetchOlderCountUntil }).from(trafficSources)
    .where(eq(trafficSources.id, sourceId)).get()?.until
}

test('v222 marks the end of each source\'s last browser-agent hour, or the upgrade if it ends later', () => {
  const db = databaseAtV221()
  const projectId = seedProject(db)

  // Archived months ago: its last Google-Agent hour ends the older count there,
  // and a link fetcher's later hours do not move it.
  const archived = seedSource(db, projectId, 'archived')
  seedUserFetch(db, projectId, archived, 'google-agent', '2026-06-14T18:00:00.000Z')
  seedUserFetch(db, projectId, archived, 'google-agent', '2026-06-14T19:00:00.000Z', '/pricing')
  seedUserFetch(db, projectId, archived, 'chatgpt-user', '2026-08-30T10:00:00.000Z', '/pricing')
  // Claude-Agent read pages in the hour the upgrade ran: that hour ends after it.
  const live = seedSource(db, projectId)
  seedUserFetch(db, projectId, live, 'claude-agent', '2026-11-11T18:00:00.000Z')
  // The older trust rules sent whole browser-agent visits to the likely-fake
  // counts: those hours were counted the older way too. Here the latest
  // likely-fake hour ends after the latest counted one.
  const judgedFake = seedSource(db, projectId)
  seedUserFetch(db, projectId, judgedFake, 'google-agent', '2026-11-08T03:00:00.000Z', '/pricing')
  seedLikelyFake(db, projectId, judgedFake, 'claude-agent', '2026-11-09T06:00:00.000Z', 'scanner-path')
  seedLikelyFake(db, projectId, judgedFake, 'claude-agent', '2026-11-09T07:00:00.000Z', 'scanner-burst')
  // Only likely-fake browser-agent hours, the last one ending at midnight.
  const onlyJudgedFake = seedSource(db, projectId)
  seedLikelyFake(db, projectId, onlyJudgedFake, 'google-agent', '2026-10-02T23:00:00.000Z', 'scanner-burst')

  migrate(db)

  expect(olderCountUntil(db, archived)).toBe('2026-06-14T20:00:00.000Z')
  expect(olderCountUntil(db, live)).toBe(UPGRADED_AT)
  expect(olderCountUntil(db, judgedFake)).toBe('2026-11-09T08:00:00.000Z')
  expect(olderCountUntil(db, onlyJudgedFake)).toBe('2026-10-03T00:00:00.000Z')
})

test('v222 leaves a source without browser-agent rows unmarked', () => {
  const db = databaseAtV221()
  const projectId = seedProject(db)
  const marked = seedSource(db, projectId)
  seedUserFetch(db, projectId, marked, 'google-agent', '2026-11-10T14:00:00.000Z')
  // Link fetchers counted one request per fetch all along, likely fakes included.
  const linkFetcher = seedSource(db, projectId)
  seedUserFetch(db, projectId, linkFetcher, 'claude-user', '2026-11-10T14:00:00.000Z', '/pricing')
  seedLikelyFake(db, projectId, linkFetcher, 'chatgpt-user', '2026-11-10T15:00:00.000Z', 'scanner-path')
  // Third-party tools whose user agent names the agent: no rule matches them,
  // so their unrecognized-agent rows never become Claude-Agent's.
  const thirdParty = seedSource(db, projectId)
  seedUnrecognized(db, projectId, thirdParty, 'claude-agent-sdk', 'claude-agent-sdk/0.1')
  // Claude-Agent before it had a rule: an unrecognized agent the stored traffic
  // pass moves in, marking its source as it does.
  const beforeItsRule = seedSource(db, projectId)
  seedUnrecognized(db, projectId, beforeItsRule, 'claude-agent', CLAUDE_AGENT_UA)
  const quiet = seedSource(db, projectId)

  migrate(db)

  expect(olderCountUntil(db, marked)).toBe('2026-11-10T15:00:00.000Z')
  expect(olderCountUntil(db, linkFetcher)).toBeNull()
  expect(olderCountUntil(db, thirdParty)).toBeNull()
  expect(olderCountUntil(db, beforeItsRule)).toBeNull()
  expect(olderCountUntil(db, quiet)).toBeNull()
})

test('v222 keeps a marker already set', () => {
  const db = databaseAtV221()
  const projectId = seedProject(db)
  const source = seedSource(db, projectId)
  seedUserFetch(db, projectId, source, 'google-agent', '2026-06-14T19:00:00.000Z')
  // A database whose version record was lost replays every version over the
  // column it already has.
  db.run(sql.raw(`ALTER TABLE traffic_sources ADD COLUMN ai_user_fetch_older_count_until TEXT`))
  db.run(sql`UPDATE traffic_sources SET ai_user_fetch_older_count_until = '2026-09-01T00:00:00.000Z' WHERE id = ${source}`)

  migrate(db)

  expect(olderCountUntil(db, source)).toBe('2026-09-01T00:00:00.000Z')
})

test('a database without the hourly tables skips the stamp', () => {
  const db = tempDb()
  db.run(sql.raw(`CREATE TABLE traffic_sources (id TEXT PRIMARY KEY, ai_user_fetch_older_count_until TEXT)`))
  db.run(sql.raw(`INSERT INTO traffic_sources (id) VALUES ('legacy')`))
  const v222 = MIGRATION_VERSIONS.find(version => version.version === 222)
  expect(() => v222!.run!(db)).not.toThrow()
  expect(db.all(sql.raw(`SELECT ai_user_fetch_older_count_until AS until FROM traffic_sources`))).toEqual([{ until: null }])
})
