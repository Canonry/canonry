/** Narrow an unknown object for defensive access to external JSON fields. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * A value read from external JSON as text: a string as-is, a number, boolean or bigint
 * spelled out, an array or object as its JSON, and null, undefined or anything else as "".
 * Use it instead of `String(value)`, which turns an object into "[object Object]".
 */
export function jsonValueText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (value !== null && typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? ''
    } catch {
      return ''
    }
  }
  return ''
}
