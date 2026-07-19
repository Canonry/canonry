import crypto from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { and, asc, eq, gt, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import {
  ADS_ACTIVATE_SCOPE,
  ADS_APPROVE_SCOPE,
  AdsActivationGrantStates,
  AdsActivationEntityTypes,
  AdsOperationKinds,
  AdsOperationStates,
  AdsOperationStepStates,
  AppError,
  adsActivateTreeRequestSchema,
  adsActivateTreeResponseSchema,
  adsActivationGrantCreateRequestSchema,
  adsActivationGrantDtoSchema,
  adsActivationGrantResponseSchema,
  adsActivationGrantRevokeRequestSchema,
  adsOperationStepDtoSchema,
  alreadyExists,
  forbidden,
  internalError,
  notFound,
  providerError,
  validationError,
  type AdsActivateTreeResponse,
  type AdsActivationGrantDto,
  type AdsOperationDto,
  type AdsOperationStepDto,
} from '@ainyc/canonry-contracts'
import {
  adsActivationGrants,
  adsOperations,
  adsOperationSteps,
  apiKeys,
  projects,
  type DatabaseClient,
} from '@ainyc/canonry-db'
import { requireScope } from './auth.js'
import { auditFromRequest, resolveProject, writeAuditLog } from './helpers.js'
import {
  AdsActivationError,
  AdsActivationErrorCodes,
  enforceAdsActivationCampaignBoundarySafety,
  enforceUnknownAdsActivationSafety,
  executeApprovedAdsActivation,
  hashAdsActivationManifest,
  hashAdsActivationOperationRequest,
  preflightAdsActivationApproval,
  serializeAdsActivationManifest,
  type AdsActivationClaimInput,
  type AdsActivationClaimResult,
  type AdsActivationResult,
  type AdsActivationOperationRecord,
  type AdsActivationProvider,
  type AdsActivationStepAuthorizationInput,
  type AdsActivationStepTransitionInput,
  type AdsActivationStore,
} from './ads-activation.js'

type OperationRow = typeof adsOperations.$inferSelect
type ActivationGrantRow = typeof adsActivationGrants.$inferSelect
type ActivationStepRow = typeof adsOperationSteps.$inferSelect
type ActivationReadDb = Pick<DatabaseClient, 'select'>

const MAX_ACTIVATION_GRANT_LIFETIME_MS = 24 * 60 * 60 * 1_000
const ACTIVATION_LEASE_MS = 5 * 60_000
const ACTIVATION_STEP_INSERT_BATCH_SIZE = 40

export interface AdsActivationRuntime {
  adAccountId: string
  provider: AdsActivationProvider
}

export interface AdsActivationRoutesOptions {
  resolveRuntime(project: { id: string; name: string }): Promise<AdsActivationRuntime>
  toOperationDto(row: OperationRow): AdsOperationDto
  /** Recovery cadence for stale, pending activation receipts. Zero disables it. */
  watchdogIntervalMs?: number
  watchdogBatchSize?: number
  leaseMs?: number
}

function parseBody<T>(
  schema: {
    safeParse(value: unknown):
      | { success: true; data: T }
      | { success: false; error: { issues: unknown[] } }
  },
  value: unknown,
): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw validationError('Invalid ads activation request', { issues: parsed.error.issues })
  }
  return parsed.data
}

function toGrantDto(row: ActivationGrantRow): AdsActivationGrantDto {
  return adsActivationGrantDtoSchema.parse(row)
}

function toStepDto(row: ActivationStepRow): AdsOperationStepDto {
  return adsOperationStepDtoSchema.parse(row)
}

function activationOperationState(
  state: string,
): AdsActivationOperationRecord['state'] {
  switch (state) {
    case AdsOperationStates.pending:
    case AdsOperationStates.succeeded:
    case AdsOperationStates.failed:
    case AdsOperationStates.unknown:
      return state
    default:
      throw internalError('Ads activation receipt has an invalid state')
  }
}

function loadActivationGrant(
  db: ActivationReadDb,
  grantId: string,
): AdsActivationGrantDto | undefined {
  const row = db.select().from(adsActivationGrants)
    .where(eq(adsActivationGrants.id, grantId)).get()
  return row ? toGrantDto(row) : undefined
}

function loadActivationOperation(
  db: ActivationReadDb,
  operationId: string,
): AdsActivationOperationRecord | undefined {
  const row = db.select().from(adsOperations)
    .where(eq(adsOperations.id, operationId)).get()
  if (!row) return undefined
  if (row.kind !== AdsOperationKinds.campaign_tree_activate) {
    throw internalError('Ads activation grant is bound to a non-activation receipt')
  }
  const steps = db.select().from(adsOperationSteps)
    .where(eq(adsOperationSteps.operationId, operationId))
    .orderBy(asc(adsOperationSteps.ordinal)).all().map(toStepDto)
  return {
    ...row,
    kind: AdsOperationKinds.campaign_tree_activate,
    state: activationOperationState(row.state),
    steps,
  }
}

function loadCanonicalActivation(
  db: ActivationReadDb,
  grantId: string,
  operationId: string,
): { grant: AdsActivationGrantDto; operation: AdsActivationOperationRecord } {
  const grant = loadActivationGrant(db, grantId)
  const operation = loadActivationOperation(db, operationId)
  if (!grant || !operation) {
    throw internalError('Ads activation receipt could not be loaded')
  }
  return { grant, operation }
}

function sameManifest(grant: ActivationGrantRow, input: AdsActivationClaimInput): boolean {
  return grant.manifestHash === input.manifestHash
    && hashAdsActivationManifest(grant.manifest) === input.manifestHash
    && serializeAdsActivationManifest(grant.manifest) === serializeAdsActivationManifest(input.manifest)
}

function rejectionForGrantState(state: ActivationGrantRow['state']): AdsActivationClaimResult {
  switch (state) {
    case AdsActivationGrantStates.approved:
      return { kind: 'rejected', reason: 'operation_conflict' }
    case AdsActivationGrantStates.executing:
    case AdsActivationGrantStates.consumed:
    case AdsActivationGrantStates.unknown:
      return { kind: 'rejected', reason: 'used' }
    case AdsActivationGrantStates.revoked:
      return { kind: 'rejected', reason: 'revoked' }
    case AdsActivationGrantStates.expired:
      return { kind: 'rejected', reason: 'expired' }
    default:
      throw internalError('Ads activation grant has an invalid state')
  }
}

function validateGrantBinding(
  grant: ActivationGrantRow | undefined,
  input: AdsActivationClaimInput,
): AdsActivationClaimResult | undefined {
  if (!grant) return { kind: 'rejected', reason: 'grant_not_found' }
  if (grant.projectId !== input.projectId) {
    return { kind: 'rejected', reason: 'project_mismatch' }
  }
  if (grant.adAccountId !== input.adAccountId) {
    return { kind: 'rejected', reason: 'account_mismatch' }
  }
  if (!sameManifest(grant, input)) {
    return { kind: 'rejected', reason: 'manifest_mismatch' }
  }
  if (grant.executorApiKeyId !== input.executorApiKeyId) {
    return { kind: 'rejected', reason: 'executor_mismatch' }
  }
  return undefined
}

function createActivationStore(
  app: FastifyInstance,
  request?: FastifyRequest,
): AdsActivationStore {
  const audit = (entry: Parameters<typeof auditFromRequest>[1]) => request
    ? auditFromRequest(request, entry)
    : { ...entry, actor: 'system', userAgent: 'canonry-activation-watchdog' }
  return {
    claimGrantAndOperation: async (input) => app.db.transaction((tx) => {
      const grantRow = tx.select().from(adsActivationGrants)
        .where(eq(adsActivationGrants.id, input.grantId)).get()
      const bindingRejection = validateGrantBinding(grantRow, input)
      if (bindingRejection) return bindingRejection
      const grant = grantRow!

      const existing = tx.select().from(adsOperations).where(and(
        eq(adsOperations.projectId, input.projectId),
        eq(adsOperations.operationKey, input.operationKey),
      )).get()
      if (existing) {
        if (
          existing.requestHash !== input.requestHash
          || existing.kind !== AdsOperationKinds.campaign_tree_activate
          || existing.adAccountId !== input.adAccountId
          || existing.entityType !== AdsActivationEntityTypes.campaign
          || existing.entityId !== input.manifest.campaign.id
        ) {
          return { kind: 'rejected', reason: 'operation_conflict' } satisfies AdsActivationClaimResult
        }
        if (grant.operationId !== existing.id) {
          return rejectionForGrantState(grant.state)
        }
        const canonical = loadCanonicalActivation(tx, grant.id, existing.id)
        if (existing.state !== AdsOperationStates.pending) {
          return { kind: 'replay', ...canonical } satisfies AdsActivationClaimResult
        }
        if (grant.state !== AdsActivationGrantStates.executing) {
          return rejectionForGrantState(grant.state)
        }
        if (
          existing.leaseOwner !== null
          && existing.leaseOwner !== input.leaseOwner
          && existing.leaseExpiresAt !== null
          && existing.leaseExpiresAt > input.now
        ) {
          return { kind: 'busy', ...canonical } satisfies AdsActivationClaimResult
        }
        const claimed = tx.update(adsOperations).set({
          leaseOwner: input.leaseOwner,
          leaseExpiresAt: input.leaseExpiresAt,
          updatedAt: input.now,
        }).where(and(
          eq(adsOperations.id, existing.id),
          eq(adsOperations.state, AdsOperationStates.pending),
          or(
            isNull(adsOperations.leaseOwner),
            eq(adsOperations.leaseOwner, input.leaseOwner),
            isNull(adsOperations.leaseExpiresAt),
            lte(adsOperations.leaseExpiresAt, input.now),
          ),
        )).run()
        const resumed = loadCanonicalActivation(tx, grant.id, existing.id)
        return claimed.changes > 0
          ? { kind: 'resumed', ...resumed } satisfies AdsActivationClaimResult
          : { kind: 'busy', ...resumed } satisfies AdsActivationClaimResult
      }

      if (grant.state !== AdsActivationGrantStates.approved) {
        return rejectionForGrantState(grant.state)
      }
      const expiresAt = Date.parse(grant.expiresAt)
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(input.now)) {
        const expired = tx.update(adsActivationGrants).set({
          state: AdsActivationGrantStates.expired,
          expiredAt: input.now,
          updatedAt: input.now,
        }).where(and(
          eq(adsActivationGrants.id, grant.id),
          eq(adsActivationGrants.state, AdsActivationGrantStates.approved),
        )).run()
        if (expired.changes === 1) {
          writeAuditLog(tx, audit({
            projectId: input.projectId,
            actor: 'api',
            action: 'ads.activation_grant.expired',
            entityType: 'ads-activation-grant',
            entityId: grant.id,
            diff: { executorApiKeyId: input.executorApiKeyId },
          }))
        }
        return { kind: 'rejected', reason: 'expired' } satisfies AdsActivationClaimResult
      }

      tx.insert(adsOperations).values({
        id: input.operationId,
        projectId: input.projectId,
        adAccountId: input.adAccountId,
        operationKey: input.operationKey,
        requestHash: input.requestHash,
        kind: AdsOperationKinds.campaign_tree_activate,
        state: AdsOperationStates.pending,
        entityType: AdsActivationEntityTypes.campaign,
        entityId: input.manifest.campaign.id,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.leaseExpiresAt,
        createdAt: input.now,
        updatedAt: input.now,
      }).run()
      const grantClaim = tx.update(adsActivationGrants).set({
        state: AdsActivationGrantStates.executing,
        operationId: input.operationId,
        executionStartedAt: input.now,
        updatedAt: input.now,
      }).where(and(
        eq(adsActivationGrants.id, grant.id),
        eq(adsActivationGrants.projectId, input.projectId),
        eq(adsActivationGrants.adAccountId, input.adAccountId),
        eq(adsActivationGrants.state, AdsActivationGrantStates.approved),
        isNull(adsActivationGrants.operationId),
      )).run()
      if (grantClaim.changes !== 1) {
        throw alreadyExists('Ads activation grant', grant.id)
      }
      for (let offset = 0; offset < input.steps.length; offset += ACTIVATION_STEP_INSERT_BATCH_SIZE) {
        tx.insert(adsOperationSteps)
          .values(input.steps.slice(offset, offset + ACTIVATION_STEP_INSERT_BATCH_SIZE))
          .run()
      }
      writeAuditLog(tx, audit({
        projectId: input.projectId,
        actor: 'api',
        action: 'ads.campaign_tree_activate.claimed',
        entityType: 'ads-activation-grant',
        entityId: grant.id,
        diff: {
          operationId: input.operationId,
          operationKey: input.operationKey,
          manifestHash: input.manifestHash,
          executorApiKeyId: input.executorApiKeyId,
        },
      }))
      return {
        kind: 'claimed',
        ...loadCanonicalActivation(tx, grant.id, input.operationId),
      } satisfies AdsActivationClaimResult
    }, { behavior: 'immediate' }),

    loadGrant: async (grantId) => loadActivationGrant(app.db, grantId),

    renewLease: async (input) => app.db.transaction((tx) => {
      const changed = tx.update(adsOperations).set({
        leaseExpiresAt: input.leaseExpiresAt,
        updatedAt: input.now,
      }).where(and(
        eq(adsOperations.id, input.operationId),
        eq(adsOperations.state, AdsOperationStates.pending),
        eq(adsOperations.leaseOwner, input.leaseOwner),
        gt(adsOperations.leaseExpiresAt, input.now),
      )).run()
      const operation = loadActivationOperation(tx, input.operationId)
      if (!operation) throw internalError('Ads activation receipt was not found')
      return { applied: changed.changes === 1, operation }
    }, { behavior: 'immediate' }),

    releaseLease: async (input) => app.db.transaction((tx) => {
      const changed = tx.update(adsOperations).set({
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: input.now,
      }).where(and(
        eq(adsOperations.id, input.operationId),
        eq(adsOperations.state, AdsOperationStates.pending),
        eq(adsOperations.leaseOwner, input.leaseOwner),
      )).run()
      const operation = loadActivationOperation(tx, input.operationId)
      if (!operation) throw internalError('Ads activation receipt was not found')
      return { applied: changed.changes === 1, operation }
    }, { behavior: 'immediate' }),

    authorizeStep: async (input: AdsActivationStepAuthorizationInput) => app.db.transaction((tx) => {
      if (
        input.fromState !== AdsOperationStepStates.pending
        || input.next.state !== AdsOperationStepStates.executing
      ) {
        throw internalError('Ads activation forward authorization transition is invalid')
      }
      const grant = tx.select().from(adsActivationGrants).where(and(
        eq(adsActivationGrants.id, input.grantId),
        eq(adsActivationGrants.operationId, input.operationId),
      )).get()
      const operation = loadActivationOperation(tx, input.operationId)
      if (!grant || !operation) throw internalError('Ads activation authorization binding was not found')
      if (grant.revocationRequestedAt !== null || grant.state === AdsActivationGrantStates.revoked) {
        return { applied: false, operation, rejection: 'revoked' as const }
      }
      if (grant.state !== AdsActivationGrantStates.executing) {
        return { applied: false, operation }
      }
      const expiresAt = Date.parse(grant.expiresAt)
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(input.now)) {
        return { applied: false, operation, rejection: 'expired' as const }
      }

      const existing = tx.select().from(adsOperationSteps).where(and(
        eq(adsOperationSteps.id, input.next.id),
        eq(adsOperationSteps.operationId, input.operationId),
      )).get()
      if (!existing) throw internalError('Ads activation step was not found')
      const immutableMismatch = existing.ordinal !== input.next.ordinal
        || existing.entityType !== input.next.entityType
        || existing.entityId !== input.next.entityId
        || existing.expectedUpdatedAt !== input.next.expectedUpdatedAt
        || existing.createdAt !== input.next.createdAt
      if (immutableMismatch) {
        throw internalError('Ads activation step identity changed during authorization')
      }

      const lease = tx.update(adsOperations).set({
        leaseExpiresAt: input.leaseExpiresAt,
        updatedAt: input.next.updatedAt,
      }).where(and(
        eq(adsOperations.id, input.operationId),
        eq(adsOperations.state, AdsOperationStates.pending),
        eq(adsOperations.leaseOwner, input.leaseOwner),
        gt(adsOperations.leaseExpiresAt, input.next.updatedAt),
      )).run()
      if (lease.changes !== 1 || existing.state !== input.fromState) {
        const current = loadActivationOperation(tx, input.operationId)
        if (!current) throw internalError('Ads activation receipt was not found')
        return { applied: false, operation: current }
      }
      const changed = tx.update(adsOperationSteps).set({
        state: input.next.state,
        providerUpdatedAt: input.next.providerUpdatedAt,
        errorCode: input.next.errorCode,
        errorMessage: input.next.errorMessage,
        remediation: input.next.remediation,
        startedAt: input.next.startedAt,
        finishedAt: input.next.finishedAt,
        updatedAt: input.next.updatedAt,
      }).where(and(
        eq(adsOperationSteps.id, input.next.id),
        eq(adsOperationSteps.operationId, input.operationId),
        eq(adsOperationSteps.state, input.fromState),
      )).run()
      const current = loadActivationOperation(tx, input.operationId)
      if (!current) throw internalError('Ads activation receipt was not found')
      return { applied: changed.changes === 1, operation: current }
    }, { behavior: 'immediate' }),

    transitionStep: async (input: AdsActivationStepTransitionInput) => app.db.transaction((tx) => {
      const existing = tx.select().from(adsOperationSteps).where(and(
        eq(adsOperationSteps.id, input.next.id),
        eq(adsOperationSteps.operationId, input.operationId),
      )).get()
      if (!existing) throw internalError('Ads activation step was not found')
      const immutableMismatch = existing.ordinal !== input.next.ordinal
        || existing.entityType !== input.next.entityType
        || existing.entityId !== input.next.entityId
        || existing.expectedUpdatedAt !== input.next.expectedUpdatedAt
        || existing.createdAt !== input.next.createdAt
      if (immutableMismatch) {
        throw internalError('Ads activation step identity changed during execution')
      }

      const lease = tx.update(adsOperations).set({
        leaseExpiresAt: input.leaseExpiresAt,
        updatedAt: input.next.updatedAt,
      }).where(and(
        eq(adsOperations.id, input.operationId),
        eq(adsOperations.state, AdsOperationStates.pending),
        eq(adsOperations.leaseOwner, input.leaseOwner),
        gt(adsOperations.leaseExpiresAt, input.next.updatedAt),
      )).run()
      if (lease.changes !== 1 || existing.state !== input.fromState) {
        const operation = loadActivationOperation(tx, input.operationId)
        if (!operation) throw internalError('Ads activation receipt was not found')
        return { applied: false, operation }
      }

      const changed = tx.update(adsOperationSteps).set({
        state: input.next.state,
        providerUpdatedAt: input.next.providerUpdatedAt,
        errorCode: input.next.errorCode,
        errorMessage: input.next.errorMessage,
        remediation: input.next.remediation,
        startedAt: input.next.startedAt,
        finishedAt: input.next.finishedAt,
        updatedAt: input.next.updatedAt,
      }).where(and(
        eq(adsOperationSteps.id, input.next.id),
        eq(adsOperationSteps.operationId, input.operationId),
        eq(adsOperationSteps.state, input.fromState),
      )).run()
      const operation = loadActivationOperation(tx, input.operationId)
      if (!operation) throw internalError('Ads activation receipt was not found')
      return { applied: changed.changes === 1, operation }
    }, { behavior: 'immediate' }),

    finishOperation: async (input) => app.db.transaction((tx) => {
      const currentGrant = tx.select().from(adsActivationGrants).where(and(
        eq(adsActivationGrants.id, input.grantId),
        eq(adsActivationGrants.operationId, input.operationId),
      )).get()
      if (!currentGrant) throw internalError('Ads activation grant was not found')
      if (
        currentGrant.revocationRequestedAt !== null
        && input.operationState === AdsOperationStates.succeeded
      ) {
        throw new AdsActivationError(
          AdsActivationErrorCodes.grantRevoked,
          'Ads activation grant was revoked before execution completed',
          409,
        )
      }
      const grantExpired = Date.parse(currentGrant.expiresAt) <= Date.parse(input.now)
      if (grantExpired && input.operationState === AdsOperationStates.succeeded) {
        throw new AdsActivationError(
          AdsActivationErrorCodes.grantExpired,
          'Ads activation grant expired before execution completed',
          409,
        )
      }
      const effectiveGrantState = input.operationState === AdsOperationStates.unknown
        ? AdsActivationGrantStates.unknown
        : input.grantState
      const campaignStep = tx.select().from(adsOperationSteps).where(and(
        eq(adsOperationSteps.operationId, input.operationId),
        eq(adsOperationSteps.entityType, AdsActivationEntityTypes.campaign),
      )).get()
      const operationUpdate = tx.update(adsOperations).set({
        state: input.operationState,
        upstreamUpdatedAt: input.operationState === AdsOperationStates.succeeded
          ? campaignStep?.providerUpdatedAt ?? null
          : null,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: input.now,
      }).where(and(
        eq(adsOperations.id, input.operationId),
        eq(adsOperations.state, AdsOperationStates.pending),
        eq(adsOperations.leaseOwner, input.leaseOwner),
        gt(adsOperations.leaseExpiresAt, input.now),
      )).run()

      if (operationUpdate.changes === 1) {
        const grantUpdate = tx.update(adsActivationGrants).set({
          state: effectiveGrantState,
          consumedAt: effectiveGrantState === AdsActivationGrantStates.consumed ? input.now : null,
          updatedAt: input.now,
        }).where(and(
          eq(adsActivationGrants.id, input.grantId),
          eq(adsActivationGrants.operationId, input.operationId),
          eq(adsActivationGrants.state, AdsActivationGrantStates.executing),
        )).run()
        if (grantUpdate.changes !== 1) {
          throw internalError('Ads activation grant could not be finalized')
        }
        const operation = tx.select().from(adsOperations)
          .where(eq(adsOperations.id, input.operationId)).get()
        writeAuditLog(tx, audit({
          projectId: operation?.projectId,
          actor: 'api',
          action: `ads.campaign_tree_activate.${input.operationState}`,
          entityType: AdsActivationEntityTypes.campaign,
          entityId: operation?.entityId,
          diff: { operationId: input.operationId, operationKey: operation?.operationKey, grantId: input.grantId },
        }))
      }

      const canonical = loadCanonicalActivation(tx, input.grantId, input.operationId)
      return { applied: operationUpdate.changes === 1, ...canonical }
    }, { behavior: 'immediate' }),
  }
}

function countManifest(manifest: AdsActivationGrantDto['manifest']): {
  adGroupCount: number
  adCount: number
} {
  return {
    adGroupCount: manifest.campaign.adGroups.length,
    adCount: manifest.campaign.adGroups.reduce((count, group) => count + group.ads.length, 0),
  }
}

function requireAuthenticatedKey(request: FastifyRequest): NonNullable<FastifyRequest['apiKey']> {
  if (!request.apiKey) {
    throw forbidden('Ads activation approval and execution require an authenticated API key')
  }
  return request.apiKey
}

function mapActivationError(error: AdsActivationError, request: {
  grantId: string
  operationKey: string
}): AppError {
  const details = {
    activationCode: error.code,
    grantId: request.grantId,
    operationKey: request.operationKey,
    ...(error.operation ? { operationId: error.operation.id } : {}),
  }
  if (error.code === AdsActivationErrorCodes.grantNotFound) {
    return notFound('Ads activation grant', request.grantId)
  }
  if (
    error.code === AdsActivationErrorCodes.grantExecutorMismatch
    || error.code === AdsActivationErrorCodes.grantProjectMismatch
  ) {
    return forbidden('This API key cannot execute the requested ads activation', details)
  }
  if (error.code === AdsActivationErrorCodes.operationConflict) {
    return alreadyExists('Ads operation key', request.operationKey)
  }
  if (error.statusCode >= 500) {
    if (error.statusCode === 502) return providerError(error.message, details)
    return internalError('Ads activation persistence failed', details)
  }
  return new AppError('VALIDATION_ERROR', error.message, error.statusCode, details)
}

function mapApprovalPreflightError(error: AdsActivationError): AppError {
  const details = {
    activationCode: error.code,
    ...(error.entity ? error.entity : {}),
  }
  if (error.statusCode >= 500) {
    if (error.statusCode === 502) return providerError(error.message, details)
    return internalError('Ads activation approval preflight failed', details)
  }
  return validationError(error.message, details)
}

function activationResponse(
  opts: AdsActivationRoutesOptions,
  grant: AdsActivationGrantDto,
  operation: AdsActivationOperationRecord,
): AdsActivateTreeResponse {
  const { steps: _steps, ...operationRow } = operation
  return adsActivateTreeResponseSchema.parse({
    grant,
    operation: opts.toOperationDto(operationRow),
    steps: operation.steps,
  })
}

function terminalActivationResponse(
  app: FastifyInstance,
  opts: AdsActivationRoutesOptions,
  grant: ActivationGrantRow,
  operationKey: string,
): AdsActivateTreeResponse | undefined {
  if (!grant.operationId) return undefined
  const canonical = loadCanonicalActivation(app.db, grant.id, grant.operationId)
  if (canonical.operation.operationKey !== operationKey) {
    throw new AdsActivationError(
      AdsActivationErrorCodes.grantUsed,
      'Ads activation grant has already been used',
      409,
    )
  }
  const expectedRequestHash = hashAdsActivationOperationRequest({
    projectId: grant.projectId,
    adAccountId: grant.adAccountId,
    grantId: grant.id,
    manifestHash: grant.manifestHash,
    executorApiKeyId: grant.executorApiKeyId,
  })
  if (
    canonical.operation.projectId !== grant.projectId
    || canonical.operation.adAccountId !== grant.adAccountId
    || canonical.operation.requestHash !== expectedRequestHash
    || canonical.operation.entityType !== AdsActivationEntityTypes.campaign
    || canonical.operation.entityId !== grant.manifest.campaign.id
  ) {
    throw internalError('Ads activation receipt binding is invalid')
  }
  if (canonical.operation.state === AdsOperationStates.pending) return undefined
  const validTerminalPair = canonical.operation.state === AdsOperationStates.succeeded
    ? canonical.grant.state === AdsActivationGrantStates.consumed
    : canonical.operation.state === AdsOperationStates.unknown
      ? canonical.grant.state === AdsActivationGrantStates.unknown
      : canonical.grant.state === AdsActivationGrantStates.consumed
  if (!validTerminalPair) {
    throw internalError('Ads activation terminal state is inconsistent')
  }
  return activationResponse(opts, canonical.grant, canonical.operation)
}

async function executeActivationGrant(
  app: FastifyInstance,
  opts: AdsActivationRoutesOptions,
  request: FastifyRequest | undefined,
  project: { id: string; name: string },
  executorApiKeyId: string,
  grant: ActivationGrantRow,
  operationKey: string,
): Promise<AdsActivateTreeResponse> {
  const runtime = await opts.resolveRuntime(project)
  const result: AdsActivationResult = await executeApprovedAdsActivation({
    store: createActivationStore(app, request),
    provider: runtime.provider,
    leaseMs: opts.leaseMs ?? ACTIVATION_LEASE_MS,
  }, {
    projectId: project.id,
    adAccountId: runtime.adAccountId,
    operationKey,
    grantId: grant.id,
    manifestHash: grant.manifestHash,
    executorApiKeyId,
    manifest: grant.manifest,
  })
  return activationResponse(opts, result.grant, result.operation)
}

function selectWatchdogOperations(
  app: FastifyInstance,
  nowIso: string,
  batchSize: number,
  allowLiveRevocationLease: boolean,
): OperationRow[] {
  const leaseAvailable = or(
    isNull(adsOperations.leaseOwner),
    isNull(adsOperations.leaseExpiresAt),
    lte(adsOperations.leaseExpiresAt, nowIso),
  )
  const campaignHasMutationEvidence = or(
    eq(adsOperationSteps.state, AdsOperationStepStates.executing),
    eq(adsOperationSteps.state, AdsOperationStepStates.active),
    eq(adsOperationSteps.state, AdsOperationStepStates.rollback_executing),
    eq(adsOperationSteps.state, AdsOperationStepStates.rollback_failed),
    eq(adsOperationSteps.state, AdsOperationStepStates.unknown),
  )
  const eligibleState = allowLiveRevocationLease
    ? or(
        eq(adsOperations.state, AdsOperationStates.unknown),
        and(
          eq(adsOperations.state, AdsOperationStates.pending),
          or(
            isNotNull(adsActivationGrants.revocationRequestedAt),
            and(leaseAvailable, campaignHasMutationEvidence),
          ),
        ),
      )
    : and(
        or(
          eq(adsOperations.state, AdsOperationStates.unknown),
          eq(adsOperations.state, AdsOperationStates.pending),
        ),
        leaseAvailable,
      )
  const freshRevocationPriority = sql<number>`CASE
    WHEN ${adsActivationGrants.revocationRequestedAt} IS NOT NULL
      AND (
        ${adsOperations.lastReconciledAt} IS NULL
        OR ${adsOperations.lastReconciledAt} < ${adsActivationGrants.revocationRequestedAt}
      )
    THEN 0
    ELSE 1
  END`
  const roundRobinCursor = allowLiveRevocationLease
    ? adsOperations.lastReconciledAt
    : adsOperations.updatedAt
  return app.db.select({ operation: adsOperations })
    .from(adsOperations)
    .leftJoin(
      adsActivationGrants,
      eq(adsActivationGrants.operationId, adsOperations.id),
    )
    .leftJoin(
      adsOperationSteps,
      and(
        eq(adsOperationSteps.operationId, adsOperations.id),
        eq(adsOperationSteps.entityType, AdsActivationEntityTypes.campaign),
      ),
    )
    .where(and(
      eq(adsOperations.kind, AdsOperationKinds.campaign_tree_activate),
      eligibleState,
    ))
    .orderBy(
      asc(freshRevocationPriority),
      asc(roundRobinCursor),
      asc(adsOperations.updatedAt),
    )
    .limit(batchSize)
    .all()
    .map((row) => row.operation)
}

function selectRecoveryWatchdogOperations(
  app: FastifyInstance,
  nowIso: string,
  batchSize: number,
): OperationRow[] {
  return selectWatchdogOperations(app, nowIso, batchSize, false)
}

function validateWatchdogContainmentBinding(
  app: FastifyInstance,
  opts: AdsActivationRoutesOptions,
  operation: OperationRow,
  grant: ActivationGrantRow,
): boolean {
  const terminal = terminalActivationResponse(app, opts, grant, operation.operationKey)
  if (terminal) {
    return terminal.operation.state === AdsOperationStates.unknown
  }
  if (
    operation.state === AdsOperationStates.pending
    && grant.state !== AdsActivationGrantStates.executing
  ) {
    throw internalError('Ads activation containment binding is invalid')
  }
  return true
}

async function containWatchdogCampaign(
  app: FastifyInstance,
  opts: AdsActivationRoutesOptions,
  operation: OperationRow,
  grant: ActivationGrantRow,
  project: typeof projects.$inferSelect,
): Promise<AdsActivationRuntime | undefined> {
  try {
    if (!validateWatchdogContainmentBinding(app, opts, operation, grant)) {
      return undefined
    }
    const runtime = await opts.resolveRuntime(project)
    if (
      runtime.adAccountId !== operation.adAccountId
      || runtime.adAccountId !== grant.adAccountId
    ) {
      throw new AdsActivationError(
        AdsActivationErrorCodes.grantAccountMismatch,
        'Activation containment is bound to another OpenAI ad account',
        409,
      )
    }
    const contained = await enforceAdsActivationCampaignBoundarySafety(
      runtime.provider,
      grant.manifest.campaign.id,
    )
    if (contained) {
      app.log.warn({ operationId: operation.id }, 'Ads activation campaign boundary was safety-paused')
    } else {
      app.log.error({ operationId: operation.id }, 'Ads activation campaign boundary could not be verified paused')
    }
    return runtime
  } catch {
    app.log.error({ operationId: operation.id }, 'Ads activation campaign boundary containment failed')
    return undefined
  }
}

/**
 * Fast fleet pass: contain only the campaign boundary for urgent receipts.
 * It has its own scheduler singleflight so slow descendant cleanup cannot
 * suppress later campaign-pause ticks. lastReconciledAt is the round-robin
 * cursor, preventing an old terminal receipt from monopolizing every batch.
 */
export async function containUrgentAdsActivationCampaignsOnce(
  app: FastifyInstance,
  opts: AdsActivationRoutesOptions,
): Promise<void> {
  const startedAt = new Date().toISOString()
  const batchSize = Math.min(100, Math.max(1, opts.watchdogBatchSize ?? 10))
  const operations = selectWatchdogOperations(app, startedAt, batchSize, true)
  await Promise.all(operations.map(async (operation) => {
    const grant = app.db.select().from(adsActivationGrants)
      .where(eq(adsActivationGrants.operationId, operation.id)).get()
    const project = app.db.select().from(projects)
      .where(eq(projects.id, operation.projectId)).get()
    if (grant && project) {
      await containWatchdogCampaign(app, opts, operation, grant, project)
    } else {
      app.log.error(
        { operationId: operation.id },
        'Ads activation campaign boundary has an invalid receipt binding',
      )
    }
    app.db.update(adsOperations).set({
      lastReconciledAt: new Date().toISOString(),
    }).where(and(
      eq(adsOperations.id, operation.id),
      or(
        eq(adsOperations.state, AdsOperationStates.unknown),
        eq(adsOperations.state, AdsOperationStates.pending),
      ),
    )).run()
  }))
}

export async function sweepStaleAdsActivationsOnce(
  app: FastifyInstance,
  opts: AdsActivationRoutesOptions,
): Promise<void> {
  const nowIso = new Date().toISOString()
  const batchSize = Math.min(100, Math.max(1, opts.watchdogBatchSize ?? 10))
  const candidates = selectRecoveryWatchdogOperations(app, nowIso, batchSize)

  const recoverable: Array<{
    operation: OperationRow
    grant: ActivationGrantRow
    project: typeof projects.$inferSelect
  }> = []
  for (const operation of candidates) {
    const grant = app.db.select().from(adsActivationGrants)
      .where(eq(adsActivationGrants.operationId, operation.id)).get()
    const project = app.db.select().from(projects)
      .where(eq(projects.id, operation.projectId)).get()
    if (!grant || !project) {
      app.db.transaction((tx) => {
        const quarantined = tx.update(adsOperations).set({
          state: AdsOperationStates.unknown,
          errorCode: AdsActivationErrorCodes.persistenceFailed,
          errorMessage: 'Activation receipt binding requires manual remediation',
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: nowIso,
        }).where(and(
          eq(adsOperations.id, operation.id),
          or(
            eq(adsOperations.state, AdsOperationStates.unknown),
            and(
              eq(adsOperations.state, AdsOperationStates.pending),
              or(
                isNull(adsOperations.leaseOwner),
                isNull(adsOperations.leaseExpiresAt),
                lte(adsOperations.leaseExpiresAt, nowIso),
              ),
            ),
          ),
        )).run()
        if (
          quarantined.changes === 1
          && operation.state === AdsOperationStates.pending
          && grant
        ) {
          tx.update(adsActivationGrants).set({
            state: AdsActivationGrantStates.unknown,
            updatedAt: nowIso,
          }).where(and(
            eq(adsActivationGrants.id, grant.id),
            eq(adsActivationGrants.operationId, operation.id),
            eq(adsActivationGrants.state, AdsActivationGrantStates.executing),
          )).run()
        }
      }, { behavior: 'immediate' })
      app.log.error({ operationId: operation.id }, 'Ads activation watchdog found an invalid receipt binding')
      continue
    }
    recoverable.push({ operation, grant, project })
  }
  const runtimeByOperationId = new Map<string, AdsActivationRuntime>()
  await Promise.all(recoverable
    .filter(({ operation, grant }) => (
      operation.state === AdsOperationStates.unknown
      || grant.revocationRequestedAt !== null
    ))
    .map(async ({ operation, grant, project }) => {
      const runtime = await containWatchdogCampaign(app, opts, operation, grant, project)
      if (runtime) runtimeByOperationId.set(operation.id, runtime)
    }))

  const markRecoveryIncomplete = (operation: OperationRow): void => {
    const failedAt = new Date().toISOString()
    app.db.update(adsOperations).set({ updatedAt: failedAt }).where(and(
      eq(adsOperations.id, operation.id),
      or(
        eq(adsOperations.state, AdsOperationStates.unknown),
        and(
          eq(adsOperations.state, AdsOperationStates.pending),
          or(
            isNull(adsOperations.leaseOwner),
            isNull(adsOperations.leaseExpiresAt),
            lte(adsOperations.leaseExpiresAt, failedAt),
          ),
        ),
      ),
    )).run()
    app.log.warn({ operationId: operation.id }, 'Ads activation watchdog recovery did not complete')
  }

  // Unknown trees have already had campaign-boundary containment attempted.
  // Clean them concurrently within the bounded batch so one large provider
  // tree cannot monopolize the descendant-cleanup lane; only then resume
  // ordinary pending work.
  await Promise.all(recoverable
    .filter(({ operation }) => operation.state === AdsOperationStates.unknown)
    .map(async ({ operation, grant, project }) => {
      try {
        // Validate every durable binding before touching the provider. The
        // receipt intentionally stays unknown; recurring idempotent pauses are
        // containment, not proof that an ambiguous activation never landed.
        terminalActivationResponse(app, opts, grant, operation.operationKey)
        const runtime = runtimeByOperationId.get(operation.id)
          ?? await opts.resolveRuntime(project)
        if (
          runtime.adAccountId !== operation.adAccountId
          || runtime.adAccountId !== grant.adAccountId
        ) {
          throw new AdsActivationError(
            AdsActivationErrorCodes.grantAccountMismatch,
            'Unknown activation is bound to another OpenAI ad account',
            409,
          )
        }
        const safety = await enforceUnknownAdsActivationSafety(
          runtime.provider,
          grant.manifest,
        )
        app.db.update(adsOperations).set({
          reconcileAttempts: operation.reconcileAttempts + 1,
          lastReconciledAt: new Date().toISOString(),
          errorMessage: safety.fullyVerified
            ? 'Unknown activation was safety-paused; manual remediation is still required'
            : 'Unknown activation safety pause could not be fully verified',
          updatedAt: new Date().toISOString(),
        }).where(and(
          eq(adsOperations.id, operation.id),
          eq(adsOperations.state, AdsOperationStates.unknown),
        )).run()
        if (safety.fullyVerified) {
          app.log.warn({ operationId: operation.id }, 'Unknown ads activation was safety-paused')
        } else {
          app.log.error({ operationId: operation.id }, 'Unknown ads activation could not be fully safety-paused')
        }
      } catch {
        markRecoveryIncomplete(operation)
      }
    }))

  for (const { operation, grant, project } of recoverable) {
    if (operation.state !== AdsOperationStates.pending) continue
    try {
      await executeActivationGrant(
        app,
        opts,
        undefined,
        project,
        grant.executorApiKeyId,
        grant,
        operation.operationKey,
      )
    } catch {
      // The core either released the lease for a safe retry or persisted a
      // terminal/manual-remediation state. Never log provider details here.
      markRecoveryIncomplete(operation)
    }
  }
}

export function registerAdsActivationRoutes(
  app: FastifyInstance,
  opts: AdsActivationRoutesOptions,
): void {
  const watchdogIntervalMs = opts.watchdogIntervalMs ?? 60_000
  let initialWatchdog: ReturnType<typeof setImmediate> | undefined
  let watchdogTimer: ReturnType<typeof setInterval> | undefined
  let boundaryWatchdogPromise: Promise<void> | undefined
  let recoveryWatchdogPromise: Promise<void> | undefined
  let boundaryWatchdogQueued = false
  let watchdogClosing = false
  let startWatchdogSweep: (() => void) | undefined
  if (watchdogIntervalMs > 0) {
    const runRecoverySweep = (): void => {
      if (watchdogClosing || recoveryWatchdogPromise) return
      recoveryWatchdogPromise = sweepStaleAdsActivationsOnce(app, opts)
        .catch(() => app.log.error('Ads activation recovery sweep failed'))
        .finally(() => {
          recoveryWatchdogPromise = undefined
        })
    }
    const runBoundarySweep = (): void => {
      if (watchdogClosing) return
      if (boundaryWatchdogPromise) {
        boundaryWatchdogQueued = true
        return
      }
      boundaryWatchdogQueued = false
      boundaryWatchdogPromise = containUrgentAdsActivationCampaignsOnce(app, opts)
        .catch(() => app.log.error('Ads activation campaign-boundary sweep failed'))
        .finally(() => {
          boundaryWatchdogPromise = undefined
          runRecoverySweep()
          if (boundaryWatchdogQueued) runBoundarySweep()
        })
    }
    startWatchdogSweep = runBoundarySweep
    app.addHook('onReady', async () => {
      // Provider recovery starts only after Fastify finishes its readiness
      // lifecycle, so a stale receipt can never wedge deploy health checks.
      initialWatchdog = setImmediate(runBoundarySweep)
      initialWatchdog.unref()
      watchdogTimer = setInterval(() => {
        runBoundarySweep()
      }, watchdogIntervalMs)
      watchdogTimer.unref()
    })
    app.addHook('onClose', async () => {
      watchdogClosing = true
      if (initialWatchdog) clearImmediate(initialWatchdog)
      if (watchdogTimer) clearInterval(watchdogTimer)
      await Promise.all([boundaryWatchdogPromise, recoveryWatchdogPromise])
    })
  }

  app.post<{ Params: { name: string }; Body: unknown }>(
    '/projects/:name/ads/activation-grants',
    async (request) => {
      requireScope(request, ADS_APPROVE_SCOPE)
      const approver = requireAuthenticatedKey(request)
      const project = resolveProject(app.db, request.params.name)
      const body = parseBody(adsActivationGrantCreateRequestSchema, request.body)
      const now = new Date()
      const expiresAt = Date.parse(body.expiresAt)
      if (
        !Number.isFinite(expiresAt)
        || expiresAt <= now.getTime()
        || expiresAt > now.getTime() + MAX_ACTIVATION_GRANT_LIFETIME_MS
      ) {
        throw validationError('Ads activation grants must expire within the next 24 hours')
      }

      const executor = app.db.select().from(apiKeys)
        .where(eq(apiKeys.id, body.executorApiKeyId)).get()
      if (!executor || executor.revokedAt !== null) {
        throw notFound('Executor API key', body.executorApiKeyId)
      }
      if (executor.id === approver.id) {
        throw validationError('The activation approver and executor must use different API keys')
      }
      if (executor.projectId !== null && executor.projectId !== project.id) {
        throw forbidden('The executor API key is scoped to a different project')
      }
      if (!executor.scopes.includes('*') && !executor.scopes.includes(ADS_ACTIVATE_SCOPE)) {
        throw forbidden(`The executor API key requires the "${ADS_ACTIVATE_SCOPE}" scope`)
      }

      const runtime = await opts.resolveRuntime(project)
      let preflight: Awaited<ReturnType<typeof preflightAdsActivationApproval>>
      try {
        preflight = await preflightAdsActivationApproval(runtime.provider, {
          adAccountId: runtime.adAccountId,
          manifest: body.manifest,
        })
      } catch (error) {
        if (error instanceof AdsActivationError) throw mapApprovalPreflightError(error)
        throw error
      }
      const id = crypto.randomUUID()
      const nowIso = now.toISOString()
      app.db.transaction((tx) => {
        tx.insert(adsActivationGrants).values({
          id,
          projectId: project.id,
          adAccountId: runtime.adAccountId,
          manifestHash: preflight.manifestHash,
          manifest: preflight.manifest,
          executorApiKeyId: executor.id,
          approverApiKeyId: approver.id,
          state: AdsActivationGrantStates.approved,
          expiresAt: body.expiresAt,
          approvedAt: nowIso,
          createdAt: nowIso,
          updatedAt: nowIso,
        }).run()
        writeAuditLog(tx, auditFromRequest(request, {
          projectId: project.id,
          actor: 'api',
          action: 'ads.activation_grant.approved',
          entityType: 'ads-activation-grant',
          entityId: id,
          diff: {
            manifestHash: preflight.manifestHash,
            adAccountId: runtime.adAccountId,
            executorApiKeyId: executor.id,
            expiresAt: body.expiresAt,
            ...countManifest(preflight.manifest),
          },
        }))
      }, { behavior: 'immediate' })
      return adsActivationGrantResponseSchema.parse({
        grant: loadActivationGrant(app.db, id),
      })
    },
  )

  app.post<{ Params: { name: string; grantId: string }; Body: unknown }>(
    '/projects/:name/ads/activation-grants/:grantId/revoke',
    async (request) => {
      requireScope(request, ADS_APPROVE_SCOPE)
      const revoker = requireAuthenticatedKey(request)
      const project = resolveProject(app.db, request.params.name)
      parseBody(
        adsActivationGrantRevokeRequestSchema,
        request.body === undefined ? {} : request.body,
      )
      const existing = app.db.select().from(adsActivationGrants).where(and(
        eq(adsActivationGrants.id, request.params.grantId),
        eq(adsActivationGrants.projectId, project.id),
      )).get()
      if (!existing) throw notFound('Ads activation grant', request.params.grantId)

      const grant = app.db.transaction((tx) => {
        const current = tx.select().from(adsActivationGrants).where(and(
          eq(adsActivationGrants.id, request.params.grantId),
          eq(adsActivationGrants.projectId, project.id),
        )).get()
        if (!current) throw notFound('Ads activation grant', request.params.grantId)
        if (
          current.state === AdsActivationGrantStates.consumed
          && current.revocationRequestedAt !== null
        ) {
          return toGrantDto(current)
        }
        if (current.state === AdsActivationGrantStates.consumed) {
          throw validationError('A completed ads activation grant cannot be revoked')
        }
        if (
          current.state === AdsActivationGrantStates.revoked
          || current.state === AdsActivationGrantStates.expired
          || (
            (
              current.state === AdsActivationGrantStates.executing
              || current.state === AdsActivationGrantStates.unknown
            )
            && current.revocationRequestedAt !== null
          )
        ) {
          return toGrantDto(current)
        }
        const nowIso = new Date().toISOString()
        const cancellationRequested = current.state === AdsActivationGrantStates.executing
          || current.state === AdsActivationGrantStates.unknown
        const expired = !cancellationRequested && Date.parse(current.expiresAt) <= Date.parse(nowIso)
        if (cancellationRequested) {
          tx.update(adsActivationGrants).set({
            revocationRequestedAt: nowIso,
            updatedAt: nowIso,
          }).where(and(
            eq(adsActivationGrants.id, current.id),
            eq(adsActivationGrants.state, current.state),
            isNull(adsActivationGrants.revocationRequestedAt),
          )).run()
        } else {
          tx.update(adsActivationGrants).set({
            state: expired ? AdsActivationGrantStates.expired : AdsActivationGrantStates.revoked,
            revokedAt: expired ? null : nowIso,
            expiredAt: expired ? nowIso : null,
            updatedAt: nowIso,
          }).where(and(
            eq(adsActivationGrants.id, current.id),
            eq(adsActivationGrants.state, AdsActivationGrantStates.approved),
          )).run()
        }
        writeAuditLog(tx, auditFromRequest(request, {
          projectId: project.id,
          actor: 'api',
          action: expired
            ? 'ads.activation_grant.expired'
            : cancellationRequested
              ? 'ads.activation_grant.revocation_requested'
              : 'ads.activation_grant.revoked',
          entityType: 'ads-activation-grant',
          entityId: current.id,
          diff: { revokerApiKeyId: revoker.id },
        }))
        const updated = tx.select().from(adsActivationGrants)
          .where(eq(adsActivationGrants.id, current.id)).get()
        if (!updated) throw internalError('Ads activation grant disappeared during revocation')
        return toGrantDto(updated)
      }, { behavior: 'immediate' })
      if (
        grant.revocationRequestedAt !== null
        && (
          grant.state === AdsActivationGrantStates.executing
          || grant.state === AdsActivationGrantStates.unknown
        )
      ) {
        startWatchdogSweep?.()
      }
      return adsActivationGrantResponseSchema.parse({ grant })
    },
  )

  app.post<{ Params: { name: string; id: string }; Body: unknown }>(
    '/projects/:name/ads/campaigns/:id/activate-tree',
    async (request) => {
      requireScope(request, ADS_ACTIVATE_SCOPE)
      const executor = requireAuthenticatedKey(request)
      const project = resolveProject(app.db, request.params.name)
      const body = parseBody(adsActivateTreeRequestSchema, request.body)
      const grant = app.db.select().from(adsActivationGrants).where(and(
        eq(adsActivationGrants.id, body.grantId),
        eq(adsActivationGrants.projectId, project.id),
      )).get()
      if (!grant) throw notFound('Ads activation grant', body.grantId)
      if (grant.executorApiKeyId !== executor.id) {
        throw forbidden('This API key cannot execute the requested ads activation')
      }
      if (grant.manifest.campaign.id !== request.params.id) {
        throw validationError('The activation grant does not match the requested campaign')
      }
      if (grant.manifestHash !== body.manifestHash) {
        throw validationError('The activation grant does not match the requested manifest hash')
      }
      try {
        const terminal = terminalActivationResponse(app, opts, grant, body.operationKey)
        if (terminal) return terminal
        return await executeActivationGrant(
          app,
          opts,
          request,
          project,
          executor.id,
          grant,
          body.operationKey,
        )
      } catch (error) {
        if (error instanceof AdsActivationError) {
          throw mapActivationError(error, {
            grantId: body.grantId,
            operationKey: body.operationKey,
          })
        }
        throw error
      }
    },
  )

  app.post<{
    Params: { name: string; operationKey: string }
    Body: unknown
  }>('/projects/:name/ads/operations/:operationKey/resume-activation', async (request) => {
    requireScope(request, ADS_ACTIVATE_SCOPE)
    const executor = requireAuthenticatedKey(request)
    const project = resolveProject(app.db, request.params.name)
    if (request.body !== undefined) {
      throw validationError('Ads activation recovery does not accept a request body')
    }
    const operation = app.db.select().from(adsOperations).where(and(
      eq(adsOperations.projectId, project.id),
      eq(adsOperations.operationKey, request.params.operationKey),
    )).get()
    if (!operation || operation.kind !== AdsOperationKinds.campaign_tree_activate) {
      throw notFound('Ads activation operation', request.params.operationKey)
    }
    const grant = app.db.select().from(adsActivationGrants).where(and(
      eq(adsActivationGrants.projectId, project.id),
      eq(adsActivationGrants.operationId, operation.id),
    )).get()
    if (!grant) throw internalError('Ads activation receipt has no approval grant')
    if (grant.executorApiKeyId !== executor.id) {
      throw forbidden('This API key cannot resume the requested ads activation')
    }
    try {
      const terminal = terminalActivationResponse(
        app,
        opts,
        grant,
        request.params.operationKey,
      )
      if (terminal) return terminal
      return await executeActivationGrant(
        app,
        opts,
        request,
        project,
        executor.id,
        grant,
        request.params.operationKey,
      )
    } catch (error) {
      if (error instanceof AdsActivationError) {
        throw mapActivationError(error, {
          grantId: grant.id,
          operationKey: request.params.operationKey,
        })
      }
      throw error
    }
  })
}
