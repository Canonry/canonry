import type { NormalizedTrafficRequest } from '@ainyc/canonry-contracts'
import { DEFAULT_AI_CRAWLER_RULES, DEFAULT_AI_REFERRER_RULES } from './rules.js'
import type { ClassifiedAiReferral, ClassifiedCrawler } from './types.js'

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, '')
}

function hostMatches(host: string, domain: string): boolean {
  const normalizedHost = normalizeHost(host)
  const normalizedDomain = normalizeHost(domain)
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`)
}

function hostFromUrl(value: string | null): string | null {
  if (!value) return null
  try {
    return normalizeHost(new URL(value).hostname)
  } catch {
    return null
  }
}

function utmSourceFromQuery(queryString: string | null): string | null {
  if (!queryString) return null
  const params = new URLSearchParams(queryString)
  const source = params.get('utm_source')
  return source ? normalizeHost(source) : null
}

export function classifyCrawler(event: NormalizedTrafficRequest): ClassifiedCrawler | null {
  const userAgent = event.userAgent?.trim()
  if (!userAgent) return null

  for (const rule of DEFAULT_AI_CRAWLER_RULES) {
    if (rule.userAgentPatterns.some((pattern) => pattern.test(userAgent))) {
      return {
        botId: rule.id,
        operator: rule.operator,
        product: rule.product,
        purpose: rule.purpose,
        verificationStatus: 'claimed_unverified',
        matchedUserAgent: userAgent,
      }
    }
  }

  return null
}

export function classifyAiReferral(event: NormalizedTrafficRequest): ClassifiedAiReferral | null {
  const refererHost = hostFromUrl(event.referer)
  if (refererHost) {
    const rule = DEFAULT_AI_REFERRER_RULES.find((candidate) => hostMatches(refererHost, candidate.domain))
    if (rule) {
      return {
        operator: rule.operator,
        product: rule.product,
        sourceDomain: refererHost,
        evidenceType: 'referer',
      }
    }
  }

  const utmSource = utmSourceFromQuery(event.queryString)
  if (utmSource) {
    const rule = DEFAULT_AI_REFERRER_RULES.find((candidate) => hostMatches(utmSource, candidate.domain))
    if (rule) {
      return {
        operator: rule.operator,
        product: rule.product,
        sourceDomain: utmSource,
        evidenceType: 'utm',
      }
    }
  }

  return null
}
