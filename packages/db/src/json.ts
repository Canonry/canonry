/**
 * Safely parse a JSON text column from SQLite.
 * Returns `fallback` when the value is null, undefined, empty, or invalid JSON.
 */
export function parseJsonColumn<T>(value: string | null | undefined, fallback: T): T {
  if (value == null || value === '') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
