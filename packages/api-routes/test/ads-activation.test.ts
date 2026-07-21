import { describe, expect, it } from 'vitest'
import {
  adsActivationGrantDtoSchema,
  adsOperationStepDtoSchema,
  AdsActivationEntityTypes,
  AdsActivationGrantStates,
  AdsOperationKinds,
  AdsOperationStates,
  AdsOperationStepStates,
  type AdsActivationEntityType,
  type AdsActivationManifest,
} from '@ainyc/canonry-contracts'
import {
  AdsActivationError,
  AdsActivationErrorCodes,
  buildAdsActivationSteps,
  enforceUnknownAdsActivationSafety,
  executeApprovedAdsActivation,
  hashAdsActivationManifest,
  hashAdsActivationOperationRequest,
  preflightAdsActivationApproval,
  refreshSemanticallyUnchangedAdsActivationManifest,
  serializeAdsActivationManifest,
  type AdsActivationClaimInput,
  type AdsActivationClaimResult,
  type AdsActivationEntitySnapshot,
  type AdsActivationFinishInput,
  type AdsActivationFinishResult,
  type AdsActivationGrantRecord,
  type AdsActivationOperationRecord,
  type AdsActivationProvider,
  type AdsActivationRequest,
  type AdsActivationStepRecord,
  type AdsActivationStepTransitionInput,
  type AdsActivationStepTransitionResult,
  type AdsActivationStore,
} from '../src/ads-activation.js'

const NOW = '2026-07-18T16:00:00.000Z'
const EXPIRES_AT = '2026-07-18T17:00:00.000Z'

const MANIFEST = {
  campaign: {
    id: 'cmpn_1',
    expectedUpdatedAt: 100,
    adGroups: [{
      id: 'adgrp_1',
      expectedUpdatedAt: 200,
      ads: [{ id: 'ad_1', expectedUpdatedAt: 300 }],
    }],
  },
} satisfies AdsActivationManifest

const MANIFEST_HASH = 'bd88a67550696759538d8176f1177689072cce74bddb2bf779c232f4cab623ea'
const OPERATION_HASH = 'c04aeb7538f70d96e767b8198e250cea7f2ccf80c359e3f6272537d563a81d2e'

function activationRequest(manifest: AdsActivationManifest = MANIFEST): AdsActivationRequest {
  return {
    projectId: 'project_1',
    adAccountId: 'adacct_1',
    operationKey: 'weekend:activate:1',
    grantId: 'grant_1',
    manifestHash: hashAdsActivationManifest(manifest),
    executorApiKeyId: 'key_executor',
    manifest,
  }
}

function entityKey(entityType: AdsActivationEntityType, entityId: string): string {
  return `${entityType}:${entityId}`
}

type ReadResult = AdsActivationEntitySnapshot | Error

class FakeProvider implements AdsActivationProvider {
  readonly calls: string[] = []
  readonly entities = new Map<string, AdsActivationEntitySnapshot>()
  readonly readQueues = new Map<string, ReadResult[]>()
  readonly pauseErrors = new Set<string>()
  afterActivate?: (entityType: AdsActivationEntityType, entityId: string) => void
  account = {
    id: 'adacct_1',
    reviewStatus: 'approved',
    integrityReviewStatus: 'approved',
    integrityDecision: 'allowed',
  }

  constructor() {
    this.setEntity(AdsActivationEntityTypes.campaign, {
      id: MANIFEST.campaign.id,
      status: 'paused',
      updatedAt: MANIFEST.campaign.expectedUpdatedAt,
    })
    const group = MANIFEST.campaign.adGroups[0]!
    this.setEntity(AdsActivationEntityTypes.ad_group, {
      id: group.id,
      campaignId: MANIFEST.campaign.id,
      status: 'paused',
      updatedAt: group.expectedUpdatedAt,
    })
    this.setEntity(AdsActivationEntityTypes.ad, {
      id: group.ads[0]!.id,
      adGroupId: group.id,
      reviewStatus: 'approved',
      status: 'paused',
      updatedAt: group.ads[0]!.expectedUpdatedAt,
    })
  }

  setEntity(entityType: AdsActivationEntityType, entity: AdsActivationEntitySnapshot): void {
    this.entities.set(entityKey(entityType, entity.id), entity)
  }

  queueReads(entityType: AdsActivationEntityType, entityId: string, ...results: ReadResult[]): void {
    this.readQueues.set(entityKey(entityType, entityId), [...results])
  }

  async getAccount() {
    this.calls.push('get:account')
    return { ...this.account }
  }

  async getCampaign(id: string) {
    return this.read(AdsActivationEntityTypes.campaign, id)
  }

  async getAdGroup(id: string, _campaignId: string) {
    return this.read(AdsActivationEntityTypes.ad_group, id)
  }

  async listAdGroups(campaignId: string) {
    this.calls.push(`list:ad_groups:${campaignId}`)
    return [...this.entities.values()]
      .filter((entity) => entity.campaignId === campaignId)
      .map((entity) => ({ ...entity }))
  }

  async getAd(id: string, _adGroupId: string) {
    return this.read(AdsActivationEntityTypes.ad, id)
  }

  async listAds(adGroupId: string) {
    this.calls.push(`list:ads:${adGroupId}`)
    return [...this.entities.values()]
      .filter((entity) => entity.adGroupId === adGroupId)
      .map((entity) => ({ ...entity }))
  }

  async activateCampaign(id: string) {
    this.activate(AdsActivationEntityTypes.campaign, id)
  }

  async activateAdGroup(id: string) {
    this.activate(AdsActivationEntityTypes.ad_group, id)
  }

  async activateAd(id: string) {
    this.activate(AdsActivationEntityTypes.ad, id)
  }

  async pauseCampaign(id: string) {
    this.pause(AdsActivationEntityTypes.campaign, id)
  }

  async pauseAdGroup(id: string) {
    this.pause(AdsActivationEntityTypes.ad_group, id)
  }

  async pauseAd(id: string) {
    this.pause(AdsActivationEntityTypes.ad, id)
  }

  private async read(entityType: AdsActivationEntityType, id: string): Promise<AdsActivationEntitySnapshot> {
    const key = entityKey(entityType, id)
    this.calls.push(`get:${key}`)
    const queue = this.readQueues.get(key)
    const queued = queue?.shift()
    if (queued instanceof Error) throw queued
    if (queued) return { ...queued }
    const entity = this.entities.get(key)
    if (!entity) throw new Error(`Missing fake provider entity ${key}`)
    return { ...entity }
  }

  private activate(entityType: AdsActivationEntityType, id: string): void {
    const key = entityKey(entityType, id)
    this.calls.push(`activate:${key}`)
    const entity = this.entities.get(key)
    if (!entity) throw new Error(`Missing fake provider entity ${key}`)
    this.entities.set(key, {
      ...entity,
      status: 'active',
      updatedAt: (entity.updatedAt ?? 0) + 1,
    })
    this.afterActivate?.(entityType, id)
  }

  private pause(entityType: AdsActivationEntityType, id: string): void {
    const key = entityKey(entityType, id)
    this.calls.push(`pause:${key}`)
    if (this.pauseErrors.has(key)) throw new Error('Ambiguous pause response')
    const entity = this.entities.get(key)
    if (!entity) throw new Error(`Missing fake provider entity ${key}`)
    this.entities.set(key, {
      ...entity,
      status: 'paused',
      updatedAt: (entity.updatedAt ?? 0) + 1,
    })
  }
}

type StepTransform = (steps: AdsActivationStepRecord[]) => AdsActivationStepRecord[]
type TransitionReject = (input: AdsActivationStepTransitionInput) => boolean

class MemoryActivationStore implements AdsActivationStore {
  grant: AdsActivationGrantRecord | undefined
  operation: AdsActivationOperationRecord | undefined
  readonly transitions: AdsActivationStepRecord[] = []
  readonly finishes: AdsActivationFinishInput[] = []
  beforeFinish?: () => void

  constructor(
    private readonly claimKind: 'claimed' | 'resumed' = 'claimed',
    private readonly transformSteps: StepTransform = (steps) => steps,
    private readonly rejectTransition: TransitionReject = () => false,
  ) {}

  async claimGrantAndOperation(input: AdsActivationClaimInput): Promise<AdsActivationClaimResult> {
    const steps = this.transformSteps(input.steps)
    this.grant = adsActivationGrantDtoSchema.parse({
      id: input.grantId,
      projectId: input.projectId,
      adAccountId: input.adAccountId,
      manifestHash: input.manifestHash,
      manifest: input.manifest,
      executorApiKeyId: input.executorApiKeyId,
      approverApiKeyId: 'key_approver',
      state: AdsActivationGrantStates.executing,
      expiresAt: EXPIRES_AT,
      operationId: input.operationId,
      approvedAt: NOW,
      executionStartedAt: input.now,
      consumedAt: null,
      revokedAt: null,
      revocationRequestedAt: null,
      expiredAt: null,
      createdAt: NOW,
      updatedAt: input.now,
    })
    this.operation = {
      id: input.operationId,
      projectId: input.projectId,
      adAccountId: input.adAccountId,
      operationKey: input.operationKey,
      requestHash: input.requestHash,
      kind: AdsOperationKinds.campaign_tree_activate,
      state: AdsOperationStates.pending,
      entityType: AdsActivationEntityTypes.campaign,
      entityId: input.manifest.campaign.id,
      upstreamUpdatedAt: null,
      errorCode: null,
      errorMessage: null,
      reconcileStrategy: null,
      reconcileParentId: null,
      reconcileFingerprint: null,
      reconcileFields: null,
      reconcileAttempts: 0,
      lastReconciledAt: null,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: input.leaseExpiresAt,
      createdAt: input.now,
      updatedAt: input.now,
      steps,
    }
    return { kind: this.claimKind, grant: this.grant, operation: this.operation }
  }

  async loadGrant(grantId: string): Promise<AdsActivationGrantRecord | undefined> {
    return this.grant?.id === grantId ? this.grant : undefined
  }

  async renewLease(input: {
    operationId: string
    leaseOwner: string
    now: string
    leaseExpiresAt: string
  }) {
    const operation = this.requireOperation()
    const applied = operation.id === input.operationId
      && operation.leaseOwner === input.leaseOwner
      && operation.state === AdsOperationStates.pending
    if (applied) {
      this.operation = {
        ...operation,
        leaseExpiresAt: input.leaseExpiresAt,
        updatedAt: input.now,
      }
    }
    return { applied, operation: this.requireOperation() }
  }

  async releaseLease(input: { operationId: string; leaseOwner: string; now: string }) {
    const operation = this.requireOperation()
    const applied = operation.id === input.operationId
      && operation.leaseOwner === input.leaseOwner
      && operation.state === AdsOperationStates.pending
    if (applied) {
      this.operation = {
        ...operation,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: input.now,
      }
    }
    return { applied, operation: this.requireOperation() }
  }

  async authorizeStep(input: AdsActivationStepTransitionInput & { grantId: string; now: string }) {
    const grant = this.requireGrant()
    const operation = this.requireOperation()
    if (grant.revocationRequestedAt !== null || grant.state === AdsActivationGrantStates.revoked) {
      return { applied: false, operation, rejection: 'revoked' as const }
    }
    if (Date.parse(grant.expiresAt) <= Date.parse(input.now)) {
      return { applied: false, operation, rejection: 'expired' as const }
    }
    return this.transitionStep(input)
  }

  async transitionStep(input: AdsActivationStepTransitionInput): Promise<AdsActivationStepTransitionResult> {
    const operation = this.requireOperation()
    if (this.rejectTransition(input)) return { applied: false, operation }
    const current = operation.steps.find((step) => step.id === input.next.id)
    if (!current || current.state !== input.fromState) {
      return { applied: false, operation }
    }
    const next = adsOperationStepDtoSchema.parse(input.next)
    this.transitions.push(next)
    this.operation = {
      ...operation,
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: next.updatedAt,
      steps: operation.steps.map((step) => step.id === next.id ? next : step),
    }
    return { applied: true, operation: this.operation }
  }

  async finishOperation(input: AdsActivationFinishInput): Promise<AdsActivationFinishResult> {
    this.beforeFinish?.()
    const operation = this.requireOperation()
    const grant = this.requireGrant()
    if (
      grant.revocationRequestedAt !== null
      && input.operationState === AdsOperationStates.succeeded
    ) {
      throw new AdsActivationError(
        AdsActivationErrorCodes.grantRevoked,
        'Ads activation grant was revoked before execution completed',
        409,
      )
    }
    if (
      Date.parse(grant.expiresAt) <= Date.parse(input.now)
      && input.operationState === AdsOperationStates.succeeded
    ) {
      throw new AdsActivationError(
        AdsActivationErrorCodes.grantExpired,
        'Ads activation grant expired before execution completed',
        409,
      )
    }
    this.finishes.push(input)
    this.operation = {
      ...operation,
      state: input.operationState,
      upstreamUpdatedAt: input.operationState === AdsOperationStates.succeeded
        ? operation.steps.find((step) => step.entityType === AdsActivationEntityTypes.campaign)?.providerUpdatedAt ?? null
        : operation.upstreamUpdatedAt,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: input.now,
    }
    this.grant = adsActivationGrantDtoSchema.parse({
      ...grant,
      state: input.grantState,
      consumedAt: input.grantState === AdsActivationGrantStates.consumed ? input.now : null,
      revokedAt: null,
      expiredAt: null,
      updatedAt: input.now,
    })
    return { applied: true, grant: this.grant, operation: this.operation }
  }

  private requireGrant(): AdsActivationGrantRecord {
    if (!this.grant) throw new Error('Activation grant was not claimed')
    return this.grant
  }

  private requireOperation(): AdsActivationOperationRecord {
    if (!this.operation) throw new Error('Activation operation was not claimed')
    return this.operation
  }
}

function deterministicIds(): () => string {
  let next = 0
  return () => `generated_${++next}`
}

function fixedNow(): Date {
  return new Date(NOW)
}

function mutationCalls(provider: FakeProvider): string[] {
  return provider.calls.filter((call) => call.startsWith('activate:') || call.startsWith('pause:'))
}

describe('approval-bound ads activation core', () => {
  it('keeps canonical manifest and operation identity hashes separate and deterministic', () => {
    expect(serializeAdsActivationManifest(MANIFEST)).toBe(
      '{"campaign":{"id":"cmpn_1","expectedUpdatedAt":100,"adGroups":[{"id":"adgrp_1","expectedUpdatedAt":200,"ads":[{"id":"ad_1","expectedUpdatedAt":300}]}]}}',
    )
    expect(hashAdsActivationManifest(MANIFEST)).toBe(MANIFEST_HASH)

    const request = activationRequest()
    expect(hashAdsActivationOperationRequest(request)).toBe(OPERATION_HASH)
    expect(hashAdsActivationOperationRequest({ ...request, projectId: 'project_2' })).not.toBe(OPERATION_HASH)
    expect(hashAdsActivationManifest(request.manifest)).toBe(MANIFEST_HASH)

    const unsorted = {
      campaign: {
        ...MANIFEST.campaign,
        adGroups: [
          { id: 'adgrp_2', expectedUpdatedAt: 201, ads: [{ id: 'ad_3', expectedUpdatedAt: 303 }] },
          { ...MANIFEST.campaign.adGroups[0]!, ads: [{ id: 'ad_2', expectedUpdatedAt: 302 }, ...MANIFEST.campaign.adGroups[0]!.ads] },
        ],
      },
    } as AdsActivationManifest
    const canonical = {
      campaign: {
        ...MANIFEST.campaign,
        adGroups: [
          { ...MANIFEST.campaign.adGroups[0]!, ads: [{ id: 'ad_1', expectedUpdatedAt: 300 }, { id: 'ad_2', expectedUpdatedAt: 302 }] },
          { id: 'adgrp_2', expectedUpdatedAt: 201, ads: [{ id: 'ad_3', expectedUpdatedAt: 303 }] },
        ],
      },
    } satisfies AdsActivationManifest
    expect(hashAdsActivationManifest(unsorted)).toBe(hashAdsActivationManifest(canonical))
  })

  it('preflights the exact approved account and paused campaign tree without mutations', async () => {
    const provider = new FakeProvider()

    await expect(preflightAdsActivationApproval(provider, {
      adAccountId: 'adacct_1',
      manifest: MANIFEST,
    })).resolves.toEqual({ manifest: MANIFEST, manifestHash: MANIFEST_HASH })
    expect(provider.calls).toEqual([
      'get:account',
      'list:ad_groups:cmpn_1',
      'list:ads:adgrp_1',
      'get:ad:ad_1',
      'get:ad_group:adgrp_1',
      'get:campaign:cmpn_1',
    ])
    expect(mutationCalls(provider)).toEqual([])

    const unapproved = new FakeProvider()
    unapproved.account.reviewStatus = 'in_review'
    await expect(preflightAdsActivationApproval(unapproved, {
      adAccountId: 'adacct_1',
      manifest: MANIFEST,
    })).rejects.toMatchObject({ code: AdsActivationErrorCodes.accountNotApproved })
    expect(unapproved.calls).toEqual(['get:account'])

    const wrongParent = new FakeProvider()
    wrongParent.setEntity(AdsActivationEntityTypes.ad, {
      id: 'ad_1',
      adGroupId: 'adgrp_other',
      reviewStatus: 'approved',
      status: 'paused',
      updatedAt: 300,
    })
    await expect(preflightAdsActivationApproval(wrongParent, {
      adAccountId: 'adacct_1',
      manifest: MANIFEST,
    })).rejects.toMatchObject({ code: AdsActivationErrorCodes.entityMismatch })
    expect(mutationCalls(wrongParent)).toEqual([])

    const omittedActiveDescendant = new FakeProvider()
    omittedActiveDescendant.setEntity(AdsActivationEntityTypes.ad, {
      id: 'ad_unapproved',
      adGroupId: 'adgrp_1',
      reviewStatus: 'approved',
      status: 'active',
      updatedAt: 999,
    })
    await expect(preflightAdsActivationApproval(omittedActiveDescendant, {
      adAccountId: 'adacct_1',
      manifest: MANIFEST,
    })).rejects.toMatchObject({ code: AdsActivationErrorCodes.entityMismatch })
    expect(mutationCalls(omittedActiveDescendant)).toEqual([])
  })

  it('refreshes review-only provider versions and rejects semantic drift', async () => {
    const provider = new FakeProvider()
    provider.setEntity(AdsActivationEntityTypes.ad, {
      id: 'ad_1',
      adGroupId: 'adgrp_1',
      reviewStatus: 'approved',
      status: 'paused',
      updatedAt: 301,
    })

    const matched: string[] = []
    const refreshed = await refreshSemanticallyUnchangedAdsActivationManifest(provider, {
      adAccountId: 'adacct_1',
      manifest: MANIFEST,
      semanticallyMatchesMaterialization: (entityType, entityId) => {
        matched.push(entityKey(entityType, entityId))
        return true
      },
    })

    expect(refreshed.manifest.campaign.adGroups[0]!.ads[0]!.expectedUpdatedAt).toBe(301)
    expect(refreshed.manifestHash).toBe(hashAdsActivationManifest(refreshed.manifest))
    expect(matched).toEqual(['ad:ad_1', 'ad_group:adgrp_1', 'campaign:cmpn_1'])
    expect(mutationCalls(provider)).toEqual([])

    await expect(refreshSemanticallyUnchangedAdsActivationManifest(provider, {
      adAccountId: 'adacct_1',
      manifest: MANIFEST,
      semanticallyMatchesMaterialization: (_entityType, entityId) => entityId !== 'ad_1',
    })).rejects.toMatchObject({
      code: AdsActivationErrorCodes.entityMismatch,
      entity: { entityType: 'ad', entityId: 'ad_1' },
    })
    expect(mutationCalls(provider)).toEqual([])
  })

  it('activates ads, then ad groups, then the campaign with durable checkpoints', async () => {
    const provider = new FakeProvider()
    const store = new MemoryActivationStore()

    const result = await executeApprovedAdsActivation({
      provider,
      store,
      now: fixedNow,
      randomId: deterministicIds(),
    }, activationRequest())

    expect(mutationCalls(provider)).toEqual([
      'activate:ad:ad_1',
      'activate:ad_group:adgrp_1',
      'activate:campaign:cmpn_1',
    ])
    expect(result.operation.state).toBe(AdsOperationStates.succeeded)
    expect(result.grant.state).toBe(AdsActivationGrantStates.consumed)
    expect(result.steps.map((step) => [step.ordinal, step.entityType, step.state])).toEqual([
      [0, AdsActivationEntityTypes.ad, AdsOperationStepStates.active],
      [1, AdsActivationEntityTypes.ad_group, AdsOperationStepStates.active],
      [2, AdsActivationEntityTypes.campaign, AdsOperationStepStates.active],
    ])
    expect(store.transitions.map((step) => step.state)).toEqual([
      'executing', 'active',
      'executing', 'active',
      'executing', 'active',
    ])
  })

  it('recovers an executing step with GET only and never resends its activation', async () => {
    const provider = new FakeProvider()
    provider.setEntity(AdsActivationEntityTypes.ad, {
      id: 'ad_1',
      adGroupId: 'adgrp_1',
      reviewStatus: 'approved',
      status: 'active',
      updatedAt: 301,
    })
    const store = new MemoryActivationStore('resumed', (steps) => steps.map((step) =>
      step.entityType === AdsActivationEntityTypes.ad
        ? adsOperationStepDtoSchema.parse({
            ...step,
            state: AdsOperationStepStates.executing,
            providerUpdatedAt: null,
            errorCode: null,
            errorMessage: null,
            remediation: null,
            startedAt: NOW,
            finishedAt: null,
          })
        : step,
    ))

    const result = await executeApprovedAdsActivation({
      provider,
      store,
      now: fixedNow,
      randomId: deterministicIds(),
    }, activationRequest())

    expect(provider.calls.filter((call) => call === 'get:ad:ad_1')).toHaveLength(6)
    expect(mutationCalls(provider)).toEqual([
      'activate:ad_group:adgrp_1',
      'activate:campaign:cmpn_1',
    ])
    expect(result.operation.state).toBe(AdsOperationStates.succeeded)
    expect(result.steps[0]).toMatchObject({
      state: AdsOperationStepStates.active,
      providerUpdatedAt: 301,
    })
  })

  it('rolls back campaign, then ad groups, then ads after a late checkpoint failure', async () => {
    const provider = new FakeProvider()
    const store = new MemoryActivationStore(
      'claimed',
      (steps) => steps,
      (input) => input.next.entityType === AdsActivationEntityTypes.campaign
        && input.next.state === AdsOperationStepStates.active,
    )

    await expect(executeApprovedAdsActivation({
      provider,
      store,
      now: fixedNow,
      randomId: deterministicIds(),
    }, activationRequest())).rejects.toMatchObject({
      code: AdsActivationErrorCodes.persistenceFailed,
    })

    expect(mutationCalls(provider)).toEqual([
      'activate:ad:ad_1',
      'activate:ad_group:adgrp_1',
      'activate:campaign:cmpn_1',
      'pause:campaign:cmpn_1',
      'pause:ad_group:adgrp_1',
      'pause:ad:ad_1',
    ])
    expect(store.operation?.state).toBe(AdsOperationStates.failed)
    expect(store.grant?.state).toBe(AdsActivationGrantStates.consumed)
    expect(store.operation?.steps.every((step) => step.state === AdsOperationStepStates.rolled_back)).toBe(true)
  })

  it('fails closed as unknown when a rollback mutation cannot be verified', async () => {
    const provider = new FakeProvider()
    provider.pauseErrors.add(entityKey(AdsActivationEntityTypes.campaign, 'cmpn_1'))
    provider.queueReads(
      AdsActivationEntityTypes.campaign,
      'cmpn_1',
      { id: 'cmpn_1', status: 'paused', updatedAt: 100 },
      { id: 'cmpn_1', status: 'paused', updatedAt: 100 },
      { id: 'cmpn_1', status: 'active', updatedAt: 101 },
      { id: 'cmpn_1', status: 'active', updatedAt: 101 },
      { id: 'cmpn_1', status: 'active', updatedAt: 101 },
      new Error('Connection dropped while verifying pause'),
    )
    const store = new MemoryActivationStore(
      'claimed',
      (steps) => steps,
      (input) => input.next.entityType === AdsActivationEntityTypes.campaign
        && input.next.state === AdsOperationStepStates.active,
    )

    await expect(executeApprovedAdsActivation({
      provider,
      store,
      now: fixedNow,
      randomId: deterministicIds(),
    }, activationRequest())).rejects.toMatchObject({
      code: AdsActivationErrorCodes.manualRemediationRequired,
    })

    expect(provider.calls.filter((call) => call === 'pause:campaign:cmpn_1')).toHaveLength(1)
    expect(store.operation?.state).toBe(AdsOperationStates.unknown)
    expect(store.grant?.state).toBe(AdsActivationGrantStates.unknown)
    expect(store.operation?.steps.find((step) => step.entityType === AdsActivationEntityTypes.campaign)?.state)
      .toBe(AdsOperationStepStates.unknown)
    expect(store.operation?.steps.filter((step) => step.entityType !== AdsActivationEntityTypes.campaign))
      .toSatisfy((steps: AdsActivationStepRecord[]) =>
        steps.every((step) => step.state === AdsOperationStepStates.rolled_back),
      )
  })

  it('revalidates each later entity immediately before mutation', async () => {
    const provider = new FakeProvider()
    provider.queueReads(
      AdsActivationEntityTypes.ad_group,
      'adgrp_1',
      {
        id: 'adgrp_1',
        campaignId: 'cmpn_1',
        status: 'paused',
        updatedAt: 200,
      },
      {
        id: 'adgrp_1',
        campaignId: 'cmpn_1',
        status: 'paused',
        updatedAt: 201,
      },
    )
    const store = new MemoryActivationStore()

    await expect(executeApprovedAdsActivation({
      provider,
      store,
      now: fixedNow,
      randomId: deterministicIds(),
    }, activationRequest())).rejects.toMatchObject({
      code: AdsActivationErrorCodes.entityStale,
    })

    expect(mutationCalls(provider)).toEqual([
      'activate:ad:ad_1',
      'pause:ad:ad_1',
    ])
    expect(store.operation?.state).toBe(AdsOperationStates.failed)
    expect(store.grant?.state).toBe(AdsActivationGrantStates.consumed)
  })

  it('stops before the next atomic step authorization when a grant expires', async () => {
    const provider = new FakeProvider()
    const store = new MemoryActivationStore()
    let clock = new Date(NOW)
    provider.afterActivate = (entityType) => {
      if (entityType === AdsActivationEntityTypes.ad) clock = new Date(EXPIRES_AT)
    }

    await expect(executeApprovedAdsActivation({
      provider,
      store,
      now: () => clock,
      randomId: deterministicIds(),
    }, activationRequest())).rejects.toMatchObject({
      code: AdsActivationErrorCodes.grantExpired,
    })

    expect(mutationCalls(provider)).toEqual([
      'activate:ad:ad_1',
      'pause:ad:ad_1',
    ])
    expect(store.operation?.state).toBe(AdsOperationStates.failed)
    expect(store.grant?.state).toBe(AdsActivationGrantStates.consumed)
  })

  it('lets a revocation win the finalization race and rolls the active tree back', async () => {
    const provider = new FakeProvider()
    const store = new MemoryActivationStore()
    store.beforeFinish = () => {
      store.beforeFinish = undefined
      store.grant = adsActivationGrantDtoSchema.parse({
        ...store.grant!,
        revocationRequestedAt: NOW,
      })
    }

    await expect(executeApprovedAdsActivation({
      provider,
      store,
      now: fixedNow,
      randomId: deterministicIds(),
    }, activationRequest())).rejects.toMatchObject({
      code: AdsActivationErrorCodes.grantRevoked,
    })

    expect(mutationCalls(provider)).toEqual([
      'activate:ad:ad_1',
      'activate:ad_group:adgrp_1',
      'activate:campaign:cmpn_1',
      'pause:campaign:cmpn_1',
      'pause:ad_group:adgrp_1',
      'pause:ad:ad_1',
    ])
    expect(store.operation?.state).toBe(AdsOperationStates.failed)
    expect(store.grant).toMatchObject({
      state: AdsActivationGrantStates.consumed,
      revocationRequestedAt: NOW,
    })
  })

  it('rechecks account approval before each new provider mutation', async () => {
    const provider = new FakeProvider()
    const store = new MemoryActivationStore()
    provider.afterActivate = (entityType) => {
      if (entityType === AdsActivationEntityTypes.ad) {
        provider.account.reviewStatus = 'suspended'
      }
    }

    await expect(executeApprovedAdsActivation({
      provider,
      store,
      now: fixedNow,
      randomId: deterministicIds(),
    }, activationRequest())).rejects.toMatchObject({
      code: AdsActivationErrorCodes.accountNotApproved,
    })

    expect(mutationCalls(provider)).toEqual([
      'activate:ad:ad_1',
      'pause:ad:ad_1',
    ])
    expect(store.operation?.state).toBe(AdsOperationStates.failed)
  })

  it('blocks the campaign spend boundary when an active descendant drifts', async () => {
    const provider = new FakeProvider()
    const store = new MemoryActivationStore()
    provider.afterActivate = (entityType) => {
      if (entityType === AdsActivationEntityTypes.ad_group) {
        provider.setEntity(AdsActivationEntityTypes.ad, {
          id: 'ad_1',
          adGroupId: 'adgrp_1',
          reviewStatus: 'approved',
          status: 'paused',
          updatedAt: 302,
        })
      }
    }

    await expect(executeApprovedAdsActivation({
      provider,
      store,
      now: fixedNow,
      randomId: deterministicIds(),
    }, activationRequest())).rejects.toMatchObject({
      code: AdsActivationErrorCodes.manualRemediationRequired,
    })

    expect(mutationCalls(provider)).toEqual([
      'activate:ad:ad_1',
      'activate:ad_group:adgrp_1',
      'pause:ad_group:adgrp_1',
    ])
    expect(mutationCalls(provider)).not.toContain('activate:campaign:cmpn_1')
    expect(store.operation?.state).toBe(AdsOperationStates.failed)
  })

  it('re-enumerates descendants after campaign activation and rolls back an omitted child', async () => {
    const provider = new FakeProvider()
    const store = new MemoryActivationStore()
    provider.afterActivate = (entityType) => {
      if (entityType === AdsActivationEntityTypes.campaign) {
        provider.setEntity(AdsActivationEntityTypes.ad_group, {
          id: 'adgrp_omitted',
          campaignId: 'cmpn_1',
          status: 'active',
          updatedAt: 400,
        })
      }
    }

    await expect(executeApprovedAdsActivation({
      provider,
      store,
      now: fixedNow,
      randomId: deterministicIds(),
    }, activationRequest())).rejects.toMatchObject({
      code: AdsActivationErrorCodes.entityMismatch,
    })

    expect(mutationCalls(provider)).toEqual([
      'activate:ad:ad_1',
      'activate:ad_group:adgrp_1',
      'activate:campaign:cmpn_1',
      'pause:campaign:cmpn_1',
      'pause:ad_group:adgrp_1',
      'pause:ad:ad_1',
    ])
    expect(provider.entities.get('campaign:cmpn_1')?.status).toBe('paused')
    expect(store.operation?.state).toBe(AdsOperationStates.failed)
  })

  it('rolls back when a resumed active checkpoint timestamp has drifted', async () => {
    const provider = new FakeProvider()
    provider.setEntity(AdsActivationEntityTypes.ad, {
      id: 'ad_1',
      adGroupId: 'adgrp_1',
      reviewStatus: 'approved',
      status: 'active',
      updatedAt: 302,
    })
    const store = new MemoryActivationStore('resumed', (steps) => steps.map((step) =>
      step.entityType === AdsActivationEntityTypes.ad
        ? adsOperationStepDtoSchema.parse({
            ...step,
            state: AdsOperationStepStates.active,
            providerUpdatedAt: 301,
            startedAt: NOW,
            finishedAt: NOW,
          })
        : step,
    ))

    await expect(executeApprovedAdsActivation({
      provider,
      store,
      now: fixedNow,
      randomId: deterministicIds(),
    }, activationRequest())).rejects.toMatchObject({
      code: AdsActivationErrorCodes.manualRemediationRequired,
    })

    expect(mutationCalls(provider)).toEqual(['pause:ad:ad_1'])
    expect(store.operation?.state).toBe(AdsOperationStates.failed)
  })

  it('keeps an ambiguous activation unknown instead of trusting one paused read', async () => {
    const provider = new FakeProvider()
    provider.queueReads(
      AdsActivationEntityTypes.ad,
      'ad_1',
      {
        id: 'ad_1',
        adGroupId: 'adgrp_1',
        reviewStatus: 'approved',
        status: 'paused',
        updatedAt: 300,
      },
      {
        id: 'ad_1',
        adGroupId: 'adgrp_1',
        reviewStatus: 'approved',
        status: 'paused',
        updatedAt: 300,
      },
      {
        id: 'ad_1',
        adGroupId: 'adgrp_1',
        reviewStatus: 'approved',
        status: 'paused',
        updatedAt: 300,
      },
    )
    const store = new MemoryActivationStore()

    await expect(executeApprovedAdsActivation({
      provider,
      store,
      now: fixedNow,
      randomId: deterministicIds(),
    }, activationRequest())).rejects.toMatchObject({
      code: AdsActivationErrorCodes.manualRemediationRequired,
    })

    expect(mutationCalls(provider)).toEqual(['activate:ad:ad_1'])
    expect(store.operation?.state).toBe(AdsOperationStates.unknown)
    expect(store.grant?.state).toBe(AdsActivationGrantStates.unknown)
    expect(store.operation?.steps[0]?.state).toBe(AdsOperationStepStates.unknown)
  })

  it('keeps an expired executing checkpoint unknown when the provider still reports paused', async () => {
    const provider = new FakeProvider()
    const store = new MemoryActivationStore('resumed', (steps) => steps.map((step) =>
      step.entityType === AdsActivationEntityTypes.ad
        ? adsOperationStepDtoSchema.parse({
            ...step,
            state: AdsOperationStepStates.executing,
            startedAt: NOW,
          })
        : step,
    ))

    await expect(executeApprovedAdsActivation({
      provider,
      store,
      now: () => new Date('2026-07-18T18:00:00.000Z'),
      randomId: deterministicIds(),
    }, activationRequest())).rejects.toMatchObject({
      code: AdsActivationErrorCodes.manualRemediationRequired,
    })

    expect(mutationCalls(provider)).toEqual([])
    expect(store.operation?.state).toBe(AdsOperationStates.unknown)
    expect(store.grant?.state).toBe(AdsActivationGrantStates.unknown)
    expect(store.operation?.steps[0]?.state).toBe(AdsOperationStepStates.unknown)
  })

  it('never resends a rollback mutation after its outcome became unknown', async () => {
    const provider = new FakeProvider()
    provider.setEntity(AdsActivationEntityTypes.ad, {
      id: 'ad_1',
      adGroupId: 'adgrp_1',
      reviewStatus: 'approved',
      status: 'active',
      updatedAt: 301,
    })
    const store = new MemoryActivationStore('resumed', (steps) => steps.map((step) =>
      step.entityType === AdsActivationEntityTypes.ad
        ? adsOperationStepDtoSchema.parse({
            ...step,
            state: AdsOperationStepStates.unknown,
            providerUpdatedAt: null,
            errorCode: AdsActivationErrorCodes.manualRemediationRequired,
            errorMessage: 'Rollback outcome could not be verified',
            remediation: 'Pause manually',
            startedAt: NOW,
            finishedAt: NOW,
          })
        : step,
    ))

    await expect(executeApprovedAdsActivation({
      provider,
      store,
      now: fixedNow,
      randomId: deterministicIds(),
    }, activationRequest())).rejects.toMatchObject({
      code: AdsActivationErrorCodes.manualRemediationRequired,
    })

    expect(mutationCalls(provider)).toEqual([])
    expect(store.operation?.state).toBe(AdsOperationStates.unknown)
    expect(store.grant?.state).toBe(AdsActivationGrantStates.unknown)
  })

  it('safety-pauses provider descendants that were omitted from the approved manifest', async () => {
    const provider = new FakeProvider()
    provider.setEntity(AdsActivationEntityTypes.ad_group, {
      id: 'adgrp_omitted',
      campaignId: MANIFEST.campaign.id,
      status: 'active',
      updatedAt: 401,
    })
    provider.setEntity(AdsActivationEntityTypes.ad, {
      id: 'ad_omitted',
      adGroupId: 'adgrp_omitted',
      reviewStatus: 'approved',
      status: 'active',
      updatedAt: 402,
    })

    const result = await enforceUnknownAdsActivationSafety(provider, MANIFEST)

    expect(result).toEqual({ attempted: 5, verifiedPaused: 5, fullyVerified: true })
    expect(provider.calls.indexOf('pause:campaign:cmpn_1'))
      .toBeLessThan(provider.calls.indexOf('list:ad_groups:cmpn_1'))
    expect(provider.calls).toContain('pause:ad_group:adgrp_omitted')
    expect(provider.calls).toContain('pause:ad:ad_omitted')
    expect(provider.entities.get('ad_group:adgrp_omitted')?.status).toBe('paused')
    expect(provider.entities.get('ad:ad_omitted')?.status).toBe('paused')
  })

  it('builds stable ad-first ordinals for the durable step ledger', () => {
    let id = 0
    const steps = buildAdsActivationSteps(MANIFEST, 'operation_1', NOW, () => `step_${++id}`)
    expect(steps.map((step) => ({ id: step.id, ordinal: step.ordinal, entityType: step.entityType }))).toEqual([
      { id: 'step_1', ordinal: 0, entityType: AdsActivationEntityTypes.ad },
      { id: 'step_2', ordinal: 1, entityType: AdsActivationEntityTypes.ad_group },
      { id: 'step_3', ordinal: 2, entityType: AdsActivationEntityTypes.campaign },
    ])
  })
})
