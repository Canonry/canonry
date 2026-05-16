import { brandLabelFromDomain, normalizeProjectDomain, registrableDomain } from './project.js'
import type { MentionState, VisibilityState } from './run.js'

const GENERIC_TOKENS = new Set([
  'agency',
  'app',
  'company',
  'corp',
  'group',
  'health',
  'inc',
  'llc',
  'online',
  'platform',
  'services',
  'site',
  'solutions',
  'software',
  'systems',
  'tech',
])

// Minimum length of the whitespace-stripped brand key required to allow a
// "loose" match across word boundaries (e.g. registered "azcoatings" matching
// "AZ Coatings" in answer text). Below this, fall back to the strict
// space-preserving comparison so short names like "Acme" don't false-match
// adjacent words.
const MIN_BRAND_KEY_LENGTH = 6

// Trailing legal/corporate classifiers stripped from a registered brand name
// before matching, so a project named "AZ Coatings LLC" (or "azcoatingsllc")
// matches an answer that mentions just "AZ Coatings". Sorted longest-first so
// "incorporated" is tried before "inc". Stricter than GENERIC_TOKENS — only
// classifiers that are unambiguous suffixes, never industry words like "tech".
const BUSINESS_SUFFIXES = [
  'incorporated',
  'corporation',
  'limited',
  'company',
  'gmbh',
  'pllc',
  'corp',
  'group',
  'llp',
  'plc',
  'llc',
  'inc',
  'ltd',
]

export interface AnswerMentionResult {
  mentioned: boolean
  matchedTerms: string[]
}

export function extractAnswerMentions(
  answerText: string | null | undefined,
  brandNames: string[],
  domains: string[],
): AnswerMentionResult {
  if (!answerText) return { mentioned: false, matchedTerms: [] }

  const matchedTerms: string[] = []
  const lowerAnswer = answerText.toLowerCase()

  for (const domain of domains) {
    const normalizedDomain = normalizeProjectDomain(domain)
    if (!normalizedDomain || !normalizedDomain.includes('.')) continue
    if (domainMentioned(lowerAnswer, normalizedDomain)) {
      matchedTerms.push(normalizedDomain)
    }
  }

  // Strong-match path: each brand name is its own identity. A single hit on
  // any name fires (e.g. project "LlamaIndex" with aliases ["LlamaParse"] —
  // an answer mentioning only "LlamaParse" matches via this path).
  const answerNormalized = normalizeText(answerText)
  const answerBrandKey = brandKeyFromText(answerText)
  for (const brandName of brandNames) {
    if (!brandName || !brandName.trim()) continue
    const normalizedCandidates = brandNormalizedCandidates(brandName)
    const brandKeyCandidates = brandKeyCandidatesForMatch(brandName)
    // Match the normalized candidate as a whole word in the answer, not as a
    // substring. Otherwise a short candidate like "li" (from brand "LI")
    // false-matches inside unrelated words such as "polished" or "compliance",
    // and "inc" false-matches inside "incident".
    const matchesNormalized = normalizedCandidates.some(c =>
      new RegExp(`\\b${escapeRegExp(c)}\\b`).test(answerNormalized),
    )
    const matchesBrandKey = brandKeyCandidates.some(
      c => c.length >= MIN_BRAND_KEY_LENGTH && answerBrandKey.includes(c),
    )
    if (matchesNormalized || matchesBrandKey) {
      matchedTerms.push(brandName)
    }
  }

  // Token-based path: tokens from all brand names plus every domain's brand
  // label pool into a single group. The multi-token threshold guards against
  // prefix false-positives — e.g. for competitor "rival-b" (tokens
  // ["rival", "rivalb"]), a stray "rival-a" in the answer hits "rival" but
  // not "rivalb", so the count stays below the threshold and the competitor
  // is not flagged. Standalone alias mentions ("LlamaParse" with no
  // co-occurring "LlamaIndex") fire via the strong-match path above instead,
  // so the threshold here doesn't need to relax.
  const brandTokens = collectBrandTokens(brandNames, domains)
  const allTokens = [...brandTokens.primary, ...brandTokens.secondary]
  const secondarySet = new Set(brandTokens.secondary)
  let tokenMatches = 0
  const matchedPrimary: string[] = []
  for (const token of allTokens) {
    if (new RegExp(`\\b${escapeRegExp(token)}\\b`).test(lowerAnswer)) {
      tokenMatches++
      if (!secondarySet.has(token)) matchedPrimary.push(token)
    }
  }
  const tokenThresholdMet = allTokens.length > 0 && (
    (allTokens.length === 1 && tokenMatches >= 1)
    || tokenMatches >= Math.min(2, allTokens.length)
  )
  if (tokenThresholdMet) {
    matchedTerms.push(...matchedPrimary)
  }

  // Deduplicate and remove tokens already subsumed by a domain match
  // e.g. if 'ainyc.ai' is in matchedTerms, don't also show 'ainyc'
  const unique = [...new Set(matchedTerms)]
  const domainMatches = unique.filter(t => t.includes('.'))
  const dedupedFinal = unique.filter(term => {
    if (term.includes('.')) return true // keep all domain matches
    // drop a token if it's a prefix/root of any matched domain
    return !domainMatches.some(d => d.toLowerCase().startsWith(term.toLowerCase() + '.'))
  })
  return { mentioned: dedupedFinal.length > 0, matchedTerms: dedupedFinal }
}

export function determineAnswerMentioned(
  answerText: string | null | undefined,
  brandNames: string[],
  domains: string[],
): boolean {
  return extractAnswerMentions(answerText, brandNames, domains).mentioned
}

export function visibilityStateFromAnswerMentioned(answerMentioned: boolean | null | undefined): VisibilityState {
  return answerMentioned ? 'visible' : 'not-visible'
}

/**
 * Canonical-vocabulary equivalent of `visibilityStateFromAnswerMentioned`.
 * Returns `'mentioned'` / `'not-mentioned'` — the language new APIs, CLI
 * flags, and UI labels must use per the AGENTS.md vocabulary rules.
 */
export function mentionStateFromAnswerMentioned(answerMentioned: boolean | null | undefined): MentionState {
  return answerMentioned ? 'mentioned' : 'not-mentioned'
}

/**
 * Normalize a brand name or domain label to a lowercase alphanumeric key
 * for fuzzy comparison (e.g. "Downtown Smiles" → "downtownsmiles").
 */
export function brandKeyFromText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function domainMentioned(lowerAnswer: string, normalizedDomain: string): boolean {
  const escapedDomain = escapeRegExp(normalizedDomain.toLowerCase())
  const patterns = [
    new RegExp(`(^|[^a-z0-9-])${escapedDomain}($|[^a-z0-9-])`),
    new RegExp(`https?://(?:www\\.)?${escapedDomain}(?:[/:?#]|$)`),
    new RegExp(`www\\.${escapedDomain}(?:[/:?#]|$)`),
  ]
  return patterns.some(pattern => pattern.test(lowerAnswer))
}

interface BrandTokens {
  /**
   * Tokens that may match standalone in answer text — the brand prefix
   * (first distinctive word of the display name) and the registrable
   * domain's concatenated brand label. These are unique enough that a
   * single word-boundary hit signals a real mention.
   */
  primary: string[]
  /**
   * Distinctive but trailing descriptor words from the display name
   * (e.g. "Roofing" in "Cenco Roofing"). These flow through full-phrase
   * and brand-key matching, but are NEVER matched standalone in prose,
   * because generic industry nouns are too common to be a reliable
   * signal of brand presence on their own.
   */
  secondary: string[]
}

/**
 * Pool tokens from every brand name and every domain into a single group.
 *
 * - First distinctive word of each brand name → primary.
 * - Trailing distinctive words of each brand name → secondary (count toward
 *   the threshold but never surface as matchedTerms — generic descriptors
 *   like "Roofing" are too common to be reliable evidence on their own).
 * - Each registrable domain's brand label → primary (with the subdomain
 *   stripped so an owned domain like `app.example.com` does not contribute
 *   the noisy `app` token).
 */
function collectBrandTokens(brandNames: string[], domains: string[]): BrandTokens {
  const primary = new Set<string>()
  const secondary = new Set<string>()

  for (const brandName of brandNames) {
    if (!brandName || !brandName.trim()) continue
    const distinctiveWords = extractDistinctiveTokens(brandName)
    if (distinctiveWords.length > 0) {
      primary.add(distinctiveWords[0]!)
      for (let i = 1; i < distinctiveWords.length; i++) {
        secondary.add(distinctiveWords[i]!)
      }
    }
  }

  for (const domain of domains) {
    const reg = registrableDomain(domain)
    const brand = reg
      ? brandLabelFromDomain(reg)
      : (normalizeProjectDomain(domain).split('/')[0]?.split('.')[0] ?? '')
    const token = brand.replace(/[^a-z0-9]/gi, '').toLowerCase()
    if (isDistinctiveToken(token)) primary.add(token)
  }

  // A token must not appear in both buckets — primary wins.
  for (const t of primary) secondary.delete(t)

  return { primary: [...primary], secondary: [...secondary] }
}

function extractDistinctiveTokens(value: string): string[] {
  return normalizeText(value)
    .split(' ')
    .filter(isDistinctiveToken)
}

function isDistinctiveToken(token: string): boolean {
  if (token.length < 4) return false
  return !GENERIC_TOKENS.has(token)
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function brandNormalizedCandidates(displayName: string): string[] {
  const original = normalizeText(displayName)
  if (!original) return []
  const stripped = stripBusinessSuffix(original, ' ')
  if (!stripped || stripped === original) return [original]
  return [original, stripped]
}

function brandKeyCandidatesForMatch(displayName: string): string[] {
  const original = brandKeyFromText(displayName)
  if (!original) return []
  const stripped = stripBusinessSuffix(original, '')
  return stripped && stripped !== original ? [original, stripped] : [original]
}

// Strip a trailing business classifier (LLC/Inc/Corp/…) from a normalized brand
// string. `separator` is `' '` for space-separated normalized text and `''` for
// the whitespace-stripped brand key. Requires ≥3 chars to remain so a name
// that is only a classifier (e.g. "Inc") is left untouched.
function stripBusinessSuffix(value: string, separator: string): string {
  for (const suffix of BUSINESS_SUFFIXES) {
    const trailing = `${separator}${suffix}`
    if (value.endsWith(trailing) && value.length - trailing.length >= 3) {
      return value.slice(0, -trailing.length)
    }
  }
  return value
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
