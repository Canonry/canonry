import { describe, expect, it, vi } from 'vitest'
import { createClient, getApiV1Projects } from '../src/index.js'

/**
 * Smoke tests for the generated SDK + the `createClient` factory.
 *
 * The drift test (CI: `codegen-drift` job) catches stale generated output.
 * These tests catch wiring regressions in the thin `createClient` helper —
 * if hey-api ever changes its config shape, the test fails locally.
 */
describe('canonry-api-client', () => {
  it('createClient applies bearer auth + base URL to generated operations', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const client = createClient({
      baseUrl: 'https://example.test/canonry',
      apiKey: 'cnry_test',
      fetch: fakeFetch as unknown as typeof fetch,
    })

    await getApiV1Projects({ client })

    expect(fakeFetch).toHaveBeenCalledOnce()
    const req = fakeFetch.mock.calls[0]![0] as Request
    expect(req.url).toBe('https://example.test/canonry/api/v1/projects')
    expect(req.headers.get('authorization')).toBe('Bearer cnry_test')
  })

  it('createClient omits authorization when no apiKey is given', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const client = createClient({
      baseUrl: 'https://example.test',
      fetch: fakeFetch as unknown as typeof fetch,
    })

    await getApiV1Projects({ client })

    const req = fakeFetch.mock.calls[0]![0] as Request
    expect(req.headers.get('authorization')).toBeNull()
  })
})
