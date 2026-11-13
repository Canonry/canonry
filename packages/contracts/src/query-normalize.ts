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

/**
 * Each query once, in order: the first spelling of every text that
 * `normalizeQueryText` reads as the same query, trimmed, with blanks dropped.
 * This is how a tracked-query list collapses on save, so a count taken from it
 * is the number of queries that will be stored.
 */
export function uniqueQueryTexts(texts: Iterable<string>): string[] {
  const seen = new Set<string>()
  const queries: string[] = []
  for (const text of texts) {
    const query = text.trim()
    const key = normalizeQueryText(query)
    if (!key || seen.has(key)) continue
    seen.add(key)
    queries.push(query)
  }
  return queries
}

/**
 * Selection and query-control text identity used by the api-routes
 * measurement readers and query tracking: compatibility-normalized (NFKC),
 * trimmed, internal whitespace collapsed, and lowercased with the `en`
 * locale. Lowercasing is not Unicode case folding, so `Straße` and `STRASSE`
 * stay distinct. Those readers key rows on it, so they share this one
 * definition. Unlike {@link normalizeQueryText}, it collapses internal
 * whitespace.
 */
export function normalizeIdentityText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en')
}
