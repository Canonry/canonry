/**
 * Intent classifier for search queries — brand / lead-gen / industry / other.
 *
 * Pure: takes a query string + a precomputed brand-token list. The caller
 * builds the brand tokens once per project (or per render) and passes them
 * in, so the function stays cacheable and reusable across the report
 * builder, CLI text views, dashboards, and Aero's reasoning.
 *
 * Brand matching uses the shared exact identity matcher: approved aliases
 * tolerate case, spacing, and punctuation presentation variants, but never
 * suffix stripping, substring guesses, or edit-distance matches.
 */

import {
  brandKeyFromText,
  brandLabelFromDomain,
  textContainsAnyBrandAlias,
} from '@ainyc/canonry-contracts'

export type QueryCategory = 'brand' | 'lead-gen' | 'industry' | 'other'

const TRANSACTIONAL_RE = /\b(?:buy|price|pricing|cost|hire|near me|services?|agency|consultant|company)\b/i
const INFORMATIONAL_RE = /\b(?:what|how|why|when|guide|tutorial|vs|versus|alternatives?|examples?|definition)\b/i

const MIN_BRAND_TOKEN_LENGTH = 3

/**
 * Build the normalized brand identity list for a project. The caller passes this
 * into `categorizeQueryByIntent` to drive brand matching.
 *
 * Sources:
 *   1. The canonical domain with its TLD stripped — e.g. `vexlo-iq.test` → `vexloiq`.
 *   2. Each approved brand name (displayName plus aliases) — only when its normalized
 *      form is at least `MIN_BRAND_TOKEN_LENGTH` and not already covered.
 *
 * Tokens shorter than `MIN_BRAND_TOKEN_LENGTH` are dropped to prevent
 * false-positive matches on common short strings (e.g. brand "x.io" → "x").
 */
export function buildBrandTokens(canonicalDomain: string, brandNames: readonly string[] = []): string[] {
  const seen = new Set<string>()
  const stemCompact = brandKeyFromText(brandLabelFromDomain(canonicalDomain))
  if (stemCompact.length >= MIN_BRAND_TOKEN_LENGTH) seen.add(stemCompact)
  for (const name of brandNames) {
    if (!name) continue
    const nameCompact = brandKeyFromText(name)
    if (nameCompact.length >= MIN_BRAND_TOKEN_LENGTH) seen.add(nameCompact)
  }
  return [...seen]
}

export function categorizeQueryByIntent(query: string, brandTokens: string[]): QueryCategory {
  if (textContainsAnyBrandAlias(query, brandTokens)) {
    return 'brand'
  }
  if (TRANSACTIONAL_RE.test(query)) return 'lead-gen'
  if (INFORMATIONAL_RE.test(query)) return 'industry'
  return 'other'
}
