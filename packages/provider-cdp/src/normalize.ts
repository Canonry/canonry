import {
  AI_ENGINE_SELF_DOMAINS,
  hostMatchesAnyDomain,
  hostOf,
  registrableDomain,
  type GroundingSource,
  type RawQueryResult,
  type NormalizedQueryResult,
} from '@canonry/canonry-contracts'

/**
 * Extract unique domains from grounding sources.
 * Strips www. prefix and normalizes to lowercase.
 */
export function extractCitedDomains(groundingSources: GroundingSource[]): string[] {
  const domains = new Set<string>()

  for (const source of groundingSources) {
    const domain = hostOf(source.uri)
    if (domain && registrableDomain(domain)) {
      if (!hostMatchesAnyDomain(domain, AI_ENGINE_SELF_DOMAINS.chatgpt)) domains.add(domain)
    } else {
      // Try extracting domain from title as fallback (similar to Gemini provider)
      const titleDomain = extractDomainFromTitle(source.title)
      if (titleDomain) domains.add(titleDomain)
    }
  }

  return [...domains]
}

/** Try to extract a bare domain from a title string (e.g. "example.com - Page Title") */
function extractDomainFromTitle(title: string): string | undefined {
  // Check if the title starts with what looks like a domain
  const firstWord = title.split(/[\s\-–—|]/)[0]?.trim()
  if (!firstWord || !registrableDomain(firstWord)) return undefined
  return hostOf(firstWord) ?? undefined
}

/** Normalize a CDP raw query result into standard format */
export function normalizeResult(raw: RawQueryResult): NormalizedQueryResult {
  const answerText = typeof raw.rawResponse.answerText === 'string'
    ? raw.rawResponse.answerText
    : ''

  return {
    provider: raw.provider,
    answerText,
    citedDomains: extractCitedDomains(raw.groundingSources),
    groundingSources: raw.groundingSources,
    searchQueries: raw.searchQueries,
    retrievalStatus: raw.retrievalStatus ?? 'unknown',
  }
}
