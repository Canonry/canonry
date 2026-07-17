import crypto from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { eq, and, asc, gte, lte, inArray } from 'drizzle-orm'
import {
  ADS_WRITE_SCOPE,
  AdsEntityTypes,
  AdsEntityStatuses,
  AdsOperationKinds,
  AdsOperationStates,
  AppError,
  adsAdCreateRequestSchema,
  adsAdGroupCreateRequestSchema,
  adsAdGroupUpdateRequestSchema,
  adsAdUpdateRequestSchema,
  adsCampaignCreateRequestSchema,
  adsCampaignUpdateRequestSchema,
  adsConnectRequestSchema,
  adsImageUploadRequestSchema,
  adsInsightLevelSchema,
  adsPauseRequestSchema,
  adsCtr,
  adsCpcMicros,
  alreadyExists,
  notFound,
  providerError,
  validationError,
  RunKinds,
  RunStatuses,
  RunTriggers,
} from '@ainyc/canonry-contracts'
import type {
  AdsAdDto,
  AdsAdGroupDto,
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
} from '@ainyc/canonry-contracts'
import { adsConnections, adsCampaigns, adsAdGroups, adsAds, adsInsightsDaily, adsOperations, runs } from '@ainyc/canonry-db'
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
}

export interface AdsRoutesOptions {
  adsCredentialStore?: AdsCredentialStore
  /** Validates an SDK key against the upstream ad account (host wires this to the integration client). */
  verifyAdsAccount?: (apiKey: string) => Promise<VerifiedAdsAccount>
  /** Fired after a manual sync run row is created; host runs the ads-sync worker. */
  onAdsSyncRequested?: (runId: string, projectId: string) => void
  /** Optional lifecycle adapter. The host resolves the project credential and calls the upstream Ads API. */
  adsOperator?: AdsOperator
}

export interface AdsOperatorEntityResult {
  id: string
  status: string
  updatedAt: number
  reviewStatus?: string | null
}

export interface AdsOperator {
  uploadImage(apiKey: string, imageUrl: string): Promise<{ fileId: string }>
  getCampaign(apiKey: string, id: string): Promise<AdsOperatorEntityResult>
  createCampaign(apiKey: string, input: {
    name: string
    description?: string
    startTime?: number
    endTime?: number
    lifetimeSpendLimitMicros: number
    locationIds: string[]
    status: typeof AdsEntityStatuses.paused
  }): Promise<AdsOperatorEntityResult>
  updateCampaign(apiKey: string, id: string, input: {
    name?: string
    description?: string | null
    startTime?: number | null
    endTime?: number | null
    lifetimeSpendLimitMicros?: number
    locationIds?: string[] | null
  }): Promise<AdsOperatorEntityResult>
  pauseCampaign(apiKey: string, id: string): Promise<AdsOperatorEntityResult>
  getAdGroup(apiKey: string, id: string): Promise<AdsOperatorEntityResult>
  createAdGroup(apiKey: string, input: {
    campaignId: string
    name: string
    description?: string
    contextHints: string[]
    maxBidMicros: number
    status: typeof AdsEntityStatuses.paused
  }): Promise<AdsOperatorEntityResult>
  updateAdGroup(apiKey: string, id: string, input: {
    name?: string
    description?: string | null
    contextHints?: string[]
    maxBidMicros?: number
  }): Promise<AdsOperatorEntityResult>
  pauseAdGroup(apiKey: string, id: string): Promise<AdsOperatorEntityResult>
  getAd(apiKey: string, id: string): Promise<AdsOperatorEntityResult>
  createAd(apiKey: string, input: {
    adGroupId: string
    name: string
    creative: { title: string; body: string; targetUrl: string; fileId: string }
    status: typeof AdsEntityStatuses.paused
  }): Promise<AdsOperatorEntityResult>
  updateAd(apiKey: string, id: string, input: {
    name?: string
    creative?: { title: string; body: string; targetUrl: string; fileId: string }
  }): Promise<AdsOperatorEntityResult>
  pauseAd(apiKey: string, id: string): Promise<AdsOperatorEntityResult>
}

type ConnectionRow = typeof adsConnections.$inferSelect
type OperationRow = typeof adsOperations.$inferSelect

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
    operationKey: row.operationKey,
    kind: row.kind as AdsOperationKind,
    state: row.state as AdsOperationDto['state'],
    entityType: row.entityType as AdsEntityType | null,
    entityId: row.entityId,
    upstreamUpdatedAt: row.upstreamUpdatedAt,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
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

function resolveAdsOperator(
  opts: AdsRoutesOptions,
  projectName: string,
): { apiKey: string; operator: AdsOperator } {
  const apiKey = opts.adsCredentialStore?.getConnection(projectName)?.apiKey
  if (!apiKey) {
    throw validationError('No ads connection for this project. Run "canonry ads connect" first.')
  }
  if (!opts.adsOperator) {
    throw validationError('Ads lifecycle operations are not configured for this deployment')
  }
  return { apiKey, operator: opts.adsOperator }
}

async function executeAdsOperation(
  app: FastifyInstance,
  request: FastifyRequest,
  input: {
    projectId: string
    operationKey: string
    kind: AdsOperationKind
    entityType: AdsEntityType
    payload: unknown
    expectedStatus?: AdsEntityStatus
    remediateStatus?: (
      result: { id: string; status?: string; updatedAt?: number | null },
    ) => Promise<{ id: string; status?: string; updatedAt?: number | null }>
    run: () => Promise<{ id: string; status?: string; updatedAt?: number | null }>
  },
): Promise<AdsOperationResponse> {
  const hash = requestHash({ kind: input.kind, entityType: input.entityType, payload: input.payload })
  const existing = app.db
    .select()
    .from(adsOperations)
    .where(and(
      eq(adsOperations.projectId, input.projectId),
      eq(adsOperations.operationKey, input.operationKey),
    ))
    .get()
  if (existing) {
    if (existing.requestHash !== hash) {
      throw alreadyExists('Ads operation key', input.operationKey)
    }
    return { operation: operationDto(existing), replayed: true }
  }

  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  app.db.insert(adsOperations).values({
    id,
    projectId: input.projectId,
    operationKey: input.operationKey,
    requestHash: hash,
    kind: input.kind,
    state: AdsOperationStates.pending,
    entityType: input.entityType,
    createdAt,
    updatedAt: createdAt,
  }).run()

  let result: Awaited<ReturnType<typeof input.run>> | undefined
  try {
    result = await input.run()
    if (input.expectedStatus !== undefined && result.status !== input.expectedStatus) {
      if (input.remediateStatus) result = await input.remediateStatus(result)
      if (result.status !== input.expectedStatus) {
        throw new AdsPausedPostconditionError(result.id)
      }
    }
    const succeededResult = result
    const updatedAt = new Date().toISOString()
    app.db.transaction((tx) => {
      tx.update(adsOperations).set({
        state: AdsOperationStates.succeeded,
        entityId: succeededResult.id,
        upstreamUpdatedAt: succeededResult.updatedAt ?? null,
        updatedAt,
      }).where(eq(adsOperations.id, id)).run()
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: input.projectId,
        actor: 'api',
        action: `ads.${input.kind}.succeeded`,
        entityType: input.entityType,
        entityId: succeededResult.id,
        diff: { operationId: id, operationKey: input.operationKey },
      }))
    })
    const row = app.db.select().from(adsOperations).where(eq(adsOperations.id, id)).get()!
    return { operation: operationDto(row), replayed: false }
  } catch (err) {
    const failure = errorDetails(err)
    // A remediation request can fail after the provider has already created or
    // updated the entity. Preserve the last confirmed id so the unknown receipt
    // can be reconciled without blindly retrying the mutation.
    const entityId = failure.entityId ?? result?.id
    const updatedAt = new Date().toISOString()
    app.db.transaction((tx) => {
      tx.update(adsOperations).set({
        state: failure.state,
        entityId,
        errorCode: failure.code,
        errorMessage: failure.message,
        updatedAt,
      }).where(eq(adsOperations.id, id)).run()
      writeAuditLog(tx, auditFromRequest(request, {
        projectId: input.projectId,
        actor: 'api',
        action: `ads.${input.kind}.${failure.state}`,
        entityType: input.entityType,
        entityId: entityId ?? id,
        diff: { operationId: id, operationKey: input.operationKey, errorCode: failure.code },
      }))
    })
    if (err instanceof AppError) throw err
    throw providerError('OpenAI Ads API mutation failed', {
      operationId: id,
      operationKey: input.operationKey,
      state: failure.state,
      code: failure.code,
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

export async function adsRoutes(app: FastifyInstance, opts: AdsRoutesOptions): Promise<void> {
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

    const response: AdsDisconnectResponse = { disconnected: Boolean(row) || removedFromConfig }
    return response
  })

  app.get<{ Params: { name: string } }>('/projects/:name/ads/status', async (request) => {
    const project = resolveProject(app.db, request.params.name)
    const row = app.db.select().from(adsConnections)
      .where(eq(adsConnections.projectId, project.id)).get()
    return statusDto(row)
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
    const { apiKey, operator } = resolveAdsOperator(opts, project.name)
    return executeAdsOperation(app, request, {
      projectId: project.id,
      operationKey: body.operationKey,
      kind: AdsOperationKinds.image_upload,
      entityType: AdsEntityTypes.file,
      payload: { imageUrl: body.imageUrl },
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
    const { operationKey, ...requested } = body
    const providerInput = { ...requested, status: AdsEntityStatuses.paused }
    const { apiKey, operator } = resolveAdsOperator(opts, project.name)
    return executeAdsOperation(app, request, {
      projectId: project.id,
      operationKey,
      kind: AdsOperationKinds.campaign_create,
      entityType: AdsEntityTypes.campaign,
      payload: providerInput,
      expectedStatus: AdsEntityStatuses.paused,
      remediateStatus: (result) => operator.pauseCampaign(apiKey, result.id),
      run: async () => operator.createCampaign(apiKey, providerInput),
    })
  })

  app.post<{ Params: { name: string } }>('/projects/:name/ads/ad-groups', async (request) => {
    requireScope(request, ADS_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    const body = parseBody(adsAdGroupCreateRequestSchema, request.body)
    const { operationKey, ...requested } = body
    const providerInput = { ...requested, status: AdsEntityStatuses.paused }
    const { apiKey, operator } = resolveAdsOperator(opts, project.name)
    return executeAdsOperation(app, request, {
      projectId: project.id,
      operationKey,
      kind: AdsOperationKinds.ad_group_create,
      entityType: AdsEntityTypes.ad_group,
      payload: providerInput,
      expectedStatus: AdsEntityStatuses.paused,
      remediateStatus: (result) => operator.pauseAdGroup(apiKey, result.id),
      run: async () => operator.createAdGroup(apiKey, providerInput),
    })
  })

  app.post<{ Params: { name: string } }>('/projects/:name/ads/ads', async (request) => {
    requireScope(request, ADS_WRITE_SCOPE)
    const project = resolveProject(app.db, request.params.name)
    const body = parseBody(adsAdCreateRequestSchema, request.body)
    const { operationKey, ...requested } = body
    const providerInput = { ...requested, status: AdsEntityStatuses.paused }
    const { apiKey, operator } = resolveAdsOperator(opts, project.name)
    return executeAdsOperation(app, request, {
      projectId: project.id,
      operationKey,
      kind: AdsOperationKinds.ad_create,
      entityType: AdsEntityTypes.ad,
      payload: providerInput,
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
      const { apiKey, operator } = resolveAdsOperator(opts, project.name)
      return executeAdsOperation(app, request, {
        projectId: project.id,
        operationKey,
        kind: AdsOperationKinds.campaign_update,
        entityType: AdsEntityTypes.campaign,
        payload: { id: request.params.id, expectedUpdatedAt, update },
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
      const { apiKey, operator } = resolveAdsOperator(opts, project.name)
      return executeAdsOperation(app, request, {
        projectId: project.id,
        operationKey,
        kind: AdsOperationKinds.ad_group_update,
        entityType: AdsEntityTypes.ad_group,
        payload: { id: request.params.id, expectedUpdatedAt, update },
        expectedStatus: AdsEntityStatuses.paused,
        remediateStatus: (result) => operator.pauseAdGroup(apiKey, result.id),
        run: async () => {
          const current = await operator.getAdGroup(apiKey, request.params.id)
          assertExpectedUpdatedAt(current, expectedUpdatedAt)
          assertPausedForUpdate(current)
          return operator.updateAdGroup(apiKey, request.params.id, update)
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
      const { apiKey, operator } = resolveAdsOperator(opts, project.name)
      return executeAdsOperation(app, request, {
        projectId: project.id,
        operationKey,
        kind: AdsOperationKinds.ad_update,
        entityType: AdsEntityTypes.ad,
        payload: { id: request.params.id, expectedUpdatedAt, update },
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
      const { apiKey, operator } = resolveAdsOperator(opts, project.name)
      return executeAdsOperation(app, request, {
        projectId: project.id,
        operationKey: body.operationKey,
        kind: AdsOperationKinds.campaign_pause,
        entityType: AdsEntityTypes.campaign,
        payload: { id: request.params.id },
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
      const { apiKey, operator } = resolveAdsOperator(opts, project.name)
      return executeAdsOperation(app, request, {
        projectId: project.id,
        operationKey: body.operationKey,
        kind: AdsOperationKinds.ad_group_pause,
        entityType: AdsEntityTypes.ad_group,
        payload: { id: request.params.id },
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
      const { apiKey, operator } = resolveAdsOperator(opts, project.name)
      return executeAdsOperation(app, request, {
        projectId: project.id,
        operationKey: body.operationKey,
        kind: AdsOperationKinds.ad_pause,
        entityType: AdsEntityTypes.ad,
        payload: { id: request.params.id },
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
        billingEventType: group.billingEventType,
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
      biddingType: campaign.biddingType,
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
