import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ScheduleDto } from '@ainyc/canonry-contracts'
import { formatNextRun, printSchedule } from '../src/commands/schedule.js'

describe('printSchedule (text-mode output)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let lines: string[]

  beforeEach(() => {
    lines = []
    logSpy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      lines.push(String(msg))
    })
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  function baseSchedule(overrides: Partial<ScheduleDto> = {}): ScheduleDto {
    return {
      id: 'sched_1',
      projectId: 'proj_1',
      kind: 'answer-visibility',
      cronExpr: '*/15 * * * *',
      preset: null,
      timezone: 'UTC',
      enabled: true,
      providers: [],
      sourceId: null,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:00.000Z',
      ...overrides,
    }
  }

  it('does not duplicate the cron row when no preset is configured', () => {
    // Regression: `--cron`-configured schedules previously printed the cron
    // expression on both the "Schedule:" and "Cron:" rows. With no preset set,
    // only the "Cron:" row should appear.
    printSchedule(baseSchedule({ preset: null, cronExpr: '*/15 * * * *' }))

    const cronOccurrences = lines.filter(l => l.includes('*/15 * * * *')).length
    expect(cronOccurrences).toBe(1)
    expect(lines.some(l => /^\s*Preset:/.test(l))).toBe(false)
    expect(lines.some(l => l === '  Cron:      */15 * * * *')).toBe(true)
  })

  it('renders the preset row alongside the cron row when a preset is configured', () => {
    printSchedule(baseSchedule({ preset: 'daily', cronExpr: '0 0 * * *' }))

    expect(lines.some(l => l === '  Preset:    daily')).toBe(true)
    expect(lines.some(l => l === '  Cron:      0 0 * * *')).toBe(true)
    // The preset name and the cron expression must remain distinct.
    expect(lines.filter(l => l.includes('daily'))).toHaveLength(1)
    expect(lines.filter(l => l.includes('0 0 * * *'))).toHaveLength(1)
  })

  it('renders calendar recurrence details instead of the empty cron placeholder', () => {
    printSchedule(baseSchedule({ cronExpr: '', recurrence: { everyDays: 14, startDate: '2026-09-23', time: '00:00' } }))
    expect(lines).toContain('  Every:     14 day(s)')
    expect(lines).toContain('  Start:     2026-09-23')
    expect(lines).toContain('  At:        00:00')
    expect(lines.some(line => line.startsWith('  Cron:'))).toBe(false)
  })

  // A bare ISO timestamp made a wrong timezone invisible: the operator had to
  // convert in their head to notice a run was hours off. Local first (what was
  // asked for), UTC second (what the scheduler stores).
  it('renders the next run in the schedule timezone beside UTC', () => {
    printSchedule(baseSchedule({ timezone: 'Etc/GMT-2', nextRunAt: '2026-09-23T09:00:00.000Z' }))
    expect(lines).toContain('  Next run:  2026-09-23 11:00 (+02:00) / 09:00Z')
  })

  it('renders sourceId only for traffic-sync schedules', () => {
    printSchedule(baseSchedule({ kind: 'traffic-sync', sourceId: 'src_abc' }))
    expect(lines.some(l => l === '  Source:    src_abc')).toBe(true)
  })

  it('omits sourceId for answer-visibility schedules even when present', () => {
    printSchedule(baseSchedule({ kind: 'answer-visibility', sourceId: 'src_abc' }))
    expect(lines.some(l => l.startsWith('  Source:'))).toBe(false)
  })
})

describe('formatNextRun', () => {
  it('renders local time, offset, and UTC', () => {
    expect(formatNextRun('2026-09-23T09:00:00.000Z', 'Etc/GMT-2')).toBe('2026-09-23 11:00 (+02:00) / 09:00Z')
    expect(formatNextRun('2026-09-23T12:00:00.000Z', 'America/New_York')).toBe('2026-09-23 08:00 (-04:00) / 12:00Z')
  })

  it('follows the zone across a DST change rather than a fixed offset', () => {
    // Same stored instant, either side of the European transition.
    expect(formatNextRun('2026-10-21T09:00:00.000Z', 'Europe/Berlin')).toBe('2026-10-21 11:00 (+02:00) / 09:00Z')
    expect(formatNextRun('2026-11-04T09:00:00.000Z', 'Europe/Berlin')).toBe('2026-11-04 10:00 (+01:00) / 09:00Z')
  })

  it('renders UTC schedules without inventing an offset', () => {
    expect(formatNextRun('2026-09-23T09:00:00.000Z', 'UTC')).toBe('2026-09-23 09:00 (+00:00) / 09:00Z')
  })

  it('falls back to the raw value rather than throwing', () => {
    // `schedule show` must never crash on a malformed row or an unknown zone.
    expect(formatNextRun('not-a-date', 'UTC')).toBe('not-a-date')
    expect(formatNextRun('2026-09-23T09:00:00.000Z', 'Not/AZone')).toBe('2026-09-23T09:00:00.000Z')
  })
})
