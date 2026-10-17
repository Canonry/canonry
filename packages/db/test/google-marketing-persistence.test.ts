import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { expect, onTestFinished, test } from 'vitest'
import {
  RunKinds,
  RunStatuses,
  RunTriggers,
  type ConversionTrackingContract,
  type GoogleAdsSnapshotPayload,
  type GtmSnapshotPayload,
} from '@canonry/canonry-contracts'
import {
  MIGRATION_VERSIONS,
  conversionTrackingContracts,
  createClient,
  googleAdsConnections,
  googleAdsRawSnapshots,
  gtmConnections,
  gtmRawSnapshots,
  migrate,
  runs,
} from '../src/index.js'

const NOW = '2026-08-14T12:00:00.000Z'

function createTempDb(prefix: string, through = Number.POSITIVE_INFINITY) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  onTestFinished(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db, MIGRATION_VERSIONS.filter(migration => migration.version <= through))
  return db
}

function seedProject(db: ReturnType<typeof createTempDb>, id: string) {
  db.$client.prepare(`
    INSERT INTO projects
      (id, name, display_name, canonical_domain, country, language, created_at, updated_at)
    VALUES (?, ?, 'Example', 'example.com', 'US', 'en', ?, ?)
  `).run(id, id, NOW, NOW)
}

function seedGoogleMarketingParents(db: ReturnType<typeof createTempDb>, projectId = 'project_1') {
  db.insert(googleAdsConnections).values({
    id: `${projectId}_ads_connection`,
    projectId,
    selectedLoginCustomerId: '100',
    selectedCustomerId: '200',
    selectedCustomerName: 'Example Hotel',
    selectedCustomerCurrencyCode: 'USD',
    selectedCustomerTimeZone: 'America/New_York',
    selectedCustomerStatus: 'enabled',
    scopes: ['https://www.googleapis.com/auth/adwords'],
    lastValidatedAt: NOW,
    lastInventorySnapshotAt: null,
    lastMetricsSnapshotAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  db.insert(gtmConnections).values({
    id: `${projectId}_gtm_connection`,
    projectId,
    selectedAccountId: 'account_1',
    selectedAccountName: 'Example account',
    selectedContainerId: 'container_1',
    selectedContainerName: 'Example container',
    selectedContainerPublicId: 'GTM-EXAMPLE',
    selectedWorkspaceId: 'workspace_1',
    selectedWorkspaceName: 'Default workspace',
    scopes: ['https://www.googleapis.com/auth/tagmanager.readonly'],
    lastValidatedAt: NOW,
    lastSnapshotAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  }).run()
  db.insert(runs).values([
    {
      id: `${projectId}_ads_run`, projectId, kind: RunKinds['google-ads-sync'], status: RunStatuses.completed,
      trigger: RunTriggers.manual, createdAt: NOW,
    },
    {
      id: `${projectId}_gtm_run`, projectId, kind: RunKinds['gtm-sync'], status: RunStatuses.completed,
      trigger: RunTriggers.manual, createdAt: NOW,
    },
  ]).run()
}

const GOOGLE_ADS_PAYLOAD: GoogleAdsSnapshotPayload = {
  kind: 'inventory',
  data: {
    customerId: '200', fetchedAt: NOW, campaigns: [], conversionActions: [], customerConversionGoals: [],
    campaignConversionGoals: [], customConversionGoals: [], campaignGoalConfigurations: [],
  },
}

const GTM_PAYLOAD: GtmSnapshotPayload = {
  kind: 'live',
  data: {
    source: 'live',
    version: {
      accountId: 'account_1', containerId: 'container_1', id: 'version_1',
      path: 'accounts/account_1/containers/container_1/versions/version_1', name: 'Live', description: null,
      fingerprint: null, deleted: false,
    },
    graph: {
      accountId: 'account_1', containerId: 'container_1', workspaceId: null,
      tags: [], triggers: [], variables: [], googleAdsTagAssessments: [],
    },
    fetchedAt: NOW,
  },
}

const CONTRACT: ConversionTrackingContract = {
  id: 'booking_contract',
  projectId: 'project_1',
  name: 'Booking completed',
  eventName: 'purchase',
  googleAds: {
    customerId: '200', conversionActionId: 'action_booking', conversionId: 'AW-123456',
    conversionLabel: 'booking_label', campaignIds: ['campaign_booking'], requireBiddableGoal: true,
    requirePrimaryAction: true,
  },
  gtm: {
    accountId: 'account_1', containerId: 'container_1', tagId: 'tag_booking',
    triggerIds: ['trigger_purchase'], variableIds: ['variable_value'],
  },
  runtime: {
    verificationRequired: true, requireTransactionId: true, requireValue: true, requireCurrency: true,
    productionHosts: ['example.com'],
  },
  createdAt: NOW,
  updatedAt: NOW,
}

function googleAdsSnapshotValues(projectId: string, connectionId: string, runId: string, id: string) {
  return {
    id,
    projectId,
    connectionId,
    runId,
    kind: GOOGLE_ADS_PAYLOAD.kind,
    customerId: '200',
    payloadChecksum: 'a'.repeat(64),
    rawPayloadSha256: null,
    rawPayloadBytes: null,
    redactedFieldCount: 0,
    payload: GOOGLE_ADS_PAYLOAD,
    capturedAt: NOW,
    createdAt: NOW,
  }
}

test('Google marketing connections, immutable snapshots, and contract semantics round-trip without credentials', () => {
  const db = createTempDb('canonry-google-marketing-persistence-')
  seedProject(db, 'project_1')
  seedGoogleMarketingParents(db)

  db.insert(conversionTrackingContracts).values({
    id: CONTRACT.id,
    projectId: CONTRACT.projectId,
    name: CONTRACT.name,
    eventName: CONTRACT.eventName,
    googleAds: CONTRACT.googleAds,
    gtm: CONTRACT.gtm,
    runtime: CONTRACT.runtime,
    createdAt: CONTRACT.createdAt,
    updatedAt: CONTRACT.updatedAt,
  }).run()
  db.insert(googleAdsRawSnapshots).values(googleAdsSnapshotValues(
    'project_1', 'project_1_ads_connection', 'project_1_ads_run', 'ads_snapshot_1',
  )).run()
  db.insert(gtmRawSnapshots).values({
    id: 'gtm_snapshot_1', projectId: 'project_1', connectionId: 'project_1_gtm_connection',
    runId: 'project_1_gtm_run', kind: GTM_PAYLOAD.kind, accountId: 'account_1', containerId: 'container_1',
    workspaceId: null, payloadChecksum: 'b'.repeat(64), rawPayloadSha256: null, rawPayloadBytes: null,
    redactedFieldCount: 0, payload: GTM_PAYLOAD, capturedAt: NOW, createdAt: NOW,
  }).run()

  const contract = db.select().from(conversionTrackingContracts)
    .where(eq(conversionTrackingContracts.id, CONTRACT.id)).get()
  expect(contract).toMatchObject({
    projectId: 'project_1',
    googleAds: { conversionId: 'AW-123456', conversionLabel: 'booking_label' },
    gtm: { tagId: 'tag_booking' },
    runtime: { productionHosts: ['example.com'] },
  })
  expect(db.select().from(googleAdsRawSnapshots).where(eq(googleAdsRawSnapshots.id, 'ads_snapshot_1')).get()?.payload)
    .toEqual(GOOGLE_ADS_PAYLOAD)
  expect(db.select().from(gtmRawSnapshots).where(eq(gtmRawSnapshots.id, 'gtm_snapshot_1')).get()?.payload)
    .toEqual(GTM_PAYLOAD)

  for (const table of ['google_ads_connections', 'gtm_connections', 'google_ads_raw_snapshots', 'gtm_raw_snapshots', 'conversion_tracking_contracts']) {
    const columns = db.$client.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    expect(columns.map(column => column.name)).not.toEqual(expect.arrayContaining([
      'access_token', 'refresh_token', 'developer_token', 'client_secret', 'oauth_token',
    ]))
  }
  expect(db.$client.prepare('PRAGMA table_info(google_ads_raw_snapshots)').all()).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'updated_at' })]),
  )
  expect(db.$client.prepare('PRAGMA table_info(gtm_raw_snapshots)').all()).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'updated_at' })]),
  )
})

test('snapshot run/connection ownership cannot cross project boundaries', () => {
  const db = createTempDb('canonry-google-marketing-same-project-')
  seedProject(db, 'project_1')
  seedProject(db, 'project_2')
  seedGoogleMarketingParents(db, 'project_1')
  seedGoogleMarketingParents(db, 'project_2')

  expect(() => db.insert(googleAdsRawSnapshots).values(googleAdsSnapshotValues(
    'project_1', 'project_2_ads_connection', 'project_1_ads_run', 'wrong_connection_project',
  )).run()).toThrow(/FOREIGN KEY/i)
  expect(() => db.insert(googleAdsRawSnapshots).values(googleAdsSnapshotValues(
    'project_1', 'project_1_ads_connection', 'project_2_ads_run', 'wrong_run_project',
  )).run()).toThrow(/FOREIGN KEY/i)
})

test('v142 adds the project-scoped conversion-tracking contract anchor over a v141 database', () => {
  const db = createTempDb('canonry-google-marketing-v142-upgrade-', 141)
  expect(db.$client.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversion_tracking_contracts'`).get())
    .toBeUndefined()

  migrate(db)

  expect(MIGRATION_VERSIONS.find(migration => migration.version === 142))
    .toMatchObject({ name: 'conversion-tracking-contracts' })
  const indexes = db.$client.prepare(`PRAGMA index_list(conversion_tracking_contracts)`).all() as Array<{ name: string }>
  expect(indexes.map(index => index.name)).toEqual(expect.arrayContaining([
    'idx_conversion_tracking_contracts_project_name',
    'idx_conversion_tracking_contracts_project_event',
  ]))
})

test('v143 adds private generation and exact-snapshot anchors over an existing v142 database', () => {
  const db = createTempDb('canonry-google-marketing-v143-upgrade-', 142)
  seedProject(db, 'project_1')
  db.$client.prepare(`
    INSERT INTO google_ads_connections (id, project_id, scopes, created_at, updated_at)
    VALUES ('ads_connection', 'project_1', '[]', ?, ?)
  `).run(NOW, NOW)
  db.$client.prepare(`
    INSERT INTO gtm_connections (id, project_id, scopes, created_at, updated_at)
    VALUES ('gtm_connection', 'project_1', '[]', ?, ?)
  `).run(NOW, NOW)

  const before = db.$client.prepare(`PRAGMA table_info(google_ads_connections)`).all() as Array<{ name: string }>
  expect(before.map(column => column.name)).not.toContain('selection_generation')

  migrate(db)

  expect(MIGRATION_VERSIONS.find(migration => migration.version === 143))
    .toMatchObject({ name: 'google-marketing-selection-generation-anchors' })
  const adsColumns = db.$client.prepare(`PRAGMA table_info(google_ads_connections)`).all() as Array<{ name: string }>
  const gtmColumns = db.$client.prepare(`PRAGMA table_info(gtm_connections)`).all() as Array<{ name: string }>
  expect(adsColumns.map(column => column.name)).toEqual(expect.arrayContaining([
    'selection_generation', 'last_customer_snapshot_id', 'last_inventory_snapshot_id', 'last_metrics_snapshot_id',
  ]))
  expect(gtmColumns.map(column => column.name)).toEqual(expect.arrayContaining([
    'selection_generation', 'last_snapshot_id',
  ]))
  expect(db.$client.prepare(`
    SELECT selection_generation, last_customer_snapshot_id, last_inventory_snapshot_id, last_metrics_snapshot_id
    FROM google_ads_connections WHERE id = 'ads_connection'
  `).get()).toEqual({
    selection_generation: 0,
    last_customer_snapshot_id: null,
    last_inventory_snapshot_id: null,
    last_metrics_snapshot_id: null,
  })
  expect(db.$client.prepare(`
    SELECT selection_generation, last_snapshot_id FROM gtm_connections WHERE id = 'gtm_connection'
  `).get()).toEqual({ selection_generation: 0, last_snapshot_id: null })
})
