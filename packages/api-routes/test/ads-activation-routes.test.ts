import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import {
  ADS_ACTIVATE_SCOPE,
  ADS_APPROVE_SCOPE,
  AdsActivationEntityTypes,
  AdsActivationGrantStates,
  AdsEntityStatuses,
  AdsOperationKinds,
  AdsOperationStates,
  AdsOperationStepStates,
  AdsReconcileStrategies,
  AppError,
  adsOperationDtoSchema,
  type AdsActivationManifest,
} from '@ainyc/canonry-contracts'
import {
  adsActivationGrants,
  adsConnections,
  adsOperations,
  adsOperationSteps,
  apiKeys,
  auditLog,
  createClient,
  migrate,
  projects,
} from '@ainyc/canonry-db'
import { adsRoutes, type AdsOperator, type AdsOperatorEntityResult } from '../src/ads.js'
import {
  buildAdsActivationSteps,
  hashAdsActivationManifest,
  hashAdsActivationOperationRequest,
} from '../src/ads-activation.js'
import { registerAdsActivationRoutes } from '../src/ads-activation-routes.js'

const MANIFEST: AdsActivationManifest = {
  campaign: {
    id: 'cmpn_approved',
    expectedUpdatedAt: 10,
    adGroups: [{
      id: 'adgrp_approved',
      expectedUpdatedAt: 20,
      ads: [{ id: 'ad_approved', expectedUpdatedAt: 30 }],
    }],
  },
}

interface ActivationHarnessOptions {
  accountReviewStatus?: string
  activationLeaseMs?: number
  blockAdActivation?: boolean
  blockAdActivationBeforeMutation?: boolean
  failCampaignReadAfterActivation?: boolean
  failDescendantReadAfterCampaignActivation?: boolean
  injectDescendantAfterCampaignActivation?: boolean
  sweepBatchSize?: number
  sweepIntervalMs?: number
}

function buildHarness(options: ActivationHarnessOptions = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ads-activation-routes-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)
  const projectId = 'project_activation'
  const now = new Date().toISOString()
  db.insert(projects).values({
    id: projectId,
    name: 'acme',
    displayName: 'Acme',
    canonicalDomain: 'acme.example',
    country: 'US',
    language: 'en',
    createdAt: now,
    updatedAt: now,
  }).run()
  db.insert(apiKeys).values([
    {
      id: 'key_approver',
      name: 'Human approver',
      keyHash: 'hash_approver',
      keyPrefix: 'cnry_approver',
      scopes: [ADS_APPROVE_SCOPE],
      projectId,
      createdAt: now,
    },
    {
      id: 'key_executor',
      name: 'Activation executor',
      keyHash: 'hash_executor',
      keyPrefix: 'cnry_executor',
      scopes: [ADS_ACTIVATE_SCOPE],
      projectId,
      createdAt: now,
    },
    {
      id: 'key_wrong_scope',
      name: 'Wrong executor',
      keyHash: 'hash_wrong',
      keyPrefix: 'cnry_wrong',
      scopes: ['read'],
      projectId,
      createdAt: now,
    },
    {
      id: 'key_other_executor',
      name: 'Other activation executor',
      keyHash: 'hash_other_executor',
      keyPrefix: 'cnry_other_executor',
      scopes: [ADS_ACTIVATE_SCOPE],
      projectId,
      createdAt: now,
    },
  ]).run()
  db.insert(adsConnections).values({
    id: 'connection_activation',
    projectId,
    adAccountId: 'adacct_approved',
    displayName: 'Acme Ads',
    status: 'active',
    reviewStatus: 'approved',
    integrityReviewStatus: 'approved',
    integrityDecision: 'allowed',
    createdAt: now,
    updatedAt: now,
  }).run()

  const entities = new Map<string, AdsOperatorEntityResult>([
    ['cmpn_approved', { id: 'cmpn_approved', status: 'paused', updatedAt: 10 }],
    ['adgrp_approved', {
      id: 'adgrp_approved',
      campaignId: 'cmpn_approved',
      status: 'paused',
      updatedAt: 20,
    }],
    ['ad_approved', {
      id: 'ad_approved',
      adGroupId: 'adgrp_approved',
      reviewStatus: 'approved',
      status: 'paused',
      updatedAt: 30,
    }],
  ])
  const calls: string[] = []
  let verifyMustFail = false
  let verifyFailureCountdown: number | undefined
  let campaignReadMustFail = false
  let campaignDescendantReadMustFail = false
  let signalActivationStarted: (() => void) | undefined
  let releaseBlockedActivation: (() => void) | undefined
  const activationStarted = new Promise<void>((resolve) => {
    signalActivationStarted = resolve
  })
  const blockedActivation = new Promise<void>((resolve) => {
    releaseBlockedActivation = resolve
  })

  function read(kind: string, id: string): AdsOperatorEntityResult {
    calls.push(`get:${kind}:${id}`)
    if (kind === 'campaign' && campaignReadMustFail) {
      campaignReadMustFail = false
      throw new Error('provider read failed with sk-secret')
    }
    const entity = entities.get(id)
    if (!entity) throw new Error('missing test entity')
    return { ...entity }
  }

  function mutate(kind: string, id: string, status: 'active' | 'paused'): AdsOperatorEntityResult {
    calls.push(`${status === 'active' ? 'activate' : 'pause'}:${kind}:${id}`)
    const entity = entities.get(id)
    if (!entity) throw new Error('missing test entity')
    const next = { ...entity, status, updatedAt: entity.updatedAt + 1 }
    entities.set(id, next)
    if (
      status === 'active'
      && kind === 'campaign'
      && options.failCampaignReadAfterActivation
    ) {
      campaignReadMustFail = true
    }
    if (
      status === 'active'
      && kind === 'campaign'
      && options.failDescendantReadAfterCampaignActivation
    ) {
      campaignDescendantReadMustFail = true
    }
    if (
      status === 'active'
      && kind === 'campaign'
      && options.injectDescendantAfterCampaignActivation
    ) {
      entities.set('adgrp_omitted', {
        id: 'adgrp_omitted',
        campaignId: 'cmpn_approved',
        status: 'active',
        updatedAt: 40,
      })
    }
    return { ...next }
  }

  const unsupported = async (): Promise<never> => {
    throw new Error('unsupported in activation route test')
  }
  const operator: AdsOperator = {
    uploadImage: unsupported,
    getCampaign: async (_key, id) => read('campaign', id),
    listCampaigns: async () => [],
    createCampaign: unsupported,
    updateCampaign: unsupported,
    pauseCampaign: async (_key, id) => mutate('campaign', id, 'paused'),
    activateCampaign: async (_key, id) => mutate('campaign', id, 'active'),
    getAdGroup: async (_key, id) => read('ad_group', id),
    listAdGroups: async (_key, campaignId) => {
      calls.push(`list:ad_groups:${campaignId}`)
      if (campaignDescendantReadMustFail) {
        campaignDescendantReadMustFail = false
        throw new Error('provider descendant read failed with sk-secret')
      }
      return [...entities.values()]
        .filter((entity) => entity.campaignId === campaignId)
        .map((entity) => ({ ...entity }))
    },
    createAdGroup: unsupported,
    updateAdGroup: unsupported,
    pauseAdGroup: async (_key, id) => mutate('ad_group', id, 'paused'),
    activateAdGroup: async (_key, id) => mutate('ad_group', id, 'active'),
    getAd: async (_key, id) => read('ad', id),
    listAds: async (_key, adGroupId) => {
      calls.push(`list:ads:${adGroupId}`)
      return [...entities.values()]
        .filter((entity) => entity.adGroupId === adGroupId)
        .map((entity) => ({ ...entity }))
    },
    createAd: unsupported,
    updateAd: unsupported,
    pauseAd: async (_key, id) => mutate('ad', id, 'paused'),
    activateAd: async (_key, id) => {
      if (options.blockAdActivationBeforeMutation) {
        signalActivationStarted?.()
        await blockedActivation
      }
      const result = mutate('ad', id, 'active')
      signalActivationStarted?.()
      if (options.blockAdActivation) await blockedActivation
      return result
    },
  }

  const app = Fastify()
  app.decorate('db', db)
  app.addHook('onRequest', async (request) => {
    const idHeader = request.headers['x-test-api-key-id']
    const id = Array.isArray(idHeader) ? idHeader[0] : idHeader
    if (!id) return
    const row = db.select().from(apiKeys).where(eq(apiKeys.id, id)).get()
    if (!row) return
    request.apiKey = { id: row.id, name: row.name, scopes: row.scopes, projectId: row.projectId }
  })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.status(error.statusCode).send(error.toJSON())
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal error' } })
  })
  const credential = {
    projectName: 'acme',
    apiKey: 'sk-provider',
    adAccountId: 'adacct_approved',
    createdAt: now,
    updatedAt: now,
  }
  void app.register(adsRoutes, {
    adsCredentialStore: {
      getConnection: (projectName) => projectName === 'acme' ? credential : undefined,
      upsertConnection: () => credential,
      removeConnection: () => false,
    },
    verifyAdsAccount: async () => {
      calls.push('verify:account')
      if (verifyFailureCountdown !== undefined) {
        if (verifyFailureCountdown === 0) {
          verifyFailureCountdown = undefined
          throw new Error('provider unavailable with sk-secret')
        }
        verifyFailureCountdown -= 1
      }
      if (verifyMustFail) throw new Error('provider unavailable with sk-secret')
      return {
        id: credential.adAccountId,
        name: 'Acme Ads',
        status: 'active',
        currencyCode: 'USD',
        timezone: 'UTC',
        reviewStatus: options.accountReviewStatus ?? 'approved',
        integrityReviewStatus: 'approved',
        integrityDecision: 'allowed',
      }
    },
    adsOperator: operator,
    adsReconcileSweepIntervalMs: 0,
    adsActivationWatchdogBatchSize: options.sweepBatchSize,
    adsActivationWatchdogIntervalMs: options.sweepIntervalMs ?? 0,
    adsActivationLeaseMs: options.activationLeaseMs,
  })

  const headers = (id: string) => ({ 'x-test-api-key-id': id })
  async function createGrant(
    executorApiKeyId = 'key_executor',
    manifest: AdsActivationManifest = MANIFEST,
    versionPolicy?: 'exact' | 'refresh_semantically_unchanged',
  ) {
    return app.inject({
      method: 'POST',
      url: '/projects/acme/ads/activation-grants',
      headers: headers('key_approver'),
      payload: {
        manifest,
        executorApiKeyId,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        ...(versionPolicy ? { versionPolicy } : {}),
      },
    })
  }

  return {
    app,
    db,
    tmpDir,
    calls,
    entities,
    headers,
    createGrant,
    setAdAccountId: (adAccountId: string) => {
      credential.adAccountId = adAccountId
      db.update(adsConnections).set({ adAccountId }).where(eq(adsConnections.projectId, projectId)).run()
    },
    activationStarted,
    releaseBlockedActivation: () => releaseBlockedActivation?.(),
    setVerifyFailure: (value: boolean) => { verifyMustFail = value },
    failVerifyAfter: (successfulCalls: number) => { verifyFailureCountdown = successfulCalls },
  }
}

function seedUnknownActivation(
  ctx: ReturnType<typeof buildHarness>,
  grant: { id: string; manifestHash: string },
  manifest: AdsActivationManifest,
  suffix: string,
): string {
  const operationId = `operation_fleet_${suffix}`
  const operationKey = `beta:fleet:${suffix}`
  const checkpointAt = new Date(Date.now() - 60_000).toISOString()
  ctx.db.insert(adsOperations).values({
    id: operationId,
    projectId: 'project_activation',
    adAccountId: 'adacct_approved',
    operationKey,
    requestHash: hashAdsActivationOperationRequest({
      projectId: 'project_activation',
      adAccountId: 'adacct_approved',
      grantId: grant.id,
      manifestHash: grant.manifestHash,
      executorApiKeyId: 'key_executor',
    }),
    kind: AdsOperationKinds.campaign_tree_activate,
    state: AdsOperationStates.unknown,
    entityType: AdsActivationEntityTypes.campaign,
    entityId: manifest.campaign.id,
    errorCode: 'ADS_ACTIVATION_MANUAL_REMEDIATION_REQUIRED',
    errorMessage: 'Ambiguous activation requires containment',
    createdAt: checkpointAt,
    updatedAt: checkpointAt,
  }).run()
  ctx.db.update(adsActivationGrants).set({
    state: AdsActivationGrantStates.unknown,
    manifestHash: hashAdsActivationManifest(manifest),
    manifest,
    operationId,
    executionStartedAt: checkpointAt,
    updatedAt: checkpointAt,
  }).where(eq(adsActivationGrants.id, grant.id)).run()
  ctx.db.insert(adsOperationSteps).values(buildAdsActivationSteps(
    manifest,
    operationId,
    checkpointAt,
    (() => {
      let index = 0
      return () => `fleet_${suffix}_step_${++index}`
    })(),
  ).map((step) => ({
    ...step,
    state: AdsOperationStepStates.unknown,
    errorCode: 'ADS_ACTIVATION_MANUAL_REMEDIATION_REQUIRED',
    errorMessage: 'Ambiguous activation requires containment',
    remediation: 'Keep the campaign paused and reconcile manually',
    startedAt: checkpointAt,
    finishedAt: checkpointAt,
  }))).run()
  return operationId
}

function seedPendingActivation(
  ctx: ReturnType<typeof buildHarness>,
  grant: { id: string; manifestHash: string },
  manifest: AdsActivationManifest,
  suffix: string,
  checkpointAt: string,
): string {
  const operationId = `operation_pending_${suffix}`
  ctx.db.insert(adsOperations).values({
    id: operationId,
    projectId: 'project_activation',
    adAccountId: 'adacct_approved',
    operationKey: `beta:pending:${suffix}`,
    requestHash: hashAdsActivationOperationRequest({
      projectId: 'project_activation',
      adAccountId: 'adacct_approved',
      grantId: grant.id,
      manifestHash: grant.manifestHash,
      executorApiKeyId: 'key_executor',
    }),
    kind: AdsOperationKinds.campaign_tree_activate,
    state: AdsOperationStates.pending,
    entityType: AdsActivationEntityTypes.campaign,
    entityId: manifest.campaign.id,
    createdAt: checkpointAt,
    updatedAt: checkpointAt,
  }).run()
  ctx.db.update(adsActivationGrants).set({
    state: AdsActivationGrantStates.executing,
    operationId,
    executionStartedAt: checkpointAt,
    updatedAt: checkpointAt,
  }).where(eq(adsActivationGrants.id, grant.id)).run()
  ctx.db.insert(adsOperationSteps).values(buildAdsActivationSteps(
    manifest,
    operationId,
    checkpointAt,
    (() => {
      let index = 0
      return () => `pending_${suffix}_step_${++index}`
    })(),
  )).run()
  return operationId
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for activation recovery')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('ads approval-bound activation routes', () => {
  let ctx: ReturnType<typeof buildHarness>

  beforeEach(async () => {
    ctx = buildHarness()
    await ctx.app.ready()
  })

  afterEach(async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  })

  it('approves read-only, activates in dependency order, and replays without provider I/O', async () => {
    const approval = await ctx.createGrant()
    expect(approval.statusCode).toBe(200)
    const approved = JSON.parse(approval.body) as {
      grant: { id: string; adAccountId: string; manifestHash: string; state: string }
    }
    expect(approved.grant.state).toBe('approved')
    expect(approved.grant.adAccountId).toBe('adacct_approved')
    expect(ctx.calls.some((call) => call.startsWith('activate:') || call.startsWith('pause:'))).toBe(false)

    ctx.calls.length = 0
    const payload = {
      operationKey: 'beta:activate:1',
      grantId: approved.grant.id,
      manifestHash: approved.grant.manifestHash,
    }
    const activated = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/campaigns/cmpn_approved/activate-tree',
      headers: ctx.headers('key_executor'),
      payload,
    })
    expect(activated.statusCode).toBe(200)
    expect(JSON.parse(activated.body)).toMatchObject({
      grant: { state: 'consumed' },
      operation: { state: 'succeeded', kind: 'campaign_tree_activate' },
      steps: [{ entityType: 'ad', state: 'active' }, { entityType: 'ad_group', state: 'active' }, { entityType: 'campaign', state: 'active' }],
    })
    expect(ctx.calls.filter((call) => call.startsWith('activate:'))).toEqual([
      'activate:ad:ad_approved',
      'activate:ad_group:adgrp_approved',
      'activate:campaign:cmpn_approved',
    ])

    ctx.calls.length = 0
    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/campaigns/cmpn_approved/activate-tree',
      headers: ctx.headers('key_executor'),
      payload,
    })
    expect(replay.statusCode).toBe(200)
    expect(ctx.calls).toEqual([])
    expect(ctx.db.select().from(adsOperations)
      .where(eq(adsOperations.operationKey, payload.operationKey)).all()).toHaveLength(1)
  })

  it('replays terminal activation receipts without a live provider credential check', async () => {
    const approval = await ctx.createGrant()
    const grant = JSON.parse(approval.body).grant as { id: string; manifestHash: string }
    const payload = {
      operationKey: 'beta:activate:terminal-offline-replay',
      grantId: grant.id,
      manifestHash: grant.manifestHash,
    }
    const activated = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/campaigns/cmpn_approved/activate-tree',
      headers: ctx.headers('key_executor'),
      payload,
    })
    expect(activated.statusCode).toBe(200)

    ctx.setVerifyFailure(true)
    ctx.calls.length = 0
    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/campaigns/cmpn_approved/activate-tree',
      headers: ctx.headers('key_executor'),
      payload,
    })
    expect(replay.statusCode).toBe(200)
    expect(JSON.parse(replay.body)).toMatchObject({
      grant: { state: AdsActivationGrantStates.consumed },
      operation: { state: AdsOperationStates.succeeded },
    })
    const resumed = await ctx.app.inject({
      method: 'POST',
      url: `/projects/acme/ads/operations/${payload.operationKey}/resume-activation`,
      headers: ctx.headers('key_executor'),
    })
    expect(resumed.statusCode).toBe(200)
    expect(JSON.parse(resumed.body)).toMatchObject({
      operation: { state: AdsOperationStates.succeeded },
    })
    expect(ctx.calls).toEqual([])
  })

  it('releases a pure provider-read failure and resumes the same grant and operation key', async () => {
    const approval = await ctx.createGrant()
    const grant = JSON.parse(approval.body).grant as { id: string; manifestHash: string }
    const payload = {
      operationKey: 'beta:retryable-read:1',
      grantId: grant.id,
      manifestHash: grant.manifestHash,
    }
    ctx.failVerifyAfter(1)

    const interrupted = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/campaigns/cmpn_approved/activate-tree',
      headers: ctx.headers('key_executor'),
      payload,
    })

    expect(interrupted.statusCode).toBe(502)
    expect(interrupted.body).not.toContain('sk-secret')
    const pending = ctx.db.select().from(adsOperations)
      .where(eq(adsOperations.operationKey, payload.operationKey)).get()!
    expect(pending).toMatchObject({
      state: AdsOperationStates.pending,
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    expect(ctx.db.select().from(adsActivationGrants)
      .where(eq(adsActivationGrants.id, grant.id)).get()?.state)
      .toBe(AdsActivationGrantStates.executing)
    expect(ctx.db.select().from(adsOperationSteps)
      .where(eq(adsOperationSteps.operationId, pending.id)).all()
      .every((step) => step.state === AdsOperationStepStates.pending)).toBe(true)
    expect(ctx.calls.some((call) => call.startsWith('activate:'))).toBe(false)

    const resumed = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/campaigns/cmpn_approved/activate-tree',
      headers: ctx.headers('key_executor'),
      payload,
    })
    expect(resumed.statusCode).toBe(200)
    expect(JSON.parse(resumed.body)).toMatchObject({
      grant: { state: AdsActivationGrantStates.consumed },
      operation: { id: pending.id, state: AdsOperationStates.succeeded },
    })
  })

  it('watchdog-resumes a safely suspended activation without another HTTP request', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildHarness({ sweepIntervalMs: 10 })
    await ctx.app.ready()

    const approval = await ctx.createGrant()
    const grant = JSON.parse(approval.body).grant as { id: string; manifestHash: string }
    ctx.failVerifyAfter(1)
    const interrupted = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/campaigns/cmpn_approved/activate-tree',
      headers: ctx.headers('key_executor'),
      payload: {
        operationKey: 'beta:watchdog:1',
        grantId: grant.id,
        manifestHash: grant.manifestHash,
      },
    })
    expect(interrupted.statusCode).toBe(502)

    await waitForCondition(() => ctx.db.select().from(adsOperations)
      .where(eq(adsOperations.operationKey, 'beta:watchdog:1')).get()?.state
      === AdsOperationStates.succeeded)
    expect(ctx.db.select().from(adsActivationGrants)
      .where(eq(adsActivationGrants.id, grant.id)).get()?.state)
      .toBe(AdsActivationGrantStates.consumed)
    expect(ctx.calls.filter((call) => call.startsWith('activate:'))).toEqual([
      'activate:ad:ad_approved',
      'activate:ad_group:adgrp_approved',
      'activate:campaign:cmpn_approved',
    ])
    expect(ctx.calls.some((call) => call.startsWith('pause:'))).toBe(false)
  })

  it('does not block Fastify readiness while startup recovery waits on the provider', async () => {
    const approval = await ctx.createGrant()
    const grant = JSON.parse(approval.body).grant as { id: string; manifestHash: string }
    ctx.failVerifyAfter(1)
    const interrupted = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/campaigns/cmpn_approved/activate-tree',
      headers: ctx.headers('key_executor'),
      payload: {
        operationKey: 'beta:watchdog:nonblocking-ready',
        grantId: grant.id,
        manifestHash: grant.manifestHash,
      },
    })
    expect(interrupted.statusCode).toBe(502)

    let signalRecoveryStarted: (() => void) | undefined
    let releaseRecovery: (() => void) | undefined
    const recoveryStarted = new Promise<void>((resolve) => {
      signalRecoveryStarted = resolve
    })
    const recoveryBlocked = new Promise<void>((resolve) => {
      releaseRecovery = resolve
    })
    const watchdogApp = Fastify()
    watchdogApp.decorate('db', ctx.db)
    registerAdsActivationRoutes(watchdogApp, {
      watchdogIntervalMs: 1_000,
      resolveRuntime: async () => {
        signalRecoveryStarted?.()
        await recoveryBlocked
        throw new Error('provider remained unavailable')
      },
      toOperationDto: (row) => adsOperationDtoSchema.parse(row),
    })

    const ready = await Promise.race([
      watchdogApp.ready().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ])
    expect(ready).toBe(true)
    await recoveryStarted
    releaseRecovery?.()
    await watchdogApp.close()
  })

  it('revokes an executing activation, prevents later steps, and verifies rollback', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildHarness({ blockAdActivation: true, sweepIntervalMs: 60_000 })
    await ctx.app.ready()

    const approval = await ctx.createGrant()
    const grant = JSON.parse(approval.body).grant as { id: string; manifestHash: string }
    const activation = ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/campaigns/cmpn_approved/activate-tree',
      headers: ctx.headers('key_executor'),
      payload: {
        operationKey: 'beta:revoke-running:1',
        grantId: grant.id,
        manifestHash: grant.manifestHash,
      },
    })
    await ctx.activationStarted

    const revocation = await ctx.app.inject({
      method: 'POST',
      url: `/projects/acme/ads/activation-grants/${grant.id}/revoke`,
      headers: ctx.headers('key_approver'),
    })
    expect(revocation.statusCode, revocation.body).toBe(200)
    expect(JSON.parse(revocation.body).grant).toMatchObject({
      state: AdsActivationGrantStates.executing,
      revocationRequestedAt: expect.any(String),
    })
    await waitForCondition(() => ctx.calls.includes('pause:campaign:cmpn_approved'))
    ctx.releaseBlockedActivation()

    const response = await activation
    expect(response.statusCode).toBe(409)
    const operation = ctx.db.select().from(adsOperations)
      .where(eq(adsOperations.operationKey, 'beta:revoke-running:1')).get()!
    expect(operation.state).toBe(AdsOperationStates.failed)
    expect(ctx.db.select().from(adsActivationGrants)
      .where(eq(adsActivationGrants.id, grant.id)).get()?.state)
      .toBe(AdsActivationGrantStates.consumed)
    expect(ctx.calls.filter((call) => call.startsWith('activate:'))).toEqual([
      'activate:ad:ad_approved',
    ])
    expect(ctx.calls.filter((call) => call.startsWith('pause:'))).toEqual([
      'pause:campaign:cmpn_approved',
      'pause:ad:ad_approved',
    ])
    expect([...ctx.entities.values()].every((entity) => entity.status === 'paused')).toBe(true)

    const replayedRevocation = await ctx.app.inject({
      method: 'POST',
      url: `/projects/acme/ads/activation-grants/${grant.id}/revoke`,
      headers: ctx.headers('key_approver'),
    })
    expect(replayedRevocation.statusCode).toBe(200)
    expect(JSON.parse(replayedRevocation.body).grant).toMatchObject({
      state: AdsActivationGrantStates.consumed,
      revocationRequestedAt: expect.any(String),
    })
  })

  it('keeps grant issuance/revocation human-only and enforces the distinct executor key', async () => {
    const executorCannotApprove = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/activation-grants',
      headers: ctx.headers('key_executor'),
      payload: {
        manifest: MANIFEST,
        executorApiKeyId: 'key_executor',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    })
    expect(executorCannotApprove.statusCode).toBe(403)

    expect((await ctx.createGrant('key_approver')).statusCode).toBe(400)
    expect((await ctx.createGrant('key_wrong_scope')).statusCode).toBe(403)

    const approval = await ctx.createGrant()
    const grant = JSON.parse(approval.body).grant as { id: string; manifestHash: string }
    const nonEmpty = await ctx.app.inject({
      method: 'POST',
      url: `/projects/acme/ads/activation-grants/${grant.id}/revoke`,
      headers: ctx.headers('key_approver'),
      payload: { force: true },
    })
    expect(nonEmpty.statusCode).toBe(400)

    const revoked = await ctx.app.inject({
      method: 'POST',
      url: `/projects/acme/ads/activation-grants/${grant.id}/revoke`,
      headers: ctx.headers('key_approver'),
    })
    expect(revoked.statusCode).toBe(200)
    expect(JSON.parse(revoked.body).grant.state).toBe('revoked')
    expect((await ctx.app.inject({
      method: 'POST',
      url: `/projects/acme/ads/activation-grants/${grant.id}/revoke`,
      headers: ctx.headers('key_approver'),
    })).statusCode).toBe(200)

    const approverCannotActivate = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/campaigns/cmpn_approved/activate-tree',
      headers: ctx.headers('key_approver'),
      payload: { operationKey: 'beta:wrong-key', grantId: grant.id, manifestHash: grant.manifestHash },
    })
    expect(approverCannotActivate.statusCode).toBe(403)
  })

  it('returns the canonical live receipt to a concurrent replay without a second mutation', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildHarness({ blockAdActivation: true })
    await ctx.app.ready()
    const approval = await ctx.createGrant()
    const grant = JSON.parse(approval.body).grant as { id: string; manifestHash: string }
    ctx.calls.length = 0
    const request = {
      method: 'POST' as const,
      url: '/projects/acme/ads/campaigns/cmpn_approved/activate-tree',
      headers: ctx.headers('key_executor'),
      payload: {
        operationKey: 'beta:activate:concurrent',
        grantId: grant.id,
        manifestHash: grant.manifestHash,
      },
    }

    const firstPromise = ctx.app.inject(request)
    await ctx.activationStarted
    const concurrent = await ctx.app.inject(request)
    expect(concurrent.statusCode).toBe(200)
    expect(JSON.parse(concurrent.body)).toMatchObject({
      grant: { state: 'executing' },
      operation: { state: 'pending' },
    })
    expect(ctx.calls.filter((call) => call === 'activate:ad:ad_approved')).toHaveLength(1)

    ctx.releaseBlockedActivation()
    const first = await firstPromise
    expect(first.statusCode).toBe(200)
    expect(JSON.parse(first.body).operation.state).toBe('succeeded')
    expect(ctx.db.select().from(adsOperations)
      .where(eq(adsOperations.operationKey, 'beta:activate:concurrent')).all()).toHaveLength(1)
    expect(ctx.calls.filter((call) => call.startsWith('activate:'))).toEqual([
      'activate:ad:ad_approved',
      'activate:ad_group:adgrp_approved',
      'activate:campaign:cmpn_approved',
    ])
  })

  it('heartbeats a blocked provider mutation so its short test lease cannot be stolen', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildHarness({
      activationLeaseMs: 1_000,
      blockAdActivation: true,
    })
    await ctx.app.ready()
    const approval = await ctx.createGrant()
    const grant = JSON.parse(approval.body).grant as { id: string; manifestHash: string }
    const request = {
      method: 'POST' as const,
      url: '/projects/acme/ads/campaigns/cmpn_approved/activate-tree',
      headers: ctx.headers('key_executor'),
      payload: {
        operationKey: 'beta:activate:heartbeat',
        grantId: grant.id,
        manifestHash: grant.manifestHash,
      },
    }

    const firstPromise = ctx.app.inject(request)
    await ctx.activationStarted
    await new Promise((resolve) => setTimeout(resolve, 1_250))

    const concurrent = await ctx.app.inject(request)
    expect(concurrent.statusCode).toBe(200)
    expect(JSON.parse(concurrent.body)).toMatchObject({
      grant: { state: AdsActivationGrantStates.executing },
      operation: { state: AdsOperationStates.pending },
    })
    expect(ctx.calls.filter((call) => call === 'activate:ad:ad_approved')).toHaveLength(1)

    ctx.releaseBlockedActivation()
    const first = await firstPromise
    expect(first.statusCode).toBe(200)
    expect(JSON.parse(first.body).operation.state).toBe(AdsOperationStates.succeeded)
    expect(ctx.calls.filter((call) => call === 'activate:ad:ad_approved')).toHaveLength(1)
  })

  it('binds execution to the approved key and consumes a grant only once', async () => {
    const approval = await ctx.createGrant()
    const grant = JSON.parse(approval.body).grant as { id: string; manifestHash: string }
    const request = {
      operationKey: 'beta:activate:executor-bound',
      grantId: grant.id,
      manifestHash: grant.manifestHash,
    }

    const wrongExecutor = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/campaigns/cmpn_approved/activate-tree',
      headers: ctx.headers('key_other_executor'),
      payload: request,
    })
    expect(wrongExecutor.statusCode).toBe(403)
    expect(ctx.db.select().from(adsOperations).all()).toHaveLength(0)
    expect(ctx.calls.some((call) => call.startsWith('activate:') || call.startsWith('pause:'))).toBe(false)

    const activated = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/campaigns/cmpn_approved/activate-tree',
      headers: ctx.headers('key_executor'),
      payload: request,
    })
    expect(activated.statusCode).toBe(200)
    ctx.calls.length = 0

    const reused = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/campaigns/cmpn_approved/activate-tree',
      headers: ctx.headers('key_executor'),
      payload: { ...request, operationKey: 'beta:activate:reuse-denied' },
    })
    expect(reused.statusCode).toBe(409)
    expect(reused.body).toContain('ADS_ACTIVATION_GRANT_USED')
    expect(ctx.calls).toEqual([])
    expect(ctx.db.select().from(adsOperations).all()).toHaveLength(1)
  })

  it('rejects an operation-key hash conflict without consuming the grant', async () => {
    const approval = await ctx.createGrant()
    const grant = JSON.parse(approval.body).grant as { id: string; manifestHash: string }
    const operationKey = 'beta:activate:conflicting-receipt'
    const now = new Date().toISOString()
    ctx.db.insert(adsOperations).values({
      id: 'operation_existing_conflict',
      projectId: 'project_activation',
      adAccountId: 'adacct_approved',
      operationKey,
      requestHash: 'f'.repeat(64),
      kind: 'campaign_pause',
      state: AdsOperationStates.succeeded,
      entityType: AdsActivationEntityTypes.campaign,
      entityId: 'cmpn_other',
      createdAt: now,
      updatedAt: now,
    }).run()
    ctx.calls.length = 0

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/campaigns/cmpn_approved/activate-tree',
      headers: ctx.headers('key_executor'),
      payload: { operationKey, grantId: grant.id, manifestHash: grant.manifestHash },
    })

    expect(response.statusCode).toBe(409)
    expect(ctx.calls.some((call) => call.startsWith('activate:') || call.startsWith('pause:'))).toBe(false)
    expect(ctx.db.select().from(adsActivationGrants)
      .where(eq(adsActivationGrants.id, grant.id)).get()?.state).toBe(AdsActivationGrantStates.approved)
  })

  it('resumes an expired lease from an executing checkpoint using GET only', async () => {
    const approval = await ctx.createGrant()
    const grant = JSON.parse(approval.body).grant as { id: string; manifestHash: string }
    const operationId = 'operation_restart_recovery'
    const operationKey = 'beta:activate:restart-recovery'
    const checkpointAt = '2026-07-18T15:00:00.000Z'
    const requestHash = hashAdsActivationOperationRequest({
      projectId: 'project_activation',
      adAccountId: 'adacct_approved',
      grantId: grant.id,
      manifestHash: grant.manifestHash,
      executorApiKeyId: 'key_executor',
    })
    const steps = buildAdsActivationSteps(
      MANIFEST,
      operationId,
      checkpointAt,
      (() => {
        let index = 0
        return () => `restart_step_${++index}`
      })(),
    ).map((step) => step.entityType === AdsActivationEntityTypes.ad
      ? {
          ...step,
          state: AdsOperationStepStates.executing,
          startedAt: checkpointAt,
          updatedAt: checkpointAt,
        }
      : step)
    ctx.db.insert(adsOperations).values({
      id: operationId,
      projectId: 'project_activation',
      adAccountId: 'adacct_approved',
      operationKey,
      requestHash,
      kind: AdsOperationKinds.campaign_tree_activate,
      state: AdsOperationStates.pending,
      entityType: AdsActivationEntityTypes.campaign,
      entityId: MANIFEST.campaign.id,
      leaseOwner: 'dead-worker',
      leaseExpiresAt: '2026-07-18T15:05:00.000Z',
      createdAt: checkpointAt,
      updatedAt: checkpointAt,
    }).run()
    ctx.db.update(adsActivationGrants).set({
      state: AdsActivationGrantStates.executing,
      operationId,
      executionStartedAt: checkpointAt,
      updatedAt: checkpointAt,
    }).where(eq(adsActivationGrants.id, grant.id)).run()
    ctx.db.insert(adsOperationSteps).values(steps).run()
    ctx.entities.set('ad_approved', {
      id: 'ad_approved',
      adGroupId: 'adgrp_approved',
      reviewStatus: 'approved',
      status: 'active',
      updatedAt: 31,
    })
    ctx.calls.length = 0

    const wrongExecutor = await ctx.app.inject({
      method: 'POST',
      url: `/projects/acme/ads/operations/${operationKey}/resume-activation`,
      headers: ctx.headers('key_other_executor'),
    })
    expect(wrongExecutor.statusCode).toBe(403)
    const nonEmpty = await ctx.app.inject({
      method: 'POST',
      url: `/projects/acme/ads/operations/${operationKey}/resume-activation`,
      headers: ctx.headers('key_executor'),
      payload: {},
    })
    expect(nonEmpty.statusCode).toBe(400)
    expect(ctx.calls).toEqual([])

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/projects/acme/ads/operations/${operationKey}/resume-activation`,
      headers: ctx.headers('key_executor'),
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      grant: { state: AdsActivationGrantStates.consumed },
      operation: { state: AdsOperationStates.succeeded },
      steps: [
        { entityType: AdsActivationEntityTypes.ad, state: AdsOperationStepStates.active },
        { entityType: AdsActivationEntityTypes.ad_group, state: AdsOperationStepStates.active },
        { entityType: AdsActivationEntityTypes.campaign, state: AdsOperationStepStates.active },
      ],
    })
    expect(ctx.calls.filter((call) => call.startsWith('activate:'))).toEqual([
      'activate:ad_group:adgrp_approved',
      'activate:campaign:cmpn_approved',
    ])
    expect(ctx.calls).toContain('list:ads:adgrp_approved')
  })

  it('maps stale approval preflight failures without issuing a grant', async () => {
    ctx.entities.get('ad_approved')!.updatedAt = 31
    const response = await ctx.createGrant()
    expect(response.statusCode).toBe(400)
    expect(response.body).toContain('ADS_ACTIVATION_ENTITY_STALE')
    expect(ctx.db.select().from(adsActivationGrants).all()).toHaveLength(0)
  })

  it('refreshes review-only versions only when the provider tree matches its create receipts', async () => {
    ctx.entities.set('cmpn_approved', {
      id: 'cmpn_approved',
      name: 'Approved campaign',
      description: null,
      status: AdsEntityStatuses.paused,
      updatedAt: 10,
      startTime: null,
      endTime: null,
      lifetimeSpendLimitMicros: 10_000_000,
      locationIds: ['1000232'],
      biddingType: 'clicks',
      conversionEventSettingIds: ['event_1'],
    })
    ctx.entities.set('adgrp_approved', {
      id: 'adgrp_approved',
      campaignId: 'cmpn_approved',
      name: 'Approved group',
      description: null,
      status: AdsEntityStatuses.paused,
      updatedAt: 20,
      contextHints: ['buyer question'],
      maxBidMicros: 1_000_000,
      billingEventType: 'click',
    })
    ctx.entities.set('ad_approved', {
      id: 'ad_approved',
      adGroupId: 'adgrp_approved',
      name: 'Approved ad',
      creative: {
        title: 'See your AI search gaps',
        body: 'Get a free audit.',
        targetUrl: 'https://canonry.ai/audit',
        fileId: 'file_1',
      },
      reviewStatus: 'approved',
      status: AdsEntityStatuses.paused,
      updatedAt: 31,
    })
    const now = new Date().toISOString()
    ctx.db.insert(adsOperations).values([
      {
        id: 'create_campaign',
        projectId: 'project_activation',
        adAccountId: 'adacct_approved',
        operationKey: 'create:campaign',
        requestHash: 'hash_campaign',
        kind: AdsOperationKinds.campaign_create,
        state: AdsOperationStates.succeeded,
        entityType: AdsActivationEntityTypes.campaign,
        entityId: 'cmpn_approved',
        upstreamUpdatedAt: 10,
        reconcileStrategy: AdsReconcileStrategies.create_fingerprint,
        reconcileFields: {
          name: 'Approved campaign',
          description: null,
          status: AdsEntityStatuses.paused,
          startTime: null,
          endTime: null,
          lifetimeSpendLimitMicros: 10_000_000,
          locationIds: ['1000232'],
          biddingType: 'clicks',
          conversionEventSettingIds: ['event_1'],
        },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'create_group',
        projectId: 'project_activation',
        adAccountId: 'adacct_approved',
        operationKey: 'create:group',
        requestHash: 'hash_group',
        kind: AdsOperationKinds.ad_group_create,
        state: AdsOperationStates.succeeded,
        entityType: AdsActivationEntityTypes.ad_group,
        entityId: 'adgrp_approved',
        upstreamUpdatedAt: 20,
        reconcileStrategy: AdsReconcileStrategies.create_fingerprint,
        reconcileFields: {
          campaignId: 'cmpn_approved',
          name: 'Approved group',
          description: null,
          status: AdsEntityStatuses.paused,
          contextHints: ['buyer question'],
          maxBidMicros: 1_000_000,
          billingEventType: 'click',
        },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'create_ad',
        projectId: 'project_activation',
        adAccountId: 'adacct_approved',
        operationKey: 'create:ad',
        requestHash: 'hash_ad',
        kind: AdsOperationKinds.ad_create,
        state: AdsOperationStates.succeeded,
        entityType: AdsActivationEntityTypes.ad,
        entityId: 'ad_approved',
        upstreamUpdatedAt: 30,
        reconcileStrategy: AdsReconcileStrategies.create_fingerprint,
        reconcileFields: {
          adGroupId: 'adgrp_approved',
          name: 'Approved ad',
          status: AdsEntityStatuses.paused,
        },
        createdAt: now,
        updatedAt: now,
      },
    ]).run()

    const response = await ctx.createGrant(
      'key_executor',
      MANIFEST,
      'refresh_semantically_unchanged',
    )
    expect(response.statusCode, response.body).toBe(200)
    const grant = JSON.parse(response.body).grant
    expect(grant.manifest.campaign.adGroups[0].ads[0].expectedUpdatedAt).toBe(31)
    expect(grant.manifestHash).toBe(hashAdsActivationManifest(grant.manifest))

    ctx.entities.get('ad_approved')!.name = 'Changed outside the approved plan'
    const rejected = await ctx.createGrant(
      'key_executor',
      MANIFEST,
      'refresh_semantically_unchanged',
    )
    expect(rejected.statusCode).toBe(400)
    expect(rejected.body).toContain('ADS_ACTIVATION_ENTITY_MISMATCH')
  })

  it('refuses to consume a grant after the project reconnects to another ad account', async () => {
    const approval = await ctx.createGrant()
    const grant = JSON.parse(approval.body).grant as {
      id: string
      adAccountId: string
      manifestHash: string
    }
    expect(grant.adAccountId).toBe('adacct_approved')

    ctx.setAdAccountId('adacct_reconnected')
    ctx.calls.length = 0
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/campaigns/cmpn_approved/activate-tree',
      headers: ctx.headers('key_executor'),
      payload: {
        operationKey: 'beta:activate:wrong-account',
        grantId: grant.id,
        manifestHash: grant.manifestHash,
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.body).toContain('ADS_ACTIVATION_GRANT_ACCOUNT_MISMATCH')
    expect(ctx.calls.some((call) => call.startsWith('activate:') || call.startsWith('pause:'))).toBe(false)
    expect(ctx.db.select().from(adsOperations).all()).toHaveLength(0)
    expect(ctx.db.select().from(adsActivationGrants)
      .where(eq(adsActivationGrants.id, grant.id)).get()?.state).toBe('approved')
  })

  it('atomically audits a grant that expires when execution claims it', async () => {
    const approval = await ctx.createGrant()
    const grant = JSON.parse(approval.body).grant as { id: string; manifestHash: string }
    ctx.db.update(adsActivationGrants).set({
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    }).where(eq(adsActivationGrants.id, grant.id)).run()

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/campaigns/cmpn_approved/activate-tree',
      headers: ctx.headers('key_executor'),
      payload: {
        operationKey: 'beta:activate:expired',
        grantId: grant.id,
        manifestHash: grant.manifestHash,
      },
    })

    expect(response.statusCode).toBe(409)
    expect(ctx.db.select().from(adsOperations).all()).toHaveLength(0)
    expect(ctx.db.select().from(adsActivationGrants)
      .where(eq(adsActivationGrants.id, grant.id)).get()?.state).toBe('expired')
    const expiryAudit = ctx.db.select().from(auditLog).where(and(
      eq(auditLog.action, 'ads.activation_grant.expired'),
      eq(auditLog.entityId, grant.id),
    )).get()
    expect(expiryAudit).toMatchObject({ projectId: 'project_activation' })
    expect(JSON.parse(expiryAudit!.diff!)).toEqual({ executorApiKeyId: 'key_executor' })
  })

  it('pauses the campaign when a descendant appears after the final pre-activation check', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildHarness({ injectDescendantAfterCampaignActivation: true })
    await ctx.app.ready()
    const approval = await ctx.createGrant()
    const grant = JSON.parse(approval.body).grant as { id: string; manifestHash: string }

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/campaigns/cmpn_approved/activate-tree',
      headers: ctx.headers('key_executor'),
      payload: {
        operationKey: 'beta:activate:late-descendant',
        grantId: grant.id,
        manifestHash: grant.manifestHash,
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.body).toContain('ADS_ACTIVATION_ENTITY_MISMATCH')
    expect(ctx.calls).toContain('pause:campaign:cmpn_approved')
    expect(ctx.entities.get('cmpn_approved')?.status).toBe('paused')
    expect(ctx.db.select().from(adsOperations)
      .where(eq(adsOperations.operationKey, 'beta:activate:late-descendant')).get()?.state)
      .toBe(AdsOperationStates.failed)
  })

  it('rolls back instead of releasing a lease when post-activation enumeration fails', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildHarness({ failDescendantReadAfterCampaignActivation: true })
    await ctx.app.ready()
    const approval = await ctx.createGrant()
    const grant = JSON.parse(approval.body).grant as { id: string; manifestHash: string }

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/campaigns/cmpn_approved/activate-tree',
      headers: ctx.headers('key_executor'),
      payload: {
        operationKey: 'beta:activate:post-enumeration-read',
        grantId: grant.id,
        manifestHash: grant.manifestHash,
      },
    })

    expect(response.statusCode).toBe(502)
    expect(response.body).not.toContain('sk-secret')
    expect(ctx.calls).toContain('pause:campaign:cmpn_approved')
    expect(ctx.entities.get('cmpn_approved')?.status).toBe('paused')
    expect(ctx.db.select().from(adsOperations)
      .where(eq(adsOperations.operationKey, 'beta:activate:post-enumeration-read')).get())
      .toMatchObject({
        state: AdsOperationStates.failed,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
  })

  it('safety-pauses every urgent campaign boundary before descendant cleanup', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildHarness({ sweepIntervalMs: 60_000 })
    await ctx.app.ready()
    const secondManifest = {
      campaign: {
        id: 'cmpn_second',
        expectedUpdatedAt: 110,
        adGroups: [{
          id: 'adgrp_second',
          expectedUpdatedAt: 120,
          ads: [{ id: 'ad_second', expectedUpdatedAt: 130 }],
        }],
      },
    } satisfies AdsActivationManifest
    ctx.entities.set('cmpn_second', {
      id: 'cmpn_second',
      status: 'paused',
      updatedAt: 110,
    })
    ctx.entities.set('adgrp_second', {
      id: 'adgrp_second',
      campaignId: 'cmpn_second',
      status: 'paused',
      updatedAt: 120,
    })
    ctx.entities.set('ad_second', {
      id: 'ad_second',
      adGroupId: 'adgrp_second',
      reviewStatus: 'approved',
      status: 'paused',
      updatedAt: 130,
    })
    const firstApproval = await ctx.createGrant()
    const firstGrant = JSON.parse(firstApproval.body).grant as { id: string; manifestHash: string }
    const secondApproval = await ctx.createGrant('key_executor', secondManifest)
    expect(secondApproval.statusCode, secondApproval.body).toBe(200)
    const secondGrant = JSON.parse(secondApproval.body).grant as { id: string; manifestHash: string }

    const firstOperationId = seedUnknownActivation(ctx, firstGrant, MANIFEST, 'first')
    const secondOperationId = seedUnknownActivation(ctx, secondGrant, secondManifest, 'second')
    for (const entity of ctx.entities.values()) entity.status = 'active'
    ctx.calls.length = 0

    const cancellation = await ctx.app.inject({
      method: 'POST',
      url: `/projects/acme/ads/activation-grants/${firstGrant.id}/revoke`,
      headers: ctx.headers('key_approver'),
    })
    expect(cancellation.statusCode, cancellation.body).toBe(200)
    await waitForCondition(() => [firstOperationId, secondOperationId].every((id) => (
      ctx.db.select().from(adsOperations).where(eq(adsOperations.id, id)).get()?.lastReconciledAt
      !== null
    )))

    const pauseCalls = ctx.calls.filter((call) => call.startsWith('pause:'))
    const firstDescendantPause = pauseCalls.findIndex((call) => (
      call.startsWith('pause:ad_group:') || call.startsWith('pause:ad:')
    ))
    expect(firstDescendantPause).toBeGreaterThanOrEqual(2)
    expect(pauseCalls.indexOf('pause:campaign:cmpn_approved')).toBeLessThan(firstDescendantPause)
    expect(pauseCalls.indexOf('pause:campaign:cmpn_second')).toBeLessThan(firstDescendantPause)
  })

  it('rotates past a previously contained revocation marker with a one-receipt batch', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildHarness({ sweepBatchSize: 1, sweepIntervalMs: 20 })
    await ctx.app.ready()
    const laterManifest = {
      campaign: {
        id: 'cmpn_later',
        expectedUpdatedAt: 210,
        adGroups: [{
          id: 'adgrp_later',
          expectedUpdatedAt: 220,
          ads: [{ id: 'ad_later', expectedUpdatedAt: 230 }],
        }],
      },
    } satisfies AdsActivationManifest
    ctx.entities.set('cmpn_later', {
      id: 'cmpn_later',
      status: 'paused',
      updatedAt: 210,
    })
    ctx.entities.set('adgrp_later', {
      id: 'adgrp_later',
      campaignId: 'cmpn_later',
      status: 'paused',
      updatedAt: 220,
    })
    ctx.entities.set('ad_later', {
      id: 'ad_later',
      adGroupId: 'adgrp_later',
      reviewStatus: 'approved',
      status: 'paused',
      updatedAt: 230,
    })
    const markedApproval = await ctx.createGrant()
    const markedGrant = JSON.parse(markedApproval.body).grant as { id: string; manifestHash: string }
    const laterApproval = await ctx.createGrant('key_executor', laterManifest)
    expect(laterApproval.statusCode, laterApproval.body).toBe(200)
    const laterGrant = JSON.parse(laterApproval.body).grant as { id: string; manifestHash: string }
    const markedOperationId = seedUnknownActivation(ctx, markedGrant, MANIFEST, 'rotation_marked')
    seedUnknownActivation(ctx, laterGrant, laterManifest, 'rotation_later')
    for (const entity of ctx.entities.values()) entity.status = 'active'
    ctx.calls.length = 0

    const cancellation = await ctx.app.inject({
      method: 'POST',
      url: `/projects/acme/ads/activation-grants/${markedGrant.id}/revoke`,
      headers: ctx.headers('key_approver'),
    })
    expect(cancellation.statusCode, cancellation.body).toBe(200)
    await waitForCondition(() => (
      ctx.db.select().from(adsOperations)
        .where(eq(adsOperations.id, markedOperationId)).get()?.lastReconciledAt !== null
    ))
    await waitForCondition(() => ctx.calls.includes('pause:campaign:cmpn_later'))

    const markedPause = ctx.calls.indexOf('pause:campaign:cmpn_approved')
    const laterPause = ctx.calls.indexOf('pause:campaign:cmpn_later')
    expect(markedPause).toBeGreaterThanOrEqual(0)
    expect(laterPause).toBeGreaterThan(markedPause)
    expect(ctx.db.select().from(adsActivationGrants)
      .where(eq(adsActivationGrants.id, markedGrant.id)).get()).toMatchObject({
      state: AdsActivationGrantStates.unknown,
      revocationRequestedAt: expect.any(String),
    })
  })

  it('rotates recovery past a retryable pending receipt with a one-receipt batch', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildHarness({ sweepBatchSize: 1, sweepIntervalMs: 20 })
    await ctx.app.ready()
    const unknownManifest = {
      campaign: {
        id: 'cmpn_recovery_unknown',
        expectedUpdatedAt: 310,
        adGroups: [{
          id: 'adgrp_recovery_unknown',
          expectedUpdatedAt: 320,
          ads: [{ id: 'ad_recovery_unknown', expectedUpdatedAt: 330 }],
        }],
      },
    } satisfies AdsActivationManifest
    ctx.entities.set('cmpn_recovery_unknown', {
      id: 'cmpn_recovery_unknown',
      status: 'paused',
      updatedAt: 310,
    })
    ctx.entities.set('adgrp_recovery_unknown', {
      id: 'adgrp_recovery_unknown',
      campaignId: 'cmpn_recovery_unknown',
      status: 'paused',
      updatedAt: 320,
    })
    ctx.entities.set('ad_recovery_unknown', {
      id: 'ad_recovery_unknown',
      adGroupId: 'adgrp_recovery_unknown',
      reviewStatus: 'approved',
      status: 'paused',
      updatedAt: 330,
    })
    const pendingApproval = await ctx.createGrant()
    const pendingGrant = JSON.parse(pendingApproval.body).grant as { id: string; manifestHash: string }
    const unknownApproval = await ctx.createGrant('key_executor', unknownManifest)
    expect(unknownApproval.statusCode, unknownApproval.body).toBe(200)
    const unknownGrant = JSON.parse(unknownApproval.body).grant as { id: string; manifestHash: string }
    const pendingAt = new Date(Date.now() - 120_000).toISOString()
    const pendingOperationId = seedPendingActivation(
      ctx,
      pendingGrant,
      MANIFEST,
      'cursor_fairness',
      pendingAt,
    )
    const unknownOperationId = seedUnknownActivation(
      ctx,
      unknownGrant,
      unknownManifest,
      'cursor_fairness',
    )
    const unknownAt = ctx.db.select().from(adsOperations)
      .where(eq(adsOperations.id, unknownOperationId)).get()!.updatedAt
    ctx.db.update(adsOperations).set({
      lastReconciledAt: new Date(Date.now() - 30_000).toISOString(),
    }).where(eq(adsOperations.id, unknownOperationId)).run()
    ctx.setVerifyFailure(true)

    await waitForCondition(() => (
      ctx.db.select().from(adsOperations)
        .where(eq(adsOperations.id, pendingOperationId)).get()?.updatedAt !== pendingAt
    ))
    await waitForCondition(() => (
      ctx.db.select().from(adsOperations)
        .where(eq(adsOperations.id, unknownOperationId)).get()?.updatedAt !== unknownAt
    ))

    expect(ctx.db.select().from(adsOperations)
      .where(eq(adsOperations.id, pendingOperationId)).get()).toMatchObject({
      state: AdsOperationStates.pending,
      lastReconciledAt: null,
    })
    expect(ctx.db.select().from(adsOperations)
      .where(eq(adsOperations.id, unknownOperationId)).get()?.state)
      .toBe(AdsOperationStates.unknown)
  })

  it('keeps an ambiguous campaign activation unknown while the watchdog repeatedly safety-pauses it', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildHarness({
      failCampaignReadAfterActivation: true,
      sweepIntervalMs: 10,
    })
    await ctx.app.ready()
    const approval = await ctx.createGrant()
    const grant = JSON.parse(approval.body).grant as { id: string; manifestHash: string }
    ctx.calls.length = 0

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/projects/acme/ads/campaigns/cmpn_approved/activate-tree',
      headers: ctx.headers('key_executor'),
      payload: {
        operationKey: 'beta:activate:rollback',
        grantId: grant.id,
        manifestHash: grant.manifestHash,
      },
    })
    expect(response.statusCode).toBe(502)
    expect(response.body).not.toContain('sk-secret')
    expect(ctx.calls.filter((call) => call.startsWith('activate:'))).toEqual([
      'activate:ad:ad_approved',
      'activate:ad_group:adgrp_approved',
      'activate:campaign:cmpn_approved',
    ])

    const operation = ctx.db.select().from(adsOperations)
      .where(eq(adsOperations.operationKey, 'beta:activate:rollback')).get()
    expect(operation?.state).toBe('unknown')
    expect(ctx.db.select().from(adsActivationGrants)
      .where(eq(adsActivationGrants.id, grant.id)).get()?.state).toBe('unknown')
    expect(ctx.db.select().from(adsOperationSteps).where(and(
      eq(adsOperationSteps.operationId, operation!.id),
      eq(adsOperationSteps.state, 'rolled_back'),
    )).all()).toHaveLength(2)
    expect(ctx.db.select().from(adsOperationSteps).where(and(
      eq(adsOperationSteps.operationId, operation!.id),
      eq(adsOperationSteps.entityType, AdsActivationEntityTypes.campaign),
    )).get()?.state).toBe(AdsOperationStepStates.unknown)

    // Provider state can drift after approval. The safety sweeper must contain
    // the live tree it enumerates, not only ids preserved in the manifest.
    ctx.entities.set('adgrp_omitted', {
      id: 'adgrp_omitted',
      campaignId: 'cmpn_approved',
      status: 'active',
      updatedAt: 40,
    })
    ctx.entities.set('ad_omitted', {
      id: 'ad_omitted',
      adGroupId: 'adgrp_omitted',
      reviewStatus: 'approved',
      status: 'active',
      updatedAt: 50,
    })

    const cancellation = await ctx.app.inject({
      method: 'POST',
      url: `/projects/acme/ads/activation-grants/${grant.id}/revoke`,
      headers: ctx.headers('key_approver'),
    })
    expect(cancellation.statusCode, cancellation.body).toBe(200)
    expect(JSON.parse(cancellation.body).grant).toMatchObject({
      state: AdsActivationGrantStates.unknown,
      revocationRequestedAt: expect.any(String),
    })

    await waitForCondition(() => (
      ctx.db.select().from(adsOperations)
        .where(eq(adsOperations.id, operation!.id)).get()?.reconcileAttempts ?? 0
    ) > 0)
    expect(ctx.calls).toContain('pause:ad_group:adgrp_approved')
    expect(ctx.calls).toContain('pause:ad:ad_approved')
    expect(ctx.calls).toContain('pause:ad_group:adgrp_omitted')
    expect(ctx.calls).toContain('pause:ad:ad_omitted')
    expect([...ctx.entities.values()].every((entity) => entity.status === 'paused')).toBe(true)
    expect(ctx.db.select().from(adsOperations)
      .where(eq(adsOperations.id, operation!.id)).get()).toMatchObject({
      state: AdsOperationStates.unknown,
      reconcileAttempts: expect.any(Number),
      lastReconciledAt: expect.any(String),
    })
  })
})
