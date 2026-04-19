import { describe, expect, it, beforeEach, vi } from 'vitest'

const mockGetProject = vi.fn()
const mockGetLatestRun = vi.fn()
const mockListRuns = vi.fn()
const mockGetExport = vi.fn()
const mockGetRun = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getProject: mockGetProject,
    getLatestRun: mockGetLatestRun,
    listRuns: mockListRuns,
    getExport: mockGetExport,
    getRun: mockGetRun,
  }),
}))

const { showStatus } = await import('../src/commands/status.js')
const { exportProject } = await import('../src/commands/export-cmd.js')

describe('latest-run command usage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('showStatus text mode reads the latest run from the composite endpoint', async () => {
    mockGetProject.mockResolvedValue({
      id: 'proj_1',
      name: 'demo',
      displayName: 'Demo',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
    })
    mockGetLatestRun.mockResolvedValue({
      totalRuns: 3,
      run: {
        id: 'run_latest',
        projectId: 'proj_1',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        createdAt: '2026-04-18T15:00:00.000Z',
        finishedAt: '2026-04-18T15:05:00.000Z',
        snapshots: [],
      },
    })

    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await showStatus('demo')
    } finally {
      console.log = origLog
    }

    expect(mockGetLatestRun).toHaveBeenCalledWith('demo')
    expect(mockListRuns).not.toHaveBeenCalled()
    expect(logs.join('\n')).toContain('run_latest')
    expect(logs.join('\n')).toContain('Total runs: 3')
  })

  it('exportProject --include-results pulls results from the latest-run endpoint', async () => {
    mockGetExport.mockResolvedValue({
      apiVersion: 'canonry/v1',
      kind: 'Project',
      metadata: { name: 'demo' },
      spec: { canonicalDomain: 'example.com' },
    })
    mockGetLatestRun.mockResolvedValue({
      totalRuns: 2,
      run: {
        id: 'run_latest',
        projectId: 'proj_1',
        kind: 'answer-visibility',
        status: 'completed',
        trigger: 'manual',
        createdAt: '2026-04-18T15:00:00.000Z',
        snapshots: [
          {
            id: 'snap_1',
            runId: 'run_latest',
            keywordId: 'kw_1',
            provider: 'gemini',
            citationState: 'cited',
            citedDomains: ['example.com'],
            competitorOverlap: [],
            recommendedCompetitors: [],
            matchedTerms: [],
            groundingSources: [],
            searchQueries: [],
            createdAt: '2026-04-18T15:00:00.000Z',
          },
        ],
      },
    })

    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await exportProject('demo', { includeResults: true, format: 'json' })
    } finally {
      console.log = origLog
    }

    expect(mockGetLatestRun).toHaveBeenCalledWith('demo')
    expect(mockListRuns).not.toHaveBeenCalled()
    expect(mockGetRun).not.toHaveBeenCalled()

    const parsed = JSON.parse(logs.join('\n')) as {
      results: { id: string; snapshots: Array<{ id: string }> }
    }
    expect(parsed.results.id).toBe('run_latest')
    expect(parsed.results.snapshots[0]?.id).toBe('snap_1')
  })
})
