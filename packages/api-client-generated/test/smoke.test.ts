import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { createClient, getApiV1Projects } from '../src/index.js'
import type {
  AdsCampaignListResponse,
  AdsOperationReconcileResponse,
  AdsUnresolvedOperationListResponse,
} from '../src/index.js'

/**
 * Smoke tests for the generated SDK + the `createClient` factory.
 *
 * The drift test (CI: `codegen-drift` job) catches stale generated output.
 * These tests catch wiring regressions in the thin `createClient` helper —
 * if hey-api ever changes its config shape, the test fails locally.
 */
describe('canonry-api-client', () => {
  it('retains nullable ads bidding and billing values in generated response types', () => {
    type Campaign = AdsCampaignListResponse['campaigns'][number]
    type AdGroup = Campaign['adGroups'][number]

    expectTypeOf<Campaign['biddingType']>()
      .toEqualTypeOf<'impressions' | 'clicks' | null | undefined>()
    expectTypeOf<AdGroup['billingEventType']>()
      .toEqualTypeOf<'impression' | 'click' | null | undefined>()
  })

  it('generates the typed ads recovery operation surface', () => {
    type Operation = AdsUnresolvedOperationListResponse['operations'][number]

    expectTypeOf<Operation['state']>()
      .toEqualTypeOf<'pending' | 'reconciling' | 'succeeded' | 'failed' | 'unknown'>()
    expectTypeOf<Operation['entityType']>()
      .toEqualTypeOf<'file' | 'campaign' | 'ad_group' | 'ad' | null>()
    expectTypeOf<Operation['reconcileStrategy']>()
      .toEqualTypeOf<'known_entity' | 'create_fingerprint' | 'manual_only' | null>()
    expectTypeOf<AdsOperationReconcileResponse['resolved']>().toEqualTypeOf<boolean>()
  })

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
