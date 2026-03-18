import type { GroundingSource, RawQueryResult, NormalizedQueryResult } from '@ainyc/canonry-contracts'

/**
 * Extract unique domains from grounding sources.
 * Strips www. prefix and normalizes to lowercase.
 */
export function extractCitedDomains(groundingSources: GroundingSource[]): string[] {
  const domains = new Set<string>()

  for (const source of groundingSources) {
    try {
      const url = new URL(source.uri)
      const domain = url.hostname.replace(/^www\./, '').toLowerCase()
      // Skip internal AI service domains
      if (!domain.includes('chatgpt.com') && !domain.includes('openai.com')) {
        domains.add(domain)
      }
    } catch {
      // Try extracting domain from title as fallback (similar to Gemini provider)
      const titleDomain = extractDomainFromTitle(source.title)
      if (titleDomain) domains.add(titleDomain)
    }
  }

  return [...domains]
}

/** Try to extract a bare domain from a title string (e.g. "example.com - Page Title") */
function extractDomainFromTitle(title: string): string | undefined {
  const domainPattern = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i
  // Check if the title starts with what looks like a domain
  const firstWord = title.split(/[\s\-–—|]/)[0]?.trim()
  if (firstWord && domainPattern.test(firstWord)) {
    return firstWord.replace(/^www\./, '').toLowerCase()
  }
  return undefined
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
  }
}
