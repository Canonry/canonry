import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const client = vi.hoisted(() => ({
  getVisibilityReport: vi.fn(), getQueryTrackingWorkspace: vi.fn(), previewQueryTracking: vi.fn(), commitQueryTracking: vi.fn(),
}))
vi.mock('../src/client.js', () => ({ createApiClient: () => client }))
import { runAdvancedMeasurementOperation } from '../src/commands/measurement-plan.js'
import { canonryMcpTools } from '../src/mcp/tool-registry.js'
import type { ApiClient } from '../src/client.js'

const dirs: string[] = []
function inputFile(input: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'query-visibility-parity-'))
  dirs.push(dir)
  const path = join(dir, 'input.json')
  writeFileSync(path, JSON.stringify(input))
  return path
}
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }) })

/** A report whose populations carry an available and an unavailable change since the previous sweep. */
const REPORT_WITH_COMPARISON = {
  selection: { queryClass: 'all', revision: 2, run: { id: 'run-current', explicit: false } },
  populations: [
    { queryClass: 'branded', comparison: { state: 'unavailable', reason: 'partial-run', previousRun: { id: 'run-previous', createdAt: '2026-09-06T12:00:00.000Z', completedAt: null } } },
    {
      queryClass: 'non-brand',
      comparison: {
        state: 'available',
        previousRun: { id: 'run-previous', createdAt: '2026-09-06T12:00:00.000Z', completedAt: '2026-09-06T12:40:00.000Z' },
        mentionCoverage: { state: 'available', previous: { numerator: 18, denominator: 36, rate: 0.5 }, delta: 24 / 36 - 0.5 },
        citationCoverage: { state: 'unavailable', reason: 'previous-unavailable' },
        propertyReach: { state: 'unavailable', reason: 'not-applicable' },
      },
    },
  ],
}

describe('query and visibility CLI parity', () => {
  it('keeps each population comparison unchanged in JSON output', async () => {
    client.getVisibilityReport.mockResolvedValue(REPORT_WITH_COMPARISON)
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runAdvancedMeasurementOperation('demo', 'visibility', inputFile({ queryClass: 'all' }), 'json')
    const printed = JSON.parse(output.mock.calls[0]![0] as string)
    expect(printed).toEqual(REPORT_WITH_COMPARISON)
    expect(printed.populations[1].comparison.mentionCoverage.delta).toBe(24 / 36 - 0.5)
  })

  it('returns the report envelope verbatim, including class populations and revision evidence', async () => {
    const result = { selection: { queryClass: 'all', revision: 2 }, populations: [{ queryClass: 'branded' }, { queryClass: 'non-brand' }] }
    client.getVisibilityReport.mockResolvedValue(result)
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runAdvancedMeasurementOperation('demo', 'visibility', inputFile({ queryClass: 'all', scope: 'group', scopeKey: 'regional', marketKey: 'alpha', provider: 'gemini', model: 'exact-model', location: 'none', runId: 'measurement-run' }), 'json')
    expect(client.getVisibilityReport).toHaveBeenCalledWith('demo', expect.objectContaining({ queryClass: 'all', scope: 'group', scopeKey: 'regional', marketKey: 'alpha', provider: 'gemini', model: 'exact-model', runId: 'measurement-run' }))
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(result)
  })

  it('returns the workspace unchanged in machine formats', async () => {
    const result = { workspaceVersion: `qtw_${'a'.repeat(64)}`, tracked: [] }
    client.getQueryTrackingWorkspace.mockResolvedValue(result)
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runAdvancedMeasurementOperation('demo', 'query-workspace', undefined, 'jsonl')
    expect(client.getQueryTrackingWorkspace).toHaveBeenCalledWith('demo')
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(result)
  })

  it('passes exact reviewed mutation and token to commit without requesting a sweep', async () => {
    const request = { reviewedAt: '2026-09-04T12:00:00.000Z', expectedWorkspaceVersion: `qtw_${'b'.repeat(64)}`, previewToken: `qtp_${'c'.repeat(64)}`, additions: [{ input: { source: 'manual', text: 'apartments near transit' }, audience: { groupKeys: ['alpha'] } }], removals: [] }
    const result = { committed: true, active: { revision: 4 }, workload: { nextSweepProviderCalls: 2 } }
    client.commitQueryTracking.mockResolvedValue(result)
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runAdvancedMeasurementOperation('demo', 'query-commit', inputFile(request), 'json')
    expect(client.commitQueryTracking).toHaveBeenCalledWith('demo', request)
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual(result)
  })
})

describe('query and visibility MCP parity', () => {
  it('keeps all selection fields in the agent contract and forwards them unchanged', async () => {
    const tool = canonryMcpTools.find(tool => tool.name === 'canonry_visibility_report')
    expect(tool).toBeDefined()
    const input = tool!.inputSchema.parse({ project: 'demo', scope: 'group', scopeKey: 'regional', marketKey: 'alpha', queryClass: 'all', provider: 'gemini', model: 'actual-model', location: 'none', runId: 'measured', queryKey: 'context-node', from: '2026-09-01T00:00:00.000Z', to: '2026-09-04T23:59:59.999Z' })
    await tool!.handler(client as unknown as ApiClient, input)
    const { project, ...selection } = input
    expect(client.getVisibilityReport).toHaveBeenCalledWith(project, selection)
    expect(tool!.access).toBe('read')
  })

  it('returns the client report, including each comparison, unchanged', async () => {
    const tool = canonryMcpTools.find(tool => tool.name === 'canonry_visibility_report')
    expect(tool).toBeDefined()
    client.getVisibilityReport.mockResolvedValue(REPORT_WITH_COMPARISON)
    const output = await tool!.handler(client as unknown as ApiClient, tool!.inputSchema.parse({ project: 'demo', queryClass: 'all' }))
    expect(output).toBe(REPORT_WITH_COMPARISON)
    expect(output).toEqual(REPORT_WITH_COMPARISON)
  })

  it('requires the same preview token and workspace version for an agent commit', async () => {
    const tool = canonryMcpTools.find(tool => tool.name === 'canonry_query_tracking_commit')
    expect(tool).toBeDefined()
    const request = { reviewedAt: '2026-09-04T12:00:00.000Z', expectedWorkspaceVersion: `qtw_${'a'.repeat(64)}`, previewToken: `qtp_${'b'.repeat(64)}`, additions: [], removals: [{ queryText: 'old question', audience: { groupKeys: ['alpha'] } }] }
    const input = tool!.inputSchema.parse({ project: 'demo', request })
    await tool!.handler(client as unknown as ApiClient, input)
    expect(client.commitQueryTracking).toHaveBeenCalledWith('demo', request)
    expect(tool!.access).toBe('write')
  })
})
