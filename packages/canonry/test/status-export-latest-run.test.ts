import { describe, expect, it, beforeEach, vi } from 'vitest'

const mockGetProject = vi.fn()
const mockGetLatestRun = vi.fn()
const mockListRuns = vi.fn()
const mockGetExport = vi.fn()
const mockGetRun = vi.fn()
const mockGetStatus = vi.fn()

vi.mock('../src/client.js', () => ({
  createApiClient: () => ({
    getProject: mockGetProject,
    getLatestRun: mockGetLatestRun,
    listRuns: mockListRuns,
    getExport: mockGetExport,
    getRun: mockGetRun,
    getStatus: mockGetStatus,
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

  it('status --all json prints the stored status DTO unchanged', async () => {
    const status = {
      generatedAt: '2026-10-11T00:00:00.000Z',
      summary: { projects: 1, ok: 1, failing: 0, stale: 0, neverSynced: 0 },
      projects: [{ project: 'demo', displayName: 'Demo', state: 'ok', health: null, integrations: [] }],
    }
    mockGetStatus.mockResolvedValue(status)
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await showStatus(undefined, 'json', { all: true })
    } finally {
      console.log = origLog
    }
    expect(mockGetStatus).toHaveBeenCalledWith({ problems: undefined })
    expect(JSON.parse(logs.join('\n'))).toEqual(status)
  })

  it('status --all jsonl emits flat project integration rows', async () => {
    mockGetStatus.mockResolvedValue({
      generatedAt: '2026-10-11T00:00:00.000Z',
      summary: { projects: 1, ok: 0, failing: 1, stale: 0, neverSynced: 0 },
      projects: [{ project: 'demo', displayName: 'Demo', state: 'failing', health: null, integrations: [{ integration: 'gsc', label: 'Search Console', runKind: 'gsc-sync', sourceId: null, state: 'failing', lastSuccessAt: null, latestRunAt: null, latestRunId: null, latestStatus: null, latestTrigger: null, consecutiveFailures: 3, latestError: 'blocked', dataThrough: null, dataAgeDays: null, doctorChecks: [] }] }],
    })
    const writes: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true }) as typeof process.stdout.write)
    try {
      await showStatus(undefined, 'jsonl', { all: true })
    } finally {
      write.mockRestore()
    }
    const row = JSON.parse(writes.join('').trim()) as Record<string, unknown>
    expect(row).toMatchObject({ project: 'demo', integration: 'gsc', latestError: 'blocked' })
    expect(row.row).toBeUndefined()
  })

  it('status --all human output includes streak, data watermark, and latest error', async () => {
    mockGetStatus.mockResolvedValue({
      generatedAt: '2026-10-11T00:00:00.000Z',
      summary: { projects: 1, ok: 0, failing: 1, stale: 0, neverSynced: 0 },
      projects: [{ project: 'demo', displayName: 'Demo', state: 'failing', health: { status: 'fail', code: 'gsc.api.dns-blocked', summary: 'DNS blocked', checkedAt: '2026-10-11T00:00:00.000Z', notifiedAt: null }, integrations: [{ integration: 'gsc', label: 'Search Console', runKind: 'gsc-sync', sourceId: null, state: 'failing', lastSuccessAt: '2026-10-01T00:00:00.000Z', latestRunAt: '2026-10-11T00:00:00.000Z', latestRunId: 'run', latestStatus: 'failed', latestTrigger: 'scheduled', consecutiveFailures: 4, latestError: 'DNS blocked', dataThrough: '2026-10-01', dataAgeDays: 10, doctorChecks: [] }] }],
    })
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      await showStatus(undefined, undefined, { all: true })
    } finally {
      console.log = origLog
    }
    const output = logs.join('\n')
    expect(output).toContain('streak: 4')
    expect(output).toContain('data through: 2026-10-01')
    expect(output).toContain('latest error: DNS blocked')
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
            queryId: 'kw_1',
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
