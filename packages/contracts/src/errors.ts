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

export function authRequired(): AppError {
  return new AppError('AUTH_REQUIRED', 'Authentication required', 401)
}

export function authInvalid(): AppError {
  return new AppError('AUTH_INVALID', 'Invalid API key', 401)
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
