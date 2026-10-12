import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'
import { ORGANIC_EVIDENCE_CLI_COMMANDS } from '../src/cli-commands/organic-evidence.js'
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

  it('maps --window 90d to the same stored period and output as --period 90', async () => {
    const invoke = (flags: string[]) => dispatchRegisteredCommand(['organic-evidence', 'demo', ...flags, '--format', 'json'], 'text', ORGANIC_EVIDENCE_CLI_COMMANDS).then(() => {})
    const canonical = await captureLog(() => invoke(['--window', '90d']))
    const legacy = await captureLog(() => invoke(['--period', '90']))
    expect(JSON.parse(canonical)).toEqual(JSON.parse(legacy))
    expect(mockGetOrganicEvidence.mock.calls).toEqual([['demo', 90], ['demo', 90]])
  })

  it('forwards the selected period', async () => {
    await show('json', 60)
    expect(mockGetOrganicEvidence).toHaveBeenCalledWith('demo', 60)
  })

  it('describes URL-agnostic pages and available GA4 lead-event evidence without claiming attribution', async () => {
    const { canonryMcpTools } = await import('../src/mcp/tool-registry.js')
    const tool = canonryMcpTools.find(entry => entry.name === 'canonry_organic_evidence')

    expect(tool?.description).toMatch(/page evidence/i)
    expect(tool?.description).toMatch(/lead-event evidence/i)
    expect(tool?.description).toMatch(/source-specific/i)
    expect(tool?.description).not.toMatch(/dedicated blog|blog cohort/i)
    expect(tool?.description).toMatch(/not lead attribution/i)
    expect(tool?.description).not.toMatch(/AI attention, or leads/i)
  })
})

const { showOrganicEvidence } = await import('../src/commands/organic-evidence.js')
const show = (format: string, period?: 60 | 90) => showOrganicEvidence('demo', { format, period })
