import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { isDashboardManagedRunKind, isDashboardManagedSweeps } from '../src/api.js'
import { ManagedSweepStatus, MANAGED_SWEEPS_UNAVAILABLE_COPY, MANAGED_SWEEPS_RUNNING_COPY, MANAGED_SWEEPS_NEXT_LABEL, MANAGED_SCANS_COPY } from '../src/components/project/ManagedSweepStatus.js'

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

// This fixed local calendar date is independent of the scheduled UTC instant.
const expectedLocalDate = new Date('2026-09-08T12:00:00.000Z').toLocaleDateString('en-US', {
  month: 'short', day: 'numeric', timeZone: 'UTC',
})

function renderSchedule(response: unknown, status = 200, kind: 'answer-visibility' | 'site-audit' = 'answer-visibility', running = false) {
  const request = vi.fn(async () => new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', request)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const page = render(<QueryClientProvider client={client}><ManagedSweepStatus projectName="example" kind={kind} running={running} /></QueryClientProvider>)
  return { ...page, request, client }
}

test('reads the answer-visibility schedule and renders its real nextRunAt in the schedule timezone', async () => {
  const { request, container, client } = renderSchedule(schedule)
  await waitFor(() => expect(client.isFetching()).toBe(0))
  const url = new URL((request.mock.calls[0] as unknown as [Request])[0].url)
  expect(url.pathname).toBe('/api/v1/projects/example/schedule')
  expect(url.searchParams.get('kind')).toBe('answer-visibility')
  expect(screen.getByRole('status').textContent).toBe(`${MANAGED_SWEEPS_NEXT_LABEL} ${expectedLocalDate}`)
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
  expect(screen.getByRole('status').textContent).toBe(MANAGED_SWEEPS_UNAVAILABLE_COPY)
  expect(container.querySelector('time')).toBeNull()
})


test('managed kinds replace the legacy sweep alias and are safe without a browser', () => {
  window.__CANONRY_CONFIG__ = { dashboard: { managedSweeps: true } }
  expect(isDashboardManagedRunKind('answer-visibility')).toBe(true)
  expect(isDashboardManagedRunKind('site-audit')).toBe(false)
  window.__CANONRY_CONFIG__.dashboard!.managedRunKinds = ['site-audit']
  expect(isDashboardManagedRunKind('site-audit')).toBe(true)
  expect(isDashboardManagedSweeps()).toBe(false)
  window.__CANONRY_CONFIG__.dashboard!.managedRunKinds = ['answer-visibility']
  expect(isDashboardManagedSweeps()).toBe(true)
  window.__CANONRY_CONFIG__.dashboard!.managedRunKinds = []
  expect(isDashboardManagedSweeps()).toBe(false)
  vi.stubGlobal('window', undefined)
  expect(isDashboardManagedRunKind('site-audit')).toBe(false)
})

test('managed scans read the site-audit schedule and show its actual nextRunAt in UTC', async () => {
  const nextRunAt = '2026-10-01T06:00:00.000Z'
  const { request, container, client } = renderSchedule({ ...schedule, kind: 'site-audit', nextRunAt }, 200, 'site-audit')
  await waitFor(() => expect(client.isFetching()).toBe(0))
  const url = new URL((request.mock.calls[0] as unknown as [Request])[0].url)
  expect(url.searchParams.get('kind')).toBe('site-audit')
  const expectedDate = new Date(nextRunAt).toLocaleString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    timeZone: 'UTC', hourCycle: 'h23',
  })
  expect(screen.getByRole('status').querySelector('time')?.textContent).toBe(`${expectedDate} UTC`)
  expect(container.querySelector('time')?.dateTime).toBe(nextRunAt)
})

test.each([
  [{ error: { code: 'NOT_FOUND' } }, 404],
  [{ ...schedule, nextRunAt: null }, 200],
  [{ ...schedule, enabled: false }, 200],
  [{ ...schedule, nextRunAt: 'invalid' }, 200],
  [{ error: { code: 'INTERNAL_ERROR' } }, 500],
] as const)('managed scans show fallback with no invented date: %j', async (response, status) => {
  const { container, client } = renderSchedule(response, status, 'site-audit')
  await waitFor(() => expect(client.isFetching()).toBe(0))
  expect(screen.getByRole('status').textContent).toBe(MANAGED_SCANS_COPY)
  expect(container.querySelector('time')).toBeNull()
})


test('managed sweep date uses the schedule timezone at a UTC date boundary', async () => {
  const { container, client } = renderSchedule({ ...schedule, nextRunAt: '2026-09-09T03:30:00.000Z' })
  await waitFor(() => expect(client.isFetching()).toBe(0))
  expect(screen.getByRole('status').textContent).toBe(`${MANAGED_SWEEPS_NEXT_LABEL} ${expectedLocalDate}`)
  expect(container.querySelector('time')?.dateTime).toBe('2026-09-09T03:30:00.000Z')
})

test('managed sweep retains a concise running state', async () => {
  const { container } = renderSchedule(schedule, 200, 'answer-visibility', true)
  expect(screen.getByRole('status').textContent).toBe(MANAGED_SWEEPS_RUNNING_COPY)
  expect(container.querySelector('time')).toBeNull()
})
