import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { isDashboardManagedRunKind, isDashboardManagedSweeps } from '../src/api.js'
import { ManagedSweepStatus, MANAGED_SWEEPS_COPY, MANAGED_SCANS_COPY } from '../src/components/project/ManagedSweepStatus.js'

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

function renderSchedule(response: unknown, status = 200, kind: 'answer-visibility' | 'site-audit' = 'answer-visibility') {
  const request = vi.fn(async () => new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', request)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const page = render(<QueryClientProvider client={client}><ManagedSweepStatus projectName="example" kind={kind} /></QueryClientProvider>)
  return { ...page, request, client }
}

test('reads the answer-visibility schedule and renders its real nextRunAt in the schedule timezone', async () => {
  const { request, container } = renderSchedule(schedule)
  await screen.findByText(/Next scheduled sweep/)
  const url = new URL((request.mock.calls[0] as unknown as [Request])[0].url)
  expect(url.pathname).toBe('/api/v1/projects/example/schedule')
  expect(url.searchParams.get('kind')).toBe('answer-visibility')
  expect(screen.getByRole('status').textContent).toBe('Next scheduled sweep Tue, Sep 8, 2026, 2:00 AM EDT · managed by your Canonry team')
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
  const { request, container } = renderSchedule({ ...schedule, kind: 'site-audit', nextRunAt }, 200, 'site-audit')
  await screen.findByText(/Next scan/)
  const url = new URL((request.mock.calls[0] as unknown as [Request])[0].url)
  expect(url.searchParams.get('kind')).toBe('site-audit')
  expect(screen.getByRole('status').textContent).toBe('Next scan Thursday 1 Oct, 06:00 UTC · managed by your Canonry team')
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
  expect(container.textContent).not.toMatch(/Next scan|UTC|\d|Invalid Date/)
})


test('the schedule tooltip supports focus and Escape and explains the saved start time', async () => {
  const nextRunAt = '2026-09-23T04:00:00.000Z'
  const { request, container } = renderSchedule({ ...schedule, nextRunAt })
  await screen.findByText(/Next scheduled sweep/)
  const help = screen.getByRole('button', { name: /Sweeps are run by your Canonry team.*Sep 23, 2026, 12:00 AM EDT/ })
  expect(help.getAttribute('aria-expanded')).toBe('false')
  fireEvent.focus(help)
  expect(help.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText(/Results update after the sweep finishes/)).toBeTruthy()
  fireEvent.keyDown(help, { key: 'Escape' })
  expect(help.getAttribute('aria-expanded')).toBe('false')
  expect(container.querySelector('time')?.dateTime).toBe(nextRunAt)
  expect(request.mock.calls.every(call => (call as unknown as [Request])[0].method === 'GET')).toBe(true)
})

test.each([
  [{ ...schedule, enabled: false }, 200, /Automatic sweeps are paused/],
  [{ error: { code: 'NOT_FOUND' } }, 404, /No automatic sweep is currently scheduled/],
  [{ error: { code: 'INTERNAL_ERROR' } }, 500, /The next scheduled time could not be loaded/],
])('the tooltip explains unavailable schedules without promising a date: %j', async (response, status, message) => {
  const { client, container } = renderSchedule(response, status)
  await waitFor(() => expect(client.isFetching()).toBe(0))
  expect(await screen.findByRole('button', { name: message })).toBeTruthy()
  expect(container.querySelector('time')).toBeNull()
})
