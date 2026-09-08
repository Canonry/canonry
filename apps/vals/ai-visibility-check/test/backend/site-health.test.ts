import { runSiteCrawl } from 'npm:@canonry/aeo-audit@7.2.0'
import { createSiteHealthRunner, VAL_TOWN_SITE_HEALTH_LIMITS } from '../../src/site-health/runner.ts'

function equal<T>(actual: T, expected: T, message = 'values differ'): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
  }
}

Deno.test('Technical AEO sample uses fixed bounded limits and never requests dead-link probes', async () => {
  const capture: { value: Record<string, unknown> | null } = { value: null }
  const runner = createSiteHealthRunner((_url, options) => {
    capture.value = options as Record<string, unknown>
    return Promise.resolve({
      mode: 'full',
      summary: {
        crawlSchemaVersion: '1.2',
        rootUrl: 'https://example.com/',
        finalRootUrl: 'https://example.com/',
        complete: true,
        terminationReason: null,
        pagesDiscovered: 1,
        pagesFetched: 1,
        pagesObserved: 1,
        elapsedMs: 10,
        auditRollup: { aggregateScore: 88, factors: [] },
        warnings: [],
      },
      pages: [],
      edges: [],
      deadLinks: { state: 'disabled', findings: [] },
    } as never)
  })

  const result = await runner.run('example.com', AbortSignal.timeout(1_000))
  equal(result.label, '5-page Technical AEO sample')
  equal(capture.value?.maxPages, 5)
  equal(capture.value?.maxEdges, 2_500)
  equal(capture.value?.maxDurationMs, 20_000)
  equal(capture.value?.checkDeadLinks, false)
  // Names the exact host being crawled. Val Town grants no DNS, so the engine's
  // resolve-then-check guard fails closed on every host without this; a matching
  // host skips the DNS preflight while every other host stays guarded.
  equal(capture.value?.allowPrivateHost, 'example.com')
  equal(VAL_TOWN_SITE_HEALTH_LIMITS.concurrency, 2)
})

Deno.test('the private-host allowance is scoped per attempt, never blanket', async () => {
  const allowed: unknown[] = []
  const runner = createSiteHealthRunner((rootUrl, options) => {
    allowed.push((options as Record<string, unknown>).allowPrivateHost)
    const empty = allowed.length === 1
    return Promise.resolve({
      mode: 'full',
      summary: {
        crawlSchemaVersion: '1.2',
        rootUrl,
        finalRootUrl: rootUrl,
        complete: true,
        terminationReason: null,
        pagesDiscovered: empty ? 0 : 1,
        pagesFetched: empty ? 0 : 1,
        pagesObserved: empty ? 0 : 1,
        elapsedMs: 10,
        auditRollup: { aggregateScore: empty ? 0 : 70, factors: [], auditedPages: empty ? 0 : 1 },
        warnings: [],
      },
      pages: [],
      edges: [],
      deadLinks: { state: 'disabled', findings: [] },
    } as never)
  })

  await runner.run('example.com', AbortSignal.timeout(1_000))
  // Each attempt names only the host it is about to crawl, so the www retry
  // cannot inherit an allowance minted for the apex.
  equal(allowed.length, 2)
  equal(allowed[0], 'example.com')
  equal(allowed[1], 'www.example.com')
})

Deno.test('retries only the exact www alias after an empty primary result', async () => {
  const roots: string[] = []
  const runner = createSiteHealthRunner((rootUrl) => {
    roots.push(rootUrl)
    const empty = roots.length === 1
    return Promise.resolve({
      mode: 'full',
      summary: {
        crawlSchemaVersion: '1.2',
        rootUrl,
        finalRootUrl: rootUrl,
        complete: true,
        terminationReason: null,
        pagesDiscovered: empty ? 0 : 1,
        pagesFetched: empty ? 0 : 1,
        pagesObserved: empty ? 0 : 1,
        elapsedMs: 5,
        auditRollup: { aggregateScore: empty ? null : 91, factors: [] },
        warnings: [],
      },
      pages: [],
      edges: [],
      deadLinks: { state: 'disabled', findings: [] },
    } as never)
  })
  const result = await runner.run('example.com', AbortSignal.timeout(1_000))
  equal(roots.join(','), 'https://example.com/,https://www.example.com/')
  equal(result.attemptedHosts.join(','), 'example.com,www.example.com')
  equal(result.score, 91)
})

Deno.test('retries the exact www alias recorded by a root-host redirect', async () => {
  const roots: string[] = []
  const runner = createSiteHealthRunner((rootUrl) => {
    roots.push(rootUrl)
    const redirected = roots.length === 1
    return Promise.resolve({
      mode: 'full',
      summary: {
        crawlSchemaVersion: '1.2',
        rootUrl,
        finalRootUrl: redirected ? 'https://www.example.com/' : rootUrl,
        complete: !redirected,
        terminationReason: redirected ? 'root-host-redirect' : null,
        pagesDiscovered: 1,
        pagesFetched: 1,
        pagesObserved: 1,
        elapsedMs: 5,
        auditRollup: { auditedPages: redirected ? 0 : 1, aggregateScore: redirected ? null : 91, factors: [] },
        warnings: [],
      },
      pages: [],
      edges: [],
      deadLinks: { state: 'disabled', findings: [] },
    } as never)
  })

  const result = await runner.run('example.com', AbortSignal.timeout(1_000))
  equal(roots.join(','), 'https://example.com/,https://www.example.com/')
  equal(result.attemptedHosts.join(','), 'example.com,www.example.com')
  equal(result.score, 91)
})

Deno.test('does not follow an arbitrary root-host redirect', async () => {
  const roots: string[] = []
  const runner = createSiteHealthRunner((rootUrl) => {
    roots.push(rootUrl)
    return Promise.resolve({
      mode: 'full',
      summary: {
        crawlSchemaVersion: '1.2',
        rootUrl,
        finalRootUrl: 'https://other.example/',
        complete: false,
        terminationReason: 'root-host-redirect',
        pagesDiscovered: 1,
        pagesFetched: 1,
        pagesObserved: 1,
        elapsedMs: 5,
        auditRollup: { auditedPages: 0, aggregateScore: null, factors: [] },
        warnings: [],
      },
      pages: [],
      edges: [],
      deadLinks: { state: 'disabled', findings: [] },
    } as never)
  })

  const result = await runner.run('example.com', AbortSignal.timeout(1_000))
  equal(roots.join(','), 'https://example.com/')
  equal(result.status, 'error')
})

Deno.test('a complete crawl with no audited pages is an unavailable Technical AEO sample', async () => {
  const runner = createSiteHealthRunner((_url) =>
    Promise.resolve({
      mode: 'full',
      summary: {
        crawlSchemaVersion: '1.2',
        rootUrl: 'https://example.com/',
        finalRootUrl: 'https://example.com/',
        complete: true,
        terminationReason: null,
        pagesDiscovered: 1,
        pagesFetched: 1,
        pagesObserved: 1,
        elapsedMs: 5,
        auditRollup: { auditedPages: 0, aggregateScore: null, factors: [] },
        warnings: [],
      },
      pages: [],
      edges: [],
      deadLinks: { state: 'disabled', findings: [] },
    } as never)
  )

  const result = await runner.run('example.com', AbortSignal.timeout(1_000))
  equal(result.status, 'error')
  equal(result.score, null)
  equal(result.error, 'No public pages could be audited in the Technical AEO sample.')
})

Deno.test({
  name: 'Deno crawl permits only the explicit local test host and blocks a private redirect hop',
  // @canonry/aeo-audit owns one process-global Undici dispatcher. Its idle
  // connection timer outlives this proof even after the local server closes.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    let rootRequests = 0
    let privateRequests = 0
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0 }, (request) => {
      const url = new URL(request.url)
      const address = server.addr as Deno.NetAddr
      if (url.pathname === '/') {
        rootRequests += 1
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${address.port}/private` },
        })
      }
      if (url.pathname === '/private') privateRequests += 1
      return new Response('<html><body>test</body></html>', { headers: { 'content-type': 'text/html' } })
    })
    const controller = new AbortController()

    try {
      const address = server.addr as Deno.NetAddr
      const redirectAttempts: string[] = []
      await runSiteCrawl(`http://localhost:${address.port}/`, {
        mode: 'full',
        // Test-only escape hatch: production runner never passes this option.
        allowPrivateHost: 'localhost',
        respectRobots: false,
        maxPages: 1,
        maxEdges: 10,
        maxFetches: 10,
        maxDurationMs: 5_000,
        maxQueryVariants: 0,
        maxSitemapFanout: 0,
        maxSitemapUrls: 0,
        maxFetchRetries: 0,
        signal: controller.signal,
        onOutboundAttempt: (attempt) => {
          redirectAttempts.push(attempt.url)
        },
      })

      equal(rootRequests > 0, true)
      equal(privateRequests, 0)
      equal(redirectAttempts.some((url) => new URL(url).hostname === '127.0.0.1'), false)

      const directAttempts: string[] = []
      await runSiteCrawl(`http://127.0.0.1:${address.port}/`, {
        mode: 'full',
        respectRobots: false,
        maxPages: 1,
        maxEdges: 10,
        maxFetches: 10,
        maxDurationMs: 5_000,
        maxQueryVariants: 0,
        maxSitemapFanout: 0,
        maxSitemapUrls: 0,
        maxFetchRetries: 0,
        signal: controller.signal,
        onOutboundAttempt: (attempt) => {
          directAttempts.push(attempt.url)
        },
      })
      equal(directAttempts.length, 0)
    } finally {
      controller.abort()
      await server.shutdown()
    }
  },
})

/** One crawl report, parameterised on how the crawl ended. */
function crawlEndingWith(terminationReason: string | null, complete: boolean) {
  return {
    mode: 'full',
    summary: {
      crawlSchemaVersion: '1.2',
      rootUrl: 'https://example.com/',
      finalRootUrl: 'https://example.com/',
      complete,
      terminationReason,
      pagesDiscovered: 5,
      pagesFetched: 5,
      pagesObserved: 5,
      elapsedMs: 900,
      auditRollup: { aggregateScore: 74, auditedPages: 5, factors: [] },
      warnings: [],
    },
    pages: [],
    edges: [],
    deadLinks: { state: 'disabled', findings: [] },
  } as never
}

Deno.test('a bounded sample that reached its own ceiling is complete, not partial', async () => {
  // `summary.complete` means the crawler saw the WHOLE site, which a 5-page
  // sample is designed never to do. Every real check therefore came back
  // `partial`, which marked the record partial and painted an amber
  // "Partial result / Failed checks are shown separately" over a run where
  // nothing failed. A caution on 100% of results is not a caution.
  for (const reason of ['max-pages', 'max-sitemap-fanout', 'max-duration', 'max-depth', 'max-edges']) {
    const runner = createSiteHealthRunner(() => Promise.resolve(crawlEndingWith(reason, false)))
    const result = await runner.run('example.com', AbortSignal.timeout(1_000))
    equal(result.status, 'complete', `${reason} is a configured ceiling, so the sample is complete`)
    // The reason is still reported; it is the STATUS that was wrong.
    equal(result.terminationReason, reason)
  }
})

Deno.test('an ending that is not one of our ceilings stays partial', async () => {
  // root-host-redirect means the crawl never reached the host that was asked
  // for. That is a degraded result, and the only non-`max-` reason today.
  const runner = createSiteHealthRunner(() => Promise.resolve(crawlEndingWith('root-host-redirect', false)))
  const result = await runner.run('example.com', AbortSignal.timeout(1_000))
  equal(result.status, 'partial', 'a crawl that missed the host is genuinely partial')
})

Deno.test('a sample that audited nothing is still an error, not a complete zero', async () => {
  const runner = createSiteHealthRunner(() =>
    Promise.resolve({
      ...(crawlEndingWith('max-pages', false) as unknown as Record<string, unknown>),
      summary: {
        ...((crawlEndingWith('max-pages', false) as unknown as { summary: Record<string, unknown> }).summary),
        auditRollup: { aggregateScore: 0, auditedPages: 0, factors: [] },
      },
    } as never)
  )
  const result = await runner.run('example.com', AbortSignal.timeout(1_000))
  equal(result.status, 'error', 'hitting a ceiling cannot upgrade an empty sample')
})
