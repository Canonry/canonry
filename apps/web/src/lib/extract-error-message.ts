/**
 * Normalize an unknown thrown value into a human-readable message.
 *
 * Any `Error` (including subclasses such as the API client's `ApiError`)
 * yields its `.message`; anything else is coerced with `String()`.
 */
export function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
