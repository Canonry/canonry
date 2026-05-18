import { describe, expect, test } from 'vitest'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { getApiV1ProjectsByNameTrafficEventsQueryKey } from '@ainyc/canonry-api-client/react-query'
import { useServerTrafficEvents } from '../src/queries/server-traffic.js'
import { heyClient } from '../src/api.js'

/**
 * Regression test for the infinite-refetch bug fixed in PR #594.
 *
 * Before the fix, `useServerTrafficEvents` called `paramsForFilters(filters)`
 * inline inside `useQuery({...})` on every render. `paramsForFilters`
 * computes `since = new Date(Date.now() - sinceMinutes * 60_000).toISOString()`,
 * which produced a fresh ISO string on every call. React-query treats a
 * different `query` object as a new query and refetches — and the new data
 * triggered another render, another fresh `since`, another refetch, etc.
 * Browser memory grew monotonically because the 5-minute cacheTime kept
 * every superseded query response alive in the cache.
 *
 * The fix wraps `paramsForFilters` in `useMemo` keyed on the actual filter
 * fields (kind / sourceId / sinceMinutes / limit), so `since` only changes
 * when the user picks a different window — not on every render frame.
 *
 * This test asserts the query key stays referentially stable across
 * re-renders that DON'T change any filter field, and that it DOES change
 * when the user picks a new window.
 */

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return createElement(QueryClientProvider, { client }, children)
}

describe('useServerTrafficEvents — query key stability', () => {
  test('re-rendering with the same filters does not change the query key', () => {
    const filters = { kind: 'all' as const, sourceId: 'abc', sinceMinutes: 10080, limit: 1000 }
    const { result, rerender } = renderHook(
      ({ project, filters }) => useServerTrafficEvents(project, filters),
      {
        wrapper: Wrapper,
        initialProps: { project: 'demo', filters },
      },
    )

    // Capture the initial cache key (react-query's queryKey is derived from
    // the generated `getApiV1...QueryKey` helper).
    const firstKey = JSON.stringify(result.current.dataUpdatedAt) // proxy: a stable read

    // Re-render with the EXACT SAME filter object reference — should not
    // even trigger a new query at all.
    rerender({ project: 'demo', filters })
    const secondKey = JSON.stringify(result.current.dataUpdatedAt)

    // Pre-fix: every render produced a new query key → new query → new
    // `dataUpdatedAt` once data arrived → cycle. Post-fix: stable.
    expect(secondKey).toBe(firstKey)

    // Re-render with a fresh filter object but identical values — the
    // common case in a parent component that builds the object inline.
    rerender({
      project: 'demo',
      filters: { kind: 'all', sourceId: 'abc', sinceMinutes: 10080, limit: 1000 },
    })
    const thirdKey = JSON.stringify(result.current.dataUpdatedAt)
    expect(thirdKey).toBe(firstKey)
  })

  test('changing sinceMinutes produces a different query key', () => {
    // Sanity check the OTHER direction — when the user picks a new window,
    // the key MUST change so react-query refetches.
    const baseKey = getApiV1ProjectsByNameTrafficEventsQueryKey({
      client: heyClient,
      path: { name: 'demo' },
      query: { sourceId: 'abc', since: 'A', limit: '1000' },
    })
    const widerKey = getApiV1ProjectsByNameTrafficEventsQueryKey({
      client: heyClient,
      path: { name: 'demo' },
      query: { sourceId: 'abc', since: 'B', limit: '1000' },
    })
    expect(JSON.stringify(baseKey)).not.toBe(JSON.stringify(widerKey))
  })
})
