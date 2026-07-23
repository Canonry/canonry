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
