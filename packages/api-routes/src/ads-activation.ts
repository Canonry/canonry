import crypto from 'node:crypto'
import {
  adsActivationManifestHashSchema,
  adsActivationManifestSchema,
  adsOperationStepDtoSchema,
  canonicalizeAdsActivationManifest,
  AdsActivationEntityTypes,
  AdsActivationGrantStates,
  AdsIntegrityDecisions,
  AdsOperationKinds,
  AdsOperationStates,
  AdsOperationStepStates,
  AdsReviewStatuses,
  type AdsActivationEntityType,
  type AdsAdGroupBillingEventType,
  type AdsActivationGrantDto,
  type AdsActivationManifest,
  type AdsCampaignBiddingType,
  type AdsOperationStepDto,
} from '@ainyc/canonry-contracts'
import type { adsOperations } from '@ainyc/canonry-db'

/**
 * Approval-bound activation is dependency-injected so the route layer can own
 * authentication and SQLite transactions while this module owns provider I/O
 * ordering and fail-closed state transitions.
 */

export const AdsActivationErrorCodes = {
  invalidManifest: 'ADS_ACTIVATION_INVALID_MANIFEST',
  grantNotFound: 'ADS_ACTIVATION_GRANT_NOT_FOUND',
  grantProjectMismatch: 'ADS_ACTIVATION_GRANT_PROJECT_MISMATCH',
  grantAccountMismatch: 'ADS_ACTIVATION_GRANT_ACCOUNT_MISMATCH',
  grantHashMismatch: 'ADS_ACTIVATION_GRANT_HASH_MISMATCH',
  grantExecutorMismatch: 'ADS_ACTIVATION_GRANT_EXECUTOR_MISMATCH',
  grantExpired: 'ADS_ACTIVATION_GRANT_EXPIRED',
  grantRevoked: 'ADS_ACTIVATION_GRANT_REVOKED',
  grantUsed: 'ADS_ACTIVATION_GRANT_USED',
  operationConflict: 'ADS_ACTIVATION_OPERATION_CONFLICT',
  accountNotApproved: 'ADS_ACTIVATION_ACCOUNT_NOT_APPROVED',
  entityMismatch: 'ADS_ACTIVATION_ENTITY_MISMATCH',
  entityNotPaused: 'ADS_ACTIVATION_ENTITY_NOT_PAUSED',
  entityStale: 'ADS_ACTIVATION_ENTITY_STALE',
  adNotApproved: 'ADS_ACTIVATION_AD_NOT_APPROVED',
  providerReadFailed: 'ADS_ACTIVATION_PROVIDER_READ_FAILED',
  providerMutationFailed: 'ADS_ACTIVATION_PROVIDER_MUTATION_FAILED',
  rolledBack: 'ADS_ACTIVATION_ROLLED_BACK',
  manualRemediationRequired: 'ADS_ACTIVATION_MANUAL_REMEDIATION_REQUIRED',
  persistenceFailed: 'ADS_ACTIVATION_PERSISTENCE_FAILED',
} as const

export type AdsActivationErrorCode =
  typeof AdsActivationErrorCodes[keyof typeof AdsActivationErrorCodes]

export class AdsActivationError extends Error {
  constructor(
    readonly code: AdsActivationErrorCode,
    message: string,
    readonly statusCode: number,
    readonly operation?: { id: string; operationKey: string },
    readonly entity?: { entityType: AdsActivationEntityType; entityId: string },
  ) {
    super(message)
    this.name = 'AdsActivationError'
  }
}

export interface AdsActivationRequest {
  projectId: string
  adAccountId: string
  operationKey: string
  grantId: string
  manifestHash: string
  executorApiKeyId: string
  manifest: AdsActivationManifest
}

export interface AdsActivationApprovalPreflightRequest {
  adAccountId: string
  manifest: AdsActivationManifest
}

export interface AdsActivationApprovalPreflightResult {
  manifest: AdsActivationManifest
  manifestHash: string
}

export interface AdsActivationVersionRefreshRequest extends AdsActivationApprovalPreflightRequest {
  semanticallyMatchesMaterialization: (
    entityType: AdsActivationEntityType,
    entityId: string,
    entity: AdsActivationEntitySnapshot,
  ) => boolean
}

export type AdsActivationGrantRecord = AdsActivationGrantDto
export type AdsActivationStepRecord = AdsOperationStepDto

type AdsOperationRow = typeof adsOperations.$inferSelect
type ActivationOperationState =
  | typeof AdsOperationStates.pending
  | typeof AdsOperationStates.succeeded
  | typeof AdsOperationStates.failed
  | typeof AdsOperationStates.unknown

export type AdsActivationOperationRecord = Omit<AdsOperationRow, 'kind' | 'state'> & {
  kind: typeof AdsOperationKinds.campaign_tree_activate
  state: ActivationOperationState
  steps: AdsActivationStepRecord[]
}

export type AdsActivationClaimRejection =
  | 'grant_not_found'
  | 'project_mismatch'
  | 'account_mismatch'
  | 'manifest_mismatch'
  | 'executor_mismatch'
  | 'expired'
  | 'revoked'
  | 'used'
  | 'operation_conflict'

export type AdsActivationClaimResult =
  | {
      kind: 'claimed' | 'resumed' | 'replay' | 'busy'
      grant: AdsActivationGrantRecord
      operation: AdsActivationOperationRecord
    }
  | { kind: 'rejected'; reason: AdsActivationClaimRejection }

export interface AdsActivationClaimInput {
  grantId: string
  projectId: string
  adAccountId: string
  operationId: string
  operationKey: string
  manifest: AdsActivationManifest
  manifestHash: string
  requestHash: string
  executorApiKeyId: string
  leaseOwner: string
  now: string
  leaseExpiresAt: string
  steps: AdsActivationStepRecord[]
}

export interface AdsActivationStepTransitionInput {
  operationId: string
  leaseOwner: string
  fromState: AdsActivationStepRecord['state']
  next: AdsActivationStepRecord
  leaseExpiresAt: string
}

export interface AdsActivationStepTransitionResult {
  applied: boolean
  operation: AdsActivationOperationRecord
}

export type AdsActivationAuthorizationRejection = 'expired' | 'revoked'

export interface AdsActivationStepAuthorizationInput extends AdsActivationStepTransitionInput {
  grantId: string
  now: string
}

export type AdsActivationStepAuthorizationResult = AdsActivationStepTransitionResult & {
  rejection?: AdsActivationAuthorizationRejection
}

export interface AdsActivationLeaseInput {
  operationId: string
  leaseOwner: string
  now: string
  leaseExpiresAt: string
}

export interface AdsActivationLeaseResult {
  applied: boolean
  operation: AdsActivationOperationRecord
}

export interface AdsActivationFinishInput {
  operationId: string
  grantId: string
  leaseOwner: string
  operationState:
    | typeof AdsOperationStates.succeeded
    | typeof AdsOperationStates.failed
    | typeof AdsOperationStates.unknown
  grantState:
    | typeof AdsActivationGrantStates.consumed
    | typeof AdsActivationGrantStates.unknown
  errorCode: string | null
  errorMessage: string | null
  now: string
}

export interface AdsActivationFinishResult {
  applied: boolean
  grant: AdsActivationGrantRecord
  operation: AdsActivationOperationRecord
}

export interface AdsActivationStore {
  /** Claiming the grant, inserting/replaying the receipt, binding the grant,
   * creating steps, and acquiring the lease are one database transaction. */
  claimGrantAndOperation(input: AdsActivationClaimInput): Promise<AdsActivationClaimResult>
  loadGrant(grantId: string): Promise<AdsActivationGrantRecord | undefined>
  renewLease(input: AdsActivationLeaseInput): Promise<AdsActivationLeaseResult>
  releaseLease(input: Omit<AdsActivationLeaseInput, 'leaseExpiresAt'>): Promise<AdsActivationLeaseResult>
  authorizeStep(input: AdsActivationStepAuthorizationInput): Promise<AdsActivationStepAuthorizationResult>
  transitionStep(input: AdsActivationStepTransitionInput): Promise<AdsActivationStepTransitionResult>
  finishOperation(input: AdsActivationFinishInput): Promise<AdsActivationFinishResult>
}

export interface AdsActivationAccountSnapshot {
  id: string
  reviewStatus: string | null
  integrityReviewStatus: string | null
  integrityDecision: string | null
}

export interface AdsActivationEntitySnapshot {
  id: string
  status: string | null
  updatedAt: number | null
  campaignId?: string | null
  adGroupId?: string | null
  reviewStatus?: string | null
  biddingType?: AdsCampaignBiddingType | null
  conversionEventSettingIds?: string[] | null
  billingEventType?: AdsAdGroupBillingEventType | null
  name?: string | null
  description?: string | null
  startTime?: number | null
  endTime?: number | null
  lifetimeSpendLimitMicros?: number | null
  locationIds?: string[] | null
  contextHints?: string[] | null
  maxBidMicros?: number | null
  creative?: { title: string; body: string; targetUrl: string; fileId: string } | null
}

export interface AdsActivationProvider {
  getAccount(): Promise<AdsActivationAccountSnapshot>
  getCampaign(id: string): Promise<AdsActivationEntitySnapshot>
  getAdGroup(id: string, campaignId: string): Promise<AdsActivationEntitySnapshot>
  listAdGroups(campaignId: string): Promise<AdsActivationEntitySnapshot[]>
  getAd(id: string, adGroupId: string): Promise<AdsActivationEntitySnapshot>
  listAds(adGroupId: string): Promise<AdsActivationEntitySnapshot[]>
  activateCampaign(id: string): Promise<unknown>
  activateAdGroup(id: string): Promise<unknown>
  activateAd(id: string): Promise<unknown>
  pauseCampaign(id: string): Promise<unknown>
  pauseAdGroup(id: string): Promise<unknown>
  pauseAd(id: string): Promise<unknown>
}

export interface AdsActivationDependencies {
  store: AdsActivationStore
  provider: AdsActivationProvider
  now?: () => Date
  randomId?: () => string
  leaseMs?: number
}

export interface AdsActivationResult {
  grant: AdsActivationGrantRecord
  operation: AdsActivationOperationRecord
  steps: AdsActivationStepRecord[]
  replayed: boolean
  inProgress: boolean
  manualRemediationRequired: boolean
}

export interface AdsActivationSafetyPauseResult {
  attempted: number
  verifiedPaused: number
  fullyVerified: boolean
}

interface ActivationTarget {
  entityType: AdsActivationEntityType
  entityId: string
  parentId: string | null
  expectedUpdatedAt: number
}

interface ActivationContext {
  deps: Required<Pick<AdsActivationDependencies, 'now' | 'randomId' | 'leaseMs'>>
    & Pick<AdsActivationDependencies, 'store' | 'provider'>
  request: AdsActivationRequest
  manifest: AdsActivationManifest
  operation: AdsActivationOperationRecord
  grant: AdsActivationGrantRecord
  leaseOwner: string
  replayed: boolean
}

const DEFAULT_LEASE_MS = 5 * 60_000
const PROVIDER_PAUSED = 'paused'
const PROVIDER_ACTIVE = 'active'

function assertNever(value: never): never {
  throw new Error(`Unexpected ads activation state: ${String(value)}`)
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function canonicalManifest(manifest: AdsActivationManifest): AdsActivationManifest {
  const parsed = adsActivationManifestSchema.safeParse(canonicalizeAdsActivationManifest(manifest))
  if (!parsed.success) {
    throw new AdsActivationError(
      AdsActivationErrorCodes.invalidManifest,
      'Ads activation manifest is invalid',
      400,
    )
  }
  return parsed.data
}

/** Serialize only the exact nested manifest; project/account identity is not part of this hash. */
export function serializeAdsActivationManifest(manifest: AdsActivationManifest): string {
  return JSON.stringify(canonicalManifest(manifest))
}

export function hashAdsActivationManifest(manifest: AdsActivationManifest): string {
  return sha256(serializeAdsActivationManifest(manifest))
}

/**
 * Idempotency identity for the execution operation. This is intentionally
 * distinct from the immutable manifest hash stored on the approval grant.
 */
export function hashAdsActivationOperationRequest(
  request: Pick<
    AdsActivationRequest,
    'grantId' | 'manifestHash' | 'executorApiKeyId' | 'projectId' | 'adAccountId'
  >,
): string {
  return sha256(JSON.stringify({
    kind: AdsOperationKinds.campaign_tree_activate,
    grantId: request.grantId,
    manifestHash: request.manifestHash,
    executorApiKeyId: request.executorApiKeyId,
    projectId: request.projectId,
    adAccountId: request.adAccountId,
  }))
}

function activationTargets(manifest: AdsActivationManifest): ActivationTarget[] {
  const ads: ActivationTarget[] = []
  const groups: ActivationTarget[] = []
  for (const group of manifest.campaign.adGroups) {
    groups.push({
      entityType: AdsActivationEntityTypes.ad_group,
      entityId: group.id,
      parentId: manifest.campaign.id,
      expectedUpdatedAt: group.expectedUpdatedAt,
    })
    for (const ad of group.ads) {
      ads.push({
        entityType: AdsActivationEntityTypes.ad,
        entityId: ad.id,
        parentId: group.id,
        expectedUpdatedAt: ad.expectedUpdatedAt,
      })
    }
  }
  return [
    ...ads,
    ...groups,
    {
      entityType: AdsActivationEntityTypes.campaign,
      entityId: manifest.campaign.id,
      parentId: null,
      expectedUpdatedAt: manifest.campaign.expectedUpdatedAt,
    },
  ]
}

export function buildAdsActivationSteps(
  manifest: AdsActivationManifest,
  operationId: string,
  now: string,
  randomId: () => string = () => crypto.randomUUID(),
): AdsActivationStepRecord[] {
  return activationTargets(canonicalManifest(manifest)).map((target, ordinal) =>
    adsOperationStepDtoSchema.parse({
      id: randomId(),
      operationId,
      ordinal,
      entityType: target.entityType,
      entityId: target.entityId,
      expectedUpdatedAt: target.expectedUpdatedAt,
      state: AdsOperationStepStates.pending,
      providerUpdatedAt: null,
      errorCode: null,
      errorMessage: null,
      remediation: null,
      startedAt: null,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
    }),
  )
}

function operationRef(operation: AdsActivationOperationRecord) {
  return { id: operation.id, operationKey: operation.operationKey }
}

function claimError(reason: AdsActivationClaimRejection): AdsActivationError {
  switch (reason) {
    case 'grant_not_found':
      return new AdsActivationError(AdsActivationErrorCodes.grantNotFound, 'Ads activation grant was not found', 404)
    case 'project_mismatch':
      return new AdsActivationError(AdsActivationErrorCodes.grantProjectMismatch, 'Ads activation grant is for another project', 403)
    case 'account_mismatch':
      return new AdsActivationError(
        AdsActivationErrorCodes.grantAccountMismatch,
        'Ads activation grant is bound to a different OpenAI ad account',
        409,
      )
    case 'manifest_mismatch':
      return new AdsActivationError(AdsActivationErrorCodes.grantHashMismatch, 'Ads activation grant does not match this manifest', 409)
    case 'executor_mismatch':
      return new AdsActivationError(AdsActivationErrorCodes.grantExecutorMismatch, 'Ads activation grant is bound to another executor', 403)
    case 'expired':
      return new AdsActivationError(AdsActivationErrorCodes.grantExpired, 'Ads activation grant has expired', 409)
    case 'revoked':
      return new AdsActivationError(AdsActivationErrorCodes.grantRevoked, 'Ads activation grant was revoked', 409)
    case 'used':
      return new AdsActivationError(AdsActivationErrorCodes.grantUsed, 'Ads activation grant has already been used', 409)
    case 'operation_conflict':
      return new AdsActivationError(AdsActivationErrorCodes.operationConflict, 'Ads activation operation key conflicts with another request', 409)
    default:
      return assertNever(reason)
  }
}

async function readTarget(
  provider: AdsActivationProvider,
  target: ActivationTarget,
): Promise<AdsActivationEntitySnapshot> {
  switch (target.entityType) {
    case AdsActivationEntityTypes.campaign:
      return provider.getCampaign(target.entityId)
    case AdsActivationEntityTypes.ad_group:
      return provider.getAdGroup(target.entityId, target.parentId!)
    case AdsActivationEntityTypes.ad:
      return provider.getAd(target.entityId, target.parentId!)
    default:
      return assertNever(target.entityType)
  }
}

function assertExactEntityIds(
  expected: readonly string[],
  actual: readonly AdsActivationEntitySnapshot[],
  target: ActivationTarget,
): void {
  const expectedIds = [...expected].sort()
  const actualIds = actual.map((entity) => entity.id).sort()
  if (
    expectedIds.length !== actualIds.length
    || expectedIds.some((id, index) => id !== actualIds[index])
  ) {
    throw targetError(
      AdsActivationErrorCodes.entityMismatch,
      'Provider campaign descendants did not match the exact approved manifest',
      409,
      target,
    )
  }
}

async function validateExactDescendants(
  provider: AdsActivationProvider,
  manifest: AdsActivationManifest,
  parent: ActivationTarget,
  beforeRead: () => Promise<void> = async () => undefined,
): Promise<void> {
  if (parent.entityType === AdsActivationEntityTypes.ad) return
  if (parent.entityType === AdsActivationEntityTypes.ad_group) {
    const group = manifest.campaign.adGroups.find((candidate) => candidate.id === parent.entityId)
    if (!group) {
      throw targetError(AdsActivationErrorCodes.entityMismatch, 'Approved ad group is missing', 409, parent)
    }
    let actualAds: AdsActivationEntitySnapshot[]
    try {
      await beforeRead()
      actualAds = await provider.listAds(parent.entityId)
    } catch {
      throw targetError(AdsActivationErrorCodes.providerReadFailed, 'Approved ads could not be enumerated', 502, parent)
    }
    assertExactEntityIds(group.ads.map((ad) => ad.id), actualAds, parent)
    for (const entity of actualAds) {
      if (entity.adGroupId !== parent.entityId) {
        throw targetError(AdsActivationErrorCodes.entityMismatch, 'Provider ad parent did not match the approved manifest', 409, parent)
      }
    }
    return
  }

  let actualGroups: AdsActivationEntitySnapshot[]
  try {
    await beforeRead()
    actualGroups = await provider.listAdGroups(parent.entityId)
  } catch {
    throw targetError(AdsActivationErrorCodes.providerReadFailed, 'Approved ad groups could not be enumerated', 502, parent)
  }
  assertExactEntityIds(manifest.campaign.adGroups.map((group) => group.id), actualGroups, parent)
  for (const entity of actualGroups) {
    if (entity.campaignId !== parent.entityId) {
      throw targetError(AdsActivationErrorCodes.entityMismatch, 'Provider ad group parent did not match the approved manifest', 409, parent)
    }
  }
  for (const group of manifest.campaign.adGroups) {
    await validateExactDescendants(
      provider,
      manifest,
      {
        entityType: AdsActivationEntityTypes.ad_group,
        entityId: group.id,
        parentId: parent.entityId,
        expectedUpdatedAt: group.expectedUpdatedAt,
      },
      beforeRead,
    )
  }
}

async function activateTarget(provider: AdsActivationProvider, target: ActivationTarget): Promise<void> {
  switch (target.entityType) {
    case AdsActivationEntityTypes.campaign:
      await provider.activateCampaign(target.entityId)
      return
    case AdsActivationEntityTypes.ad_group:
      await provider.activateAdGroup(target.entityId)
      return
    case AdsActivationEntityTypes.ad:
      await provider.activateAd(target.entityId)
      return
    default:
      return assertNever(target.entityType)
  }
}

async function pauseTarget(provider: AdsActivationProvider, target: ActivationTarget): Promise<void> {
  switch (target.entityType) {
    case AdsActivationEntityTypes.campaign:
      await provider.pauseCampaign(target.entityId)
      return
    case AdsActivationEntityTypes.ad_group:
      await provider.pauseAdGroup(target.entityId)
      return
    case AdsActivationEntityTypes.ad:
      await provider.pauseAd(target.entityId)
      return
    default:
      return assertNever(target.entityType)
  }
}

/**
 * Apply the cheapest provider-side spend boundary. This deliberately does no
 * descendant work so the watchdog can contain every urgent campaign in its
 * bounded fleet batch before starting slower tree cleanup.
 */
export async function enforceAdsActivationCampaignBoundarySafety(
  provider: AdsActivationProvider,
  campaignId: string,
): Promise<boolean> {
  const target: ActivationTarget = {
    entityType: AdsActivationEntityTypes.campaign,
    entityId: campaignId,
    parentId: null,
    expectedUpdatedAt: 0,
  }
  try {
    await pauseTarget(provider, target)
  } catch {
    // A lost mutation response is followed by an authoritative read.
  }
  try {
    const entity = await readTarget(provider, target)
    validateIdentity(target, entity)
    return entity.status === PROVIDER_PAUSED
  } catch {
    return false
  }
}

/**
 * Unknown activation receipts cannot prove whether a provider mutation landed.
 * Reissuing activation is forbidden, but reissuing the reducing action (pause)
 * is safe. The watchdog uses this for recurring best-effort containment while
 * the receipt remains explicitly unknown for human remediation.
 */
export async function enforceUnknownAdsActivationSafety(
  provider: AdsActivationProvider,
  manifestInput: AdsActivationManifest,
): Promise<AdsActivationSafetyPauseResult> {
  const manifest = canonicalManifest(manifestInput)
  const rank: Record<AdsActivationEntityType, number> = {
    [AdsActivationEntityTypes.campaign]: 0,
    [AdsActivationEntityTypes.ad_group]: 1,
    [AdsActivationEntityTypes.ad]: 2,
  }
  const manifestTargets = activationTargets(manifest)
  const campaignTarget = manifestTargets.find(
    (target) => target.entityType === AdsActivationEntityTypes.campaign,
  )!
  const targetsByKey = new Map<string, ActivationTarget>(
    manifestTargets
      .filter((target) => target.entityType !== AdsActivationEntityTypes.campaign)
      .map((target) => [`${target.entityType}:${target.entityId}`, target]),
  )
  let enumerationComplete = true
  let verifiedPaused = await enforceAdsActivationCampaignBoundarySafety(
    provider,
    campaignTarget.entityId,
  ) ? 1 : 0

  // The manifest is the durable minimum containment set, but it is not an
  // authoritative description of the provider tree after an ambiguous
  // activation. Enumerate the campaign's current descendants so an entity
  // omitted from the approval cannot remain live indefinitely. Parent ids are
  // checked before issuing a reducing mutation outside the campaign boundary.
  let actualGroups: AdsActivationEntitySnapshot[] = []
  try {
    actualGroups = await provider.listAdGroups(campaignTarget.entityId)
  } catch {
    enumerationComplete = false
  }
  for (const group of actualGroups) {
    if (group.campaignId !== campaignTarget.entityId) {
      enumerationComplete = false
      continue
    }
    const groupTarget: ActivationTarget = {
      entityType: AdsActivationEntityTypes.ad_group,
      entityId: group.id,
      parentId: campaignTarget.entityId,
      expectedUpdatedAt: group.updatedAt ?? 0,
    }
    targetsByKey.set(`${groupTarget.entityType}:${groupTarget.entityId}`, groupTarget)
    let actualAds: AdsActivationEntitySnapshot[] = []
    try {
      actualAds = await provider.listAds(group.id)
    } catch {
      enumerationComplete = false
    }
    for (const ad of actualAds) {
      if (ad.adGroupId !== group.id) {
        enumerationComplete = false
        continue
      }
      const adTarget: ActivationTarget = {
        entityType: AdsActivationEntityTypes.ad,
        entityId: ad.id,
        parentId: group.id,
        expectedUpdatedAt: ad.updatedAt ?? 0,
      }
      targetsByKey.set(`${adTarget.entityType}:${adTarget.entityId}`, adTarget)
    }
  }

  const targets = [...targetsByKey.values()]
    .sort((left, right) => rank[left.entityType] - rank[right.entityType])

  for (const target of targets) {
    try {
      await pauseTarget(provider, target)
    } catch {
      // A lost pause response is still followed by an authoritative read. The
      // next watchdog sweep retries the idempotent reducing action if needed.
    }
    try {
      const entity = await readTarget(provider, target)
      validateIdentity(target, entity)
      if (entity.status === PROVIDER_PAUSED) verifiedPaused += 1
    } catch {
      // Keep the receipt unknown. Provider details are intentionally not
      // returned or logged from this safety path.
    }
  }

  return {
    attempted: targets.length + 1,
    verifiedPaused,
    fullyVerified: enumerationComplete && verifiedPaused === targets.length + 1,
  }
}

function targetError(
  code: AdsActivationErrorCode,
  message: string,
  statusCode: number,
  target: ActivationTarget,
): AdsActivationError {
  return new AdsActivationError(code, message, statusCode, undefined, {
    entityType: target.entityType,
    entityId: target.entityId,
  })
}

function validateIdentity(target: ActivationTarget, entity: AdsActivationEntitySnapshot): void {
  if (entity.id !== target.entityId) {
    throw targetError(AdsActivationErrorCodes.entityMismatch, 'Provider entity did not match the approved manifest', 409, target)
  }
  if (target.entityType === AdsActivationEntityTypes.ad_group && entity.campaignId !== target.parentId) {
    throw targetError(AdsActivationErrorCodes.entityMismatch, 'Provider ad group parent did not match the approved manifest', 409, target)
  }
  if (target.entityType === AdsActivationEntityTypes.ad && entity.adGroupId !== target.parentId) {
    throw targetError(AdsActivationErrorCodes.entityMismatch, 'Provider ad parent did not match the approved manifest', 409, target)
  }
}

function validateAdApproval(target: ActivationTarget, entity: AdsActivationEntitySnapshot): void {
  if (
    target.entityType === AdsActivationEntityTypes.ad
    && entity.reviewStatus !== AdsReviewStatuses.approved
  ) {
    throw targetError(AdsActivationErrorCodes.adNotApproved, 'Every ad must be approved before activation', 409, target)
  }
}

async function validateAccount(provider: AdsActivationProvider, adAccountId: string): Promise<void> {
  let account: AdsActivationAccountSnapshot
  try {
    account = await provider.getAccount()
  } catch {
    throw new AdsActivationError(
      AdsActivationErrorCodes.providerReadFailed,
      'OpenAI Ads account approval could not be verified',
      502,
    )
  }
  if (
    account.id !== adAccountId
    || account.reviewStatus !== AdsReviewStatuses.approved
    || account.integrityReviewStatus !== AdsReviewStatuses.approved
    || account.integrityDecision !== AdsIntegrityDecisions.allowed
  ) {
    throw new AdsActivationError(
      AdsActivationErrorCodes.accountNotApproved,
      'OpenAI Ads account is not fully approved for activation',
      409,
    )
  }
}

async function readAndValidatePaused(
  provider: AdsActivationProvider,
  target: ActivationTarget,
): Promise<AdsActivationEntitySnapshot> {
  let entity: AdsActivationEntitySnapshot
  try {
    entity = await readTarget(provider, target)
  } catch {
    throw targetError(AdsActivationErrorCodes.providerReadFailed, 'An approved ads entity could not be verified', 502, target)
  }
  validateIdentity(target, entity)
  validateAdApproval(target, entity)
  if (entity.status !== PROVIDER_PAUSED) {
    throw targetError(AdsActivationErrorCodes.entityNotPaused, 'Every approved ads entity must still be paused', 409, target)
  }
  if (entity.updatedAt !== target.expectedUpdatedAt) {
    throw targetError(AdsActivationErrorCodes.entityStale, 'An ads entity changed after approval', 409, target)
  }
  return entity
}

async function readAndValidateActiveCheckpoint(
  provider: AdsActivationProvider,
  target: ActivationTarget,
  providerUpdatedAt: number,
): Promise<void> {
  let entity: AdsActivationEntitySnapshot
  try {
    entity = await readTarget(provider, target)
  } catch {
    throw targetError(
      AdsActivationErrorCodes.providerReadFailed,
      'A previously activated ads entity could not be verified',
      502,
      target,
    )
  }
  validateIdentity(target, entity)
  validateAdApproval(target, entity)
  if (
    entity.status !== PROVIDER_ACTIVE
    || entity.updatedAt === null
    || entity.updatedAt !== providerUpdatedAt
  ) {
    throw targetError(
      AdsActivationErrorCodes.manualRemediationRequired,
      'A previously active entity no longer matches its durable activation checkpoint',
      502,
      target,
    )
  }
}

/** Read-only approval gate. It never claims a grant or sends a provider mutation. */
export async function preflightAdsActivationApproval(
  provider: AdsActivationProvider,
  request: AdsActivationApprovalPreflightRequest,
): Promise<AdsActivationApprovalPreflightResult> {
  const manifest = canonicalManifest(request.manifest)
  await validateAccount(provider, request.adAccountId)
  await validateExactDescendants(provider, manifest, {
    entityType: AdsActivationEntityTypes.campaign,
    entityId: manifest.campaign.id,
    parentId: null,
    expectedUpdatedAt: manifest.campaign.expectedUpdatedAt,
  })
  for (const target of activationTargets(manifest)) {
    await readAndValidatePaused(provider, target)
  }
  return { manifest, manifestHash: hashAdsActivationManifest(manifest) }
}

/**
 * Rebind only provider concurrency versions after an asynchronous review
 * transition. Entity IDs, exact descendants, paused state, ad approval, and
 * every materialized semantic field must still match the durable create
 * receipts. A second exact preflight closes the read-to-grant race.
 */
export async function refreshSemanticallyUnchangedAdsActivationManifest(
  provider: AdsActivationProvider,
  request: AdsActivationVersionRefreshRequest,
): Promise<AdsActivationApprovalPreflightResult> {
  const manifest = canonicalManifest(request.manifest)
  await validateAccount(provider, request.adAccountId)
  await validateExactDescendants(provider, manifest, {
    entityType: AdsActivationEntityTypes.campaign,
    entityId: manifest.campaign.id,
    parentId: null,
    expectedUpdatedAt: manifest.campaign.expectedUpdatedAt,
  })

  const versions = new Map<string, number>()
  for (const target of activationTargets(manifest)) {
    let entity: AdsActivationEntitySnapshot
    try {
      entity = await readTarget(provider, target)
    } catch {
      throw targetError(
        AdsActivationErrorCodes.providerReadFailed,
        'An ads entity could not be verified for version refresh',
        502,
        target,
      )
    }
    validateIdentity(target, entity)
    validateAdApproval(target, entity)
    if (entity.status !== PROVIDER_PAUSED) {
      throw targetError(AdsActivationErrorCodes.entityNotPaused, 'Every approved ads entity must still be paused', 409, target)
    }
    if (!Number.isInteger(entity.updatedAt) || entity.updatedAt === null || entity.updatedAt < 0) {
      throw targetError(
        AdsActivationErrorCodes.providerReadFailed,
        'An ads entity did not report a usable provider version',
        502,
        target,
      )
    }
    if (!request.semanticallyMatchesMaterialization(target.entityType, target.entityId, entity)) {
      throw targetError(
        AdsActivationErrorCodes.entityMismatch,
        'An ads entity no longer matches its materialized approved fields',
        409,
        target,
      )
    }
    versions.set(`${target.entityType}:${target.entityId}`, entity.updatedAt)
  }

  const version = (entityType: AdsActivationEntityType, entityId: string): number => {
    const current = versions.get(`${entityType}:${entityId}`)
    if (current === undefined) {
      throw new AdsActivationError(
        AdsActivationErrorCodes.persistenceFailed,
        'A refreshed ads entity version is missing',
        500,
      )
    }
    return current
  }
  const refreshed: AdsActivationManifest = {
    campaign: {
      id: manifest.campaign.id,
      expectedUpdatedAt: version(AdsActivationEntityTypes.campaign, manifest.campaign.id),
      adGroups: manifest.campaign.adGroups.map((group) => ({
        id: group.id,
        expectedUpdatedAt: version(AdsActivationEntityTypes.ad_group, group.id),
        ads: group.ads.map((ad) => ({
          id: ad.id,
          expectedUpdatedAt: version(AdsActivationEntityTypes.ad, ad.id),
        })),
      })),
    },
  }
  return preflightAdsActivationApproval(provider, {
    adAccountId: request.adAccountId,
    manifest: refreshed,
  })
}

function stepTarget(manifest: AdsActivationManifest, step: AdsActivationStepRecord): ActivationTarget {
  const target = activationTargets(manifest).find((candidate) =>
    candidate.entityType === step.entityType && candidate.entityId === step.entityId,
  )
  if (!target || target.expectedUpdatedAt !== step.expectedUpdatedAt) {
    throw new AdsActivationError(
      AdsActivationErrorCodes.persistenceFailed,
      'Activation step does not match the approved manifest',
      500,
    )
  }
  return target
}

function currentStep(ctx: ActivationContext, stepId: string): AdsActivationStepRecord {
  const step = ctx.operation.steps.find((candidate) => candidate.id === stepId)
  if (!step) {
    throw new AdsActivationError(
      AdsActivationErrorCodes.persistenceFailed,
      'Ads activation receipt step is missing',
      500,
      operationRef(ctx.operation),
    )
  }
  return step
}

function checkedStep(value: unknown): AdsActivationStepRecord {
  return adsOperationStepDtoSchema.parse(value)
}

function sanitizedPersistedText(value: string, fallback: string, maxLength: number): string {
  const withoutControls = [...value].map((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint <= 31 || codePoint === 127 ? ' ' : character
  }).join('')
  const sanitized = withoutControls
    .replace(/\s+/g, ' ')
    .trim()
  return (sanitized || fallback).slice(0, maxLength)
}

function persistedErrorCode(code: string): string {
  return sanitizedPersistedText(code, AdsActivationErrorCodes.persistenceFailed, 100)
}

function persistedErrorMessage(message: string): string {
  return sanitizedPersistedText(message, 'Ads activation failed', 500)
}

function persistedRemediation(message: string): string {
  return sanitizedPersistedText(message, 'Review provider state before retrying', 500)
}

function executingStep(step: AdsActivationStepRecord, now: string): AdsActivationStepRecord {
  return checkedStep({
    ...step,
    state: AdsOperationStepStates.executing,
    providerUpdatedAt: null,
    errorCode: null,
    errorMessage: null,
    remediation: null,
    startedAt: now,
    finishedAt: null,
    updatedAt: now,
  })
}

function activeStep(step: AdsActivationStepRecord, providerUpdatedAt: number, now: string): AdsActivationStepRecord {
  return checkedStep({
    ...step,
    state: AdsOperationStepStates.active,
    providerUpdatedAt,
    errorCode: null,
    errorMessage: null,
    remediation: null,
    startedAt: step.startedAt ?? now,
    finishedAt: now,
    updatedAt: now,
  })
}

function failedStep(
  step: AdsActivationStepRecord,
  error: AdsActivationError,
  now: string,
): AdsActivationStepRecord {
  return checkedStep({
    ...step,
    state: AdsOperationStepStates.failed,
    providerUpdatedAt: step.providerUpdatedAt,
    errorCode: persistedErrorCode(error.code),
    errorMessage: persistedErrorMessage(error.message),
    remediation: persistedRemediation('Review the failed preflight and approve a new activation manifest'),
    startedAt: step.startedAt ?? now,
    finishedAt: now,
    updatedAt: now,
  })
}

function unknownStep(
  step: AdsActivationStepRecord,
  error: AdsActivationError,
  providerUpdatedAt: number | null,
  now: string,
): AdsActivationStepRecord {
  return checkedStep({
    ...step,
    state: AdsOperationStepStates.unknown,
    providerUpdatedAt,
    errorCode: persistedErrorCode(error.code),
    errorMessage: persistedErrorMessage(error.message),
    remediation: persistedRemediation('Reconcile provider state and pause the entity manually if necessary'),
    startedAt: step.startedAt ?? now,
    finishedAt: now,
    updatedAt: now,
  })
}

function rollbackExecutingStep(
  step: AdsActivationStepRecord,
  providerUpdatedAt: number,
  now: string,
): AdsActivationStepRecord {
  return checkedStep({
    ...step,
    state: AdsOperationStepStates.rollback_executing,
    providerUpdatedAt,
    errorCode: null,
    errorMessage: null,
    remediation: persistedRemediation('Pausing the entity after activation did not complete'),
    startedAt: step.startedAt ?? now,
    finishedAt: null,
    updatedAt: now,
  })
}

function rolledBackStep(
  step: AdsActivationStepRecord,
  providerUpdatedAt: number,
  now: string,
): AdsActivationStepRecord {
  return checkedStep({
    ...step,
    state: AdsOperationStepStates.rolled_back,
    providerUpdatedAt,
    errorCode: null,
    errorMessage: null,
    remediation: persistedRemediation('Entity was verified paused after activation did not complete'),
    startedAt: step.startedAt ?? now,
    finishedAt: now,
    updatedAt: now,
  })
}

function rollbackFailedStep(
  step: AdsActivationStepRecord,
  error: AdsActivationError,
  providerUpdatedAt: number,
  now: string,
): AdsActivationStepRecord {
  return checkedStep({
    ...step,
    state: AdsOperationStepStates.rollback_failed,
    providerUpdatedAt,
    errorCode: persistedErrorCode(error.code),
    errorMessage: persistedErrorMessage(error.message),
    remediation: persistedRemediation('Pause the entity manually before attempting another activation'),
    startedAt: step.startedAt ?? now,
    finishedAt: now,
    updatedAt: now,
  })
}

function leaseExpiry(ctx: ActivationContext, now: Date): string {
  return new Date(now.getTime() + ctx.deps.leaseMs).toISOString()
}

async function renewLease(ctx: ActivationContext): Promise<void> {
  const now = ctx.deps.now()
  const result = await ctx.deps.store.renewLease({
    operationId: ctx.operation.id,
    leaseOwner: ctx.leaseOwner,
    now: now.toISOString(),
    leaseExpiresAt: leaseExpiry(ctx, now),
  })
  if (!result.applied) {
    throw new AdsActivationError(
      AdsActivationErrorCodes.persistenceFailed,
      'Ads activation lease was lost before provider I/O',
      409,
      operationRef(result.operation),
    )
  }
  ctx.operation = result.operation
}

async function withLeaseHeartbeat<T>(
  ctx: ActivationContext,
  work: () => Promise<T>,
): Promise<T> {
  const heartbeatIntervalMs = Math.max(
    25,
    Math.min(30_000, Math.floor(ctx.deps.leaseMs / 3)),
  )
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let heartbeatPromise: Promise<void> | undefined
  let heartbeatFailure: AdsActivationError | undefined

  const schedule = (): void => {
    if (stopped || heartbeatFailure) return
    timer = setTimeout(() => {
      const now = ctx.deps.now()
      heartbeatPromise = ctx.deps.store.renewLease({
        operationId: ctx.operation.id,
        leaseOwner: ctx.leaseOwner,
        now: now.toISOString(),
        leaseExpiresAt: leaseExpiry(ctx, now),
      }).then((result) => {
        if (
          !result.applied
          && result.operation.state === AdsOperationStates.pending
        ) {
          throw new AdsActivationError(
            AdsActivationErrorCodes.persistenceFailed,
            'Ads activation lease heartbeat was lost',
            409,
            operationRef(result.operation),
          )
        }
      }).catch((cause: unknown) => {
        heartbeatFailure = cause instanceof AdsActivationError
          ? cause
          : new AdsActivationError(
              AdsActivationErrorCodes.persistenceFailed,
              'Ads activation lease heartbeat failed',
              500,
              operationRef(ctx.operation),
            )
      }).finally(() => {
        heartbeatPromise = undefined
        schedule()
      })
    }, heartbeatIntervalMs)
  }

  schedule()
  let outcome: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    outcome = { ok: true, value: await work() }
  } catch (error) {
    outcome = { ok: false, error }
  } finally {
    stopped = true
    if (timer) clearTimeout(timer)
    await heartbeatPromise
  }
  if (!outcome.ok) throw outcome.error
  if (heartbeatFailure) throw heartbeatFailure
  return outcome.value
}

async function refreshGrant(ctx: ActivationContext): Promise<void> {
  const grant = await ctx.deps.store.loadGrant(ctx.grant.id)
  if (!grant) {
    throw new AdsActivationError(
      AdsActivationErrorCodes.persistenceFailed,
      'Ads activation grant could not be reloaded',
      500,
      operationRef(ctx.operation),
    )
  }
  ctx.grant = grant
  if (grant.state === AdsActivationGrantStates.revoked) {
    throw claimError('revoked')
  }
  if (grant.revocationRequestedAt !== null) {
    throw claimError('revoked')
  }
  if (grant.state !== AdsActivationGrantStates.executing) {
    throw new AdsActivationError(
      AdsActivationErrorCodes.persistenceFailed,
      'Ads activation grant is no longer executable',
      409,
      operationRef(ctx.operation),
    )
  }
  const expiresAt = Date.parse(grant.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= ctx.deps.now().getTime()) {
    throw new AdsActivationError(
      AdsActivationErrorCodes.grantExpired,
      'Ads activation grant expired before the next forward step was authorized',
      409,
      operationRef(ctx.operation),
    )
  }
}

async function releaseForRetry(ctx: ActivationContext, error: AdsActivationError): Promise<never> {
  const result = await ctx.deps.store.releaseLease({
    operationId: ctx.operation.id,
    leaseOwner: ctx.leaseOwner,
    now: ctx.deps.now().toISOString(),
  })
  ctx.operation = result.operation
  throw new AdsActivationError(
    error.code,
    'Ads activation was interrupted before the next provider mutation and can be resumed safely',
    error.statusCode,
    operationRef(ctx.operation),
    error.entity,
  )
}

async function transitionStep(
  ctx: ActivationContext,
  current: AdsActivationStepRecord,
  next: AdsActivationStepRecord,
): Promise<boolean> {
  const now = ctx.deps.now()
  const result = await ctx.deps.store.transitionStep({
    operationId: ctx.operation.id,
    leaseOwner: ctx.leaseOwner,
    fromState: current.state,
    next,
    leaseExpiresAt: leaseExpiry(ctx, now),
  })
  ctx.operation = result.operation
  return result.applied
}

async function authorizeStep(
  ctx: ActivationContext,
  current: AdsActivationStepRecord,
  next: AdsActivationStepRecord,
): Promise<boolean> {
  const now = ctx.deps.now()
  const result = await ctx.deps.store.authorizeStep({
    operationId: ctx.operation.id,
    grantId: ctx.grant.id,
    leaseOwner: ctx.leaseOwner,
    fromState: current.state,
    next,
    now: now.toISOString(),
    leaseExpiresAt: leaseExpiry(ctx, now),
  })
  ctx.operation = result.operation
  if (result.rejection === 'expired') {
    throw new AdsActivationError(
      AdsActivationErrorCodes.grantExpired,
      'Ads activation grant expired before the next forward step was authorized',
      409,
      operationRef(ctx.operation),
    )
  }
  if (result.rejection === 'revoked') {
    throw new AdsActivationError(
      AdsActivationErrorCodes.grantRevoked,
      'Ads activation was revoked before the next forward step was authorized',
      409,
      operationRef(ctx.operation),
    )
  }
  return result.applied
}

function assertClaimBinding(
  request: AdsActivationRequest,
  manifest: AdsActivationManifest,
  requestHash: string,
  grant: AdsActivationGrantRecord,
  operation: AdsActivationOperationRecord,
): void {
  if (grant.id !== request.grantId) throw claimError('grant_not_found')
  if (grant.projectId !== request.projectId || operation.projectId !== request.projectId) {
    throw claimError('project_mismatch')
  }
  if (
    grant.manifestHash !== request.manifestHash
    || serializeAdsActivationManifest(grant.manifest) !== serializeAdsActivationManifest(manifest)
  ) {
    throw claimError('manifest_mismatch')
  }
  if (grant.executorApiKeyId !== request.executorApiKeyId) throw claimError('executor_mismatch')
  if (grant.operationId !== operation.id) {
    throw new AdsActivationError(
      AdsActivationErrorCodes.persistenceFailed,
      'Ads activation grant binding was not persisted',
      500,
      operationRef(operation),
    )
  }
  if (
    operation.adAccountId !== request.adAccountId
    || operation.operationKey !== request.operationKey
    || operation.requestHash !== requestHash
    || operation.entityType !== AdsActivationEntityTypes.campaign
    || operation.entityId !== manifest.campaign.id
  ) {
    throw claimError('operation_conflict')
  }

  const expectedTargets = activationTargets(manifest)
  if (operation.steps.length !== expectedTargets.length) {
    throw new AdsActivationError(AdsActivationErrorCodes.persistenceFailed, 'Activation step count is invalid', 500)
  }
  for (const [ordinal, target] of expectedTargets.entries()) {
    const step = operation.steps.find((candidate) => candidate.ordinal === ordinal)
    if (
      !step
      || step.operationId !== operation.id
      || step.entityType !== target.entityType
      || step.entityId !== target.entityId
      || step.expectedUpdatedAt !== target.expectedUpdatedAt
    ) {
      throw new AdsActivationError(AdsActivationErrorCodes.persistenceFailed, 'Activation steps do not match the approved manifest', 500)
    }
  }
}

function activationResult(
  grant: AdsActivationGrantRecord,
  operation: AdsActivationOperationRecord,
  replayed: boolean,
): AdsActivationResult {
  return {
    grant,
    operation,
    steps: operation.steps,
    replayed,
    inProgress: operation.state === AdsOperationStates.pending,
    manualRemediationRequired:
      operation.state === AdsOperationStates.unknown
      || operation.steps.some((step) =>
        step.state === AdsOperationStepStates.unknown
        || step.state === AdsOperationStepStates.rollback_failed,
      ),
  }
}

async function finish(
  ctx: ActivationContext,
  operationState: AdsActivationFinishInput['operationState'],
  grantState: AdsActivationFinishInput['grantState'],
  error: AdsActivationError | undefined,
): Promise<AdsActivationFinishResult> {
  const result = await ctx.deps.store.finishOperation({
    operationId: ctx.operation.id,
    grantId: ctx.grant.id,
    leaseOwner: ctx.leaseOwner,
    operationState,
    grantState,
    errorCode: error?.code ?? null,
    errorMessage: error?.message ?? null,
    now: ctx.deps.now().toISOString(),
  })
  ctx.grant = result.grant
  ctx.operation = result.operation
  return result
}

function hasMutationEvidence(operation: AdsActivationOperationRecord): boolean {
  return operation.steps.some((step) => step.state !== AdsOperationStepStates.pending)
}

async function failBeforeMutation(ctx: ActivationContext, error: AdsActivationError): Promise<never> {
  if (error.entity) {
    const step = ctx.operation.steps.find((candidate) =>
      candidate.entityType === error.entity!.entityType && candidate.entityId === error.entity!.entityId,
    )
    if (step?.state === AdsOperationStepStates.pending) {
      await transitionStep(ctx, step, failedStep(step, error, ctx.deps.now().toISOString()))
    }
  }
  await finish(ctx, AdsOperationStates.failed, AdsActivationGrantStates.consumed, error)
  throw new AdsActivationError(error.code, 'Ads activation preflight failed', error.statusCode, operationRef(ctx.operation))
}

async function recoverAndPreflight(ctx: ActivationContext): Promise<void> {
  await renewLease(ctx)
  await validateAccount(ctx.deps.provider, ctx.request.adAccountId)
  await validateExactDescendants(
    ctx.deps.provider,
    ctx.manifest,
    {
      entityType: AdsActivationEntityTypes.campaign,
      entityId: ctx.manifest.campaign.id,
      parentId: null,
      expectedUpdatedAt: ctx.manifest.campaign.expectedUpdatedAt,
    },
    () => renewLease(ctx),
  )
  for (const step of [...ctx.operation.steps].sort((left, right) => left.ordinal - right.ordinal)) {
    const target = stepTarget(ctx.manifest, step)
    await renewLease(ctx)
    if (step.state === AdsOperationStepStates.pending) {
      await readAndValidatePaused(ctx.deps.provider, target)
      continue
    }
    if (step.state === AdsOperationStepStates.active) {
      await readAndValidateActiveCheckpoint(ctx.deps.provider, target, step.providerUpdatedAt)
      continue
    }
    if (step.state === AdsOperationStepStates.executing) {
      let entity: AdsActivationEntitySnapshot
      try {
        entity = await readTarget(ctx.deps.provider, target)
      } catch {
        const error = targetError(AdsActivationErrorCodes.providerReadFailed, 'Activation outcome could not be verified', 502, target)
        await transitionStep(ctx, step, unknownStep(step, error, null, ctx.deps.now().toISOString()))
        throw error
      }
      validateIdentity(target, entity)
      validateAdApproval(target, entity)
      if (entity.status === PROVIDER_ACTIVE && entity.updatedAt !== null) {
        await transitionStep(ctx, step, activeStep(step, entity.updatedAt, ctx.deps.now().toISOString()))
        continue
      }
      const error = targetError(AdsActivationErrorCodes.manualRemediationRequired, 'Ambiguous activation cannot be safely resent', 502, target)
      await transitionStep(ctx, step, unknownStep(step, error, entity.updatedAt, ctx.deps.now().toISOString()))
      throw error
    }
    throw targetError(AdsActivationErrorCodes.manualRemediationRequired, 'Activation is already in rollback recovery', 502, target)
  }
}

function isActivationDescendant(
  candidate: ActivationTarget,
  parent: ActivationTarget,
): boolean {
  switch (parent.entityType) {
    case AdsActivationEntityTypes.ad:
      return false
    case AdsActivationEntityTypes.ad_group:
      return candidate.entityType === AdsActivationEntityTypes.ad
        && candidate.parentId === parent.entityId
    case AdsActivationEntityTypes.campaign:
      return candidate.entityType !== AdsActivationEntityTypes.campaign
    default:
      return assertNever(parent.entityType)
  }
}

async function validateActiveDescendants(
  ctx: ActivationContext,
  parent: ActivationTarget,
): Promise<void> {
  for (const step of [...ctx.operation.steps].sort((left, right) => left.ordinal - right.ordinal)) {
    if (step.state !== AdsOperationStepStates.active) continue
    const candidate = stepTarget(ctx.manifest, step)
    if (!isActivationDescendant(candidate, parent)) continue
    await renewLease(ctx)
    await readAndValidateActiveCheckpoint(
      ctx.deps.provider,
      candidate,
      step.providerUpdatedAt,
    )
  }
}

async function activateOne(ctx: ActivationContext, original: AdsActivationStepRecord): Promise<void> {
  let step = currentStep(ctx, original.id)
  if (step.state === AdsOperationStepStates.active) {
    const target = stepTarget(ctx.manifest, step)
    await validateExactDescendants(
      ctx.deps.provider,
      ctx.manifest,
      target,
      () => renewLease(ctx),
    )
    await validateActiveDescendants(ctx, target)
    await renewLease(ctx)
    await readAndValidateActiveCheckpoint(
      ctx.deps.provider,
      target,
      step.providerUpdatedAt,
    )
    return
  }
  if (step.state !== AdsOperationStepStates.pending) {
    throw new AdsActivationError(
      AdsActivationErrorCodes.manualRemediationRequired,
      'Activation step is not safe to issue',
      502,
      operationRef(ctx.operation),
    )
  }
  const target = stepTarget(ctx.manifest, step)
  await renewLease(ctx)
  await validateExactDescendants(
    ctx.deps.provider,
    ctx.manifest,
    target,
    () => renewLease(ctx),
  )
  await refreshGrant(ctx)
  await validateActiveDescendants(ctx, target)
  await renewLease(ctx)
  await validateAccount(ctx.deps.provider, ctx.request.adAccountId)
  await renewLease(ctx)
  await readAndValidatePaused(ctx.deps.provider, target)
  const now = ctx.deps.now().toISOString()
  if (!await authorizeStep(ctx, step, executingStep(step, now))) {
    throw new AdsActivationError(AdsActivationErrorCodes.persistenceFailed, 'Activation step could not be claimed', 409)
  }
  step = currentStep(ctx, step.id)

  try {
    await activateTarget(ctx.deps.provider, target)
  } catch {
    // The request may have reached the provider; the GET below is authoritative.
  }

  // Keep the lease fenced across the activation request and its verification
  // read. The activation lease is deliberately longer than two provider
  // request timeouts, and this renewal gives the read a fresh full window.
  await renewLease(ctx)

  let entity: AdsActivationEntitySnapshot
  try {
    entity = await readTarget(ctx.deps.provider, target)
  } catch {
    const error = targetError(AdsActivationErrorCodes.providerMutationFailed, 'Provider activation outcome could not be verified', 502, target)
    await transitionStep(ctx, step, unknownStep(step, error, null, ctx.deps.now().toISOString()))
    throw error
  }
  try {
    validateIdentity(target, entity)
    validateAdApproval(target, entity)
    if (entity.status !== PROVIDER_ACTIVE || entity.updatedAt === null) {
      throw targetError(AdsActivationErrorCodes.providerMutationFailed, 'Provider did not confirm the required active state', 502, target)
    }
  } catch (cause) {
    const error = cause instanceof AdsActivationError
      ? cause
      : targetError(AdsActivationErrorCodes.providerMutationFailed, 'Provider activation validation failed', 502, target)
    await transitionStep(ctx, step, unknownStep(step, error, entity.updatedAt, ctx.deps.now().toISOString()))
    throw error
  }
  await validateExactDescendants(
    ctx.deps.provider,
    ctx.manifest,
    target,
    () => renewLease(ctx),
  )
  await validateActiveDescendants(ctx, target)
  await renewLease(ctx)
  await readAndValidateActiveCheckpoint(
    ctx.deps.provider,
    target,
    entity.updatedAt,
  )
  if (!await transitionStep(ctx, step, activeStep(step, entity.updatedAt, ctx.deps.now().toISOString()))) {
    throw targetError(AdsActivationErrorCodes.persistenceFailed, 'Confirmed activation could not be checkpointed', 502, target)
  }
}

function rollbackTargets(ctx: ActivationContext): AdsActivationStepRecord[] {
  const rank: Record<AdsActivationEntityType, number> = {
    [AdsActivationEntityTypes.campaign]: 0,
    [AdsActivationEntityTypes.ad_group]: 1,
    [AdsActivationEntityTypes.ad]: 2,
  }
  return ctx.operation.steps
    .filter((step) => step.state !== AdsOperationStepStates.pending && step.state !== AdsOperationStepStates.failed)
    .sort((left, right) => rank[left.entityType] - rank[right.entityType] || left.ordinal - right.ordinal)
}

async function rollbackOne(ctx: ActivationContext, original: AdsActivationStepRecord): Promise<boolean> {
  let step = currentStep(ctx, original.id)
  const target = stepTarget(ctx.manifest, step)
  // An unknown step may represent either an activation that will apply late or
  // a rollback pause whose outcome could not be read. Never infer safety from
  // one provider read and never resend either ambiguous mutation.
  if (step.state === AdsOperationStepStates.unknown) return false
  let entity: AdsActivationEntitySnapshot
  try {
    await renewLease(ctx)
    entity = await readTarget(ctx.deps.provider, target)
  } catch {
    const error = targetError(AdsActivationErrorCodes.manualRemediationRequired, 'Provider state could not be read during rollback', 502, target)
    await transitionStep(ctx, step, unknownStep(step, error, null, ctx.deps.now().toISOString()))
    return false
  }

  const now = ctx.deps.now().toISOString()
  if (entity.updatedAt === null) {
    const error = targetError(AdsActivationErrorCodes.manualRemediationRequired, 'Provider rollback timestamp is missing', 502, target)
    await transitionStep(ctx, step, unknownStep(step, error, null, now))
    return false
  }
  try {
    validateIdentity(target, entity)
  } catch (cause) {
    const error = cause as AdsActivationError
    await transitionStep(ctx, step, rollbackFailedStep(step, error, entity.updatedAt, now))
    return false
  }
  if (entity.status === PROVIDER_PAUSED) {
    if (step.state === AdsOperationStepStates.executing) {
      const error = targetError(
        AdsActivationErrorCodes.manualRemediationRequired,
        'An ambiguous activation may still apply after the provider reported paused',
        502,
        target,
      )
      await transitionStep(ctx, step, unknownStep(step, error, entity.updatedAt, now))
      return false
    }
    if (step.state === AdsOperationStepStates.rolled_back) return true
    return transitionStep(ctx, step, rolledBackStep(step, entity.updatedAt, now))
  }
  if (entity.status !== PROVIDER_ACTIVE) {
    const error = targetError(AdsActivationErrorCodes.manualRemediationRequired, 'Provider did not report a safe rollback state', 502, target)
    await transitionStep(ctx, step, rollbackFailedStep(step, error, entity.updatedAt, now))
    return false
  }
  if (
    step.state === AdsOperationStepStates.rollback_executing
    || step.state === AdsOperationStepStates.rolled_back
    || step.state === AdsOperationStepStates.rollback_failed
  ) {
    if (step.state === AdsOperationStepStates.rollback_failed) return false
    const error = targetError(AdsActivationErrorCodes.manualRemediationRequired, 'An ambiguous rollback mutation cannot be resent', 502, target)
    await transitionStep(ctx, step, rollbackFailedStep(step, error, entity.updatedAt, now))
    return false
  }
  if (!await transitionStep(ctx, step, rollbackExecutingStep(step, entity.updatedAt, now))) return false
  step = currentStep(ctx, step.id)
  try {
    await renewLease(ctx)
    await pauseTarget(ctx.deps.provider, target)
  } catch {
    // Verify with GET; never blindly resend this pause on replay.
  }
  try {
    await renewLease(ctx)
    entity = await readTarget(ctx.deps.provider, target)
  } catch {
    const error = targetError(AdsActivationErrorCodes.manualRemediationRequired, 'Provider rollback outcome could not be verified', 502, target)
    await transitionStep(ctx, step, unknownStep(step, error, null, ctx.deps.now().toISOString()))
    return false
  }
  if (entity.updatedAt === null) {
    const error = targetError(AdsActivationErrorCodes.manualRemediationRequired, 'Provider rollback timestamp is missing', 502, target)
    await transitionStep(ctx, step, unknownStep(step, error, null, ctx.deps.now().toISOString()))
    return false
  }
  if (entity.id !== target.entityId || entity.status !== PROVIDER_PAUSED) {
    const error = targetError(AdsActivationErrorCodes.manualRemediationRequired, 'Provider did not confirm the required paused state', 502, target)
    await transitionStep(ctx, step, rollbackFailedStep(step, error, entity.updatedAt, ctx.deps.now().toISOString()))
    return false
  }
  return transitionStep(ctx, step, rolledBackStep(step, entity.updatedAt, ctx.deps.now().toISOString()))
}

async function rollback(ctx: ActivationContext, cause: AdsActivationError): Promise<never> {
  let complete = true
  for (const step of rollbackTargets(ctx)) {
    if (!await rollbackOne(ctx, step)) complete = false
  }
  if (complete) {
    await finish(
      ctx,
      AdsOperationStates.failed,
      AdsActivationGrantStates.consumed,
      cause,
    )
    throw new AdsActivationError(cause.code, 'Ads activation failed and was rolled back', cause.statusCode, operationRef(ctx.operation))
  }
  const unknown = new AdsActivationError(
    AdsActivationErrorCodes.manualRemediationRequired,
    'Ads activation rollback could not be fully verified',
    502,
    operationRef(ctx.operation),
  )
  await finish(ctx, AdsOperationStates.unknown, AdsActivationGrantStates.unknown, unknown)
  throw unknown
}

async function executeClaimedActivation(ctx: ActivationContext): Promise<AdsActivationResult> {
  try {
    await refreshGrant(ctx)
  } catch (cause) {
    const error = cause as AdsActivationError
    if (hasMutationEvidence(ctx.operation)) return rollback(ctx, error)
    return failBeforeMutation(ctx, error)
  }

  try {
    await recoverAndPreflight(ctx)
  } catch (cause) {
    const error = cause instanceof AdsActivationError
      ? cause
      : new AdsActivationError(AdsActivationErrorCodes.providerReadFailed, 'Ads activation preflight failed', 502)
    if (error.code === AdsActivationErrorCodes.providerReadFailed && !hasMutationEvidence(ctx.operation)) {
      return releaseForRetry(ctx, error)
    }
    if (hasMutationEvidence(ctx.operation)) return rollback(ctx, error)
    return failBeforeMutation(ctx, error)
  }

  for (const original of [...ctx.operation.steps].sort((left, right) => left.ordinal - right.ordinal)) {
    try {
      await activateOne(ctx, original)
    } catch (cause) {
      const error = cause instanceof AdsActivationError
        ? cause
        : new AdsActivationError(AdsActivationErrorCodes.providerMutationFailed, 'Ads activation failed', 502)
      if (error.code === AdsActivationErrorCodes.providerReadFailed && !hasMutationEvidence(ctx.operation)) {
        return releaseForRetry(ctx, error)
      }
      return rollback(ctx, error)
    }
  }

  try {
    await refreshGrant(ctx)
  } catch (cause) {
    return rollback(ctx, cause as AdsActivationError)
  }
  let finished: AdsActivationFinishResult
  try {
    finished = await finish(ctx, AdsOperationStates.succeeded, AdsActivationGrantStates.consumed, undefined)
  } catch (cause) {
    if (
      cause instanceof AdsActivationError
      && (
        cause.code === AdsActivationErrorCodes.grantRevoked
        || cause.code === AdsActivationErrorCodes.grantExpired
      )
    ) {
      return rollback(ctx, cause)
    }
    throw cause
  }
  return activationResult(finished.grant, finished.operation, ctx.replayed || !finished.applied)
}

/**
 * Execute, replay, or resume one approval-bound activation. Mutations run ads
 * first, ad groups second, and campaign last. Rollback uses the inverse safety
 * order and never resends an ambiguous provider mutation.
 */
export async function executeApprovedAdsActivation(
  dependencies: AdsActivationDependencies,
  request: AdsActivationRequest,
): Promise<AdsActivationResult> {
  const manifest = canonicalManifest(request.manifest)
  const manifestHash = hashAdsActivationManifest(manifest)
  if (
    !adsActivationManifestHashSchema.safeParse(request.manifestHash).success
    || request.manifestHash !== manifestHash
  ) {
    throw claimError('manifest_mismatch')
  }
  const requestHash = hashAdsActivationOperationRequest(request)
  const deps: ActivationContext['deps'] = {
    store: dependencies.store,
    provider: dependencies.provider,
    now: dependencies.now ?? (() => new Date()),
    randomId: dependencies.randomId ?? (() => crypto.randomUUID()),
    leaseMs: dependencies.leaseMs ?? DEFAULT_LEASE_MS,
  }
  if (!Number.isSafeInteger(deps.leaseMs) || deps.leaseMs <= 0) {
    throw new AdsActivationError(AdsActivationErrorCodes.invalidManifest, 'Activation lease duration is invalid', 400)
  }

  const now = deps.now()
  const operationId = deps.randomId()
  const leaseOwner = deps.randomId()
  const nowIso = now.toISOString()
  const claim = await deps.store.claimGrantAndOperation({
    grantId: request.grantId,
    projectId: request.projectId,
    adAccountId: request.adAccountId,
    operationId,
    operationKey: request.operationKey,
    manifest,
    manifestHash,
    requestHash,
    executorApiKeyId: request.executorApiKeyId,
    leaseOwner,
    now: nowIso,
    leaseExpiresAt: new Date(now.getTime() + deps.leaseMs).toISOString(),
    steps: buildAdsActivationSteps(manifest, operationId, nowIso, deps.randomId),
  })
  if (claim.kind === 'rejected') throw claimError(claim.reason)
  assertClaimBinding(request, manifest, requestHash, claim.grant, claim.operation)
  if (claim.kind === 'replay' || claim.kind === 'busy') {
    return activationResult(claim.grant, claim.operation, true)
  }

  const ctx: ActivationContext = {
    deps,
    request,
    manifest,
    operation: claim.operation,
    grant: claim.grant,
    leaseOwner,
    replayed: claim.kind === 'resumed',
  }
  if (ctx.operation.state !== AdsOperationStates.pending) {
    return activationResult(ctx.grant, ctx.operation, true)
  }
  return withLeaseHeartbeat(ctx, () => executeClaimedActivation(ctx))
}
