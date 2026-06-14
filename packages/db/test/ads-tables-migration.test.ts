import { test, expect, onTestFinished } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, and } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import {
  createClient,
  migrate,
  projects,
  adsConnections,
  adsCampaigns,
  adsAdGroups,
  adsAds,
  adsInsightsDaily,
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

  const group = db.select().from(adsAdGroups).where(eq(adsAdGroups.id, 'adgrp_ddd')).get()
  // native JSON mode: direct property access returns the typed array
  expect(group?.contextHints).toEqual(['how much does a new deck cost\nmeasure my yard to plan materials'])
  expect(group?.maxBidMicros).toBe(2_000_000)

  const ad = db.select().from(adsAds).where(eq(adsAds.id, 'ad_eee')).get()
  expect((ad?.creative as { type?: string } | null)?.type).toBe('chat_card')
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
