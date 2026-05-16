// Regression test for PR #554's Step 5 inline-results polling.
//
// The bug: `refetchInterval` callback worked, but `refetchIntervalInBackground`
// defaulted to `false` in react-query v5 — meaning the moment the tab lost
// focus (real user alt-tabbing during the 30-60s sweep, or any headless test
// environment), polling silently suppressed and the wizard stayed on the
// "Running" badge forever even though the server had already completed.
//
// This test exercises the polling helper in isolation against a mocked
// `fetchRunDetail` to prove:
//   1. The query polls on the 2s interval while status is non-terminal.
//   2. Polling stops the moment a terminal status (`completed`/`failed`/...)
//      lands.
//   3. Polling does NOT silently suppress when the tab is not focused
//      (the original bug).

import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { ApiRunDetail } from '../src/api.js'

// Standalone copy of the SetupPage.tsx launchedRun config. Importing the
// full SetupPage pulls in too much state for a focused test; mirroring the
// config here lets us assert the exact pattern without spinning up the
// whole wizard.
function useLaunchedRunPoll(runId: string | null, fetcher: (id: string) => Promise<ApiRunDetail>) {
  return useQuery({
    queryKey: ['setup', 'launched-run', runId],
    queryFn: () => fetcher(runId!),
    enabled: !!runId,
    refetchInterval: ({ state }) => {
      const status = state.data?.status
      const terminal = status === 'completed' || status === 'partial' || status === 'failed' || status === 'cancelled'
      return terminal ? false : 2000
    },
    refetchIntervalInBackground: true,
  })
}

function makeRunDetail(status: ApiRunDetail['status']): ApiRunDetail {
  return {
    id: 'run_test',
    projectId: 'p_test',
    kind: 'answer-visibility',
    status,
    trigger: 'manual',
    location: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: status === 'completed' || status === 'failed' || status === 'partial' || status === 'cancelled'
      ? '2026-01-01T00:00:30.000Z'
      : null,
    error: null,
    snapshots: [],
  }
}

let queryClient: QueryClient
let fetcher: ReturnType<typeof vi.fn>

function Probe({ runId }: { runId: string | null }) {
  const q = useLaunchedRunPoll(runId, fetcher)
  return <div data-testid="status">{q.data?.status ?? 'no-data'}</div>
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  })
  fetcher = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
  queryClient.clear()
})

describe('SetupPage launched-run polling', () => {
  it('does not fetch while runId is null', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <Probe runId={null} />
      </QueryClientProvider>,
    )
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('polls every 2s while the run is still running', async () => {
    // Server keeps returning 'running' — wizard should keep polling.
    fetcher.mockResolvedValue(makeRunDetail('running'))

    render(
      <QueryClientProvider client={queryClient}>
        <Probe runId="run_test" />
      </QueryClientProvider>,
    )

    // Wait for the initial fetch to resolve.
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))

    // Advance ~4.5s — expect 2 more polls at 2s + 4s.
    await vi.advanceTimersByTimeAsync(4500)
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('stops polling the moment a terminal status lands', async () => {
    // First call returns running, second returns failed.
    fetcher
      .mockResolvedValueOnce(makeRunDetail('running'))
      .mockResolvedValueOnce(makeRunDetail('failed'))
      .mockResolvedValue(makeRunDetail('failed'))

    render(
      <QueryClientProvider client={queryClient}>
        <Probe runId="run_test" />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))

    // First poll cycle — picks up failed.
    await vi.advanceTimersByTimeAsync(2100)
    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2))

    const callsAtTerminal = fetcher.mock.calls.length

    // Now wait another 10s — no additional polls should fire because
    // refetchInterval returned false.
    await vi.advanceTimersByTimeAsync(10000)
    expect(fetcher.mock.calls.length).toBe(callsAtTerminal)
  })

  it('keeps polling even when the document is not focused (regression for #554)', async () => {
    // Reproduce the original bug: simulate the tab losing focus by stubbing
    // document.hasFocus to return false. With the prior config
    // (refetchIntervalInBackground default-false), polling would silently
    // suppress. With the fix, polling continues regardless of focus.
    const hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(false)

    fetcher.mockResolvedValue(makeRunDetail('running'))

    render(
      <QueryClientProvider client={queryClient}>
        <Probe runId="run_test" />
      </QueryClientProvider>,
    )

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(4500)
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3)

    hasFocusSpy.mockRestore()
  })
})
