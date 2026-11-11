import { beforeEach, describe, expect, it, vi } from 'vitest'

const trackEvent = vi.hoisted(() => vi.fn())
vi.mock('../src/telemetry.js', () => ({ trackEvent }))

const { trackTrafficIngested, trackTrafficSynced } = await import('../src/traffic-telemetry.js')

beforeEach(() => trackEvent.mockReset())

describe('traffic.synced', () => {
  it('forwards the AI user-fetch count with the other aggregates, and the failure code on the envelope', () => {
    trackTrafficSynced({
      status: 'completed', sourceType: 'cloudflare', sourceId: 'src-1', pulledEvents: 9, selfTrafficExcluded: 1,
      crawlerHits: 4, aiUserFetchHits: 3, aiReferralHits: 2, durationMs: 1_234,
    })
    trackTrafficSynced({
      status: 'failed', sourceType: 'vercel', sourceId: 'src-2', pulledEvents: 0, selfTrafficExcluded: 0,
      crawlerHits: 0, aiUserFetchHits: 0, aiReferralHits: 0, durationMs: 50, errorCode: 'PROVIDER_AUTH',
    })

    expect(trackEvent.mock.calls).toEqual([
      ['traffic.synced', {
        status: 'completed', sourceType: 'cloudflare', sourceId: 'src-1', pulledEvents: 9, selfTrafficExcluded: 1,
        crawlerHits: 4, aiUserFetchHits: 3, aiReferralHits: 2, durationMs: 1_234,
      }, undefined],
      ['traffic.synced', {
        status: 'failed', sourceType: 'vercel', sourceId: 'src-2', pulledEvents: 0, selfTrafficExcluded: 0,
        crawlerHits: 0, aiUserFetchHits: 0, aiReferralHits: 0, durationMs: 50,
      }, { errorCode: 'PROVIDER_AUTH' }],
    ])
  })
})

describe('server_traffic ingest', () => {
  const pushed = { sourceType: 'cloudflare', status: 'succeeded' as const, events: 3, crawlerHits: 1, aiReferralHits: 1, aiUserFetchHits: 1, durationMs: 12 }

  it('reports a push as a sampled push-triggered outcome with its counts, and a refusal with its reason', () => {
    trackTrafficIngested(pushed)
    trackTrafficIngested({ ...pushed, status: 'failed', events: 0, crawlerHits: 0, aiReferralHits: 0, aiUserFetchHits: 0, reasonCode: 'VALIDATION', errorName: 'AppError' })

    expect(trackEvent.mock.calls).toEqual([
      ['feature.completed', {
        feature: 'server_traffic', operation: 'ingest', status: 'succeeded', trigger: 'push', surface: 'api',
        durationBucket: 'under_1s', counts: { events: 3, crawlerHits: 1, aiReferralHits: 1, aiUserFetchHits: 1 },
      }, undefined],
      ['feature.completed', {
        feature: 'server_traffic', operation: 'ingest', status: 'failed', trigger: 'push', surface: 'api',
        durationBucket: 'under_1s', reasonCode: 'VALIDATION', errorName: 'AppError',
      }, { errorCode: 'VALIDATION' }],
    ])
  })

  it('samples per source type and status, so a stream of pushes never starves a failure, and counts what it drops', () => {
    // One success above was already spent from this module's sampler; the burst is 10.
    for (let i = 0; i < 20; i += 1) trackTrafficIngested(pushed)
    const succeeded = trackEvent.mock.calls.filter(([, properties]) => properties.status === 'succeeded')
    expect(succeeded).toHaveLength(9)

    trackTrafficIngested({ ...pushed, status: 'failed', reasonCode: 'VALIDATION' })
    expect(trackEvent.mock.calls.at(-1)?.[1]).toMatchObject({ status: 'failed', reasonCode: 'VALIDATION' })

    vi.useFakeTimers({ now: Date.now() + 60_000 })
    try {
      trackTrafficIngested(pushed)
      expect(trackEvent.mock.calls.at(-1)?.[1]).toMatchObject({ status: 'succeeded', droppedBefore: 11 })
    } finally {
      vi.useRealTimers()
    }
  })
})
