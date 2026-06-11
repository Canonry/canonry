export type ErrorCode =
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'VALIDATION_ERROR'
  | 'AUTH_REQUIRED'
  | 'AUTH_INVALID'
  | 'FORBIDDEN'
  | 'QUOTA_EXCEEDED'
  | 'PROVIDER_ERROR'
  | 'RUN_IN_PROGRESS'
  | 'UNSUPPORTED_KIND'
  | 'RUN_NOT_CANCELLABLE'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL_ERROR'
  | 'DELIVERY_FAILED'
  | 'AGENT_BUSY'
  | 'MISSING_DEPENDENCY'
  | 'RUNTIME_STATE_MISSING'

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

export function authInvalid(message = 'Invalid API key'): AppError {
  return new AppError('AUTH_INVALID', message, 401)
}

export function forbidden(message = 'Forbidden'): AppError {
  return new AppError('FORBIDDEN', message, 403)
}

export function quotaExceeded(metric: string): AppError {
  return new AppError('QUOTA_EXCEEDED', `Quota exceeded for ${metric}`, 429)
}

export function providerError(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('PROVIDER_ERROR', message, 502, details)
}

export function runInProgress(projectName: string): AppError {
  return new AppError('RUN_IN_PROGRESS', `A run is already in progress for '${projectName}'`, 409)
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
