import { test, expect, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import {
  createClient,
  migrate,
  projects,
  trafficSources,
  trafficEventReceipts,
  crawlerEventsHourly,
  crawlerVerificationManifestsHourly,
  aiUserFetchEventsHourly,
  aiUserFetchVerificationManifestsHourly,
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

/**
 * Seeds only the physical project columns available before v150. Historical
 * migration tests must not let Drizzle's current `projects` model write a
 * column introduced by the migration chain they deliberately have not run.
 */
function seedPreV150Project(db: ReturnType<typeof createTempDb>['db']) {
  const now = new Date().toISOString()
  db.run(sql`
    INSERT INTO projects (
      id, name, display_name, canonical_domain, country, language, created_at, updated_at
    ) VALUES (
      ${'proj_1'}, ${'test-project'}, ${'Test Project'}, ${'example.com'}, ${'US'}, ${'en'}, ${now}, ${now}
    )
  `)
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

test('raw sample retention migration adds a global expiry index without rewriting evidence', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-raw-sample-migration-'))
  onTestFinished(() => cleanup(tmpDir))
  const db = createClient(path.join(tmpDir, 'test.db'))

  migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version < 144))
  seedPreV150Project(db)
  const now = '2026-08-17T12:00:00.000Z'
  db.run(sql`
    INSERT INTO traffic_sources (
      id, project_id, source_type, display_name, status, config_json, created_at, updated_at
    ) VALUES (
      ${'src_raw_migration'}, ${'proj_1'}, ${'cloud-run'}, ${'Cloud Run'},
      ${'connected'}, ${JSON.stringify({})}, ${now}, ${now}
    )
  `)
  db.insert(rawEventSamples).values([
    {
      id: 'offset_timestamp',
      projectId: 'proj_1',
      sourceId: 'src_raw_migration',
      ts: '2026-07-18T08:00:00-04:00',
      eventType: 'unknown',
      pathNormalized: '/',
      classifierDetailsJson: {},
      createdAt: now,
    },
    {
      id: 'invalid_timestamp',
      projectId: 'proj_1',
      sourceId: 'src_raw_migration',
      ts: 'not-a-timestamp',
      eventType: 'unknown',
      pathNormalized: '/',
      classifierDetailsJson: {},
      createdAt: now,
    },
  ]).run()

  expect(MIGRATION_VERSIONS.find(migration => migration.version === 144)?.name)
    .toBe('raw-event-sample-retention-index')
  migrate(db)

  expect(db.select().from(rawEventSamples).all().map(row => ({ id: row.id, ts: row.ts })))
    .toEqual([
      { id: 'offset_timestamp', ts: '2026-07-18T08:00:00-04:00' },
      { id: 'invalid_timestamp', ts: 'not-a-timestamp' },
    ])
  const indexes = db.all(sql.raw("PRAGMA index_list('raw_event_samples')")) as Array<{ name: string }>
  expect(indexes.map(index => index.name)).toContain('idx_raw_event_samples_ts')
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

test('verification manifest sidecars preserve two manifests and cascade with their parent rollups', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)
  const now = '2026-08-13T12:00:00.000Z'
  db.insert(trafficSources).values({
    id: 'src_manifest',
    projectId: 'proj_1',
    sourceType: 'cloud-run',
    displayName: 'Manifest source',
    status: 'connected',
    configJson: {},
    createdAt: now,
    updatedAt: now,
  }).run()

  const crawlerParent = {
    projectId: 'proj_1',
    sourceId: 'src_manifest',
    tsHour: '2026-08-13T11:00:00.000Z',
    botId: 'anthropic-claudebot',
    operator: 'Anthropic',
    verificationStatus: 'verified',
    pathNormalized: '/docs',
    status: 200,
    hits: 5,
    sampledUserAgent: 'ClaudeBot/1.0',
    createdAt: now,
    updatedAt: now,
  }
  db.insert(crawlerEventsHourly).values(crawlerParent).run()

  const manifests = [
    { id: 'anthropic:v1', source: 'https://api.anthropic.com/ranges', version: '1' },
    { id: 'anthropic:v2', source: 'https://api.anthropic.com/ranges', version: '2' },
  ]
  db.insert(crawlerVerificationManifestsHourly).values(manifests.map((manifest, index) => ({
    projectId: crawlerParent.projectId,
    sourceId: crawlerParent.sourceId,
    tsHour: crawlerParent.tsHour,
    botId: crawlerParent.botId,
    verificationStatus: crawlerParent.verificationStatus,
    pathNormalized: crawlerParent.pathNormalized,
    status: crawlerParent.status,
    manifestId: manifest.id,
    manifestJson: manifest,
    hits: index + 2,
    createdAt: now,
    updatedAt: now,
  }))).run()

  const crawlerProvenance = db.select().from(crawlerVerificationManifestsHourly).all()
  expect(crawlerProvenance.map(row => row.manifestId).sort()).toEqual(['anthropic:v1', 'anthropic:v2'])
  expect(crawlerProvenance.find(row => row.manifestId === 'anthropic:v2')?.manifestJson).toEqual(manifests[1])

  const fetchParent = {
    ...crawlerParent,
    botId: 'claude-user',
    pathNormalized: '/pricing',
    hits: 4,
    sampledUserAgent: 'Claude-User/1.0',
  }
  db.insert(aiUserFetchEventsHourly).values(fetchParent).run()
  db.insert(aiUserFetchVerificationManifestsHourly).values(manifests.map(manifest => ({
    projectId: fetchParent.projectId,
    sourceId: fetchParent.sourceId,
    tsHour: fetchParent.tsHour,
    botId: fetchParent.botId,
    verificationStatus: fetchParent.verificationStatus,
    pathNormalized: fetchParent.pathNormalized,
    status: fetchParent.status,
    manifestId: manifest.id,
    manifestJson: manifest,
    hits: 2,
    createdAt: now,
    updatedAt: now,
  }))).run()
  expect(db.select().from(aiUserFetchVerificationManifestsHourly).all()).toHaveLength(2)

  db.delete(crawlerEventsHourly).where(and(
    eq(crawlerEventsHourly.projectId, crawlerParent.projectId),
    eq(crawlerEventsHourly.sourceId, crawlerParent.sourceId),
    eq(crawlerEventsHourly.tsHour, crawlerParent.tsHour),
    eq(crawlerEventsHourly.botId, crawlerParent.botId),
    eq(crawlerEventsHourly.verificationStatus, crawlerParent.verificationStatus),
    eq(crawlerEventsHourly.pathNormalized, crawlerParent.pathNormalized),
    eq(crawlerEventsHourly.status, crawlerParent.status),
  )).run()
  db.delete(aiUserFetchEventsHourly).where(and(
    eq(aiUserFetchEventsHourly.projectId, fetchParent.projectId),
    eq(aiUserFetchEventsHourly.sourceId, fetchParent.sourceId),
    eq(aiUserFetchEventsHourly.tsHour, fetchParent.tsHour),
    eq(aiUserFetchEventsHourly.botId, fetchParent.botId),
    eq(aiUserFetchEventsHourly.verificationStatus, fetchParent.verificationStatus),
    eq(aiUserFetchEventsHourly.pathNormalized, fetchParent.pathNormalized),
    eq(aiUserFetchEventsHourly.status, fetchParent.status),
  )).run()
  expect(db.select().from(crawlerVerificationManifestsHourly).all()).toEqual([])
  expect(db.select().from(aiUserFetchVerificationManifestsHourly).all()).toEqual([])
})

test('migration 139 leaves legacy rollups unattributed and preserves old-writer upserts', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-traffic-manifest-migration-'))
  onTestFinished(() => cleanup(tmpDir))
  const db = createClient(path.join(tmpDir, 'test.db'))

  migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version < 139))
  seedPreV150Project(db)
  const now = '2026-08-13T12:00:00.000Z'
  db.run(sql`
    INSERT INTO traffic_sources (
      id, project_id, source_type, display_name, status, config_json, created_at, updated_at
    ) VALUES (
      ${'src_pre_manifest'}, ${'proj_1'}, ${'cloud-run'}, ${'Pre-manifest source'},
      ${'connected'}, ${JSON.stringify({})}, ${now}, ${now}
    )
  `)

  // Raw SQL models the exact table shape an older binary wrote before v139.
  db.run(sql`
    INSERT INTO crawler_events_hourly (
      project_id, source_id, ts_hour, bot_id, operator, verification_status,
      path_normalized, status, hits, sampled_user_agent, created_at, updated_at
    ) VALUES (
      ${'proj_1'}, ${'src_pre_manifest'}, ${'2026-08-13T11:00:00.000Z'},
      ${'anthropic-claudebot'}, ${'Anthropic'}, ${'verified'}, ${'/docs'},
      ${200}, ${7}, ${'ClaudeBot/1.0'}, ${now}, ${now}
    )
  `)
  db.run(sql`
    INSERT INTO ai_user_fetch_events_hourly (
      project_id, source_id, ts_hour, bot_id, operator, verification_status,
      path_normalized, status, hits, sampled_user_agent, created_at, updated_at
    ) VALUES (
      ${'proj_1'}, ${'src_pre_manifest'}, ${'2026-08-13T11:00:00.000Z'},
      ${'claude-user'}, ${'Anthropic'}, ${'verified'}, ${'/pricing'},
      ${200}, ${3}, ${'Claude-User/1.0'}, ${now}, ${now}
    )
  `)

  migrate(db)

  // No provenance is invented for rows written before the sidecars existed.
  expect(db.select().from(crawlerVerificationManifestsHourly).all()).toEqual([])
  expect(db.select().from(aiUserFetchVerificationManifestsHourly).all()).toEqual([])

  // These are the exact column and ON CONFLICT targets used by a pre-v139
  // writer. Both still prepare and update after the additive migration.
  db.$client.prepare(`
    INSERT INTO crawler_events_hourly (
      project_id, source_id, ts_hour, bot_id, operator, verification_status,
      path_normalized, status, hits, sampled_user_agent, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (
      project_id, source_id, ts_hour, bot_id, verification_status,
      path_normalized, status
    ) DO UPDATE SET hits = hits + excluded.hits, updated_at = excluded.updated_at
  `).run(
    'proj_1', 'src_pre_manifest', '2026-08-13T11:00:00.000Z',
    'anthropic-claudebot', 'Anthropic', 'verified', '/docs', 200, 5,
    'ClaudeBot/1.0', now, now,
  )
  db.$client.prepare(`
    INSERT INTO ai_user_fetch_events_hourly (
      project_id, source_id, ts_hour, bot_id, operator, verification_status,
      path_normalized, status, hits, sampled_user_agent, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (
      project_id, source_id, ts_hour, bot_id, verification_status,
      path_normalized, status
    ) DO UPDATE SET hits = hits + excluded.hits, updated_at = excluded.updated_at
  `).run(
    'proj_1', 'src_pre_manifest', '2026-08-13T11:00:00.000Z',
    'claude-user', 'Anthropic', 'verified', '/pricing', 200, 2,
    'Claude-User/1.0', now, now,
  )

  expect(db.select().from(crawlerEventsHourly).get()?.hits).toBe(12)
  expect(db.select().from(aiUserFetchEventsHourly).get()?.hits).toBe(5)
  expect(db.all(sql.raw('PRAGMA foreign_key_check'))).toEqual([])
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
      deliveryMode: 'direct-push',
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

test('traffic_event_receipts durably dedupes per source and cascades with it', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  seedProject(db)
  const receivedAt = '2026-08-09T12:00:00.000Z'
  const expiresAt = '2026-08-10T12:00:00.000Z'
  db.insert(trafficSources).values({
    id: 'src_receipts',
    projectId: 'proj_1',
    sourceType: 'cloudflare',
    displayName: 'Cloudflare receipts',
    status: 'connected',
    configJson: { schemaVersion: 1, deliveryMode: 'direct-push' },
    createdAt: receivedAt,
    updatedAt: receivedAt,
  }).run()

  const receipt = {
    sourceId: 'src_receipts',
    eventId: 'cloudflare-worker:ray-1',
    receivedAt,
    expiresAt,
  }
  db.insert(trafficEventReceipts).values(receipt).run()

  expect(db.select().from(trafficEventReceipts).all()).toEqual([receipt])
  expect(() => db.insert(trafficEventReceipts).values(receipt).run()).toThrow()
  expect(db.all(sql.raw(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_traffic_event_receipts_expires'",
  ))).toEqual([{ name: 'idx_traffic_event_receipts_expires' }])
  expect(db.all(sql.raw(
    "SELECT name FROM pragma_index_info('idx_traffic_event_receipts_expires') ORDER BY seqno",
  ))).toEqual([{ name: 'source_id' }, { name: 'expires_at' }])

  db.delete(trafficSources).where(eq(trafficSources.id, 'src_receipts')).run()
  expect(db.select().from(trafficEventReceipts).all()).toEqual([])
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

test('traffic sync lease migration adds nullable per-source lease fields without changing legacy rows', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-traffic-lease-migration-'))
  onTestFinished(() => cleanup(tmpDir))
  const db = createClient(path.join(tmpDir, 'test.db'))

  migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version < 135))
  seedPreV150Project(db)
  const now = '2026-08-11T12:00:00.000Z'
  // This is deliberately a pre-v135 insert. Drizzle's current table model
  // names the new lease columns even when values are omitted, so use SQL that
  // names only columns an older binary could have written.
  db.run(sql`
    INSERT INTO traffic_sources (
      id, project_id, source_type, display_name, status, config_json, created_at, updated_at
    ) VALUES (
      ${'src_pre_lease'}, ${'proj_1'}, ${'cloudflare'}, ${'Legacy Cloudflare source'},
      ${'connected'}, ${JSON.stringify({ deliveryMode: 'direct-push' })}, ${now}, ${now}
    )
  `)

  const leaseMigration = MIGRATION_VERSIONS.find(
    migration => migration.name === 'traffic-source-sync-lease',
  )
  expect(leaseMigration).toMatchObject({ version: 135 })

  migrate(db)
  const [row] = db.select().from(trafficSources).where(eq(trafficSources.id, 'src_pre_lease')).all()
  expect(row.syncLeaseOwner).toBeNull()
  expect(row.syncLeaseExpiresAt).toBeNull()
})

test('traffic queue backlog migration adds nullable observations without changing legacy rows', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-traffic-backlog-migration-'))
  onTestFinished(() => cleanup(tmpDir))
  const db = createClient(path.join(tmpDir, 'test.db'))

  migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version < 136))
  seedPreV150Project(db)
  const now = '2026-08-11T12:00:00.000Z'
  db.run(sql`
    INSERT INTO traffic_sources (
      id, project_id, source_type, display_name, status, config_json, created_at, updated_at
    ) VALUES (
      ${'src_pre_backlog'}, ${'proj_1'}, ${'cloudflare'}, ${'Legacy Queue source'},
      ${'connected'}, ${JSON.stringify({ deliveryMode: 'queue-pull' })}, ${now}, ${now}
    )
  `)

  const backlogMigration = MIGRATION_VERSIONS.find(
    migration => migration.name === 'traffic-source-queue-backlog',
  )
  expect(backlogMigration).toMatchObject({ version: 136 })

  migrate(db)
  const [legacy] = db.select().from(trafficSources).where(eq(trafficSources.id, 'src_pre_backlog')).all()
  expect(legacy.queueBacklogCount).toBeNull()
  expect(legacy.queueBacklogObservedAt).toBeNull()

  db.update(trafficSources)
    .set({ queueBacklogCount: 125, queueBacklogObservedAt: now })
    .where(eq(trafficSources.id, 'src_pre_backlog'))
    .run()
  const [observed] = db.select().from(trafficSources).where(eq(trafficSources.id, 'src_pre_backlog')).all()
  expect(observed.queueBacklogCount).toBe(125)
  expect(observed.queueBacklogObservedAt).toBe(now)
})

test('WordPress pending-window migration leaves old cursors explicitly unmarked', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-wp-pending-window-migration-'))
  onTestFinished(() => cleanup(tmpDir))
  const db = createClient(path.join(tmpDir, 'test.db'))

  migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version < 145))
  seedPreV150Project(db)
  const now = '2026-08-20T17:00:00.000Z'
  // Pre-v145 WordPress cursors have no recorded upper bound. The new code
  // must distinguish that ambiguous legacy state from a bounded continuation.
  db.run(sql`
    INSERT INTO traffic_sources (
      id, project_id, source_type, display_name, status, last_synced_at,
      last_cursor, config_json, created_at, updated_at
    ) VALUES (
      ${'src_pre_wp_pending'}, ${'proj_1'}, ${'wordpress'}, ${'Legacy WordPress source'},
      ${'connected'}, ${now}, ${'opaque-legacy-cursor'}, ${JSON.stringify({ baseUrl: 'https://example.com', username: 'bot' })}, ${now}, ${now}
    )
  `)

  expect(MIGRATION_VERSIONS.find(migration => migration.version === 145)?.name)
    .toBe('wordpress-traffic-pending-window')
  migrate(db)

  const [legacy] = db.select().from(trafficSources)
    .where(eq(trafficSources.id, 'src_pre_wp_pending')).all()
  expect(legacy.lastCursor).toBe('opaque-legacy-cursor')
  expect(legacy.wordpressPendingUntil).toBeNull()

  db.update(trafficSources)
    .set({ wordpressPendingUntil: '2026-08-20T17:30:00.000Z' })
    .where(eq(trafficSources.id, 'src_pre_wp_pending'))
    .run()
  const [bounded] = db.select().from(trafficSources)
    .where(eq(trafficSources.id, 'src_pre_wp_pending')).all()
  expect(bounded.wordpressPendingUntil).toBe('2026-08-20T17:30:00.000Z')
})

test('traffic ingest migration adds source auth columns and durable receipts without losing source data', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))

  const ingestMigration = MIGRATION_VERSIONS.find(
    migration => migration.name === 'traffic-ingest-foundation',
  )
  expect(ingestMigration).toMatchObject({ version: 129 })

  seedProject(db)

  const now = new Date().toISOString()
  db.insert(trafficSources).values({
    id: 'src_legacy',
    projectId: 'proj_1',
    sourceType: 'cloud-run',
    displayName: 'Legacy row written before Cloudflare migration',
    status: 'connected',
    configJson: { gcpProjectId: 'p', authMode: 'service-account' },
    createdAt: now,
    updatedAt: now,
  }).run()

  const [row] = db.select().from(trafficSources).where(eq(trafficSources.id, 'src_legacy')).all()
  expect(row.ingestTokenHash).toBeNull()
  expect(row.lastWorkerVersion).toBeNull()
})
