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

/**
 * Build an absolute URL for a path stored against a project domain. GSC
 * returns most landing pages as path-only strings (`/blog/foo`), and storing
 * them that way is correct — but rendering them as `<a href="/blog/foo">` in
 * a report HTML file makes the browser resolve the path against whatever host
 * the file is served from (often the canonry dashboard host or `file://`).
 * This helper prepends `https://<canonicalDomain>` so the link resolves to
 * the project's actual site instead. Already-absolute URLs (http/https) and
 * protocol-relative URLs (`//host/...`) are returned unchanged. Returns the
 * input as-is when it can't be confidently absolutized.
 */
export function absolutizeProjectUrl(
  url: string | null | undefined,
  canonicalDomain: string,
): string {
  if (!url) return ''
  const trimmed = url.trim()
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  const host = canonicalDomain.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  if (!host) return trimmed
  if (trimmed.startsWith('/')) return `https://${host}${trimmed}`
  // Bare paths or domain-prefixed strings are ambiguous — treat as paths.
  return `https://${host}/${trimmed}`
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
  trimmed = trimmed.replace(/([a-z0-9])[).]+$/i, '$1')

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

/**
 * Normalize a USER-TYPED domain (e.g. from an onboarding input) to a bare
 * lowercase hostname, or null when the input can't be a domain.
 *
 * Accepts the messy real-world forms — `https://www.acme.com/path`,
 * `Acme.com`, `acme.com:8080`, `user:pass@acme.com`, `acme.com?q=1`,
 * `münchen.de` — and returns the crawlable host (`acme.com`,
 * `xn--mnchen-3ya.de`). Built on WHATWG `URL` parsing (linear, no
 * backtracking) so port/userinfo/path/query are stripped rather than
 * merged into the host, and IDN is punycoded instead of mangled.
 *
 * Returns null (caller decides the error shape) for empty input, parse
 * failures, single-label hosts, and hosts shorter than 4 chars.
 */
export function normalizeUserDomainInput(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return null
  let host: string
  try {
    host = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`).hostname
  } catch {
    return null
  }
  if (host.startsWith('www.')) host = host.slice(4)
  if (host.endsWith('.')) host = host.slice(0, -1)
  // URL.hostname is already constrained, but keep a conservative final
  // gate: bare-ASCII registrable-domain shape with at least one dot.
  if (!host.includes('.') || host.length < 4) return null
  if (!/^[a-z0-9.-]+$/.test(host)) return null
  return host
}
