import { createElement, type ReactNode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchHealth, useHealth } from '../src/queries/use-health.js'

afterEach(() => {
  cleanup()
  focusManager.setFocused(undefined)
  vi.useRealTimers()
  delete window.__CANONRY_CONFIG__
  vi.unstubAllGlobals()
})

describe('fetchHealth', () => {
  it('discloses that background execution is disabled in the public demo', async () => {
    window.__CANONRY_CONFIG__ = { demo: { enabled: true, readOnly: true, sampleData: true } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))

    await expect(fetchHealth()).resolves.toMatchObject({
      apiStatus: { state: 'ok' },
      workerStatus: {
        label: 'Worker',
        state: 'disabled',
        detail: 'Background execution is disabled in this public demo.',
      },
    })
  })

  it('keeps the standard deployment status outside the public demo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))

    await expect(fetchHealth()).resolves.toMatchObject({
      workerStatus: { detail: 'In-process job runner' },
    })
  })
})

describe('health reads', () => {
  function setup() {
    vi.useFakeTimers()
    focusManager.setFocused(true)
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000, refetchOnWindowFocus: false } },
    })
    let version = 0
    const fetch = vi.fn(() => Response.json({ version: `1.0.${++version}` }))
    vi.stubGlobal('fetch', fetch)
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    return { fetch, wrapper }
  }

  async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  }

  it('refreshes the shared snapshot only while a foreground status view is polling', async () => {
    const { fetch, wrapper } = setup()
    const shell = renderHook(() => useHealth(true).data, { wrapper })
    await advance(30_001)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(shell.result.current?.apiStatus.version).toBe('1.0.1')

    const page = renderHook(() => useHealth(true, undefined, true).data, { wrapper })
    await advance(15_001)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(page.result.current?.apiStatus.version).toBe('1.0.2')
    expect(shell.result.current?.apiStatus.version).toBe('1.0.2')

    act(() => { focusManager.setFocused(false) })
    await advance(30_001)
    expect(fetch).toHaveBeenCalledTimes(2)
    act(() => { focusManager.setFocused(true) })
    page.unmount()
    await advance(60_001)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('refetches a stale passive snapshot when focus returns and reuses a fresh snapshot', async () => {
    const { fetch, wrapper } = setup()
    const shell = renderHook(() => useHealth(true).data, { wrapper })
    await advance(1)
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true) })
    await advance(1)
    expect(fetch).toHaveBeenCalledTimes(1)

    act(() => { focusManager.setFocused(false) })
    await advance(60_001)
    expect(fetch).toHaveBeenCalledTimes(1)
    act(() => { focusManager.setFocused(true) })
    await advance(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(shell.result.current?.apiStatus.version).toBe('1.0.2')
  })
})
