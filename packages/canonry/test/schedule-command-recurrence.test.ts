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

  it('sets recurrence from CLI flags and retains it when toggling with a CAS version', async () => {
    await setSchedule('project', { everyDays: '14', startDate: '2026-09-23', at: '00:00', timezone: 'America/New_York' })
    expect(mockPutSchedule).toHaveBeenNthCalledWith(1, 'project', {
      recurrence: { everyDays: 14, startDate: '2026-09-23', time: '00:00' }, timezone: 'America/New_York',
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
