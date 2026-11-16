import { createGuardedFetch } from '@canonry/canonry-api-routes'
import {
  classifyLocalBlock,
  hasMetaNoindex,
  hasXRobotsNoindex,
  isDisallowedByRobots,
  parseRobotsTxt,
  type LocalBlockCheck,
  type RobotsGroup,
} from '@canonry/canonry-contracts'
import { describeError, isRetryableHttpError, retryAfterDelayMs, withRetry } from '@canonry/canonry-contracts'
import { createLogger } from './logger.js'

const log = createLogger('Discoverability')

/** Retries per fetch; a sitemap sweep already paces provider calls, and these are best-effort reads. */
const DISCOVERABILITY_MAX_RETRIES = 2
/** Meta tags live in `<head>`; cap the read so one pathological page cannot swell the run. */
const MAX_PAGE_READ_CHARS = 512_000

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Fetches are the operator's own site (the sitemap's origin), so loopback
 * stays admitted exactly as the sitemap parser admits it; the guarded fetch
 * still blocks every other private address and checks redirect hops.
 */
const guardedFetch = createGuardedFetch({ allowLoopback: true })

export interface DiscoverabilityCheckerOptions {
  /** Bot names the local signals are read for: `['googlebot']` on a GSC run, `['bingbot']` on a Bing run. */
  userAgents: readonly string[]
  /**
   * Test seam: replaces the guarded fetch. Production leaves it unset.
   * Retry still wraps it, so a stub that fails transiently exercises the
   * same path production takes.
   */
  fetchImpl?: FetchImpl
  /** Test seam: replaces the retry sleep so retry tests do not spend real seconds. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Local discoverability checks for sitemap URLs (issue #357): robots.txt
 * Disallow, `<meta name="robots">` noindex, and `X-Robots-Tag: noindex`,
 * classified into `localBlocked` / `localBlockReason` by the contracts
 * helpers. Best-effort by design: a fetch that fails after retries leaves
 * the URL unblocked (`null` reason) and logs, so a dead page can never fail
 * the inspection sweep that found it.
 */
export class DiscoverabilityChecker {
  private readonly userAgents: readonly string[]
  private readonly fetchImpl: FetchImpl
  private readonly sleep: ((ms: number) => Promise<void>) | undefined
  private readonly robotsCache = new Map<string, RobotsGroup[] | null>()

  constructor(options: DiscoverabilityCheckerOptions) {
    this.userAgents = options.userAgents
    this.fetchImpl = options.fetchImpl ?? guardedFetch
    this.sleep = options.sleep
  }

  async check(url: string): Promise<LocalBlockCheck> {
    try {
      const origin = new URL(url).origin
      const robots = await this.robotsFor(origin)
      const robotsDisallowed = robots !== null && isDisallowedByRobots(robots, url, this.userAgents)
      const page = await this.fetchPage(url)
      if (page === null) {
        return classifyLocalBlock({ robotsDisallowed, metaNoindex: false, xRobotsNoindex: false })
      }
      const html = await readCappedText(page.body, MAX_PAGE_READ_CHARS)
      return classifyLocalBlock({
        robotsDisallowed,
        metaNoindex: hasMetaNoindex(html, this.userAgents),
        xRobotsNoindex: hasXRobotsNoindex(page.headers.get('x-robots-tag'), this.userAgents),
      })
    } catch (err) {
      log.warn('discoverability.check-failed', { url, error: describeError(err) })
      return { localBlocked: false, localBlockReason: null }
    }
  }

  /** One check per URL, in order; robots.txt is fetched once per origin. */
  async checkMany(urls: readonly string[]): Promise<Map<string, LocalBlockCheck>> {
    const results = new Map<string, LocalBlockCheck>()
    for (const url of urls) {
      results.set(url, await this.check(url))
    }
    return results
  }

  private async robotsFor(origin: string): Promise<RobotsGroup[] | null> {
    const cached = this.robotsCache.get(origin)
    if (cached !== undefined) return cached
    let groups: RobotsGroup[] | null = null
    try {
      const res = await this.fetchWithRetry(`${origin}/robots.txt`)
      if (res !== null && res.ok) groups = parseRobotsTxt(await res.text())
    } catch (err) {
      log.warn('discoverability.robots-failed', { origin, error: describeError(err) })
    }
    this.robotsCache.set(origin, groups)
    return groups
  }

  /** The page itself, or null when it cannot be read (4xx, or retries exhausted). */
  private async fetchPage(url: string): Promise<Response | null> {
    const res = await this.fetchWithRetry(url)
    if (res === null || !res.ok) return null
    return res
  }

  /**
   * One guarded request with the shared retry policy. A 5xx throws with its
   * status so `isRetryableHttpError` retries it; a 4xx returns null at once
   * (a missing page is data, not a reason to retry), and a refusal or
   * network failure throws and retries like any other transport error.
   */
  private async fetchWithRetry(url: string): Promise<Response | null> {
    return withRetry(
      async () => {
        const res = await this.fetchImpl(url)
        if (res.status >= 500) {
          throw Object.assign(new Error(`HTTP ${res.status} fetching ${url}`), { status: res.status })
        }
        if (res.status >= 400) return null
        return res
      },
      {
        maxRetries: DISCOVERABILITY_MAX_RETRIES,
        isRetryable: isRetryableHttpError,
        computeDelayMs: (_attempt, err, defaultMs) => retryAfterDelayMs(err) ?? defaultMs,
        ...(this.sleep !== undefined ? { sleep: this.sleep } : {}),
      },
    )
  }
}

async function readCappedText(body: ReadableStream<Uint8Array> | null, cap: number): Promise<string> {
  if (body === null) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out += decoder.decode(value, { stream: true })
      if (out.length >= cap) {
        await reader.cancel().catch(() => undefined)
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  return out.slice(0, cap)
}

/**
 * The post-inspect enrichment pass both sitemap executors run (issue #357):
 * check each inspected URL's local signals and hand the result to `updateRow`
 * (which writes it onto the run's stored inspection row). Best-effort — the
 * checker never throws, so a dead page leaves its fields null and the sweep
 * keeps its own outcome. Returns how many URLs were checked and blocked, for
 * the run's completion log.
 */
export async function enrichInspectedUrlsWithDiscoverability(
  urls: readonly string[],
  userAgents: readonly string[],
  updateRow: (url: string, check: LocalBlockCheck) => void,
  options: Pick<DiscoverabilityCheckerOptions, 'fetchImpl' | 'sleep'> = {},
): Promise<{ checked: number; blocked: number }> {
  if (urls.length === 0) return { checked: 0, blocked: 0 }
  const checker = new DiscoverabilityChecker({ userAgents, ...options })
  const checks = await checker.checkMany(urls)
  let blocked = 0
  for (const [url, check] of checks) {
    if (check.localBlocked) blocked += 1
    updateRow(url, check)
  }
  return { checked: urls.length, blocked }
}
