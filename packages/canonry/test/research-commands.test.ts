import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResearchRunDetailDto } from '@ainyc/canonry-contracts'

const startResearchRun = vi.fn()
const listResearchRuns = vi.fn()
const getResearchRun = vi.fn()
const getProject = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({ startResearchRun, listResearchRuns, getResearchRun, getProject }),
}))

const { researchRun, researchShow } = await import('../src/commands/research.js')
const { RESEARCH_CLI_COMMANDS } = await import('../src/cli-commands/research.js')

const detail: ResearchRunDetailDto = {
  id: 'research-1', projectId: 'proj-1', status: 'completed', provider: 'openai', requestedModel: null,
  resolvedModel: 'gpt-test', location: null, totalQueries: 1, completedQueries: 1, failedQueries: 0,
  error: null, startedAt: null, finishedAt: null, createdAt: '2026-07-23T00:00:00Z',
  queries: [{
    id: 'query-1', position: 0, query: 'best AEO software', status: 'completed', requestedModel: null,
    resolvedModel: 'gpt-test', servedModel: 'gpt-test', answerText: 'A useful answer.',
    groundingSources: [{ title: 'Source', uri: 'https://example.com/source' }], citedDomains: ['example.com'],
    searchQueries: [], answerMentioned: true, citationState: 'cited', error: null,
    startedAt: null, finishedAt: null, createdAt: '2026-07-23T00:00:00Z',
  }],
}

function captureLog(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => lines.push(args.join(' '))
  return fn().finally(() => { console.log = original }).then(() => lines.join('\n'))
}

describe('research commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    startResearchRun.mockResolvedValue(detail)
    getResearchRun.mockResolvedValue(detail)
  })

  it('emits exactly one compact parent record for a non-wait jsonl start', async () => {
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk)); return true
    })
    try {
      await researchRun('demo', { queries: ['best AEO software'], provider: 'openai', format: 'jsonl' })
    } finally {
      vi.restoreAllMocks()
    }
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0]!)).toMatchObject({ project: 'demo', id: 'research-1' })
  })

  it('renders answers, source links, and independent cited/mentioned labels for human detail', async () => {
    const output = await captureLog(() => researchShow('demo', 'research-1', {}))
    expect(output).toContain('A useful answer.')
    expect(output).toContain('https://example.com/source')
    expect(output).toContain('CITED  MENTIONED')
  })

  it('dedupes query flags case-insensitively and validates the list limit before any request', async () => {
    const run = RESEARCH_CLI_COMMANDS.find(command => command.path.join(' ') === 'research run')!
    await run.run({
      positionals: ['demo', 'Best AEO software'], values: { query: ['best aeo software', 'other query'], provider: 'openai' }, format: 'json', dryRun: false,
    })
    expect(startResearchRun).toHaveBeenCalledWith('demo', expect.objectContaining({ queries: ['Best AEO software', 'other query'] }))

    const list = RESEARCH_CLI_COMMANDS.find(command => command.path.join(' ') === 'research list')!
    await expect(list.run({ positionals: ['demo'], values: { limit: '101' }, format: 'json', dryRun: false })).rejects.toMatchObject({ code: 'CLI_USAGE_ERROR' })
    expect(listResearchRuns).not.toHaveBeenCalled()
  })

  it('requires a provider for an exact model and resolves only configured location labels', async () => {
    const run = RESEARCH_CLI_COMMANDS.find(command => command.path.join(' ') === 'research run')!
    await expect(run.run({
      positionals: ['demo', 'query'], values: { model: 'gpt-test' }, format: 'json', dryRun: false,
    })).rejects.toMatchObject({ code: 'CLI_USAGE_ERROR' })

    getProject.mockResolvedValue({ locations: [{ label: 'New York', city: 'New York', region: 'NY', country: 'US' }] })
    await run.run({
      positionals: ['demo', 'query'], values: { provider: 'openai', location: 'New York' }, format: 'json', dryRun: false,
    })
    expect(startResearchRun).toHaveBeenLastCalledWith('demo', expect.objectContaining({
      location: { label: 'New York', city: 'New York', region: 'NY', country: 'US' },
    }))
    await expect(run.run({
      positionals: ['demo', 'query'], values: { provider: 'openai', location: 'New York', 'no-location': true }, format: 'json', dryRun: false,
    })).rejects.toMatchObject({ code: 'CLI_USAGE_ERROR' })
  })

  it('waits for the terminal detail before emitting jsonl query records', async () => {
    startResearchRun.mockResolvedValue({ ...detail, status: 'queued' })
    getResearchRun.mockResolvedValue(detail)
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk)); return true
    })
    vi.spyOn(global, 'setTimeout').mockImplementation(((callback: () => void) => {
      callback(); return 0 as unknown as NodeJS.Timeout
    }) as typeof setTimeout)
    try {
      await researchRun('demo', { queries: ['query'], provider: 'openai', wait: true, format: 'jsonl' })
    } finally {
      vi.restoreAllMocks()
    }
    expect(getResearchRun).toHaveBeenCalledWith('demo', 'research-1')
    expect(JSON.parse(writes[0]!)).toMatchObject({ project: 'demo', runId: 'research-1', query: 'best AEO software' })
  })
})
