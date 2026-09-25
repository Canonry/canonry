import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDto, ProviderBatchSummaryDto, RunDetailDto } from '@ainyc/canonry-contracts'

const mockTriggerRun = vi.fn()
const mockListProjects = vi.fn()
const mockGetRun = vi.fn<(id: string) => Promise<RunDetailDto>>()

vi.mock('../src/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/client.js')>()),
  createApiClient: () => ({
    triggerRun: mockTriggerRun,
    listProjects: mockListProjects,
    getRun: mockGetRun,
  }),
}))

const { invokeCli, parseJsonOutput } = await import('./cli-test-utils.js')

// Past the 10-minute poll bound, so a --wait that kept polling would fail
// with the timeout (exit 2) instead of returning.
const PAST_POLL_TIMEOUT_MS = 11 * 60 * 1000

function batch(overrides: Partial<ProviderBatchSummaryDto>): ProviderBatchSummaryDto {
  return {
    id: 'b1', provider: 'claude', model: 'claude-sonnet-4-6', status: 'submitted', requestCount: 120,
    ingestedCount: 0, recordedCount: 0, submittedAt: '2026-09-24T06:00:05.000Z', endedAt: null,
    deadlineAt: '2026-09-25T06:00:05.000Z', error: null,
    ...overrides,
  }
}

function run(overrides: Partial<RunDetailDto>): RunDetailDto {
  return {
    id: 'run_1',
    projectId: 'proj_acme',
    kind: 'answer-visibility',
    status: 'running',
    trigger: 'manual',
    startedAt: '2026-09-24T06:00:00.000Z',
    createdAt: '2026-09-24T06:00:00.000Z',
    dispatchModes: {},
    providerBatches: [],
    usage: [],
    snapshots: [],
    ...overrides,
  }
}

const batchPending = run({ dispatchModes: { claude: 'batch' }, providerBatches: [batch({})] })

const project: ProjectDto = {
  id: 'proj_acme',
  name: 'acme',
  displayName: 'Acme',
  canonicalDomain: 'acme.com',
  ownedDomains: [],
  aliases: [],
  country: 'US',
  language: 'en',
  configSource: 'api',
  configRevision: 1,
  tags: [],
  labels: {},
  locations: [],
  defaultLocation: null,
  providers: ['claude', 'openai'],
  providerModels: {},
  providerDispatchModes: {},
  measurement: { marketingHosts: [], brandTerms: [], leadEventNames: ['generate_lead'] },
  autoExtractBacklinks: false,
}

/** Run the CLI to its exit, driving the 2-second poll with fake time. */
async function cli(args: string[]) {
  const done = invokeCli(args)
  await vi.advanceTimersByTimeAsync(PAST_POLL_TIMEOUT_MS)
  return done
}

beforeEach(() => {
  vi.useFakeTimers()
  mockTriggerRun.mockResolvedValue({ id: 'run_1', status: 'queued', kind: 'answer-visibility' })
})

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('canonry run --wait on a batch run', () => {
  it('stops at batch-pending, exits 0 and says what it is waiting on', async () => {
    mockGetRun
      .mockResolvedValueOnce(run({ dispatchModes: { claude: 'batch' }, providerBatches: [batch({ status: 'submitting', submittedAt: null })] }))
      .mockResolvedValue(batchPending)

    const result = await cli(['run', 'acme', '--dispatch-mode', 'batch', '--wait'])

    expect(result.exitCode).toBeUndefined()
    // A `submitting` batch is not outstanding yet: the second poll is the stop.
    expect(mockGetRun).toHaveBeenCalledTimes(2)
    expect(result.stdout).toContain('Run: run_1')
    expect(result.stdout).toContain('Status:   running')
    expect(result.stdout).toContain(
      'Waiting on provider batch(es): claude — 120 requests, submitted 2026-09-24T06:00:05.000Z, deadline 2026-09-25T06:00:05.000Z; check with canonry run show run_1',
    )
    expect(result.stderr).not.toContain('Timed out')
  })

  it('names every outstanding batch, ended ones included, and no settled one', async () => {
    mockGetRun.mockResolvedValue(run({
      dispatchModes: { claude: 'batch' },
      providerBatches: [
        batch({ id: 'b1', status: 'ended', requestCount: 100, endedAt: '2026-09-24T07:00:00.000Z' }),
        batch({ id: 'b2', status: 'ingested', requestCount: 40, ingestedCount: 40, recordedCount: 40 }),
        batch({ id: 'b3', status: 'submitted', requestCount: 20, submittedAt: '2026-09-24T06:00:07.000Z', deadlineAt: '2026-09-25T06:00:07.000Z' }),
      ],
    }))

    const result = await cli(['run', 'acme', '--dispatch-mode', 'batch', '--wait'])

    expect(result.exitCode).toBeUndefined()
    expect(mockGetRun).toHaveBeenCalledTimes(1)
    expect(result.stdout).toContain(
      'Waiting on provider batch(es): claude — 100 requests, submitted 2026-09-24T06:00:05.000Z, deadline 2026-09-25T06:00:05.000Z; '
      + 'claude — 20 requests, submitted 2026-09-24T06:00:07.000Z, deadline 2026-09-25T06:00:07.000Z; check with canonry run show run_1',
    )
  })

  it('prints the batch-pending run detail unchanged for --format json', async () => {
    mockGetRun.mockResolvedValue(batchPending)

    const result = await cli(['run', 'acme', '--dispatch-mode', 'batch', '--wait', '--format', 'json'])

    expect(result.exitCode).toBeUndefined()
    expect(parseJsonOutput(result.stdout)).toEqual(batchPending)
    expect(result.stdout).not.toContain('Waiting on provider batch')
  })

  it('reports each run of --all, the batch-pending one included, and exits 0', async () => {
    mockListProjects.mockResolvedValue([project, { ...project, id: 'proj_globex', name: 'globex' }])
    mockTriggerRun
      .mockResolvedValueOnce({ id: 'run_1', status: 'queued', kind: 'answer-visibility' })
      .mockResolvedValueOnce({ id: 'run_2', status: 'queued', kind: 'answer-visibility' })
    mockGetRun.mockImplementation(async (id: string) => (id === 'run_1'
      ? batchPending
      : run({ id: 'run_2', projectId: 'proj_globex', status: 'completed', finishedAt: '2026-09-24T06:05:00.000Z' })))

    const text = await cli(['run', '--all', '--dispatch-mode', 'batch', '--wait'])
    expect(text.exitCode).toBeUndefined()
    expect(text.stdout).toMatch(/acme\s+run_1\s+running/)
    expect(text.stdout).toMatch(/globex\s+run_2\s+completed/)
    expect(text.stdout).toContain('acme: Waiting on provider batch(es): claude — 120 requests, submitted 2026-09-24T06:00:05.000Z, deadline 2026-09-25T06:00:05.000Z; check with canonry run show run_1')
    expect(text.stdout).not.toContain('globex: Waiting')

    mockTriggerRun
      .mockResolvedValueOnce({ id: 'run_1', status: 'queued', kind: 'answer-visibility' })
      .mockResolvedValueOnce({ id: 'run_2', status: 'queued', kind: 'answer-visibility' })
    const json = await cli(['run', '--all', '--dispatch-mode', 'batch', '--wait', '--format', 'json'])
    expect(json.exitCode).toBeUndefined()
    expect(parseJsonOutput(json.stdout)).toEqual([
      { project: 'acme', runId: 'run_1', status: 'running', location: null },
      { project: 'globex', runId: 'run_2', status: 'completed', location: null },
    ])
  })

  it('reports a batch-pending location run of --all-locations and exits 0', async () => {
    mockTriggerRun.mockResolvedValue([
      { id: 'run_1', status: 'queued', kind: 'answer-visibility', location: 'nyc' },
      { id: 'run_2', status: 'queued', kind: 'answer-visibility', location: 'sf' },
    ])
    mockGetRun.mockImplementation(async (id: string) => (id === 'run_1'
      ? { ...batchPending, location: 'nyc' }
      : run({ id: 'run_2', status: 'completed', location: 'sf' })))

    const result = await cli(['run', 'acme', '--all-locations', '--dispatch-mode', 'batch', '--wait'])

    expect(result.exitCode).toBeUndefined()
    expect(result.stdout).toMatch(/nyc\s+running/)
    expect(result.stdout).toMatch(/sf\s+completed/)
    expect(result.stdout).toContain('nyc: Waiting on provider batch(es): claude — 120 requests')
    expect(result.stdout).not.toContain('sf: Waiting')
  })
})

describe('canonry run --wait on a sync run (unchanged)', () => {
  it('waits for a terminal status and exits 0 without a batch line', async () => {
    mockGetRun
      .mockResolvedValueOnce(run({}))
      .mockResolvedValueOnce(run({ status: 'completed', finishedAt: '2026-09-24T06:05:00.000Z' }))

    const result = await cli(['run', 'acme', '--wait'])

    expect(result.exitCode).toBeUndefined()
    expect(mockGetRun).toHaveBeenCalledTimes(2)
    expect(result.stdout).toContain('Status:   completed')
    expect(result.stdout).not.toContain('Waiting on provider batch')
  })

  it('keeps polling past a batch that fell back to sync, until the run is terminal', async () => {
    const fellBack = { dispatchModes: { claude: 'batch' as const }, providerBatches: [batch({ status: 'failed', submittedAt: null })] }
    mockGetRun
      .mockResolvedValueOnce(run(fellBack))
      .mockResolvedValueOnce(run({ ...fellBack, status: 'completed', finishedAt: '2026-09-24T06:05:00.000Z' }))

    const result = await cli(['run', 'acme', '--dispatch-mode', 'batch', '--wait', '--format', 'json'])

    expect(result.exitCode).toBeUndefined()
    expect(mockGetRun).toHaveBeenCalledTimes(2)
    expect(parseJsonOutput(result.stdout)).toMatchObject({ status: 'completed' })
  })

  it('still times out after 10 minutes with exit 2 when a run without a batch never finishes', async () => {
    mockGetRun.mockResolvedValue(run({}))

    const result = await cli(['run', 'acme', '--wait', '--format', 'json'])

    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('Timed out waiting for run run_1 after 600s')
    expect(result.stdout).toBe('')
  })
})
