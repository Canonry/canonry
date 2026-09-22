import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduleDto } from '@ainyc/canonry-contracts'

const mockGetSchedule = vi.fn()
const mockPutSchedule = vi.fn()
vi.mock('../src/client.js', () => ({
  createApiClient: () => ({ getSchedule: mockGetSchedule, putSchedule: mockPutSchedule }),
}))

const { disableSchedule, enableSchedule, setSchedule } = await import('../src/commands/schedule.js')

const schedule: ScheduleDto = {
  id: 'schedule-1', projectId: 'project-1', kind: 'traffic-sync', cronExpr: '', preset: null,
  recurrence: { everyDays: 14, startDate: '2026-09-23', time: '00:00' },
  timezone: 'America/New_York', enabled: false, providers: [], sourceId: 'source-1',
  lastRunAt: null, nextRunAt: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
}

describe('schedule command recurrence payloads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSchedule.mockResolvedValue(schedule)
    mockPutSchedule.mockResolvedValue(schedule)
  })

  // A flag-only body used to be sent verbatim. PUT /schedule REPLACES the row,
  // and its schema defaults timezone to 'UTC' and providers to [], so changing
  // only the time silently relocated the schedule and dropped its pinned
  // providers (the run then fell back to the project's provider list).
  it('preserves timezone and providers when only the time is changed', async () => {
    mockGetSchedule.mockResolvedValue({
      ...schedule, kind: 'answer-visibility', sourceId: null,
      timezone: 'Etc/GMT-2', providers: ['claude', 'gemini', 'openai'],
    })

    await setSchedule('project', { everyDays: '14', startDate: '2026-09-23', at: '11:00' })

    const [, payload] = mockPutSchedule.mock.calls[0]!
    expect(payload).toMatchObject({
      recurrence: { everyDays: 14, startDate: '2026-09-23', time: '11:00' },
      timezone: 'Etc/GMT-2',
      providers: ['claude', 'gemini', 'openai'],
      expectedUpdatedAt: schedule.updatedAt,
    })
  })

  it('still creates a schedule when none exists yet', async () => {
    mockGetSchedule.mockRejectedValue(new Error('not found'))

    await setSchedule('project', { everyDays: '7', startDate: '2026-10-01', at: '09:00', timezone: 'UTC' })

    const [, payload] = mockPutSchedule.mock.calls[0]!
    expect(payload).toMatchObject({ recurrence: { everyDays: 7, startDate: '2026-10-01', time: '09:00' }, timezone: 'UTC' })
    // No row to guard against, so a create must not send a CAS version.
    expect(payload).not.toHaveProperty('expectedUpdatedAt')
  })

  it('sets recurrence from CLI flags and retains it when toggling with a CAS version', async () => {
    await setSchedule('project', { everyDays: '14', startDate: '2026-09-23', at: '00:00', timezone: 'America/New_York' })
    // `set` now reads the current row and carries forward what the caller did
    // not set, so the payload also pins kind, sourceId and the CAS version.
    expect(mockPutSchedule).toHaveBeenNthCalledWith(1, 'project', {
      kind: 'traffic-sync',
      recurrence: { everyDays: 14, startDate: '2026-09-23', time: '00:00' }, timezone: 'America/New_York',
      sourceId: 'source-1', expectedUpdatedAt: schedule.updatedAt,
    })

    await enableSchedule('project', undefined, 'traffic-sync')
    await disableSchedule('project', undefined, 'traffic-sync')
    for (const [, payload] of mockPutSchedule.mock.calls.slice(1)) {
      expect(payload).toMatchObject({
        kind: 'traffic-sync', recurrence: schedule.recurrence, timezone: 'America/New_York',
        sourceId: 'source-1', expectedUpdatedAt: schedule.updatedAt,
      })
    }
    expect(mockPutSchedule.mock.calls[1]![1]).toMatchObject({ enabled: true })
    expect(mockPutSchedule.mock.calls[2]![1]).toMatchObject({ enabled: false })
  })
})
