import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import type { TrafficEventsResponse } from '@ainyc/canonry-api-client'
import { useServerTrafficEvents, type ServerTrafficEventsFilters } from '../src/queries/server-traffic.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

const initialNow = Date.parse('2026-09-01T00:00:00.000Z')
const filters: ServerTrafficEventsFilters = {
  kind: 'all', sourceId: 'abc', sinceMinutes: 10080, limit: 1000, granularity: 'day',
}
const response: TrafficEventsResponse = {
  windowStart: '2026-08-25T00:00:00.000Z',
  windowEnd: '2026-09-01T00:00:00.000Z',
  series: {
    granularity: 'day', points: [], coverageStart: null,
    trends: { crawlerContentHits: null, aiUserFetchHits: null, aiReferralLandedHits: null },
  },
  totals: {
    crawlerHits: 0, crawlerContentHits: 0, crawlerInfraHits: 0,
    crawlerSegments: { content: 0, sitemap: 0, robots: 0, asset: 0, other: 0 },
    aiUserFetchHits: 0, aiReferralHits: 0, aiReferralLandedHits: 0,
    aiReferralRedirectedHits: 0, aiReferralPaidHits: 0, aiReferralOrganicHits: 0, aiReferralUnknownHits: 0,
  },
  eventRows: { total: 0, returned: 0, truncated: false },
  events: [],
}

let queryClient: QueryClient
let requests: URL[]
let now: number

function Wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children)
}

beforeEach(() => {
  now = initialNow
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  requests = []
  onTestFinished(mockFetch(url => {
    requests.push(new URL(url))
    return jsonResponse(response)
  }))
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.restoreAllMocks()
})

describe('useServerTrafficEvents', () => {
  // PR #594: a moving since timestamp used to allocate and fetch a new query
  // on every render, including the render caused by a successful response.
  test('keeps one settled request and cache entry across same-value rerenders', async () => {
    const { result, rerender } = renderHook(
      ({ filters }) => useServerTrafficEvents('demo', filters),
      { wrapper: Wrapper, initialProps: { filters } },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(response)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.pathname).toBe('/api/v1/projects/demo/traffic/events')
    expect(Object.fromEntries(requests[0]!.searchParams)).toEqual({
      sourceId: 'abc', since: '2026-08-25T00:00:00.000Z', limit: '1000', granularity: 'day',
    })
    const firstHash = queryClient.getQueryCache().getAll()[0]!.queryHash

    now += 1000
    rerender({ filters })
    now += 1000
    rerender({ filters: { ...filters } })

    expect(result.current.isSuccess).toBe(true)
    expect(result.current.isFetching).toBe(false)
    expect(queryClient.getQueryCache().getAll().map(query => query.queryHash)).toEqual([firstHash])
    expect(requests).toHaveLength(1)
  })

  test('fetches and caches a new window when sinceMinutes changes', async () => {
    const { result, rerender } = renderHook(
      ({ filters }) => useServerTrafficEvents('demo', filters),
      { wrapper: Wrapper, initialProps: { filters } },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(requests).toHaveLength(1)

    now += 1000
    rerender({ filters: { ...filters, sinceMinutes: 1440 } })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data).toEqual(response)
    expect(requests.map(request => request.searchParams.get('since'))).toEqual([
      '2026-08-25T00:00:00.000Z', '2026-08-31T00:00:01.000Z',
    ])
    expect(queryClient.getQueryCache().getAll()).toHaveLength(2)
  })
})
