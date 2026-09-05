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

describe('query and visibility CLI parity', () => {
  it('returns the report envelope verbatim, including class populations and revision evidence', async () => {
    const result = { selection: { queryClass: 'all', revision: 2 }, populations: [{ queryClass: 'branded' }, { queryClass: 'non-brand' }] }
    client.getVisibilityReport.mockResolvedValue(result)
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await runAdvancedMeasurementOperation('demo', 'visibility', inputFile({ queryClass: 'all', scope: 'market', scopeKey: 'alpha', provider: 'gemini', model: 'exact-model', location: 'none', runId: 'measurement-run' }), 'json')
    expect(client.getVisibilityReport).toHaveBeenCalledWith('demo', expect.objectContaining({ queryClass: 'all', scope: 'market', scopeKey: 'alpha', provider: 'gemini', model: 'exact-model', runId: 'measurement-run' }))
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
    const input = tool!.inputSchema.parse({ project: 'demo', scope: 'market', scopeKey: 'alpha', queryClass: 'all', provider: 'gemini', model: 'actual-model', location: 'none', runId: 'measured', queryKey: 'context-node', from: '2026-09-01T00:00:00.000Z', to: '2026-09-04T23:59:59.999Z' })
    await tool!.handler(client as unknown as ApiClient, input)
    const { project, ...selection } = input
    expect(client.getVisibilityReport).toHaveBeenCalledWith(project, selection)
    expect(tool!.access).toBe('read')
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
