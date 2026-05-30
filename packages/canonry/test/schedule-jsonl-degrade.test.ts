import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { ScheduleDto } from '@ainyc/canonry-contracts'

const mockGetSchedule = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({ getSchedule: mockGetSchedule }),
}))

/** Capture console.log lines (the json / jsonl degrade path uses console.log). */
function captureLog(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  return fn()
    .finally(() => {
      console.log = origLog
    })
    .then(() => logs.join('\n'))
}

const { showSchedule } = await import('../src/commands/schedule.js')

const schedule: ScheduleDto = {
  kind: 'answer-visibility',
  preset: 'daily',
  cronExpr: '0 9 * * *',
  timezone: 'UTC',
  enabled: true,
  providers: ['openai'],
  sourceId: null,
  lastRunAt: null,
  nextRunAt: null,
} as unknown as ScheduleDto

describe('showSchedule — jsonl degrades to the json document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSchedule.mockResolvedValue(schedule)
  })

  it('format=jsonl emits parseable JSON equal to format=json (the degrade)', async () => {
    const jsonOut = await captureLog(() => showSchedule('demo', 'json'))
    const jsonlOut = await captureLog(() => showSchedule('demo', 'jsonl'))

    expect(jsonlOut).toBe(jsonOut)
    expect(JSON.parse(jsonlOut)).toEqual(JSON.parse(jsonOut))
    expect(JSON.parse(jsonlOut)).toMatchObject({ kind: 'answer-visibility', cronExpr: '0 9 * * *' })
  })

  it('format=jsonl does NOT print the human schedule table', async () => {
    const out = await captureLog(() => showSchedule('demo', 'jsonl'))
    expect(out).not.toMatch(/Kind:/)
    expect(out).not.toMatch(/Cron:/)
  })

  it('no format → human text output is unchanged (prints the decorated table)', async () => {
    const out = await captureLog(() => showSchedule('demo', undefined))
    expect(out).toMatch(/Kind:\s+answer-visibility/)
    expect(out).toMatch(/Cron:\s+0 9 \* \* \*/)
    expect(() => JSON.parse(out)).toThrow()
  })
})
