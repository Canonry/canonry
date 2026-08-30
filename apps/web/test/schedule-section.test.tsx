import React from 'react'
import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { ScheduleSection } from '../src/components/project/ScheduleSection.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(() => {
  cleanup()
  delete window.__CANONRY_CONFIG__
})

const schedule = {
  id: 'schedule_demo',
  projectId: 'project_demo',
  kind: 'answer-visibility' as const,
  cronExpr: '0 6 * * *',
  preset: 'daily',
  timezone: 'UTC',
  enabled: true,
  providers: [],
  sourceId: null,
  lastRunAt: null,
  nextRunAt: '2026-08-29T06:00:00.000Z',
  createdAt: '2026-08-28T10:00:00.000Z',
  updatedAt: '2026-08-28T10:00:00.000Z',
}

function installScheduleApi(overrides: { scheduleResponse?: Response; saveResponse?: Response; removeResponse?: Response } = {}) {
  const restoreFetch = mockFetch((url, init) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    if (path === '/api/v1/projects/demo/schedule' && method === 'GET') return overrides.scheduleResponse ?? jsonResponse(schedule)
    if (path === '/api/v1/projects/demo/schedule' && method === 'PUT') return overrides.saveResponse ?? jsonResponse(schedule)
    if (path === '/api/v1/projects/demo/schedule' && method === 'DELETE') return overrides.removeResponse ?? jsonResponse({ ok: true })
    throw new Error(`Unexpected fetch: ${method} ${url}`)
  })
  onTestFinished(restoreFetch)
}

function renderSchedule(options: {
  scheduleEditRequested?: boolean
  onScheduleEditHandled?: () => void
  isActiveV2?: boolean
  role?: 'admin' | 'viewer' | null
} = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={options.role ? { name: 'demo-user', role: options.role } : null}>
        <ScheduleSection
          projectName="demo"
          scheduleEditRequested={options.scheduleEditRequested}
          onScheduleEditHandled={options.onScheduleEditHandled}
          isActiveV2={options.isActiveV2}
        />
      </AccountProvider>
    </QueryClientProvider>,
  )
}

test('opens a requested editor once after schedule data loads and consumes the marker on cancel', async () => {
  installScheduleApi()
  const onScheduleEditHandled = vi.fn()
  renderSchedule({ scheduleEditRequested: true, onScheduleEditHandled })

  expect(await screen.findByText('AI visibility sweep')).toBeTruthy()
  expect(await screen.findByLabelText('Frequency')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByLabelText('Frequency')).toBeNull())
  expect(onScheduleEditHandled).toHaveBeenCalledTimes(1)
})

test('shows a loading state, treats 404 as no schedule, and preserves other read failures for retry', async () => {
  let resolveSchedule: (response: Response) => void = () => undefined
  const loadingRestore = mockFetch((url) => {
    const path = new URL(url).pathname
    if (path === '/api/v1/projects/demo/schedule') {
      return new Promise<Response>((resolve) => { resolveSchedule = resolve })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(loadingRestore)
  const loading = renderSchedule()
  expect(await screen.findByRole('status')).toBeTruthy()
  resolveSchedule(jsonResponse(schedule))
  await screen.findByRole('button', { name: 'Edit schedule' })
  loading.unmount()

  const missingRestore = mockFetch((url) => {
    if (new URL(url).pathname === '/api/v1/projects/demo/schedule') return jsonResponse({ code: 'NOT_FOUND' }, 404)
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(missingRestore)
  const missing = renderSchedule()
  expect(await screen.findByText('No AI visibility sweep is scheduled. Set one to automatically trigger visibility sweeps.')).toBeTruthy()
  missing.unmount()

  let attempts = 0
  const errorRestore = mockFetch((url) => {
    if (new URL(url).pathname === '/api/v1/projects/demo/schedule') {
      attempts += 1
      return attempts === 1 ? jsonResponse({ code: 'UNAVAILABLE' }, 503) : jsonResponse(schedule)
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
  onTestFinished(errorRestore)
  renderSchedule()
  expect((await screen.findByRole('alert')).textContent).toContain('Could not load the AI visibility sweep schedule.')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByRole('button', { name: 'Edit schedule' })
  expect(attempts).toBe(2)
})

test('consumes the requested editor marker after save and remove', async () => {
  installScheduleApi()
  const afterSave = vi.fn()
  renderSchedule({ scheduleEditRequested: true, onScheduleEditHandled: afterSave })
  await screen.findByLabelText('Frequency')
  fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }))
  await waitFor(() => expect(afterSave).toHaveBeenCalledTimes(1))

  cleanup()
  installScheduleApi()
  const afterRemove = vi.fn()
  renderSchedule({ scheduleEditRequested: true, onScheduleEditHandled: afterRemove })
  await screen.findByLabelText('Frequency')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await screen.findByRole('button', { name: 'Remove' })
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  await waitFor(() => expect(afterRemove).toHaveBeenCalledTimes(2))
})

test('clears the exact generated schedule query after delete instead of retaining the old schedule card', async () => {
  let exists = true
  let getRequests = 0
  const restoreFetch = mockFetch((url, init) => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    if (path !== '/api/v1/projects/demo/schedule') throw new Error(`Unexpected fetch: ${method} ${url}`)
    if (method === 'GET') {
      getRequests += 1
      return exists ? jsonResponse(schedule) : jsonResponse({ code: 'NOT_FOUND' }, 404)
    }
    if (method === 'DELETE') {
      exists = false
      return jsonResponse({ ok: true })
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`)
  })
  onTestFinished(restoreFetch)

  renderSchedule()
  await screen.findByRole('button', { name: 'Remove' })
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

  expect(await screen.findByText('No AI visibility sweep is scheduled. Set one to automatically trigger visibility sweeps.')).toBeTruthy()
  expect(screen.queryByText('Every day at 6:00 AM · UTC')).toBeNull()
  expect(getRequests).toBeGreaterThanOrEqual(2)
})

test('states the active-v2 single-sweep rule and keeps normal copy for simple or v1 plans', async () => {
  installScheduleApi()
  const activeV2 = renderSchedule({ isActiveV2: true })
  expect(await screen.findByText('One schedule runs the full published plan. Groups and Properties inherit its official results; they do not have separate schedules.')).toBeTruthy()
  activeV2.unmount()

  installScheduleApi()
  renderSchedule({ isActiveV2: false })
  await screen.findByText('AI visibility sweep')
  expect(screen.queryByText('One schedule runs the full published plan. Groups and Properties inherit its official results; they do not have separate schedules.')).toBeNull()
})

test('does not expose schedule writes to a viewer or embed', async () => {
  installScheduleApi()
  const viewerConsumed = vi.fn()
  const viewer = renderSchedule({ role: 'viewer', scheduleEditRequested: true, onScheduleEditHandled: viewerConsumed })
  await screen.findByText('Active')
  expect(screen.queryByRole('button', { name: 'Edit schedule' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  expect(viewerConsumed).toHaveBeenCalledTimes(1)
  viewer.unmount()

  window.__CANONRY_CONFIG__ = { embed: { enabled: true, views: ['project'] } }
  installScheduleApi()
  const embedConsumed = vi.fn()
  renderSchedule({ scheduleEditRequested: true, onScheduleEditHandled: embedConsumed })
  await screen.findByText('Active')
  expect(screen.queryByRole('button', { name: 'Edit schedule' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
  expect(embedConsumed).toHaveBeenCalledTimes(1)
})
