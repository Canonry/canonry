import { describe, expect, it } from 'vitest'
import { REGISTERED_CLI_COMMANDS } from '../src/cli-commands.js'
import { buildCliCatalog } from '../src/cli-catalog.js'
import { toolOperationAccess, canonryMcpTools } from '../src/mcp/tool-registry.js'
import { dispatchRegisteredCommand } from '../src/cli-dispatch.js'
import { cliAccessClassificationIds, resolveCliAccess } from '../src/cli-access.js'

describe('CLI and MCP operation access metadata', () => {
  it('declares access for every CLI command and classifies representative commands', () => {
    expect(REGISTERED_CLI_COMMANDS.every(command => command.access)).toBe(true)
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'google.properties')?.access).toBe('live')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'competitor.list')?.access).toBe('stored')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'competitor.add')?.access).toBe('write')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'schedule.set')?.access).toBe('write')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'traffic.sync')?.access).toBe('write')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'ga.acquisition')?.access).toBe('stored')
    expect(REGISTERED_CLI_COMMANDS.find(command => command.path.join('.') === 'agent.memory.set')?.access).toBe('write')
    const catalog = buildCliCatalog(REGISTERED_CLI_COMMANDS)
    expect(catalog.groups.flatMap(group => group.commands).every(command => command.access)).toBe(true)
  })

  it('matches MCP open-world annotations to derived live reads', () => {
    for (const tool of canonryMcpTools) {
      const derived = toolOperationAccess(tool)
      if (tool.access === 'read') expect(Boolean(tool.annotations.openWorldHint)).toBe(derived === 'live')
      if (tool.access === 'write') expect(derived).toBe('write')
    }
    expect(toolOperationAccess(canonryMcpTools.find(tool => tool.name === 'canonry_ga_properties')!)).toBe('live')
  })

  it('shows access in contextual help while leaving catalog command output typed', async () => {
    const output: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => output.push(args.join(' '))
    try {
      await dispatchRegisteredCommand(['google', 'properties', '--help'], 'text', REGISTERED_CLI_COMMANDS)
    } finally {
      console.log = original
    }
    expect(output.join('\n')).toContain('Access: live (calls a provider now)')
    expect(output.join('\n')).toContain('canonry google properties')
  })

  it('exhaustively classifies every registered command without a stored fallback', () => {
    const registered = REGISTERED_CLI_COMMANDS.map(command => command.path.join('.')).sort()
    expect(cliAccessClassificationIds().sort()).toEqual(registered)
    expect(resolveCliAccess({ path: ['schedule', 'set'], usage: 'x', run: () => undefined })).toBe('write')
    expect(resolveCliAccess({ path: ['ga', 'acquisition'], usage: 'x', run: () => undefined })).toBe('stored')
    expect(resolveCliAccess({ path: ['traffic', 'sync'], usage: 'x', run: () => undefined })).toBe('write')
    expect(() => resolveCliAccess({ path: ['new', 'unclassified'], usage: 'x', run: () => undefined })).toThrow('Missing CLI operation access classification')
  })
})
