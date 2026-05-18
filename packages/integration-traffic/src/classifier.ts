import type { NormalizedTrafficRequest } from '@ainyc/canonry-contracts'
import { verifyIpForRule } from './ip-verify.js'
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

// UTM source values are often a short label rather than a hostname (e.g.
// `utm_source=chatgpt` for `chatgpt.com`). Match against the first DNS label
// of the rule's domain so we don't miss the short form.
function utmTokenMatchesDomain(utmSource: string, domain: string): boolean {
  if (hostMatches(utmSource, domain)) return true
  const normalizedUtm = normalizeHost(utmSource)
  const firstLabel = normalizeHost(domain).split('.')[0]
  return Boolean(firstLabel) && normalizedUtm === firstLabel
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

function utmSourceFromUrl(value: string | null): string | null {
  if (!value) return null
  try {
    return utmSourceFromQuery(new URL(value).search.replace(/^\?/, ''))
  } catch {
    return null
  }
}

export function classifyCrawler(event: NormalizedTrafficRequest): ClassifiedCrawler | null {
  const userAgent = event.userAgent?.trim()
  if (!userAgent) return null

  for (const rule of DEFAULT_AI_CRAWLER_RULES) {
    if (rule.userAgentPatterns.some((pattern) => pattern.test(userAgent))) {
      // UA matched — try to upgrade `claimed_unverified` → `verified` by
      // checking the request's source IP against the operator's
      // published crawler IP ranges. Falls back to `claimed_unverified`
      // when (a) the operator doesn't publish ranges (most LLM
      // operators today), (b) we don't have the IP, or (c) the IP is
      // outside the published set (probable spoofer — UA matches but
      // source isn't really the operator).
      //
      // The verified vs unverified split surfaces in the dashboard via
      // separate `crawler_events_hourly` buckets (verification_status
      // is part of the primary key), so the operator can sort real
      // crawler traffic from spoofed traffic at a glance.
      const verified = verifyIpForRule(event.remoteIp, rule.id)
      return {
        botId: rule.id,
        operator: rule.operator,
        product: rule.product,
        purpose: rule.purpose,
        verificationStatus: verified ? 'verified' : 'claimed_unverified',
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
    const rule = DEFAULT_AI_REFERRER_RULES.find((candidate) => utmTokenMatchesDomain(utmSource, candidate.domain))
    if (rule) {
      return {
        operator: rule.operator,
        product: rule.product,
        sourceDomain: utmSource,
        evidenceType: 'utm',
      }
    }
  }

  // Edge-cached pages serve the HTML hit from the CDN; only the cache-busting
  // sub-resource requests (JS chunks, fonts, etc.) reach the origin. Those
  // requests carry the original landing-URL UTM in their referer's query
  // string, so we look there too — without it we lose ~all human AI-referral
  // signal on cached sites.
  const refererUtmSource = utmSourceFromUrl(event.referer)
  if (refererUtmSource) {
    const rule = DEFAULT_AI_REFERRER_RULES.find((candidate) => utmTokenMatchesDomain(refererUtmSource, candidate.domain))
    if (rule) {
      return {
        operator: rule.operator,
        product: rule.product,
        sourceDomain: refererUtmSource,
        evidenceType: 'referer-utm',
      }
    }
  }

  return null
}
