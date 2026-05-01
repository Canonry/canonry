import { brandLabelFromDomain, normalizeProjectDomain, registrableDomain } from './project.js'
import type { VisibilityState } from './run.js'

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
  displayName: string,
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

  const answerNormalized = normalizeText(answerText)
  const answerBrandKey = brandKeyFromText(answerText)
  const normalizedCandidates = brandNormalizedCandidates(displayName)
  const brandKeyCandidates = brandKeyCandidatesForMatch(displayName)
  const matchesNormalized = normalizedCandidates.some(c => answerNormalized.includes(c))
  const matchesBrandKey = brandKeyCandidates.some(
    c => c.length >= MIN_BRAND_KEY_LENGTH && answerBrandKey.includes(c),
  )
  if (matchesNormalized || matchesBrandKey) {
    matchedTerms.push(displayName)
  }

  const tokens = collectDistinctiveTokens(displayName, domains)
  let tokenMatches = 0
  const matchedTokens: string[] = []
  for (const token of tokens) {
    if (new RegExp(`\\b${escapeRegExp(token)}\\b`).test(lowerAnswer)) {
      tokenMatches++
      matchedTokens.push(token)
    }
  }

  const tokenThresholdMet = tokens.length > 0 && (
    (tokens.length === 1 && tokenMatches >= 1)
    || tokenMatches >= Math.min(2, tokens.length)
  )

  if (tokenThresholdMet) {
    matchedTerms.push(...matchedTokens)
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
  displayName: string,
  domains: string[],
): boolean {
  return extractAnswerMentions(answerText, displayName, domains).mentioned
}

export function visibilityStateFromAnswerMentioned(answerMentioned: boolean | null | undefined): VisibilityState {
  return answerMentioned ? 'visible' : 'not-visible'
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

function collectDistinctiveTokens(displayName: string, domains: string[]): string[] {
  const tokens = new Set<string>()

  for (const token of extractDistinctiveTokens(displayName)) {
    tokens.add(token)
  }

  for (const domain of domains) {
    // Use only the registrable domain's brand label as a token — never the
    // subdomain. Otherwise an owned domain like `app.example.com` would
    // contribute `app` as a word-boundary token and false-match every "app"
    // in the answer text. Falls back to the hostname's leftmost label when
    // the input has no recognizable TLD (e.g. `localhost`).
    const reg = registrableDomain(domain)
    const brand = reg
      ? brandLabelFromDomain(reg)
      : (normalizeProjectDomain(domain).split('/')[0]?.split('.')[0] ?? '')
    const token = brand.replace(/[^a-z0-9]/gi, '').toLowerCase()
    if (isDistinctiveToken(token)) tokens.add(token)
  }

  return [...tokens]
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
  // Apply the same MIN_BRAND_KEY_LENGTH guard as the brand-key path: a stripped
  // candidate like "bob" (from "Bob Inc") would otherwise substring-match inside
  // unrelated words such as "bobsled".
  if (brandKeyFromText(stripped).length < MIN_BRAND_KEY_LENGTH) return [original]
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
