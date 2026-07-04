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

/**
 * Lowercase + de-dupe id tokens (view ids or project-tab keys), preserving
 * first-seen order; an empty result becomes `undefined` (= "all", never an
 * allowlist of nothing). Shared by the server's boot config resolution and the
 * per-request embed override below.
 */
export function normalizeIdTokens(raw: string[]): string[] | undefined {
  if (raw.length === 0) return undefined
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of raw) {
    const id = token.toLowerCase()
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out.length > 0 ? out : undefined
}

/**
 * Parse a per-request theme override header (`X-Canonry-Embed-Theme`, a plain
 * JSON object string the Embed v2 `/e` proxy sets per dashboard) into a flat
 * `Record<string,string>`. STRUCTURAL defense-in-depth only: caps the header
 * size, keeps only string keys/values within length bounds, and bounds the key
 * count — the VALUE-level guards (color form / font-family / mode enum) live in
 * the SPA's `embedThemeStyle` / `embedThemeMode`, which apply these values. A
 * malformed / oversized / non-object header yields `undefined` (keep boot theme).
 */
function parseThemeOverride(raw: string | string[] | undefined): Record<string, string> | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (Object.keys(out).length >= 12) break
    if (typeof k !== 'string' || k.length === 0 || k.length > 32) continue
    if (typeof v !== 'string' || v.length > 256) continue
    out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * The client-config block for ONE request: the boot-resolved embed settings, but
 * with `projectTabs` and `theme` replaced by per-request overrides when present.
 * The Embed v2 platform `/e` proxy sets those overrides (the `X-Canonry-Embed-Tabs`
 * / `X-Canonry-Embed-Theme` headers it controls per dashboard); the end client
 * cannot reach the loopback engine to set them. An absent / empty override keeps
 * the boot-wide value. Presentational only, NOT a security boundary: the API key
 * scope governs data access, and the SPA sanitizes every theme value it applies.
 */
export function embedClientConfigForRequest(
  resolved: ResolvedEmbedConfig,
  projectTabsOverride: string | string[] | undefined,
  themeOverride?: string | string[],
): EmbedClientConfig | undefined {
  const base = buildEmbedClientConfig(resolved)
  if (!base) return undefined
  const tabs = normalizeIdTokens(splitList(projectTabsOverride))
  const theme = parseThemeOverride(themeOverride)
  let out = base
  if (tabs) out = { ...out, projectTabs: tabs }
  if (theme) out = { ...out, theme }
  return out
}

/**
 * JSON-serialize a value for SAFE embedding inside an inline `<script>` element
 * (used for `window.__CANONRY_CONFIG__`). `JSON.stringify` escapes `"` but NOT
 * `<` / `>` / `&`, so a value containing `</script>` would terminate the script
 * element early (the classic JSON-in-HTML-script XSS). This escapes those plus
 * the JS line separators (U+2028 / U+2029) to their equivalent `\uXXXX` JSON
 * escapes: the output parses to the identical value but can never break out of
 * the `<script>`. Defense in depth — the embed projectTabs override is the first
 * request-derived value to reach this script, and the engine cannot assume the
 * fronting proxy strips a client-tainted header.
 */
export function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
