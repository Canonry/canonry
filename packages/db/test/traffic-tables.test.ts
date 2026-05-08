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
  aiReferralEventsHourly,
  rawEventSamples,
} from '../src/index.js'

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
    configJson: '{}',
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
    configJson: '{}',
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
    configJson: '{}',
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
    configJson: '{}',
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
    configJson: '{}',
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
