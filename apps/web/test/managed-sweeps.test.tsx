import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { isDashboardManagedSweeps } from '../src/api.js'
import { ManagedSweepStatus, MANAGED_SWEEPS_COPY } from '../src/components/project/ManagedSweepStatus.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete window.__CANONRY_CONFIG__
})

test('managed sweeps is opt-in, including without a browser', () => {
  expect(isDashboardManagedSweeps()).toBe(false)
  window.__CANONRY_CONFIG__ = { dashboard: { managedSweeps: false } }
  expect(isDashboardManagedSweeps()).toBe(false)
  window.__CANONRY_CONFIG__ = { dashboard: { managedSweeps: true } }
  expect(isDashboardManagedSweeps()).toBe(true)
  vi.stubGlobal('window', undefined)
  expect(isDashboardManagedSweeps()).toBe(false)
})

const schedule = {
  id: 'schedule', projectId: 'project', kind: 'answer-visibility', enabled: true,
  cronExpr: '0 6 * * *', timezone: 'America/New_York', providers: [],
  nextRunAt: '2026-09-08T06:00:00.000Z', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
}

function renderSchedule(response: unknown, status = 200) {
  const request = vi.fn(async () => new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', request)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const page = render(<QueryClientProvider client={client}><ManagedSweepStatus projectName="example" /></QueryClientProvider>)
  return { ...page, request, client }
}

test('reads the answer-visibility schedule and renders its real nextRunAt in UTC', async () => {
  const { request, container } = renderSchedule(schedule)
  await screen.findByText(/Next sync/)
  const url = new URL((request.mock.calls[0] as unknown as [Request])[0].url)
  expect(url.pathname).toBe('/api/v1/projects/example/schedule')
  expect(url.searchParams.get('kind')).toBe('answer-visibility')
  expect(screen.getByRole('status').textContent).toBe('Next sync Tuesday 8 Sept, 06:00 UTC · managed by your Canonry team')
  expect(container.querySelector('time')?.dateTime).toBe(schedule.nextRunAt)
})

test.each([
  ['no schedule', { error: { code: 'NOT_FOUND' } }, 404],
  ['no next-run time', { ...schedule, nextRunAt: null }, 200],
  ['paused schedule', { ...schedule, enabled: false }, 200],
  ['invalid next-run time', { ...schedule, nextRunAt: 'invalid' }, 200],
  ['failed schedule read', { error: { code: 'INTERNAL_ERROR' } }, 500],
] as const)('%s shows the managed fallback without a date', async (_label, response, status) => {
  const { container, client } = renderSchedule(response, status)
  await waitFor(() => expect(client.isFetching()).toBe(0))
  expect(screen.getByRole('status').textContent).toBe(MANAGED_SWEEPS_COPY)
  expect(container.querySelector('time')).toBeNull()
  expect(container.textContent).not.toMatch(/Next sync|2026|UTC|Invalid Date/)
})
