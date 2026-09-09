import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest'
import { waitFor, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'

import { useDashboardOverview } from '../src/queries/use-dashboard-overview.js'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function mockFetch(handler: (path: string) => Response | Promise<Response>) {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    const path = url.replace(/^https?:\/\/[^/]+/, '') || url
    return handler(path)
  }) as typeof fetch
  return () => {
    globalThis.fetch = realFetch
  }
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return createElement(QueryClientProvider, { client }, children)
}

const metadataProject = {
  id: 'alpha-id', name: 'alpha', displayName: 'Alpha', canonicalDomain: 'alpha.example',
  ownedDomains: [], aliases: [], country: 'US', language: 'en', tags: [], labels: [],
  providers: [], providerModels: {}, measurement: null, locations: [], defaultLocation: null,
  autoExtractBacklinks: false, configSource: 'config', configRevision: 1,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}

afterEach(() => {
  delete window.__CANONRY_CONFIG__
})

describe('useDashboardOverview', () => {
  test('can skip the global settings read for embed rendering', async () => {
    const paths: string[] = []
    const restoreFetch = mockFetch((path) => {
      paths.push(path)
      if (path.startsWith('/api/v1/projects')) return jsonResponse([])
      if (path.startsWith('/api/v1/runs')) return jsonResponse([])
      if (path.startsWith('/api/v1/settings')) return jsonResponse({ error: 'settings should not be fetched' }, 500)
      return jsonResponse({})
    })
    onTestFinished(restoreFetch)

    renderHook(
      () => useDashboardOverview(null, { includeSettings: false }),
      { wrapper },
    )

    await waitFor(() => {
      expect(paths.some(path => path.startsWith('/api/v1/projects'))).toBe(true)
      expect(paths.some(path => path.startsWith('/api/v1/runs'))).toBe(true)
    })
    expect(paths.some(path => path.startsWith('/api/v1/settings'))).toBe(false)
  })

  test('does not poll the empty project list while focused setup owns creation', async () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    let projectReads = 0
    const restoreFetch = mockFetch((path) => {
      if (path.startsWith('/api/v1/projects')) {
        projectReads += 1
        return jsonResponse([])
      }
      if (path.startsWith('/api/v1/runs')) return jsonResponse([])
      return jsonResponse({ providers: [] })
    })
    onTestFinished(restoreFetch)

    renderHook(
      () => useDashboardOverview(null, { includeSettings: false, pauseProjectPolling: true }),
      { wrapper },
    )

    await vi.waitFor(() => { expect(projectReads).toBe(1) })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(projectReads).toBe(1)
  })

  test('builds the metadata dashboard without fetching or refetching project overviews', async () => {
    const paths: string[] = []
    const restoreFetch = mockFetch((path) => {
      paths.push(path)
      if (path.startsWith('/api/v1/projects')) return jsonResponse([metadataProject])
      if (path.startsWith('/api/v1/runs')) return jsonResponse([])
      return jsonResponse({ error: `unexpected ${path}` }, 404)
    })
    onTestFinished(restoreFetch)

    const { result } = renderHook(
      () => useDashboardOverview(null, { includeSettings: false, includeOverviews: false }),
      { wrapper },
    )

    await waitFor(() => expect(result.current.dashboard?.projects.map(project => project.project.name)).toEqual(['alpha']))
    expect(paths.some(path => /\/overview(?:\?|$)/.test(path))).toBe(false)

    await result.current.refetch()
    expect(paths.some(path => /\/overview(?:\?|$)/.test(path))).toBe(false)
  })
})
