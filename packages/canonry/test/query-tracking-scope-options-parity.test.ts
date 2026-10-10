import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryTrackingWorkspaceResponseSchema } from '@ainyc/canonry-contracts'

const client = vi.hoisted(() => ({ getQueryTrackingWorkspace: vi.fn() }))
vi.mock('../src/client.js', () => ({ createApiClient: () => client }))

import type { CliCommandSpec } from '../src/cli-dispatch.js'
import { MEASUREMENT_PLAN_CLI_COMMANDS } from '../src/cli-commands/measurement-plan.js'
import { QUERY_CLI_COMMANDS } from '../src/cli-commands/query.js'
import type { ApiClient } from '../src/client.js'
import { jsonToolResult } from '../src/mcp/results.js'
import { canonryMcpTools } from '../src/mcp/tool-registry.js'

/** An Advanced workspace as the API serves it, with server-built scope options. */
const workspace = queryTrackingWorkspaceResponseSchema.parse({
  mode: 'advanced',
  workspaceVersion: `qtw_${'a'.repeat(64)}`,
  active: { revision: 3, compiledChecksum: 'b'.repeat(64) },
  defaultContexts: [],
  targets: [{ stableKey: 'bayside', label: 'Bayside Homes' }, { stableKey: 'harbor', label: 'Harbor Homes' }],
  groups: [{ stableKey: 'metro', label: 'Metro', targetKeys: ['bayside', 'harbor'] }],
  markets: [{
    stableKey: 'harbor-market', groupKey: 'metro', label: 'Harbor market',
    usageEdges: [
      { executionNodeKey: 'exec-brand', targetKey: 'harbor', queryId: 'q-brand' },
      { executionNodeKey: 'exec-nearby', targetKey: 'harbor', queryId: 'q-nearby' },
    ],
  }],
  scopeOptions: [
    { id: 'project', label: 'Project', kind: 'project', targetCount: 2 },
    { id: 'metro', label: 'Metro', kind: 'group', targetCount: 2 },
    { id: 'harbor-market', label: 'Harbor market', kind: 'market', targetCount: 1, parentGroupIds: ['metro'] },
    { id: 'bayside', label: 'Bayside Homes', kind: 'property', targetCount: 1, parentGroupIds: ['metro'] },
    { id: 'harbor', label: 'Harbor Homes', kind: 'property', targetCount: 1, parentGroupIds: ['metro'] },
  ],
  tracked: [],
  savedSources: { research: [], discovery: [] },
})

const context = { providers: ['openai'], models: {}, location: null }
const trackedRow = (queryId: string, targetKeys: readonly string[], marketKeys: readonly string[], queryClass = 'non-brand') => ({
  queryId, queryText: queryId, normalizedText: queryId, provenance: null, state: 'awaiting-sweep', lastMeasuredAt: null,
  assignments: targetKeys.map(targetKey => ({
    targetKey, groupKeys: ['metro'], marketKeys, queryClass, classificationSource: 'server', contexts: [context],
  })),
})

/** The same workspace with the Subject each row's pairings derive to (Harbor market has one location, so Type breaks the tie). */
const subjectWorkspace = queryTrackingWorkspaceResponseSchema.parse({
  ...workspace,
  tracked: [
    { ...trackedRow('q-brand', ['harbor'], ['harbor-market'], 'branded'), focus: { kind: 'property', key: 'harbor' } },
    { ...trackedRow('q-nearby', ['harbor'], ['harbor-market']), focus: { kind: 'market', key: 'harbor-market' } },
    { ...trackedRow('q-both', ['bayside', 'harbor'], []), focus: { kind: 'custom' } },
    { ...trackedRow('q-idle', [], []), focus: { kind: 'not-asked' } },
  ],
})

function command(specs: readonly CliCommandSpec[], path: readonly string[]): CliCommandSpec {
  const spec = specs.find(candidate => candidate.path.join(' ') === path.join(' '))
  expect(spec, path.join(' ')).toBeDefined()
  return spec!
}

/** Lines are collected as written; `mockRestore()` would otherwise clear them first. */
async function captureConsole(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(String(args[0])) })
  try {
    await run()
  } finally {
    spy.mockRestore()
  }
  return lines
}

function workspaceTool() {
  const tool = canonryMcpTools.find(candidate => candidate.name === 'canonry_query_tracking_workspace')
  expect(tool).toBeDefined()
  return tool!
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('query tracking scope options CLI parity', () => {
  it.each([
    { name: 'canonry query workspace', specs: QUERY_CLI_COMMANDS, path: ['query', 'workspace'], positionals: ['demo'] },
    {
      name: 'canonry measurement-plan advanced query-workspace',
      specs: MEASUREMENT_PLAN_CLI_COMMANDS,
      path: ['measurement-plan', 'advanced'],
      positionals: ['demo', 'query-workspace'],
    },
  ])('$name --format json prints scopeOptions unchanged', async ({ specs, path, positionals }) => {
    client.getQueryTrackingWorkspace.mockResolvedValue(workspace)
    const lines = await captureConsole(async () => {
      await command(specs, path).run({ positionals, values: {}, format: 'json', dryRun: false })
    })
    expect(client.getQueryTrackingWorkspace).toHaveBeenCalledWith('demo')
    expect(lines).toHaveLength(1)
    const printed = JSON.parse(lines[0]!) as typeof workspace
    expect(printed).toStrictEqual(workspace)
    expect(printed.scopeOptions).toStrictEqual(workspace.scopeOptions)
  })
})

describe('query tracking scope options MCP parity', () => {
  it('returns the client workspace unchanged, scopeOptions included', async () => {
    const tool = workspaceTool()
    client.getQueryTrackingWorkspace.mockResolvedValue(workspace)
    const result = await tool.handler(client as unknown as ApiClient, tool.inputSchema.parse({ project: 'demo' }))
    expect(client.getQueryTrackingWorkspace).toHaveBeenCalledWith('demo')
    expect(result).toBe(workspace)
    const [content] = jsonToolResult(result).content
    expect(content).toMatchObject({ type: 'text' })
    expect(JSON.parse((content as { text: string }).text)).toStrictEqual(workspace)
    expect(tool.access).toBe('read')
  })

  it('tells agents the workspace read returns scopeOptions', () => {
    expect(workspaceTool().description).toContain('scopeOptions')
  })
})

describe('query tracking subject CLI and MCP parity', () => {
  const focuses = subjectWorkspace.tracked.map(row => [row.queryId, row.focus])

  it.each([
    { name: 'canonry query workspace', specs: QUERY_CLI_COMMANDS, path: ['query', 'workspace'], positionals: ['demo'] },
    {
      name: 'canonry measurement-plan advanced query-workspace',
      specs: MEASUREMENT_PLAN_CLI_COMMANDS,
      path: ['measurement-plan', 'advanced'],
      positionals: ['demo', 'query-workspace'],
    },
  ])('$name --format json prints each row\'s focus unchanged', async ({ specs, path, positionals }) => {
    client.getQueryTrackingWorkspace.mockResolvedValue(subjectWorkspace)
    const lines = await captureConsole(async () => {
      await command(specs, path).run({ positionals, values: {}, format: 'json', dryRun: false })
    })
    const printed = JSON.parse(lines[0]!) as typeof subjectWorkspace
    expect(printed).toStrictEqual(subjectWorkspace)
    expect(printed.tracked.map(row => [row.queryId, row.focus])).toStrictEqual(focuses)
  })

  it('returns the same focus through the MCP workspace tool and names it in the description', async () => {
    const tool = workspaceTool()
    client.getQueryTrackingWorkspace.mockResolvedValue(subjectWorkspace)
    const result = await tool.handler(client as unknown as ApiClient, tool.inputSchema.parse({ project: 'demo' }))
    const [content] = jsonToolResult(result).content
    const returned = JSON.parse((content as { text: string }).text) as typeof subjectWorkspace
    expect(returned.tracked.map(row => [row.queryId, row.focus])).toStrictEqual(focuses)
    expect(tool.description).toContain('focus')
  })
})
