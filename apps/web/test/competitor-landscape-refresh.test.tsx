import React from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { focusManager, QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { getApiV1ProjectsByNameAnalyticsCompetitorsQueryKey } from '@canonry/canonry-api-client/react-query'
import { heyClient } from '../src/api.js'
import { competitorEvidenceRevision, useCompetitorLandscapeRefresh } from '../src/queries/competitor-landscape-refresh.js'
import { invalidateQueriesForRunKind } from '../src/queries/run-invalidations.js'

afterEach(() => { cleanup(); focusManager.setFocused(undefined) })

test('completion revisions cover older runs, but exclude running, probe and unrelated work', () => {
  const completed = { id: 'newer', kind: 'answer-visibility', status: 'completed', trigger: 'manual' } as const
  const older = { ...completed, id: 'older', status: 'running' as const }
  const before = competitorEvidenceRevision([completed, older])
  expect(competitorEvidenceRevision([older, completed])).toBe(before)
  expect(competitorEvidenceRevision([completed, { ...older, status: 'partial' }])).not.toBe(before)
  expect(competitorEvidenceRevision([completed, { ...completed, id: 'probe', trigger: 'probe' }, { ...completed, id: 'audit', kind: 'site-audit' }])).toBe(before)
})

test.each([false, true])('a revision change supersedes an in-flight old-history read (cached=%s)', async cached => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const key = getApiV1ProjectsByNameAnalyticsCompetitorsQueryKey({ client: heyClient, path: { name: 'demo' }, query: { window: '30d' } })
  let finishOld: ((value: { observed: string[] }) => void) | undefined
  if (cached) client.setQueryData(key, { observed: ['initial'] })
  const fetchLandscape = vi.fn()
    .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
    .mockResolvedValue({ observed: ['fresh-rival'] })
  const { rerender } = renderHook(({ revision }) => {
    useQuery({ queryKey: key, queryFn: fetchLandscape, staleTime: 0 })
    useCompetitorLandscapeRefresh('demo', revision, true)
  }, {
    initialProps: { revision: 'before-pin' },
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  })
  await waitFor(() => expect(fetchLandscape).toHaveBeenCalledTimes(1))
  rerender({ revision: 'after-pin' })
  await waitFor(() => expect(client.getQueryData(key)).toEqual({ observed: ['fresh-rival'] }))
  expect(fetchLandscape).toHaveBeenCalledTimes(2)
  await act(async () => { finishOld?.({ observed: ['stale-rival'] }) })
  expect(client.getQueryData(key)).toEqual({ observed: ['fresh-rival'] })
})

for (const query of [{ window: '30d' as const }, { window: '30d' as const, groupKey: 'north' }, { window: '30d' as const, scope: 'all-markets' as const }]) {
  test(`poll-driven completions, pins and publication refresh ${JSON.stringify(query)} once per revision`, async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
    const fetchLandscape = vi.fn().mockResolvedValue({ observed: [] })
    const key = getApiV1ProjectsByNameAnalyticsCompetitorsQueryKey({ client: heyClient, path: { name: 'demo' }, query })
    const { rerender } = renderHook(({ revision }) => {
      useQuery({ queryKey: key, queryFn: fetchLandscape, staleTime: 0, refetchOnWindowFocus: 'always' })
      useCompetitorLandscapeRefresh('demo', revision, true)
    }, {
      initialProps: { revision: 'history-1/pins-1/active-1/draft-none' },
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    })
    await waitFor(() => expect(fetchLandscape).toHaveBeenCalledTimes(1))
    await act(async () => { invalidateQueriesForRunKind(client, 'answer-visibility', 'demo') })
    expect(fetchLandscape).toHaveBeenCalledTimes(1)
    rerender({ revision: 'history-2/pins-1/active-1/draft-none' })
    await waitFor(() => expect(fetchLandscape).toHaveBeenCalledTimes(2))
    rerender({ revision: 'history-2/pins-1/active-1/draft-none' })
    expect(fetchLandscape).toHaveBeenCalledTimes(2)
    rerender({ revision: 'history-2/pins-2/active-1/draft-none' })
    await waitFor(() => expect(fetchLandscape).toHaveBeenCalledTimes(3))
    rerender({ revision: 'history-2/pins-2/active-1/draft-2' })
    await waitFor(() => expect(fetchLandscape).toHaveBeenCalledTimes(4))
    rerender({ revision: 'history-2/pins-2/active-2/draft-none' })
    await waitFor(() => expect(fetchLandscape).toHaveBeenCalledTimes(5))
    // Agent/CLI source classifications do not alter run identity. Focus is the
    // explicit external-state refresh boundary, even with the app default off.
    await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true) })
    await waitFor(() => expect(fetchLandscape).toHaveBeenCalledTimes(6))
  })
}
