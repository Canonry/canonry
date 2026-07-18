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
  AdsOperationKinds,
  AdsOperationStates,
  AdsOperationStepStates,
  AppError,
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
  hashAdsActivationOperationRequest,
} from '../src/ads-activation.js'

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
  blockAdActivation?: boolean
  failCampaignReadAfterActivation?: boolean
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
  let campaignReadMustFail = false
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
    listAdGroups: async () => [],
    createAdGroup: unsupported,
    updateAdGroup: unsupported,
    pauseAdGroup: async (_key, id) => mutate('ad_group', id, 'paused'),
    activateAdGroup: async (_key, id) => mutate('ad_group', id, 'active'),
    getAd: async (_key, id) => read('ad', id),
    listAds: async () => [],
    createAd: unsupported,
    updateAd: unsupported,
    pauseAd: async (_key, id) => mutate('ad', id, 'paused'),
    activateAd: async (_key, id) => {
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
  })

  const headers = (id: string) => ({ 'x-test-api-key-id': id })
  async function createGrant(executorApiKeyId = 'key_executor') {
    return app.inject({
      method: 'POST',
      url: '/projects/acme/ads/activation-grants',
      headers: headers('key_approver'),
      payload: {
        manifest: MANIFEST,
        executorApiKeyId,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
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
    expect(ctx.calls.filter((call) => call === 'get:ad:ad_approved')).toHaveLength(3)
  })

  it('maps stale approval preflight failures without issuing a grant', async () => {
    ctx.entities.get('ad_approved')!.updatedAt = 31
    const response = await ctx.createGrant()
    expect(response.statusCode).toBe(400)
    expect(response.body).toContain('ADS_ACTIVATION_ENTITY_STALE')
    expect(ctx.db.select().from(adsActivationGrants).all()).toHaveLength(0)
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

  it('leaves an ambiguous campaign activation unknown while rolling back confirmed children', async () => {
    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
    ctx = buildHarness({ failCampaignReadAfterActivation: true })
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
    expect(ctx.calls.filter((call) => call.startsWith('activate:') || call.startsWith('pause:'))).toEqual([
      'activate:ad:ad_approved',
      'activate:ad_group:adgrp_approved',
      'activate:campaign:cmpn_approved',
      'pause:ad_group:adgrp_approved',
      'pause:ad:ad_approved',
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
  })
})
