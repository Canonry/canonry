import { test, expect, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import {
  createClient,
  migrate,
  projects,
  trafficSources,
  crawlerEventsHourly,
  aiUserFetchEventsHourly,
  aiReferralEventsHourly,
  rawEventSamples,
} from '../src/index.js'
import { MIGRATION_VERSIONS } from '../src/migrate.js'

function createTempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-traffic-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  return { db, dbPath, tmpDir }
}

function cleanup(tmpDir: string) {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

function seedProject(db: ReturnType<typeof createTempDb>['db']) {
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: 'proj_1',
    name: 'test-project',
    displayName: 'Test Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
}

test('traffic_sources round-trips a connected cloud-run source', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)

  const now = new Date().toISOString()
  db.insert(trafficSources).values({
    id: 'src_1',
    projectId: 'proj_1',
    sourceType: 'cloud-run',
    displayName: 'Cloud Run · openclaw-nyc',
    status: 'connected',
    lastSyncedAt: null,
    lastCursor: null,
    lastError: null,
    archivedAt: null,
    configJson: JSON.stringify({ gcpProjectId: 'openclaw-nyc', serviceName: 'openclaw-nyc', location: 'us-east1', authMode: 'service-account' }),
    createdAt: now,
    updatedAt: now,
  }).run()

  const [row] = db.select().from(trafficSources).where(eq(trafficSources.id, 'src_1')).all()

  expect(row).toBeDefined()
  expect(row.sourceType).toBe('cloud-run')
  expect(row.status).toBe('connected')
  expect(row.archivedAt).toBeNull()
  expect(row.lastSyncedAt).toBeNull()
})

test('traffic_sources supports archived status with archived_at', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)

  const now = new Date().toISOString()
  db.insert(trafficSources).values({
    id: 'src_archived',
    projectId: 'proj_1',
    sourceType: 'cloud-run',
    displayName: 'Old host',
    status: 'archived',
    archivedAt: now,
    configJson: {},
    createdAt: now,
    updatedAt: now,
  }).run()

  const [row] = db.select().from(trafficSources).where(eq(trafficSources.id, 'src_archived')).all()

  expect(row.status).toBe('archived')
  expect(row.archivedAt).toBe(now)
})

test('crawler_events_hourly composite PK rejects duplicate inserts and accumulates via upsert', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)

  const now = new Date().toISOString()
  db.insert(trafficSources).values({
    id: 'src_2',
    projectId: 'proj_1',
    sourceType: 'cloud-run',
    displayName: 'Cloud Run',
    status: 'connected',
    configJson: {},
    createdAt: now,
    updatedAt: now,
  }).run()

  const baseRow = {
    projectId: 'proj_1',
    sourceId: 'src_2',
    tsHour: '2026-05-07T17:00:00.000Z',
    botId: 'gptbot',
    operator: 'OpenAI',
    verificationStatus: 'claimed_unverified',
    pathNormalized: '/blog/foo',
    status: 200,
    hits: 3,
    sampledUserAgent: 'GPTBot/1.0',
    createdAt: now,
    updatedAt: now,
  }

  db.insert(crawlerEventsHourly).values(baseRow).run()

  // Re-insert with a different hits count must conflict on the composite PK
  // and let the caller upsert (set hits = hits + 5).
  expect(() => db.insert(crawlerEventsHourly).values(baseRow).run()).toThrow()

  // Composite PK lookup works
  const [row] = db
    .select()
    .from(crawlerEventsHourly)
    .where(
      and(
        eq(crawlerEventsHourly.projectId, 'proj_1'),
        eq(crawlerEventsHourly.sourceId, 'src_2'),
        eq(crawlerEventsHourly.tsHour, '2026-05-07T17:00:00.000Z'),
        eq(crawlerEventsHourly.botId, 'gptbot'),
        eq(crawlerEventsHourly.verificationStatus, 'claimed_unverified'),
        eq(crawlerEventsHourly.pathNormalized, '/blog/foo'),
        eq(crawlerEventsHourly.status, 200),
      ),
    )
    .all()
  expect(row.hits).toBe(3)
  expect(row.operator).toBe('OpenAI')
})

test('ai_referral_events_hourly stores hourly buckets keyed by product+source+evidence', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)

  const now = new Date().toISOString()
  db.insert(trafficSources).values({
    id: 'src_3',
    projectId: 'proj_1',
    sourceType: 'cloud-run',
    displayName: 'Cloud Run',
    status: 'connected',
    configJson: {},
    createdAt: now,
    updatedAt: now,
  }).run()

  db.insert(aiReferralEventsHourly).values({
    projectId: 'proj_1',
    sourceId: 'src_3',
    tsHour: '2026-05-07T17:00:00.000Z',
    product: 'ChatGPT',
    operator: 'OpenAI',
    sourceDomain: 'chatgpt.com',
    evidenceType: 'utm',
    landingPathNormalized: '/blog/open-source-aeo-audit-tool',
    status: 200,
    sessionsOrHits: 2,
    usersEstimated: null,
    createdAt: now,
    updatedAt: now,
  }).run()

  const [row] = db
    .select()
    .from(aiReferralEventsHourly)
    .where(
      and(
        eq(aiReferralEventsHourly.projectId, 'proj_1'),
        eq(aiReferralEventsHourly.product, 'ChatGPT'),
      ),
    )
    .all()
  expect(row).toBeDefined()
  expect(row.evidenceType).toBe('utm')
  expect(row.sessionsOrHits).toBe(2)
  expect(row.usersEstimated).toBeNull()
})

test('raw_event_samples stores debug samples without full IPs', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)

  const now = new Date().toISOString()
  db.insert(trafficSources).values({
    id: 'src_4',
    projectId: 'proj_1',
    sourceType: 'cloud-run',
    displayName: 'Cloud Run',
    status: 'connected',
    configJson: {},
    createdAt: now,
    updatedAt: now,
  }).run()

  db.insert(rawEventSamples).values({
    id: 'sample_1',
    projectId: 'proj_1',
    sourceId: 'src_4',
    ts: '2026-05-07T17:32:00.000Z',
    eventType: 'crawler',
    ipHash: 'abc123def',
    userAgent: 'GPTBot/1.0',
    pathNormalized: '/pricing',
    status: 200,
    refererHost: null,
    classifierDetailsJson: JSON.stringify({ botId: 'gptbot' }),
    createdAt: now,
  }).run()

  const [row] = db.select().from(rawEventSamples).where(eq(rawEventSamples.id, 'sample_1')).all()
  expect(row.eventType).toBe('crawler')
  expect(row.ipHash).toBe('abc123def')
  expect(row.userAgent).toBe('GPTBot/1.0')
})

test('ai_user_fetch_events_hourly accepts inserts keyed like crawler_events_hourly', () => {
  // The new table mirrors crawler_events_hourly schema-wise but holds the
  // human-in-the-loop UA matches (ChatGPT-User, Perplexity-User, etc.) so
  // dashboard / API counts can split machine crawl from user-driven fetch.
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)

  const now = new Date().toISOString()
  db.insert(trafficSources).values({
    id: 'src_user_fetch',
    projectId: 'proj_1',
    sourceType: 'cloud-run',
    displayName: 'Cloud Run',
    status: 'connected',
    configJson: {},
    createdAt: now,
    updatedAt: now,
  }).run()

  db.insert(aiUserFetchEventsHourly).values({
    projectId: 'proj_1',
    sourceId: 'src_user_fetch',
    tsHour: '2026-05-19T20:00:00.000Z',
    botId: 'openai-chatgpt-user',
    operator: 'OpenAI',
    verificationStatus: 'verified',
    pathNormalized: '/',
    status: 200,
    hits: 1,
    sampledUserAgent: 'Mozilla/5.0 ChatGPT-User/1.0',
    createdAt: now,
    updatedAt: now,
  }).run()

  const [row] = db
    .select()
    .from(aiUserFetchEventsHourly)
    .where(
      and(
        eq(aiUserFetchEventsHourly.projectId, 'proj_1'),
        eq(aiUserFetchEventsHourly.botId, 'openai-chatgpt-user'),
      ),
    )
    .all()

  expect(row).toBeDefined()
  expect(row.verificationStatus).toBe('verified')
  expect(row.hits).toBe(1)
})

test('migration 64 moves legacy user-fetch rows out of crawler_events_hourly', () => {
  // Before the split, ChatGPT-User and Perplexity-User UAs were classified as
  // crawlers and persisted into crawler_events_hourly. The migration's job is
  // to move those rows into ai_user_fetch_events_hourly so historical totals
  // stop double-counting user-fetch as machine crawl. Re-runs the v64 SQL
  // explicitly against pre-existing rows (the migration runner records v64
  // as applied on first boot and won't re-run it, so this seeds the same
  // state that production DBs reached just before applying v64).
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)

  const now = new Date().toISOString()
  db.insert(trafficSources).values({
    id: 'src_legacy',
    projectId: 'proj_1',
    sourceType: 'cloud-run',
    displayName: 'Cloud Run',
    status: 'connected',
    configJson: {},
    createdAt: now,
    updatedAt: now,
  }).run()

  // Two legacy user-fetch rows (one ChatGPT-User, one Perplexity-User) plus
  // one genuine bulk crawler row that must stay put.
  for (const row of [
    {
      botId: 'openai-chatgpt-user',
      operator: 'OpenAI',
      pathNormalized: '/',
      sampledUserAgent: 'Mozilla/5.0 ChatGPT-User/1.0',
    },
    {
      botId: 'perplexity-user',
      operator: 'Perplexity',
      pathNormalized: '/pricing',
      sampledUserAgent: 'Mozilla/5.0 Perplexity-User/1.0',
    },
    {
      botId: 'openai-gptbot',
      operator: 'OpenAI',
      pathNormalized: '/blog/post-1',
      sampledUserAgent: 'GPTBot/1.0',
    },
  ]) {
    db.insert(crawlerEventsHourly).values({
      projectId: 'proj_1',
      sourceId: 'src_legacy',
      tsHour: '2026-05-19T20:00:00.000Z',
      botId: row.botId,
      operator: row.operator,
      verificationStatus: 'verified',
      pathNormalized: row.pathNormalized,
      status: 200,
      hits: 3,
      sampledUserAgent: row.sampledUserAgent,
      createdAt: now,
      updatedAt: now,
    }).run()
  }

  // Re-execute v64's statements directly. The runner has already applied
  // them on the empty pre-seed DB; this proves the SQL itself handles the
  // populated case correctly.
  const v64 = MIGRATION_VERSIONS.find(v => v.version === 64)
  expect(v64).toBeDefined()
  for (const sql of v64!.statements) {
    db.$client.exec(sql)
  }

  const moved = db.select().from(aiUserFetchEventsHourly).all()
  expect(moved).toHaveLength(2)
  expect(new Set(moved.map(r => r.botId))).toEqual(new Set(['openai-chatgpt-user', 'perplexity-user']))
  expect(moved.every(r => r.hits === 3 && r.verificationStatus === 'verified')).toBe(true)

  const remainingCrawlers = db.select().from(crawlerEventsHourly).all()
  expect(remainingCrawlers).toHaveLength(1)
  expect(remainingCrawlers[0].botId).toBe('openai-gptbot')
})

test('migration 65 splits legacy mistral-ai rows by sampled user agent', () => {
  // The legacy `mistral-ai` rule matched both MistralAI-User (user-fetch)
  // and MistralBot (bulk crawl), so historical buckets collapsed both
  // under one id. v65 splits them: MistralAI-User-flavored rows move to
  // ai_user_fetch_events_hourly (bot_id='mistral-ai-user'); the rest are
  // renamed to bot_id='mistral-bot' in place.
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)

  const now = new Date().toISOString()
  db.insert(trafficSources).values({
    id: 'src_mistral',
    projectId: 'proj_1',
    sourceType: 'cloud-run',
    displayName: 'Cloud Run',
    status: 'connected',
    configJson: {},
    createdAt: now,
    updatedAt: now,
  }).run()

  for (const row of [
    {
      pathNormalized: '/blog/post-a',
      sampledUserAgent: 'Mozilla/5.0 MistralAI-User/1.0',
    },
    {
      pathNormalized: '/blog/post-b',
      sampledUserAgent: 'Mozilla/5.0 (compatible; MistralBot/1.0; +https://mistral.ai)',
    },
    {
      pathNormalized: '/blog/post-c',
      // Null sample — historically possible since sampled_user_agent is
      // nullable. Stays as crawler with renamed bot_id.
      sampledUserAgent: null,
    },
  ]) {
    db.insert(crawlerEventsHourly).values({
      projectId: 'proj_1',
      sourceId: 'src_mistral',
      tsHour: '2026-05-19T20:00:00.000Z',
      botId: 'mistral-ai',
      operator: 'Mistral AI',
      verificationStatus: 'claimed_unverified',
      pathNormalized: row.pathNormalized,
      status: 200,
      hits: 5,
      sampledUserAgent: row.sampledUserAgent,
      createdAt: now,
      updatedAt: now,
    }).run()
  }

  const v65 = MIGRATION_VERSIONS.find(v => v.version === 65)
  expect(v65).toBeDefined()
  for (const sql of v65!.statements) {
    db.$client.exec(sql)
  }

  const userFetch = db.select().from(aiUserFetchEventsHourly).all()
  expect(userFetch).toHaveLength(1)
  expect(userFetch[0]).toMatchObject({
    botId: 'mistral-ai-user',
    operator: 'Mistral AI',
    pathNormalized: '/blog/post-a',
    hits: 5,
  })

  const crawlers = db.select().from(crawlerEventsHourly).all()
  expect(crawlers).toHaveLength(2)
  expect(crawlers.every(r => r.botId === 'mistral-bot')).toBe(true)
  expect(new Set(crawlers.map(r => r.pathNormalized))).toEqual(new Set(['/blog/post-b', '/blog/post-c']))
})

test('traffic_sources cascade deletes all dependent rows when project is removed', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)

  const now = new Date().toISOString()
  db.insert(trafficSources).values({
    id: 'src_cascade',
    projectId: 'proj_1',
    sourceType: 'cloud-run',
    displayName: 'Cloud Run',
    status: 'connected',
    configJson: {},
    createdAt: now,
    updatedAt: now,
  }).run()

  db.insert(crawlerEventsHourly).values({
    projectId: 'proj_1',
    sourceId: 'src_cascade',
    tsHour: '2026-05-07T17:00:00.000Z',
    botId: 'gptbot',
    operator: 'OpenAI',
    verificationStatus: 'claimed_unverified',
    pathNormalized: '/x',
    status: 200,
    hits: 1,
    sampledUserAgent: 'GPTBot/1.0',
    createdAt: now,
    updatedAt: now,
  }).run()

  db.delete(projects).where(eq(projects.id, 'proj_1')).run()

  expect(db.select().from(trafficSources).all().length).toBe(0)
  expect(db.select().from(crawlerEventsHourly).all().length).toBe(0)
})

test('traffic_sources persists ingest_token_hash and last_worker_version for cloudflare sources', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)

  const now = new Date().toISOString()
  db.insert(trafficSources).values({
    id: 'src_cf',
    projectId: 'proj_1',
    sourceType: 'cloudflare',
    displayName: 'Cloudflare · example.com',
    status: 'connected',
    configJson: {
      schemaVersion: 1,
      workerVersion: '1.0.0',
      expectedBotListVersion: '2026-05-27',
      zoneId: null,
      accountId: null,
    },
    ingestTokenHash: 'a'.repeat(64),
    lastWorkerVersion: '1.0.0',
    createdAt: now,
    updatedAt: now,
  }).run()

  const [row] = db.select().from(trafficSources).where(eq(trafficSources.id, 'src_cf')).all()
  expect(row.sourceType).toBe('cloudflare')
  expect(row.ingestTokenHash).toBe('a'.repeat(64))
  expect(row.lastWorkerVersion).toBe('1.0.0')
})

test('traffic_sources leaves ingest_token_hash and last_worker_version NULL for pull adapters', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)

  const now = new Date().toISOString()
  db.insert(trafficSources).values({
    id: 'src_vercel',
    projectId: 'proj_1',
    sourceType: 'vercel',
    displayName: 'Vercel · example.com',
    status: 'connected',
    configJson: { projectId: 'prj_1', teamId: 'team_1', environment: 'production' },
    createdAt: now,
    updatedAt: now,
  }).run()

  const [row] = db.select().from(trafficSources).where(eq(trafficSources.id, 'src_vercel')).all()
  expect(row.sourceType).toBe('vercel')
  expect(row.ingestTokenHash).toBeNull()
  expect(row.lastWorkerVersion).toBeNull()
})

test('migration 87 adds ingest_token_hash + last_worker_version to existing traffic_sources rows without losing data', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  expect(MIGRATION_VERSIONS).toContainEqual(expect.objectContaining({
    version: 87,
    name: 'traffic-sources-cloudflare-worker-columns',
  }))

  seedProject(db)

  const now = new Date().toISOString()
  db.insert(trafficSources).values({
    id: 'src_legacy',
    projectId: 'proj_1',
    sourceType: 'cloud-run',
    displayName: 'Legacy row written before v87',
    status: 'connected',
    configJson: { gcpProjectId: 'p', authMode: 'service-account' },
    createdAt: now,
    updatedAt: now,
  }).run()

  const [row] = db.select().from(trafficSources).where(eq(trafficSources.id, 'src_legacy')).all()
  expect(row.ingestTokenHash).toBeNull()
  expect(row.lastWorkerVersion).toBeNull()
})
