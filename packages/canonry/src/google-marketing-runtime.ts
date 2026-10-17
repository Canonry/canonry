import crypto from 'node:crypto'
import {
  GOOGLE_ADS_CAMPAIGN_METRICS_MAX_CAMPAIGNS,
  GOOGLE_ADS_CAMPAIGN_METRICS_MAX_DAYS,
  GOOGLE_ADS_CAMPAIGN_METRICS_MAX_ROWS,
  GoogleAdsCampaignStatuses,
  GoogleAdsConversionActionStatuses,
  GoogleAdsCustomerStatuses,
  GoogleAdsGoalConfigurationLevels,
  GoogleAdsSnapshotKinds,
  GoogleMarketingProviders,
  GtmSnapshotKinds,
  canonicalizeGtmAccountId,
  canonicalizeGtmContainerId,
  canonicalizeGtmResourceSelection,
  deriveGoogleAdsEffectiveGoalGraph,
  formatIsoDateInTimeZone,
  googleAdsAccessibleCustomerDtoSchema,
  googleAdsAccessibleCustomersResponseSchema,
  googleAdsCampaignMetricsQuerySchema,
  googleAdsRawSnapshotDtoSchema,
  gtmAccountsResponseSchema,
  gtmContainerListResponseSchema,
  gtmRawSnapshotDtoSchema,
  gtmWorkspaceListResponseSchema,
  shiftIsoCalendarDate,
} from '@canonry/canonry-contracts'
import type {
  GoogleAdsAccessibleCustomerDto,
  GoogleAdsAccessibleCustomersResponse,
  GoogleAdsCampaignDto,
  GoogleAdsCampaignMetricDto,
  GoogleAdsCampaignMetricsQuery,
  GoogleAdsCampaignMetricsResponse,
  GoogleAdsConversionActionDto,
  GoogleAdsEffectiveGoalGraphDto,
  GoogleAdsInventoryDto,
  GoogleAdsRawSnapshotDto,
  GoogleAdsSnapshotKind,
  GoogleAdsSnapshotPayload,
  GoogleAdsCustomerStatus,
  GoogleMarketingProvider,
  GtmAccountsResponse,
  GtmContainerListResponse,
  GtmRawSnapshotDto,
  GtmSnapshotKind,
  GtmSnapshotPayload,
  GtmWorkspaceListResponse,
} from '@canonry/canonry-contracts'
import {
  GOOGLE_ADS_MAX_CUSTOMER_CLIENTS,
  GOOGLE_ADS_MAX_RESULT_ROWS,
  GoogleAdsClient,
  normalizeGoogleAdsCustomerId,
} from '@canonry/canonry-integration-google-ads'
import type {
  GoogleAdsCampaign,
  GoogleAdsCampaignMetrics,
  GoogleAdsConversionAction,
  GoogleAdsConversionGoalData,
  GoogleAdsCustomer,
  GoogleAdsCustomerClient,
  GoogleAdsDailyCampaignMetricsRow,
} from '@canonry/canonry-integration-google-ads'
import {
  checksumJson,
  createGoogleTagManagerClient,
  toGtmAccountDto,
  toGtmContainerDto,
  toGtmDraftWorkspaceGraphDto,
  toGtmLiveContainerGraphDto,
  toGtmWorkspaceDto,
} from '@canonry/canonry-integration-google-tag-manager'
import type {
  GoogleTagManagerClient,
  GtmContainerSnapshot,
  GtmDtoAdapterOptions,
} from '@canonry/canonry-integration-google-tag-manager'
import { refreshAccessToken } from '@canonry/canonry-integration-google'
import type { GoogleTokenResponse } from '@canonry/canonry-integration-google'
import type {
  CanonryConfig,
  GoogleAdsConnectionConfigEntry,
  GtmConnectionConfigEntry,
} from './config.js'
import {
  getGoogleAdsAuthConfig,
  getGoogleAdsConnection,
  upsertGoogleAdsConnection,
} from './google-ads-config.js'
import {
  getGtmAuthConfig,
  getGtmConnection,
  upsertGtmConnection,
} from './gtm-config.js'
import { createLogger } from './logger.js'

const log = createLogger('GoogleMarketing')

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1_000
const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 1_000

export interface GoogleMarketingProjectRef {
  id: string
  name: string
}

export interface GoogleMarketingRuntimeOptions {
  config: CanonryConfig
  saveConfigPatch: (patch: Partial<CanonryConfig>) => void | Promise<void>
  env?: Readonly<Record<string, string | undefined>>
  fetch?: typeof globalThis.fetch
  now?: () => Date
  randomUUID?: () => string
  refreshAccessToken?: (
    clientId: string,
    clientSecret: string,
    refreshToken: string,
  ) => Promise<GoogleTokenResponse>
}

export interface GoogleAdsCustomerDiscoveryOptions {
  loginCustomerId?: string | null
  maxCustomers?: number
}

export interface GoogleAdsCustomerDetailsInput {
  customerId: string
  loginCustomerId?: string | null
}

export interface GoogleMarketingListOptions {
  maxResults?: number
}

export interface GoogleAdsSyncInput {
  project: GoogleMarketingProjectRef
  connectionId: string
  runId: string
  selection: {
    customerId: string
    loginCustomerId?: string | null
    selectedAt?: string | null
  }
  /** Omit to use the trailing 31 customer-local calendar days (UTC fallback) and at most 50 campaigns. */
  metricsQuery?: GoogleAdsCampaignMetricsQuery
}

export interface GoogleAdsSyncResult {
  accessibleCustomers: GoogleAdsRawSnapshotDto
  inventory: GoogleAdsRawSnapshotDto
  metrics: GoogleAdsRawSnapshotDto | null
  effectiveGoalGraph: GoogleAdsEffectiveGoalGraphDto
}

export interface GtmSyncInput {
  project: GoogleMarketingProjectRef
  connectionId: string
  runId: string
  selection: {
    accountId: string
    containerId: string
    workspaceId?: string | null
  }
  expectedEventName?: string
  expectedHostname?: string
}

export interface GoogleMarketingRuntime {
  listGoogleAdsCustomers(
    project: GoogleMarketingProjectRef,
    options?: GoogleAdsCustomerDiscoveryOptions,
  ): Promise<GoogleAdsAccessibleCustomersResponse>
  getGoogleAdsCustomer(
    project: GoogleMarketingProjectRef,
    input: GoogleAdsCustomerDetailsInput,
  ): Promise<GoogleAdsAccessibleCustomerDto>
  listGtmAccounts(
    project: GoogleMarketingProjectRef,
    options?: GoogleMarketingListOptions,
  ): Promise<GtmAccountsResponse>
  listGtmContainers(
    project: GoogleMarketingProjectRef,
    accountId: string,
    options?: GoogleMarketingListOptions,
  ): Promise<GtmContainerListResponse>
  listGtmWorkspaces(
    project: GoogleMarketingProjectRef,
    accountId: string,
    containerId: string,
    options?: GoogleMarketingListOptions,
  ): Promise<GtmWorkspaceListResponse>
  syncGoogleAds(input: GoogleAdsSyncInput): Promise<GoogleAdsSyncResult>
  syncGtm(input: GtmSyncInput): Promise<GtmRawSnapshotDto>
}

export class GoogleMarketingRuntimeError extends Error {
  override readonly name = 'GoogleMarketingRuntimeError'

  constructor(
    message: string,
    public readonly code:
      | 'INVALID_INPUT'
      | 'NOT_CONFIGURED'
      | 'CONNECTION_NOT_FOUND'
      | 'TOKEN_REFRESH_REQUIRED'
      | 'INVALID_TOKEN_RESPONSE'
      | 'RESOURCE_NOT_FOUND',
  ) {
    super(message)
  }
}

interface SnapshotContext {
  project: GoogleMarketingProjectRef
  connectionId: string
  runId: string
}

interface PrivateCredential {
  accessToken: string
}

type GoogleMarketingConnection = GoogleAdsConnectionConfigEntry | GtmConnectionConfigEntry

/**
 * A refresh can await Google while a reconnect or disconnect replaces this
 * project's credentials. Keep a secret-free value snapshot for a local CAS;
 * credentialGeneration makes a reconnect distinguishable even when timestamps
 * happen to land in the same millisecond.
 */
function credentialGeneration(connection: GoogleMarketingConnection): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    projectId: connection.projectId,
    credentialGeneration: connection.credentialGeneration ?? null,
    accessToken: connection.accessToken ?? null,
    refreshToken: connection.refreshToken ?? null,
    tokenExpiresAt: connection.tokenExpiresAt ?? null,
    scopes: connection.scopes ?? [],
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  })).digest('base64url')
}

/** Private runtime seam. Values returned here must never cross an API response boundary. */
export interface GoogleMarketingCredentialStore {
  getCredential(
    project: GoogleMarketingProjectRef,
    provider: GoogleMarketingProvider,
  ): Promise<PrivateCredential>
}

function nonEmpty(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GoogleMarketingRuntimeError(`${label} is required`, 'INVALID_INPUT')
  }
  return value.trim()
}

function validateProject(project: GoogleMarketingProjectRef): GoogleMarketingProjectRef {
  return {
    id: nonEmpty(project.id, 'Project ID'),
    name: nonEmpty(project.name, 'Project name'),
  }
}

function validatedListLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LIST_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new GoogleMarketingRuntimeError(
      `List limit must be an integer between 1 and ${MAX_LIST_LIMIT}`,
      'INVALID_INPUT',
    )
  }
  return limit
}

function resourceId(value: string, label: string): string {
  const id = value.split('/').filter(Boolean).at(-1)
  if (!id) throw new GoogleMarketingRuntimeError(`${label} is invalid`, 'INVALID_INPUT')
  return id
}

function canonicalGtmAccountId(value: string): string {
  const accountId = canonicalizeGtmAccountId(value)
  if (!accountId) {
    throw new GoogleMarketingRuntimeError('GTM account ID is invalid', 'INVALID_INPUT')
  }
  return accountId
}

function canonicalGtmContainerId(value: string, accountId: string): string {
  const containerId = canonicalizeGtmContainerId(value, accountId)
  if (!containerId) {
    throw new GoogleMarketingRuntimeError('GTM container ID is invalid or belongs to another account', 'INVALID_INPUT')
  }
  return containerId
}

function accountPath(accountId: string): string {
  return `accounts/${canonicalGtmAccountId(accountId)}`
}

function containerPath(accountId: string, containerId: string): string {
  const canonicalAccountId = canonicalGtmAccountId(accountId)
  return `accounts/${canonicalAccountId}/containers/${canonicalGtmContainerId(containerId, canonicalAccountId)}`
}

function workspacePath(accountId: string, containerId: string, workspaceId: string): string {
  const selection = canonicalizeGtmResourceSelection({ accountId, containerId, workspaceId })
  if (!selection?.workspaceId) {
    throw new GoogleMarketingRuntimeError('GTM workspace ID is invalid or belongs to another container', 'INVALID_INPUT')
  }
  return `accounts/${selection.accountId}/containers/${selection.containerId}/workspaces/${selection.workspaceId}`
}

function normalizedCustomerStatus(status: string | undefined): GoogleAdsCustomerStatus {
  switch (status?.toUpperCase()) {
    case 'ENABLED': return GoogleAdsCustomerStatuses.enabled
    case 'SUSPENDED': return GoogleAdsCustomerStatuses.suspended
    case 'CLOSED': return GoogleAdsCustomerStatuses.closed
    case 'CANCELED': return GoogleAdsCustomerStatuses.canceled
    case 'UNSPECIFIED': return GoogleAdsCustomerStatuses.unspecified
    default: return GoogleAdsCustomerStatuses.unknown
  }
}

function accessibleCustomerDto(customer: GoogleAdsCustomer): GoogleAdsAccessibleCustomerDto {
  return googleAdsAccessibleCustomerDtoSchema.parse({
    resourceName: customer.resourceName,
    customerId: customer.id,
    parentCustomerId: null,
    descriptiveName: customer.descriptiveName ?? null,
    currencyCode: customer.currencyCode ?? null,
    timeZone: customer.timeZone ?? null,
    manager: customer.manager ?? false,
    hidden: false,
    testAccount: customer.testAccount ?? false,
    level: 0,
    status: normalizedCustomerStatus(customer.status),
  })
}

function accessibleCustomerClientDto(
  customer: GoogleAdsCustomerClient,
  loginCustomerId: string,
): GoogleAdsAccessibleCustomerDto {
  const level = Number(customer.level ?? '0')
  if (!Number.isSafeInteger(level) || level < 0) {
    throw new GoogleMarketingRuntimeError(
      'Google Ads returned an invalid customer hierarchy level',
      'INVALID_INPUT',
    )
  }
  return googleAdsAccessibleCustomerDtoSchema.parse({
    resourceName: customer.clientCustomer || `customers/${customer.id}`,
    customerId: customer.id,
    // Google Ads exposes the selected login-manager root and hierarchy depth,
    // but not a direct parent edge in this query. Retain the root as the
    // account context required to read any discovered child honestly.
    parentCustomerId: customer.id === loginCustomerId ? null : loginCustomerId,
    descriptiveName: customer.descriptiveName ?? null,
    currencyCode: customer.currencyCode ?? null,
    timeZone: customer.timeZone ?? null,
    manager: customer.manager ?? false,
    hidden: customer.hidden ?? false,
    testAccount: customer.testAccount ?? false,
    level,
    status: normalizedCustomerStatus(customer.status),
  })
}

function campaignStatus(status: string): GoogleAdsCampaignDto['status'] {
  switch (status.toUpperCase()) {
    case 'ENABLED': return GoogleAdsCampaignStatuses.enabled
    case 'PAUSED': return GoogleAdsCampaignStatuses.paused
    case 'REMOVED': return GoogleAdsCampaignStatuses.removed
    default: return GoogleAdsCampaignStatuses.unknown
  }
}

function conversionActionStatus(status: string): GoogleAdsConversionActionDto['status'] {
  switch (status.toUpperCase()) {
    case 'ENABLED': return GoogleAdsConversionActionStatuses.enabled
    case 'HIDDEN': return GoogleAdsConversionActionStatuses.hidden
    case 'REMOVED': return GoogleAdsConversionActionStatuses.removed
    default: return GoogleAdsConversionActionStatuses.unknown
  }
}

function campaignDto(campaign: GoogleAdsCampaign): GoogleAdsCampaignDto {
  return {
    id: campaign.id,
    resourceName: campaign.resourceName,
    name: campaign.name,
    status: campaignStatus(campaign.status),
    advertisingChannelType: campaign.advertisingChannelType ?? null,
    biddingStrategyType: campaign.biddingStrategyType ?? null,
  }
}

function conversionActionDto(action: GoogleAdsConversionAction): GoogleAdsConversionActionDto {
  return {
    id: action.id,
    resourceName: action.resourceName,
    name: action.name,
    status: conversionActionStatus(action.status),
    category: action.category,
    origin: action.origin,
    primaryForGoal: action.primaryForGoal ?? false,
    includeInConversionsMetric: action.includeInConversionsMetric ?? false,
  }
}

function inventoryDto(
  customerId: string,
  fetchedAt: string,
  campaigns: readonly GoogleAdsCampaign[],
  goals: GoogleAdsConversionGoalData,
): GoogleAdsInventoryDto {
  return {
    customerId,
    fetchedAt,
    campaigns: campaigns.map(campaignDto),
    conversionActions: goals.conversionActions.map(row => conversionActionDto(row.conversionAction)),
    customerConversionGoals: goals.customerGoals.map(row => ({
      category: row.customerConversionGoal.category,
      origin: row.customerConversionGoal.origin,
      biddable: row.customerConversionGoal.biddable ?? false,
    })),
    campaignConversionGoals: goals.campaignGoals.map(row => ({
      campaignId: row.campaign.id,
      category: row.campaignConversionGoal.category,
      origin: row.campaignConversionGoal.origin,
      biddable: row.campaignConversionGoal.biddable ?? false,
    })),
    campaignConversionGoalsComplete: goals.campaignGoalsComplete === true,
    customConversionGoals: goals.customGoals.map(row => ({
      id: row.customConversionGoal.id,
      name: row.customConversionGoal.name,
      conversionActionIds: (row.customConversionGoal.conversionActions ?? [])
        .map(name => resourceId(name, 'Conversion action resource name')),
    })),
    campaignGoalConfigurations: goals.campaignConfigs.map(row => {
      const level = row.conversionGoalCampaignConfig.goalConfigLevel
      if (level !== 'CUSTOMER' && level !== 'CAMPAIGN') {
        throw new GoogleMarketingRuntimeError(
          'Google Ads returned an unsupported campaign goal configuration level',
          'INVALID_INPUT',
        )
      }
      return {
        campaignId: row.campaign.id,
        goalConfigLevel: level === 'CAMPAIGN'
          ? GoogleAdsGoalConfigurationLevels.campaign
          : GoogleAdsGoalConfigurationLevels.customer,
        customGoalId: row.conversionGoalCampaignConfig.customConversionGoal
          ? resourceId(
              row.conversionGoalCampaignConfig.customConversionGoal,
              'Custom conversion goal resource name',
            )
          : null,
      }
    }),
  }
}

function nonnegativeInteger(value: string | undefined, label: string): number {
  const parsed = Number(value ?? '0')
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new GoogleMarketingRuntimeError(`Google Ads returned an invalid ${label}`, 'INVALID_INPUT')
  }
  return parsed
}

function conversionValueMicros(metrics: GoogleAdsCampaignMetrics): number | null {
  if (metrics.conversionsValue === undefined) return null
  const value = Math.round(metrics.conversionsValue * 1_000_000)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GoogleMarketingRuntimeError(
      'Google Ads returned an invalid conversion value',
      'INVALID_INPUT',
    )
  }
  return value
}

function campaignMetricDto(row: GoogleAdsDailyCampaignMetricsRow): GoogleAdsCampaignMetricDto {
  return {
    campaignId: row.campaign.id,
    date: row.segments.date,
    impressions: nonnegativeInteger(row.metrics.impressions, 'impression count'),
    clicks: nonnegativeInteger(row.metrics.clicks, 'click count'),
    costMicros: nonnegativeInteger(row.metrics.costMicros, 'cost'),
    conversions: row.metrics.conversions ?? 0,
    conversionValueMicros: conversionValueMicros(row.metrics),
  }
}

/**
 * The window every metrics read covers: the last MAX_DAYS calendar days in the
 * account's own time zone.
 */
function defaultMetricsWindow(now: Date, timeZone: string | null | undefined): { startDate: string; endDate: string } {
  const customerTimeZone = typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone : 'UTC'
  const endDate = formatIsoDateInTimeZone(now.toISOString(), customerTimeZone)
  return { startDate: shiftIsoCalendarDate(endDate, -(GOOGLE_ADS_CAMPAIGN_METRICS_MAX_DAYS - 1)), endDate }
}

/**
 * Which campaigns the bounded daily-metrics query should cover.
 *
 * `rankedCampaignIds` is the account's campaigns ordered by spend over the same
 * window, removed ones included. Selecting by spend rather than by campaign id
 * matters twice over:
 *
 * - id order is arbitrary with respect to money, so an account above the cap
 *   could spend the whole allowance on dormant campaigns and omit its biggest
 *   spender from the totals;
 * - a campaign removed mid-window still spent real money in it, and the
 *   inventory list excludes removed campaigns, so selecting from inventory
 *   alone loses that spend while coverage still reads complete.
 *
 * Falls back to inventory order when the ranking is unavailable, so a failed
 * ranking read degrades to the old behaviour rather than to no metrics at all.
 */
function defaultMetricsQuery(
  now: Date,
  campaigns: readonly GoogleAdsCampaignDto[],
  timeZone: string | null | undefined,
  rankedCampaignIds?: readonly string[],
): { query: GoogleAdsCampaignMetricsQuery | null; inventoryTruncated: boolean } {
  const inventoryIds = campaigns
    .map(campaign => campaign.id)
    .sort((left, right) => left.localeCompare(right))

  // The ranking is authoritative when present. Inventory ids that the ranking
  // never mentioned had no delivery in the window, so they are appended rather
  // than dropped: a zero-spend campaign is still a real campaign to report.
  const ranked = rankedCampaignIds ?? []
  const ordered = ranked.length > 0
    ? [...ranked, ...inventoryIds.filter(id => !ranked.includes(id))]
    : inventoryIds

  const selected = ordered.slice(0, GOOGLE_ADS_CAMPAIGN_METRICS_MAX_CAMPAIGNS)
  if (selected.length === 0) return { query: null, inventoryTruncated: false }
  const { startDate, endDate } = defaultMetricsWindow(now, timeZone)
  return {
    query: googleAdsCampaignMetricsQuerySchema.parse({ campaignIds: selected, startDate, endDate }),
    inventoryTruncated: ordered.length > selected.length,
  }
}

function countRedactedProviderValues(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0
  if (Array.isArray(value)) {
    let total = 0
    for (const item of value) total += countRedactedProviderValues(item)
    return total
  }
  return Object.entries(value).reduce((total, [key, item]) => {
    const own = key === 'value' || key === 'globalSiteTag' || key === 'eventSnippet' ? 1 : 0
    return total + own + countRedactedProviderValues(item)
  }, 0)
}

function rawMetadata(value: unknown): {
  rawPayloadSha256: null
  rawPayloadBytes: null
  redactedFieldCount: number
} {
  return {
    // The provider clients intentionally do not expose exact response bytes.
    // A hash of normalized objects would not be an honest raw-body checksum.
    rawPayloadSha256: null,
    rawPayloadBytes: null,
    redactedFieldCount: countRedactedProviderValues(value),
  }
}

class ConfigCredentialStore implements GoogleMarketingCredentialStore {
  readonly #config: CanonryConfig
  readonly #saveConfigPatch: GoogleMarketingRuntimeOptions['saveConfigPatch']
  readonly #now: () => Date
  readonly #refresh: NonNullable<GoogleMarketingRuntimeOptions['refreshAccessToken']>
  readonly #refreshes = new Map<string, Promise<string>>()

  constructor(options: GoogleMarketingRuntimeOptions) {
    this.#config = options.config
    this.#saveConfigPatch = options.saveConfigPatch
    this.#now = options.now ?? (() => new Date())
    this.#refresh = options.refreshAccessToken ?? refreshAccessToken
  }

  async getCredential(
    project: GoogleMarketingProjectRef,
    provider: GoogleMarketingProvider,
  ): Promise<PrivateCredential> {
    const normalizedProject = validateProject(project)
    const accessToken = await this.#accessToken(normalizedProject, provider)
    return { accessToken }
  }

  async #accessToken(
    project: GoogleMarketingProjectRef,
    provider: GoogleMarketingProvider,
  ): Promise<string> {
    const connection = provider === GoogleMarketingProviders['google-ads']
      ? getGoogleAdsConnection(this.#config, project.id)
      : getGtmConnection(this.#config, project.id)
    if (!connection) {
      throw new GoogleMarketingRuntimeError(
        `${provider === GoogleMarketingProviders['google-ads'] ? 'Google Ads' : 'GTM'} is not connected for this project`,
        'CONNECTION_NOT_FOUND',
      )
    }

    if (this.#hasFreshAccessToken(connection)) return connection.accessToken!

    // A reconnect can replace an expired credential while an older refresh is
    // still pending. The flight must be scoped to that exact credential
    // generation: joining the old promise would make the new principal's
    // first read fail its CAS instead of refreshing its own token.
    const key = `${provider}\u0000${project.id}\u0000${credentialGeneration(connection)}`
    const pending = this.#refreshes.get(key)
    if (pending) return pending

    const refresh = this.#refreshConnection(project, provider, connection)
    this.#refreshes.set(key, refresh)
    try {
      return await refresh
    } finally {
      if (this.#refreshes.get(key) === refresh) this.#refreshes.delete(key)
    }
  }

  #hasFreshAccessToken(connection: GoogleAdsConnectionConfigEntry | GtmConnectionConfigEntry): boolean {
    if (!connection.accessToken || !connection.tokenExpiresAt) return false
    const expiresAt = Date.parse(connection.tokenExpiresAt)
    return Number.isFinite(expiresAt) && this.#now().getTime() < expiresAt - TOKEN_REFRESH_SKEW_MS
  }

  #connection(
    provider: GoogleMarketingProvider,
    projectId: string,
  ): GoogleMarketingConnection | undefined {
    return provider === GoogleMarketingProviders['google-ads']
      ? getGoogleAdsConnection(this.#config, projectId)
      : getGtmConnection(this.#config, projectId)
  }

  #connectionHasGeneration(
    provider: GoogleMarketingProvider,
    projectId: string,
    expectedGeneration: string,
  ): boolean {
    const current = this.#connection(provider, projectId)
    return current !== undefined && credentialGeneration(current) === expectedGeneration
  }

  #restoreConnection(
    provider: GoogleMarketingProvider,
    connection: GoogleMarketingConnection,
  ): void {
    if (provider === GoogleMarketingProviders['google-ads']) {
      upsertGoogleAdsConnection(this.#config, connection as GoogleAdsConnectionConfigEntry)
    } else {
      upsertGtmConnection(this.#config, connection as GtmConnectionConfigEntry)
    }
  }

  async #refreshConnection(
    project: GoogleMarketingProjectRef,
    provider: GoogleMarketingProvider,
    connection: GoogleAdsConnectionConfigEntry | GtmConnectionConfigEntry,
  ): Promise<string> {
    if (!connection.refreshToken) {
      throw new GoogleMarketingRuntimeError(
        'Google OAuth access has expired and no refresh token is available',
        'TOKEN_REFRESH_REQUIRED',
      )
    }
    const auth = provider === GoogleMarketingProviders['google-ads']
      ? getGoogleAdsAuthConfig(this.#config)
      : getGtmAuthConfig(this.#config)
    if (!auth.clientId || !auth.clientSecret) {
      throw new GoogleMarketingRuntimeError(
        'Google OAuth client credentials are not configured',
        'NOT_CONFIGURED',
      )
    }

    const generationBeforeRefresh = credentialGeneration(connection)
    const tokens = await this.#refresh(auth.clientId, auth.clientSecret, connection.refreshToken)
    if (
      typeof tokens.access_token !== 'string' ||
      tokens.access_token.trim() === '' ||
      !Number.isFinite(tokens.expires_in) ||
      tokens.expires_in <= 0
    ) {
      throw new GoogleMarketingRuntimeError(
        'Google OAuth returned an invalid token response',
        'INVALID_TOKEN_RESPONSE',
      )
    }

    const now = this.#now()
    const patch = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? connection.refreshToken,
      tokenExpiresAt: new Date(now.getTime() + tokens.expires_in * 1_000).toISOString(),
      ...(tokens.scope ? { scopes: tokens.scope.split(/\s+/).filter(Boolean) } : {}),
      updatedAt: now.toISOString(),
    }
    if (!this.#connectionHasGeneration(provider, project.id, generationBeforeRefresh)) {
      throw new GoogleMarketingRuntimeError(
        `${provider === GoogleMarketingProviders['google-ads'] ? 'Google Ads' : 'GTM'} connection changed during token refresh`,
        'CONNECTION_NOT_FOUND',
      )
    }

    const refreshedConnection = { ...connection, ...patch }
    const refreshedGeneration = credentialGeneration(refreshedConnection)
    this.#restoreConnection(provider, refreshedConnection)
    try {
      await this.#saveConfigPatch(
        provider === GoogleMarketingProviders['google-ads']
          ? { googleAds: this.#config.googleAds }
          : { gtm: this.#config.gtm },
      )
    } catch (error) {
      // A reconnect may complete while an asynchronous save is pending. Roll
      // back only the refresh generation we wrote; never restore its principal
      // over the newer connection.
      if (this.#connectionHasGeneration(provider, project.id, refreshedGeneration)) {
        this.#restoreConnection(provider, connection)
      }
      throw error
    }
    return tokens.access_token
  }
}

class DefaultGoogleMarketingRuntime implements GoogleMarketingRuntime {
  readonly #config: CanonryConfig
  readonly #credentials: GoogleMarketingCredentialStore
  readonly #env: Readonly<Record<string, string | undefined>>
  readonly #fetch: typeof globalThis.fetch
  readonly #now: () => Date
  readonly #randomUUID: () => string

  constructor(options: GoogleMarketingRuntimeOptions) {
    this.#config = options.config
    this.#credentials = new ConfigCredentialStore(options)
    this.#env = options.env ?? process.env
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.#now = options.now ?? (() => new Date())
    this.#randomUUID = options.randomUUID ?? crypto.randomUUID
  }

  async listGoogleAdsCustomers(
    project: GoogleMarketingProjectRef,
    options: GoogleAdsCustomerDiscoveryOptions = {},
  ): Promise<GoogleAdsAccessibleCustomersResponse> {
    const normalizedProject = validateProject(project)
    const client = await this.#adsClient(normalizedProject, options.loginCustomerId)
    const result = await client.listAccessibleCustomerDetails({ maxCustomers: options.maxCustomers })
    const fetchedAt = this.#now().toISOString()
    const customersById = new Map(
      result.data.customers.map(customer => {
        const dto = accessibleCustomerDto(customer)
        return [dto.customerId, dto] as const
      }),
    )
    let hierarchyTruncated = false
    for (const root of result.data.customers) {
      if (!root.manager) continue
      const remaining = GOOGLE_ADS_MAX_CUSTOMER_CLIENTS - customersById.size
      if (remaining <= 0) {
        hierarchyTruncated = true
        break
      }
      try {
        const hierarchy = await client.getCustomerClients(root.id, { maxCustomers: remaining })
        hierarchyTruncated ||= hierarchy.data.truncated
        for (const customer of hierarchy.data.customerClients) {
          const dto = accessibleCustomerClientDto(customer, root.id)
          const existing = customersById.get(dto.customerId)
          if (!existing || dto.level < existing.level) customersById.set(dto.customerId, dto)
        }
      } catch {
        // A principal can list a directly accessible manager yet lack one of
        // its linked-client permissions. Preserve the proven roots and mark
        // discovery incomplete instead of inventing or dropping accessibility.
        hierarchyTruncated = true
      }
    }
    const customers = [...customersById.values()]
      .sort((left, right) => left.level - right.level || left.customerId.localeCompare(right.customerId))
    // Per-customer detail failures are rich (status, providerStatus, requestId,
    // sanitized message) and were collapsed into the `truncated` boolean and
    // otherwise discarded. That hid the only useful signal in the common case:
    // `listAccessibleCustomers` succeeds, every `getCustomerDetails` is denied
    // because the developer token's manager cannot reach the customer, and the
    // dashboard reports "0 of 0 accessible customers" as though the account
    // simply had none. Log them; the response shape is unchanged.
    if (result.data.failures.length > 0) {
      log.error('google-ads.customer-details-failed', {
        project: normalizedProject.name,
        totalAccessible: result.data.totalAccessible,
        attempted: result.data.attempted,
        returned: customers.length,
        failures: result.data.failures,
      })
    }
    return googleAdsAccessibleCustomersResponseSchema.parse({
      customers,
      totalAccessible: customers.length,
      truncated: result.data.truncated || result.data.failures.length > 0 || hierarchyTruncated,
      selection: {
        loginCustomerId: options.loginCustomerId
          ? normalizeGoogleAdsCustomerId(options.loginCustomerId, 'Login customer ID')
          : null,
        customerId: null,
        selectedAt: null,
      },
      fetchedAt,
    })
  }

  async getGoogleAdsCustomer(
    project: GoogleMarketingProjectRef,
    input: GoogleAdsCustomerDetailsInput,
  ): Promise<GoogleAdsAccessibleCustomerDto> {
    const normalizedProject = validateProject(project)
    const client = await this.#adsClient(normalizedProject, input.loginCustomerId)
    const result = await client.getCustomerDetails(input.customerId)
    return accessibleCustomerDto(result.data)
  }

  async listGtmAccounts(
    project: GoogleMarketingProjectRef,
    options: GoogleMarketingListOptions = {},
  ): Promise<GtmAccountsResponse> {
    const limit = validatedListLimit(options.maxResults)
    const client = await this.#gtmClient(validateProject(project))
    const accounts = (await client.listAccounts())
      .map(toGtmAccountDto)
    return gtmAccountsResponseSchema.parse({
      accounts: accounts.slice(0, limit),
      totalAccessible: accounts.length,
      truncated: accounts.length > limit,
      fetchedAt: this.#now().toISOString(),
    })
  }

  async listGtmContainers(
    project: GoogleMarketingProjectRef,
    accountId: string,
    options: GoogleMarketingListOptions = {},
  ): Promise<GtmContainerListResponse> {
    const limit = validatedListLimit(options.maxResults)
    const normalizedAccountId = canonicalGtmAccountId(accountId)
    const client = await this.#gtmClient(validateProject(project))
    const containers = (await client.listContainers(accountPath(normalizedAccountId)))
      .map(toGtmContainerDto)
    return gtmContainerListResponseSchema.parse({
      accountId: normalizedAccountId,
      containers: containers.slice(0, limit),
      totalAccessible: containers.length,
      truncated: containers.length > limit,
      fetchedAt: this.#now().toISOString(),
    })
  }

  async listGtmWorkspaces(
    project: GoogleMarketingProjectRef,
    accountId: string,
    containerId: string,
    options: GoogleMarketingListOptions = {},
  ): Promise<GtmWorkspaceListResponse> {
    const limit = validatedListLimit(options.maxResults)
    const normalizedAccountId = canonicalGtmAccountId(accountId)
    const normalizedContainerId = canonicalGtmContainerId(containerId, normalizedAccountId)
    const client = await this.#gtmClient(validateProject(project))
    const workspaces = (await client.listWorkspaces(
      containerPath(normalizedAccountId, normalizedContainerId),
    ))
      .map(toGtmWorkspaceDto)
    return gtmWorkspaceListResponseSchema.parse({
      accountId: normalizedAccountId,
      containerId: normalizedContainerId,
      workspaces: workspaces.slice(0, limit),
      totalAccessible: workspaces.length,
      truncated: workspaces.length > limit,
      fetchedAt: this.#now().toISOString(),
    })
  }

  async syncGoogleAds(input: GoogleAdsSyncInput): Promise<GoogleAdsSyncResult> {
    const project = validateProject(input.project)
    const context = this.#snapshotContext(project, input.connectionId, input.runId)
    const customerId = normalizeGoogleAdsCustomerId(input.selection.customerId)
    const suppliedMetricsQuery = input.metricsQuery
      ? googleAdsCampaignMetricsQuerySchema.parse(input.metricsQuery)
      : undefined
    const client = await this.#adsClient(project, input.selection.loginCustomerId)
    const [customerResult, campaignResult, goalResult] = await Promise.all([
      client.getCustomerDetails(customerId),
      client.getCampaigns(customerId, { limit: GOOGLE_ADS_MAX_RESULT_ROWS }),
      client.getConversionGoals(customerId),
    ])
    const capturedAt = this.#now().toISOString()
    const accessibleCustomersData = googleAdsAccessibleCustomersResponseSchema.parse({
      customers: [accessibleCustomerDto(customerResult.data)],
      totalAccessible: 1,
      truncated: false,
      selection: {
        loginCustomerId: input.selection.loginCustomerId
          ? normalizeGoogleAdsCustomerId(input.selection.loginCustomerId, 'Login customer ID')
          : null,
        customerId,
        selectedAt: input.selection.selectedAt ?? null,
      },
      fetchedAt: capturedAt,
    })
    const accessibleCustomersPayload: GoogleAdsSnapshotPayload = {
      kind: GoogleAdsSnapshotKinds['accessible-customers'],
      data: accessibleCustomersData,
    }
    const accessibleCustomersSnapshot = this.#googleAdsSnapshot(
      context,
      accessibleCustomersPayload,
      customerId,
      customerResult.data,
      capturedAt,
    )
    const inventory = inventoryDto(
      customerId,
      capturedAt,
      campaignResult.data.map(row => row.campaign),
      goalResult.data,
    )
    const inventoryPayload: GoogleAdsSnapshotPayload = {
      kind: GoogleAdsSnapshotKinds.inventory,
      data: inventory,
    }
    const inventoryRaw = {
      campaigns: campaignResult.data,
      conversionGoals: goalResult.data,
    }
    const inventorySnapshot = this.#googleAdsSnapshot(
      context,
      inventoryPayload,
      customerId,
      inventoryRaw,
      capturedAt,
    )
    const effectiveGoalGraph = deriveGoogleAdsEffectiveGoalGraph(inventory)

    // One extra bounded read: campaigns ranked by spend over the same window,
    // removed ones included, so the daily query is scoped to where the money
    // went. A failure here is not fatal; selection degrades to inventory order.
    const rankingWindow = defaultMetricsWindow(this.#now(), customerResult.data.timeZone)
    // Fetch ONE MORE than the cap. Exactly-at-cap is ambiguous: it cannot be
    // told apart from an account with more campaigns whose tail was cut, and
    // that ambiguity is what lets a subset sum be reported as complete.
    const ranking = await client
      .getCampaignSpendRanking(customerId, {
        ...rankingWindow,
        limit: GOOGLE_ADS_CAMPAIGN_METRICS_MAX_CAMPAIGNS + 1,
      })
      .then(result => ({
        ids: result.data.map(row => String(row.campaign.id)),
        failed: false,
      }))
      // A swallowed failure silently falls back to inventory order, which
      // EXCLUDES removed campaigns, so a campaign deleted mid-window loses its
      // spend while `truncated` still reads false. Record the failure and let it
      // surface as incompleteness instead of disappearing.
      .catch(() => ({ ids: [] as string[], failed: true }))

    const rankingTruncated = ranking.ids.length > GOOGLE_ADS_CAMPAIGN_METRICS_MAX_CAMPAIGNS

    const defaults = defaultMetricsQuery(
      this.#now(),
      inventory.campaigns,
      customerResult.data.timeZone,
      ranking.failed ? undefined : ranking.ids.slice(0, GOOGLE_ADS_CAMPAIGN_METRICS_MAX_CAMPAIGNS),
    )
    const metricsQuery = suppliedMetricsQuery ?? defaults.query
    if (!metricsQuery) {
      return {
        accessibleCustomers: accessibleCustomersSnapshot,
        inventory: inventorySnapshot,
        metrics: null,
        effectiveGoalGraph,
      }
    }

    const metricResult = await client.getDailyCampaignMetrics(customerId, {
      ...metricsQuery,
      limit: GOOGLE_ADS_CAMPAIGN_METRICS_MAX_ROWS + 1,
    })
    const metricRows = metricResult.data.map(campaignMetricDto)
    const response: GoogleAdsCampaignMetricsResponse = {
      query: metricsQuery,
      rows: metricRows.slice(0, GOOGLE_ADS_CAMPAIGN_METRICS_MAX_ROWS),
      truncated:
        metricRows.length > GOOGLE_ADS_CAMPAIGN_METRICS_MAX_ROWS ||
        (suppliedMetricsQuery === undefined && defaults.inventoryTruncated) ||
        // Either the ranking could not be read (so selection fell back to an
        // order that omits removed campaigns) or it reported more campaigns
        // than the cap. Both mean these totals are a subset of the account.
        (suppliedMetricsQuery === undefined && (ranking.failed || rankingTruncated)),
      fetchedAt: this.#now().toISOString(),
    }
    const metricsPayload: GoogleAdsSnapshotPayload = {
      kind: GoogleAdsSnapshotKinds['campaign-metrics'],
      data: response,
    }
    const metricsSnapshot = this.#googleAdsSnapshot(
      context,
      metricsPayload,
      customerId,
      metricResult.data,
      response.fetchedAt,
    )
    return {
      accessibleCustomers: accessibleCustomersSnapshot,
      inventory: inventorySnapshot,
      metrics: metricsSnapshot,
      effectiveGoalGraph,
    }
  }

  async syncGtm(input: GtmSyncInput): Promise<GtmRawSnapshotDto> {
    const project = validateProject(input.project)
    const context = this.#snapshotContext(project, input.connectionId, input.runId)
    const selected = canonicalizeGtmResourceSelection({
      accountId: input.selection.accountId,
      containerId: input.selection.containerId,
      ...(input.selection.workspaceId === undefined || input.selection.workspaceId === null
        ? {}
        : { workspaceId: input.selection.workspaceId }),
    })
    if (!selected) {
      throw new GoogleMarketingRuntimeError('GTM resource selection is invalid', 'INVALID_INPUT')
    }
    const selectedAccountId = selected.accountId
    const selectedContainerId = selected.containerId
    const selectedWorkspaceId = selected.workspaceId ?? null
    const client = await this.#gtmClient(project)
    const accounts = await client.listAccounts()
    const accountDtos = accounts.map(toGtmAccountDto)
    const account = accountDtos.find(candidate => candidate.id === selectedAccountId)
    if (!account) {
      throw new GoogleMarketingRuntimeError('Selected GTM account was not found', 'RESOURCE_NOT_FOUND')
    }

    const selectedContainerPath = containerPath(selectedAccountId, selectedContainerId)
    const [containers, workspaces] = await Promise.all([
      client.listContainers(accountPath(selectedAccountId)),
      client.listWorkspaces(selectedContainerPath),
    ])
    const containerDtos = containers.map(toGtmContainerDto)
    const container = containerDtos.find(candidate => candidate.id === selectedContainerId)
    if (!container) {
      throw new GoogleMarketingRuntimeError('Selected GTM container was not found', 'RESOURCE_NOT_FOUND')
    }
    const workspaceDtos = workspaces.map(toGtmWorkspaceDto)
    if (workspaceDtos.length > MAX_LIST_LIMIT) {
      throw new GoogleMarketingRuntimeError(
        `GTM workspace inventory exceeds the ${MAX_LIST_LIMIT}-workspace safety limit`,
        'INVALID_INPUT',
      )
    }
    // Publishing a GTM workspace deletes it and opens a new Default Workspace, so
    // a selected workspace ID goes stale on every publish. Follow the replacement
    // when it is the container's only workspace; otherwise read the live container.
    const selectedWorkspaceExists = selectedWorkspaceId !== null
      && workspaceDtos.some(candidate => candidate.id === selectedWorkspaceId)
    const workspaceId = selectedWorkspaceId === null || selectedWorkspaceExists
      ? selectedWorkspaceId
      : workspaceDtos.length === 1 ? workspaceDtos[0]!.id : null

    const snapshotReads: Array<Promise<GtmContainerSnapshot>> = [
      client.getLiveSnapshot(selectedContainerPath),
    ]
    if (workspaceId) {
      snapshotReads.push(client.getWorkspaceSnapshot(
        workspacePath(selectedAccountId, selectedContainerId, workspaceId),
      ))
    }
    const snapshots = await Promise.all(snapshotReads)
    const capturedAt = this.#now().toISOString()
    const adapterOptions: GtmDtoAdapterOptions = {
      fetchedAt: capturedAt,
      ...(input.expectedEventName ? { expectedEventName: input.expectedEventName } : {}),
      ...(input.expectedHostname ? { expectedHostname: input.expectedHostname } : {}),
    }
    const live = toGtmLiveContainerGraphDto(snapshots[0]!, adapterOptions)
    const draft = snapshots[1]
      ? toGtmDraftWorkspaceGraphDto(snapshots[1], adapterOptions)
      : null
    const payload: GtmSnapshotPayload = {
      kind: GtmSnapshotKinds.container,
      data: {
        account,
        container,
        workspaces: workspaceDtos,
        live,
        draft,
        fetchedAt: capturedAt,
      },
    }
    const raw = { accounts, containers, workspaces, snapshots }
    return this.#gtmSnapshot(
      context,
      payload,
      selectedAccountId,
      selectedContainerId,
      workspaceId,
      raw,
      capturedAt,
    )
  }

  async #adsClient(
    project: GoogleMarketingProjectRef,
    loginCustomerId: string | null | undefined,
  ): Promise<GoogleAdsClient> {
    const { accessToken } = await this.#credentials.getCredential(
      project,
      GoogleMarketingProviders['google-ads'],
    )
    const auth = getGoogleAdsAuthConfig(this.#config)
    const developerToken = this.#env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim()
      || auth.developerToken?.trim()
    if (!developerToken) {
      throw new GoogleMarketingRuntimeError(
        'Google Ads developer token is not configured',
        'NOT_CONFIGURED',
      )
    }
    return new GoogleAdsClient({
      accessToken,
      developerToken,
      ...(loginCustomerId ? { loginCustomerId } : {}),
    }, { fetch: this.#fetch })
  }

  async #gtmClient(project: GoogleMarketingProjectRef): Promise<GoogleTagManagerClient> {
    const { accessToken } = await this.#credentials.getCredential(
      project,
      GoogleMarketingProviders.gtm,
    )
    return createGoogleTagManagerClient(accessToken, { fetch: this.#fetch })
  }

  #snapshotContext(
    project: GoogleMarketingProjectRef,
    connectionId: string,
    runId: string,
  ): SnapshotContext {
    return {
      project,
      connectionId: nonEmpty(connectionId, 'Connection ID'),
      runId: nonEmpty(runId, 'Run ID'),
    }
  }

  #googleAdsSnapshot(
    context: SnapshotContext,
    payload: GoogleAdsSnapshotPayload,
    customerId: string | null,
    raw: unknown,
    capturedAt: string,
  ): GoogleAdsRawSnapshotDto {
    return googleAdsRawSnapshotDtoSchema.parse({
      metadata: {
        id: this.#randomUUID(),
        projectId: context.project.id,
        connectionId: context.connectionId,
        runId: context.runId,
        kind: payload.kind satisfies GoogleAdsSnapshotKind,
        customerId,
        payloadChecksum: checksumJson(payload),
        ...rawMetadata(raw),
        capturedAt,
        createdAt: capturedAt,
      },
      payload,
    })
  }

  #gtmSnapshot(
    context: SnapshotContext,
    payload: GtmSnapshotPayload,
    accountId: string | null,
    containerId: string | null,
    workspaceId: string | null,
    raw: unknown,
    capturedAt: string,
  ): GtmRawSnapshotDto {
    return gtmRawSnapshotDtoSchema.parse({
      metadata: {
        id: this.#randomUUID(),
        projectId: context.project.id,
        connectionId: context.connectionId,
        runId: context.runId,
        kind: payload.kind satisfies GtmSnapshotKind,
        accountId,
        containerId,
        workspaceId,
        payloadChecksum: checksumJson(payload),
        ...rawMetadata(raw),
        capturedAt,
        createdAt: capturedAt,
      },
      payload,
    })
  }
}

export function createGoogleMarketingCredentialStore(
  options: GoogleMarketingRuntimeOptions,
): GoogleMarketingCredentialStore {
  return new ConfigCredentialStore(options)
}

export function createGoogleMarketingRuntime(
  options: GoogleMarketingRuntimeOptions,
): GoogleMarketingRuntime {
  return new DefaultGoogleMarketingRuntime(options)
}
