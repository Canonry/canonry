import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GaMeasurementAnalysisDto } from '@ainyc/canonry-contracts'
import type { ApiClient } from '../src/client.js'

const gaMeasurementAnalysisMock = vi.fn()

vi.mock('../src/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client.js')>()
  return {
    ...actual,
    createApiClient: () => ({
      gaMeasurementAnalysis: gaMeasurementAnalysisMock,
    }),
  }
})

const ANALYSIS: GaMeasurementAnalysisDto = {
  window: '90d',
  bucketDays: 30,
  filters: {
    hostScope: 'marketing',
    marketingHosts: ['example.com'],
    pathPrefix: '/blog',
    brandTerms: ['Example'],
    queryMixScope: 'property',
  },
  acquisition: {
    status: 'ready',
    error: null,
    syncedAt: '2026-07-23T12:00:00.000Z',
    periods: [],
    channels: [],
    pages: [],
  },
  leads: {
    status: 'ready',
    error: null,
    syncedAt: '2026-07-23T12:00:00.000Z',
    attributionScope: 'landing-page',
    hostAndPathFiltersApplied: true,
    periods: [],
    channels: [],
    aiEngines: {
      leadRateAvailable: false,
      leadRateUnavailableReason: 'no-data',
      organic: { periods: [], engines: [], unattributed: { sources: [], periods: [] } },
      paid: { periods: [], engines: [], unattributed: { sources: [], periods: [] } },
    },
  },
  engagement: {
    status: 'ready',
    availableFromDate: '2026-07-21',
    latestDate: '2026-07-22',
    periods: [],
  },
  searchDemand: {
    status: 'ready',
    periods: [],
    queries: [],
    pages: [],
    latestDate: '2026-07-22',
  },
}

describe('GA measurement analysis operator parity', () => {
  beforeEach(() => {
    gaMeasurementAnalysisMock.mockReset()
    vi.restoreAllMocks()
  })

  it('exposes a typed client method and a CLI command with every analysis filter', async () => {
    const { ApiClient: RealApiClient } = await import('../src/client.js')
    const { GA_CLI_COMMANDS } = await import('../src/cli-commands/ga.js')

    expect(typeof RealApiClient.prototype.gaMeasurementAnalysis).toBe('function')
    const command = GA_CLI_COMMANDS.find(entry => (
      entry.path[0] === 'ga' && entry.path[1] === 'measurement-analysis'
    ))
    expect(command?.options).toMatchObject({
      window: expect.any(Object),
      'host-scope': expect.any(Object),
      'path-prefix': expect.any(Object),
      limit: expect.any(Object),
    })
  })

  it('forwards every filter and degrades jsonl to the stable JSON document', async () => {
    gaMeasurementAnalysisMock.mockResolvedValue(ANALYSIS)
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { gaMeasurementAnalysis } = await import('../src/commands/ga.js')

    await gaMeasurementAnalysis('acme', {
      window: '90d',
      hostScope: 'marketing',
      pathPrefix: '/blog',
      limit: 5,
      format: 'jsonl',
    })

    expect(gaMeasurementAnalysisMock).toHaveBeenCalledWith('acme', {
      window: '90d',
      hostScope: 'marketing',
      pathPrefix: '/blog',
      limit: '5',
    })
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual(ANALYSIS)
  })

  it('renders component errors and the full branded/non-brand/unreported search split for humans', async () => {
    gaMeasurementAnalysisMock.mockResolvedValue({
      ...ANALYSIS,
      acquisition: {
        ...ANALYSIS.acquisition,
        status: 'error',
        error: 'acquisition quota exhausted',
        periods: [{
          label: 'latest',
          startDate: '2026-06-24',
          endDate: '2026-07-23',
          sessions: 12,
        }],
      },
      leads: {
        ...ANALYSIS.leads,
        status: 'error',
        error: 'lead dimension unavailable',
        periods: [{
          label: 'latest',
          startDate: '2026-06-24',
          endDate: '2026-07-23',
          eventCount: 2,
        }],
      },
      searchDemand: {
        ...ANALYSIS.searchDemand,
        periods: [{
          label: 'latest',
          startDate: '2026-06-23',
          endDate: '2026-07-22',
          propertyClicks: 20,
          propertyImpressions: 300,
          reportedQueryClicks: 17,
          reportedQueryImpressions: 240,
          brandedClicks: 8,
          brandedImpressions: 100,
          nonBrandedClicks: 9,
          nonBrandedImpressions: 140,
          unreportedClicks: 3,
          unreportedImpressions: 60,
        }],
      },
    } satisfies GaMeasurementAnalysisDto)
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { gaMeasurementAnalysis } = await import('../src/commands/ga.js')

    await gaMeasurementAnalysis('acme')

    const rendered = output.mock.calls.map(call => String(call[0])).join('\n')
    expect(rendered).toContain('acquisition quota exhausted')
    expect(rendered).toContain('lead dimension unavailable')
    expect(rendered).toMatch(/8 branded/i)
    expect(rendered).toMatch(/9 (reported )?non-brand/i)
    expect(rendered).toMatch(/3 unreported/i)
    expect(rendered).toMatch(/60 unreported impressions/i)
  })

  it('renders organic leads by AI engine as one row per engine plus the total, per cohort, and paid clicks apart', async () => {
    const previous = { label: 'previous' as const, startDate: '2026-05-25', endDate: '2026-06-23' }
    const latest = { label: 'latest' as const, startDate: '2026-06-24', endDate: '2026-07-23' }
    const zero = { eventCount: 0, sessions: 0, leadRate: null }
    const noUnattributed = { sources: [], periods: [{ ...previous, ...zero }, { ...latest, ...zero }] }
    const aiEngines: GaMeasurementAnalysisDto['leads']['aiEngines'] = {
      leadRateAvailable: true,
      leadRateUnavailableReason: null,
      organic: {
        periods: [
          { ...previous, eventCount: 1, sessions: 25, leadRate: 0.04 },
          { ...latest, eventCount: 7, sessions: 100, leadRate: 0.07 },
        ],
        engines: [
          {
            engine: 'chatgpt',
            label: 'ChatGPT',
            sources: ['chatgpt.com'],
            periods: [
              { ...previous, eventCount: 1, sessions: 25, leadRate: 0.04 },
              { ...latest, eventCount: 5, sessions: 50, leadRate: 0.1 },
            ],
          },
          {
            engine: 'gemini',
            label: 'Gemini',
            sources: ['gemini.google.com'],
            periods: [
              { ...previous, ...zero },
              { ...latest, eventCount: 2, sessions: 50, leadRate: 0.04 },
            ],
          },
        ],
        unattributed: noUnattributed,
      },
      paid: {
        periods: [{ ...previous, ...zero }, { ...latest, ...zero }],
        engines: [],
        unattributed: noUnattributed,
      },
    }
    gaMeasurementAnalysisMock.mockResolvedValue({
      ...ANALYSIS,
      window: '60d',
      leads: { ...ANALYSIS.leads, aiEngines },
    } satisfies GaMeasurementAnalysisDto)
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { gaMeasurementAnalysis } = await import('../src/commands/ga.js')

    await gaMeasurementAnalysis('acme')

    const lines = output.mock.calls.map(call => String(call[0]))
    const rowFor = (label: string) => lines.find(line => line.trim().startsWith(label))
    expect(lines).toContain('  Leads by AI engine, organic (lead events / AI sessions, lead rate)')
    expect(rowFor('ENGINE')).toMatch(/ENGINE\s+PREVIOUS\s+LATEST$/)
    expect(rowFor('ChatGPT')).toMatch(/ChatGPT\s+1 \/ 25 {2}4\.0%\s+5 \/ 50 {2}10\.0%$/)
    // A cohort with no sessions has no rate, never a 0%.
    expect(rowFor('Gemini')).toMatch(/Gemini\s+0 \/ 0 {2}\S+\s+2 \/ 50 {2}4\.0%$/)
    expect(rowFor('Gemini')).not.toMatch(/0 \/ 0 {2}0%/)
    expect(rowFor('All AI')).toMatch(/All AI\s+1 \/ 25 {2}4\.0%\s+7 \/ 100 {2}7\.0%$/)
    // No paid AI rows and no unattributed AI channel rows: neither is printed.
    expect(lines.some(line => line.includes('paid clicks'))).toBe(false)
    expect(lines.some(line => line.includes('Other AI Assistant'))).toBe(false)
    expect(lines.some(line => line.includes('Note:'))).toBe(false)

    output.mockClear()
    gaMeasurementAnalysisMock.mockResolvedValue({
      ...ANALYSIS,
      leads: {
        ...ANALYSIS.leads,
        attributionScope: 'channel',
        hostAndPathFiltersApplied: false,
        aiEngines: {
          leadRateAvailable: false,
          leadRateUnavailableReason: 'channel-leads-unfiltered',
          organic: {
            periods: [{ ...latest, eventCount: 6, sessions: 70, leadRate: null }],
            engines: [{
              engine: 'chatgpt',
              label: 'ChatGPT',
              sources: ['chatgpt.com'],
              periods: [{ ...latest, eventCount: 4, sessions: 50, leadRate: null }],
            }],
            unattributed: {
              sources: ['assistant.example.com'],
              periods: [{ ...latest, eventCount: 2, sessions: 20, leadRate: null }],
            },
          },
          paid: {
            periods: [{ ...latest, eventCount: 30, sessions: 200, leadRate: null }],
            engines: [{
              engine: 'chatgpt',
              label: 'ChatGPT',
              sources: ['chatgpt'],
              periods: [{ ...latest, eventCount: 30, sessions: 200, leadRate: null }],
            }],
            unattributed: { sources: [], periods: [{ ...latest, ...zero }] },
          },
        },
      },
    } satisfies GaMeasurementAnalysisDto)

    await gaMeasurementAnalysis('acme')

    const channelLines = output.mock.calls.map(call => String(call[0]))
    const organicAt = channelLines.indexOf('  Leads by AI engine, organic (lead events / AI sessions, lead rate)')
    const paidAt = channelLines.indexOf('  Leads by AI engine, paid clicks (lead events / AI sessions, lead rate)')
    expect(organicAt).toBeGreaterThanOrEqual(0)
    expect(paidAt).toBeGreaterThan(organicAt)
    const organicLines = channelLines.slice(organicAt, paidAt)
    expect(organicLines.find(line => line.trim().startsWith('ChatGPT'))).toMatch(/4 \/ 50/)
    expect(organicLines.find(line => line.trim().startsWith('Other AI Assistant'))).toMatch(/2 \/ 20/)
    expect(channelLines.slice(paidAt).find(line => line.trim().startsWith('ChatGPT'))).toMatch(/30 \/ 200/)
    expect(channelLines.some(line => /channel-level.*--host-scope all/.test(line))).toBe(true)

    output.mockClear()
    gaMeasurementAnalysisMock.mockResolvedValue({
      ...ANALYSIS,
      leads: {
        ...ANALYSIS.leads,
        aiEngines: {
          ...aiEngines,
          leadRateAvailable: false,
          leadRateUnavailableReason: 'sessions-behind-leads',
        },
      },
    } satisfies GaMeasurementAnalysisDto)

    await gaMeasurementAnalysis('acme')

    const staleLines = output.mock.calls.map(call => String(call[0]))
    expect(staleLines.some(line => /Note: stored lead events run past the last stored session date/.test(line))).toBe(true)
  })

  it('exposes the analysis as a read-only GA MCP tool with identical filters', async () => {
    const { canonryMcpTools } = await import('../src/mcp/tool-registry.js')
    const tool = canonryMcpTools.find(entry => entry.name === 'canonry_ga_measurement_analysis')
    const client = {
      gaMeasurementAnalysis: vi.fn().mockResolvedValue(ANALYSIS),
    } as unknown as ApiClient

    expect(tool).toMatchObject({
      tier: 'ga',
      access: 'read',
      openApiOperations: [
        'GET /api/v1/projects/{name}/ga/measurement-analysis',
      ],
    })
    await tool!.handler(client, {
      project: 'acme',
      window: '90d',
      hostScope: 'marketing',
      pathPrefix: '/blog',
      limit: 5,
    })
    expect(client.gaMeasurementAnalysis).toHaveBeenCalledWith('acme', {
      window: '90d',
      hostScope: 'marketing',
      pathPrefix: '/blog',
      limit: '5',
    })
  })
})
