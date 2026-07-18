import { test, expect, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, and } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import {
  createClient,
  migrate,
  MIGRATION_VERSIONS,
  projects,
  adsConnections,
  adsCampaigns,
  adsAdGroups,
  adsAds,
  adsInsightsDaily,
  adsOperations,
} from '../src/index.js'

function createTempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-ads-test-'))
  const dbPath = path.join(tmpDir, 'test.db')
  const db = createClient(dbPath)
  migrate(db)
  return { db, tmpDir }
}

function cleanup(tmpDir: string) {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

function seedProject(db: ReturnType<typeof createTempDb>['db'], id = 'proj_1', name = 'test-project') {
  const now = new Date().toISOString()
  db.insert(projects).values({
    id,
    name,
    displayName: 'Test Project',
    canonicalDomain: 'example.com',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
}

const NOW = '2026-06-10T00:00:00.000Z'

function seedAdsRows(db: ReturnType<typeof createTempDb>['db'], projectId = 'proj_1') {
  db.insert(adsConnections).values({
    id: 'conn_1',
    projectId,
    adAccountId: 'adacct_aaa',
    displayName: 'Acme Exteriors, Inc',
    currencyCode: 'USD',
    timezone: 'America/Denver',
    status: 'active',
    reviewStatus: 'in_review',
    integrityReviewStatus: 'approved',
    integrityDecision: 'allowed',
    lastSyncedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  db.insert(adsCampaigns).values({
    id: 'cmpn_bbb',
    projectId,
    name: 'Homeowners Free Estimate',
    status: 'active',
    biddingType: 'clicks',
    dailySpendLimitMicros: 150_000_000,
    conversionEventSettingIds: ['ces_123'],
    targeting: { locations: { include: [{ id: '1000232', type: 'country', country_code: 'US' }] } },
    upstreamCreatedAt: 1780770653,
    upstreamUpdatedAt: 1780868842,
    syncedAt: NOW,
  }).run()
  db.insert(adsAdGroups).values({
    id: 'adgrp_ddd',
    projectId,
    campaignId: 'cmpn_bbb',
    name: 'Deck Project Planning',
    status: 'active',
    billingEventType: 'click',
    maxBidMicros: 2_000_000,
    contextHints: ['how much does a new deck cost\nmeasure my yard to plan materials'],
    upstreamCreatedAt: 1780770657,
    upstreamUpdatedAt: 1780864410,
    syncedAt: NOW,
  }).run()
  db.insert(adsAds).values({
    id: 'ad_eee',
    projectId,
    adGroupId: 'adgrp_ddd',
    name: 'HO Deck - Materials',
    status: 'active',
    creative: { type: 'chat_card', title: 'Free Estimate For Materials' },
    reviewStatus: 'approved',
    upstreamCreatedAt: 1780770662,
    upstreamUpdatedAt: 1781139491,
    syncedAt: NOW,
  }).run()
}

test('migration creates the ads tables and rows round-trip with typed JSON columns', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  seedProject(db)
  seedAdsRows(db)

  const conn = db.select().from(adsConnections).where(eq(adsConnections.projectId, 'proj_1')).get()
  expect(conn?.adAccountId).toBe('adacct_aaa')
  expect(conn?.currencyCode).toBe('USD')
  expect(conn?.reviewStatus).toBe('in_review')
  expect(conn?.integrityReviewStatus).toBe('approved')
  expect(conn?.integrityDecision).toBe('allowed')

  const campaign = db.select().from(adsCampaigns).where(eq(adsCampaigns.id, 'cmpn_bbb')).get()
  expect(campaign?.conversionEventSettingIds).toEqual(['ces_123'])

  const group = db.select().from(adsAdGroups).where(eq(adsAdGroups.id, 'adgrp_ddd')).get()
  // native JSON mode: direct property access returns the typed array
  expect(group?.contextHints).toEqual(['how much does a new deck cost\nmeasure my yard to plan materials'])
  expect(group?.maxBidMicros).toBe(2_000_000)

  const ad = db.select().from(adsAds).where(eq(adsAds.id, 'ad_eee')).get()
  expect((ad?.creative as { type?: string } | null)?.type).toBe('chat_card')
})

test('migration 100 preserves existing ads rows and defaults conversion settings to an empty list', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-ads-v100-test-'))
  onTestFinished(() => cleanup(tmpDir))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db, MIGRATION_VERSIONS.filter((migration) => migration.version <= 99))
  seedProject(db)

  db.run(sql.raw(`INSERT INTO ads_connections
    (id, project_id, ad_account_id, created_at, updated_at)
    VALUES ('conn_legacy', 'proj_1', 'adacct_legacy', '${NOW}', '${NOW}')`))
  db.run(sql.raw(`INSERT INTO ads_campaigns
    (id, project_id, name, status, synced_at)
    VALUES ('cmpn_legacy', 'proj_1', 'Legacy campaign', 'paused', '${NOW}')`))

  migrate(db)

  const connection = db.select().from(adsConnections).where(eq(adsConnections.id, 'conn_legacy')).get()
  expect(connection).toMatchObject({
    reviewStatus: null,
    integrityReviewStatus: null,
    integrityDecision: null,
  })
  const campaign = db.select().from(adsCampaigns).where(eq(adsCampaigns.id, 'cmpn_legacy')).get()
  expect(campaign?.conversionEventSettingIds).toEqual([])
})

test('one connection per project is enforced', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  seedProject(db)
  seedAdsRows(db)

  expect(() =>
    db.insert(adsConnections).values({
      id: 'conn_2',
      projectId: 'proj_1',
      adAccountId: 'adacct_other',
      createdAt: NOW,
      updatedAt: NOW,
    }).run(),
  ).toThrow(/UNIQUE/i)
})

test('ads operation receipts enforce one key and round-trip typed reconciliation metadata', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  seedProject(db)
  db.insert(adsOperations).values({
    id: 'op_1', projectId: 'proj_1', operationKey: 'weekend:campaign:1', requestHash: 'abc',
    kind: 'campaign_create', state: 'unknown', entityType: 'campaign', errorCode: 'socket_closed',
    errorMessage: 'socket closed after request write', reconcileStrategy: 'create_fingerprint',
    reconcileFingerprint: 'a'.repeat(64), reconcileFields: {
      name: 'AEO Audit Leads', status: 'paused', lifetimeSpendLimitMicros: 25_000_000,
      locationIds: ['1000232'],
    }, reconcileAttempts: 1, lastReconciledAt: NOW, leaseOwner: 'sweeper-1',
    leaseExpiresAt: '2026-06-10T00:01:00.000Z', createdAt: NOW, updatedAt: NOW,
  }).run()

  const row = db.select().from(adsOperations).where(eq(adsOperations.operationKey, 'weekend:campaign:1')).get()
  expect(row).toMatchObject({
    state: 'unknown', entityType: 'campaign', entityId: null,
    reconcileStrategy: 'create_fingerprint', reconcileAttempts: 1, leaseOwner: 'sweeper-1',
    reconcileFields: {
      name: 'AEO Audit Leads', status: 'paused', lifetimeSpendLimitMicros: 25_000_000,
      locationIds: ['1000232'],
    },
  })
  expect(() => db.insert(adsOperations).values({
    id: 'op_2', projectId: 'proj_1', operationKey: 'weekend:campaign:1', requestHash: 'def',
    kind: 'campaign_create', state: 'pending', createdAt: NOW, updatedAt: NOW,
  }).run()).toThrow(/UNIQUE/i)
})

test('migration 101 preserves operation receipts and defaults reconciliation state safely', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-ads-v101-test-'))
  onTestFinished(() => cleanup(tmpDir))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db, MIGRATION_VERSIONS.filter((migration) => migration.version <= 100))
  seedProject(db)

  db.run(sql.raw(`INSERT INTO ads_operations
    (id, project_id, operation_key, request_hash, kind, state, entity_type, created_at, updated_at)
    VALUES ('op_legacy', 'proj_1', 'weekend:campaign:legacy', 'abc', 'campaign_create',
      'unknown', 'campaign', '${NOW}', '${NOW}')`))

  migrate(db)

  const row = db.select().from(adsOperations).where(eq(adsOperations.id, 'op_legacy')).get()
  expect(row).toMatchObject({
    state: 'unknown',
    reconcileStrategy: null,
    reconcileParentId: null,
    reconcileFingerprint: null,
    reconcileFields: null,
    reconcileAttempts: 0,
    lastReconciledAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
  })
})

test('insights upsert on (project, level, entity, date) replaces instead of duplicating', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  seedProject(db)
  seedAdsRows(db)

  const key = { projectId: 'proj_1', level: 'campaign', entityId: 'cmpn_bbb', date: '2026-06-10' }
  db.insert(adsInsightsDaily).values({
    id: 'ins_1', ...key, impressions: 1736, clicks: 23, spendMicros: 39_280_000, syncRunId: null,
  }).run()
  // Re-sync of an in-progress day: same key, fresher numbers.
  db.insert(adsInsightsDaily).values({
    id: 'ins_2', ...key, impressions: 1800, clicks: 25, spendMicros: 41_000_000, syncRunId: null,
  }).onConflictDoUpdate({
    target: [adsInsightsDaily.projectId, adsInsightsDaily.level, adsInsightsDaily.entityId, adsInsightsDaily.date],
    set: { impressions: 1800, clicks: 25, spendMicros: 41_000_000 },
  }).run()

  const rows = db.select().from(adsInsightsDaily)
    .where(and(eq(adsInsightsDaily.entityId, 'cmpn_bbb'), eq(adsInsightsDaily.date, '2026-06-10')))
    .all()
  expect(rows.length).toBe(1)
  expect(rows[0]!.impressions).toBe(1800)
  expect(rows[0]!.spendMicros).toBe(41_000_000)
})

test('deleting a project cascades through connection, entities, and insights', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  seedProject(db)
  seedAdsRows(db)
  db.insert(adsInsightsDaily).values({
    id: 'ins_1', projectId: 'proj_1', level: 'ad_group', entityId: 'adgrp_ddd', date: '2026-06-10',
    impressions: 64, clicks: 1, spendMicros: 570_000, syncRunId: null,
  }).run()

  db.run(sql`DELETE FROM projects WHERE id = 'proj_1'`)

  expect(db.select().from(adsConnections).all().length).toBe(0)
  expect(db.select().from(adsCampaigns).all().length).toBe(0)
  expect(db.select().from(adsAdGroups).all().length).toBe(0)
  expect(db.select().from(adsAds).all().length).toBe(0)
  expect(db.select().from(adsInsightsDaily).all().length).toBe(0)
  expect(db.select().from(adsOperations).all().length).toBe(0)
})

test('deleting a campaign cascades to its ad groups and ads', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  seedProject(db)
  seedAdsRows(db)

  db.delete(adsCampaigns).where(eq(adsCampaigns.id, 'cmpn_bbb')).run()

  expect(db.select().from(adsAdGroups).all().length).toBe(0)
  expect(db.select().from(adsAds).all().length).toBe(0)
})
