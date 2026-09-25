import { describe, expect, it } from 'vitest'
import { reportMonthsForDoctor, reportMonthSchema, groupIsoDateRanges } from '../src/doctor.js'

describe('report calendar selection', () => {
  it('keeps the previous calendar month through day 3, including year rollover', () => {
    expect(reportMonthsForDoctor(undefined, new Date('2026-01-03T23:59:59Z'))).toEqual(['2025-12', '2026-01'])
    expect(reportMonthsForDoctor(undefined, new Date('2026-01-04T00:00:00Z'))).toEqual(['2026-01'])
    expect(reportMonthsForDoctor('2024-02', new Date('2026-01-01T00:00:00Z'))).toEqual(['2024-02'])
  })
  it.each(['2026-00', '2026-13', '2026-1', 'September', '0026-09'])('rejects invalid month %s', month => {
    expect(reportMonthSchema.safeParse(month).success).toBe(false)
  })
})

it('groups distinct ordered calendar days across leap and month boundaries', () => {
  expect(groupIsoDateRanges(['2024-03-01', '2024-02-28', '2024-02-29', '2024-02-29', '2024-03-03'])).toEqual([
    { start: '2024-02-28', end: '2024-03-01' }, { start: '2024-03-03', end: '2024-03-03' },
  ])
  expect(groupIsoDateRanges([])).toEqual([])
})
