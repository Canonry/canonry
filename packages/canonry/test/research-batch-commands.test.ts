import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResearchRunDetailDto } from '@ainyc/canonry-contracts'

const { readFileSync, startResearchBatch, getResearchRun } = vi.hoisted(() => ({
  readFileSync: vi.fn(), startResearchBatch: vi.fn(), getResearchRun: vi.fn(),
}))
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(), readFileSync,
}))
vi.mock('../src/client.js', () => ({ createApiClient: () => ({ startResearchBatch, getResearchRun }) }))

const { researchBatch } = await import('../src/commands/research.js')
const { RESEARCH_CLI_COMMANDS } = await import('../src/cli-commands/research.js')
const { dispatchRegisteredCommand } = await import('../src/cli-dispatch.js')

const request = {
  idempotencyKey: 'reviewed-two-markets',
  runs: [
    { queries: ['  Best apartments in Atlanta  '], provider: 'openai', model: 'gpt-test', location: null, scope: { kind: 'market', key: 'atlanta', expectedPlanRevision: 3 } },
    { queries: ['Best apartments in Boston'], provider: 'openai', model: 'gpt-test', location: { label: 'Boston', city: 'Boston', region: 'MA', country: 'US' }, scope: { kind: 'market', key: 'boston', expectedPlanRevision: 3 } },
  ],
}
const saved = request.runs.map((run, index): ResearchRunDetailDto => ({
  id: `research-${index}`, projectId: 'project-1', status: 'queued', provider: run.provider,
  requestedModel: run.model, resolvedModel: run.model, location: run.location,
  scope: { kind: 'market', key: run.scope.key, label: index === 0 ? 'Atlanta' : 'Boston', planRevision: 3 },
  totalQueries: 1, completedQueries: 0, failedQueries: 0, error: null, initiatedBy: null,
  startedAt: null, finishedAt: null, createdAt: '2026-09-10T00:00:00Z', queries: [],
}))

describe('reviewed research batch CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readFileSync.mockReturnValue(JSON.stringify(request))
    startResearchBatch.mockResolvedValue({ runs: saved })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })
  afterEach(() => vi.restoreAllMocks())

  it('dispatches an exact reviewed file once with concrete scopes and a stable retry key', async () => {
    await dispatchRegisteredCommand(['research', 'batch', 'portfolio', 'reviewed.json', '--format', 'json'], 'text', RESEARCH_CLI_COMMANDS)
    expect(readFileSync).toHaveBeenCalledWith('reviewed.json', 'utf8')
    expect(startResearchBatch).toHaveBeenCalledExactlyOnceWith('portfolio', request)
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)).toEqual({ runs: saved })
    await researchBatch('portfolio', 'reviewed.json', { format: 'json' })
    expect(startResearchBatch).toHaveBeenLastCalledWith('portfolio', request)
  })

  it('reads stdin and emits one self-contained JSONL record for each destination', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await researchBatch('portfolio', '-', { format: 'jsonl' })
    expect(readFileSync).toHaveBeenCalledWith(0, 'utf8')
    const records = String(write.mock.calls[0]![0]).trim().split('\n').map(line => JSON.parse(line))
    expect(records).toEqual(saved.map(run => ({ project: 'portfolio', ...run })))
    expect(console.log).not.toHaveBeenCalled()
  })

  it.each([
    ['malformed JSON', '{'],
    ['missing stable retry key', JSON.stringify({ runs: request.runs })],
    ['missing explicit location', JSON.stringify({ ...request, runs: [{ queries: ['query'], provider: 'openai', model: 'gpt-test' }] })],
    ['unreviewed revision', JSON.stringify({ ...request, runs: [{ ...request.runs[0], scope: { kind: 'market', key: 'atlanta' } }] })],
    ['too many query executions', JSON.stringify({ ...request, runs: [request.runs[0], { ...request.runs[1], queries: Array.from({ length: 50 }, (_, index) => `query ${index}`) }] })],
  ])('rejects %s before any provider request', async (_label, source) => {
    readFileSync.mockReturnValue(source)
    await expect(researchBatch('portfolio', 'reviewed.json', {})).rejects.toMatchObject({ code: 'CLI_USAGE_ERROR' })
    expect(startResearchBatch).not.toHaveBeenCalled()
  })

  it('waits for every accepted destination without restarting completed runs', async () => {
    vi.useFakeTimers()
    startResearchBatch.mockResolvedValue({ runs: [{ ...saved[0], status: 'completed' }, saved[1]] })
    getResearchRun.mockResolvedValue({ ...saved[1], status: 'completed' })
    try {
      const completion = researchBatch('portfolio', 'reviewed.json', { wait: true, format: 'json' })
      await vi.advanceTimersByTimeAsync(2000)
      await completion
      expect(getResearchRun).toHaveBeenCalledExactlyOnceWith('portfolio', 'research-1')
      const output = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)
      expect(output.runs.map((run: ResearchRunDetailDto) => run.status)).toEqual(['completed', 'completed'])
      expect(startResearchBatch).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
