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
})
