import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest'
import { act, waitFor, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { RunKinds, RunStatuses, RunTriggers, type RunDto } from '@canonry/canonry-contracts'
import { getApiV1ProjectsQueryKey } from '@canonry/canonry-api-client/react-query'

import { heyClient } from '../src/api.js'
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
  test('updates project metadata from the refreshed list while retaining cached summaries', async () => {
    let currentProject = metadataProject
    let overviewReads = 0
    const restoreFetch = mockFetch((path) => {
      const url = new URL(path, 'http://localhost')
      if (url.pathname === '/api/v1/projects/alpha/overview') {
        overviewReads += 1
        return jsonResponse(null)
      }
      if (url.pathname === '/api/v1/projects') return jsonResponse([currentProject])
      if (url.pathname === '/api/v1/runs') return jsonResponse([])
      return jsonResponse({ error: `unexpected ${path}` }, 404)
    })
    onTestFinished(restoreFetch)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    onTestFinished(() => client.clear())
    const { result } = renderHook(() => useDashboardOverview(null, { includeSettings: false }), {
      wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
    })
    await waitFor(() => expect(result.current.dashboard?.projects[0]?.project.displayName).toBe('Alpha'))
    expect(overviewReads).toBe(1)

    currentProject = { ...metadataProject, displayName: 'Alpha renamed', canonicalDomain: 'renamed.example' }
    await act(async () => {
      await client.invalidateQueries({ queryKey: getApiV1ProjectsQueryKey({ client: heyClient }) })
    })

    await waitFor(() => expect(result.current.dashboard?.projects[0]?.project.displayName).toBe('Alpha renamed'))
    expect(result.current.dashboard?.projects[0]?.project.canonicalDomain).toBe('renamed.example')
    expect(result.current.dashboard?.portfolioOverview.projects[0]?.project.displayName).toBe('Alpha renamed')
    expect(overviewReads).toBe(1)
  })

  test('shows the server\'s Activity for the projects it lists, named and with its window, apart from the sweep history', async () => {
    const beta = { ...metadataProject, id: 'beta-id', name: 'beta', displayName: 'Beta' }
    const run = (id: string, kind: RunDto['kind'], day: number, projectId = metadataProject.id): RunDto => ({
      id, projectId, kind, status: RunStatuses.completed, trigger: RunTriggers.manual,
      createdAt: `2026-02-${String(day).padStart(2, '0')}T00:00:00.000Z`,
    })
    const sweeps: RunDto[] = [
      { ...run('failed-sweep', RunKinds['answer-visibility'], 12), status: RunStatuses.failed },
      run('alpha-sweep', RunKinds['answer-visibility'], 6),
      run('alpha-previous', RunKinds['answer-visibility'], 4),
      { ...run('beta-sweep', RunKinds['answer-visibility'], 3, beta.id), measurementPlanVersionId: 'published-plan' },
    ]
    // The server has already picked each job's latest run that needs attention.
    const activity = {
      since: '2026-01-23T00:00:00.000Z',
      items: [
        { project: { id: metadataProject.id, name: metadataProject.name, displayName: 'Alpha' }, run: sweeps[0]! },
        { project: { id: beta.id, name: beta.name, displayName: 'Beta' }, run: { ...run('ads', RunKinds['google-ads-sync'], 8, beta.id), status: RunStatuses.running } },
        // A project this dashboard does not list is left out.
        { project: { id: 'gone-id', name: 'gone', displayName: 'Gone' }, run: { ...run('gone-audit', RunKinds['site-audit'], 7, 'gone-id'), status: RunStatuses.failed } },
      ],
    }
    const restoreFetch = mockFetch((path) => {
      const url = new URL(path, 'http://localhost')
      if (/\/projects\/[^/]+\/overview$/.test(url.pathname)) return jsonResponse(null)
      if (url.pathname === '/api/v1/projects') return jsonResponse([metadataProject, beta])
      if (url.pathname === '/api/v1/runs/attention') return jsonResponse(activity)
      if (url.pathname === '/api/v1/runs' && url.searchParams.get('kind') === RunKinds['answer-visibility']) return jsonResponse(sweeps)
      return jsonResponse({ error: `unexpected ${path}` }, 404)
    })
    onTestFinished(restoreFetch)

    const { result } = renderHook(() => useDashboardOverview(null, { includeSettings: false }), { wrapper })

    await waitFor(() => expect(result.current.dashboard?.portfolioOverview.recentRuns.map(item => [
      item.id, item.projectName, item.status,
    ])).toEqual([
      ['failed-sweep', 'Alpha', RunStatuses.failed],
      ['ads', 'Beta', RunStatuses.running],
    ]))
    expect(result.current.dashboard?.portfolioOverview.activitySince).toBe('2026-01-23T00:00:00.000Z')
    expect(result.current.dashboard?.projects.map(project => [
      project.project.name, project.visibilitySweeps.map(item => item.id),
    ])).toEqual([
      ['alpha', ['alpha-sweep', 'alpha-previous']],
      ['beta', ['beta-sweep']],
    ])
    expect(result.current.dashboard?.portfolioOverview.projects.map(project => project.lastRun.id))
      .toEqual(['failed-sweep', 'beta-sweep'])
  })

  test('keeps the dashboard available when Activity refresh fails and recovers on retry', async () => {
    let failActivity = false
    const sweep: RunDto = {
      id: 'saved-sweep', projectId: metadataProject.id, kind: RunKinds['answer-visibility'],
      status: RunStatuses.completed, trigger: RunTriggers.manual, createdAt: '2026-02-01T00:00:00.000Z',
    }
    const audit: RunDto = { ...sweep, id: 'saved-audit', kind: RunKinds['site-audit'], status: RunStatuses.failed, createdAt: '2026-02-02T00:00:00.000Z' }
    const project = { id: metadataProject.id, name: metadataProject.name, displayName: metadataProject.displayName }
    const restoreFetch = mockFetch((path) => {
      const url = new URL(path, 'http://localhost')
      if (/\/projects\/[^/]+\/overview$/.test(url.pathname)) return jsonResponse(null)
      if (url.pathname === '/api/v1/projects') return jsonResponse([metadataProject])
      if (url.pathname === '/api/v1/runs/attention') {
        if (failActivity) return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Activity unavailable' } }, 500)
        return jsonResponse({ since: '2026-01-03T00:00:00.000Z', items: [{ project, run: audit }] })
      }
      if (url.pathname === '/api/v1/runs' && url.searchParams.get('kind') === RunKinds['answer-visibility']) return jsonResponse([sweep])
      return jsonResponse({ error: `unexpected ${path}` }, 404)
    })
    onTestFinished(restoreFetch)

    const { result } = renderHook(() => useDashboardOverview(null, { includeSettings: false }), { wrapper })
    await waitFor(() => expect(result.current.dashboard?.portfolioOverview.recentRuns.map(item => item.id)).toEqual(['saved-audit']))

    failActivity = true
    await result.current.refetch()
    await waitFor(() => expect(result.current.activityError).toBe(true))
    expect(result.current.isError).toBe(false)
    expect(result.current.dashboard?.projects[0]?.visibilitySweeps.map(item => item.id)).toEqual(['saved-sweep'])

    failActivity = false
    audit.id = 'refreshed-audit'
    await result.current.refetch()
    await waitFor(() => {
      expect(result.current.activityError).toBe(false)
      expect(result.current.dashboard?.portfolioOverview.recentRuns.map(item => item.id)).toEqual(['refreshed-audit'])
    })
  })

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
    expect(paths.filter(path => path.startsWith('/api/v1/runs')).every(path =>
      new URL(path, 'http://localhost').searchParams.get('kind') === RunKinds['answer-visibility'])).toBe(true)

    await result.current.refetch()
    expect(paths.some(path => /\/overview(?:\?|$)/.test(path))).toBe(false)
    expect(paths.filter(path => path.startsWith('/api/v1/runs')).every(path =>
      new URL(path, 'http://localhost').searchParams.get('kind') === RunKinds['answer-visibility'])).toBe(true)
  })

  test('keeps broader job history out of the read-only embed request surface', async () => {
    window.__CANONRY_CONFIG__ = { embed: { enabled: true } }
    const kinds: Array<string | null> = []
    const restoreFetch = mockFetch((path) => {
      const url = new URL(path, 'http://localhost')
      if (url.pathname === '/api/v1/projects') return jsonResponse([])
      if (url.pathname === '/api/v1/runs') {
        kinds.push(url.searchParams.get('kind'))
        return jsonResponse([])
      }
      return jsonResponse({ error: `unexpected ${path}` }, 404)
    })
    onTestFinished(restoreFetch)

    const { result } = renderHook(() => useDashboardOverview(null, { includeSettings: false }), { wrapper })
    await waitFor(() => expect(result.current.dashboard).not.toBeNull())
    await result.current.refetch()
    expect(kinds).toEqual([RunKinds['answer-visibility'], RunKinds['answer-visibility']])
  })
})
