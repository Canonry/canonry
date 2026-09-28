import { z } from 'zod'
import type { GroundingSource } from './run.js'
import { AI_ENGINE_SELF_DOMAINS, AI_PROVIDER_INFRA_DOMAINS, VERTEX_AI_SEARCH_PROXY_DOMAIN } from './ai-engines.js'
import { hostMatchesAnyDomain } from './url-normalize.js'

export const CITED_URL_CAPTURE_VERSION = 1

export const citedUrlCaptureStatusSchema = z.enum(['complete', 'partial', 'failed', 'unsupported'])
export type CitedUrlCaptureStatus = z.infer<typeof citedUrlCaptureStatusSchema>
export const CitedUrlCaptureStatuses = citedUrlCaptureStatusSchema.enum

export const ROUTE_CAPABLE_CITED_URL_PROVIDERS = [
  'gemini',
  'openai',
  'claude',
  'perplexity',
  'muse',
  'cdp:chatgpt',
] as const

/** Gemini's trusted redirect proxy is an exact host + route, never a suffix match. */
export function isVertexGroundingRedirect(url: URL): boolean {
  return url.protocol === 'https:'
    && url.hostname === VERTEX_AI_SEARCH_PROXY_DOMAIN
    && url.pathname.startsWith('/grounding-api-redirect/')
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.hash = ''
    return url
  } catch {
    return undefined
  }
}

function isProviderInfrastructure(url: URL): boolean {
  return hostMatchesAnyDomain(url.hostname, [
    ...AI_PROVIDER_INFRA_DOMAINS,
    ...Object.values(AI_ENGINE_SELF_DOMAINS).flat(),
  ])
}

/**
 * Source entries eligible for URL capture. The exact Gemini redirect proxy is
 * retained for the resolver; all other provider infrastructure is excluded.
 */
export function deriveCitedUrlCandidates(sources: readonly Pick<GroundingSource, 'uri'>[]): string[] {
  const candidates: string[] = []
  for (const source of sources) {
    const url = parseHttpUrl(source.uri)
    if (!url) continue
    if (isVertexGroundingRedirect(url) || !isProviderInfrastructure(url)) {
      candidates.push(url.toString())
    }
  }
  return candidates
}

/** Final URL acceptance: provider infrastructure and unresolved proxies never persist. */
export function filterCapturedCitedUrls(urls: readonly (string | undefined)[]): string[] {
  const accepted = new Set<string>()
  for (const value of urls) {
    if (!value) continue
    const url = parseHttpUrl(value)
    if (!url || isVertexGroundingRedirect(url) || isProviderInfrastructure(url)) continue
    accepted.add(url.toString())
  }
  return [...accepted]
}
