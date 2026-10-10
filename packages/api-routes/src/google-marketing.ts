import crypto from 'node:crypto'
import { and, desc, eq, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  conversionTrackingContracts,
  googleAdsConnections,
  googleAdsRawSnapshots,
  gtmConnections,
  gtmRawSnapshots,
  projects,
  runs,
} from '@ainyc/canonry-db'
import {
  GOOGLE_MARKETING_LIVE_READ_SCOPE,
  GOOGLE_MARKETING_STORED_SNAPSHOT_PAGE_MAX,
  GOOGLE_MARKETING_WRITE_SCOPE,
  GoogleAdsConnectionStates,
  GoogleAdsSnapshotKinds,
  GoogleMarketingProviders,
  GtmConnectionStates,
  GtmSnapshotKinds,
  RunKinds,
  RunStatuses,
  RunTriggers,
  alreadyExists,
  canonicalizeGoogleAdsCustomerSelection,
  canonicalizeGtmAccountId,
  canonicalizeGtmResourceSelection,
  conversionTrackingContractSchema,
  conversionTrackingContractWriteRequestSchema,
  conversionTrackingIntegrityAssessmentDtoSchema,
  GoogleAdsCampaignStatuses,
  calendarDateRange,
  formatIsoDate,
  formatIsoDateInTimeZone,
  googleAdsAccessibleCustomersResponseSchema,
  googleAdsCustomerSelectionRequestSchema,
  googleAdsMetricsWindowSchema,
  googleAdsRawSnapshotDtoSchema,
  googleMarketingOAuthConnectRequestSchema,
  googleMarketingProviderSchema,
  inclusiveDayCount,
  forbidden,
  gtmAccountsResponseSchema,
  gtmContainerListResponseSchema,
  gtmRawSnapshotDtoSchema,
  gtmResourceSelectionRequestSchema,
  gtmWorkspaceListResponseSchema,
  hostOf,
  notFound,
  notImplemented,
  providerError,
  quotaExceeded,
  relativeChangeRatio,
  shiftIsoCalendarDate,
  validationError,
  type ConversionTrackingContract,
  type ConversionTrackingContractWriteRequest,
  type ConversionTrackingIntegrityAssessmentDto,
  type GoogleAdsAccessibleCustomerDto,
  type GoogleAdsAccessibleCustomersResponse,
  type GoogleAdsCampaignMetricDto,
  type GoogleAdsCampaignMetricsResponse,
  type GoogleAdsCampaignPerformance,
  type GoogleAdsConnectionMetadataDto,
  type GoogleAdsConnectionStatusDto,
  type GoogleAdsInventoryDto,
  type GoogleAdsMetricTotals,
  type GoogleAdsMetricsDailyPoint,
  type GoogleAdsMetricsWindow,
  type GoogleAdsPerformanceComparison,
  type GoogleAdsPerformanceDto,
  type GoogleAdsRawSnapshotDto,
  type GoogleMarketingProvider,
  type GtmAccountsResponse,
  type GtmConnectionMetadataDto,
  type GtmConnectionStatusDto,
  type GtmContainerListResponse,
  type GtmRawSnapshotDto,
  type GtmWorkspaceListResponse,
  describeError,
  AppError,
} from '@ainyc/canonry-contracts'
import { assertNotProjectScoped, requireAdminSession, requireBroadInstanceKey, requireScope } from './auth.js'
import { auditFromRequest, resolveProject, writeAuditLog } from './helpers.js'
import { connectionRoute, startConnectionAttempt, telemetryRead, unverifiedOAuthStateField, type ConnectionSubject } from './connection-telemetry.js'
import { assertSameOriginWrite } from './same-origin.js'
import {
  buildSignedGoogleOAuthState,
  GOOGLE_OAUTH_STATE_MAX_AGE_MS,
  verifySignedGoogleOAuthState,
} from './google-oauth-state.js'
import { parseCookieHeader } from './user-session.js'

/** A stable, project-local key for injected secret and provider adapters. */
export interface GoogleMarketingProjectRef {
  id: string
  name: string
}

/**
 * Private OAuth material. This type is deliberately local to the route seam:
 * it is accepted from an injected store and never serialized, audited, or
 * persisted through the Canonry database.
 */
export interface GoogleMarketingStoredCredential {
  accessToken: string | null
  refreshToken?: string | null
  expiresAt?: string | null
  scopes: string[]
  /** Google Ads only. Never returned from an API route. */
  developerToken?: string | null
  createdAt: string
  updatedAt: string
}

/** Project-scoped private credential storage (normally Canonry config). */
export interface GoogleMarketingCredentialStore {
  get(project: GoogleMarketingProjectRef, provider: GoogleMarketingProvider): GoogleMarketingStoredCredential | undefined
  /**
   * Persist the private credential. When supplied, the returned compensator
   * restores the prior durable credential if the caller's following database
   * transaction cannot commit.
   */
  upsert(project: GoogleMarketingProjectRef, provider: GoogleMarketingProvider, credential: GoogleMarketingStoredCredential): void | (() => void)
  delete(project: GoogleMarketingProjectRef, provider: GoogleMarketingProvider): boolean
  /**
   * Google Ads developer tokens are install-global. This intentionally exposes
   * only presence, never the token, so a project OAuth flow can use an
   * existing host token without copying it through a project credential.
   */
  hasGoogleAdsDeveloperToken?(): boolean
}

export interface GoogleMarketingOAuthToken {
  accessToken: string
  refreshToken?: string | null
  expiresAt?: string | null
  scopes: string[]
}

/** OAuth exchange seam; provider SDKs stay out of the shared route package. */
export interface GoogleMarketingOAuth {
  authorizationUrl(input: {
    provider: GoogleMarketingProvider
    redirectUri: string
    state: string
    scopes: readonly string[]
  }): string | Promise<string>
  exchangeCode(input: {
    provider: GoogleMarketingProvider
    code: string
    redirectUri: string
  }): Promise<GoogleMarketingOAuthToken>
}

/** Read-only provider discovery seam. It accepts no caller-provided credential. */
export interface GoogleMarketingLiveReader {
  listGoogleAdsCustomers(project: GoogleMarketingProjectRef): Promise<GoogleAdsAccessibleCustomersResponse>
  listGtmAccounts(project: GoogleMarketingProjectRef): Promise<GtmAccountsResponse>
  listGtmContainers(project: GoogleMarketingProjectRef, accountId: string): Promise<GtmContainerListResponse>
  listGtmWorkspaces(project: GoogleMarketingProjectRef, accountId: string, containerId: string): Promise<GtmWorkspaceListResponse>
}

/** Exact stored evidence handed to the pure integrity evaluator. */
export interface ConversionTrackingIntegrityInput {
  project: GoogleMarketingProjectRef
  contract: ConversionTrackingContract
  googleAdsSnapshot: GoogleAdsRawSnapshotDto | null
  gtmSnapshot: GtmRawSnapshotDto | null
}

export interface GoogleMarketingRoutesOptions {
  /** Private OAuth tokens/developer token. Never Canonry DB storage. */
  googleMarketingCredentialStore?: GoogleMarketingCredentialStore
  /** Provider-specific OAuth URL + code exchange implementation. */
  googleMarketingOAuth?: GoogleMarketingOAuth
  /** Provider OAuth scopes, injected by the host to avoid integration deps here. */
  googleMarketingOAuthScopes?: Partial<Record<GoogleMarketingProvider, readonly string[]>>
  /** Bounded read-only discovery adapter. */
  googleMarketingLiveReader?: GoogleMarketingLiveReader
  /** Pure integrity evaluator; api-routes does not import a runtime cycle. */
  assessConversionTrackingIntegrity?: (
    input: ConversionTrackingIntegrityInput,
  ) => Promise<ConversionTrackingIntegrityAssessmentDto> | ConversionTrackingIntegrityAssessmentDto
  /** Called only after the queued Google Ads sync run commits. */
  onGoogleAdsSyncRequested?: (runId: string, projectId: string) => void | Promise<void>
  /** Called only after the queued GTM sync run commits. */
  onGtmSyncRequested?: (runId: string, projectId: string) => void | Promise<void>
  /** Shared HMAC secret for the short-lived OAuth callback state. */
  googleStateSecret?: string
  /** Public URL for OAuth redirect URIs (overrides request-header detection). */
  publicUrl?: string
  /** API route prefix (default: `/api/v1`). */
  routePrefix?: string
}

const snapshotPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(GOOGLE_MARKETING_STORED_SNAPSHOT_PAGE_MAX).optional(),
  cursor: z.string().min(1).optional(),
}).strict()

const oauthStateSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  provider: googleMarketingProviderSchema,
  redirectUri: z.string().url(),
  nonce: z.string().regex(/^[\w-]{43}$/),
  issuedAt: z.number(),
}).strict()

type GoogleMarketingOAuthState = z.infer<typeof oauthStateSchema>

/** Keep pending authorization material small and automatically short-lived. */
const GOOGLE_MARKETING_OAUTH_PENDING_FLOW_MAX = 256
const GOOGLE_MARKETING_OAUTH_COOKIE_PREFIX = 'canonry_google_marketing_oauth_'

interface GoogleMarketingOAuthInitiator {
  kind: 'api-key' | 'user' | null
  id: string | null
  projectId: string | null
  viaCookie: boolean
}

interface PendingGoogleMarketingOAuthFlow {
  nonce: string
  generation: string
  projectId: string
  projectName: string
  provider: GoogleMarketingProvider
  redirectUri: string
  expiresAtMs: number
  initiator: GoogleMarketingOAuthInitiator
  /** Separate browser-held secret; never appears in the OAuth URL/state. */
  browserNonce: string
  /** Present only when a broad instance authority supplied a new global token. */
  developerToken?: string
  /** Outcome telemetry: whether this flow replaces an existing credential. */
  connectionAction?: 'connect' | 'reauth'
}

const MARKETING_INTEGRATIONS = { 'google-ads': 'google_ads', gtm: 'gtm' } as const

/** The outcome subject for a Google Marketing provider name, or undefined for anything else. */
function marketingConnection(provider: unknown, action: ConnectionSubject['action'] = 'connect'): ConnectionSubject | undefined {
  return typeof provider === 'string' && Object.hasOwn(MARKETING_INTEGRATIONS, provider)
    ? { integration: MARKETING_INTEGRATIONS[provider as keyof typeof MARKETING_INTEGRATIONS], action }
    : undefined
}

interface PendingGoogleMarketingOAuthConfirmation {
  id: string
  flow: PendingGoogleMarketingOAuthFlow
  tokens: GoogleMarketingOAuthToken
  expiresAtMs: number
}

function oauthInitiator(request: FastifyRequest): GoogleMarketingOAuthInitiator {
  const principal = request.principal
  return {
    kind: principal?.kind ?? null,
    id: principal?.id ?? null,
    projectId: principal?.projectId ?? null,
    viaCookie: principal?.viaCookie ?? false,
  }
}

function sameOAuthInitiator(
  expected: GoogleMarketingOAuthInitiator,
  actual: GoogleMarketingOAuthInitiator,
): boolean {
  return expected.kind === actual.kind
    && expected.id === actual.id
    && expected.projectId === actual.projectId
    && expected.viaCookie === actual.viaCookie
}

/**
 * The OAuth callback must be public so Google can deliver the code. A signed
 * state establishes integrity, while this process-local store makes the state
 * a short-lived, single-use capability. `consume` deletes before the first
 * await in the callback, so concurrent/replayed callbacks cannot exchange or
 * persist a second code.
 */
class PendingGoogleMarketingOAuthFlows {
  #flows = new Map<string, PendingGoogleMarketingOAuthFlow>()
  #confirmations = new Map<string, PendingGoogleMarketingOAuthConfirmation>()
  #currentGenerations = new Map<string, string>()

  create(flow: PendingGoogleMarketingOAuthFlow, nowMs = Date.now()): void {
    this.prune(nowMs)
    const replacesExisting = [...this.#flows.values()].some(existing =>
      existing.projectId === flow.projectId && existing.provider === flow.provider)
    if (this.#flows.size >= GOOGLE_MARKETING_OAUTH_PENDING_FLOW_MAX && !replacesExisting) {
      throw quotaExceeded('Google Marketing OAuth starts')
    }
    this.revoke(flow.projectId, flow.provider)
    this.#currentGenerations.set(this.generationKey(flow.projectId, flow.provider), flow.generation)
    this.#flows.set(flow.nonce, flow)
  }

  consume(
    state: GoogleMarketingOAuthState,
    browserNonce: string | undefined,
    nowMs = Date.now(),
  ): PendingGoogleMarketingOAuthFlow | null {
    this.prune(nowMs)
    const flow = this.#flows.get(state.nonce)
    if (!flow) return null

    // Do not burn a legitimate browser's flow if a leaked URL is opened in a
    // different browser. Only the browser that received the HttpOnly binding
    // cookie can consume it.
    if (!sameOpaqueNonce(browserNonce, flow.browserNonce)) return null

    if (!this.isCurrent(flow)) {
      this.#flows.delete(state.nonce)
      return null
    }

    // Deleting before binding checks is intentional: a callback attempt gets
    // one chance, including malformed/failed provider callbacks.
    this.#flows.delete(state.nonce)
    if (
      flow.projectId !== state.projectId
      || flow.projectName !== state.projectName
      || flow.provider !== state.provider
      || flow.redirectUri !== state.redirectUri
      || flow.expiresAtMs <= nowMs
    ) {
      this.finish(flow)
      return null
    }
    return flow
  }

  createConfirmation(
    flow: PendingGoogleMarketingOAuthFlow,
    tokens: GoogleMarketingOAuthToken,
    nowMs = Date.now(),
  ): string | null {
    this.prune(nowMs)
    if (!this.isCurrent(flow)) return null
    if (this.#confirmations.size >= GOOGLE_MARKETING_OAUTH_PENDING_FLOW_MAX) {
      throw quotaExceeded('Google Marketing OAuth confirmations')
    }
    const id = crypto.randomBytes(32).toString('base64url')
    this.#confirmations.set(id, {
      id,
      flow,
      tokens,
      expiresAtMs: nowMs + GOOGLE_OAUTH_STATE_MAX_AGE_MS,
    })
    return id
  }

  consumeConfirmation(
    id: string,
    initiator: GoogleMarketingOAuthInitiator,
    nowMs = Date.now(),
  ): PendingGoogleMarketingOAuthConfirmation | null {
    this.prune(nowMs)
    const confirmation = this.#confirmations.get(id)
    if (!confirmation || !sameOAuthInitiator(confirmation.flow.initiator, initiator)) return null
    this.#confirmations.delete(id)
    return confirmation
  }

  revoke(projectId: string, provider: GoogleMarketingProvider): void {
    for (const [nonce, flow] of this.#flows) {
      if (flow.projectId === projectId && flow.provider === provider) this.#flows.delete(nonce)
    }
    for (const [id, confirmation] of this.#confirmations) {
      if (confirmation.flow.projectId === projectId && confirmation.flow.provider === provider) {
        this.#confirmations.delete(id)
      }
    }
    this.#currentGenerations.delete(this.generationKey(projectId, provider))
  }

  isCurrent(flow: PendingGoogleMarketingOAuthFlow): boolean {
    return this.#currentGenerations.get(this.generationKey(flow.projectId, flow.provider)) === flow.generation
  }

  finish(flow: PendingGoogleMarketingOAuthFlow): void {
    const key = this.generationKey(flow.projectId, flow.provider)
    if (this.#currentGenerations.get(key) === flow.generation) this.#currentGenerations.delete(key)
  }

  private prune(nowMs: number): void {
    for (const [nonce, flow] of this.#flows) {
      if (flow.expiresAtMs <= nowMs) {
        this.#flows.delete(nonce)
        this.finish(flow)
      }
    }
    for (const [id, confirmation] of this.#confirmations) {
      if (confirmation.expiresAtMs <= nowMs) {
        this.#confirmations.delete(id)
        this.finish(confirmation.flow)
      }
    }
  }

  private generationKey(projectId: string, provider: GoogleMarketingProvider): string {
    return `${projectId}\u0000${provider}`
  }
}

function sameOpaqueNonce(actual: string | undefined, expected: string): boolean {
  if (!actual || !/^[\w-]{43}$/.test(actual)) return false
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer)
}

function oauthBindingCookieName(nonce: string): string {
  return `${GOOGLE_MARKETING_OAUTH_COOKIE_PREFIX}${nonce}`
}

function oauthCallbackPath(opts: GoogleMarketingRoutesOptions): string {
  return `${(opts.routePrefix ?? '/api/v1').replace(/\/$/, '')}/google-marketing/callback`
}

function serializeOAuthBindingCookie(input: {
  nonce: string
  value: string | null
  secure: boolean
  opts: GoogleMarketingRoutesOptions
}): string {
  const parts = [
    `${oauthBindingCookieName(input.nonce)}=${input.value ? encodeURIComponent(input.value) : ''}`,
    `Path=${oauthCallbackPath(input.opts)}`,
    'HttpOnly',
    'SameSite=Lax',
    input.value ? `Max-Age=${Math.ceil(GOOGLE_OAUTH_STATE_MAX_AGE_MS / 1_000)}` : 'Max-Age=0',
  ]
  if (input.secure) parts.push('Secure')
  return parts.join('; ')
}

function appendSetCookie(reply: FastifyReply, value: string): void {
  const current = reply.getHeader('set-cookie')
  const cookies = Array.isArray(current)
    ? current.map(String)
    : current === undefined ? [] : [String(current)]
  reply.header('set-cookie', [...cookies, value])
}

type SnapshotCursor = { capturedAt: string; id: string }

function encodeSnapshotCursor(cursor: SnapshotCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeSnapshotCursor(value: string | undefined): SnapshotCursor | null {
  if (!value) return null
  try {
    const decoded = Buffer.from(value, 'base64url')
    if (decoded.toString('base64url') !== value) throw new Error('Non-canonical cursor')
    const parsed = z.object({ capturedAt: z.string().min(1), id: z.string().min(1) }).strict().parse(JSON.parse(decoded.toString()))
    return parsed
  } catch {
    throw validationError('Invalid Google Marketing snapshot cursor.')
  }
}

function asProjectRef(project: { id: string; name: string }): GoogleMarketingProjectRef {
  return { id: project.id, name: project.name }
}

function normalizeConversionTrackingContractWrite(
  input: ConversionTrackingContractWriteRequest,
): ConversionTrackingContractWriteRequest {
  return {
    ...input,
    runtime: {
      ...input.runtime,
      // The OpenAPI schema stays validation-only; canonical storage happens at
      // this write boundary so JSON Schema generation never encounters a Zod transform.
      productionHosts: input.runtime.productionHosts.map(host => hostOf(host)!),
    },
  }
}

function requiredCredential(
  opts: GoogleMarketingRoutesOptions,
  project: GoogleMarketingProjectRef,
  provider: GoogleMarketingProvider,
): GoogleMarketingStoredCredential {
  const credential = opts.googleMarketingCredentialStore?.get(project, provider)
  if (!credential?.accessToken) {
    throw validationError(`No ${provider === GoogleMarketingProviders['google-ads'] ? 'Google Ads' : 'Google Tag Manager'} OAuth connection is available for this project.`)
  }
  return credential
}

function requireCredentialStore(opts: GoogleMarketingRoutesOptions): GoogleMarketingCredentialStore {
  if (!opts.googleMarketingCredentialStore) {
    throw validationError('Google Marketing credential storage is not configured for this deployment.')
  }
  return opts.googleMarketingCredentialStore
}

function requireLiveReader(opts: GoogleMarketingRoutesOptions): GoogleMarketingLiveReader {
  if (!opts.googleMarketingLiveReader) {
    throw notImplemented('Google Marketing live discovery is not configured for this deployment.')
  }
  return opts.googleMarketingLiveReader
}

function parseBody<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: unknown[] } } },
  value: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw validationError(`Invalid ${label} request.`, { issues: parsed.error.issues })
  return parsed.data
}

function toGoogleAdsConnectionMetadata(row: typeof googleAdsConnections.$inferSelect): GoogleAdsConnectionMetadataDto {
  return {
    id: row.id,
    projectId: row.projectId,
    scopes: row.scopes,
    selection: {
      loginCustomerId: row.selectedLoginCustomerId,
      customerId: row.selectedCustomerId,
      // Keep the public DTO backward-compatible; private generation and
      // snapshot-ID anchors decide whether stored evidence is current.
      selectedAt: row.lastValidatedAt,
    },
    lastValidatedAt: row.lastValidatedAt,
    lastInventorySnapshotAt: row.lastInventorySnapshotAt,
    lastMetricsSnapshotAt: row.lastMetricsSnapshotAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toGtmConnectionMetadata(row: typeof gtmConnections.$inferSelect): GtmConnectionMetadataDto {
  return {
    id: row.id,
    projectId: row.projectId,
    scopes: row.scopes,
    selection: {
      accountId: row.selectedAccountId,
      containerId: row.selectedContainerId,
      workspaceId: row.selectedWorkspaceId,
      selectedAt: row.lastValidatedAt,
    },
    lastValidatedAt: row.lastValidatedAt,
    lastSnapshotAt: row.lastSnapshotAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toGoogleAdsSnapshotMetadata(row: typeof googleAdsRawSnapshots.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    connectionId: row.connectionId,
    runId: row.runId,
    kind: row.kind,
    customerId: row.customerId,
    payloadChecksum: row.payloadChecksum,
    rawPayloadSha256: row.rawPayloadSha256,
    rawPayloadBytes: row.rawPayloadBytes,
    redactedFieldCount: row.redactedFieldCount,
    capturedAt: row.capturedAt,
    createdAt: row.createdAt,
  }
}

function toGtmSnapshotMetadata(row: typeof gtmRawSnapshots.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    connectionId: row.connectionId,
    runId: row.runId,
    kind: row.kind,
    accountId: row.accountId,
    containerId: row.containerId,
    workspaceId: row.workspaceId,
    payloadChecksum: row.payloadChecksum,
    rawPayloadSha256: row.rawPayloadSha256,
    rawPayloadBytes: row.rawPayloadBytes,
    redactedFieldCount: row.redactedFieldCount,
    capturedAt: row.capturedAt,
    createdAt: row.createdAt,
  }
}

function toGoogleAdsSnapshot(row: typeof googleAdsRawSnapshots.$inferSelect): GoogleAdsRawSnapshotDto | null {
  const parsed = googleAdsRawSnapshotDtoSchema.safeParse({
    metadata: toGoogleAdsSnapshotMetadata(row),
    payload: row.payload,
  })
  return parsed.success ? parsed.data : null
}

function toGtmSnapshot(row: typeof gtmRawSnapshots.$inferSelect): GtmRawSnapshotDto | null {
  const parsed = gtmRawSnapshotDtoSchema.safeParse({
    metadata: toGtmSnapshotMetadata(row),
    payload: row.payload,
  })
  return parsed.success ? parsed.data : null
}

interface GoogleAdsCustomerSnapshotProvenance {
  connectionId: string
  customerId: string
  loginCustomerId: string | null
  lastCustomerSnapshotId: string | null
}

function selectedGoogleAdsCustomer(
  app: FastifyInstance,
  projectId: string,
  selection: GoogleAdsCustomerSnapshotProvenance,
): GoogleAdsAccessibleCustomerDto | null {
  if (!selection.lastCustomerSnapshotId) return null
  const row = app.db.select().from(googleAdsRawSnapshots)
    .where(and(
      eq(googleAdsRawSnapshots.projectId, projectId),
      eq(googleAdsRawSnapshots.id, selection.lastCustomerSnapshotId),
      eq(googleAdsRawSnapshots.connectionId, selection.connectionId),
      eq(googleAdsRawSnapshots.customerId, selection.customerId),
      eq(googleAdsRawSnapshots.kind, GoogleAdsSnapshotKinds['accessible-customers']),
    ))
    .get()
  if (!row) return null
  const snapshot = toGoogleAdsSnapshot(row)
  if (
    !snapshot
    || snapshot.payload.kind !== GoogleAdsSnapshotKinds['accessible-customers']
    || snapshot.metadata.id !== selection.lastCustomerSnapshotId
    || snapshot.metadata.connectionId !== selection.connectionId
    || snapshot.metadata.customerId !== selection.customerId
    || snapshot.payload.data.selection.customerId !== selection.customerId
    || snapshot.payload.data.selection.loginCustomerId !== selection.loginCustomerId
  ) return null
  return snapshot.payload.data.customers.find(customer => customer.customerId === selection.customerId) ?? null
}

interface GtmSnapshotProvenance {
  connectionId: string
  accountId: string
  containerId: string
  workspaceId: string | null
  lastSnapshotId: string | null
  lastSnapshotAt: string | null
}

/**
 * A graph is current only when the connection's durable snapshot anchor names
 * this exact selection. Timestamp ordering alone is not a generation boundary:
 * a workspace reselection and the prior snapshot can share one millisecond.
 */
function hasMatchingGtmGraphEvidence(
  app: FastifyInstance,
  projectId: string,
  selection: GtmSnapshotProvenance,
): boolean {
  if (!selection.lastSnapshotId || !selection.lastSnapshotAt) return false
  const conditions: SQL[] = [
    eq(gtmRawSnapshots.projectId, projectId),
    eq(gtmRawSnapshots.id, selection.lastSnapshotId),
    eq(gtmRawSnapshots.connectionId, selection.connectionId),
    eq(gtmRawSnapshots.accountId, selection.accountId),
    eq(gtmRawSnapshots.containerId, selection.containerId),
    eq(gtmRawSnapshots.capturedAt, selection.lastSnapshotAt),
  ]
  conditions.push(selection.workspaceId === null
    ? isNull(gtmRawSnapshots.workspaceId)
    : eq(gtmRawSnapshots.workspaceId, selection.workspaceId))
  const row = app.db.select().from(gtmRawSnapshots).where(and(...conditions)).get()
  if (!row) return false
  const snapshot = toGtmSnapshot(row)
  return Boolean(
    snapshot
    && snapshot.metadata.id === selection.lastSnapshotId
    && snapshot.metadata.connectionId === selection.connectionId
    && snapshot.metadata.accountId === selection.accountId
    && snapshot.metadata.containerId === selection.containerId
    && snapshot.metadata.workspaceId === selection.workspaceId
    && snapshot.metadata.capturedAt === selection.lastSnapshotAt
    && snapshot.payload.kind === GtmSnapshotKinds.container
  )
}

function googleAdsStatus(
  app: FastifyInstance,
  opts: GoogleMarketingRoutesOptions,
  project: GoogleMarketingProjectRef,
): GoogleAdsConnectionStatusDto {
  const credential = opts.googleMarketingCredentialStore?.get(project, GoogleMarketingProviders['google-ads'])
  const row = app.db.select().from(googleAdsConnections)
    .where(eq(googleAdsConnections.projectId, project.id)).get()
  if (!credential?.accessToken || !row) {
    return {
      connected: false,
      status: GoogleAdsConnectionStates['not-connected'],
      connection: null,
      selectedCustomer: null,
    }
  }

  const connection = toGoogleAdsConnectionMetadata(row)
  if (!connection.selection.customerId) {
    return {
      connected: true,
      status: GoogleAdsConnectionStates['selection-required'],
      connection,
      selectedCustomer: null,
    }
  }

  // The status DTO must never pretend that a hand-entered ID is a fully known
  // provider customer. It becomes connected only once an append-only, safe
  // discovery observation proves the selected customer shape.
  const selectedCustomer = selectedGoogleAdsCustomer(app, project.id, {
    connectionId: row.id,
    customerId: connection.selection.customerId,
    loginCustomerId: connection.selection.loginCustomerId,
    lastCustomerSnapshotId: row.lastCustomerSnapshotId,
  })
  if (!selectedCustomer) {
    return {
      connected: true,
      status: GoogleAdsConnectionStates['selection-required'],
      connection,
      selectedCustomer: null,
    }
  }
  return {
    connected: true,
    status: GoogleAdsConnectionStates.connected,
    connection,
    selectedCustomer,
  }
}

function gtmStatus(
  app: FastifyInstance,
  opts: GoogleMarketingRoutesOptions,
  project: GoogleMarketingProjectRef,
): GtmConnectionStatusDto {
  const credential = opts.googleMarketingCredentialStore?.get(project, GoogleMarketingProviders.gtm)
  const row = app.db.select().from(gtmConnections)
    .where(eq(gtmConnections.projectId, project.id)).get()
  if (!credential?.accessToken || !row) {
    return {
      connected: false,
      status: GtmConnectionStates['not-connected'],
      connection: null,
      selection: null,
    }
  }

  const connection = toGtmConnectionMetadata(row)
  const selection = connection.selection
  if (!selection.accountId || !selection.containerId) {
    return {
      connected: true,
      status: GtmConnectionStates['selection-required'],
      connection,
      selection,
    }
  }
  const evidence = hasMatchingGtmGraphEvidence(app, project.id, {
    connectionId: row.id,
    accountId: selection.accountId,
    containerId: selection.containerId,
    workspaceId: selection.workspaceId,
    lastSnapshotId: row.lastSnapshotId,
    lastSnapshotAt: row.lastSnapshotAt,
  })
  if (!evidence) {
    return {
      connected: true,
      status: GtmConnectionStates.stale,
      connection,
      selection,
    }
  }
  return {
    connected: true,
    status: GtmConnectionStates.connected,
    connection,
    selection,
  }
}

function queuedRun(projectId: string, kind: typeof RunKinds['google-ads-sync'] | typeof RunKinds['gtm-sync']) {
  const createdAt = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    projectId,
    kind,
    status: RunStatuses.queued,
    trigger: RunTriggers.manual,
    createdAt,
  }
}

function enqueueAfterCommit(
  app: FastifyInstance,
  callback: ((runId: string, projectId: string) => void | Promise<void>) | undefined,
  runId: string,
  projectId: string,
  label: string,
): void {
  if (!callback) return
  void Promise.resolve(callback(runId, projectId)).catch(() => {
    // Never return a private provider/config error from a committed sync
    // request. The host runner owns retry/failure stamping for the run.
    app.log.error({ runId, projectId, label }, 'Google Marketing sync dispatch failed after commit')
  })
}

function latestGoogleAdsSnapshot(app: FastifyInstance, projectId: string): GoogleAdsRawSnapshotDto | null {
  const connection = app.db.select().from(googleAdsConnections)
    .where(eq(googleAdsConnections.projectId, projectId)).get()
  if (!connection?.selectedCustomerId || !connection.lastInventorySnapshotId || !connection.lastInventorySnapshotAt) return null
  const conditions: SQL[] = [
    eq(googleAdsRawSnapshots.projectId, projectId),
    eq(googleAdsRawSnapshots.id, connection.lastInventorySnapshotId),
    eq(googleAdsRawSnapshots.connectionId, connection.id),
    eq(googleAdsRawSnapshots.customerId, connection.selectedCustomerId),
    eq(googleAdsRawSnapshots.kind, GoogleAdsSnapshotKinds.inventory),
    eq(googleAdsRawSnapshots.capturedAt, connection.lastInventorySnapshotAt),
  ]
  const row = app.db.select().from(googleAdsRawSnapshots).where(and(...conditions)).get()
  const snapshot = row ? toGoogleAdsSnapshot(row) : null
  if (
    !snapshot
    || snapshot.metadata.id !== connection.lastInventorySnapshotId
    || snapshot.metadata.connectionId !== connection.id
    || snapshot.metadata.customerId !== connection.selectedCustomerId
    || snapshot.metadata.capturedAt !== connection.lastInventorySnapshotAt
    || snapshot.payload.kind !== GoogleAdsSnapshotKinds.inventory
    || snapshot.payload.data.customerId !== connection.selectedCustomerId
  ) return null
  return snapshot
}

function latestGtmSnapshot(app: FastifyInstance, projectId: string): GtmRawSnapshotDto | null {
  const connection = app.db.select().from(gtmConnections)
    .where(eq(gtmConnections.projectId, projectId)).get()
  if (!connection?.selectedAccountId || !connection.selectedContainerId || !connection.lastSnapshotId || !connection.lastSnapshotAt) return null
  const conditions: SQL[] = [
    eq(gtmRawSnapshots.projectId, projectId),
    eq(gtmRawSnapshots.id, connection.lastSnapshotId),
    eq(gtmRawSnapshots.connectionId, connection.id),
    eq(gtmRawSnapshots.accountId, connection.selectedAccountId),
    eq(gtmRawSnapshots.containerId, connection.selectedContainerId),
    eq(gtmRawSnapshots.capturedAt, connection.lastSnapshotAt),
    // The sync runtime persists one sanitized `container` envelope holding
    // both live and optional draft graphs. A standalone `live` row is a
    // contract type for future importers, not the normal sync artifact.
    eq(gtmRawSnapshots.kind, GtmSnapshotKinds.container),
  ]
  conditions.push(connection.selectedWorkspaceId === null
    ? isNull(gtmRawSnapshots.workspaceId)
    : eq(gtmRawSnapshots.workspaceId, connection.selectedWorkspaceId))
  const row = app.db.select().from(gtmRawSnapshots).where(and(...conditions)).get()
  const snapshot = row ? toGtmSnapshot(row) : null
  if (
    !snapshot
    || snapshot.metadata.id !== connection.lastSnapshotId
    || snapshot.metadata.connectionId !== connection.id
    || snapshot.metadata.accountId !== connection.selectedAccountId
    || snapshot.metadata.containerId !== connection.selectedContainerId
    || snapshot.metadata.workspaceId !== connection.selectedWorkspaceId
    || snapshot.metadata.capturedAt !== connection.lastSnapshotAt
    || snapshot.payload.kind !== GtmSnapshotKinds.container
  ) return null
  return snapshot
}

// --- Google Ads stored performance -------------------------------------------

const googleAdsPerformanceQuerySchema = z.object({
  window: googleAdsMetricsWindowSchema.optional(),
}).strict()

const GOOGLE_ADS_PERFORMANCE_WINDOW_DAYS: Record<GoogleAdsMetricsWindow, number> = {
  '7d': 7,
  '14d': 14,
  '30d': 30,
}

const GOOGLE_ADS_PERFORMANCE_DEFAULT_WINDOW: GoogleAdsMetricsWindow = '14d'

/**
 * Running sums for one scope. Deliberately separate from the DTO so every ratio
 * is derived exactly once, from the finished sums, instead of being averaged
 * out of per-day ratios.
 */
interface GoogleAdsMetricSums {
  impressions: number
  clicks: number
  costMicros: number
  conversions: number
  /** Null until a row in scope reports a value: unreported is not a measured zero. */
  conversionValueMicros: number | null
}

function emptyGoogleAdsMetricSums(): GoogleAdsMetricSums {
  return { impressions: 0, clicks: 0, costMicros: 0, conversions: 0, conversionValueMicros: null }
}

function addGoogleAdsMetricRow(sums: GoogleAdsMetricSums, row: GoogleAdsCampaignMetricDto): void {
  sums.impressions += row.impressions
  sums.clicks += row.clicks
  sums.costMicros += row.costMicros
  sums.conversions += row.conversions
  if (row.conversionValueMicros !== null) {
    sums.conversionValueMicros = (sums.conversionValueMicros ?? 0) + row.conversionValueMicros
  }
}

/**
 * Money stays INTEGER MICROS and every ratio stays a RAW float: rounding here
 * would be a display decision baked into the transport, and a renderer can no
 * longer recover the measured value from a rounded one.
 *
 * A ratio with a zero denominator is null, never 0. An undefined 0/0 is not the
 * same fact as a measured zero, and a chart that plots it as 0 invents a point.
 */
function googleAdsMetricTotals(sums: GoogleAdsMetricSums): GoogleAdsMetricTotals {
  return {
    impressions: sums.impressions,
    clicks: sums.clicks,
    costMicros: sums.costMicros,
    conversions: sums.conversions,
    conversionValueMicros: sums.conversionValueMicros,
    ctr: sums.impressions === 0 ? null : sums.clicks / sums.impressions,
    cpcMicros: sums.clicks === 0 ? null : Math.round(sums.costMicros / sums.clicks),
    conversionRate: sums.clicks === 0 ? null : sums.conversions / sums.clicks,
    costPerConversionMicros: sums.conversions === 0 ? null : Math.round(sums.costMicros / sums.conversions),
  }
}


/** The stored metrics snapshot plus the account labels the DTO reports beside it. */
interface GoogleAdsMetricsEvidence {
  snapshotId: string
  capturedAt: string
  customerId: string
  currencyCode: string | null
  timeZone: string | null
  metrics: GoogleAdsCampaignMetricsResponse
}

/**
 * The newest stored `campaign-metrics` snapshot for the connection's CURRENT
 * selection generation. Anchored on the connection's exact snapshot id, the way
 * the inventory read is: timestamp ordering alone would happily return evidence
 * captured for a customer the operator has since replaced.
 *
 * This is a stored read. It must never reach the Google Ads API — a live read
 * spends the advertiser's budget and is gated behind live-read authority that a
 * plain dashboard reader does not hold.
 */
function latestGoogleAdsMetricsEvidence(app: FastifyInstance, projectId: string): GoogleAdsMetricsEvidence | null {
  const connection = app.db.select().from(googleAdsConnections)
    .where(eq(googleAdsConnections.projectId, projectId)).get()
  if (!connection?.selectedCustomerId || !connection.lastMetricsSnapshotId || !connection.lastMetricsSnapshotAt) return null
  const conditions: SQL[] = [
    eq(googleAdsRawSnapshots.projectId, projectId),
    eq(googleAdsRawSnapshots.id, connection.lastMetricsSnapshotId),
    eq(googleAdsRawSnapshots.connectionId, connection.id),
    eq(googleAdsRawSnapshots.customerId, connection.selectedCustomerId),
    eq(googleAdsRawSnapshots.kind, GoogleAdsSnapshotKinds['campaign-metrics']),
    eq(googleAdsRawSnapshots.capturedAt, connection.lastMetricsSnapshotAt),
  ]
  const row = app.db.select().from(googleAdsRawSnapshots).where(and(...conditions)).get()
  const snapshot = row ? toGoogleAdsSnapshot(row) : null
  if (
    !snapshot
    || snapshot.metadata.id !== connection.lastMetricsSnapshotId
    || snapshot.metadata.connectionId !== connection.id
    || snapshot.metadata.customerId !== connection.selectedCustomerId
    || snapshot.metadata.capturedAt !== connection.lastMetricsSnapshotAt
    || snapshot.payload.kind !== GoogleAdsSnapshotKinds['campaign-metrics']
  ) return null
  return {
    snapshotId: snapshot.metadata.id,
    capturedAt: snapshot.metadata.capturedAt,
    customerId: connection.selectedCustomerId,
    currencyCode: connection.selectedCustomerCurrencyCode,
    timeZone: connection.selectedCustomerTimeZone,
    metrics: snapshot.payload.data,
  }
}

interface GoogleAdsClosedPeriod {
  startDate: string
  endDate: string
  days: number
}

/**
 * The window's closed-day bounds, clamped to what the snapshot actually covers.
 *
 * Clamping rather than extending is the point: a day before the snapshot's own
 * query range was never measured, and densifying it to zero would report an
 * outage the advertiser never had.
 */
function googleAdsClosedWindow(
  coverageStart: string,
  asOfDate: string,
  windowDays: number,
): GoogleAdsClosedPeriod | null {
  const closedDays = inclusiveDayCount(coverageStart, asOfDate)
  if (closedDays === null || closedDays < 1) return null
  const days = Math.min(windowDays, closedDays)
  return { startDate: shiftIsoCalendarDate(asOfDate, -(days - 1)), endDate: asOfDate, days }
}

function googleAdsRowsInPeriod(
  rows: readonly GoogleAdsCampaignMetricDto[],
  period: GoogleAdsClosedPeriod,
): GoogleAdsCampaignMetricDto[] {
  return rows.filter(row => row.date >= period.startDate && row.date <= period.endDate)
}

function googleAdsSumOf(rows: readonly GoogleAdsCampaignMetricDto[]): GoogleAdsMetricSums {
  const sums = emptyGoogleAdsMetricSums()
  for (const row of rows) addGoogleAdsMetricRow(sums, row)
  return sums
}

/**
 * One point per CALENDAR day in the period, not one per row the provider
 * returned. Google Ads omits a day with no delivery, so a series built from
 * "days that exist" silently compresses the x-axis; `origin` records which days
 * were densified. A filled day carries measured zeros, because on this provider
 * a missing day means zero delivery, not unknown delivery.
 */
function googleAdsDailySeries(
  rows: readonly GoogleAdsCampaignMetricDto[],
  period: GoogleAdsClosedPeriod,
): GoogleAdsMetricsDailyPoint[] {
  const byDate = new Map<string, GoogleAdsMetricSums>()
  for (const row of rows) {
    const sums = byDate.get(row.date) ?? emptyGoogleAdsMetricSums()
    addGoogleAdsMetricRow(sums, row)
    byDate.set(row.date, sums)
  }
  return calendarDateRange(period.startDate, period.endDate).map((date): GoogleAdsMetricsDailyPoint => {
    const sums = byDate.get(date)
    if (!sums) {
      return { date, origin: 'filled', impressions: 0, clicks: 0, costMicros: 0, conversions: 0, ctr: null }
    }
    return {
      date,
      origin: 'provider',
      impressions: sums.impressions,
      clicks: sums.clicks,
      costMicros: sums.costMicros,
      conversions: sums.conversions,
      ctr: sums.impressions === 0 ? null : sums.clicks / sums.impressions,
    }
  })
}

/**
 * Per-campaign totals for the window, labelled from the stored inventory.
 *
 * A campaign the metrics snapshot names but the inventory snapshot does not is
 * still returned, with a null name and `unknown` status. Dropping it would
 * silently remove real spend from a per-campaign table whose column total is
 * expected to reconcile with the window total.
 */
function googleAdsCampaignPerformance(
  rows: readonly GoogleAdsCampaignMetricDto[],
  inventory: GoogleAdsInventoryDto | null,
): GoogleAdsCampaignPerformance[] {
  const labels = new Map((inventory?.campaigns ?? []).map(campaign => [campaign.id, campaign]))
  const byCampaign = new Map<string, GoogleAdsMetricSums>()
  for (const row of rows) {
    const sums = byCampaign.get(row.campaignId) ?? emptyGoogleAdsMetricSums()
    addGoogleAdsMetricRow(sums, row)
    byCampaign.set(row.campaignId, sums)
  }
  return [...byCampaign.entries()]
    // Spend descending: the biggest spender is the row an operator looks for
    // first, and campaignId order is meaningless to a human. Sorted here rather
    // than in the component so the CLI, which iterates DTO order, matches the
    // dashboard. campaignId breaks ties so the order stays stable across reads.
    .sort(([leftId, leftSums], [rightId, rightSums]) =>
      rightSums.costMicros - leftSums.costMicros || leftId.localeCompare(rightId))
    .map(([campaignId, sums]): GoogleAdsCampaignPerformance => {
      const label = labels.get(campaignId)
      return {
        campaignId,
        name: label?.name ?? null,
        status: label?.status ?? GoogleAdsCampaignStatuses.unknown,
        totals: googleAdsMetricTotals(sums),
      }
    })
}

function googleAdsChangeRatio(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null) return null
  return relativeChangeRatio(current, prior)
}

/**
 * Prior-equal-period comparison, or null when the stored snapshot cannot cover
 * 2N closed days.
 *
 * A snapshot holds GOOGLE_ADS_CAMPAIGN_METRICS_MAX_DAYS (31) days of which at
 * most 30 are closed, so a 30d window can never have a prior period. Reporting
 * a truncated prior period as if it were equal-length would manufacture a
 * decline out of the missing days.
 */
function googleAdsComparison(
  metrics: GoogleAdsCampaignMetricsResponse,
  current: GoogleAdsClosedPeriod,
  currentTotals: GoogleAdsMetricTotals,
  windowDays: number,
): GoogleAdsPerformanceComparison | null {
  if (current.days !== windowDays) return null
  const priorEnd = shiftIsoCalendarDate(current.startDate, -1)
  const priorStart = shiftIsoCalendarDate(priorEnd, -(windowDays - 1))
  if (priorStart < metrics.query.startDate) return null
  const prior: GoogleAdsClosedPeriod = { startDate: priorStart, endDate: priorEnd, days: windowDays }
  const priorTotals = googleAdsMetricTotals(googleAdsSumOf(googleAdsRowsInPeriod(metrics.rows, prior)))
  return {
    days: windowDays,
    prior: { startDate: priorStart, endDate: priorEnd, days: windowDays, totals: priorTotals },
    change: {
      impressions: googleAdsChangeRatio(currentTotals.impressions, priorTotals.impressions),
      clicks: googleAdsChangeRatio(currentTotals.clicks, priorTotals.clicks),
      costMicros: googleAdsChangeRatio(currentTotals.costMicros, priorTotals.costMicros),
      conversions: googleAdsChangeRatio(currentTotals.conversions, priorTotals.conversions),
      ctr: googleAdsChangeRatio(currentTotals.ctr, priorTotals.ctr),
      conversionRate: googleAdsChangeRatio(currentTotals.conversionRate, priorTotals.conversionRate),
    },
  }
}

/**
 * The documented empty payload for a project with no usable stored metrics.
 *
 * Deliberately a 200, not a 404: "this project has no Google Ads evidence yet"
 * is a real, renderable answer, and a 404 would make a dashboard show an error
 * for the ordinary pre-sync state. The window is still named so the caller can
 * label the empty chart; with no payload to read a date from, the request clock
 * is the only source available, and no measured value depends on it.
 */
function emptyGoogleAdsPerformance(
  window: GoogleAdsMetricsWindow,
  windowDays: number,
  reason: 'insufficient-history' | 'no-snapshot',
  endDate: string,
): GoogleAdsPerformanceDto {
  return {
    window,
    startDate: shiftIsoCalendarDate(endDate, -(windowDays - 1)),
    endDate,
    days: windowDays,
    totals: googleAdsMetricTotals(emptyGoogleAdsMetricSums()),
    daily: [],
    campaigns: [],
    comparison: null,
    comparisonUnavailableReason: reason,
    source: null,
  }
}

/**
 * Computed Google Ads performance over CLOSED days only.
 *
 * The capture day is excluded from every window. Snapshots are taken mid-day, so
 * that day is partial, and including it draws a fabricated cliff on the right
 * edge of every chart. The cutoff comes from the payload's own `fetchedAt`, never
 * from a server clock: a stale snapshot must keep reporting the window it
 * actually measured instead of sliding forward and inventing empty days.
 */
function googleAdsPerformance(
  app: FastifyInstance,
  projectId: string,
  window: GoogleAdsMetricsWindow,
): GoogleAdsPerformanceDto {
  const windowDays = GOOGLE_ADS_PERFORMANCE_WINDOW_DAYS[window]
  const evidence = latestGoogleAdsMetricsEvidence(app, projectId)
  if (!evidence) {
    // Today is still open everywhere, so an empty window is still labelled as
    // ending on a closed day. Nothing measured depends on this date.
    const today = formatIsoDate(new Date().toISOString())
    return emptyGoogleAdsPerformance(window, windowDays, 'no-snapshot', shiftIsoCalendarDate(today, -1))
  }

  const { metrics } = evidence
  // Google Ads buckets metrics by the ACCOUNT's calendar day, so the capture
  // date must be read in the account's zone. A UTC-derived date is a whole day
  // ahead or behind for part of every day in a non-UTC account.
  const captureDate = formatIsoDateInTimeZone(metrics.fetchedAt, evidence.timeZone ?? 'UTC')
  const openDate = captureDate >= metrics.query.startDate && captureDate <= metrics.query.endDate
    ? captureDate
    : null
  const asOfDate = captureDate <= metrics.query.endDate
    ? shiftIsoCalendarDate(captureDate, -1)
    : metrics.query.endDate
  const current = googleAdsClosedWindow(metrics.query.startDate, asOfDate, windowDays)
  if (!current) {
    // A snapshot whose whole queried range is the still-open capture day holds
    // no closed evidence at all. There is nothing to report and nothing to
    // compare, so say so rather than publish the partial day.
    return emptyGoogleAdsPerformance(window, windowDays, 'insufficient-history', asOfDate)
  }

  const windowRows = googleAdsRowsInPeriod(metrics.rows, current)
  const totals = googleAdsMetricTotals(googleAdsSumOf(windowRows))
  const inventorySnapshot = latestGoogleAdsSnapshot(app, projectId)
  const inventory = inventorySnapshot?.payload.kind === GoogleAdsSnapshotKinds.inventory
    ? inventorySnapshot.payload.data
    : null
  const comparison = googleAdsComparison(metrics, current, totals, windowDays)

  return {
    window,
    startDate: current.startDate,
    endDate: current.endDate,
    days: current.days,
    totals,
    daily: googleAdsDailySeries(windowRows, current),
    campaigns: googleAdsCampaignPerformance(windowRows, inventory),
    comparison,
    comparisonUnavailableReason: comparison ? null : 'insufficient-history',
    source: {
      snapshotId: evidence.snapshotId,
      capturedAt: evidence.capturedAt,
      customerId: evidence.customerId,
      currencyCode: evidence.currencyCode,
      timeZone: evidence.timeZone,
      asOfDate,
      openDate,
      truncated: metrics.truncated,
      campaignsQueried: metrics.query.campaignIds.length,
      campaignsInInventory: inventory?.campaigns.length ?? 0,
    },
  }
}

function toConversionTrackingContract(row: typeof conversionTrackingContracts.$inferSelect): ConversionTrackingContract {
  const parsed = conversionTrackingContractSchema.safeParse({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    eventName: row.eventName,
    googleAds: row.googleAds,
    gtm: row.gtm,
    runtime: row.runtime,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
  if (!parsed.success) throw providerError('Stored conversion tracking contract is invalid.')
  return parsed.data
}

function resolveRedirectUri(
  request: FastifyRequest,
  publicUrl: string | undefined,
  opts: GoogleMarketingRoutesOptions,
): string {
  const configured = publicUrl ?? opts.publicUrl
  let origin: string
  let callbackPath: string
  if (configured) {
    origin = configured.replace(/\/$/, '')
    // A configured public URL is the deployment base, which can already
    // include a mount path. OAuth callbacks remain under the public API path.
    callbackPath = '/api/v1/google-marketing/callback'
  } else {
    const protoHeader = request.headers['x-forwarded-proto']
    const proto = (Array.isArray(protoHeader) ? protoHeader[0] : protoHeader)?.split(',')[0]?.trim()
    const safeProto = proto === 'https' || proto === 'http' ? proto : 'http'
    const host = request.headers.host
    origin = `${safeProto}://${host ?? 'localhost:4100'}`
    callbackPath = `${(opts.routePrefix ?? '/api/v1').replace(/\/$/, '')}/google-marketing/callback`
  }
  const redirectUri = `${origin}${callbackPath}`
  try {
    const parsed = new URL(redirectUri)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Unsupported redirect protocol')
  } catch {
    throw validationError('Invalid Google Marketing OAuth public URL.')
  }
  return redirectUri
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]!))
}

function oauthHtml(title: string, message: string): string {
  return `<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><p style="color:#888">You can close this window.</p></body></html>`
}

function oauthConfirmationPath(opts: GoogleMarketingRoutesOptions, confirmationId: string): string {
  return `${oauthCallbackPath(opts)}/confirm/${encodeURIComponent(confirmationId)}`
}

function oauthConfirmationHtml(input: {
  provider: GoogleMarketingProvider
  projectName: string
  confirmationId: string
  opts: GoogleMarketingRoutesOptions
}): string {
  const label = input.provider === GoogleMarketingProviders['google-ads'] ? 'Google Ads' : 'Google Tag Manager'
  const action = oauthConfirmationPath(input.opts, input.confirmationId)
  return `<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Confirm connection</h2><p>Connect ${escapeHtml(label)} to ${escapeHtml(input.projectName)}?</p><form method="post" action="${escapeHtml(action)}"><button type="submit">Confirm connection</button></form><p style="color:#888">This must be confirmed in the same signed-in browser that started the connection.</p></body></html>`
}

/**
 * First-class, read-only Google Ads + GTM API surface. Provider adapters and
 * secrets are host-injected; this plugin stores only typed selection metadata
 * and sanitized, append-only evidence rows.
 */
/**
 * Turn a failed provider call into an error an operator can act on.
 *
 * These calls fail for a small set of SETUP reasons that look identical from the
 * dashboard: the API is not enabled on the Cloud project that owns the OAuth
 * client, the developer token is not approved, or the OAuth user cannot see the
 * account. Google says which of those it is, precisely. A bare `catch` used to
 * discard that and answer "discovery failed", which left the operator with no
 * next step: diagnosing one real case needed a `gcloud services list` against
 * the Cloud project, because nothing in the product said the API was disabled.
 *
 * The provider error is logged in full, and a short summary reaches the caller.
 * These routes already require an admin session, and Google's messages carry no
 * credentials, so the summary discloses nothing the operator cannot already see.
 */
function discoveryFailure(app: FastifyInstance, what: string, err: unknown): AppError {
  app.log.error({ err, discovery: what }, `${what} failed`)
  const detail = describeError(err).trim()
  return providerError(detail ? `${what} failed: ${detail}` : `${what} failed.`)
}

export async function googleMarketingRoutes(app: FastifyInstance, opts: GoogleMarketingRoutesOptions) {
  // The OAuth confirmation page this module serves is plain server-rendered HTML
  // whose only control is a `<form method="post">`. Browsers submit that as
  // `application/x-www-form-urlencoded`, and Fastify parses bodies before the
  // handler runs, so without a parser for that type the submit answered
  // `415 Unsupported Media Type` and the request never reached the route. That
  // made the final step of every Google Ads and GTM connection impossible to
  // complete: the server's own button posted to an endpoint the server refused.
  //
  // Registered HERE rather than on the root instance on purpose. Fastify scopes
  // content-type parsers to the encapsulation context, and this module is added
  // with `api.register(googleMarketingRoutes, ...)`, so the rest of the API keeps
  // rejecting form bodies and stays JSON-only.
  //
  // The body is deliberately discarded. The confirmation id travels in the path
  // and the browser binding is the HttpOnly cookie, so the form carries no
  // fields worth reading, and accepting an empty object keeps a submitted field
  // from ever reaching the handler as input.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, _body, done) => { done(null, {}) },
  )

  const pendingOAuthFlows = new PendingGoogleMarketingOAuthFlows()
  let stateSecret: string | null = null
  if (opts.googleStateSecret !== undefined) {
    if (opts.googleStateSecret === '' || opts.googleStateSecret === 'insecure-default-secret') {
      throw new Error('googleStateSecret must be a non-empty, non-default secret to enable Google Marketing OAuth.')
    }
    stateSecret = opts.googleStateSecret
  } else {
    app.log.warn('googleStateSecret is not configured — Google Marketing OAuth connect/callback routes will not be registered.')
  }

  const requireLiveRead = (request: FastifyRequest) => {
    requireAdminSession(request)
    requireScope(request, GOOGLE_MARKETING_LIVE_READ_SCOPE)
  }
  const requireWrite = (request: FastifyRequest) => requireScope(request, GOOGLE_MARKETING_WRITE_SCOPE)

  // --- Stored connection status -------------------------------------------------

  app.get<{ Params: { name: string } }>('/projects/:name/google-ads/status', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    return googleAdsStatus(app, opts, asProjectRef(project))
  })

  app.get<{ Params: { name: string } }>('/projects/:name/gtm/status', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    return gtmStatus(app, opts, asProjectRef(project))
  })

  // --- OAuth --------------------------------------------------------------------

  if (stateSecret) {
    const registerOAuthConnect = (path: string, provider: GoogleMarketingProvider) => {
      app.post<{ Params: { name: string }; Body: unknown }>(path, connectionRoute(app, () => marketingConnection(provider), async (request, reply, attempt) => {
        requireWrite(request)
        // OAuth code delivery is browser-bound. An Authorization-header/CLI
        // start cannot receive the HttpOnly callback cookie, so refuse it
        // rather than minting an authorization URL that can never be safely
        // confirmed. `skipAuth` test harnesses have no principal and remain
        // intentionally supported for route-level tests.
        if (request.principal && !request.principal.viaCookie) {
          throw forbidden('Google Marketing OAuth must be started from a signed-in browser.')
        }
        const body = parseBody(googleMarketingOAuthConnectRequestSchema, request.body, 'Google Marketing OAuth connect')
        if (body.provider !== provider) {
          throw validationError(`This endpoint only starts the ${provider} OAuth flow.`)
        }
        if (provider !== GoogleMarketingProviders['google-ads'] && body.developerToken !== undefined) {
          throw validationError('A Google Ads developer token cannot be supplied for a Google Tag Manager OAuth flow.')
        }
        const project = resolveProject(app.db, request.params.name)
        const store = requireCredentialStore(opts)
        const connectionAction = telemetryRead(() => store.get(asProjectRef(project), provider), undefined) ? 'reauth' : 'connect'
        attempt.update({ action: connectionAction })
        const adapter = opts.googleMarketingOAuth
        if (!adapter) throw notImplemented('Google Marketing OAuth is not configured for this deployment.')
        const scopes = opts.googleMarketingOAuthScopes?.[provider]
        if (!scopes || scopes.length === 0) {
          throw validationError(`OAuth scopes for ${provider} are not configured for this deployment.`)
        }

        // A developer token changes an install-global secret, not a
        // project-local connection. A project-scoped integration key may
        // connect using a preconfigured token but can never set or replace it.
        if (provider === GoogleMarketingProviders['google-ads'] && body.developerToken !== undefined) {
          requireBroadInstanceKey(request)
        }
        const suppliedDeveloperToken = provider === GoogleMarketingProviders['google-ads']
          ? body.developerToken
          : undefined
        if (
          provider === GoogleMarketingProviders['google-ads']
          && !suppliedDeveloperToken
          && !store.hasGoogleAdsDeveloperToken?.()
        ) {
          throw validationError('A Google Ads developer token is required before connecting this project.')
        }

        const redirectUri = resolveRedirectUri(request, body.publicUrl, opts)
        const nowMs = Date.now()
        const nonce = crypto.randomBytes(32).toString('base64url')
        const browserNonce = crypto.randomBytes(32).toString('base64url')
        const state = buildSignedGoogleOAuthState({
          projectId: project.id,
          projectName: project.name,
          provider,
          redirectUri,
          nonce,
        }, stateSecret, nowMs)
        let authorizationUrl: string
        try {
          authorizationUrl = await adapter.authorizationUrl({ provider, redirectUri, state, scopes })
          new URL(authorizationUrl)
        } catch (err) {
          throw discoveryFailure(app, 'Google Marketing OAuth start', err)
        }

        // Do not persist a supplied developer token until the signed-in browser
        // confirms the exchanged code. The only copy before then is this bounded,
        // process-local flow entry; the signed URL contains only a nonce and
        // non-secret binding metadata.
        // A newer start replaces an unfinished start for this exact project
        // and provider, so an old callback cannot recreate a disconnected or
        // superseded connection.
        pendingOAuthFlows.create({
          nonce,
          generation: crypto.randomUUID(),
          projectId: project.id,
          projectName: project.name,
          provider,
          redirectUri,
          expiresAtMs: nowMs + GOOGLE_OAUTH_STATE_MAX_AGE_MS,
          initiator: oauthInitiator(request),
          browserNonce,
          connectionAction,
          ...(suppliedDeveloperToken ? { developerToken: suppliedDeveloperToken } : {}),
        }, nowMs)

        // The state appears in Google's authorization URL by protocol design;
        // this second, HttpOnly browser secret does not. A callback must prove
        // both values, binding the otherwise public callback to the browser
        // that began the flow. HTTP local installs cannot retain Secure cookies;
        // deployed HTTPS origins always receive one.
        appendSetCookie(reply, serializeOAuthBindingCookie({
          nonce,
          value: browserNonce,
          secure: new URL(redirectUri).protocol === 'https:',
          opts,
        }))

        writeAuditLog(app.db, auditFromRequest(request, {
          projectId: project.id,
          actor: 'api',
          action: 'google-marketing.oauth-started',
          entityType: 'google-marketing-connection',
          entityId: provider,
          diff: { provider },
        }))
        attempt.started()
        return {
          provider,
          authorizationUrl,
          redirectUri,
          expiresAt: null,
        }
      }))
    }

    registerOAuthConnect('/projects/:name/google-ads/oauth/connect', GoogleMarketingProviders['google-ads'])
    registerOAuthConnect('/projects/:name/gtm/oauth/connect', GoogleMarketingProviders.gtm)

    app.get<{
      Querystring: { code?: string; state?: string; error?: string }
    }>('/google-marketing/callback', connectionRoute(app, (request) => {
      // An invalid or expired state still names its provider, read unverified for telemetry only.
      const verified = oauthStateSchema.safeParse(verifySignedGoogleOAuthState(request.query.state ?? '', stateSecret))
      return marketingConnection(verified.success ? verified.data.provider : unverifiedOAuthStateField(request.query.state, 'provider'))
    }, async (request, reply, attempt) => {
      if (!request.query.state) {
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'Missing OAuth state.'))
      }
      const state = verifySignedGoogleOAuthState(request.query.state, stateSecret)
      const parsedState = oauthStateSchema.safeParse(state)
      if (!parsedState.success) {
        attempt.failed(undefined, 'OAUTH_STATE_INVALID')
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'Invalid, expired, or tampered OAuth state.'))
      }
      // This is deliberately before code exchange and credential reads. A
      // replay, a provider-denied callback, or a failed code exchange burns
      // the capability, so it cannot later be retried with another account.
      const browserNonce = parseCookieHeader(request.headers.cookie)[oauthBindingCookieName(parsedState.data.nonce)]
      const pending = pendingOAuthFlows.consume(parsedState.data, browserNonce)
      if (!pending) {
        attempt.failed(undefined, 'OAUTH_STATE_INVALID')
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'OAuth state is unknown, expired, already used, or was opened in a different browser.'))
      }
      appendSetCookie(reply, serializeOAuthBindingCookie({
        nonce: parsedState.data.nonce,
        value: null,
        secure: new URL(parsedState.data.redirectUri).protocol === 'https:',
        opts,
      }))
      attempt.update({ action: pending.connectionAction ?? 'connect' })
      if (request.query.error) {
        pendingOAuthFlows.finish(pending)
        if (request.query.error === 'access_denied') attempt.cancelled('OAUTH_CANCELLED')
        else attempt.failed(undefined, 'AUTH_DENIED')
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'Google did not approve this authorization request.'))
      }
      if (!request.query.code) {
        pendingOAuthFlows.finish(pending)
        attempt.failed(undefined, 'VALIDATION')
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'Missing OAuth code.'))
      }
      const { projectId, projectName, provider, redirectUri } = parsedState.data
      const project = app.db.select().from(projects)
        .where(eq(projects.id, projectId)).get()
      if (!project || project.name !== projectName) {
        pendingOAuthFlows.finish(pending)
        attempt.failed(undefined, project ? 'OAUTH_STATE_INVALID' : 'NOT_FOUND')
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'Project ownership changed. Restart the OAuth flow.'))
      }
      const store = opts.googleMarketingCredentialStore
      const adapter = opts.googleMarketingOAuth
      if (!store || !adapter) {
        pendingOAuthFlows.finish(pending)
        attempt.failed(undefined, 'UNSUPPORTED')
        return reply.status(500).type('text/html').send(oauthHtml('Authorization failed', 'Google Marketing OAuth is not configured.'))
      }
      let tokens: GoogleMarketingOAuthToken
      try {
        tokens = await adapter.exchangeCode({ provider, code: request.query.code, redirectUri })
      } catch (err) {
        pendingOAuthFlows.finish(pending)
        attempt.failed(err)
        return reply.status(502).type('text/html').send(oauthHtml('Authorization failed', 'Google rejected the OAuth code. Restart the connection flow.'))
      }

      // A disconnect or newer start can happen while Google's token endpoint
      // is awaited. Do not let that old callback resurrect credentials.
      if (!pendingOAuthFlows.isCurrent(pending)) {
        pendingOAuthFlows.finish(pending)
        attempt.failed(undefined, 'OAUTH_STATE_INVALID')
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'This OAuth flow was replaced or disconnected. Restart the connection flow.'))
      }
      // Reconnects must prove they received a token for the account just
      // authorized. Reusing the prior refresh token would silently switch the
      // connection back to that old principal when the access token expires.
      if (typeof tokens.refreshToken !== 'string' || tokens.refreshToken.trim().length === 0) {
        pendingOAuthFlows.finish(pending)
        attempt.failed(undefined, 'PERMISSION_MISSING')
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'Google did not provide offline access. Restart the connection flow and approve access.'))
      }
      let confirmationId: string | null
      try {
        confirmationId = pendingOAuthFlows.createConfirmation(pending, tokens)
      } catch {
        pendingOAuthFlows.finish(pending)
        attempt.failed(undefined, 'RATE_LIMITED')
        return reply.status(503).type('text/html').send(oauthHtml('Authorization failed', 'Too many pending OAuth confirmations. Restart the connection flow.'))
      }
      if (!confirmationId) {
        pendingOAuthFlows.finish(pending)
        attempt.failed(undefined, 'OAUTH_STATE_INVALID')
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'This OAuth flow was replaced or disconnected. Restart the connection flow.'))
      }
      // The browser's explicit confirmation completes the connection and reports it.
      attempt.deferred()
      return reply.type('text/html').send(oauthConfirmationHtml({
        provider,
        projectName: project.name,
        confirmationId,
        opts,
      }))
    }))

    app.post<{ Params: { confirmationId: string } }>('/google-marketing/callback/confirm/:confirmationId', async (request, reply) => {
      // The public callback must not persist merely because Google returned a
      // code. This second, same-origin POST is the browser user's explicit
      // consent and binds the exchanged token to the initiator's identity.
      if (request.principal && !request.principal.viaCookie) {
        throw forbidden('Google Marketing OAuth confirmation requires the browser that started the connection.')
      }
      if (request.principal?.viaCookie) assertSameOriginWrite(request)
      requireAdminSession(request)
      requireWrite(request)

      const confirmation = pendingOAuthFlows.consumeConfirmation(
        request.params.confirmationId,
        oauthInitiator(request),
      )
      if (!confirmation) {
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'This OAuth confirmation is unknown, expired, already used, or belongs to another browser session.'))
      }
      const { flow, tokens } = confirmation
      const attempt = startConnectionAttempt(app, marketingConnection(flow.provider, flow.connectionAction))
      if (!pendingOAuthFlows.isCurrent(flow)) {
        pendingOAuthFlows.finish(flow)
        attempt.failed(undefined, 'OAUTH_STATE_INVALID')
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'This OAuth flow was replaced or disconnected. Restart the connection flow.'))
      }

      const project = app.db.select().from(projects).where(eq(projects.id, flow.projectId)).get()
      if (!project || project.name !== flow.projectName) {
        pendingOAuthFlows.finish(flow)
        attempt.failed(undefined, project ? 'OAUTH_STATE_INVALID' : 'NOT_FOUND')
        return reply.status(400).type('text/html').send(oauthHtml('Authorization failed', 'Project ownership changed. Restart the OAuth flow.'))
      }
      const store = opts.googleMarketingCredentialStore
      if (!store) {
        pendingOAuthFlows.finish(flow)
        attempt.failed(undefined, 'UNSUPPORTED')
        return reply.status(500).type('text/html').send(oauthHtml('Authorization failed', 'Google Marketing OAuth is not configured.'))
      }

      const projectRef = asProjectRef(project)
      const existing = store.get(projectRef, flow.provider)
      const now = new Date().toISOString()
      let rollbackCredential: (() => void) | undefined
      try {
        // This is all synchronous after the generation check, so disconnect or
        // a newer start cannot interleave and recreate a stale connection.
        const credentialCompensator = store.upsert(projectRef, flow.provider, {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt ?? existing?.expiresAt ?? null,
          scopes: tokens.scopes,
          ...(flow.provider === GoogleMarketingProviders['google-ads']
            ? { developerToken: flow.developerToken ?? null }
            : {}),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        })
        rollbackCredential = typeof credentialCompensator === 'function' ? credentialCompensator : undefined

        app.db.transaction((tx) => {
          if (flow.provider === GoogleMarketingProviders['google-ads']) {
            const row = tx.select().from(googleAdsConnections)
              .where(eq(googleAdsConnections.projectId, project.id)).get()
            if (row) {
              // A reconnect can authenticate a different Google principal.
              // Force a fresh selection/evidence generation before anything
              // from the prior credential can be treated as current.
              tx.update(googleAdsConnections).set({
                selectedLoginCustomerId: null, selectedCustomerId: null, selectedCustomerName: null,
                selectedCustomerCurrencyCode: null, selectedCustomerTimeZone: null, selectedCustomerStatus: null,
                selectionGeneration: sql`${googleAdsConnections.selectionGeneration} + 1`,
                scopes: tokens.scopes, lastValidatedAt: now, lastCustomerSnapshotId: null,
                lastInventorySnapshotAt: null, lastInventorySnapshotId: null,
                lastMetricsSnapshotAt: null, lastMetricsSnapshotId: null, updatedAt: now,
              })
                .where(eq(googleAdsConnections.id, row.id)).run()
            } else {
              tx.insert(googleAdsConnections).values({
                id: crypto.randomUUID(), projectId: project.id, scopes: tokens.scopes,
                lastValidatedAt: now, createdAt: now, updatedAt: now,
              }).run()
            }
          } else {
            const row = tx.select().from(gtmConnections)
              .where(eq(gtmConnections.projectId, project.id)).get()
            if (row) {
              tx.update(gtmConnections).set({
                selectedAccountId: null, selectedAccountName: null, selectedContainerId: null,
                selectedContainerName: null, selectedContainerPublicId: null,
                selectedWorkspaceId: null, selectedWorkspaceName: null,
                selectionGeneration: sql`${gtmConnections.selectionGeneration} + 1`,
                scopes: tokens.scopes, lastValidatedAt: now, lastSnapshotAt: null, lastSnapshotId: null,
                updatedAt: now,
              })
                .where(eq(gtmConnections.id, row.id)).run()
            } else {
              tx.insert(gtmConnections).values({
                id: crypto.randomUUID(), projectId: project.id, scopes: tokens.scopes,
                lastValidatedAt: now, createdAt: now, updatedAt: now,
              }).run()
            }
          }
          writeAuditLog(tx, {
            projectId: project.id,
            actor: 'oauth',
            action: 'google-marketing.connected',
            entityType: 'google-marketing-connection',
            entityId: flow.provider,
            diff: { provider: flow.provider },
          })
        })
      } catch (error) {
        attempt.failed(error)
        // Private OAuth config is outside SQLite. Restore it if the public
        // connection metadata/audit transaction did not commit. A compensator
        // failure is logged but must not hide the database failure from the
        // caller.
        if (rollbackCredential) {
          try {
            rollbackCredential()
          } catch (rollbackError) {
            app.log.error({ err: rollbackError, projectId: project.id, provider: flow.provider }, 'Google Marketing OAuth credential rollback failed')
          }
        }
        throw error
      } finally {
        pendingOAuthFlows.finish(flow)
      }
      attempt.succeeded()
      const label = flow.provider === GoogleMarketingProviders['google-ads'] ? 'Google Ads' : 'Google Tag Manager'
      return reply.type('text/html').send(oauthHtml('Connected successfully', `${label} is now linked to this project.`))
    })
  }

  // --- Live discovery (all provider queries have both gates) -------------------

  app.get<{ Params: { name: string } }>('/projects/:name/google-ads/customers', async (request) => {
    requireLiveRead(request)
    assertNotProjectScoped(request, 'listing Google Ads customers')
    const project = resolveProject(app.db, request.params.name)
    const projectRef = asProjectRef(project)
    requiredCredential(opts, projectRef, GoogleMarketingProviders['google-ads'])
    const reader = requireLiveReader(opts)
    let result: GoogleAdsAccessibleCustomersResponse
    try {
      result = googleAdsAccessibleCustomersResponseSchema.parse(await reader.listGoogleAdsCustomers(projectRef))
    } catch (err) {
      throw discoveryFailure(app, 'Google Ads customer discovery', err)
    }
    return result
  })

  app.get<{ Params: { name: string } }>('/projects/:name/gtm/accounts', async (request) => {
    requireLiveRead(request)
    assertNotProjectScoped(request, 'listing Google Tag Manager accounts')
    const project = resolveProject(app.db, request.params.name)
    const projectRef = asProjectRef(project)
    requiredCredential(opts, projectRef, GoogleMarketingProviders.gtm)
    const reader = requireLiveReader(opts)
    try {
      return gtmAccountsResponseSchema.parse(await reader.listGtmAccounts(projectRef))
    } catch (err) {
      throw discoveryFailure(app, 'Google Tag Manager account discovery', err)
    }
  })

  app.get<{ Params: { name: string; accountId: string } }>('/projects/:name/gtm/accounts/:accountId/containers', async (request) => {
    requireLiveRead(request)
    assertNotProjectScoped(request, 'listing Google Tag Manager containers')
    const project = resolveProject(app.db, request.params.name)
    const projectRef = asProjectRef(project)
    requiredCredential(opts, projectRef, GoogleMarketingProviders.gtm)
    const accountId = canonicalizeGtmAccountId(request.params.accountId)
    if (!accountId) throw validationError('Invalid GTM account resource path.')
    const reader = requireLiveReader(opts)
    try {
      return gtmContainerListResponseSchema.parse(await reader.listGtmContainers(projectRef, accountId))
    } catch (err) {
      throw discoveryFailure(app, 'Google Tag Manager container discovery', err)
    }
  })

  app.get<{ Params: { name: string; accountId: string; containerId: string } }>('/projects/:name/gtm/accounts/:accountId/containers/:containerId/workspaces', async (request) => {
    requireLiveRead(request)
    assertNotProjectScoped(request, 'listing Google Tag Manager workspaces')
    const project = resolveProject(app.db, request.params.name)
    const projectRef = asProjectRef(project)
    requiredCredential(opts, projectRef, GoogleMarketingProviders.gtm)
    const selection = canonicalizeGtmResourceSelection({
      accountId: request.params.accountId,
      containerId: request.params.containerId,
    })
    if (!selection) throw validationError('Invalid GTM account/container resource paths.')
    const reader = requireLiveReader(opts)
    try {
      return gtmWorkspaceListResponseSchema.parse(await reader.listGtmWorkspaces(
        projectRef,
        selection.accountId,
        selection.containerId,
      ))
    } catch (err) {
      throw discoveryFailure(app, 'Google Tag Manager workspace discovery', err)
    }
  })

  // --- Resource selection --------------------------------------------------------

  /**
   * Queue a provider sync right after a selection, so an operator is never left
   * connected with no data.
   *
   * Selecting a customer or container clears every snapshot pointer, which put
   * the project in a state that reads as "not set up": status stays
   * `selection-required` because the selected resource resolves from a snapshot
   * that no longer exists, the metrics view has nothing to show, and the
   * conversion form falls back to hand-typed ids. Selection is an explicit act
   * with exactly one sensible follow-up, so it should not be homework.
   *
   * GATED IDENTICALLY TO THE SYNC ROUTE. A caller holding only the write scope
   * must not be able to cause a provider call through selection that it cannot
   * make directly, so a caller failing that gate simply gets the previous
   * behaviour rather than an error: the selection itself already succeeded.
   */
  const queueSelectionSync = (
    request: FastifyRequest,
    projectId: string,
    kind: 'google-ads-sync' | 'gtm-sync',
    callback: ((runId: string, projectId: string) => void | Promise<void>) | undefined,
  ): string | null => {
    if (!callback) return null
    try {
      requireLiveRead(request)
    } catch {
      return null
    }
    // ALWAYS queue a successor; never reuse an in-flight run.
    //
    // Selection increments `selectionGeneration`, and the sync worker CAS-writes
    // its evidence gated on that generation (google-marketing-sync.ts). So a run
    // queued before this selection is already doomed: it will fail the compare
    // and throw. Reusing it would leave the new selection with no sync at all,
    // which is exactly the dead state this helper exists to prevent.
    //
    // Two rapid selections therefore queue two runs. That is correct rather than
    // wasteful: each one is a distinct generation and the earlier run cannot
    // satisfy the later selection.
    const run = queuedRun(projectId, RunKinds[kind])
    app.db.transaction((tx) => {
      tx.insert(runs).values(run).run()
      writeAuditLog(tx, auditFromRequest(request, {
        projectId, actor: 'api', action: `${kind}.requested-on-selection`,
        entityType: 'run', entityId: run.id,
      }))
    })
    enqueueAfterCommit(app, callback, run.id, projectId, kind)
    return run.id
  }

  app.put<{ Params: { name: string }; Body: unknown }>('/projects/:name/google-ads/selection', connectionRoute(app, () => marketingConnection(GoogleMarketingProviders['google-ads'], 'select'), async (request, _reply, attempt) => {
    requireWrite(request)
    const parsedBody = parseBody(googleAdsCustomerSelectionRequestSchema, request.body, 'Google Ads selection')
    const body = canonicalizeGoogleAdsCustomerSelection(parsedBody)
    if (!body) throw validationError('Invalid Google Ads selection.')
    const project = resolveProject(app.db, request.params.name)
    const projectRef = asProjectRef(project)
    try {
      requiredCredential(opts, projectRef, GoogleMarketingProviders['google-ads'])
    } catch (err) {
      attempt.failed(err, 'NOT_CONNECTED')
      throw err
    }
    const existing = app.db.select().from(googleAdsConnections)
      .where(eq(googleAdsConnections.projectId, project.id)).get()
    if (!existing) {
      attempt.failed(undefined, 'NOT_CONNECTED')
      throw validationError('Connect Google Ads before selecting a customer.')
    }
    const now = new Date().toISOString()
    const customerChanged = existing.selectedCustomerId !== body.customerId
    app.db.transaction((tx) => {
      tx.update(googleAdsConnections).set({
        selectedLoginCustomerId: body.loginCustomerId ?? null,
        selectedCustomerId: body.customerId,
        selectedCustomerName: customerChanged ? null : existing.selectedCustomerName,
        selectedCustomerCurrencyCode: customerChanged ? null : existing.selectedCustomerCurrencyCode,
        selectedCustomerTimeZone: customerChanged ? null : existing.selectedCustomerTimeZone,
        selectedCustomerStatus: customerChanged ? null : existing.selectedCustomerStatus,
        // A same-value write still starts a new selection generation. Do not
        // let timestamp equality reuse append-only evidence from before it.
        selectionGeneration: sql`${googleAdsConnections.selectionGeneration} + 1`,
        lastValidatedAt: now,
        lastCustomerSnapshotId: null,
        lastInventorySnapshotAt: null,
        lastInventorySnapshotId: null,
        lastMetricsSnapshotAt: null,
        lastMetricsSnapshotId: null,
        updatedAt: now,
      }).where(eq(googleAdsConnections.id, existing.id)).run()
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id, actor: 'api', action: 'google-ads.selection-updated',
        entityType: 'google-ads-connection', entityId: existing.id,
        diff: { loginCustomerId: body.loginCustomerId ?? null, customerId: body.customerId },
      }))
    })
    queueSelectionSync(request, project.id, 'google-ads-sync', opts.onGoogleAdsSyncRequested)
    return googleAdsStatus(app, opts, projectRef)
  }))

  app.put<{ Params: { name: string }; Body: unknown }>('/projects/:name/gtm/selection', connectionRoute(app, () => marketingConnection(GoogleMarketingProviders.gtm, 'select'), async (request, _reply, attempt) => {
    requireWrite(request)
    const parsedBody = parseBody(gtmResourceSelectionRequestSchema, request.body, 'GTM selection')
    const body = canonicalizeGtmResourceSelection(parsedBody)
    if (!body) throw validationError('Invalid GTM selection.')
    const project = resolveProject(app.db, request.params.name)
    const projectRef = asProjectRef(project)
    try {
      requiredCredential(opts, projectRef, GoogleMarketingProviders.gtm)
    } catch (err) {
      attempt.failed(err, 'NOT_CONNECTED')
      throw err
    }
    const existing = app.db.select().from(gtmConnections)
      .where(eq(gtmConnections.projectId, project.id)).get()
    if (!existing) {
      attempt.failed(undefined, 'NOT_CONNECTED')
      throw validationError('Connect Google Tag Manager before selecting resources.')
    }
    const now = new Date().toISOString()
    const selectedWorkspaceId = body.workspaceId ?? null
    const containerChanged = existing.selectedAccountId !== body.accountId || existing.selectedContainerId !== body.containerId
    const workspaceChanged = existing.selectedWorkspaceId !== selectedWorkspaceId
    app.db.transaction((tx) => {
      tx.update(gtmConnections).set({
        selectedAccountId: body.accountId,
        selectedAccountName: containerChanged ? null : existing.selectedAccountName,
        selectedContainerId: body.containerId,
        selectedContainerName: containerChanged ? null : existing.selectedContainerName,
        selectedContainerPublicId: containerChanged ? null : existing.selectedContainerPublicId,
        selectedWorkspaceId,
        selectedWorkspaceName: workspaceChanged ? null : existing.selectedWorkspaceName,
        selectionGeneration: sql`${gtmConnections.selectionGeneration} + 1`,
        lastValidatedAt: now,
        // Every selection write starts a new evidence generation, including a
        // same-value reselection. The timestamp alone cannot order a prior
        // snapshot and this write when both land in one millisecond.
        lastSnapshotAt: null,
        lastSnapshotId: null,
        updatedAt: now,
      }).where(eq(gtmConnections.id, existing.id)).run()
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id, actor: 'api', action: 'gtm.selection-updated',
        entityType: 'gtm-connection', entityId: existing.id,
        diff: { accountId: body.accountId, containerId: body.containerId, workspaceId: body.workspaceId ?? null },
      }))
    })
    queueSelectionSync(request, project.id, 'gtm-sync', opts.onGtmSyncRequested)
    return gtmStatus(app, opts, projectRef)
  }))

  // --- Manual sync: queue only; host performs bounded GETs + snapshot writes ---

  app.post<{ Params: { name: string } }>('/projects/:name/google-ads/sync', async (request) => {
    requireLiveRead(request)
    requireWrite(request)
    if (!opts.onGoogleAdsSyncRequested) {
      throw notImplemented('Google Ads sync is not configured for this deployment.')
    }
    const project = resolveProject(app.db, request.params.name)
    requiredCredential(opts, asProjectRef(project), GoogleMarketingProviders['google-ads'])
    const connection = app.db.select().from(googleAdsConnections)
      .where(eq(googleAdsConnections.projectId, project.id)).get()
    if (!connection) throw validationError('Connect Google Ads before starting a sync.')
    const candidateRun = queuedRun(project.id, RunKinds['google-ads-sync'])
    let run: typeof runs.$inferSelect | typeof candidateRun = candidateRun
    let queued = false
    app.db.transaction((tx) => {
      const existing = tx.select().from(runs).where(and(
        eq(runs.projectId, project.id),
        eq(runs.kind, RunKinds['google-ads-sync']),
        or(eq(runs.status, RunStatuses.queued), eq(runs.status, RunStatuses.running)),
      )).orderBy(desc(runs.createdAt)).get()
      if (existing) {
        run = existing
        return
      }
      tx.insert(runs).values(candidateRun).run()
      queued = true
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id, actor: 'api', action: 'google-ads.sync-requested',
        entityType: 'run', entityId: run.id,
      }))
    })
    if (queued) enqueueAfterCommit(app, opts.onGoogleAdsSyncRequested, run.id, project.id, 'google-ads-sync')
    return run
  })

  app.post<{ Params: { name: string } }>('/projects/:name/gtm/sync', async (request) => {
    requireLiveRead(request)
    requireWrite(request)
    if (!opts.onGtmSyncRequested) {
      throw notImplemented('Google Tag Manager sync is not configured for this deployment.')
    }
    const project = resolveProject(app.db, request.params.name)
    requiredCredential(opts, asProjectRef(project), GoogleMarketingProviders.gtm)
    const connection = app.db.select().from(gtmConnections)
      .where(eq(gtmConnections.projectId, project.id)).get()
    if (!connection) throw validationError('Connect Google Tag Manager before starting a sync.')
    const candidateRun = queuedRun(project.id, RunKinds['gtm-sync'])
    let run: typeof runs.$inferSelect | typeof candidateRun = candidateRun
    let queued = false
    app.db.transaction((tx) => {
      const existing = tx.select().from(runs).where(and(
        eq(runs.projectId, project.id),
        eq(runs.kind, RunKinds['gtm-sync']),
        or(eq(runs.status, RunStatuses.queued), eq(runs.status, RunStatuses.running)),
      )).orderBy(desc(runs.createdAt)).get()
      if (existing) {
        run = existing
        return
      }
      tx.insert(runs).values(candidateRun).run()
      queued = true
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id, actor: 'api', action: 'gtm.sync-requested',
        entityType: 'run', entityId: run.id,
      }))
    })
    if (queued) enqueueAfterCommit(app, opts.onGtmSyncRequested, run.id, project.id, 'gtm-sync')
    return run
  })

  // --- Computed stored performance ----------------------------------------------

  // Stored-evidence read. It deliberately does NOT reach Google: a live metrics
  // read spends the advertiser's budget and is gated behind live-read authority,
  // while this is the figure a dashboard renders on every page load.
  app.get<{
    Params: { name: string }
    Querystring: { window?: string }
  }>('/projects/:name/google-ads/performance', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const query = parseBody(googleAdsPerformanceQuerySchema, request.query, 'Google Ads performance')
    return googleAdsPerformance(app, project.id, query.window ?? GOOGLE_ADS_PERFORMANCE_DEFAULT_WINDOW)
  })

  // --- Append-only sanitized snapshot reads -------------------------------------

  app.get<{
    Params: { name: string }
    Querystring: { limit?: string; cursor?: string }
  }>('/projects/:name/google-ads/snapshots', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const query = parseBody(snapshotPageQuerySchema, request.query, 'Google Ads snapshot page')
    const cursor = decodeSnapshotCursor(query.cursor)
    const conditions: SQL[] = [eq(googleAdsRawSnapshots.projectId, project.id)]
    if (cursor) {
      conditions.push(or(
        lt(googleAdsRawSnapshots.capturedAt, cursor.capturedAt),
        and(eq(googleAdsRawSnapshots.capturedAt, cursor.capturedAt), lt(googleAdsRawSnapshots.id, cursor.id)),
      )!)
    }
    const limit = query.limit ?? 50
    const rows = app.db.select().from(googleAdsRawSnapshots).where(and(...conditions))
      .orderBy(desc(googleAdsRawSnapshots.capturedAt), desc(googleAdsRawSnapshots.id))
      .limit(limit + 1).all()
    const page = rows.slice(0, limit)
    const total = app.db.select({ total: sql<number>`COUNT(*)`.mapWith(Number).as('total') }).from(googleAdsRawSnapshots)
      .where(eq(googleAdsRawSnapshots.projectId, project.id)).get()
    return {
      snapshots: page.map(toGoogleAdsSnapshotMetadata),
      nextCursor: rows.length > limit && page.length > 0
        ? encodeSnapshotCursor({ capturedAt: page.at(-1)!.capturedAt, id: page.at(-1)!.id })
        : null,
      total: total?.total ?? 0,
    }
  })

  app.get<{ Params: { name: string; snapshotId: string } }>('/projects/:name/google-ads/snapshots/:snapshotId', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const row = app.db.select().from(googleAdsRawSnapshots).where(and(
      eq(googleAdsRawSnapshots.projectId, project.id),
      eq(googleAdsRawSnapshots.id, request.params.snapshotId),
    )).get()
    if (!row) throw notFound('Google Ads snapshot', request.params.snapshotId)
    const snapshot = toGoogleAdsSnapshot(row)
    if (!snapshot) throw providerError('Stored Google Ads snapshot is invalid.')
    return { snapshot }
  })

  app.get<{
    Params: { name: string }
    Querystring: { limit?: string; cursor?: string }
  }>('/projects/:name/gtm/snapshots', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const query = parseBody(snapshotPageQuerySchema, request.query, 'GTM snapshot page')
    const cursor = decodeSnapshotCursor(query.cursor)
    const conditions: SQL[] = [eq(gtmRawSnapshots.projectId, project.id)]
    if (cursor) {
      conditions.push(or(
        lt(gtmRawSnapshots.capturedAt, cursor.capturedAt),
        and(eq(gtmRawSnapshots.capturedAt, cursor.capturedAt), lt(gtmRawSnapshots.id, cursor.id)),
      )!)
    }
    const limit = query.limit ?? 50
    const rows = app.db.select().from(gtmRawSnapshots).where(and(...conditions))
      .orderBy(desc(gtmRawSnapshots.capturedAt), desc(gtmRawSnapshots.id))
      .limit(limit + 1).all()
    const page = rows.slice(0, limit)
    const total = app.db.select({ total: sql<number>`COUNT(*)`.mapWith(Number).as('total') }).from(gtmRawSnapshots)
      .where(eq(gtmRawSnapshots.projectId, project.id)).get()
    return {
      snapshots: page.map(toGtmSnapshotMetadata),
      nextCursor: rows.length > limit && page.length > 0
        ? encodeSnapshotCursor({ capturedAt: page.at(-1)!.capturedAt, id: page.at(-1)!.id })
        : null,
      total: total?.total ?? 0,
    }
  })

  app.get<{ Params: { name: string; snapshotId: string } }>('/projects/:name/gtm/snapshots/:snapshotId', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const row = app.db.select().from(gtmRawSnapshots).where(and(
      eq(gtmRawSnapshots.projectId, project.id),
      eq(gtmRawSnapshots.id, request.params.snapshotId),
    )).get()
    if (!row) throw notFound('GTM snapshot', request.params.snapshotId)
    const snapshot = toGtmSnapshot(row)
    if (!snapshot) throw providerError('Stored GTM snapshot is invalid.')
    return { snapshot }
  })

  // --- Disconnect preserves append-only evidence, removes private credential --

  app.delete<{ Params: { name: string } }>('/projects/:name/google-ads/connection', connectionRoute(app, () => marketingConnection(GoogleMarketingProviders['google-ads'], 'disconnect'), async (request, _reply, attempt) => {
    requireWrite(request)
    const project = resolveProject(app.db, request.params.name)
    const projectRef = asProjectRef(project)
    pendingOAuthFlows.revoke(project.id, GoogleMarketingProviders['google-ads'])
    const row = app.db.select().from(googleAdsConnections).where(eq(googleAdsConnections.projectId, project.id)).get()
    const removedCredential = requireCredentialStore(opts).delete(projectRef, GoogleMarketingProviders['google-ads'])
    if (row) {
      const now = new Date().toISOString()
      app.db.transaction((tx) => {
        tx.update(googleAdsConnections).set({
          selectedLoginCustomerId: null, selectedCustomerId: null, selectedCustomerName: null,
          selectedCustomerCurrencyCode: null, selectedCustomerTimeZone: null, selectedCustomerStatus: null,
          selectionGeneration: sql`${googleAdsConnections.selectionGeneration} + 1`,
          scopes: [], lastValidatedAt: null, lastCustomerSnapshotId: null,
          lastInventorySnapshotAt: null, lastInventorySnapshotId: null,
          lastMetricsSnapshotAt: null, lastMetricsSnapshotId: null, updatedAt: now,
        }).where(eq(googleAdsConnections.id, row.id)).run()
        writeAuditLog(tx, auditFromRequest(request, {
          projectId: project.id, actor: 'api', action: 'google-ads.disconnected',
          entityType: 'google-ads-connection', entityId: row.id,
        }))
      })
    }
    if (!row && !removedCredential) attempt.cancelled('NOT_CONNECTED')
    return { provider: GoogleMarketingProviders['google-ads'], disconnected: Boolean(row) || removedCredential }
  }))

  app.delete<{ Params: { name: string } }>('/projects/:name/gtm/connection', connectionRoute(app, () => marketingConnection(GoogleMarketingProviders.gtm, 'disconnect'), async (request, _reply, attempt) => {
    requireWrite(request)
    const project = resolveProject(app.db, request.params.name)
    const projectRef = asProjectRef(project)
    pendingOAuthFlows.revoke(project.id, GoogleMarketingProviders.gtm)
    const row = app.db.select().from(gtmConnections).where(eq(gtmConnections.projectId, project.id)).get()
    const removedCredential = requireCredentialStore(opts).delete(projectRef, GoogleMarketingProviders.gtm)
    if (row) {
      const now = new Date().toISOString()
      app.db.transaction((tx) => {
        tx.update(gtmConnections).set({
          selectedAccountId: null, selectedAccountName: null, selectedContainerId: null,
          selectedContainerName: null, selectedContainerPublicId: null,
          selectedWorkspaceId: null, selectedWorkspaceName: null,
          selectionGeneration: sql`${gtmConnections.selectionGeneration} + 1`,
          scopes: [], lastValidatedAt: null, lastSnapshotAt: null, lastSnapshotId: null, updatedAt: now,
        }).where(eq(gtmConnections.id, row.id)).run()
        writeAuditLog(tx, auditFromRequest(request, {
          projectId: project.id, actor: 'api', action: 'gtm.disconnected',
          entityType: 'gtm-connection', entityId: row.id,
        }))
      })
    }
    if (!row && !removedCredential) attempt.cancelled('NOT_CONNECTED')
    return { provider: GoogleMarketingProviders.gtm, disconnected: Boolean(row) || removedCredential }
  }))

  // --- Conversion-tracking contract + integrity reads ---------------------------

  /**
   * Options for the declare-a-conversion form.
   *
   * Reads the latest STORED snapshots only, so it costs no provider quota and
   * cannot spend the advertiser's budget. Without this the operator had to copy
   * two opaque numeric ids out of the Google Ads and Tag Manager consoles by
   * hand, which fails only after saving and produces a contract that silently
   * checks the wrong thing on a typo.
   */
  app.get<{ Params: { name: string } }>('/projects/:name/conversion-tracking/options', async (request) => {
    const project = resolveProject(app.db, request.params.name)

    const adsSnapshot = latestGoogleAdsSnapshot(app, project.id)
    const adsInventory = adsSnapshot?.payload.kind === GoogleAdsSnapshotKinds.inventory
      ? adsSnapshot.payload.data
      : null

    const gtmSnapshot = latestGtmSnapshot(app, project.id)
    const gtmContainer = gtmSnapshot?.payload.kind === GtmSnapshotKinds.container
      ? gtmSnapshot.payload.data
      : null
    // The draft workspace is what the operator is editing; fall back to live.
    const gtmGraph = (gtmContainer?.draft ?? gtmContainer?.live)?.graph ?? null

    return {
      googleAds: {
        customerId: adsSnapshot?.metadata.customerId ?? null,
        syncedAt: adsSnapshot?.metadata.capturedAt ?? null,
        conversionActions: (adsInventory?.conversionActions ?? []).map(action => ({
          id: action.id,
          name: action.name,
          detail: action.category,
          // A removed action is still offered: an existing contract may point
          // at one, and hiding it would make that contract unexplainable.
          active: action.status !== 'removed',
        })),
      },
      gtm: {
        containerId: gtmSnapshot?.metadata.containerId ?? null,
        syncedAt: gtmSnapshot?.metadata.capturedAt ?? null,
        tags: (gtmGraph?.tags ?? []).map(tag => ({
          id: tag.id,
          name: tag.name,
          detail: tag.type,
          active: !tag.paused,
        })),
      },
    }
  })

  app.get<{ Params: { name: string } }>('/projects/:name/conversion-tracking/contracts', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    return app.db.select().from(conversionTrackingContracts)
      .where(eq(conversionTrackingContracts.projectId, project.id))
      .orderBy(conversionTrackingContracts.name)
      .all()
      .map(toConversionTrackingContract)
  })

  app.post<{ Params: { name: string }; Body: unknown }>('/projects/:name/conversion-tracking/contracts', async (request) => {
    requireWrite(request)
    const body = normalizeConversionTrackingContractWrite(
      parseBody(conversionTrackingContractWriteRequestSchema, request.body, 'conversion tracking contract'),
    )
    const project = resolveProject(app.db, request.params.name)
    const duplicate = app.db.select({ id: conversionTrackingContracts.id }).from(conversionTrackingContracts)
      .where(and(eq(conversionTrackingContracts.projectId, project.id), eq(conversionTrackingContracts.name, body.name))).get()
    if (duplicate) throw alreadyExists('Conversion tracking contract', body.name)
    const now = new Date().toISOString()
    const contract: ConversionTrackingContract = {
      id: crypto.randomUUID(), projectId: project.id, ...body, createdAt: now, updatedAt: now,
    }
    app.db.transaction((tx) => {
      tx.insert(conversionTrackingContracts).values(contract).run()
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id, actor: 'api', action: 'conversion-tracking.contract-created',
        entityType: 'conversion-tracking-contract', entityId: contract.id,
        diff: { name: contract.name, eventName: contract.eventName },
      }))
    })
    return contract
  })

  app.get<{ Params: { name: string; contractId: string } }>('/projects/:name/conversion-tracking/contracts/:contractId', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const row = app.db.select().from(conversionTrackingContracts).where(and(
      eq(conversionTrackingContracts.projectId, project.id),
      eq(conversionTrackingContracts.id, request.params.contractId),
    )).get()
    if (!row) throw notFound('Conversion tracking contract', request.params.contractId)
    return toConversionTrackingContract(row)
  })

  app.put<{ Params: { name: string; contractId: string }; Body: unknown }>('/projects/:name/conversion-tracking/contracts/:contractId', async (request) => {
    requireWrite(request)
    const body = normalizeConversionTrackingContractWrite(
      parseBody(conversionTrackingContractWriteRequestSchema, request.body, 'conversion tracking contract'),
    )
    const project = resolveProject(app.db, request.params.name)
    const existing = app.db.select().from(conversionTrackingContracts).where(and(
      eq(conversionTrackingContracts.projectId, project.id),
      eq(conversionTrackingContracts.id, request.params.contractId),
    )).get()
    if (!existing) throw notFound('Conversion tracking contract', request.params.contractId)
    const duplicate = app.db.select({ id: conversionTrackingContracts.id }).from(conversionTrackingContracts).where(and(
      eq(conversionTrackingContracts.projectId, project.id),
      eq(conversionTrackingContracts.name, body.name),
      ne(conversionTrackingContracts.id, existing.id),
    )).get()
    if (duplicate) throw alreadyExists('Conversion tracking contract', body.name)
    const updatedAt = new Date().toISOString()
    const contract: ConversionTrackingContract = {
      id: existing.id, projectId: project.id, ...body, createdAt: existing.createdAt, updatedAt,
    }
    app.db.transaction((tx) => {
      tx.update(conversionTrackingContracts).set({
        name: contract.name, eventName: contract.eventName, googleAds: contract.googleAds,
        gtm: contract.gtm, runtime: contract.runtime, updatedAt,
      }).where(eq(conversionTrackingContracts.id, existing.id)).run()
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id, actor: 'api', action: 'conversion-tracking.contract-updated',
        entityType: 'conversion-tracking-contract', entityId: existing.id,
        diff: { name: contract.name, eventName: contract.eventName },
      }))
    })
    return contract
  })

  app.delete<{ Params: { name: string; contractId: string } }>('/projects/:name/conversion-tracking/contracts/:contractId', async (request, reply) => {
    requireWrite(request)
    const project = resolveProject(app.db, request.params.name)
    const existing = app.db.select().from(conversionTrackingContracts).where(and(
      eq(conversionTrackingContracts.projectId, project.id),
      eq(conversionTrackingContracts.id, request.params.contractId),
    )).get()
    if (!existing) throw notFound('Conversion tracking contract', request.params.contractId)
    app.db.transaction((tx) => {
      tx.delete(conversionTrackingContracts).where(eq(conversionTrackingContracts.id, existing.id)).run()
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: project.id, actor: 'api', action: 'conversion-tracking.contract-deleted',
        entityType: 'conversion-tracking-contract', entityId: existing.id,
        diff: { name: existing.name },
      }))
    })
    return reply.status(204).send()
  })

  app.get<{ Params: { name: string; contractId: string } }>('/projects/:name/conversion-tracking/contracts/:contractId/integrity', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const row = app.db.select().from(conversionTrackingContracts).where(and(
      eq(conversionTrackingContracts.projectId, project.id),
      eq(conversionTrackingContracts.id, request.params.contractId),
    )).get()
    if (!row) throw notFound('Conversion tracking contract', request.params.contractId)
    if (!opts.assessConversionTrackingIntegrity) {
      throw notImplemented('Conversion tracking integrity assessment is not configured for this deployment.')
    }
    const contract = toConversionTrackingContract(row)
    const googleAdsSnapshot = latestGoogleAdsSnapshot(app, project.id)
    const gtmSnapshot = latestGtmSnapshot(app, project.id)
    let assessment: ConversionTrackingIntegrityAssessmentDto
    try {
      assessment = conversionTrackingIntegrityAssessmentDtoSchema.parse(await opts.assessConversionTrackingIntegrity({
        project: asProjectRef(project), contract, googleAdsSnapshot, gtmSnapshot,
      }))
    } catch {
      throw providerError('Conversion tracking integrity assessment failed.')
    }
    if (assessment.contract.id !== contract.id || assessment.contract.projectId !== project.id) {
      throw providerError('Conversion tracking integrity assessment returned a mismatched contract.')
    }
    return {
      assessment,
      googleAdsSnapshot: googleAdsSnapshot?.metadata ?? null,
      gtmSnapshot: gtmSnapshot?.metadata ?? null,
    }
  })
}
