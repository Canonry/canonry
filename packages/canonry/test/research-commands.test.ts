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
const { dispatchRegisteredCommand } = await import('../src/cli-dispatch.js')

const detail: ResearchRunDetailDto = {
  id: 'research-1', projectId: 'proj-1', status: 'completed', provider: 'openai', requestedModel: null,
  resolvedModel: 'gpt-test', location: null, scope: null, totalQueries: 1, completedQueries: 1, failedQueries: 0,
  error: null, initiatedBy: null, startedAt: null, finishedAt: null, createdAt: '2026-07-23T00:00:00Z',
  queries: [{
    id: 'query-1', position: 0, query: 'best AEO software', status: 'completed', requestedModel: null,
    resolvedModel: 'gpt-test', servedModel: 'gpt-test', answerText: 'A useful answer.',
    groundingSources: [{ title: 'Source', uri: 'https://example.com/source' }], citedDomains: ['example.com'],
    searchQueries: [], namedCompetitors: ['Rival'], citedCompetitorDomains: ['rival.example'], answerMentioned: true, citationState: 'cited', error: null,
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

  it('renders answers, source links, named competitors, and independent cited/mentioned labels for human detail', async () => {
    const output = await captureLog(() => researchShow('demo', 'research-1', {}))
    expect(output).toContain('A useful answer.')
    expect(output).toContain('https://example.com/source')
    expect(output).toContain('Named competitors: Rival')
    expect(output).toContain('Cited competitor domains: rival.example')
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

  it('preserves the first nonblank query token exactly through CLI argument parsing while retaining normalized deduplication', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await dispatchRegisteredCommand([
      'research', 'run', 'demo', '  Exact positional question  ',
      '--query', 'exact positional question', '--query', '  Exact flagged question  ',
      '--provider', 'openai', '--format', 'json',
    ], 'text', RESEARCH_CLI_COMMANDS)
    expect(startResearchRun).toHaveBeenCalledWith('demo', expect.objectContaining({
      queries: ['  Exact positional question  ', '  Exact flagged question  '],
    }))
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

  it('maps one market destination into the saved batch without changing the final query or fetching locations', async () => {
    const run = RESEARCH_CLI_COMMANDS.find(command => command.path.join(' ') === 'research run')!
    await run.run({
      positionals: ['demo', 'query'], values: { provider: 'openai', market: 'north-america' }, format: 'json', dryRun: false,
    })
    expect(startResearchRun).toHaveBeenLastCalledWith('demo', expect.objectContaining({
      queries: ['query'], scope: { kind: 'market', key: 'north-america' }, location: undefined,
    }))
    expect(getProject).not.toHaveBeenCalled()
  })

  it('keeps portfolio scope independent from an explicit configured location', async () => {
    const run = RESEARCH_CLI_COMMANDS.find(command => command.path.join(' ') === 'research run')!
    getProject.mockResolvedValue({ locations: [{ label: 'New York', city: 'New York', region: 'NY', country: 'US' }] })
    await run.run({
      positionals: ['demo', 'query'], values: { provider: 'openai', property: 'north-store', location: 'New York' }, format: 'json', dryRun: false,
    })
    expect(startResearchRun).toHaveBeenLastCalledWith('demo', expect.objectContaining({
      scope: { kind: 'property', key: 'north-store' },
      location: { label: 'New York', city: 'New York', region: 'NY', country: 'US' },
    }))
  })


  it('accepts only market or property destinations and rejects template provenance missing its paired version', async () => {
    const run = RESEARCH_CLI_COMMANDS.find(command => command.path.join(' ') === 'research run')!
    expect(run.usage).not.toContain('--group')
    expect(run.options?.group).toBeUndefined()
    await expect(run.run({
      positionals: ['demo', 'query'], values: { market: 'north-america', property: 'north-store' }, format: 'json', dryRun: false,
    })).rejects.toMatchObject({ code: 'CLI_USAGE_ERROR' })
    await expect(run.run({
      positionals: ['demo', 'query'], values: { 'template-id': 'template-1' }, format: 'json', dryRun: false,
    })).rejects.toMatchObject({ code: 'CLI_USAGE_ERROR' })
    expect(startResearchRun).not.toHaveBeenCalled()
  })

  it('records paired template provenance alongside the final editable query without local expansion', async () => {
    const run = RESEARCH_CLI_COMMANDS.find(command => command.path.join(' ') === 'research run')!
    await run.run({
      positionals: ['demo', 'edited final question'], values: { provider: 'openai', 'template-id': 'template-1', 'template-version': 'v3' }, format: 'json', dryRun: false,
    })
    expect(startResearchRun).toHaveBeenCalledWith('demo', expect.objectContaining({
      queries: ['edited final question'], template: { templateId: 'template-1', templateVersion: 'v3' },
    }))
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

it('forwards history cursors and preserves access, providers and pagination in JSON output', async () => {
  const response = { runs: [detail], access: { canRun: true, dailyRunLimit: 20 }, providers: [{ name: 'openai', defaultModel: detail.resolvedModel }], nextCursor: 'next-page-token' }
  listResearchRuns.mockResolvedValue(response)
  const output = await captureLog(() => dispatchRegisteredCommand(['research', 'list', 'demo', '--cursor', 'previous-page-token', '--limit', '10', '--format', 'json'], 'text', RESEARCH_CLI_COMMANDS).then(() => undefined))
  expect(listResearchRuns).toHaveBeenCalledWith('demo', { limit: 10, cursor: 'previous-page-token' })
  expect(JSON.parse(output)).toEqual(response)
})
