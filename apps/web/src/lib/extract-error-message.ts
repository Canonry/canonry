/**
 * Structured view of an unknown thrown value from an API call.
 *
 * Two error shapes reach a component: an `ApiError` (Error subclass carrying
 * `code` + `details`, thrown by the `api.ts` wrappers) and the raw envelope
 * `{ error: { code, message, details } }` that the generated SDK throws when
 * `throwOnError: true` (the path TanStack Query's `fetchQuery`/hooks take).
 * This normalizes both so callers can branch on `code` / `details` without
 * caring which path produced the error.
 */
export interface ApiErrorInfo {
  message: string
  code?: string
  details?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Normalize an unknown thrown value into `{ message, code?, details? }`.
 * Handles `ApiError` (duck-typed to avoid a circular import with api.ts), the
 * raw `{ error: { … } }` SDK envelope, plain `Error`s, and strings.
 */
export function extractApiErrorInfo(error: unknown): ApiErrorInfo {
  if (error instanceof Error) {
    const e = error as Error & { code?: unknown; details?: unknown }
    return {
      message: error.message,
      code: typeof e.code === 'string' ? e.code : undefined,
      details: isRecord(e.details) ? e.details : undefined,
    }
  }
  if (isRecord(error)) {
    const inner = (error as { error?: unknown }).error
    if (isRecord(inner)) {
      return {
        message: typeof inner.message === 'string' ? inner.message : 'Request failed',
        code: typeof inner.code === 'string' ? inner.code : undefined,
        details: isRecord(inner.details) ? inner.details : undefined,
      }
    }
    if (typeof inner === 'string') return { message: inner }
    const flatMessage = (error as { message?: unknown }).message
    if (typeof flatMessage === 'string') return { message: flatMessage }
  }
  if (typeof error === 'string') return { message: error }
  return { message: String(error) }
}

/**
 * Normalize an unknown thrown value into a human-readable message.
 *
 * Any `Error` (including subclasses such as the API client's `ApiError`)
 * yields its `.message`; the raw `{ error: { message } }` SDK envelope yields
 * its inner message; anything else is coerced with `String()`.
 */
export function extractErrorMessage(error: unknown): string {
  return extractApiErrorInfo(error).message
}
