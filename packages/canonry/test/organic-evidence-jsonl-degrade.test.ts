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
  cohorts: [], coverage: { gsc: true, ga4: true, server: false, visibility: false },
  sourceCoverage: { gsc: null, ga4: null, server: null, visibility: null },
  gsc: null, ga4: null, gaAiReferrals: null, server: null, visibility: null,
  blog: { pathRule: '/blog and descendants', gsc: null, ga4: null, server: null },
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
})

const { showOrganicEvidence } = await import('../src/commands/organic-evidence.js')
const show = (format: string, period?: 60 | 90) => showOrganicEvidence('demo', { format, period })
