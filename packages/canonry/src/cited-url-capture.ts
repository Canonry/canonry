import {
  CITED_URL_CAPTURE_VERSION,
  ROUTE_CAPABLE_CITED_URL_PROVIDERS,
  deriveCitedUrlCandidates,
  filterCapturedCitedUrls,
  isVertexGroundingRedirect,
  isOpenRouterRoute,
  mapWithConcurrency,
  type CitedUrlCaptureStatus,
  type GroundingSource,
} from '@ainyc/canonry-contracts'

const RESOLUTION_CONCURRENCY = 5
const RESOLUTION_TIMEOUT_MS = 5_000
const MAX_VERTEX_PROXY_HOPS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface CitedUrlCapture {
  citedUrls: string[] | null
  captureStatus: CitedUrlCaptureStatus
  sourceCount: number
  resolvedCount: number
  captureVersion: number
}

export interface CitedUrlCaptureOptions {
  fetchImpl?: FetchImpl
  timeoutMs?: number
}

function isRouteCapableProvider(provider: string): boolean {
  return isOpenRouterRoute(provider) || (ROUTE_CAPABLE_CITED_URL_PROVIDERS as readonly string[]).includes(provider)
}

function parseHttpUrl(value: string, base?: string): URL | undefined {
  try {
    const url = new URL(value, base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.hash = ''
    return url
  } catch {
    return undefined
  }
}

/**
 * Resolve only the trusted Gemini redirect endpoint. Destinations are observed
 * from `Location` and never fetched, preventing the capture path becoming an
 * arbitrary URL fetcher.
 */
export async function resolveVertexGroundingRedirect(
  value: string,
  opts: CitedUrlCaptureOptions = {},
): Promise<string | undefined> {
  const initial = parseHttpUrl(value)
  if (!initial || !isVertexGroundingRedirect(initial)) return undefined

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? RESOLUTION_TIMEOUT_MS
  let current = initial

  for (let hop = 0; hop <= MAX_VERTEX_PROXY_HOPS; hop++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(current, { redirect: 'manual', signal: controller.signal })
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }

    if (!REDIRECT_STATUSES.has(response.status)) return undefined
    const location = response.headers.get('location')
    if (!location) return undefined
    const next = parseHttpUrl(location, current.toString())
    if (!next) return undefined
    if (!isVertexGroundingRedirect(next)) return next.toString()
    current = next
  }

  return undefined
}

export async function captureCitedUrls(
  provider: string,
  sources: readonly GroundingSource[],
  opts: CitedUrlCaptureOptions = {},
): Promise<CitedUrlCapture> {
  const sourceCount = sources.length
  if (!isRouteCapableProvider(provider)) {
    return {
      citedUrls: null,
      captureStatus: 'unsupported',
      sourceCount,
      resolvedCount: 0,
      captureVersion: CITED_URL_CAPTURE_VERSION,
    }
  }

  const candidates = deriveCitedUrlCandidates(sources)
  const candidateCount = candidates.length
  let resolved: Array<string | undefined>
  try {
    resolved = await mapWithConcurrency(candidates, RESOLUTION_CONCURRENCY, async (candidate) => {
      const parsed = parseHttpUrl(candidate)
      if (!parsed) return undefined
      if (!isVertexGroundingRedirect(parsed)) return candidate
      return resolveVertexGroundingRedirect(candidate, opts)
    })
  } catch {
    // Capture is observational. A local resolver fault must not fail the
    // provider query or change its citation/mention computations.
    resolved = candidates.map(() => undefined)
  }
  const acceptedPerSource = resolved.map((value): string | undefined => filterCapturedCitedUrls([value]).at(0))
  const resolvedCount = acceptedPerSource.filter((value) => value !== undefined).length
  const captureStatus: CitedUrlCaptureStatus = resolvedCount === candidateCount
    ? 'complete'
    : resolvedCount > 0
      ? 'partial'
      : 'failed'

  return {
    citedUrls: filterCapturedCitedUrls(acceptedPerSource),
    captureStatus,
    sourceCount,
    resolvedCount,
    captureVersion: CITED_URL_CAPTURE_VERSION,
  }
}
