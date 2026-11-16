import { Console } from 'node:console'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_BROWSER_AGENT_PROFILES,
  AgentBrowserAgents,
  AgentBrowserResultStatuses,
  RunStatuses,
  RunTriggers,
  normalizeAgentBrowserCheckRequest,
  summarizeAgentBrowserResults,
} from '@canonry/canonry-contracts'
import type { AgentBrowserCheckDto, AgentBrowserChecksResponseDto, AgentBrowserResultDto, AgentBrowserResultStatus, RunStatus } from '@canonry/canonry-contracts'

const mockTrigger = vi.fn()
const mockGetCheck = vi.fn<(project: string, runId: string) => Promise<AgentBrowserCheckDto>>()
const mockListChecks = vi.fn<(project: string, opts: { limit?: number; property?: string }) => Promise<AgentBrowserChecksResponseDto>>()

vi.mock('../src/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/client.js')>()),
  createApiClient: () => ({
    triggerAgentBrowserCheck: mockTrigger,
    getAgentBrowserCheck: mockGetCheck,
    listAgentBrowserChecks: mockListChecks,
  }),
}))

const { runCli } = await import('../src/cli.js')
// Load the handler now, so the fake clock these tests advance never races a real module load.
await import('../src/commands/agent-browser.js')

// Past the longest --wait bound (90 minutes), so a wait that never ended fails on its timeout
// instead of hanging the test.
const PAST_WAIT_BOUND_MS = 91 * 60 * 1000
const NO_RUN_JUDGED = 'No agent run could be judged: every one errored.'
const NO_KEY = 'No openai API key is configured for this Canonry.'

const request = normalizeAgentBrowserCheckRequest(
  { task: 'Find the pricing page', agents: [AgentBrowserAgents.openai], repeats: 2, expect: { urlPath: '/pricing' } },
  { property: null, siteHosts: ['acme.com'], defaultStartUrl: 'https://acme.com/' },
)

function result(attempt: number, status: AgentBrowserResultStatus, detail: string): AgentBrowserResultDto {
  const errored = status === AgentBrowserResultStatuses.errored
  return {
    id: `result_${attempt}`,
    agent: AgentBrowserAgents.openai,
    model: AGENT_BROWSER_AGENT_PROFILES.openai.defaultModel,
    perception: AGENT_BROWSER_AGENT_PROFILES.openai.perception,
    attempt,
    status,
    verified: !errored,
    detail,
    checks: [],
    answer: '',
    stop: errored ? 'error' : 'final',
    error: errored ? detail : null,
    durationMs: errored ? 0 : 42_000,
    turns: errored ? 0 : 9,
    actions: errored ? 0 : 14,
    screenshots: errored ? 0 : 10,
    safetyChecks: 0,
    usage: { requests: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    finalUrl: errored ? '' : 'https://acme.com/',
    visited: [],
    blockedPages: [],
    submissions: [],
    evidencePath: null,
    createdAt: '2026-11-16T10:00:30.000Z',
  }
}

function check(status: RunStatus, results: AgentBrowserResultDto[], error: string | null = null, effective = request): AgentBrowserCheckDto {
  const running = status === RunStatuses.running
  return {
    runId: 'run_1',
    project: 'acme',
    status,
    trigger: RunTriggers.manual,
    createdAt: '2026-11-16T10:00:00.000Z',
    startedAt: '2026-11-16T10:00:01.000Z',
    finishedAt: running ? null : '2026-11-16T10:01:00.000Z',
    error,
    request: effective,
    summary: summarizeAgentBrowserResults(results, effective.agents.length * effective.repeats),
    results,
  }
}

const unjudged = check(RunStatuses.failed, [result(1, AgentBrowserResultStatuses.errored, NO_KEY), result(2, AgentBrowserResultStatuses.errored, NO_KEY)], NO_RUN_JUDGED)

/** Run the CLI with stdout and stderr captured, the fake clock carried past the wait bound. */
async function cli(args: string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const originalLog = console.log
  const originalError = console.error
  const originalWrite = process.stderr.write
  const terminal = new Console({ stdout: process.stdout, stderr: process.stderr })
  console.log = (...parts: unknown[]) => { stdout.push(parts.join(' ')) }
  console.error = terminal.error.bind(terminal)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'))
    return true
  }) as typeof process.stderr.write
  try {
    const done = runCli(args)
    await vi.advanceTimersByTimeAsync(PAST_WAIT_BOUND_MS)
    const exitCode = await done
    return { stdout: stdout.join('\n'), stderr: stderr.join(''), exitCode: exitCode === 0 ? undefined : exitCode }
  } finally {
    console.log = originalLog
    console.error = originalError
    process.stderr.write = originalWrite
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  mockTrigger.mockResolvedValue({ runId: 'run_1', status: RunStatuses.queued, reused: false })
})

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

const ARGS = ['agent-browser', 'check', 'acme', '--task', 'Find the pricing page', '--agent', 'openai', '--runs', '2', '--expect-url', '/pricing', '--wait']

describe('canonry agent-browser check --wait exit code', () => {
  it('exits 2 when no agent run could be judged, after printing the whole check', async () => {
    mockGetCheck.mockResolvedValueOnce(check(RunStatuses.running, [])).mockResolvedValueOnce(unjudged)

    const outcome = await cli(ARGS)

    expect(outcome.exitCode).toBe(2)
    expect(mockGetCheck).toHaveBeenCalledTimes(2)
    expect(outcome.stdout).toContain('Agent-browser check run_1 · failed')
    expect(outcome.stdout).toContain('2 of 2 runs finished · 0 passed · 0 failed · 2 errored')
    expect(outcome.stdout).toContain(NO_KEY)
    expect(outcome.stderr).toContain(`Error: Agent-browser check run_1 failed: ${NO_RUN_JUDGED}`)
  })

  it('exits 2 with --format json, stdout exactly the check and the error envelope alone on stderr', async () => {
    mockGetCheck.mockResolvedValue(unjudged)

    const outcome = await cli([...ARGS, '--format', 'json'])

    expect(outcome.exitCode).toBe(2)
    expect(JSON.parse(outcome.stdout)).toEqual(unjudged)
    expect(JSON.parse(outcome.stderr)).toEqual({
      error: {
        code: 'RUN_FAILED',
        message: `Agent-browser check run_1 failed: ${NO_RUN_JUDGED}`,
        details: { project: 'acme', runId: 'run_1', error: NO_RUN_JUDGED },
      },
    })
  })

  it.each([
    ['completed, its agent having failed the task (a finding about the site)', check(RunStatuses.completed, [
      result(1, AgentBrowserResultStatuses.failed, 'ended on /, not /pricing'),
      result(2, AgentBrowserResultStatuses.passed, 'ended on /pricing'),
    ])],
    ['partial, one run errored', check(RunStatuses.partial, [
      result(1, AgentBrowserResultStatuses.errored, '529 overloaded'),
      result(2, AgentBrowserResultStatuses.passed, 'ended on /pricing'),
    ])],
    ['cancelled', check(RunStatuses.cancelled, [], 'Cancelled by user')],
  ])('exits 0 when the check ended %s', async (_label, ended) => {
    mockGetCheck.mockResolvedValue(ended)

    const text = await cli(ARGS)
    const json = await cli([...ARGS, '--format', 'json'])

    expect(text.exitCode).toBeUndefined()
    expect(text.stdout).toContain(`Agent-browser check run_1 · ${ended.status}`)
    expect(text.stderr).not.toContain('Error:')
    expect(json.exitCode).toBeUndefined()
    expect(JSON.parse(json.stdout)).toEqual(ended)
    expect(json.stderr).toBe('')
  })
})

// A custom portfolio's checks carry their Property: the list filters by it and the human views name it.
describe('canonry agent-browser with a Property', () => {
  const harbor = normalizeAgentBrowserCheckRequest(
    { task: 'Find the harbor homes', agents: [AgentBrowserAgents.openai] },
    { property: { key: 'harbor', label: 'Harbor Homes', planRevision: 3 }, siteHosts: ['acme.com', 'northstar.example'], defaultStartUrl: 'https://northstar.example/locations/harbor' },
  )

  it('lists one Property\'s checks, sending the key to the API and naming the Property on each line', async () => {
    mockListChecks.mockResolvedValue({
      project: 'acme',
      checks: [{
        runId: 'run_1', property: { key: 'harbor', label: 'Harbor Homes' }, status: RunStatuses.completed, trigger: RunTriggers.manual,
        createdAt: '2026-11-16T10:00:00.000Z', finishedAt: '2026-11-16T10:01:00.000Z', task: 'Find the harbor homes', startUrl: harbor.startUrl,
        agents: [AgentBrowserAgents.openai], summary: summarizeAgentBrowserResults([{ status: AgentBrowserResultStatuses.passed, verified: true }], 1),
      }],
    })

    const outcome = await cli(['agent-browser', 'checks', 'acme', '--property', 'harbor'])

    expect(outcome.exitCode).toBeUndefined()
    expect(mockListChecks).toHaveBeenCalledWith('acme', { limit: undefined, property: 'harbor' })
    expect(outcome.stdout).toBe('2026-11-16T10:00:00.000Z  run_1  completed  1/1 passed, 0 failed, 0 errored  openai  Harbor Homes  Find the harbor homes')
  })

  it('says which Property has no checks yet, and how to start one', async () => {
    mockListChecks.mockResolvedValue({ project: 'acme', checks: [] })

    const outcome = await cli(['agent-browser', 'checks', 'acme', '--property', 'harbor'])

    expect(outcome.stdout).toBe('No agent-browser checks of Property "harbor" for acme yet. Start one with `canonry agent-browser check acme --property harbor --task "<what to do>"`.')
  })

  it('shows the Property, its plan revision and the hosts that counted as the site', async () => {
    mockGetCheck.mockResolvedValue(check(RunStatuses.completed, [result(1, AgentBrowserResultStatuses.passed, 'ended on /locations/harbor')], null, harbor))

    const outcome = await cli(['agent-browser', 'show', 'acme', '--run-id', 'run_1'])

    expect(outcome.stdout).toContain('Property: Harbor Homes (harbor), plan revision 3\nTask: Find the harbor homes\nStart: https://northstar.example/locations/harbor\nSite: acme.com, northstar.example')
  })
})
