/**
 * URL path canonicalization. Used to give every captured URL a stable
 * identity for joins, aggregation, and de-duplication. The strip-list is
 * deliberately conservative: only parameters that we know don't change the
 * page identity are removed.
 */

const STRIP_KEYS: ReadonlySet<string> = new Set([
  // Click identifiers
  'fbclid',
  'gclid',
  'msclkid',
  'ttclid',
  'li_fat_id',
  'igshid',
  'yclid',
  'dclid',
  'gbraid',
  'wbraid',
  'bingid',
  // Mailchimp
  'mc_cid',
  'mc_eid',
  // Google Analytics linkers
  '_ga',
  '_gl',
  // Google Tag Manager debug
  'gtm_latency',
  'gtm_debug',
  // WordPress internal noise
  'preview',
  'preview_id',
  'preview_nonce',
  '_thumbnail_id',
  // Common cache-busters/versioning
  'v',
  'ver',
  'version',
])

interface QueryPair {
  key: string
  /** null for flag-style params with no `=` (e.g. `?flag`); '' for `?flag=` */
  value: string | null
}

function shouldStrip(key: string): boolean {
  if (STRIP_KEYS.has(key)) return true
  if (key.startsWith('utm_')) return true
  return false
}

function parseQuery(query: string): QueryPair[] {
  if (query === '') return []
  return query.split('&').map((pair) => {
    const eq = pair.indexOf('=')
    if (eq === -1) return { key: pair, value: null }
    return { key: pair.slice(0, eq), value: pair.slice(eq + 1) }
  })
}

function encodeQuery(pairs: readonly QueryPair[]): string {
  return pairs.map((p) => (p.value === null ? p.key : `${p.key}=${p.value}`)).join('&')
}

function collapseRootIndex(path: string): string {
  if (path === '/index.html' || path === '/index.php') return '/'
  return path
}

function dropTrailingSlash(path: string): string {
  if (path.length > 1 && path.endsWith('/')) {
    return path.replace(/\/+$/, '')
  }
  return path
}

export function normalizeUrlPath(input: string | null | undefined): string | null {
  if (input == null) return null
  let trimmed = input.trim()
  if (trimmed === '') return null

  // Pre-normalization artifact cleanup (GA artifacts, Slack/doc copy-paste)
  trimmed = trimmed
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (trimmed === '' || trimmed === '/') return '/'
  if (trimmed === '(not set)') return null

  // Strip trailing punctuation that likely isn't part of a slug (e.g. trailing dot or parenthesis)
  // but only if it's not a root / and it's not preceded by another punctuation (avoid stripping actual file extensions)
  trimmed = trimmed.replace(/([a-zA-Z0-9])([).]+)$/, '$1')

  // Special case for artifacts like "/) open" -> "/"
  if (trimmed.startsWith('/)') || trimmed.startsWith('/ ')) {
    trimmed = '/'
  }
  if (trimmed.includes(' ')) {
    trimmed = trimmed.split(' ')[0]
  }
  if (trimmed === '' || trimmed === '/') return '/'

  let pathPart: string
  let queryPart: string

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      return null
    }
    pathPart = url.pathname || '/'
    queryPart = url.search.startsWith('?') ? url.search.slice(1) : url.search
  } else {
    let raw = trimmed
    const hashIdx = raw.indexOf('#')
    if (hashIdx !== -1) raw = raw.slice(0, hashIdx)
    const qIdx = raw.indexOf('?')
    if (qIdx === -1) {
      pathPart = raw
      queryPart = ''
    } else {
      pathPart = raw.slice(0, qIdx)
      queryPart = raw.slice(qIdx + 1)
    }
  }

  if (pathPart === '') pathPart = '/'
  pathPart = collapseRootIndex(pathPart)
  pathPart = dropTrailingSlash(pathPart)

  const pairs = parseQuery(queryPart).filter((p) => !shouldStrip(p.key))
  pairs.sort((a, b) => {
    if (a.key < b.key) return -1
    if (a.key > b.key) return 1
    return 0
  })

  if (pairs.length === 0) return pathPart
  return `${pathPart}?${encodeQuery(pairs)}`
}
