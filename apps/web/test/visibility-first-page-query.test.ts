import { createElement } from 'react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { hashKey, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { VisibilityReportResponse } from '@ainyc/canonry-contracts'
import { getApiV1ProjectsByNameVisibilityReportQueryKey } from '@ainyc/canonry-api-client/react-query'
import { apiErrorDetails, heyClient } from '../src/api.js'
import { parseVisibilitySelection, visibilityReportFirstPageQuery } from '../src/lib/measurement-view-url.js'
import { useVisibilityReportFirstPage, VisibilityWorkspace } from '../src/components/project/VisibilityTrendSection.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(cleanup)

function report(scope: { id: string; label: string; kind: 'project' | 'group' }): VisibilityReportResponse {
  const rate = { numerator: 3, denominator: 4, rate: 0.75 }
  const row = { queryCount: 2, mentionCoverage: rate, citationCoverage: rate }
  const groupScope = { id: 'north', label: 'North', kind: 'group' as const, targetCount: 2 }
  return {
    selection: {
      mode: 'advanced', queryClass: 'non-brand', scope: scope.kind === 'project' ? { ...scope, targetCount: 2 } : groupScope,
      provider: 'gemini', model: null, location: { kind: 'all' }, time: { from: null, to: null },
      revision: 4, run: { id: 'run-4', explicit: false },
      provenance: { kind: 'frozen-advanced', definitionRevision: 4 },
      measurement: { state: 'measured', activeRevision: 4, measuredRevision: 4, awaitingSweep: false, pendingAssignmentCount: 0, completedAt: '2026-09-13T10:00:00Z' },
      availability: { state: 'available' },
    },
    scopeOptions: [{ id: 'project', label: 'Project', kind: 'project', targetCount: 2 }, groupScope],
    filterOptions: { providers: ['gemini'], models: [], locations: [{ kind: 'none' }] },
    populations: [{
      queryClass: 'non-brand',
      summary: { queryCount: 2, answerCount: 4, mentionCoverage: rate, citationCoverage: rate, propertyReach: { numerator: 2, denominator: 2, rate: 1 }, outcomes: { bothSignals: 2, mentionedOnly: 0, citedOnly: 0, neither: 0, notMeasured: 0, total: 2 } },
      trend: [{ runId: 'run-4', createdAt: '2026-09-13T10:00:00Z', revision: 4, provenance: { kind: 'frozen-advanced', definitionRevision: 4 }, queryCount: 2, answerCount: 4, mentionCoverage: rate, citationCoverage: rate, continuity: { state: 'first', comparedRunId: null } }],
      queries: { items: [], total: 0, nextCursor: null },
      evidence: { items: [], total: 0, nextCursor: null },
      competitors: [], competitorAvailability: { state: 'available' }, observedCompetitors: [],
      breakdown: { groups: [], properties: [{ ...row, id: 'harbor-house', label: 'Harbor House' }] },
    }],
  }
}

function wrapperFor(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children)
}

function reportRequests(requests: string[]) {
  return requests.filter(url => new URL(url).pathname.endsWith('/visibility-report'))
}

describe('visibilityReportFirstPageQuery', () => {
  it('carries every aggregate filter and nothing that belongs to answers, paging, or the run drawer', () => {
    const selection = parseVisibilitySelection({
      measurementScope: 'property', measurementScopeKey: 'harbor-house', measurementMarketKey: 'coastal-maine', queryClass: 'branded',
      measurementProvider: 'gemini', measurementModel: 'gemini-2.5-flash', measurementLocation: 'Portland, ME',
      measurementFrom: '2026-09-01T00:00:00.000Z', measurementTo: '2026-09-08T23:59:59.999Z', measurementRevision: '4',
      measurementRunId: 'run-7', measurementQueryKey: 'query-harbor', runId: 'drawer-run',
    })
    expect(visibilityReportFirstPageQuery(selection)).toStrictEqual({
      scope: 'property', scopeKey: 'harbor-house', marketKey: 'coastal-maine', queryClass: 'branded',
      provider: 'gemini', model: 'gemini-2.5-flash', location: 'Portland, ME',
      from: '2026-09-01T00:00:00.000Z', to: '2026-09-08T23:59:59.999Z', revision: 4, runId: 'run-7', limit: 25,
    })
  })

  it('keeps every key for a clean URL so the shape never depends on the selection', () => {
    expect(visibilityReportFirstPageQuery(parseVisibilitySelection({}))).toStrictEqual({
      scope: 'project', scopeKey: undefined, marketKey: undefined, queryClass: 'all',
      provider: undefined, model: undefined, location: undefined,
      from: undefined, to: undefined, revision: undefined, runId: undefined, limit: 25,
    })
  })
})

describe('useVisibilityReportFirstPage', () => {
  const scoped = parseVisibilitySelection({ measurementScope: 'group', measurementScopeKey: 'north', measurementMarketKey: 'coastal-maine', queryClass: 'non-brand', measurementProvider: 'gemini' })

  it('shares one cache entry and one request with the workspace first page', async () => {
    const requests: string[] = []
    onTestFinished(mockFetch(url => { requests.push(url); return jsonResponse(report({ id: 'north', label: 'North', kind: 'group' })) }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = wrapperFor(queryClient)

    render(createElement(VisibilityWorkspace, { projectName: 'demo', selection: scoped, onSelectionChange: () => {} }), { wrapper })
    const hook = renderHook(() => useVisibilityReportFirstPage('demo', scoped, { enabled: true }), { wrapper })
    await waitFor(() => expect(hook.result.current.data?.selection.scope.id).toBe('north'))

    const expectedHash = hashKey(getApiV1ProjectsByNameVisibilityReportQueryKey({ client: heyClient, path: { name: 'demo' }, query: visibilityReportFirstPageQuery(scoped) }))
    const firstPages = queryClient.getQueryCache().findAll().filter(query => {
      const key = query.queryKey[0] as { _id?: string; query?: { limit?: number } }
      return key._id === 'getApiV1ProjectsByNameVisibilityReport' && key.query?.limit === 25
    })
    expect(firstPages.map(query => query.queryHash)).toEqual([expectedHash])
    expect(reportRequests(requests)).toHaveLength(1)
    expect(Object.fromEntries(new URL(reportRequests(requests)[0]!).searchParams)).toEqual({
      scope: 'group', scopeKey: 'north', marketKey: 'coastal-maine', queryClass: 'non-brand', provider: 'gemini', limit: '25',
    })
  })

  it('reads nothing while disabled and reuses fresh data on a remount', async () => {
    const requests: string[] = []
    onTestFinished(mockFetch(url => { requests.push(url); return jsonResponse(report({ id: 'north', label: 'North', kind: 'group' })) }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = wrapperFor(queryClient)

    const disabled = renderHook(() => useVisibilityReportFirstPage('demo', scoped, { enabled: false }), { wrapper })
    expect(disabled.result.current.fetchStatus).toBe('idle')
    expect(reportRequests(requests)).toHaveLength(0)
    disabled.unmount()

    const first = renderHook(() => useVisibilityReportFirstPage('demo', scoped, { enabled: true }), { wrapper })
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true))
    first.unmount()
    const second = renderHook(() => useVisibilityReportFirstPage('demo', scoped, { enabled: true }), { wrapper })
    expect(second.result.current.data?.selection.scope.id).toBe('north')
    expect(second.result.current.isFetching).toBe(false)
    expect(reportRequests(requests)).toHaveLength(1)
  })

  it('keeps the previous report visible while a changed selection loads', async () => {
    let releaseProject: (() => void) | undefined
    const projectGate = new Promise<void>(resolve => { releaseProject = resolve })
    onTestFinished(mockFetch(async url => {
      if (new URL(url).searchParams.get('scope') === 'project') {
        await projectGate
        return jsonResponse(report({ id: 'project', label: 'Project', kind: 'project' }))
      }
      return jsonResponse(report({ id: 'north', label: 'North', kind: 'group' }))
    }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const hook = renderHook(({ selection }) => useVisibilityReportFirstPage('demo', selection, { enabled: true }), {
      wrapper: wrapperFor(queryClient),
      initialProps: { selection: scoped },
    })
    await waitFor(() => expect(hook.result.current.data?.selection.scope.id).toBe('north'))

    hook.rerender({ selection: parseVisibilitySelection({ queryClass: 'non-brand' }) })
    expect(hook.result.current.isPlaceholderData).toBe(true)
    expect(hook.result.current.data?.selection.scope.id).toBe('north')
    releaseProject!()
    await waitFor(() => expect(hook.result.current.data?.selection.scope.id).toBe('project'))
    expect(hook.result.current.isPlaceholderData).toBe(false)
  })

  it('surfaces a retired-scope envelope after one request, with details the web can read', async () => {
    const requests: string[] = []
    const details = { reason: 'retired-market', kind: 'market', key: 'coastal-maine' }
    onTestFinished(mockFetch(url => {
      requests.push(url)
      return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'Market "coastal-maine" is not in this frozen definition.', details } }, 400)
    }))
    // The client default retries; the hook must not.
    const queryClient = new QueryClient()
    onTestFinished(() => queryClient.clear())
    const hook = renderHook(() => useVisibilityReportFirstPage('demo', scoped, { enabled: true }), { wrapper: wrapperFor(queryClient) })

    await waitFor(() => expect(hook.result.current.isError).toBe(true))
    expect(reportRequests(requests)).toHaveLength(1)
    expect(apiErrorDetails(hook.result.current.error)).toEqual(details)
  })
})
