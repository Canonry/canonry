import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetOrganicEvidence = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({ getOrganicEvidence: mockGetOrganicEvidence }),
}))

function captureLog(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => logs.push(args.join(' '))
  return fn().finally(() => { console.log = original }).then(() => logs.join('\n'))
}

const evidence = {
  contractVersion: 'organic-evidence/v1', periodDays: 90, asOfDate: '2026-07-20',
  coverage: { gsc: true, ga4: true, server: false, visibility: false },
  sourceCoverage: { gsc: null, ga4: null, server: null, visibility: null },
  gsc: null, ga4: null, gaAiReferrals: null, server: null, visibility: null,
  pages: [], findings: [], limitations: [],
}

describe('organic-evidence — jsonl degrades to the composite JSON document', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetOrganicEvidence.mockResolvedValue(evidence)
  })

  it('emits the same parseable document for json and jsonl', async () => {
    const json = await captureLog(() => show('json'))
    const jsonl = await captureLog(() => show('jsonl'))
    expect(JSON.parse(jsonl)).toEqual(JSON.parse(json))
    expect(JSON.parse(jsonl)).toMatchObject(evidence)
  })

  it('forwards the selected period', async () => {
    await show('json', 60)
    expect(mockGetOrganicEvidence).toHaveBeenCalledWith('demo', 60)
  })

  it('describes URL-agnostic pages and available GA4 lead evidence to agents', async () => {
    const { canonryMcpTools } = await import('../src/mcp/tool-registry.js')
    const tool = canonryMcpTools.find(entry => entry.name === 'canonry_organic_evidence')

    expect(tool?.description).toMatch(/page evidence/i)
    expect(tool?.description).toMatch(/lead events|lead evidence|leads/i)
    expect(tool?.description).toMatch(/source-specific/i)
    expect(tool?.description).not.toMatch(/dedicated blog|blog cohort/i)
    expect(tool?.description).not.toMatch(/lead attribution is unavailable/i)
  })
})

const { showOrganicEvidence } = await import('../src/commands/organic-evidence.js')
const show = (format: string, period?: 60 | 90) => showOrganicEvidence('demo', { format, period })
