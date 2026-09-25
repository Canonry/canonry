import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDto, RunDetailDto } from '@ainyc/canonry-contracts'

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

// Past the 10-minute poll bound, so a --wait that never returned would fail
// with the timeout instead of hanging the test.
const PAST_POLL_TIMEOUT_MS = 11 * 60 * 1000

// What a sweep with an invalid Claude key stores: the one provider it asked
// failed, so the whole run failed.
const CLAUDE_401 = '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'

function run(overrides: Partial<RunDetailDto>): RunDetailDto {
  return {
    id: 'run_1',
    projectId: 'proj_acme',
    kind: 'answer-visibility',
    status: 'running',
    trigger: 'manual',
    startedAt: '2026-09-24T06:00:00.000Z',
    createdAt: '2026-09-24T06:00:00.000Z',
    snapshots: [],
    ...overrides,
  }
}

const failedRun = run({
  status: 'failed',
  finishedAt: '2026-09-24T06:00:04.000Z',
  error: { providers: { claude: { message: CLAUDE_401 } } },
})

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
  providers: ['claude'],
  providerModels: {},
  measurement: { marketingHosts: [], brandTerms: [], leadEventNames: ['generate_lead'] },
  autoExtractBacklinks: false,
}

/** Run the CLI to its exit, driving the 2-second poll with fake time. */
async function cli(args: string[]) {
  const done = invokeCli(args)
  await vi.advanceTimersByTimeAsync(PAST_POLL_TIMEOUT_MS)
  return done
}

/** The `{ error }` envelope printed to stderr, apart from the progress dots. */
function stderrEnvelope(stderr: string) {
  return parseJsonOutput(stderr) as { error: { code: string; message: string; details?: Record<string, unknown> } }
}

beforeEach(() => {
  vi.useFakeTimers()
  mockTriggerRun.mockResolvedValue({ id: 'run_1', status: 'queued', kind: 'answer-visibility' })
})

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('canonry run <project> --wait exit code', () => {
  it('exits 2 when the run fails, after printing the full run detail', async () => {
    mockGetRun.mockResolvedValueOnce(run({})).mockResolvedValueOnce(failedRun)

    const result = await cli(['run', 'acme', '--wait'])

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toContain('Run: run_1')
    expect(result.stdout).toContain('Status:   failed')
    expect(result.stdout).toContain(`Error (claude): ${CLAUDE_401}`)
    expect(result.stderr).toContain(`Error: Run run_1 failed: claude: ${CLAUDE_401}`)
  })

  it('exits 2 with --format json, stdout still exactly the run detail and the error envelope on stderr', async () => {
    mockGetRun.mockResolvedValue(failedRun)

    const result = await cli(['run', 'acme', '--wait', '--format', 'json'])

    expect(result.exitCode).toBe(2)
    expect(JSON.parse(result.stdout)).toEqual(failedRun)
    expect(stderrEnvelope(result.stderr)).toEqual({
      error: {
        code: 'RUN_FAILED',
        message: `Run run_1 failed: claude: ${CLAUDE_401}`,
        details: {
          waitedRunCount: 1,
          failedRuns: [{ runId: 'run_1', project: 'acme', error: `claude: ${CLAUDE_401}` }],
        },
      },
    })
  })

  it('exits 2 when the trigger response is already failed and nothing is polled', async () => {
    mockTriggerRun.mockResolvedValue({ id: 'run_1', status: 'failed', kind: 'answer-visibility' })
    mockGetRun.mockResolvedValue(failedRun)

    const result = await cli(['run', 'acme', '--wait', '--format', 'json'])

    expect(result.exitCode).toBe(2)
    expect(mockGetRun).toHaveBeenCalledTimes(1)
    expect(JSON.parse(result.stdout)).toEqual(failedRun)
  })

  it('exits 0 for a completed run', async () => {
    const completed = run({ status: 'completed', finishedAt: '2026-09-24T06:05:00.000Z' })
    mockGetRun.mockResolvedValue(completed)

    const text = await cli(['run', 'acme', '--wait'])
    expect(text.exitCode).toBeUndefined()
    expect(text.stdout).toContain('Status:   completed')
    expect(text.stderr).not.toContain('Error:')

    const json = await cli(['run', 'acme', '--wait', '--format', 'json'])
    expect(json.exitCode).toBeUndefined()
    expect(JSON.parse(json.stdout)).toEqual(completed)
  })

  it('exits 0 for a partial run: its answers are saved and `canonry run fill` finishes it', async () => {
    const partial = run({
      status: 'partial',
      finishedAt: '2026-09-24T06:05:00.000Z',
      error: { providers: { claude: { message: '429 rate limited' } } },
    })
    mockGetRun.mockResolvedValue(partial)

    const text = await cli(['run', 'acme', '--wait'])
    expect(text.exitCode).toBeUndefined()
    expect(text.stdout).toContain('Status:   partial')
    expect(text.stdout).toContain('Error (claude): 429 rate limited')

    const json = await cli(['run', 'acme', '--wait', '--format', 'json'])
    expect(json.exitCode).toBeUndefined()
    expect(JSON.parse(json.stdout)).toEqual(partial)
  })

  it('exits 0 for a run an operator cancelled', async () => {
    mockGetRun.mockResolvedValue(run({ status: 'cancelled', error: { message: 'Cancelled by user' } }))

    const result = await cli(['run', 'acme', '--wait', '--format', 'json'])

    expect(result.exitCode).toBeUndefined()
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'cancelled' })
  })
})

describe('canonry run <project> --all-locations --wait exit code', () => {
  beforeEach(() => {
    mockTriggerRun.mockResolvedValue([
      { id: 'run_1', status: 'queued', kind: 'answer-visibility', location: 'nyc' },
      { id: 'run_2', status: 'queued', kind: 'answer-visibility', location: 'sf' },
    ])
    mockGetRun.mockImplementation(async (id: string) => (id === 'run_1'
      ? { ...failedRun, location: 'nyc' }
      : run({ id: 'run_2', status: 'completed', location: 'sf' })))
  })

  it('exits 2 when one location run fails, after the final statuses', async () => {
    const result = await cli(['run', 'acme', '--all-locations', '--wait'])

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toMatch(/Final statuses:\n\s+nyc\s+failed\n\s+sf\s+completed/)
    expect(result.stderr).toContain(`Error: 1 of 2 runs failed: acme (nyc) run run_1: claude: ${CLAUDE_401}`)
  })

  it('exits 2 with --format json and prints every location run unchanged', async () => {
    const result = await cli(['run', 'acme', '--all-locations', '--wait', '--format', 'json'])

    expect(result.exitCode).toBe(2)
    expect(JSON.parse(result.stdout)).toEqual([
      { ...failedRun, location: 'nyc' },
      run({ id: 'run_2', status: 'completed', location: 'sf' }),
    ])
    expect(stderrEnvelope(result.stderr).error).toMatchObject({
      code: 'RUN_FAILED',
      details: {
        waitedRunCount: 2,
        failedRuns: [{ runId: 'run_1', project: 'acme', location: 'nyc', error: `claude: ${CLAUDE_401}` }],
      },
    })
  })

  it('exits 0 when every location run completes', async () => {
    mockGetRun.mockImplementation(async (id: string) => run({ id, status: 'completed' }))

    const result = await cli(['run', 'acme', '--all-locations', '--wait'])

    expect(result.exitCode).toBeUndefined()
  })
})

describe('canonry run --all --wait exit code', () => {
  beforeEach(() => {
    mockListProjects.mockResolvedValue([
      project,
      { ...project, id: 'proj_globex', name: 'globex' },
      { ...project, id: 'proj_initech', name: 'initech' },
      { ...project, id: 'proj_umbrella', name: 'umbrella' },
    ])
    mockTriggerRun.mockImplementation(async (name: string) => {
      if (name === 'umbrella') throw new Error('no providers configured')
      const id = { acme: 'run_1', globex: 'run_2', initech: 'run_3' }[name]
      return { id, status: 'queued', kind: 'answer-visibility' }
    })
    mockGetRun.mockImplementation(async (id: string) => {
      if (id === 'run_1') return failedRun
      if (id === 'run_2') return run({ id, projectId: 'proj_globex', status: 'completed' })
      return run({ id, projectId: 'proj_initech', status: 'partial', error: { providers: { claude: { message: '429 rate limited' } } } })
    })
  })

  it('exits 2 when one waited run fails, after printing the whole table', async () => {
    const result = await cli(['run', '--all', '--wait'])

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toMatch(/acme\s+run_1\s+failed/)
    expect(result.stdout).toMatch(/globex\s+run_2\s+completed/)
    expect(result.stdout).toMatch(/initech\s+run_3\s+partial/)
    expect(result.stdout).toMatch(/umbrella\s+\(failed\)\s+error/)
    // umbrella never got a run, so it is not a waited run: 3, not 4.
    expect(result.stderr).toContain(`Error: 1 of 3 runs failed: acme run run_1: claude: ${CLAUDE_401}`)
  })

  it('exits 2 with --format json and prints the same rows as before', async () => {
    const result = await cli(['run', '--all', '--wait', '--format', 'json'])

    expect(result.exitCode).toBe(2)
    expect(JSON.parse(result.stdout)).toEqual([
      { project: 'acme', runId: 'run_1', status: 'failed', location: null },
      { project: 'globex', runId: 'run_2', status: 'completed', location: null },
      { project: 'initech', runId: 'run_3', status: 'partial', location: null },
      { project: 'umbrella', runId: '', status: 'error', location: null, error: 'no providers configured' },
    ])
    expect(stderrEnvelope(result.stderr)).toEqual({
      error: {
        code: 'RUN_FAILED',
        message: `1 of 3 runs failed: acme run run_1: claude: ${CLAUDE_401}`,
        details: {
          waitedRunCount: 3,
          failedRuns: [{ runId: 'run_1', project: 'acme', error: `claude: ${CLAUDE_401}` }],
        },
      },
    })
  })

  it('exits 0 when no waited run failed, partial included', async () => {
    mockGetRun.mockImplementation(async (id: string) => (id === 'run_3'
      ? run({ id, status: 'partial' })
      : run({ id, status: 'completed' })))

    const result = await cli(['run', '--all', '--wait', '--format', 'json'])

    expect(result.exitCode).toBeUndefined()
  })

  it('exits 0 without --wait, since nothing was waited on', async () => {
    const result = await cli(['run', '--all', '--format', 'json'])

    expect(result.exitCode).toBeUndefined()
    expect(mockGetRun).not.toHaveBeenCalled()
  })
})
