import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectDto, RunDetailDto } from '@ainyc/canonry-contracts'

const mockTriggerRun = vi.fn()
const mockListProjects = vi.fn()
const mockGetRun = vi.fn()
const mockGetProject = vi.fn()
const mockPutProject = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    triggerRun: mockTriggerRun,
    listProjects: mockListProjects,
    getRun: mockGetRun,
    getProject: mockGetProject,
    putProject: mockPutProject,
  }),
}))

const { RUN_CLI_COMMANDS } = await import('../src/cli-commands/run.js')
const { PROJECT_CLI_COMMANDS } = await import('../src/cli-commands/project.js')
const { dispatchRegisteredCommand } = await import('../src/cli-dispatch.js')
const { CliError } = await import('../src/cli-error.js')

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
  providerDispatchModes: { openai: 'batch' },
  measurement: { marketingHosts: [], brandTerms: [], leadEventNames: ['generate_lead'] },
  autoExtractBacklinks: false,
}

const detail: RunDetailDto = {
  id: 'run_1',
  projectId: 'proj_acme',
  kind: 'answer-visibility',
  status: 'running',
  trigger: 'scheduled',
  startedAt: '2026-09-24T06:00:00.000Z',
  createdAt: '2026-09-24T06:00:00.000Z',
  measurementPlanVersionId: 'v1',
  measurementManifest: {},
  dispatchModes: { claude: 'batch' },
  providerBatches: [
    {
      id: 'b1', provider: 'claude', model: 'claude-sonnet-4-6', status: 'submitted', requestCount: 120,
      ingestedCount: 0, recordedCount: 0, submittedAt: '2026-09-24T06:00:05.000Z', endedAt: null,
      deadlineAt: '2026-09-25T06:00:05.000Z', error: null,
    },
    {
      id: 'b2', provider: 'claude', model: 'claude-opus-5', status: 'ingested', requestCount: 40,
      ingestedCount: 40, recordedCount: 38, submittedAt: '2026-09-24T06:00:06.000Z', endedAt: '2026-09-24T06:40:00.000Z',
      deadlineAt: '2026-09-25T06:00:06.000Z', error: '2 lines errored',
    },
  ],
  usage: [
    { provider: 'claude', pricingTier: 'batch', answers: 38, inputTokens: 250_000, cachedInputTokens: 2_000, cacheWriteTokens: 0, outputTokens: 30_000, searchCount: 76, estimatedCostMicros: 1_635_400, unpricedAnswers: 0 },
    { provider: 'openai', pricingTier: 'standard', answers: 12, inputTokens: 9_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1_500, searchCount: 12, estimatedCostMicros: null, unpricedAnswers: 12 },
  ],
  snapshots: [],
}

let output: string[]

beforeEach(() => {
  vi.clearAllMocks()
  output = []
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => { output.push(String(line ?? '')) })
  mockTriggerRun.mockResolvedValue({ id: 'run_1', status: 'queued', kind: 'answer-visibility' })
  mockGetRun.mockResolvedValue(detail)
  mockGetProject.mockResolvedValue(project)
  mockPutProject.mockImplementation(async (name: string, body: Record<string, unknown>) => ({ ...project, ...body, name }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

function lastRunBody(): Record<string, unknown> {
  return mockTriggerRun.mock.calls.at(-1)![1] as Record<string, unknown>
}

describe('canonry run --dispatch-mode', () => {
  it('sends the mode on both run forms, and nothing when omitted', async () => {
    await dispatchRegisteredCommand(['run', 'acme', '--dispatch-mode', 'batch'], 'json', RUN_CLI_COMMANDS)
    expect(lastRunBody().dispatchMode).toBe('batch')

    await dispatchRegisteredCommand(['run', 'trigger', 'acme', '--dispatch-mode', 'sync'], 'json', RUN_CLI_COMMANDS)
    expect(lastRunBody().dispatchMode).toBe('sync')

    await dispatchRegisteredCommand(['run', 'acme'], 'json', RUN_CLI_COMMANDS)
    expect(lastRunBody()).not.toHaveProperty('dispatchMode')
  })

  it('sends it for every project with --all', async () => {
    mockListProjects.mockResolvedValue([project, { ...project, name: 'globex' }])
    await dispatchRegisteredCommand(['run', '--all', '--dispatch-mode', 'batch'], 'json', RUN_CLI_COMMANDS)
    expect(mockTriggerRun.mock.calls.map(call => [call[0], (call[1] as Record<string, unknown>).dispatchMode]))
      .toEqual([['acme', 'batch'], ['globex', 'batch']])
  })

  it('refuses an unknown mode before calling the API', async () => {
    await expect(dispatchRegisteredCommand(['run', 'acme', '--dispatch-mode', 'flex'], 'json', RUN_CLI_COMMANDS)).rejects.toThrow(CliError)
    expect(mockTriggerRun).not.toHaveBeenCalled()
  })
})

describe('canonry run show', () => {
  it('prints the run detail response verbatim for --format json', async () => {
    await dispatchRegisteredCommand(['run', 'show', 'run_1'], 'json', RUN_CLI_COMMANDS)
    expect(JSON.parse(output.join('\n'))).toEqual(detail)
  })

  it('says a batch-pending run is waiting on the provider, and prints the usage table', async () => {
    await dispatchRegisteredCommand(['run', 'show', 'run_1'], 'text', RUN_CLI_COMMANDS)
    const text = output.join('\n')

    expect(text).toContain('Dispatch: claude=batch (other providers sync)')
    expect(text).toContain('waiting on provider batch: claude — 120 requests, submitted 2026-09-24T06:00:05.000Z, deadline 2026-09-25T06:00:05.000Z')
    expect(text).toContain('provider batch claude: ingested — 38 of 40 answers recorded (2 lines errored)')
    expect(text).toMatch(/claude\s+batch\s+38\s+250,000\s+2,000\s+0\s+30,000\s+76\s+\$1\.6354/)
    expect(text).toMatch(/openai\s+standard\s+12\s+9,000\s+0\s+0\s+1,500\s+12\s+unpriced/)
  })

  it('says nothing about batches or usage for a run that has neither', async () => {
    mockGetRun.mockResolvedValue({ ...detail, dispatchModes: {}, providerBatches: [], usage: [] })
    await dispatchRegisteredCommand(['run', 'show', 'run_1'], 'text', RUN_CLI_COMMANDS)
    const text = output.join('\n')
    expect(text).not.toContain('provider batch')
    expect(text).not.toContain('Usage')
    expect(text).not.toContain('Dispatch:')
  })
})

describe('canonry project --dispatch-mode', () => {
  function putBody(): Record<string, unknown> {
    expect(mockPutProject).toHaveBeenCalledTimes(1)
    return mockPutProject.mock.calls[0]![1] as Record<string, unknown>
  }

  it('merges assignments into the stored preference on update', async () => {
    await dispatchRegisteredCommand(['project', 'update', 'acme', '--dispatch-mode', 'claude=batch'], 'json', PROJECT_CLI_COMMANDS)
    expect(putBody().providerDispatchModes).toEqual({ openai: 'batch', claude: 'batch' })
  })

  it('clears a provider\'s preference', async () => {
    await dispatchRegisteredCommand(['project', 'update', 'acme', '--clear-dispatch-mode', 'openai'], 'json', PROJECT_CLI_COMMANDS)
    expect(putBody().providerDispatchModes).toEqual({})
  })

  it('leaves the preference to the server when no dispatch flag is given', async () => {
    await dispatchRegisteredCommand(['project', 'update', 'acme', '--display-name', 'Acme Inc'], 'json', PROJECT_CLI_COMMANDS)
    expect(putBody()).not.toHaveProperty('providerDispatchModes')
  })

  it('sets it on create', async () => {
    await dispatchRegisteredCommand(['project', 'create', 'acme', '--domain', 'acme.com', '--dispatch-mode', 'claude=batch'], 'json', PROJECT_CLI_COMMANDS)
    expect(putBody().providerDispatchModes).toEqual({ claude: 'batch' })
  })

  it('refuses a malformed or unknown mode before calling the API', async () => {
    await expect(dispatchRegisteredCommand(['project', 'update', 'acme', '--dispatch-mode', 'claude=later'], 'json', PROJECT_CLI_COMMANDS)).rejects.toThrow(CliError)
    await expect(dispatchRegisteredCommand(['project', 'update', 'acme', '--dispatch-mode', 'claude'], 'json', PROJECT_CLI_COMMANDS)).rejects.toThrow(CliError)
    await expect(dispatchRegisteredCommand(['project', 'update', 'acme', '--dispatch-mode', 'claude=batch', '--clear-dispatch-mode', 'claude'], 'json', PROJECT_CLI_COMMANDS)).rejects.toThrow(CliError)
    expect(mockPutProject).not.toHaveBeenCalled()
  })

  it('shows the preference', async () => {
    await dispatchRegisteredCommand(['project', 'show', 'acme'], 'text', PROJECT_CLI_COMMANDS)
    expect(output.join('\n')).toContain('Dispatch modes:   openai=batch (scheduled sweeps; others sync)')
  })
})
