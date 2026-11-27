import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { RunKinds, RunStatuses, RunTriggers, type RunDto } from '@canonry/canonry-contracts'

import { AuditHistoryPanel } from '../src/components/shared/AuditHistoryPanel.js'
import { ProjectHistorySection } from '../src/components/project/ProjectHistorySection.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test.each([false, true])('project comparison offers selectors only for two eligible checks (pair: %s)', async hasPair => {
  const earlier: RunDto = { id: 'earlier', projectId: 'example', kind: RunKinds['answer-visibility'], status: RunStatuses.completed, trigger: RunTriggers.manual, createdAt: '2026-11-01T10:00:00Z' }
  const later: RunDto = { ...earlier, id: 'later', status: RunStatuses.partial, createdAt: '2026-11-02T10:00:00Z' }
  const reads: URL[] = []
  vi.stubGlobal('fetch', async (request: Request) => {
    const url = new URL(request.url)
    reads.push(url)
    if (url.pathname === '/api/v1/projects/example/history') return jsonResponse([])
    if (url.pathname === '/api/v1/projects/example/runs') return jsonResponse([
      earlier, ...(hasPair ? [later] : []),
      { ...later, id: 'running', status: RunStatuses.running },
      { ...later, id: 'probe', trigger: RunTriggers.probe },
    ])
    if (url.pathname === '/api/v1/projects/example/snapshots/diff') return jsonResponse({ diff: [] })
    if (url.pathname === '/api/v1/projects/example/health/history') return jsonResponse([])
    throw new Error(`Unexpected project history request ${url.pathname}`)
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  onTestFinished(() => { cleanup(); queryClient.clear() })
  render(<QueryClientProvider client={queryClient}><ProjectHistorySection projectName="example" /></QueryClientProvider>)

  const changes = screen.getByRole('tab', { name: 'Changes' })
  const compare = screen.getByRole('tab', { name: 'Compare runs' })
  expect(changes.tabIndex).toBe(0)
  expect(compare.tabIndex).toBe(-1)
  changes.focus()
  fireEvent.keyDown(changes, { key: 'End' })
  expect(document.activeElement).toBe(compare)
  expect(screen.getByRole('tabpanel', { name: 'Compare runs' })).toBeTruthy()
  if (hasPair) {
    await screen.findByRole('heading', { name: 'No mention or citation changes' })
    const earlierSelect = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Earlier run' })
    const laterSelect = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Later run' })
    expect(earlierSelect.value).toBe('earlier')
    expect(laterSelect.value).toBe('later')
    expect(Array.from(earlierSelect.options, option => option.value).sort()).toEqual(['earlier', 'later'])
    expect(Array.from(laterSelect.options, option => option.value).sort()).toEqual(['earlier', 'later'])
    expect(Object.fromEntries(reads.find(url => url.pathname.endsWith('/snapshots/diff'))!.searchParams)).toEqual({ run1: 'earlier', run2: 'later' })
  } else {
    await screen.findByRole('heading', { name: 'Two completed checks are required' })
    expect(screen.queryByRole('combobox', { name: 'Earlier run' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Later run' })).toBeNull()
    expect(reads.some(url => url.pathname.endsWith('/snapshots/diff'))).toBe(false)
  }
  expect(screen.getByRole('region', { name: 'Compare answer visibility runs', exact: true })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'See which tracked queries changed mention or citation state between two checks.' })).toBeTruthy()
  fireEvent.keyDown(compare, { key: 'ArrowLeft' })
  const coverage = screen.getByRole('tab', { name: 'Coverage history' })
  expect(document.activeElement).toBe(coverage)
  expect(coverage.tabIndex).toBe(0)
  expect(compare.tabIndex).toBe(-1)
  await screen.findByRole('heading', { name: 'No coverage history yet' })
  expect(screen.getByRole('region', { name: 'Mention and citation coverage', exact: true })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Independent answer-text mentions and source citations across completed checks.' })).toBeTruthy()
  fireEvent.keyDown(coverage, { key: 'Home' })
  expect(document.activeElement).toBe(changes)
  fireEvent.keyDown(changes, { key: 'ArrowLeft' })
  expect(document.activeElement).toBe(compare)
  fireEvent.keyDown(compare, { key: 'ArrowRight' })
  expect(document.activeElement).toBe(changes)
})

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('shows retained deleted-project evidence, client attribution, session, and field diff', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes('/api/v1/history')) {
      return jsonResponse([{
        id: 'audit-1',
        projectId: 'deleted-project-id',
        actor: 'api',
        action: 'project.updated',
        entityType: 'project',
        entityId: 'deleted-project-id',
        diff: { displayName: { before: 'Old', after: 'New' } },
        userAgent: 'Mozilla/5.0',
        actorSession: 'session-123',
        createdAt: '2026-07-14T18:16:33.000Z',
      }])
    }
    if (url.includes('/api/v1/projects')) return jsonResponse([])
    throw new Error(`Unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AuditHistoryPanel />
    </QueryClientProvider>,
  )

  await waitFor(() => expect(screen.getByText(/Deleted project · deleted-project-id/)).not.toBeNull())
  expect(screen.getByText('Dashboard')).not.toBeNull()
  expect(screen.getByText('Session session-123')).not.toBeNull()

  fireEvent.click(screen.getByText('View diff'))
  expect(screen.getByText(/"before": "Old"/)).not.toBeNull()

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  cleanup()
  queryClient.clear()
})
