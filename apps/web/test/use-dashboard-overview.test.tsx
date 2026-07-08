import { afterEach, describe, expect, onTestFinished, test } from 'vitest'
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
})
