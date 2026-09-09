import { afterEach, describe, expect, onTestFinished, test } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'

import { useProjectDashboard } from '../src/queries/use-project-dashboard.js'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function project(name: string) {
  return {
    id: `${name}-id`, name, displayName: name, canonicalDomain: `${name}.example`,
    ownedDomains: [], aliases: [], country: 'US', language: 'en', tags: [], labels: [],
    providers: [], providerModels: {}, measurement: null, locations: [], defaultLocation: null,
    autoExtractBacklinks: false, configSource: 'config', configRevision: 1,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function run(id: string, projectName: string, createdAt: string, trigger = 'manual') {
  return {
    id, projectId: `${projectName}-id`, kind: 'answer-visibility', status: 'completed', trigger,
    createdAt, startedAt: createdAt, finishedAt: createdAt, location: null, error: null,
  }
}

function pathOf(input: RequestInfo | URL): string {
  const url = input instanceof Request ? input.url : String(input)
  return url.replace(/^https?:\/\/[^/]+/, '') || url
}

function installFetch(handler: (path: string) => Response | Promise<Response>) {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => handler(pathOf(input))) as typeof fetch
  return () => { globalThis.fetch = realFetch }
}

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children)
  }
  return { Wrapper, client }
}

function projectNameFrom(path: string): string {
  return path.match(/^\/api\/v1\/projects\/([^/?]+)/)?.[1] ?? 'alpha'
}

function standardResponse(path: string, runs = [run('run-1', 'alpha', '2026-01-01T00:00:00.000Z')]): Response {
  if (/^\/api\/v1\/projects\/[^/]+\/runs/.test(path)) return jsonResponse(runs)
  if (/^\/api\/v1\/projects\/[^/]+\/overview/.test(path)) return jsonResponse(null)
  if (/^\/api\/v1\/projects\/[^/]+\/queries/.test(path)) return jsonResponse([])
  if (/^\/api\/v1\/projects\/[^/]+\/timeline/.test(path)) return jsonResponse([])
  if (/^\/api\/v1\/runs\//.test(path)) return jsonResponse({ id: path.split('/').at(-1), snapshots: [] })
  if (/^\/api\/v1\/projects\/[^/?]+/.test(path)) return jsonResponse(project(projectNameFrom(path)))
  return jsonResponse({ error: `unexpected ${path}` }, 404)
}

afterEach(() => {
  delete window.__CANONRY_CONFIG__
})

describe('useProjectDashboard', () => {
  test('loads only project metadata and project-scoped runs by default', async () => {
    const paths: string[] = []
    const restoreFetch = installFetch(path => {
      paths.push(path)
      return standardResponse(path)
    })
    onTestFinished(restoreFetch)
    const { Wrapper, client } = makeWrapper()
    onTestFinished(() => client.clear())

    const { result } = renderHook(() => useProjectDashboard('alpha'), { wrapper: Wrapper })

    await waitFor(() => expect(result.current.project?.name).toBe('alpha'))
    expect(paths.some(path => /\/overview(?:\?|$)/.test(path))).toBe(false)
    expect(paths.some(path => /\/(?:queries|timeline)(?:\?|$)/.test(path))).toBe(false)
    expect(paths.some(path => /^\/api\/v1\/runs\//.test(path))).toBe(false)
    expect(paths.some(path => /\/(?:competitors|insights)(?:\?|$)|\/google\/gsc\/coverage|\/bing\/coverage/.test(path))).toBe(false)
  })

  test('keeps core metadata and overview usable while evidence is stalled', async () => {
    let releaseEvidence: (() => void) | undefined
    const stalledEvidence = new Promise<Response>(resolve => { releaseEvidence = () => resolve(jsonResponse([])) })
    const restoreFetch = installFetch(path => {
      if (/\/(?:queries|timeline)(?:\?|$)/.test(path)) return stalledEvidence
      return standardResponse(path)
    })
    onTestFinished(() => { releaseEvidence?.(); restoreFetch() })
    const { Wrapper, client } = makeWrapper()
    onTestFinished(() => client.clear())

    const { result } = renderHook(
      () => useProjectDashboard('alpha', { overview: true, evidence: true }),
      { wrapper: Wrapper },
    )

    await waitFor(() => {
      expect(result.current.project?.name).toBe('alpha')
      expect(result.current.overviewLoading).toBe(false)
    })
    expect(result.current.evidenceLoading).toBe(true)
  })

  test('starts and stops evidence reads only when evidence is enabled', async () => {
    const paths: string[] = []
    const restoreFetch = installFetch(path => {
      paths.push(path)
      return standardResponse(path)
    })
    onTestFinished(restoreFetch)
    const { Wrapper, client } = makeWrapper()
    onTestFinished(() => client.clear())

    const { result, rerender } = renderHook(
      ({ evidence }: { evidence: boolean }) => useProjectDashboard('alpha', { evidence }),
      { initialProps: { evidence: false }, wrapper: Wrapper },
    )
    await waitFor(() => expect(result.current.project?.name).toBe('alpha'))
    expect(paths.some(path => /\/(?:queries|timeline)(?:\?|$)/.test(path))).toBe(false)

    rerender({ evidence: true })
    await waitFor(() => expect(result.current.evidenceLoading).toBe(false))
    expect(paths.some(path => /\/queries(?:\?|$)/.test(path))).toBe(true)
    expect(paths.some(path => /\/timeline(?:\?|$)/.test(path))).toBe(true)
    expect(paths.some(path => /^\/api\/v1\/runs\/run-1(?:\?|$)/.test(path))).toBe(true)

    const evidenceReads = paths.filter(path => /\/(?:queries|timeline)(?:\?|$)/.test(path)).length
    rerender({ evidence: false })
    expect(paths.filter(path => /\/(?:queries|timeline)(?:\?|$)/.test(path)).length).toBe(evidenceReads)
  })

  test('rotates evidence to the latest completed sibling group and excludes probes', async () => {
    let generation = 0
    const paths: string[] = []
    const restoreFetch = installFetch(path => {
      paths.push(path)
      if (/^\/api\/v1\/projects\/alpha\/runs/.test(path)) {
        return jsonResponse(generation === 0
          ? [
              run('old', 'alpha', '2026-01-01T00:00:00.000Z'),
              run('probe', 'alpha', '2026-02-01T00:00:00.000Z', 'probe'),
            ]
          : [
              run('new-a', 'alpha', '2026-03-01T00:00:00.000Z'),
              run('new-b', 'alpha', '2026-03-01T00:00:00.000Z'),
              run('probe', 'alpha', '2026-04-01T00:00:00.000Z', 'probe'),
            ])
      }
      return standardResponse(path)
    })
    onTestFinished(restoreFetch)
    const { Wrapper, client } = makeWrapper()
    onTestFinished(() => client.clear())
    const { result } = renderHook(() => useProjectDashboard('alpha', { evidence: true }), { wrapper: Wrapper })

    await waitFor(() => expect(result.current.latestVisibilityRevision).toBe('2026-01-01T00:00:00.000Z:old'))
    await waitFor(() => expect(paths.some(path => /\/runs\/old(?:\?|$)/.test(path))).toBe(true))
    generation = 1
    await act(async () => { await result.current.refetch() })

    await waitFor(() => expect(result.current.latestVisibilityRevision).toBe('2026-03-01T00:00:00.000Z:new-a,new-b'))
    await waitFor(() => {
      expect(paths.some(path => /\/runs\/new-a(?:\?|$)/.test(path))).toBe(true)
      expect(paths.some(path => /\/runs\/new-b(?:\?|$)/.test(path))).toBe(true)
    })
    expect(paths.some(path => /\/runs\/probe(?:\?|$)/.test(path))).toBe(false)
  })

  test('refetching core state does not activate disabled optional queries', async () => {
    const paths: string[] = []
    const restoreFetch = installFetch(path => {
      paths.push(path)
      return standardResponse(path)
    })
    onTestFinished(restoreFetch)
    const { Wrapper, client } = makeWrapper()
    onTestFinished(() => client.clear())
    const { result } = renderHook(() => useProjectDashboard('alpha'), { wrapper: Wrapper })

    await waitFor(() => expect(result.current.project?.name).toBe('alpha'))
    await act(async () => { await result.current.refetch() })
    expect(paths.some(path => /\/(?:overview|queries|timeline)(?:\?|$)/.test(path))).toBe(false)
    expect(paths.some(path => /^\/api\/v1\/runs\//.test(path))).toBe(false)
  })

  test('isolates optional data when the project changes', async () => {
    const paths: string[] = []
    const restoreFetch = installFetch(path => {
      paths.push(path)
      return standardResponse(path, [run(`${projectNameFrom(path)}-run`, projectNameFrom(path), '2026-01-01T00:00:00.000Z')])
    })
    onTestFinished(restoreFetch)
    const { Wrapper, client } = makeWrapper()
    onTestFinished(() => client.clear())
    const { result, rerender } = renderHook(
      ({ name }: { name: string }) => useProjectDashboard(name, { overview: true }),
      { initialProps: { name: 'alpha' }, wrapper: Wrapper },
    )
    await waitFor(() => expect(result.current.project?.name).toBe('alpha'))

    rerender({ name: 'beta' })
    await waitFor(() => expect(result.current.project?.name).toBe('beta'))
    await waitFor(() => expect(paths.some(path => /^\/api\/v1\/projects\/beta\/overview/.test(path))).toBe(true))
    expect(result.current.latestVisibilityRevision).toBe('2026-01-01T00:00:00.000Z:beta-run')
  })

  test.each(['project', 'runs'])('stops the answer loading state when %s fails', async (failedRequest) => {
    const restoreFetch = installFetch(path => {
      const isFailedRequest = failedRequest === 'project'
        ? path === '/api/v1/projects/alpha'
        : path.startsWith('/api/v1/projects/alpha/runs')
      return isFailedRequest
        ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'try again' } }, 500)
        : standardResponse(path)
    })
    onTestFinished(restoreFetch)
    const { Wrapper, client } = makeWrapper()
    onTestFinished(() => client.clear())
    const { result } = renderHook(() => useProjectDashboard('alpha', { evidence: true }), { wrapper: Wrapper })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.evidenceLoading).toBe(false)
    expect(result.current.commandCenter).toBeNull()
  })

  test('keeps cached optional results visible when a background refresh fails', async () => {
    let failRefresh = false
    const restoreFetch = installFetch(path => {
      if (failRefresh && /\/(?:overview|timeline)(?:\?|$)/.test(path)) {
        return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'try again' } }, 500)
      }
      return standardResponse(path)
    })
    onTestFinished(restoreFetch)
    const { Wrapper, client } = makeWrapper()
    onTestFinished(() => client.clear())
    const { result } = renderHook(
      () => useProjectDashboard('alpha', { overview: true, evidence: true }),
      { wrapper: Wrapper },
    )
    await waitFor(() => {
      expect(result.current.overviewLoading).toBe(false)
      expect(result.current.evidenceLoading).toBe(false)
    })
    failRefresh = true
    await act(async () => { await result.current.refetch() })

    expect(client.getQueryState(['project-dashboard-full', 'alpha-id', 'run-1', 'overview'])?.status).toBe('error')
    expect(client.getQueryState(['project-dashboard-full', 'alpha-id', 'run-1', 'evidence'])?.status).toBe('error')
    expect(result.current.overviewError).toBe(false)
    expect(result.current.evidenceError).toBe(false)
    expect(result.current.commandCenter?.project.name).toBe('alpha')
  })

  test('exposes optional failures and retries the active optional query', async () => {
    let overviewAttempts = 0
    const restoreFetch = installFetch(path => {
      if (/\/overview(?:\?|$)/.test(path)) {
        overviewAttempts += 1
        return overviewAttempts === 1
          ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'try again' } }, 500)
          : jsonResponse(null)
      }
      return standardResponse(path)
    })
    onTestFinished(restoreFetch)
    const { Wrapper, client } = makeWrapper()
    onTestFinished(() => client.clear())
    const { result } = renderHook(() => useProjectDashboard('alpha', { overview: true }), { wrapper: Wrapper })

    await waitFor(() => expect(result.current.overviewError).toBe(true))
    await act(async () => { await result.current.refetch() })
    await waitFor(() => expect(result.current.overviewError).toBe(false))
    expect(overviewAttempts).toBeGreaterThanOrEqual(2)
  })
})
