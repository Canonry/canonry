/**
 * Intent classifier for search queries — brand / lead-gen / industry / other.
 *
 * Pure: takes a query string + a precomputed brand-token list. The caller
 * builds the brand tokens once per project (or per render) and passes them
 * in, so the function stays cacheable and reusable across the report
 * builder, CLI text views, dashboards, and Aero's reasoning.
 *
 * Brand matching uses "compact" tokens — strip every non-alphanumeric
 * character on both sides — so "demand iq", "demandiq", "demand-iq",
 * "Demand IQ" all match a brand built from the canonical domain
 * "demand-iq.com".
 */

export type QueryCategory = 'brand' | 'lead-gen' | 'industry' | 'other'

const TRANSACTIONAL_RE = /\b(buy|price|pricing|cost|hire|near me|services?|agency|consultant|company)\b/i
const INFORMATIONAL_RE = /\b(what|how|why|when|guide|tutorial|vs|versus|alternatives?|examples?|definition)\b/i

const MIN_BRAND_TOKEN_LENGTH = 3

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Build the compact brand-token list for a project. The caller passes this
 * into `categorizeQueryByIntent` to drive brand matching.
 *
 * Sources:
 *   1. The canonical domain with its TLD stripped — e.g. `demand-iq.com` → `demandiq`.
 *   2. Each brand name (displayName plus any aliases) — only when its compact
 *      form is at least `MIN_BRAND_TOKEN_LENGTH` and not already covered.
 *
 * Tokens shorter than `MIN_BRAND_TOKEN_LENGTH` are dropped to prevent
 * false-positive matches on common short strings (e.g. brand "x.io" → "x").
 */
export function buildBrandTokens(canonicalDomain: string, brandNames: readonly string[] = []): string[] {
  const seen = new Set<string>()
  const stem = canonicalDomain.toLowerCase().replace(/\.[a-z]{2,}$/, '')
  const stemCompact = compact(stem)
  if (stemCompact.length >= MIN_BRAND_TOKEN_LENGTH) seen.add(stemCompact)
  for (const name of brandNames) {
    if (!name) continue
    const nameCompact = compact(name)
    if (nameCompact.length >= MIN_BRAND_TOKEN_LENGTH) seen.add(nameCompact)
  }
  return [...seen]
}

export function categorizeQueryByIntent(query: string, brandTokens: string[]): QueryCategory {
  const compactQuery = compact(query)
  if (brandTokens.length > 0 && brandTokens.some((t) => compactQuery.includes(t))) {
    return 'brand'
  }
  if (TRANSACTIONAL_RE.test(query)) return 'lead-gen'
  if (INFORMATIONAL_RE.test(query)) return 'industry'
  return 'other'
}
