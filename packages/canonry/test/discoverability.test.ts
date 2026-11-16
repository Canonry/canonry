import { describe, expect, it } from 'vitest'
import { DiscoverabilityChecker } from '../src/discoverability.js'

function stubFetch(routes: Record<string, { status: number; body: string; headers?: Record<string, string> }>) {
  const calls: string[] = []
  const fetchImpl = async (url: string): Promise<Response> => {
    calls.push(url)
    const route = routes[url]
    if (route === undefined) return new Response('not found', { status: 404 })
    return new Response(route.body, { status: route.status, headers: route.headers })
  }
  return { fetchImpl, calls }
}

const ROBOTS = 'User-agent: *\nDisallow: /hidden/\n'

describe('DiscoverabilityChecker', () => {
  it('reports a robots.txt disallow and fetches robots.txt once per origin', async () => {
    const { fetchImpl, calls } = stubFetch({
      'https://example.com/robots.txt': { status: 200, body: ROBOTS },
      'https://example.com/hidden/page': { status: 200, body: '<html><head></head></html>' },
      'https://example.com/open/page': { status: 200, body: '<html><head></head></html>' },
    })
    const checker = new DiscoverabilityChecker({ userAgents: ['googlebot'], fetchImpl, sleep: () => Promise.resolve() })
    const results = await checker.checkMany(['https://example.com/hidden/page', 'https://example.com/open/page'])
    expect(results.get('https://example.com/hidden/page')).toEqual({
      localBlocked: true,
      localBlockReason: 'robots-disallow',
    })
    expect(results.get('https://example.com/open/page')).toEqual({ localBlocked: false, localBlockReason: null })
    expect(calls.filter((url) => url === 'https://example.com/robots.txt')).toHaveLength(1)
  })

  it('reads meta noindex and X-Robots-Tag noindex from the page', async () => {
    const { fetchImpl } = stubFetch({
      'https://example.com/robots.txt': { status: 404, body: '' },
      'https://example.com/a': { status: 200, body: '<meta name="robots" content="noindex">' },
      'https://example.com/b': {
        status: 200,
        body: '<html></html>',
        headers: { 'x-robots-tag': 'noindex' },
      },
    })
    const checker = new DiscoverabilityChecker({ userAgents: ['bingbot'], fetchImpl })
    expect(await checker.check('https://example.com/a')).toEqual({
      localBlocked: true,
      localBlockReason: 'meta-noindex',
    })
    expect(await checker.check('https://example.com/b')).toEqual({
      localBlocked: true,
      localBlockReason: 'x-robots-tag-noindex',
    })
  })

  it('leaves a URL unblocked when every fetch fails, instead of failing the sweep', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error('fetch failed')
    }
    const checker = new DiscoverabilityChecker({ userAgents: ['googlebot'], fetchImpl, sleep: () => Promise.resolve() })
    await expect(checker.check('https://example.com/page')).resolves.toEqual({
      localBlocked: false,
      localBlockReason: null,
    })
  })

  it('retries a 500 and does not retry a 404', async () => {
    let flakyCalls = 0
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 })
      flakyCalls += 1
      if (flakyCalls < 3) return new Response('error', { status: 500 })
      return new Response('<meta name="robots" content="noindex">', { status: 200 })
    }
    const checker = new DiscoverabilityChecker({ userAgents: ['googlebot'], fetchImpl, sleep: () => Promise.resolve() })
    await expect(checker.check('https://example.com/page')).resolves.toEqual({
      localBlocked: true,
      localBlockReason: 'meta-noindex',
    })
    expect(flakyCalls).toBe(3)

    let notFoundCalls = 0
    const notFoundFetch = async (url: string): Promise<Response> => {
      if (url.endsWith('/robots.txt')) return new Response('', { status: 404 })
      notFoundCalls += 1
      return new Response('missing', { status: 404 })
    }
    const notFoundChecker = new DiscoverabilityChecker({
      userAgents: ['googlebot'],
      fetchImpl: notFoundFetch,
      sleep: () => Promise.resolve(),
    })
    await expect(notFoundChecker.check('https://example.com/gone')).resolves.toEqual({
      localBlocked: false,
      localBlockReason: null,
    })
    expect(notFoundCalls).toBe(1)
  })
})
