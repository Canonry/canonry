import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ScheduleDto } from '@ainyc/canonry-contracts'
import { printSchedule } from '../src/commands/schedule.js'

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

  it('renders sourceId only for traffic-sync schedules', () => {
    printSchedule(baseSchedule({ kind: 'traffic-sync', sourceId: 'src_abc' }))
    expect(lines.some(l => l === '  Source:    src_abc')).toBe(true)
  })

  it('omits sourceId for answer-visibility schedules even when present', () => {
    printSchedule(baseSchedule({ kind: 'answer-visibility', sourceId: 'src_abc' }))
    expect(lines.some(l => l.startsWith('  Source:'))).toBe(false)
  })
})
