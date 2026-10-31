import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '../src/client.js'
import { TRAFFIC_ANALYTICS_FIXTURE } from './traffic-analytics-fixture.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ApiClient traffic delivery lifecycle', () => {
  it.each([undefined, 7, 14, 30, 90] as const)('reads complete traffic analytics through the SDK with period %s and the configured base path', async period => {
    let received: Request | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      received = input instanceof Request ? input : new Request(input, init)
      return new Response(JSON.stringify(TRAFFIC_ANALYTICS_FIXTURE), { headers: { 'content-type': 'application/json' } })
    }))
    const client = new ApiClient('https://canonry.test/canonry', 'cnry_test', { skipProbe: true })
    const result = await client.getTrafficAnalytics('acme', period)
    const url = new URL(received!.url)
    expect(received?.method).toBe('GET')
    expect(received?.headers.get('authorization')).toBe('Bearer cnry_test')
    expect(url.pathname).toBe('/canonry/api/v1/projects/acme/traffic/analytics')
    expect(url.searchParams.get('period')).toBe(period === undefined ? null : String(period))
    expect(result).toEqual(TRAFFIC_ANALYTICS_FIXTURE)
    expect(result.activity?.topCrawledPaths).toHaveLength(501)
  })

  it('activates the exact source through the generated SDK operation', async () => {
    let received: Request | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      received = input instanceof Request ? input : new Request(input, init)
      return new Response(JSON.stringify({
        id: 'source-queue',
        projectId: 'project-demo',
        sourceType: 'cloudflare',
        displayName: 'Cloudflare Queue',
        status: 'connected',
        lastSyncedAt: null,
        lastCursor: null,
        lastError: null,
        skippedThroughAt: null,
        archivedAt: null,
        config: { deliveryMode: 'queue-pull' },
        createdAt: '2026-08-11T12:00:00.000Z',
        updatedAt: '2026-08-11T12:01:00.000Z',
      }), { headers: { 'content-type': 'application/json' } })
    }))
    const client = new ApiClient('https://canonry.test', 'cnry_test', { skipProbe: true })

    const source = await client.trafficActivate('demo', 'source-queue')

    expect(received?.method).toBe('POST')
    expect(new URL(received!.url).pathname).toBe('/api/v1/projects/demo/traffic/sources/source-queue/activate')
    expect(source).toMatchObject({ id: 'source-queue', status: 'connected' })
  })
})
