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
  apiKeys,
  adsConnections,
  adsCampaigns,
  adsAdGroups,
  adsAds,
  adsInsightsDaily,
  adsOperations,
  adsActivationGrants,
  adsOperationSteps,
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
  db.run(sql`
    INSERT INTO projects
      (id, name, display_name, canonical_domain, country, language, created_at, updated_at)
    VALUES
      (${id}, ${name}, 'Test Project', 'example.com', 'US', 'en', ${now}, ${now})
  `)
}

const NOW = '2026-06-10T00:00:00.000Z'

const ACTIVATION_MANIFEST = {
  campaign: {
    id: 'cmpn_bbb',
    expectedUpdatedAt: 1780868842,
    adGroups: [{
      id: 'adgrp_ddd',
      expectedUpdatedAt: 1780864410,
      ads: [{ id: 'ad_eee', expectedUpdatedAt: 1781139491 }],
    }],
  },
}

function seedActivationKeys(db: ReturnType<typeof createTempDb>['db']) {
  db.insert(apiKeys).values([
    {
      id: 'key_approver',
      name: 'Human approver',
      keyHash: 'approver-hash',
      keyPrefix: 'cnry_approver',
      scopes: ['ads.approve'],
      createdAt: NOW,
    },
    {
      id: 'key_executor',
      name: 'Activation executor',
      keyHash: 'executor-hash',
      keyPrefix: 'cnry_executor',
      scopes: ['ads.activate'],
      createdAt: NOW,
    },
  ]).run()
}

function seedActivationOperation(
  db: ReturnType<typeof createTempDb>['db'],
  id = 'op_activate_1',
  operationKey = 'weekend:activate:1',
) {
  db.insert(adsOperations).values({
    id,
    projectId: 'proj_1',
    adAccountId: 'adacct_aaa',
    operationKey,
    requestHash: 'b'.repeat(64),
    kind: 'campaign_tree_activate',
    state: 'pending',
    entityType: 'campaign',
    entityId: 'cmpn_bbb',
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
}

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

test('activation grants and ordered operation steps round-trip with native JSON', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  seedProject(db)
  seedActivationKeys(db)
  seedActivationOperation(db)

  db.insert(adsActivationGrants).values({
    id: 'grant_1',
    projectId: 'proj_1',
    adAccountId: 'adacct_1',
    manifestHash: 'a'.repeat(64),
    manifest: ACTIVATION_MANIFEST,
    executorApiKeyId: 'key_executor',
    approverApiKeyId: 'key_approver',
    state: 'approved',
    expiresAt: '2026-06-10T00:15:00.000Z',
    approvedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }).run()

  const approved = db.select().from(adsActivationGrants).where(eq(adsActivationGrants.id, 'grant_1')).get()
  expect(approved?.manifest).toEqual(ACTIVATION_MANIFEST)
  expect(approved).toMatchObject({
    adAccountId: 'adacct_1',
    manifestHash: 'a'.repeat(64),
    executorApiKeyId: 'key_executor',
    approverApiKeyId: 'key_approver',
    state: 'approved',
    operationId: null,
  })

  db.update(adsActivationGrants).set({
    state: 'executing',
    operationId: 'op_activate_1',
    executionStartedAt: NOW,
    updatedAt: NOW,
  }).where(eq(adsActivationGrants.id, 'grant_1')).run()
  db.insert(adsOperationSteps).values([
    {
      id: 'step_campaign',
      operationId: 'op_activate_1',
      ordinal: 2,
      entityType: 'campaign',
      entityId: 'cmpn_bbb',
      expectedUpdatedAt: 1780868842,
      state: 'pending',
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: 'step_group',
      operationId: 'op_activate_1',
      ordinal: 1,
      entityType: 'ad_group',
      entityId: 'adgrp_ddd',
      expectedUpdatedAt: 1780864410,
      state: 'pending',
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: 'step_ad',
      operationId: 'op_activate_1',
      ordinal: 0,
      entityType: 'ad',
      entityId: 'ad_eee',
      expectedUpdatedAt: 1781139491,
      state: 'active',
      providerUpdatedAt: 1781139500,
      startedAt: NOW,
      finishedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]).run()

  const executing = db.select().from(adsActivationGrants).where(eq(adsActivationGrants.id, 'grant_1')).get()
  expect(executing).toMatchObject({
    state: 'executing',
    operationId: 'op_activate_1',
    executionStartedAt: NOW,
  })
  const steps = db.select().from(adsOperationSteps).orderBy(adsOperationSteps.ordinal).all()
  expect(steps.map((step) => [step.ordinal, step.entityType, step.state])).toEqual([
    [0, 'ad', 'active'],
    [1, 'ad_group', 'pending'],
    [2, 'campaign', 'pending'],
  ])
  expect(steps[0]).toMatchObject({
    expectedUpdatedAt: 1781139491,
    providerUpdatedAt: 1781139500,
  })
})

test('activation grant and step identity and closed-state constraints fail loud', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  seedProject(db)
  seedActivationKeys(db)
  seedActivationOperation(db)

  const approvedGrant = {
    projectId: 'proj_1',
    adAccountId: 'adacct_1',
    manifestHash: 'a'.repeat(64),
    manifest: ACTIVATION_MANIFEST,
    executorApiKeyId: 'key_executor',
    approverApiKeyId: 'key_approver',
    state: 'approved',
    expiresAt: '2026-06-10T00:15:00.000Z',
    approvedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }

  db.insert(adsActivationGrants).values({ id: 'grant_1', ...approvedGrant }).run()
  expect(() => db.insert(adsActivationGrants).values({
    id: 'grant_same_key',
    ...approvedGrant,
    executorApiKeyId: 'key_approver',
  }).run()).toThrow(/CHECK/i)
  expect(() => db.insert(adsActivationGrants).values({
    id: 'grant_invalid_state',
    ...approvedGrant,
    state: 'maybe',
  }).run()).toThrow(/CHECK/i)
  expect(() => db.insert(adsActivationGrants).values({
    id: 'grant_invalid_hash',
    ...approvedGrant,
    manifestHash: 'not-a-sha256',
  }).run()).toThrow(/CHECK/i)
  expect(() => db.insert(adsActivationGrants).values({
    id: 'grant_invalid_approved_shape',
    ...approvedGrant,
    operationId: 'op_activate_1',
  }).run()).toThrow(/CHECK/i)

  db.update(adsActivationGrants).set({
    state: 'executing',
    operationId: 'op_activate_1',
    executionStartedAt: NOW,
  }).where(eq(adsActivationGrants.id, 'grant_1')).run()
  expect(() => db.insert(adsActivationGrants).values({
    id: 'grant_duplicate_operation',
    ...approvedGrant,
    state: 'executing',
    operationId: 'op_activate_1',
    executionStartedAt: NOW,
  }).run()).toThrow(/UNIQUE/i)

  const pendingStep = {
    operationId: 'op_activate_1',
    ordinal: 0,
    entityType: 'ad',
    entityId: 'ad_eee',
    expectedUpdatedAt: 1781139491,
    state: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
  }
  db.insert(adsOperationSteps).values({ id: 'step_1', ...pendingStep }).run()
  expect(() => db.insert(adsOperationSteps).values({
    id: 'step_duplicate_ordinal',
    ...pendingStep,
    entityId: 'ad_other',
  }).run()).toThrow(/UNIQUE/i)
  expect(() => db.insert(adsOperationSteps).values({
    id: 'step_duplicate_entity',
    ...pendingStep,
    ordinal: 1,
  }).run()).toThrow(/UNIQUE/i)
  expect(() => db.insert(adsOperationSteps).values({
    id: 'step_invalid_entity_type',
    ...pendingStep,
    ordinal: 1,
    entityType: 'file',
    entityId: 'file_1',
  }).run()).toThrow(/CHECK/i)
  expect(() => db.insert(adsOperationSteps).values({
    id: 'step_invalid_state',
    ...pendingStep,
    ordinal: 1,
    entityId: 'ad_other',
    state: 'maybe',
  }).run()).toThrow(/CHECK/i)
  expect(() => db.insert(adsOperationSteps).values({
    id: 'step_invalid_timestamp',
    ...pendingStep,
    ordinal: 1,
    entityId: 'ad_other',
    expectedUpdatedAt: -1,
  }).run()).toThrow(/CHECK/i)
  expect(() => db.insert(adsOperationSteps).values({
    id: 'step_invalid_pending_shape',
    ...pendingStep,
    ordinal: 1,
    entityId: 'ad_other',
    providerUpdatedAt: 1781139500,
  }).run()).toThrow(/CHECK/i)
  expect(() => db.insert(adsOperationSteps).values({
    id: 'step_invalid_active_shape',
    ...pendingStep,
    ordinal: 1,
    entityId: 'ad_other',
    state: 'active',
    startedAt: NOW,
    finishedAt: NOW,
  }).run()).toThrow(/CHECK/i)
})

test('migration 102 preserves legacy receipts and adds approval activation storage', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-ads-v102-test-'))
  onTestFinished(() => cleanup(tmpDir))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db, MIGRATION_VERSIONS.filter((migration) => migration.version <= 101))
  seedProject(db)
  seedActivationKeys(db)
  seedActivationOperation(db, 'op_legacy_activation', 'weekend:activate:legacy')

  migrate(db)
  migrate(db)

  db.insert(adsActivationGrants).values({
    id: 'grant_legacy_activation',
    projectId: 'proj_1',
    adAccountId: 'adacct_1',
    manifestHash: 'a'.repeat(64),
    manifest: ACTIVATION_MANIFEST,
    executorApiKeyId: 'key_executor',
    approverApiKeyId: 'key_approver',
    state: 'executing',
    expiresAt: '2026-06-10T00:15:00.000Z',
    operationId: 'op_legacy_activation',
    approvedAt: NOW,
    executionStartedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  db.insert(adsOperationSteps).values({
    id: 'step_legacy_activation',
    operationId: 'op_legacy_activation',
    ordinal: 0,
    entityType: 'ad',
    entityId: 'ad_eee',
    expectedUpdatedAt: 1781139491,
    state: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
  }).run()

  expect(db.select().from(adsOperations).where(eq(adsOperations.id, 'op_legacy_activation')).get()).toMatchObject({
    kind: 'campaign_tree_activate',
    operationKey: 'weekend:activate:legacy',
  })
  expect(db.select().from(adsActivationGrants).all()).toHaveLength(1)
  expect(db.select().from(adsOperationSteps).all()).toHaveLength(1)
})

test('a bound activation receipt cannot be deleted outside the project cascade', () => {
  const { db, tmpDir } = createTempDb()
  onTestFinished(() => cleanup(tmpDir))
  seedProject(db)
  seedActivationKeys(db)
  seedActivationOperation(db)
  db.insert(adsActivationGrants).values({
    id: 'grant_1',
    projectId: 'proj_1',
    adAccountId: 'adacct_1',
    manifestHash: 'a'.repeat(64),
    manifest: ACTIVATION_MANIFEST,
    executorApiKeyId: 'key_executor',
    approverApiKeyId: 'key_approver',
    state: 'unknown',
    expiresAt: '2026-06-10T00:15:00.000Z',
    operationId: 'op_activate_1',
    approvedAt: NOW,
    executionStartedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  db.insert(adsOperationSteps).values({
    id: 'step_1',
    operationId: 'op_activate_1',
    ordinal: 0,
    entityType: 'ad',
    entityId: 'ad_eee',
    expectedUpdatedAt: 1781139491,
    state: 'unknown',
    errorCode: 'ambiguous_outcome',
    errorMessage: 'The provider response was interrupted',
    remediation: 'Reconcile provider state before retrying',
    startedAt: NOW,
    finishedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }).run()

  expect(() => db.delete(adsOperations).where(eq(adsOperations.id, 'op_activate_1')).run())
    .toThrow(/FOREIGN KEY/i)
  expect(db.select().from(adsOperationSteps).all()).toHaveLength(1)
  expect(db.select().from(adsActivationGrants).where(eq(adsActivationGrants.id, 'grant_1')).get()?.operationId)
    .toBe('op_activate_1')

  db.delete(projects).where(eq(projects.id, 'proj_1')).run()
  expect(db.select().from(adsActivationGrants).all()).toHaveLength(0)
  expect(db.select().from(adsOperationSteps).all()).toHaveLength(0)
  expect(db.select().from(adsOperations).all()).toHaveLength(0)
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
