import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { SourceBreakdownDto } from '@ainyc/canonry-contracts'

const mockGetAnalyticsSources = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getAnalyticsSources: mockGetAnalyticsSources,
  }),
}))

/** Capture both console.log (human/json) and process.stdout.write (jsonl). */
function capture(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = []
  const origLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    logs.push(String(chunk))
    return true
  })
  return fn()
    .finally(() => {
      console.log = origLog
      spy.mockRestore()
    })
    .then(() => logs.join('\n'))
}

const { showSources } = await import('../src/commands/sources.js')
const { dispatchRegisteredCommand } = await import('../src/cli-dispatch.js')
const { OPERATOR_CLI_COMMANDS } = await import('../src/cli-commands/operator.js')

function fixture(): SourceBreakdownDto {
  const ranked = {
    totalCitedSlots: 17,
    domainTotal: 4,
    entries: [
      { domain: 'acme.com', count: 3, percentage: 0.1765, category: 'other' as const, label: 'Independent sites', surfaceClass: 'own' as const },
      { domain: 'rival.com', count: 2, percentage: 0.1176, category: 'other' as const, label: 'Independent sites', surfaceClass: 'direct-competitor' as const },
      { domain: 'booking.com', count: 1, percentage: 0.0588, category: 'directory' as const, label: 'Booking.com', surfaceClass: 'ota-aggregator' as const },
      { domain: 'forbes.com', count: 1, percentage: 0.0588, category: 'news' as const, label: 'Forbes', surfaceClass: 'editorial-media' as const },
    ],
    truncatedDomainCount: 0,
    truncatedCitedSlots: 0,
    bySurfaceClass: [
      { surfaceClass: 'other' as const, label: 'Other sources', count: 8, percentage: 0.4706, domainCount: 8 },
      { surfaceClass: 'own' as const, label: 'Your domains', count: 4, percentage: 0.2353, domainCount: 2 },
      { surfaceClass: 'direct-competitor' as const, label: 'Direct competitors', count: 2, percentage: 0.1176, domainCount: 1 },
      { surfaceClass: 'ota-aggregator' as const, label: 'Aggregators & marketplaces', count: 2, percentage: 0.1176, domainCount: 2 },
      { surfaceClass: 'editorial-media' as const, label: 'Editorial & media', count: 1, percentage: 0.0588, domainCount: 1 },
    ],
  }
  return {
    overall: [],
    byQuery: {},
    ranked,
    byProvider: {
      gemini: { ...ranked, totalCitedSlots: 13 },
      openai: { ...ranked, totalCitedSlots: 4 },
    },
    runId: 'run_1',
    window: 'all',
    limit: null,
  }
}

const emptyFixture: SourceBreakdownDto = {
  overall: [], byQuery: {},
  ranked: { totalCitedSlots: 0, domainTotal: 0, entries: [], truncatedDomainCount: 0, truncatedCitedSlots: 0, bySurfaceClass: [] },
  byProvider: {}, runId: '', window: 'all', limit: null,
}

describe('showSources', () => {
  beforeEach(() => {
    mockGetAnalyticsSources.mockReset()
    mockGetAnalyticsSources.mockResolvedValue(fixture())
  })

  it('renders the surface-class roll-up by default', async () => {
    const out = await capture(() => showSources('p', {}))
    expect(out).toMatch(/Source Rankings/)
    expect(out).toMatch(/Your domains/)
    expect(out).toMatch(/Aggregators & marketplaces/)
    expect(out).toMatch(/Direct competitors/)
  })

  it('prints each 0..1 share through formatPercent in a six-wide column', async () => {
    const lines = (await capture(() => showSources('p', { rank: true }))).split('\n')
    expect(lines).toContain(`    ${'Your domains'.padEnd(28)}  23.5%  (4)  2 domains`)
    expect(lines).toContain(`    ${'Editorial & media'.padEnd(28)}   5.9%  (1)  1 domain`)
    // 3 of 17 cited slots is 17.647...%: half up on the tenth.
    expect(lines).toContain(`    ${'acme.com'.padEnd(32)}    3   17.7%  own`)
    expect(lines).toContain(`    ${'booking.com'.padEnd(32)}    1    5.9%  ota-aggregator`)
  })

  it('renders the flat ranked list with --rank, tagging each domain with its surface class', async () => {
    const out = await capture(() => showSources('p', { rank: true }))
    expect(out).toMatch(/acme\.com/)
    expect(out).toMatch(/rival\.com/)
    expect(out).toMatch(/booking\.com/)
    expect(out).toMatch(/direct-competitor/)
  })

  it('renders per-provider sections with --by-provider', async () => {
    const out = await capture(() => showSources('p', { byProvider: true }))
    expect(out).toMatch(/gemini/)
    expect(out).toMatch(/openai/)
  })

  it('emits the DTO directly with --format json (not wrapped under a feature key)', async () => {
    const out = await capture(() => showSources('p', { format: 'json' }))
    const parsed = JSON.parse(out)
    expect(parsed).toHaveProperty('ranked')
    expect(parsed).toHaveProperty('byProvider')
    expect(parsed).toHaveProperty('limit')
    expect(parsed).not.toHaveProperty('sources') // not the analytics aggregate envelope
    expect(parsed.ranked.entries[0].domain).toBe('acme.com')
  })

  it('streams ranked entries one per line with --format jsonl, stamping the project', async () => {
    const out = await capture(() => showSources('proj-x', { format: 'jsonl' }))
    const lines = out.split('\n').filter(Boolean)
    expect(lines).toHaveLength(4)
    const first = JSON.parse(lines[0]!)
    expect(first.project).toBe('proj-x')
    expect(first.domain).toBe('acme.com')
    expect(first.surfaceClass).toBe('own')
  })

  it('forwards window + limit to the API client', async () => {
    await capture(() => showSources('p', { window: '30d', limit: 5, format: 'json' }))
    expect(mockGetAnalyticsSources).toHaveBeenCalledWith('p', { window: '30d', limit: 5 })
  })

  it('states what the counts pool and names providers that cited nothing', async () => {
    mockGetAnalyticsSources.mockResolvedValue({
      ...fixture(),
      answerTotal: 12,
      runCount: 2,
      providersWithoutSources: ['claude'],
      filters: { runId: null, queryClass: 'all', queryClassBasis: null, includeByQuery: true },
    } satisfies SourceBreakdownDto)
    const out = await capture(() => showSources('p', { byProvider: true }))
    expect(out).toContain('12 answers · 2 runs pooled · branded and non-brand pooled')
    expect(out).toContain('claude: answered, but no answer named a source')
  })

  it('omits the scope line for an older server that does not report it', async () => {
    const out = await capture(() => showSources('p', {}))
    expect(out).not.toMatch(/pooled/)
  })

  it('rejects a non-positive limit before calling the API', async () => {
    await expect(showSources('p', { limit: 0 })).rejects.toThrow()
    expect(mockGetAnalyticsSources).not.toHaveBeenCalled()
  })

  it('handles an empty project without crashing (machine + human)', async () => {
    mockGetAnalyticsSources.mockResolvedValue(emptyFixture)
    const human = await capture(() => showSources('p', {}))
    expect(human).toMatch(/No source data available/)
    mockGetAnalyticsSources.mockResolvedValue(emptyFixture)
    const json = await capture(() => showSources('p', { format: 'json' }))
    expect(JSON.parse(json).ranked.entries).toHaveLength(0)
  })

  it('says how many answers a class filter could not place', async () => {
    mockGetAnalyticsSources.mockResolvedValue({
      ...fixture(),
      answerTotal: 8,
      runCount: 1,
      unclassifiedAnswers: 3,
      filters: { runId: 'run_1', queryClass: 'non-brand', queryClassBasis: 'measurement-plan', includeByQuery: true },
    } satisfies SourceBreakdownDto)
    const out = await capture(() => showSources('p', {}))
    expect(out).toContain('8 answers · run run_1 · non-brand queries only · 3 unclassified answers excluded')
  })
})

/**
 * The registered `canonry sources` command, parsed exactly as the CLI parses
 * argv. The API and MCP accept runId / queryClass / includeByQuery; before
 * these flags were registered the CLI rejected them as unknown options.
 */
describe('canonry sources (registered command)', () => {
  const dispatch = (args: string[]) => capture(async () => {
    await dispatchRegisteredCommand(args, 'text', OPERATOR_CLI_COMMANDS)
  })

  beforeEach(() => {
    mockGetAnalyticsSources.mockReset()
    mockGetAnalyticsSources.mockResolvedValue(fixture())
  })

  it('sources --query-class non-brand reaches the API client', async () => {
    await dispatch(['sources', 'p', '--query-class', 'non-brand', '--format', 'json'])
    expect(mockGetAnalyticsSources).toHaveBeenCalledTimes(1)
    expect(mockGetAnalyticsSources.mock.calls[0]![1]).toMatchObject({ queryClass: 'non-brand' })
  })

  it('sources --run-id reaches the API client', async () => {
    await dispatch(['sources', 'p', '--run-id', 'run_7', '--format', 'json'])
    expect(mockGetAnalyticsSources.mock.calls[0]![1]).toMatchObject({ runId: 'run_7' })
  })

  it('forwards every filter together, with --include-by-query false dropping the per-query breakdown', async () => {
    await dispatch([
      'sources', 'p',
      '--query-class', 'branded', '--run-id', 'run_7', '--include-by-query', 'false',
      '--limit', '5', '--window', '30d', '--format', 'json',
    ])
    expect(mockGetAnalyticsSources).toHaveBeenCalledWith('p', {
      window: '30d',
      limit: 5,
      runId: 'run_7',
      queryClass: 'branded',
      includeByQuery: false,
    })
  })

  it('leaves the server defaults alone when no filter is passed', async () => {
    const out = await dispatch(['sources', 'p', '--format', 'json'])
    const opts = mockGetAnalyticsSources.mock.calls[0]![1] as Record<string, unknown>
    expect(opts.runId).toBeUndefined()
    expect(opts.queryClass).toBeUndefined()
    expect(opts.includeByQuery).toBeUndefined()
    expect(JSON.parse(out).ranked.entries[0].domain).toBe('acme.com')
  })

  it('accepts --include-by-query true', async () => {
    await dispatch(['sources', 'p', '--include-by-query', 'true', '--format', 'json'])
    expect(mockGetAnalyticsSources.mock.calls[0]![1]).toMatchObject({ includeByQuery: true })
  })

  it('rejects an unknown --query-class with a usage error naming the valid classes', async () => {
    const err = await dispatch(['sources', 'p', '--query-class', 'brand', '--format', 'json']).catch((e: unknown) => e)
    expect(err).toMatchObject({
      code: 'CLI_USAGE_ERROR',
      message: '--query-class must be one of all, branded, non-brand',
      details: { command: 'sources', option: 'query-class', value: 'brand' },
    })
    expect(mockGetAnalyticsSources).not.toHaveBeenCalled()
  })

  it('rejects a non-boolean --include-by-query with a usage error', async () => {
    const err = await dispatch(['sources', 'p', '--include-by-query', 'yes', '--format', 'json']).catch((e: unknown) => e)
    expect(err).toMatchObject({
      code: 'CLI_USAGE_ERROR',
      message: '--include-by-query must be true or false',
    })
    expect(mockGetAnalyticsSources).not.toHaveBeenCalled()
  })
})
