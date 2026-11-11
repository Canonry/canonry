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
 * loads as AI user fetches. Hours a source wrote before counted every file,
 * data call and beacon their pages made and cannot be recounted, so v222
 * stamps when that older count ended on each source holding such hours, and
 * on no other source.
 */

type Db = ReturnType<typeof createClient>

const UPGRADED_AT = '2026-11-11T18:31:33.000Z'
const HOUR = '2026-11-10T14:00:00.000Z'
const CLAUDE_AGENT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-Agent/1.0) Chrome/154.0.0.0 Safari/537.36'

afterEach(() => {
  vi.useRealTimers()
})

function tempDb(): Db {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-user-fetch-older-count-'))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  return createClient(path.join(tmpDir, 'test.db'))
}

// Physical columns only: the database is still at v221, and Drizzle's insert
// names every column the current schema declares.
function seedProject(db: Db): string {
  const id = crypto.randomUUID()
  insertLegacyProject(db, { id, name: 'older-count', displayName: 'Older count', canonicalDomain: 'example.com', createdAt: '2026-08-01T00:00:00.000Z' })
  return id
}

function seedSource(db: Db, projectId: string): string {
  const id = crypto.randomUUID()
  insertLegacyRow(db, 'traffic_sources', {
    id, project_id: projectId, source_type: 'vercel', display_name: 'Source', status: 'connected',
    config_json: {}, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
  })
  return id
}

function seedUserFetch(db: Db, projectId: string, sourceId: string, botId: string, pathNormalized = '/_next/static/chunks/main.js'): void {
  insertLegacyRow(db, 'ai_user_fetch_events_hourly', {
    project_id: projectId, source_id: sourceId, ts_hour: HOUR, bot_id: botId, operator: 'Operator',
    verification_status: 'claimed_unverified', path_normalized: pathNormalized, status: 200, hits: 20,
    sampled_user_agent: null, created_at: HOUR, updated_at: HOUR,
  })
}

function seedUnrecognized(db: Db, projectId: string, sourceId: string, agentName: string, sampledUserAgent: string): void {
  insertLegacyRow(db, 'unrecognized_agent_events_hourly', {
    project_id: projectId, source_id: sourceId, ts_hour: HOUR, agent_name: agentName, hits: 6,
    sampled_user_agent: sampledUserAgent, sampled_path: '/pricing', created_at: HOUR, updated_at: HOUR,
  })
}

function olderCountUntil(db: Db, sourceId: string): string | null | undefined {
  return db.select({ until: trafficSources.aiUserFetchOlderCountUntil }).from(trafficSources)
    .where(eq(trafficSources.id, sourceId)).get()?.until
}

test('v222 stamps only sources holding a browser agent\'s hours, and a rerun keeps the stamp', () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(UPGRADED_AT))
  const db = tempDb()
  migrate(db, MIGRATION_VERSIONS.filter(version => version.version <= 221))
  const projectId = seedProject(db)

  const google = seedSource(db, projectId)
  seedUserFetch(db, projectId, google, 'google-agent')
  const claude = seedSource(db, projectId)
  seedUserFetch(db, projectId, claude, 'claude-agent')
  // Claude-Agent before its rule: an unrecognized agent the stored traffic pass moves.
  const beforeItsRule = seedSource(db, projectId)
  seedUnrecognized(db, projectId, beforeItsRule, 'claude-agent', CLAUDE_AGENT_UA)
  // A link fetcher and another unrecognized agent counted one request per fetch all along.
  const linkFetcher = seedSource(db, projectId)
  seedUserFetch(db, projectId, linkFetcher, 'claude-user', '/pricing')
  seedUnrecognized(db, projectId, linkFetcher, 'pinterestbot', 'Mozilla/5.0 (compatible; Pinterestbot/1.0; +http://www.pinterest.com/bot.html)')
  const quiet = seedSource(db, projectId)

  migrate(db)

  expect(olderCountUntil(db, google)).toBe(UPGRADED_AT)
  expect(olderCountUntil(db, claude)).toBe(UPGRADED_AT)
  expect(olderCountUntil(db, beforeItsRule)).toBe(UPGRADED_AT)
  expect(olderCountUntil(db, linkFetcher)).toBeNull()
  expect(olderCountUntil(db, quiet)).toBeNull()

  // A rerun keeps the time the older count ended.
  vi.setSystemTime(new Date('2026-11-12T09:00:00.000Z'))
  seedUserFetch(db, projectId, quiet, 'google-agent')
  const v222 = MIGRATION_VERSIONS.find(version => version.version === 222)
  expect(v222?.name).toBe('ai-user-fetch-older-count-until')
  v222!.run!(db)
  expect(olderCountUntil(db, google)).toBe(UPGRADED_AT)
  expect(olderCountUntil(db, quiet)).toBe('2026-11-12T09:00:00.000Z')
})

test('a fresh install stamps nothing', () => {
  const db = tempDb()
  migrate(db)
  const projectId = seedProject(db)
  const source = seedSource(db, projectId)
  seedUserFetch(db, projectId, source, 'google-agent')
  expect(olderCountUntil(db, source)).toBeNull()
})

test('a database without the hourly tables skips the stamp', () => {
  const db = tempDb()
  db.run(sql.raw(`CREATE TABLE traffic_sources (id TEXT PRIMARY KEY, ai_user_fetch_older_count_until TEXT)`))
  db.run(sql.raw(`INSERT INTO traffic_sources (id) VALUES ('legacy')`))
  const v222 = MIGRATION_VERSIONS.find(version => version.version === 222)
  expect(() => v222!.run!(db)).not.toThrow()
  expect(db.all(sql.raw(`SELECT ai_user_fetch_older_count_until AS until FROM traffic_sources`))).toEqual([{ until: null }])
})
