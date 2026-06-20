/**
 * Tracked-query text canonicalization. Used to give a query string a stable
 * identity for de-duplication and for matching snapshot `query_text` back to a
 * tracked query row when the foreign key has been nulled (ON DELETE SET NULL).
 * Deliberately minimal: trim surrounding whitespace and lowercase. It must NOT
 * strip punctuation or collapse internal whitespace — two queries that differ
 * only by those are genuinely different tracked baskets.
 */
export function normalizeQueryText(value: string): string {
  return value.trim().toLowerCase()
}
