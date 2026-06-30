/**
 * Read-only embed mode (issue #716) — pure, dependency-free helpers shared by
 * the local server (which resolves config + emits the framing header), the CLI,
 * and the web SPA (which reads the injected client block).
 *
 * Two surfaces consume this module, so it lives in `contracts`: the server
 * normalizes origins + builds the `Content-Security-Policy: frame-ancestors`
 * value, and the SPA reads the `EmbedClientConfig` block injected into
 * `window.__CANONRY_CONFIG__`. Everything here is value→value (no I/O), so it
 * is exhaustively unit-testable.
 */

/**
 * The `embed:` block as it appears (un-validated) in `~/.canonry/config.yaml`.
 * Mirrors the other config blocks — a bare TS interface, not a Zod schema —
 * because the local config file is parsed without validation by convention.
 */
export interface EmbedConfigEntry {
  /** Opt-in switch. Off (or absent) keeps the default serve byte-for-byte unchanged. */
  enabled?: boolean
  /**
   * Origins permitted to frame the dashboard. Each is normalized to a bare
   * origin (scheme + host + optional non-default port). An empty / all-invalid
   * list fails CLOSED to `frame-ancestors 'none'`.
   */
  allowOrigins?: string[]
  /** Optional allowlist of view ids the embed may render (omit = all views). */
  views?: string[]
  /**
   * Optional allowlist of PROJECT TAB keys the embedded project page may render
   * (`overview`, `technical-aeo`, `search-console`, `activity`, `backlinks`, ...).
   * Finer-grained than `views` (which only gates whole top-level routes): the
   * project page collapses to one `project` view, so this is the only lever that
   * can hide individual operator tabs from the embedded client dashboard. Omit =
   * all tabs.
   */
  projectTabs?: string[]
  /** Optional CSS custom-property overrides for the host page (sanitized client-side). */
  theme?: Record<string, string>
}

/** The fully-resolved embed settings the server acts on (env merged over config). */
export interface ResolvedEmbedConfig {
  enabled: boolean
  /** Normalized, de-duped origins. NEVER sent to the client. */
  allowedOrigins: string[]
  /** Normalized view allowlist; `undefined` means "all views" (never `[]`). */
  views?: string[]
  /** Normalized project-tab allowlist; `undefined` means "all tabs" (never `[]`). */
  projectTabs?: string[]
  theme?: Record<string, string>
}

/**
 * The presentational block injected into `window.__CANONRY_CONFIG__.embed`.
 * Carries ONLY what the SPA needs to render chromeless — never `allowedOrigins`
 * (a server-only framing concern) and never any credential.
 */
export interface EmbedClientConfig {
  enabled: true
  views?: string[]
  /** Project-tab allowlist; `undefined` means "all tabs". */
  projectTabs?: string[]
  theme?: Record<string, string>
}

/** The CSP keyword for same-origin framing, passed through verbatim when configured. */
const SELF_TOKEN = "'self'"

/**
 * Normalize one configured framing source into a bare CSP origin, or `null`
 * when it is not a usable `frame-ancestors` source expression.
 *
 * Accepts `http(s)://host[:port]` and the literal `'self'`. Rejects (→ `null`)
 * wildcards (`*`, `*.host` — would make the page clickjackable from attacker
 * subdomains), paths/queries/fragments, userinfo, bare hostnames, and
 * non-http(s) schemes. Lowercases scheme + host and drops default ports.
 */
export function normalizeFrameOrigin(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed === SELF_TOKEN) return SELF_TOKEN
  // A wildcard host can never be a safe allowlist entry. Reject before parsing
  // (the URL parser is lenient about `*` in some positions).
  if (trimmed.includes('*')) return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  // Userinfo (`user:pass@`) is silently dropped by `.origin`; reject explicitly.
  if (url.username || url.password) return null
  // An origin source expression carries no path/query/fragment.
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) return null
  if (!url.hostname) return null

  // `.origin` already lowercases scheme + host and omits default ports (80/443).
  return url.origin
}

/**
 * Split a comma/whitespace-delimited list (string or string[]) into trimmed,
 * de-duped, non-empty tokens, preserving first-seen order.
 */
export function splitList(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return []
  const tokens = (Array.isArray(raw) ? raw : [raw]).flatMap((entry) =>
    String(entry).split(/[\s,]+/),
  )
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of tokens) {
    const trimmed = token.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

/**
 * Parse a configured origin list into normalized, de-duped CSP origins.
 * Junk entries are dropped; an all-invalid list collapses to `[]` (which the
 * header builder then fails closed to `'none'`).
 */
export function parseOriginList(raw: string | string[] | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of splitList(raw)) {
    const origin = normalizeFrameOrigin(token)
    if (!origin || seen.has(origin)) continue
    seen.add(origin)
    out.push(origin)
  }
  return out
}

/**
 * Build the `Content-Security-Policy` value for the SPA document. Fails CLOSED:
 * an empty origin list yields `frame-ancestors 'none'` (NOT an empty source
 * list, which browsers treat as fail-open). Only the `frame-ancestors`
 * directive is emitted, so it never forces `'unsafe-inline'` and cannot break
 * the injected inline config script or Tailwind inline styles.
 */
export function frameAncestorsHeaderValue(origins: readonly string[]): string {
  if (origins.length === 0) return "frame-ancestors 'none'"
  return `frame-ancestors ${origins.join(' ')}`
}

/**
 * Project the resolved embed settings down to the client-facing block.
 * Returns `undefined` when embed is disabled (so the injected config stays
 * byte-for-byte unchanged) and never leaks `allowedOrigins`.
 */
export function buildEmbedClientConfig(resolved: ResolvedEmbedConfig): EmbedClientConfig | undefined {
  if (!resolved.enabled) return undefined
  const client: EmbedClientConfig = { enabled: true }
  if (resolved.views && resolved.views.length > 0) client.views = resolved.views
  if (resolved.projectTabs && resolved.projectTabs.length > 0) client.projectTabs = resolved.projectTabs
  if (resolved.theme && Object.keys(resolved.theme).length > 0) client.theme = resolved.theme
  return client
}
