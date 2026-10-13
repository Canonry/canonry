import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { beforeEach, expect, onTestFinished, test, vi } from 'vitest'
import {
  createClient,
  googleAdsConnections,
  googleAdsRawSnapshots,
  gtmConnections,
  gtmRawSnapshots,
  migrate,
  projects,
  runs,
} from '@ainyc/canonry-db'
import {
  RunKinds,
  RunStatuses,
  RunTriggers,
  type GoogleAdsRawSnapshotDto,
  type GtmRawSnapshotDto,
} from '@ainyc/canonry-contracts'
import { GoogleMarketingRuntimeError, type GoogleMarketingRuntime } from '../src/google-marketing-runtime.js'
import {
  executeGoogleAdsMarketingSync,
  executeGtmMarketingSync,
} from '../src/google-marketing-sync.js'

const trackEvent = vi.hoisted(() => vi.fn())
vi.mock('../src/telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/telemetry.js')>()),
  trackEvent,
}))

beforeEach(() => trackEvent.mockReset())

function outcomes() {
  return trackEvent.mock.calls.filter((call) => call[0] === 'feature.completed').map((call) => call.slice(1))
}

const NOW = '2026-08-14T12:00:00.000Z'
const SHA = 'a'.repeat(64)

function createTempDb() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-google-marketing-sync-'))
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }))
  const db = createClient(path.join(directory, 'test.db'))
  migrate(db)
  return db
}

function seedProject(db: ReturnType<typeof createTempDb>) {
  db.insert(projects).values({
    id: 'project_1', name: 'example', displayName: 'Example', canonicalDomain: 'example.com',
    country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
  }).run()
}

function adsSnapshot(
  id: string,
  payload: GoogleAdsRawSnapshotDto['payload'],
): GoogleAdsRawSnapshotDto {
  return {
    metadata: {
      id, projectId: 'project_1', connectionId: 'ads_connection', runId: 'ads_run',
      kind: payload.kind, customerId: '1234567890', payloadChecksum: SHA,
      rawPayloadSha256: SHA, rawPayloadBytes: 100, redactedFieldCount: 0,
      capturedAt: NOW, createdAt: NOW,
    },
    payload,
  }
}

function gtmSnapshot(): GtmRawSnapshotDto {
  return {
    metadata: {
      id: 'gtm_snapshot', projectId: 'project_1', connectionId: 'gtm_connection', runId: 'gtm_run',
      kind: 'container', accountId: 'account_1', containerId: 'container_1', workspaceId: 'workspace_1',
      payloadChecksum: SHA, rawPayloadSha256: SHA, rawPayloadBytes: 100, redactedFieldCount: 0,
      capturedAt: NOW, createdAt: NOW,
    },
    payload: {
      kind: 'container',
      data: {
        account: { id: 'account_1', path: 'accounts/account_1', name: 'Example', shareData: null },
        container: {
          accountId: 'account_1', id: 'container_1', path: 'accounts/account_1/containers/container_1',
          name: 'Hotel web', publicId: 'GTM-TEST', domainName: 'example.com', usageContexts: ['web'],
        },
        workspaces: [{
          accountId: 'account_1', containerId: 'container_1', id: 'workspace_1',
          path: 'accounts/account_1/containers/container_1/workspaces/workspace_1',
          name: 'Default', description: null, fingerprint: null,
        }],
        live: null,
        draft: null,
        fetchedAt: NOW,
      },
    },
  }
}

function googleAdsSyncResult() {
  const accessibleCustomers = adsSnapshot('customer_snapshot', {
    kind: 'accessible-customers',
    data: {
      customers: [{
        resourceName: 'customers/1234567890', customerId: '1234567890', parentCustomerId: null,
        descriptiveName: 'Example Hotel', currencyCode: 'USD', timeZone: 'America/Los_Angeles',
        manager: false, hidden: false, testAccount: false, level: 0, status: 'enabled',
      }],
      totalAccessible: 1, truncated: false,
      selection: { loginCustomerId: null, customerId: '1234567890', selectedAt: NOW },
      fetchedAt: NOW,
    },
  })
  const inventory = adsSnapshot('inventory_snapshot', {
    kind: 'inventory',
    data: {
      customerId: '1234567890', fetchedAt: NOW, campaigns: [], conversionActions: [],
      customerConversionGoals: [], campaignConversionGoals: [], customConversionGoals: [],
      campaignGoalConfigurations: [],
    },
  })
  return {
    accessibleCustomers,
    inventory,
    metrics: null,
    effectiveGoalGraph: { customerId: '1234567890', derivedAt: NOW, campaigns: [] },
  }
}

test('Google Ads sync publishes selected-customer and inventory evidence atomically', async () => {
  const db = createTempDb()
  seedProject(db)
  db.insert(googleAdsConnections).values({
    id: 'ads_connection', projectId: 'project_1', selectedCustomerId: '1234567890',
    scopes: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(runs).values({
    id: 'ads_run', projectId: 'project_1', kind: RunKinds['google-ads-sync'],
    status: RunStatuses.queued, trigger: RunTriggers.manual, createdAt: NOW,
  }).run()
  const result = googleAdsSyncResult()
  let duplicateError = ''
  const runtime = {
    syncGoogleAds: async () => {
      duplicateError = await executeGoogleAdsMarketingSync(db, runtime, 'ads_run', 'project_1')
        .then(() => 'unexpected-success')
        .catch((error: unknown) => error instanceof Error ? error.message : String(error))
      return result
    },
  } as unknown as GoogleMarketingRuntime

  await executeGoogleAdsMarketingSync(db, runtime, 'ads_run', 'project_1')

  expect(db.select().from(googleAdsRawSnapshots).all()).toHaveLength(2)
  expect(db.select().from(googleAdsConnections).where(eq(googleAdsConnections.id, 'ads_connection')).get())
    .toMatchObject({
      selectedCustomerName: 'Example Hotel', lastCustomerSnapshotId: 'customer_snapshot',
      lastInventorySnapshotAt: NOW, lastInventorySnapshotId: 'inventory_snapshot',
    })
  expect(db.select().from(runs).where(eq(runs.id, 'ads_run')).get())
    .toMatchObject({ status: RunStatuses.completed, error: null })
  expect(duplicateError).toContain('only queued Google Marketing runs can start')
})

test('same-value Google Ads reselection rejects an in-flight sync at one timestamp', async () => {
  const db = createTempDb()
  seedProject(db)
  db.insert(googleAdsConnections).values({
    id: 'ads_connection', projectId: 'project_1', selectedCustomerId: '1234567890',
    selectionGeneration: 7, scopes: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(runs).values({
    id: 'ads_run', projectId: 'project_1', kind: RunKinds['google-ads-sync'],
    status: RunStatuses.queued, trigger: RunTriggers.manual, createdAt: NOW,
  }).run()
  const result = googleAdsSyncResult()
  const runtime = {
    syncGoogleAds: async () => {
      // The API selection mutation does this even when customer IDs match.
      db.update(googleAdsConnections).set({
        selectionGeneration: 8, lastValidatedAt: NOW, lastCustomerSnapshotId: null,
        lastInventorySnapshotAt: null, lastInventorySnapshotId: null,
        lastMetricsSnapshotAt: null, lastMetricsSnapshotId: null,
      }).where(eq(googleAdsConnections.id, 'ads_connection')).run()
      return result
    },
  } as unknown as GoogleMarketingRuntime

  await expect(executeGoogleAdsMarketingSync(db, runtime, 'ads_run', 'project_1'))
    .rejects.toThrow('selection changed')

  expect(db.select().from(googleAdsRawSnapshots).all()).toHaveLength(0)
  expect(db.select().from(googleAdsConnections).where(eq(googleAdsConnections.id, 'ads_connection')).get())
    .toMatchObject({ selectionGeneration: 8, lastInventorySnapshotId: null })
  expect(db.select().from(runs).where(eq(runs.id, 'ads_run')).get())
    .toMatchObject({ status: RunStatuses.failed })
})

test('Google Ads reconnect during a sync rejects evidence from the former principal', async () => {
  const db = createTempDb()
  seedProject(db)
  db.insert(googleAdsConnections).values({
    id: 'ads_connection', projectId: 'project_1', selectedCustomerId: '1234567890',
    selectionGeneration: 7, scopes: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(runs).values({
    id: 'ads_run', projectId: 'project_1', kind: RunKinds['google-ads-sync'],
    status: RunStatuses.queued, trigger: RunTriggers.manual, createdAt: NOW,
  }).run()
  const result = googleAdsSyncResult()
  const runtime = {
    syncGoogleAds: async () => {
      // Mirrors OAuth confirmation: a new principal has no inherited resource
      // selection or current-evidence anchors.
      db.update(googleAdsConnections).set({
        selectedLoginCustomerId: null, selectedCustomerId: null, selectedCustomerName: null,
        selectedCustomerCurrencyCode: null, selectedCustomerTimeZone: null, selectedCustomerStatus: null,
        selectionGeneration: 8, lastValidatedAt: NOW, lastCustomerSnapshotId: null,
        lastInventorySnapshotAt: null, lastInventorySnapshotId: null,
        lastMetricsSnapshotAt: null, lastMetricsSnapshotId: null,
      }).where(eq(googleAdsConnections.id, 'ads_connection')).run()
      return result
    },
  } as unknown as GoogleMarketingRuntime

  await expect(executeGoogleAdsMarketingSync(db, runtime, 'ads_run', 'project_1'))
    .rejects.toThrow('selection changed')

  expect(db.select().from(googleAdsRawSnapshots).all()).toHaveLength(0)
  expect(db.select().from(googleAdsConnections).where(eq(googleAdsConnections.id, 'ads_connection')).get())
    .toMatchObject({ selectedCustomerId: null, selectionGeneration: 8, lastInventorySnapshotId: null })
  expect(db.select().from(runs).where(eq(runs.id, 'ads_run')).get())
    .toMatchObject({ status: RunStatuses.failed })
})

test('GTM sync publishes only the sanitized graph and validated selection metadata', async () => {
  const db = createTempDb()
  seedProject(db)
  db.insert(gtmConnections).values({
    id: 'gtm_connection', projectId: 'project_1', selectedAccountId: 'account_1',
    selectedContainerId: 'container_1', selectedWorkspaceId: 'workspace_1',
    scopes: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(runs).values({
    id: 'gtm_run', projectId: 'project_1', kind: RunKinds['gtm-sync'],
    status: RunStatuses.queued, trigger: RunTriggers.manual, createdAt: NOW,
  }).run()
  const runtime = { syncGtm: async () => gtmSnapshot() } as unknown as GoogleMarketingRuntime

  await executeGtmMarketingSync(db, runtime, 'gtm_run', 'project_1')

  expect(db.select().from(gtmRawSnapshots).all()).toHaveLength(1)
  expect(db.select().from(gtmConnections).where(eq(gtmConnections.id, 'gtm_connection')).get())
    .toMatchObject({
      selectedAccountName: 'Example', selectedContainerPublicId: 'GTM-TEST',
      lastSnapshotAt: NOW, lastSnapshotId: 'gtm_snapshot',
    })
  expect(db.select().from(runs).where(eq(runs.id, 'gtm_run')).get())
    .toMatchObject({ status: RunStatuses.completed, error: null })
})

test('GTM sync rejects a graph whose workspace does not match the selected workspace', async () => {
  const db = createTempDb()
  seedProject(db)
  db.insert(gtmConnections).values({
    id: 'gtm_connection', projectId: 'project_1', selectedAccountId: 'account_1',
    selectedContainerId: 'container_1', selectedWorkspaceId: 'workspace_1',
    scopes: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(runs).values({
    id: 'gtm_run', projectId: 'project_1', kind: RunKinds['gtm-sync'],
    status: RunStatuses.queued, trigger: RunTriggers.manual, createdAt: NOW,
  }).run()
  const runtime = {
    syncGtm: async () => {
      const snapshot = gtmSnapshot()
      snapshot.metadata.workspaceId = 'workspace_2'
      return snapshot
    },
  } as unknown as GoogleMarketingRuntime

  await expect(executeGtmMarketingSync(db, runtime, 'gtm_run', 'project_1'))
    .rejects.toThrow('different account, container, or workspace')
  expect(db.select().from(gtmRawSnapshots).all()).toHaveLength(0)
  expect(db.select().from(runs).where(eq(runs.id, 'gtm_run')).get())
    .toMatchObject({ status: RunStatuses.failed })
})

test('same-value GTM reselection rejects an in-flight sync at one timestamp', async () => {
  const db = createTempDb()
  seedProject(db)
  db.insert(gtmConnections).values({
    id: 'gtm_connection', projectId: 'project_1', selectedAccountId: 'account_1',
    selectedContainerId: 'container_1', selectedWorkspaceId: 'workspace_1',
    selectionGeneration: 7, scopes: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(runs).values({
    id: 'gtm_run', projectId: 'project_1', kind: RunKinds['gtm-sync'],
    status: RunStatuses.queued, trigger: RunTriggers.manual, createdAt: NOW,
  }).run()
  const runtime = {
    syncGtm: async () => {
      // The API selection mutation increments this even when all IDs match.
      db.update(gtmConnections).set({
        selectionGeneration: 8, lastValidatedAt: NOW, lastSnapshotAt: null, lastSnapshotId: null,
      }).where(eq(gtmConnections.id, 'gtm_connection')).run()
      return gtmSnapshot()
    },
  } as unknown as GoogleMarketingRuntime

  await expect(executeGtmMarketingSync(db, runtime, 'gtm_run', 'project_1'))
    .rejects.toThrow('selection changed')

  expect(db.select().from(gtmRawSnapshots).all()).toHaveLength(0)
  expect(db.select().from(gtmConnections).where(eq(gtmConnections.id, 'gtm_connection')).get())
    .toMatchObject({ selectionGeneration: 8, lastSnapshotId: null })
  expect(db.select().from(runs).where(eq(runs.id, 'gtm_run')).get())
    .toMatchObject({ status: RunStatuses.failed })
})

test('GTM reconnect during a sync rejects evidence from the former principal', async () => {
  const db = createTempDb()
  seedProject(db)
  db.insert(gtmConnections).values({
    id: 'gtm_connection', projectId: 'project_1', selectedAccountId: 'account_1',
    selectedContainerId: 'container_1', selectedWorkspaceId: 'workspace_1',
    selectionGeneration: 7, scopes: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(runs).values({
    id: 'gtm_run', projectId: 'project_1', kind: RunKinds['gtm-sync'],
    status: RunStatuses.queued, trigger: RunTriggers.manual, createdAt: NOW,
  }).run()
  const runtime = {
    syncGtm: async () => {
      // Mirrors OAuth confirmation: a new principal starts without inheriting
      // the former principal's selected account/container/workspace.
      db.update(gtmConnections).set({
        selectedAccountId: null, selectedAccountName: null, selectedContainerId: null,
        selectedContainerName: null, selectedContainerPublicId: null,
        selectedWorkspaceId: null, selectedWorkspaceName: null,
        selectionGeneration: 8, lastValidatedAt: NOW, lastSnapshotAt: null, lastSnapshotId: null,
      }).where(eq(gtmConnections.id, 'gtm_connection')).run()
      return gtmSnapshot()
    },
  } as unknown as GoogleMarketingRuntime

  await expect(executeGtmMarketingSync(db, runtime, 'gtm_run', 'project_1'))
    .rejects.toThrow('selection changed')

  expect(db.select().from(gtmRawSnapshots).all()).toHaveLength(0)
  expect(db.select().from(gtmConnections).where(eq(gtmConnections.id, 'gtm_connection')).get())
    .toMatchObject({ selectedAccountId: null, selectedContainerId: null, selectionGeneration: 8, lastSnapshotId: null })
  expect(db.select().from(runs).where(eq(runs.id, 'gtm_run')).get())
    .toMatchObject({ status: RunStatuses.failed })
})

test('failed sync stores a bounded redacted error and no snapshot', async () => {
  const db = createTempDb()
  seedProject(db)
  db.insert(gtmConnections).values({
    id: 'gtm_connection', projectId: 'project_1', selectedAccountId: 'account_1',
    selectedContainerId: 'container_1', scopes: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(runs).values({
    id: 'gtm_run', projectId: 'project_1', kind: RunKinds['gtm-sync'],
    status: RunStatuses.queued, trigger: RunTriggers.manual, createdAt: NOW,
  }).run()
  const runtime = {
    syncGtm: async () => { throw new Error('authorization: Bearer should-not-persist') },
  } as unknown as GoogleMarketingRuntime

  await expect(executeGtmMarketingSync(db, runtime, 'gtm_run', 'project_1')).rejects.toThrow()

  expect(db.select().from(gtmRawSnapshots).all()).toHaveLength(0)
  const run = db.select().from(runs).where(eq(runs.id, 'gtm_run')).get()
  expect(run?.status).toBe(RunStatuses.failed)
  expect(run?.error).toContain('[redacted]')
  expect(run?.error).not.toContain('should-not-persist')
})

test('failed sync redacts credentials from a thrown provider object', async () => {
  const db = createTempDb()
  seedProject(db)
  db.insert(gtmConnections).values({
    id: 'gtm_connection', projectId: 'project_1', selectedAccountId: 'account_1',
    selectedContainerId: 'container_1', scopes: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(runs).values({
    id: 'gtm_run', projectId: 'project_1', kind: RunKinds['gtm-sync'],
    status: RunStatuses.queued, trigger: RunTriggers.manual, createdAt: NOW,
  }).run()
  const runtime = {
    syncGtm: async () => {
      throw { access_token: 'object-access-secret', clientSecret: 'object-client-secret' }
    },
  } as unknown as GoogleMarketingRuntime

  await expect(executeGtmMarketingSync(db, runtime, 'gtm_run', 'project_1')).rejects.toBeDefined()

  const run = db.select().from(runs).where(eq(runs.id, 'gtm_run')).get()
  expect(run?.error).toContain('[redacted]')
  expect(run?.error).not.toContain('object-access-secret')
  expect(run?.error).not.toContain('object-client-secret')
})

test('a mismatched callback cannot fail another project run', async () => {
  const db = createTempDb()
  seedProject(db)
  db.insert(runs).values({
    id: 'ads_run', projectId: 'project_1', kind: RunKinds['google-ads-sync'],
    status: RunStatuses.queued, trigger: RunTriggers.manual, createdAt: NOW,
  }).run()
  const runtime = {} as GoogleMarketingRuntime

  await expect(executeGoogleAdsMarketingSync(db, runtime, 'ads_run', 'different_project'))
    .rejects.toThrow('not a google-ads-sync run')

  expect(db.select().from(runs).where(eq(runs.id, 'ads_run')).get())
    .toMatchObject({ status: RunStatuses.queued, error: null, finishedAt: null })
})

test('a duplicate callback cannot overwrite a completed run', async () => {
  const db = createTempDb()
  seedProject(db)
  db.insert(runs).values({
    id: 'gtm_run', projectId: 'project_1', kind: RunKinds['gtm-sync'],
    status: RunStatuses.completed, trigger: RunTriggers.manual, createdAt: NOW, finishedAt: NOW,
  }).run()
  const runtime = {} as GoogleMarketingRuntime

  await expect(executeGtmMarketingSync(db, runtime, 'gtm_run', 'project_1'))
    .rejects.toThrow('only queued Google Marketing runs can start')

  expect(db.select().from(runs).where(eq(runs.id, 'gtm_run')).get())
    .toMatchObject({ status: RunStatuses.completed, error: null, finishedAt: NOW })
})

test('cancelling an in-flight sync prevents evidence publication and completion overwrite', async () => {
  const db = createTempDb()
  seedProject(db)
  db.insert(gtmConnections).values({
    id: 'gtm_connection', projectId: 'project_1', selectedAccountId: 'account_1',
    selectedContainerId: 'container_1', selectedWorkspaceId: 'workspace_1',
    scopes: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(runs).values({
    id: 'gtm_run', projectId: 'project_1', kind: RunKinds['gtm-sync'],
    status: RunStatuses.queued, trigger: RunTriggers.manual, createdAt: NOW,
  }).run()
  const runtime = {
    syncGtm: async () => {
      db.update(runs).set({ status: RunStatuses.cancelled, finishedAt: NOW })
        .where(eq(runs.id, 'gtm_run')).run()
      return gtmSnapshot()
    },
  } as unknown as GoogleMarketingRuntime

  await expect(executeGtmMarketingSync(db, runtime, 'gtm_run', 'project_1'))
    .rejects.toThrow('was no longer running')

  expect(db.select().from(gtmRawSnapshots).all()).toHaveLength(0)
  expect(db.select().from(runs).where(eq(runs.id, 'gtm_run')).get())
    .toMatchObject({ status: RunStatuses.cancelled, error: null })
})

test('reselection during a sync rolls back stale evidence and preserves the new selection', async () => {
  const db = createTempDb()
  seedProject(db)
  db.insert(gtmConnections).values({
    id: 'gtm_connection', projectId: 'project_1', selectedAccountId: 'account_1',
    selectedContainerId: 'container_1', selectedWorkspaceId: 'workspace_1',
    scopes: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(runs).values({
    id: 'gtm_run', projectId: 'project_1', kind: RunKinds['gtm-sync'],
    status: RunStatuses.queued, trigger: RunTriggers.manual, createdAt: NOW,
  }).run()
  const runtime = {
    syncGtm: async () => {
      db.update(gtmConnections).set({
        selectedContainerId: 'container_2',
        lastValidatedAt: '2026-08-14T12:30:00.000Z',
      }).where(eq(gtmConnections.id, 'gtm_connection')).run()
      return gtmSnapshot()
    },
  } as unknown as GoogleMarketingRuntime

  await expect(executeGtmMarketingSync(db, runtime, 'gtm_run', 'project_1'))
    .rejects.toThrow('selection changed')

  expect(db.select().from(gtmRawSnapshots).all()).toHaveLength(0)
  expect(db.select().from(gtmConnections).where(eq(gtmConnections.id, 'gtm_connection')).get())
    .toMatchObject({ selectedContainerId: 'container_2', lastSnapshotAt: null })
  expect(db.select().from(runs).where(eq(runs.id, 'gtm_run')).get())
    .toMatchObject({ status: RunStatuses.failed })
})

function seedGoogleAds(db: ReturnType<typeof createTempDb>, run: { status?: string; selectedCustomerId?: string | null } = {}) {
  seedProject(db)
  db.insert(googleAdsConnections).values({
    id: 'ads_connection', projectId: 'project_1',
    selectedCustomerId: run.selectedCustomerId === undefined ? '1234567890' : run.selectedCustomerId,
    selectionGeneration: 7, scopes: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(runs).values({
    id: 'ads_run', projectId: 'project_1', kind: RunKinds['google-ads-sync'],
    status: run.status ?? RunStatuses.queued, trigger: RunTriggers.manual, createdAt: NOW,
  }).run()
}

test('reports a Google Ads sync with its campaigns and metric rows after the evidence is saved', async () => {
  const db = createTempDb()
  seedGoogleAds(db)
  const result = googleAdsSyncResult()
  if (result.inventory.payload.kind === 'inventory') {
    result.inventory.payload.data.campaigns = [
      { id: '111', resourceName: 'customers/1234567890/campaigns/111', name: 'Brand', status: 'enabled', advertisingChannelType: 'SEARCH', biddingStrategyType: null },
      { id: '222', resourceName: 'customers/1234567890/campaigns/222', name: 'Rooms', status: 'paused', advertisingChannelType: 'SEARCH', biddingStrategyType: null },
    ]
  }
  const runtime = { syncGoogleAds: async () => result } as unknown as GoogleMarketingRuntime

  await executeGoogleAdsMarketingSync(db, runtime, 'ads_run', 'project_1')

  expect(outcomes()).toEqual([[
    {
      feature: 'google_ads', operation: 'sync', trigger: 'manual', status: 'succeeded',
      durationBucket: 'under_1s', counts: { campaigns: 2, rows: 0 },
    },
    undefined,
  ]])
})

test('reports a Google Ads sync by reason: no selected customer, an expired grant, a run already running, a selection change', async () => {
  const cases: Array<{ arrange: (db: ReturnType<typeof createTempDb>) => GoogleMarketingRuntime; outcome: Record<string, unknown> }> = [
    {
      arrange: (db) => {
        seedGoogleAds(db, { selectedCustomerId: null })
        return {} as GoogleMarketingRuntime
      },
      outcome: { status: 'failed', reasonCode: 'ACCOUNT_NOT_FOUND', errorName: 'Error' },
    },
    {
      arrange: (db) => {
        seedGoogleAds(db)
        return {
          syncGoogleAds: async () => { throw new GoogleMarketingRuntimeError('Google OAuth access has expired', 'TOKEN_REFRESH_REQUIRED') },
        } as unknown as GoogleMarketingRuntime
      },
      outcome: { status: 'failed', reasonCode: 'INVALID_CREDENTIALS', errorName: 'GoogleMarketingRuntimeError' },
    },
    {
      arrange: (db) => {
        seedGoogleAds(db, { status: RunStatuses.running })
        return {} as GoogleMarketingRuntime
      },
      outcome: { status: 'skipped', reasonCode: 'OPERATION_IN_PROGRESS', errorName: 'Error' },
    },
    {
      arrange: (db) => {
        seedGoogleAds(db)
        const result = googleAdsSyncResult()
        return {
          syncGoogleAds: async () => {
            db.update(googleAdsConnections).set({ selectionGeneration: 8 }).where(eq(googleAdsConnections.id, 'ads_connection')).run()
            return result
          },
        } as unknown as GoogleMarketingRuntime
      },
      outcome: { status: 'cancelled', reasonCode: 'CANCELLED_BY_USER', errorName: 'Error' },
    },
  ]
  for (const testCase of cases) {
    trackEvent.mockReset()
    const db = createTempDb()
    const runtime = testCase.arrange(db)
    await expect(executeGoogleAdsMarketingSync(db, runtime, 'ads_run', 'project_1')).rejects.toThrow()
    expect(outcomes()).toEqual([[
      { feature: 'google_ads', operation: 'sync', trigger: 'manual', ...testCase.outcome, durationBucket: 'under_1s' },
      { errorCode: testCase.outcome.reasonCode },
    ]])
  }
})

test('reports a GTM sync with the tags in the published container', async () => {
  const db = createTempDb()
  seedProject(db)
  db.insert(gtmConnections).values({
    id: 'gtm_connection', projectId: 'project_1', selectedAccountId: 'account_1',
    selectedContainerId: 'container_1', selectedWorkspaceId: 'workspace_1',
    scopes: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(runs).values({
    id: 'gtm_run', projectId: 'project_1', kind: RunKinds['gtm-sync'],
    status: RunStatuses.queued, trigger: RunTriggers.scheduled, createdAt: NOW,
  }).run()
  const snapshot = gtmSnapshot()
  if (snapshot.payload.kind === 'container') {
    const tag = (id: string) => ({
      id, name: `Tag ${id}`, type: 'awct', paused: false, firingTriggerIds: [], blockingTriggerIds: [],
      referencedVariableIds: [], parameterKeys: [], fingerprint: null,
    })
    snapshot.payload.data.live = {
      source: 'live',
      version: {
        accountId: 'account_1', containerId: 'container_1', id: '12', path: 'accounts/account_1/containers/container_1/versions/12',
        name: 'Live', description: null, fingerprint: null, deleted: false,
      },
      graph: {
        accountId: 'account_1', containerId: 'container_1', workspaceId: null,
        tags: [tag('1'), tag('2'), tag('3')], triggers: [], variables: [], googleAdsTagAssessments: [],
      },
      fetchedAt: NOW,
    }
  }
  const runtime = { syncGtm: async () => snapshot } as unknown as GoogleMarketingRuntime

  await executeGtmMarketingSync(db, runtime, 'gtm_run', 'project_1')

  expect(outcomes()).toEqual([[
    {
      feature: 'gtm', operation: 'sync', trigger: 'scheduled', surface: 'system', status: 'succeeded',
      durationBucket: 'under_1s', counts: { items: 3 },
    },
    undefined,
  ]])
})

test('reports GTM evidence that failed our own consistency check as internal', async () => {
  const db = createTempDb()
  seedProject(db)
  db.insert(gtmConnections).values({
    id: 'gtm_connection', projectId: 'project_1', selectedAccountId: 'account_1',
    selectedContainerId: 'container_1', selectedWorkspaceId: 'workspace_2',
    scopes: [], createdAt: NOW, updatedAt: NOW,
  }).run()
  db.insert(runs).values({
    id: 'gtm_run', projectId: 'project_1', kind: RunKinds['gtm-sync'],
    status: RunStatuses.queued, trigger: RunTriggers.manual, createdAt: NOW,
  }).run()
  const runtime = { syncGtm: async () => gtmSnapshot() } as unknown as GoogleMarketingRuntime

  await expect(executeGtmMarketingSync(db, runtime, 'gtm_run', 'project_1')).rejects.toThrow('different account, container, or workspace')

  expect(outcomes()).toEqual([[
    {
      feature: 'gtm', operation: 'sync', trigger: 'manual', status: 'failed', reasonCode: 'INTERNAL',
      errorName: 'Error', durationBucket: 'under_1s',
    },
    { errorCode: 'INTERNAL' },
  ]])
})
