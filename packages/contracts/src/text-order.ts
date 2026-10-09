/**
 * Locale-independent string ordering. `compareText` orders by UTF-16 code
 * unit, so unlike `localeCompare` the result never depends on the runtime's
 * locale or ICU data.
 */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** The distinct values, sorted with `compareText`. */
export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText)
}
