/**
 * Pure URL ↔ query matcher for the content recommendation engine.
 *
 * Used to decide "do we already have a page for this query?" when GSC
 * doesn't yet have an exact-query entry. Two-stage match:
 *
 * 1. Substring: query slugified (`best crm for saas` → `best-crm-for-saas`)
 *    appears in the URL path. High-confidence positive.
 * 2. Token overlap: ≥ minOverlap (default 2) meaningful tokens shared
 *    between path and query, after stopwords removed.
 */

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'to',
  'was',
  'were',
  'will',
  'with',
])

interface MatchOpts {
  /** Minimum number of meaningful (non-stopword) tokens that must overlap. */
  minOverlap?: number
}

export function matchesQuery(url: string, query: string, opts: MatchOpts = {}): boolean {
  const minOverlap = opts.minOverlap ?? 2
  const path = extractPath(url).toLowerCase()
  const queryNormalized = query.trim().toLowerCase()

  if (!path || !queryNormalized) return false

  const queryAsSlug = queryNormalized.replace(/\s+/g, '-')
  if (path.includes(queryAsSlug)) return true

  const pathTokens = tokenize(path)
  const queryTokens = tokenize(queryNormalized)
  let overlap = 0
  for (const token of queryTokens) {
    if (pathTokens.has(token)) overlap += 1
  }
  return overlap >= minOverlap
}

function extractPath(url: string): string {
  if (!url) return ''
  const match = /^https?:\/\/[^/]+(.*)$/.exec(url)
  const path = match ? match[1] : url
  const stripped = path.replace(/\/$/, '')
  return stripped || '/'
}

function tokenize(value: string): Set<string> {
  const tokens = value
    .split(/[/\s\-_.]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
  return new Set(tokens)
}
