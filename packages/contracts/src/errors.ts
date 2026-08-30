export type ErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'VALIDATION_ERROR'
  | 'AUTH_REQUIRED'
  | 'AUTH_INVALID'
  | 'FORBIDDEN'
  | 'QUOTA_EXCEEDED'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_AUTH'
  | 'NO_PROVIDER'
  | 'NO_QUERIES'
  | 'RUN_IN_PROGRESS'
  | 'OPERATION_IN_PROGRESS'
  | 'UNSUPPORTED_KIND'
  | 'RUN_NOT_CANCELLABLE'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL_ERROR'
  | 'DELIVERY_FAILED'
  | 'AGENT_BUSY'
  | 'MISSING_DEPENDENCY'
  | 'RUNTIME_STATE_MISSING'
  | 'MEASUREMENT_PLAN_REVISION_CONFLICT'
  | 'MEASUREMENT_COMPILED_CHECKSUM_CONFLICT'
  | 'MEASUREMENT_RUN_REVISION_MISMATCH'
  | 'MEASUREMENT_DRAFT_ETAG_REQUIRED'
  | 'MEASUREMENT_DRAFT_ETAG_STALE'
  | 'MEASUREMENT_IDEMPOTENCY_KEY_REQUIRED'
  | 'MEASUREMENT_IDEMPOTENCY_KEY_CONFLICT'
  | 'RESEARCH_PROMOTION_PREVIEW_CONFLICT'

export class AppError extends Error {
  readonly code: ErrorCode
  readonly statusCode: number
  readonly details?: Record<string, unknown>

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    }
  }
}

export function notFound(entity: string, id: string): AppError {
  return new AppError('NOT_FOUND', `${entity} '${id}' not found`, 404)
}

export function alreadyExists(entity: string, id: string): AppError {
  return new AppError('ALREADY_EXISTS', `${entity} '${id}' already exists`, 409)
}

export function validationError(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('VALIDATION_ERROR', message, 400, details)
}

export function authRequired(message = 'Authentication required'): AppError {
  return new AppError('AUTH_REQUIRED', message, 401)
}

export function authInvalid(): AppError {
  return new AppError('AUTH_INVALID', 'Invalid API key', 401)
}

export function forbidden(message = 'Forbidden', details?: Record<string, unknown>): AppError {
  return new AppError('FORBIDDEN', message, 403, details)
}

export function quotaExceeded(metric: string, details?: Record<string, unknown>): AppError {
  return new AppError('QUOTA_EXCEEDED', `Quota exceeded for ${metric}`, 429, details)
}

export function providerError(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('PROVIDER_ERROR', message, 502, details)
}

/**
 * An upstream answer provider rejected our credentials.
 *
 * Deliberately NOT `authInvalid`: that is 401 and means the CALLER's canonry
 * key is bad, and the dashboard's response interceptor treats any 401 as an
 * expired session and signs the user out. A stale Gemini key must never log
 * someone out of their own instance, so this is a 502 like every other
 * upstream failure, with its own code so callers can tell it apart from a
 * network blip.
 */
export function providerAuthError(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('PROVIDER_AUTH', message, 502, details)
}

export function noProvider(projectName: string, details?: Record<string, unknown>): AppError {
  return new AppError(
    'NO_PROVIDER',
    `No runnable answer provider is configured for '${projectName}'. Configure a provider before starting a run.`,
    503,
    { projectName, ...details },
  )
}

export function noQueries(projectName: string): AppError {
  return new AppError(
    'NO_QUERIES',
    `Project '${projectName}' has no tracked queries. Add at least one query before starting a run.`,
    422,
    { projectName },
  )
}

export function runInProgress(projectName: string): AppError {
  return new AppError('RUN_IN_PROGRESS', `A run is already in progress for '${projectName}'`, 409)
}

export function operationInProgress(
  message: string,
  details?: Record<string, unknown>,
): AppError {
  return new AppError('OPERATION_IN_PROGRESS', message, 409, details)
}

export function measurementPlanRevisionConflict(
  expectedActiveRevision: number | null,
  actualActiveRevision: number | null,
): AppError {
  return new AppError(
    'MEASUREMENT_PLAN_REVISION_CONFLICT',
    'The active measurement plan changed. Reload it before publishing.',
    409,
    { expectedActiveRevision, actualActiveRevision },
  )
}

/**
 * The recompile at publish time produced different content than the operator
 * reviewed. Nothing is written: republishing a document nobody looked at is the
 * failure this prevents.
 */
export function measurementCompiledChecksumConflict(
  expectedCompiledChecksum: string,
  actualCompiledChecksum: string,
): AppError {
  return new AppError(
    'MEASUREMENT_COMPILED_CHECKSUM_CONFLICT',
    'The compiled measurement plan changed after it was reviewed. Reload the review and publish again.',
    409,
    { expectedCompiledChecksum, actualCompiledChecksum },
  )
}

/** A research-promotion preview is a projection checksum, never a compiled-plan checksum. */
export function researchPromotionPreviewConflict(
  expectedPreviewChecksum: string,
  actualPreviewChecksum: string,
): AppError {
  return new AppError(
    'RESEARCH_PROMOTION_PREVIEW_CONFLICT',
    'The research promotion changed after it was previewed. Reload the promotion preview and confirm again.',
    409,
    { expectedPreviewChecksum, actualPreviewChecksum },
  )
}

/**
 * A report was asked to display a run pinned to a different plan revision.
 * Joining across revisions would compare two different sets of questions, so
 * the request is refused rather than answered with a mixed basis.
 */
export function measurementRunRevisionMismatch(
  runId: string,
  runRevision: number,
  activeRevision: number | null,
): AppError {
  return new AppError(
    'MEASUREMENT_RUN_REVISION_MISMATCH',
    `Run '${runId}' measured plan revision ${runRevision}, not the active revision. Select a run pinned to the active revision.`,
    422,
    { runId, runRevision, activeRevision },
  )
}

/** A draft mutation arrived without `If-Match`, so it cannot be shown to be acting on what the caller saw. */
export function measurementDraftEtagRequired(): AppError {
  return new AppError(
    'MEASUREMENT_DRAFT_ETAG_REQUIRED',
    'This action requires the current draft ETag in `If-Match`. Reload the draft and retry.',
    428,
  )
}

export function measurementDraftEtagStale(expectedEtag: string, actualEtag: string): AppError {
  return new AppError(
    'MEASUREMENT_DRAFT_ETAG_STALE',
    'The measurement draft changed since it was loaded. Reload it and retry.',
    412,
    { expectedEtag, actualEtag },
  )
}

export function measurementIdempotencyKeyRequired(operation: string): AppError {
  return new AppError(
    'MEASUREMENT_IDEMPOTENCY_KEY_REQUIRED',
    `The '${operation}' action requires an \`Idempotency-Key\` header.`,
    400,
    { operation },
  )
}

/** Same key, different content: replaying a receipt over a changed request would silently apply the wrong one. */
export function measurementIdempotencyKeyConflict(operation: string): AppError {
  return new AppError(
    'MEASUREMENT_IDEMPOTENCY_KEY_CONFLICT',
    `The \`Idempotency-Key\` for '${operation}' was already used with a different request body.`,
    409,
    { operation },
  )
}

export function runNotCancellable(runId: string, status: string): AppError {
  return new AppError('RUN_NOT_CANCELLABLE', `Run '${runId}' is already in terminal state '${status}' and cannot be cancelled`, 409)
}

export function unsupportedKind(kind: string): AppError {
  return new AppError('UNSUPPORTED_KIND', `Kind '${kind}' is not supported in this version`, 400)
}

export function notImplemented(message: string): AppError {
  return new AppError('NOT_IMPLEMENTED', message, 501)
}

export function deliveryFailed(message: string): AppError {
  return new AppError('DELIVERY_FAILED', message, 502)
}

export function agentBusy(projectName: string): AppError {
  return new AppError(
    'AGENT_BUSY',
    `Aero is already running a turn for '${projectName}'. Retry after the current turn settles.`,
    409,
  )
}

export function missingDependency(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('MISSING_DEPENDENCY', message, 422, details)
}

export function internalError(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('INTERNAL_ERROR', message, 500, details)
}

/**
 * Fires when a runtime-essential file (DB or config) the daemon opened at
 * boot has been removed from disk while the daemon is still running. SQLite
 * holds the inode open through `unlink`, so the daemon would otherwise keep
 * serving stale data from an orphaned file with no surfacing — operator
 * deletes `~/.canonry/data.db` expecting a clean slate, daemon happily
 * returns the old projects, UI looks wrong. This 503 fails loud so the
 * operator knows to restart `canonry serve`.
 */
export function runtimeStateMissing(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('RUNTIME_STATE_MISSING', message, 503, details)
}

/**
 * Render an unknown caught value as human-readable text for a log line, an
 * error field, or a message to the operator.
 *
 * `catch (err)` binds `unknown`, and the reflex is
 * `err instanceof Error ? err.message : String(err)`. That `String(err)` is
 * the problem: a thrown plain object renders `[object Object]`, so the one
 * line written to explain a failure explains nothing, and the detail is gone
 * by the time anyone reads it. Rejected promises from HTTP and SDK layers
 * throw non-`Error` objects often enough for this to be the common case, not
 * the exotic one.
 *
 * Never throws — a helper on the failure path that can itself fail would
 * replace a logged error with a crash.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err === null || err === undefined) return 'unknown error'
  try {
    // lib.es5.d.ts types this `string`, but it genuinely returns `undefined`
    // for a function or symbol input. The assertion corrects the lib, so the
    // guard below is real rather than "unnecessary".
    const json = JSON.stringify(err) as string | undefined
    if (json !== undefined) return json
  } catch {
    // Circular references and BigInt both make JSON.stringify throw.
  }
  try {
    // The one intentional base-to-string in the monorepo. Reaching it means
    // JSON.stringify already declined the value, so '[object Object]' here is
    // the floor rather than the careless default the rule exists to catch.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return String(err)
  } catch {
    // A null-prototype or throwing-`toString` object cannot be stringified.
    return 'unknown error'
  }
}
