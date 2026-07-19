import crypto from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { eq, and, asc, gt, gte, lt, lte, ne, inArray, or, isNull, isNotNull, sql } from 'drizzle-orm'
import {
  ADS_WRITE_SCOPE,
  AdsAdGroupBillingEventTypes,
  AdsCampaignBiddingTypes,
  AdsEntityTypes,
  AdsEntityStatuses,
  AdsOperationKinds,
  AdsOperationStates,
  AdsReconcileStrategies,
  AppError,
  adsAdCreateRequestSchema,
  adsAdGroupBillingEventTypeSchema,
  adsAdGroupCreateRequestSchema,
  adsAdGroupUpdateRequestSchema,
  adsAdUpdateRequestSchema,
  adsCampaignCreateRequestSchema,
  adsCampaignBiddingTypeSchema,
  adsCampaignUpdateRequestSchema,
  adsConnectRequestSchema,
  adsImageUploadRequestSchema,
  adsGeoSearchQuerySchema,
  adsInsightLevelSchema,
  adsPauseRequestSchema,
  adsUnresolvedOperationListQuerySchema,
  adsCtr,
  adsCpcMicros,
  alreadyExists,
  notFound,
  operationInProgress,
  providerError,
  validationError,
  RunKinds,
  RunStatuses,
  RunTriggers,
} from '@ainyc/canonry-contracts'
import type {
  AdsAdDto,
  AdsAdGroupDto,
  AdsAdGroupBillingEventType,
  AdsCampaignBiddingType,
  AdsCampaignDto,
  AdsCampaignListResponse,
  AdsConnectionStatusDto,
  AdsCreativeDto,
  AdsDisconnectResponse,
  AdsInsightLevel,
  AdsInsightRowDto,
  AdsInsightsResponse,
  AdsSummaryDto,
  AdsSyncResponse,
  AdsEntityType,
  AdsEntityStatus,
  AdsOperationDto,
  AdsOperationKind,
  AdsOperationResponse,
  AdsOperationReconcileResponse,
  AdsReconcileFields,
  AdsReconcileStrategy,
  AdsUnresolvedOperationListResponse,
  AdsAccountDto,
  AdsGeoSearchQuery,
  AdsGeoSearchResponse,
  AdsConversionPixelListResponse,
  AdsConversionEventSettingListResponse,
} from '@ainyc/canonry-contracts'
import { adsConnections, adsCampaigns, adsAdGroups, adsAds, adsInsightsDaily, adsOperations, projects, runs } from '@ainyc/canonry-db'
import { requireScope } from './auth.js'
import { resolveProject, writeAuditLog, auditFromRequest } from './helpers.js'

export interface AdsConnectionConfigEntryLike {
  projectName: string
  apiKey: string
  adAccountId?: string | null
  createdAt: string
  updatedAt: string
}

/** Wraps the openaiAds block of ~/.canonry/config.yaml (the key never touches the DB). */
export interface AdsCredentialStore {
  getConnection(projectName: string): AdsConnectionConfigEntryLike | undefined
  upsertConnection(entry: AdsConnectionConfigEntryLike): unknown
  removeConnection(projectName: string): boolean
}

export interface VerifiedAdsAccount {
  id: string
  name: string
  status: string
  currencyCode: string | null
  timezone: string | null
  reviewStatus: string | null
  integrityReviewStatus: string | null
  integrityDecision: string | null
}

/** Read-only live provider surfaces used to plan a valid campaign. */
export interface AdsReader {
  getAccount(apiKey: string): Promise<AdsAccountDto>
  searchGeo(apiKey: string, query: AdsGeoSearchQuery): Promise<AdsGeoSearchResponse>
  listConversionPixels(apiKey: string): Promise<AdsConversionPixelListResponse>
  listConversionEventSettings(apiKey: string): Promise<AdsConversionEventSettingListResponse>
}

export interface AdsRoutesOptions {
  adsCredentialStore?: AdsCredentialStore
  /** Validates an SDK key against the upstream ad account (host wires this to the integration client). */
  verifyAdsAccount?: (apiKey: string) => Promise<VerifiedAdsAccount>
  /** Optional read adapter. The host resolves the project credential server-side. */
  adsReader?: AdsReader
  /** Fired after a manual sync run row is created; host runs the ads-sync worker. */
  onAdsSyncRequested?: (runId: string, projectId: string) => void
  /** Optional lifecycle adapter. The host resolves the project credential and calls the upstream Ads API. */
  adsOperator?: AdsOperator
  /** Receipt reconciler cadence. Set to 0 to disable the background sweeper. */
  adsReconcileSweepIntervalMs?: number
  /** A pending receipt cannot be manually or automatically claimed until it has been idle this long. */
  adsReconcilePendingStaleMs?: number
  /** Base delay for exponential retries after an inconclusive reconciliation. */
  adsReconcileBackoffBaseMs?: number
  /** Maximum inspection attempts before a receipt is quarantined. */
  adsReconcileMaxAttempts?: number
  /** Upper bound on receipts inspected per sweep. */
  adsReconcileBatchSize?: number
  /** Exclusive lease duration for one reconciliation attempt. */
  adsReconcileLeaseMs?: number
  /** TTL for an exact credential/account verification result. Set to 0 to disable. */
  adsAccountVerificationCacheTtlMs?: number
}

export interface AdsOperatorEntityResult {
  id: string
  status: string
  updatedAt: number
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
  campaignId?: string | null
  contextHints?: string[] | null
  maxBidMicros?: number | null
  adGroupId?: string | null
  creative?: { title: string; body: string; targetUrl: string; fileId: string } | null
}

/**
 * Provider lifecycle adapter. Create methods must request paused entities; the
 * route verifies that postcondition and emergency-pauses any mismatch.
 */
export interface AdsOperator {
  uploadImage(apiKey: string, imageUrl: string): Promise<{ fileId: string }>
  getCampaign(apiKey: string, id: string): Promise<AdsOperatorEntityResult>
  listCampaigns(apiKey: string): Promise<AdsOperatorEntityResult[]>
  createCampaign(apiKey: string, input: {
    name: string
    description?: string
    startTime?: number
    endTime?: number
    lifetimeSpendLimitMicros: number
    locationIds: string[]
    biddingType: AdsCampaignBiddingType
    conversionEventSettingIds?: string[]
  }): Promise<AdsOperatorEntityResult>
  updateCampaign(apiKey: string, id: string, input: {
    name?: string
    description?: string | null
    startTime?: number | null
    endTime?: number | null
    lifetimeSpendLimitMicros?: number
    locationIds?: string[]
  }): Promise<AdsOperatorEntityResult>
  pauseCampaign(apiKey: string, id: string): Promise<AdsOperatorEntityResult>
  getAdGroup(apiKey: string, id: string): Promise<AdsOperatorEntityResult>
  listAdGroups(apiKey: string, campaignId: string): Promise<AdsOperatorEntityResult[]>
  createAdGroup(apiKey: string, input: {
    campaignId: string
    name: string
    description?: string
    contextHints: string[]
    maxBidMicros: number
    billingEventType: AdsAdGroupBillingEventType
  }): Promise<AdsOperatorEntityResult>
  updateAdGroup(apiKey: string, id: string, input: {
    name?: string
    description?: string | null
    contextHints?: string[]
    maxBidMicros?: number
    billingEventType?: AdsAdGroupBillingEventType
  }): Promise<AdsOperatorEntityResult>
  pauseAdGroup(apiKey: string, id: string): Promise<AdsOperatorEntityResult>
  getAd(apiKey: string, id: string): Promise<AdsOperatorEntityResult>
  listAds(apiKey: string, adGroupId: string): Promise<AdsOperatorEntityResult[]>
  createAd(apiKey: string, input: {
    adGroupId: string
    name: string
    creative: { title: string; body: string; targetUrl: string; fileId: string }
  }): Promise<AdsOperatorEntityResult>
  updateAd(apiKey: string, id: string, input: {
    name?: string
    creative?: { title: string; body: string; targetUrl: string; fileId: string }
  }): Promise<AdsOperatorEntityResult>
  pauseAd(apiKey: string, id: string): Promise<AdsOperatorEntityResult>
}

type ConnectionRow = typeof adsConnections.$inferSelect
type OperationRow = typeof adsOperations.$inferSelect

const DEFAULT_RECONCILE_SWEEP_INTERVAL_MS = 60_000
const DEFAULT_RECONCILE_PENDING_STALE_MS = 5 * 60_000
const DEFAULT_RECONCILE_BACKOFF_BASE_MS = 5 * 60_000
const DEFAULT_RECONCILE_MAX_ATTEMPTS = 5
const DEFAULT_RECONCILE_BATCH_SIZE = 10
const DEFAULT_RECONCILE_LEASE_MS = 30_000
const DEFAULT_ADS_ACCOUNT_VERIFICATION_CACHE_TTL_MS = 5 * 60_000
const ADS_RECONCILIATION_QUARANTINED = 'ADS_RECONCILIATION_QUARANTINED'

interface AdsAccountVerificationCacheEntry {
  credentialFingerprint: string
  adAccountId: string
  expiresAtMs: number
}

type AdsAccountVerificationCache = Map<string, AdsAccountVerificationCacheEntry>

interface ReconcilePolicy {
  pendingMinIdleMs: number
  backoffBaseMs: number
  maxAttempts: number
}

interface AdsReconciliationPlan {
  strategy: AdsReconcileStrategy
  parentId?: string
  fields?: AdsReconcileFields
}

interface ReconcileAuditContext {
  request?: FastifyRequest
  actor: 'api' | 'system'
}

class AdsPausedPostconditionError extends Error {
  readonly code = 'ADS_PAUSED_POSTCONDITION_FAILED'
  readonly status = 502

  constructor(readonly entityId: string) {
    super('OpenAI Ads API did not confirm the required paused state')
    this.name = 'AdsPausedPostconditionError'
  }
}

function statusDto(row: ConnectionRow | undefined): AdsConnectionStatusDto {
  if (!row) return { connected: false }
  return {
    connected: true,
    adAccountId: row.adAccountId,
    displayName: row.displayName,
    currencyCode: row.currencyCode,
    timezone: row.timezone,
    status: row.status,
    reviewStatus: row.reviewStatus,
    integrityReviewStatus: row.integrityReviewStatus,
    integrityDecision: row.integrityDecision,
    lastSyncedAt: row.lastSyncedAt,
    conversionTrackingConfigured: row.conversionTrackingConfigured,
  }
}

function creativeDto(raw: unknown): AdsCreativeDto | null {
  if (raw == null || typeof raw !== 'object') return null
  const c = raw as { type?: unknown; title?: unknown; body?: unknown; target_url?: unknown; file_id?: unknown }
  return {
    type: typeof c.type === 'string' ? c.type : null,
    title: typeof c.title === 'string' ? c.title : null,
    body: typeof c.body === 'string' ? c.body : null,
    targetUrl: typeof c.target_url === 'string' ? c.target_url : null,
    fileId: typeof c.file_id === 'string' ? c.file_id : null,
  }
}

function locationIdsDto(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return []
  const locations = (raw as { locations?: unknown }).locations
  if (!locations || typeof locations !== 'object') return []
  const include = (locations as { include?: unknown }).include
  if (!Array.isArray(include)) return []
  return include.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const id = (entry as { id?: unknown }).id
    return typeof id === 'string' && id.length > 0 ? [id] : []
  })
}

function operationDto(row: OperationRow): AdsOperationDto {
  return {
    id: row.id,
    adAccountId: row.adAccountId,
    operationKey: row.operationKey,
    kind: row.kind as AdsOperationKind,
    state: row.state as AdsOperationDto['state'],
    entityType: row.entityType as AdsEntityType | null,
    entityId: row.entityId,
    upstreamUpdatedAt: row.upstreamUpdatedAt,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    reconcileStrategy: row.reconcileStrategy as AdsReconcileStrategy | null,
    reconcileParentId: row.reconcileParentId,
    reconcileFingerprint: row.reconcileFingerprint,
    reconcileFields: row.reconcileFields,
    reconcileAttempts: row.reconcileAttempts,
    lastReconciledAt: row.lastReconciledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key]
    if (child !== undefined) out[key] = canonicalize(child)
  }
  return out
}

function requestHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

interface AdsOperationCursor {
  v: 1
  projectId: string
  states: string[]
  createdAt: string
  id: string
}

function normalizedOperationStates(states: readonly string[]): string[] {
  return [...states].sort()
}

function encodeAdsOperationCursor(
  projectId: string,
  states: readonly string[],
  row: OperationRow,
): string {
  const cursor: AdsOperationCursor = {
    v: 1,
    projectId,
    states: normalizedOperationStates(states),
    createdAt: row.createdAt,
    id: row.id,
  }
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeAdsOperationCursor(
  encoded: string,
  projectId: string,
  states: readonly string[],
): AdsOperationCursor {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<AdsOperationCursor>
    const stateIdentity = normalizedOperationStates(states)
    if (parsed.v !== 1
      || parsed.projectId !== projectId
      || !Array.isArray(parsed.states)
      || parsed.states.some((state) => typeof state !== 'string')
      || JSON.stringify(parsed.states) !== JSON.stringify(stateIdentity)
      || typeof parsed.createdAt !== 'string'
      || !Number.isFinite(Date.parse(parsed.createdAt))
      || typeof parsed.id !== 'string'
      || parsed.id.length === 0) {
      throw new Error('cursor identity mismatch')
    }
    return parsed as AdsOperationCursor
  } catch {
    throw validationError('Invalid ads operation cursor for this project and state filter')
  }
}

function normalizeString(value: string): string {
  return value.trim()
}

function normalizeStringSet(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeString))].sort()
}

function creativeFingerprint(creative: {
  title: string
  body: string
  targetUrl: string
  fileId: string
}): string {
  // The target URL can contain signed query parameters. Persist only this
  // one-way digest, never the URL or the original mutation payload.
  return requestHash({
    title: normalizeString(creative.title),
    body: normalizeString(creative.body),
    targetUrlHash: requestHash(creative.targetUrl),
    fileId: normalizeString(creative.fileId),
  })
}

function campaignCreateReconcileFields(input: {
  name: string
  description?: string
  startTime?: number
  endTime?: number
  lifetimeSpendLimitMicros: number
  locationIds: string[]
  biddingType: AdsCampaignBiddingType
  conversionEventSettingIds?: string[]
}): AdsReconcileFields {
  return {
    name: normalizeString(input.name),
    description: input.description === undefined ? null : normalizeString(input.description),
    status: AdsEntityStatuses.paused,
    startTime: input.startTime ?? null,
    endTime: input.endTime ?? null,
    lifetimeSpendLimitMicros: input.lifetimeSpendLimitMicros,
    locationIds: normalizeStringSet(input.locationIds),
    biddingType: input.biddingType,
    conversionEventSettingIds: normalizeStringSet(input.conversionEventSettingIds ?? []),
  }
}

function adGroupCreateReconcileFields(input: {
  campaignId: string
  name: string
  description?: string
  contextHints: string[]
  maxBidMicros: number
  billingEventType: AdsAdGroupBillingEventType
}): AdsReconcileFields {
  return {
    campaignId: input.campaignId,
    name: normalizeString(input.name),
    description: input.description === undefined ? null : normalizeString(input.description),
    status: AdsEntityStatuses.paused,
    contextHints: normalizeStringSet(input.contextHints),
    maxBidMicros: input.maxBidMicros,
    billingEventType: input.billingEventType,
  }
}

function adCreateReconcileFields(input: {
  adGroupId: string
  name: string
  creative: { title: string; body: string; targetUrl: string; fileId: string }
}): AdsReconcileFields {
  return {
    adGroupId: input.adGroupId,
    name: normalizeString(input.name),
    status: AdsEntityStatuses.paused,
    creativeFingerprint: creativeFingerprint(input.creative),
  }
}

function updateReconcileFields(
  entityType: AdsEntityType,
  update: Record<string, unknown>,
): AdsReconcileFields {
  const fields: AdsReconcileFields = { status: AdsEntityStatuses.paused }
  if (typeof update.name === 'string') fields.name = normalizeString(update.name)
  if (update.description === null) fields.description = null
  else if (typeof update.description === 'string') fields.description = normalizeString(update.description)

  if (entityType === AdsEntityTypes.campaign) {
    if (update.startTime === null || typeof update.startTime === 'number') fields.startTime = update.startTime
    if (update.endTime === null || typeof update.endTime === 'number') fields.endTime = update.endTime
    if (typeof update.lifetimeSpendLimitMicros === 'number') {
      fields.lifetimeSpendLimitMicros = update.lifetimeSpendLimitMicros
    }
    if (Array.isArray(update.locationIds)) {
      fields.locationIds = normalizeStringSet(update.locationIds as string[])
    }
  } else if (entityType === AdsEntityTypes.ad_group) {
    if (Array.isArray(update.contextHints)) {
      fields.contextHints = normalizeStringSet(update.contextHints as string[])
    }
    if (typeof update.maxBidMicros === 'number') fields.maxBidMicros = update.maxBidMicros
  } else if (entityType === AdsEntityTypes.ad) {
    if (update.creative && typeof update.creative === 'object') {
      fields.creativeFingerprint = creativeFingerprint(update.creative as {
        title: string
        body: string
        targetUrl: string
        fileId: string
      })
    }
  }
  return fields
}

function entityReconcileFields(entity: AdsOperatorEntityResult): AdsReconcileFields {
  const fields: AdsReconcileFields = {}
  if (typeof entity.name === 'string') fields.name = normalizeString(entity.name)
  if (entity.description === null) fields.description = null
  else if (typeof entity.description === 'string') fields.description = normalizeString(entity.description)
  if (entity.status === AdsEntityStatuses.active
    || entity.status === AdsEntityStatuses.paused
    || entity.status === AdsEntityStatuses.archived) {
    fields.status = entity.status
  }
  if (entity.startTime === null || typeof entity.startTime === 'number') fields.startTime = entity.startTime
  if (entity.endTime === null || typeof entity.endTime === 'number') fields.endTime = entity.endTime
  if (typeof entity.lifetimeSpendLimitMicros === 'number') {
    fields.lifetimeSpendLimitMicros = entity.lifetimeSpendLimitMicros
  }
  if (Array.isArray(entity.locationIds)) fields.locationIds = normalizeStringSet(entity.locationIds)
  if (entity.biddingType) fields.biddingType = entity.biddingType
  if (entity.conversionEventSettingIds === null) {
    fields.conversionEventSettingIds = []
  } else if (Array.isArray(entity.conversionEventSettingIds)) {
    fields.conversionEventSettingIds = normalizeStringSet(entity.conversionEventSettingIds)
  }
  if (typeof entity.campaignId === 'string') fields.campaignId = entity.campaignId
  if (Array.isArray(entity.contextHints)) fields.contextHints = normalizeStringSet(entity.contextHints)
  if (typeof entity.maxBidMicros === 'number') fields.maxBidMicros = entity.maxBidMicros
  if (entity.billingEventType) fields.billingEventType = entity.billingEventType
  if (typeof entity.adGroupId === 'string') fields.adGroupId = entity.adGroupId
  if (entity.creative) fields.creativeFingerprint = creativeFingerprint(entity.creative)
  return fields
}

function selectReconcileFields(
  fields: AdsReconcileFields,
  desired: AdsReconcileFields,
): AdsReconcileFields {
  const selected: AdsReconcileFields = {}
  for (const key of Object.keys(desired) as Array<keyof AdsReconcileFields>) {
    // The indexed assignment is safe because both objects share the exact
    // AdsReconcileFields schema; this helper never introduces a new key.
    Object.assign(selected, { [key]: fields[key] })
  }
  return selected
}

function entityMatchesReconcileFields(
  entity: AdsOperatorEntityResult,
  desired: AdsReconcileFields,
  fingerprint: string | null,
): boolean {
  const selected = selectReconcileFields(entityReconcileFields(entity), desired)
  const candidateFingerprint = requestHash(selected)
  return fingerprint === null
    ? candidateFingerprint === requestHash(desired)
    : candidateFingerprint === fingerprint
}

function reconcileFieldsWithoutParent(fields: AdsReconcileFields): AdsReconcileFields {
  const { campaignId: _campaignId, adGroupId: _adGroupId, ...withoutParent } = fields
  return withoutParent
}

function errorDetails(err: unknown): {
  state: 'failed' | 'unknown'
  code: string
  message: string
  entityId?: string
} {
  const candidate = err as { status?: unknown; code?: unknown; message?: unknown; entityId?: unknown }
  const status = typeof candidate.status === 'number' ? candidate.status : undefined
  const knownClientFailure = err instanceof AppError || (
    status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429
  )
  const rawCode = typeof candidate.code === 'string'
    ? candidate.code
    : err instanceof AppError
      ? err.code
      : 'upstream_error'
  const code = rawCode.replace(/[^\w.:-]/g, '_').slice(0, 100) || 'upstream_error'
  const message = err instanceof AppError
    ? err.message.slice(0, 500)
    : knownClientFailure
      ? 'OpenAI Ads API rejected the operation'
      : 'OpenAI Ads API outcome could not be confirmed'
  return {
    state: knownClientFailure ? AdsOperationStates.failed : AdsOperationStates.unknown,
    code,
    message,
    entityId: typeof candidate.entityId === 'string' ? candidate.entityId.slice(0, 200) : undefined,
  }
}

async function resolveAdsOperator(
  app: FastifyInstance,
  opts: AdsRoutesOptions,
  project: { id: string; name: string },
  verification?: {
    cache: AdsAccountVerificationCache
    ttlMs: number
    nowMs?: number
  },
): Promise<{ apiKey: string; adAccountId: string; operator: AdsOperator }> {
  const connection = opts.adsCredentialStore?.getConnection(project.name)
  if (!connection?.apiKey) {
    throw validationError('No ads connection for this project. Run "canonry ads connect" first.')
  }
  if (!connection.adAccountId) {
    throw validationError('Reconnect this project to bind its verified OpenAI ad account before mutating ads')
  }
  if (!opts.adsOperator) {
    throw validationError('Ads lifecycle operations are not configured for this deployment')
  }
  if (!opts.verifyAdsAccount) {
    throw validationError('Ads account verification is not configured for this deployment')
  }
  const stored = app.db.select({ adAccountId: adsConnections.adAccountId }).from(adsConnections)
    .where(eq(adsConnections.projectId, project.id)).get()
  if (!stored?.adAccountId || stored.adAccountId !== connection.adAccountId) {
    throw validationError('Reconnect this project because its stored OpenAI ad account identity is inconsistent')
  }
  const nowMs = verification?.nowMs ?? Date.now()
  const credentialFingerprint = requestHash({
    apiKey: connection.apiKey,
    adAccountId: connection.adAccountId,
  })
  const cached = verification?.cache.get(project.id)
  if (cached
    && cached.expiresAtMs > nowMs
    && cached.credentialFingerprint === credentialFingerprint
    && cached.adAccountId === connection.adAccountId) {
    return { apiKey: connection.apiKey, adAccountId: cached.adAccountId, operator: opts.adsOperator }
  }
  const verified = await executeAdsRead(
    'account identity',
    () => opts.verifyAdsAccount!(connection.apiKey),
  )
  if (verified.id !== connection.adAccountId) {
    verification?.cache.delete(project.id)
    throw validationError('The configured key belongs to a different OpenAI ad account; reconnect this project')
  }
  if (verification && verification.ttlMs > 0) {
    verification.cache.set(project.id, {
      credentialFingerprint,
      adAccountId: verified.id,
      expiresAtMs: nowMs + verification.ttlMs,
    })
  }
  return { apiKey: connection.apiKey, adAccountId: verified.id, operator: opts.adsOperator }
}

function resolveAdsReader(
  opts: AdsRoutesOptions,
  projectName: string,
): { apiKey: string; reader: AdsReader } {
  const apiKey = opts.adsCredentialStore?.getConnection(projectName)?.apiKey
  if (!apiKey) {
    throw validationError('No OpenAI Ads API key configured for this project')
  }
  if (!opts.adsReader) {
    throw validationError('Ads planning reads are not configured for this deployment')
  }
  return { apiKey, reader: opts.adsReader }
}

async function executeAdsRead<T>(surface: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    const upstreamStatus = typeof error === 'object'
      && error !== null
      && 'status' in error
      && typeof error.status === 'number'
      && Number.isInteger(error.status)
      ? error.status
      : undefined
    const upstreamCode = typeof error === 'object'
      && error !== null
      && 'code' in error
      && typeof error.code === 'string'
      ? error.code
      : undefined
    throw providerError(`OpenAI Ads API ${surface} read failed`, {
      ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
      ...(upstreamCode === undefined ? {} : { upstreamCode }),
    })
  }
}

async function executeAdsOperation(
  app: FastifyInstance,
  request: FastifyRequest,
  input: {
    projectId: string
    adAccountId: string
    operationKey: string
    kind: AdsOperationKind
    entityType: AdsEntityType
    payload: unknown
    /** Read-only checks that must succeed before a durable mutation receipt is claimed. */
    preflight?: () => Promise<void>
    reconciliation: AdsReconciliationPlan
    knownEntityId?: string
    expectedStatus?: AdsEntityStatus
    remediateStatus?: (
      result: { id: string; status?: string; updatedAt?: number | null },
    ) => Promise<{ id: string; status?: string; updatedAt?: number | null }>
    run: () => Promise<{ id: string; status?: string; updatedAt?: number | null }>
  },
): Promise<AdsOperationResponse> {
  const hash = requestHash({ kind: input.kind, entityType: input.entityType, payload: input.payload })
  const existing = readOperationByKey(app, input.projectId, input.operationKey)
  if (existing) {
    if (existing.requestHash !== hash) {
      throw alreadyExists('Ads operation key', input.operationKey)
    }
    return { operation: operationDto(existing), replayed: true }
  }

  // A receipt marks the boundary after which an upstream write may have been
  // attempted. Keep provider reads before it so a transient read failure can
  // be retried with the same operation key without manufacturing ambiguity.
  await input.preflight?.()

  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const reconcileFields = input.reconciliation.fields ?? null
  const reconcileFingerprintFields = reconcileFields === null
    ? null
    : input.reconciliation.strategy === AdsReconcileStrategies.create_fingerprint
      ? reconcileFieldsWithoutParent(reconcileFields)
      : reconcileFields
  const inserted = app.db.insert(adsOperations).values({
    id,
    projectId: input.projectId,
    adAccountId: input.adAccountId,
    operationKey: input.operationKey,
    requestHash: hash,
    kind: input.kind,
    state: AdsOperationStates.pending,
    entityType: input.entityType,
    entityId: input.knownEntityId,
    reconcileStrategy: input.reconciliation.strategy,
    reconcileParentId: input.reconciliation.parentId,
    // Parent identity has its own exact column. The fingerprint covers only
    // fields the provider GET can return consistently, so both bindings are
    // independently checked during recovery.
    reconcileFingerprint: reconcileFingerprintFields === null
      ? null
      : requestHash(reconcileFingerprintFields),
    reconcileFields,
    createdAt,
    updatedAt: createdAt,
  }).onConflictDoNothing({
    target: [adsOperations.projectId, adsOperations.operationKey],
  }).returning({ id: adsOperations.id }).all()

  // The unique row is the concurrency primitive. Every process attempts the
  // insert, then reads the canonical receipt; only the insert winner may call
  // the provider. This turns the former unique-violation 500 into a clean
  // replay or hash conflict under multi-instance contention.
  const canonical = app.db
    .select()
    .from(adsOperations)
    .where(and(
      eq(adsOperations.projectId, input.projectId),
      eq(adsOperations.operationKey, input.operationKey),
    ))
    .get()
  if (!canonical) {
    throw providerError('Ads operation receipt could not be claimed')
  }
  if (canonical.requestHash !== hash) {
    throw alreadyExists('Ads operation key', input.operationKey)
  }
  if (inserted.length === 0) {
    return { operation: operationDto(canonical), replayed: true }
  }

  let result: Awaited<ReturnType<typeof input.run>> | undefined
  try {
    result = await input.run()
    // Checkpoint the confirmed upstream id before any remediation/readback.
    // A crash after create but before the final outcome write can therefore be
    // recovered by inspection without re-sending the mutation.
    app.db.update(adsOperations).set({
      entityId: result.id,
      upstreamUpdatedAt: result.updatedAt ?? null,
      updatedAt: new Date().toISOString(),
    }).where(and(
      eq(adsOperations.id, id),
      eq(adsOperations.state, AdsOperationStates.pending),
      isNull(adsOperations.leaseOwner),
    )).run()
    if (input.expectedStatus !== undefined && result.status !== input.expectedStatus) {
      if (input.remediateStatus) result = await input.remediateStatus(result)
      if (result.status !== input.expectedStatus) {
        throw new AdsPausedPostconditionError(result.id)
      }
    }
    const succeededResult = result
    const updatedAt = new Date().toISOString()
    app.db.transaction((tx) => {
      const update = tx.update(adsOperations).set({
        state: AdsOperationStates.succeeded,
        entityId: succeededResult.id,
        upstreamUpdatedAt: succeededResult.updatedAt ?? null,
        errorCode: null,
        errorMessage: null,
        updatedAt,
      }).where(and(
        eq(adsOperations.id, id),
        eq(adsOperations.state, AdsOperationStates.pending),
        isNull(adsOperations.leaseOwner),
      )).run()
      if (update.changes > 0) {
        writeAuditLog(tx, auditFromRequest(request, {
          projectId: input.projectId,
          actor: 'api',
          action: `ads.${input.kind}.succeeded`,
          entityType: input.entityType,
          entityId: succeededResult.id,
          diff: { operationId: id, operationKey: input.operationKey },
        }))
      }
    })
    const row = app.db.select().from(adsOperations).where(eq(adsOperations.id, id)).get()!
    // A stale original request can finish after a sweeper has claimed the
    // receipt. It must not invalidate that lease or overwrite its canonical
    // result; return whatever the lease owner persisted.
    return { operation: operationDto(row), replayed: false }
  } catch (err) {
    const failure = errorDetails(err)
    // A remediation request can fail after the provider has already created or
    // updated the entity. Preserve the last confirmed id so the unknown receipt
    // can be reconciled without blindly retrying the mutation.
    const entityId = failure.entityId ?? result?.id
    const updatedAt = new Date().toISOString()
    const finalized = app.db.transaction((tx) => {
      const update = tx.update(adsOperations).set({
        state: failure.state,
        entityId,
        errorCode: failure.code,
        errorMessage: failure.message,
        updatedAt,
      }).where(and(
        eq(adsOperations.id, id),
        eq(adsOperations.state, AdsOperationStates.pending),
        isNull(adsOperations.leaseOwner),
      )).run()
      if (update.changes > 0) {
        writeAuditLog(tx, auditFromRequest(request, {
          projectId: input.projectId,
          actor: 'api',
          action: `ads.${input.kind}.${failure.state}`,
          entityType: input.entityType,
          entityId: entityId ?? id,
          diff: { operationId: id, operationKey: input.operationKey, errorCode: failure.code },
        }))
      }
      return update.changes > 0
    })
    if (!finalized) {
      const canonical = app.db.select().from(adsOperations).where(and(
        eq(adsOperations.id, id),
        eq(adsOperations.projectId, input.projectId),
      )).get()
      if (!canonical) throw notFound('Ads operation', input.operationKey)
      return { operation: operationDto(canonical), replayed: false }
    }
    if (err instanceof AppError) throw err
    throw providerError('OpenAI Ads API mutation failed', {
      operationId: id,
      operationKey: input.operationKey,
      state: failure.state,
      code: failure.code,
    })
  }
}

function readOperationByKey(
  app: FastifyInstance,
  projectId: string,
  operationKey: string,
): OperationRow | undefined {
  return app.db.select().from(adsOperations).where(and(
    eq(adsOperations.projectId, projectId),
    eq(adsOperations.operationKey, operationKey),
  )).get()
}

function claimOperationForReconciliation(
  app: FastifyInstance,
  row: OperationRow,
  leaseOwner: string,
  now: Date,
  leaseMs: number,
  policy: ReconcilePolicy,
  enforceBackoff: boolean,
): OperationRow | undefined {
  const nowIso = now.toISOString()
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString()
  const pendingCutoff = new Date(now.getTime() - policy.pendingMinIdleMs).toISOString()
  const backoffMs = policy.backoffBaseMs * (2 ** Math.max(0, row.reconcileAttempts - 1))
  const unknownCutoff = new Date(now.getTime() - backoffMs).toISOString()
  const claimableState = row.state === AdsOperationStates.pending
    ? and(
        eq(adsOperations.state, AdsOperationStates.pending),
        lte(adsOperations.updatedAt, pendingCutoff),
      )
    : row.state === AdsOperationStates.unknown
      ? and(
          eq(adsOperations.state, AdsOperationStates.unknown),
          enforceBackoff ? lte(adsOperations.updatedAt, unknownCutoff) : undefined,
        )
      : and(
          eq(adsOperations.state, AdsOperationStates.reconciling),
          or(isNull(adsOperations.leaseExpiresAt), lte(adsOperations.leaseExpiresAt, nowIso)),
        )
  const claimed = app.db.update(adsOperations).set({
    state: AdsOperationStates.reconciling,
    leaseOwner,
    leaseExpiresAt,
    reconcileAttempts: sql`${adsOperations.reconcileAttempts} + 1`,
    updatedAt: nowIso,
  }).where(and(
    eq(adsOperations.id, row.id),
    eq(adsOperations.projectId, row.projectId),
    eq(adsOperations.reconcileAttempts, row.reconcileAttempts),
    lt(adsOperations.reconcileAttempts, policy.maxAttempts),
    claimableState,
  )).returning({ id: adsOperations.id }).all()
  if (claimed.length === 0) return undefined
  return app.db.select().from(adsOperations).where(eq(adsOperations.id, row.id)).get()
}

async function getEntityForReconciliation(
  operator: AdsOperator,
  apiKey: string,
  entityType: AdsEntityType,
  entityId: string,
): Promise<AdsOperatorEntityResult> {
  switch (entityType) {
    case AdsEntityTypes.campaign:
      return operator.getCampaign(apiKey, entityId)
    case AdsEntityTypes.ad_group:
      return operator.getAdGroup(apiKey, entityId)
    case AdsEntityTypes.ad:
      return operator.getAd(apiKey, entityId)
    case AdsEntityTypes.file:
      throw validationError('Image upload receipts require manual reconciliation')
  }
}

function reconciliationAuditEntry(
  row: OperationRow,
  state: 'succeeded' | 'unknown',
  context: ReconcileAuditContext,
  details: { entityId?: string | null; errorCode?: string | null },
) {
  const entry = {
    projectId: row.projectId,
    actor: context.actor,
    action: `ads.${row.kind}.reconciled.${state}`,
    entityType: row.entityType ?? 'ads-operation',
    entityId: details.entityId ?? row.id,
    diff: {
      operationId: row.id,
      operationKey: row.operationKey,
      ...(details.errorCode ? { errorCode: details.errorCode } : {}),
    },
  }
  return context.request ? auditFromRequest(context.request, entry) : entry
}

function finishReconciliation(
  app: FastifyInstance,
  row: OperationRow,
  leaseOwner: string,
  context: ReconcileAuditContext,
  outcome: {
    state: 'succeeded' | 'unknown'
    entity?: AdsOperatorEntityResult
    errorCode?: string
    errorMessage?: string
  },
  maxAttempts: number,
): OperationRow {
  const now = new Date().toISOString()
  const entityId = outcome.entity?.id ?? row.entityId
  const exhausted = outcome.state === AdsOperationStates.unknown
    && row.reconcileAttempts >= maxAttempts
  const errorCode = exhausted ? ADS_RECONCILIATION_QUARANTINED : outcome.errorCode ?? null
  const errorMessage = exhausted
    ? `Reconciliation stopped after ${maxAttempts} inconclusive attempts; manual remediation is required`
    : outcome.errorMessage ?? null
  app.db.transaction((tx) => {
    const result = tx.update(adsOperations).set({
      state: outcome.state,
      entityId,
      upstreamUpdatedAt: outcome.entity?.updatedAt ?? row.upstreamUpdatedAt,
      errorCode,
      errorMessage,
      lastReconciledAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
    }).where(and(
      eq(adsOperations.id, row.id),
      eq(adsOperations.projectId, row.projectId),
      eq(adsOperations.leaseOwner, leaseOwner),
      eq(adsOperations.state, AdsOperationStates.reconciling),
    )).run()
    if (result.changes > 0) {
      writeAuditLog(tx, reconciliationAuditEntry(row, outcome.state, context, {
        entityId,
        errorCode,
      }))
    }
  })

  // A slow read may outlive its lease. Never let the stale worker overwrite a
  // newer attempt; return the canonical row owned by the current lease holder.
  const canonical = app.db.select().from(adsOperations).where(and(
    eq(adsOperations.id, row.id),
    eq(adsOperations.projectId, row.projectId),
  )).get()
  if (!canonical) throw notFound('Ads operation', row.operationKey)
  return canonical
}

function unknownReconciliation(
  app: FastifyInstance,
  row: OperationRow,
  leaseOwner: string,
  context: ReconcileAuditContext,
  code: string,
  message: string,
  maxAttempts: number,
): OperationRow {
  return finishReconciliation(app, row, leaseOwner, context, {
    state: AdsOperationStates.unknown,
    errorCode: code,
    errorMessage: message,
  }, maxAttempts)
}

function pendingIdleRemainingMs(row: OperationRow, now: Date, minimumIdleMs: number): number {
  const updatedAtMs = Date.parse(row.updatedAt)
  if (!Number.isFinite(updatedAtMs)) return minimumIdleMs
  return Math.max(0, updatedAtMs + minimumIdleMs - now.getTime())
}

function quarantineExhaustedReconciliation(
  app: FastifyInstance,
  row: OperationRow,
  now: Date,
  policy: ReconcilePolicy,
  context: ReconcileAuditContext,
): OperationRow {
  if (row.reconcileAttempts < policy.maxAttempts
    || row.state === AdsOperationStates.succeeded
    || row.state === AdsOperationStates.failed) {
    return row
  }
  if (row.state === AdsOperationStates.unknown
    && row.errorCode === ADS_RECONCILIATION_QUARANTINED) {
    return row
  }
  if (row.state === AdsOperationStates.pending
    && pendingIdleRemainingMs(row, now, policy.pendingMinIdleMs) > 0) {
    return row
  }
  if (row.state === AdsOperationStates.reconciling
    && row.leaseExpiresAt
    && row.leaseExpiresAt > now.toISOString()) {
    return row
  }

  const nowIso = now.toISOString()
  app.db.transaction((tx) => {
    const result = tx.update(adsOperations).set({
      state: AdsOperationStates.unknown,
      errorCode: ADS_RECONCILIATION_QUARANTINED,
      errorMessage: `Reconciliation stopped after ${policy.maxAttempts} inconclusive attempts; manual remediation is required`,
      lastReconciledAt: nowIso,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: nowIso,
    }).where(and(
      eq(adsOperations.id, row.id),
      eq(adsOperations.projectId, row.projectId),
      gte(adsOperations.reconcileAttempts, policy.maxAttempts),
      inArray(adsOperations.state, [
        AdsOperationStates.pending,
        AdsOperationStates.unknown,
        AdsOperationStates.reconciling,
      ]),
    )).run()
    if (result.changes > 0) {
      const entry = {
        projectId: row.projectId,
        actor: context.actor,
        action: `ads.${row.kind}.reconciliation.quarantined`,
        entityType: row.entityType ?? 'ads-operation',
        entityId: row.entityId ?? row.id,
        diff: {
          operationId: row.id,
          operationKey: row.operationKey,
          reconcileAttempts: row.reconcileAttempts,
        },
      }
      writeAuditLog(tx, context.request ? auditFromRequest(context.request, entry) : entry)
    }
  })
  return app.db.select().from(adsOperations).where(eq(adsOperations.id, row.id)).get() ?? row
}

function reconcileResponse(row: OperationRow): AdsOperationReconcileResponse {
  return {
    operation: operationDto(row),
    resolved: row.state === AdsOperationStates.succeeded,
  }
}

/**
 * Reconcile at most one durable receipt by inspecting upstream state. This
 * helper never invokes a create, update, or pause method.
 */
export async function reconcileOneAdsOperation(
  app: FastifyInstance,
  input: {
    projectId: string
    adAccountId: string
    operationKey: string
    apiKey: string
    operator: AdsOperator
    leaseMs?: number
    pendingMinIdleMs?: number
    backoffBaseMs?: number
    maxAttempts?: number
    /** Background workers honor exponential delay; an explicit operator request may inspect immediately. */
    enforceBackoff?: boolean
    now?: Date
    audit?: ReconcileAuditContext
  },
): Promise<AdsOperationReconcileResponse> {
  const existing = readOperationByKey(app, input.projectId, input.operationKey)
  if (!existing) throw notFound('Ads operation', input.operationKey)
  if (existing.state === AdsOperationStates.succeeded) {
    return { operation: operationDto(existing), resolved: true }
  }
  if (existing.state === AdsOperationStates.failed) {
    return { operation: operationDto(existing), resolved: false }
  }
  if (!existing.entityType) {
    throw validationError('Ads operation receipt is missing its entity type')
  }

  const now = input.now ?? new Date()
  const policy: ReconcilePolicy = {
    pendingMinIdleMs: Math.max(1, input.pendingMinIdleMs ?? DEFAULT_RECONCILE_PENDING_STALE_MS),
    backoffBaseMs: Math.max(1, input.backoffBaseMs ?? DEFAULT_RECONCILE_BACKOFF_BASE_MS),
    maxAttempts: Math.min(20, Math.max(1, input.maxAttempts ?? DEFAULT_RECONCILE_MAX_ATTEMPTS)),
  }
  const context = input.audit ?? { actor: 'system' }
  const pendingWaitMs = existing.state === AdsOperationStates.pending
    ? pendingIdleRemainingMs(existing, now, policy.pendingMinIdleMs)
    : 0
  if (pendingWaitMs > 0) {
    throw operationInProgress(
      'The ads mutation may still be in flight; reconciliation is blocked until the receipt is idle',
      {
        operationKey: existing.operationKey,
        minimumIdleMs: policy.pendingMinIdleMs,
        retryAfterMs: pendingWaitMs,
      },
    )
  }
  if (existing.reconcileAttempts >= policy.maxAttempts) {
    return reconcileResponse(quarantineExhaustedReconciliation(app, existing, now, policy, context))
  }

  const leaseOwner = `ads-reconcile:${crypto.randomUUID()}`
  const claimed = claimOperationForReconciliation(
    app,
    existing,
    leaseOwner,
    now,
    input.leaseMs ?? DEFAULT_RECONCILE_LEASE_MS,
    policy,
    input.enforceBackoff ?? false,
  )
  if (!claimed) {
    const canonical = readOperationByKey(app, input.projectId, input.operationKey)
    if (!canonical) throw notFound('Ads operation', input.operationKey)
    if (canonical.state === AdsOperationStates.pending) {
      const retryAfterMs = pendingIdleRemainingMs(canonical, now, policy.pendingMinIdleMs)
      if (retryAfterMs > 0) {
        throw operationInProgress(
          'The ads mutation may still be in flight; reconciliation is blocked until the receipt is idle',
          {
            operationKey: canonical.operationKey,
            minimumIdleMs: policy.pendingMinIdleMs,
            retryAfterMs,
          },
        )
      }
    }
    return {
      operation: operationDto(canonical),
      resolved: canonical.state === AdsOperationStates.succeeded,
    }
  }

  if (!claimed.adAccountId || claimed.adAccountId !== input.adAccountId) {
    const row = unknownReconciliation(
      app,
      claimed,
      leaseOwner,
      context,
      claimed.adAccountId
        ? 'ADS_RECONCILIATION_ACCOUNT_MISMATCH'
        : 'ADS_RECONCILIATION_ACCOUNT_UNBOUND',
      claimed.adAccountId
        ? 'The current credential is connected to a different OpenAI ad account'
        : 'This legacy receipt is not bound to a verified OpenAI ad account',
      policy.maxAttempts,
    )
    return reconcileResponse(row)
  }
  const strategy = claimed.reconcileStrategy as AdsReconcileStrategy | null
  const desired = claimed.reconcileFields
  if (strategy === AdsReconcileStrategies.manual_only
    || claimed.entityType === AdsEntityTypes.file
    || !strategy
    || !desired) {
    const row = unknownReconciliation(
      app,
      claimed,
      leaseOwner,
      context,
      'ADS_RECONCILIATION_MANUAL_ONLY',
      'This operation cannot be reconciled automatically',
      policy.maxAttempts,
    )
    return reconcileResponse(row)
  }

  try {
    let match: AdsOperatorEntityResult | undefined
    const checkpointedId = claimed.entityId
    // The provider does not accept an idempotency/provenance key on creates.
    // Mutable-field equality, even when unique in a list, cannot prove that an
    // uncheckpointed create produced that entity. Fail closed until a provider
    // id was durably checkpointed; never bind a pre-existing lookalike.
    if (strategy === AdsReconcileStrategies.create_fingerprint && !checkpointedId) {
      const row = unknownReconciliation(
        app,
        claimed,
        leaseOwner,
        context,
        'ADS_RECONCILIATION_UNCHECKPOINTED_CREATE',
        'The create outcome has no checkpointed provider id and cannot be resolved automatically',
        policy.maxAttempts,
      )
      return reconcileResponse(row)
    }
    if (checkpointedId) {
      const entity = await getEntityForReconciliation(
        input.operator,
        input.apiKey,
        claimed.entityType as AdsEntityType,
        checkpointedId,
      )
      const checkpointDesired = strategy === AdsReconcileStrategies.create_fingerprint
        ? reconcileFieldsWithoutParent(desired)
        : desired
      const desiredParentId = claimed.entityType === AdsEntityTypes.ad_group
        ? desired.campaignId
        : claimed.entityType === AdsEntityTypes.ad
          ? desired.adGroupId
          : undefined
      const entityParentId = claimed.entityType === AdsEntityTypes.ad_group
        ? entity.campaignId
        : claimed.entityType === AdsEntityTypes.ad
          ? entity.adGroupId
          : undefined
      const parentMatches = strategy !== AdsReconcileStrategies.create_fingerprint || (
        (desiredParentId ?? null) === claimed.reconcileParentId
        && (entityParentId == null || entityParentId === claimed.reconcileParentId)
      )
      if (parentMatches && entityMatchesReconcileFields(
        entity,
        checkpointDesired,
        claimed.reconcileFingerprint,
      )) match = entity
    }

    if (!match) {
      const row = unknownReconciliation(
        app,
        claimed,
        leaseOwner,
        context,
        'ADS_RECONCILIATION_MISMATCH',
        'The upstream entity did not match the requested safe state',
        policy.maxAttempts,
      )
      return reconcileResponse(row)
    }

    const row = finishReconciliation(app, claimed, leaseOwner, context, {
      state: AdsOperationStates.succeeded,
      entity: match,
    }, policy.maxAttempts)
    return reconcileResponse(row)
  } catch (error) {
    const failure = errorDetails(error)
    const row = unknownReconciliation(
      app,
      claimed,
      leaseOwner,
      context,
      `ADS_RECONCILIATION_${failure.code}`.slice(0, 100),
      'OpenAI Ads API outcome could not be reconciled',
      policy.maxAttempts,
    )
    return reconcileResponse(row)
  }
}

async function sweepAdsOperationsOnce(
  app: FastifyInstance,
  opts: AdsRoutesOptions,
  config: {
    policy: ReconcilePolicy
    batchSize: number
    leaseMs: number
    verificationCache: AdsAccountVerificationCache
    verificationCacheTtlMs: number
  },
): Promise<void> {
  if (!opts.adsOperator || !opts.adsCredentialStore) return
  const now = new Date()
  const nowIso = now.toISOString()
  const pendingCutoff = new Date(
    now.getTime() - config.policy.pendingMinIdleMs,
  ).toISOString()
  const unknownRetryWindows = Array.from(
    { length: config.policy.maxAttempts },
    (_, reconcileAttempts) => {
      const backoffMs = config.policy.backoffBaseMs
        * (2 ** Math.max(0, reconcileAttempts - 1))
      return and(
        eq(adsOperations.reconcileAttempts, reconcileAttempts),
        lte(adsOperations.updatedAt, new Date(now.getTime() - backoffMs).toISOString()),
      )
    },
  )
  const retryableStateWhere = or(
    and(
      eq(adsOperations.state, AdsOperationStates.pending),
      lte(adsOperations.updatedAt, pendingCutoff),
    ),
    and(
      eq(adsOperations.state, AdsOperationStates.unknown),
      or(...unknownRetryWindows),
    ),
    and(
      eq(adsOperations.state, AdsOperationStates.reconciling),
      or(isNull(adsOperations.leaseExpiresAt), lte(adsOperations.leaseExpiresAt, nowIso)),
    ),
  )
  const staleReconcileWhere = and(
    lt(adsOperations.reconcileAttempts, config.policy.maxAttempts),
    or(
      eq(adsOperations.reconcileStrategy, AdsReconcileStrategies.known_entity),
      and(
        eq(adsOperations.reconcileStrategy, AdsReconcileStrategies.create_fingerprint),
        or(
          isNotNull(adsOperations.entityId),
          inArray(adsOperations.state, [
            AdsOperationStates.pending,
            AdsOperationStates.reconciling,
          ]),
        ),
      ),
    ),
    retryableStateWhere,
  )

  // A worker can die after claiming its last permitted attempt. Convert that
  // expired lease, and any legacy exhausted row, into an explicit terminal
  // recovery posture once. It stays unknown for operator visibility but is no
  // longer eligible for automatic or manual provider inspection.
  const exhaustedRows = app.db.select().from(adsOperations).where(and(
    gte(adsOperations.reconcileAttempts, config.policy.maxAttempts),
    or(
      and(
        eq(adsOperations.state, AdsOperationStates.pending),
        lte(adsOperations.updatedAt, pendingCutoff),
      ),
      eq(adsOperations.state, AdsOperationStates.unknown),
      and(
        eq(adsOperations.state, AdsOperationStates.reconciling),
        or(isNull(adsOperations.leaseExpiresAt), lte(adsOperations.leaseExpiresAt, nowIso)),
      ),
    ),
    or(
      isNull(adsOperations.errorCode),
      ne(adsOperations.errorCode, ADS_RECONCILIATION_QUARANTINED),
    ),
  )).orderBy(asc(adsOperations.updatedAt)).limit(config.batchSize).all()
  for (const row of exhaustedRows) {
    quarantineExhaustedReconciliation(app, row, now, config.policy, { actor: 'system' })
  }

  // Apply the batch limit only after excluding projects that cannot currently
  // prove their credential/account binding. Otherwise the same oldest
  // disconnected or misbound receipts can consume every bounded sweep and
  // permanently starve later eligible work. Verify only projects that actually
  // have a stale, safely reconcilable receipt.
  const credentialsByProjectId = new Map<
    string,
    { apiKey: string; adAccountId: string }
  >()
  const projectRows = app.db.selectDistinct({ id: projects.id, name: projects.name })
    .from(projects)
    .innerJoin(adsOperations, eq(adsOperations.projectId, projects.id))
    .where(staleReconcileWhere)
    .all()
  for (const project of projectRows) {
    try {
      const { apiKey, adAccountId } = await resolveAdsOperator(app, opts, project, {
        cache: config.verificationCache,
        ttlMs: config.verificationCacheTtlMs,
        nowMs: now.getTime(),
      })
      credentialsByProjectId.set(project.id, { apiKey, adAccountId })
    } catch {
      app.log.warn({ projectId: project.id }, 'Skipping ads receipt sweep for an unverified account binding')
    }
  }
  const eligibleProjectIds = [...credentialsByProjectId.keys()]
  if (eligibleProjectIds.length === 0) return

  const rows = app.db.select().from(adsOperations).where(and(
    inArray(adsOperations.projectId, eligibleProjectIds),
    staleReconcileWhere,
  )).orderBy(asc(adsOperations.updatedAt)).limit(config.batchSize).all()

  for (const row of rows) {
    const credential = credentialsByProjectId.get(row.projectId)
    if (!credential) continue
    await reconcileOneAdsOperation(app, {
      projectId: row.projectId,
      operationKey: row.operationKey,
      apiKey: credential.apiKey,
      adAccountId: credential.adAccountId,
      operator: opts.adsOperator,
      leaseMs: config.leaseMs,
      pendingMinIdleMs: config.policy.pendingMinIdleMs,
      backoffBaseMs: config.policy.backoffBaseMs,
      maxAttempts: config.policy.maxAttempts,
      enforceBackoff: true,
      now,
      audit: { actor: 'system' },
    })
  }
}

function parseBody<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: unknown[] } } }, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw validationError('Invalid ads operation request', { issues: parsed.error.issues })
  return parsed.data
}

function assertExpectedUpdatedAt(entity: AdsOperatorEntityResult, expected: number): void {
  if (entity.updatedAt !== expected) {
    throw validationError('The upstream ad entity changed since it was reviewed', {
      expectedUpdatedAt: expected,
      actualUpdatedAt: entity.updatedAt,
    })
  }
}

function assertPausedForUpdate(entity: AdsOperatorEntityResult): void {
  if (entity.status !== AdsEntityStatuses.paused) {
    throw validationError('Pause the upstream ad entity before updating it', {
      actualStatus: entity.status,
    })
  }
}

const BILLING_EVENT_BY_CAMPAIGN_BIDDING_TYPE: Record<
  AdsCampaignBiddingType,
  AdsAdGroupBillingEventType
> = {
  [AdsCampaignBiddingTypes.impressions]: AdsAdGroupBillingEventTypes.impression,
  [AdsCampaignBiddingTypes.clicks]: AdsAdGroupBillingEventTypes.click,
}

function assertAdGroupBillingMatchesCampaign(
  campaign: AdsOperatorEntityResult,
  requestedBillingEventType: AdsAdGroupBillingEventType,
): void {
  // The provider documents a missing/null bidding_type as the legacy
  // impressions default. Materialize that default before enforcing the
  // campaign/ad-group compatibility invariant.
  const campaignBiddingType = campaign.biddingType ?? AdsCampaignBiddingTypes.impressions
  const expectedBillingEventType = BILLING_EVENT_BY_CAMPAIGN_BIDDING_TYPE[campaignBiddingType]
  if (requestedBillingEventType !== expectedBillingEventType) {
    throw validationError('The ad group billing event must match the parent campaign bidding type', {
      campaignId: campaign.id,
      campaignBiddingType,
      requestedBillingEventType,
      expectedBillingEventType,
    })
  }
}

function campaignBiddingTypeDto(value: string | null): AdsCampaignBiddingType | null {
  const parsed = adsCampaignBiddingTypeSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function adGroupBillingEventTypeDto(value: string | null): AdsAdGroupBillingEventType | null {
  const parsed = adsAdGroupBillingEventTypeSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export async function adsRoutes(app: FastifyInstance, opts: AdsRoutesOptions): Promise<void> {
  const sweepIntervalMs = opts.adsReconcileSweepIntervalMs ?? DEFAULT_RECONCILE_SWEEP_INTERVAL_MS
  const pendingStaleMs = Math.max(1, opts.adsReconcilePendingStaleMs ?? DEFAULT_RECONCILE_PENDING_STALE_MS)
  const backoffBaseMs = Math.max(1, opts.adsReconcileBackoffBaseMs ?? DEFAULT_RECONCILE_BACKOFF_BASE_MS)
  const maxAttempts = Math.min(20, Math.max(1, opts.adsReconcileMaxAttempts ?? DEFAULT_RECONCILE_MAX_ATTEMPTS))
  const batchSize = Math.min(100, Math.max(1, opts.adsReconcileBatchSize ?? DEFAULT_RECONCILE_BATCH_SIZE))
  const leaseMs = Math.max(1, opts.adsReconcileLeaseMs ?? DEFAULT_RECONCILE_LEASE_MS)
  const verificationCacheTtlMs = Math.max(
    0,
    opts.adsAccountVerificationCacheTtlMs ?? DEFAULT_ADS_ACCOUNT_VERIFICATION_CACHE_TTL_MS,
  )
  const verificationCache: AdsAccountVerificationCache = new Map()
  const reconcilePolicy: ReconcilePolicy = {
    pendingMinIdleMs: pendingStaleMs,
    backoffBaseMs,
    maxAttempts,
  }
  const resolveOperatorForProject = (project: { id: string; name: string }) => resolveAdsOperator(
    app,
    opts,
    project,
    { cache: verificationCache, ttlMs: verificationCacheTtlMs },
  )
  let sweepTimer: ReturnType<typeof setInterval> | undefined
  let sweepPromise: Promise<void> | undefined
  if (sweepIntervalMs > 0 && opts.adsOperator && opts.adsCredentialStore) {
    app.addHook('onReady', async () => {
      sweepTimer = setInterval(() => {
        if (sweepPromise) return
        sweepPromise = sweepAdsOperationsOnce(app, opts, {
          policy: reconcilePolicy,
          batchSize,
          leaseMs,
          verificationCache,
          verificationCacheTtlMs,
        })
          .catch(() => {
            // Provider details can contain credentials or signed URLs. Keep the
            // process-level log generic; the receipt records a sanitized code.
            app.log.error('Ads receipt reconciliation sweep failed')
          })
          .finally(() => {
            sweepPromise = undefined
          })
      }, sweepIntervalMs)
      sweepTimer.unref()
    })
    app.addHook('onClose', async () => {
      if (sweepTimer) clearInterval(sweepTimer)
      await sweepPromise
    })
  }

  app.post<{ Params: { name: string }; Body: { apiKey?: string } }>(
    '/projects/:name/ads/connect',
    async (request) => {
      requireScope(request, ADS_WRITE_SCOPE)
      const project = resolveProject(app.db, request.params.name)
      const parsed = adsConnectRequestSchema.safeParse(request.body)
      if (!parsed.success) throw validationError('"apiKey" is required')
      if (!opts.adsCredentialStore || !opts.verifyAdsAccount) {
        throw validationError('Ads credential storage is not configured for this deployment')
      }

      // Validate the key against the upstream ad account BEFORE any write —
      // a key that cannot read its own account would only fail later, at
      // sync time, with a worse error.
      let account: VerifiedAdsAccount
      try {
        account = await opts.verifyAdsAccount(parsed.data.apiKey)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw validationError(`OpenAI Ads API rejected the key: ${message}`)
      }

      const now = new Date().toISOString()
      verificationCache.delete(project.id)
      const existingCfg = opts.adsCredentialStore.getConnection(project.name)
      opts.adsCredentialStore.upsertConnection({
        projectName: project.name,
        apiKey: parsed.data.apiKey,
        adAccountId: account.id,
        createdAt: existingCfg?.createdAt ?? now,
        updatedAt: now,
      })

      const existingRow = app.db.select().from(adsConnections)
        .where(eq(adsConnections.projectId, project.id)).get()
      app.db.transaction((tx) => {
        if (existingRow) {
          tx.update(adsConnections).set({
            adAccountId: account.id,
            displayName: account.name,
            currencyCode: account.currencyCode,
            timezone: account.timezone,
            status: account.status,
            reviewStatus: account.reviewStatus,
            integrityReviewStatus: account.integrityReviewStatus,
            integrityDecision: account.integrityDecision,
            updatedAt: now,
          }).where(eq(adsConnections.id, existingRow.id)).run()
        } else {
          tx.insert(adsConnections).values({
            id: crypto.randomUUID(),
            projectId: project.id,
            adAccountId: account.id,
            displayName: account.name,
            currencyCode: account.currencyCode,
            timezone: account.timezone,
            status: account.status,
            reviewStatus: account.reviewStatus,
            integrityReviewStatus: account.integrityReviewStatus,
            integrityDecision: account.integrityDecision,
            createdAt: now,
            updatedAt: now,
          }).run()
        }
        writeAuditLog(tx, auditFromRequest(request, {
          projectId: project.id,
          actor: 'api',
          action: 'ads.connected',
          entityType: 'ads-connection',
          entityId: account.id,
        }))
      })

      const row = app.db.select().from(adsConnections)
        .where(eq(adsConnections.projectId, project.id)).get()
      return statusDto(row)
    },
  )

  app.delete<{ Params: { name: string } }>('/projects/:name/ads/connection', async (request) => {
    requireScope(request, ADS_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    const row = app.db.select().from(adsConnections)
      .where(eq(adsConnections.projectId, project.id)).get()

    if (row) {
      app.db.transaction((tx) => {
        tx.delete(adsConnections).where(eq(adsConnections.id, row.id)).run()
        writeAuditLog(tx, auditFromRequest(request, {
          projectId: project.id,
          actor: 'api',
          action: 'ads.disconnected',
          entityType: 'ads-connection',
          entityId: row.adAccountId,
        }))
      })
    }
    const removedFromConfig = opts.adsCredentialStore?.removeConnection(project.name) ?? false
    verificationCache.delete(project.id)

    const response: AdsDisconnectResponse = { disconnected: Boolean(row) || removedFromConfig }
    return response
  })

  app.get<{ Params: { name: string } }>('/projects/:name/ads/status', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const row = app.db.select().from(adsConnections)
      .where(eq(adsConnections.projectId, project.id)).get()
    return statusDto(row)
  })

  app.get<{ Params: { name: string } }>('/projects/:name/ads/account', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const { apiKey, reader } = resolveAdsReader(opts, project.name)
    return executeAdsRead('account', () => reader.getAccount(apiKey))
  })

  app.get<{
    Params: { name: string }
    Querystring: { q?: string; limit?: string | number }
  }>('/projects/:name/ads/geo/search', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const parsed = adsGeoSearchQuerySchema.safeParse({
      q: request.query.q,
      limit: request.query.limit === undefined ? undefined : Number(request.query.limit),
    })
    if (!parsed.success) {
      throw validationError('Invalid ads geo search query', { issues: parsed.error.issues })
    }
    const { apiKey, reader } = resolveAdsReader(opts, project.name)
    return executeAdsRead('geo search', () => reader.searchGeo(apiKey, parsed.data))
  })

  app.get<{ Params: { name: string } }>('/projects/:name/ads/conversions/pixels', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const { apiKey, reader } = resolveAdsReader(opts, project.name)
    return executeAdsRead('conversion pixel list', () => reader.listConversionPixels(apiKey))
  })

  app.get<{ Params: { name: string } }>(
    '/projects/:name/ads/conversions/event-settings',
    async (request) => {
      const project = resolveProject(app.db, request.params.name)
      const { apiKey, reader } = resolveAdsReader(opts, project.name)
      return executeAdsRead(
        'conversion event setting list',
        () => reader.listConversionEventSettings(apiKey),
      )
    },
  )

  app.get<{
    Params: { name: string }
    Querystring: { state?: string; limit?: string | number; cursor?: string }
  }>('/projects/:name/ads/operations', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const parsed = adsUnresolvedOperationListQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      throw validationError('Invalid ads operation list query', { issues: parsed.error.issues })
    }
    const cursor = parsed.data.cursor
      ? decodeAdsOperationCursor(parsed.data.cursor, project.id, parsed.data.state)
      : undefined
    const rows = app.db.select().from(adsOperations).where(and(
      eq(adsOperations.projectId, project.id),
      inArray(adsOperations.state, parsed.data.state),
      cursor
        ? or(
            gt(adsOperations.createdAt, cursor.createdAt),
            and(
              eq(adsOperations.createdAt, cursor.createdAt),
              gt(adsOperations.id, cursor.id),
            ),
          )
        : undefined,
    )).orderBy(asc(adsOperations.createdAt), asc(adsOperations.id))
      .limit(parsed.data.limit + 1).all()
    const hasMore = rows.length > parsed.data.limit
    const page = hasMore ? rows.slice(0, parsed.data.limit) : rows
    const response: AdsUnresolvedOperationListResponse = {
      operations: page.map(operationDto),
      count: page.length,
      nextCursor: hasMore && page.length > 0
        ? encodeAdsOperationCursor(project.id, parsed.data.state, page[page.length - 1]!)
        : null,
    }
    return response
  })

  app.post<{
    Params: { name: string; operationKey: string }
    Body: unknown
  }>('/projects/:name/ads/operations/:operationKey/reconcile', async (request) => {
    requireScope(request, ADS_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    if (!readOperationByKey(app, project.id, request.params.operationKey)) {
      throw notFound('Ads operation', request.params.operationKey)
    }
    if (request.body !== undefined && (
      request.body === null
      || typeof request.body !== 'object'
      || Array.isArray(request.body)
      || Object.keys(request.body).length > 0
    )) {
      throw validationError('Ads operation reconciliation does not accept a request body')
    }
    const { apiKey, adAccountId, operator } = await resolveOperatorForProject(project)
    return reconcileOneAdsOperation(app, {
      projectId: project.id,
      adAccountId,
      operationKey: request.params.operationKey,
      apiKey,
      operator,
      leaseMs,
      pendingMinIdleMs: reconcilePolicy.pendingMinIdleMs,
      backoffBaseMs: reconcilePolicy.backoffBaseMs,
      maxAttempts: reconcilePolicy.maxAttempts,
      audit: { request, actor: 'api' },
    })
  })

  app.get<{ Params: { name: string; operationKey: string } }>(
    '/projects/:name/ads/operations/:operationKey',
    async (request) => {
      const project = resolveProject(app.db, request.params.name)
      const row = app.db
        .select()
        .from(adsOperations)
        .where(and(
          eq(adsOperations.projectId, project.id),
          eq(adsOperations.operationKey, request.params.operationKey),
        ))
        .get()
      if (!row) throw notFound('Ads operation', request.params.operationKey)
      const response: AdsOperationResponse = { operation: operationDto(row), replayed: true }
      return response
    },
  )

  app.post<{ Params: { name: string } }>('/projects/:name/ads/files', async (request) => {
    requireScope(request, ADS_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    const body = parseBody(adsImageUploadRequestSchema, request.body)
    const { apiKey, adAccountId, operator } = await resolveOperatorForProject(project)
    return executeAdsOperation(app, request, {
      projectId: project.id,
      adAccountId,
      operationKey: body.operationKey,
      kind: AdsOperationKinds.image_upload,
      entityType: AdsEntityTypes.file,
      payload: { imageUrl: body.imageUrl },
      reconciliation: { strategy: AdsReconcileStrategies.manual_only },
      run: async () => {
        const result = await operator.uploadImage(apiKey, body.imageUrl)
        return { id: result.fileId }
      },
    })
  })

  app.post<{ Params: { name: string } }>('/projects/:name/ads/campaigns', async (request) => {
    requireScope(request, ADS_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    const body = parseBody(adsCampaignCreateRequestSchema, request.body)
    const { operationKey, ...providerInput } = body
    const biddingType = providerInput.biddingType ?? AdsCampaignBiddingTypes.impressions
    const { apiKey, adAccountId, operator } = await resolveOperatorForProject(project)
    return executeAdsOperation(app, request, {
      projectId: project.id,
      adAccountId,
      operationKey,
      kind: AdsOperationKinds.campaign_create,
      entityType: AdsEntityTypes.campaign,
      payload: providerInput,
      reconciliation: {
        strategy: AdsReconcileStrategies.create_fingerprint,
        fields: campaignCreateReconcileFields({ ...providerInput, biddingType }),
      },
      expectedStatus: AdsEntityStatuses.paused,
      remediateStatus: (result) => operator.pauseCampaign(apiKey, result.id),
      run: async () => operator.createCampaign(apiKey, { ...providerInput, biddingType }),
    })
  })

  app.post<{ Params: { name: string } }>('/projects/:name/ads/ad-groups', async (request) => {
    requireScope(request, ADS_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    const body = parseBody(adsAdGroupCreateRequestSchema, request.body)
    const { operationKey, ...providerInput } = body
    const requestedBillingEventType = providerInput.billingEventType ?? AdsAdGroupBillingEventTypes.impression
    const { apiKey, adAccountId, operator } = await resolveOperatorForProject(project)
    return executeAdsOperation(app, request, {
      projectId: project.id,
      adAccountId,
      operationKey,
      kind: AdsOperationKinds.ad_group_create,
      entityType: AdsEntityTypes.ad_group,
      payload: providerInput,
      preflight: async () => {
        const campaign = await executeAdsRead(
          'campaign billing preflight',
          () => operator.getCampaign(apiKey, providerInput.campaignId),
        )
        assertAdGroupBillingMatchesCampaign(campaign, requestedBillingEventType)
      },
      reconciliation: {
        strategy: AdsReconcileStrategies.create_fingerprint,
        parentId: providerInput.campaignId,
        fields: adGroupCreateReconcileFields({
          ...providerInput,
          billingEventType: requestedBillingEventType,
        }),
      },
      expectedStatus: AdsEntityStatuses.paused,
      remediateStatus: (result) => operator.pauseAdGroup(apiKey, result.id),
      run: async () => operator.createAdGroup(apiKey, {
        ...providerInput,
        billingEventType: requestedBillingEventType,
      }),
    })
  })

  app.post<{ Params: { name: string } }>('/projects/:name/ads/ads', async (request) => {
    requireScope(request, ADS_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    const body = parseBody(adsAdCreateRequestSchema, request.body)
    const { operationKey, ...providerInput } = body
    const { apiKey, adAccountId, operator } = await resolveOperatorForProject(project)
    return executeAdsOperation(app, request, {
      projectId: project.id,
      adAccountId,
      operationKey,
      kind: AdsOperationKinds.ad_create,
      entityType: AdsEntityTypes.ad,
      payload: providerInput,
      reconciliation: {
        strategy: AdsReconcileStrategies.create_fingerprint,
        parentId: providerInput.adGroupId,
        fields: adCreateReconcileFields(providerInput),
      },
      expectedStatus: AdsEntityStatuses.paused,
      remediateStatus: (result) => operator.pauseAd(apiKey, result.id),
      run: async () => operator.createAd(apiKey, providerInput),
    })
  })

  app.post<{ Params: { name: string; id: string } }>(
    '/projects/:name/ads/campaigns/:id',
    async (request) => {
      requireScope(request, ADS_WRITE_SCOPE)
      const project = resolveProject(app.db, request.params.name)
      const body = parseBody(adsCampaignUpdateRequestSchema, request.body)
      const { operationKey, expectedUpdatedAt, ...update } = body
      const { apiKey, adAccountId, operator } = await resolveOperatorForProject(project)
      return executeAdsOperation(app, request, {
        projectId: project.id,
        adAccountId,
        operationKey,
        kind: AdsOperationKinds.campaign_update,
        entityType: AdsEntityTypes.campaign,
        payload: { id: request.params.id, expectedUpdatedAt, update },
        knownEntityId: request.params.id,
        reconciliation: {
          strategy: AdsReconcileStrategies.known_entity,
          fields: updateReconcileFields(AdsEntityTypes.campaign, update),
        },
        expectedStatus: AdsEntityStatuses.paused,
        remediateStatus: (result) => operator.pauseCampaign(apiKey, result.id),
        run: async () => {
          const current = await operator.getCampaign(apiKey, request.params.id)
          assertExpectedUpdatedAt(current, expectedUpdatedAt)
          assertPausedForUpdate(current)
          return operator.updateCampaign(apiKey, request.params.id, update)
        },
      })
    },
  )

  app.post<{ Params: { name: string; id: string } }>(
    '/projects/:name/ads/ad-groups/:id',
    async (request) => {
      requireScope(request, ADS_WRITE_SCOPE)
      const project = resolveProject(app.db, request.params.name)
      const body = parseBody(adsAdGroupUpdateRequestSchema, request.body)
      const { operationKey, expectedUpdatedAt, ...update } = body
      const { apiKey, adAccountId, operator } = await resolveOperatorForProject(project)
      return executeAdsOperation(app, request, {
        projectId: project.id,
        adAccountId,
        operationKey,
        kind: AdsOperationKinds.ad_group_update,
        entityType: AdsEntityTypes.ad_group,
        payload: { id: request.params.id, expectedUpdatedAt, update },
        knownEntityId: request.params.id,
        reconciliation: {
          strategy: AdsReconcileStrategies.known_entity,
          fields: updateReconcileFields(AdsEntityTypes.ad_group, update),
        },
        expectedStatus: AdsEntityStatuses.paused,
        remediateStatus: (result) => operator.pauseAdGroup(apiKey, result.id),
        run: async () => {
          const current = await operator.getAdGroup(apiKey, request.params.id)
          assertExpectedUpdatedAt(current, expectedUpdatedAt)
          assertPausedForUpdate(current)
          if (update.maxBidMicros === undefined) {
            return operator.updateAdGroup(apiKey, request.params.id, update)
          }
          if (!current.billingEventType) {
            throw validationError('The upstream ad group did not report a supported billing event', {
              adGroupId: current.id,
            })
          }
          return operator.updateAdGroup(apiKey, request.params.id, {
            ...update,
            billingEventType: current.billingEventType,
          })
        },
      })
    },
  )

  app.post<{ Params: { name: string; id: string } }>(
    '/projects/:name/ads/ads/:id',
    async (request) => {
      requireScope(request, ADS_WRITE_SCOPE)
      const project = resolveProject(app.db, request.params.name)
      const body = parseBody(adsAdUpdateRequestSchema, request.body)
      const { operationKey, expectedUpdatedAt, ...update } = body
      const { apiKey, adAccountId, operator } = await resolveOperatorForProject(project)
      return executeAdsOperation(app, request, {
        projectId: project.id,
        adAccountId,
        operationKey,
        kind: AdsOperationKinds.ad_update,
        entityType: AdsEntityTypes.ad,
        payload: { id: request.params.id, expectedUpdatedAt, update },
        knownEntityId: request.params.id,
        reconciliation: {
          strategy: AdsReconcileStrategies.known_entity,
          fields: updateReconcileFields(AdsEntityTypes.ad, update),
        },
        expectedStatus: AdsEntityStatuses.paused,
        remediateStatus: (result) => operator.pauseAd(apiKey, result.id),
        run: async () => {
          const current = await operator.getAd(apiKey, request.params.id)
          assertExpectedUpdatedAt(current, expectedUpdatedAt)
          assertPausedForUpdate(current)
          return operator.updateAd(apiKey, request.params.id, update)
        },
      })
    },
  )

  app.post<{ Params: { name: string; id: string } }>(
    '/projects/:name/ads/campaigns/:id/pause',
    async (request) => {
      requireScope(request, ADS_WRITE_SCOPE)
      const project = resolveProject(app.db, request.params.name)
      const body = parseBody(adsPauseRequestSchema, request.body)
      const { apiKey, adAccountId, operator } = await resolveOperatorForProject(project)
      return executeAdsOperation(app, request, {
        projectId: project.id,
        adAccountId,
        operationKey: body.operationKey,
        kind: AdsOperationKinds.campaign_pause,
        entityType: AdsEntityTypes.campaign,
        payload: { id: request.params.id },
        knownEntityId: request.params.id,
        reconciliation: {
          strategy: AdsReconcileStrategies.known_entity,
          fields: { status: AdsEntityStatuses.paused },
        },
        expectedStatus: AdsEntityStatuses.paused,
        remediateStatus: (result) => operator.pauseCampaign(apiKey, result.id),
        run: async () => operator.pauseCampaign(apiKey, request.params.id),
      })
    },
  )

  app.post<{ Params: { name: string; id: string } }>(
    '/projects/:name/ads/ad-groups/:id/pause',
    async (request) => {
      requireScope(request, ADS_WRITE_SCOPE)
      const project = resolveProject(app.db, request.params.name)
      const body = parseBody(adsPauseRequestSchema, request.body)
      const { apiKey, adAccountId, operator } = await resolveOperatorForProject(project)
      return executeAdsOperation(app, request, {
        projectId: project.id,
        adAccountId,
        operationKey: body.operationKey,
        kind: AdsOperationKinds.ad_group_pause,
        entityType: AdsEntityTypes.ad_group,
        payload: { id: request.params.id },
        knownEntityId: request.params.id,
        reconciliation: {
          strategy: AdsReconcileStrategies.known_entity,
          fields: { status: AdsEntityStatuses.paused },
        },
        expectedStatus: AdsEntityStatuses.paused,
        remediateStatus: (result) => operator.pauseAdGroup(apiKey, result.id),
        run: async () => operator.pauseAdGroup(apiKey, request.params.id),
      })
    },
  )

  app.post<{ Params: { name: string; id: string } }>(
    '/projects/:name/ads/ads/:id/pause',
    async (request) => {
      requireScope(request, ADS_WRITE_SCOPE)
      const project = resolveProject(app.db, request.params.name)
      const body = parseBody(adsPauseRequestSchema, request.body)
      const { apiKey, adAccountId, operator } = await resolveOperatorForProject(project)
      return executeAdsOperation(app, request, {
        projectId: project.id,
        adAccountId,
        operationKey: body.operationKey,
        kind: AdsOperationKinds.ad_pause,
        entityType: AdsEntityTypes.ad,
        payload: { id: request.params.id },
        knownEntityId: request.params.id,
        reconciliation: {
          strategy: AdsReconcileStrategies.known_entity,
          fields: { status: AdsEntityStatuses.paused },
        },
        expectedStatus: AdsEntityStatuses.paused,
        remediateStatus: (result) => operator.pauseAd(apiKey, result.id),
        run: async () => operator.pauseAd(apiKey, request.params.id),
      })
    },
  )

  app.post<{ Params: { name: string } }>('/projects/:name/ads/sync', async (request) => {
    requireScope(request, ADS_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    const row = app.db.select().from(adsConnections)
      .where(eq(adsConnections.projectId, project.id)).get()
    if (!row) {
      throw validationError('No ads connection for this project. Run "canonry ads connect" first.')
    }

    // Idempotent trigger: a sync paginates the whole account and runs for
    // minutes, so return the in-flight run instead of stacking a second pass
    // (mirrors POST /technical-aeo/runs).
    const inFlight = app.db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(and(
        eq(runs.projectId, project.id),
        eq(runs.kind, RunKinds['ads-sync']),
        inArray(runs.status, [RunStatuses.queued, RunStatuses.running]),
      ))
      .get()
    if (inFlight) {
      const existing: AdsSyncResponse = { runId: inFlight.id, status: inFlight.status as AdsSyncResponse['status'] }
      return existing
    }

    const runId = crypto.randomUUID()
    app.db.insert(runs).values({
      id: runId,
      projectId: project.id,
      kind: RunKinds['ads-sync'],
      status: RunStatuses.queued,
      trigger: RunTriggers.manual,
      createdAt: new Date().toISOString(),
    }).run()

    opts.onAdsSyncRequested?.(runId, project.id)

    const response: AdsSyncResponse = { runId, status: RunStatuses.queued }
    return response
  })

  app.get<{ Params: { name: string } }>('/projects/:name/ads/campaigns', async (request) => {
    const project = resolveProject(app.db, request.params.name)

    const campaignRows = app.db.select().from(adsCampaigns)
      .where(eq(adsCampaigns.projectId, project.id)).all()
    const groupRows = app.db.select().from(adsAdGroups)
      .where(eq(adsAdGroups.projectId, project.id)).all()
    const adRows = app.db.select().from(adsAds)
      .where(eq(adsAds.projectId, project.id)).all()

    const adsByGroup = new Map<string, AdsAdDto[]>()
    for (const ad of adRows) {
      const dto: AdsAdDto = {
        id: ad.id,
        adGroupId: ad.adGroupId,
        name: ad.name,
        status: ad.status,
        reviewStatus: ad.reviewStatus,
        creative: creativeDto(ad.creative),
        upstreamUpdatedAt: ad.upstreamUpdatedAt,
        syncedAt: ad.syncedAt,
      }
      const list = adsByGroup.get(ad.adGroupId) ?? []
      list.push(dto)
      adsByGroup.set(ad.adGroupId, list)
    }

    const groupsByCampaign = new Map<string, AdsAdGroupDto[]>()
    for (const group of groupRows) {
      const dto: AdsAdGroupDto = {
        id: group.id,
        campaignId: group.campaignId,
        name: group.name,
        description: group.description,
        status: group.status,
        billingEventType: adGroupBillingEventTypeDto(group.billingEventType),
        maxBidMicros: group.maxBidMicros,
        contextHints: group.contextHints,
        ads: adsByGroup.get(group.id) ?? [],
        upstreamUpdatedAt: group.upstreamUpdatedAt,
        syncedAt: group.syncedAt,
      }
      const list = groupsByCampaign.get(group.campaignId) ?? []
      list.push(dto)
      groupsByCampaign.set(group.campaignId, list)
    }

    const campaigns: AdsCampaignDto[] = campaignRows.map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      description: campaign.description,
      status: campaign.status,
      startTime: campaign.startTime,
      endTime: campaign.endTime,
      biddingType: campaignBiddingTypeDto(campaign.biddingType),
      conversionEventSettingIds: campaign.conversionEventSettingIds,
      dailySpendLimitMicros: campaign.dailySpendLimitMicros,
      lifetimeSpendLimitMicros: campaign.lifetimeSpendLimitMicros,
      locationIds: locationIdsDto(campaign.targeting),
      adGroups: groupsByCampaign.get(campaign.id) ?? [],
      upstreamUpdatedAt: campaign.upstreamUpdatedAt,
      syncedAt: campaign.syncedAt,
    }))

    const response: AdsCampaignListResponse = { campaigns }
    return response
  })

  app.get<{
    Params: { name: string }
    Querystring: { level?: string; entityId?: string; from?: string; to?: string }
  }>('/projects/:name/ads/insights', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const { level, entityId, from, to } = request.query

    let parsedLevel: AdsInsightLevel | undefined
    if (level !== undefined) {
      const result = adsInsightLevelSchema.safeParse(level)
      if (!result.success) {
        throw validationError('"level" must be one of: campaign, ad_group')
      }
      parsedLevel = result.data
    }

    const conditions = [eq(adsInsightsDaily.projectId, project.id)]
    if (parsedLevel) conditions.push(eq(adsInsightsDaily.level, parsedLevel))
    if (entityId) conditions.push(eq(adsInsightsDaily.entityId, entityId))
    if (from) conditions.push(gte(adsInsightsDaily.date, from))
    if (to) conditions.push(lte(adsInsightsDaily.date, to))

    const rows = app.db.select().from(adsInsightsDaily)
      .where(and(...conditions))
      .orderBy(asc(adsInsightsDaily.date))
      .all()

    const dtoRows: AdsInsightRowDto[] = rows.map((row) => ({
      level: row.level as AdsInsightLevel,
      entityId: row.entityId,
      date: row.date,
      impressions: row.impressions,
      clicks: row.clicks,
      spendMicros: row.spendMicros,
      conversions: row.conversions,
      ctr: adsCtr(row.clicks, row.impressions),
      cpcMicros: adsCpcMicros(row.spendMicros, row.clicks),
    }))

    const conn = app.db.select().from(adsConnections)
      .where(eq(adsConnections.projectId, project.id)).get()
    const response: AdsInsightsResponse = { rows: dtoRows, currencyCode: conn?.currencyCode ?? null }
    return response
  })

  app.get<{ Params: { name: string } }>('/projects/:name/ads/summary', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const row = app.db.select().from(adsConnections)
      .where(eq(adsConnections.projectId, project.id)).get()

    const campaignCount = app.db.select().from(adsCampaigns)
      .where(eq(adsCampaigns.projectId, project.id)).all().length
    const adGroupCount = app.db.select().from(adsAdGroups)
      .where(eq(adsAdGroups.projectId, project.id)).all().length
    const adCount = app.db.select().from(adsAds)
      .where(eq(adsAds.projectId, project.id)).all().length

    // Totals use CAMPAIGN-level rollups only — summing across levels would
    // double-count (ad-group rows are subdivisions of campaign rows).
    const campaignInsights = app.db.select().from(adsInsightsDaily)
      .where(and(
        eq(adsInsightsDaily.projectId, project.id),
        eq(adsInsightsDaily.level, 'campaign'),
      ))
      .all()

    let impressions = 0
    let clicks = 0
    let spendMicros = 0
    let conversions = 0
    let fromDate: string | null = null
    let toDate: string | null = null
    for (const insight of campaignInsights) {
      impressions += insight.impressions
      clicks += insight.clicks
      spendMicros += insight.spendMicros
      conversions += insight.conversions
      if (fromDate === null || insight.date < fromDate) fromDate = insight.date
      if (toDate === null || insight.date > toDate) toDate = insight.date
    }

    const response: AdsSummaryDto = {
      connected: Boolean(row),
      displayName: row?.displayName ?? null,
      currencyCode: row?.currencyCode ?? null,
      lastSyncedAt: row?.lastSyncedAt ?? null,
      campaignCount,
      adGroupCount,
      adCount,
      window: { from: fromDate, to: toDate },
      totals: {
        impressions,
        clicks,
        spendMicros,
        conversions,
        ctr: adsCtr(clicks, impressions),
        cpcMicros: adsCpcMicros(spendMicros, clicks),
      },
    }
    return response
  })
}
