import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunCompletenessDto, RunFillDto, RunFillResponseDto } from '@ainyc/canonry-contracts'

const client = {
  fillRun: vi.fn<(id: string, body: unknown) => Promise<RunFillResponseDto>>(),
  getRunCompleteness: vi.fn<(id: string) => Promise<RunCompletenessDto>>(),
  triggerRun: vi.fn(),
}
vi.mock('../src/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/client.js')>()),
  createApiClient: () => client,
}))

const { runCli } = await import('../src/cli.js')
const { fillRun } = await import('../src/commands/run.js')

function fill(id: string, status: RunFillDto['status']): RunFillDto {
  return { id, runId: 'run-1', projectId: 'p', status, providers: ['claude'], expected: 2, filled: status === 'completed' ? 2 : 0, error: null, createdAt: '2026-09-23T10:00:00Z', startedAt: null, finishedAt: null }
}
function completeness(status: RunCompletenessDto['status'], latestFill: RunFillDto | null): RunCompletenessDto {
  const done = status === 'completed'
  return { runId: 'run-1', status, planned: true, readable: true, expected: 4, executed: done ? 4 : 2, missing: done ? 0 : 2, missingByProvider: done ? {} : { claude: 2 }, fillable: false, refusal: null, latestFill }
}

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('canonry run fill', () => {
  it('--dry-run reaches the handler and previews without queueing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    client.fillRun.mockResolvedValue({ outcome: 'dry-run', completeness: completeness('partial', null), fill: null })
    expect(await runCli(['run', 'fill', 'run-1', '--dry-run', '--format', 'json'])).toBe(0)
    expect(client.fillRun).toHaveBeenCalledWith('run-1', { dryRun: true })
  })

  it('--dry-run without a run id is a usage error, never a real sweep of a project named "fill"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    expect(await runCli(['run', 'fill', '--dry-run'])).toBe(1)
    expect(client.triggerRun).not.toHaveBeenCalled()
    expect(client.fillRun).not.toHaveBeenCalled()
  })

  it('--wait finishes when a retry by another client completes the run', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    client.fillRun.mockResolvedValue({ outcome: 'queued', completeness: completeness('partial', fill('ours', 'queued')), fill: fill('ours', 'queued') })
    client.getRunCompleteness
      // Ours ended and someone else's retry is already the latest attempt.
      .mockResolvedValueOnce(completeness('partial', fill('retry', 'running')))
      .mockResolvedValueOnce(completeness('completed', fill('retry', 'completed')))
    const done = fillRun('run-1', { wait: true, format: 'json' })
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(done).resolves.toBeUndefined()
    expect(client.getRunCompleteness).toHaveBeenCalledTimes(2)
  })
})
