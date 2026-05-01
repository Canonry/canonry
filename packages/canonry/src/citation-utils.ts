import type { NormalizedQueryResult } from '@ainyc/canonry-contracts'
import { brandKeyFromText, brandLabelFromDomain, normalizeProjectDomain, registrableDomain } from '@ainyc/canonry-contracts'

function domainMatches(domain: string, canonicalDomain: string): boolean {
  const normalized = normalizeProjectDomain(canonicalDomain)
  const d = normalizeProjectDomain(domain)
  return d === normalized || d.endsWith(`.${normalized}`)
}

export function determineCitationState(
  normalized: NormalizedQueryResult,
  domains: string[],
): 'cited' | 'not-cited' {
  for (const canonicalDomain of domains) {
    const bareDomain = normalizeProjectDomain(canonicalDomain)

    if (normalized.citedDomains.some(d => domainMatches(d, bareDomain))) {
      return 'cited'
    }

    const lowerDomain = bareDomain.toLowerCase()
    for (const source of normalized.groundingSources) {
      try {
        const uri = source.uri.toLowerCase()
        if (lowerDomain.includes('.') && uri.includes(lowerDomain)) {
          return 'cited'
        }
      } catch {
        // ignore
      }
      if (source.title) {
        const titleLower = source.title.toLowerCase().replace(/^www\./, '')
        if (titleLower === lowerDomain || titleLower.endsWith(`.${lowerDomain}`)) {
          return 'cited'
        }
      }
    }
  }

  return 'not-cited'
}

export function computeCompetitorOverlap(
  normalized: NormalizedQueryResult,
  competitorDomains: string[],
): string[] {
  const overlapSet = new Set<string>()

  for (const d of normalized.citedDomains) {
    for (const cd of competitorDomains) {
      if (domainMatches(d, cd)) {
        overlapSet.add(cd)
      }
    }
  }

  for (const source of normalized.groundingSources) {
    const uri = source.uri.toLowerCase()
    for (const cd of competitorDomains) {
      if (uri.includes(cd.toLowerCase())) {
        overlapSet.add(cd)
      }
    }
  }

  if (normalized.answerText) {
    const lowerAnswer = normalized.answerText.toLowerCase()
    for (const cd of competitorDomains) {
      if (lowerAnswer.includes(cd.toLowerCase())) {
        overlapSet.add(cd)
      }
      // Use the registrable domain's brand label (eTLD+1's leftmost label) so
      // a stored competitor like `offers.roofle.com` is matched against the
      // brand `roofle`, not the subdomain `offers` — otherwise the literal
      // word "offers" in the answer prose would falsely flag the competitor.
      const brand = brandLabelFromDomain(cd)
      if (brand.length >= 4 && new RegExp(`\\b${escapeRegExp(brand)}\\b`, 'i').test(lowerAnswer)) {
        overlapSet.add(cd)
      }
    }
  }

  return [...overlapSet]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Extract brand names from the answer, but only when they line up with
 * domains we already know were cited or matched as competitors.
 */
export function extractRecommendedCompetitors(
  answerText: string | null | undefined,
  ownDomains: string[],
  citedDomains: string[],
  competitorDomains: string[],
): string[] {
  if (!answerText || answerText.length < 20) return []

  const ownBrandKeys = new Set(
    ownDomains.flatMap(domain => collectBrandKeysFromDomain(domain)),
  )
  const knownCompetitorKeys = new Set(
    [...citedDomains, ...competitorDomains]
      .flatMap(domain => collectBrandKeysFromDomain(domain))
      .filter(key => !ownBrandKeys.has(key)),
  )

  if (knownCompetitorKeys.size === 0) return []

  const candidatePatterns = [
    /^\s*(?:[-*]|\d+\.)\s+(?:\*\*)?([A-Z0-9][A-Za-z0-9][\w\s.&',/()-]{1,50}?)(?:\*\*)?\s*[:\u2014\u2013–-]/gm,
    /\*\*([A-Z0-9][A-Za-z0-9][\w\s.&',/()-]{1,50}?)\*\*/g,
    /^#{1,4}\s+(?:\d+\.\s+)?(?:\*\*)?([A-Z0-9][A-Za-z0-9][\w\s.&',/()-]{1,50}?)(?:\*\*)?$/gm,
    /\[([A-Z0-9][A-Za-z0-9][\w\s.&',/()-]{1,50}?)\]\(https?:\/\/[^\s)]+\)/g,
  ]
  const genericKeys = new Set([
    'additional',
    'best',
    'benefits',
    'bottomline',
    'comparison',
    'conclusion',
    'directorylisting',
    'example',
    'expertise',
    'features',
    'finalthoughts',
    'howitworks',
    'important',
    'keybenefits',
    'keyfeatures',
    'major',
    'note',
    'notable',
    'option',
    'other',
    'overview',
    'pricing',
    'pros',
    'reviews',
    'step',
    'summary',
    'top',
    'verdict',
    'whattolookfor',
    'whyitmatters',
    'whyitstandsout',
    'whywechoseit',
  ])

  const seen = new Map<string, string>()
  for (const pattern of candidatePatterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(answerText)) !== null) {
      const candidate = cleanCandidateName(match[1] ?? '')
      const candidateKey = brandKeyFromText(candidate)
      if (!candidateKey) continue
      if (genericKeys.has(candidateKey)) continue
      if (candidate.split(/\s+/).length > 6) continue
      if (matchesBrandKey(candidateKey, ownBrandKeys)) continue
      if (!matchesBrandKey(candidateKey, knownCompetitorKeys)) continue
      if (!seen.has(candidateKey)) seen.set(candidateKey, candidate)
    }
  }

  return [...seen.values()].slice(0, 10)
}

function cleanCandidateName(candidate: string): string {
  return candidate
    .replace(/^[\s"'`]+|[\s"'`.,:;!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function collectBrandKeysFromDomain(domain: string): string[] {
  // Source brand keys from the registrable domain only — never from
  // subdomain labels — so a competitor `offers.roofle.com` does not contribute
  // `offers` as a brand key (which would let the answer-text word "offers"
  // false-match in extractRecommendedCompetitors).
  const reg = registrableDomain(domain)
  if (!reg) {
    const hostname = normalizeProjectDomain(domain).split('/')[0] ?? ''
    const fallback = hostname.replace(/[^a-z0-9]/gi, '').toLowerCase()
    return fallback.length >= 4 ? [fallback] : []
  }
  const keys = new Set<string>()
  const fullKey = reg.replace(/[^a-z0-9]/gi, '').toLowerCase()
  if (fullKey.length >= 4) keys.add(fullKey)
  const brand = brandLabelFromDomain(reg).replace(/[^a-z0-9]/gi, '').toLowerCase()
  if (brand.length >= 4) keys.add(brand)
  return [...keys]
}

function matchesBrandKey(candidateKey: string, brandKeys: Set<string>): boolean {
  for (const brandKey of brandKeys) {
    if (candidateKey === brandKey) return true
    if (candidateKey.startsWith(brandKey) || candidateKey.endsWith(brandKey)) return true
    if (brandKey.startsWith(candidateKey) || brandKey.endsWith(candidateKey)) return true
  }
  return false
}
