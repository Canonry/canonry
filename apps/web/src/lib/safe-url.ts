/**
 * Returns a safe `href` value for anchor tags that render URLs from
 * provider grounding sources, citations, or any other LLM-influenced
 * surface. Anything that isn't an absolute http(s) URL, a root-relative
 * path, or a `mailto:` link collapses to `null` — callers should render
 * the value as text instead of an anchor in that case.
 *
 * React 19 still blocks `javascript:` URLs at the renderer today, but
 * the behavior is deprecated and `data:`/other schemes are not blocked
 * at all. Guarding at the data layer prevents an attacker who can plant
 * a `javascript:` or `data:text/html,...` URI in a cited source from
 * landing a navigable link in the live dashboard.
 */
export function safeExternalUrl(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return null
  if (trimmed.startsWith('/')) return trimmed
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^mailto:/i.test(trimmed)) return trimmed
  return null
}
