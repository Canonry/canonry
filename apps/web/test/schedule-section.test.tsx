import { afterEach, expect, onTestFinished, test } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { getApiV1ProjectsByNameSchedulesQueryKey } from '@ainyc/canonry-api-client/react-query'

import { ScheduleSection } from '../src/components/project/ScheduleSection.js'
import { heyClient, type ApiSchedule } from '../src/api.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

afterEach(() => {
  cleanup()
  focusManager.setFocused(undefined)
})

function makeSchedule(overrides: Partial<ApiSchedule> = {}): ApiSchedule {
  return {
    id: 'schedule-1',
    projectId: 'project-1',
    kind: 'answer-visibility',
    cronExpr: '0 6 * * *',
    preset: 'daily',
    timezone: 'UTC',
    enabled: true,
    providers: [],
    nextRunAt: '2026-08-07T06:00:00.000Z',
    lastRunAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

test('discovers an existing schedule through the zero-noise collection read', async () => {
  let scheduleReads = 0
  const restore = mockFetch((url) => {
    expect(url).toContain('/api/v1/projects/citypoint/schedules')
    scheduleReads += 1
    return jsonResponse([{
      id: 'schedule-1',
      projectId: 'project-1',
      kind: 'answer-visibility',
      cronExpr: '0 6 * * *',
      preset: 'daily',
      timezone: 'UTC',
      enabled: true,
      providers: [],
      nextRunAt: '2026-08-07T06:00:00.000Z',
      lastRunAt: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    }])
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ScheduleSection projectName="citypoint" />
    </QueryClientProvider>,
  )
  expect(await screen.findByText('0 6 * * *')).toBeTruthy()
  expect(screen.getByText('Active')).toBeTruthy()
  expect(scheduleReads).toBe(1)
})

test('refreshes a stale cached absence before schedule editing is available', async () => {
  let resolveScheduleRead!: (response: Response) => void
  const scheduleRead = new Promise<Response>((resolve) => {
    resolveScheduleRead = resolve
  })
  const restore = mockFetch((url) => {
    expect(url).toContain('/api/v1/projects/citypoint/schedules')
    return scheduleRead
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(
    getApiV1ProjectsByNameSchedulesQueryKey({ client: heyClient, path: { name: 'citypoint' } }),
    [],
    { updatedAt: 1 },
  )

  render(
    <QueryClientProvider client={queryClient}>
      <ScheduleSection projectName="citypoint" />
    </QueryClientProvider>,
  )

  expect(screen.getByText('Loading...')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '+ Set schedule' })).toBeNull()
  expect(screen.queryByText(/No schedule configured/)).toBeNull()

  await act(async () => {
    resolveScheduleRead(jsonResponse([{
      id: 'schedule-2',
      projectId: 'project-1',
      kind: 'answer-visibility',
      cronExpr: '0 9 * * 1-5',
      preset: null,
      timezone: 'America/New_York',
      enabled: true,
      providers: [],
      nextRunAt: '2026-08-10T13:00:00.000Z',
      lastRunAt: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:00.000Z',
    }]))
    await scheduleRead
  })

  expect(await screen.findByText('0 9 * * 1-5')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Edit schedule' })).toBeTruthy()
  expect(screen.queryByText(/No schedule configured/)).toBeNull()
})

test('renders no schedule from an empty collection without a 404 path', async () => {
  const restore = mockFetch((url) => {
    expect(url).toContain('/api/v1/projects/fresh-site/schedules')
    return jsonResponse([])
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ScheduleSection projectName="fresh-site" />
    </QueryClientProvider>,
  )

  expect(await screen.findByText(/No schedule configured/)).toBeTruthy()
})

test('does not report schedule absence when the authoritative read fails', async () => {
  let attempts = 0
  const restore = mockFetch(() => {
    attempts += 1
    if (attempts === 1) {
      return jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'offline' } }, 503)
    }
    return jsonResponse([])
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ScheduleSection projectName="offline-site" />
    </QueryClientProvider>,
  )

  expect(await screen.findByText('Canonry could not verify this schedule.')).toBeTruthy()
  expect(screen.queryByText(/No schedule configured/)).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText(/No schedule configured/)).toBeTruthy()
  expect(attempts).toBe(2)
})

test('refreshes the mounted schedule on focus before editing is available', async () => {
  let scheduleReads = 0
  const restore = mockFetch((url, init) => {
    expect(url).toContain('/api/v1/projects/citypoint/schedules')
    expect(init?.method).toBe('GET')
    scheduleReads += 1
    return jsonResponse([makeSchedule(scheduleReads === 1
      ? {}
      : {
          cronExpr: '0 9 * * 3',
          preset: 'weekly@wed@9',
          updatedAt: '2026-08-08T00:00:00.000Z',
        })])
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ScheduleSection projectName="citypoint" />
    </QueryClientProvider>,
  )

  expect(await screen.findByText('0 6 * * *')).toBeTruthy()

  await act(async () => {
    focusManager.setFocused(false)
    focusManager.setFocused(true)
  })

  expect(await screen.findByText('0 9 * * 3')).toBeTruthy()
  expect(scheduleReads).toBe(2)

  fireEvent.click(screen.getByRole('button', { name: 'Edit schedule' }))
  expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('weekly@wed')
})

test('blocks an open editor when focus finds a newer schedule', async () => {
  let scheduleReads = 0
  const restore = mockFetch((_url, init) => {
    expect(init?.method).toBe('GET')
    scheduleReads += 1
    return jsonResponse([makeSchedule(scheduleReads === 1
      ? {}
      : {
          cronExpr: '0 11 * * 1-5',
          preset: null,
          timezone: 'America/New_York',
          updatedAt: '2026-08-08T00:00:00.000Z',
        })])
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ScheduleSection projectName="citypoint" />
    </QueryClientProvider>,
  )

  expect(await screen.findByText('0 6 * * *')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Edit schedule' }))
  const frequency = screen.getAllByRole('combobox')[0] as HTMLSelectElement
  fireEvent.change(frequency, { target: { value: 'weekly@fri' } })

  await act(async () => {
    focusManager.setFocused(false)
    focusManager.setFocused(true)
  })

  expect((await screen.findByRole('alert')).textContent).toContain('This schedule changed elsewhere.')
  expect(frequency.value).toBe('weekly@fri')
  expect((screen.getByRole('button', { name: 'Save schedule' }) as HTMLButtonElement).disabled).toBe(true)

  fireEvent.click(screen.getByRole('button', { name: 'Load latest schedule' }))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(frequency.value).toBe('custom')
  expect((screen.getByPlaceholderText('0 9 * * 1-5') as HTMLInputElement).value).toBe('0 11 * * 1-5')
  expect((screen.getByRole('button', { name: 'Save schedule' }) as HTMLButtonElement).disabled).toBe(false)
})

test('revalidates before saving and refuses a version that changed after editing began', async () => {
  let scheduleReads = 0
  let scheduleWrites = 0
  const restore = mockFetch((_url, init) => {
    if (init?.method === 'PUT') {
      scheduleWrites += 1
      return jsonResponse(makeSchedule())
    }
    expect(init?.method).toBe('GET')
    scheduleReads += 1
    return jsonResponse([makeSchedule(scheduleReads === 1
      ? {}
      : {
          cronExpr: '0 8 * * *',
          preset: 'daily@8',
          updatedAt: '2026-08-08T00:00:00.000Z',
        })])
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ScheduleSection projectName="citypoint" />
    </QueryClientProvider>,
  )

  expect(await screen.findByText('0 6 * * *')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Edit schedule' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }))

  expect((await screen.findByRole('alert')).textContent).toContain('This schedule changed elsewhere.')
  expect(scheduleReads).toBe(2)
  expect(scheduleWrites).toBe(0)
  expect((screen.getByRole('button', { name: 'Save schedule' }) as HTMLButtonElement).disabled).toBe(true)
})

test('sends the editor version and reloads accessibly after an atomic save conflict', async () => {
  let scheduleReads = 0
  let scheduleWrites = 0
  const restore = mockFetch((_url, init) => {
    if (init?.method === 'PUT') {
      scheduleWrites += 1
      expect(JSON.parse(String(init.body))).toMatchObject({
        preset: 'daily@6',
        expectedUpdatedAt: '2026-08-01T00:00:00.000Z',
      })
      return jsonResponse({
        error: {
          code: 'SCHEDULE_VERSION_CONFLICT',
          message: 'The schedule changed since it was loaded. Reload it before saving.',
        },
      }, 409)
    }
    expect(init?.method).toBe('GET')
    scheduleReads += 1
    return jsonResponse([makeSchedule(scheduleReads < 3
      ? {}
      : {
          cronExpr: '0 10 * * 1',
          preset: 'weekly@mon@10',
          updatedAt: '2026-08-09T00:00:00.000Z',
        })])
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ScheduleSection projectName="citypoint" />
    </QueryClientProvider>,
  )

  expect(await screen.findByText('0 6 * * *')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Edit schedule' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }))

  expect((await screen.findByRole('alert')).textContent).toContain('This schedule changed elsewhere.')
  expect(screen.getByRole('button', { name: 'Load latest schedule' })).toBeTruthy()
  expect(scheduleReads).toBe(3)
  expect(scheduleWrites).toBe(1)

  fireEvent.click(screen.getByRole('button', { name: 'Load latest schedule' }))
  expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('weekly@mon')
  expect((screen.getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('10')
})

test('sends the displayed version when toggling and deleting a schedule', async () => {
  let scheduleReads = 0
  let scheduleWrites = 0
  let scheduleDeletes = 0
  const current = makeSchedule()
  const paused = makeSchedule({
    enabled: false,
    updatedAt: '2026-08-02T00:00:00.000Z',
  })
  const restore = mockFetch((url, init) => {
    if (init?.method === 'PUT') {
      scheduleWrites += 1
      expect(JSON.parse(String(init.body))).toMatchObject({
        enabled: false,
        expectedUpdatedAt: current.updatedAt,
      })
      return jsonResponse(paused)
    }
    if (init?.method === 'DELETE') {
      scheduleDeletes += 1
      expect(new URL(url).searchParams.get('expectedUpdatedAt')).toBe(paused.updatedAt)
      return new Response(null, { status: 204 })
    }
    expect(init?.method).toBe('GET')
    scheduleReads += 1
    return jsonResponse([current])
  })
  onTestFinished(restore)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ScheduleSection projectName="citypoint" />
    </QueryClientProvider>,
  )

  expect(await screen.findByText('Active')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
  expect(await screen.findByText('Paused')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  expect(await screen.findByText(/No schedule configured/)).toBeTruthy()

  expect(scheduleReads).toBe(2)
  expect(scheduleWrites).toBe(1)
  expect(scheduleDeletes).toBe(1)
})
